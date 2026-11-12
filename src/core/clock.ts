/**
 * Small abstraction over time so the limiter can be tested deterministically.
 */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number;
  /** Resolve after roughly `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  },
};
