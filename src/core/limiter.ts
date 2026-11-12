import { systemClock, type Clock } from "./clock.js";
import { DailyQuota, type DailyQuotaSnapshot } from "./dailyQuota.js";
import { RateLimiterError } from "./errors.js";
import { TokenBucket } from "./tokenBucket.js";

const MINUTE_MS = 60_000;
/** Fallback wake-up interval while waiting for a concurrency slot. */
const CONCURRENCY_RETRY_MS = 25;

export interface LimiterOptions {
  /** Requests allowed per minute (continuous refill, no hard window). */
  requestsPerMinute: number;
  /** Prompt + reserved completion tokens allowed per minute. */
  tokensPerMinute: number;
  /** Maximum simultaneous leases. Default 8. */
  maxConcurrency?: number;
  /** Daily token budget. 0 / undefined disables it. */
  dailyTokenQuota?: number;
  /** Daily request budget. 0 / undefined disables it. */
  dailyRequestQuota?: number;
  /** Maximum number of waiting requests. 0 means "never queue". Default 200. */
  maxQueueSize?: number;
  /** Maximum time a request may wait for capacity. 0 disables the timeout. Default 120s. */
  queueTimeoutMs?: number;
  /**
   * Burst allowance as a multiple of one minute of quota. Default 1, meaning
   * the bucket starts full (one minute worth of requests/tokens).
   */
  burstMultiplier?: number;
  /** Local day offset for daily quota resets, in minutes. Default 0 (UTC). */
  utcOffsetMinutes?: number;
  clock?: Clock;
  onEvent?: (event: LimiterEvent) => void;
}

export type LimiterEvent =
  | {
      type: "admitted";
      id: number;
      estimatedTokens: number;
      waitMs: number;
      queueLength: number;
    }
  | { type: "completed"; id: number; tokens: number }
  | { type: "rejected"; id: number; code: string; reason: string }
  | { type: "retry"; status?: number; attempt: number }
  | { type: "cooldown"; until: number; delayMs: number };

export interface LimiterSnapshot {
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    maxConcurrency: number;
    dailyTokenQuota: number | null;
    dailyRequestQuota: number | null;
    maxQueueSize: number;
    queueTimeoutMs: number;
  };
  usage: {
    /** Tokens currently available in the RPM bucket (may be fractional). */
    rpmTokens: number;
    /** Tokens currently available in the TPM bucket (may be negative). */
    tpmTokens: number;
    active: number;
    queued: number;
    cooldownUntil: number | null;
  };
  daily: DailyQuotaSnapshot;
  totals: {
    admitted: number;
    completed: number;
    rejected: number;
    retries: number;
    cooldowns: number;
    tokensEstimated: number;
    tokensSettled: number;
  };
}

/** A reservation obtained from the limiter. Always release it when done. */
export interface Lease {
  readonly id: number;
  /** Tokens reserved when the lease was granted. */
  readonly estimatedTokens: number;
  /**
   * Reconcile the reservation with the real token usage. Can be called before
   * `release()` and is safe to call more than once.
   */
  settle(actualTokens: number): void;
  /** Free the concurrency slot and wake queued requests. Idempotent. */
  release(): void;
}

interface Waiter {
  id: number;
  estimatedTokens: number;
  enqueuedAt: number;
  done: boolean;
  resolve: (lease: Lease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type Admission = "admitted" | "fatal" | { retryAt: number };

export class DeepSeekLimiter {
  private readonly clock: Clock;
  private readonly rpm: TokenBucket;
  private readonly tpm: TokenBucket;
  private readonly quota: DailyQuota;
  private readonly requestsPerMinute: number;
  private readonly tokensPerMinute: number;
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private readonly onEvent?: (event: LimiterEvent) => void;
  private readonly rpmCapacity: number;
  private readonly tpmCapacity: number;

  private readonly queue: Waiter[] = [];
  private active = 0;
  private nextId = 1;
  private cooldownUntil = 0;
  private pumping = false;
  private wakeAt: number | null = null;
  private wakeToken = 0;

  private readonly totals = {
    admitted: 0,
    completed: 0,
    rejected: 0,
    retries: 0,
    cooldowns: 0,
    tokensEstimated: 0,
    tokensSettled: 0,
  };

  constructor(options: LimiterOptions) {
    if (!(options.requestsPerMinute > 0)) {
      throw new RangeError("requestsPerMinute must be greater than 0");
    }
    if (!(options.tokensPerMinute > 0)) {
      throw new RangeError("tokensPerMinute must be greater than 0");
    }

    this.clock = options.clock ?? systemClock;
    this.requestsPerMinute = options.requestsPerMinute;
    this.tokensPerMinute = options.tokensPerMinute;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 8));
    this.maxQueueSize = Math.max(0, Math.floor(options.maxQueueSize ?? 200));
    this.queueTimeoutMs = Math.max(0, Math.floor(options.queueTimeoutMs ?? 120_000));
    this.onEvent = options.onEvent;

    const burst = Math.max(0.001, options.burstMultiplier ?? 1);
    const rpmCapacity = Math.max(1, Math.ceil(options.requestsPerMinute * burst));
    const tpmCapacity = Math.max(1, Math.ceil(options.tokensPerMinute * burst));

    this.rpmCapacity = rpmCapacity;
    this.tpmCapacity = tpmCapacity;

    this.rpm = new TokenBucket(
      {
        capacity: rpmCapacity,
        refillPerMs: options.requestsPerMinute / MINUTE_MS,
      },
      this.clock,
    );
    this.tpm = new TokenBucket(
      {
        capacity: tpmCapacity,
        refillPerMs: options.tokensPerMinute / MINUTE_MS,
      },
      this.clock,
    );
    this.quota = new DailyQuota(
      {
        tokenLimit: options.dailyTokenQuota,
        requestLimit: options.dailyRequestQuota,
        utcOffsetMinutes: options.utcOffsetMinutes,
      },
      this.clock,
    );
  }

  /**
   * Wait until the request fits within all limits, then return a lease.
   * Rejects with a `RateLimiterError` when the queue is full, the wait times
   * out, the daily budget is exhausted, or the signal is aborted.
   */
  acquire(estimatedTokens: number, options: { signal?: AbortSignal } = {}): Promise<Lease> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new RateLimiterError("ABORTED", "Request aborted before queueing"));
    }

    // A request can never reserve more than a full bucket; clamp so it can run.
    const requested = Math.max(1, Math.ceil(estimatedTokens));
    const tokens = Math.min(requested, this.tpmCapacity);

    const quotaCheck = this.quota.check(tokens);
    if (!quotaCheck.ok) {
      this.totals.rejected += 1;
      const snapshot = this.quota.snapshot();
      const error = new RateLimiterError(
        "DAILY_QUOTA_EXCEEDED",
        quotaCheck.reason === "requests"
          ? `Daily request quota exhausted (${snapshot.requestsUsed}/${quotaCheck.limit})`
          : `Daily token quota exhausted (${snapshot.tokensUsed}/${quotaCheck.limit} tokens)`,
        { reason: quotaCheck.reason, limit: quotaCheck.limit, used: quotaCheck.used, day: snapshot.day },
      );
      this.emit({ type: "rejected", id: 0, code: error.code, reason: error.message });
      return Promise.reject(error);
    }

    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        id: this.nextId++,
        estimatedTokens: tokens,
        enqueuedAt: this.clock.now(),
        done: false,
        resolve,
        reject,
        signal,
      };

      if (signal) {
        waiter.onAbort = () => {
          if (waiter.done) return;
          this.removeWaiter(waiter);
          this.finishWaiter(waiter);
          this.totals.rejected += 1;
          const error = new RateLimiterError("ABORTED", "Request aborted while waiting");
          this.emit({ type: "rejected", id: waiter.id, code: error.code, reason: error.message });
          reject(error);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.queue.push(waiter);
      this.pump();

      // No queueing allowed (maxQueueSize = 0) or queue overflow: reject now.
      if (!waiter.done && this.queue.length > this.maxQueueSize) {
        this.removeWaiter(waiter);
        this.finishWaiter(waiter);
        this.totals.rejected += 1;
        const error = new RateLimiterError(
          "QUEUE_FULL",
          `Rate limit queue is full (${this.maxQueueSize} waiting)`,
          { queueLength: this.queue.length, maxQueueSize: this.maxQueueSize },
        );
        this.emit({ type: "rejected", id: waiter.id, code: error.code, reason: error.message });
        reject(error);
        return;
      }

      if (waiter.done || this.queueTimeoutMs <= 0) return;

      this.clock.sleep(this.queueTimeoutMs).then(() => {
        if (waiter.done) return;
        this.removeWaiter(waiter);
        this.finishWaiter(waiter);
        this.totals.rejected += 1;
        const error = new RateLimiterError(
          "QUEUE_TIMEOUT",
          `Request waited more than ${this.queueTimeoutMs}ms for rate limit capacity`,
          { queueTimeoutMs: this.queueTimeoutMs },
        );
        this.emit({ type: "rejected", id: waiter.id, code: error.code, reason: error.message });
        reject(error);
      });
    });
  }

  /** Acquire, run `fn`, then always release the lease. */
  async run<T>(
    estimatedTokens: number,
    fn: (lease: Lease) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const lease = await this.acquire(estimatedTokens, options);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /** Pause admissions for `delayMs` (e.g. after an upstream 429). */
  cooldown(delayMs: number): void {
    if (!(delayMs > 0)) return;

    const now = this.clock.now();
    const until = now + delayMs;
    if (until <= this.cooldownUntil) return;

    this.cooldownUntil = until;
    this.totals.cooldowns += 1;
    this.emit({ type: "cooldown", until, delayMs });
    this.scheduleWake(until);
  }

  /** Record a retry attempt (for statistics). */
  recordRetry(status?: number): void {
    this.totals.retries += 1;
    this.emit({ type: "retry", status, attempt: this.totals.retries });
  }

  snapshot(): LimiterSnapshot {
    const now = this.clock.now();
    return {
      limits: {
        requestsPerMinute: this.requestsPerMinute,
        tokensPerMinute: this.tokensPerMinute,
        maxConcurrency: this.maxConcurrency,
        dailyTokenQuota: this.quota.snapshot(now).tokenLimit,
        dailyRequestQuota: this.quota.snapshot(now).requestLimit,
        maxQueueSize: this.maxQueueSize,
        queueTimeoutMs: this.queueTimeoutMs,
      },
      usage: {
        rpmTokens: round3(this.rpm.available(now)),
        tpmTokens: round3(this.tpm.available(now)),
        active: this.active,
        queued: this.queue.length,
        cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : null,
      },
      daily: this.quota.snapshot(now),
      totals: { ...this.totals },
    };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (this.queue.length > 0) {
        const waiter = this.queue[0];
        if (!waiter) break;

        const now = this.clock.now();
        const admission = this.admit(waiter, now);

        if (typeof admission === "object") {
          this.scheduleWake(admission.retryAt);
          return;
        }

        this.queue.shift();
      }
    } finally {
      this.pumping = false;
    }
  }

  private admit(waiter: Waiter, now: number): Admission {
    const quotaCheck = this.quota.check(waiter.estimatedTokens, now);
    if (!quotaCheck.ok) {
      this.finishWaiter(waiter);
      this.totals.rejected += 1;
      const snapshot = this.quota.snapshot(now);
      const error = new RateLimiterError(
        "DAILY_QUOTA_EXCEEDED",
        quotaCheck.reason === "requests"
          ? `Daily request quota exhausted (${snapshot.requestsUsed}/${quotaCheck.limit})`
          : `Daily token quota exhausted (${snapshot.tokensUsed}/${quotaCheck.limit} tokens)`,
        { reason: quotaCheck.reason, limit: quotaCheck.limit, used: quotaCheck.used, day: snapshot.day },
      );
      this.emit({ type: "rejected", id: waiter.id, code: error.code, reason: error.message });
      waiter.reject(error);
      return "fatal";
    }

    if (this.active >= this.maxConcurrency) {
      // A release will call pump() immediately; the timer is just a safety net.
      return { retryAt: now + CONCURRENCY_RETRY_MS };
    }

    if (now < this.cooldownUntil) {
      return { retryAt: this.cooldownUntil };
    }

    const rpmWait = this.rpm.timeUntil(1, now);
    const tpmWait = this.tpm.timeUntil(waiter.estimatedTokens, now);
    const waitMs = Math.max(rpmWait, tpmWait);

    if (waitMs > 0) {
      return { retryAt: now + Math.max(1, waitMs) };
    }

    this.rpm.consume(1, now);
    this.tpm.consume(waiter.estimatedTokens, now);
    this.quota.consume(waiter.estimatedTokens, now);
    this.active += 1;
    this.totals.admitted += 1;
    this.totals.tokensEstimated += waiter.estimatedTokens;

    const lease = this.createLease(waiter.id, waiter.estimatedTokens);
    this.finishWaiter(waiter);
    this.emit({
      type: "admitted",
      id: waiter.id,
      estimatedTokens: waiter.estimatedTokens,
      waitMs: now - waiter.enqueuedAt,
      queueLength: Math.max(0, this.queue.length - 1),
    });
    waiter.resolve(lease);
    return "admitted";
  }

  private createLease(id: number, estimatedTokens: number): Lease {
    let currentTokens = estimatedTokens;
    let reportedTokens = 0;
    let released = false;

    return {
      id,
      estimatedTokens,
      settle: (actualTokens: number): void => {
        if (released) return;

        const actual = Math.max(0, Math.ceil(actualTokens));
        const delta = actual - currentTokens;
        currentTokens = actual;

        if (delta !== 0) {
          // Negative delta refunds the over-reservation.
          this.tpm.consume(delta, this.clock.now());
          this.quota.adjust(delta, this.clock.now());
        }

        this.totals.tokensSettled += actual - reportedTokens;
        reportedTokens = actual;
      },
      release: (): void => {
        if (released) return;
        released = true;

        this.active = Math.max(0, this.active - 1);
        this.totals.completed += 1;
        this.emit({ type: "completed", id, tokens: currentTokens });
        this.pump();
      },
    };
  }

  private scheduleWake(at: number): void {
    if (this.wakeAt !== null && this.wakeAt <= at) return;

    this.wakeAt = at;
    const token = ++this.wakeToken;
    const delay = Math.max(0, at - this.clock.now());

    this.clock.sleep(delay).then(() => {
      if (token !== this.wakeToken) return;
      this.wakeAt = null;
      this.pump();
    });
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private finishWaiter(waiter: Waiter): void {
    waiter.done = true;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private emit(event: LimiterEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // Statistics hooks must never break the limiter.
    }
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
