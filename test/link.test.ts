import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashOf } from "./hash.ts";
import { binOf, linkOf, readBin } from "./link.ts";
import { linkArgs, readLink } from "../src/util.ts";
import { storeKeys } from "../src/keys.ts";
import { builtin } from "../src/builtin.ts";
import { linkTree } from "../src/link.ts";
import type { Progress } from "../src/api.ts";
import type { ResolvedPackage, Resolution } from "../src/resolve.ts";
import { STATE_FILE, readState, stateHash } from "../src/state.ts";
import { createStore } from "../src/store.ts";
import type { FileEntry, Store } from "../src/store.ts";
import { makeTarball } from "./tarball.ts";

/** Counts what the linker asks of the filesystem, so "one stat, not thousands" is assertable. */
const counted = vi.hoisted(() => ({ stat: [] as string[], readdir: [] as string[] }));
// Counted through `builtin`, which is where src reaches every node builtin: mocking
// `node:fs/promises` itself would no longer be on the path src takes.
vi.mock("../src/builtin.ts", async (importOriginal) => {
  const real = (await importOriginal<typeof import("../src/builtin.ts")>()).builtin;
  const fsp = real.fsp;
  return {
    builtin: {
      ...real,
      fsp: {
        ...fsp,
        stat: (path: string, ...rest: unknown[]) => {
          counted.stat.push(String(path));
          return (fsp.stat as (...args: unknown[]) => unknown)(path, ...rest);
        },
        readdir: (path: string, ...rest: unknown[]) => {
          counted.readdir.push(String(path));
          return (fsp.readdir as (...args: unknown[]) => unknown)(path, ...rest);
        },
      },
    },
  };
});

interface Fixture {
  name: string;
  version?: string;
  files?: Record<string, string>;
  bin?: Record<string, string>;
  deps?: Record<string, string>;
  optDeps?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
}

let root: string;
let project: string;
let storeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "upm-link-"));
  project = join(root, "project");
  storeDir = join(root, "store");
  counted.stat.length = 0;
  counted.readdir.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("linkTree", () => {
  it("builds the isolated layout: real files in .upm, direct deps at the top", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "module.exports = 'a'" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "module.exports = 'b'" } },
    ]);
    const keys = await storeKeys(resolution.packages);
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.entries).toBe(2);
    expect(result.reused).toBe(0);
    expect(result.linked + result.copied).toBe(4); // package.json + index.js, twice

    const nm = join(project, "node_modules");
    const keyA = keys["a@1.0.0"] as string;
    const keyB = keys["b@1.0.0"] as string;
    expect(keyA).toMatch(/^a@1\.0\.0-[\w-]+$/);

    // Top level: a symlink for the one direct dep, pointing into .upm.
    expect(await linkOf(join(nm, "a"))).toBe(`.upm/${keyA}/node_modules/a`);
    expect(await read(join(nm, "a", "index.js"))).toBe("module.exports = 'a'");

    // The entry's own copy of its dep, relative so the tree survives a move.
    const inside = join(nm, ".upm", keyA, "node_modules", "b");
    expect(await linkOf(inside)).toBe(`../../${keyB}/node_modules/b`);
    expect(await read(join(inside, "index.js"))).toBe("module.exports = 'b'");

    // Real files live in the .upm entry, not behind a symlink.
    expect((await lstat(join(nm, ".upm", keyA, "node_modules", "a"))).isDirectory()).toBe(true);
  });

  it("places files under every depth of nesting, siblings and scoped alike", async () => {
    const files = {
      "index.js": "root",
      "a/one.js": "1",
      "a/b/two.js": "2",
      "a/b/c/d/e/five.js": "5",
      "a/c/three.js": "3",
      "x/y/z/four.js": "4",
    };
    const { store, resolution } = await seed([
      { name: "@s/deep", files, deps: { flat: "1.0.0" } },
      { name: "flat", files: { "index.js": "f" } },
    ]);
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.linked + result.copied).toBe(Object.keys(files).length + 1 + 2);
    const at = join(project, "node_modules", "@s", "deep");
    for (const [path, body] of Object.entries(files)) {
      expect(await read(join(at, path))).toBe(body);
    }
    expect((await lstat(join(at, "a", "b", "c", "d"))).isDirectory()).toBe(true);
  });

  it("links an optional edge the same as a required one", async () => {
    // The two maps only exist so filterPlatform can tell them apart; a survivor is a dep.
    const { store, resolution } = await seed([
      {
        name: "a",
        files: { "index.js": "module.exports = require('b')" },
        optDeps: { b: "1.0.0" },
      },
      { name: "b", files: { "index.js": "module.exports = 'b'" }, optional: true },
    ]);
    const keys = await storeKeys(resolution.packages);
    await linkTree(resolution, { dir: project, store });

    const inside = join(project, "node_modules", ".upm", keys["a@1.0.0"]!, "node_modules", "b");
    expect(await linkOf(inside)).toBe(`../../${keys["b@1.0.0"]!}/node_modules/b`);
    expect(createRequire(join(project, "index.js"))("a")).toBe("b");
  });

  it("does not put a transitive dep at the top level", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "module.exports = require('b')" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "module.exports = 'b'" } },
    ]);
    await linkTree(resolution, { dir: project, store });

    const nm = join(project, "node_modules");
    expect(await exists(join(nm, "a"))).toBe(true);
    expect(await exists(join(nm, "b"))).toBe(false);
    // Node resolves from the realpath, so a sees b and the project does not. That strictness
    // is the whole point of the layout: you can only import what you declared.
    const fromRoot = createRequire(join(project, "index.js"));
    expect(fromRoot("a")).toBe("b"); // a found b, through its own entry
    expect(() => fromRoot.resolve("b")).toThrow();
  });

  it("hardlinks from the store instead of copying", async () => {
    const { store, resolution, integrity } = await seed([
      { name: "a", files: { "index.js": "shared bytes" } },
    ]);
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.copied).toBe(0);
    expect(result.linked).toBe(2);

    const index = await store.index(integrity["a@1.0.0"] as string);
    const file = index?.files.find((entry) => entry.path === "index.js") as FileEntry;
    const source = await stat(store.blobPath(file));
    const placed = await stat(join(project, "node_modules", "a", "index.js"));
    expect(placed.ino).toBe(source.ino);
    expect(placed.dev).toBe(source.dev);
    expect(source.nlink).toBeGreaterThan(1);
  });

  it("replaces what another install left at a bin's name, never writing through a link", async (ctx) => {
    const { store, resolution } = await seed([
      { name: "a", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { a: "cli.js" } },
    ]);
    const bin = join(project, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    // An older upm's Windows bin was a link to a file: a write through it would reach the store.
    const victim = join(root, "victim.js");
    await writeFile(victim, "keep");
    // Linking a file on Windows needs Developer Mode or admin, which CI has.
    const refused = (error: { code?: string }) => (error.code === "EPERM" ? ctx.skip() : error);
    await symlink(victim, join(bin, "a")).catch((error) => Promise.reject(refused(error)));
    await writeFile(join(bin, "a.cmd"), "stale");

    await linkTree(resolution, { dir: project, store });
    expect(await read(victim)).toBe("keep");
    expect(await binOf(join(bin, "a"))).toBe("../a/cli.js");
    expect(await readBin(join(bin, "a"))).toBe("#!/usr/bin/env node\n");
    if (process.platform === "win32") expect(await read(join(bin, "a.cmd"))).not.toBe("stale");
  });

  it.runIf(process.platform === "win32")(
    "writes a Windows bin as its three shims, and sweeps them together",
    async () => {
      const { store, resolution } = await seed([
        { name: "a", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { a: "cli.js" } },
        { name: "b", files: { "b.exe": "MZ" }, bin: { b: "b.exe" } },
      ]);
      const bin = join(project, "node_modules", ".bin");
      await linkTree(resolution, { dir: project, store });
      expect((await readdir(bin)).sort()).toEqual(["a", "a.cmd", "a.ps1", "b", "b.cmd", "b.ps1"]);
      expect(await read(join(bin, "a.cmd"))).toContain('"node" "%dp0%\\..\\a\\cli.js" %*');
      expect(await read(join(bin, "b.cmd"))).toContain('"%dp0%\\..\\b\\b.exe" %*');
      // The `.cmd` is what cmd runs, so the tree is not up to date without it.
      await rm(join(bin, "a.cmd"));
      expect((await linkTree(resolution, { dir: project, store })).upToDate).toBe(false);
      expect(await exists(join(bin, "a.cmd"))).toBe(true);

      drop(resolution, "b@1.0.0");
      expect((await linkTree(resolution, { dir: project, store })).removed).toBe(2);
      expect((await readdir(bin)).sort()).toEqual(["a", "a.cmd", "a.ps1"]);
    },
  );

  it("links .bin for direct deps and for each entry's own deps", async () => {
    const { store, resolution } = await seed([
      {
        name: "a",
        files: { "cli.js": "#!/usr/bin/env node\n" },
        bin: { a: "cli.js" },
        deps: { b: "1.0.0" },
      },
      { name: "b", files: { "run.js": "#!/usr/bin/env node\n" }, bin: { runner: "run.js" } },
    ]);
    const keys = await storeKeys(resolution.packages);
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.bins).toBe(2);
    const nm = join(project, "node_modules");
    // Only the direct dep's bin is at the top.
    expect(await binOf(join(nm, ".bin", "a"))).toBe("../a/cli.js");
    expect(await exists(join(nm, ".bin", "runner"))).toBe(false);
    // a's own dep's bin lives inside a's entry.
    const entryBin = join(nm, ".upm", keys["a@1.0.0"] as string, "node_modules", ".bin", "runner");
    expect(await binOf(entryBin)).toBe("../b/run.js");

    // The target must already be executable: the store keeps an -exec variant for it.
    // Windows has no exec bit to check.
    for (const bin of process.platform === "win32" ? [] : [join(nm, ".bin", "a"), entryBin]) {
      expect((await stat(bin)).mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("resolves a bin name collision last-wins", async () => {
    const { store, resolution } = await seed([
      { name: "first", files: { "x.js": "1" }, bin: { same: "x.js" } },
      { name: "second", files: { "y.js": "2" }, bin: { same: "y.js" } },
    ]);
    await linkTree(resolution, { dir: project, store });

    const bin = join(project, "node_modules", ".bin", "same");
    expect(await binOf(bin)).toBe("../second/y.js");
    expect(await readBin(bin)).toBe("2");
  });

  it("nests scoped names at both levels", async () => {
    const { store, resolution } = await seed([
      { name: "@scope/a", files: { "index.js": "a" }, deps: { "@scope/b": "1.0.0" } },
      { name: "@scope/b", files: { "index.js": "b" } },
    ]);
    const keys = await storeKeys(resolution.packages);
    const nm = join(project, "node_modules");
    await linkTree(resolution, { dir: project, store });

    const keyA = keys["@scope/a@1.0.0"] as string;
    const keyB = keys["@scope/b@1.0.0"] as string;
    expect(keyA).toContain("@scope+a@1.0.0-"); // the key itself stays one path segment

    expect(await linkOf(join(nm, "@scope", "a"))).toBe(`../.upm/${keyA}/node_modules/@scope/a`);
    expect(await read(join(nm, "@scope", "a", "index.js"))).toBe("a");
    const inside = join(nm, ".upm", keyA, "node_modules", "@scope", "b");
    expect(await linkOf(inside)).toBe(`../../../${keyB}/node_modules/@scope/b`);
    expect(await read(join(inside, "index.js"))).toBe("b");
  });

  it("spells every dep link the way path.relative would, whichever side is scoped", async () => {
    // Plain and scoped on both ends, two scopes in one entry, and a scoped entry whose deps
    // are all in its own scope. The targets are spelled from the layout, not computed, so
    // this is the one place they are checked against the general answer.
    const { store, resolution } = await seed([
      { name: "a", files: { "i.js": "" }, deps: { b: "1.0.0", "@s/c": "1.0.0", "@t/d": "1.0.0" } },
      {
        name: "@s/c",
        files: { "i.js": "" },
        deps: { b: "1.0.0", "@t/d": "1.0.0", "@s/e": "1.0.0" },
      },
      { name: "@s/f", files: { "i.js": "" }, deps: { "@s/e": "1.0.0" } },
      { name: "b", files: { "i.js": "" } },
      { name: "@t/d", files: { "i.js": "" } },
      { name: "@s/e", files: { "i.js": "" } },
    ]);
    const keys = await storeKeys(resolution.packages);
    const first = await linkTree(resolution, { dir: project, store });
    expect(first.entries).toBe(6);

    const nm = join(project, "node_modules");
    let checked = 0;
    for (const pkg of Object.values(resolution.packages)) {
      const nmDir = join(nm, ".upm", keys[`${pkg.name}@${pkg.version}`] as string, "node_modules");
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        const at = join(nmDir, name);
        const to = join(nm, ".upm", keys[`${name}@${version}`] as string, "node_modules", name);
        expect(await readLink(at)).toBe(relative(dirname(at), to));
        expect((await stat(at)).isDirectory()).toBe(true); // it resolves
        checked++;
      }
    }
    expect(checked).toBe(7);

    // And `intact` reads them back as its own: nothing is rebuilt.
    const again = await linkTree(resolution, { dir: project, store, verify: true });
    expect(again).toMatchObject({ entries: 0, repaired: 0, reused: 6 });
  });

  it("leaves entries alone on a second run", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    const first = await linkTree(resolution, { dir: project, store });
    const second = await linkTree(resolution, { dir: project, store });

    expect(first).toMatchObject({ entries: 2, reused: 0 });
    expect(second).toMatchObject({ entries: 0, reused: 2, linked: 0, copied: 0 });
    expect(await read(join(project, "node_modules", "a", "index.js"))).toBe("a");
  });

  it("skips dev-only packages with production", async () => {
    const { store, resolution } = await seed(
      [
        { name: "a", files: { "index.js": "a" } },
        { name: "tool", files: { "index.js": "t" }, dev: true },
      ],
      { a: "1.0.0", tool: "1.0.0" },
    );
    const result = await linkTree(resolution, { dir: project, store, production: true });

    const nm = join(project, "node_modules");
    expect(result.entries).toBe(1);
    expect(await exists(join(nm, "a"))).toBe(true);
    expect(await exists(join(nm, "tool"))).toBe(false);
    expect((await readdir(join(nm, ".upm"))).sort()).toEqual([
      expect.stringMatching(/^a@/),
      "node_modules",
    ]);
  });

  it("links a cycle without hanging", async () => {
    const { store, resolution } = await seed(
      [
        { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
        { name: "b", files: { "index.js": "b" }, deps: { a: "1.0.0" } },
      ],
      { a: "1.0.0" },
    );
    const keys = await storeKeys(resolution.packages);
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.entries).toBe(2);
    const nm = join(project, "node_modules");
    const keyA = keys["a@1.0.0"] as string;
    const keyB = keys["b@1.0.0"] as string;
    expect(await read(join(nm, ".upm", keyA, "node_modules", "b", "index.js"))).toBe("b");
    expect(await read(join(nm, ".upm", keyB, "node_modules", "a", "index.js"))).toBe("a");
    // Both halves of a cycle share one subgraph, so their keys carry the same hash.
    expect(keyA.split("-").at(-1)).toBe(keyB.split("-").at(-1));
  });

  it("drops an optional package the store never got, and fails on a required one", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" }, optional: true },
    ]);
    // Pretend the fetch step skipped the optional: point it at an integrity nothing stored.
    const b = resolution.packages["b@1.0.0"] as ResolvedPackage;
    b.integrity = hashOf(Buffer.from("never stored"));
    await linkTree(resolution, { dir: project, store });
    expect(await exists(join(project, "node_modules", "a", "node_modules", "b"))).toBe(false);

    b.optional = false;
    await expect(linkTree(resolution, { dir: join(root, "other"), store })).rejects.toMatchObject({
      code: "ELINK",
    });
  });

  it("takes an optional dropped while the store fills out of its progress total", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" }, optional: true },
    ]);
    const b = resolution.packages["b@1.0.0"] as ResolvedPackage;
    b.integrity = hashOf(Buffer.from("never stored"));
    const seen: Progress[] = [];
    // Still filling: the drop is known only once the total is taken.
    const awaiting = async () => {};
    await linkTree(resolution, { dir: project, store, awaiting, onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toEqual({ phase: "link", done: 1, total: 1 });
  });

  it("drops an optional package whose index is torn, and fails on a required one", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" }, optional: true },
    ]);
    const b = resolution.packages["b@1.0.0"] as ResolvedPackage;
    await writeFile(store.indexPath(b.integrity), '{"integrity');
    // A store that has not read the index yet: the one that seeded it remembers the whole one.
    const fresh = createStore({ dir: store.dir });
    const result = await linkTree(resolution, { dir: project, store: fresh });
    expect(result.dropped).toEqual(["b@1.0.0"]);
    expect(await exists(join(project, "node_modules", "a", "node_modules", "b"))).toBe(false);

    b.optional = false;
    await expect(
      linkTree(resolution, { dir: join(root, "other"), store: fresh }),
    ).rejects.toMatchObject({ code: "ELINK" });
  });
});

describe("linkTree sweep", () => {
  it("drops a removed dependency's top-level link and its bin, and counts both", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { a: "cli.js" } },
      { name: "b", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { b: "cli.js" } },
    ]);
    const nm = join(project, "node_modules");
    await linkTree(resolution, { dir: project, store });
    expect(await exists(join(nm, "b"))).toBe(true);
    expect(await exists(join(nm, ".bin", "b"))).toBe(true);

    drop(resolution, "b@1.0.0");
    const second = await linkTree(resolution, { dir: project, store });

    expect(second.removed).toBe(2); // the package link and its shim
    expect(await exists(join(nm, "b"))).toBe(false);
    expect(await exists(join(nm, ".bin", "b"))).toBe(false);
    // The one still declared is untouched, link and shim both.
    expect(await linkOf(join(nm, "a"))).toMatch(/^\.upm\/a@1\.0\.0-/);
    expect(await binOf(join(nm, ".bin", "a"))).toBe("../a/cli.js");
    if (process.platform !== "win32") {
      expect((await stat(join(nm, ".bin", "a"))).mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("removes an @scope directory once it empties, and keeps it while it does not", async () => {
    const { store, resolution } = await seed([
      { name: "@scope/a", files: { "index.js": "a" } },
      { name: "@scope/b", files: { "index.js": "b" } },
    ]);
    const nm = join(project, "node_modules");
    await linkTree(resolution, { dir: project, store });

    drop(resolution, "@scope/b@1.0.0");
    expect((await linkTree(resolution, { dir: project, store })).removed).toBe(1);
    expect(await exists(join(nm, "@scope", "b"))).toBe(false);
    expect(await read(join(nm, "@scope", "a", "index.js"))).toBe("a"); // still there

    drop(resolution, "@scope/a@1.0.0");
    expect((await linkTree(resolution, { dir: project, store })).removed).toBe(1);
    expect(await exists(join(nm, "@scope"))).toBe(false);
  });

  it("leaves real directories, .upm and a concurrent install's .tmp-* alone", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    const nm = join(project, "node_modules");
    await linkTree(resolution, { dir: project, store });

    // Hand-placed by a user or another tool, plus an entry another install is mid-write.
    await mkdir(join(nm, "mine"), { recursive: true });
    await writeFile(join(nm, "mine", "note.txt"), "keep me");
    const temp = join(nm, ".upm", ".tmp-9999-0");
    await mkdir(temp, { recursive: true });

    const second = await linkTree(resolution, { dir: project, store });
    expect(second.removed).toBe(0);
    expect(await read(join(nm, "mine", "note.txt"))).toBe("keep me");
    expect(await exists(temp)).toBe(true);
    expect(await exists(join(nm, ".upm"))).toBe(true);
  });

  it("removes the link, not what it points at", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    const nm = join(project, "node_modules");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "data.txt"), "not ours to delete");
    await mkdir(nm, { recursive: true });
    await symlink("../../outside", join(nm, "ghost"));

    expect((await linkTree(resolution, { dir: project, store })).removed).toBe(1);
    expect(await exists(join(nm, "ghost"))).toBe(false);
    expect(await read(join(outside, "data.txt"))).toBe("not ours to delete");
  });

  it("sweeps a stale dep and bin inside a reused .upm entry", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    const keys = await storeKeys(resolution.packages);
    await linkTree(resolution, { dir: project, store });

    // What an entry written by an older upm could hold: a dep we no longer resolve.
    const entryNm = join(
      project,
      "node_modules",
      ".upm",
      keys["a@1.0.0"] as string,
      "node_modules",
    );
    await symlink("../../nowhere", join(entryNm, "ghost"));
    await mkdir(join(entryNm, ".bin"), { recursive: true });
    await symlink("../ghost/cli.js", join(entryNm, ".bin", "ghost"));
    // An older upm left no state, so this run has to look at the entries.
    await rm(join(project, "node_modules", STATE_FILE));

    const second = await linkTree(resolution, { dir: project, store });
    expect(second.removed).toBe(2);
    expect(await exists(join(entryNm, "ghost"))).toBe(false);
    expect(await exists(join(entryNm, ".bin", "ghost"))).toBe(false);
    // The entry's real package and its live dep survive.
    expect(await read(join(entryNm, "a", "index.js"))).toBe("a");
    expect(await read(join(entryNm, "b", "index.js"))).toBe("b");
  });

  it("sweeps dev links when the same tree is reinstalled with production", async () => {
    const { store, resolution } = await seed(
      [
        { name: "a", files: { "index.js": "a" } },
        {
          name: "tool",
          files: { "cli.js": "#!/usr/bin/env node\n" },
          bin: { tool: "cli.js" },
          dev: true,
        },
      ],
      { a: "1.0.0", tool: "1.0.0" },
    );
    const nm = join(project, "node_modules");
    await linkTree(resolution, { dir: project, store });
    expect(await exists(join(nm, "tool"))).toBe(true);

    const second = await linkTree(resolution, { dir: project, store, production: true });
    expect(second.removed).toBe(2);
    expect(await exists(join(nm, "tool"))).toBe(false);
    expect(await exists(join(nm, ".bin", "tool"))).toBe(false);
    expect(await exists(join(nm, "a"))).toBe(true);
  });
});

describe("linkTree state", () => {
  it.each([
    ["a top-level symlink", (dir: string) => join(dir, "node_modules", "a")],
    ["the .bin directory", (dir: string) => join(dir, "node_modules", ".bin")],
  ])("does not call the tree up to date after losing %s", async (_label, target) => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, bin: { a: "index.js" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    await rm(target(project), { recursive: true, force: true });

    // Saying "up to date" here leaves an import broken with no way for the user to know.
    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect(await exists(join(project, "node_modules", "a"))).toBe(true);
  });

  it("does not call the tree up to date after losing a .upm entry", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const key = Object.values(await storeKeys(resolution.packages))[0] as string;
    await rm(join(project, "node_modules", ".upm", key), { recursive: true, force: true });

    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect(await exists(join(project, "node_modules", ".upm", key, "node_modules", "a"))).toBe(
      true,
    );
  });

  it("stays on the fast path under production when the root has devDependencies", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" } },
      { name: "d", files: { "index.js": "d" } },
    ]);
    resolution.packages["d@1.0.0"]!.dev = true;
    await linkTree(resolution, { dir: project, store, production: true });

    // root.dependencies still names the dev package, but production never links it.
    const again = await linkTree(resolution, { dir: project, store, production: true });

    expect(again.upToDate).toBe(true);
  });

  it("does not call the tree up to date after one bin is deleted", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, bin: { a: "index.js" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    // On Windows a bin is its three shims.
    for (const suffix of process.platform === "win32" ? ["", ".cmd", ".ps1"] : [""]) {
      await rm(join(project, "node_modules", ".bin", `a${suffix}`));
    }

    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect(await exists(join(project, "node_modules", ".bin", "a"))).toBe(true);
  });

  it("does not call the tree up to date after a top-level link is repointed", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const at = join(project, "node_modules", "a");
    await rm(at);
    await symlink("/etc", at);

    // Anything able to write into node_modules could otherwise repoint a package for good.
    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect(await linkOf(at)).toContain(".upm/");
  });

  it("does not call the tree up to date when a link leads into another project's .upm", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    const other = join(dirname(project), "other");
    await mkdir(other, { recursive: true });
    await linkTree(resolution, { dir: other, store });
    await linkTree(resolution, { dir: project, store });
    const at = join(project, "node_modules", "a");
    const key = Object.values(await storeKeys(resolution.packages))[0] as string;
    await rm(at);
    // What a moved tree's junction reads back as on Windows: a whole entry, just not ours.
    const theirs = relative(
      dirname(at),
      join(other, "node_modules", ".upm", key, "node_modules", "a"),
    );
    const [to, type] = linkArgs(theirs, at);
    await symlink(to, at, type);

    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect(await linkOf(at)).toBe(`.upm/${key}/node_modules/a`);
  });

  it("does not accept a plain file standing in for a store entry", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const key = Object.values(await storeKeys(resolution.packages))[0] as string;
    const at = join(project, "node_modules", ".upm", key);
    await rm(at, { recursive: true });
    await writeFile(at, "");

    const again = await linkTree(resolution, { dir: project, store });

    expect(again.upToDate).toBe(false);
    expect((await stat(at)).isDirectory()).toBe(true);
  });

  it("reports an optional the store cannot supply and never calls that tree complete", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" } },
      { name: "o", files: { "index.js": "o" } },
    ]);
    resolution.packages["o@1.0.0"]!.optional = true;
    resolution.packages["o@1.0.0"]!.integrity = hashOf(Buffer.from("nothing has this"));

    const first = await linkTree(resolution, { dir: project, store });
    expect(first.dropped).toEqual(["o@1.0.0"]);

    // Recording this as a finished tree would hide the gap behind the fast path forever.
    const again = await linkTree(resolution, { dir: project, store });
    expect(again.upToDate).toBe(false);
    expect(again.dropped).toEqual(["o@1.0.0"]);
  });

  it("records what it installed, then comes back in on one stat", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
      { name: "c", files: { "index.js": "c" } },
    ]);
    const first = await linkTree(resolution, { dir: project, store });
    expect(first.upToDate).toBe(false);

    const state = await readState(project);
    expect(state).toMatchObject({
      version: 1,
      hash: await stateHash(resolution, { production: false, store: storeDir }),
      entries: Object.values(await storeKeys(resolution.packages)).sort(),
      store: storeDir,
    });

    counted.stat.length = 0;
    counted.readdir.length = 0;
    const second = await linkTree(resolution, { dir: project, store });

    expect(second).toMatchObject({ upToDate: true, reused: 3, entries: 0, linked: 0, removed: 0 });
    // Nothing is stat'd per package; the whole check is two directory listings.
    expect(counted.stat).toEqual([]);
    expect(counted.readdir).toEqual([
      join(project, "node_modules"),
      join(project, "node_modules", ".upm"),
    ]);
  });

  it("does not look inside the entries on the fast path", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(await entryNm(resolution, "a@1.0.0"), "a", "index.js"));

    expect((await linkTree(resolution, { dir: project, store })).upToDate).toBe(true);
    expect(await exists(join(await entryNm(resolution, "a@1.0.0"), "a", "index.js"))).toBe(false);
  });

  it("links in full again when the state is gone", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(project, "node_modules", STATE_FILE));

    const second = await linkTree(resolution, { dir: project, store });
    expect(second).toMatchObject({ upToDate: false, reused: 1 });
  });

  it("links in full again when node_modules was thrown away", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(project, "node_modules", ".upm"), { recursive: true });

    const second = await linkTree(resolution, { dir: project, store });
    expect(second).toMatchObject({ upToDate: false, entries: 1 });
    expect(await read(join(project, "node_modules", "a", "index.js"))).toBe("a");
  });

  it("links in full again when the graph changed", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    drop(resolution, "b@1.0.0");

    const second = await linkTree(resolution, { dir: project, store });
    expect(second).toMatchObject({ upToDate: false, reused: 1, removed: 1 });
  });

  it("holds no state while the tree is being rewritten", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    // A package the store never got: the graph changed, so the run reaches it and fails.
    resolution.packages["ghost@1.0.0"] = { ...resolution.packages["a@1.0.0"]!, name: "ghost" };
    resolution.root.dependencies.ghost = "1.0.0";
    resolution.packages["ghost@1.0.0"]!.integrity = `sha512-${"A".repeat(86)}==`;

    await expect(linkTree(resolution, { dir: project, store })).rejects.toMatchObject({
      code: "ELINK",
    });
    expect(await readState(project)).toBeUndefined();
  });

  it("verify forces the slow path over a matching state", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(await entryNm(resolution, "a@1.0.0"), "a", "index.js"));

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second).toMatchObject({ upToDate: false, repaired: 1, reused: 0 });
    expect(await read(join(await entryNm(resolution, "a@1.0.0"), "a", "index.js"))).toBe("a");
  });
});

describe("linkTree concurrency", () => {
  it("survives two installs of the same tree into one directory", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { b: "cli.js" } },
    ]);
    const both = await Promise.all([
      linkTree(resolution, { dir: project, store }),
      linkTree(resolution, { dir: project, store }),
    ]);

    // One of them built the entries; whoever lost the race reused them.
    expect(both.map((run) => run.entries + run.reused + run.repaired)).toEqual([2, 2]);
    expect(await read(join(project, "node_modules", "a", "index.js"))).toBe("a");
    expect(await binOf(join(await entryNm(resolution, "a@1.0.0"), ".bin", "b"))).toBe(
      "../b/cli.js",
    );
    expect((await readState(project))?.entries).toHaveLength(2);
  });

  it("survives two installs racing to replace the same top-level link", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { a: "cli.js" } },
    ]);
    const nm = join(project, "node_modules");
    // Hold each run's `rm` of the top-level name until the other has reached it too: both saw
    // the link missing, both remove, and then both symlink — the second gets EEXIST.
    const waiting = new Map<string, () => void>();
    const meet = (path: string) =>
      new Promise<void>((resolve) => {
        const other = waiting.get(path);
        if (!other) return waiting.set(path, resolve);
        waiting.delete(path);
        other();
        resolve();
      });
    const raced = new Set([join(nm, "a"), join(nm, ".bin", "a")]);
    // There already, so neither run takes it for a new one that needs no `rm`.
    await mkdir(nm, { recursive: true });
    const realRm = builtin.fsp.rm;
    vi.spyOn(builtin.fsp, "rm").mockImplementation(async (path, options) => {
      if (raced.has(String(path))) await meet(String(path));
      return await realRm(path, options);
    });

    const both = await Promise.all([
      linkTree(resolution, { dir: project, store }),
      linkTree(resolution, { dir: project, store }),
    ]);
    expect(both.map((run) => run.entries + run.reused)).toEqual([1, 1]);
    expect(await linkOf(join(nm, "a"))).toBe(await linkOf(join(nm, "a")));
    expect(await read(join(nm, "a", "cli.js"))).toBe("#!/usr/bin/env node\n");
    expect(await binOf(join(nm, ".bin", "a"))).toBe("../a/cli.js");
    expect(waiting.size).toBe(0);
  });

  it("replaces a name another install took first in a node_modules it just made", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { a: "cli.js" } },
    ]);
    const nm = join(project, "node_modules");
    const realSymlink = builtin.fsp.symlink;
    // On Windows a bin is a shim, written as a file rather than linked.
    const bins = process.platform === "win32" ? [] : [join(nm, ".bin", "a")];
    const taken = new Set([join(nm, "a"), ...bins]);
    vi.spyOn(builtin.fsp, "symlink").mockImplementation(async (target, path, type) => {
      if (taken.delete(String(path))) await realSymlink("elsewhere", path, type);
      return await realSymlink(target, path, type);
    });
    await linkTree(resolution, { dir: project, store });
    expect(taken.size).toBe(0);
    expect(await read(join(nm, "a", "cli.js"))).toBe("#!/usr/bin/env node\n");
    expect(await binOf(join(nm, ".bin", "a"))).toBe("../a/cli.js");
  });

  it("gives up on a link someone keeps pointing elsewhere", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    const at = join(project, "node_modules", "a");
    const realSymlink = builtin.fsp.symlink;
    let tries = 0;
    vi.spyOn(builtin.fsp, "symlink").mockImplementation(async (target, path, type) => {
      if (String(path) !== at) return await realSymlink(target, path, type);
      tries++;
      await realSymlink("elsewhere", path, type); // someone else got there first, every time
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    });

    await expect(linkTree(resolution, { dir: project, store })).rejects.toMatchObject({
      code: "ELINK",
    });
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThan(10);
  });

  it("survives two installs repairing the same damaged entry", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a", "lib/util.js": "util" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    // Damage it, so both runs take the swap-in path and race for the same name.
    await rm(join(await entryNm(resolution, "a@1.0.0"), "a", "lib", "util.js"));

    const both = await Promise.all([
      linkTree(resolution, { dir: project, store, verify: true }),
      linkTree(resolution, { dir: project, store, verify: true }),
    ]);

    // Whether the loser finds the name taken or retires the winner's entry and swaps its own
    // identical rebuild in is the interleaving's business — both are one whole entry renamed
    // into place. What must hold either way: every run accounted for both packages, at least
    // one rebuild happened, the entry that survived is complete, and no temp outlived the swap.
    expect(both.map((run) => run.entries + run.repaired + run.reused)).toEqual([2, 2]);
    expect(both.reduce((total, run) => total + run.repaired, 0)).toBeGreaterThanOrEqual(1);
    const nmDir = await entryNm(resolution, "a@1.0.0");
    expect(await read(join(nmDir, "a", "lib", "util.js"))).toBe("util");
    expect(await read(join(nmDir, "a", "index.js"))).toBe("a");
    expect(await readLink(join(nmDir, "b"))).toBe(
      relative(nmDir, join(await entryNm(resolution, "b@1.0.0"), "b")),
    );
    expect((await readdir(join(project, "node_modules", ".upm"))).sort()).toEqual(
      [...Object.values(await storeKeys(resolution.packages)), "node_modules"].sort(),
    );
  });

  it("touches an entry it reuses, so a concurrent prune leaves it alone", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const entry = join(
      project,
      "node_modules",
      ".upm",
      (await storeKeys(resolution.packages))["a@1.0.0"] as string,
    );
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(entry, old, old);

    const second = await linkTree(resolution, { dir: project, store, verify: true });

    expect(second.reused).toBe(1);
    expect((await stat(entry)).mtimeMs).toBeGreaterThan(old.getTime());
  });
});

describe("linkTree repair", () => {
  it("repairs nothing when nothing is wrong", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second).toMatchObject({ repaired: 0, reused: 2, entries: 0, linked: 0 });
  });

  it("rebuilds an entry a file was deleted from", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a", "lib/util.js": "util" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(await entryNm(resolution, "a@1.0.0"), "a", "lib", "util.js"));

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.repaired).toBe(1);
    expect(await read(join(project, "node_modules", "a", "lib", "util.js"))).toBe("util");
  });

  it("rebuilds an entry a file was truncated in", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a-full-body" } }]);
    await linkTree(resolution, { dir: project, store });
    const file = join(await entryNm(resolution, "a@1.0.0"), "a", "index.js");
    // Replacing rather than truncating: the file is a hardlink, and writing through it
    // would damage the store content every other project shares.
    await rm(file);
    await writeFile(file, "cut");

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.repaired).toBe(1);
    expect(await read(join(project, "node_modules", "a", "index.js"))).toBe("a-full-body");
  });

  it("rebuilds an entry a dependency symlink went missing from", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(await entryNm(resolution, "a@1.0.0"), "b"));

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.repaired).toBe(1);
    expect(await read(join(await entryNm(resolution, "a@1.0.0"), "b", "index.js"))).toBe("b");
  });

  it("rebuilds an entry whose dependency symlink points somewhere else", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { b: "1.0.0" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    const at = join(await entryNm(resolution, "a@1.0.0"), "b");
    await rm(at);
    await symlink("../../nowhere", at);

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.repaired).toBe(1);
    expect(await linkOf(at)).toMatch(/b@1\.0\.0-/);
  });

  it("rebuilds an entry a .bin shim went missing from", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" }, deps: { tool: "1.0.0" } },
      { name: "tool", files: { "cli.js": "#!/usr/bin/env node\n" }, bin: { tool: "cli.js" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    const shim = join(await entryNm(resolution, "a@1.0.0"), ".bin", "tool");
    expect(await exists(shim)).toBe(true);
    await rm(shim);

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.repaired).toBe(1);
    expect(await binOf(shim)).toBe("../tool/cli.js");
  });

  it("repairs a damaged entry on its own, when another package pulled it back in", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a" } },
      { name: "b", files: { "index.js": "b" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    await rm(join(await entryNm(resolution, "a@1.0.0"), "a", "index.js"));
    drop(resolution, "b@1.0.0"); // a real change, so no verify flag is needed

    const second = await linkTree(resolution, { dir: project, store });
    expect(second).toMatchObject({ repaired: 1, reused: 0 });
    expect(await read(join(project, "node_modules", "a", "index.js"))).toBe("a");
  });

  it("puts the old entry back when a repair cannot be built", async () => {
    const { store, resolution } = await seed([
      { name: "a", files: { "index.js": "a", "extra.js": "extra" } },
    ]);
    await linkTree(resolution, { dir: project, store });
    const pkgDir = join(await entryNm(resolution, "a@1.0.0"), "a");
    await rm(join(pkgDir, "index.js")); // the entry now fails its check
    const index = (await store.index(integrityOf(resolution, "a@1.0.0")))!;
    for (const file of index.files) {
      await rm(store.blobPath(file)); // ...and cannot be built again
    }

    await expect(linkTree(resolution, { dir: project, store, verify: true })).rejects.toMatchObject(
      {
        code: "ELINK",
      },
    );
    // Rolled back: what was there before the attempt is there after it.
    expect(await read(join(pkgDir, "extra.js"))).toBe("extra");
  });

  it("keeps the entry hardlinked to the store after a repair", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const file = join(await entryNm(resolution, "a@1.0.0"), "a", "index.js");
    await rm(file);

    await linkTree(resolution, { dir: project, store, verify: true });
    const index = (await store.index(integrityOf(resolution, "a@1.0.0")))!;
    const content = index.files.find((entry: FileEntry) => entry.path === "index.js")!;
    expect((await stat(file)).ino).toBe((await stat(store.blobPath(content))).ino);
  });
});

describe("linkTree hoist", () => {
  const hoistNm = () => join(project, "node_modules", ".upm", "node_modules");

  it("lets a package reach what it never declared, through .upm/node_modules", async () => {
    const { store, resolution } = await seed([
      {
        name: "a",
        files: { "index.js": "module.exports = require('@s/c')" },
        deps: { b: "1.0.0" },
      },
      { name: "b", files: { "index.js": "" }, deps: { "@s/c": "1.0.0" } },
      { name: "@s/c", files: { "index.js": "module.exports = 'c'" } },
    ]);
    await linkTree(resolution, { dir: project, store });

    // The root's own names stay out: the folder is searched before them.
    expect((await readdir(hoistNm())).sort()).toEqual(["@s", "b"]);
    expect(await readLink(join(hoistNm(), "@s", "c"))).toBe(
      relative(join(hoistNm(), "@s"), join(await entryNm(resolution, "@s/c@1.0.0"), "@s", "c")),
    );
    const a = join(project, "node_modules", "a", "index.js");
    expect(createRequire(a)("./index.js")).toBe("c");
  });

  it("picks pnpm's version: nearest the root, then the first parent by id", async () => {
    const { store, resolution } = await seed(
      [
        { name: "d2", deps: { ms: "2.0.0" } },
        { name: "d4", deps: { ms: "2.1.2" } },
        { name: "send", deps: { debug: "1.0.0", mime: "2.0.0" } },
        { name: "debug", deps: { mime: "1.0.0" } },
        { name: "ms", version: "2.0.0" },
        { name: "ms", version: "2.1.2" },
        { name: "mime", version: "1.0.0" },
        { name: "mime", version: "2.0.0" },
      ],
      { d2: "1.0.0", d4: "1.0.0", send: "1.0.0" },
    );
    await linkTree(resolution, { dir: project, store });

    // Same depth: `d2` sorts first, though `d4`'s is higher. `mime@2` is a level nearer.
    expect(await readLink(join(hoistNm(), "ms"))).toContain(`${sep}ms@2.0.0-`);
    expect(await readLink(join(hoistNm(), "mime"))).toContain(`${sep}mime@2.0.0-`);
  });

  it("converges as the tree changes, and leaves the folder out with hoist off", async () => {
    const { store, resolution } = await seed([
      { name: "a", deps: { b: "1.0.0", c: "1.0.0" } },
      { name: "b" },
      { name: "c" },
    ]);
    await linkTree(resolution, { dir: project, store });
    expect((await readdir(hoistNm())).sort()).toEqual(["b", "c"]);

    delete resolution.packages["a@1.0.0"]!.dependencies.c;
    delete resolution.packages["c@1.0.0"];
    const second = await linkTree(resolution, { dir: project, store });
    expect(await readdir(hoistNm())).toEqual(["b"]);
    expect(second.removed).toBe(1);

    // The same tree with the folder gone is not the tree the state recorded.
    await rm(hoistNm(), { recursive: true });
    expect((await linkTree(resolution, { dir: project, store })).upToDate).toBe(false);
    expect(await readdir(hoistNm())).toEqual(["b"]);

    const off = await linkTree(resolution, { dir: project, store, hoist: false });
    expect(off.upToDate).toBe(false);
    expect(await exists(hoistNm())).toBe(false);
    expect((await linkTree(resolution, { dir: project, store, hoist: false })).upToDate).toBe(true);
  });

  it("leaves out what production drops", async () => {
    const { store, resolution } = await seed(
      [
        { name: "a", deps: { b: "1.0.0" } },
        { name: "b" },
        { name: "tool", deps: { t: "1.0.0" }, dev: true },
        { name: "t", dev: true },
      ],
      { a: "1.0.0", tool: "1.0.0" },
    );
    await linkTree(resolution, { dir: project, store, production: true });
    expect(await readdir(hoistNm())).toEqual(["b"]);
  });
});

describe("linkTree temp sweep", () => {
  it("removes an abandoned temp entry once its pid is gone and it has gone cold", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const abandoned = await staleTemp(`.tmp-${deadPid()}-0`);

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.removed).toBe(1);
    expect(await exists(abandoned)).toBe(false);
  });

  it("keeps a temp entry whose pid is still running", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    // Old enough to look abandoned, but the install that owns it is this very process.
    const live = await staleTemp(`.tmp-${process.pid}-0`);

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.removed).toBe(0);
    expect(await exists(live)).toBe(true);
  });

  it("keeps a fresh temp entry even when its pid is gone", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const fresh = join(project, "node_modules", ".upm", `.tmp-${deadPid()}-1`);
    await mkdir(fresh, { recursive: true });

    const second = await linkTree(resolution, { dir: project, store, verify: true });
    expect(second.removed).toBe(0);
    expect(await exists(fresh)).toBe(true);
  });

  it("keeps a name it cannot read a pid out of", async () => {
    const { store, resolution } = await seed([{ name: "a", files: { "index.js": "a" } }]);
    await linkTree(resolution, { dir: project, store });
    const odd = await staleTemp(".tmp-someone-elses-0");

    expect((await linkTree(resolution, { dir: project, store, verify: true })).removed).toBe(0);
    expect(await exists(odd)).toBe(true);
  });
});

/** A temp entry left over from an install that ran two hours ago. */
async function staleTemp(name: string): Promise<string> {
  const at = join(project, "node_modules", ".upm", name);
  await mkdir(at, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(at, old, old);
  return at;
}

/** A pid nothing is using, so the sweep must read it as an install that is over. */
function deadPid(): number {
  for (let pid = 4_000_000; pid > 1; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") return pid;
    }
  }
  throw new Error("every pid is taken");
}

async function entryNm(resolution: Resolution, id: string): Promise<string> {
  const key = (await storeKeys(resolution.packages))[id] as string;
  return join(project, "node_modules", ".upm", key, "node_modules");
}

function integrityOf(resolution: Resolution, id: string): string {
  return (resolution.packages[id] as ResolvedPackage).integrity;
}

/** Forget a package the way editing package.json does: gone from the root and the graph. */
function drop(resolution: Resolution, id: string): void {
  const pkg = resolution.packages[id] as ResolvedPackage;
  delete resolution.packages[id];
  delete resolution.root.dependencies[pkg.name];
}

/** Build tarballs for each fixture, put them in a real store, and return the resolution. */
async function seed(
  fixtures: Fixture[],
  direct?: Record<string, string>,
): Promise<{ store: Store; resolution: Resolution; integrity: Record<string, string> }> {
  const tarballs: Record<string, Uint8Array> = {};
  const integrity: Record<string, string> = {};
  const packages: Record<string, ResolvedPackage> = {};

  for (const fixture of fixtures) {
    const version = fixture.version ?? "1.0.0";
    const id = `${fixture.name}@${version}`;
    const manifest = { name: fixture.name, version, ...(fixture.bin && { bin: fixture.bin }) };
    const tarball = makeTarball([
      { path: "package.json", data: JSON.stringify(manifest) },
      ...Object.entries(fixture.files ?? {}).map(([path, data]) => ({ path, data })),
    ]);
    const url = `https://reg/${encodeURIComponent(id)}.tgz`;
    tarballs[url] = tarball;
    integrity[id] = hashOf(tarball);
    packages[id] = {
      name: fixture.name,
      version,
      resolved: url,
      integrity: integrity[id] as string,
      dependencies: fixture.deps ?? {},
      ...(fixture.optDeps && { optionalDependencies: fixture.optDeps }),
      optional: fixture.optional ?? false,
      dev: fixture.dev ?? false,
      bin: fixture.bin ?? {},
    };
  }

  const store = createStore({ dir: storeDir, fetch: stubFetch(tarballs) });
  for (const [id, entry] of Object.entries(packages)) {
    await store.add(entry.resolved, integrity[id] as string);
  }

  const dependencies =
    direct ??
    Object.fromEntries(
      // Anything nothing else depends on is a direct dep of the root.
      Object.values(packages)
        .filter(
          (pkg) =>
            !Object.values(packages).some(
              (other) => other.dependencies[pkg.name] ?? other.optionalDependencies?.[pkg.name],
            ),
        )
        .map((pkg) => [pkg.name, pkg.version]),
    );
  return { store, resolution: { root: { dependencies }, packages, warnings: [] }, integrity };
}

function stubFetch(bodies: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const bytes = bodies[String(input)];
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes as unknown as BodyInit);
  }) as typeof fetch;
}

async function read(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}
