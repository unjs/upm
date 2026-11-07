// Installing from the lockfile npm, pnpm or bun left, with no `upm.lock` written beside it.
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readForeign } from "../src/foreign-lock.ts";
import * as upm from "../src/index.ts";
import { formatLockfile, fromLockfile, parseLockfile } from "../src/lock.ts";
import type { ForeignFile, LockEntry, Lockfile } from "../src/lock.ts";
import { hashOf } from "./hash.ts";
import { binOf } from "./link.ts";
import { makeTarball } from "./tarball.ts";

const FIXTURES = new URL("./fixtures/foreign/", import.meta.url);
const fixture = (name: string) => readFile(fileURLToPath(new URL(name, FIXTURES)), "utf8");
const npmjs = () => "https://registry.npmjs.org";

/** The expected lock without the fields `strip` takes out of every entry. */
function without(lock: Lockfile, strip: (entry: LockEntry) => void): string {
  const copy = structuredClone(lock);
  for (const entry of Object.values(copy.packages)) strip(entry);
  return formatLockfile(copy);
}

describe("the nitro fixture, locked by each manager", () => {
  it("maps package-lock.json onto the lock upm resolves itself", async () => {
    const expected = parseLockfile(await fixture("expected.lock"));
    const manifest = JSON.parse(await fixture("package.json"));
    const read = readForeign(
      "package-lock.json",
      await fixture("package-lock.json"),
      manifest,
      npmjs,
    );
    expect(formatLockfile(read.lock)).toBe(formatLockfile(expected));
    expect(read.binless).toEqual([]);
  });

  it("maps pnpm-lock.yaml the same, with bins left to the store", async () => {
    const expected = parseLockfile(await fixture("expected.lock"));
    const manifest = JSON.parse(await fixture("package.json"));
    const read = readForeign("pnpm-lock.yaml", await fixture("pnpm-lock.yaml"), manifest, npmjs);
    expect(formatLockfile(read.lock)).toBe(without(expected, (entry) => delete entry.bin));
    const withBins = Object.keys(expected.packages).filter((key) => expected.packages[key]!.bin);
    expect(read.binless.sort()).toEqual(withBins.sort());
  });

  it("maps bun.lock the same, short of the libc bun does not record", async () => {
    const expected = parseLockfile(await fixture("expected.lock"));
    const manifest = JSON.parse(await fixture("package.json"));
    const read = readForeign("bun.lock", await fixture("bun.lock"), manifest, npmjs);
    const harmony = "@rolldown/binding-openharmony-arm64@1.2.8";
    // bun's "none" is an os it does not know, not a restriction: installed, as a missing libc is.
    expect(read.lock.packages[harmony]!.os).toBeUndefined();
    read.lock.packages[harmony]!.os = ["openharmony"];
    expect(formatLockfile(read.lock)).toBe(without(expected, (entry) => delete entry.libc));
  });

  it("folds a peer settled two ways onto the highest, and keeps an alias's tarball", () => {
    const at = (name: string, version: string, rest: object = {}) => ({
      version,
      integrity: `sha512-${name}${version}`,
      ...rest,
    });
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { plugin: "^1", host: "^2", b: "^1", str: "npm:string-width@^4" } },
        "node_modules/plugin": at("plugin", "1.0.0", { peerDependencies: { host: ">=1" } }),
        "node_modules/host": at("host", "2.0.0"),
        "node_modules/b": at("b", "1.0.0", { dependencies: { plugin: "^1", host: "^1" } }),
        "node_modules/b/node_modules/host": at("host", "1.0.0"),
        "node_modules/b/node_modules/plugin": at("plugin", "1.0.0", {
          peerDependencies: { host: ">=1" },
        }),
        "node_modules/str": { ...at("string-width", "4.2.3"), name: "string-width" },
      },
    });
    const manifest = { dependencies: JSON.parse(text).packages[""].dependencies };
    const read = readForeign("package-lock.json", text, manifest, npmjs);
    expect(read.lock.packages["plugin@1.0.0"]).toMatchObject({
      dependencies: { host: "2.0.0" },
      peers: { host: "required" },
    });
    expect(read.lock.packages["b@1.0.0"]!.dependencies).toEqual({ plugin: "1.0.0", host: "1.0.0" });
    expect(read.warnings).toEqual([
      "package-lock.json settles a peer of plugin@1.0.0 two ways; upm links the highest",
    ]);
    // Named, so install holds its tarball to string-width.
    expect(read.lock.packages["str@4.2.3"]).toMatchObject({
      name: "string-width",
      resolved: "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",
    });
    expect(fromLockfile(read.lock).packages["str@4.2.3"]).toMatchObject({
      fetchName: "string-width",
    });
  });

  it("gives a pnpm alias a node of its own", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      str:
        specifier: npm:string-width@^4
        version: string-width@4.2.3
packages:
  string-width@4.2.3:
    resolution: {integrity: sha512-sw}
snapshots:
  string-width@4.2.3: {}
`;
    // pnpm's own dependencies may come first, as a document of their own.
    const env =
      "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies: {}\n";
    const manifest = { dependencies: { str: "npm:string-width@^4" } };
    const { lock } = readForeign("pnpm-lock.yaml", `${env}---\n${text}`, manifest, npmjs);
    expect(lock.root).toEqual({
      specs: { dependencies: { str: "npm:string-width@^4" } },
      dependencies: { str: "4.2.3" },
    });
    expect(Object.keys(lock.packages)).toEqual(["str@4.2.3"]);
    expect(lock.packages["str@4.2.3"]).toMatchObject({ name: "string-width" });
    expect(lock.packages["str@4.2.3"]!.resolved).toContain(
      "/string-width/-/string-width-4.2.3.tgz",
    );
  });

  it("reads a pnpm snapshot written under an explicit key", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      pathe:
        specifier: 2.0.3
        version: 2.0.3
packages:
  pathe@2.0.3:
    resolution: {integrity: sha512-sw}
snapshots:
  ? pathe@2.0.3
  : {}
`;
    const manifest = { dependencies: { pathe: "2.0.3" } };
    const { lock } = readForeign("pnpm-lock.yaml", text, manifest, npmjs);
    expect(lock.root).toEqual({
      specs: { dependencies: { pathe: "2.0.3" } },
      dependencies: { pathe: "2.0.3" },
    });
    expect(Object.keys(lock.packages)).toEqual(["pathe@2.0.3"]);
  });

  it("refuses what it cannot map rather than dropping it", () => {
    const npm = (packages: object) => JSON.stringify({ lockfileVersion: 3, packages });
    const git = npm({
      "": { dependencies: { a: "github:x/a" } },
      "node_modules/a": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/a.git#abc" },
    });
    const gitDep = { dependencies: { a: "github:x/a" } };
    expect(() => readForeign("package-lock.json", git, gitDep, npmjs)).toThrow(
      "package.json depends on a, which package-lock.json has from no registry",
    );
    const bare = npm({ "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0" } });
    expect(() =>
      readForeign("package-lock.json", bare, { dependencies: { a: "1" } }, npmjs),
    ).toThrow("package-lock.json gives a@1.0.0 no integrity");
    const workspace = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/a: {}\n";
    expect(() => readForeign("pnpm-lock.yaml", workspace, {}, npmjs)).toThrow("workspaces");
    const patched = "lockfileVersion: '9.0'\npatchedDependencies:\n  a: patches/a.patch\n";
    expect(() => readForeign("pnpm-lock.yaml", patched, {}, npmjs)).toThrow("patches");
    const bunPatched = '{"lockfileVersion":1,"patchedDependencies":{"a@1.0.0":"patches/a.patch"}}';
    expect(() => readForeign("bun.lock", bunPatched, {}, npmjs)).toThrow("patches");
    expect(() => readForeign("pnpm-lock.yaml", "lockfileVersion: '6.0'\n", {}, npmjs)).toThrow(
      "pnpm 9 and later",
    );
    expect(() => readForeign("bun.lock", "{", {}, npmjs)).toThrow("bun.lock cannot be read");
    const empty = '{"lockfileVersion":1,"packages":{}}';
    const patches: object = { patchedDependencies: { "a@1.0.0": "patches/a.patch" } };
    expect(() => readForeign("bun.lock", empty, patches, npmjs)).toThrow("patches");
    const pnpmPatches: object = { pnpm: patches };
    expect(() => readForeign("package-lock.json", npm({}), pnpmPatches, npmjs)).toThrow("patches");
  });

  it("leaves a bundled copy to its parent's tarball", () => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { a: "^1" } } },
      packages: {
        a: ["a@1.0.0", "", { dependencies: { b: "^1" } }, "sha512-a"],
        "a/b": ["b@1.0.0", "", { bundled: true, dependencies: { c: "^1" } }, "sha512-b"],
        "a/c": ["c@1.0.0", "", {}, "sha512-c"],
      },
    });
    const { lock } = readForeign("bun.lock", text, { dependencies: { a: "^1" } }, npmjs);
    expect(Object.keys(lock.packages)).toEqual(["a@1.0.0"]);
    expect(lock.packages["a@1.0.0"]!.dependencies).toBeUndefined();
  });

  it("leaves an npm bundle its parent names, with no entry of its own, to the tarball", () => {
    // npm writes no `inBundle` entries for a package it did not unpack, as one for another cpu.
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { a: "^1" } },
        "node_modules/a": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
          integrity: "sha512-a",
          bundleDependencies: ["b"],
          dependencies: { b: "^1" },
        },
      },
    });
    const { lock } = readForeign("package-lock.json", text, { dependencies: { a: "^1" } }, npmjs);
    expect(Object.keys(lock.packages)).toEqual(["a@1.0.0"]);
    expect(lock.packages["a@1.0.0"]!.dependencies).toBeUndefined();
  });

  it("refuses two packages under one pnpm alias", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a: {specifier: '1', version: 1.0.0}
      b: {specifier: '1', version: 1.0.0}
packages:
  a@1.0.0: {resolution: {integrity: sha512-a}}
  b@1.0.0: {resolution: {integrity: sha512-b}}
  foo@1.0.0: {resolution: {integrity: sha512-foo}}
  bar@1.0.0: {resolution: {integrity: sha512-bar}}
snapshots:
  a@1.0.0:
    dependencies:
      x: foo@1.0.0
  b@1.0.0:
    dependencies:
      x: bar@1.0.0
  foo@1.0.0: {}
  bar@1.0.0: {}
`;
    const manifest = { dependencies: { a: "1", b: "1" } };
    expect(() => readForeign("pnpm-lock.yaml", text, manifest, npmjs)).toThrow(
      "pnpm-lock.yaml holds two packages as x@1.0.0",
    );
  });
});

describe("whether the file was written for package.json", () => {
  const npm = (root: object) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": root, "node_modules/a": { version: "1.0.0", integrity: "sha512-a" } },
    });
  const read = (file: ForeignFile, text: string, manifest: object) =>
    readForeign(file, text, manifest, npmjs).lock.root;

  it("takes the groups from package.json, whichever group the file put a name in", () => {
    // All three managers file a name declared twice under optionalDependencies alone.
    const both = { dependencies: { a: "^1" }, optionalDependencies: { a: "^1" } };
    expect(read("package-lock.json", npm({ optionalDependencies: { a: "^1" } }), both)).toEqual({
      specs: both,
      dependencies: { a: "1.0.0" },
    });
    // pnpm files a dependency that is also a devDependency under dependencies.
    const dev = { dependencies: { a: "^1" }, devDependencies: { a: "^1" } };
    expect(read("package-lock.json", npm({ dependencies: { a: "^1" } }), dev).specs).toEqual(dev);
  });

  it("leaves out the root peers pnpm records, and refuses any other difference", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a: {specifier: ^1, version: 1.0.0}
packages:
  a@1.0.0: {resolution: {integrity: sha512-a}}
snapshots:
  a@1.0.0: {}
`;
    expect(read("pnpm-lock.yaml", text, { peerDependencies: { a: "^1" } })).toEqual({
      dependencies: {},
    });
    for (const manifest of [
      { peerDependencies: { a: "^2" } },
      { dependencies: { a: "^2" } },
      { dependencies: { a: "^1", b: "^1" } },
      {},
    ]) {
      expect(() => read("pnpm-lock.yaml", text, manifest)).toThrow(
        "pnpm-lock.yaml is out of date with package.json: run pnpm install",
      );
    }
  });

  it("refuses a bun.lock resolved under other overrides", () => {
    const text = (overrides: object) =>
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { "": { dependencies: { a: "^1" } } },
        overrides,
        packages: { a: ["a@1.0.0", "", {}, "sha512-a"] },
      });
    const manifest = { dependencies: { a: "^1" }, overrides: { b: "1.0.0" } };
    expect(read("bun.lock", text({ b: "1.0.0" }), manifest).dependencies).toEqual({ a: "1.0.0" });
    const resolutions = { dependencies: { a: "^1" }, resolutions: { b: "1.0.0" } };
    expect(read("bun.lock", text({ b: "1.0.0" }), resolutions).dependencies).toEqual({
      a: "1.0.0",
    });
    expect(() => read("bun.lock", text({ b: "2.0.0" }), manifest)).toThrow("out of date");
    expect(() => read("bun.lock", text({}), manifest)).toThrow("out of date");
  });

  it("refuses a file that leaves out a name every object has, or hides one in __proto__", () => {
    const a = { version: "1.0.0", integrity: "sha512-a" };
    const packages = { "node_modules/a": a };
    const missing = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { a: "^1" } }, ...packages },
    });
    const constructor = { dependencies: { a: "^1", constructor: "^1" } };
    expect(() => read("package-lock.json", missing, constructor)).toThrow("out of date");
    // JSON.parse keeps `__proto__` as a key, but copying the group sets it as a prototype.
    const hidden = `{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"^1","__proto__":{"b":"^1"}}},"node_modules/a":${JSON.stringify(a)}}}`;
    const both = { dependencies: { a: "^1", b: "^1" } };
    expect(() => read("package-lock.json", hidden, both)).toThrow("out of date");
  });

  it("reads a dependency or peer named as a property every object has as any other", () => {
    const text = (deps: object) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { a: "^1" } },
          "node_modules/a": {
            version: "1.0.0",
            integrity: "sha512-a",
            dependencies: { constructor: "^1" },
            peerDependencies: { toString: "^1" },
          },
          ...deps,
        },
      });
    const manifest = { dependencies: { a: "^1" } };
    expect(() => read("package-lock.json", text({}), manifest)).toThrow(
      "a@1.0.0 depends on constructor, which package-lock.json has from no registry",
    );
    const c = { version: "1.0.0", integrity: "sha512-c" };
    const { lock } = readForeign(
      "package-lock.json",
      text({ "node_modules/constructor": c, "node_modules/toString": c }),
      manifest,
      npmjs,
    );
    expect(lock.packages["a@1.0.0"]).toMatchObject({
      dependencies: { constructor: "1.0.0", toString: "1.0.0" },
      peers: { toString: "required" },
    });
    // pnpm: an optional peer, settled or not.
    const pnpm = (settled: string) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a: {specifier: ^1, version: 1.0.0}
packages:
  a@1.0.0:
    resolution: {integrity: sha512-a}
    peerDependencies: {constructor: ^1}
    peerDependenciesMeta: {constructor: {optional: true}}
  constructor@1.0.0: {resolution: {integrity: sha512-c}}
snapshots:
  a@1.0.0: {${settled}}
  constructor@1.0.0: {}
`;
    const alone = readForeign("pnpm-lock.yaml", pnpm(""), manifest, npmjs).lock;
    expect(alone.packages["a@1.0.0"]!.optionalDependencies).toBeUndefined();
    const settled = "dependencies: {constructor: 1.0.0}";
    const peer = readForeign("pnpm-lock.yaml", pnpm(settled), manifest, npmjs).lock;
    expect(peer.packages["a@1.0.0"]!.optionalDependencies).toEqual({ constructor: "1.0.0" });
  });
});

// A registry that serves two tarballs and fails the test on any metadata request.
const tool = makeTarball([
  { path: "package.json", data: '{"name":"tool","version":"1.0.0","bin":{"tool":"cli.js"}}' },
  { path: "cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
]);
const dep = makeTarball([{ path: "index.js", data: "module.exports = 1;\n" }]);
const TOOL = hashOf(tool);
const DEP = hashOf(dep);

/** A package whose `index.js` says which one it is, as its tarball names it. */
function pkg(name: string, version: string, dependencies?: object) {
  const manifest = JSON.stringify({ name, version, dependencies });
  const data = makeTarball([
    { path: "package.json", data: manifest },
    { path: "index.js", data: `module.exports = "${name}@${version}";\n` },
  ]);
  return { url: `/${name}/-/${name}-${version}.tgz`, data, integrity: hashOf(data) };
}
// pkg-a@1.1.0 depends on pkg-b, and evil is on the same registry as both.
const A1 = pkg("pkg-a", "1.1.0", { "pkg-b": "^1.0.0" });
const A2 = pkg("pkg-a", "2.0.0");
const B = pkg("pkg-b", "1.0.0");
const EVIL = pkg("evil", "1.0.0");
const REAL = pkg("real", "1.0.0");

const SERVED = new Map<string, Uint8Array>([
  ["/tool/-/tool-1.0.0.tgz", tool],
  ["/dep/-/dep-1.0.0.tgz", dep],
  ...[A1, A2, B, EVIL, REAL].map((p) => [p.url, p.data] as [string, Uint8Array]),
]);

const MANIFEST = { name: "demo", dependencies: { tool: "^1.0.0" } };

// Written by hand in each manager's shape. The npm and pnpm urls name npmjs: the install's
// registry is the one `.npmrc` (here the option) gives, not the one the file was written behind.
const LOCKS: Record<ForeignFile, string> = {
  "package-lock.json": JSON.stringify({
    name: "demo",
    lockfileVersion: 3,
    packages: {
      "": MANIFEST,
      "node_modules/tool": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/tool/-/tool-1.0.0.tgz",
        integrity: TOOL,
        dependencies: { dep: "^1.0.0" },
        bin: { tool: "cli.js" },
      },
      "node_modules/dep": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz",
        integrity: DEP,
      },
    },
  }),
  "pnpm-lock.yaml": `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      tool:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  dep@1.0.0:
    resolution: {integrity: ${DEP}}

  tool@1.0.0:
    resolution: {integrity: ${TOOL}}
    hasBin: true

snapshots:

  dep@1.0.0: {}

  tool@1.0.0:
    dependencies:
      dep: 1.0.0
`,
  "bun.lock": `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "demo",
      "dependencies": { "tool": "^1.0.0", },
    },
  },
  "packages": {
    "dep": ["dep@1.0.0", "", {}, "${DEP}"],
    "tool": ["tool@1.0.0", "", { "dependencies": { "dep": "^1.0.0" }, "bin": { "tool": "cli.js" } }, "${TOOL}"],
  }
}
`,
};

let dir: string;
let server: Server;
let asked: string[];
let base: upm.InstallOptions;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-foreign-"));
  asked = [];
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const body = SERVED.get(url);
    if (!body) asked.push(url);
    response.writeHead(body ? 200 : 404);
    response.end(body && Buffer.from(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = {
    dir,
    store: join(dir, "store"),
    registry: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    experimental: { resolvePool: 0, linkPool: { size: 0 } },
  };
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
});

async function project(file: ForeignFile, manifest: object = MANIFEST): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(dir, file), LOCKS[file]);
}

const exists = (path: string) =>
  stat(join(dir, path)).then(
    () => true,
    () => false,
  );

describe("a project another manager locked", () => {
  for (const file of Object.keys(LOCKS) as ForeignFile[]) {
    it(`installs from ${file} with no metadata request and no upm.lock`, async () => {
      await project(file);
      const first = await upm.install(base);
      expect(first).toMatchObject({ packages: 2, upToDate: false });
      expect(await binOf(join(dir, "node_modules", ".bin", "tool"))).toBe("../tool/cli.js");
      expect(await exists("node_modules/tool/package.json")).toBe(true);
      const from = createRequire(await realpath(join(dir, "node_modules", "tool", "cli.js")));
      expect(from.resolve("dep")).toContain("index.js");
      expect(await upm.install(base)).toMatchObject({ upToDate: true });
      expect(await upm.install({ ...base, frozen: true })).toMatchObject({ upToDate: true });
      expect(Object.keys((await upm.lock(base)).packages).sort()).toEqual([
        "dep@1.0.0",
        "tool@1.0.0",
      ]);
      expect(await upm.fetchLockfile(base)).toHaveLength(2);
      expect(await exists("upm.lock")).toBe(false);
      expect(asked).toEqual([]);
    });
  }

  it("reads the bins pnpm did not name before the tree is hashed", async () => {
    await project("pnpm-lock.yaml");
    await upm.install(base);
    // Other bytes, the same graph: the state's hash is what finds the tree up to date.
    await writeFile(join(dir, "pnpm-lock.yaml"), `${LOCKS["pnpm-lock.yaml"]}\n`);
    expect(await upm.install(base)).toMatchObject({ upToDate: true });
    await rm(join(dir, "node_modules"), { recursive: true });
    expect(await upm.install(base)).toMatchObject({ upToDate: false }); // from a warm store
    expect(await exists("node_modules/.bin/tool")).toBe(true);
  });

  it("asks a host off the registry for nothing, bins included, before the registry vouches", async () => {
    const elsewhere: string[] = [];
    const other = createServer((request, response) => {
      elsewhere.push(request.url ?? "");
      response.writeHead(200);
      response.end(Buffer.from(tool));
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    try {
      const at = `http://127.0.0.1:${(other.address() as AddressInfo).port}/tool.tgz`;
      const npm = LOCKS["package-lock.json"].replace(
        "https://registry.npmjs.org/tool/-/tool-1.0.0.tgz",
        at,
      );
      // pnpm names only `hasBin`, so its bins are read out of the tarball before the link.
      const pnpm = LOCKS["pnpm-lock.yaml"].replace(
        `{integrity: ${TOOL}}`,
        `{integrity: ${TOOL}, tarball: '${at}'}`,
      );
      for (const [file, text] of [
        ["package-lock.json", npm],
        ["pnpm-lock.yaml", pnpm],
      ] as const) {
        await rm(join(dir, "package-lock.json"), { force: true });
        await writeFile(join(dir, "package.json"), JSON.stringify(MANIFEST));
        await writeFile(join(dir, file), text);
        // The registry has no document for tool: nothing says those bytes are its.
        await expect(upm.install({ ...base, frozen: true })).rejects.toMatchObject({
          code: "ELOCK",
          message: expect.stringContaining("tool@1.0.0 is locked to http://127.0.0.1:"),
        });
      }
      expect(elsewhere).toEqual([]);
      expect(await exists("node_modules/tool")).toBe(false);
    } finally {
      await new Promise((done) => other.close(done));
    }
  });

  it("refuses to resolve once package.json has moved on", async () => {
    await project("pnpm-lock.yaml");
    await upm.install(base);
    const moved = { ...MANIFEST, dependencies: { tool: "^1.0.0", dep: "^1.0.0" } };
    await writeFile(join(dir, "package.json"), JSON.stringify(moved));
    for (const options of [base, { ...base, frozen: true }]) {
      await expect(upm.install(options)).rejects.toMatchObject({
        code: "ELOCK",
        message: expect.stringContaining(
          "pnpm-lock.yaml is out of date with package.json: run pnpm install",
        ),
      });
    }
    await expect(upm.lock(base)).rejects.toMatchObject({ code: "ELOCK" });
    expect(await exists("upm.lock")).toBe(false);
  });

  it("refuses the commands that would write upm.lock", async () => {
    await project("package-lock.json");
    const raw = await readFile(join(dir, "package.json"), "utf8");
    await expect(upm.add(["dep"], base)).rejects.toMatchObject({
      code: "ELOCK",
      message: expect.stringContaining("add would write upm.lock beside package-lock.json"),
    });
    await expect(upm.remove(["tool"], base)).rejects.toMatchObject({ code: "ELOCK" });
    await expect(upm.dedupe(base)).rejects.toMatchObject({ code: "ELOCK" });
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(raw);
    expect(await exists("upm.lock")).toBe(false);
    expect(asked).toEqual([]);
  });

  it("refuses two lockfiles, and workspaces", async () => {
    await project("pnpm-lock.yaml");
    await writeFile(join(dir, "bun.lock"), LOCKS["bun.lock"]);
    await expect(upm.install(base)).rejects.toMatchObject({
      code: "ELOCK",
      message: expect.stringContaining("pnpm-lock.yaml and bun.lock both lock"),
    });
    await rm(join(dir, "bun.lock"));
    await project("pnpm-lock.yaml", { ...MANIFEST, workspaces: ["packages/*"] });
    await expect(upm.install(base)).rejects.toMatchObject({
      code: "ELOCK",
      message: expect.stringContaining("upm does not read workspaces from pnpm-lock.yaml"),
    });
  });

  it("reads upm.lock first when there is one", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify(MANIFEST));
    await writeFile(join(dir, "pnpm-lock.yaml"), "not: [a lockfile");
    const { lock } = readForeign("package-lock.json", LOCKS["package-lock.json"], MANIFEST, npmjs);
    await writeFile(join(dir, "upm.lock"), formatLockfile(lock));
    expect(await upm.install({ ...base, frozen: true })).toMatchObject({ packages: 2 });
    expect(asked).toEqual([]);
  });
});

// Only the lockfile is the attacker's: package.json, the registry and the store are not.
describe("a lockfile edited to give a package another's tarball", () => {
  const url = (p: { url: string }) => `${base.registry}${p.url}`;
  const npm = (packages: object, root: object = { "pkg-a": "^1.0.0" }) =>
    JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: root }, ...packages } });
  const pnpm = (pin: string, packages: string, snapshots: string) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      pkg-a: {specifier: ^1.0.0, version: ${pin}}
packages:
${packages}
snapshots:
${snapshots}
`;
  const bun = (packages: object, overrides?: object) =>
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { "pkg-a": "^1.0.0" } } },
      ...(overrides && { overrides }),
      packages,
    });
  const nested = { "pkg-b": "^1.0.0" };
  const a1 = () => ({
    version: "1.1.0",
    resolved: url(A1),
    integrity: A1.integrity,
    dependencies: nested,
  });
  const install = async (file: ForeignFile, text: string, manifest: object) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", ...manifest }));
    await writeFile(join(dir, file), text);
  };
  const which = (name: string) =>
    readFile(join(dir, "node_modules", name, "index.js"), "utf8").then(
      (text) => /"(.*)"/.exec(text)?.[1],
      () => undefined,
    );
  const DEPS = { dependencies: { "pkg-a": "^1.0.0" } };

  const swaps: [string, ForeignFile, () => string][] = [
    [
      "evil's url and integrity",
      "package-lock.json",
      () =>
        npm({
          "node_modules/pkg-a": {
            version: "1.0.0",
            resolved: url(EVIL),
            integrity: EVIL.integrity,
          },
        }),
    ],
    [
      "evil's url, integrity and name",
      "package-lock.json",
      () =>
        npm({
          "node_modules/pkg-a": {
            name: "evil",
            version: "1.0.0",
            resolved: url(EVIL),
            integrity: EVIL.integrity,
          },
        }),
    ],
    [
      "a version its range does not allow",
      "package-lock.json",
      () =>
        npm({
          "node_modules/pkg-a": { version: "2.0.0", resolved: url(A2), integrity: A2.integrity },
        }),
    ],
    [
      "evil as an alias",
      "pnpm-lock.yaml",
      () =>
        pnpm(
          "evil@1.0.0",
          `  evil@1.0.0: {resolution: {integrity: ${EVIL.integrity}}}`,
          "  evil@1.0.0: {}",
        ),
    ],
    [
      "evil's tarball and integrity",
      "pnpm-lock.yaml",
      () =>
        pnpm(
          "1.0.0",
          `  pkg-a@1.0.0: {resolution: {integrity: ${EVIL.integrity}, tarball: '${url(EVIL)}'}}`,
          "  pkg-a@1.0.0: {}",
        ),
    ],
    [
      "a version its range does not allow",
      "pnpm-lock.yaml",
      () =>
        pnpm(
          "2.0.0",
          `  pkg-a@2.0.0: {resolution: {integrity: ${A2.integrity}}}`,
          "  pkg-a@2.0.0: {}",
        ),
    ],
    [
      "evil as an alias",
      "bun.lock",
      () => bun({ "pkg-a": ["evil@1.0.0", "", {}, EVIL.integrity] }),
    ],
    [
      "a version its range does not allow",
      "bun.lock",
      () => bun({ "pkg-a": ["pkg-a@2.0.0", "", {}, A2.integrity] }),
    ],
    [
      "a version only an override of another name would allow",
      "bun.lock",
      () => bun({ "pkg-a": ["pkg-a@2.0.0", "", {}, A2.integrity] }, { "x>pkg-a": "2.0.0" }),
    ],
  ];
  for (const [what, file, text] of swaps) {
    it(`refuses ${file} pinning pkg-a to ${what}`, async () => {
      const overrides = what.includes("override") ? { overrides: { "x>pkg-a": "2.0.0" } } : {};
      await install(file, text(), { ...DEPS, ...overrides });
      for (const options of [base, { ...base, frozen: true }]) {
        await expect(upm.install(options)).rejects.toMatchObject({
          code: "ELOCK",
          message: expect.stringContaining(
            `${file} locks pkg-a to a version or package that package.json does not allow`,
          ),
        });
      }
      expect(await which("pkg-a")).toBeUndefined();
      expect(await exists("upm.lock")).toBe(false);
    });
  }

  // A nested edge is held at link time, by its dependent's own package.json.
  const deep: [ForeignFile, () => string][] = [
    [
      "package-lock.json",
      () =>
        npm({
          "node_modules/pkg-a": a1(),
          "node_modules/pkg-b": {
            version: "1.0.0",
            resolved: url(EVIL),
            integrity: EVIL.integrity,
          },
        }),
    ],
    [
      "pnpm-lock.yaml",
      () =>
        pnpm(
          "1.1.0",
          `  pkg-a@1.1.0: {resolution: {integrity: ${A1.integrity}}}\n  evil@1.0.0: {resolution: {integrity: ${EVIL.integrity}}}`,
          "  pkg-a@1.1.0:\n    dependencies:\n      pkg-b: evil@1.0.0\n  evil@1.0.0: {}",
        ),
    ],
    [
      "bun.lock",
      () =>
        bun({
          "pkg-a": ["pkg-a@1.1.0", "", { dependencies: nested }, A1.integrity],
          "pkg-b": ["evil@1.0.0", "", {}, EVIL.integrity],
        }),
    ],
  ];
  for (const [file, text] of deep) {
    it(`refuses ${file} giving pkg-a's own pkg-b evil's tarball`, async () => {
      await install(file, text(), DEPS);
      for (const options of [base, { ...base, frozen: true }]) {
        await expect(upm.install(options)).rejects.toMatchObject({
          code: "EMISMATCH",
          message: expect.stringContaining("its package.json makes pkg-b pkg-b, not evil"),
        });
      }
    });
  }

  // A tarball that calls itself what the lock says, on a host that is not the registry: the
  // link's name check passes it, so only the registry's integrity can refuse it.
  const forged = (name: string, version: string) => {
    const data = makeTarball([
      { path: "package.json", data: JSON.stringify({ name, version }) },
      { path: "index.js", data: 'module.exports = "forged";\n' },
    ]);
    return { data, integrity: hashOf(data) };
  };
  const FA = forged("pkg-a", "1.0.0");
  const FB = forged("pkg-b", "1.0.0");
  const elsewhere: [ForeignFile, string, (at: string) => string, string][] = [
    [
      "package-lock.json",
      "pkg-a",
      (at) =>
        npm({
          "node_modules/pkg-a": {
            version: "1.0.0",
            resolved: `${at}/a.tgz`,
            integrity: FA.integrity,
          },
        }),
      "ELOCK",
    ],
    [
      "package-lock.json",
      "pkg-a's own pkg-b",
      (at) =>
        npm({
          "node_modules/pkg-a": a1(),
          "node_modules/pkg-b": {
            version: "1.0.0",
            resolved: `${at}/b.tgz`,
            integrity: FB.integrity,
          },
        }),
      "ELOCK",
    ],
    [
      "pnpm-lock.yaml",
      "pkg-a",
      (at) =>
        pnpm(
          "1.0.0",
          `  pkg-a@1.0.0: {resolution: {integrity: ${FA.integrity}, tarball: '${at}/a.tgz'}}`,
          "  pkg-a@1.0.0: {}",
        ),
      "ELOCK",
    ],
    [
      "pnpm-lock.yaml",
      "pkg-a's own pkg-b",
      (at) =>
        pnpm(
          "1.1.0",
          `  pkg-a@1.1.0: {resolution: {integrity: ${A1.integrity}}}\n  pkg-b@1.0.0: {resolution: {integrity: ${FB.integrity}, tarball: '${at}/b.tgz'}}`,
          "  pkg-a@1.1.0:\n    dependencies:\n      pkg-b: 1.0.0\n  pkg-b@1.0.0: {}",
        ),
      "ELOCK",
    ],
    // bun names a registry, never a tarball: the url is the installing machine's registry's.
    [
      "bun.lock",
      "pkg-a",
      (at) => bun({ "pkg-a": ["pkg-a@1.0.0", `${at}/`, {}, FA.integrity] }),
      "E404",
    ],
    [
      "bun.lock",
      "pkg-a's own pkg-b",
      (at) =>
        bun({
          "pkg-a": ["pkg-a@1.1.0", "", { dependencies: nested }, A1.integrity],
          "pkg-b": ["pkg-b@1.0.0", `${at}/`, {}, FB.integrity],
        }),
      "EINTEGRITY",
    ],
  ];
  for (const [file, what, text, code] of elsewhere) {
    it(`refuses ${file} fetching ${what} from another host by the lock's integrity`, async () => {
      const asked: string[] = [];
      const other = createServer((request, response) => {
        asked.push(request.url ?? "");
        response.writeHead(200);
        response.end(Buffer.from(request.url === "/a.tgz" ? FA.data : FB.data));
      });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      try {
        const at = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
        await install(file, text(at), DEPS);
        for (const options of [base, { ...base, frozen: true }]) {
          await expect(upm.install(options)).rejects.toMatchObject({ code });
        }
        expect(asked).toEqual([]);
        expect(await which("pkg-a")).toBeUndefined();
      } finally {
        await new Promise((done) => other.close(done));
      }
    });
  }

  // The shapes each manager wrote for this package.json, an alias and an override included.
  it("installs package-lock.json with an alias and a $name override", async () => {
    const text = npm(
      {
        "node_modules/pkg-a": a1(),
        "node_modules/pkg-b": { version: "1.0.0", resolved: url(B), integrity: B.integrity },
        "node_modules/str": {
          name: "real",
          version: "1.0.0",
          resolved: url(REAL),
          integrity: REAL.integrity,
        },
      },
      { "pkg-a": "^1.0.0", str: "npm:real@^1" },
    );
    const dependencies = { "pkg-a": "^1.0.0", str: "npm:real@^1" };
    await install("package-lock.json", text, { dependencies, overrides: { "pkg-a": "$pkg-a" } });
    expect(await upm.install({ ...base, frozen: true })).toMatchObject({ packages: 3 });
    expect(await which("pkg-a")).toBe("pkg-a@1.1.0");
    expect(await which("str")).toBe("real@1.0.0");
    expect(asked).toEqual([]);
  });

  it("installs pnpm-lock.yaml with an alias, under pnpm-workspace.yaml's override", async () => {
    // pnpm writes the override's value as the root's specifier.
    const text = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  pkg-a: 2.0.0

importers:

  .:
    dependencies:
      pkg-a:
        specifier: 2.0.0
        version: 2.0.0
      str:
        specifier: npm:real@^1
        version: real@1.0.0

packages:

  pkg-a@2.0.0:
    resolution: {integrity: ${A2.integrity}}

  real@1.0.0:
    resolution: {integrity: ${REAL.integrity}}

snapshots:

  pkg-a@2.0.0: {}

  real@1.0.0: {}
`;
    const dependencies = { "pkg-a": "^1.0.0", str: "npm:real@^1" };
    await install("pnpm-lock.yaml", text, { dependencies });
    await expect(upm.install(base)).rejects.toMatchObject({ code: "ELOCK" });
    await writeFile(join(dir, "pnpm-workspace.yaml"), "overrides:\n  pkg-a: 2.0.0\n");
    expect(await upm.install({ ...base, frozen: true })).toMatchObject({ packages: 2 });
    expect(await which("pkg-a")).toBe("pkg-a@2.0.0");
    expect(await which("str")).toBe("real@1.0.0");
    // Another override's value is not the one the file recorded.
    await writeFile(join(dir, "pnpm-workspace.yaml"), "overrides:\n  pkg-a: 2.0.1\n");
    await expect(upm.install(base)).rejects.toMatchObject({ code: "ELOCK" });
    expect(asked).toEqual([]);
  });

  it("installs bun.lock with an alias, under an override", async () => {
    const text = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "demo",
      "dependencies": {
        "pkg-a": "^1.0.0",
        "str": "npm:real@^1",
      },
    },
  },
  "overrides": {
    "pkg-a": "2.0.0",
  },
  "packages": {
    "pkg-a": ["pkg-a@2.0.0", "${url(A2)}", {}, "${A2.integrity}"],

    "str": ["real@1.0.0", "${url(REAL)}", {}, "${REAL.integrity}"],
  }
}
`;
    const dependencies = { "pkg-a": "^1.0.0", str: "npm:real@^1" };
    await install("bun.lock", text, { dependencies, overrides: { "pkg-a": "2.0.0" } });
    expect(await upm.install({ ...base, frozen: true })).toMatchObject({ packages: 2 });
    expect(await which("pkg-a")).toBe("pkg-a@2.0.0");
    expect(await which("str")).toBe("real@1.0.0");
    expect(asked).toEqual([]);
  });
});
