// The commands as functions, against a local registry: every CLI command has one.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtin } from "../src/builtin.ts";
import * as upm from "../src/index.ts";
import { warnNewer } from "../src/newer.ts";
import { parseLockfile } from "../src/resolver.ts";
import { stampOf } from "../src/state.ts";
import { createStore } from "../src/store.ts";
import { holdTree, TREE_HELD } from "../src/tree-lock.ts";
import { hashOf } from "./hash.ts";
import { binOf } from "./link.ts";
import { makeTarball } from "./tarball.ts";

const tarball = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid";\n' }]);

let dir: string;
let server: Server;
let lines: string[];
let base: upm.InstallOptions;
/** Tarballs served by path besides the registry's, and each request for one. */
let files: Record<string, Uint8Array>;
let served: string[];
/** Documents served by path besides `nanoid`'s. */
let docs: Record<string, object>;
/** Paths answered 429 with a short Retry-After, as a registry too busy for them. */
let busy: Set<string>;
/** The `last-modified` every tarball is served with, or each by its path, when set. */
let lastModified: string | ((url: string) => string) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-api-"));
  lines = [];
  files = {};
  served = [];
  docs = {};
  busy = new Set();
  lastModified = undefined;
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const at = typeof lastModified === "function" ? lastModified(url) : lastModified;
    const dated = at ? { "last-modified": at } : {};
    if (Object.hasOwn(docs, url)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(docs[url]));
      return;
    }
    if (busy.has(url)) {
      served.push(url);
      response.writeHead(429, { "retry-after": "0.01" });
      response.end();
      return;
    }
    if (Object.hasOwn(files, url)) {
      served.push(url);
      response.writeHead(200, { "content-type": "application/octet-stream", ...dated });
      response.end(Buffer.from(files[url]!));
      return;
    }
    if (url === "/nanoid/-/nanoid-5.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream", ...dated });
      response.end(Buffer.from(tarball));
      return;
    }
    const manifest = {
      name: "nanoid",
      version: "5.0.0",
      dist: { tarball: `${registry()}/nanoid/-/nanoid-5.0.0.tgz`, integrity: hashOf(tarball) },
    };
    const body =
      url === "/nanoid"
        ? { name: "nanoid", "dist-tags": { latest: "5.0.0" }, versions: { "5.0.0": manifest } }
        : url === "/nanoid/5.0.0"
          ? manifest
          : undefined;
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "Not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = {
    dir,
    store: join(dir, "store"),
    registry: registry(),
    log: (line: string) => lines.push(line),
    experimental: { resolvePool: 0, linkPool: { size: 0 } },
  };
});

afterEach(async () => {
  vi.restoreAllMocks(); // a clock moved on must not age the next test's files
  await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
});

function registry(): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("api", () => {
  it("resolves and fetches specs", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    const [picked] = await upm.resolve(["nanoid@^5"], base);
    expect(picked).toMatchObject({ name: "nanoid", version: "5.0.0" });

    const [first] = await upm.fetchPackages(["nanoid"], base);
    expect(first).toMatchObject({ name: "nanoid", version: "5.0.0", cached: false, files: 1 });
    expect((await upm.fetchPackages(["nanoid"], base))[0]!.cached).toBe(true);
  });

  it("says which package.json fields that change the tree it does not apply", async () => {
    const manifest = {
      dependencies: { nanoid: "^5" },
      // Applied, but for the rule nested too deep for a package's one set of edges.
      overrides: { nanoid: "5.0.0", a: { b: { c: "1.0.0" } } },
      resolutions: {},
      pnpm: { overrides: { nanoid: "5.0.0" }, patchedDependencies: { a: "a.patch" } },
    };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    const said =
      "ignoring overrides.a.b, pnpm.patchedDependencies in package.json: upm does not apply them";
    await upm.install(base);
    expect(lines).toContain(said);
    // A no-op install read nothing new, so it says nothing new.
    lines.length = 0;
    expect(await upm.install(base)).toMatchObject({ upToDate: true });
    expect(lines).not.toContain(said);
    // A lockfile that still stands is no reason to be quiet about it.
    lines.length = 0;
    await upm.lock(base);
    expect(lines).toContain(said);
    await upm.install({ ...base, frozen: true, verify: true });
    expect(lines.filter((line) => line === said)).toHaveLength(2);
    // npm's lockfile was resolved with its overrides applied: nothing to say there.
    await rm(join(dir, "upm.lock"));
    const npm = { dependencies: manifest.dependencies, overrides: manifest.overrides };
    await writeFile(join(dir, "package.json"), JSON.stringify(npm));
    const nanoid = {
      version: "5.0.0",
      resolved: `${registry()}/nanoid/-/nanoid-5.0.0.tgz`,
      integrity: hashOf(tarball),
    };
    const packages = { "": npm, "node_modules/nanoid": nanoid };
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    lines.length = 0;
    await upm.install({ ...base, verify: true });
    expect(lines.filter((line) => line.startsWith("ignoring"))).toEqual([]);
  });

  it("resolves a workspace root on threads opened before the workspaces are read", async () => {
    const ws = (name: string) =>
      JSON.stringify({ name, version: "1.0.0", dependencies: { nanoid: "^5" } });
    await mkdir(join(dir, "packages", "a"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await writeFile(join(dir, "packages", "a", "package.json"), ws("a"));
    const threads = { ...base, experimental: { resolvePool: 1 } };
    const locked = await upm.lock(threads);
    expect(await upm.lock({ ...base, write: false })).toEqual(locked);
    await rm(join(dir, "upm.lock"));
    expect(await upm.install(threads)).toMatchObject({ packages: 1, workspaces: 1 });
    // A command that fails before its resolve closes them again, and says why it failed.
    await rm(join(dir, "upm.lock"));
    await rm(join(dir, "node_modules"), { recursive: true });
    await mkdir(join(dir, "packages", "b"), { recursive: true });
    await writeFile(join(dir, "packages", "b", "package.json"), ws("a"));
    for (const run of [upm.lock, upm.install]) {
      await expect(run(threads)).rejects.toMatchObject({ code: "EWORKSPACE" });
    }
  });

  it("installs through a store backend, which holds the package once the install returns", async () => {
    const data = new Map<string, Uint8Array>();
    const storeBackend: upm.StoreBackend = {
      get: async (key) => data.get(key),
      set: async (key, value) => void data.set(key, value),
    };
    const indexes = () => [...data.keys()].filter((key) => key.startsWith("index/"));
    await writeFile(join(dir, "package.json"), '{ "dependencies": { "nanoid": "^5" } }');
    await upm.install({ ...base, storeBackend });
    expect(indexes()).toHaveLength(1);

    // `fetchPackages` hands on what it downloads before it returns too.
    data.clear();
    await upm.fetchPackages(["nanoid"], { ...base, store: join(dir, "fetched"), storeBackend });
    expect(indexes()).toHaveLength(1);

    await rm(join(dir, "node_modules"), { recursive: true });
    let requested = 0;
    server.on("request", (request) => void (request.url?.endsWith(".tgz") && requested++));
    await upm.install({ ...base, store: join(dir, "other-store"), storeBackend, frozen: true });
    expect(requested).toBe(0);
    expect(await readFile(join(dir, "node_modules", "nanoid", "index.js"), "utf8")).toContain(
      "nanoid",
    );
  });

  it("fails a bad spec before any request is left running", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await expect(upm.resolve(["missing", "bad name@1"], base)).rejects.toMatchObject({
      code: "EINVALIDSPEC",
    });
    await expect(upm.fetchPackages(["missing", "bad name@1"], base)).rejects.toMatchObject({
      code: "EINVALIDSPEC",
    });
  });

  it("writes package.json through a rename, keeping its text, mode and link", async () => {
    await mkdir(join(dir, "real"));
    const raw = '{\n\t"name": "demo",\n\t"private": true\n}';
    await writeFile(join(dir, "real", "package.json"), raw, { mode: 0o640 });
    await chmod(join(dir, "real", "package.json"), 0o640);
    await symlink(join("real", "package.json"), join(dir, "package.json"));
    const { ino } = await stat(join(dir, "real", "package.json"));
    await upm.add(["nanoid"], base);
    // A new file renamed in: never the old one written over, which a crash would leave half.
    expect((await stat(join(dir, "real", "package.json"))).ino).not.toBe(ino);
    const text = await readFile(join(dir, "real", "package.json"), "utf8");
    expect(text).toBe(
      '{\n\t"name": "demo",\n\t"private": true,\n\t"dependencies": {\n\t\t"nanoid": "^5.0.0"\n\t}\n}',
    );
    expect((await lstat(join(dir, "package.json"))).isSymbolicLink()).toBe(true);
    // Windows keeps no POSIX mode bits to compare.
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "real", "package.json"))).mode & 0o777).toBe(0o640);
    }
    expect(await readdir(join(dir, "real"))).toEqual(["package.json"]);
  });

  it("sweeps a lockfile temp a dead run left, once it is an hour old", async () => {
    await writeFile(join(dir, "package.json"), '{"dependencies":{"nanoid":"^5.0.0"}}');
    const dead = 2 ** 22 + 1; // past any pid_max
    const hourAgo = new Date(Date.now() - 61 * 60 * 1000);
    const [old, young, live, other] = [
      `upm.lock.${dead}-a.tmp`,
      `upm.lock.${dead}-b.tmp`,
      `upm.lock.${process.pid}-c.tmp`,
      `other.${dead}-d.tmp`,
    ];
    for (const name of [old, young, live, other]) {
      await writeFile(join(dir, name), "{");
      if (name !== young) await utimes(join(dir, name), hourAgo, hourAgo);
    }
    await upm.install(base);
    const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(left.sort()).toEqual([young!, live!, other!].sort());
  });

  it("adds, installs, locks, fetches the lock, dedupes, removes and prunes", async () => {
    await writeFile(join(dir, "package.json"), '{\n  "name": "demo"\n}\n');
    const added = await upm.add(["nanoid"], { ...base, group: "devDependencies" });
    expect(added.added).toEqual([{ name: "nanoid", range: "^5.0.0", group: "devDependencies" }]);
    expect(added).toMatchObject({ packages: 1, upToDate: false });
    expect((await readJson(join(dir, "package.json"))).devDependencies).toEqual({
      nanoid: "^5.0.0",
    });
    expect(await readFile(join(dir, "node_modules", "nanoid", "index.js"), "utf8")).toContain(
      "nanoid",
    );
    expect(lines).toContain("+ nanoid@^5.0.0 in devDependencies");

    const again = await upm.install({ ...base, frozen: true });
    expect(again).toMatchObject({ packages: 1, upToDate: true });
    expect((await upm.install({ ...base, production: true })).packages).toBe(0);

    const locked = await upm.lock(base);
    expect(Object.keys(locked.packages)).toEqual(["nanoid@5.0.0"]);
    expect(parseLockfile(await readFile(join(dir, "upm.lock"), "utf8"))).toEqual(locked);

    const fetched = await upm.fetchLockfile(base);
    expect(fetched).toMatchObject([{ name: "nanoid", version: "5.0.0", cached: true }]);
    expect(await upm.fetchLockfile({ ...base, production: true })).toEqual([]);

    expect((await upm.dedupe(base)).packages).toBe(1);

    const removed = await upm.remove(["nanoid"], base);
    expect(removed.removed).toEqual(["nanoid"]);
    expect(await readJson(join(dir, "package.json"))).toEqual({ name: "demo" });
    await expect(stat(join(dir, "node_modules", "nanoid"))).rejects.toThrow();
    await expect(upm.remove(["nanoid"], base)).rejects.toMatchObject({ code: "ENODEP" });

    const pruned = await upm.prune(base);
    expect(pruned.entries).toBeDefined();
    expect(pruned.content).toMatchObject({ files: 0, packages: 0 });
  });

  it("finds a tree up to date off the inputs alone, and not once one of them moves", async () => {
    await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"^5"}}');
    const first = await upm.install(base);
    expect(first).toMatchObject({ packages: 1, upToDate: false });
    const stateFile = join(dir, "node_modules", ".upm.json");
    const state = await readJson(stateFile);
    expect(state).toMatchObject({
      version: 1,
      inputs: expect.any(String),
      summary: { packages: 1, otherPlatforms: 0, warnings: [] },
      root: { links: { nanoid: expect.stringContaining(".upm") }, bins: [] },
    });

    // The same bytes again: up to date, reported as before, and the graph never read. The
    // file was written again, so its stamps are new; the rest of the state is not.
    const lock = await readFile(join(dir, "upm.lock"), "utf8");
    await writeFile(join(dir, "upm.lock"), `${lock.trimEnd()}\n`); // the same bytes
    const again = await upm.install(base);
    expect(again).toMatchObject({ packages: 1, upToDate: true, stats: { reused: 1 } });
    const { stamps, ...rest } = await readJson(stateFile);
    const { stamps: before, ...was } = state;
    expect(rest).toEqual(was);
    expect(stamps.lock).not.toEqual(before.lock);
    expect(stamps.manifest).toEqual(before.manifest);
    // Untouched since: neither file is read or hashed, and the state is not written.
    expect((await upm.install(base)).upToDate).toBe(true);
    expect(await readJson(stateFile)).toEqual({ ...rest, stamps });

    // A link gone: the inputs still match, the tree does not.
    await rm(join(dir, "node_modules", "nanoid"));
    expect((await upm.install(base)).upToDate).toBe(false);
    expect(await readFile(join(dir, "node_modules", "nanoid", "index.js"), "utf8")).toContain(
      "nanoid",
    );

    // The lockfile's bytes changed, if only in spacing: the slow path, which reads it.
    await writeFile(join(dir, "upm.lock"), `${lock}\n`);
    expect((await upm.install(base)).upToDate).toBe(true);
    expect((await readJson(stateFile)).inputs).not.toBe(state.inputs);

    // Another setting: another tree.
    expect((await upm.install({ ...base, production: true })).upToDate).toBe(false);
    expect((await upm.install({ ...base, production: true })).upToDate).toBe(true);
    expect((await upm.install(base)).upToDate).toBe(false);

    // A manifest edit that changes nothing the lockfile depends on still takes the slow path,
    // and finds the tree up to date there.
    await writeFile(
      join(dir, "package.json"),
      '{"name":"demo","description":"x","dependencies":{"nanoid":"^5"}}',
    );
    expect((await upm.install(base)).upToDate).toBe(true);
  });

  it("does not find a tree up to date off the inputs once a direct package's dir is gone", async () => {
    await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    expect((await upm.install(base)).upToDate).toBe(true);
    // The top link still reads the same; only the package dir inside its entry is gone.
    const at = join(dir, "node_modules", "nanoid");
    await rm(await realpath(at), { recursive: true });

    expect((await upm.install(base)).upToDate).toBe(false);
    expect(await readFile(join(at, "index.js"), "utf8")).toContain("nanoid");
    expect((await upm.install(base)).upToDate).toBe(true);
  });

  it("finds a workspace tree up to date without a glob, and never once a workspace moves", async () => {
    const root = { name: "root", workspaces: ["packages/*"], dependencies: { a: "*" } };
    await writeFile(join(dir, "package.json"), JSON.stringify(root));
    const ws = async (name: string, manifest: object) => {
      await mkdir(join(dir, "packages", name), { recursive: true });
      await writeFile(join(dir, "packages", name, "package.json"), JSON.stringify(manifest));
    };
    await ws("a", { name: "a", version: "1.0.0", dependencies: { nanoid: "^5" } });
    await ws("b", { name: "b", version: "1.0.0", dependencies: { a: "workspace:*" } });
    // Every stamp here is fresh, which the real clock would not trust: it is moved on, and
    // each change waits out the timestamp's tick instead (30 ms: not enough where a tick is 1 s).
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + 60_000);
    const tick = () => new Promise((done) => setTimeout(done, 30));
    const glob = vi.spyOn(process.getBuiltinModule("node:fs/promises"), "glob").mock;
    const stateFile = join(dir, "node_modules", ".upm.json");
    const locked = async () =>
      Object.keys(parseLockfile(await readFile(lockFile(), "utf8")).workspaces!);
    const lockFile = () => join(dir, "upm.lock");

    expect(await upm.install(base)).toMatchObject({ workspaces: 2, upToDate: false });
    expect(await readJson(stateFile)).toMatchObject({
      inputs: expect.any(String),
      tops: {
        "packages/a": { links: { nanoid: expect.stringContaining(".upm") }, bins: [] },
        // As `relative` spells it, with `\` on Windows.
        "packages/b": { links: { a: join("..", "..", "a") }, bins: [] },
      },
      workspaces: { paths: ["packages/a", "packages/b"] },
    });
    expect(glob.calls).toHaveLength(1);
    await tick();
    expect(await upm.install(base)).toMatchObject({ packages: 1, workspaces: 2, upToDate: true });
    expect(glob.calls).toHaveLength(1);
    // Settled now: a no-op reads the state and writes nothing back.
    const written = await stat(stateFile);
    expect((await upm.install(base)).upToDate).toBe(true);
    expect(await stat(stateFile)).toMatchObject({ ino: written.ino, mtimeMs: written.mtimeMs });

    // A workspace's link gone: the inputs still match, the tree does not.
    await rm(join(dir, "packages", "a", "node_modules", "nanoid"));
    expect((await upm.install(base)).upToDate).toBe(false);
    expect(await readFile(join(dir, "packages/a/node_modules/nanoid/index.js"), "utf8")).toContain(
      "nanoid",
    );
    expect(glob.calls).toHaveLength(1);

    // A workspace's package.json edited, its ranges unchanged: read and hashed, not globbed,
    // and found up to date. A range moved: a new lockfile.
    await tick();
    await ws("a", {
      name: "a",
      version: "1.0.0",
      description: "x",
      dependencies: { nanoid: "^5" },
    });
    expect((await upm.install(base)).upToDate).toBe(true);
    await tick();
    await ws("a", { name: "a", version: "1.0.0", dependencies: { nanoid: "5.0.0" } });
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
    expect((await upm.install(base)).upToDate).toBe(true);
    expect(await readFile(lockFile(), "utf8")).toContain('"nanoid": "5.0.0"');
    expect(glob.calls).toHaveLength(1);

    // Added, renamed, removed: each is a new lockfile, never a no-op, and stale when frozen.
    const moves: [() => Promise<unknown>, string[]][] = [
      [() => ws("c", { name: "c", version: "1.0.0" }), ["packages/a", "packages/b", "packages/c"]],
      [
        () => rename(join(dir, "packages", "b"), join(dir, "packages", "d")),
        ["packages/a", "packages/c", "packages/d"],
      ],
      [() => rm(join(dir, "packages", "c"), { recursive: true }), ["packages/a", "packages/d"]],
    ];
    for (const [move, paths] of moves) {
      await tick();
      await move();
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
      expect(await upm.install(base)).toMatchObject({ workspaces: paths.length, upToDate: false });
      expect(await locked()).toEqual(paths);
      expect((await readJson(stateFile)).workspaces.paths).toEqual(paths);
    }
  });

  it("names the store it used in the inputs, defaults included, whatever the cwd", async () => {
    await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"^5"}}');
    const { store: _store, ...noStore } = base;
    const stateFile = join(dir, "node_modules", ".upm.json");
    const cwd = process.cwd();
    const env = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      UPM_STORE: process.env.UPM_STORE,
    };
    delete process.env.UPM_STORE;
    process.env.HOME = join(dir, "home-a"); // `~/.upm/store`, the last default
    process.env.USERPROFILE = join(dir, "home-a"); // os.homedir() on Windows
    try {
      await upm.install(noStore);
      const state = await readJson(stateFile);
      expect(state.store).toBe(join(dir, "home-a", ".upm", "store"));
      // The default store spelled from another cwd is the same store: the fast path holds and
      // the state is not written again.
      process.chdir(join(dir, "node_modules"));
      expect((await upm.install(noStore)).upToDate).toBe(true);
      expect(await readJson(stateFile)).toEqual(state);
      // Another default store is another input: what it holds is not this tree's content.
      process.env.UPM_STORE = join(dir, "store-b");
      const moved = await upm.install(noStore);
      expect(moved.upToDate).toBe(false);
      expect((await readJson(stateFile)).store).toBe(join(dir, "store-b"));
    } finally {
      process.chdir(cwd);
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("writes no lockfile when asked not to", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    const lock = await upm.lock({ ...base, write: false });
    expect(lock.root.dependencies).toEqual({ nanoid: "5.0.0" });
    await expect(stat(join(dir, "upm.lock"))).rejects.toThrow();
  });

  it("installs offline from the lockfile, the store and kept documents, and fails fast on more", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    await upm.install(base);
    const nm = join(dir, "node_modules");
    await rm(nm, { recursive: true });
    const offline = { ...base, offline: true };
    expect(await upm.install(offline)).toMatchObject({ packages: 1, upToDate: false });
    expect(await readFile(join(nm, "nanoid", "index.js"), "utf8")).toContain("nanoid");

    // Nothing in this store, and no registry to ask for the new name.
    const fresh = { ...offline, store: join(dir, "fresh") };
    await rm(nm, { recursive: true });
    await expect(upm.install(fresh)).rejects.toMatchObject({ code: "EOFFLINE" });
    await expect(upm.add(["left-pad"], offline)).rejects.toMatchObject({ code: "EOFFLINE" });
    expect((await readJson(join(dir, "package.json"))).dependencies).toEqual({ nanoid: "^5" });
    // The install above kept nanoid's document beside the store.
    expect(await upm.resolve(["nanoid"], offline)).toMatchObject([{ version: "5.0.0" }]);
    await expect(upm.resolve(["nanoid"], fresh)).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("repairs same-size damage under verify, in the store and in the tree", async () => {
    await writeFile(join(dir, "package.json"), '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    const file = join(dir, "node_modules", "nanoid", "index.js");
    const good = await readFile(file, "utf8");
    const bad = good.toUpperCase();

    // Through the link: the store's inode, so the store's content too. A fresh tree built
    // without verify believes it.
    await chmod(file, 0o644);
    await writeFile(file, bad);
    await rm(join(dir, "node_modules"), { recursive: true });
    await upm.install(base);
    expect(await readFile(file, "utf8")).toBe(bad);
    expect(await upm.install({ ...base, verify: true })).toMatchObject({ upToDate: false });
    expect(await readFile(file, "utf8")).toBe(good);

    // Renamed over the link, with the old times: the store never saw it, and only reading
    // the file tells.
    const other = `${file}.new`;
    await writeFile(other, bad);
    const { atime, mtime } = await stat(file);
    await utimes(other, atime, mtime);
    // Windows refuses to rename over the read-only link the repair placed.
    await chmod(file, 0o644);
    await rename(other, file);
    expect((await upm.install(base)).upToDate).toBe(true);
    expect(await upm.install({ ...base, verify: true })).toMatchObject({ upToDate: false });
    expect(await readFile(file, "utf8")).toBe(good);
    expect((await upm.install({ ...base, verify: true })).upToDate).toBe(false);
    expect((await upm.install(base)).upToDate).toBe(true);
  });

  describe("a registry package locked to another host", () => {
    let other: Server;
    /** What the other host serves, by path, and each path it was asked for. */
    let at: Record<string, Uint8Array>;
    let asked: string[];
    beforeEach(async () => {
      at = {};
      asked = [];
      other = createServer((request, response) => {
        const url = request.url ?? "";
        asked.push(url);
        const found = Object.hasOwn(at, url) ? at[url] : undefined;
        response.writeHead(found ? 200 : 404, { "content-type": "application/octet-stream" });
        response.end(found ? Buffer.from(found) : undefined);
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    });
    afterEach(() => new Promise((done) => other.close(done)));
    /** Another port is another host: the registry's url never matches it. */
    const host = () => `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const evil = makeTarball([{ path: "index.js", data: 'module.exports = "evil";\n' }]);
    const lockFile = () => join(dir, "upm.lock");
    const index = () => join(dir, "node_modules", "nanoid", "index.js");

    /** nanoid installed from the registry, then its lock entry moved to `url` and `integrity`. */
    async function relock(key: string, url: string, integrity: string) {
      const lock = await readJson(lockFile());
      lock.packages[key] = { ...lock.packages[key], resolved: url, integrity };
      await writeFile(lockFile(), JSON.stringify(lock));
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
    }

    beforeEach(async () => {
      await writeFile(join(dir, "package.json"), '{"dependencies":{"nanoid":"^5"}}');
    });

    it("is refused when its integrity is not the registry's, frozen or not", async () => {
      await upm.install(base);
      at["/nanoid.tgz"] = evil;
      await relock("nanoid@5.0.0", `${host()}/nanoid.tgz`, hashOf(evil));
      lines = [];
      const refused = { code: "ELOCK", message: expect.stringContaining("not the one at") };
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject(refused);
      await expect(upm.install(base)).rejects.toMatchObject(refused);
      await expect(upm.fetchLockfile(base)).rejects.toMatchObject(refused);
      // A stale lockfile replays the entry in the walk: its prefetch must not ask either.
      const manifest = {
        dependencies: { nanoid: "^5" },
        devDependencies: { nanoid2: "npm:nanoid@^5" },
      };
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await expect(upm.install(base)).rejects.toMatchObject(refused);
      expect(asked).toEqual([]);
      await expect(stat(index())).rejects.toThrow();
    });

    it("is refused when the store already holds those bytes", async () => {
      await upm.install(base);
      at["/nanoid.tgz"] = evil;
      const store = createStore({ dir: base.store });
      const { integrity } = await store.adopt(`${host()}/nanoid.tgz`);
      await store.flush();
      store.close();
      await relock("nanoid@5.0.0", `${host()}/nanoid.tgz`, integrity);
      asked = [];
      // Offline: no byte could be fetched, and nanoid's kept document says what it should be.
      const offline = { ...base, frozen: true, offline: true };
      await expect(upm.install(offline)).rejects.toMatchObject({ code: "ELOCK" });
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
      expect(asked).toEqual([]);
      await expect(stat(index())).rejects.toThrow();
    });

    it("installs from a mirror that serves the registry's bytes, offline only from kept documents", async () => {
      await upm.install(base);
      const good = hashOf(tarball);
      at["/mirror/nanoid-5.0.0.tgz"] = tarball;
      await relock("nanoid@5.0.0", `${host()}/mirror/nanoid-5.0.0.tgz`, good);
      const fresh = { ...base, store: join(dir, "fresh"), frozen: true };
      expect(await upm.install(fresh)).toMatchObject({ packages: 1, upToDate: false });
      expect(asked).toEqual(["/mirror/nanoid-5.0.0.tgz"]);
      expect(await readFile(index(), "utf8")).toContain("nanoid");
      // Offline, the kept document answers.
      await rm(join(dir, "node_modules"), { recursive: true });
      expect(await upm.install({ ...fresh, offline: true })).toMatchObject({ packages: 1 });
      // Without it, the bytes in the store are not enough: nothing says they are the registry's.
      await rm(join(dir, "node_modules"), { recursive: true });
      await rm(join(fresh.store, "metadata"), { recursive: true });
      await expect(upm.install({ ...fresh, offline: true })).rejects.toMatchObject({
        code: "EOFFLINE",
        message: expect.stringContaining("locked to"),
      });
      await expect(stat(index())).rejects.toThrow();
    });

    it("is held to the registry its scope is read from", async () => {
      const name = "@acme/pkg";
      const scoped = `${registry()}/acme`;
      const own = makeTarball([{ path: "index.js", data: 'module.exports = "acme";\n' }]);
      const packument = (data: Uint8Array, base: string) => ({
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            dist: { tarball: `${base}/${name}/-/pkg-1.0.0.tgz`, integrity: hashOf(data) },
          },
        },
      });
      docs["/acme/@acme%2fpkg"] = packument(own, scoped);
      files["/acme/@acme/pkg/-/pkg-1.0.0.tgz"] = own;
      // The default registry has another tarball under the name: it must not be the one asked.
      docs["/@acme%2fpkg"] = packument(evil, registry());
      await writeFile(join(dir, ".npmrc"), `@acme:registry=${scoped}/\n`);
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { [name]: "^1" } }),
      );
      await upm.install(base);
      at["/evil.tgz"] = evil;
      at["/own.tgz"] = own;
      const fresh = { ...base, store: join(dir, "fresh"), frozen: true };
      await relock(`${name}@1.0.0`, `${host()}/evil.tgz`, hashOf(evil));
      await expect(upm.install(fresh)).rejects.toMatchObject({ code: "ELOCK" });
      await relock(`${name}@1.0.0`, `${host()}/own.tgz`, hashOf(own));
      expect(await upm.install(fresh)).toMatchObject({ packages: 1 });
      expect(asked).toEqual(["/own.tgz"]);
      const installed = join(dir, "node_modules", "@acme", "pkg", "index.js");
      expect(await readFile(installed, "utf8")).toContain("acme");
      // Without the scope's registry, nothing vouches for it.
      delete docs["/@acme%2fpkg"];
      await rm(join(dir, ".npmrc"));
      await rm(join(dir, "node_modules"), { recursive: true });
      await expect(upm.install(fresh)).rejects.toMatchObject({
        code: "ELOCK",
        message: expect.stringContaining("name its registry in .npmrc"),
      });
    });

    it("takes a sha1 only where the registry publishes nothing stronger", async () => {
      const old = makeTarball([{ path: "index.js", data: 'module.exports = "old";\n' }]);
      const shasum = createHash("sha1").update(old).digest("hex");
      const dist = { tarball: `${registry()}/old/-/old-1.0.0.tgz`, shasum };
      const versions = { "1.0.0": { name: "old", version: "1.0.0", dist } };
      docs["/old"] = { name: "old", "dist-tags": { latest: "1.0.0" }, versions };
      files["/old/-/old-1.0.0.tgz"] = old;
      at["/old.tgz"] = old;
      await writeFile(join(dir, "package.json"), '{"dependencies":{"old":"^1"}}');
      await upm.install(base);
      const sha1 = (await readJson(lockFile())).packages["old@1.0.0"].integrity;
      expect(sha1).toMatch(/^sha1-/);
      const fresh = { ...base, store: join(dir, "fresh"), frozen: true };
      // The same bytes by a hash the registry never published: nothing to hold it to.
      await relock("old@1.0.0", `${host()}/old.tgz`, hashOf(old));
      await expect(upm.install(fresh)).rejects.toMatchObject({ code: "ELOCK" });
      await relock("old@1.0.0", `${host()}/old.tgz`, sha1);
      expect(await upm.install(fresh)).toMatchObject({ packages: 1 });
      expect(asked).toEqual(["/old.tgz"]);
    });

    it("asks nothing for a url on its registry's host", async () => {
      await upm.install(base);
      await relock("nanoid@5.0.0", `${registry()}/nanoid/-/nanoid-5.0.0.tgz?odd`, hashOf(tarball));
      await rm(join(base.store!, "metadata"), { recursive: true });
      await upm.install({ ...base, frozen: true, offline: true });
      expect(await readFile(index(), "utf8")).toContain("nanoid");
    });

    it("is held to the registry when its url there is another package's tarball", async () => {
      await upm.install(base);
      // Published as evil, it says it is nanoid: nothing at the registry checks that.
      const confused = makeTarball([
        { path: "package.json", data: '{"name":"nanoid","version":"5.0.0"}' },
        { path: "index.js", data: 'module.exports = "evil";\n' },
      ]);
      files["/evil/-/evil-1.0.0.tgz"] = confused;
      await relock("nanoid@5.0.0", `${registry()}/evil/-/evil-1.0.0.tgz`, hashOf(confused));
      const fresh = { ...base, store: join(dir, "fresh") };
      for (const options of [fresh, { ...fresh, frozen: true }]) {
        await expect(upm.install(options)).rejects.toMatchObject({
          code: "ELOCK",
          message: expect.stringContaining("its integrity is not the one at"),
        });
      }
      await expect(stat(index())).rejects.toThrow();
    });
  });

  it("warns once when the registry gives no publish dates for the release age", async () => {
    // This registry's document has neither `modified` nor `time`.
    const told = `${registry()} gives no publish dates: min-release-age holds nothing back from it`;
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    await upm.lock(base);
    expect(lines.filter((line) => line === told)).toHaveLength(1);
    await rm(join(dir, "upm.lock"));
    lines = [];
    await upm.lock({ ...base, minReleaseAge: 0 });
    expect(lines).toEqual(["wrote upm.lock · 1 pkgs"]);
  });

  it("fails an offline install missing an optional, rather than skip it", async () => {
    const optionalDependencies = { nanoid: "^5" };
    await writeFile(join(dir, "package.json"), JSON.stringify({ optionalDependencies }));
    await upm.lock(base);
    const fresh = { ...base, store: join(dir, "fresh"), offline: true };
    await expect(upm.install(fresh)).rejects.toMatchObject({ code: "EOFFLINE" });
    // Online, the same store is filled.
    expect(await upm.install({ ...fresh, offline: false })).toMatchObject({ packages: 1 });
  });

  /** A packument served beside nanoid's, for each version the tarball its integrity names. */
  const serve = (name: string, versions: Record<string, Uint8Array>, integrity = hashOf) => {
    const manifests = Object.fromEntries(
      Object.entries(versions).map(([version, data]) => {
        const path = `/${name}/-/${name}-${version}.tgz`;
        files[path] = data;
        const dist = { tarball: `${registry()}${path}`, integrity: integrity(data) };
        return [version, { name, version, dist }];
      }),
    );
    const latest = Object.keys(versions).at(-1)!;
    const packument = { name, "dist-tags": { latest }, versions: manifests };
    files[`/${name}`] = Buffer.from(JSON.stringify(packument));
  };

  it("resolves again from a lockfile that pins a version its range does not allow", async () => {
    const four = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid 4";\n' }]);
    serve("nanoid", { "4.0.0": four, "5.0.0": tarball });
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^4" } }));
    await upm.install(base);
    // As a hand edit or a bad merge leaves it: a whole, valid lockfile, 5.0.0 under `^4`.
    const lockFile = join(dir, "upm.lock");
    const edited = await readJson(lockFile);
    edited.root.dependencies.nanoid = "5.0.0";
    edited.packages = { "nanoid@5.0.0": { integrity: hashOf(tarball) } };
    await writeFile(lockFile, JSON.stringify(edited, undefined, 2));
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
    await rm(join(dir, "node_modules"), { recursive: true });
    await upm.install(base);
    expect((await readJson(lockFile)).root.dependencies).toEqual({ nanoid: "4.0.0" });
    const installed = join(dir, "node_modules", "nanoid", "index.js");
    expect(await readFile(installed, "utf8")).toContain("nanoid 4");
  });

  it("links what the overrides pick, and resolves again when they change", async () => {
    const four = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid 4";\n' }]);
    serve("nanoid", { "4.0.0": four, "5.0.0": tarball });
    const dependencies = { nanoid: "^4" };
    const json = JSON.stringify({ name: "wrap", version: "1.0.0", dependencies });
    serve("wrap", { "1.0.0": makeTarball([{ path: "package.json", data: json }]) });
    const doc = JSON.parse(Buffer.from(files["/wrap"]!).toString());
    doc.versions["1.0.0"].dependencies = dependencies;
    files["/wrap"] = Buffer.from(JSON.stringify(doc));
    const manifest = (overrides: object) =>
      writeFile(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { wrap: "^1" }, overrides }),
      );
    // What wrap's own `require("nanoid")` finds.
    const nanoid = async () => {
      const wrap = await realpath(join(dir, "node_modules", "wrap"));
      return await readFile(join(wrap, "..", "nanoid", "index.js"), "utf8");
    };

    await manifest({ nanoid: "5.0.0" });
    await upm.install(base);
    const lockFile = join(dir, "upm.lock");
    const locked = await readJson(lockFile);
    expect(locked.root.overrides).toEqual({ nanoid: "5.0.0" });
    expect(locked.packages["wrap@1.0.0"].dependencies).toEqual({ nanoid: "5.0.0" });
    expect(await nanoid()).toContain("nanoid");
    expect(await nanoid()).not.toContain("nanoid 4");

    await manifest({});
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
    await upm.install(base);
    expect((await readJson(lockFile)).root.overrides).toBeUndefined();
    expect(await nanoid()).toContain("nanoid 4");
  });

  it("reads the overrides of pnpm-workspace.yaml, and sees it change", async () => {
    const four = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid 4";\n' }]);
    serve("nanoid", { "4.0.0": four, "5.0.0": tarball });
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    const yaml = join(dir, "pnpm-workspace.yaml");
    await writeFile(yaml, "packages:\n- .\noverrides:\n  nanoid: 4.0.0 # pinned\n");
    await upm.install(base);
    const lockFile = join(dir, "upm.lock");
    expect((await readJson(lockFile)).root).toMatchObject({
      overrides: { nanoid: "4.0.0" },
      dependencies: { nanoid: "4.0.0" },
    });
    const installed = join(dir, "node_modules", "nanoid", "index.js");
    expect(await readFile(installed, "utf8")).toContain("nanoid 4");
    expect(await upm.install(base)).toMatchObject({ upToDate: true });
    // Only the yaml moves: no longer a no-op, and no longer a lockfile to install frozen.
    await writeFile(yaml, "packages:\n- .\n");
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
    expect(await upm.install(base)).toMatchObject({ upToDate: false });
    expect((await readJson(lockFile)).root.overrides).toBeUndefined();
    expect(await readFile(installed, "utf8")).not.toContain("nanoid 4");
    // And back, so a yaml that gains its overrides is seen too.
    await writeFile(yaml, "overrides:\n  nanoid: 4.0.0\n");
    expect(await upm.install(base)).toMatchObject({ upToDate: false });
    expect(await readFile(installed, "utf8")).toContain("nanoid 4");
  });

  it("overrides a workspace's own dependency, and installs frozen from that lock", async () => {
    const four = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid 4";\n' }]);
    serve("nanoid", { "4.0.0": four, "5.0.0": tarball });
    const root = { workspaces: ["packages/*"], overrides: { nanoid: "5.0.0" } };
    await writeFile(join(dir, "package.json"), JSON.stringify(root));
    const at = join(dir, "packages", "a");
    await mkdir(at, { recursive: true });
    const ws = { name: "a", version: "1.0.0", dependencies: { nanoid: "^4" } };
    await writeFile(join(at, "package.json"), JSON.stringify(ws));
    await upm.install(base);
    const lockFile = join(dir, "upm.lock");
    expect((await readJson(lockFile)).workspaces["packages/a"].dependencies).toEqual({
      nanoid: "5.0.0",
    });
    const installed = join(at, "node_modules", "nanoid", "index.js");
    expect(await readFile(installed, "utf8")).not.toContain("nanoid 4");
    // A pin outside the workspace's own range is the override's, not a stale lock.
    await rm(join(dir, "node_modules"), { recursive: true });
    await rm(join(at, "node_modules"), { recursive: true });
    await upm.install({ ...base, frozen: true });
    expect(await readFile(installed, "utf8")).not.toContain("nanoid 4");
  });

  it("keeps no lockfile from an install whose tarball failed its integrity", async () => {
    const other = makeTarball([{ path: "index.js", data: "other\n" }]);
    serve("bad", { "1.0.0": tarball }, () => hashOf(other));
    const lockFile = join(dir, "upm.lock");
    const manifest = (dependencies: Record<string, string>) =>
      writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
    await manifest({ bad: "^1" });
    await expect(upm.install(base)).rejects.toMatchObject({ code: "EINTEGRITY" });
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });

    // Over a lockfile, the one before stays, byte for byte, whichever command resolved.
    await manifest({ nanoid: "^5" });
    await upm.install(base);
    const before = await readFile(lockFile, "utf8");
    await manifest({ nanoid: "^5", bad: "^1" });
    await expect(upm.install(base)).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await readFile(lockFile, "utf8")).toBe(before);
    await manifest({ nanoid: "^5" });
    await expect(upm.add(["bad"], base)).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await readFile(lockFile, "utf8")).toBe(before);
    // Put right, the next install goes on from it.
    await manifest({ nanoid: "^5" });
    expect(await upm.install({ ...base, frozen: true })).toMatchObject({ packages: 1 });

    // A lockfile another install wrote meanwhile is that install's: it stays.
    await manifest({ nanoid: "^5", bad: "^1" });
    const theirs = `${before}\n`;
    const log = (message: string) => {
      if (message.startsWith("wrote upm.lock")) writeFileSync(lockFile, theirs);
    };
    await expect(upm.install({ ...base, log })).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await readFile(lockFile, "utf8")).toBe(theirs);
    await rm(lockFile);
    await expect(upm.install({ ...base, log })).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await readFile(lockFile, "utf8")).toBe(theirs);
  });

  it("fetches a package again when its blobs lost their bytes under a standing index", async () => {
    await writeFile(join(dir, "package.json"), '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    const file = join(dir, "node_modules", "nanoid", "index.js");
    const text = await readFile(file, "utf8");
    // As power lost before the page cache reached the disk leaves it: the index written, the
    // blob empty, and the entry hardlinked to that same empty blob.
    await chmod(file, 0o644);
    await truncate(file, 0);
    await rm(join(dir, "node_modules", ".upm.json"));
    const requests: string[] = [];
    server.on("request", (request) => void requests.push(request.url ?? ""));
    const fetches = () => requests.filter((url) => url.endsWith(".tgz")).length;

    expect(await upm.install(base)).toMatchObject({ upToDate: false });
    expect(await readFile(file, "utf8")).toBe(text);
    expect(fetches()).toBe(1);
    // Healed in the store too, so the next full link needs nothing from the network.
    await rm(join(dir, "node_modules"), { recursive: true });
    await upm.install(base);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(fetches()).toBe(1);
  });

  it("waits for another install of the tree only when the tree must change", async () => {
    await writeFile(join(dir, "package.json"), '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    const other = await holdTree(join(dir, "node_modules"), () => {});
    // Standing: nothing to change, so nothing to wait for.
    expect(await upm.install(base)).toMatchObject({ upToDate: true });

    const top = join(dir, "node_modules", "nanoid");
    const target = await readlink(top);
    await rm(top);
    let done = false;
    const waiting = upm.install(base).then((result) => ((done = true), result));
    await vi.waitFor(() => expect(lines).toContain(`waiting for another install of ${dir}`), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    // What the other install did while this one waited: the very tree this one wants.
    await symlink(target, top, "junction"); // as upm links it on Windows
    await other();
    expect(await waiting).toMatchObject({ upToDate: true });
    expect(await readdir(join(dir, "node_modules"))).not.toContain(TREE_HELD);
  });

  it.each([
    ["the lockfile and package.json", true, true],
    ["package.json", false, true],
    ["the lockfile", true, false],
  ])("takes no stamp of %s another command wrote while it installed", async (_, lockToo, back) => {
    serve("other", { "1.0.0": makeTarball([{ path: "index.js", data: "other\n" }]) });
    const lockFile = join(dir, "upm.lock");
    const manifestFile = join(dir, "package.json");
    await writeFile(manifestFile, '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    const lock = await readFile(lockFile, "utf8");
    // Another command puts the files back as they were once this install has read them.
    const log = (message: string) => {
      if (!message.startsWith("wrote upm.lock")) return;
      if (lockToo) writeFileSync(lockFile, lock);
      if (back) writeFileSync(manifestFile, '{"dependencies":{"nanoid":"^5"}}');
    };
    await writeFile(manifestFile, '{"dependencies":{"nanoid":"^5","other":"^1"}}');
    await upm.install({ ...base, log });
    expect(await readdir(join(dir, "node_modules"))).toContain("other");
    // The tree's copy is the lockfile it was linked from, not the one there now.
    expect(await readFile(join(dir, "node_modules", ".upm.lock"), "utf8")).toContain("other@");
    // The tree is of what this install read; the files now are the other command's, so the
    // next install reads them. A lockfile put back alone is resolved again onto the same tree.
    expect(await upm.install(base)).toMatchObject({ upToDate: !back });
    expect((await readdir(join(dir, "node_modules"))).includes("other")).toBe(!back);
    expect((await readFile(lockFile, "utf8")).includes("other@")).toBe(!back);
    expect(await upm.install(base)).toMatchObject({ upToDate: true });
  });

  it("takes no stamp of a package.json written as a no-op install read it", async () => {
    serve("other", { "1.0.0": makeTarball([{ path: "index.js", data: "other\n" }]) });
    const manifestFile = join(dir, "package.json");
    await writeFile(manifestFile, '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    // The lockfile comes back from the tree after package.json is read, before it is stamped.
    await rm(join(dir, "upm.lock"));
    const log = (message: string) => {
      if (message.startsWith("wrote upm.lock")) {
        writeFileSync(manifestFile, '{"dependencies":{"nanoid":"^5","other":"^1"}}');
      }
    };
    expect(await upm.install({ ...base, log })).toMatchObject({ upToDate: true });
    expect(await upm.install(base)).toMatchObject({ upToDate: false });
    expect(await readdir(join(dir, "node_modules"))).toContain("other");
  });

  it("adds again onto a package.json another command wrote while it resolved", async () => {
    serve("other", { "1.0.0": makeTarball([{ path: "index.js", data: "other\n" }]) });
    serve("third", { "1.0.0": makeTarball([{ path: "index.js", data: "third\n" }]) });
    const manifestFile = join(dir, "package.json");
    await writeFile(manifestFile, '{"dependencies":{"nanoid":"^5"}}');
    await upm.install(base);
    // As another `add` that finished first leaves it.
    let edit: (() => string) | undefined = () => (
      (edit = undefined),
      '{"dependencies":{"nanoid":"^5","third":"^1"}}'
    );
    const log = (message: string) => {
      lines.push(message);
      if (message.startsWith("wrote upm.lock") && edit) writeFileSync(manifestFile, edit());
    };
    await upm.add(["other"], { ...base, log });
    expect(lines).toContain("package.json changed meanwhile: editing it again");
    expect(Object.keys((await readJson(manifestFile)).dependencies)).toEqual([
      "nanoid",
      "other",
      "third",
    ]);
    expect(await readdir(join(dir, "node_modules"))).toEqual(
      expect.arrayContaining(["nanoid", "other", "third"]),
    );
    expect(await readdir(dir)).not.toContain(".upm.editing");
    expect(await upm.install(base)).toMatchObject({ upToDate: true });

    // One that never stops changing is given up on, with the lockfile as it was.
    const lock = await readFile(join(dir, "upm.lock"), "utf8");
    let n = 0;
    const deps = { nanoid: "^5", other: "^1", third: "^1" };
    edit = () => JSON.stringify({ version: `1.0.${n++}`, dependencies: deps });
    await expect(upm.remove(["other"], { ...base, log })).rejects.toMatchObject({
      code: "EMANIFEST",
    });
    expect(await readFile(join(dir, "upm.lock"), "utf8")).toBe(lock);
    const left = (await readdir(dir)).filter((name) =>
      /^(package\.json\.|\.upm\.editing)/.test(name),
    );
    expect(left).toEqual([]);
  });

  it("fails a frozen install without a lockfile", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
  });

  describe("with no lockfile beside the tree", () => {
    const lockFile = () => join(dir, "upm.lock");
    const copy = () => join(dir, "node_modules", ".upm.lock");
    let requests: string[];
    beforeEach(() => {
      requests = [];
      server.on("request", (request) => void requests.push(request.url ?? ""));
    });
    /** The install resolved: the lockfile was written from a walk, not taken from the tree. */
    const resolved = () => lines.some((line) => line.startsWith("wrote upm.lock · "));

    it("takes the tree's lockfile back, with no store and no registry, while package.json matches", async () => {
      await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"^5"}}');
      await upm.install(base);
      const text = await readFile(lockFile(), "utf8");
      expect(await readFile(copy(), "utf8")).toBe(text);

      // As a benchmark leaves it: the tree, and no lockfile, store or kept documents.
      await rm(lockFile());
      await rm(base.store!, { recursive: true });
      requests.length = 0;
      expect(await upm.install(base)).toMatchObject({ packages: 1, upToDate: true });
      expect(requests).toEqual([]);
      expect(await readFile(lockFile(), "utf8")).toBe(text);
      expect(lines).toContain("wrote upm.lock ← node_modules");
      // Written back, it is the lockfile again: the next install is the ordinary no-op.
      expect((await upm.install(base)).upToDate).toBe(true);

      // Other settings than the tree's: the copy is read and checked, not taken off the state.
      await rm(lockFile());
      expect(await upm.install({ ...base, verify: true })).toMatchObject({ packages: 1 });
      expect(requests).toEqual(["/nanoid/-/nanoid-5.0.0.tgz"]); // for the store, not the lock
      expect(await readFile(lockFile(), "utf8")).toBe(text);

      // A link gone: the copy still comes back, and the tree is linked again from it.
      await rm(lockFile());
      await rm(join(dir, "node_modules", "nanoid"));
      lines.length = 0;
      expect(await upm.install(base)).toMatchObject({ upToDate: false });
      expect(resolved()).toBe(false);
      expect(await readFile(lockFile(), "utf8")).toBe(text);
      expect(await readFile(join(dir, "node_modules", "nanoid", "index.js"), "utf8")).toContain(
        "nanoid",
      );

      // Never under frozen: no lockfile is what it reports.
      await rm(lockFile());
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code: "ELOCK" });
      await expect(stat(lockFile())).rejects.toThrow();
    });

    it("resolves afresh once package.json has moved, or the copy cannot be read", async () => {
      await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"^5"}}');
      await upm.install(base);
      const text = await readFile(lockFile(), "utf8");

      // A range the copy was not made from: resolved, as with no tree, and the copy follows.
      await writeFile(join(dir, "package.json"), '{"name":"demo","dependencies":{"nanoid":"5"}}');
      await rm(lockFile());
      lines.length = 0;
      await upm.install(base);
      expect(resolved()).toBe(true);
      const moved = await readFile(lockFile(), "utf8");
      expect(moved).not.toBe(text);
      expect(await readFile(copy(), "utf8")).toBe(moved);

      await writeFile(copy(), "{ torn");
      await rm(lockFile());
      lines.length = 0;
      await upm.install(base);
      expect(resolved()).toBe(true);
      expect(await readFile(lockFile(), "utf8")).toBe(moved);

      // An edit is a package.json the copy was not made from.
      await rm(lockFile());
      lines.length = 0;
      await upm.add(["nanoid@^5.0.0"], base);
      expect(resolved()).toBe(true);
      expect(await readFile(copy(), "utf8")).toContain('"nanoid": "^5.0.0"');
    });

    it("keeps no copy for a tree another manager's lockfile changed", async () => {
      const manifest = { name: "demo", devDependencies: { nanoid: "^5" } };
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await upm.install(base);
      await rm(lockFile());
      const nanoid = {
        version: "5.0.0",
        resolved: `${registry()}/nanoid/-/nanoid-5.0.0.tgz`,
        integrity: hashOf(tarball),
        dev: true,
      };
      const packages = { "": manifest, "node_modules/nanoid": nanoid };
      await writeFile(
        join(dir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      );
      // The same tree: its copy still says what it holds.
      expect((await upm.install(base)).upToDate).toBe(true);
      expect(await readFile(copy(), "utf8")).toContain("nanoid@5.0.0");
      // Another tree: no copy, so none comes back once that file goes.
      expect((await upm.install({ ...base, production: true })).upToDate).toBe(false);
      await expect(stat(copy())).rejects.toThrow();
      await rm(join(dir, "package-lock.json"));
      lines.length = 0;
      await upm.install(base);
      expect(resolved()).toBe(true);
    });

    it("takes back a workspace tree's lockfile", async () => {
      await mkdir(join(dir, "packages", "a"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/*"], dependencies: { a: "*" } }),
      );
      await writeFile(
        join(dir, "packages", "a", "package.json"),
        JSON.stringify({ name: "a", version: "1.0.0", dependencies: { nanoid: "^5" } }),
      );
      await upm.install(base);
      const text = await readFile(lockFile(), "utf8");
      await rm(lockFile());
      await rm(base.store!, { recursive: true });
      requests.length = 0;
      expect(await upm.install(base)).toMatchObject({ workspaces: 1, upToDate: true });
      expect(requests).toEqual([]);
      expect(await readFile(lockFile(), "utf8")).toBe(text);

      // A workspace's own range moved: resolved again.
      await writeFile(
        join(dir, "packages", "a", "package.json"),
        JSON.stringify({ name: "a", version: "1.0.0", dependencies: { nanoid: "5" } }),
      );
      await rm(lockFile());
      lines.length = 0;
      await upm.install(base);
      expect(resolved()).toBe(true);
    });
  });

  it("refuses options a command cannot take, before reading anything", async () => {
    const nowhere = { dir: join(dir, "missing") };
    const bad = [
      upm.add([], nowhere),
      upm.remove([], nowhere),
      upm.add(["nanoid"], { ...nowhere, group: "peerDependencies" as upm.Group }),
      upm.install({ ...nowhere, experimental: { resolvePool: 17 } }),
      upm.install({ ...nowhere, experimental: { resolvePool: 1.5 } }),
      upm.install({ ...nowhere, experimental: { linkPool: { size: 65 } } }),
      upm.run("go", { ...nowhere, workspaces: true as unknown as "all" }),
    ];
    for (const call of bad) await expect(call).rejects.toMatchObject({ code: "EOPTION" });
    for (const call of [
      upm.resolve([], nowhere),
      upm.fetchPackages([], nowhere),
      upm.install({ ...nowhere, experimental: { linkPool: 5 as unknown as { size: 1 } } }),
      upm.run("go", { ...nowhere, workspaces: [1] as unknown as string[] }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "EOPTION" });
    }
    await expect(upm.run("go", { ...nowhere, workspaces: [] })).rejects.toMatchObject({
      code: "EWORKSPACE",
    });
  });

  it("keeps a default for a link pool entry left undefined", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    const result = await upm.install({
      ...base,
      experimental: { resolvePool: 0, linkPool: { size: undefined, packages: 0 } },
    });
    expect(result.packages).toBe(0);
  });

  it("starts the link pool while the walk picks, once enough packages are picked", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    // No lockfile: the count that starts the pool is the walk's, not the lockfile's.
    const walked = await upm.install({
      ...base,
      experimental: { resolvePool: 0, linkPool: { size: 1, packages: 1, files: 1000 } },
    });
    expect(walked.stats).toMatchObject({ entries: 1, pooled: 1 });
    // A second tree from the lockfile counts its entries the same way.
    await rm(join(dir, "node_modules"), { recursive: true });
    const locked = await upm.install({
      ...base,
      experimental: { resolvePool: 0, linkPool: { size: 1, packages: 1, files: 1000 } },
    });
    expect(locked.stats).toMatchObject({ entries: 1, pooled: 1 });
  });

  it("refuses to add to workspaces when there are none to pick", async () => {
    await writeFile(join(dir, "package.json"), '{ "name": "root" }');
    await expect(upm.add(["nanoid"], { ...base, workspaces: "all" })).rejects.toMatchObject({
      code: "EWORKSPACE",
    });
    expect(await readJson(join(dir, "package.json"))).toEqual({ name: "root" });
  });

  it("never runs a name the scripts object only inherits", async () => {
    await writeFile(join(dir, "package.json"), '{ "name": "root", "scripts": {} }');
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const result = await upm.run(name, { dir });
      expect(result).toMatchObject({ code: 1, results: [{ missing: true }] });
    }
  });

  it("logs each line with its level", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    const seen: [string, upm.LogLevel][] = [];
    await upm.lock({ ...base, log: (message, level) => seen.push([message, level]) });
    expect(seen.at(-1)).toEqual(["wrote upm.lock · 1 pkgs", "info"]);
  });

  it("lists and runs scripts, in workspace order", async () => {
    const out = join(dir, "out.txt");
    const script = (name: string) => `echo ${name} >> "${out}"`;
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: { go: script("root") } }),
    );
    for (const [name, deps] of [
      ["a", { b: "workspace:*" }],
      ["b", {}],
    ] as const) {
      await mkdir(join(dir, "packages", name), { recursive: true });
      await writeFile(
        join(dir, "packages", name, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          dependencies: deps,
          scripts: { go: script(name) },
        }),
      );
    }
    const file = (path: string) => join(dir, path, "package.json");

    expect(await upm.listScripts({ dir })).toEqual([
      { name: "root", path: ".", file: file("."), scripts: { go: script("root") } },
    ]);
    const all = await upm.listScripts({ dir, workspaces: "all", includeRoot: true });
    expect(all.map((top) => top.name)).toEqual(["root", "b", "a"]);

    const started: string[] = [];
    const onScript = (s: upm.ScriptStart) => started.push(`${s.workspace}:${s.script}`);
    const both = await upm.run("go", { dir, workspaces: "all", onScript });
    expect(both).toEqual({
      code: 0,
      results: [
        { name: "b", path: "packages/b", file: file("packages/b"), code: 0 },
        { name: "a", path: "packages/a", file: file("packages/a"), code: 0 },
      ],
    });
    expect(started).toEqual(["b:go", "a:go"]);
    expect((await upm.run("go", { dir })).code).toBe(0);
    expect((await readFile(out, "utf8")).split(/\s+/).filter(Boolean)).toEqual(["b", "a", "root"]);

    // A missing script is the same result either way: not run, and a failure.
    const missing = { name: "root", path: ".", file: file("."), missing: true };
    expect(await upm.run("nope", { dir })).toEqual({ code: 1, results: [missing] });
    const inA = await upm.run("nope", { dir, workspaces: ["a"] });
    expect(inA).toEqual({
      code: 1,
      results: [{ name: "a", path: "packages/a", file: file("packages/a"), missing: true }],
    });
    const present = await upm.run("nope", { dir, workspaces: ["a", "b"], ifPresent: true });
    expect(present.code).toBe(0);
    expect(present.results.every((r) => r.missing && r.code === undefined)).toBe(true);

    const failing = join(dir, "packages", "b", "package.json");
    await writeFile(failing, JSON.stringify({ name: "b", scripts: { go: "exit 3; :" } }));
    const failed = await upm.run("go", { dir, workspaces: "all", args: ["x"] });
    expect(failed.code).toBe(3);
    expect(failed.results.map((r) => r.code)).toEqual([3, 0]);
  });
});

describe("tarball dependencies", () => {
  const remote = makeTarball([
    {
      path: "package.json",
      data: JSON.stringify({ name: "remote", version: "1.0.0", dependencies: { nanoid: "^5" } }),
    },
    { path: "index.js", data: "module.exports = require('nanoid');\n" },
  ]);
  const local = makeTarball([
    { path: "package.json", data: '{"name":"local","version":"2.0.0"}' },
    { path: "index.js", data: 'module.exports = "local";\n' },
  ]);
  const url = () => `${registry()}/files/remote-1.0.0.tgz`;

  beforeEach(async () => {
    files["/files/remote-1.0.0.tgz"] = remote;
    await mkdir(join(dir, "vendor"));
    await writeFile(join(dir, "vendor", "local-2.0.0.tgz"), local);
  });

  /** `add` reads a path from cwd, the way a shell hands it over. */
  async function from<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const was = process.cwd();
    process.chdir(cwd);
    try {
      return await run();
    } finally {
      process.chdir(was);
    }
  }

  it("installs a url and a path, locked by where they are and fetched once", async () => {
    const dependencies = { local: "file:vendor/local-2.0.0.tgz", remote: url() };
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
    expect(await upm.install(base)).toMatchObject({ packages: 3, upToDate: false });
    expect(served).toEqual(["/files/remote-1.0.0.tgz"]);
    const nm = join(dir, "node_modules");
    expect(await readFile(join(nm, "local", "index.js"), "utf8")).toContain("local");
    // The tarball's own dependency comes from the registry, beside it in its store entry.
    const home = await realpath(join(nm, "remote"));
    expect(await readFile(join(home, "..", "nanoid", "index.js"), "utf8")).toContain("nanoid");

    const lock = await readJson(join(dir, "upm.lock"));
    expect(lock.root.dependencies).toEqual(dependencies);
    expect(lock.packages).toEqual({
      "local@file:vendor/local-2.0.0.tgz": { version: "2.0.0", integrity: hashOf(local) },
      "nanoid@5.0.0": { integrity: hashOf(tarball) },
      [`remote@${url()}`]: {
        version: "1.0.0",
        integrity: hashOf(remote),
        dependencies: { nanoid: "5.0.0" },
      },
    });
    expect((await upm.install(base)).upToDate).toBe(true);

    // From the lockfile alone, into a store that has none of it.
    await rm(nm, { recursive: true });
    const fresh = { ...base, store: join(dir, "fresh"), frozen: true };
    expect(await upm.install(fresh)).toMatchObject({ packages: 3, upToDate: false });
    expect(served).toHaveLength(2);
    expect(await readFile(join(nm, "local", "index.js"), "utf8")).toContain("local");

    // Fetched off the lockfile alone, the local one from its path.
    const fetched = await upm.fetchLockfile({ ...base, store: join(dir, "fetched") });
    expect(fetched.map(({ name, cached }) => [name, cached]).sort()).toEqual([
      ["local", false],
      ["nanoid", false],
      ["remote", false],
    ]);
  });

  describe("a url's bytes in the store", () => {
    const evil = makeTarball([
      { path: "package.json", data: '{"name":"evil","version":"1.0.0"}' },
      { path: "index.js", data: 'module.exports = "evil";\n' },
    ]);
    const remotePath = "/files/remote-1.0.0.tgz";
    const nm = () => join(dir, "node_modules");
    const index = () => createStore({ dir: base.store }).indexPath(hashOf(remote));

    beforeEach(() => {
      files["/files/evil-1.0.0.tgz"] = evil;
    });

    it("are another tarball's when the lock gives it their integrity", async () => {
      const dependencies = { remote: url(), evil: `${registry()}/files/evil-1.0.0.tgz` };
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
      await upm.install(base); // the store now holds evil's tarball
      const file = join(dir, "upm.lock");
      const lock = await readJson(file);
      lock.packages[`remote@${url()}`].integrity = hashOf(evil);
      await writeFile(file, JSON.stringify(lock, null, 2));
      await rm(nm(), { recursive: true });

      const before = served.length;
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
        code: "EINTEGRITY",
      });
      // Asked of the url, whose bytes are not evil's.
      expect(served.slice(before)).toEqual([remotePath]);
      await expect(upm.install({ ...base, frozen: true, offline: true })).rejects.toMatchObject({
        code: "EOFFLINE",
      });
      // A resolve reads the url's package.json from the same bytes, and a fetch fills the same.
      await expect(upm.install(base)).rejects.toMatchObject({ code: "EINTEGRITY" });
      await expect(upm.fetchLockfile(base)).rejects.toMatchObject({ code: "EINTEGRITY" });
      await expect(readFile(join(nm(), "remote", "index.js"), "utf8")).rejects.toThrow();
    });

    it("are taken from a store that fetched them from the url, with no request", async () => {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { remote: url() } }),
      );
      await upm.install(base);
      expect(served).toEqual([remotePath]);
      expect((await readJson(index())).sources).toEqual([url()]);
      await rm(nm(), { recursive: true });
      await upm.install({ ...base, frozen: true, offline: true });
      await upm.fetchLockfile({ ...base, offline: true });
      expect(served).toEqual([remotePath]);
    });

    it("are fetched once more when an older index cannot say where they came from", async () => {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { remote: url() } }),
      );
      await upm.install(base);
      const { sources: _, ...older } = await readJson(index());
      await writeFile(index(), JSON.stringify(older));
      await rm(nm(), { recursive: true });
      await expect(upm.install({ ...base, frozen: true, offline: true })).rejects.toMatchObject({
        code: "EOFFLINE",
      });
      await upm.install({ ...base, frozen: true });
      expect(served).toEqual([remotePath, remotePath]);
      expect((await readJson(index())).sources).toEqual([url()]);
      await rm(nm(), { recursive: true });
      await upm.install({ ...base, frozen: true });
      expect(served).toHaveLength(2);
    });
  });

  it("fetches nothing that only an off-platform tarball reaches", async () => {
    const aix = { name: "aix", version: "1.0.0", os: ["aix"], dependencies: { nanoid: "^5" } };
    files["/files/aix-1.0.0.tgz"] = makeTarball([
      { path: "package.json", data: JSON.stringify(aix) },
    ]);
    files["/nanoid/-/nanoid-5.0.0.tgz"] = tarball; // served here to be counted
    const optionalDependencies = { aix: `${registry()}/files/aix-1.0.0.tgz` };
    await writeFile(join(dir, "package.json"), JSON.stringify({ optionalDependencies }));
    expect(await upm.install(base)).toMatchObject({ packages: 0, otherPlatforms: 2 });
    expect(served).toEqual(["/files/aix-1.0.0.tgz"]);
  });

  it("ends its progress done when an optional's download fails", async () => {
    const opt = '{"name":"opt","version":"1.0.0"}';
    files["/files/opt-1.0.0.tgz"] = makeTarball([{ path: "package.json", data: opt }]);
    const optionalDependencies = { opt: `${registry()}/files/opt-1.0.0.tgz` };
    const manifest = { dependencies: { nanoid: "^5" }, optionalDependencies };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    await upm.lock(base);
    // Locked, then gone: a fresh store has to download it, and cannot.
    delete files["/files/opt-1.0.0.tgz"];
    const seen: upm.Progress[] = [];
    const fresh = {
      ...base,
      store: join(dir, "fresh"),
      onProgress: (p: upm.Progress) => seen.push(p),
    };
    await upm.install(fresh);
    expect(lines).toContainEqual(expect.stringContaining("skipped optional opt@1.0.0"));
    const last = (phase: string) => seen.filter((p) => p.phase === phase).at(-1);
    expect(last("fetch")).toEqual({ phase: "fetch", done: 1, total: 1 });
    expect(last("link")).toEqual({ phase: "link", done: 1, total: 1 });
  });

  describe("an optional whose download failed", () => {
    const path = "/files/opt-1.0.0.tgz";
    const nm = () => join(dir, "node_modules");
    const state = async () => await readJson(join(nm(), ".upm.json"));
    let fresh: upm.InstallOptions;
    const asked = () => served.filter((url) => url === path).length;

    beforeEach(async () => {
      const opt = '{"name":"opt","version":"1.0.0"}';
      files[path] = makeTarball([{ path: "package.json", data: opt }]);
      const optionalDependencies = { opt: `${registry()}${path}` };
      const manifest = { dependencies: { nanoid: "^5" }, optionalDependencies };
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await upm.lock(base);
      // Locked, so a fresh store has to download it.
      fresh = { ...base, store: join(dir, "fresh") };
    });

    it("is fetched again by the next install once the registry answers", async () => {
      busy.add(path);
      expect((await upm.install(fresh)).missingOptional).toEqual([`opt@${registry()}${path}`]);
      expect((await state()).complete).toBe(false);
      busy.delete(path);
      expect(await upm.install(fresh)).toMatchObject({ upToDate: false, missingOptional: [] });
      expect(await readFile(join(nm(), "opt", "package.json"), "utf8")).toContain('"opt"');
      expect(await upm.install(fresh)).toMatchObject({ upToDate: true, missingOptional: [] });
    });

    it.each([
      ["gone", () => delete files[path]],
      ["other bytes", () => (files[path] = makeTarball([{ path: "index.js", data: "other" }]))],
    ])(
      "is not asked for again when it is %s, and the tree is up to date without it",
      async (_, change) => {
        change();
        const id = `opt@${registry()}${path}`;
        expect((await upm.install(fresh)).missingOptional).toEqual([id]);
        const before = served.length;
        expect(await upm.install(fresh)).toMatchObject({ upToDate: true, missingOptional: [id] });
        expect(served).toHaveLength(before);
      },
    );

    it("is asked for once more when the registry stays busy, then left out", async () => {
      busy.add(path);
      const locked = asked();
      await upm.install(fresh);
      const tries = asked() - locked;
      expect(tries).toBeGreaterThan(1); // retried within the install
      expect(await upm.install(fresh)).toMatchObject({ upToDate: false });
      expect(asked() - locked).toBe(tries * 2);
      const id = `opt@${registry()}${path}`;
      expect(await upm.install(fresh)).toMatchObject({ upToDate: true, missingOptional: [id] });
      expect(asked() - locked).toBe(tries * 2);
    });

    it("is not asked for offline, and the offline install still links the rest", async () => {
      busy.add(path);
      await upm.install(fresh);
      busy.delete(path);
      const before = served.length;
      await rm(join(nm(), "nanoid"), { recursive: true });
      expect(await upm.install({ ...fresh, offline: true })).toMatchObject({ upToDate: false });
      expect(served).toHaveLength(before);
      expect(await readFile(join(nm(), "nanoid", "index.js"), "utf8")).toContain("nanoid");
      // Back online, the tree is still short of it, so it is asked for.
      expect(await upm.install(fresh)).toMatchObject({ missingOptional: [] });
    });
  });

  describe("a local tarball changed in place", () => {
    const source = "file:vendor/local-2.0.0.tgz";
    const file = () => join(dir, "vendor", "local-2.0.0.tgz");
    const next = makeTarball([
      { path: "package.json", data: '{"name":"local","version":"2.0.1"}' },
      { path: "index.js", data: 'module.exports = "local two";\n' },
    ]);
    const state = async () => await readJson(join(dir, "node_modules", ".upm.json"));
    const checked = (bytes = local) => ({ [source]: [...stampOf(file())!, hashOf(bytes)] });
    /** How often the install read the tarball's bytes. */
    const reads = () => {
      const fsp = process.getBuiltinModule("node:fs/promises");
      const spy = vi.spyOn(fsp, "readFile");
      return () => spy.mock.calls.filter(([path]) => path === file()).length;
    };

    beforeEach(async () => {
      const dependencies = { local: source, remote: url() };
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
      await upm.install(base);
      expect((await state()).tarballs).toEqual(checked());
    });

    it("is read again and locked anew, and nothing else is", async () => {
      await writeFile(file(), next);
      lines.length = 0;
      expect(await upm.install(base)).toMatchObject({ packages: 3, upToDate: false });
      expect(lines).toContain(`${source} changed since upm.lock locked it`);
      const lock = await readJson(join(dir, "upm.lock"));
      expect(lock.packages[`local@${source}`]).toEqual({
        version: "2.0.1",
        integrity: hashOf(next),
      });
      expect(served).toEqual(["/files/remote-1.0.0.tgz"]);
      const at = join(dir, "node_modules", "local", "index.js");
      expect(await readFile(at, "utf8")).toContain("local two");
      // Stamped as it was read, so the next install is a no-op.
      expect((await state()).tarballs).toEqual(checked(next));
      expect((await upm.install(base)).upToDate).toBe(true);
    });

    it("fails a frozen install, though the store has what the lock pinned", async () => {
      await writeFile(file(), next);
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
        code: "ELOCK",
        message: expect.stringMatching(/is out of date: file:vendor\/local-2\.0\.0\.tgz changed/),
      });
    });

    it("is hashed once when only touched, then trusted by its stamp", async () => {
      const lock = await readFile(join(dir, "upm.lock"), "utf8");
      const later = new Date(Date.now() + 60_000);
      await utimes(file(), later, later);
      expect((await upm.install(base)).upToDate).toBe(true);
      expect(await readFile(join(dir, "upm.lock"), "utf8")).toBe(lock);
      expect((await state()).tarballs).toEqual(checked());
    });

    it("is not read again while its stamp and the lockfile's integrity hold", async () => {
      const read = reads();
      expect((await upm.install(base)).upToDate).toBe(true);
      // The lockfile in other words: the install checks it, but not the tarball's bytes.
      const lock = await readJson(join(dir, "upm.lock"));
      await writeFile(join(dir, "upm.lock"), JSON.stringify(lock));
      expect((await upm.install(base)).upToDate).toBe(true);
      expect(read()).toBe(0);
    });

    it("is read again when the lockfile pins it to other bytes the store holds", async () => {
      // Another project put a tarball of the same name and version in the store.
      const evil = makeTarball([
        { path: "package.json", data: '{"name":"local","version":"2.0.0"}' },
        { path: "index.js", data: 'module.exports = "evil";\n' },
      ]);
      const other = join(dir, "other");
      await mkdir(other);
      await writeFile(join(other, "evil.tgz"), evil);
      const manifest = { dependencies: { local: "file:evil.tgz" } };
      await writeFile(join(other, "package.json"), JSON.stringify(manifest));
      await upm.install({ ...base, dir: other });

      // Its stamp unmoved, the file is no proof of bytes the lockfile now names.
      const path = join(dir, "upm.lock");
      const lock = await readJson(path);
      lock.packages[`local@${source}`].integrity = hashOf(evil);
      await writeFile(path, JSON.stringify(lock));
      await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
        code: "ELOCK",
        message: expect.stringMatching(/is out of date: file:vendor\/local-2\.0\.0\.tgz changed/),
      });
      lines.length = 0;
      // Locked anew from the file, which is the tree already there.
      expect(await upm.install(base)).toMatchObject({ upToDate: true });
      expect(lines).toContain(`${source} changed since upm.lock locked it`);
      const at = join(dir, "node_modules", "local", "index.js");
      expect(await readFile(at, "utf8")).toContain('"local"');
      expect((await readJson(path)).packages[`local@${source}`].integrity).toBe(hashOf(local));
      expect((await state()).tarballs).toEqual(checked());
    });

    it("is read once more when an older upm stamped it without its integrity", async () => {
      const at = join(dir, "node_modules", ".upm.json");
      const old = await state();
      await writeFile(at, JSON.stringify({ ...old, tarballs: { [source]: stampOf(file()) } }));
      const read = reads();
      expect((await upm.install(base)).upToDate).toBe(true);
      expect(read()).toBe(1);
      expect((await state()).tarballs).toEqual(checked());
      expect((await upm.install(base)).upToDate).toBe(true);
      expect(read()).toBe(1);
    });

    it("makes the lockfile stale for lock too", async () => {
      await writeFile(file(), next);
      const locked = await upm.lock(base);
      expect(locked.packages[`local@${source}`]?.integrity).toBe(hashOf(next));
    });
  });

  it("adds a path from cwd or a url on its own, named by its package.json", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "sub"));
    const added = await from(join(dir, "sub"), () =>
      upm.add(["../vendor/local-2.0.0.tgz", url()], base),
    );
    expect(added.added).toEqual([
      { name: "local", range: "file:vendor/local-2.0.0.tgz", group: "dependencies" },
      { name: "remote", range: url(), group: "dependencies" },
    ]);
    // Read to be named, and not again by the install that followed.
    expect(served).toEqual(["/files/remote-1.0.0.tgz"]);
    expect(await readJson(join(dir, "package.json"))).toEqual({
      dependencies: { local: "file:vendor/local-2.0.0.tgz", remote: url() },
    });
    expect(await readFile(join(dir, "node_modules", "local", "index.js"), "utf8")).toContain(
      "local",
    );

    // Under a name of its own choosing, as an alias is.
    await upm.add([`other@${url()}`], base);
    const other = await realpath(join(dir, "node_modules", "other"));
    expect(await readFile(join(other, "index.js"), "utf8")).toContain("nanoid");
  });

  it("saves a path from cwd when the project is given through a link", async () => {
    // As on macOS, where the temp dir is under /var, a link to /private/var: cwd is the real path.
    await writeFile(join(dir, "package.json"), "{}");
    const link = `${dir}-link`;
    await symlink(dir, link, "junction");
    try {
      await from(dir, () => upm.add(["./vendor/local-2.0.0.tgz"], { ...base, dir: link }));
      expect((await readJson(join(dir, "package.json"))).dependencies).toEqual({
        local: "file:vendor/local-2.0.0.tgz",
      });
    } finally {
      await rm(link, { recursive: true, force: true });
    }
  });

  it("saves a path in a workspace from its own directory, and reads it from there", async () => {
    const root = { private: true, workspaces: ["packages/*"] };
    await writeFile(join(dir, "package.json"), JSON.stringify(root));
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    await writeFile(join(dir, "packages", "w", "package.json"), '{"name":"w"}');
    const options = { ...base, workspaces: ["w"] };
    await from(dir, () => upm.add(["./vendor/local-2.0.0.tgz"], options));
    expect(await readJson(join(dir, "packages", "w", "package.json"))).toEqual({
      name: "w",
      dependencies: { local: "file:../../vendor/local-2.0.0.tgz" },
    });
    await rm(join(dir, "upm.lock"));
    const locked = await upm.lock(base);
    expect(Object.keys(locked.packages)).toEqual(["local@file:vendor/local-2.0.0.tgz"]);
    await upm.install({ ...base, frozen: true });
    const at = join(dir, "packages", "w", "node_modules", "local", "index.js");
    expect(await readFile(at, "utf8")).toContain("local");
    // Stamped though a tree with workspaces has no no-op check: the next install hashes nothing.
    const state = await readJson(join(dir, "node_modules", ".upm.json"));
    const file = join(dir, "vendor", "local-2.0.0.tgz");
    const stamp = [...stampOf(file)!, hashOf(local)];
    expect(state.tarballs).toEqual({ "file:vendor/local-2.0.0.tgz": stamp });
  });

  it("reads a hand-written package.json as npm does", async () => {
    const loose = { name: "loose", version: "v3.0.0", os: process.platform };
    const data = JSON.stringify(loose);
    await writeFile(
      join(dir, "vendor", "loose.tgz"),
      makeTarball([{ path: "package.json", data }]),
    );
    await writeFile(join(dir, "package.json"), "{}");
    await from(dir, () => upm.add(["./vendor/loose.tgz"], base));
    expect((await readJson(join(dir, "upm.lock"))).packages).toEqual({
      "loose@file:vendor/loose.tgz": {
        version: "3.0.0",
        integrity: hashOf(await readFile(join(dir, "vendor", "loose.tgz"))),
        os: [process.platform],
      },
    });
  });

  it.each([
    ["no package.json", [{ path: "index.js", data: "" }], /has no package\.json/, "EMANIFEST"],
    [
      "a package.json that is not JSON",
      [{ path: "package.json", data: "{" }],
      /not valid JSON/,
      "EMANIFEST",
    ],
    [
      "no version",
      [{ path: "package.json", data: '{"name":"x"}' }],
      /has no valid version/,
      "EMANIFEST",
    ],
    [
      "no name",
      [{ path: "package.json", data: '{"version":"1.0.0"}' }],
      /add it as <name>@/,
      "EINVALIDSPEC",
    ],
    [
      "a peer range that is not a string",
      [{ path: "package.json", data: '{"name":"x","version":"1.0.0","peerDependencies":{"y":1}}' }],
      /peerDependencies is not a map of ranges/,
      "EMANIFEST",
    ],
    [
      "an os that is not a list",
      [{ path: "package.json", data: '{"name":"x","version":"1.0.0","os":{"linux":true}}' }],
      /os is not a list of names/,
      "EMANIFEST",
    ],
  ])(
    "refuses a tarball with %s, and leaves package.json alone",
    async (_label, entries, message, code) => {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "vendor", "bad.tgz"), makeTarball(entries));
      await expect(from(dir, () => upm.add(["./vendor/bad.tgz"], base))).rejects.toMatchObject({
        code,
        message: expect.stringMatching(message),
      });
      expect(await readFile(join(dir, "package.json"), "utf8")).toBe("{}");
    },
  );

  it("is refused where only a registry spec will do", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await expect(upm.resolve([`a@${url()}`], base)).rejects.toMatchObject({
      code: "EINVALIDSPEC",
    });
    await expect(upm.exec("a", { ...base, packages: [`a@${url()}`] })).rejects.toMatchObject({
      code: "EINVALIDSPEC",
    });
  });
});

describe("link: dependencies", () => {
  let app: string;
  let options: upm.InstallOptions;

  beforeEach(async () => {
    app = join(dir, "app");
    options = { ...base, dir: app };
    await mkdir(join(dir, "lib"));
    await mkdir(app);
    const lib = { name: "lib", version: "1.2.3", bin: "cli.js", dependencies: { nanoid: "^5" } };
    await writeFile(join(dir, "lib", "package.json"), JSON.stringify(lib));
    await writeFile(join(dir, "lib", "cli.js"), "#!/usr/bin/env node\n");
  });

  it("links a directory as it is, with its bins and none of its dependencies", async () => {
    const manifest = { dependencies: { nanoid: "^5" }, devDependencies: { mine: "link:../lib" } };
    await writeFile(join(app, "package.json"), JSON.stringify(manifest));
    expect(await upm.install(options)).toMatchObject({ packages: 1, upToDate: false });
    const nm = join(app, "node_modules");
    expect(await realpath(join(nm, "mine"))).toBe(await realpath(join(dir, "lib")));
    expect(await binOf(join(nm, ".bin", "lib"))).toBe("../mine/cli.js");
    // Its own nanoid is not installed for it: the one here is the root's.
    expect(await readdir(join(dir, "lib"))).toEqual(["cli.js", "package.json"]);

    // The edge alone: the directory says the rest.
    const lock = await readJson(join(app, "upm.lock"));
    expect(lock.root.dependencies).toEqual({ mine: "link:../lib", nanoid: "5.0.0" });
    expect(Object.keys(lock.packages)).toEqual(["nanoid@5.0.0"]);
    expect((await upm.install(options)).upToDate).toBe(true);

    // From the lockfile alone, bins read off the directory again; dev, so not in production.
    await rm(nm, { recursive: true });
    await upm.install({ ...options, frozen: true });
    expect(await binOf(join(nm, ".bin", "lib"))).toBe("../mine/cli.js");
    await upm.install({ ...options, production: true });
    await expect(lstat(join(nm, "mine"))).rejects.toThrow();
    expect(await readdir(nm)).toContain("nanoid");
  });

  it("reads a workspace's path from its own directory, and locks it from the root", async () => {
    const root = { private: true, workspaces: ["packages/*"] };
    await writeFile(join(app, "package.json"), JSON.stringify(root));
    await mkdir(join(app, "packages", "w"), { recursive: true });
    const w = { name: "w", dependencies: { lib: "link:../../../lib" } };
    await writeFile(join(app, "packages", "w", "package.json"), JSON.stringify(w));
    await upm.install(options);
    const lock = await readJson(join(app, "upm.lock"));
    expect(lock.workspaces["packages/w"].dependencies).toEqual({ lib: "link:../lib" });
    const at = join(app, "packages", "w", "node_modules", "lib");
    expect(await realpath(at)).toBe(await realpath(join(dir, "lib")));
  });

  it("adds a path from cwd, saved from package.json", async () => {
    await writeFile(join(app, "package.json"), "{}");
    const was = process.cwd();
    process.chdir(dir);
    try {
      const { added } = await upm.add(["mine@link:./lib"], options);
      expect(added).toEqual([{ name: "mine", range: "link:../lib", group: "dependencies" }]);
    } finally {
      process.chdir(was);
    }
    expect((await readJson(join(app, "package.json"))).dependencies).toEqual({
      mine: "link:../lib",
    });
    expect(await realpath(join(app, "node_modules", "mine"))).toBe(
      await realpath(join(dir, "lib")),
    );
  });

  it("is a top's to declare, not a registry package's", async () => {
    const dep = {
      name: "dep",
      version: "1.0.0",
      dependencies: { lib: "link:../lib" },
      dist: { tarball: `${registry()}/dep/-/dep-1.0.0.tgz`, integrity: hashOf(tarball) },
    };
    docs["/dep"] = { name: "dep", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": dep } };
    await writeFile(join(app, "package.json"), JSON.stringify({ dependencies: { dep: "1" } }));
    await expect(upm.install(options)).rejects.toThrow(
      /a link: dependency can be a dependency of the root or a workspace only/,
    );
  });
});

describe("a tarball is the package it is installed as", () => {
  /**
   * `name@version` on the registry, its tarball's package.json saying `says`; `dependencies`,
   * `peerDependencies` and `more` in both, as a registry serves them.
   */
  function publish(
    name: string,
    version: string,
    says: object = { name, version },
    dependencies?: Record<string, string>,
    peerDependencies?: Record<string, string>,
    more: object = {},
  ): string {
    const tgz = makeTarball([
      {
        path: "package.json",
        data: JSON.stringify({ ...says, dependencies, peerDependencies, ...more }),
      },
      { path: "index.js", data: `module.exports = ${JSON.stringify(`${name}@${version}`)};\n` },
    ]);
    const path = `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
    files[path] = tgz;
    const manifest = {
      name,
      version,
      dist: { tarball: `${registry()}${path}`, integrity: hashOf(tgz) },
      ...(dependencies && { dependencies }),
      ...(peerDependencies && { peerDependencies }),
      ...more,
    };
    docs[`/${name.replace("/", "%2f")}`] = {
      name,
      "dist-tags": { latest: version },
      versions: { [version]: manifest },
    };
    return hashOf(tgz);
  }
  const pooled = { resolvePool: 0, linkPool: { size: 1, packages: 1, files: 1000 } };
  const code = (file: string) => readFile(join(dir, "node_modules", file, "index.js"), "utf8");

  it("refuses a tarball whose package.json names another package, on and off the pool", async () => {
    publish("pkg-a", "1.0.0", { name: "pkg-other", version: "1.0.0" });
    await writeFile(join(dir, "package.json"), '{ "dependencies": { "pkg-a": "^1" } }');
    await expect(upm.install(base)).rejects.toMatchObject({ code: "EMISMATCH" });
    await expect(upm.install({ ...base, experimental: pooled })).rejects.toMatchObject({
      code: "EMISMATCH",
    });
  });

  it("refuses a tarball whose package.json has another version", async () => {
    publish("pkg-a", "1.0.0", { name: "pkg-a", version: "9.9.9" });
    await writeFile(join(dir, "package.json"), '{ "dependencies": { "pkg-a": "^1" } }');
    await expect(upm.install(base)).rejects.toMatchObject({ code: "EMISMATCH" });
  });

  it("refuses a tarball whose package.json names the package in another case", async () => {
    publish("pkg-a", "1.0.0", { name: "PKG-A", version: "1.0.0" });
    await writeFile(join(dir, "package.json"), '{ "dependencies": { "pkg-a": "^1" } }');
    await expect(upm.install(base)).rejects.toMatchObject({ code: "EMISMATCH" });
  });

  it("takes a version spelled another way, and an alias", async () => {
    publish("pkg-a", "1.0.0", { name: "pkg-a", version: "v1.0.0+build.5" });
    publish("pkg-b", "1.0.0");
    // Old npm published loose versions, and the registry keys them as semver reads them.
    publish("pkg-c", "1.0.2-beta", { name: "pkg-c", version: "1.0.2beta" });
    publish("pkg-d", "0.4.1-4.1", { name: "pkg-d", version: "0.4.14.1" });
    const deps = {
      "pkg-a": "^1",
      "renamed-b": "npm:pkg-b@^1",
      "pkg-c": "1.0.2-beta",
      "pkg-d": "0.4.1-4.1",
    };
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    await upm.install(base);
    expect(await code("renamed-b")).toContain("pkg-b@1.0.0");
    await rm(join(dir, "node_modules"), { recursive: true });
    await upm.install({ ...base, frozen: true, experimental: pooled });
    expect(await code("pkg-a")).toContain("pkg-a@1.0.0");
  });

  it("refuses a lockfile that gives a package another's tarball already in the store", async () => {
    publish("pkg-a", "1.0.0");
    publish("pkg-b", "1.0.0");
    await writeFile(
      join(dir, "package.json"),
      '{ "dependencies": { "pkg-a": "^1", "pkg-b": "^1" } }',
    );
    await upm.install(base);
    const file = join(dir, "upm.lock");
    const lock = await readJson(file);
    lock.packages["pkg-a@1.0.0"].integrity = lock.packages["pkg-b@1.0.0"].integrity;
    await writeFile(file, JSON.stringify(lock, null, 2));
    // With the tree there, and without: the store has pkg-b's tarball either way.
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
      code: "EMISMATCH",
    });
    await rm(join(dir, "node_modules"), { recursive: true });
    for (const experimental of [base.experimental, pooled]) {
      await expect(upm.install({ ...base, frozen: true, experimental })).rejects.toMatchObject({
        code: "EMISMATCH",
      });
    }
  });

  it("refuses a scoped package given the unscoped package its url ends in", async () => {
    publish("@scope/pkg-a", "1.0.0");
    publish("pkg-a", "1.0.0");
    const deps = { "@scope/pkg-a": "^1", "pkg-a": "^1" };
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    await upm.install(base);
    const file = join(dir, "upm.lock");
    const lock = await readJson(file);
    lock.packages["@scope/pkg-a@1.0.0"].integrity = lock.packages["pkg-a@1.0.0"].integrity;
    await writeFile(file, JSON.stringify(lock, null, 2));
    await rm(join(dir, "node_modules"), { recursive: true });
    for (const experimental of [base.experimental, pooled]) {
      await expect(upm.install({ ...base, frozen: true, experimental })).rejects.toMatchObject({
        code: "EMISMATCH",
      });
    }
  });

  it("refuses another package's tarball that only a store backend holds", async () => {
    const data = new Map<string, Uint8Array>();
    const storeBackend: upm.StoreBackend = {
      get: async (key) => data.get(key),
      set: async (key, value) => void data.set(key, value),
    };
    publish("pkg-a", "1.0.0");
    publish("pkg-b", "1.0.0");
    await writeFile(
      join(dir, "package.json"),
      '{ "dependencies": { "pkg-a": "^1", "pkg-b": "^1" } }',
    );
    await upm.install({ ...base, storeBackend });
    const file = join(dir, "upm.lock");
    const lock = await readJson(file);
    lock.packages["pkg-a@1.0.0"].integrity = lock.packages["pkg-b@1.0.0"].integrity;
    await writeFile(file, JSON.stringify(lock, null, 2));
    await rm(join(dir, "node_modules"), { recursive: true });
    const fresh = { ...base, store: join(dir, "other-store"), storeBackend, frozen: true };
    await expect(upm.install(fresh)).rejects.toMatchObject({ code: "EMISMATCH" });
  });

  it("refuses a lockfile that points a package at another's tarball and integrity", async () => {
    publish("pkg-a", "1.0.0");
    publish("pkg-b", "2.0.0");
    await writeFile(join(dir, "package.json"), '{ "dependencies": { "pkg-a": "^1" } }');
    await upm.install(base);
    const file = join(dir, "upm.lock");
    const lock = await readJson(file);
    const entry = lock.packages["pkg-a@1.0.0"];
    entry.resolved = `${registry()}/pkg-b/-/pkg-b-2.0.0.tgz`;
    entry.integrity = hashOf(files["/pkg-b/-/pkg-b-2.0.0.tgz"]!);
    await writeFile(file, JSON.stringify(lock, null, 2));
    await rm(join(dir, "node_modules"), { recursive: true });
    // Its url names pkg-b, so the registry's integrity for pkg-a@1.0.0 refuses it before a byte.
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
      code: "ELOCK",
      message: expect.stringContaining("its integrity is not the one at"),
    });
  });

  /** Installs `deps`, then lets `edit` change upm.lock, the store keeping every tarball. */
  async function locked(
    deps: object,
    edit: (packages: Record<string, any>, lock: any) => void,
    manifest: object = {},
  ) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...manifest, dependencies: deps }));
    const file = join(dir, "upm.lock");
    await rm(file, { force: true }); // an edit before stands under an unchanged package.json
    await upm.install(base);
    const lock = await readJson(file);
    edit(lock.packages, lock);
    await writeFile(file, JSON.stringify(lock, null, 2));
    return lock;
  }

  /** Every way a frozen install can link the tree: over it, fresh, on the pool. */
  async function refused(code: string) {
    await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({ code });
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    for (const experimental of [base.experimental, pooled]) {
      await expect(upm.install({ ...base, frozen: true, experimental })).rejects.toMatchObject({
        code,
      });
    }
  }

  it("refuses another package of the same version, named as an alias or not", async () => {
    publish("pkg-a", "1.0.0");
    const evil = publish("evil", "1.0.0");
    const deps = { "pkg-a": "^1", evil: "^1" }; // so evil's tarball is in the store
    const entry = (packages: Record<string, any>) => packages["pkg-a@1.0.0"];
    const url = `${registry()}/evil/-/evil-1.0.0.tgz`;
    // Its integrity alone: pkg-a's url, evil's tarball.
    await locked(deps, (packages) => void (entry(packages).integrity = evil));
    await refused("EMISMATCH");
    // Evil's url too, which reads as an alias of evil, or named one: package.json says pkg-a.
    await locked(deps, (packages) =>
      Object.assign(entry(packages), { resolved: url, integrity: evil }),
    );
    await refused("ELOCK");
    await locked(deps, (packages) =>
      Object.assign(entry(packages), { name: "evil", integrity: evil }),
    );
    await refused("ELOCK");
    await upm.install(base);
    expect(await code("pkg-a")).toContain("pkg-a@1.0.0");
  });

  it("refuses a dependency's edge given another package of the same version", async () => {
    publish("pkg-q", "1.0.0");
    publish("pkg-p", "1.0.0", undefined, { "pkg-q": "^1" });
    const evil = publish("evil", "1.0.0");
    // The lock may call it an alias of evil; pkg-p's own package.json says otherwise.
    const resolved = `${registry()}/evil/-/evil-1.0.0.tgz`;
    for (const name of [undefined, "evil"]) {
      await locked({ "pkg-p": "^1", evil: "^1" }, (packages) => {
        Object.assign(packages["pkg-q@1.0.0"], { name, resolved, integrity: evil });
      });
      await refused("EMISMATCH");
    }
  });

  it("refuses an alias a dependency declares, given the package of the alias's name", async () => {
    publish("pkg-q", "1.0.0");
    publish("pkg-p", "1.0.0", undefined, { "q-cjs": "npm:pkg-q@^1" });
    // Someone published the alias's own name, at the same version: its tarball is where the
    // registry keeps `q-cjs`, so the lock needs only its name, url and integrity edited.
    const squat = publish("q-cjs", "1.0.0");
    await locked({ "pkg-p": "^1" }, (packages) => {
      const entry = packages["q-cjs@1.0.0"];
      expect(entry.name).toBe("pkg-q");
      delete entry.name;
      delete entry.resolved;
      entry.integrity = squat;
    });
    await refused("EMISMATCH");
  });

  it("names an alias in upm.lock, and still reads one a lock of before left unnamed", async () => {
    publish("pkg-q", "1.0.0");
    publish("pkg-p", "1.0.0", undefined, { "q-cjs": "npm:pkg-q@^1" });
    publish("pkg-b", "1.0.0");
    const deps = { "pkg-p": "^1", "renamed-b": "npm:pkg-b@^1" };
    const lock = await locked(deps, () => {});
    // Named, and its url kept for an upm that reads only that.
    expect(lock.packages["renamed-b@1.0.0"]).toMatchObject({
      name: "pkg-b",
      resolved: `${registry()}/pkg-b/-/pkg-b-1.0.0.tgz`,
    });
    expect(lock.packages["q-cjs@1.0.0"]).toMatchObject({ name: "pkg-q" });
    // As upm wrote them before: no name, the url naming the package.
    await locked(deps, (packages) => {
      for (const [key, real] of [
        ["renamed-b@1.0.0", "pkg-b"],
        ["q-cjs@1.0.0", "pkg-q"],
      ] as const) {
        delete packages[key].name;
        packages[key].resolved = `${registry()}/${real}/-/${real}-1.0.0.tgz`;
      }
    });
    for (const experimental of [base.experimental, pooled]) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen: true, experimental });
      expect(await code("renamed-b")).toContain("pkg-b@1.0.0");
      // pkg-p's own q-cjs sits beside it in its entry.
      const beside = join(dirname(await realpath(join(dir, "node_modules", "pkg-p"))), "q-cjs");
      expect(await readFile(join(beside, "index.js"), "utf8")).toContain("pkg-q@1.0.0");
    }
  });

  it("reads what a package aliases off its package.json when its index is older", async () => {
    publish("pkg-q", "1.0.0");
    const p = publish("pkg-p", "1.0.0", undefined, { "q-cjs": "npm:pkg-q@^1" });
    const squat = publish("q-cjs", "1.0.0");
    await locked({ "pkg-p": "^1" }, () => {});
    // As an index was written before it kept what the package aliases.
    const { createStore } = await import("../src/store.ts");
    const at = createStore({ dir: base.store! }).indexPath(p);
    const index = await readJson(at);
    expect(index.aliases).toEqual({ "q-cjs": "pkg-q" });
    delete index.aliases;
    await writeFile(at, JSON.stringify(index));
    await rm(join(dir, "node_modules"), { recursive: true });
    await upm.install({ ...base, frozen: true });
    await locked({ "pkg-p": "^1" }, (packages) => {
      delete packages["q-cjs@1.0.0"].name;
      delete packages["q-cjs@1.0.0"].resolved;
      packages["q-cjs@1.0.0"].integrity = squat;
    });
    await refused("EMISMATCH");
  });

  it("keeps what an older index lacked, read once, at the index's own time", async () => {
    publish("pkg-q", "1.0.0");
    const p = publish("pkg-p", "1.0.0", undefined, { "q-cjs": "npm:pkg-q@^1" });
    await locked({ "pkg-p": "^1" }, () => {});
    const { createStore } = await import("../src/store.ts");
    const store = createStore({ dir: base.store! });
    const at = store.indexPath(p);
    const fresh = await readFile(at, "utf8");
    const { aliases, ...older } = JSON.parse(fresh);
    const blob = store.blobPath(older.files.find((file: any) => file.path === "package.json"));
    const reads = () => spy.mock.calls.filter(([path]) => path === blob).length;
    const spy = vi.spyOn(builtin.fs, "readFileSync");
    for (const experimental of [base.experimental, pooled]) {
      await writeFile(at, JSON.stringify(older));
      const then = new Date(Date.now() - 60_000);
      await utimes(at, then, then);
      spy.mockClear();
      await rm(join(dir, "node_modules"), { recursive: true });
      await upm.install({ ...base, frozen: true, experimental });
      // Read once, then kept as an index written now keeps it, and as old as it was.
      expect(await readFile(at, "utf8")).toBe(fresh);
      expect((await stat(at)).mtimeMs).toBe(then.getTime());
      if (experimental === base.experimental) expect(reads()).toBe(1);
      spy.mockClear();
      await rm(join(dir, "node_modules"), { recursive: true });
      await upm.install({ ...base, frozen: true, experimental });
      expect(reads()).toBe(0);
      expect(await readdir(dirname(at))).toEqual([basename(at)]);
    }
  });

  it("refuses a peer given another package, whatever the lock calls the edge", async () => {
    publish("host", "1.0.0");
    publish("pkg-q", "1.0.0");
    publish("plugin", "1.0.0", undefined, { "q-cjs": "npm:pkg-q@^1" }, { host: "^1" });
    const evil = publish("evil", "1.0.0");
    const squat = publish("q-cjs", "1.0.0");
    // A package of evil's own, which does alias host to it.
    const voucher = publish("voucher", "1.0.0", undefined, { host: "npm:evil@^1" });
    const deps = { plugin: "^1", evil: "^1" };
    const url = `${registry()}/evil/-/evil-1.0.0.tgz`;
    const lie = (packages: Record<string, any>) => {
      Object.assign(packages["plugin@1.0.0"], {
        peerDependencies: { host: "^1", "q-cjs": "^1" },
        peers: { host: "required", "q-cjs": "required" },
      });
    };
    for (const edit of [
      // The peer the resolve fetched, as another package's url.
      (packages: Record<string, any>) =>
        Object.assign(packages["host@1.0.0"], { resolved: url, integrity: evil }),
      // Named, and the edge no longer a peer.
      (packages: Record<string, any>) => {
        Object.assign(packages["host@1.0.0"], { name: "evil", integrity: evil });
        delete packages["plugin@1.0.0"].peers;
      },
      // Named, and put there by a package the lock adds, whose own package.json says so.
      (packages: Record<string, any>) => {
        Object.assign(packages["host@1.0.0"], { name: "evil", integrity: evil });
        packages["plugin@1.0.0"].dependencies.voucher = "1.0.0";
        packages["voucher@1.0.0"] = { integrity: voucher, dependencies: { host: "1.0.0" } };
      },
      // An own alias called a peer, given the package of the alias's name.
      (packages: Record<string, any>) => {
        lie(packages);
        const squatted = { name: undefined, resolved: undefined, integrity: squat };
        Object.assign(packages["q-cjs@1.0.0"], squatted);
      },
      // An own edge called a peer, given another package.
      (packages: Record<string, any>) => {
        lie(packages);
        Object.assign(packages["host@1.0.0"], { name: "evil", integrity: evil });
      },
    ]) {
      await locked(deps, edit);
      await refused("EMISMATCH");
    }
  });

  it("refuses a workspace's peer given another package", async () => {
    publish("host", "1.0.0");
    const evil = publish("evil", "1.0.0");
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    const peers = { name: "w", version: "1.0.0", peerDependencies: { host: "^1" } };
    await writeFile(join(dir, "packages", "w", "package.json"), JSON.stringify(peers));
    const manifest = { workspaces: ["packages/*"] };
    await locked(
      { evil: "^1" },
      (packages) => {
        const resolved = `${registry()}/evil/-/evil-1.0.0.tgz`;
        Object.assign(packages["host@1.0.0"], { resolved, integrity: evil });
      },
      manifest,
    );
    await refused("EMISMATCH");
  });

  it("takes a peer on what the root declares, and a package's own url", async () => {
    publish("real-host", "1.0.0");
    const tgz = makeTarball([
      { path: "package.json", data: '{ "name": "dep", "version": "1.0.0" }' },
      { path: "index.js", data: "module.exports = 'dep';\n" },
    ]);
    files["/dep.tgz"] = tgz;
    const url = `${registry()}/dep.tgz`;
    publish("plugin", "1.0.0", undefined, { dep: url }, { host: "^1", dep: "*" });
    publish("other", "1.0.0", undefined, undefined, { dep: "*" });
    // The root's alias of host and its url of dep are what plugin's and other's peers settle on.
    const deps = { host: "npm:real-host@^1", dep: url, plugin: "^1", other: "^1" };
    await locked(deps, () => {});
    for (const experimental of [base.experimental, pooled]) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen: true, experimental });
      const entry = (name: string) => realpath(join(dir, "node_modules", name));
      const beside = async (from: string, name: string) =>
        readFile(join(dirname(await entry(from)), name, "index.js"), "utf8");
      expect(await beside("plugin", "host")).toContain("real-host@1.0.0");
      expect(await beside("plugin", "dep")).toContain("'dep'");
      expect(await beside("other", "dep")).toContain("'dep'");
    }
  });

  it("takes a peer on what a dependency's own edge declares, however deep", async () => {
    publish("real-host", "1.0.0");
    const tgz = makeTarball([
      { path: "package.json", data: '{ "name": "host-fork", "version": "1.0.0" }' },
      { path: "index.js", data: "module.exports = 'host-fork';\n" },
    ]);
    files["/host.tgz"] = tgz;
    const url = `${registry()}/host.tgz`;
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    const soft = { peerDependenciesMeta: { host: { optional: true } } };
    publish("soft-plugin", "1.0.0", undefined, undefined, { host: "^1" }, soft);
    const alias = { host: "npm:real-host@^1" };
    // Each a package that installs host as another package, and a plugin on host beside it.
    publish("mid-a", "1.0.0", undefined, { ...alias, plugin: "^1" });
    publish("mid-b", "1.0.0", undefined, { plugin: "^1" }, undefined, {
      optionalDependencies: alias,
    });
    publish("mid-c", "1.0.0", undefined, { ...alias, "soft-plugin": "^1" });
    publish("mid-d", "1.0.0", undefined, { host: url, plugin: "^1" });
    // A peer its package.json also lists in devDependencies is still a peer alone.
    const dev = { devDependencies: { host: "^1" } };
    publish("dev-plugin", "1.0.0", undefined, undefined, { host: "^1" }, dev);
    publish("mid-e", "1.0.0", undefined, { ...alias, "dev-plugin": "^1" });
    publish("outer", "1.0.0", undefined, { "mid-a": "^1" });
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    const w = { name: "w", version: "1.0.0", peerDependencies: { host: "^1" } };
    await writeFile(join(dir, "packages", "w", "package.json"), JSON.stringify(w));
    // The root's deps, the path from the root to the plugin, and what its host must be.
    const cases: [object, string[], string, string[]?][] = [
      [{ "mid-a": "^1" }, ["mid-a", "plugin"], "real-host@1.0.0"],
      [{ "mid-b": "^1" }, ["mid-b", "plugin"], "real-host@1.0.0"],
      [{ "mid-c": "^1" }, ["mid-c", "soft-plugin"], "real-host@1.0.0"],
      [{ "mid-d": "^1" }, ["mid-d", "plugin"], "host-fork"],
      [{ "mid-e": "^1" }, ["mid-e", "dev-plugin"], "real-host@1.0.0"],
      [{ outer: "^1" }, ["outer", "mid-a", "plugin"], "real-host@1.0.0"],
      // A workspace's peer, on what a registry package installs.
      [{ "mid-a": "^1", w: "workspace:*" }, [], "real-host@1.0.0", ["packages/*"]],
    ];
    for (const [deps, path, host, workspaces] of cases) {
      await locked(deps, () => {}, workspaces ? { workspaces } : {});
      for (const experimental of [base.experimental, pooled]) {
        await rm(join(dir, "node_modules"), { recursive: true, force: true });
        await upm.install({ ...base, frozen: true, experimental });
        let at = join(dir, "packages", "w", "node_modules", "w");
        for (const [i, name] of path.entries()) {
          at = await realpath(join(i === 0 ? join(dir, "node_modules") : dirname(at), name));
        }
        expect(await readFile(join(dirname(at), "host", "index.js"), "utf8")).toContain(host);
      }
    }
  });

  it("takes a peer that a package.json with a BOM declares", async () => {
    publish("real-host", "1.0.0");
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    publish("mid", "1.0.0", undefined, { host: "npm:real-host@^1", plugin: "^1" });
    // The unpack reads a package.json without its BOM; so must the peer's check.
    const json = { name: "plugin", version: "1.0.0", peerDependencies: { host: "^1" } };
    const tgz = makeTarball([
      { path: "package.json", data: `﻿${JSON.stringify(json)}` },
      { path: "index.js", data: "module.exports = 'plugin';\n" },
    ]);
    files["/plugin/-/plugin-1.0.0.tgz"] = tgz;
    (docs["/plugin"] as any).versions["1.0.0"].dist.integrity = hashOf(tgz);
    await locked({ mid: "^1" }, () => {});
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    await upm.install({ ...base, frozen: true });
    const mid = await realpath(join(dir, "node_modules", "mid"));
    const plugin = await realpath(join(dirname(mid), "plugin"));
    expect(await readFile(join(dirname(plugin), "host", "index.js"), "utf8")).toContain(
      "real-host@1.0.0",
    );
  });

  it("refuses a peer on an alias that only an edge no package.json declares put there", async () => {
    publish("host", "1.0.0");
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    publish("mid", "1.0.0", undefined, { plugin: "^1" });
    const evil = publish("evil", "1.0.0");
    // A package of evil's own, which does alias host to it, given to mid by the lock alone:
    // as an edge, or as a peer.
    const voucher = publish("voucher", "1.0.0", undefined, { host: "npm:evil@^1" });
    for (const peer of [false, true]) {
      await locked({ mid: "^1", evil: "^1" }, (packages) => {
        Object.assign(packages["host@1.0.0"], { name: "evil", integrity: evil });
        packages["mid@1.0.0"].dependencies.voucher = "1.0.0";
        if (peer) {
          packages["mid@1.0.0"].peerDependencies = { voucher: "^1" };
          packages["mid@1.0.0"].peers = { voucher: "required" };
        }
        packages["voucher@1.0.0"] = { integrity: voucher, dependencies: { host: "1.0.0" } };
      });
      await refused("EMISMATCH");
    }
  });

  it("refuses an edge the lock calls a peer, on what the root or a package aliases", async () => {
    publish("host", "1.0.0");
    publish("real-host", "2.0.0");
    // mid aliases host, as the root may. other depends on host itself, not as a peer, and
    // soft names it only in peerDependenciesMeta, which makes no peer.
    publish("mid", "1.0.0", undefined, { host: "npm:real-host@^2" });
    publish("other", "1.0.0", undefined, { host: "^1" });
    const meta = { peerDependenciesMeta: { host: { optional: true } } };
    publish("soft", "1.0.0", undefined, undefined, undefined, meta);
    for (const deps of [{ mid: "^1" }, { host: "npm:real-host@^2" }]) {
      for (const lied of ["other", "soft"]) {
        await locked({ ...deps, [lied]: "^1" }, (packages) => {
          expect(packages["host@2.0.0"]).toMatchObject({ name: "real-host" });
          Object.assign(packages[`${lied}@1.0.0`], {
            dependencies: { host: "2.0.0" },
            peerDependencies: { host: "^1" },
            peers: { host: "required" },
          });
        });
        await refused("EMISMATCH");
      }
    }
  });

  it("takes a peer on what a package fetched as a peer declares", async () => {
    publish("real-host", "1.0.0");
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    // Nothing else installs kit: plugin-kit's peer fetches it.
    const kit = publish("kit", "1.0.0", undefined, { host: "npm:real-host@^1", plugin: "^1" });
    publish("plugin-kit", "1.0.0", undefined, undefined, { kit: "^1" });
    await locked({ "plugin-kit": "^1" }, () => {});
    const { createStore } = await import("../src/store.ts");
    for (const experimental of [base.experimental, pooled, base.experimental]) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen: true, experimental });
      let at = await realpath(join(dir, "node_modules", "plugin-kit"));
      for (const name of ["kit", "plugin"]) at = await realpath(join(dirname(at), name));
      expect(await readFile(join(dirname(at), "host", "index.js"), "utf8")).toContain(
        "real-host@1.0.0",
      );
      // Lost from the store, the package that vouches is fetched again, not taken as a lie.
      await rm(createStore({ dir: base.store! }).indexPath(kit));
    }
  });

  it("refuses a tarball where the spec names something else, and anything else for a tarball", async () => {
    publish("pkg-a", "1.0.0");
    publish("pkg-p", "1.0.0", undefined, { "pkg-a": "^1" });
    const tgz = (name: string, what: string) => {
      const bytes = makeTarball([
        { path: "package.json", data: JSON.stringify({ name, version: "1.0.0" }) },
        { path: "index.js", data: `module.exports = ${JSON.stringify(what)};\n` },
      ]);
      files[`/${what}.tgz`] = bytes;
      return { url: `${registry()}/${what}.tgz`, integrity: hashOf(bytes) };
    };
    const good = tgz("x", "good");
    const bad = tgz("pkg-a", "bad");
    // A registry spec given a tarball, as a root's edge and as a dependency's.
    const move = (from: string) => (packages: Record<string, any>, lock: any) => {
      const edges = from ? packages[from].dependencies : lock.root.dependencies;
      edges["pkg-a"] = bad.url;
      packages[`pkg-a@${bad.url}`] = { version: "1.0.0", integrity: bad.integrity };
      if (from) delete lock.root.dependencies["pkg-a"];
      delete packages["pkg-a@1.0.0"];
    };
    await locked({ "pkg-a": "^1" }, move(""));
    await refused("ELOCK");
    await locked({ "pkg-p": "^1" }, move("pkg-p@1.0.0"));
    await refused("EMISMATCH");
    // A tarball spec given another url.
    await locked({ x: good.url }, (packages, lock) => {
      lock.root.dependencies.x = bad.url;
      packages[`x@${bad.url}`] = { version: "1.0.0", integrity: bad.integrity };
      delete packages[`x@${good.url}`];
    });
    await refused("ELOCK");
    // A workspace spec given the registry package of its name.
    publish("w", "1.0.0");
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    await writeFile(
      join(dir, "packages", "w", "package.json"),
      '{ "name": "w", "version": "1.0.0" }',
    );
    await locked(
      { w: "workspace:*" },
      (packages, lock) => {
        lock.root.dependencies.w = "1.0.0";
        packages["w@1.0.0"] = { integrity: (docs["/w"] as any).versions["1.0.0"].dist.integrity };
      },
      { workspaces: ["packages/*"] },
    );
    await refused("ELOCK");
  });

  it("refuses a top's edge under a name every object has, and one a workspace has twice", async () => {
    publish("host", "1.0.0");
    const evil = publish("evil", "1.0.1", undefined, undefined, undefined, { bin: { tsc: "x" } });
    // The root's own edge no package.json declares, with a bin for its `.bin`.
    for (const name of ["constructor", "toString", "valueOf"]) {
      await locked({ evil: "^1" }, (packages, lock) => {
        lock.root.dependencies[name] = "1.0.1";
        packages[`${name}@1.0.1`] = { name: "evil", integrity: evil, bin: { tsc: "x" } };
      });
      await refused("ELOCK");
    }
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    const w = (more: object) =>
      writeFile(
        join(dir, "packages", "w", "package.json"),
        JSON.stringify({ name: "w", version: "1.0.0", ...more }),
      );
    const workspaces = { workspaces: ["packages/*"] };
    // A workspace's peer of such a name is a peer, held as one.
    publish("constructor", "1.0.0");
    await w({ peerDependencies: { constructor: "^1" } });
    await locked(
      { w: "workspace:*", evil: "^1" },
      (packages, lock) => {
        expect(lock.workspaces["packages/w"].peers).toEqual({ constructor: "required" });
        lock.workspaces["packages/w"].dependencies = { constructor: "1.0.1" };
        packages["constructor@1.0.1"] = { name: "evil", integrity: evil };
      },
      workspaces,
    );
    await refused("EMISMATCH");
    // An edge in both maps: the optional one is linked, so it is held to package.json too.
    await w({ dependencies: { host: "^1" } });
    await locked(
      { w: "workspace:*", evil: "^1" },
      (packages, lock) => {
        lock.workspaces["packages/w"].optionalDependencies = { host: "1.0.1" };
        packages["host@1.0.1"] = { name: "evil", integrity: evil };
      },
      workspaces,
    );
    await refused("ELOCK");
  });

  it("installs a package named as a property every object has, as any other", async () => {
    publish("constructor", "1.0.0");
    publish("uses", "1.0.0", undefined, { constructor: "^1" });
    // A peer no tree installs, which `--verify` must not take for one installed.
    const optional = { peerDependenciesMeta: { valueOf: { optional: true } } };
    publish("hopes", "1.0.0", undefined, undefined, { valueOf: "^1" }, optional);
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    const w = { name: "w", version: "1.0.0", peerDependencies: { constructor: "^1" } };
    await writeFile(join(dir, "packages", "w", "package.json"), JSON.stringify(w));
    const manifest = (more: object = {}) =>
      writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*"],
          dependencies: { w: "workspace:*" },
          devDependencies: { uses: "^1", hopes: "^1", ...more },
        }),
      );
    const peer = join(dir, "packages", "w", "node_modules", "constructor", "index.js");
    const own = async () => {
      const uses = await realpath(join(dir, "node_modules", "uses"));
      return readFile(join(dirname(uses), "constructor", "index.js"), "utf8");
    };
    await manifest();
    await upm.install(base);
    expect(await own()).toContain("constructor@1.0.0");
    // A resolve that keeps the locked tree keeps the edge too.
    publish("other", "1.0.0");
    await manifest({ other: "^1" });
    await upm.install(base);
    expect(await own()).toContain("constructor@1.0.0");
    lines.length = 0;
    await upm.install({ ...base, verify: true });
    expect(lines.filter((line) => line.includes("unmet peer"))).toEqual([]);
    // Only the workspace's peer ships, whether resolved or read from the lock.
    for (const frozen of [false, true]) {
      if (!frozen) await rm(join(dir, "upm.lock"));
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen, production: true });
      expect(await readFile(peer, "utf8")).toContain("constructor@1.0.0");
    }
  });

  it("takes a workspace's peer on what its devDependencies alias", async () => {
    publish("rolldown-vite", "7.1.0");
    const evil = publish("evil", "7.1.0");
    await mkdir(join(dir, "packages", "w"), { recursive: true });
    const w = {
      name: "w",
      version: "1.0.0",
      peerDependencies: { vite: "^7" },
      devDependencies: { vite: "npm:rolldown-vite@^7" },
    };
    await writeFile(join(dir, "packages", "w", "package.json"), JSON.stringify(w));
    await locked({ w: "workspace:*", evil: "^7" }, () => {}, { workspaces: ["packages/*"] });
    for (const experimental of [base.experimental, pooled]) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen: true, experimental });
      const vite = join(dir, "packages", "w", "node_modules", "vite", "index.js");
      expect(await readFile(vite, "utf8")).toContain("rolldown-vite@7.1.0");
    }
    // Held to that alias, not to any package.
    await locked(
      { w: "workspace:*", evil: "^7" },
      (packages) => Object.assign(packages["vite@7.1.0"], { name: "evil", integrity: evil }),
      { workspaces: ["packages/*"] },
    );
    await refused("ELOCK");
  });

  it("takes a peer on a scoped alias, a JSR one, and the root's alias of vite", async () => {
    publish("@jsr/std__path", "1.0.0");
    publish("rolldown-vite", "7.1.0");
    publish("plugin", "1.0.0", undefined, undefined, { "@std/path": "^1" });
    const path = { "@std/path": "npm:@jsr/std__path@^1" };
    publish("mid", "1.0.0", undefined, { ...path, plugin: "^1" });
    const optional = { peerDependenciesMeta: { vite: { optional: true } } };
    publish("@vitest/mocker", "3.0.0", undefined, undefined, { vite: "^7" }, optional);
    publish("vitest", "3.0.0", undefined, { "@vitest/mocker": "3.0.0" }, { vite: "^7" });
    publish("@vitejs/plugin-vue", "6.0.0", undefined, undefined, { vite: "^7" });
    publish("kit", "1.0.0", undefined, { "@vitejs/plugin-vue": "^6", vitest: "^3" });
    const vite = { vite: "npm:rolldown-vite@^7", vitest: "^3", kit: "^1" };
    const cases: [object, string[], string, string][] = [
      [{ mid: "^1" }, ["mid", "plugin"], "@std/path", "@jsr/std__path@1.0.0"],
      [{ ...path, plugin: "^1" }, ["plugin"], "@std/path", "@jsr/std__path@1.0.0"],
      [vite, ["vitest", "@vitest/mocker"], "vite", "rolldown-vite@7.1.0"],
      [vite, ["kit", "@vitejs/plugin-vue"], "vite", "rolldown-vite@7.1.0"],
    ];
    for (const [deps, chain, peer, real] of cases) {
      await locked(deps, () => {});
      for (const experimental of [base.experimental, pooled]) {
        await rm(join(dir, "node_modules"), { recursive: true, force: true });
        await upm.install({ ...base, frozen: true, experimental });
        let at = join(dir, "node_modules", "x");
        for (const name of chain) at = await realpath(join(dirname(at), name));
        // A scoped package sits one directory deeper.
        const nm = chain.at(-1)!.includes("/") ? dirname(dirname(at)) : dirname(at);
        expect(await readFile(join(nm, peer, "index.js"), "utf8")).toContain(real);
      }
    }
  });

  it("takes a peer on what a tarball at the root aliases", async () => {
    publish("real-host", "1.0.0");
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    const kit = {
      name: "kit",
      version: "1.0.0",
      dependencies: { host: "npm:real-host@^1", plugin: "^1" },
    };
    const tgz = makeTarball([
      { path: "package.json", data: JSON.stringify(kit) },
      { path: "index.js", data: "module.exports = 'kit';\n" },
    ]);
    await writeFile(join(dir, "kit.tgz"), tgz);
    await locked({ kit: "file:kit.tgz" }, () => {});
    for (const experimental of [base.experimental, pooled]) {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      await upm.install({ ...base, frozen: true, experimental });
      const plugin = await realpath(
        join(await realpath(join(dir, "node_modules", "kit")), "..", "plugin"),
      );
      expect(await readFile(join(dirname(plugin), "host", "index.js"), "utf8")).toContain(
        "real-host@1.0.0",
      );
    }
  });

  it("refuses a peer the walk would reach only through a name its dependent never aliased", async () => {
    publish("host", "1.0.0");
    publish("plugin", "1.0.0", undefined, undefined, { host: "^1" });
    publish("kit", "1.0.0");
    const evil = publish("evil", "1.0.0");
    // A package of evil's own, which does alias host to it.
    const voucher = publish("voucher", "1.0.0", undefined, { host: "npm:evil@^1" });
    publish("mid", "1.0.0", undefined, { kit: "^1", plugin: "^1" });
    // mid declares kit: the lock makes it voucher, as an alias, or gives kit voucher's tarball.
    for (const alias of [true, false]) {
      await locked({ mid: "^1", evil: "^1", voucher: "^1" }, (packages) => {
        packages["kit@1.0.0"] = {
          ...(alias && { name: "voucher" }),
          integrity: voucher,
          dependencies: { host: "1.0.0" },
        };
        Object.assign(packages["host@1.0.0"], { name: "evil", integrity: evil });
        Object.assign(packages["plugin@1.0.0"], {
          dependencies: { host: "1.0.0" },
          peers: { host: "required" },
        });
      });
      await refused("EMISMATCH");
    }
  });

  it("refuses an edge the lock calls a peer on the root's tarball, under --prod too", async () => {
    const tgz = makeTarball([
      { path: "package.json", data: '{ "name": "host", "version": "1.0.0" }' },
      { path: "index.js", data: "module.exports = 'tarball';\n" },
    ]);
    await writeFile(join(dir, "host.tgz"), tgz);
    publish("host", "1.0.0");
    publish("other", "1.0.0", undefined, { host: "^1" });
    await locked({ host: "file:host.tgz", other: "^1" }, (packages) => {
      Object.assign(packages["other@1.0.0"], {
        dependencies: { host: "file:host.tgz" },
        peerDependencies: { host: "^1" },
        peers: { host: "required" },
      });
    });
    await refused("EMISMATCH");
    for (const experimental of [base.experimental, pooled]) {
      const prod = { ...base, frozen: true, production: true, experimental };
      await expect(upm.install(prod)).rejects.toMatchObject({ code: "EMISMATCH" });
      // Nothing says the tree is done.
      await expect(stat(join(dir, "node_modules", ".upm.json"))).rejects.toThrow();
    }
  });
});

describe("the order a store is filled in", () => {
  const pkg = (name: string, dependencies: Record<string, string> = {}, local?: string) => ({
    name,
    version: local ? `link:${local}` : "1.0.0",
    resolved: "",
    integrity: "",
    dependencies,
    optional: false,
    dev: false,
    bin: {},
    ...(local && { local }),
  });

  it("asks for what the tops depend on first, then breadth first, and drops nothing", async () => {
    const { nearestFirst } = await import("../src/api.ts");
    const packages = {
      "a-leaf@1.0.0": pkg("a-leaf"),
      "b-mid@1.0.0": pkg("b-mid", { "a-leaf": "1.0.0" }),
      "z-top@1.0.0": pkg("z-top", { "b-mid": "1.0.0" }),
      "y-ws-dep@1.0.0": pkg("y-ws-dep"),
      "stray@1.0.0": pkg("stray"),
      "ws@link:packages/ws": pkg("ws", { "y-ws-dep": "1.0.0" }, "packages/ws"),
    };
    const resolution = { root: { dependencies: { "z-top": "1.0.0" } }, packages, warnings: [] };
    const wanted = Object.values(packages).filter((each) => !("local" in each));
    const order = nearestFirst(resolution, wanted).map((each) => each.name);
    // Key order would have been a-leaf, b-mid, stray, y-ws-dep, z-top.
    expect(order).toEqual(["z-top", "y-ws-dep", "b-mid", "a-leaf", "stray"]);
  });
});

describe("a locked version newer than the release cutoff", () => {
  const said = (text: string) => lines.filter((line) => line.includes(text));
  const cold = async () => {
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    await rm(join(dir, "store"), { recursive: true, force: true });
    lines.length = 0;
  };

  it("is told by its tarball's last-modified, never for a version the resolve picked", async () => {
    const options = { ...base, minReleaseAge: 1 };
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    lastModified = new Date().toUTCString();
    // The registry gives no dates, so the pick takes it: the resolve saw it, and says so itself.
    await upm.install(options);
    expect(said("release cutoff, as")).toEqual([]);

    // The lockfile's word alone, as from a machine without the cutoff.
    await cold();
    await upm.install({ ...options, frozen: true });
    expect(said("release cutoff, as")).toEqual([
      expect.stringMatching(/^locked versions published after .*: nanoid@5\.0\.0 \(20/),
    ]);
    // In the store already, it is not downloaded, so nothing is said.
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    lines.length = 0;
    await upm.install({ ...options, frozen: true });
    expect(said("release cutoff, as")).toEqual([]);

    // Nor when the lockfile came through a non-frozen install that took it as it was.
    await cold();
    await upm.install(options);
    expect(said("release cutoff, as")).toHaveLength(1);
  });

  it("is not told for what only newer packages depend on, as a platform build", async () => {
    const tgz = makeTarball([
      { path: "package.json", data: JSON.stringify({ name: "host", version: "1.0.0" }) },
    ]);
    files["/host/-/host-1.0.0.tgz"] = tgz;
    const manifest = {
      name: "host",
      version: "1.0.0",
      dependencies: { nanoid: "5.0.0" },
      dist: { tarball: `${registry()}/host/-/host-1.0.0.tgz`, integrity: hashOf(tgz) },
    };
    docs["/host"] = {
      name: "host",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": manifest },
    };
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { host: "^1" } }));
    await upm.install(base);
    lastModified = new Date().toUTCString();
    await cold();
    await upm.install({ ...base, minReleaseAge: 1, frozen: true });
    expect(said("release cutoff, as")).toEqual([expect.stringMatching(/: host@1\.0\.0 \([^,]*$/)]);
    await cold();
    await upm.install({ ...base, minReleaseAge: 1, minReleaseAgeExclude: ["host"], frozen: true });
    expect(said("release cutoff, as")).toEqual([]);
    // An older package asks for it, so its pin does not explain it.
    const old = new Date(Date.now() - 2 * 86_400_000).toUTCString();
    lastModified = (url) => (url.startsWith("/host/") ? old : new Date().toUTCString());
    await cold();
    await upm.install({ ...base, minReleaseAge: 1, frozen: true });
    expect(said("release cutoff, as")).toEqual([
      expect.stringMatching(/: nanoid@5\.0\.0 \([^,]*$/),
    ]);
  });

  it("is not told when it is older, excluded, pinned exactly or the cutoff is off", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { nanoid: "^5" } }));
    await upm.install(base);
    const frozen = async (options: upm.InstallOptions) => {
      await cold();
      await upm.install({ ...base, minReleaseAge: 1, ...options, frozen: true });
      return said("release cutoff, as");
    };
    lastModified = new Date(Date.now() - 2 * 86_400_000).toUTCString();
    expect(await frozen({})).toEqual([]);
    lastModified = new Date().toUTCString();
    expect(await frozen({})).toHaveLength(1);
    expect(await frozen({ minReleaseAge: 0 })).toEqual([]);
    expect(await frozen({ minReleaseAgeExclude: ["nano*"] })).toEqual([]);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { nanoid: "5.0.0" } }),
    );
    await upm.install(base);
    expect(await frozen({})).toEqual([]);
  });

  it("names ten of a long list and counts the rest", () => {
    const packages = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `p${i}@1.0.0`,
        { name: `p${i}`, version: "1.0.0", resolved: "", integrity: `sha512-${i}`, bin: {} },
      ]),
    );
    const deps = Object.fromEntries(Object.values(packages).map((p) => [p.name, "1.0.0"]));
    const newer = new Map(Object.values(packages).map((p) => [p.integrity, 0]));
    const told: string[] = [];
    const resolution = {
      root: { dependencies: deps },
      packages: Object.fromEntries(
        Object.entries(packages).map(([key, p]) => [
          key,
          { ...p, dependencies: {}, optional: false, dev: false },
        ]),
      ),
      warnings: [],
    };
    const project = { manifest: {}, workspaces: [] };
    warnNewer({ log: (line) => told.push(line) }, newer, project, resolution);
    expect(told).toEqual([
      expect.stringMatching(/: p0@1\.0\.0 .* p9@1\.0\.0 \([^,]*\) and 2 more \(/),
    ]);
  });
});
