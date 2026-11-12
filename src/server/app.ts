import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { estimateChatTokens, estimateCompletionTextTokens, estimateTextTokens } from "../core/estimate.js";
import { RateLimiterError } from "../core/errors.js";
import { DeepSeekLimiter } from "../core/limiter.js";
import { createSseParser } from "../core/sse.js";
import {
  accumulateStreamChunk,
  extractUsage,
  type StreamAccumulator,
} from "../core/usage.js";
import { joinUrl, sendWithRetry, type UpstreamContext } from "../client/upstream.js";
import type { ServerConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { Metrics, renderPrometheus } from "./metrics.js";

export interface CreateAppOptions {
  config: ServerConfig;
  limiter?: DeepSeekLimiter;
  metrics?: Metrics;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface CreatedApp {
  app: Express;
  limiter: DeepSeekLimiter;
  metrics: Metrics;
}

const MODELS_TIMEOUT_MS = 15_000;
const MAX_BODY_SIZE = "16mb";

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export function createApp(options: CreateAppOptions): CreatedApp {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel);
  const limiter =
    options.limiter ??
    new DeepSeekLimiter({ ...config.limiter, clock: config.clock });
  const metrics = options.metrics ?? new Metrics();

  const upstream: UpstreamContext = {
    baseUrl: config.deepseek.baseUrl,
    apiKey: config.deepseek.apiKey,
    limiter,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: config.deepseek.timeoutMs,
    clock: config.clock,
    ...config.retry,
  };

  const app = express();
  app.disable("x-powered-by");

  if (config.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigin as string);
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-api-key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.use((req, res, next) => {
    const startedAt = Date.now();

    res.on("finish", () => {
      const level =
        res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      logger[level](`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });

    next();
  });

  const requireProxyAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.proxyApiKey) {
      next();
      return;
    }

    const header = req.header("authorization");
    const bearer =
      header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const provided = bearer ?? req.header("x-api-key")?.trim();

    if (!provided || !safeEqual(provided, config.proxyApiKey)) {
      sendError(res, 401, "Invalid proxy API key", "authentication_error", "invalid_api_key");
      return;
    }
    next();
  };

  app.get("/", (_req, res) => {
    res.json({
      name: "deepseek-rate-limiter",
      endpoints: [
        "POST /v1/chat/completions",
        "GET /v1/models",
        "GET /healthz",
        "GET /stats",
        "GET /metrics",
      ],
    });
  });

  app.get("/healthz", (_req, res) => {
    const snapshot = limiter.snapshot();
    res.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      active: snapshot.usage.active,
      queued: snapshot.usage.queued,
    });
  });

  app.get("/stats", requireProxyAuth, (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      limiter: limiter.snapshot(),
      metrics: metrics.snapshot(),
    });
  });

  app.get("/metrics", requireProxyAuth, (_req, res) => {
    res.type("text/plain; version=0.0.4; charset=utf-8");
    res.send(renderPrometheus(limiter.snapshot(), metrics.snapshot()));
  });

  app.use("/v1", requireProxyAuth);

  app.get(["/v1/models", "/models"], async (_req, res) => {
    try {
      const response = await (options.fetchImpl ?? fetch)(
        joinUrl(config.deepseek.baseUrl, "/models"),
        {
          headers: {
            authorization: `Bearer ${config.deepseek.apiKey}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        },
      );

      const text = await response.text();
      res.status(response.status).type("application/json").send(text);
    } catch (error) {
      logger.warn("Failed to proxy /models", error);
      sendError(res, 502, "Failed to reach DeepSeek", "upstream_error", "upstream_unavailable");
    }
  });

  app.post(["/v1/chat/completions", "/chat/completions"], requireProxyAuth, (req, res) => {
    void handleChatCompletion(req, res);
  });

  async function handleChatCompletion(req: Request, res: Response): Promise<void> {
    const rawBody: unknown = req.body;
    if (!isPlainObject(rawBody)) {
      sendError(
        res,
        400,
        "Request body must be a JSON object",
        "invalid_request_error",
        "invalid_body",
      );
      return;
    }

    metrics.recordRequest();

    const isStream = rawBody.stream === true;
    const body =
      isStream && config.forceIncludeUsage ? withIncludeUsage(rawBody) : rawBody;

    const estimate = estimateChatTokens(body, {
      expectedCompletionTokens: config.expectedCompletionTokens,
    });

    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);

    try {
      const { response, lease } = await sendWithRetry(upstream, {
        path: "/chat/completions",
        body,
        estimatedTokens: estimate.total,
        signal: controller.signal,
        headers: isStream ? { accept: "text/event-stream" } : undefined,
      });

      try {
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          metrics.recordFailure(response.status);
          res
            .status(response.status)
            .type(response.headers.get("content-type") ?? "application/json")
            .send(
              text ||
                JSON.stringify({
                  error: {
                    message: `DeepSeek API error ${response.status}`,
                    type: "upstream_error",
                    code: "upstream_error",
                  },
                }),
            );
          return;
        }

        if (isStream) {
          await pipeStream(res, response, lease, estimate, controller.signal);
        } else {
          await forwardJson(res, response, lease, estimate);
        }
      } finally {
        lease.release();
      }
    } catch (error) {
      metrics.recordFailure();
      handleError(res, error, logger);
    } finally {
      res.off("close", onClose);
    }
  }

  async function forwardJson(
    res: Response,
    upstreamResponse: FetchResponse,
    lease: { settle(tokens: number): void },
    estimate: { prompt: number },
  ): Promise<void> {
    const text = await upstreamResponse.text();
    let json: Record<string, any>;

    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      metrics.recordFailure(502);
      sendError(
        res,
        502,
        "DeepSeek returned a non-JSON response",
        "upstream_error",
        "invalid_upstream_response",
      );
      return;
    }

    const usage = extractUsage(json);
    const promptTokens = usage?.prompt_tokens ?? estimate.prompt;
    const completionTokens =
      usage?.completion_tokens ?? estimateCompletionTextTokens(json);
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

    lease.settle(totalTokens);
    metrics.recordSuccess(promptTokens, completionTokens);

    res.status(200).json(json);
  }

  async function pipeStream(
    res: Response,
    upstreamResponse: FetchResponse,
    lease: { settle(tokens: number): void },
    estimate: { prompt: number },
    signal: AbortSignal,
  ): Promise<void> {
    if (!upstreamResponse.body) {
      metrics.recordFailure(502);
      sendError(
        res,
        502,
        "DeepSeek returned an empty stream",
        "upstream_error",
        "empty_stream",
      );
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    metrics.activeStreams += 1;

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const state: StreamAccumulator = { text: "" };
    let finished = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        if (!value) continue;

        if (!res.write(value)) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
          if (res.destroyed || res.writableEnded) break;
        }

        for (const line of parser.push(decoder.decode(value, { stream: true }))) {
          consumeSseLine(line.data, state);
        }
      }

      for (const line of parser.flush()) {
        consumeSseLine(line.data, state);
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.warn("Streaming failed", error);
      }
    } finally {
      metrics.activeStreams = Math.max(0, metrics.activeStreams - 1);
      if (finished) {
        metrics.recordSuccess(
          state.usage?.prompt_tokens ?? estimate.prompt,
          state.usage?.completion_tokens ?? estimateTextTokens(state.text),
        );
      } else {
        metrics.recordFailure();
      }

      const usage = state.usage;
      const promptTokens = usage?.prompt_tokens ?? estimate.prompt;
      const completionTokens = usage?.completion_tokens ?? estimateTextTokens(state.text);
      const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

      lease.settle(totalTokens);

      if (!res.writableEnded) res.end();
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  }

  // JSON body parse errors and any unhandled route errors.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      sendError(res, 400, "Invalid JSON body", "invalid_request_error", "invalid_json");
      return;
    }

    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : NaN;

    if (Number.isInteger(status) && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : "Request rejected";
      sendError(res, status, message, "invalid_request_error", "request_rejected");
      return;
    }

    logger.error("Unhandled error", error);
    sendError(res, 500, "Internal server error", "server_error", "internal_error");
  });

  return { app, limiter, metrics };
}

function consumeSseLine(data: string, state: StreamAccumulator): void {
  if (data === "[DONE]" || data.trim() === "") return;

  try {
    accumulateStreamChunk(JSON.parse(data), state);
  } catch {
    // Ignore malformed keep-alive or partial chunks.
  }
}

function withIncludeUsage(body: Record<string, unknown>): Record<string, unknown> {
  const existing =
    typeof body.stream_options === "object" && body.stream_options !== null
      ? (body.stream_options as Record<string, unknown>)
      : {};

  return {
    ...body,
    stream_options: { include_usage: true, ...existing },
  };
}

function handleError(res: Response, error: unknown, logger: Logger): void {
  if (error instanceof RateLimiterError) {
    if (error.code === "ABORTED") {
      if (!res.headersSent && !res.writableEnded) {
        sendError(res, 499, "Client closed the request", "request_aborted", error.code);
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const status =
      error.code === "QUEUE_FULL" ||
      error.code === "QUEUE_TIMEOUT" ||
      error.code === "DAILY_QUOTA_EXCEEDED"
        ? 429
        : error.code === "UPSTREAM_TIMEOUT"
          ? 504
          : 502;

    const type = status === 429 ? "rate_limit_error" : "upstream_error";
    sendError(res, status, error.message, type, error.code);
    return;
  }

  logger.error("Unexpected request failure", error);
  sendError(res, 500, "Internal server error", "server_error", "internal_error");
}

function sendError(
  res: Response,
  status: number,
  message: string,
  type: string,
  code: string,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  if (status === 429) res.setHeader("Retry-After", "1");
  res.status(status).json({ error: { message, type, code } });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
