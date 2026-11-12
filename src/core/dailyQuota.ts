import type { Clock } from "./clock.js";

export interface DailyQuotaOptions {
  /** Maximum tokens per day. 0 / undefined disables the limit. */
  tokenLimit?: number;
  /** Maximum requests per day. 0 / undefined disables the limit. */
  requestLimit?: number;
  /** Minutes added to UTC before computing the day boundary (e.g. 480 = UTC+8). */
  utcOffsetMinutes?: number;
}

export interface DailyQuotaSnapshot {
  /** Local day in YYYY-MM-DD format (offset applied). */
  day: string;
  tokensUsed: number;
  requestsUsed: number;
  tokenLimit: number | null;
  requestLimit: number | null;
  tokensRemaining: number | null;
  requestsRemaining: number | null;
}

export type QuotaCheck =
  | { ok: true }
  | { ok: false; reason: "tokens" | "requests"; limit: number; used: number };

const DAY_MS = 86_400_000;

/**
 * Rolling daily budget. The counter resets when the local day changes;
 * the boundary is shifted from UTC by `utcOffsetMinutes`.
 *
 * Note: this is in-process state. Run one proxy instance per API key, or move
 * the counters to Redis if you need a shared budget across replicas.
 */
export class DailyQuota {
  private readonly tokenLimit: number | null;
  private readonly requestLimit: number | null;
  private readonly utcOffsetMinutes: number;
  private readonly clock: Clock;

  private dayIndex: number;
  private tokensUsed = 0;
  private requestsUsed = 0;

  constructor(options: DailyQuotaOptions = {}, clock: Clock) {
    this.tokenLimit = toLimit(options.tokenLimit);
    this.requestLimit = toLimit(options.requestLimit);
    this.utcOffsetMinutes = options.utcOffsetMinutes ?? 0;
    this.clock = clock;
    this.dayIndex = this.dayIndexFor(clock.now());
  }

  check(tokens: number, now: number = this.clock.now()): QuotaCheck {
    this.roll(now);

    if (this.requestLimit !== null && this.requestsUsed + 1 > this.requestLimit) {
      return { ok: false, reason: "requests", limit: this.requestLimit, used: this.requestsUsed };
    }
    if (this.tokenLimit !== null && this.tokensUsed + tokens > this.tokenLimit) {
      return { ok: false, reason: "tokens", limit: this.tokenLimit, used: this.tokensUsed };
    }
    return { ok: true };
  }

  /** Record one request costing `tokens` tokens. */
  consume(tokens: number, now: number = this.clock.now()): void {
    this.roll(now);
    this.requestsUsed += 1;
    this.tokensUsed += Math.max(0, tokens);
  }

  /** Adjust the token count after the real usage is known (can be negative). */
  adjust(deltaTokens: number, now: number = this.clock.now()): void {
    if (deltaTokens === 0) return;
    this.roll(now);

    const next = this.tokensUsed + deltaTokens;
    const ceiling = this.tokenLimit ?? Number.POSITIVE_INFINITY;
    this.tokensUsed = Math.max(0, Math.min(ceiling, next));
  }

  snapshot(now: number = this.clock.now()): DailyQuotaSnapshot {
    this.roll(now);

    return {
      day: this.dayString(this.dayIndex),
      tokensUsed: round(this.tokensUsed),
      requestsUsed: this.requestsUsed,
      tokenLimit: this.tokenLimit,
      requestLimit: this.requestLimit,
      tokensRemaining:
        this.tokenLimit === null ? null : Math.max(0, round(this.tokenLimit - this.tokensUsed)),
      requestsRemaining:
        this.requestLimit === null ? null : Math.max(0, this.requestLimit - this.requestsUsed),
    };
  }

  private roll(now: number): void {
    const next = this.dayIndexFor(now);
    if (next === this.dayIndex) return;

    this.dayIndex = next;
    this.tokensUsed = 0;
    this.requestsUsed = 0;
  }

  private dayIndexFor(now: number): number {
    return Math.floor((now + this.utcOffsetMinutes * 60_000) / DAY_MS);
  }

  private dayString(dayIndex: number): string {
    return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
  }
}

function toLimit(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
