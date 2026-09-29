// Per-file content-addressed store. Files are keyed by their own hash, indexes by
// the tarball integrity, so a tarball we have seen before is never fetched or untarred again.
import { builtin } from "./builtin.ts";
import { cacheLookups, fetching, getter } from "./dns.ts";
import type { Answer } from "./dns.ts";
import type { BackendClient, StoreBackend } from "./store-backend.ts";
import type { Pool, Sink } from "./unpack-pool.ts";
import {
  createAdaptiveLimiter,
  createLimiter,
  fsConcurrency,
  isThrottle,
  retryAfter,
} from "./limit.ts";
import type { Signal } from "./limit.ts";
import { createWriter, SHARD_MIN, verifyTarball, wrapped } from "./unpack.ts";
import { authFor } from "./registry.ts";
import { concat, createHasher, sleep, toBase64 } from "./runtime.ts";
import { isIndex, now, sizeOfSync, tick, trace, tracing } from "./util.ts";

export { isIndex };

/** The pool's `WORKER_DIED`, spelled out so importing it does not load the pool. */
const WORKER_DIED = "EWORKERDIED";

export interface FileEntry {
  path: string;
  /**
   * Where the content is, relative to the store's `files/`: `<shard>/<algorithm>-<digest>`, plus
   * `-exec` for the executable copy, with this platform's separator. Written in that form so
   * linking a file is one concat and not a hash-to-path conversion — 13,575 of them for `nuxt`.
   */
  blob: string;
  size: number;
}

export interface PackageIndex {
  integrity: string;
  files: FileEntry[];
  unpackedSize: number;
}

/**
 * Where a tarball is: a url, or a file on this machine. Only a caller that means a local file
 * can name one, so no url a registry sends is ever read off the disk.
 */
export type Tarball = string | { path: string };

export interface StoreOptions {
  /** Defaults to `UPM_STORE`, then `~/.upm/store`. */
  dir?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** `.npmrc` credentials by `//host/path/`, sent with a tarball request under one. */
  auth?: Record<string, string>;
  /** Ceiling on tarballs downloading at once. Default 32. */
  concurrency?: number;
  /**
   * Compressed bytes that may have landed and wait to be stored before another download starts.
   * Default 64 MiB. Injectable for tests.
   */
  held?: number;
  /** Worker threads unpacking tarballs, at most. 0 keeps every tarball on the main thread. */
  workers?: number;
  /** Injectable for tests. */
  workerEntry?: URL;
  /** Told once when no unpack thread would start: every tarball is then unpacked here. */
  noThreads?: () => void;
  /** How long a download may make no progress before it is abandoned. Injectable for tests. */
  stall?: number;
  /** Check that stored content still matches its index instead of trusting it. Default false. */
  verify?: boolean;
  /** A tarball not already here fails with `EOFFLINE` instead of being downloaded. */
  offline?: boolean;
  /** See `StoreBackend`; `backendFailed` is told once when it fails. */
  backend?: StoreBackend;
  backendFailed?: (error: unknown) => void;
}

export interface Store {
  dir: string;
  index(integrity: string): PackageIndex | undefined;
  /** Where the index is, or would be. */
  indexPath(integrity: string): string;
  /** Bytes of the index on disk, without reading it; 0 when there is none, or could be none. */
  indexSize(integrity: string): number;
  add(tarball: Tarball, integrity: string): Promise<{ index: PackageIndex; cached: boolean }>;
  /**
   * A tarball whose integrity is not known yet, which is a tarball dependency the first time it
   * is resolved: read whole and stored under the sha512 of its bytes, which is its integrity
   * from then on. Content is still named by its own hash alone; nothing the tarball says is
   * taken on trust.
   */
  adopt(tarball: Tarball): Promise<{ index: PackageIndex; integrity: string }>;
  /** Stop the unpack threads. Nothing may still be adding. */
  close(): void;
  /** Wait for the backend's puts. */
  flush(): Promise<void>;
  /**
   * `add`, for a caller that wants the content here and not the index: one that is already
   * here is not read, which is 559 reads and parses on a warm `nuxt`. A torn index passes as
   * present and fails where it is read, which the linker answers by filling again.
   */
  ensure(tarball: Tarball, integrity: string): Promise<void>;
  contentPath(hash: string, exec: boolean): string;
  /** Absolute path of a file's content. */
  blobPath(file: FileEntry): string;
  /** The `add` still running for this tarball, if one is; it rejects as that `add` does. */
  pending(integrity: string): Promise<unknown> | undefined;
}

const INDEX_MODE = 0o644;

/** How much of a tarball is joined at a time while it downloads. Most fit in one block. */
const BLOCK = 1024 * 1024;

/**
 * From this size a tarball goes to its worker block by block as it downloads, so the inflate
 * runs under the network. `next` (40 MiB) was ~400 ms of inflate after its last byte landed.
 * The same size as `SHARD_MIN`: a streamed tarball's big files are hashed and written as they
 * inflate, and a 7.9 MiB native binary was `nitro`'s last tarball, 91 ms behind its last byte.
 */
const STREAM_MIN = SHARD_MIN;

/** What a download came to: the bytes, or the index a worker is making of them as they land. */
type Pulled = ({ bytes: Uint8Array[] } | { streamed: Promise<PackageIndex> }) & { size: number };

/** Asks the pool for a worker to stream a tarball of this many bytes to. */
type Open = (size: number) => Promise<Sink | undefined>;

/**
 * Compressed bytes that may have landed and wait for their unpack before a new download starts.
 * The download slots bound what is on the wire; this bounds what is past it. A cold `large`
 * peaked at 28 MiB in 200 tarballs, where slots held to the index had peaked at 23 MiB in 32;
 * `next`'s two biggest (67 MiB) reach it either way.
 */
const HELD = 64 * 1024 * 1024;

/** Tries per tarball, and the first pause between them. Matches the registry client. */
const ATTEMPTS = 5;
const BACKOFF = 100;

/**
 * How long a download may make no progress at all before it is abandoned. A whole-request
 * deadline is the wrong shape here — a big tarball on a thin line is slow but fine, while a
 * socket that has gone quiet is never coming back however long it is given.
 */
const STALL = 30_000;

/** Where the store is: `dir`, else `UPM_STORE`, else `~/.upm/store`. */
export function storeDir(dir?: string): string {
  return (
    dir ||
    globalThis.process?.env.UPM_STORE ||
    builtin.path.join(builtin.os.homedir(), ".upm", "store")
  );
}

export function createStore(options: StoreOptions = {}): Store {
  const dir = storeDir(options.dir);
  const request = options.fetch ?? fetching();
  const auth = options.auth;
  // A tree of many small tarballs waits on round trips, not on CPU. At sixteen `nuxt` had
  // nearly every slot in the network with ~85 waiting; thirty-two was ~300 ms faster. Sixty-four
  // was a wash on `large` and a quarter slower on `next`, whose big tarballs then share the wire
  // with twice as many others.
  const concurrency = options.concurrency ?? 32;
  // Three gates over one pipeline. The first spans a download, request to last byte, and comes
  // down off its count when the registry says to. The second is `held`: bytes landed and not
  // yet stored, which is what bounds memory past the wire. The third caps how many tarballs
  // this thread tears apart at once when there are no workers to do it, which is the machine's
  // business and not the registry's; the pool bounds itself by its thread count.
  const most = options.held ?? HELD;
  const stall = options.stall ?? STALL;
  const verify = options.verify === true;
  const backend = options.backend;
  let backing: Promise<BackendClient | void> | undefined;
  const client = () =>
    (backing ??= import("./store-backend.ts").then(
      (lib) => lib.createBackendClient(options, writer, disk, stall),
      options.backendFailed,
    ));
  const net = createAdaptiveLimiter({ max: concurrency });
  const disk = createLimiter(fsConcurrency());
  const writer = createWriter(dir);
  const pending = new Map<string, Promise<PackageIndex>>();
  const downloaded = new Set<string>();
  // An install reads every index twice: once to fill the store, once to link from it.
  const loaded = new Map<string, PackageIndex>();
  // And asks where each is three or four times: the spelling costs a regex and a normalize.
  const paths = new Map<string, string>();
  const sizes = new Map<string, number>();
  const indexPath = (integrity: string): string => {
    let path = paths.get(integrity);
    if (path === undefined) paths.set(integrity, (path = writer.indexPath(integrity)));
    return path;
  };
  let pool: Pool | undefined;
  let loading: Promise<Pool | undefined> | undefined;
  // Tarballs missed and not yet unpacked. An install asks for everything at once, so at the
  // first landing this is the whole install: what tells the pool how many threads to start.
  let behind = 0;
  // Bytes landed and not yet stored, and the downloads waiting for them to go under `most`.
  let held = 0;
  const roomy: (() => void)[] = [];
  /** Shard directories under `index/`, listed on the first read. */
  let shards: Set<string> | undefined;

  const shardOf = (file: string) => builtin.path.basename(builtin.path.dirname(file)).toLowerCase();

  function listShards(): Set<string> {
    try {
      const names = builtin.fs.readdirSync(builtin.path.join(dir, "index"));
      return new Set(names.map((name) => name.toLowerCase()));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return new Set();
      throw wrapped(error, `list indexes in ${dir}`);
    }
  }

  /** Whether an index could be at `file`: its shard was there at the first look, or made since. */
  function listed(file: string): boolean {
    shards ??= listShards();
    return shards.has(shardOf(file));
  }

  function readIndex(integrity: string): PackageIndex | undefined {
    const memo = loaded.get(integrity);
    if (memo) return memo;
    // A miss is not remembered: the next read may be after a download wrote the index.
    const found = loadIndex(integrity);
    if (found) loaded.set(integrity, found);
    return found;
  }

  // Synchronous on purpose. An index is a few KB the page cache already holds, and routing it
  // through the threadpool costs a futex round trip per file — ten times the read itself, and
  // 559 of them for `nuxt`.
  function loadIndex(integrity: string): PackageIndex | undefined {
    const file = writer.indexPath(integrity);
    // A cold store has no shard directory for most of what an install asks about, and a read
    // that fails on one costs ~100 µs under an install's load: 55 ms of `nuxt`'s main thread.
    // One listing answers for all of them; a shard this process makes is added in `download`.
    // Folded to one case: a shard is two base64url characters, and on a case-insensitive
    // disk `Ab` and `aB` are one directory listed under whichever spelling made it. Folding
    // can only say "maybe there", which costs the read it would have cost anyway.
    if (!listed(file)) return undefined;
    let raw: string;
    const t = tracing ? now() : 0;
    try {
      raw = builtin.fs.readFileSync(file, "utf8");
    } catch (error) {
      if (tracing) tick("loadIndexMiss", now() - t);
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw wrapped(error, `read index for ${integrity}`);
    }
    // A torn or hand-edited index is a miss, not a crash — and must not be trusted blindly.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return isIndex(parsed) ? parsed : undefined;
  }

  /**
   * Every file the index names, still on disk at the right size. That is one stat per file —
   * 10,174 of them for `next` — so it is what `--verify` buys and not what every install pays.
   * Without it a *missing* file still cannot slip through: linking throws ELINK, and install
   * answers that by refilling the store and linking again. What only this catches is content
   * that is present but the wrong size.
   */
  function intact(index: PackageIndex): boolean {
    for (const file of index.files) {
      if (sizeOfSync(writer.blobPath(file.blob)) !== file.size) return false;
    }
    return true;
  }

  async function build(tarball: Tarball, integrity: string): Promise<PackageIndex> {
    const hit = readIndex(integrity);
    if (hit && (!verify || intact(hit))) return hit;
    // A hit that failed the check has damaged content, so rewrite rather than skip. The pool
    // is made here, on the first miss, and starts its threads as tarballs land with no idle
    // one and enough behind them — so an install that finds everything cached never pays
    // for one, and nor does one of a package or five. Its loading is not waited on here: the
    // tarball is asked for now, and the pool is wanted once its headers or its bytes are in.
    if (!loading) void loadPool();
    if (backend) {
      const kept = await (await client())?.fetch(integrity, !!hit);
      if (kept) return await publish(integrity, kept);
    }
    behind++;
    trace("miss", { i: integrity, behind });
    try {
      // The address cache, in place before a download slot is taken; already, on a cold walk.
      const lookups = cacheLookups();
      if (lookups) await lookups;
      const index = await download(tarball, integrity, hit !== undefined);
      if (backend?.set) void client().then((it) => it?.put(integrity, index, tarball));
      return index;
    } finally {
      behind--;
    }
  }

  /**
   * The pool, loaded on the first miss and never imported statically: it holds its worker's
   * code, which an install that finds everything cached never needs. One that cannot load
   * unpacks here.
   */
  function loadPool(): Promise<Pool | undefined> {
    return (loading ??= import("./unpack-pool.ts")
      .then(
        ({ createPool }) =>
          (pool = createPool(dir, {
            size: options.workers,
            concurrency,
            entry: options.workerEntry,
            fallback: unpackHere,
            noThreads: options.noThreads,
          })),
      )
      .catch(() => {
        if (options.workers !== 0) options.noThreads?.();
        return undefined;
      }));
  }

  /** Verify and unpack on this thread. What a worker does, when there is no worker. */
  async function unpackHere(
    integrity: string,
    bytes: Uint8Array[],
    repair: boolean,
  ): Promise<PackageIndex> {
    await verifyTarball(integrity, bytes);
    return await disk(() => writer.unpack(integrity, bytes, repair));
  }

  async function download(tarball: Tarball, integrity: string, repair: boolean) {
    let index: PackageIndex;
    try {
      index = await fill(tarball, integrity, repair, true);
    } catch (error) {
      // A dead worker reported nothing, so its tarball is simply un-unpacked — but the bytes
      // were transferred to it rather than copied, so the redo starts back at the network.
      // Once, and here: whatever killed a worker must not be handed to another one.
      if ((error as { code?: string }).code !== WORKER_DIED) throw error;
      index = await fill(tarball, integrity, repair, false);
    }
    return await publish(integrity, index);
  }

  /** Wait until the bytes landed and not yet in the store are under `held`. */
  async function room(): Promise<void> {
    while (held >= most) await new Promise<void>((resolve) => roomy.push(resolve));
  }

  function unheld(bytes: number): void {
    held -= bytes;
    while (held < most && roomy.length > 0) roomy.shift()!();
  }

  /** The index is what makes the content findable, so only this thread ever writes one. */
  async function publish(integrity: string, index: PackageIndex): Promise<PackageIndex> {
    const file = writer.indexPath(integrity);
    await writer.ensureDir(builtin.path.dirname(file));
    shards?.add(shardOf(file));
    await writer.put(file, new TextEncoder().encode(JSON.stringify(index)), INDEX_MODE, true);
    trace("index", { i: integrity, files: index.files.length });
    loaded.set(integrity, index);
    downloaded.add(integrity);
    return index;
  }

  /**
   * Fetch a tarball and turn it into content, in a worker when `offer` and the pool allow. The
   * download slot is given back at the last byte, not at the index: held through the unpack,
   * `large` had all 32 slots waiting on busy workers and no request out for 600 ms. What bounds
   * memory past the slot is `room`.
   */
  async function fill(
    tarball: Tarball,
    integrity: string,
    repair: boolean,
    offer: boolean,
  ): Promise<PackageIndex> {
    const open = offer
      ? async (size: number) => (pool ?? (await loadPool()))?.open(integrity, repair, size)
      : undefined;
    const pulled = await net(async (signal) => {
      // Asked with the slot in hand: before it, every tarball of the install would pass at once.
      await room();
      signal.restart();
      trace("slot", { i: integrity, behind });
      trace("pull", { i: integrity, url: tarball });
      return await pull(tarball, signal, open);
    });
    held += pulled.size;
    try {
      if ("streamed" in pulled) return await pulled.streamed;
      // The hash is checked where the unpack runs, so a worker takes that off this thread too.
      const { bytes } = pulled;
      const ready = offer ? (pool ?? (await loadPool())) : undefined;
      const offered = ready?.offer(integrity, bytes, repair, behind);
      trace("offer", { i: integrity, behind, taken: !!offered });
      return await (offered ?? unpackHere(integrity, bytes, repair));
    } finally {
      unheld(pulled.size);
    }
  }

  /**
   * Download a tarball. Nothing here touches the disk, and nothing here checks the hash: that
   * happens on the thread that unpacks, before it writes a byte.
   *
   * A busy server, a 5xx and a socket that died are all worth asking again about; a missing
   * tarball or a corrupt one is not, and asking twice would only turn a loud failure into a
   * slow one. Back pressure is reported even when a later attempt succeeds, because from
   * outside a retried request is indistinguishable from a slow one.
   */
  async function pull(tarball: Tarball, signal: Signal, open?: Open): Promise<Pulled> {
    if (typeof tarball !== "string") {
      const bytes = await readLocal(tarball.path);
      return { bytes: [bytes], size: bytes.byteLength };
    }
    if (options.offline) {
      throw Object.assign(new Error(`offline: ${tarball} is not in the store`), {
        code: "EOFFLINE",
      });
    }
    let last: unknown;
    // What the last answer asked us to wait, which beats guessing when the server said.
    let asked = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(asked || BACKOFF * 2 ** (attempt - 1));
      try {
        return await once(tarball, open);
      } catch (error) {
        const { code, status, wait } = error as { code?: string; status?: number; wait?: number };
        asked = wait ?? 0;
        const busy = status !== undefined && isThrottle(status);
        const gone = status === undefined && (code === "ENETWORK" || code === "ETIMEDOUT");
        // A missing tarball or a corrupt one is a fault, not a busy minute.
        if (!busy && (status ?? 0) < 500 && !gone) throw error;
        // A server too busy to answer and one too busy to finish answering are the same news.
        if (busy || code === "ETIMEDOUT") signal.throttled();
        last = error;
      }
    }
    throw last;
  }

  /**
   * One attempt at the bytes. Both halves are guarded: a socket that dies partway through a
   * 40 MB tarball is the ordinary transient failure, and it arrives as an uncoded TypeError
   * out of the middle of the stream rather than out of the request.
   */
  async function once(tarball: string, open?: Open): Promise<Pulled> {
    const quiet = new AbortController();
    let timer = setTimeout(() => quiet.abort(), stall);
    /** Restart the clock: what is being watched for is silence, not slowness. */
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => quiet.abort(), stall);
    };
    try {
      return await attempt(tarball, quiet.signal, alive, open);
    } catch (error) {
      // fetch rejects with an uncoded TypeError, so give the retry something to switch on. Ours
      // carry a string code; the stall's own abort arrives as a DOMException whose `code` is a
      // number, and is not one of ours.
      if (typeof (error as { code?: unknown })?.code === "string") throw error;
      const silent = quiet.signal.aborted;
      throw Object.assign(
        new Error(
          `Tarball ${tarball} ${silent ? `went quiet for ${stall} ms` : "failed"}: ${
            (error as Error)?.message ?? error
          }`,
        ),
        { code: silent ? "ETIMEDOUT" : "ENETWORK" },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function attempt(
    tarball: string,
    aborted: AbortSignal,
    alive: () => void,
    open?: Open,
  ): Promise<Pulled> {
    const authorization = auth && authFor(auth, tarball);
    const headers = authorization ? { authorization } : undefined;
    const get = options.fetch ? undefined : getter();
    const response: Answer = get
      ? await get(tarball, headers, aborted)
      : await request(tarball, { ...(headers && { headers }), signal: aborted });
    if (response.status < 200 || response.status > 299) {
      throw Object.assign(new Error(`Tarball ${tarball} returned ${response.status}`), {
        code: response.status === 404 ? "E404" : "ENETWORK",
        status: response.status,
        wait: isThrottle(response.status) ? retryAfter(response) : 0,
      });
    }
    const body = response.body;
    if (!body) throw Object.assign(new Error("Tarball response had no body"), { code: "ENETWORK" });
    // A big tarball's blocks go to a worker as they land, when there is one to go to.
    const length = Number(response.headers.get("content-length"));
    // The first misses may still be loading the pool: a big one waits for it, its body buffering.
    const sink = length >= STREAM_MIN ? await open?.(length) : undefined;
    trace("head", { i: tarball, length, stream: !!sink });
    let got = 0;
    // Joined into blocks as it arrives rather than into one buffer at the end: a 40 MB
    // tarball concatenated whole is briefly held twice, right when the unpack needs the room.
    // Blocks keep that transient down to BLOCK bytes without handing gunzip the thousands of
    // 16 KB writes the raw chunks would be, which measured slower than one big write.
    const bytes: Uint8Array[] = [];
    let pending: Uint8Array[] = [];
    let waiting = 0;
    const landed = (block: Uint8Array) => (sink ? sink.push(block) : bytes.push(block));
    try {
      for await (const chunk of body) {
        alive();
        if (tracing && got === 0) trace("first", { i: tarball });
        got += chunk.byteLength;
        pending.push(chunk);
        waiting += chunk.byteLength;
        if (waiting >= BLOCK) {
          landed(concat(pending, waiting));
          pending = [];
          waiting = 0;
        }
      }
      if (waiting > 0) landed(concat(pending, waiting));
      trace("last", { i: tarball, bytes: got });
    } catch (error) {
      sink?.abort();
      throw error;
    }
    return sink ? { streamed: sink.end(), size: got } : { bytes, size: got };
  }

  const store: Store = {
    dir,
    contentPath: writer.contentPath,
    blobPath: (file) => writer.blobPath(file.blob),
    index: readIndex,
    pending: (integrity) => pending.get(integrity),
    indexPath,
    // An integrity the store cannot spell has no index; `add` is where it is reported. One found
    // is remembered: a warm install asks for each up to three times. A miss is asked again.
    indexSize(integrity) {
      let size = sizes.get(integrity);
      if (size !== undefined) return size;
      try {
        // A cold store has no shard for most of these: the listing answers without a stat each.
        const file = indexPath(integrity);
        size = listed(file) ? Math.max(0, sizeOfSync(file)) : 0;
      } catch {
        return 0;
      }
      if (size > 0) sizes.set(integrity, size);
      return size;
    },
    async ensure(tarball, integrity) {
      if (!verify && (loaded.has(integrity) || store.indexSize(integrity) > 0)) return;
      await store.add(tarball, integrity);
    },
    async add(tarball, integrity) {
      // Share one download between concurrent callers asking for the same tarball.
      const shared = pending.get(integrity);
      if (shared) return { index: await shared, cached: true };

      const hit = build(tarball, integrity).catch((error: unknown) => {
        pending.delete(integrity);
        throw error;
      });
      pending.set(integrity, hit);
      const index = await hit;
      // Only the caller that actually went to the network is not a cache hit.
      return { index, cached: !downloaded.has(integrity) };
    },
    async adopt(tarball) {
      const lookups = cacheLookups();
      if (lookups) await lookups;
      const bytes = await net(async (signal) => {
        const pulled = await pull(tarball, signal); // no `open`, so never streamed
        signal.settled();
        return (pulled as { bytes: Uint8Array[] }).bytes;
      });
      const hash = createHasher("sha512");
      for (const block of bytes) hash.update(block);
      const integrity = `sha512-${toBase64(await hash.digest())}`;
      const hit = readIndex(integrity);
      // Checked whatever `verify` says: the caller reads its package.json next, and a file the
      // index names but the disk lost would fail that read with nothing to repair it.
      if (hit && intact(hit)) return { index: hit, integrity };
      const index = await unpackHere(integrity, bytes, hit !== undefined);
      return { index: await publish(integrity, index), integrity };
    },
    close() {
      pool?.close();
    },
    async flush() {
      await (await backing)?.flush();
    },
  };
  return store;
}

/**
 * A local tarball's bytes. A file that is not there will not be by the next attempt either.
 * A regular file only: a link to a device or a pipe would never end.
 */
async function readLocal(path: string): Promise<Uint8Array> {
  try {
    if (!(await builtin.fsp.stat(path)).isFile()) {
      throw Object.assign(new Error("not a regular file"), { code: "EINVAL" });
    }
    return await builtin.fsp.readFile(path);
  } catch (error) {
    const { code } = error as { code?: string };
    throw Object.assign(new Error(`Tarball ${path} cannot be read`), { code, cause: error });
  }
}

/**
 * Exported so the collector judges an index exactly as the store does. An index in an older
 * shape fails this and is a miss, so the tarball is fetched and unpacked again.
 */
