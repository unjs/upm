// One address lookup per host per thread. Node's `fetch` asks the resolver again for every
// socket it opens — about fifty times in the first 300 ms of a cold `next` — and a box with no
// local stub sends each as a UDP query with glibc's 5 s timeout, so one dropped query held
// every connection on its libuv thread for 5 s, in about one cold run in eight. The answer is
// asked for once and handed to an agent of our own as its `lookup`, turned per connection the
// way the resolver's own answers turn, so the sockets still spread over the registry's
// addresses. The agent goes with each of our requests; the process's own `fetch` is not
// touched. Node only; nothing here for a runtime without `fetch`'s dispatcher.
import type { LookupAddress } from "node:dns";
import { builtin } from "./builtin.ts";
import { hasNode } from "./runtime.ts";

interface LookupOptions {
  family?: number;
  hints?: number;
  all?: boolean;
}

type Callback = (
  error: NodeJS.ErrnoException | null,
  address?: LookupAddress[] | string,
  family?: number,
) => void;

/**
 * Where undici keeps the dispatcher `fetch` uses: what `setGlobalDispatcher` writes to. undici 8
 * (Node 26) reads `.2` and leaves `.1` a wrapper for older copies of undici; before it, `.1`.
 */
export const DISPATCHER = Symbol.for(
  `undici.globalDispatcher.${Number.parseInt(globalThis.process?.versions?.undici ?? "") >= 8 ? 2 : 1}`,
);

const known = new Map<string, Promise<LookupAddress[]>>();
const turns = new Map<string, number>();
let installing: Promise<void> | undefined;
let installed = false;
/** Our agent, once `cacheLookups` made one; requests go through `fetching()` to use it. */
let agent: object | undefined;

/**
 * A query the resolver dropped waits out glibc's 5 s timeout before it is retried; asked again
 * from here after this long, on another libuv thread, it usually answers at once (one lookup in
 * ~100 stalled that way in tonight's cold `next` runs). The first answer wins.
 */
const HEDGE_MS = 1000;

/** The resolver's answer for a host, asked once. A failure is not kept: the next asks again. */
function resolve(host: string): Promise<LookupAddress[]> {
  let found = known.get(host);
  if (!found) {
    found = new Promise((resolve, reject) => {
      const { dns } = builtin;
      let asked = 1;
      let settled = false;
      const ask = () =>
        dns.lookup(host, { all: true, hints: dns.ADDRCONFIG }, (error, list) => {
          if (settled) return;
          // A refusal is final at once; only a lookup that never comes back is asked again.
          if (!error) resolve(list);
          else if (--asked > 0) return;
          else reject(error);
          settled = true;
          clearTimeout(hedge);
        });
      ask();
      const hedge = setTimeout(() => {
        asked++;
        ask();
      }, HEDGE_MS);
      hedge.unref();
    });
    found.catch(() => known.delete(host));
    known.set(host, found);
  }
  return found;
}

/**
 * Make this thread's agent, so `fetching()` resolves through `resolve`. Loads the fetch
 * machinery (~25 ms), so it is called where a request is about to be made and not before.
 * Undefined once it is done, so a caller with a request ready need not wait a tick; where no
 * agent can be made (no `fetch`) requests go out as before, resolving per socket.
 */
export function cacheLookups(): Promise<void> | undefined {
  if (installed) return undefined;
  return (installing ??= install().then(
    () => void (installed = true),
    () => void (installed = true),
  ));
}

/**
 * `fetch` with our agent, for the registry and the store. The global dispatcher is not
 * touched: a host process that calls into upm keeps its own for its own requests. The agent
 * is made before the first request, so a run that asks nothing, a resolve from kept
 * documents say, never loads the fetch machinery; plain `fetch` where it could not be made.
 */
export function fetching(): typeof fetch {
  return async (input, init) => {
    const lookups = cacheLookups();
    if (lookups) await lookups;
    return await fetch(input, agent ? ({ ...init, dispatcher: agent } as RequestInit) : init);
  };
}

/** A response as a download reads it: what `fetch` returns, or what `get` makes of the same. */
export interface Answer {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}

/** A GET of a url with these headers, aborted by the signal. */
export type Get = (
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
) => Promise<Answer>;

/**
 * `fetch`'s GET without `fetch`, through our agent's own callbacks: its Request, Response,
 * Headers and web stream cost the main thread about 0.3 ms a tarball, much of what it did on a
 * cold install of 1,350 packages. Undefined until `cacheLookups` has made the agent, and where
 * it could not: `fetching()` is then the way. A redirect is followed as `fetch` follows it, and
 * a credential goes no further than the origin it was sent to.
 */
export function getter(): Get | undefined {
  const own = agent as Dispatcher | undefined;
  if (!own) return undefined;
  return async (url, headers, signal) => {
    for (let hop = 0; ; hop++) {
      const answer = await getOnce(own, url, headers, signal);
      const location = answer.headers.get("location");
      if (!REDIRECTS.has(answer.status) || location === null || hop === MAX_REDIRECTS) {
        return answer;
      }
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") return answer;
      if (next.origin !== new URL(url).origin) headers = undefined;
      url = next.href;
    }
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAYS = { "user-agent": "node", accept: "*/*" };
/** As `fetch` has it. */
const MAX_REDIRECTS = 20;

/**
 * The part of undici's `Dispatcher` a GET uses. undici 7 and 8 call the `onRequest…` and
 * `onResponse…` callbacks (8 refuses a handler without them); undici 6 the others.
 */
interface Dispatcher {
  dispatch(
    options: { origin: string; path: string; method: "GET"; headers?: Record<string, string> },
    handler: {
      onRequestStart(controller: { abort(reason?: unknown): void }): void;
      onResponseStart(
        controller: unknown,
        status: number,
        headers: Record<string, string | string[] | undefined>,
      ): void;
      onResponseData(controller: unknown, chunk: Uint8Array): void;
      onResponseEnd(): void;
      onResponseError(controller: unknown, error: Error): void;
      onConnect(abort: (reason?: unknown) => void): void;
      onHeaders(status: number, raw: (Uint8Array | Uint8Array[])[]): boolean;
      onData(chunk: Uint8Array): boolean;
      onComplete(): void;
      onError(error: Error): void;
    },
  ): boolean;
}

function getOnce(
  own: Dispatcher,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<Answer> {
  const { origin, pathname, search } = new URL(url);
  const chunks: Uint8Array[] = [];
  let done = false;
  let failed: Error | undefined;
  let wake: (() => void) | undefined;
  let abort: ((reason?: unknown) => void) | undefined;
  const stop = () => abort?.(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const settle = () => {
    signal.removeEventListener("abort", stop);
    wake?.();
  };
  async function* body(): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (chunks.length > 0) yield* chunks.splice(0);
      else if (failed) throw failed;
      else if (done) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return new Promise((resolve, reject) => {
    const start = (cancel: (reason?: unknown) => void) => {
      abort = cancel;
      if (signal.aborted) cancel(signal.reason);
    };
    const answer = (status: number, found: Map<string, string>) => {
      // An informational answer, 103 Early Hints say, comes before the real one.
      if (status < 200) return;
      // As `fetch` has it: these statuses have no body.
      const none = status === 204 || status === 205 || status === 304;
      const headers = { get: (name: string) => found.get(name) ?? null };
      resolve({ status, headers, body: none ? null : body() });
    };
    const data = (chunk: Uint8Array) => {
      chunks.push(chunk);
      wake?.();
    };
    const end = () => {
      done = true;
      settle();
    };
    const fail = (error: Error) => {
      // Uncoded, as `fetch` rejects: the caller tells a transient failure by the lack of one.
      failed = new Error(error?.message ?? String(error), { cause: error });
      reject(failed);
      settle();
    };
    own.dispatch(
      // What `fetch` would say it is: some proxies turn away a request that says nothing.
      { origin, path: `${pathname}${search}`, method: "GET", headers: { ...SAYS, ...headers } },
      {
        onRequestStart: (controller) => start((reason) => controller.abort(reason)),
        onResponseStart(_, status, headers) {
          const found = new Map<string, string>();
          for (const [name, value] of Object.entries(headers)) {
            if (value !== undefined) {
              found.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
            }
          }
          answer(status, found);
        },
        onResponseData: (_, chunk) => data(chunk),
        onResponseEnd: end,
        onResponseError: (_, error) => fail(error),
        onConnect: start,
        onHeaders(status, raw) {
          const found = new Map<string, string>();
          const text = (value: Uint8Array | Uint8Array[]): string =>
            Array.isArray(value) ? value.map(text).join(", ") : decoder.decode(value);
          for (let at = 0; at + 1 < raw.length; at += 2) {
            const name = text(raw[at]!).toLowerCase();
            const value = text(raw[at + 1]!);
            const before = found.get(name);
            found.set(name, before === undefined ? value : `${before}, ${value}`);
          }
          answer(status, found);
          return true;
        },
        onData(chunk) {
          data(chunk);
          return true;
        },
        onComplete: end,
        onError: fail,
      },
    );
  });
}

const decoder = new TextDecoder();

/**
 * Our agent is one of undici's own `Agent` class with a `connect.lookup`; the class is read off
 * the default dispatcher undici makes for itself. A dispatcher that was there before — a host
 * process's own, whatever its class — is used instead, unless it is undici's untouched default
 * agent from an ESM `import "node:http"`: none is made, as with no `fetch` or a runtime that keeps
 * the dispatcher under another name.
 */
async function install(): Promise<void> {
  const global = globalThis as unknown as Record<symbol, object | undefined>;
  // Off Node there is no undici to find, and a page's `connect-src` would see the probe.
  if (!hasNode || typeof fetch !== "function") return;
  let made = global[DISPATCHER];
  if (!made) {
    // undici makes its default agent on the first fetch; a `data:` url is one that goes nowhere.
    await fetch("data:,");
    made = global[DISPATCHER];
  } else if (!isDefault(made)) return;
  const Agent = made?.constructor as (new (options: object) => object) | undefined;
  if (typeof Agent !== "function" || Agent.name !== "Agent") return;
  agent = new Agent({ connect: { lookup } });
}

/**
 * Whether a dispatcher is undici's untouched default agent, which an ESM `import "node:http"`
 * or a first `fetch` creates on Node 22 to 26, rather than one the caller configured.
 */
function isDefault(dispatcher: unknown): boolean {
  if ((dispatcher as { constructor?: { name?: string } })?.constructor?.name !== "Agent") {
    return false;
  }
  const d = dispatcher as Record<symbol, Record<string, unknown>>;
  const opt = d[Object.getOwnPropertySymbols(d).find((s) => s.description === "options")!];
  // undici 6 leaves connect, tls and interceptors unset; undici 7 adds maxOrigins: Infinity.
  return (
    !!opt &&
    Object.entries(opt).every(([k, v]) => v === undefined || (k === "maxOrigins" && v === Infinity))
  );
}

/** What `net.connect` calls per socket: the cached answer, each family's list turned by one. */
export function lookup(host: string, options: LookupOptions, callback: Callback): void {
  resolve(host).then(
    (list) => {
      const turn = turns.get(host) ?? 0;
      turns.set(host, turn + 1);
      const wanted = options.family ? list.filter((a) => a.family === options.family) : list;
      const v4 = wanted.filter((a) => a.family === 4);
      const v6 = wanted.filter((a) => a.family === 6);
      const rotated = [...turned(v4, turn), ...turned(v6, turn)];
      const first = rotated[0];
      if (!first) {
        const error = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
        error.code = "ENOTFOUND";
        callback(error);
      } else if (options.all) callback(null, rotated);
      else callback(null, first.address, first.family);
    },
    (error: NodeJS.ErrnoException) => callback(error),
  );
}

function turned<T>(list: T[], by: number): T[] {
  if (list.length < 2) return list;
  const at = by % list.length;
  return [...list.slice(at), ...list.slice(0, at)];
}
