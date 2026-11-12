import type { Clock } from "../core/clock.js";
import type { LimiterOptions } from "../core/limiter.js";
import type { RetryOptions } from "../client/upstream.js";
import type { LogLevel } from "./logger.js";

export interface ServerConfig {
  host: string;
  port: number;
  /** Optional key clients must present. Empty/undefined disables proxy auth. */
  proxyApiKey?: string;
  corsOrigin?: string;
  logLevel: LogLevel;
  deepseek: {
    apiKey: string;
    baseUrl: string;
    /** Per-attempt upstream timeout. */
    timeoutMs: number;
  };
  limiter: Omit<LimiterOptions, "clock" | "onEvent">;
  retry: Pick<RetryOptions, "maxRetries" | "baseDelayMs" | "maxDelayMs">;
  /** Completion tokens reserved when a request has no max_tokens. */
  expectedCompletionTokens: number;
  /** Add stream_options.include_usage to streaming requests. */
  forceIncludeUsage: boolean;
  /** Injectable clock for tests. */
  clock?: Clock;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = optional(env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required. Copy .env.example to .env and add your key, " +
        "or export DEEPSEEK_API_KEY before starting the proxy.",
    );
  }

  const baseUrl = optional(env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com";
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("DEEPSEEK_BASE_URL must start with http:// or https://");
  }

  const logLevel = (optional(env.LOG_LEVEL) ?? "info").toLowerCase();
  if (!isLogLevel(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of debug, info, warn, error (got "${logLevel}")`);
  }

  const maxRetries = integer(env, "DEEPSEEK_MAX_RETRIES", 3, 0);
  const baseDelayMs = integer(env, "DEEPSEEK_RETRY_BASE_MS", 500, 0);
  const maxDelayMs = integer(env, "DEEPSEEK_RETRY_MAX_MS", 30_000, baseDelayMs);

  return {
    host: optional(env.HOST) ?? "127.0.0.1",
    port: integer(env, "PORT", 8787, 1, { max: 65_535 }),
    proxyApiKey: optional(env.PROXY_API_KEY),
    corsOrigin: optional(env.CORS_ORIGIN),
    logLevel,
    deepseek: {
      apiKey,
      baseUrl,
      timeoutMs: integer(env, "REQUEST_TIMEOUT_MS", 600_000, 1),
    },
    limiter: {
      requestsPerMinute: integer(env, "DEEPSEEK_RPM", 60, 1),
      tokensPerMinute: integer(env, "DEEPSEEK_TPM", 60_000, 1),
      maxConcurrency: integer(env, "DEEPSEEK_MAX_CONCURRENCY", 8, 1),
      dailyTokenQuota: integer(env, "DEEPSEEK_DAILY_TOKEN_QUOTA", 0, 0),
      dailyRequestQuota: integer(env, "DEEPSEEK_DAILY_REQUEST_QUOTA", 0, 0),
      maxQueueSize: integer(env, "DEEPSEEK_MAX_QUEUE_SIZE", 200, 0),
      queueTimeoutMs: integer(env, "DEEPSEEK_QUEUE_TIMEOUT_MS", 120_000, 0),
      burstMultiplier: decimal(env, "DEEPSEEK_BURST_MULTIPLIER", 1, 0.001),
      utcOffsetMinutes: integer(env, "DEEPSEEK_UTC_OFFSET_MINUTES", 0, -720, { max: 840 }),
    },
    retry: { maxRetries, baseDelayMs, maxDelayMs },
    expectedCompletionTokens: integer(env, "DEEPSEEK_EXPECTED_COMPLETION_TOKENS", 512, 0),
    forceIncludeUsage: bool(env, "DEEPSEEK_FORCE_INCLUDE_USAGE", true),
  };
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  options: { max?: number } = {},
): number {
  const raw = optional(env[name]);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer (got "${raw}")`);
  }
  if (value < min) {
    throw new Error(`${name} must be >= ${min} (got ${value})`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be <= ${options.max} (got ${value})`);
  }
  return value;
}

function decimal(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = optional(env[name]);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min} (got "${raw}")`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optional(env[name])?.toLowerCase();
  if (raw === undefined) return fallback;

  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean (got "${raw}")`);
}

function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
