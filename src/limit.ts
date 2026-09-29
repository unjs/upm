// Concurrency gates. Two shapes, because the two things an install waits on push back in
// different ways: a disk only ever gets slower, so its gate is a number chosen once from the
// machine, while a registry says "slow down" out loud and is worth listening to when it does.
import { cpus } from "./runtime.ts";

/** Runs at most `limit` tasks at once. Waiters are served in arrival order. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** A gate at a number fixed for the life of the install. */
export function createLimiter(limit: number): Limiter {
  const queue: (() => void)[] = [];
  let active = 0;
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** What a task may tell the gate about the request it just made. Both are optional. */
export interface Signal {
  /**
   * The end of the part this gate is meant to be measuring. A task that holds its slot past
   * its own request — to hand the result to another gate, say — says so here, and waiting on
   * something else then never reads as a slow server. Left alone, the whole task is the
   * measurement.
   */
  settled(): void;
  /**
   * The wait so far was not the far end's: the clock starts again here. A task that waits on
   * something of its own, slot in hand, before its request says so, or a full disk would read
   * as a slow server.
   */
  restart(): void;
  /**
   * The far end asked for fewer, whatever this task goes on to return. A request that was
   * retried until it succeeded is still a request the server pushed back on, and it is the
   * only one that can say so — from the outside it looks like a slow success.
   */
  throttled(): void;
}

export interface AdaptiveLimiter {
  <T>(task: (signal: Signal) => Promise<T>): Promise<T>;
  /** Where the controller has settled. Read by tests, and by anyone persisting it between runs. */
  readonly limit: number;
}

export interface AdaptiveOptions {
  /**
   * Where to begin. Defaults to the ceiling; below it the gate grows one slot per contended
   * fast success, so a far end that keeps up is asked for more, a round trip at a time.
   */
  start?: number;
  /** Never go below this, so a registry that throttles everything still makes progress. */
  min?: number;
  /** Never go above this. */
  max?: number;
}

/** How hard a rising-latency regime pulls back. Five trips take a full pipe down to a quarter. */
const SHRINK = 0.7;
/** After a 429, how long to stop growing entirely and take the server at its word. */
const COOLDOWN = 1000;
/** Smoothing for the running mean. Turns over in roughly 32 samples. */
const SLOW = 1 / 32;
/** How far above the mean a response must sit before it counts as drift rather than jitter. */
const SLACK = 1.25;
/** Samples' worth of sustained excess before the pipe is called congested. */
const RISING = 4;
const THROTTLED = new Set([408, 420, 429, 502, 503, 504]);

/** Statuses that mean "too many, too fast" rather than "broken". */
export function isThrottle(status: number): boolean {
  return THROTTLED.has(status);
}

/**
 * The longest we will sit out a `Retry-After`. Past this the server is either punishing us
 * for longer than an install can wait or has sent something silly, and one more request is
 * cheaper than the alternative.
 */
const PATIENCE = 30_000;

/**
 * How long the server asked us to wait, in milliseconds, if it said. A count of seconds or
 * an HTTP date, per RFC 9110. Guessing instead is what makes a retry useless: three tries
 * 100 ms apart all land inside the one second the server just asked us to skip.
 */
export function retryAfter(response: { headers: { get(name: string): string | null } }): number {
  const asked = response.headers.get("retry-after");
  if (!asked) return 0;
  const seconds = Number(asked);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(asked) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, PATIENCE);
}

/**
 * A limiter that learns how many requests the far end wants. It starts at `start`, halves on
 * a 429 or a timeout, and backs off when latency drifts up for long enough to be congestion
 * rather than one slow response. What it wins it wins one request at a time, and only from
 * work that had to wait, so what a throttle costs is not handed straight back a second later.
 *
 * It never opens more than `max`. The registry gate starts at the 16 every registry was asked
 * for before it grew and may reach 32; the tarball gate starts at
 * its ceiling and only ever asks for fewer.
 */
export function createAdaptiveLimiter(options: AdaptiveOptions = {}): AdaptiveLimiter {
  const max = Math.max(1, options.max ?? 64);
  const min = Math.min(max, Math.max(1, options.min ?? 4));
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.floor(n)));

  let limit = clamp(options.start ?? max);
  let active = 0;
  const queue: (() => void)[] = [];
  let frozen = 0;
  // A running mean of how long a request takes, and the excess over it accumulated so far.
  // Sustained drift adds up here and trips; jitter cancels itself back to zero.
  let slow = 0;
  let drift = 0;

  /** Hand the slot over as we wake a waiter, so a task arriving now cannot take it first. */
  function wake(): void {
    while (queue.length > 0 && active < limit) {
      active++;
      queue.shift()?.();
    }
  }

  function throttle(): void {
    limit = clamp(limit / 2);
    frozen = Date.now() + COOLDOWN;
    drift = 0;
  }

  function observe(ms: number): void {
    if (slow === 0) {
      slow = ms;
      return;
    }
    // Each response contributes how far above the mean it landed, as a multiple of it, and no
    // single one may contribute more than a whole sample: what trips this is a stretch of slow
    // responses, never one unlucky one. Anything at or below the mean pays the excess back.
    const excess = Math.min(1, ms / slow - SLACK);
    slow += (ms - slow) * SLOW;
    drift = Math.max(0, drift + excess);
    if (drift >= RISING) {
      limit = clamp(limit * SHRINK);
      drift = 0;
    }
  }

  function grow(saturated: boolean): void {
    // Only work that had to wait says anything about the ceiling. Three fast requests on a
    // warm install would otherwise talk us up to the maximum having never once been busy.
    if (!saturated || Date.now() < frozen) return;
    limit = clamp(limit + 1);
  }

  const run = async <T>(task: (signal: Signal) => Promise<T>): Promise<T> => {
    // A non-empty queue means someone is already waiting on this gate, so this task is
    // contended too even if a slot happens to free up before it is looked at.
    const saturated = active >= limit || queue.length > 0;
    if (saturated) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    let started = performance.now();
    let took = -1;
    let pushed = false;
    const signal: Signal = {
      settled: () => {
        if (took < 0) took = performance.now() - started;
      },
      restart: () => {
        started = performance.now();
      },
      throttled: () => {
        pushed = true;
      },
    };
    try {
      const value = await task(signal);
      // A request that was retried into a success says nothing about how long a healthy one
      // takes, so it feeds the throttle rather than the latency mean.
      if (pushed) {
        throttle();
        return value;
      }
      signal.settled();
      observe(took);
      grow(saturated);
      return value;
    } catch (error) {
      if (pushed || backpressure(error)) throttle();
      throw error;
    } finally {
      active--;
      wake();
    }
  };

  return Object.defineProperty(run, "limit", { get: () => limit }) as AdaptiveLimiter;
}

/** Busy or rate-limited, not broken: the far end is asking for fewer, not reporting a fault. */
function backpressure(error: unknown): boolean {
  const failure = error as { code?: string; status?: number } | null;
  if (failure?.code === "ETIMEDOUT") return true;
  return failure?.status !== undefined && isThrottle(failure.status);
}

/**
 * How much work bounded by the local disk to run at once. Not adaptive: a filesystem never
 * answers "slow down", it just gets slower for everyone, so the number comes from the machine.
 * The floor keeps a single-core box from linking one entry at a time; the ceiling is where
 * more threads stop buying anything, because metadata operations serialize in the kernel.
 */
export function fsConcurrency(): number {
  return Math.max(4, Math.min(cpus(), 16));
}
