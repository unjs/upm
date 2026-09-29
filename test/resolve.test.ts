import { afterEach, describe, expect, it, vi } from "vitest";
import { builtin } from "../src/builtin.ts";
import { storeKeys } from "../src/keys.ts";
import { formatLockfile, fromLockfile, parseLockfile, toLockfile } from "../src/lock.ts";
import { viewOf } from "../src/pick.ts";
import type { Registry } from "../src/registry.ts";
import { allDeps, filterPlatform, resolveTree, unmetPeers } from "../src/resolve.ts";
import type {
  Platform,
  ResolveOptions,
  ResolvedPackage,
  Resolution,
  RootManifest,
} from "../src/resolve.ts";
import type { Manifest, Packument } from "../src/types.ts";

type Spec = Partial<Manifest> & { version?: string };
type Fixture = Record<string, Record<string, Spec>>;

const LINUX: Platform = { os: "linux", cpu: "x64", libc: "glibc" };
const WINDOWS: Platform = { os: "win32", cpu: "x64" };

/** Resolution is platform-blind now, so a test that cares says which platform it means. */
const on = (target: Platform) => (resolution: Resolution) => filterPlatform(resolution, target);
const linux = on(LINUX);

/**
 * A registry backed by inline fixtures, counting calls per package name. Pass `full` to model
 * the abbreviated packument: `fixture` is what the resolver sees, `full` what `manifest` adds.
 * Name a package in `huge` and its packument is too big to read, so `pinned` falls to the
 * per-version route the way the real client does.
 */
function fake(fixture: Fixture, full: Fixture = fixture, huge = new Set<string>()) {
  const calls: string[] = []; // packument reads, abandoned ones included
  const manifests: string[] = []; // per-version reads
  const seen = new Map<string, Manifest | undefined>();
  const read = new Set<string>(); // packuments `pinned` already read whole
  const build = (source: Fixture, name: string, version: string): Manifest => ({
    name,
    version,
    dist: {
      tarball: `https://r/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${name}${version}`,
    },
    ...source[name]?.[version],
  });
  // Both single-version routes share one memo, as the real client does.
  const load = (name: string, version: string): Manifest | undefined => {
    const key = `${name}@${version}`;
    if (!seen.has(key)) {
      manifests.push(key);
      seen.set(key, full[name]?.[version] ? build(full, name, version) : undefined);
    }
    return seen.get(key);
  };
  const registry: Registry = {
    base: "https://r",
    baseFor: () => "https://r",
    view: async (name) => viewOf(await registry.packument(name)),
    async packument(name) {
      if (!read.has(name)) calls.push(name); // a document already read whole is free
      const versions = fixture[name];
      if (!versions) throw Object.assign(new Error(`404 ${name}`), { code: "E404" });
      const out: Record<string, Manifest> = {};
      for (const version of Object.keys(versions)) out[version] = build(fixture, name, version);
      const latest = Object.keys(versions).at(-1) as string;
      return { name, "dist-tags": { latest }, versions: out } satisfies Packument;
    },
    async manifest(name, version) {
      const found = load(name, version);
      if (!found) throw Object.assign(new Error(`404 ${name}@${version}`), { code: "E404" });
      return found;
    },
    async pinned(name, version) {
      calls.push(name);
      if (huge.has(name)) return load(name, version);
      read.add(name);
      return fixture[name]?.[version] ? build(fixture, name, version) : undefined;
    },
  };
  return {
    registry,
    calls,
    manifests,
    count: (name: string) => calls.filter((c) => c === name).length,
  };
}

function run(fixture: Fixture, root: RootManifest, options: ResolveOptions = {}) {
  const { registry, count, calls, manifests } = fake(fixture);
  return {
    count,
    calls,
    manifests,
    result: resolveTree(root, { registry, ...options }),
  };
}

async function resolve(fixture: Fixture, root: RootManifest, options: ResolveOptions = {}) {
  return await run(fixture, root, options).result;
}

describe("basic walk", () => {
  const fixture: Fixture = {
    a: { "1.0.0": { dependencies: { b: "^2" } } },
    b: { "2.0.0": {}, "2.5.0": {} },
  };

  it("resolves a simple tree", async () => {
    const out = await resolve(fixture, {
      name: "root",
      version: "0.0.0",
      dependencies: { a: "^1" },
    });
    expect(out.root).toEqual({
      name: "root",
      version: "0.0.0",
      specs: { dependencies: { a: "^1" } },
      dependencies: { a: "1.0.0" },
    });
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@2.5.0"]);
    expect(out.packages["a@1.0.0"]).toMatchObject({
      name: "a",
      version: "1.0.0",
      resolved: "https://r/a/-/a-1.0.0.tgz",
      integrity: "sha512-a1.0.0",
      dependencies: { b: "2.5.0" },
      optional: false,
      bin: {},
    });
    expect(out.warnings).toEqual([]);
  });

  it("normalizes bin", async () => {
    const out = await resolve(
      { a: { "1.0.0": { bin: "./cli/../cli.js" } } },
      { dependencies: { a: "1" } },
    );
    expect(out.packages["a@1.0.0"]?.bin).toEqual({ a: "cli.js" });
  });

  it("falls back to a legacy shasum for integrity", async () => {
    const out = await resolve(
      { a: { "1.0.0": { dist: { tarball: "https://r/a.tgz", shasum: "a".repeat(40) } } } },
      { dependencies: { a: "1" } },
    );
    expect(out.packages["a@1.0.0"]?.integrity).toMatch(/^sha1-/);
  });

  it("fetches each packument once for a shared transitive dep", async () => {
    const shared: Fixture = {
      a: { "1.0.0": { dependencies: { c: "^1" } } },
      b: { "1.0.0": { dependencies: { c: "^1" } } },
      c: { "1.0.0": {} },
    };
    const job = run(shared, { dependencies: { a: "^1", b: "^1" } });
    const out = await job.result;
    expect(job.count("c")).toBe(1);
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
  });

  it("keeps two versions of one package side by side", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { c: "^1" } } },
        b: { "1.0.0": { dependencies: { c: "^2" } } },
        c: { "1.0.0": {}, "2.0.0": {} },
      },
      { dependencies: { a: "^1", b: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0", "c@2.0.0"]);
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ c: "1.0.0" });
    expect(out.packages["b@1.0.0"]?.dependencies).toEqual({ c: "2.0.0" });
  });

  it("records the declared ranges it resolved from", async () => {
    const out = await resolve(fixture, {
      dependencies: { a: "^1" },
      devDependencies: { b: "^2" },
      optionalDependencies: {},
    });
    // Empty groups are left out, so an added-then-removed group is not a diff.
    expect(out.root.specs).toEqual({ dependencies: { a: "^1" }, devDependencies: { b: "^2" } });
    expect(await resolve(fixture, { dependencies: {} }).then((r) => r.root.specs)).toBeUndefined();
  });
});

describe("dev dependencies", () => {
  it("resolves devDependencies and marks the subtree dev", async () => {
    const out = await resolve(
      {
        prod: { "1.0.0": {} },
        tool: { "1.0.0": { dependencies: { helper: "^1" } } },
        helper: { "1.0.0": {} },
      },
      { dependencies: { prod: "^1" }, devDependencies: { tool: "^1" } },
    );
    expect(out.root.dependencies).toEqual({ prod: "1.0.0", tool: "1.0.0" });
    expect(out.packages["prod@1.0.0"]?.dev).toBe(false);
    expect(out.packages["tool@1.0.0"]?.dev).toBe(true);
    expect(out.packages["helper@1.0.0"]?.dev).toBe(true);
  });

  it("marks a package non-dev when it is reachable both ways", async () => {
    const fixture: Fixture = {
      prod: { "1.0.0": { dependencies: { shared: "^1" } } },
      tool: { "1.0.0": { dependencies: { shared: "^1" } } },
      shared: { "1.0.0": { dependencies: { under: "^1" } } },
      under: { "1.0.0": {} },
    };
    const out = await resolve(fixture, {
      dependencies: { prod: "^1" },
      devDependencies: { tool: "^1" },
    });
    expect(out.packages["shared@1.0.0"]?.dev).toBe(false);
    expect(out.packages["under@1.0.0"]?.dev).toBe(false);

    // Order of discovery must not matter.
    const flipped = await resolve(fixture, {
      devDependencies: { tool: "^1" },
      dependencies: { prod: "^1" },
    });
    expect(flipped.packages["shared@1.0.0"]?.dev).toBe(false);
  });

  it("marks a direct devDependency non-dev when a prod package needs it too", async () => {
    const out = await resolve(
      { a: { "1.0.0": { dependencies: { b: "^2" } } }, b: { "2.5.0": {} } },
      { dependencies: { a: "^1" }, devDependencies: { b: "^2" } },
    );
    expect(out.packages["b@2.5.0"]?.dev).toBe(false);
  });

  it("keeps a dev dep out of the optional flag and vice versa", async () => {
    const out = await resolve(
      { tool: { "1.0.0": {} }, opt: { "1.0.0": {} } },
      { devDependencies: { tool: "^1" }, optionalDependencies: { opt: "^1" } },
    );
    expect(out.packages["tool@1.0.0"]).toMatchObject({ dev: true, optional: false });
    // optionalDependencies are production, so they are never dev.
    expect(out.packages["opt@1.0.0"]).toMatchObject({ dev: false, optional: true });
  });
});

describe("cycles", () => {
  it("handles a self cycle", async () => {
    const out = await resolve(
      { a: { "1.0.0": { dependencies: { a: "^1" } } } },
      { dependencies: { a: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0"]);
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ a: "1.0.0" });
  });

  it("handles an a -> b -> a cycle", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { b: "^1" } } },
        b: { "1.0.0": { dependencies: { a: "^1" } } },
      },
      { dependencies: { a: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(out.packages["b@1.0.0"]?.dependencies).toEqual({ a: "1.0.0" });
  });

  it("handles a longer cycle reached from two sides", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { b: "^1" } } },
        b: { "1.0.0": { dependencies: { c: "^1" } } },
        c: { "1.0.0": { dependencies: { a: "^1", b: "^1" } } },
      },
      { dependencies: { a: "^1", c: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
  });
});

describe("optional dependencies", () => {
  it("survives an optional dep that 404s", async () => {
    const out = await resolve(
      { a: { "1.0.0": {} } },
      { dependencies: { a: "^1" }, optionalDependencies: { gone: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0"]);
    expect(out.root.dependencies).toEqual({ a: "1.0.0" });
    expect(out.warnings).toEqual([expect.stringContaining("skipped optional gone@^1 of root")]);
  });

  it("survives an optional dep with no matching version", async () => {
    const out = await resolve({ a: { "1.0.0": {} } }, { optionalDependencies: { a: "^9" } });
    expect(out.packages).toEqual({});
    expect(out.warnings[0]).toContain("No matching version found");
  });

  it("fails an optional dep it could not ask the registry for, offline", async () => {
    const { registry } = fake({ a: { "1.0.0": {} } });
    const packument = registry.packument;
    registry.packument = async (name) => {
      if (name !== "opt") return await packument(name);
      throw Object.assign(new Error("offline: cannot ask the registry for opt"), {
        code: "EOFFLINE",
      });
    };
    const root = { dependencies: { a: "^1" }, optionalDependencies: { opt: "^1" } };
    await expect(resolveTree(root, { registry })).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("rejects when a required dep 404s", async () => {
    await expect(resolve({}, { dependencies: { gone: "^1" } })).rejects.toMatchObject({
      code: "E404",
    });
  });

  it("names the failing edge and its dependent", async () => {
    const failing = resolve(
      { a: { "1.0.0": { dependencies: { gone: "^2" } } } },
      { dependencies: { a: "^1" } },
    );
    await expect(failing).rejects.toMatchObject({ code: "E404" });
    await expect(failing).rejects.toThrow("gone@^2 (required by a@1.0.0)");
  });

  it("drops the whole optional subtree when something inside it fails", async () => {
    const out = await resolve(
      { opt: { "1.0.0": { dependencies: { gone: "^1" } } } },
      { optionalDependencies: { opt: "^1" } },
    );
    expect(out.packages).toEqual({});
    // prune reports the resolved version; edge reports the range. Both name the same drop.
    expect(out.warnings).toEqual([expect.stringContaining("skipped optional opt@")]);
  });

  it("inherits optionality through a subtree", async () => {
    const out = await resolve(
      {
        opt: { "1.0.0": { dependencies: { deep: "^1" } } },
        deep: { "1.0.0": { dependencies: { deeper: "^1" } } },
        deeper: { "1.0.0": {} },
      },
      { optionalDependencies: { opt: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["deep@1.0.0", "deeper@1.0.0", "opt@1.0.0"]);
    for (const p of Object.values(out.packages)) expect(p.optional).toBe(true);
  });

  it("marks a package required when it is reachable both ways", async () => {
    const fixture: Fixture = {
      opt: { "1.0.0": { dependencies: { shared: "^1" } } },
      req: { "1.0.0": { dependencies: { shared: "^1" } } },
      shared: { "1.0.0": { dependencies: { under: "^1" } } },
      under: { "1.0.0": {} },
    };
    const root = { dependencies: { req: "^1" }, optionalDependencies: { opt: "^1" } };
    const out = await resolve(fixture, root);
    expect(out.packages["shared@1.0.0"]?.optional).toBe(false);
    expect(out.packages["under@1.0.0"]?.optional).toBe(false);
    expect(out.packages["opt@1.0.0"]?.optional).toBe(true);
    expect(out.packages["req@1.0.0"]?.optional).toBe(false);

    // Order of discovery must not matter.
    const flipped = await resolve(fixture, {
      optionalDependencies: { opt: "^1" },
      dependencies: { req: "^1" },
    });
    expect(flipped.packages["shared@1.0.0"]?.optional).toBe(false);
  });

  it("treats a dep listed in both dependencies and optionalDependencies as optional", async () => {
    const out = await resolve(
      { a: { "1.0.0": {} } },
      { dependencies: { gone: "^1" }, optionalDependencies: { gone: "^1" } },
    );
    expect(out.packages).toEqual({});
    expect(out.warnings).toHaveLength(1);
  });
});

describe("platform filtering", () => {
  const onlyWin: Fixture = { w: { "1.0.0": { os: ["win32"] } } };

  it("locks every platform's build, whatever platform resolved it", async () => {
    const out = await resolve(onlyWin, { optionalDependencies: { w: "^1" } });
    // The whole point: the file does not depend on the machine that wrote it.
    expect(Object.keys(out.packages)).toEqual(["w@1.0.0"]);
    expect(out.packages["w@1.0.0"]?.os).toEqual(["win32"]);
    expect(out.warnings).toEqual([]);
  });

  it("keeps the two edge kinds apart, so an install knows what it may drop", async () => {
    const out = await resolve(
      {
        host: { "1.0.0": { dependencies: { need: "^1" }, optionalDependencies: { w: "^1" } } },
        need: { "1.0.0": {} },
        ...onlyWin,
      },
      { dependencies: { host: "^1" } },
    );
    expect(out.packages["host@1.0.0"]?.dependencies).toEqual({ need: "1.0.0" });
    expect(out.packages["host@1.0.0"]?.optionalDependencies).toEqual({ w: "1.0.0" });
    expect(out.packages["need@1.0.0"]?.optionalDependencies).toBeUndefined();
  });

  it("errors on a required dep whose os does not match", async () => {
    const out = await resolve(onlyWin, { dependencies: { w: "^1" } });
    expect(() => linux(out)).toThrow(expect.objectContaining({ code: "EBADPLATFORM" }));
    expect(() => linux(out)).toThrow("does not run on linux-x64-glibc");
  });

  it("drops an optional dep whose os does not match, and says nothing about it", async () => {
    const out = linux(await resolve(onlyWin, { optionalDependencies: { w: "^1" } }));
    expect(out.packages).toEqual({});
    expect(out.root.dependencies).toEqual({});
    // Every lockfile is mostly other platforms; a warning each would drown the install.
    expect(out.warnings).toEqual([]);
  });

  it("filters on cpu and libc too", async () => {
    const fixture: Fixture = {
      arm: { "1.0.0": { cpu: ["arm64"] } },
      musl: { "1.0.0": { libc: ["musl"] } },
    };
    const out = await resolve(fixture, { optionalDependencies: { arm: "^1", musl: "^1" } });
    expect(Object.keys(out.packages)).toEqual(["arm@1.0.0", "musl@1.0.0"]);
    expect(linux(out).packages).toEqual({});
  });

  it("gives each platform its own build out of the one lockfile", async () => {
    const fixture: Fixture = {
      gnu: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
      musl: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["musl"] } },
      win: { "1.0.0": { os: ["win32"], cpu: ["x64"] } },
      host: { "1.0.0": { optionalDependencies: { gnu: "^1", musl: "^1", win: "^1" } } },
    };
    const out = await resolve(fixture, { dependencies: { host: "^1" } });
    const at = (target: Platform) => Object.keys(on(target)(out).packages);
    expect(at(LINUX)).toEqual(["gnu@1.0.0", "host@1.0.0"]);
    expect(at({ os: "linux", cpu: "x64", libc: "musl" })).toEqual(["host@1.0.0", "musl@1.0.0"]);
    expect(at(WINDOWS)).toEqual(["host@1.0.0", "win@1.0.0"]);
  });

  it("picks one of a glibc/musl pair on this machine, with no target given", async () => {
    // The other libc tests name a target; this one exercises `currentPlatform`, which is what
    // actually reads the running libc. If that detection ever returns nothing on linux, both
    // builds are dropped instead of one — silently, because they are optional.
    const fixture: Fixture = {
      gnu: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
      musl: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["musl"] } },
      host: { "1.0.0": { optionalDependencies: { gnu: "^1", musl: "^1" } } },
    };
    const out = await resolve(fixture, { dependencies: { host: "^1" } });
    const here = Object.keys(filterPlatform(out).packages);
    expect(here).toContain("host@1.0.0");
    const builds = here.filter((key) => key !== "host@1.0.0");
    if (process.platform === "linux" && process.arch === "x64") {
      // Exactly one — never both, which is what installing 100+ MB of unloadable binary is.
      expect(builds).toHaveLength(1);
      expect(["gnu@1.0.0", "musl@1.0.0"]).toContain(builds[0]);
    } else {
      expect(builds).toEqual([]); // wrong os or cpu: neither build belongs here
    }
  });

  describe.skipIf(process.platform !== "linux")("tells glibc from musl by what is mapped", () => {
    // `/proc/self/maps` names the libc file: `libc.so.6` since glibc 2.34, `libc-2.<minor>.so`
    // before it (Debian 11, Ubuntu 20.04, RHEL 8), musl's loader on Alpine. The diagnostic
    // report is the slow way to the same answer and must only be built when maps say nothing.
    const fixture: Fixture = {
      gnu: { "1.0.0": { os: ["linux"], cpu: [process.arch], libc: ["glibc"] } },
      musl: { "1.0.0": { os: ["linux"], cpu: [process.arch], libc: ["musl"] } },
      host: { "1.0.0": { optionalDependencies: { gnu: "^1", musl: "^1" } } },
    };
    const line = (file: string) => `7f4a 00000000 fd:01 1 /usr/lib/${file}\n`;
    const cases: [maps: string | undefined, build: string, reports: number][] = [
      [line("libc.so.6") + line("ld-linux-x86-64.so.2"), "gnu@1.0.0", 0],
      [line("libc-2.31.so") + line("ld-2.31.so"), "gnu@1.0.0", 0],
      [line("ld-musl-x86_64.so.1"), "musl@1.0.0", 0],
      [line("libnode.so.1"), "gnu@1.0.0", 1], // maps say nothing: the report decides
      [undefined, "gnu@1.0.0", 1], // no /proc at all
    ];
    afterEach(() => vi.restoreAllMocks());

    it.each(cases)("maps %j picks %s", async (maps, build, reports) => {
      const read = vi.spyOn(builtin.fs, "readFileSync").mockImplementation((file) => {
        if (file !== "/proc/self/maps") throw new Error(`unexpected read of ${String(file)}`);
        if (maps === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return maps;
      });
      const report = vi
        .spyOn(process.report!, "getReport")
        .mockReturnValue({ header: { glibcVersionRuntime: "2.31" } } as never);
      const out = await resolve(fixture, { dependencies: { host: "^1" } });
      expect(Object.keys(filterPlatform(out).packages).sort()).toEqual(
        [build, "host@1.0.0"].sort(),
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(reports);
    });
  });

  it("reads libc from the full manifest when the packument does not say", async () => {
    // What the abbreviated document says: a linux-x64 build with no libc at all.
    const corgi: Fixture = {
      "@img/sharp-linux-x64": { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
      "@img/sharp-linuxmusl-x64": { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
    };
    const full: Fixture = {
      "@img/sharp-linux-x64": { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
      "@img/sharp-linuxmusl-x64": { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["musl"] } },
    };
    const { registry, manifests } = fake(corgi, full);
    const out = await resolveTree(
      { optionalDependencies: { "@img/sharp-linux-x64": "^1", "@img/sharp-linuxmusl-x64": "^1" } },
      { registry },
    );
    // Without libc in the lockfile an install could not tell these two apart and would take both.
    expect(out.packages["@img/sharp-linux-x64@1.0.0"]?.libc).toEqual(["glibc"]);
    expect(out.packages["@img/sharp-linuxmusl-x64@1.0.0"]?.libc).toEqual(["musl"]);
    expect(Object.keys(linux(out).packages)).toEqual(["@img/sharp-linux-x64@1.0.0"]);
    expect(manifests.sort()).toEqual([
      "@img/sharp-linux-x64@1.0.0",
      "@img/sharp-linuxmusl-x64@1.0.0",
    ]);
  });

  it("tells onPick a linux build only once its libc is read, and walks on meanwhile", async () => {
    const corgi: Fixture = {
      "@img/sharp-linux-x64": {
        "1.0.0": { os: ["linux"], cpu: ["x64"], dependencies: { c: "^1" } },
      },
      c: { "1.0.0": {} },
    };
    const full: Fixture = {
      "@img/sharp-linux-x64": { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
    };
    const { registry, calls } = fake(corgi, full);
    const picks: string[] = [];
    const reads: Promise<string>[] = [];
    const out = await resolveTree(
      { dependencies: { "@img/sharp-linux-x64": "^1" } },
      {
        registry,
        onPick: (p, from, libc) => {
          picks.push(`${from}>${p.name}:${p.libc?.join()}:${calls.length}`);
          if (libc) reads.push(libc.then((read) => `${p.name}:${read?.join()}:${p.libc?.join()}`));
        },
      },
    );
    // The build is announced before its child and before its libc is in; the read is handed
    // over to wait on, and `c`'s document is asked for meanwhile.
    expect(picks).toEqual([
      ">@img/sharp-linux-x64:undefined:1",
      "@img/sharp-linux-x64@1.0.0>c:undefined:2",
    ]);
    expect(await Promise.all(reads)).toEqual(["@img/sharp-linux-x64:glibc:glibc"]);
    expect(out.packages["@img/sharp-linux-x64@1.0.0"]?.libc).toEqual(["glibc"]);
  });

  it("does not read libc off a build's name: a manifest that declares none means any", async () => {
    // `rustywind-linux-x64-musl` is a static musl binary published as the only x64 build. It
    // declares no libc, which under npm's rules means any, and it runs on glibc. A lockfile
    // that took `musl` from the name would drop it on every glibc machine.
    const corgi: Fixture = {
      "rustywind-linux-x64-musl": { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
      "@rolldown/binding-linux-x64-gnu": { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
      "@rolldown/binding-linux-x64-musl": { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
    };
    const full: Fixture = {
      ...corgi,
      "@rolldown/binding-linux-x64-gnu": {
        "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      },
      "@rolldown/binding-linux-x64-musl": {
        "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["musl"] },
      },
    };
    const { registry, manifests } = fake(corgi, full);
    const optionalDependencies = Object.fromEntries(Object.keys(corgi).map((n) => [n, "^1"]));
    const out = await resolveTree({ optionalDependencies }, { registry });
    const libc = (name: string) => out.packages[`${name}@1.0.0`]?.libc;
    expect(libc("rustywind-linux-x64-musl")).toBeUndefined();
    expect(libc("@rolldown/binding-linux-x64-gnu")).toEqual(["glibc"]);
    expect(libc("@rolldown/binding-linux-x64-musl")).toEqual(["musl"]);
    // Every linux build cost its full manifest: the name is not evidence.
    expect(manifests.sort()).toEqual(
      Object.keys(corgi)
        .map((n) => `${n}@1.0.0`)
        .sort(),
    );
    expect(Object.keys(linux(out).packages)).toEqual([
      "@rolldown/binding-linux-x64-gnu@1.0.0",
      "rustywind-linux-x64-musl@1.0.0",
    ]);
    const musl = filterPlatform(out, { os: "linux", cpu: "x64", libc: "musl" });
    expect(Object.keys(musl.packages)).toEqual([
      "@rolldown/binding-linux-x64-musl@1.0.0",
      "rustywind-linux-x64-musl@1.0.0",
    ]);
  });

  it("asks for the full manifest only of a linux build nothing else says the libc of", async () => {
    const fixture: Fixture = {
      plain: { "1.0.0": {} }, // no os/cpu: nothing to learn
      known: { "1.0.0": { os: ["linux"], libc: ["glibc"] } }, // packument already said
      here: { "1.0.0": { os: ["linux"] } },
      anywhere: { "1.0.0": { cpu: ["x64"] } }, // no os: linux is not ruled out
      notwin: { "1.0.0": { os: ["!win32"] } }, // linux is not ruled out either
      // Off linux, so libc is nobody's question: the lockfile serves win32 without one.
      win: { "1.0.0": { os: ["win32"] } },
      "linux-x64-gnu": { "1.0.0": { os: ["linux"], cpu: ["x64"] } }, // the name is not asked
    };
    const { registry, manifests } = fake(fixture);
    await resolveTree(
      {
        dependencies: { plain: "^1", known: "^1", here: "^1", anywhere: "^1", notwin: "^1" },
        optionalDependencies: { win: "^1", "linux-x64-gnu": "^1" },
      },
      { registry },
    );
    expect(manifests.sort()).toEqual([
      "anywhere@1.0.0",
      "here@1.0.0",
      "linux-x64-gnu@1.0.0",
      "notwin@1.0.0",
    ]);
  });

  it("fails an optional platform build whose full manifest cannot be read", async () => {
    const { registry } = fake({ p: { "1.0.0": { os: ["linux"] } } }, {});
    const out = await resolveTree({ optionalDependencies: { p: "^1" } }, { registry });
    expect(out.packages).toEqual({});
    expect(out.warnings[0]).toContain("404 p@1.0.0");
  });

  it("honours ! negation", async () => {
    const fixture: Fixture = {
      n: { "1.0.0": { os: ["!win32"] } },
      m: { "1.0.0": { os: ["!linux"] } },
    };
    const out = await resolve(fixture, { optionalDependencies: { n: "^1", m: "^1" } });
    expect(Object.keys(out.packages)).toEqual(["m@1.0.0", "n@1.0.0"]);
    expect(Object.keys(linux(out).packages)).toEqual(["n@1.0.0"]);
    expect(Object.keys(on(WINDOWS)(out).packages)).toEqual(["m@1.0.0"]);
  });

  it("matches everything on any or an empty list", async () => {
    const fixture: Fixture = {
      a: { "1.0.0": { os: ["any"], cpu: [] } },
      b: { "1.0.0": { cpu: ["any"] } },
    };
    const out = linux(await resolve(fixture, { dependencies: { a: "^1", b: "^1" } }));
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(out.packages["a@1.0.0"]?.os).toEqual(["any"]);
  });

  it("drops an optional package whose required dep cannot run here, and says so", async () => {
    const out = linux(
      await resolve(
        { opt: { "1.0.0": { dependencies: { w: "^1" } } }, ...onlyWin },
        { optionalDependencies: { opt: "^1" } },
      ),
    );
    expect(out.packages).toEqual({});
    // Unlike a binding for another platform, this loses a package that was meant to be here.
    expect(out.warnings).toEqual([
      "skipped optional opt@1.0.0: needs w@1.0.0, which does not run on linux-x64-glibc",
    ]);
  });

  it("cascades that drop up a chain of optional parents", async () => {
    const out = linux(
      await resolve(
        {
          top: { "1.0.0": { dependencies: { mid: "^1" } } },
          mid: { "1.0.0": { dependencies: { w: "^1" } } },
          ...onlyWin,
        },
        { optionalDependencies: { top: "^1" } },
      ),
    );
    expect(out.packages).toEqual({});
    expect(out.warnings).toHaveLength(2);
  });

  it("keeps a package whose *optional* dep cannot run here", async () => {
    const out = linux(
      await resolve(
        { host: { "1.0.0": { optionalDependencies: { w: "^1" } } }, ...onlyWin },
        { dependencies: { host: "^1" } },
      ),
    );
    // The binding goes, the tool it belongs to stays: this is the oxlint/esbuild shape.
    expect(Object.keys(out.packages)).toEqual(["host@1.0.0"]);
    expect(out.packages["host@1.0.0"]?.optionalDependencies).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it("re-marks a package as dev when its only production path was an off-platform build", async () => {
    const out = await resolve(
      {
        shared: { "1.0.0": {} },
        winonly: { "1.0.0": { os: ["win32"], dependencies: { shared: "^1" } } },
        tool: { "1.0.0": { dependencies: { shared: "^1" } } },
      },
      { optionalDependencies: { winonly: "^1" }, devDependencies: { tool: "^1" } },
    );
    expect(out.packages["shared@1.0.0"]?.dev).toBe(false);
    // On linux nothing in production reaches it any more, so --production must skip it.
    expect(linux(out).packages["shared@1.0.0"]?.dev).toBe(true);
    expect(on(WINDOWS)(out).packages["shared@1.0.0"]?.dev).toBe(false);
  });

  it("defaults the platform to the current process", async () => {
    const fixture: Fixture = {
      here: { "1.0.0": { os: [process.platform], cpu: [process.arch] } },
      elsewhere: { "1.0.0": { os: [process.platform === "win32" ? "linux" : "win32"] } },
    };
    const out = await resolve(fixture, {
      dependencies: { here: "^1" },
      optionalDependencies: { elsewhere: "^1" },
    });
    expect(Object.keys(filterPlatform(out).packages)).toEqual(["here@1.0.0"]);
  });

  it("leaves a resolution with nothing to drop exactly as it was", async () => {
    const out = await resolve(
      { a: { "1.0.0": { dependencies: { b: "^1" } } }, b: { "1.0.0": {} } },
      { dependencies: { a: "^1" } },
    );
    expect(linux(out)).toEqual(out);
  });
});

describe("onPick", () => {
  const fixture: Fixture = {
    a: { "1.0.0": { dependencies: { b: "^1" } } },
    b: { "1.0.0": { os: ["linux"], cpu: ["x64"] } },
  };

  it("is told each package as it is picked, before its dependencies are walked", async () => {
    const { registry, calls } = fake(fixture);
    // What was picked, from where, and how many packuments had been read by then.
    const picks: [string, string, number][] = [];
    const onPick = (pkg: ResolvedPackage, from: string) =>
      picks.push([`${pkg.name}@${pkg.version}`, from, calls.length]);
    const out = await resolveTree({ dependencies: { a: "^1" } }, { registry, onPick });
    // `a` is reported before `b`'s packument is asked for: that is the head start.
    expect(picks).toEqual([
      ["a@1.0.0", "", 1],
      ["b@1.0.0", "a@1.0.0", 2],
    ]);
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0"]);
  });

  it("hands over what an install needs to start the tarball, and no edges yet", async () => {
    const { registry } = fake(fixture);
    const picks: ResolvedPackage[] = [];
    await resolveTree({ dependencies: { a: "^1" } }, { registry, onPick: (p) => picks.push(p) });
    expect(picks[0]).toMatchObject({
      name: "a",
      version: "1.0.0",
      resolved: "https://r/a/-/a-1.0.0.tgz",
      integrity: "sha512-a1.0.0",
      dependencies: {},
    });
    expect(picks[1]).toMatchObject({ name: "b", os: ["linux"], cpu: ["x64"] });
  });

  it("is told of a kept package too, and once, with its parent", async () => {
    const { registry } = fake(fixture);
    const locked = await resolveTree({ dependencies: { a: "^1" } }, { registry });
    const picks: string[] = [];
    await resolveTree(
      { dependencies: { a: "^1" } },
      { registry, locked, onPick: (p, from) => picks.push(`${from} > ${p.name}@${p.version}`) },
    );
    expect(picks.sort()).toEqual([" > a@1.0.0", "a@1.0.0 > b@1.0.0"]);
  });

  it("is told of a pick the walk later drops", async () => {
    // An optional subtree that fails takes what it reached with it — after it was picked.
    const { registry } = fake({
      opt: { "1.0.0": { dependencies: { gone: "^1" } } },
    });
    const picks: string[] = [];
    const out = await resolveTree(
      { optionalDependencies: { opt: "^1" } },
      { registry, onPick: (p) => picks.push(`${p.name}@${p.version}`) },
    );
    expect(picks).toEqual(["opt@1.0.0"]);
    expect(out.packages).toEqual({});
    expect(out.warnings[0]).toContain("skipped optional opt@^1 of root");
  });
});

describe("pinned specs", () => {
  const fixture: Fixture = {
    pinned: { "1.0.0": {}, "2.0.0": {} },
    ranged: { "1.0.0": {} },
  };
  const big = new Set(["pinned"]);

  it("reads an ordinary packument as before", async () => {
    const { registry, calls, manifests } = fake(fixture);
    const out = await resolveTree(
      { dependencies: { pinned: "1.0.0", ranged: "^1" } },
      { registry },
    );

    expect(Object.keys(out.packages)).toEqual(["pinned@1.0.0", "ranged@1.0.0"]);
    expect(calls.sort()).toEqual(["pinned", "ranged"]);
    expect(manifests).toEqual([]);
  });

  it("takes the per-version route when the packument is too big to read", async () => {
    const { registry, manifests } = fake(fixture, fixture, big);
    const out = await resolveTree({ dependencies: { pinned: "1.0.0" } }, { registry });

    expect(Object.keys(out.packages)).toEqual(["pinned@1.0.0"]);
    expect(manifests).toEqual(["pinned@1.0.0"]);
  });

  it("normalizes a spec the registry would not recognize as a path", async () => {
    const { registry, manifests } = fake(fixture, fixture, big);
    await resolveTree({ dependencies: { pinned: "v1.0.0" } }, { registry });

    expect(manifests).toEqual(["pinned@1.0.0"]);
  });

  it("keeps the packument for a range or a tag, whatever it costs", async () => {
    const { registry, calls, manifests } = fake(fixture, fixture, big);
    await resolveTree(
      { dependencies: { pinned: "^1" }, devDependencies: { ranged: "latest" } },
      { registry },
    );

    expect(calls.sort()).toEqual(["pinned", "ranged"]);
    expect(manifests).toEqual([]);
  });

  it("falls back to the packument, not the full document, when the route is missing", async () => {
    const { registry, calls, manifests } = fake(fixture, {}, big);
    const out = await resolveTree({ dependencies: { pinned: "1.0.0" } }, { registry });

    expect(Object.keys(out.packages)).toEqual(["pinned@1.0.0"]);
    expect(manifests).toEqual(["pinned@1.0.0"]); // asked once, answered nothing
    expect(calls).toEqual(["pinned", "pinned"]);
  });

  it("reports a version nobody has as ETARGET", async () => {
    const { registry } = fake(fixture, fixture, big);
    await expect(
      resolveTree({ dependencies: { pinned: "3.0.0" } }, { registry }),
    ).rejects.toMatchObject({ code: "ETARGET" });
  });

  it("answers the libc check from the version it already has", async () => {
    const { registry, manifests } = fake(
      { p: { "1.0.0": { os: ["linux"], cpu: ["x64"] } } },
      { p: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } } },
      new Set(["p"]),
    );
    const out = await resolveTree({ dependencies: { p: "1.0.0" } }, { registry });

    expect(out.packages["p@1.0.0"]?.libc).toEqual(["glibc"]);
    expect(manifests).toEqual(["p@1.0.0"]); // one request settles both questions
  });
});

describe("peer dependencies", () => {
  it("installs a peer and lists it in the consumer's dependencies", async () => {
    const out = await resolve(
      { a: { "1.0.0": { peerDependencies: { react: "^18" } } }, react: { "18.2.0": {} } },
      { dependencies: { a: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "react@18.2.0"]);
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ react: "18.2.0" });
    // Still recorded as declared, so the lockfile keeps the range.
    expect(out.packages["a@1.0.0"]?.peerDependencies).toEqual({ react: "^18" });
    expect(out.warnings).toEqual([]);
  });

  it("installs a peer whose provider is transitive only", async () => {
    // The case the tree used to get wrong: nothing else pulls `host` in.
    const out = await resolve(
      {
        app: { "1.0.0": { dependencies: { plugin: "^1" } } },
        plugin: { "1.0.0": { peerDependencies: { host: "^1" } } },
        host: { "1.0.0": {} },
      },
      { dependencies: { app: "^1" } },
    );
    expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
    expect(out.packages["host@1.0.0"]?.optional).toBe(false);
  });

  it("leaves a peer alone when the package depends on it itself", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { react: "^17" }, peerDependencies: { react: "^18" } } },
        react: { "17.0.0": {}, "18.2.0": {} },
      },
      { dependencies: { a: "^1" } },
    );
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ react: "17.0.0" });
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "react@17.0.0"]);
  });

  it("never installs an optional peer, even when it would resolve", async () => {
    const out = await resolve(
      {
        a: {
          "1.0.0": {
            peerDependencies: { jiti: "^2", react: "^18" },
            peerDependenciesMeta: { jiti: { optional: true } },
          },
        },
        jiti: { "2.0.0": {} },
        react: { "18.2.0": {} },
      },
      { dependencies: { a: "^1" } },
    );

    // An optional peer means "use it if it is there", never "install it" — as npm does.
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ react: "18.2.0" });
    expect(out.packages["jiti@2.0.0"]).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it("wires an optional peer that something else already brings in", async () => {
    const out = await resolve(
      {
        a: {
          "1.0.0": {
            peerDependencies: { jiti: "^2" },
            peerDependenciesMeta: { jiti: { optional: true } },
          },
        },
        jiti: { "2.0.0": {} },
      },
      { dependencies: { a: "^1", jiti: "^2" } },
    );

    // Not installed for a's sake, but a must still see it or the feature stays off.
    expect(out.packages["jiti@2.0.0"]).toBeDefined();
    // Optional, so it is wired where an install is allowed to drop it again.
    expect(out.packages["a@1.0.0"]?.optionalDependencies).toEqual({ jiti: "2.0.0" });
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({});
  });

  it("does not wire an optional peer the tree holds at an unsatisfying version", async () => {
    const out = await resolve(
      {
        a: {
          "1.0.0": {
            peerDependencies: { jiti: "^2" },
            peerDependenciesMeta: { jiti: { optional: true } },
          },
        },
        jiti: { "1.0.0": {} },
      },
      { dependencies: { a: "^1", jiti: "^1" } },
    );

    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({});
  });

  it("fails the install when a required peer cannot be resolved", async () => {
    const failing = resolve(
      { a: { "1.0.0": { peerDependencies: { react: "^18" } } } },
      { dependencies: { a: "^1" } },
    );
    await expect(failing).rejects.toMatchObject({ code: "E404" });
    await expect(failing).rejects.toThrow("react@^18 (required by a@1.0.0)");
  });

  it("locks a required peer that does not run here, and fails installing it", async () => {
    const out = await resolve(
      { a: { "1.0.0": { peerDependencies: { w: "^1" } } }, w: { "1.0.0": { os: ["win32"] } } },
      { dependencies: { a: "^1" } },
    );
    // The peer is a required edge, so it is in the lockfile for the platform it does run on.
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ w: "1.0.0" });
    expect(() => linux(out)).toThrow(expect.objectContaining({ code: "EBADPLATFORM" }));
    expect(Object.keys(on(WINDOWS)(out).packages)).toEqual(["a@1.0.0", "w@1.0.0"]);
  });

  it("terminates on a peer cycle", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { peerDependencies: { b: "^1" } } },
        b: { "1.0.0": { dependencies: { a: "^1" } } },
      },
      { dependencies: { a: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ b: "1.0.0" });
    expect(out.packages["b@1.0.0"]?.dependencies).toEqual({ a: "1.0.0" });
  });

  it("drops a peer cycle whole when something inside it dies", async () => {
    const out = await resolve(
      {
        opt: { "1.0.0": { peerDependencies: { b: "^1" } } },
        b: { "1.0.0": { dependencies: { opt: "^1", gone: "^1" } } },
      },
      { optionalDependencies: { opt: "^1" } },
    );
    expect(out.packages).toEqual({});
    // prune reports the resolved version; edge reports the range. Both name the same drop.
    expect(out.warnings).toEqual([expect.stringContaining("skipped optional opt@")]);
  });

  it("gives two consumers different peer versions without duplicating either", async () => {
    const out = await resolve(
      {
        old: { "1.0.0": { peerDependencies: { react: "^17" } } },
        new: { "1.0.0": { peerDependencies: { react: "^18" } } },
        react: { "17.0.0": {}, "18.2.0": {} },
      },
      { dependencies: { old: "^1", new: "^1" } },
    );
    expect(Object.keys(out.packages)).toEqual([
      "new@1.0.0",
      "old@1.0.0",
      "react@17.0.0",
      "react@18.2.0",
    ]);
    expect(out.packages["old@1.0.0"]?.dependencies).toEqual({ react: "17.0.0" });
    expect(out.packages["new@1.0.0"]?.dependencies).toEqual({ react: "18.2.0" });
  });

  describe("two consumers missing the same peer", () => {
    // typescript-eslint caps typescript where ts-api-utils takes any: a copy each gave
    // ts-api-utils a typescript with no JS API (unjs/upm#8).
    const fixture: Fixture = {
      capped: { "1.0.0": { peerDependencies: { ts: ">=4.8.4 <6.1.0" } } },
      open: { "1.0.0": { peerDependencies: { ts: ">=4.8.4" } } },
      ts: { "5.9.0": {}, "6.0.3": {}, "7.0.2": {} },
    };

    it("share one version that meets both ranges", async () => {
      const { result, count } = run(fixture, { dependencies: { open: "^1", capped: "^1" } });
      const out = await result;
      expect(Object.keys(out.packages)).toEqual(["capped@1.0.0", "open@1.0.0", "ts@6.0.3"]);
      expect(out.packages["open@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["capped@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      // One pick per range, as a copy each took: the fake keeps no packument between them.
      expect(count("ts")).toBe(2);
      expect(unmetPeers(out)).toEqual([]);
    });

    it("get a version each when no published version meets both", async () => {
      // The ranges overlap on paper (>=5.9.5 <6), but nothing is published there.
      const gap: Fixture = {
        a: { "1.0.0": { peerDependencies: { ts: ">=5.0.0 <6.0.0" } } },
        b: { "1.0.0": { peerDependencies: { ts: ">=5.9.5" } } },
        ts: { "5.9.0": {}, "6.0.3": {} },
      };
      const root = { dependencies: { a: "^1", b: "^1" } };
      const { result, count } = run(gap, root);
      const out = await result;
      expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ ts: "5.9.0" });
      expect(out.packages["b@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(count("ts")).toBe(2);

      // Locked that way, a later resolve asks the registry nothing about it.
      const again = run(gap, root, { locked: out });
      expect(Object.keys((await again.result).packages)).toEqual(Object.keys(out.packages));
      expect(again.calls).toEqual([]);
    });

    it("share past one whose pick failed", async () => {
      // `aaa` sorts first and asks for a version nobody published; the others still share.
      const out = await resolve(
        { ...fixture, aaa: { "1.0.0": { peerDependencies: { ts: "^9" } } } },
        { dependencies: { open: "^1", capped: "^1" }, optionalDependencies: { aaa: "^1" } },
      );
      expect(out.packages["open@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["capped@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["aaa@1.0.0"]).toBeUndefined();
    });

    it("take the locked copy when a fresh pick lands on the same version", async () => {
      const then: Fixture = { ...fixture, ts: { "6.0.3": {} } };
      const first = await resolve(then, { dependencies: { capped: "^1" } });
      const locked = structuredClone(first);
      locked.packages["ts@6.0.3"]!.integrity = "sha512-locked";
      // `any` sorts first and picks 6.0.3 fresh; `capped` holds it locked.
      const out = await resolve(
        { ...then, any: { "1.0.0": { peerDependencies: { ts: ">=4.8.4" } } } },
        { dependencies: { any: "^1", capped: "^1" } },
        { locked },
      );
      expect(out.packages["any@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["ts@6.0.3"]?.integrity).toBe("sha512-locked");
    });

    it("never let a dev-only consumer narrow what a shipped one gets", async () => {
      const out = await resolve(fixture, {
        dependencies: { open: "^1" },
        devDependencies: { capped: "^1" },
      });
      expect(out.packages["open@1.0.0"]?.dependencies).toEqual({ ts: "7.0.2" });
      expect(out.packages["capped@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(production(out)).toEqual(["open@1.0.0", "ts@7.0.2"]);
    });

    it("share even when a third asks through an alias", async () => {
      const out = await resolve(
        {
          ...fixture,
          aliased: { "1.0.0": { peerDependencies: { ts: "npm:ts@>=4.8.4" } } },
        },
        { dependencies: { open: "^1", capped: "^1", aliased: "^1" } },
      );
      expect(out.packages["open@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["capped@1.0.0"]?.dependencies).toEqual({ ts: "6.0.3" });
      expect(out.packages["aliased@1.0.0"]?.dependencies).toEqual({ ts: "7.0.2" });
    });

    it("heal a lock that gave them a copy each", async () => {
      const capped = await resolve(fixture, { dependencies: { capped: "^1" } });
      const open = await resolve(fixture, { dependencies: { open: "^1" } });
      const split = { ...capped, packages: { ...capped.packages, ...open.packages } };
      expect(Object.keys(split.packages)).toContain("ts@7.0.2");

      const { result, calls } = run(
        fixture,
        { dependencies: { capped: "^1", open: "^1" } },
        { locked: split },
      );
      const out = await result;
      // The locked version that meets both wins, straight from the lock.
      expect(calls).toEqual([]);
      expect(Object.keys(out.packages)).toEqual(["capped@1.0.0", "open@1.0.0", "ts@6.0.3"]);
    });
  });

  it("marks a peer dev when only a dev package pulls it in", async () => {
    const out = await resolve(
      { tool: { "1.0.0": { peerDependencies: { host: "^1" } } }, host: { "1.0.0": {} } },
      { devDependencies: { tool: "^1" } },
    );
    expect(out.packages["host@1.0.0"]?.dev).toBe(true);
  });
});

describe("flags survive the lockfile without being written to it", () => {
  it("rebuilds optional and dev from the edges alone, on a tree with both", async () => {
    // The guarantee the format rests on: `toLockfile` drops both flags, and `fromLockfile`
    // has to reproduce exactly what `resolveTree` decided, from the maps and `root.specs`.
    const out = await resolve(
      {
        app: {
          "1.0.0": { dependencies: { shared: "^1" }, optionalDependencies: { native: "^1" } },
        },
        tool: { "1.0.0": { dependencies: { helper: "^1" } } },
        native: { "1.0.0": { os: ["darwin"], dependencies: { helper: "^1" } } },
        shared: { "1.0.0": {} },
        helper: { "1.0.0": {} },
        extra: { "1.0.0": {} },
      },
      {
        dependencies: { app: "^1" },
        devDependencies: { tool: "^1" },
        optionalDependencies: { extra: "^1" },
      },
    );
    // A mix worth checking: prod, dev, optional-through-a-parent, optional-at-the-root, and
    // `helper`, which an optional edge and a dev edge both reach.
    expect(Object.keys(out.packages).length).toBeGreaterThan(4);
    const back = fromLockfile(toLockfile(out));
    for (const [key, pkg] of Object.entries(out.packages)) {
      expect([key, back.packages[key]?.optional, back.packages[key]?.dev]).toEqual([
        key,
        pkg.optional,
        pkg.dev,
      ]);
    }
    expect(formatLockfile(toLockfile(out))).not.toContain('"optional"');
  });

  it("clears optional on one all-required path, through the lockfile as well", async () => {
    // `shared` hangs off a required edge and an optional one. The resolver clears the flag;
    // so must the derivation, or an install would treat a required package as droppable.
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { shared: "^1" } } },
        b: { "1.0.0": { optionalDependencies: { shared: "^1" } } },
        shared: { "1.0.0": {} },
      },
      { dependencies: { a: "^1", b: "^1" } },
    );
    expect(out.packages["shared@1.0.0"]?.optional).toBe(false);
    expect(fromLockfile(toLockfile(out)).packages["shared@1.0.0"]?.optional).toBe(false);
  });

  it("keeps every flag over a tree that filterPlatform has already narrowed", async () => {
    const out = await resolve(
      {
        gnu: { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
        win: { "1.0.0": { os: ["win32"] } },
        host: { "1.0.0": { optionalDependencies: { gnu: "^1", win: "^1" } } },
        tool: { "1.0.0": {} },
      },
      { dependencies: { host: "^1" }, devDependencies: { tool: "^1" } },
    );
    const here = filterPlatform(out, LINUX);
    const back = fromLockfile(toLockfile(here));
    for (const [key, pkg] of Object.entries(here.packages)) {
      expect([key, back.packages[key]?.optional, back.packages[key]?.dev]).toEqual([
        key,
        pkg.optional,
        pkg.dev,
      ]);
    }
    expect(back.packages["gnu@1.0.0"]?.optional).toBe(true);
    expect(back.packages["tool@1.0.0"]?.dev).toBe(true);
  });
});

describe("unmetPeers", () => {
  it("says nothing when every peer got the version it asked for", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { peerDependencies: { react: "^18" } } },
        b: { "1.0.0": { peerDependencies: { react: ">=17" } } },
        react: { "18.2.0": {} },
      },
      { dependencies: { a: "^1", b: "^1" } },
    );
    expect(unmetPeers(out)).toEqual([]);
  });

  it("names the consumer whose own dependency undercuts its peer range", async () => {
    // A package that both depends on and peers on a name: the dependency edge wins, and the
    // peer range it declared is then not met by what it actually gets.
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { react: "^17" }, peerDependencies: { react: "^18" } } },
        react: { "17.0.0": {}, "18.2.0": {} },
      },
      { dependencies: { a: "^1" } },
    );
    expect(unmetPeers(out)).toEqual([
      "a@1.0.0 needs peer react@^18, and the tree installs react@17.0.0",
    ]);
  });

  it("is quiet about two consumers with disjoint ranges: they get a version each", async () => {
    // "One version per peer" is one version per *consumer*, not one for the tree: a range the
    // pool cannot meet is fetched. So this — the shape the gap is usually described as — is met.
    const out = await resolve(
      {
        old: { "1.0.0": { peerDependencies: { react: "^17" } } },
        fresh: { "1.0.0": { peerDependencies: { react: "^18" } } },
        react: { "17.0.2": {}, "18.2.0": {} },
      },
      { dependencies: { fresh: "^1", old: "^1" } },
    );
    expect(out.packages["old@1.0.0"]?.dependencies).toEqual({ react: "17.0.2" });
    expect(out.packages["fresh@1.0.0"]?.dependencies).toEqual({ react: "18.2.0" });
    expect(unmetPeers(out)).toEqual([]);
  });

  it("stays quiet about an optional peer nothing installed", async () => {
    const out = await resolve(
      {
        a: {
          "1.0.0": {
            peerDependencies: { jiti: "^2" },
            peerDependenciesMeta: { jiti: { optional: true } },
          },
        },
        jiti: { "2.0.0": {} },
      },
      { dependencies: { a: "^1" } },
    );
    expect(out.packages["jiti@2.0.0"]).toBeUndefined();
    expect(unmetPeers(out)).toEqual([]);
  });

  it("reads the ranges back out of the lockfile, not out of the resolver", async () => {
    // The whole reason the field is written down: an install has no resolver to ask.
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { react: "^17" }, peerDependencies: { react: "^18" } } },
        react: { "17.0.0": {}, "18.2.0": {} },
      },
      { dependencies: { a: "^1" } },
    );
    const lock = toLockfile(out);
    expect(lock.packages["a@1.0.0"]?.peerDependencies).toEqual({ react: "^18" });
    expect(unmetPeers(fromLockfile(lock))).toEqual(unmetPeers(out));
  });

  it("does not judge a peer range it cannot parse", () => {
    // The resolver rejects such a range outright, so this only reaches us hand-edited.
    const lock = parseLockfile(
      JSON.stringify({
        lockfileVersion: 1,
        root: { specs: { dependencies: { a: "^1" } }, dependencies: { a: "1.0.0" } },
        packages: {
          "a@1.0.0": {
            integrity: "sha512-a",
            dependencies: { react: "18.2.0" },
            peerDependencies: { react: "workspace:*" },
          },
          "react@18.2.0": { integrity: "sha512-r" },
        },
      }),
    );
    expect(unmetPeers(fromLockfile(lock))).toEqual([
      "a@1.0.0 declares peer react@workspace:*, which is not a range we can read",
    ]);
  });

  it("checks what the platform filter left, not what the lockfile held", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { peerDependencies: { native: "^1" } } },
        native: { "1.0.0": { os: ["darwin"] } },
      },
      { dependencies: { a: "^1" } },
    );
    expect(unmetPeers(out)).toEqual([]); // the lockfile holds every platform, and this one fits
    // On linux the provider goes, and `a` needs it: that is EBADPLATFORM, never a quiet line.
    const error = (() => {
      try {
        filterPlatform(out, LINUX);
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(error?.code).toBe("EBADPLATFORM");
  });
});

describe("determinism", () => {
  const fixture: Fixture = {
    zed: { "1.0.0": { dependencies: { mid: "^1", alpha: "^1" } } },
    mid: { "1.0.0": { dependencies: { alpha: "^1" } } },
    alpha: { "1.0.0": {}, "2.0.0": {} },
    beta: { "1.0.0": { dependencies: { alpha: "^2" } } },
  };
  const root = {
    dependencies: { zed: "^1", beta: "^1" },
    optionalDependencies: { gone: "*", nope: "*" },
  };

  it("produces byte-identical output across runs", async () => {
    const a = await resolve(fixture, root);
    const b = await resolve(fixture, root);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("sorts package keys, dependency maps and warnings", async () => {
    const out = await resolve(fixture, root);
    const keys = Object.keys(out.packages);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(["alpha@1.0.0", "alpha@2.0.0", "beta@1.0.0", "mid@1.0.0", "zed@1.0.0"]);
    expect(Object.keys(out.packages["zed@1.0.0"]?.dependencies ?? {})).toEqual(["alpha", "mid"]);
    expect(out.warnings).toEqual([...out.warnings].sort());
    expect(out.warnings).toHaveLength(2);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const base = fake(
      Object.fromEntries(
        [...Array.from({ length: 30 }).keys()].map((i) => [`p${i}`, { "1.0.0": {} }]),
      ),
    );
    const registry: typeof base.registry = {
      ...base.registry,
      async packument(name) {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return await base.registry.packument(name);
      },
    };
    const deps = Object.fromEntries(
      [...Array.from({ length: 30 }).keys()].map((i) => [`p${i}`, "^1"]),
    );
    await resolveTree({ dependencies: deps }, { registry, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
  });

  describe("a failure reaches every parent", () => {
    // Only the first parent of a package awaits its walk, so the others have to be told.
    const graph: Fixture = {
      o: { "1.0.0": { dependencies: { bad: "1" } } },
      r: { "1.0.0": { dependencies: { bad: "1" } } },
      bad: { "1.0.0": { dependencies: { nope: "1" } } },
    };
    const deeper: Fixture = {
      ...graph,
      r: { "1.0.0": { dependencies: { mid: "1" } } },
      mid: { "1.0.0": { dependencies: { bad: "1" } } },
    };

    it.each([
      ["both parents at the same depth", graph],
      ["the required parent deeper", deeper],
    ])("fails the required parent when the optional one saw it first, with %s", async (_l, f) => {
      const root = { optionalDependencies: { o: "1" }, dependencies: { r: "1" } };

      // Shipping bad@1.0.0 without nope would be a broken node_modules and exit 0.
      await expect(run(f, root).result).rejects.toMatchObject({ code: "E404" });
    });
  });

  it("never leaves a dependency pointing at a package it did not resolve", async () => {
    const { result } = run(
      {
        keep: { "1.0.0": { dependencies: {}, os: ["linux"] } },
        drop: { "1.0.0": { dependencies: {}, os: ["win32"] } },
        holder: {
          "1.0.0": {
            optionalDependencies: { drop: "1" },
            dependencies: { keep: "1" },
            peerDependencies: { peer: "1", ghost: "1" },
            peerDependenciesMeta: { ghost: { optional: true } },
          },
        },
        peer: { "1.0.0": {} },
      },
      { dependencies: { holder: "1" } },
    );
    const resolution = linux(await result);

    const missing = Object.entries(resolution.packages).flatMap(([key, pkg]) =>
      Object.entries(pkg.dependencies)
        .filter(([name, version]) => !resolution.packages[`${name}@${version}`])
        .map(([name, version]) => `${key} -> ${name}@${version}`),
    );
    const rootMissing = Object.entries(resolution.root.dependencies).filter(
      ([name, version]) => !resolution.packages[`${name}@${version}`],
    );
    expect(missing).toEqual([]);
    expect(rootMissing).toEqual([]);
    expect(resolution.packages["drop@1.0.0"]).toBeUndefined();
    expect(resolution.packages["holder@1.0.0"]?.dependencies).toEqual({
      keep: "1.0.0",
      peer: "1.0.0",
    });
  });

  describe("settling required peers", () => {
    it("reuses a version the tree already has instead of fetching its own", async () => {
      const { result, count } = run(
        {
          host: { "1.0.0": {}, "2.0.0": {} },
          plug: { "1.0.0": { peerDependencies: { host: "^1 || ^2" } } },
        },
        { dependencies: { host: "^1", plug: "^1" } },
      );
      const out = await result;

      // Picking latest here would install a second host and duplicate its whole subtree.
      expect(out.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
      expect(out.packages["host@2.0.0"]).toBeUndefined();
      expect(count("host")).toBe(1);
    });

    it("fetches a peer nothing in the tree provides", async () => {
      const { result } = run(
        { host: { "2.0.0": {} }, plug: { "1.0.0": { peerDependencies: { host: "^2" } } } },
        { dependencies: { plug: "^1" } },
      );
      const out = await result;

      expect(out.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "2.0.0" });
    });

    it("does not reuse a version whose own walk failed", async () => {
      const graph: Fixture = {
        opt: { "1.0.0": { dependencies: { foo: "1.5.0" } } },
        foo: { "1.0.0": {}, "1.5.0": { dependencies: { ghost: "^1" } }, "1.9.0": {} },
        plug: { "1.0.0": { peerDependencies: { foo: "^1" } } },
      };

      // foo@1.5.0 is about to be pruned, so reusing it would fail plug for no reason.
      const out = await run(graph, {
        dependencies: { plug: "^1" },
        optionalDependencies: { opt: "^1" },
      }).result;

      expect(out.packages["plug@1.0.0"]?.dependencies).toEqual({ foo: "1.9.0" });
    });

    it("settles a peer whose own peer needs settling", async () => {
      const out = await run(
        {
          a: { "1.0.0": { peerDependencies: { b: "^1" } } },
          b: { "1.0.0": { peerDependencies: { c: "^1" } } },
          c: { "1.0.0": {} },
        },
        { dependencies: { a: "^1" } },
      ).result;

      expect(Object.keys(out.packages).sort()).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
    });

    it("settles a mutual peer cycle without hanging", async () => {
      const out = await run(
        {
          a: { "1.0.0": { peerDependencies: { b: "^1" } } },
          b: { "1.0.0": { peerDependencies: { a: "^1" } } },
        },
        { dependencies: { a: "^1" } },
      ).result;

      expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ b: "1.0.0" });
      expect(out.packages["b@1.0.0"]?.dependencies).toEqual({ a: "1.0.0" });
    });

    it("fails the install when a required peer cannot be met", async () => {
      const { result } = run(
        { plug: { "1.0.0": { peerDependencies: { host: "^1" } } } },
        { dependencies: { plug: "^1" } },
      );

      await expect(result).rejects.toMatchObject({ code: "E404" });
    });

    it("drops an optional ancestor instead of failing when its peer cannot be met", async () => {
      const out = await run(
        { plug: { "1.0.0": { peerDependencies: { host: "^1" } } } },
        { optionalDependencies: { plug: "^1" } },
      ).result;

      expect(out.packages).toEqual({});
      expect(out.warnings).toEqual([expect.stringContaining("skipped optional plug@")]);
    });

    it("resolves the same graph identically whatever order the deps are declared in", async () => {
      const graph: Fixture = {
        host: { "1.0.0": {}, "2.0.0": {} },
        plug: { "1.0.0": { peerDependencies: { host: "^1 || ^2" } } },
        other: { "1.0.0": { dependencies: { host: "^1" } } },
      };
      const forward = await run(graph, { dependencies: { host: "^1", other: "^1", plug: "^1" } })
        .result;
      const backward = await run(graph, { dependencies: { plug: "^1", other: "^1", host: "^1" } })
        .result;

      expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    });
  });
});

/** Every edge target, and every root dependency, must be a package the resolution holds. */
function dangling(out: Awaited<ReturnType<typeof resolve>>): string[] {
  return [
    ...Object.entries(out.packages).flatMap(([key, pkg]) =>
      Object.entries(pkg.dependencies)
        .filter(([name, version]) => !out.packages[`${name}@${version}`])
        .map(([name, version]) => `${key} -> ${name}@${version}`),
    ),
    ...Object.entries(out.root.dependencies)
      .filter(([name, version]) => !out.packages[`${name}@${version}`])
      .map(([name, version]) => `root -> ${name}@${version}`),
  ];
}

/** What `--production` would ship. */
function production(out: Awaited<ReturnType<typeof resolve>>): string[] {
  return Object.keys(out.packages).filter((key) => !out.packages[key]?.dev);
}

describe("a peer never promotes a dev package into production", () => {
  const versions: Fixture = {
    host: { "1.0.0": {}, "2.0.0": {} },
    plug: { "1.0.0": { peerDependencies: { host: "^1 || ^2" } } },
    tool: { "1.0.0": { dependencies: { host: "1.0.0" } } },
  };

  it("picks the same peer version with and without a devDependency", async () => {
    const alone = await resolve(versions, { dependencies: { plug: "^1" } });
    const withDev = await resolve(versions, {
      dependencies: { plug: "^1" },
      devDependencies: { tool: "^1" },
    });

    // The production tree is a function of `dependencies` alone.
    expect(alone.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "2.0.0" });
    expect(withDev.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "2.0.0" });
    expect(production(withDev)).toEqual(["host@2.0.0", "plug@1.0.0"]);
    expect(withDev.packages["host@1.0.0"]?.dev).toBe(true);
    expect(dangling(alone)).toEqual([]);
    expect(dangling(withDev)).toEqual([]);
  });

  it("leaves an optional peer unwired when only a dev package provides it", async () => {
    // vue declares typescript as an optional peer; `--production` must not ship 23MB of it.
    const out = await resolve(
      {
        vue: {
          "3.0.0": {
            peerDependencies: { typescript: "^5" },
            peerDependenciesMeta: { typescript: { optional: true } },
          },
        },
        typescript: { "5.0.0": {} },
      },
      { dependencies: { vue: "^3" }, devDependencies: { typescript: "^5" } },
    );

    expect(out.packages["vue@3.0.0"]?.dependencies).toEqual({});
    expect(out.packages["typescript@5.0.0"]?.dev).toBe(true);
    expect(production(out)).toEqual(["vue@3.0.0"]);
    expect(dangling(out)).toEqual([]);
  });

  it("still wires an optional peer whose provider is production", async () => {
    const out = await resolve(
      {
        vue: {
          "3.0.0": {
            peerDependencies: { typescript: "^5" },
            peerDependenciesMeta: { typescript: { optional: true } },
          },
        },
        typescript: { "5.0.0": {} },
      },
      { dependencies: { vue: "^3", typescript: "^5" } },
    );

    expect(allDeps(out.packages["vue@3.0.0"]!)).toEqual({ typescript: "5.0.0" });
    expect(out.packages["typescript@5.0.0"]?.dev).toBe(false);
    expect(dangling(out)).toEqual([]);
  });

  it("fetches its own copy for a required peer the dev tree alone satisfies", async () => {
    const out = await resolve(
      {
        host: { "1.0.0": {}, "1.5.0": {} },
        plug: { "1.0.0": { peerDependencies: { host: "^1" } } },
        tool: { "1.0.0": { dependencies: { host: "1.0.0" } } },
      },
      { dependencies: { plug: "^1" }, devDependencies: { tool: "^1" } },
    );

    // A required peer must exist, so it is fetched as normal rather than reusing the dev copy.
    expect(out.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "1.5.0" });
    expect(out.packages["host@1.5.0"]?.dev).toBe(false);
    expect(out.packages["host@1.0.0"]?.dev).toBe(true);
    expect(production(out)).toEqual(["host@1.5.0", "plug@1.0.0"]);
    expect(dangling(out)).toEqual([]);
  });

  it("lets a dev-only consumer reuse a production package", async () => {
    const { result, count } = run(
      {
        host: { "1.0.0": {} },
        tool: { "1.0.0": { peerDependencies: { host: "^1" } } },
      },
      { dependencies: { host: "^1" }, devDependencies: { tool: "^1" } },
    );
    const out = await result;

    // Restricting a dev consumer buys nothing and would duplicate the host.
    expect(out.packages["tool@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
    expect(Object.keys(out.packages)).toEqual(["host@1.0.0", "tool@1.0.0"]);
    expect(count("host")).toBe(1);
    expect(dangling(out)).toEqual([]);
  });

  it("ships nothing that is only reachable through devDependencies", async () => {
    const out = await resolve(
      {
        app: { "1.0.0": { dependencies: { shared: "^1" } } },
        shared: { "1.0.0": {} },
        bundler: {
          "1.0.0": {
            dependencies: { esbuild: "^1" },
            peerDependencies: { types: "^1", shared: "^1" },
            peerDependenciesMeta: { types: { optional: true } },
          },
        },
        esbuild: { "1.0.0": {} },
        types: { "1.0.0": {} },
        linter: {
          "1.0.0": {
            peerDependencies: { types: "^1" },
            peerDependenciesMeta: { types: { optional: true } },
          },
        },
      },
      {
        dependencies: { app: "^1", bundler: "^1" },
        devDependencies: { linter: "^1", types: "^1" },
      },
    );

    expect(production(out)).toEqual([
      "app@1.0.0",
      "bundler@1.0.0",
      "esbuild@1.0.0",
      "shared@1.0.0",
    ]);
    // A production consumer keeps the peers production already reaches.
    expect(out.packages["bundler@1.0.0"]?.dependencies).toEqual({
      esbuild: "1.0.0",
      shared: "1.0.0",
    });
    // A dev consumer may still see the dev-only optional peer.
    expect(allDeps(out.packages["linter@1.0.0"]!)).toEqual({ types: "1.0.0" });
    expect(dangling(out)).toEqual([]);
  });

  it("settles the same way whatever order the root declares its groups in", async () => {
    const graph: Fixture = {
      host: { "1.0.0": {}, "2.0.0": {} },
      plug: { "1.0.0": { peerDependencies: { host: "^1 || ^2" } } },
      tool: { "1.0.0": { dependencies: { host: "1.0.0" } } },
      side: { "1.0.0": { dependencies: { host: "^2" } } },
    };
    const forward = await resolve(graph, {
      dependencies: { plug: "^1", side: "^1" },
      devDependencies: { tool: "^1" },
    });
    const backward = await resolve(graph, {
      dependencies: { side: "^1", plug: "^1" },
      devDependencies: { tool: "^1" },
    });

    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(forward.packages["plug@1.0.0"]?.dependencies).toEqual({ host: "2.0.0" });
  });
});

describe("alias specs", () => {
  // The shape that made nuxt uninstallable: @isaacs/cliui reaches string-width twice, once
  // under an alias, and glob pulls it in from deep inside the tree.
  const cliui: Fixture = {
    cliui: {
      "8.0.2": {
        dependencies: {
          "string-width": "^5.1.2",
          "string-width-cjs": "npm:string-width@^4.2.0",
          "wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0",
        },
      },
    },
    "string-width": { "4.2.3": {}, "5.1.2": {} },
    "wrap-ansi": { "7.0.0": {} },
  };

  it("installs the target under the alias name", async () => {
    const out = await resolve(cliui, { dependencies: { cliui: "^8" } });
    expect(Object.keys(out.packages)).toEqual([
      "cliui@8.0.2",
      "string-width-cjs@4.2.3",
      "string-width@5.1.2",
      "wrap-ansi-cjs@7.0.0",
    ]);
    // The alias is the identity; the tarball is the real package's.
    expect(out.packages["string-width-cjs@4.2.3"]).toMatchObject({
      name: "string-width-cjs",
      version: "4.2.3",
      resolved: "https://r/string-width/-/string-width-4.2.3.tgz",
      integrity: "sha512-string-width4.2.3",
    });
    expect(out.packages["cliui@8.0.2"]?.dependencies).toEqual({
      "string-width": "5.1.2",
      "string-width-cjs": "4.2.3",
      "wrap-ansi-cjs": "7.0.0",
    });
    expect(out.warnings).toEqual([]);
  });

  it("keeps name@version resolvable for the lockfile and the store", async () => {
    const out = await resolve(cliui, { dependencies: { cliui: "^8" } });
    // Both enforce that every dependency edge names a package that is really there.
    expect(() => formatLockfile(toLockfile(out))).not.toThrow();
    expect(Object.keys(await storeKeys(out.packages))).toContain("string-width-cjs@4.2.3");
  });

  it("walks the target's own dependencies", async () => {
    const out = await resolve(
      {
        a: { "1.0.0": { dependencies: { "b-alias": "npm:b@^2" } } },
        b: { "2.0.0": { dependencies: { c: "^3" } } },
        c: { "3.0.0": {} },
      },
      { dependencies: { a: "1" } },
    );
    expect(out.packages["b-alias@2.0.0"]?.dependencies).toEqual({ c: "3.0.0" });
    expect(out.packages["c@3.0.0"]).toBeDefined();
  });

  it("shares one packument with a plain dep on the same range", async () => {
    const { result, count } = run(
      { a: { "1.0.0": { dependencies: { b: "^1", "b-copy": "npm:b@^1" } } }, b: { "1.0.0": {} } },
      { dependencies: { a: "1" } },
    );
    const out = await result;
    expect(count("b")).toBe(1);
    // One fetch, two nodes: each name gets its own entry.
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b-copy@1.0.0", "b@1.0.0"]);
  });

  it("gives two aliases of one package a node each", async () => {
    const out = await resolve(
      { a: { "1.0.0": { dependencies: { x: "npm:b@^1", y: "npm:b@^1" } } }, b: { "1.0.0": {} } },
      { dependencies: { a: "1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "x@1.0.0", "y@1.0.0"]);
    expect(out.packages["x@1.0.0"]?.resolved).toBe(out.packages["y@1.0.0"]?.resolved);
  });

  it("resolves an alias declared by the root", async () => {
    const out = await resolve({ b: { "1.0.0": {} } }, { dependencies: { "my-b": "npm:b@^1" } });
    expect(out.root.dependencies).toEqual({ "my-b": "1.0.0" });
    expect(out.root.specs).toEqual({ dependencies: { "my-b": "npm:b@^1" } });
    expect(out.packages["my-b@1.0.0"]).toMatchObject({ dev: false, optional: false });
  });

  it("marks a dev-only alias dev", async () => {
    const out = await resolve({ b: { "1.0.0": {} } }, { devDependencies: { "my-b": "npm:b@^1" } });
    expect(out.packages["my-b@1.0.0"]).toMatchObject({ dev: true });
  });

  it("names bins after the real package, not the alias", async () => {
    const out = await resolve(
      { b: { "1.0.0": { bin: "./cli.js" } } },
      { dependencies: { "my-b": "npm:b@^1" } },
    );
    expect(out.packages["my-b@1.0.0"]?.bin).toEqual({ b: "cli.js" });
  });

  it("fails a required alias whose target is missing", async () => {
    await expect(
      resolve(
        { a: { "1.0.0": { dependencies: { x: "npm:nope@^1" } } } },
        { dependencies: { a: "1" } },
      ),
    ).rejects.toThrow(/404 nope/);
  });

  it("warns instead of failing when an optional alias is unresolvable", async () => {
    const out = await resolve(
      { a: { "1.0.0": { optionalDependencies: { x: "npm:nope@^1" } } } },
      { dependencies: { a: "1" } },
    );
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0"]);
    expect(out.warnings).toEqual(["skipped optional x@npm:nope@^1 of a@1.0.0: 404 nope"]);
  });

  it("still reports a malformed alias as an invalid spec", async () => {
    await expect(
      resolve({ a: { "1.0.0": { dependencies: { x: "npm:" } } } }, { dependencies: { a: "1" } }),
    ).rejects.toThrow(expect.objectContaining({ code: "EINVALIDSPEC" }));
  });
});

describe("resolving against a previous resolution", () => {
  /** Lock a tree, then republish newer versions the ranges also allow. */
  const before: Fixture = {
    a: { "1.0.0": { dependencies: { b: "^1" } } },
    b: { "1.0.0": {} },
    c: { "1.0.0": { dependencies: { b: "^1" } } },
  };
  const after: Fixture = {
    a: { "1.0.0": { dependencies: { b: "^1" } }, "1.5.0": { dependencies: { b: "^1" } } },
    b: { "1.0.0": {}, "1.9.0": {} },
    c: { "1.0.0": { dependencies: { b: "^1" } } },
    d: { "1.0.0": { dependencies: { b: "^1" } } },
  };
  const root: RootManifest = { dependencies: { a: "^1", c: "^1" } };
  const locked = () => resolve(before, root);

  it("keeps every package whose range still fits, and asks the registry for nothing", async () => {
    const { result, calls } = run(after, root, { locked: await locked() });
    const out = await result;
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
    expect(calls).toEqual([]);
  });

  it("resolves only what is new, against the tree it is joining", async () => {
    const { result, calls } = run(
      after,
      { dependencies: { ...root.dependencies, d: "^1" } },
      {
        locked: await locked(),
      },
    );
    const out = await result;
    // d is new, so it is fetched; its b@^1 is met by the locked b, so b is not.
    expect(calls).toEqual(["d"]);
    expect(out.packages["d@1.0.0"]?.dependencies).toEqual({ b: "1.0.0" });
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0", "d@1.0.0"]);
  });

  it("re-resolves a range that moved, and keeps what sits under it", async () => {
    const { result, calls } = run(
      after,
      { dependencies: { a: "^1.5", c: "^1" } },
      {
        locked: await locked(),
      },
    );
    const out = await result;
    expect(calls).toEqual(["a"]);
    expect(Object.keys(out.packages)).toEqual(["a@1.5.0", "b@1.0.0", "c@1.0.0"]);
  });

  it("drops what nothing reaches any more, without the registry", async () => {
    const { result, calls } = run(after, { dependencies: { c: "^1" } }, { locked: await locked() });
    const out = await result;
    expect(calls).toEqual([]);
    expect(Object.keys(out.packages)).toEqual(["b@1.0.0", "c@1.0.0"]);
  });

  it("recomputes dev and optional from the new root, not the old one", async () => {
    const out = await resolve(
      after,
      { devDependencies: { a: "^1" }, optionalDependencies: { c: "^1" } },
      {
        locked: await locked(),
      },
    );
    expect(out.packages["a@1.0.0"]).toMatchObject({ dev: true, optional: false });
    expect(out.packages["c@1.0.0"]).toMatchObject({ dev: false, optional: true });
    expect(out.packages["b@1.0.0"]).toMatchObject({ dev: false, optional: false });
  });

  it("never keeps a tag, which only the registry can read", async () => {
    const fixture: Fixture = { a: { "1.0.0": {}, "2.0.0": {} } };
    const first = await resolve(fixture, { dependencies: { a: "1.0.0" } });
    const { result, calls } = run(fixture, { dependencies: { a: "latest" } }, { locked: first });
    const out = await result;
    expect(calls).toEqual(["a"]);
    expect(Object.keys(out.packages)).toEqual(["a@2.0.0"]);
  });

  it("keeps an alias only when its locked tarball is the aliased package's", async () => {
    const fixture: Fixture = { b: { "1.0.0": {}, "2.0.0": {} }, d: { "1.0.0": {}, "2.0.0": {} } };
    const first = await resolve(fixture, { dependencies: { c: "npm:b@1.0.0" } });
    expect(first.packages["c@1.0.0"]?.resolved).toBe("https://r/b/-/b-1.0.0.tgz");
    // Same package, wider range: kept, nothing fetched.
    const same = run(fixture, { dependencies: { c: "npm:b@^1" } }, { locked: first });
    expect(Object.keys((await same.result).packages)).toEqual(["c@1.0.0"]);
    expect(same.calls).toEqual([]);
    // The alias now points at another package: the locked c@1.0.0 is not it.
    const other = run(fixture, { dependencies: { c: "npm:d@^1" } }, { locked: first });
    expect((await other.result).packages["c@1.0.0"]?.resolved).toBe("https://r/d/-/d-1.0.0.tgz");
    expect(other.calls).toEqual(["d"]);
  });

  it("gives a new consumer the locked peer, and a locked consumer a new optional peer", async () => {
    const fixture: Fixture = {
      host: { "1.0.0": {}, "1.1.0": {} },
      plugin: { "1.0.0": { peerDependencies: { host: "^1" } } },
      extra: { "1.0.0": {} },
      old: {
        "1.0.0": {
          peerDependencies: { extra: "^1" },
          peerDependenciesMeta: { extra: { optional: true } },
        },
      },
    };
    const first = await resolve(fixture, { dependencies: { host: "1.0.0", old: "^1" } });
    expect(first.packages["old@1.0.0"]?.optionalDependencies).toBeUndefined();
    const { result, calls } = run(
      fixture,
      { dependencies: { host: "1.0.0", old: "^1", plugin: "^1", extra: "^1" } },
      { locked: first },
    );
    const out = await result;
    expect(calls.sort()).toEqual(["extra", "plugin"]);
    expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
    expect(out.packages["old@1.0.0"]?.optionalDependencies).toEqual({ extra: "1.0.0" });
  });

  describe("peers are settled again, not replayed", () => {
    const fixture: Fixture = {
      host: { "1.0.0": {}, "1.1.0": {} },
      plugin: { "1.0.0": { peerDependencies: { host: "^1" } } },
      extra: { "1.0.0": {} },
      old: {
        "1.0.0": {
          peerDependencies: { extra: "^1" },
          peerDependenciesMeta: { extra: { optional: true } },
        },
      },
      // Depends on host and peers on it: the own edge wins, so it is not a settled peer.
      both: { "1.0.0": { dependencies: { host: "1.0.0" }, peerDependencies: { host: "^1" } } },
    };

    it("records which edges were settled peers", async () => {
      const out = await resolve(fixture, {
        dependencies: { host: "1.0.0", plugin: "^1", old: "^1", both: "^1", extra: "^1" },
      });
      expect(out.packages["plugin@1.0.0"]?.peers).toEqual({ host: "required" });
      expect(out.packages["old@1.0.0"]?.peers).toEqual({ extra: "optional" });
      expect(out.packages["both@1.0.0"]?.peers).toBeUndefined();
      expect(out.packages["host@1.0.0"]?.peers).toBeUndefined();
    });

    it("moves a locked plugin to the host the root moved to, leaving one host", async () => {
      const first = await resolve(fixture, { dependencies: { host: "1.0.0", plugin: "^1" } });
      const { result, calls } = run(
        fixture,
        { dependencies: { host: "1.1.0", plugin: "^1" } },
        {
          locked: first,
        },
      );
      const out = await result;
      expect(calls).toEqual(["host"]);
      expect(Object.keys(out.packages)).toEqual(["host@1.1.0", "plugin@1.0.0"]);
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.1.0" });
    });

    it("keeps a locked package's own edge to a name it also peers on", async () => {
      const first = await resolve(fixture, { dependencies: { host: "1.0.0", both: "^1" } });
      const out = await resolve(
        fixture,
        { dependencies: { host: "1.1.0", both: "^1" } },
        {
          locked: first,
        },
      );
      expect(Object.keys(out.packages)).toEqual(["both@1.0.0", "host@1.0.0", "host@1.1.0"]);
      expect(out.packages["both@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
    });

    it("unwires an optional peer the root removed, or moved to dev", async () => {
      const first = await resolve(fixture, { dependencies: { old: "^1", extra: "^1" } });
      expect(first.packages["old@1.0.0"]?.optionalDependencies).toEqual({ extra: "1.0.0" });

      const gone = await resolve(fixture, { dependencies: { old: "^1" } }, { locked: first });
      expect(Object.keys(gone.packages)).toEqual(["old@1.0.0"]);

      const dev = await resolve(
        fixture,
        { dependencies: { old: "^1" }, devDependencies: { extra: "^1" } },
        { locked: first },
      );
      expect(dev.packages["old@1.0.0"]?.optionalDependencies).toBeUndefined();
      expect(dev.packages["extra@1.0.0"]?.dev).toBe(true);
    });

    it("fetches a shipped consumer's peer rather than promote a dev-only locked one", async () => {
      const first = await resolve(fixture, { devDependencies: { host: "1.0.0" } });
      const { result, calls } = run(
        fixture,
        { dependencies: { plugin: "^1" }, devDependencies: { host: "1.0.0" } },
        { locked: first },
      );
      const out = await result;
      expect(calls.sort()).toEqual(["host", "plugin"]);
      expect(Object.keys(out.packages)).toEqual(["host@1.0.0", "host@1.1.0", "plugin@1.0.0"]);
      expect(out.packages["host@1.0.0"]?.dev).toBe(true);
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.1.0" });
    });

    it("keeps the host a locked consumer alone reaches, whatever the registry has now", async () => {
      const then: Fixture = { ...fixture, host: { "1.0.0": {} } };
      const first = await resolve(then, { dependencies: { plugin: "^1" } });
      expect(Object.keys(first.packages)).toEqual(["host@1.0.0", "plugin@1.0.0"]);
      const { result, calls } = run(
        fixture,
        { dependencies: { plugin: "^1", extra: "^1" } },
        {
          locked: first,
        },
      );
      const out = await result;
      expect(calls).toEqual(["extra"]);
      expect(Object.keys(out.packages)).toEqual(["extra@1.0.0", "host@1.0.0", "plugin@1.0.0"]);
    });

    it("does not let a locked shipped consumer keep a host the root moved to dev", async () => {
      const first = await resolve(fixture, { dependencies: { plugin: "^1", host: "1.0.0" } });
      expect(first.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.0.0" });
      const { result, calls } = run(
        fixture,
        { dependencies: { plugin: "^1" }, devDependencies: { host: "1.0.0" } },
        { locked: first },
      );
      const out = await result;
      expect(calls).toEqual(["host"]);
      expect(Object.keys(out.packages)).toEqual(["host@1.0.0", "host@1.1.0", "plugin@1.0.0"]);
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.1.0" });
    });

    it("still asks the registry for nothing when the tree did not move", async () => {
      const root: RootManifest = {
        dependencies: { host: "1.0.0", plugin: "^1", old: "^1", extra: "^1" },
      };
      const first = await resolve(fixture, root);
      const { result, calls } = run(fixture, root, { locked: first });
      expect(await result).toEqual(first);
      expect(calls).toEqual([]);
    });
  });

  it("keeps a locked platform build and its libc", async () => {
    const fixture: Fixture = {
      bin: { "1.0.0": { optionalDependencies: { "bin-linux": "1.0.0" } } },
      "bin-linux": { "1.0.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] } },
    };
    const first = await resolve(fixture, { dependencies: { bin: "^1" } });
    const { result, calls } = run(fixture, { dependencies: { bin: "^1" } }, { locked: first });
    const out = await result;
    expect(calls).toEqual([]);
    expect(out.packages["bin-linux@1.0.0"]).toMatchObject({ os: ["linux"], libc: ["glibc"] });
    expect(out.packages["bin@1.0.0"]?.optionalDependencies).toEqual({ "bin-linux": "1.0.0" });
  });

  it("round-trips through the lockfile", async () => {
    const r = () => "https://r";
    const lock = toLockfile(await locked(), r);
    const again = fromLockfile(parseLockfile(formatLockfile(lock)), r);
    const out = await resolve(after, root, { locked: again });
    expect(toLockfile(out, r)).toEqual(lock);
  });
});

describe("dedupe", () => {
  /** `a` and `c` want b@^1, locked when 1.0.0 was all there was; the root then moved to 1.9.0. */
  const fixture: Fixture = {
    a: { "1.0.0": { dependencies: { b: "^1" } } },
    b: { "1.0.0": {}, "1.9.0": {}, "1.9.5": {} },
    c: { "1.0.0": { dependencies: { b: "^1" } } },
  };

  async function duplicated(): Promise<Resolution> {
    const then = { ...fixture, b: { "1.0.0": {} } };
    const first = await resolve(then, { dependencies: { a: "^1", b: "1.0.0", c: "^1" } });
    const moved = await resolve(
      fixture,
      { dependencies: { a: "^1", b: "1.9.0", c: "^1" } },
      {
        locked: first,
      },
    );
    expect(Object.keys(moved.packages)).toEqual(["a@1.0.0", "b@1.0.0", "b@1.9.0", "c@1.0.0"]);
    return moved;
  }

  it("moves every range onto the highest locked version it allows, by version, not packument", async () => {
    const locked = await duplicated();
    const { result, calls } = run(
      fixture,
      { dependencies: { a: "^1", b: "1.9.0", c: "^1" } },
      {
        locked,
        dedupe: true,
      },
    );
    const out = await result;
    expect(Object.keys(out.packages)).toEqual(["a@1.0.0", "b@1.9.0", "c@1.0.0"]);
    expect(out.packages["a@1.0.0"]?.dependencies).toEqual({ b: "1.9.0" });
    // Pinned reads only, so 1.9.5 is never seen: dedupe is not upgrade. (b twice because the
    // fake does not memoize a pinned read by version; the real client does.)
    expect([...new Set(calls)].sort()).toEqual(["a", "b", "c"]);
  });

  it("is a fresh resolve for a range no locked version satisfies, then converges", async () => {
    const locked = await duplicated();
    const root: RootManifest = { dependencies: { a: "^1", b: "^1.9.5", c: "^1" } };
    const once = await resolve(fixture, root, { locked, dedupe: true });
    // The kept ranges chose before 1.9.5 was in the tree; plan() runs passes until nothing drops.
    expect(Object.keys(once.packages)).toEqual(["a@1.0.0", "b@1.9.0", "b@1.9.5", "c@1.0.0"]);
    const twice = await resolve(fixture, root, { locked: once, dedupe: true });
    expect(Object.keys(twice.packages)).toEqual(["a@1.0.0", "b@1.9.5", "c@1.0.0"]);
  });

  it("keeps a shipped consumer off a dev-only locked peer", async () => {
    const peers: Fixture = {
      host: { "1.0.0": {}, "1.1.0": {} },
      plugin: { "1.0.0": { peerDependencies: { host: "^1" } } },
    };
    const first = await resolve(peers, { devDependencies: { host: "1.0.0" } });
    const out = await resolve(
      peers,
      { dependencies: { plugin: "^1" }, devDependencies: { host: "1.0.0" } },
      { locked: first, dedupe: true },
    );
    expect(Object.keys(out.packages)).toEqual(["host@1.0.0", "host@1.1.0", "plugin@1.0.0"]);
    expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "1.1.0" });
  });

  it("gives an alias and a plain dep of one package the same locked version, in either order", async () => {
    const then: Fixture = { b: { "1.0.0": {} } };
    const now: Fixture = { b: { "1.0.0": {}, "1.5.0": {} } };
    for (const root of [
      { dependencies: { z: "npm:b@^1", b: "^1" } },
      { dependencies: { b: "^1", z: "npm:b@^1" } },
    ]) {
      const first = await resolve(then, root);
      const out = await resolve(now, root, { locked: first, dedupe: true });
      expect(Object.keys(out.packages)).toEqual(["b@1.0.0", "z@1.0.0"]);
    }
  });

  it("changes nothing on a tree with nothing to dedupe", async () => {
    const root: RootManifest = { dependencies: { a: "^1", b: "1.9.0", c: "^1" } };
    const first = await resolve(fixture, root);
    expect(await resolve(fixture, root, { locked: first, dedupe: true })).toEqual(first);
  });
});

describe("workspaces", () => {
  const ws = (path: string, manifest: RootManifest) => ({ path, manifest });
  const a = ws("packages/a", { name: "a", version: "1.0.0", dependencies: { b: "^1" } });
  const b = ws("packages/b", { name: "b", version: "1.0.0", dependencies: { nanoid: "^5" } });
  const fixture: Fixture = {
    nanoid: { "5.0.0": {} },
    b: { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} },
  };

  it("is a top: its own package, its deps walked, and never asked of the registry", async () => {
    const { result, calls } = run(fixture, { dependencies: { a: "^1" } }, { workspaces: [a, b] });
    const out = await result;
    expect(calls).toEqual(["nanoid"]);
    expect(out.root.dependencies).toEqual({ a: "link:packages/a" });
    expect(Object.keys(out.packages)).toEqual([
      "a@link:packages/a",
      "b@link:packages/b",
      "nanoid@5.0.0",
    ]);
    expect(out.packages["a@link:packages/a"]).toEqual({
      name: "a",
      version: "1.0.0",
      resolved: "",
      integrity: "",
      local: "packages/a",
      specs: { dependencies: { b: "^1" } },
      dependencies: { b: "link:packages/b" },
      optional: false,
      dev: false,
      bin: {},
    });
    expect(out.packages["b@link:packages/b"]).toMatchObject({
      local: "packages/b",
      dependencies: { nanoid: "5.0.0" },
    });
    expect(out.packages["nanoid@5.0.0"]).toMatchObject({ dev: false, optional: false });
    expect(out.warnings).toEqual([]);
  });

  it("is present when nothing depends on it, with its subtree", async () => {
    const out = await resolve(fixture, {}, { workspaces: [a, b] });
    expect(out.root.dependencies).toEqual({});
    expect(Object.keys(out.packages)).toEqual([
      "a@link:packages/a",
      "b@link:packages/b",
      "nanoid@5.0.0",
    ]);
    expect(out.packages["nanoid@5.0.0"]).toMatchObject({ dev: false, optional: false });
    const here = linux(out);
    expect(Object.keys(here.packages)).toEqual([
      "a@link:packages/a",
      "b@link:packages/b",
      "nanoid@5.0.0",
    ]);
    expect(here.packages["nanoid@5.0.0"]?.dev).toBe(false);
  });

  it("carries the declared patterns through, in either shape", async () => {
    const list = await resolve({}, { workspaces: ["packages/*"] });
    expect(list.root.workspaces).toEqual(["packages/*"]);
    const object = await resolve({}, { workspaces: { packages: ["apps/*", "!apps/skip"] } });
    expect(object.root.workspaces).toEqual(["apps/*", "!apps/skip"]);
    expect(linux(object).root.workspaces).toEqual(["apps/*", "!apps/skip"]);
    expect((await resolve({}, {})).root.workspaces).toBeUndefined();
  });

  it("defaults the version to 0.0.0 and the name to the folder", async () => {
    const out = await resolve({}, {}, { workspaces: [ws("tools/x", {})] });
    expect(out.packages["x@link:tools/x"]).toMatchObject({
      name: "x",
      version: "0.0.0",
      local: "tools/x",
    });
  });

  it("normalizes bin and records peers", async () => {
    const out = await resolve(
      { react: { "18.0.0": {} } },
      { devDependencies: { react: "^18" } },
      {
        workspaces: [
          ws("packages/p", {
            name: "p",
            bin: "./cli/../cli.js",
            peerDependencies: { react: "^18" },
          }),
        ],
      },
    );
    expect(out.packages["p@link:packages/p"]).toMatchObject({
      bin: { p: "cli.js" },
      peerDependencies: { react: "^18" },
      peers: { react: "required" },
      dependencies: { react: "18.0.0" },
    });
  });

  it("fails on a workspace's required dep the way it fails on the root's", async () => {
    const p = ws("p", { name: "p", version: "1.0.0", dependencies: { gone: "^1" } });
    const failing = resolve({}, {}, { workspaces: [p] });
    await expect(failing).rejects.toMatchObject({ code: "E404" });
    await expect(failing).rejects.toThrow("gone@^1 (required by p@link:p)");
    const optional = ws("p", { name: "p", version: "1.0.0", optionalDependencies: { gone: "^1" } });
    const out = await resolve({}, {}, { workspaces: [optional] });
    expect(out.warnings).toEqual(["skipped optional gone@^1 of p@link:p: 404 gone"]);
  });

  it("fails when a workspace's required peer can be met by nothing", async () => {
    const p = ws("p", { name: "p", version: "1.0.0", peerDependencies: { react: "^18" } });
    const failing = resolve({}, {}, { workspaces: [p] });
    await expect(failing).rejects.toMatchObject({ code: "E404" });
    await expect(failing).rejects.toThrow("react@^18 (required by p@link:p)");
  });

  it("refuses two workspaces with one name", async () => {
    const twice = resolve(
      {},
      {},
      { workspaces: [a, ws("other/a", { name: "a", version: "2.0.0" })] },
    );
    await expect(twice).rejects.toMatchObject({ code: "EWORKSPACE" });
    await expect(twice).rejects.toThrow("packages/a and other/a are both named a");
  });

  it("refuses a workspace whose name or version is not a package's", async () => {
    const bad = resolve({}, {}, { workspaces: [ws("p", { name: "a", version: "^1" })] });
    await expect(bad).rejects.toMatchObject({ code: "EWORKSPACE" });
    await expect(bad).rejects.toThrow("workspace at p has an invalid name or version (a@^1)");
  });

  it("refuses a workspace path the lockfile would refuse", async () => {
    for (const path of ["", "/srv/a", "../a", "packages/../a", "./a", "a//b", "a\\b", "a/"]) {
      const bad = resolve({}, {}, { workspaces: [ws(path, { name: "a", version: "1.0.0" })] });
      await expect(bad).rejects.toMatchObject({ code: "EWORKSPACE" });
      await expect(bad).rejects.toThrow(
        `workspace path ${path} is not a relative path inside the project`,
      );
    }
  });

  it("refuses a workspace that names itself with workspace:, and sends a plain range to the registry", async () => {
    const self = ws("packages/b", {
      name: "b",
      version: "1.0.0",
      dependencies: { b: "workspace:*" },
    });
    const failing = resolve(fixture, {}, { workspaces: [self] });
    await expect(failing).rejects.toMatchObject({ code: "EWORKSPACE" });
    await expect(failing).rejects.toThrow("workspace b cannot depend on itself");
    const dev = ws("packages/b", {
      name: "b",
      version: "1.0.0",
      devDependencies: { b: "workspace:^" },
    });
    await expect(resolve(fixture, {}, { workspaces: [dev] })).rejects.toThrow(
      "cannot depend on itself",
    );
    // A plain range on its own name is a registry dep, as it is for a registry package.
    const plain = ws("packages/b", { name: "b", version: "1.0.0", dependencies: { b: "^1" } });
    const { result, calls } = run(fixture, {}, { workspaces: [plain] });
    const out = await result;
    expect(calls).toEqual(["b"]);
    expect(out.packages["b@link:packages/b"]?.dependencies).toEqual({ b: "1.5.0" });
    expect(out.packages["b@1.5.0"]?.local).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  describe("a plain range", () => {
    it("takes the workspace when its version fits, from the root and from a workspace", async () => {
      const { result, calls } = run(
        fixture,
        { dependencies: { b: "1.0.0" } },
        { workspaces: [a, b] },
      );
      const out = await result;
      expect(calls).toEqual(["nanoid"]);
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
      expect(out.packages["a@link:packages/a"]?.dependencies).toEqual({ b: "link:packages/b" });
    });

    it("matches any version, a prerelease too, with *", async () => {
      const beta = ws("packages/b", { name: "b", version: "2.0.0-beta.1" });
      const out = await resolve(fixture, { dependencies: { b: "*" } }, { workspaces: [beta] });
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
      expect(out.packages["b@link:packages/b"]?.version).toBe("2.0.0-beta.1");
    });

    it("goes to the registry with a warning when the version does not fit", async () => {
      const { result, calls } = run(
        fixture,
        { dependencies: { b: "^2" } },
        {
          workspaces: [
            ws("packages/a", { name: "a", version: "1.0.0", dependencies: { b: "^2" } }),
            b,
          ],
        },
      );
      const out = await result;
      expect(calls).toEqual(["b", "nanoid"]);
      expect(out.root.dependencies).toEqual({ b: "2.0.0" });
      expect(out.packages["a@link:packages/a"]?.dependencies).toEqual({ b: "2.0.0" });
      expect(Object.keys(out.packages)).toEqual([
        "a@link:packages/a",
        "b@2.0.0",
        "b@link:packages/b",
        "nanoid@5.0.0",
      ]);
      expect(out.packages["b@2.0.0"]?.local).toBeUndefined();
      expect(out.warnings).toEqual([
        "workspace b@1.0.0 does not satisfy ^2 from a@link:packages/a; using the registry",
        "workspace b@1.0.0 does not satisfy ^2 from root; using the registry",
      ]);
    });

    it("never matches a tag", async () => {
      const failing = resolve(fixture, { dependencies: { b: "latest" } }, { workspaces: [b] });
      // The registry's latest is 2.0.0, which is nothing of the workspace's.
      const out = await failing;
      expect(out.packages["b@2.0.0"]?.local).toBeUndefined();
      expect(out.packages["b@link:packages/b"]?.local).toBe("packages/b");
    });

    it("sends an alias to the registry, even one named after a workspace", async () => {
      const { result, calls } = run(
        fixture,
        { dependencies: { c: "npm:b@^1" } },
        { workspaces: [b] },
      );
      const out = await result;
      expect(calls).toEqual(["b", "nanoid"]);
      expect(out.root.dependencies).toEqual({ c: "1.5.0" });
      expect(out.packages["c@1.5.0"]?.local).toBeUndefined();
    });

    it("does not capture a transitive registry dep that shares a workspace's name", async () => {
      const { result, calls } = run(
        { ...fixture, c: { "1.0.0": { dependencies: { b: "^1" } } } },
        { dependencies: { c: "^1" } },
        { workspaces: [b] },
      );
      const out = await result;
      expect(calls).toEqual(["c", "nanoid", "b"]);
      expect(out.packages["c@1.0.0"]?.dependencies).toEqual({ b: "1.5.0" });
      expect(out.packages["b@1.5.0"]?.local).toBeUndefined();
    });

    it("keeps a workspace and a registry package of the same name and version apart", async () => {
      // pnpm's edge form: the workspace is b@link:packages/b, the registry's b@1.0.0 its own key.
      const { result, calls } = run(
        { ...fixture, b: { "1.0.0": {} }, c: { "1.0.0": { dependencies: { b: "^1" } } } },
        { dependencies: { b: "^1", c: "^1" } },
        { workspaces: [b] },
      );
      const out = await result;
      expect(calls).toEqual(["c", "nanoid", "b"]);
      expect(out.root.dependencies).toEqual({ b: "link:packages/b", c: "1.0.0" });
      expect(out.packages["c@1.0.0"]?.dependencies).toEqual({ b: "1.0.0" });
      expect(Object.keys(out.packages)).toEqual([
        "b@1.0.0",
        "b@link:packages/b",
        "c@1.0.0",
        "nanoid@5.0.0",
      ]);
      expect(out.packages["b@1.0.0"]).toMatchObject({ integrity: "sha512-b1.0.0", dev: false });
      expect(out.packages["b@link:packages/b"]).toMatchObject({
        version: "1.0.0",
        local: "packages/b",
      });
      expect(out.warnings).toEqual([]);
      const lock = parseLockfile(formatLockfile(toLockfile(out)));
      expect(lock.root.dependencies).toEqual({ b: "link:packages/b", c: "1.0.0" });
      expect(Object.keys(lock.packages)).toEqual(["b@1.0.0", "c@1.0.0", "nanoid@5.0.0"]);
      expect(fromLockfile(lock)).toEqual(out);
    });
  });

  describe("a workspace: spec", () => {
    it.each([
      "workspace:*",
      "workspace:^",
      "workspace:~",
      "workspace:",
      "workspace:^1",
      "workspace:1.0.0",
    ])("%s takes the workspace", async (spec) => {
      const { result, calls } = run(fixture, { dependencies: { b: spec } }, { workspaces: [b] });
      const out = await result;
      expect(calls).toEqual(["nanoid"]);
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
    });

    it("takes a prerelease with *", async () => {
      const beta = ws("packages/b", { name: "b", version: "2.0.0-beta.1" });
      const out = await resolve({}, { dependencies: { b: "workspace:*" } }, { workspaces: [beta] });
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
      expect(out.packages["b@link:packages/b"]?.version).toBe("2.0.0-beta.1");
    });

    it("works from a workspace", async () => {
      const c = ws("packages/c", { name: "c", devDependencies: { b: "workspace:^1" } });
      const out = await resolve(fixture, {}, { workspaces: [b, c] });
      expect(out.packages["c@link:packages/c"]?.dependencies).toEqual({ b: "link:packages/b" });
    });

    it("fails when no workspace has the name, without asking the registry", async () => {
      const { result, calls } = run(fixture, { dependencies: { b: "workspace:*" } }, {});
      await expect(result).rejects.toMatchObject({ code: "EWORKSPACE" });
      await expect(result).rejects.toThrow("no workspace package named b");
      expect(calls).toEqual([]);
    });

    it("fails when the workspace's version does not satisfy the range", async () => {
      const { result, calls } = run(
        fixture,
        { dependencies: { b: "workspace:^2" } },
        { workspaces: [b] },
      );
      await expect(result).rejects.toMatchObject({ code: "EWORKSPACE" });
      await expect(result).rejects.toThrow("no workspace version of b satisfies ^2 (have 1.0.0)");
      expect(calls).not.toContain("b");
    });

    it("skips an optional edge that has no workspace", async () => {
      const out = await resolve(
        fixture,
        { optionalDependencies: { b: "workspace:^2" } },
        { workspaces: [b] },
      );
      expect(out.root.dependencies).toEqual({});
      expect(out.warnings).toEqual([
        "skipped optional b@workspace:^2 of root: no workspace version of b satisfies ^2 (have 1.0.0)",
      ]);
    });

    it("accepts the workspace named explicitly", async () => {
      const out = await resolve(
        fixture,
        { dependencies: { b: "workspace:b@*" } },
        { workspaces: [b] },
      );
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
    });

    it("refuses to install a workspace under another name", async () => {
      const failing = resolve(
        fixture,
        { dependencies: { foo: "workspace:b@*" } },
        { workspaces: [b] },
      );
      await expect(failing).rejects.toMatchObject({ code: "EWORKSPACE" });
      await expect(failing).rejects.toThrow("workspace b cannot be installed as foo");
    });
  });

  describe("dev and optional", () => {
    const tool = ws("packages/t", {
      name: "t",
      version: "1.0.0",
      dependencies: { nanoid: "^5" },
      devDependencies: { tap: "^1" },
      optionalDependencies: { fsevents: "^1" },
    });
    const registry: Fixture = {
      nanoid: { "5.0.0": {} },
      tap: { "1.0.0": { dependencies: { nanoid: "^5" } } },
      fsevents: { "1.0.0": { os: ["darwin"] } },
    };

    it("walks a workspace's devDependencies and marks them dev", async () => {
      const out = await resolve(registry, {}, { workspaces: [tool] });
      expect(out.packages["t@link:packages/t"]?.dependencies).toEqual({
        nanoid: "5.0.0",
        tap: "1.0.0",
      });
      expect(out.packages["t@link:packages/t"]?.optionalDependencies).toEqual({
        fsevents: "1.0.0",
      });
      expect(out.packages["tap@1.0.0"]).toMatchObject({ dev: true, optional: false });
      expect(out.packages["nanoid@5.0.0"]).toMatchObject({ dev: false, optional: false });
      expect(out.packages["fsevents@1.0.0"]).toMatchObject({ dev: false, optional: true });
    });

    it("keeps the flags through the platform filter", async () => {
      const out = linux(await resolve(registry, {}, { workspaces: [tool] }));
      expect(Object.keys(out.packages)).toEqual(["nanoid@5.0.0", "t@link:packages/t", "tap@1.0.0"]);
      expect(out.packages["t@link:packages/t"]).toMatchObject({ dev: false, optional: false });
      expect(out.packages["t@link:packages/t"]?.optionalDependencies).toBeUndefined();
      expect(out.packages["tap@1.0.0"]?.dev).toBe(true);
      expect(out.packages["nanoid@5.0.0"]?.dev).toBe(false);
      expect(out.warnings).toEqual([]);
    });

    it("a dev-only workspace edge does not ship a dev dependency of the root", async () => {
      const out = await resolve(
        registry,
        { devDependencies: { tap: "^1" } },
        { workspaces: [ws("packages/t", { name: "t", devDependencies: { tap: "^1" } })] },
      );
      expect(out.packages["tap@1.0.0"]?.dev).toBe(true);
      expect(out.packages["nanoid@5.0.0"]?.dev).toBe(true);
    });

    it("fails when a workspace's required dep cannot run here", async () => {
      const out = await resolve(
        registry,
        {},
        { workspaces: [ws("packages/t", { name: "t", dependencies: { fsevents: "^1" } })] },
      );
      expect(() => linux(out)).toThrow(expect.objectContaining({ code: "EBADPLATFORM" }));
    });
  });

  describe("peers", () => {
    const react: Fixture = {
      react: { "18.0.0": {}, "17.0.0": {} },
      plugin: { "1.0.0": { peerDependencies: { react: "^18" } } },
    };

    it("settles a workspace's required peer from the tree", async () => {
      const p = ws("packages/p", { name: "p", peerDependencies: { react: "^17" } });
      const { result, calls } = run(
        react,
        { dependencies: { react: "17.0.0" } },
        { workspaces: [p] },
      );
      const out = await result;
      expect(calls).toEqual(["react"]);
      expect(out.packages["p@link:packages/p"]?.dependencies).toEqual({ react: "17.0.0" });
    });

    it("fetches a workspace's peer when the tree has none", async () => {
      const p = ws("packages/p", { name: "p", peerDependencies: { react: "^18" } });
      const out = await resolve(react, {}, { workspaces: [p] });
      expect(out.packages["p@link:packages/p"]?.dependencies).toEqual({ react: "18.0.0" });
      expect(out.packages["react@18.0.0"]?.dev).toBe(false);
    });

    it("settles a workspace's peer on another workspace", async () => {
      const p = ws("packages/p", { name: "p", peerDependencies: { b: "^1" } });
      const out = await resolve(fixture, {}, { workspaces: [b, p] });
      expect(out.packages["p@link:packages/p"]?.dependencies).toEqual({ b: "link:packages/b" });
    });

    it("reports an unmet peer on a workspace by the workspace's version", async () => {
      const p = ws("packages/p", { name: "p", peerDependencies: { b: "^1" } });
      expect(unmetPeers(await resolve(fixture, {}, { workspaces: [b, p] }))).toEqual([]);
      const strict = ws("packages/p", {
        name: "p",
        dependencies: { b: "workspace:*" },
        peerDependencies: { b: "^2" },
      });
      expect(unmetPeers(await resolve(fixture, {}, { workspaces: [b, strict] }))).toEqual([
        "p@link:packages/p needs peer b@^2, and the tree installs b@1.0.0",
      ]);
    });

    it("never settles a registry package's peer on a workspace", async () => {
      const plugin: Fixture = {
        ...fixture,
        plugin: { "1.0.0": { peerDependencies: { b: "^1" } } },
      };
      const out = await resolve(plugin, { dependencies: { plugin: "^1" } }, { workspaces: [b] });
      // b@1.5.0 comes from the registry; the workspace's b@1.0.0 is not offered.
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ b: "1.5.0" });
      expect(out.packages["b@1.5.0"]?.local).toBeUndefined();
    });

    it("does not wire a registry package's optional peer to a workspace", async () => {
      const plugin: Fixture = {
        ...fixture,
        plugin: {
          "1.0.0": {
            peerDependencies: { b: "^1" },
            peerDependenciesMeta: { b: { optional: true } },
          },
        },
      };
      const out = await resolve(plugin, { dependencies: { plugin: "^1" } }, { workspaces: [b] });
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({});
      expect(out.packages["plugin@1.0.0"]?.optionalDependencies).toBeUndefined();
    });
  });

  describe("with a lockfile", () => {
    it("never replays a local entry, and never keeps a locked version a workspace now fits", async () => {
      const root: RootManifest = { dependencies: { b: "^1" } };
      const older = await resolve(fixture, { dependencies: { b: "~1.5" } });
      expect(older.root.dependencies).toEqual({ b: "1.5.0" });
      // b became a workspace: the locked registry b is not kept, and nothing is fetched for it.
      const { result, calls } = run(fixture, root, { locked: older, workspaces: [b] });
      const out = await result;
      expect(calls).toEqual(["nanoid"]);
      expect(out.root.dependencies).toEqual({ b: "link:packages/b" });
      expect(out.packages["b@link:packages/b"]?.local).toBe("packages/b");
      expect(out.packages["b@1.5.0"]).toBeUndefined();
    });

    it("reads a workspace from disk, not from the lock", async () => {
      const first = await resolve(fixture, {}, { workspaces: [b] });
      const moved = ws("packages/b", { name: "b", version: "1.0.0", dependencies: {} });
      const { result, calls } = run(fixture, {}, { locked: first, workspaces: [moved] });
      const out = await result;
      expect(calls).toEqual([]);
      expect(out.packages["b@link:packages/b"]?.dependencies).toEqual({});
      expect(out.packages["nanoid@5.0.0"]).toBeUndefined();
    });

    it("survives the lockfile", async () => {
      const out = await resolve(
        fixture,
        { dependencies: { a: "^1" }, workspaces: ["packages/*"] },
        { workspaces: [a, b] },
      );
      const lock = parseLockfile(formatLockfile(toLockfile(out)));
      expect(lock.workspaces).toEqual({
        "packages/a": {
          name: "a",
          version: "1.0.0",
          specs: { dependencies: { b: "^1" } },
          dependencies: { b: "link:packages/b" },
        },
        "packages/b": {
          name: "b",
          version: "1.0.0",
          specs: { dependencies: { nanoid: "^5" } },
          dependencies: { nanoid: "5.0.0" },
        },
      });
      expect(Object.keys(lock.packages)).toEqual(["nanoid@5.0.0"]);
      expect(lock.root.workspaces).toEqual(["packages/*"]);
      expect(fromLockfile(lock)).toEqual(out);
    });
  });
});

describe("tarball dependencies", () => {
  const url = "https://t.test/a-1.0.0.tgz";
  const fixture: Fixture = {
    nanoid: { "5.0.0": {} },
    a: { "1.0.0": {} },
    c: { "1.0.0": { dependencies: { a: "^1" } } },
    host: { "2.0.0": {} },
    plugin: { "1.0.0": { peerDependencies: { host: "^2" } } },
  };

  /**
   * A reader over inline package.jsons, recording each source it is asked for, with the
   * integrity it was pinned to if any. A source in `slow` answers a tick later.
   */
  function tarballs(found: Record<string, Partial<Manifest>>, slow = new Set<string>()) {
    const reads: string[] = [];
    const tarball = async (source: string, pinned?: string): Promise<Manifest> => {
      reads.push(pinned === undefined ? source : `${source} ${pinned}`);
      if (slow.has(source)) await new Promise((done) => setTimeout(done, 10));
      const m = found[source];
      if (!m) throw Object.assign(new Error(`cannot read ${source}`), { code: "ENOENT" });
      const dist = { tarball: source, integrity: `sha512-${source}` };
      return { name: "x", version: "1.0.0", ...m, dist };
    };
    return { tarball, reads };
  }

  const found = {
    [url]: { name: "a", dependencies: { nanoid: "^5" } },
    "file:vendor/b.tgz": { name: "b", version: "2.0.0" },
  };

  it("keys each by where it is, apart from the registry's copy of the same version", async () => {
    const { tarball, reads } = tarballs(found);
    const root = { dependencies: { a: url, b: "file:./vendor/b.tgz", c: "^1" } };
    const out = await resolve(fixture, root, { tarball });
    expect(reads).toEqual([url, "file:vendor/b.tgz"]);
    expect(out.root.dependencies).toEqual({ a: url, b: "file:vendor/b.tgz", c: "1.0.0" });
    expect(Object.keys(out.packages)).toEqual([
      "a@1.0.0",
      `a@${url}`,
      "b@file:vendor/b.tgz",
      "c@1.0.0",
      "nanoid@5.0.0",
    ]);
    expect(out.packages[`a@${url}`]).toEqual({
      name: "a",
      version: "1.0.0",
      resolved: url,
      integrity: `sha512-${url}`,
      source: url,
      dependencies: { nanoid: "5.0.0" },
      optional: false,
      dev: false,
      bin: {},
    });
    expect(out.packages["c@1.0.0"]?.dependencies).toEqual({ a: "1.0.0" });
    // Named by the version inside, one path segment; a different entry from the registry's.
    const keys = await storeKeys(out.packages);
    expect(keys[`a@${url}`]).toMatch(/^a@1\.0\.0-/);
    expect(keys[`a@${url}`]).not.toBe(keys["a@1.0.0"]);
    expect(keys["b@file:vendor/b.tgz"]).toMatch(/^b@2\.0\.0-/);
  });

  it("survives the lockfile, and a locked one is never read again", async () => {
    const { tarball } = tarballs(found);
    const root = { dependencies: { a: url, b: "file:vendor/b.tgz" } };
    const out = await resolve(fixture, root, { tarball });
    const lock = parseLockfile(formatLockfile(toLockfile(out)));
    expect(lock.packages[`a@${url}`]).toEqual({
      version: "1.0.0",
      integrity: `sha512-${url}`,
      dependencies: { nanoid: "5.0.0" },
    });
    expect(lock.packages["b@file:vendor/b.tgz"]).toEqual({
      version: "2.0.0",
      integrity: "sha512-file:vendor/b.tgz",
    });
    expect(fromLockfile(lock)).toEqual(out);

    const again = tarballs({});
    const grown = { dependencies: { ...root.dependencies, c: "^1" } };
    const next = await resolve(fixture, grown, {
      tarball: again.tarball,
      locked: fromLockfile(lock),
    });
    expect(again.reads).toEqual([]);
    expect(next.packages[`a@${url}`]).toEqual(out.packages[`a@${url}`]);
  });

  it("is walked again when deduping, from the bytes the lock pinned", async () => {
    const t = { [url]: { name: "a", dependencies: { b: "^1" } } };
    const before: Fixture = { b: { "1.0.0": {} } };
    const after: Fixture = {
      b: { "1.0.0": {}, "1.1.0": {} },
      c: { "1.0.0": { dependencies: { b: "^1.1" } } },
    };
    const first = await resolve(
      before,
      { dependencies: { a: url } },
      { tarball: tarballs(t).tarball },
    );
    const lock = fromLockfile(parseLockfile(formatLockfile(toLockfile(first))));
    const grown = { dependencies: { a: url, c: "^1" } };
    // Kept as locked, the tarball holds on to b@1.0.0 beside the b@1.1.0 that c needs.
    const kept = await resolve(after, grown, { tarball: tarballs(t).tarball, locked: lock });
    expect(Object.keys(kept.packages)).toContain("b@1.0.0");
    // Deduping, its range gets to choose again: the second pass settles on one b.
    const again = tarballs(t);
    const options = { tarball: again.tarball, dedupe: true };
    const pass = await resolve(after, grown, { ...options, locked: lock });
    const last = await resolve(after, grown, { ...options, locked: pass });
    // Once a pass, and never for other bytes than the lock's.
    expect(again.reads).toEqual([`${url} sha512-${url}`, `${url} sha512-${url}`]);
    expect(Object.keys(last.packages)).toEqual([`a@${url}`, "b@1.1.0", "c@1.0.0"]);
    expect(last.packages[`a@${url}`]?.integrity).toBe(`sha512-${url}`);
  });

  it("reads a path from the package.json that declares it", async () => {
    const { tarball, reads } = tarballs(found);
    const w = {
      path: "packages/w",
      manifest: { name: "w", version: "1.0.0", dependencies: { b: "file:../../vendor/b.tgz" } },
    };
    const root = { dependencies: { b: "file:vendor/b.tgz" } };
    const out = await resolve(fixture, root, { tarball, workspaces: [w] });
    expect(reads).toEqual(["file:vendor/b.tgz"]);
    expect(out.packages["w@link:packages/w"]?.dependencies).toEqual({ b: "file:vendor/b.tgz" });
  });

  it("takes a path from the root and workspaces only", async () => {
    const { tarball } = tarballs({ [url]: { name: "a", dependencies: { b: "file:b.tgz" } } });
    await expect(resolve(fixture, { dependencies: { a: url } }, { tarball })).rejects.toMatchObject(
      {
        code: "EINVALIDSPEC",
        message: expect.stringMatching(/root or a workspace only/),
      },
    );
    const soft = tarballs({ [url]: { name: "a", optionalDependencies: { b: "file:b.tgz" } } });
    const out = await resolve(fixture, { dependencies: { a: url } }, { tarball: soft.tarball });
    expect(out.warnings).toEqual([
      expect.stringMatching(/^skipped optional b@file:b.tgz of a@https:.*root or a workspace only/),
    ]);
  });

  it("fails one with nothing to read it, and an optional one quietly", async () => {
    await expect(resolve(fixture, { dependencies: { a: url } })).rejects.toMatchObject({
      code: "EINVALIDSPEC",
    });
    const out = await resolve(fixture, { optionalDependencies: { a: url } });
    expect(out.packages).toEqual({});
    expect(out.warnings).toHaveLength(1);
  });

  it("is the host a plugin's peer settles on", async () => {
    const host = "https://t.test/host.tgz";
    const { tarball } = tarballs({ [host]: { name: "host", version: "2.1.0" } });
    const root = { dependencies: { host, plugin: "^1" } };
    const { result, count } = run(fixture, root, { tarball });
    const out = await result;
    expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host });
    expect(count("host")).toBe(0);
    expect(unmetPeers(out)).toEqual([]);
  });

  it("gives a peer the copy of a version its top links, not the registry's", async () => {
    const peers: Fixture = {
      host: { "2.0.0": {} },
      lib: { "1.0.0": { dependencies: { host: "^2" } } },
      plugin: { "1.0.0": { peerDependencies: { host: "^2" } } },
    };
    const { tarball } = tarballs({ "file:host.tgz": { name: "host", version: "2.0.0" } });
    const root = { dependencies: { host: "file:host.tgz", lib: "^1", plugin: "^1" } };
    const out = await resolve(peers, root, { tarball });
    expect(out.packages["lib@1.0.0"]?.dependencies).toEqual({ host: "2.0.0" });
    expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: "file:host.tgz" });
  });

  it("settles a peer between two copies no top links the same way, whichever is read first", async () => {
    const [one, two] = ["https://t.test/host-1.tgz", "https://t.test/host-2.tgz"];
    const found = {
      [one]: { name: "host", version: "2.0.0" },
      [two]: { name: "host", version: "2.0.0" },
      "https://t.test/x.tgz": { name: "x", dependencies: { host: two } },
      "https://t.test/y.tgz": { name: "y", dependencies: { host: one } },
    };
    const root = {
      dependencies: { x: "https://t.test/x.tgz", y: "https://t.test/y.tgz", plugin: "^1" },
    };
    for (const slow of [one, two]) {
      const { tarball } = tarballs(found, new Set([slow]));
      const out = await resolve(fixture, root, { tarball });
      expect(out.packages["plugin@1.0.0"]?.dependencies).toEqual({ host: one });
    }
  });

  it("reads no libc for a linux build: its package.json is whole", async () => {
    const { tarball } = tarballs({ [url]: { name: "a", os: ["linux"], cpu: ["x64"] } });
    const { result, manifests } = run(fixture, { dependencies: { a: url } }, { tarball });
    expect(Object.keys((await result).packages)).toEqual([`a@${url}`]);
    expect(manifests).toEqual([]);
  });
});
