import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";

const AUTH = { authorization: "Bearer proxy-secret", "content-type": "application/json" };

let server: Server;
let baseUrl: string;
let mode: "json" | "stream" = "json";
let lastBody: any;
let lastUrl = "";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  proxyApiKey: "proxy-secret",
  logLevel: "error",
  deepseek: {
    apiKey: "sk-upstream",
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 5000,
  },
  limiter: {
    requestsPerMinute: 1000,
    tokensPerMinute: 1_000_000,
    maxConcurrency: 4,
    maxQueueSize: 10,
    queueTimeoutMs: 5000,
    burstMultiplier: 1,
    dailyTokenQuota: 0,
    dailyRequestQuota: 0,
    utcOffsetMinutes: 0,
  },
  retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 10 },
  expectedCompletionTokens: 128,
  forceIncludeUsage: true,
};

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let created: ReturnType<typeof createApp>;

beforeAll(async () => {
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    lastUrl = String(url);
    lastBody = init.body ? JSON.parse(String(init.body)) : undefined;

    if (mode === "stream") {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const appBundle = createApp({ config, fetchImpl, logger: silentLogger });
  created = appBundle;

  server = appBundle.app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("HTTP proxy", () => {
  it("exposes an unauthenticated health check", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("requires the proxy key for inference endpoints", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_api_key" },
    });
  });

  it("forwards a non-streaming completion and settles usage", async () => {
    mode = "json";

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.usage.total_tokens).toBe(5);

    expect(lastUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(lastBody.messages).toHaveLength(1);

    const totals = created.limiter.snapshot().totals;
    expect(totals.completed).toBeGreaterThanOrEqual(1);
    expect(totals.tokensSettled).toBe(5);
    expect(created.limiter.snapshot().usage.active).toBe(0);

    expect(created.metrics.snapshot().requestsSucceeded).toBeGreaterThanOrEqual(1);
  });

  it("pipes streaming completions and forces include_usage", async () => {
    mode = "stream";

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain("[DONE]");

    expect(lastBody.stream).toBe(true);
    expect(lastBody.stream_options.include_usage).toBe(true);

    expect(created.limiter.snapshot().usage.active).toBe(0);
    expect(created.limiter.snapshot().usage.queued).toBe(0);
  });

  it("protects /stats and /metrics with the proxy key", async () => {
    expect((await fetch(`${baseUrl}/stats`)).status).toBe(401);

    const stats = await fetch(`${baseUrl}/stats`, {
      headers: { authorization: "Bearer proxy-secret" },
    });
    expect(stats.status).toBe(200);
    await expect(stats.json()).resolves.toMatchObject({ ok: true });

    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: "Bearer proxy-secret" },
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("deepseek_limiter_queued_requests");
  });

  it("proxies the models endpoint", async () => {
    mode = "json";
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: "Bearer proxy-secret" },
    });

    expect(response.status).toBe(200);
    expect(lastUrl).toBe("https://api.deepseek.com/models");
  });
});
