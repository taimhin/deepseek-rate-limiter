import type { Clock } from "../src/core/clock.js";
import { DeepSeekLimiter, type LimiterOptions } from "../src/core/limiter.js";

interface FakeTimer {
  at: number;
  resolve: () => void;
}

/**
 * Deterministic clock: `sleep()` only resolves when `advance()` moves time
 * past the deadline. Enough microtask flushes are performed between timers so
 * promise chains (limiter pump → waiter resolve → caller continuation) settle.
 */
export class FakeClock implements Clock {
  private current: number;
  private readonly timers: FakeTimer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + Math.max(0, ms), resolve });
    });
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    await flushMicrotasks();

    const target = this.current + ms;

    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];

      if (!due) break;

      this.timers.splice(this.timers.indexOf(due), 1);
      this.current = Math.max(this.current, due.at);
      due.resolve();
      await flushMicrotasks();
    }

    this.current = target;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

export function createLimiter(
  clock: Clock,
  overrides: Partial<LimiterOptions> = {},
): DeepSeekLimiter {
  return new DeepSeekLimiter({
    requestsPerMinute: 600,
    tokensPerMinute: 1_000_000,
    maxConcurrency: 10,
    maxQueueSize: 100,
    queueTimeoutMs: 60_000,
    burstMultiplier: 1,
    clock,
    ...overrides,
  });
}
