export type RateLimiterErrorCode =
  | "QUEUE_FULL"
  | "QUEUE_TIMEOUT"
  | "DAILY_QUOTA_EXCEEDED"
  | "ABORTED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT";

/**
 * Error raised by the limiter itself or by the upstream client.
 * HTTP callers can map `code` to a status code (see the proxy for an example).
 */
export class RateLimiterError extends Error {
  readonly code: RateLimiterErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: RateLimiterErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RateLimiterError";
    this.code = code;
    this.details = details;
  }
}
