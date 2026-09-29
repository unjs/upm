// A registry whose requests run on a few worker threads (src/registry-worker.ts), so the thread
// that walks the tree does the walk and none of the per-request work: on `nuxt` cold that work
// — sockets, inflate, decode, pluck — was 85% of the main thread while the walk waited for a
// pick slot. Each name has one home thread, so a document is read and kept once; what is asked
// before the threads are up, and everything after one dies, runs here as it always did.
import type { Worker } from "node:worker_threads";
import { builtin } from "./builtin.ts";
import { createDocumentCache } from "./metadata.ts";
import type { MetadataOptions } from "./metadata.ts";
import type { PickOptions } from "./pick.ts";
import { createRegistry } from "./registry.ts";
import type { Registry, RegistryOptions } from "./registry.ts";
import { cpus } from "./runtime.ts";
import { trace } from "./util.ts";
import { registryWorker } from "./workers.ts";
import type { Spec } from "./spec.ts";
import type { Manifest } from "./types.ts";

export interface PoolOptions extends RegistryOptions {
  /** Threads. Default up to 3, leaving this thread a core; 0 is the plain registry. */
  size?: number;
  /**
   * A thread that fails to load is otherwise retired without a word and its names answered
   * here. Set when the user asked for threads by count: then a question fails with the error.
   */
  strict?: boolean;
  /** Told about a thread that failed to load, when not `strict`. */
  warn?: (message: string) => void;
  /** Told once when no thread would start: every name is then asked here. */
  noThreads?: () => void;
  /** Tests point this at a worker that misbehaves. */
  entry?: URL;
  bootMs?: number;
  graceMs?: number;
  /** The distinct name whose question starts the threads; 0 starts them now. */
  startAt?: number;
  /**
   * How many distinct names the walk is known to ask, when that is known before it starts:
   * `startAt` of them start the threads now, so they boot while the caller is still busy.
   */
  expected?: number;
  /** Documents kept on disk, by every thread: each opens the directory itself. */
  metadata?: MetadataOptions;
}

/** What the pool tells a thread at start: the registry, and the request gate it runs. */
export interface WorkerData {
  registry: string;
  scopes?: Record<string, string>;
  auth?: Record<string, string>;
  concurrency: number;
  start: number;
  min: number;
  before?: number;
  exclude?: string[];
  metadata?: MetadataOptions;
}

/** One question. `pick` is the walk's usual pick: the pinned version first when there is one. */
export type Asked =
  | { op: "pick"; spec: Spec; pinned?: string; options?: PickOptions }
  | { op: "pinned"; name: string; version: string }
  | { op: "manifest"; name: string; version: string };

export type Question = Asked & { id: number };

/** An Error does not survive structured clone, so the fields callers switch on travel by hand. */
export interface Answer {
  /** -1 is the thread saying it loaded: the pool hands it work only from then on. */
  id: number;
  found?: Manifest;
  failed?: { message: string; code?: string; status?: number };
}

export interface RegistryPool extends Registry {
  pick: NonNullable<Registry["pick"]>;
  /** Stop the threads. Anything still pending, or asked afterwards, fails with `ECLOSED`. */
  close(): void;
}

/**
 * How long a thread may take to say hello. One that loads but never speaks would otherwise
 * hold its names' requests forever. A boot is 20–40 ms on a free core.
 */
const BOOT_MS = 10_000;

/**
 * How long a question given to a thread still booting waits for its hello before it is asked
 * here after all. A boot is 20–40 ms; a thread that is silent this long is one on a starved
 * machine or one that will never speak, and the question should not sit out the boot timeout
 * with it. The hello ends the wait: from then on the answer is the thread's, however slow.
 */
const GRACE_MS = 1000;

/**
 * The distinct name whose question starts the threads; 0 starts them when the pool is made.
 * One package with no dependencies is answered before a thread could boot, and starting three
 * for it costs a 150 ms install +100 ms, +58 MB and +250 ms of CPU (2026-09-16, `tiny`); a
 * root with this many dependencies has a tree behind it. On a single-dependency root the
 * fourth name is the first package's dependencies, asked in one burst the moment its document
 * lands, and handed to the threads as they boot (`ask`) rather than asked on this thread, which
 * is busy starting the install. Against 0, measured with that routing: `nitro` cold a wash
 * (+14 ms, 4/10), `nuxt` cold +45 ms (3/10, under 5%).
 */
const START_AT = 4;

interface Job {
  question: Asked;
  resolve: (found: Manifest | undefined) => void;
  reject: (error: Error) => void;
  /** Set while the thread is still booting: fires to ask the question here instead. */
  grace?: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  /** It has said hello: a thread still booting is given nothing. */
  ready: boolean;
  pending: Map<number, Job>;
}

/**
 * The threads start at the `startAt`th distinct name (`START_AT`; 0 is now, at creation); what
 * was asked before is answered here, and a warm install that never asks never opens one. With
 * no `worker_threads`, or a `fetch` of the caller's own that cannot cross a thread, this is the
 * plain registry.
 */
export function createRegistryPool(options: PoolOptions = {}): RegistryPool {
  const cache = options.metadata && createDocumentCache(options.metadata);
  const local = createRegistry({ ...options, cache });
  // Three did as well as two and better than four on `nuxt`; each is an isolate to boot
  // (~30 ms of another core, ~20 MB), so a machine with few cores gets fewer.
  const size = options.fetch ? 0 : (options.size ?? Math.min(3, cpus() - 1));
  const slots: (Slot | undefined)[] = [];
  // A name's thread, decided when it is first asked about: one that was asked before its
  // thread was up, or whose thread has died, stays here so its document is read once.
  const homes = new Map<string, Slot | undefined>();
  let seq = 0;
  let closed = false;
  // Under `strict`, the load failure every question fails with from then on.
  let broken: Error | undefined;
  let boot: ReturnType<typeof setTimeout> | undefined;
  const startAt = options.startAt ?? START_AT;
  let started = false;
  let spoke = false;

  function start(): void {
    if (started || closed) return;
    started = true;
    if (size === 0) return;
    trace("reg-start");
    // A thread still silent when this fires is terminated, and its `exit` retires it as a
    // thread that never loaded; nothing was handed to it. Never holds the process open. A
    // browser's timer is a number, with nothing to unref, and its `Worker` is not this one.
    boot = setTimeout(() => {
      for (const slot of slots) if (slot && !slot.ready) void slot.worker.terminate();
    }, options.bootMs ?? BOOT_MS);
    boot.unref?.();
    const max = options.concurrency ?? 32;
    const start = options.start ?? 16;
    const min = shares(options.min ?? 4, size);
    try {
      const entry = options.entry ?? registryWorker();
      for (let i = 0; i < size; i++) {
        const workerData: WorkerData = {
          registry: local.base,
          scopes: options.scopes,
          auth: options.auth,
          concurrency: max,
          start,
          min: min[i]!,
          before: options.before,
          exclude: options.exclude,
          metadata: options.metadata,
        };
        const worker = new builtin.workers.Worker(entry, { workerData });
        const slot: Slot = { worker, ready: false, pending: new Map() };
        // An idle thread must not hold the process open; one with a question is ref'd in
        // `ask`. Listening refs it again, so an answer that leaves it idle unrefs it once more.
        worker.unref();
        worker.on("message", (answer: Answer) => {
          if (!slot.ready) {
            trace("reg-ready");
            // Hello: the thread is up, and what it was handed is its to answer, however long
            // the registry takes; asked here as well, it would be asked twice.
            for (const job of slot.pending.values()) {
              clearTimeout(job.grace);
              job.grace = undefined;
            }
          }
          slot.ready = spoke = true;
          if (slots.every((other) => !other || other.ready)) clearTimeout(boot);
          const job = slot.pending.get(answer.id);
          if (job) {
            slot.pending.delete(answer.id);
            clearTimeout(job.grace);
            if (answer.failed) job.reject(rebuild(answer.failed));
            else job.resolve(answer.found);
          }
          if (slot.pending.size === 0) worker.unref();
        });
        worker.on("error", (error: Error) => retire(slot, error));
        worker.on("exit", () => retire(slot));
        slots.push(slot);
      }
    } catch (error) {
      // No `worker_threads`, or a thread that cannot be constructed: the plain registry.
      clearTimeout(boot);
      failed(error as Error);
      for (const slot of slots.splice(0)) if (slot) void slot.worker.terminate();
      options.noThreads?.();
    }
  }

  /**
   * A thread that died before it said hello did not load: a wrong entry in `dist/`, a runtime
   * without the modules, one that loads and never speaks. Said out loud, and under `strict`
   * made the answer from then on, because a pool that quietly runs everything here is a pool
   * nothing measures.
   */
  function failed(error: Error): void {
    const message = `registry thread failed to start: ${error?.message ?? error}`;
    options.warn?.(message);
    if (options.strict) broken ??= Object.assign(new Error(message), { code: "EWORKER" });
  }

  /**
   * A dead thread's questions are asked again here: they are reads, and it reported nothing.
   * Not after `close()`: whoever asked has gone, and a request nobody reads would only hold
   * the process open for its retries. One death raises both `error` and `exit`; the second
   * finds the slot gone, so a thread that never said hello is reported once, with the error
   * when there was one and as the boot timeout's otherwise.
   */
  function retire(slot: Slot, error?: Error): void {
    const at = slots.indexOf(slot);
    if (at === -1) return;
    slots[at] = undefined;
    if (!slot.ready && !closed) failed(error ?? new Error("no hello within the boot timeout"));
    if (!spoke && !closed && slots.every((other) => !other)) options.noThreads?.();
    for (const [name, home] of homes) if (home === slot) homes.set(name, undefined);
    const cut = closed ? fail("registry pool closed", "ECLOSED") : broken;
    for (const job of slot.pending.values()) {
      clearTimeout(job.grace);
      if (cut) job.reject(cut);
      else here(job.question).then(job.resolve, job.reject);
    }
    slot.pending.clear();
  }

  function here(q: Asked): Promise<Manifest | undefined> {
    if (q.op === "pinned") return local.pinned(q.name, q.version);
    if (q.op === "manifest") return local.manifest(q.name, q.version);
    return pickHere(q.spec, q.pinned, q.options);
  }

  function pickHere(spec: Spec, pinned?: string, pick?: PickOptions): Promise<Manifest> {
    return local.pick!(spec, pinned, pick);
  }

  function ask(name: string, question: Asked): Promise<Manifest | undefined> {
    if (closed) return Promise.reject(fail("registry pool closed", "ECLOSED"));
    if (broken) return Promise.reject(broken);
    let home = homes.get(name);
    if (!homes.has(name)) {
      if (!started && homes.size + 1 >= startAt) start();
      // A thread still booting is a home too: its questions wait in its port for the tens of
      // ms the boot takes, where here they would run behind the install's own work.
      home = slots[hash(name) % (slots.length || 1)];
      homes.set(name, home);
    }
    if (!home) return here(question);
    const slot = home;
    return new Promise((resolve, reject) => {
      const id = seq++;
      const job: Job = { question, resolve, reject };
      if (!slot.ready) {
        job.grace = setTimeout(() => {
          if (!slot.pending.delete(id)) return;
          if (slot.pending.size === 0) slot.worker.unref();
          here(question).then(resolve, reject);
        }, options.graceMs ?? GRACE_MS);
        job.grace.unref?.();
      }
      slot.pending.set(id, job);
      slot.worker.ref();
      slot.worker.postMessage({ ...question, id });
    });
  }

  function close(): void {
    closed = true;
    clearTimeout(boot);
    for (const slot of slots) if (slot) void slot.worker.terminate();
  }

  if ((options.expected ?? 0) >= startAt) start();
  return {
    base: local.base,
    baseFor: local.baseFor,
    view: local.view,
    packument: local.packument,
    pinned: (name, version) => ask(name, { op: "pinned", name, version }),
    manifest: (name, version) => ask(name, { op: "manifest", name, version }) as Promise<Manifest>,
    pick: (spec, pinned, options) =>
      ask(spec.fetchName, { op: "pick", spec, pinned, options }) as Promise<Manifest>,
    close,
  };
}

/**
 * Each thread's gate has the whole ceiling and start the plain registry has, and a share of
 * its floor. The walk's pick gate bounds what is in flight across the threads; a share of the
 * ceiling per thread only made the thread the hash favoured queue names while the others had
 * slots free (7 ms of every 41 ms pick on `nuxt`). The floor is split so a throttled registry
 * is asked for no more than without threads. The gates are separate: a 429 halves the gate
 * of the thread that saw it, and the others learn of it only when the registry tells them.
 */
export function shares(total: number, size: number): number[] {
  return Array.from(
    { length: size },
    (_, i) => Math.floor(total / size) + (i < total % size ? 1 : 0),
  );
}

/** FNV-1a over the name: stable, and spreads scoped siblings across threads. */
function hash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function rebuild(failed: NonNullable<Answer["failed"]>): Error {
  return Object.assign(new Error(failed.message), { code: failed.code, status: failed.status });
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
