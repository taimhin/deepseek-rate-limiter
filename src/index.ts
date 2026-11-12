export { systemClock } from "./core/clock.js";
export type { Clock } from "./core/clock.js";

export { DeepSeekLimiter } from "./core/limiter.js";
export type {
  Lease,
  LimiterEvent,
  LimiterOptions,
  LimiterSnapshot,
} from "./core/limiter.js";

export { TokenBucket } from "./core/tokenBucket.js";
export type { TokenBucketOptions } from "./core/tokenBucket.js";

export { DailyQuota } from "./core/dailyQuota.js";
export type {
  DailyQuotaOptions,
  DailyQuotaSnapshot,
  QuotaCheck,
} from "./core/dailyQuota.js";

export { RateLimiterError } from "./core/errors.js";
export type { RateLimiterErrorCode } from "./core/errors.js";

export {
  estimateChatRequestTokens,
  estimateChatTokens,
  estimateCompletionTextTokens,
  estimateTextTokens,
} from "./core/estimate.js";
export type { ChatTokenEstimate, TokenEstimateOptions } from "./core/estimate.js";

export { createSseParser, parseSseStream } from "./core/sse.js";
export type { SseLine } from "./core/sse.js";

export { accumulateStreamChunk, extractUsage } from "./core/usage.js";
export type { StreamAccumulator, Usage } from "./core/usage.js";

export { DeepSeekClient } from "./client/deepseekClient.js";
export type {
  CallOptions,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  DeepSeekClientOptions,
} from "./client/deepseekClient.js";

export {
  backoffDelay,
  joinUrl,
  parseRetryAfter,
  sendWithRetry,
} from "./client/upstream.js";
export type {
  RetryOptions,
  UpstreamContext,
  UpstreamResponse,
  UpstreamSendOptions,
} from "./client/upstream.js";
