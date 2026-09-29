// The linker over a tree with workspaces: every workspace is a top with a `node_modules` of its
// own, linked from its directory and never placed in `.upm`.
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashOf } from "./hash.ts";
import { binOf, linkOf, readBin } from "./link.ts";
import { graphHash, storeKeys } from "../src/keys.ts";
import { linkTree } from "../src/link.ts";
import type { ResolvedPackage, Resolution } from "../src/resolve.ts";
import { stateHash } from "../src/state.ts";
import { createStore } from "../src/store.ts";
import type { Store } from "../src/store.ts";
import { makeTarball } from "./tarball.ts";

/** Counts what the linker asks of the filesystem, so the fast path's cost is assertable. */
const counted = vi.hoisted(() => ({ stat: [] as string[], readdir: [] as string[] }));
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
  files?: Record<string, string>;
  bin?: Record<string, string>;
  deps?: Record<string, string>;
  dev?: boolean;
}

interface WorkspaceFixture extends Fixture {
  path: string;
}

let root: string;
let project: string;
let storeDir: string;

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink, and refusals name the resolved target.
  root = await realpath(await mkdtemp(join(tmpdir(), "upm-link-ws-")));
  project = join(root, "project");
  storeDir = join(root, "store");
  counted.stat.length = 0;
  counted.readdir.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const NANOID: Fixture = {
  name: "nanoid",
  files: { "bin.js": "nanoid" },
  bin: { nanoid: "bin.js" },
};
const A: WorkspaceFixture = {
  path: "packages/a",
  name: "a",
  files: { "cli.js": "a" },
  bin: { "a-cli": "cli.js" },
  deps: { nanoid: "1.0.0", b: "link:packages/b" },
};
const B: WorkspaceFixture = {
  path: "packages/b",
  name: "b",
  files: { "cli.js": "b" },
  bin: { "b-cli": "cli.js" },
};

describe("linkTree with workspaces", () => {
  it("lays out a workspace's node_modules: the store for registry deps, the directory for a workspace", async () => {
    const { store, resolution } = await seed([NANOID], [A, B]);
    const result = await linkTree(resolution, { dir: project, store });
    const keys = await storeKeys(resolution.packages);
    const nm = join(project, "packages", "a", "node_modules");

    expect(result.entries).toBe(1);
    expect(await linkOf(join(nm, "nanoid"))).toBe(
      `../../../node_modules/.upm/${keys["nanoid@1.0.0"]}/node_modules/nanoid`,
    );
    expect(await linkOf(join(nm, "b"))).toBe("../../b");
    expect(await read(join(nm, "b", "package.json"))).toContain('"name":"b"');
    // Bins of both kinds, through the links, and they resolve to real files.
    expect(await binOf(join(nm, ".bin", "nanoid"))).toBe("../nanoid/bin.js");
    expect(await binOf(join(nm, ".bin", "b-cli"))).toBe("../b/cli.js");
    expect(await readBin(join(nm, ".bin", "b-cli"))).toBe("b");
    expect(result.bins).toBe(2);
    // Nothing declared the workspaces at the root, so the root does not link them.
    expect(await exists(join(project, "node_modules", "a"))).toBe(false);
    expect(await exists(join(project, "node_modules", "b"))).toBe(false);
    // And a workspace is never a store entry.
    expect(Object.keys(keys)).toEqual(["nanoid@1.0.0"]);
    expect(await exists(join(project, "node_modules", ".upm", "b@1.0.0"))).toBe(false);
  });

  it("hoists a workspace's registry deps into .upm/node_modules, never a workspace", async () => {
    const { store, resolution } = await seed([NANOID], [A, B], { a: "link:packages/a" });
    await linkTree(resolution, { dir: project, store });
    const keys = await storeKeys(resolution.packages);
    expect(await readdir(join(project, "node_modules", ".upm", "node_modules"))).toEqual([
      "nanoid",
    ]);
    expect(await linkOf(join(project, "node_modules", ".upm", "node_modules", "nanoid"))).toBe(
      `../${keys["nanoid@1.0.0"]}/node_modules/nanoid`,
    );
  });

  it("links a workspace at the root only when the root declares it", async () => {
    const { store, resolution } = await seed([NANOID], [A, B], { a: "link:packages/a" });
    await linkTree(resolution, { dir: project, store });
    const nm = join(project, "node_modules");

    expect(await linkOf(join(nm, "a"))).toBe("../packages/a");
    expect(await binOf(join(nm, ".bin", "a-cli"))).toBe("../a/cli.js");
    expect(await readBin(join(nm, ".bin", "a-cli"))).toBe("a");
    expect(await exists(join(nm, "b"))).toBe(false);
  });

  it("comes back in on one readdir per top, never a stat", async () => {
    const { store, resolution } = await seed([NANOID], [A, B], { a: "link:packages/a" });
    await linkTree(resolution, { dir: project, store });

    counted.stat.length = 0;
    counted.readdir.length = 0;
    const again = await linkTree(resolution, { dir: project, store });
    expect(again).toMatchObject({ upToDate: true, reused: 1, entries: 0, removed: 0 });
    expect(counted.stat).toEqual([]);
    expect(counted.readdir).toEqual([
      join(project, "node_modules"),
      join(project, "node_modules", ".bin"),
      join(project, "packages", "a", "node_modules"),
      join(project, "packages", "a", "node_modules", ".bin"),
      join(project, "packages", "b", "node_modules"),
      join(project, "node_modules", ".upm"),
    ]);
  });

  it("relinks when a workspace's own deps change, without moving a registry package's key", async () => {
    const { store, resolution } = await seed([NANOID], [A, B]);
    await linkTree(resolution, { dir: project, store });
    const before = {
      graph: await graphHash(resolution),
      state: await stateHash(resolution, { production: false, store: storeDir }),
      keys: await storeKeys(resolution.packages),
    };

    const changed = structuredClone(resolution);
    delete changed.packages["a@link:packages/a"]!.dependencies.b;
    expect(await graphHash(changed)).not.toBe(before.graph);
    expect(await stateHash(changed, { production: false, store: storeDir })).not.toBe(before.state);
    expect(await storeKeys(changed.packages)).toEqual(before.keys);

    const result = await linkTree(changed, { dir: project, store });
    expect(result.upToDate).toBe(false);
    expect(result.reused).toBe(1); // the store entry stood; only the workspace's links moved
    const nm = join(project, "packages", "a", "node_modules");
    expect(await exists(join(nm, "b"))).toBe(false);
    expect(await exists(join(nm, ".bin", "b-cli"))).toBe(false);
    expect(await exists(join(nm, ".bin", "nanoid"))).toBe(true);
    expect(result.removed).toBe(2);
  });

  it("drops a removed workspace's links from every consumer", async () => {
    const { store, resolution } = await seed([NANOID], [A, B], { b: "link:packages/b" });
    await linkTree(resolution, { dir: project, store });

    const without = structuredClone(resolution);
    delete without.packages["b@link:packages/b"];
    delete without.packages["a@link:packages/a"]!.dependencies.b;
    delete without.root.dependencies.b;
    const result = await linkTree(without, { dir: project, store });

    expect(result.removed).toBe(4); // two links and two bins
    expect(await exists(join(project, "node_modules", "b"))).toBe(false);
    expect(await exists(join(project, "node_modules", ".bin", "b-cli"))).toBe(false);
    expect(await exists(join(project, "packages", "a", "node_modules", "b"))).toBe(false);
    expect(await exists(join(project, "packages", "a", "node_modules", ".bin", "b-cli"))).toBe(
      false,
    );
    // The workspace's own files are untouched: only links were removed.
    expect(await read(join(project, "packages", "b", "cli.js"))).toBe("b");
  });

  it("gives new tops the links it converges old ones to", async () => {
    const scoped: WorkspaceFixture = { ...B, name: "@s/b" };
    const a = { ...A, deps: { nanoid: "1.0.0", "@s/b": "link:packages/b" } };
    const rootDeps = { a: "link:packages/a", "@s/b": "link:packages/b", nanoid: "1.0.0" };
    const { store, resolution } = await seed([NANOID], [a, scoped], rootDeps);
    const nms = ["node_modules", "packages/a/node_modules", "packages/b/node_modules"];
    await linkTree(resolution, { dir: project, store });
    const fresh = await Promise.all(nms.map((nm) => tree(join(project, nm))));

    // Stale links and a wrong one in the tops that are now there: the same install converges.
    await symlink("../nowhere", join(project, "node_modules", "stale"));
    await symlink("../nowhere", join(project, "packages", "a", "node_modules", "@s", "stale"));
    const wrong = join(project, "packages", "a", "node_modules", "nanoid");
    await rm(wrong);
    await symlink("../../b", wrong);
    const again = await linkTree(resolution, { dir: project, store, verify: true });
    expect(again.removed).toBe(2);
    expect(await Promise.all(nms.map((nm) => tree(join(project, nm))))).toEqual(fresh);
    // The link as the tree spells it; the bin through `binOf`, since on Windows it is a shim.
    expect(fresh[1]).toMatchObject({ "@s/b": "-> ../../../b" });
    const bin = join(project, "packages", "a", "node_modules", ".bin", "nanoid");
    expect(await binOf(bin)).toBe("../nanoid/bin.js");
  });

  it("repairs a workspace link that points elsewhere", async () => {
    const { store, resolution } = await seed([NANOID], [A, B]);
    await linkTree(resolution, { dir: project, store });
    const link = join(project, "packages", "a", "node_modules", "b");
    await rm(link);
    await symlink("../../nanoid", link);

    // The fast path sees the wrong target, and --verify rebuilds the same way.
    const plain = await linkTree(resolution, { dir: project, store });
    expect(plain.upToDate).toBe(false);
    expect(await linkOf(link)).toBe("../../b");

    await rm(link);
    await mkdir(link);
    await writeFile(join(link, "stray.txt"), "x");
    const verified = await linkTree(resolution, { dir: project, store, verify: true });
    expect(verified.upToDate).toBe(false);
    expect(await linkOf(link)).toBe("../../b");
  });

  it("refuses a registry package whose edge points at a workspace", async () => {
    const c: Fixture = { name: "c", files: { "index.js": "c" }, deps: { b: "link:packages/b" } };
    const { store, resolution } = await seed([c], [B], { c: "1.0.0" });
    await expect(linkTree(resolution, { dir: project, store })).rejects.toThrow(
      expect.objectContaining({ code: "ELINK", message: expect.stringContaining("workspace b") }),
    );
  });

  it("links a scoped workspace under its scope directory, at the root and in a consumer", async () => {
    const scoped: WorkspaceFixture = { ...B, name: "@s/b" };
    const a: WorkspaceFixture = { ...A, deps: { "@s/b": "link:packages/b" } };
    const { store, resolution } = await seed([], [a, scoped], { "@s/b": "link:packages/b" });
    await linkTree(resolution, { dir: project, store });

    expect(await linkOf(join(project, "node_modules", "@s", "b"))).toBe("../../packages/b");
    const inA = join(project, "packages", "a", "node_modules");
    expect(await linkOf(join(inA, "@s", "b"))).toBe("../../../b");
    expect(await readBin(join(inA, ".bin", "b-cli"))).toBe("b");

    counted.readdir.length = 0;
    expect((await linkTree(resolution, { dir: project, store })).upToDate).toBe(true);
    expect(counted.readdir).toContain(join(inA, "@s"));
  });

  it("links every workspace's prod deps under --production and skips its dev-only ones", async () => {
    const devtool: Fixture = { name: "devtool", files: { "index.js": "d" }, dev: true };
    const a: WorkspaceFixture = { ...A, deps: { ...A.deps, devtool: "1.0.0" } };
    const { store, resolution } = await seed([NANOID, devtool], [a, B]);
    const result = await linkTree(resolution, { dir: project, store, production: true });
    const nm = join(project, "packages", "a", "node_modules");

    expect(result.entries).toBe(1);
    expect(await exists(join(nm, "nanoid"))).toBe(true);
    expect(await exists(join(nm, "b"))).toBe(true);
    expect(await exists(join(nm, "devtool"))).toBe(false);

    const again = await linkTree(resolution, { dir: project, store, production: true });
    expect(again.upToDate).toBe(true);
    // Without the flag, the tree is a different one and the dev dep comes in.
    const full = await linkTree(resolution, { dir: project, store });
    expect(full.upToDate).toBe(false);
    expect(await exists(join(nm, "devtool"))).toBe(true);
  });

  it("refuses to write through a top, its node_modules or a scope dir that leads out of the project", async () => {
    const victim = join(root, "victim");
    await mkdir(join(victim, "nanoid"), { recursive: true });
    await writeFile(join(victim, "nanoid", "precious.txt"), "keep");
    const scoped: Fixture = { ...NANOID, name: "@s/n" };
    const a: WorkspaceFixture = { ...A, deps: { nanoid: "1.0.0", "@s/n": "1.0.0" } };
    const nm = join(project, "packages", "a", "node_modules");
    const cases: [string, string, () => Promise<void>][] = [
      ["node_modules", "packages/a/node_modules", () => symlink(victim, nm)],
      [
        "a scope dir",
        "packages/a/node_modules/@s",
        () => mkdir(nm).then(() => symlink(victim, join(nm, "@s"))),
      ],
      [
        "the workspace",
        "packages/a",
        () =>
          rm(join(project, "packages", "a"), { recursive: true }).then(() =>
            symlink(victim, join(project, "packages", "a")),
          ),
      ],
    ];
    for (const [, at, arrange] of cases) {
      await rm(project, { recursive: true, force: true });
      const { store, resolution } = await seed([NANOID, scoped], [a, B]);
      await arrange();
      await expect(linkTree(resolution, { dir: project, store })).rejects.toThrow(
        expect.objectContaining({
          code: "ELINK",
          message: `refusing to link through ${join(project, at)}: it leads outside the project, to ${victim}`,
        }),
      );
      expect(await read(join(victim, "nanoid", "precious.txt"))).toBe("keep");
      expect((await lstat(join(victim, "nanoid"))).isDirectory()).toBe(true);
    }
    // A dangling link is refused too: mkdir would create its target.
    await rm(project, { recursive: true, force: true });
    const { store, resolution } = await seed([NANOID], [A, B]);
    await symlink(join(root, "nowhere", "x"), nm);
    await expect(linkTree(resolution, { dir: project, store })).rejects.toThrow(
      expect.objectContaining({ code: "ELINK", message: expect.stringContaining("leads nowhere") }),
    );
    expect(await exists(join(root, "nowhere"))).toBe(false);
  });

  it("links through a symlink that stays inside the project", async () => {
    const { store, resolution } = await seed([NANOID], [A, B]);
    const at = join(project, "packages", "a");
    await rename(at, join(project, "elsewhere"));
    await symlink(join(project, "elsewhere"), at);
    const result = await linkTree(resolution, { dir: project, store });
    expect(result.upToDate).toBe(false);
    // Spelled from `packages/a`, the path linked through. A junction is absolute, so on Windows
    // it reads back from where the link really sits.
    expect(await linkOf(join(project, "elsewhere", "node_modules", "b"))).toBe(
      process.platform === "win32" ? "../../packages/b" : "../../b",
    );
  });

  it("leaves real directories and dot names in a workspace's node_modules alone", async () => {
    const { store, resolution } = await seed([NANOID], [A, B]);
    const nm = join(project, "packages", "a", "node_modules");
    await mkdir(join(nm, "theirs"), { recursive: true });
    await mkdir(join(nm, ".cache"), { recursive: true });
    await symlink("../../b", join(nm, "stale"));
    const result = await linkTree(resolution, { dir: project, store });

    expect(result.removed).toBe(1);
    expect(await exists(join(nm, "stale"))).toBe(false);
    expect((await lstat(join(nm, "theirs"))).isDirectory()).toBe(true);
    expect((await lstat(join(nm, ".cache"))).isDirectory()).toBe(true);
  });
});

/**
 * A store holding the registry fixtures, the workspaces written under `project`, and a
 * resolution built by hand in the shape the resolver produces: a workspace's id is
 * `<name>@link:<path>`, and every edge to it carries `link:<path>`.
 */
async function seed(
  registry: Fixture[],
  workspaces: WorkspaceFixture[],
  rootDeps: Record<string, string> = {},
): Promise<{ store: Store; resolution: Resolution }> {
  const tarballs: Record<string, Uint8Array> = {};
  const packages: Record<string, ResolvedPackage> = {};
  for (const fixture of registry) {
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
      dev: fixture.dev ?? false,
      bin: fixture.bin ?? {},
    };
  }
  for (const ws of workspaces) {
    const dir = join(project, ws.path);
    await mkdir(dir, { recursive: true });
    const manifest = { name: ws.name, version: "1.0.0", ...(ws.bin && { bin: ws.bin }) };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [path, data] of Object.entries(ws.files ?? {}))
      await writeFile(join(dir, path), data);
    packages[`${ws.name}@link:${ws.path}`] = {
      name: ws.name,
      version: "1.0.0",
      resolved: "",
      integrity: "",
      local: ws.path,
      dependencies: ws.deps ?? {},
      optional: false,
      dev: false,
      bin: ws.bin ?? {},
    };
  }
  const store = createStore({ dir: storeDir, fetch: stubFetch(tarballs) });
  for (const pkg of Object.values(packages)) {
    if (pkg.local === undefined) await store.add(pkg.resolved, pkg.integrity);
  }
  return { store, resolution: { root: { dependencies: rootDeps }, packages, warnings: [] } };
}

function stubFetch(bodies: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const bytes = bodies[String(input)];
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes as unknown as BodyInit);
  }) as typeof fetch;
}

/** A top's links and directories, `.upm` left out. */
async function tree(nm: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(join(nm, prefix)).catch(() => [])).sort()) {
    const rel = prefix + name;
    if (rel === ".upm" || rel.startsWith(".upm.")) continue;
    const info = await lstat(join(nm, rel));
    if (info.isSymbolicLink()) out[rel] = `-> ${await linkOf(join(nm, rel))}`;
    else if (info.isDirectory()) Object.assign(out, { [rel]: "dir" }, await tree(nm, `${rel}/`));
    else out[rel] = "file";
  }
  return out;
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
