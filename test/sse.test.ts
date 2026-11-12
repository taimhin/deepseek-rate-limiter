import { describe, expect, it } from "vitest";
import { createSseParser, parseSseStream } from "../src/core/sse.js";

describe("SSE parser", () => {
  it("handles payloads split across chunks", () => {
    const parser = createSseParser();

    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it("supports CRLF, comments and event names", () => {
    const parser = createSseParser();
    const lines = parser.push(
      ": keep-alive\r\nevent: message\r\ndata: hello\r\ndata: world\r\n\r\n",
    );

    expect(lines).toEqual([
      { event: "message", data: "hello" },
      { event: "message", data: "world" },
    ]);
  });

  it("flushes a trailing line without a newline", () => {
    const parser = createSseParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.flush()).toEqual([{ event: undefined, data: "tail" }]);
  });

  it("streams data lines and drops the [DONE] sentinel", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
        controller.enqueue(encoder.encode('data: {"n":2}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });

    const seen: string[] = [];
    for await (const line of parseSseStream(body)) {
      seen.push(line.data);
    }

    expect(seen).toEqual(['{"n":1}', '{"n":2}']);
  });
});
