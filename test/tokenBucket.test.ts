import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/core/tokenBucket.js";
import { FakeClock } from "./helpers.js";

describe("TokenBucket", () => {
  it("starts full and stops at capacity", async () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({ capacity: 10, refillPerMs: 1 / 1000 }, clock);

    expect(bucket.available()).toBe(10);
    bucket.consume(4);
    expect(bucket.available()).toBe(6);
    bucket.refund(100);
    expect(bucket.available()).toBe(10);
  });

  it("refills continuously over time", async () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({ capacity: 2, refillPerMs: 1 / 30_000 }, clock);

    bucket.consume(2);
    expect(bucket.available()).toBe(0);
    expect(bucket.timeUntil(1)).toBe(30_000);

    await clock.advance(15_000);
    expect(bucket.available()).toBeCloseTo(0.5, 5);
    expect(bucket.timeUntil(1)).toBe(15_000);

    await clock.advance(15_000);
    expect(bucket.available()).toBeCloseTo(1, 5);
    expect(bucket.timeUntil(1)).toBe(0);
  });

  it("supports debt when actual usage exceeds the reservation", async () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({ capacity: 2, refillPerMs: 1 / 30_000 }, clock);

    bucket.consume(4);
    expect(bucket.available()).toBe(-2);
    expect(bucket.timeUntil(1)).toBe(90_000);

    await clock.advance(90_000);
    expect(bucket.available()).toBeCloseTo(1, 5);
  });

  it("never reports a finite wait for an amount larger than capacity", () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({ capacity: 10, refillPerMs: 1 }, clock);

    expect(bucket.timeUntil(11)).toBe(Number.POSITIVE_INFINITY);
    expect(bucket.timeUntil(0)).toBe(0);
  });
});
