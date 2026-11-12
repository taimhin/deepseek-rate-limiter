import { systemClock, type Clock } from "../core/clock.js";
import { RateLimiterError } from "../core/errors.js";
import type { DeepSeekLimiter, Lease } from "../core/limiter.js";

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default 500ms. */
  baseDelayMs?: number;
  /** Maximum backoff delay. Default 30s. */
  maxDelayMs?: number;
  /** Jitter as a fraction of the delay (0 = none). Default 0.2. */
  jitterRatio?: number;
  /** Injectable RNG for deterministic tests. Default Math.random. */
  random?: () => number;
  /** HTTP status codes that should be retried. */
  retryOnStatuses?: readonly number[];
}

export interface UpstreamContext extends RetryOptions {
  baseUrl: string;
  apiKey: string;
  limiter: DeepSeekLimiter;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  clock?: Clock;
}

export interface UpstreamSendOptions {
  path: string;
  body?: unknown;
  method?: string;
  /** Token reservation for the limiter. */
  estimatedTokens: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface UpstreamResponse {
  /** Upstream response. The caller must read/cancel the body, then release the lease. */
  response: Response;
  /** Reservation held for this response. */
  lease: Lease;
  /** Total attempts made (1 = success on the first try). */
  attempts: number;
}

const DEFAULT_RETRY_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504] as const;

/**
 * Send a JSON request to DeepSeek, acquiring a limiter lease per attempt and
 * retrying transient failures with exponential backoff.
 *
 * 429 responses also set a global cooldown on the limiter, pausing every
 * queued request instead of letting each one hammer the API.
 */
export async function sendWithRetry(
  context: UpstreamContext,
  options: UpstreamSendOptions,
): Promise<UpstreamResponse> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const clock = context.clock ?? systemClock;
  const maxRetries = Math.max(0, context.maxRetries ?? 3);
  const baseDelayMs = Math.max(0, context.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, context.maxDelayMs ?? 30_000);
  const jitterRatio = Math.max(0, context.jitterRatio ?? 0.2);
  const retryStatuses = context.retryOnStatuses ?? DEFAULT_RETRY_STATUSES;

  const url = joinUrl(context.baseUrl, options.path);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${context.apiKey}`,
    accept: "application/json",
    ...context.defaultHeaders,
    ...options.headers,
  };

  const init: RequestInit = {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) {
      throw new RateLimiterError("ABORTED", "Request aborted");
    }

    const lease = await context.limiter.acquire(options.estimatedTokens, {
      signal: options.signal,
    });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: combineSignals(options.signal, context.timeoutMs),
      });
    } catch (error) {
      lease.release();

      if (options.signal?.aborted) {
        throw new RateLimiterError("ABORTED", "Request aborted", {}, { cause: error });
      }
      if (attempt >= maxRetries) {
        throw upstreamError(error, attempt + 1);
      }

      context.limiter.recordRetry();
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, context.random);
      await sleepWithAbort(clock, delay, options.signal);
      continue;
    }

    if (response.ok) {
      return { response, lease, attempts: attempt + 1 };
    }

    const retryable =
      retryStatuses.includes(response.status) || response.status >= 500;

    if (!retryable || attempt >= maxRetries) {
      return { response, lease, attempts: attempt + 1 };
    }

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const delay =
      retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, context.random);

    context.limiter.recordRetry(response.status);
    if (response.status === 429) {
      context.limiter.cooldown(delay);
    }

    // Drain the failed body so the socket can be reused.
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }

    lease.release();
    await sleepWithAbort(clock, delay, options.signal);
  }
}

/** Join a base URL and path without duplicating `/v1`. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let suffix = path.startsWith("/") ? path : `/${path}`;

  if (base.endsWith("/v1") && suffix.startsWith("/v1/")) {
    suffix = suffix.slice(3);
  }
  return `${base}${suffix}`;
}

/** Exponential backoff with symmetric jitter. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));

  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function sleepWithAbort(
  clock: Clock,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return clock.sleep(ms);

  return new Promise<void>((resolve, reject) => {
    let finished = false;

    const finish = (): void => {
      finished = true;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (finished) return;
      finish();
      reject(new RateLimiterError("ABORTED", "Request aborted during backoff"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    clock.sleep(ms).then(() => {
      if (finished) return;
      finish();
      resolve();
    });
  });
}

function upstreamError(error: unknown, attempts: number): RateLimiterError {
  const isTimeout =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "TimeoutError";

  const message = error instanceof Error ? error.message : String(error);
  return new RateLimiterError(
    isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
    `DeepSeek request failed after ${attempts} attempt(s): ${message}`,
    { attempts },
    { cause: error },
  );
}
