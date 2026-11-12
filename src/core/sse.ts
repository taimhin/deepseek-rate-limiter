export interface SseLine {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser for `text/event-stream` bodies.
 * Feed it decoded text chunks; it returns the complete `data:` lines it saw.
 */
export function createSseParser(): {
  push(text: string): SseLine[];
  flush(): SseLine[];
} {
  let buffer = "";
  let eventName: string | undefined;

  function parseLines(final: boolean): SseLine[] {
    const out: SseLine[] = [];
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        eventName = undefined;
      } else if (line.startsWith(":")) {
        // comment / keep-alive
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const data = line.slice(5);
        out.push({ event: eventName, data: data.startsWith(" ") ? data.slice(1) : data });
      }

      newlineIndex = buffer.indexOf("\n");
    }

    if (final && buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      if (line.startsWith("data:")) {
        const data = line.slice(5);
        out.push({ event: eventName, data: data.startsWith(" ") ? data.slice(1) : data });
      }
    }

    return out;
  }

  return {
    push(text: string): SseLine[] {
      buffer += text;
      return parseLines(false);
    },
    flush(): SseLine[] {
      return parseLines(true);
    },
  };
}

/**
 * Turn a `ReadableStream` of SSE bytes into an async iterator of `data:` payloads.
 * `[DONE]` sentinels are filtered out.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseLine, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      for (const line of parser.push(decoder.decode(value, { stream: true }))) {
        if (line.data !== "[DONE]") yield line;
      }
    }

    for (const line of parser.flush()) {
      if (line.data !== "[DONE]") yield line;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }
    reader.releaseLock();
  }
}
