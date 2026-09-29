import { describe, expect, it, vi } from "vitest";
import { createAdaptiveLimiter, fsConcurrency, retryAfter } from "../src/limit.ts";

/** A task that resolves only when released, so a test can hold slots open on purpose. */
function held(): { task: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { task: () => done, release };
}

/** Run `count` tasks that each take `ms`, all at once, and report the peak overlap. */
async function saturate(
  limit: <T>(task: () => Promise<T>) => Promise<T>,
  count: number,
  ms: number,
): Promise<number> {
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: count }, () =>
      limit(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, ms));
        active--;
      }),
    ),
  );
  return peak;
}

const fails = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("createAdaptiveLimiter", () => {
  it("never runs more than the current limit at once", async () => {
    const limit = createAdaptiveLimiter({ start: 3, min: 3, max: 3 });
    expect(await saturate(limit, 12, 1)).toBe(3);
  });

  it("grows while a saturated gate keeps succeeding", async () => {
    const limit = createAdaptiveLimiter({ start: 4, min: 4, max: 32 });
    await saturate(limit, 60, 30);
    expect(limit.limit).toBeGreaterThan(4);
  });

  it("stays put when the caller never fills it", async () => {
    // Three fast requests on a warm install say nothing about how many the registry wants.
    const limit = createAdaptiveLimiter({ start: 8, min: 4, max: 64 });
    for (let i = 0; i < 20; i++) await limit(async () => {});
    expect(limit.limit).toBe(8);
  });

  it("halves on a 429 and does not immediately probe back up", async () => {
    const limit = createAdaptiveLimiter({ start: 16, min: 2, max: 64 });
    await expect(limit(() => Promise.reject(fails(429)))).rejects.toThrow("HTTP 429");
    expect(limit.limit).toBe(8);
    // Growth is frozen for the cooldown, so a busy stretch right after cannot undo it. It may
    // still fall further — a throttle stops us asking for more, it does not set a floor.
    await saturate(limit, 40, 30);
    expect(limit.limit).toBeLessThanOrEqual(8);
  });

  it("wins back what a 429 cost one request at a time, not in one wave", async () => {
    // A throttle that a single busy moment undoes is worth nothing: the registry complains,
    // gets one quiet second, and is then hit harder than before. Real time, real cooldown.
    const limit = createAdaptiveLimiter({ start: 16, min: 2, max: 64 });
    await expect(limit(() => Promise.reject(fails(429)))).rejects.toThrow("HTTP 429");
    expect(limit.limit).toBe(8);
    await new Promise((resolve) => setTimeout(resolve, 1050));

    // Twelve at once against a gate of eight. Doubling would be at the ceiling three
    // successes in; one at a time cannot pass eight plus twelve however busy it gets.
    // Long enough responses that the scheduler's own jitter is not a latency regime: well above
    // Windows' ~16 ms timer step, which makes a 5 ms task anything from 1 to 16.
    await saturate(limit, 12, 30);
    expect(limit.limit).toBeGreaterThan(8);
    expect(limit.limit).toBeLessThanOrEqual(20);

    // And the next one halves whatever it has won back, which is the sawtooth we want.
    const won = limit.limit;
    await expect(limit(() => Promise.reject(fails(429)))).rejects.toThrow("HTTP 429");
    expect(limit.limit).toBe(Math.floor(won / 2));
  });

  it("takes a task's word for it when a retry hid the push back", async () => {
    // A request retried until it succeeded looks like a slow success from outside. Only the
    // task knows the server said no, and it has to be able to say so.
    const limit = createAdaptiveLimiter({ start: 16, min: 2, max: 64 });
    await limit(async (signal) => {
      signal.throttled();
      return "fine";
    });
    expect(limit.limit).toBe(8);
  });

  it("judges a task on the part it was told to measure", async () => {
    // A gate over a request that then hands its result to a slower gate must not read that
    // wait as a slow server, or it closes itself over work that was never the server's.
    //
    // On fake time, because the subject is which interval gets measured and not how long it
    // takes. The gate weighs every sample against a running mean of the others, so on the real
    // clock a 2 ms timer returning at 5 ms is already a whole sample's worth of drift, and four
    // unlucky ones shrink the gate for reasons that have nothing to do with settled().
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const limit = createAdaptiveLimiter({ start: 8, min: 2, max: 64 });
      const settle = async (signal: { settled: () => void }) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        signal.settled();
        await new Promise((resolve) => setTimeout(resolve, 60)); // somebody else's queue
      };
      // Started, then run out: the task schedules its first timer synchronously, so the clock
      // may only move once there is something for it to fire.
      const through = async (task: Promise<unknown>, ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await task;
      };

      // A mean has to exist before anything can drift above it.
      for (let i = 0; i < 5; i++) {
        await through(
          limit(() => new Promise((r) => setTimeout(r, 2))),
          2,
        );
      }
      for (let i = 0; i < 10; i++) await through(limit(settle), 62);

      // 2 ms against a 2 ms mean is no drift at all. Measure the whole task instead and every
      // one of these is 62 ms, which trips RISING by the fourth and takes the gate to 5.
      expect(limit.limit).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count a wait of the task's own before its request", async () => {
    // The store waits, slot in hand, for landed bytes to be stored before it asks for more: a
    // full disk, not a slow server. Fake time, as above.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const limit = createAdaptiveLimiter({ start: 8, min: 2, max: 64 });
      const late = async (signal: { restart: () => void }) => {
        await new Promise((resolve) => setTimeout(resolve, 60)); // the disk catching up
        signal.restart();
        await new Promise((resolve) => setTimeout(resolve, 2));
      };
      const through = async (task: Promise<unknown>, ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await task;
      };
      for (let i = 0; i < 5; i++) {
        await through(
          limit(() => new Promise((r) => setTimeout(r, 2))),
          2,
        );
      }
      for (let i = 0; i < 10; i++) await through(limit(late), 62);
      expect(limit.limit).toBe(8); // counted from the start, these trip RISING as above
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a timeout as back pressure and a 404 as a fault", async () => {
    const throttled = createAdaptiveLimiter({ start: 16, min: 2, max: 64 });
    const broken = createAdaptiveLimiter({ start: 16, min: 2, max: 64 });
    await expect(
      throttled(() => Promise.reject(Object.assign(new Error("slow"), { code: "ETIMEDOUT" }))),
    ).rejects.toThrow("slow");
    await expect(broken(() => Promise.reject(fails(404)))).rejects.toThrow("HTTP 404");
    expect(throttled.limit).toBe(8);
    expect(broken.limit).toBe(16);
  });

  it("keeps a floor under continuous throttling", async () => {
    const limit = createAdaptiveLimiter({ start: 32, min: 4, max: 64 });
    for (let i = 0; i < 20; i++) {
      await expect(limit(() => Promise.reject(fails(503)))).rejects.toThrow("HTTP 503");
    }
    expect(limit.limit).toBe(4);
  });

  it("backs off when latency drifts up rather than on one slow response", async () => {
    const limit = createAdaptiveLimiter({ start: 8, min: 2, max: 8 });
    // Well above Windows' ~16 ms timer step, whose jitter on a 5 ms task reads as drift.
    await saturate(limit, 40, 30);
    const settled = limit.limit;
    await limit(() => new Promise((resolve) => setTimeout(resolve, 150))); // one bad response
    expect(limit.limit).toBe(settled);
    for (let i = 0; i < 8; i++) await limit(() => new Promise((r) => setTimeout(r, 150)));
    expect(limit.limit).toBeLessThan(settled);
  });

  it("hands a freed slot to the task that has waited longest", async () => {
    const limit = createAdaptiveLimiter({ start: 1, min: 1, max: 1 });
    const first = held();
    const order: number[] = [];
    const running = limit(first.task);
    const queued = [1, 2, 3].map((n) => limit(async () => void order.push(n)));
    first.release();
    await Promise.all([running, ...queued]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the slot when a task throws", async () => {
    const limit = createAdaptiveLimiter({ start: 2, min: 2, max: 2 });
    await expect(limit(() => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(await saturate(limit, 6, 1)).toBe(2);
  });

  it("clamps a start outside its own bounds", () => {
    expect(createAdaptiveLimiter({ start: 1, min: 4, max: 64 }).limit).toBe(4);
    expect(createAdaptiveLimiter({ start: 500, min: 4, max: 64 }).limit).toBe(64);
    // A max below the floor wins: the caller asked for at most that many.
    expect(createAdaptiveLimiter({ start: 8, min: 4, max: 2 }).limit).toBe(2);
  });
});

describe("fsConcurrency", () => {
  it("sits between the floor and the ceiling whatever the machine", () => {
    const size = fsConcurrency();
    expect(size).toBeGreaterThanOrEqual(4);
    expect(size).toBeLessThanOrEqual(16);
  });
});

describe("retryAfter", () => {
  const asking = (value?: string) =>
    new Response("slow down", {
      status: 429,
      headers: value === undefined ? {} : { "retry-after": value },
    });

  it("reads a count of seconds", () => {
    expect(retryAfter(asking("2"))).toBe(2000);
    expect(retryAfter(asking("0.5"))).toBe(500);
  });

  it("reads an HTTP date", () => {
    const soon = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfter(asking(soon))).toBeGreaterThan(3000);
    expect(retryAfter(asking(soon))).toBeLessThanOrEqual(5000);
  });

  it("is zero when the server said nothing usable", () => {
    // Zero means "we have no instruction", and the caller falls back to its own backoff.
    for (const value of [
      undefined,
      "",
      "soon",
      "-5",
      "0",
      new Date(Date.now() - 5000).toUTCString(),
    ]) {
      expect(retryAfter(asking(value))).toBe(0);
    }
  });

  it("will not sit out a punishment longer than an install can wait", () => {
    expect(retryAfter(asking("86400"))).toBe(30_000);
  });
});
