import { Buffer } from "node:buffer";
import { link, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRACE_MS, pruneStore, sweepEntries } from "../src/gc.ts";
import { hashOf } from "./hash.ts";
import { createStore } from "../src/store.ts";
import type { PackageIndex } from "../src/store.ts";
import { makeTarball } from "./tarball.ts";
import type { Entry } from "./tarball.ts";

let root: string;
let storeDir: string;
let project: string;
/** Tarball integrity per fixture name, so a package's index can be found again. */
const tarballs = new Map<string, string>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "upm-gc-"));
  storeDir = join(root, "store");
  project = join(root, "project");
  tarballs.clear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sweepEntries", () => {
  it("removes an orphan entry and keeps a wanted one", async () => {
    await entry("wanted@1.0.0-aaa", { "index.js": "keep" });
    await entry("orphan@2.0.0-bbb", { "index.js": "go" });

    const result = await sweepEntries(project, new Set(["wanted@1.0.0-aaa"]));

    expect(result.removed).toBe(1);
    expect(await entries()).toEqual(["wanted@1.0.0-aaa"]);
  });

  it("leaves an entry a concurrent install may have just made", async () => {
    // The caller read its state before that install started, so the key is missing from `keep`.
    await entry("fresh@1.0.0-ccc", { "index.js": "new" }, true);
    await entry("orphan@2.0.0-bbb", { "index.js": "go" });

    const result = await sweepEntries(project, new Set());

    expect(result.removed).toBe(1);
    expect(await entries()).toEqual(["fresh@1.0.0-ccc"]);
  });

  it("never removes a .tmp-* directory a concurrent install is staging in", async () => {
    await entry(".tmp-1234-0", { "index.js": "staging" });
    await entry("orphan@2.0.0-bbb", { "index.js": "go" });

    const result = await sweepEntries(project, new Set());

    expect(result.removed).toBe(1);
    expect(await entries()).toEqual([".tmp-1234-0"]);
  });

  it("never removes the hoisted names in .upm/node_modules", async () => {
    await entry("node_modules", { "index.js": "hoisted" });
    await entry("orphan@2.0.0-bbb", { "index.js": "go" });

    const result = await sweepEntries(project, new Set());

    expect(result.removed).toBe(1);
    expect(await entries()).toEqual(["node_modules"]);
  });

  it("is a no-op when the project has no .upm yet", async () => {
    expect(await sweepEntries(project, new Set())).toEqual({ removed: 0, bytes: 0 });
  });

  it("tolerates the entry vanishing under it", async () => {
    await entry("orphan@2.0.0-bbb", { "index.js": "go" });

    // Two sweeps list the same orphan; the loser must still succeed.
    const both = await Promise.all([
      sweepEntries(project, new Set()),
      sweepEntries(project, new Set()),
    ]);

    expect(both.every((r) => r.removed === 1)).toBe(true);
    expect(await entries()).toEqual([]);
  });

  it("does not count hardlinked content, which the store still holds", async () => {
    const blob = join(root, "blob.js");
    await writeFile(blob, "x".repeat(64 * 1024));
    const at = await entry("orphan@1.0.0-aaa", {});
    await link(blob, join(at, "node_modules", "pkg", "index.js"));

    const result = await sweepEntries(project, new Set());

    expect(result.removed).toBe(1);
    // Only the directories come back; the inode still has its other link.
    expect(result.bytes).toBeLessThan(64 * 1024);
  });

  it("counts copied content, which nothing else holds", async () => {
    await entry("orphan@1.0.0-aaa", { "index.js": "x".repeat(64 * 1024) });

    const result = await sweepEntries(project, new Set());

    expect(result.bytes).toBeGreaterThanOrEqual(64 * 1024);
  });
});

describe("pruneStore", () => {
  it("leaves a healthy store completely alone, twice", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    await add("b", [{ path: "index.js", data: "beta" }]);
    const before = await paths();
    await ageAll(storeDir); // nothing here is saved by the grace period

    expect(await pruneStore(storeDir)).toEqual({ blobs: 0, indexes: 0, bytes: 0 });
    expect(await pruneStore(storeDir)).toEqual({ blobs: 0, indexes: 0, bytes: 0 });
    expect(await paths()).toEqual(before);
  });

  it("removes a blob no index references and keeps the referenced ones", async () => {
    const index = await add("a", [
      { path: "index.js", data: "alpha" },
      { path: "other.js", data: "beta" },
    ]);
    const orphan = blobOf("nothing points here", false);
    await mkdir(join(orphan, ".."), { recursive: true });
    await writeFile(orphan, "nothing points here");
    await ageAll(storeDir);

    const result = await pruneStore(storeDir);

    expect(result).toMatchObject({ blobs: 1, indexes: 0 });
    expect(result.bytes).toBe("nothing points here".length);
    for (const file of index.files)
      expect(await exists(createStore({ dir: storeDir }).blobPath(file))).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("treats the exec and non-exec variants of one blob independently", async () => {
    await add("plain", [{ path: "index.js", data: "shared" }]);
    await add("runner", [{ path: "cli.js", data: "shared", mode: 0o755 }]);
    const plain = blobOf("shared", false);
    const exec = blobOf("shared", true);
    expect(await exists(plain)).toBe(true);
    expect(await exists(exec)).toBe(true);

    await rm(await indexFile("runner"));
    await ageAll(storeDir);
    const result = await pruneStore(storeDir);

    expect(result.blobs).toBe(1);
    expect(await exists(plain)).toBe(true);
    expect(await exists(exec)).toBe(false);
  });

  it("removes an index that cannot be parsed, and the content only it named", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    await writeFile(await indexFile("a"), "{ not json");
    await ageAll(storeDir);

    const result = await pruneStore(storeDir);

    expect(result).toMatchObject({ blobs: 1, indexes: 1 });
    expect(await paths()).toEqual([]);
  });

  it("removes an index whose content is gone", async () => {
    await add("a", [
      { path: "index.js", data: "alpha" },
      { path: "other.js", data: "beta" },
    ]);
    await rm(blobOf("alpha", false));
    await ageAll(storeDir);

    const result = await pruneStore(storeDir);

    // The index goes because it can never be replayed, and "beta" with it.
    expect(result).toMatchObject({ blobs: 1, indexes: 1 });
    expect(await paths()).toEqual([]);
  });

  it("keeps a shared blob when only one of two indexes is broken", async () => {
    await add("a", [{ path: "index.js", data: "shared" }]);
    await add("b", [{ path: "lib.js", data: "shared" }]); // a different tarball, the same content
    await writeFile(await indexFile("a"), "{ not json");
    await ageAll(storeDir);

    const result = await pruneStore(storeDir);

    expect(result).toMatchObject({ blobs: 0, indexes: 1 });
    expect(await exists(blobOf("shared", false))).toBe(true);
  });

  it("spares an orphan blob younger than the grace period", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    const fresh = blobOf("written moments ago", false);
    await mkdir(join(fresh, ".."), { recursive: true });
    await writeFile(fresh, "written moments ago");

    expect(await pruneStore(storeDir)).toEqual({ blobs: 0, indexes: 0, bytes: 0 });
    expect(await exists(fresh)).toBe(true);

    // The same blob, only older, is garbage.
    await age(fresh);
    expect(await pruneStore(storeDir)).toMatchObject({ blobs: 1 });
    expect(await exists(fresh)).toBe(false);
  });

  it("prunes the shard directories it empties", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    await writeFile(await indexFile("a"), "{ not json");
    await ageAll(storeDir);

    await pruneStore(storeDir);

    expect(await readdir(join(storeDir, "files"))).toEqual([]);
    expect(await readdir(join(storeDir, "index"))).toEqual([]);
  });

  it("ignores a store that does not exist", async () => {
    expect(await pruneStore(join(root, "nowhere"))).toEqual({ blobs: 0, indexes: 0, bytes: 0 });
  });

  it("leaves an in-flight *.tmp write of another process alone", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    const inFlight = `${blobOf("alpha", false)}.999-0.tmp`;
    await writeFile(inFlight, "half written");
    await ageAll(storeDir);

    expect(await pruneStore(storeDir)).toEqual({ blobs: 0, indexes: 0, bytes: 0 });
    expect(await exists(inFlight)).toBe(true);
  });

  it("sweeps a spooled *.tmp at the files root once its process is dead and it has aged", async () => {
    await add("a", [{ path: "index.js", data: "alpha" }]);
    const files = join(storeDir, "files");
    // A pid no process has: the largest Linux allows, plus one. `process.pid` is alive.
    const dead = join(files, "4194305-abcd1234-0.tmp");
    const live = join(files, `${process.pid}-abcd1234-1.tmp`);
    const young = join(files, "4194305-abcd1234-2.tmp");
    for (const at of [dead, live, young]) await writeFile(at, "spooled");
    await ageAll(storeDir);
    await writeFile(young, "spooled again");

    expect(await pruneStore(storeDir)).toEqual({ blobs: 1, indexes: 0, bytes: 7 });
    expect(await exists(dead)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect(await exists(young)).toBe(true);
  });
});

// --- fixtures ---

/** Put one package in the real store under a fixture name. */
async function add(name: string, files: Entry[]): Promise<PackageIndex> {
  const tarball = makeTarball(files);
  const store = createStore({ dir: storeDir, fetch: stubFetch(tarball) });
  const { index } = await store.add(`https://reg/${name}.tgz`, hashOf(tarball));
  tarballs.set(name, hashOf(tarball));
  return index;
}

/** Where the store put a package's index, found through the store's own path rules. */
async function indexFile(name: string): Promise<string> {
  const integrity = tarballs.get(name) as string;
  // `index/<shard>/<base>.json` mirrors `files/<shard>/<base>`, so borrow contentPath's split.
  const blob = createStore({ dir: storeDir }).contentPath(integrity, false);
  return `${blob.replace(join(storeDir, "files"), join(storeDir, "index"))}.json`;
}

/** The store path of a blob, by its content. */
function blobOf(content: string, exec: boolean): string {
  return createStore({ dir: storeDir }).contentPath(hashOf(Buffer.from(content)), exec);
}

/** Every file under the store, sorted — the shape a prune must not change. */
async function paths(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const full = join(at, item.name);
      if (item.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(storeDir);
  return found.sort();
}

/** Push one file's mtime past the grace period. */
async function age(path: string): Promise<void> {
  const when = new Date(Date.now() - GRACE_MS - 60_000);
  await utimes(path, when, when);
}

async function ageAll(at: string): Promise<void> {
  for (const item of await readdir(at, { withFileTypes: true }).catch(() => [])) {
    const full = join(at, item.name);
    if (item.isDirectory()) await ageAll(full);
    else await age(full);
  }
}

/** One `.upm` entry in the project, with real files under its package directory. */
/** `fresh` keeps the entry inside the grace period, where the sweep must leave it alone. */
async function entry(key: string, files: Record<string, string>, fresh = false): Promise<string> {
  const at = join(project, "node_modules", ".upm", key);
  await mkdir(join(at, "node_modules", "pkg"), { recursive: true });
  for (const [path, data] of Object.entries(files)) {
    await writeFile(join(at, "node_modules", "pkg", path), data);
  }
  if (!fresh) await age(at);
  return at;
}

async function entries(): Promise<string[]> {
  return (await readdir(join(project, "node_modules", ".upm"))).sort();
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

function stubFetch(body: Uint8Array): typeof fetch {
  return (async () => new Response(body as unknown as BodyInit)) as unknown as typeof fetch;
}
