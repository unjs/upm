// The commands as functions, against a local registry: every CLI command has one.
import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as upm from "../src/index.ts";
import { parseLockfile } from "../src/resolver.ts";
import { stampOf } from "../src/state.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

const tarball = makeTarball([{ path: "index.js", data: 'module.exports = "nanoid";\n' }]);

let dir: string;
let server: Server;
let lines: string[];
let base: upm.InstallOptions;
/** Tarballs served by path besides the registry's, and each request for one. */
let files: Record<string, Uint8Array>;
let served: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-api-"));
  lines = [];
  files = {};
  served = [];
  server = createServer((request, response) => {
    const url = request.url ?? "";
    if (Object.hasOwn(files, url)) {
      served.push(url);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(files[url]!));
      return;
    }
    if (url === "/nanoid/-/nanoid-5.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
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

  it("fails an offline install missing an optional, rather than skip it", async () => {
    const optionalDependencies = { nanoid: "^5" };
    await writeFile(join(dir, "package.json"), JSON.stringify({ optionalDependencies }));
    await upm.lock(base);
    const fresh = { ...base, store: join(dir, "fresh"), offline: true };
    await expect(upm.install(fresh)).rejects.toMatchObject({ code: "EOFFLINE" });
    // Online, the same store is filled.
    expect(await upm.install({ ...fresh, offline: false })).toMatchObject({ packages: 1 });
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

  describe("a local tarball changed in place", () => {
    const source = "file:vendor/local-2.0.0.tgz";
    const file = () => join(dir, "vendor", "local-2.0.0.tgz");
    const next = makeTarball([
      { path: "package.json", data: '{"name":"local","version":"2.0.1"}' },
      { path: "index.js", data: 'module.exports = "local two";\n' },
    ]);
    const state = async () => await readJson(join(dir, "node_modules", ".upm.json"));

    beforeEach(async () => {
      const dependencies = { local: source, remote: url() };
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
      await upm.install(base);
      expect((await state()).tarballs).toEqual({ [source]: stampOf(file()) });
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
      expect((await state()).tarballs).toEqual({ [source]: stampOf(file()) });
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
      expect((await state()).tarballs).toEqual({ [source]: stampOf(file()) });
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
    expect(state.tarballs).toEqual({ "file:vendor/local-2.0.0.tgz": stampOf(file) });
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
