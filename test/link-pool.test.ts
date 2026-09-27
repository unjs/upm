import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashOf } from "./hash.ts";
import { linkOf } from "./link.ts";
import { defaultPoolSize } from "../src/api.ts";
import { parseArgv, parseLinkPool } from "../src/cli.ts";
import { linkTree } from "../src/link.ts";
import type { LinkPool } from "../src/link.ts";
import { startLinkPool } from "../src/link-pool.ts";
import type { ResolvedPackage, Resolution } from "../src/resolve.ts";
import { cpus } from "../src/runtime.ts";
import { createStore } from "../src/store.ts";
import type { Store } from "../src/store.ts";
import { makeTarball } from "./tarball.ts";

interface Fixture {
  name: string;
  files?: Record<string, string>;
  bin?: Record<string, string>;
  deps?: Record<string, string>;
}

let root: string;
const open: LinkPool[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "upm-link-pool-"));
});

afterEach(async () => {
  for (const pool of open.splice(0)) pool.close();
  await rm(root, { recursive: true, force: true });
});

/** Scoped and plain names, nested files, bins, an entry that depends on a scoped one. */
const TREE: Fixture[] = [
  {
    name: "app",
    files: { "index.js": "app", "lib/a/b/c.js": "c", "lib/a/d.js": "d", "lib/e.js": "e" },
    deps: { "@s/one": "1.0.0", two: "1.0.0" },
    bin: { app: "index.js" },
  },
  { name: "@s/one", files: { "index.js": "one", "dist/x.js": "x" }, bin: { one: "index.js" } },
  { name: "two", files: { "index.js": "two" }, deps: { "@s/one": "1.0.0" } },
];

describe("link pool", () => {
  it("builds the same tree the sync path builds", async () => {
    const { store, resolution } = await seed(TREE);
    const pool = startLinkPool(2)!;
    open.push(pool);
    const pooled = await linkTree(resolution, {
      dir: join(root, "pooled"),
      store,
      pool: async () => pool,
    });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });

    expect(pooled.pooled).toBe(3);
    expect(alone.pooled).toBe(0);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(join(root, "pooled"))).toEqual(await snapshot(join(root, "alone")));
    expect(pooled.linked).toBe(10); // package.json per package plus the files above
    expect(pooled.bins).toBe(3); // @s/one's bin in app and in two, app's at the top
  });

  it("splits a large entry across workers and still matches the sync path", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`d${i % 37}/sub${i % 5}/f${i}.js`] = `${i}`;
    const { store, resolution } = await seed([{ name: "big", files }, { name: "small" }]);
    const pool = startLinkPool(3)!;
    open.push(pool);
    const pooled = await linkTree(resolution, {
      dir: join(root, "pooled"),
      store,
      pool: async () => pool,
    });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });

    expect(pooled.linked).toBe(602);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(join(root, "pooled"))).toEqual(await snapshot(join(root, "alone")));
  });

  it("counts as pooled only the entries that landed", async () => {
    const { store, resolution } = await seed(TREE);
    const pool = startLinkPool(2)!;
    open.push(pool);
    const dir = join(root, "shared");
    // Another install takes every name while this one is waiting for its pool: the pool
    // builds all three entries and every rename loses.
    const lost = await linkTree(resolution, {
      dir,
      store,
      pool: async () => {
        await linkTree(resolution, { dir, store });
        return pool;
      },
    });
    expect(lost).toMatchObject({ entries: 0, reused: 3, pooled: 0, linked: 10 });
    await linkTree(resolution, { dir: join(root, "alone"), store });
    expect(await snapshot(dir)).toEqual(await snapshot(join(root, "alone")));
  });

  it("is asked once, with the file count, and a refusal means the sync path", async () => {
    const { store, resolution } = await seed(TREE);
    const counts: number[] = [];
    const ask = vi.fn(async (files: () => number) => void counts.push(files()));
    const result = await linkTree(resolution, { dir: join(root, "p"), store, pool: ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(counts).toEqual([10]);
    expect(result).toMatchObject({ entries: 3, pooled: 0, linked: 10 });
  });

  it("counts only the files of entries .store does not hold yet", async () => {
    const { store, resolution } = await seed(TREE);
    const dir = join(root, "p");
    const counts: number[] = [];
    const ask = vi.fn(async (files: () => number) => void counts.push(files()));
    await linkTree(resolution, { dir, store, pool: ask });
    // The install after `add`: the state is stale, the store intact, one entry is new.
    const { store: more, resolution: grown } = await seed([
      ...TREE,
      { name: "three", files: { "a.js": "a", "b.js": "b" } },
    ]);
    const result = await linkTree(grown, { dir, store: more, pool: ask });
    expect(result).toMatchObject({ entries: 1, reused: 3 });
    expect(counts.at(-1)).toBe(3); // package.json, a.js, b.js
  });

  it("surfaces a failure a worker reports as ELINK and leaves no temp entry behind", async () => {
    const { store, resolution } = await seed(TREE);
    // The store loses a file between fill and link: the same failure the sync path reports.
    const index = store.index(resolution.packages["two@1.0.0"]!.integrity)!;
    await unlink(store.blobPath(index.files.find((file) => file.path === "index.js")!));
    const threads = startLinkPool(2)!;
    open.push(threads);
    // The other entries are still building when two's fails: they must land or go first.
    const pool: LinkPool = {
      ...threads,
      run: (shard) =>
        shard.dir.endsWith("two")
          ? threads.run(shard)
          : threads.run(shard)?.then(async (done) => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              return done;
            }),
    };
    const dir = join(root, "pooled");
    await expect(
      linkTree(resolution, { dir, store, pool: async () => pool }),
    ).rejects.toMatchObject({
      code: "ELINK",
      message: expect.stringContaining("cannot link"),
    });
    const entries = await readdir(join(dir, "node_modules", ".store"));
    expect(entries.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("builds an entry here when its worker dies, and the tree comes out the same", async () => {
    const { store, resolution } = await seed(TREE);
    const pool = flaky(1, { die: 0 });
    const pooled = await linkTree(resolution, {
      dir: join(root, "pooled"),
      store,
      pool: async () => pool,
    });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });

    expect(pooled.pooled).toBe(0);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(join(root, "pooled"))).toEqual(await snapshot(join(root, "alone")));
    expect(pool.run({ dirs: [], dir: "", paths: [], blobDir: "", blobs: [], symlinks: [] })).toBe(
      undefined,
    );
  });

  it("settles every shard of an entry before building it here after a worker dies", async () => {
    const { store, resolution } = await seed([{ name: "big", files: bigFiles() }]);
    // Shard 0 kills its worker; shard 1 is still asleep on the other one. A rebuild that
    // started meanwhile would race it: an ENOTEMPTY off the temp dir, or the sibling
    // recreating that dir after the entry was renamed in and leaving it behind.
    const pool = flaky(2, { die: 0, sleep: 80 });
    const pooled = await linkTree(resolution, {
      dir: join(root, "pooled"),
      store,
      pool: async () => pool,
    });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await temps(join(root, "pooled"))).toEqual([]);
    expect(await snapshot(join(root, "pooled"))).toEqual(await snapshot(join(root, "alone")));
  });

  it("settles every shard of an entry before a failure one of them reports is raised", async () => {
    const { store, resolution } = await seed([{ name: "big", files: bigFiles() }]);
    const index = store.index(resolution.packages["big@1.0.0"]!.integrity)!;
    // The largest directory is d0, and it goes to shard 0; shard 1 sleeps on the other worker.
    await unlink(store.blobPath(index.files.find((file) => file.path === "d0/f0.js")!));
    const pool = flaky(2, { sleep: 80 });
    const dir = join(root, "pooled");
    await expect(
      linkTree(resolution, { dir, store, pool: async () => pool }),
    ).rejects.toMatchObject({ code: "ELINK" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await temps(dir)).toEqual([]);
  });

  it("builds every entry here when no worker says hello in time, and leaves nothing behind", async () => {
    const { store, resolution } = await seed([{ name: "big", files: bigFiles() }, ...TREE]);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const pool = flaky(2, { mute: "all", bootMs: 40 });
    // The one timer never holds the process open.
    const boot = timers.mock.results.find((_, i) => timers.mock.calls[i]![1] === 40)!.value;
    expect((boot as NodeJS.Timeout).hasRef()).toBe(false);
    timers.mockRestore();
    const dir = join(root, "pooled");
    const pooled = await linkTree(resolution, { dir, store, pool: async () => pool });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });
    expect(pooled.pooled).toBe(0);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(dir)).toEqual(await snapshot(join(root, "alone")));
    expect(await temps(dir)).toEqual([]);
    // The pool is broken for good: a later entry is not queued to wait on nothing.
    expect(pool.run({ dirs: [], dir: "", paths: [], blobDir: "", blobs: [], symlinks: [] })).toBe(
      undefined,
    );
  });

  it("terminates a thread that never speaks and goes on with the ones that did", async () => {
    const { store, resolution } = await seed([{ name: "big", files: bigFiles() }, ...TREE]);
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    // The first thread to load is the silent one; the other must be up before the timer,
    // which a slow Windows runner can take past half a second to do.
    const bootMs = process.platform === "win32" ? 3000 : 500;
    const pool = flaky(2, { mute: root, bootMs });
    const until = Date.now() + bootMs + 4500;
    while (terminate.mock.calls.length === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(terminate).toHaveBeenCalledTimes(1);
    terminate.mockRestore();
    const dir = join(root, "pooled");
    const pooled = await linkTree(resolution, { dir, store, pool: async () => pool });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });
    expect(pooled.pooled).toBe(4);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(dir)).toEqual(await snapshot(join(root, "alone")));
    expect(await temps(dir)).toEqual([]);
  });

  it("keeps the process alive for a shard queued before any thread has spoken", async () => {
    // A queued shard refs nothing itself, so the booting thread must. A `message` listener
    // added before the pool's (a Worker subclass, a preload) takes the port's own ref: counted
    // on, this child exits with the shard unsettled. Plain `-e`: a worker inherits the flags.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `const threads = require("node:worker_threads");
         threads.Worker = class extends threads.Worker {
           constructor(entry, options) { super(entry, options); this.on("message", () => {}); }
         };
         import(${JSON.stringify(POOL.href)}).then(async ({ startLinkPool }) => {
           const pool = startLinkPool(1, new URL(${JSON.stringify(FLAKY.href)}));
           const shard = { dirs: [], dir: "", paths: [], blobDir: "", blobs: [], symlinks: [] };
           console.log("settled", await pool.run(shard));
         });`,
      ],
      { timeout: 10_000 },
    );
    expect(stdout).toContain("settled");
  });

  it("builds every entry here when the worker entry cannot load", async () => {
    const { store, resolution } = await seed(TREE);
    const noThreads = vi.fn();
    const pool = startLinkPool(
      2,
      new URL("./no-such-worker.ts", import.meta.url),
      10_000,
      noThreads,
    )!;
    open.push(pool);
    const pooled = await linkTree(resolution, {
      dir: join(root, "pooled"),
      store,
      pool: async () => pool,
    });
    const alone = await linkTree(resolution, { dir: join(root, "alone"), store });
    expect(pooled.pooled).toBe(0);
    expect({ ...pooled, pooled: 0 }).toEqual(alone);
    expect(await snapshot(join(root, "pooled"))).toEqual(await snapshot(join(root, "alone")));
    expect(noThreads).toHaveBeenCalledTimes(1);
  });

  it("is not started at all where worker_threads cannot be had", async () => {
    vi.resetModules();
    vi.doMock("../src/builtin.ts", async (importOriginal) => {
      const real = (await importOriginal<typeof import("../src/builtin.ts")>()).builtin;
      return {
        builtin: {
          ...real,
          get workers(): never {
            throw Object.assign(new Error("no worker_threads"), { code: "ENOBUILTIN" });
          },
        },
      };
    });
    try {
      const { startLinkPool: start } = await import("../src/link-pool.ts");
      expect(start(2)).toBe(undefined);
      // Nor in a browser, whose timer is a number with nothing to unref.
      vi.stubGlobal("setTimeout", () => 1);
      const noThreads = vi.fn();
      expect(start(2, undefined, undefined, noThreads)).toBe(undefined);
      expect(noThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("../src/builtin.ts");
      vi.resetModules();
    }
  });
});

describe("--experimental-link-pool", () => {
  it("has no default pool without two spare cores, and at most four workers", () => {
    expect(defaultPoolSize(1)).toBe(0);
    expect(defaultPoolSize(2)).toBe(0);
    expect(defaultPoolSize(3)).toBe(2);
    expect(defaultPoolSize(4)).toBe(3);
    expect(defaultPoolSize(5)).toBe(4);
    expect(defaultPoolSize(16)).toBe(4);
    expect(parseLinkPool("")!.size).toBe(defaultPoolSize(cpus()));
    // One worker is a tuning knob: slower than the sync loop, so never the default.
    expect(parseLinkPool("1")!.size).toBe(1);
  });

  it("parses the size and the two thresholds, with defaults for what is left out", () => {
    const size = defaultPoolSize(cpus());
    expect(parseLinkPool("")).toEqual({ size, packages: 200, files: 6000 });
    expect(parseLinkPool("on")).toEqual({ size, packages: 200, files: 6000 });
    expect(parseLinkPool("off")).toEqual({ size: 0, packages: 200, files: 6000 });
    expect(parseLinkPool("2")).toEqual({ size: 2, packages: 200, files: 6000 });
    expect(parseLinkPool("2,0")).toEqual({ size: 2, packages: 0, files: 6000 });
    expect(parseLinkPool("2,10,20")).toEqual({ size: 2, packages: 10, files: 20 });
    expect(parseLinkPool("0")).toEqual({ size: 0, packages: 200, files: 6000 });
    expect(parseLinkPool("x")).toBe(undefined);
    expect(parseLinkPool("4,-1")).toBe(undefined);
    expect(parseLinkPool("1,2,3,4")).toBe(undefined);
  });

  it("refuses empty fields, fractions and more than 64 workers", () => {
    // `Number("")` is 0, so `4,,` would have read as "every install".
    expect(parseLinkPool(",")).toBe(undefined);
    expect(parseLinkPool(",,")).toBe(undefined);
    expect(parseLinkPool("4,")).toBe(undefined);
    expect(parseLinkPool("4,,")).toBe(undefined);
    expect(parseLinkPool(",200")).toBe(undefined);
    expect(parseLinkPool("1.5")).toBe(undefined);
    expect(parseLinkPool("0x4")).toBe(undefined);
    expect(parseLinkPool(" 4")).toBe(undefined);
    expect(parseLinkPool("65")).toBe(undefined);
    expect(parseLinkPool("64")!.size).toBe(64);
  });

  it("is an install flag", () => {
    expect(parseArgv(["install", "--experimental-link-pool"]).linkPool).toEqual(parseLinkPool(""));
    expect(parseArgv(["install", "--experimental-link-pool=4,0,0"]).linkPool).toEqual({
      size: 4,
      packages: 0,
      files: 0,
    });
    expect(parseArgv(["install", "--experimental-link-pool=nope"]).error).toContain(
      "--experimental-link-pool takes",
    );
  });
});

describe("--experimental-link-pool through the cli", () => {
  const run = promisify(execFile);
  const CLI = fileURLToPath(new URL("../src/upm.ts", import.meta.url));
  const tarball = makeTarball([{ path: "index.js", data: "module.exports = 1;\n" }]);
  let dir: string;
  let server: Server;
  let registry: string;

  beforeEach(async () => {
    dir = join(root, "project");
    server = createServer((request, response) => {
      if (!request.url?.endsWith("/-/a-1.0.0.tgz")) {
        response.writeHead(404).end("no");
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await rm(dir, { recursive: true, force: true });
    await writeFile(
      join(dir, "package.json"),
      '{"name":"demo","version":"1.0.0","dependencies":{"a":"^1"}}',
      {
        flag: "w",
      },
    ).catch(async () => {
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        '{"name":"demo","version":"1.0.0","dependencies":{"a":"^1"}}',
      );
    });
    await writeFile(
      join(dir, "upm.lock"),
      `${JSON.stringify({
        lockfileVersion: 1,
        root: {
          name: "demo",
          version: "1.0.0",
          specs: { dependencies: { a: "^1" } },
          dependencies: { a: "1.0.0" },
        },
        packages: { "a@1.0.0": { integrity: hashOf(tarball) } },
      })}\n`,
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function install(
    flags: string[],
    env: Record<string, string> = {},
  ): Promise<{ pooled: number }> {
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    const { stdout } = await run(
      process.execPath,
      [
        CLI,
        "install",
        "--frozen-lockfile",
        "--json",
        "--dir",
        dir,
        "--store",
        join(root, "store2"),
        "--registry",
        registry,
        ...flags,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(await readFile(join(dir, "node_modules", "a", "index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    return JSON.parse(stdout) as { pooled: number };
  }

  it("pools when either threshold is met, and not otherwise", async () => {
    expect((await install(["--experimental-link-pool=2,0,0"])).pooled).toBe(1);
    // One package of one file: over the file threshold, under the package one.
    expect((await install(["--experimental-link-pool=2,5,1"])).pooled).toBe(1);
    expect((await install(["--experimental-link-pool=2,5,2"])).pooled).toBe(0);
    expect((await install(["--experimental-link-pool=0"])).pooled).toBe(0);
    expect((await install([])).pooled).toBe(0);
  });

  it("does not start early on the package count under --production", async () => {
    // Over the package threshold, under the file one: only the early trigger would fire.
    expect((await install(["--experimental-link-pool=2,0,2"])).pooled).toBe(1);
    expect((await install(["--experimental-link-pool=2,0,2", "--production"])).pooled).toBe(0);
    // The file count still counts what --production links.
    expect((await install(["--experimental-link-pool=2,5,1", "--production"])).pooled).toBe(1);
  });

  it("reads UPM_LINK_POOL, and the flag over it", async () => {
    expect((await install([], { UPM_LINK_POOL: "2,0,0" })).pooled).toBe(1);
    expect((await install(["--experimental-link-pool=0"], { UPM_LINK_POOL: "2,0,0" })).pooled).toBe(
      0,
    );
  });

  it("refuses UPM_LINK_POOL it cannot read, as it refuses the flag", async () => {
    const error = await run(process.execPath, [CLI, "install", "--dir", dir], {
      env: { ...process.env, UPM_LINK_POOL: "garbage" },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2 });
    expect(String((error as { stderr: string }).stderr)).toContain("UPM_LINK_POOL takes");
    // Only where it would be read: another command does not care.
    await run(process.execPath, [CLI, "run", "--dir", dir], {
      env: { ...process.env, UPM_LINK_POOL: "garbage" },
    });
  });

  it("is refused outside install", async () => {
    const error = await run(process.execPath, [
      CLI,
      "resolve",
      "a",
      "--experimental-link-pool",
    ]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2 });
    expect(String((error as { stderr: string }).stderr)).toContain("only applies to install");
  });
});

const POOL = new URL("../src/link-pool.ts", import.meta.url);
const FLAKY = new URL("./flaky-link-worker.ts", import.meta.url);

/** A pool of `test/flaky-link-worker.ts`, told through the environment how to misbehave. */
function flaky(
  size: number,
  how: { die?: number; sleep?: number; mute?: string; bootMs?: number },
): LinkPool {
  process.env.UPM_TEST_DIE = String(how.die ?? -1);
  process.env.UPM_TEST_SLEEP_MS = String(how.sleep ?? 0);
  process.env.UPM_TEST_MUTE = how.mute ?? "";
  try {
    const entry = new URL("./flaky-link-worker.ts", import.meta.url);
    const pool = startLinkPool(size, entry, how.bootMs)!;
    open.push(pool);
    return pool;
  } finally {
    delete process.env.UPM_TEST_DIE;
    delete process.env.UPM_TEST_SLEEP_MS;
    delete process.env.UPM_TEST_MUTE;
  }
}

/** 600 files over 37 directories: past SHARD_FILES, so two workers get a shard each. */
function bigFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 600; i++) files[`d${i % 37}/f${i}.js`] = `${i}`;
  return files;
}

async function temps(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, "node_modules", ".store"));
  return names.filter((name) => name.startsWith(".tmp-"));
}

/** Every path under node_modules with what it is: a link's target, a file's bytes. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const nm = join(dir, "node_modules");
  async function walk(at: string, rel: string): Promise<void> {
    for (const name of (await readdir(at)).sort()) {
      if (name === ".upm-state.json") continue;
      const path = join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) out[key] = `-> ${await linkOf(path)}`;
      else if (info.isDirectory()) {
        out[key] = "dir";
        await walk(path, key);
      } else out[key] = `${info.mode & 0o777}:${await readFile(path, "utf8")}`;
    }
  }
  await walk(nm, "");
  return out;
}

async function seed(fixtures: Fixture[]): Promise<{ store: Store; resolution: Resolution }> {
  const tarballs: Record<string, Uint8Array> = {};
  const packages: Record<string, ResolvedPackage> = {};
  for (const fixture of fixtures) {
    const id = `${fixture.name}@1.0.0`;
    const manifest = {
      name: fixture.name,
      version: "1.0.0",
      ...(fixture.bin && { bin: fixture.bin }),
    };
    const tarball = makeTarball([
      { path: "package.json", data: JSON.stringify(manifest) },
      ...Object.entries(fixture.files ?? {}).map(([path, data]) => ({ path, data })),
    ]);
    const url = `https://reg/${encodeURIComponent(id)}.tgz`;
    tarballs[url] = tarball;
    packages[id] = {
      name: fixture.name,
      version: "1.0.0",
      resolved: url,
      integrity: hashOf(tarball),
      dependencies: fixture.deps ?? {},
      optional: false,
      dev: false,
      bin: fixture.bin ?? {},
    };
  }
  const store = createStore({
    dir: join(root, "store"),
    fetch: (async (input: string | URL | Request) => {
      const bytes = tarballs[String(input)];
      return bytes ? new Response(bytes as unknown as BodyInit) : new Response("", { status: 404 });
    }) as typeof fetch,
  });
  for (const pkg of Object.values(packages)) await store.add(pkg.resolved, pkg.integrity);
  // Anything nothing else depends on is a direct dep of the root.
  const all = Object.values(packages);
  const dependencies = Object.fromEntries(
    all
      .filter((pkg) => !all.some((o) => o.dependencies[pkg.name]))
      .map((pkg) => [pkg.name, "1.0.0"]),
  );
  return { store, resolution: { root: { dependencies }, packages, warnings: [] } };
}
