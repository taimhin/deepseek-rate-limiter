import { systemClock, type Clock } from "../core/clock.js";
import {
  estimateChatTokens,
  estimateCompletionTextTokens,
  estimateTextTokens,
} from "../core/estimate.js";
import { RateLimiterError } from "../core/errors.js";
import { DeepSeekLimiter, type LimiterOptions } from "../core/limiter.js";
import { parseSseStream } from "../core/sse.js";
import { accumulateStreamChunk, type StreamAccumulator, type Usage } from "../core/usage.js";
import { sendWithRetry, type RetryOptions, type UpstreamContext } from "./upstream.js";

export interface DeepSeekClientOptions extends RetryOptions {
  /** DeepSeek API key. Keep it server-side. */
  apiKey: string;
  /** Defaults to https://api.deepseek.com. */
  baseUrl?: string;
  /**
   * Reuse an existing limiter. If omitted, one is created from
   * `limiterOptions` (default: 60 RPM, 60k TPM, 8 concurrent requests).
   */
  limiter?: DeepSeekLimiter;
  limiterOptions?: LimiterOptions;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  /** Completion tokens reserved when a request has no max_tokens. Default 512. */
  expectedCompletionTokens?: number;
  /** Inject a clock (used by tests). */
  clock?: Clock;
}

export interface ChatCompletionRequest {
  messages?: Array<Record<string, unknown>>;
  prompt?: string | string[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<Record<string, any>>;
  usage?: Usage;
  [key: string]: unknown;
}

export type ChatCompletionChunk = Record<string, any>;

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * Thin DeepSeek client with built-in rate limiting, queueing and retries.
 *
 * ```ts
 * const client = new DeepSeekClient({
 *   apiKey: process.env.DEEPSEEK_API_KEY!,
 *   limiterOptions: { requestsPerMinute: 60, tokensPerMinute: 60_000 },
 * });
 * const result = await client.chat({ messages: [{ role: "user", content: "Hi" }] });
 * ```
 */
export class DeepSeekClient {
  readonly limiter: DeepSeekLimiter;

  private readonly upstream: UpstreamContext;
  private readonly expectedCompletionTokens: number;

  constructor(options: DeepSeekClientOptions) {
    if (!options.apiKey) {
      throw new Error("DeepSeekClient requires an apiKey");
    }

    this.limiter =
      options.limiter ??
      new DeepSeekLimiter({
        requestsPerMinute: 60,
        tokensPerMinute: 60_000,
        maxConcurrency: 8,
        ...options.limiterOptions,
        clock: options.clock,
      });

    this.expectedCompletionTokens = options.expectedCompletionTokens ?? 512;
    this.upstream = {
      baseUrl: options.baseUrl ?? "https://api.deepseek.com",
      apiKey: options.apiKey,
      limiter: this.limiter,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      defaultHeaders: options.defaultHeaders,
      clock: options.clock ?? systemClock,
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      jitterRatio: options.jitterRatio,
      random: options.random,
      retryOnStatuses: options.retryOnStatuses,
    };
  }

  /** Non-streaming chat completion. */
  async chat(
    body: ChatCompletionRequest,
    options: CallOptions = {},
  ): Promise<ChatCompletionResponse> {
    if (body.stream) {
      throw new Error("chat() does not support streaming; use chatStream() instead");
    }

    const estimate = estimateChatTokens(body, {
      expectedCompletionTokens: this.expectedCompletionTokens,
    });

    const { response, lease } = await sendWithRetry(this.upstream, {
      path: "/chat/completions",
      body,
      estimatedTokens: estimate.total,
      signal: options.signal,
    });

    try {
      const text = await response.text();

      if (!response.ok) {
        throw new RateLimiterError(
          "UPSTREAM_UNAVAILABLE",
          `DeepSeek API error ${response.status}: ${truncate(text, 500)}`,
          { status: response.status, body: text },
        );
      }

      const json = safeJsonParse<ChatCompletionResponse>(text);
      if (!json) {
        throw new RateLimiterError(
          "UPSTREAM_UNAVAILABLE",
          "DeepSeek returned a non-JSON response",
          { status: response.status, body: text },
        );
      }

      const actual =
        json.usage?.total_tokens ?? estimate.prompt + estimateCompletionTextTokens(json);
      lease.settle(actual);
      return json;
    } finally {
      lease.release();
    }
  }

  /**
   * Streaming chat completion. Yields parsed SSE chunks.
   * `stream_options.include_usage` is enabled by default so the final chunk
   * carries exact token usage.
   */
  async *chatStream(
    body: ChatCompletionRequest,
    options: CallOptions = {},
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const payload: ChatCompletionRequest = {
      ...body,
      stream: true,
      stream_options: {
        include_usage: true,
        ...(typeof body.stream_options === "object" && body.stream_options !== null
          ? body.stream_options
          : {}),
      },
    };

    const estimate = estimateChatTokens(payload, {
      expectedCompletionTokens: this.expectedCompletionTokens,
    });

    const { response, lease } = await sendWithRetry(this.upstream, {
      path: "/chat/completions",
      body: payload,
      estimatedTokens: estimate.total,
      signal: options.signal,
      headers: { accept: "text/event-stream" },
    });

    const state: StreamAccumulator = { text: "" };

    try {
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new RateLimiterError(
          "UPSTREAM_UNAVAILABLE",
          `DeepSeek API error ${response.status}: ${truncate(text, 500)}`,
          { status: response.status, body: text },
        );
      }

      for await (const line of parseSseStream(response.body)) {
        if (line.data === "[DONE]") continue;

        const chunk = safeJsonParse<ChatCompletionChunk>(line.data);
        if (!chunk) continue;

        accumulateStreamChunk(chunk, state);
        yield chunk;
      }
    } finally {
      lease.settle(state.usage?.total_tokens ?? estimate.prompt + estimateTextTokens(state.text));
      lease.release();
    }
  }
}

function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
