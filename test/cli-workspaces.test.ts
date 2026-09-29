// The CLI over a monorepo: the root is found from inside a workspace, one install covers the
// whole tree, `add`/`remove -w` edit one package.json, and `run -w` orders the workspaces.
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf } from "./hash.ts";
import { binOf, linkOf } from "./link.ts";
import { makeTarball } from "./tarball.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/upm.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `nanoid` and `c` are what the workspaces take from the registry. `b` is published too,
 * at a version the workspace `b` is not, so a request for it would show up as one.
 */
const published: Record<string, string[]> = {
  nanoid: ["5.0.0"],
  c: ["1.0.0"],
  b: ["9.0.0"],
};
const tarballs = new Map<string, Uint8Array>();
for (const [name, versions] of Object.entries(published)) {
  for (const version of versions) {
    const data = `module.exports = "${name}@${version}";\n`;
    tarballs.set(`${name}-${version}.tgz`, makeTarball([{ path: "index.js", data }]));
  }
}

let dir: string;
let server: Server;
let registry: string;
let requests: string[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "upm-cli-ws-")));
  requests = [];
  server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const [, name, ...rest] = (request.url ?? "").split("/");
    const versions = published[name ?? ""];
    const tarball = tarballs.get(rest[1] ?? "");
    if (rest[0] === "-" && tarball) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
      return;
    }
    if (!versions || (rest.length > 0 && !versions.includes(rest[0]!))) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Not found"}');
      return;
    }
    const manifest = (version: string) => ({
      name,
      version,
      dist: {
        tarball: `${registry}/${name}/-/${name}-${version}.tgz`,
        integrity: hashOf(tarballs.get(`${name}-${version}.tgz`)!),
      },
    });
    const body =
      rest.length > 0
        ? manifest(rest[0]!)
        : {
            name,
            "dist-tags": { latest: versions.at(-1) },
            versions: Object.fromEntries(versions.map((v) => [v, manifest(v)])),
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // `a` depends on `b` by a range its version fits and on `nanoid`; `b` has a bin and a dev dep.
  await pkg("", {
    name: "root",
    version: "1.0.0",
    workspaces: ["packages/*"],
    scripts: { build: "echo build root" },
  });
  await pkg("packages/a", {
    name: "a",
    version: "1.0.0",
    dependencies: { b: "^1", nanoid: "^5" },
    scripts: { build: "echo build a", test: "echo test a" },
  });
  await pkg("packages/b", {
    name: "b",
    version: "1.2.0",
    bin: { "b-cli": "cli.js" },
    devDependencies: { c: "^1" },
    scripts: { build: "echo build b" },
  });
  await writeFile(join(dir, "packages", "b", "cli.js"), "#!/usr/bin/env node\n");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function pkg(path: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, path, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
}

/** upm from `cwd` under the fixture, with no `--dir`: the root is what the walk up finds. */
function upm(cwd: string, ...args: string[]): Promise<Result> {
  const flags = ["--store", join(dir, "store"), "--registry", registry];
  return run(process.execPath, [CLI, ...flags, ...args], { cwd: join(dir, cwd) }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: Result) => error,
  );
}

const read = (path: string) => readFile(join(dir, path), "utf8");
const manifest = async (path: string) => JSON.parse(await read(join(path, "package.json")));
const lockfile = async () => JSON.parse(await read("upm.lock"));

describe("install", () => {
  it("installs the whole tree from the root, or from inside a workspace, the same way", async () => {
    const fromInside = await upm("packages/a", "install");
    expect(fromInside).toMatchObject({ code: 0 });
    expect(fromInside.stdout).toMatch(/^✓ installed · 2 pkgs · 2 ws · /);
    const lock = await read("upm.lock");
    expect(Object.keys((await lockfile()).workspaces)).toEqual(["packages/a", "packages/b"]);
    expect(Object.keys((await lockfile()).packages).sort()).toEqual(["c@1.0.0", "nanoid@5.0.0"]);

    // `a` sees the workspace `b` from its own directory and `nanoid` from the root's store.
    expect(await linkOf(join(dir, "packages", "a", "node_modules", "b"))).toBe("../../b");
    expect(await read("packages/a/node_modules/nanoid/index.js")).toBe(
      'module.exports = "nanoid@5.0.0";\n',
    );
    expect(await binOf(join(dir, "packages", "a", "node_modules", ".bin", "b-cli"))).toBe(
      "../b/cli.js",
    );
    expect(await read("packages/b/node_modules/c/index.js")).toBe('module.exports = "c@1.0.0";\n');
    // Never the registry's `b`: the workspace fits the range.
    expect(requests.some((url) => url.startsWith("/b"))).toBe(false);

    const again = await upm("", "install");
    expect(again.stdout).toMatch(/^✓ up to date · 2 pkgs · 2 ws · [\d.]+m?s\n/);
    expect(await read("upm.lock")).toBe(lock);
    const json = JSON.parse((await upm("packages/b", "install", "--json")).stdout);
    expect(json).toMatchObject({ packages: 2, workspaces: 2, upToDate: true });
  });

  it("counts the workspaces in lock's summary", async () => {
    const result = await upm("", "lock");
    expect(result.stderr).toContain("2 pkgs · 0 opt · 1 dev · 2 ws");
  });

  it("is stale under --frozen-lockfile when a workspace's ranges or the set of workspaces move", async () => {
    expect(await upm("", "install")).toMatchObject({ code: 0 });
    expect(await upm("packages/a", "install", "--frozen-lockfile")).toMatchObject({ code: 0 });

    const a = await manifest("packages/a");
    a.dependencies.nanoid = "^4";
    await pkg("packages/a", a);
    const ranges = await upm("", "install", "--frozen-lockfile");
    expect(ranges.code).toBe(1);
    expect(ranges.stderr).toContain("is out of date with package.json (ELOCK)");

    a.dependencies.nanoid = "^5";
    await pkg("packages/a", a);
    await pkg("packages/d", { name: "d", version: "1.0.0" });
    const added = await upm("", "install", "--frozen-lockfile");
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("is out of date with package.json (ELOCK)");
  });

  it("refuses -w, --workspaces, --if-present and --include-workspace-root where they do not apply", async () => {
    const install = await upm("", "install", "-w", "a");
    expect(install.code).toBe(2);
    expect(install.stderr).toContain("install is always the whole tree");
    expect(await upm("", "install", "--workspaces")).toMatchObject({ code: 2 });
    expect(await upm("", "lock", "-w", "a")).toMatchObject({ code: 2 });
    expect(await upm("", "install", "--if-present")).toMatchObject({ code: 2 });
    expect(await upm("", "run", "--include-workspace-root", "build")).toMatchObject({ code: 2 });
    expect(await upm("", "add", "c", "--include-workspace-root")).toMatchObject({ code: 2 });
    expect(await upm("", "run", "-w", "a", "--workspaces", "build")).toMatchObject({ code: 2 });
    expect(await upm("", "run", "-w")).toMatchObject({ code: 2 });
  });

  it("reads .npmrc from the root, and says so when the workspace has one", async () => {
    await writeFile(join(dir, "packages", "a", ".npmrc"), "registry=http://127.0.0.1:1/\n");
    const result = await upm("packages/a", "install");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain(
      `ignoring ${join(dir, "packages", "a", ".npmrc")}: .npmrc is read from ${dir}`,
    );
    // From the root, or with --dir, there is nothing to ignore.
    expect((await upm("", "install")).stderr).not.toContain("ignoring");
    expect((await upm("packages/a", "install", "--dir", dir)).stderr).not.toContain("ignoring");
  });
});

describe("add and remove", () => {
  it("edits the package.json -w names, and nothing else", async () => {
    const root = await read("package.json");
    const b = await read("packages/b/package.json");
    const result = await upm("", "add", "c", "-w", "a");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain("+ c@^1.0.0 in dependencies");
    expect((await manifest("packages/a")).dependencies).toEqual({
      b: "^1",
      c: "^1.0.0",
      nanoid: "^5",
    });
    expect(await read("package.json")).toBe(root);
    expect(await read("packages/b/package.json")).toBe(b);
    expect(await read("packages/a/node_modules/c/index.js")).toBe('module.exports = "c@1.0.0";\n');
    expect((await lockfile()).workspaces["packages/a"].specs.dependencies.c).toBe("^1.0.0");

    const removed = await upm("", "remove", "c", "nanoid", "-w", "packages/a");
    expect(removed).toMatchObject({ code: 0 });
    expect((await manifest("packages/a")).dependencies).toEqual({ b: "^1" });
    expect(await read("package.json")).toBe(root);
  });

  it("edits the workspace cwd is in, else the root", async () => {
    expect(await upm("packages/b", "add", "nanoid")).toMatchObject({ code: 0 });
    expect((await manifest("packages/b")).dependencies).toEqual({ nanoid: "^5.0.0" });
    expect(await manifest("")).not.toHaveProperty("dependencies");

    expect(await upm("", "add", "nanoid")).toMatchObject({ code: 0 });
    expect((await manifest("")).dependencies).toEqual({ nanoid: "^5.0.0" });
    // Through the root's store either way; `b` links it from its own directory.
    expect(await linkOf(join(dir, "packages", "b", "node_modules", "nanoid"))).toMatch(
      /^\.\.\/\.\.\/\.\.\/node_modules\/\.upm\//,
    );
  });

  it("saves a caret range of a workspace's version without asking the registry", async () => {
    const result = await upm("", "add", "b", "-w", "a");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain("+ b@^1.2.0 in dependencies");
    expect((await manifest("packages/a")).dependencies.b).toBe("^1.2.0");
    expect(requests.some((url) => url.startsWith("/b"))).toBe(false);
    expect((await lockfile()).workspaces["packages/a"].dependencies.b).toBe("link:packages/b");

    expect(await upm("", "add", "b", "-E", "-w", "a")).toMatchObject({ code: 0 });
    expect((await manifest("packages/a")).dependencies.b).toBe("1.2.0");

    expect(await upm("", "add", "b@workspace:*", "--dev", "-w", "a")).toMatchObject({ code: 0 });
    const a = await manifest("packages/a");
    expect(a.devDependencies).toEqual({ b: "workspace:*" });
    expect(a.dependencies).toEqual({ nanoid: "^5" });
    expect(requests.some((url) => url.startsWith("/b"))).toBe(false);

    // A range the workspace does not fit is the registry's, as the resolver would have it.
    expect(await upm("", "add", "b@^9", "-w", "a")).toMatchObject({ code: 0 });
    expect((await manifest("packages/a")).dependencies.b).toBe("^9");
    expect(requests).toContain("/b");
  });

  it("refuses -w that names several workspaces, or none", async () => {
    const several = await upm("", "add", "c", "-w", "packages");
    expect(several.code).toBe(1);
    expect(several.stderr).toContain(
      "add edits one package.json, and workspaces picks a, b (EWORKSPACE)",
    );
    const none = await upm("", "remove", "b", "-w", "nope");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no workspace is named or at nope (EWORKSPACE)");
    expect((await manifest("packages/a")).dependencies).toEqual({ b: "^1", nanoid: "^5" });
  });
});

describe.skipIf(process.platform === "win32")("run", () => {
  it("runs cwd's own script without -w, root or workspace", async () => {
    expect((await upm("packages/a", "run", "build")).stdout).toBe("build a\n");
    expect((await upm("packages/a", "build")).stdout).toBe("build a\n");
    expect((await upm("", "build")).stdout).toBe("build root\n");
  });

  it("runs the workspaces a dependency first, goes on past a failure, and exits with its code", async () => {
    const b = await manifest("packages/b");
    b.scripts.build = "echo build b; exit 3";
    await pkg("packages/b", b);
    expect(await upm("", "install")).toMatchObject({ code: 0 });
    const result = await upm("", "run", "--workspaces", "build");
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("build b\nbuild a\n");
    expect(result.stderr).toBe(
      "> b: build\n> echo build b; exit 3\n> a: build\n> echo build a\nupm: build failed in b (packages/b) with code 3\n",
    );
  });

  it("installs the whole tree first, from inside a workspace, then finds it current", async () => {
    const first = await upm("packages/a", "run", "build");
    expect(first).toMatchObject({ code: 0, stdout: "build a\n" });
    expect(first.stderr).toContain("upm: installed 2 packages\n> build\n");
    expect(await linkOf(join(dir, "packages", "a", "node_modules", "nanoid"))).toBeTruthy();
    expect(await binOf(join(dir, "packages", "a", "node_modules", ".bin", "b-cli"))).toBeTruthy();
    const asked = requests.length;
    const again = await upm("packages/a", "build");
    expect(again).toMatchObject({
      code: 0,
      stdout: "build a\n",
      stderr: "> build\n> echo build a\n",
    });
    expect(requests.length).toBe(asked);
  });

  it("keeps a --production tree production", async () => {
    expect(await upm("", "install", "--production")).toMatchObject({ code: 0 });
    const result = await upm("packages/b", "run", "build");
    expect(result).toMatchObject({ code: 0, stderr: "> build\n> echo build b\n" });
    await expect(read("packages/b/node_modules/c/index.js")).rejects.toThrow();
  });

  it("installs nothing for a missing script, or a project with nothing to install", async () => {
    expect((await upm("", "run", "nope")).code).toBe(1);
    await pkg("lone", { name: "lone", scripts: { hi: "echo hi" } });
    expect(await upm("lone", "run", "hi")).toMatchObject({ code: 0, stdout: "hi\n" });
    await expect(read("upm.lock")).rejects.toThrow();
    await expect(read("lone/upm.lock")).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("skips a workspace without the script under --if-present, and fails it otherwise", async () => {
    const present = await upm("", "run", "--workspaces", "--if-present", "test");
    expect(present).toMatchObject({ code: 0, stdout: "test a\n" });
    const missing = await upm("", "run", "--workspaces", "test");
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("test a\n");
    expect(missing.stderr).toContain(
      `missing script "test" in ${join(dir, "packages", "b", "package.json")}`,
    );
    expect(missing.stderr).toContain("test failed in b (packages/b) with code 1");
  });

  it("notes a cycle once and keeps the declared order for its members", async () => {
    const b = await manifest("packages/b");
    b.devDependencies.a = "workspace:*";
    await pkg("packages/b", b);
    const result = await upm("", "run", "--workspaces", "build");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("build a\nbuild b\n");
    expect(result.stderr.split("\n").filter((line) => line.includes("depend on"))).toEqual([
      "upm: workspaces a, b depend on each other; running them as declared",
    ]);
  });

  it("picks workspaces by name, by path from the root or cwd, or by a parent directory", async () => {
    expect((await upm("", "run", "-w", "b", "build")).stdout).toBe("build b\n");
    expect((await upm("", "run", "-w", "packages/a", "build")).stdout).toBe("build a\n");
    expect((await upm("packages/b", "run", "-w", "../a", "build")).stdout).toBe("build a\n");
    expect((await upm("packages/b", "run", "-w", "./", "build")).stdout).toBe("build b\n");
    expect((await upm("", "run", "-w", "packages", "build")).stdout).toBe("build b\nbuild a\n");
    // Named twice is run once, and named in either order still runs `b` first.
    expect((await upm("", "run", "-w", "a", "-w", "b", "-w", "a", "build")).stdout).toBe(
      "build b\nbuild a\n",
    );
    const none = await upm("", "run", "-w", "nope", "build");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no workspace is named or at nope (EWORKSPACE)");
  });

  it("runs the root first under --include-workspace-root", async () => {
    const result = await upm(
      "packages/a",
      "run",
      "--workspaces",
      "--include-workspace-root",
      "build",
    );
    expect(result).toMatchObject({ code: 0, stdout: "build root\nbuild b\nbuild a\n" });
    expect(result.stderr).toContain("> root: build\n");
  });

  it("lists every workspace's scripts without a name", async () => {
    const listed = await upm("", "run", "--workspaces");
    expect(listed.stdout).toBe(
      "b\n  build\n    echo build b\na\n  build\n    echo build a\n  test\n    echo test a\n",
    );
    const json = JSON.parse((await upm("", "run", "--workspaces", "--json")).stdout);
    expect(Object.keys(json)).toEqual(["b", "a"]);
    expect(json.a).toEqual({ build: "echo build a", test: "echo test a" });
  });
});
