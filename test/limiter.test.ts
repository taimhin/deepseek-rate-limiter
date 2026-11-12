import { describe, expect, it } from "vitest";
import { DeepSeekLimiter } from "../src/core/limiter.js";
import { createLimiter, FakeClock, flushMicrotasks } from "./helpers.js";

describe("DeepSeekLimiter", () => {
  it("enforces requests per minute with a fair queue", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, {
      requestsPerMinute: 2,
      tokensPerMinute: 1_000_000,
    });

    const first = await limiter.acquire(10);
    const second = await limiter.acquire(10);

    let thirdAdmitted = false;
    const third = limiter.acquire(10).then((lease) => {
      thirdAdmitted = true;
      return lease;
    });

    await flushMicrotasks();
    expect(thirdAdmitted).toBe(false);
    expect(limiter.snapshot().usage.queued).toBe(1);

    await clock.advance(29_999);
    expect(thirdAdmitted).toBe(false);

    await clock.advance(1);
    const thirdLease = await third;
    expect(thirdAdmitted).toBe(true);

    thirdLease.release();
    second.release();
    first.release();
  });

  it("enforces tokens per minute using the reservation", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, {
      requestsPerMinute: 600,
      tokensPerMinute: 1000,
      burstMultiplier: 1,
    });

    const first = await limiter.acquire(600);
    expect(limiter.snapshot().usage.tpmTokens).toBe(400);

    let secondAdmitted = false;
    const second = limiter.acquire(600).then((lease) => {
      secondAdmitted = true;
      return lease;
    });

    await flushMicrotasks();
    expect(secondAdmitted).toBe(false);

    // Need 200 more tokens at 1000 tokens/minute => 12 seconds.
    await clock.advance(12_000);
    const secondLease = await second;
    expect(secondAdmitted).toBe(true);

    secondLease.release();
    first.release();
  });

  it("enforces max concurrency and wakes the queue on release", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, { maxConcurrency: 1 });

    const first = await limiter.acquire(10);
    let secondAdmitted = false;
    const second = limiter.acquire(10).then((lease) => {
      secondAdmitted = true;
      return lease;
    });

    await flushMicrotasks();
    expect(secondAdmitted).toBe(false);

    first.release();
    const secondLease = await second;

    expect(secondAdmitted).toBe(true);
    expect(limiter.snapshot().usage.active).toBe(1);
    expect(limiter.snapshot().totals.completed).toBe(1);

    secondLease.release();
    expect(limiter.snapshot().usage.active).toBe(0);
  });

  it("supports a larger burst window", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, {
      requestsPerMinute: 2,
      burstMultiplier: 2,
    });

    const leases = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire(1)));
    expect(leases).toHaveLength(4);

    let fifthAdmitted = false;
    limiter.acquire(1).then(() => {
      fifthAdmitted = true;
    });

    await flushMicrotasks();
    expect(fifthAdmitted).toBe(false);

    leases.forEach((lease) => lease.release());
  });

  it("rejects when the daily token quota would be exceeded", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, {
      tokensPerMinute: 1000,
      dailyTokenQuota: 100,
    });

    const lease = await limiter.acquire(80);
    lease.release();

    await expect(limiter.acquire(30)).rejects.toMatchObject({
      code: "DAILY_QUOTA_EXCEEDED",
    });
    expect(limiter.snapshot().daily.tokensUsed).toBe(80);
  });

  it("resets the daily quota on the next local day", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 23, 0, 0));
    const limiter = createLimiter(clock, {
      tokensPerMinute: 1000,
      dailyTokenQuota: 100,
    });

    (await limiter.acquire(100)).release();
    await expect(limiter.acquire(1)).rejects.toMatchObject({
      code: "DAILY_QUOTA_EXCEEDED",
    });

    await clock.advance(2 * 60 * 60 * 1000); // 01:00 UTC next day
    const lease = await limiter.acquire(100);
    expect(limiter.snapshot().daily.tokensUsed).toBe(100);
    lease.release();
  });

  it("refunds the difference between estimated and actual tokens", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, { tokensPerMinute: 1000 });

    const lease = await limiter.acquire(500);
    expect(limiter.snapshot().usage.tpmTokens).toBe(500);

    lease.settle(100);
    expect(limiter.snapshot().usage.tpmTokens).toBe(900);
    expect(limiter.snapshot().totals.tokensSettled).toBe(100);

    // Settlement is idempotent.
    lease.settle(100);
    expect(limiter.snapshot().usage.tpmTokens).toBe(900);

    lease.release();
  });

  it("rejects immediately when queueing is disabled", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, { maxConcurrency: 1, maxQueueSize: 0 });

    const first = await limiter.acquire(10);
    await expect(limiter.acquire(10)).rejects.toMatchObject({ code: "QUEUE_FULL" });

    first.release();
  });

  it("times out requests that wait too long", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, { maxConcurrency: 1, queueTimeoutMs: 1000 });

    const first = await limiter.acquire(10);
    const pending = limiter.acquire(10).then(
      () => "admitted",
      (error: { code?: string }) => error.code,
    );

    await flushMicrotasks();
    await clock.advance(1000);
    expect(await pending).toBe("QUEUE_TIMEOUT");

    first.release();
  });

  it("pauses admissions during a cooldown", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock);

    limiter.cooldown(5000);

    let admitted = false;
    const pending = limiter.acquire(10).then((lease) => {
      admitted = true;
      return lease;
    });

    await flushMicrotasks();
    expect(admitted).toBe(false);

    await clock.advance(4999);
    expect(admitted).toBe(false);

    await clock.advance(1);
    const lease = await pending;
    expect(admitted).toBe(true);
    lease.release();
  });

  it("rejects aborted waiters and frees their queue slot", async () => {
    const clock = new FakeClock(0);
    const limiter = createLimiter(clock, { maxConcurrency: 1 });

    const first = await limiter.acquire(10);
    const controller = new AbortController();
    const pending = limiter.acquire(10, { signal: controller.signal }).then(
      () => "admitted",
      (error: { code?: string }) => error.code,
    );

    await flushMicrotasks();
    controller.abort();

    expect(await pending).toBe("ABORTED");
    expect(limiter.snapshot().usage.queued).toBe(0);

    first.release();
  });

  it("reports configured limits in the snapshot", () => {
    const clock = new FakeClock(0);
    const limiter = new DeepSeekLimiter({
      requestsPerMinute: 120,
      tokensPerMinute: 500_000,
      maxConcurrency: 4,
      maxQueueSize: 50,
      queueTimeoutMs: 10_000,
      burstMultiplier: 2,
      dailyTokenQuota: 1_000_000,
      clock,
    });

    const snapshot = limiter.snapshot();
    expect(snapshot.limits.requestsPerMinute).toBe(120);
    expect(snapshot.limits.tokensPerMinute).toBe(500_000);
    expect(snapshot.limits.maxConcurrency).toBe(4);
    expect(snapshot.daily.tokenLimit).toBe(1_000_000);
  });

  it("validates constructor options", () => {
    const clock = new FakeClock(0);
    expect(
      () => new DeepSeekLimiter({ requestsPerMinute: 0, tokensPerMinute: 10, clock }),
    ).toThrow(/requestsPerMinute/);
    expect(
      () => new DeepSeekLimiter({ requestsPerMinute: 1, tokensPerMinute: 0, clock }),
    ).toThrow(/tokensPerMinute/);
  });
});
