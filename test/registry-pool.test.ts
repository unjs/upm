import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistryPool, shares } from "../src/registry-pool.ts";
import type { PoolOptions, RegistryPool } from "../src/registry-pool.ts";
import { resolveTree } from "../src/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import type { Manifest, Packument } from "../src/types.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/upm.ts", import.meta.url));
const FLAKY = new URL("./flaky-registry-worker.ts", import.meta.url);
const SLOW = new URL("./slow-registry-worker.ts", import.meta.url);

/** One tarball for every package: an install only checks it against the integrity. */
const tarball = makeTarball([{ path: "index.js", data: "module.exports = 1;\n" }]);
const integrity = hashOf(tarball);
let registry: string;

/** Tarball urls point at the test server, whose address the manifests learn lazily. */
function manifest(name: string, version: string, extra: Partial<Manifest> = {}): Manifest {
  const basename = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return {
    name,
    version,
    get dist() {
      return { tarball: `${registry}/${name}/-/${basename}-${version}.tgz`, integrity };
    },
    ...extra,
  };
}

function packument(name: string, versions: Manifest[], latest: string): Packument {
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((m) => [m.version, m])),
  };
}

const foo = packument(
  "foo",
  [manifest("foo", "1.0.0"), manifest("foo", "1.1.0"), manifest("foo", "2.0.0-beta.1")],
  "1.1.0",
);
// The packument (a CDN copy) lacks 1.2.0; the per-version route (the origin) has it.
const bar = packument("@s/bar", [manifest("@s/bar", "1.0.0")], "1.0.0");
const barLater = manifest("@s/bar", "1.2.0", { dependencies: { foo: "^1" } });
const app = packument(
  "app",
  [manifest("app", "1.0.0", { dependencies: { foo: "^1.0.0", "@s/bar": "1.2.0" } })],
  "1.0.0",
);

let server: Server;
let hits: Map<string, number>;
/** The `authorization` each url was last asked with. */
let auth: Map<string, string | undefined>;
let flakyFailures: number;
const open: RegistryPool[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "";
    hits.set(url, (hits.get(url) ?? 0) + 1);
    auth.set(url, request.headers.authorization);
    const send = (status: number, body: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const routes: Record<string, () => void> = {
      "/foo": () => send(200, foo),
      "/foo2": () => send(200, foo),
      "/foo/1.0.0": () => send(200, foo.versions["1.0.0"]),
      "/foo/1.1.0": () => send(200, foo.versions["1.1.0"]),
      "/foo/9.9.9": () => send(404, { error: "not found" }),
      "/@s%2fbar": () => send(200, bar),
      "/@s%2fbar/1.2.0": () => send(200, barLater),
      "/scoped/@s%2fbar/1.2.0": () => send(200, barLater),
      "/app": () => send(200, app),
      "/app/1.0.0": () => send(200, app.versions["1.0.0"]),
      // Changed lately, and 1.1.0 with it: its dates are in the full document alone.
      "/aged": () =>
        send(200, {
          ...foo,
          modified: new Date().toISOString(),
          ...(request.headers.accept === "application/json" && {
            time: { "1.0.0": "2020-01-01T00:00:00.000Z", "1.1.0": new Date().toISOString() },
          }),
        }),
      "/flaky": () => (flakyFailures-- > 0 ? send(500, {}) : send(200, foo)),
      "/slow": () => void setTimeout(() => send(200, foo), 800),
    };
    if (url.endsWith(".tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
      return;
    }
    (routes[url] ?? (() => send(404, { error: "not found" })))();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  for (const pool of open.splice(0)) pool.close();
  delete process.env.UPM_TEST_DIE_NAME;
  delete process.env.UPM_TEST_THROW_NAME;
  delete process.env.UPM_TEST_MUTE;
  delete process.env.UPM_TEST_DEAF;
  delete process.env.UPM_TEST_SLOW_MS;
});

beforeEach(() => {
  hits = new Map();
  auth = new Map();
  flakyFailures = 0;
});

function pool(options: PoolOptions = {}): RegistryPool {
  const p = createRegistryPool({ registry, size: 2, ...options });
  open.push(p);
  return p;
}

/**
 * The threads are up. The first question starts them and ran here; a name asked before they
 * are up stays here, so this is a name nothing else asks about.
 */
async function ready(p: RegistryPool): Promise<void> {
  for (const name of ["boot1", "boot2", "boot3", "boot4"]) {
    expect(await p.pinned(name, "0.0.0")).toBeUndefined();
  }
  await new Promise((done) => setTimeout(done, 600));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("createRegistryPool", () => {
  it("picks on a thread what the plain registry picks here", async () => {
    const p = pool();
    await ready(p);
    const plain = pool({ size: 0 });
    // The walk pins an exact spec, so the version the packument lacks comes off the route.
    const pin = (raw: string) => {
      const spec = parseSpec(raw);
      return [spec, spec.type === "version" ? spec.fetchSpec : undefined] as const;
    };
    for (const raw of ["foo@^1", "foo@1.0.0", "foo@latest", "foo@>=2.0.0-0", "@s/bar@1.2.0"]) {
      expect(await p.pick(...pin(raw))).toEqual(await plain.pick(...pin(raw)));
    }
    expect((await p.pick(parseSpec("foo@^1"))).version).toBe("1.1.0");
    expect((await p.pick(parseSpec("foo@^1"), "1.0.0")).version).toBe("1.0.0");
    expect((await p.pinned("@s/bar", "1.2.0"))?.version).toBe("1.2.0");
    expect(await p.pinned("foo", "9.9.9")).toBeUndefined();
    expect((await p.manifest("foo", "1.1.0")).version).toBe("1.1.0");
  });

  it("carries the error codes across the port", async () => {
    const p = pool();
    await ready(p);
    expect(await codeOf(p.pick(parseSpec("gone@^1")))).toBe("E404");
    expect(await codeOf(p.pick(parseSpec("foo@^3")))).toBe("ETARGET");
    expect(await codeOf(p.pick(parseSpec("foo@nope")))).toBe("ETARGET");
    expect(await codeOf(p.manifest("foo", "9.9.9"))).toBe("E404");
    flakyFailures = 1;
    expect((await p.pick(parseSpec("flaky@^1"))).version).toBe("1.1.0");
    // The one retry was the thread's; nothing was asked twice from here.
    expect(hits.get("/flaky")).toBe(2);
  });

  it("asks each thread once for a document its questions share", async () => {
    const p = pool();
    await ready(p);
    const picks = await Promise.all([
      p.pick(parseSpec("app@^1")),
      p.pick(parseSpec("app@latest")),
      p.pick(parseSpec("app@1.0.0")),
      p.pinned("app", "1.0.0"),
      p.pick(parseSpec("app@*"), "1.0.0"),
    ]);
    expect(picks.map((m) => m?.version)).toEqual(["1.0.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0"]);
    // The pins read their version out of the document the range started, not off the route.
    expect(hits.get("/app")).toBe(1);
    expect(hits.get("/app/1.0.0")).toBeUndefined();
  });

  it("answers here while the threads boot, and after they die", async () => {
    process.env.UPM_TEST_DIE_NAME = "app";
    const p = pool({ entry: FLAKY });
    // Before any thread is started: answered here, at once, and `foo` stays here.
    expect(await p.pick(parseSpec("foo@^1"))).toMatchObject({ version: "1.1.0" });
    await ready(p);
    expect(await p.pick(parseSpec("foo@^1"))).not.toHaveProperty("deprecated");
    // `flaky` and `app` hash to one of the two threads, `foo` to the other.
    expect(await p.pick(parseSpec("flaky@^1"))).toHaveProperty("deprecated", "thread");
    // The thread that owns `app` exits the moment it is asked; the question is asked here.
    const [a, b] = await Promise.all([p.pick(parseSpec("app@^1")), p.pinned("app", "1.0.0")]);
    expect(a).toMatchObject({ version: "1.0.0" });
    expect(a).not.toHaveProperty("deprecated");
    expect(b?.version).toBe("1.0.0");
    // And everything of its after it, while the other thread still answers.
    expect(await p.pick(parseSpec("app@^1"))).not.toHaveProperty("deprecated");
    expect(await p.pick(parseSpec("flaky@^1"))).not.toHaveProperty("deprecated");
    expect(await p.pick(parseSpec("foo@latest"))).not.toHaveProperty("deprecated");
    expect(await p.pick(parseSpec("foo2@latest"))).toHaveProperty("deprecated", "thread");
  });

  it("starts the threads when it is made at `startAt: 0`", async () => {
    // The first name is handed to a booting thread and answered by it; nothing ran here.
    const p = pool({ entry: FLAKY, startAt: 0 });
    expect(await p.pick(parseSpec("foo@^1"))).toHaveProperty("deprecated", "thread");
    expect(await p.pick(parseSpec("flaky@^1"))).toHaveProperty("deprecated", "thread");
    // Size 0 is the plain registry at any start.
    const none = pool({ entry: FLAKY, startAt: 0, size: 0 });
    expect(await none.pick(parseSpec("foo@^1"))).not.toHaveProperty("deprecated");
  });

  it("starts the threads when it is made, told of as many names as start them", async () => {
    const told = pool({ entry: FLAKY, expected: 4 });
    expect(await told.pick(parseSpec("foo@^1"))).toHaveProperty("deprecated", "thread");
    const few = pool({ entry: FLAKY, expected: 3 });
    expect(await few.pick(parseSpec("foo@^1"))).not.toHaveProperty("deprecated");
  });

  it("hands a name to a thread still booting, and asks here after the grace", async () => {
    // The first three names are answered here and start nothing.
    const p = pool({ entry: FLAKY });
    for (const name of ["boot1", "boot2", "boot3"]) await p.pinned(name, "0.0.0");
    // The fourth starts the threads, and is theirs: it waits for the boot, as does the next.
    const [d, e] = await Promise.all([p.pick(parseSpec("foo@^1")), p.pick(parseSpec("foo2@^1"))]);
    expect(d).toHaveProperty("deprecated", "thread");
    expect(e).toHaveProperty("deprecated", "thread");
    // A thread that stays silent past the grace does not hold its questions: they are asked
    // here, and the late thread's answer, if it comes, is dropped.
    process.env.UPM_TEST_DEAF = "1";
    const deaf = pool({ entry: FLAKY, bootMs: 5000, graceMs: 200 });
    for (const name of ["boot1", "boot2", "boot3"]) await deaf.pinned(name, "0.0.0");
    const t0 = performance.now();
    expect(await deaf.pick(parseSpec("foo@^1"))).not.toHaveProperty("deprecated");
    expect(performance.now() - t0).toBeGreaterThan(150);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("does not ask here again once the thread has said hello and is merely slow", async () => {
    // The question is handed to the thread while it boots; the thread says hello at once and
    // answers 1 s later, past a 400 ms grace. The grace waits for the hello, not the answer:
    // asked here as well, the registry would see the question twice. The grace is wide enough
    // for a thread to boot under a loaded test run, which is not what is being tested.
    process.env.UPM_TEST_SLOW_MS = "1000";
    const p = pool({ entry: SLOW, size: 1, startAt: 0, graceMs: 400 });
    const found = await p.pick(parseSpec("foo@^1"));
    expect(found).toHaveProperty("deprecated", "thread");
    await new Promise((done) => setTimeout(done, 200));
    expect(hits.get("/foo")).toBe(1);
  });

  it("does not wait on a thread that never speaks", async () => {
    process.env.UPM_TEST_DEAF = "1";
    const p = pool({ entry: FLAKY, bootMs: 200 });
    // The fourth name went to a thread that never answers: asked here once it is given up on.
    await ready(p);
    expect(await p.pick(parseSpec("foo@^1"))).toEqual(foo.versions["1.1.0"]);
    expect(await p.pick(parseSpec("app@^1"))).toEqual(app.versions["1.0.0"]);
    // One that answers without ever saying hello is a thread like any other.
    delete process.env.UPM_TEST_DEAF;
    process.env.UPM_TEST_MUTE = "1";
    const mute = pool({ entry: FLAKY, bootMs: 200 });
    await ready(mute);
    expect(await mute.pick(parseSpec("foo@^1"))).toMatchObject({ version: "1.1.0" });
  });

  it("counts a thread that never speaks as one that failed to load", async () => {
    process.env.UPM_TEST_DEAF = "1";
    const warnings: string[] = [];
    const quiet = pool({ entry: FLAKY, bootMs: 200, warn: (m) => warnings.push(m) });
    await ready(quiet);
    expect(warnings).toEqual([
      "registry thread failed to start: no hello within the boot timeout",
      "registry thread failed to start: no hello within the boot timeout",
    ]);
    // Under `strict` the warning is given too, and every question the threads were handed or
    // asked after is the failure.
    const said: string[] = [];
    const strict = pool({ entry: FLAKY, bootMs: 200, strict: true, warn: (m) => said.push(m) });
    for (const name of ["boot1", "boot2", "boot3"]) await strict.pinned(name, "0.0.0");
    await expect(strict.pinned("boot4", "0.0.0")).rejects.toMatchObject({ code: "EWORKER" });
    await new Promise((done) => setTimeout(done, 300)); // the other thread's timeout
    expect(said).toHaveLength(2);
    await expect(strict.pick(parseSpec("app@^1"))).rejects.toMatchObject({ code: "EWORKER" });
  });

  it("refuses everything asked after close()", async () => {
    const p = pool();
    await ready(p);
    expect((await p.pick(parseSpec("app@^1"))).version).toBe("1.0.0");
    p.close();
    // Before the threads have exited, and after: never a request from here.
    await expect(p.pick(parseSpec("foo2@^1"))).rejects.toMatchObject({ code: "ECLOSED" });
    await new Promise((done) => setTimeout(done, 200));
    await expect(p.pick(parseSpec("foo2@^1"))).rejects.toMatchObject({ code: "ECLOSED" });
    await expect(p.pinned("app", "1.0.0")).rejects.toMatchObject({ code: "ECLOSED" });
    expect(hits.get("/foo2")).toBeUndefined();
  });

  it("makes an Error of a thread rejecting with something else", async () => {
    process.env.UPM_TEST_THROW_NAME = "foo2";
    const p = pool({ entry: FLAKY });
    await ready(p);
    await expect(p.pick(parseSpec("foo2@^1"))).rejects.toMatchObject({
      message: "not an Error",
      code: undefined,
    });
  });

  it("says so when a thread cannot load, and fails when threads were asked for", async () => {
    const missing = new URL("./does-not-exist.ts", import.meta.url);
    const warnings: string[] = [];
    const noThreads = vi.fn();
    const quiet = pool({ entry: missing, warn: (m) => warnings.push(m), noThreads });
    await ready(quiet);
    // Everything answered here, and the failure said once per thread, and once for the pool.
    expect((await quiet.pick(parseSpec("app@^1"))).version).toBe("1.0.0");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/registry thread failed to start: .*does-not-exist/);
    expect(noThreads).toHaveBeenCalledTimes(1);

    // Asked for by count: what was answered here before the threads started stands, and every
    // question handed to them or asked after is the failure.
    const strict = pool({ entry: missing, strict: true });
    for (const name of ["boot1", "boot2", "boot3"]) await strict.pinned(name, "0.0.0");
    await expect(strict.pinned("boot4", "0.0.0")).rejects.toMatchObject({ code: "EWORKER" });
    await expect(strict.pick(parseSpec("app@^1"))).rejects.toMatchObject({
      code: "EWORKER",
      message: expect.stringContaining("registry thread failed to start"),
    });
  });

  it("answers here where the timers are a browser's and there is no worker_threads", async () => {
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
      const { createRegistryPool: create } = await import("../src/registry-pool.ts");
      const noThreads = vi.fn();
      // A browser's timer is a number: nothing to unref. Only while the pool starts, at `startAt:
      // 0` as it is made, since the request after it is Node's fetch, which wants Node's timers.
      vi.stubGlobal("setTimeout", () => 1);
      const p = create({ registry, startAt: 0, noThreads });
      vi.unstubAllGlobals();
      open.push(p);
      expect((await p.pick(parseSpec("app@^1"))).version).toBe("1.0.0");
      expect(noThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("../src/builtin.ts");
      vi.resetModules();
    }
  });

  it("hands each thread the whole gate and a share of its floor", async () => {
    expect(shares(16, 3)).toEqual([6, 5, 5]);
    expect(shares(4, 3)).toEqual([2, 1, 1]);
    expect(shares(16, 5)).toEqual([4, 3, 3, 3, 3]);
    expect(shares(16, 1)).toEqual([16]);
    const p = pool({ entry: FLAKY, size: 2 });
    await ready(p);
    expect((await p.manifest("gate", "0.0.0")).version).toBe("32/16/2");
    const wide = pool({ entry: FLAKY, size: 2, concurrency: 48, start: 24, min: 6 });
    await ready(wide);
    expect((await wide.manifest("gate", "0.0.0")).version).toBe("48/24/3");
  });

  it("does not ask again here what close() cut off on a thread", async () => {
    const p = pool();
    await ready(p);
    const cut = p.pick(parseSpec("slow@^1"));
    cut.catch(() => {});
    await new Promise((done) => setTimeout(done, 100));
    expect(hits.get("/slow")).toBe(1);
    p.close();
    // The walk that asked has failed and gone; a second request for it is one nobody reads,
    // and one that holds the process open for its retries.
    await new Promise((done) => setTimeout(done, 300));
    expect(hits.get("/slow")).toBe(1);
  });

  it("hands each thread the scope registries and credentials it was given", async () => {
    const dart = `//${registry.slice("http://".length)}/`;
    const p = pool({ scopes: { "@s": `${registry}/scoped/` }, auth: { [dart]: "Bearer t" } });
    await ready(p);
    expect(p.baseFor("@s/bar")).toBe(`${registry}/scoped`);
    // A name first asked about now has a thread for a home: that thread is what asks.
    expect((await p.manifest("@s/bar", "1.2.0")).version).toBe("1.2.0");
    expect(auth.get("/scoped/@s%2fbar/1.2.0")).toBe("Bearer t");
    expect(hits.has("/@s%2fbar/1.2.0")).toBe(false);
  });

  it("hands each thread the release cutoff and its exclusions", async () => {
    const before = Date.now() - 86_400_000;
    const p = pool({ before, exclude: ["foo"] });
    await ready(p);
    const plain = pool({ size: 0, before, exclude: ["foo"] });
    for (const q of [p, plain]) {
      expect((await q.pick(parseSpec("aged@^1"))).version).toBe("1.0.0");
      expect((await q.pick(parseSpec("foo@^1"))).version).toBe("1.1.0");
    }
    expect(hits.get("/aged")).toBe(4);
  });

  it("resolves the same tree with and without threads", async () => {
    const root = { name: "root", dependencies: { app: "^1" } };
    const threaded = pool();
    await ready(threaded);
    const a = await resolveTree(root, { registry: threaded });
    const b = await resolveTree(root, { registry: pool({ size: 0 }) });
    expect(a).toEqual(b);
    expect(Object.keys(a.packages).sort()).toEqual(["@s/bar@1.2.0", "app@1.0.0", "foo@1.1.0"]);
  });
});

describe("UPM_RESOLVE_POOL", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-resolve-pool-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { app: "^1" } }));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function lock(env: Record<string, string>): Promise<string> {
    const { stdout } = await run(
      process.execPath,
      [CLI, "lock", "--json", "--dir", dir, "--registry", registry],
      { env: { ...process.env, ...env } },
    );
    return stdout;
  }

  it("writes the same lockfile off, with the default and with one thread", async () => {
    const off = await lock({ UPM_RESOLVE_POOL: "off" });
    expect(off).toContain('"app@1.0.0"');
    expect(await lock({})).toBe(off);
    expect(await lock({ UPM_RESOLVE_POOL: "1" })).toBe(off);
  });

  it("reads the value the way UPM_LINK_POOL is read: off, on, or digits", async () => {
    const off = await lock({ UPM_RESOLVE_POOL: "off" });
    for (const value of ["", "0", "16"]) expect(await lock({ UPM_RESOLVE_POOL: value })).toBe(off);
    for (const value of ["17", "many", " 2", "2.0", "1e1", "0x2"]) {
      await expect(lock({ UPM_RESOLVE_POOL: value })).rejects.toMatchObject({
        stderr: expect.stringContaining("UPM_RESOLVE_POOL takes off or a count up to 16"),
      });
    }
  });

  it("is not read by a command that reads no registry", async () => {
    const env = { ...process.env, UPM_RESOLVE_POOL: "many" };
    const { stderr } = await run(process.execPath, [CLI, "run", "--dir", dir], { env });
    expect(stderr).not.toContain("UPM_RESOLVE_POOL");
    await expect(
      run(process.execPath, [CLI, "prune", "--dir", dir, "--store", join(dir, "store")], { env }),
    ).resolves.toBeDefined();
  });

  it("installs and dedupes through the threads as it does without them", async () => {
    const project = join(dir, "install");
    const out: Record<string, string[]> = {};
    for (const threads of ["off", "2"]) {
      await rm(project, { recursive: true, force: true });
      await mkdir(project);
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ dependencies: { app: "^1" } }),
      );
      const env = { ...process.env, UPM_RESOLVE_POOL: threads };
      const args = ["--dir", project, "--store", join(project, "store"), "--registry", registry];
      await run(process.execPath, [CLI, "install", ...args], { env });
      const lock = await readFile(join(project, "upm.lock"), "utf8");
      const { stderr } = await run(process.execPath, [CLI, "dedupe", ...args], { env });
      expect(stderr).toContain("nothing to dedupe");
      out[threads] = [lock, ...(await readdir(join(project, "node_modules"))).sort()];
    }
    expect(out["2"]).toEqual(out.off);
    expect(out.off).toContain("app");
    expect(out.off![0]).toContain('"@s/bar@1.2.0"');
  });
});
