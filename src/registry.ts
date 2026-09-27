// Read-only npm registry client: packuments and single manifests, memoized per request.
import { fetching } from "./dns.ts";
import { createAdaptiveLimiter, isThrottle, retryAfter } from "./limit.ts";
import { asOf, pickManifest, viewOf as parsedView } from "./pick.ts";
import type { PackumentView, PickOptions } from "./pick.ts";
import { pluckModified, pluckTags, pluckTimes, pluckVersion } from "./pluck.ts";
import { concat, sleep } from "./runtime.ts";
import { parseDep } from "./spec.ts";
import type { Spec } from "./spec.ts";
import type { Manifest, Packument } from "./types.ts";

/** Abbreviated ("corgi") doc first: same resolver fields, 10-100x smaller. */
const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const FULL = "application/json";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const ATTEMPTS = 5;
const BACKOFF = 100;
const TIMEOUT = 30_000;
/** The only statuses that mean "I dislike this media type". */
const CORGI_REJECT = new Set([400, 406, 415]);
/**
 * A packument read for one version out of it is abandoned past this many decoded bytes and
 * the per-version route asked instead: an origin read (~230 ms) where the packument is a CDN
 * hit. 2 MiB takes in `rolldown`'s linux builds (1.4 MiB full), whose libc read ended walks.
 */
const HUGE = 2 * 1024 * 1024;
/**
 * A peek that looks like it will be abandoned has its route started now rather than then: no
 * headers after `LATE_MS` (a CDN hit answers in ~30 ms, p90 ~50; the `@next/*` documents
 * past the cutoff are always misses), or past half the cutoff and still going.
 */
const LATE_MS = 60;
const LIKELY_HUGE = HUGE / 2;
/**
 * How much bigger a full packument is than the abbreviated one, so that an abbreviated
 * document already read says whether the full one is worth starting: past `HUGE / FULL_RATIO`
 * it would be read to the cutoff and abandoned for the route anyway. The median over 94
 * names read in both forms (1.8 for `@esbuild/*`, 2.7 for `@rolldown/binding-*`).
 */
const FULL_RATIO = 2.3;

/**
 * Whether one version is cheaper to ask for by its route than to read out of the packument:
 * on npmjs `/name/version` is a CDN hit like the packument, 20-50 ms for 2 KB, but
 * `/@scope%2fname/version` comes from the origin every time, 210 ms.
 */
const routeFirst = (name: string) => !name.startsWith("@");

export interface RegistryOptions {
  /** Defaults to npmjs. The CLI reads `.npmrc` and the environment first: `src/config.ts`. */
  registry?: string;
  /** `@scope` → the registry its packages are read from instead of `registry`. */
  scopes?: Record<string, string>;
  /** `//host/path/` → the `authorization` header for requests under it. See `authFor`. */
  auth?: Record<string, string>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /**
   * Ceiling on requests in flight. Default 32. The gate starts at `start` and grows one slot
   * per contended fast success; a 429, a timeout or rising latency pulls it back.
   */
  concurrency?: number;
  /** Where the gate starts. Default 16: what every registry was asked for before it grew. */
  start?: number;
  /** Floor under a throttling registry. Default 4. */
  min?: number;
  /**
   * npm's `before`, in epoch ms: a pick sees only versions published by then. Off by default;
   * the CLI turns `min-release-age` into this (`src/config.ts`). A pinned version is never
   * filtered: a package's exact pins are always older than the package.
   */
  before?: number;
  /** `min-release-age-exclude`: names, or globs with `*`, `**` and `?`, never filtered. */
  exclude?: string[];
  /** Documents kept from earlier runs. None by default; `src/metadata.ts` keeps them on disk. */
  cache?: DocumentCache;
}

/**
 * When a kept document answers without asking the registry. `revalidate`: while the registry's
 * `max-age` lasts, then asked with its ETag. `prefer`: whenever there is one; a pick it cannot
 * satisfy asks once. `only`: whenever there is one, and nothing is ever asked.
 */
export type CacheMode = "revalidate" | "prefer" | "only";

export interface Kept {
  bytes: Uint8Array;
  etag?: string;
  /** Still inside the `max-age` it was served with. */
  fresh: boolean;
}

/** Documents by url and media type. Synchronous: see `src/metadata.ts`. */
export interface DocumentCache {
  mode: CacheMode;
  get(key: string): Kept | undefined;
  set(key: string, bytes: Uint8Array, etag?: string, maxAge?: number): void;
  /** The registry said it has not changed: fresh again. */
  touch(key: string): void;
}

export interface Registry {
  /** The normalized base url every request and every tarball url is built from. */
  base: string;
  /** The same for one name: its scope's registry when `scopes` sends it elsewhere. */
  baseFor: BaseFor;
  packument(name: string): Promise<Packument>;
  /** The abbreviated packument as a view: the usual pick parses one manifest out of it. */
  view(name: string): Promise<PackumentView>;
  /**
   * One full manifest. The abbreviated packument drops `libc`; this is where it lives. The
   * per-version route and the full packument read up to the cutoff, in whichever order
   * `routeFirst` says; then the full packument whole.
   */
  manifest(name: string, version: string): Promise<Manifest>;
  /**
   * One pinned version, or `undefined` when nothing serves it. The per-version route and the
   * abbreviated packument read up to the cutoff, in whichever order `routeFirst` says, and
   * both before a miss: the packument is a CDN copy that can trail a publish. Never the full
   * document, so a spec nothing has still fails as the packument's ETARGET.
   */
  pinned(name: string, version: string): Promise<Manifest | undefined>;
  /**
   * The walk's pick in one call: `pinned` first when there is a version to try, then the usual
   * pick. Without it the two are asked in turn. The client's own asks the registry again when
   * a document kept from an earlier run cannot satisfy the spec.
   */
  pick?(spec: Spec, pinned?: string, options?: PickOptions): Promise<Manifest>;
}

/** Where a name is read from. The lockfile derives tarball urls through one of these. */
export type BaseFor = (name: string) => string;

/** Where a registry serves a package's tarball, by convention every registry follows. */
export function tarballUrl(base: string, name: string, version: string): string {
  const basename = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `${base}/${name}/-/${basename}-${version}.tgz`;
}

/**
 * Where a registry lives, with any trailing slashes off. Exported because the lockfile
 * derives tarball urls from it and must agree with the client character for character.
 */
export function registryBase(registry?: string): string {
  return (registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/** Where names are read from: the base, but for a scope sent elsewhere. */
export function hosts(base: string, scopes?: Record<string, string>): BaseFor {
  const entries = Object.entries(scopes ?? {});
  if (entries.length === 0) return () => base;
  const bases = Object.fromEntries(entries.map(([scope, url]) => [scope, registryBase(url)]));
  return (name) => {
    const slash = name.startsWith("@") ? name.indexOf("/") : -1;
    return (slash > 0 && bases[name.slice(0, slash)]) || base;
  };
}

/**
 * The header a url gets from `.npmrc`'s credentials, or nothing: the longest configured prefix
 * wins, walking up the path one segment or slash at a time as npm does, so `//r.test/` covers
 * every route under it and `//r.test/npm/` only those. Another host, or a redirect to one,
 * never sees it — Node's fetch drops `authorization` on a cross-origin redirect, and
 * `test/config.test.ts` holds it to that.
 */
export function authFor(auth: Record<string, string>, url: string): string | undefined {
  if (Object.keys(auth).length === 0) return undefined;
  let dart: string;
  try {
    const parsed = new URL(url);
    dart = `//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
  while (dart.length > 2) {
    const found = auth[dart];
    if (found) return found;
    dart = dart.replace(/([^/]+|\/)$/, "");
  }
  return undefined;
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  const base = registryBase(options.registry);
  const baseFor = hosts(base, options.scopes);
  const auth = options.auth ?? {};
  const request = options.fetch ?? fetching();
  // One gate over every request to this registry. It lives here because the retry below
  // turns a 429 into a slow success, and nowhere further out can tell the two apart.
  const limit = createAdaptiveLimiter({
    start: options.start ?? 16,
    max: options.concurrency ?? 32,
    min: options.min,
  });
  const start = options.start ?? 16;
  const corgis = new Map<string, Promise<TextView>>();
  const manifests = new Map<string, Promise<Manifest | undefined>>();
  const documents = new Map<string, Promise<TextView>>();
  const peeks = new Map<string, Promise<TextView | undefined>>();
  const fullPeeks = new Map<string, Promise<TextView | undefined>>();
  const corgiBytes = new Map<string, number>(); // decoded size of a peeked abbreviated document
  const aged = new Map<string, Promise<PackumentView>>();
  const times = new Map<string, Promise<Record<string, string> | undefined>>();
  const before = options.before;
  const excluded = globs(options.exclude ?? []);
  const cache = options.cache;
  /** Names answered from a kept document without asking; and those asked again since. */
  const unasked = new Set<string>();
  const rechecked = new Set<string>();

  /**
   * The kept document for a request, and whether it answers without one. When it does not, its
   * ETag goes with the request.
   */
  function kept(name: string, url: string, accept: string): { doc?: Kept; use: boolean } {
    if (!cache) return { use: false };
    const doc = cache.get(keyOf(url, accept));
    if (!doc || rechecked.has(name) || (cache.mode === "revalidate" && !doc.fresh)) {
      return { doc, use: false };
    }
    if (!doc.fresh) unasked.add(name);
    return { doc, use: true };
  }

  const offline = (name: string) =>
    fail(`offline: cannot ask the registry for ${name}`, "EOFFLINE");

  /** Keep what the registry sent, unless it said not to. */
  function keep(url: string, accept: string, response: Response, bytes: Uint8Array): void {
    const control = response.headers.get("cache-control") ?? "";
    if (!cache || /no-store/i.test(control)) return;
    const maxAge = /max-age=(\d+)/i.exec(control)?.[1];
    const etag = response.headers.get("etag") ?? undefined;
    cache.set(keyOf(url, accept), bytes, etag, maxAge === undefined ? undefined : +maxAge);
  }

  /** The response body, retried and validated as `get` says. */
  async function get(name: string, url: string, accept: string): Promise<Uint8Array> {
    const { doc, use } = kept(name, url, accept);
    if (use) return doc!.bytes;
    if (cache?.mode === "only") throw offline(name);
    return await limit(async (signal) => {
      let last: unknown;
      // What the last answer asked us to wait, which beats guessing when the server said.
      let asked = 0;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(asked || BACKOFF * 2 ** (attempt - 1));
        let response: Response;
        try {
          response = await request(url, {
            headers: headers(url, accept, doc?.etag),
            // Without this one dead socket hangs the whole install.
            signal: AbortSignal.timeout(TIMEOUT),
          });
        } catch (error) {
          // fetch rejects with an uncoded TypeError, so give callers something to switch on.
          const timedOut = (error as Error)?.name === "TimeoutError";
          asked = 0;
          if (timedOut) signal.throttled();
          last = fail(
            `Request to ${url} failed: ${(error as Error)?.message ?? error}`,
            timedOut ? "ETIMEDOUT" : "ENETWORK",
          );
          continue;
        }
        if (response.status === 304 && doc) {
          cache!.touch(keyOf(url, accept));
          return doc.bytes;
        }
        if (response.ok) {
          const bytes = await body(response, url);
          keep(url, accept, response, bytes);
          return bytes;
        }
        if (response.status === 404) {
          throw fail(`Package "${name}" not found in registry`, "E404");
        }
        asked = isThrottle(response.status) ? retryAfter(response) : 0;
        if (isThrottle(response.status)) signal.throttled();
        last = fail(
          `Registry returned ${response.status} for ${url}`,
          "EREGISTRY",
          response.status,
        );
        if (response.status < 500 && !isThrottle(response.status)) throw last;
      }
      throw last;
    });
  }

  // parseDep validates the name and gives the escaped registry path form.
  const path = (name: string) => `${baseFor(name)}/${parseDep(name, "").escapedName}`;

  function headers(url: string, accept: string, etag?: string): Record<string, string> {
    const authorization = authFor(auth, url);
    const sent: Record<string, string> = authorization ? { accept, authorization } : { accept };
    if (etag) sent["if-none-match"] = etag;
    return sent;
  }

  async function loadPackument(name: string): Promise<TextView> {
    const url = path(name);
    try {
      return viewOf(url, await get(name, url, CORGI));
    } catch (error) {
      // A 4xx can mean the registry choked on the abbreviated media type; ask for the full doc once.
      const { code, status } = error as { code?: string; status?: number };
      if (code !== "EREGISTRY" || status === undefined || !CORGI_REJECT.has(status)) throw error;
      return viewOf(url, await get(name, url, FULL));
    }
  }

  /**
   * A packument, read only as far as it stays worth reading. Deliberately plain: no retry and
   * no media-type fallback, because the per-version route is behind it and `loadPackument`
   * will do the job properly if the whole document is wanted after all.
   */
  async function peek(
    name: string,
    accept: string,
    big?: () => void,
  ): Promise<TextView | undefined> {
    const url = path(name);
    const { doc, use } = kept(name, url, accept);
    const hit = () => {
      if (accept === CORGI) corgiBytes.set(name, doc!.bytes.byteLength);
      return viewOf(url, doc!.bytes);
    };
    if (use) return hit();
    if (cache?.mode === "only") return undefined;
    return await limit(async (signal) => {
      let response: Response;
      // Not from a gate the registry has pulled back: it asked for fewer.
      const late = big && limit.limit >= start ? setTimeout(big, LATE_MS) : undefined;
      try {
        response = await request(url, {
          headers: headers(url, accept, doc?.etag),
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (error) {
        if ((error as Error)?.name === "TimeoutError") signal.throttled();
        return undefined;
      } finally {
        clearTimeout(late);
      }
      if (response.status === 304 && doc) {
        cache!.touch(keyOf(url, accept));
        return hit();
      }
      if (!response.ok && isThrottle(response.status)) signal.throttled();
      if (!response.ok || !response.body) return undefined;
      const [bytes, size] = await read(response, big);
      if (accept === CORGI) corgiBytes.set(name, size);
      if (bytes === undefined) return undefined;
      keep(url, accept, response, bytes);
      return viewOf(url, bytes);
    });
  }

  /**
   * Read a peeked document, or give up on it once it is too big to be the cheap route. The
   * size comes back either way: past the cutoff it is how far the read got.
   */
  async function read(
    response: Response,
    big?: () => void,
  ): Promise<[Uint8Array | undefined, number]> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (big && size > LIKELY_HUGE) {
        big();
        big = undefined;
      }
      if (size > HUGE) {
        await reader.cancel().catch(() => {});
        return [undefined, size];
      }
      chunks.push(value);
    }
    return [concat(chunks, size), size];
  }

  /** Whether the full packument would only be read to the cutoff and abandoned. */
  function fullTooBig(name: string): boolean {
    const bytes = corgiBytes.get(name);
    return bytes !== undefined && bytes * FULL_RATIO > HUGE;
  }

  /** A peek that read the whole document is the document; otherwise fetch it properly. */
  async function loadCorgi(name: string): Promise<TextView> {
    return (await peeks.get(name)) ?? (await loadPackument(name));
  }

  async function loadPinned(name: string, version: string): Promise<Manifest | undefined> {
    // A document that answers unasked beats any route.
    if (cache && cache.mode !== "revalidate" && cache.get(keyOf(path(name), CORGI))) {
      const found = (await memo(peeks, name, () => peek(name, CORGI)))?.version(version);
      if (found) return found;
    }
    // A document a range asked for has the version, or the route below is right.
    const known = corgis.get(name) ?? peeks.get(name);
    if (known) {
      const found = (await known.catch(() => undefined))?.version(version);
      if (found) return found;
    }
    const first = routeFirst(name);
    if (first) {
      const found = await loadedVersion(name, version);
      if (found) return found;
    }
    const found = await raced(name, version, (early) =>
      memo(peeks, name, () => peek(name, CORGI, early)),
    );
    if (found || first) return found;
    // A version the CDN's copy lacks may be newer than the copy: the route is the origin.
    return await loadedVersion(name, version);
  }

  /** The version out of a peeked document, or off an early route when that answers first. */
  function raced(
    name: string,
    version: string,
    peeked: (early: () => void) => Promise<TextView | undefined>,
  ): Promise<Manifest | undefined> {
    return new Promise((resolve, reject) => {
      const early = () =>
        void loadedVersion(name, version).then(
          (found) => found && resolve(found),
          () => {},
        );
      peeked(early).then((doc) => resolve(doc?.version(version)), reject);
    });
  }

  async function loadVersion(name: string, version: string): Promise<Manifest | undefined> {
    try {
      const url = `${path(name)}/${version}`;
      return parseJSON<Manifest>(decode(await get(name, url, FULL)), url);
    } catch (error) {
      // No such version, or a registry that does not serve the per-version route at all.
      const { code, status } = error as { code?: string; status?: number };
      // Offline, a route never kept is a miss: a kept document may still have the version.
      const missing =
        code === "E404" || code === "EOFFLINE" || (code === "EREGISTRY" && (status ?? 500) < 500);
      if (!missing) throw error;
      return undefined;
    }
  }

  function loadedVersion(name: string, version: string): Promise<Manifest | undefined> {
    return memo(manifests, `${name}@${version}`, () => loadVersion(name, version));
  }

  async function loadManifest(name: string, version: string): Promise<Manifest> {
    const missing = () => fail(`Registry has no manifest for ${name}@${version}`, "E404");
    const first = routeFirst(name);
    const found = first ? await loadedVersion(name, version) : undefined;
    if (found) return found;
    // Not started when the abbreviated document `pinned` read says it would be abandoned.
    let peeked: TextView | undefined;
    const fromDoc = fullTooBig(name)
      ? undefined
      : await raced(name, version, (early) =>
          memo(fullPeeks, name, () => peek(name, FULL, early)).then((doc) => (peeked = doc)),
        );
    // The route once more when the document lacks the version: free where `pinned` found it
    // there, one request where the CDN's copy trails a publish.
    const later = fromDoc ?? (await loadedVersion(name, version));
    if (later) return later;
    // A document read whole that lacks it is the miss; text that was never a document is not.
    if (peeked?.usable()) raise(missing());
    // Whole, however big: a registry that serves neither route still has to be read.
    const doc = await memo(documents, name, async () =>
      viewOf(path(name), await get(name, path(name), FULL)),
    );
    return doc.version(version) ?? raise(missing());
  }

  const corgi = (name: string) => memo(corgis, name, () => loadCorgi(name));

  /**
   * The abbreviated document, as of `before`. Its `modified` answers for most names: nothing
   * in a document untouched since the cutoff is newer. Otherwise the publish dates are only in
   * the full document, read once for them.
   */
  async function loadAged(name: string): Promise<PackumentView> {
    const doc = await corgi(name);
    if (before === undefined || excluded(name)) return doc;
    if (Date.parse(doc.modified() ?? "") <= before) return doc;
    const found = await memo(times, name, () => loadTimes(name));
    return found ? parsedView(asOf(doc.whole(), found, before)) : doc;
  }

  async function loadTimes(name: string): Promise<Record<string, string> | undefined> {
    const bytes = await get(name, path(name), FULL);
    return pluckTimes(bytes) ?? parseJSON<Packument>(decode(bytes), path(name)).time;
  }

  const view = (name: string) =>
    before === undefined ? corgi(name) : memo(aged, name, () => loadAged(name));

  async function pick(spec: Spec, pinned?: string, options?: PickOptions): Promise<Manifest> {
    const name = spec.fetchName;
    const found = pinned === undefined ? undefined : await loadPinned(name, pinned);
    if (found) return found;
    try {
      return pickManifest(await view(name), spec, options);
    } catch (error) {
      // A document kept from an earlier run may predate what is asked for: ask once.
      const { code } = error as { code?: string };
      const miss = code === "ETARGET" || code === "ENOVERSIONS";
      if (!miss || !unasked.has(name) || rechecked.has(name)) throw error;
      rechecked.add(name);
      for (const memos of [corgis, peeks, aged, times]) memos.delete(name);
      return pickManifest(await view(name), spec, options);
    }
  }

  return {
    base,
    baseFor,
    view,
    packument: async (name) => (await view(name)).whole(),
    manifest: (name, version) => loadManifest(name, version),
    pinned: (name, version) => loadPinned(name, version),
    pick,
  };
}

/** Where a document is kept: the abbreviated and full forms of one url are two documents. */
const keyOf = (url: string, accept: string) => `${accept === CORGI ? "corgi" : "full"} ${url}`;

interface TextView extends PackumentView {
  /** Whether the bytes are a document at all. Parses them whole to say so. */
  usable(): boolean;
  /** When the document last changed: read off its tail where the registry puts it last. */
  modified(): string | undefined;
}

/**
 * A document's bytes as a view. A member is plucked out of the bytes; when the pluck finds
 * nothing they are parsed whole, once. On a document a pluck answers as the whole parse
 * would, except that a duplicated key gives the first member where `JSON.parse` gives the
 * last — a registry's own keys, never a publisher's. Bytes that are not a document have no
 * members, and `whole()` says why.
 */
function viewOf(url: string, bytes: Uint8Array): TextView {
  let doc: Packument | undefined;
  let tags: Record<string, string> | undefined;
  const whole = () => (doc ??= parseJSON<Packument>(decode(bytes), url));
  const parsed = () => {
    try {
      return whole();
    } catch {
      return undefined;
    }
  };
  return {
    tags: () =>
      (tags ??= (doc ? doc["dist-tags"] : pluckTags(bytes)) ?? parsed()?.["dist-tags"] ?? {}),
    version: (version) =>
      doc
        ? doc.versions?.[version]
        : (pluckVersion(bytes, version) ?? parsed()?.versions?.[version]),
    whole,
    usable: () => parsed() !== undefined,
    modified: () => (doc ? doc.modified : (pluckModified(bytes) ?? parsed()?.modified)),
  };
}

/** Whether a name matches one of the names or globs: `**` any text, `*` and `?` within a segment. */
function globs(patterns: string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  const source = patterns.map((p) =>
    p.replace(/\*\*|[*?]|[.+^${}()|[\]\\/]/g, (c) =>
      c === "**" ? ".*" : c === "*" ? "[^/]*" : c === "?" ? "[^/]" : `\\${c}`,
    ),
  );
  const re = new RegExp(`^(?:${source.join("|")})$`);
  return (name) => re.test(name);
}

/** Cache the in-flight promise, so concurrent callers share one request. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load().catch((error: unknown) => {
      cache.delete(key); // A transient failure must not poison the cache.
      throw error;
    });
    cache.set(key, hit);
  }
  return hit;
}

/** A 200 can still carry HTML from a captive portal, or a body that is not JSON we can use. */
async function body(response: Response, url: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw fail(
      `Registry sent an unreadable body for ${url}: ${(error as Error)?.message}`,
      "ENETWORK",
    );
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parseJSON<T>(text: string, url = ""): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw fail(`Registry sent invalid JSON for ${url}: ${(error as Error)?.message}`, "EJSONPARSE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(`Registry sent an unusable body for ${url}`, "EJSONPARSE");
  }
  return parsed as T;
}

function fail(message: string, code: string, status?: number): Error {
  return Object.assign(new Error(message), { code, status });
}

function raise(error: Error): never {
  throw error;
}
