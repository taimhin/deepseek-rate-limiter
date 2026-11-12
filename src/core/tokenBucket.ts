import type { Clock } from "./clock.js";

export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per millisecond (e.g. 60 req/min => 60 / 60_000). */
  refillPerMs: number;
  /** Tokens available at construction time. Defaults to a full bucket. */
  initialTokens?: number;
}

/**
 * Classic token bucket with support for "debt" (negative balance), which is
 * useful when a request turns out to cost more tokens than estimated.
 */
export class TokenBucket {
  readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefill: number;

  constructor(options: TokenBucketOptions, clock: Clock) {
    if (!(options.capacity > 0)) {
      throw new RangeError("TokenBucket capacity must be greater than 0");
    }
    if (!(options.refillPerMs >= 0)) {
      throw new RangeError("TokenBucket refillPerMs must be >= 0");
    }
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.clock = clock;
    this.tokens = Math.min(options.capacity, options.initialTokens ?? options.capacity);
    this.lastRefill = clock.now();
  }

  /** Tokens currently available (may be negative while paying back debt). */
  available(now: number = this.clock.now()): number {
    this.refill(now);
    return this.tokens;
  }

  /**
   * Milliseconds until `amount` tokens are available.
   * Returns 0 when the tokens are already there, and Infinity when the amount
   * can never fit in the bucket.
   */
  timeUntil(amount: number, now: number = this.clock.now()): number {
    if (amount <= 0) return 0;
    if (amount > this.capacity) return Number.POSITIVE_INFINITY;

    this.refill(now);
    if (this.tokens >= amount) return 0;
    if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY;

    return Math.ceil((amount - this.tokens) / this.refillPerMs);
  }

  /** Consume tokens, allowing the balance to go negative (debt). */
  consume(amount: number, now: number = this.clock.now()): void {
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens - amount);
  }

  /** Give tokens back, never exceeding the capacity. */
  refund(amount: number, now: number = this.clock.now()): void {
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens + amount);
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}
