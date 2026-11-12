import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client/deepseekClient.js";
import { createLimiter, FakeClock } from "./helpers.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("DeepSeekClient", () => {
  it("retries 429 responses and settles real usage", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const limiter = createLimiter(clock, {
      requestsPerMinute: 1000,
      tokensPerMinute: 1_000_000,
    });

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { error: { message: "slow down", type: "rate_limit_error" } },
          429,
          { "retry-after": "1" },
        );
      }
      return jsonResponse({
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient({
      apiKey: "sk-test",
      limiter,
      fetchImpl,
      clock,
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      jitterRatio: 0,
    });

    const pending = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await clock.advance(0);
    expect(calls).toBe(1);

    await clock.advance(1000);
    const result = await pending;

    expect(calls).toBe(2);
    expect(result.usage?.total_tokens).toBe(7);
    expect(limiter.snapshot().totals.retries).toBe(1);
    expect(limiter.snapshot().totals.tokensSettled).toBe(7);
    expect(limiter.snapshot().usage.active).toBe(0);
  });

  it("streams chunks and settles usage from the final chunk", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const limiter = createLimiter(clock);

    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    let sentBody: any;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient({
      apiKey: "sk-test",
      limiter,
      fetchImpl,
      clock,
    });

    const chunks: unknown[] = [];
    for await (const chunk of client.chatStream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options.include_usage).toBe(true);
    expect(limiter.snapshot().totals.tokensSettled).toBe(5);
    expect(limiter.snapshot().usage.active).toBe(0);
  });

  it("throws a typed error when the network fails permanently", async () => {
    const clock = new FakeClock();
    const limiter = createLimiter(clock);

    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient({
      apiKey: "sk-test",
      limiter,
      fetchImpl,
      clock,
      maxRetries: 0,
    });

    await expect(
      client.chat({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    expect(limiter.snapshot().usage.active).toBe(0);
  });

  it("returns a typed error for upstream HTTP failures", async () => {
    const clock = new FakeClock();
    const limiter = createLimiter(clock);

    const fetchImpl = (async () =>
      jsonResponse({ error: { message: "bad request" } }, 400)) as unknown as typeof fetch;

    const client = new DeepSeekClient({
      apiKey: "sk-test",
      limiter,
      fetchImpl,
      clock,
    });

    await expect(
      client.chat({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { status: 400 } });
  });

  it("refuses streaming through chat()", async () => {
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    await expect(client.chat({ messages: [], stream: true })).rejects.toThrow(
      /chatStream/,
    );
  });
});
