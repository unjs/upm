// The build as it ships, made fresh from build.config.ts into a temporary directory, then bundled
// again the way an app takes upm in: into chunks of the app's own, with no file of ours beside
// them. Source tests start every worker from its .ts file in `src/`; only this shows that the
// built pools start theirs wherever a bundler puts them.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "obuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config, { loadRolldown } from "../build.config.ts";
import type { startLinkPool as StartLinkPool } from "../src/link-pool.ts";
import type { createRegistryPool as CreateRegistryPool } from "../src/registry-pool.ts";
import type { createPool as CreatePool } from "../src/unpack-pool.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

interface Pools {
  createPool: typeof CreatePool;
  startLinkPool: typeof StartLinkPool;
  createRegistryPool: typeof CreateRegistryPool;
}

let dir: string;
let out: string;
let server: Server;
let registry: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-dist-"));
  out = join(dir, "dist");
  const entries = config.entries!.map((entry) => {
    // A string entry keeps obuild's own `dist`, which it empties first: the real build.
    if (typeof entry === "string") throw new Error(`give ${entry} as an object entry`);
    return { ...entry, outDir: out, dts: false };
  });
  await build({ ...config, cwd: join(import.meta.dirname, ".."), entries });
  const manifest = { name: "a", version: "1.0.0", dist: { tarball: "", integrity: "" } };
  server = createServer((request, response) => {
    const body = request.url === "/a/1.0.0" ? manifest : undefined;
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** The three pools, bundled by rolldown into `format` chunks of an app somewhere else. */
async function bundled(format: "esm" | "cjs"): Promise<Pools> {
  const app = join(dir, `app-${format}`);
  await mkdir(app, { recursive: true });
  const input = join(app, "entry.mjs");
  const pools = ["createPool:unpack", "startLinkPool:link", "createRegistryPool:registry"];
  const lines = pools.map((pool) => {
    const [name, file] = pool.split(":");
    return `export { ${name} } from ${JSON.stringify(join(out, "_chunks", `${file}-pool.mjs`))};`;
  });
  await writeFile(input, lines.join("\n"));
  const { rolldown } = await loadRolldown();
  const bundle = await rolldown({ input, platform: "node", logLevel: "silent" });
  const ext = format === "esm" ? "mjs" : "cjs";
  await bundle.write({ dir: join(app, "out"), format, entryFileNames: `app.${ext}` });
  await bundle.close();
  const file = join(app, "out", `app.${ext}`);
  if (format === "cjs") return createRequire(import.meta.url)(file) as Pools;
  return (await import(pathToFileURL(file).href)) as Pools;
}

describe("dist", () => {
  for (const format of ["esm", "cjs"] as const) {
    it(`starts every worker from an app's ${format} bundle`, async () => {
      const pools = await bundled(format);
      expect((await readdir(join(dir, `app-${format}`, "out"))).join()).not.toMatch(/worker/);
      let alone = 0;
      const noThreads = () => alone++;

      // Each pool hands its work back here when no worker will load; that is the failure.
      const unpack = pools.createPool(join(dir, "store"), {
        size: 1,
        noThreads,
        fallback: () => Promise.reject(new Error("unpacked on the main thread")),
      });
      try {
        const tarball = makeTarball([{ path: "index.js", data: "module.exports = 1;\n" }]);
        const index = await unpack.offer(hashOf(tarball), [tarball], false);
        expect(index?.files.map((file) => file.path)).toEqual(["index.js"]);
      } finally {
        unpack.close();
      }

      const link = pools.startLinkPool(1, undefined, undefined, noThreads)!;
      try {
        const blobDir = join(dir, `blobs-${format}`);
        const into = join(dir, `linked-${format}`);
        await mkdir(blobDir, { recursive: true });
        await writeFile(join(blobDir, "b"), "hi");
        const shard = {
          dirs: [into],
          dir: into,
          paths: ["f"],
          blobDir,
          blobs: ["b"],
          symlinks: [],
        };
        expect(await link.run(shard)).toEqual({ linked: 1, copied: 0 });
        expect(await readFile(join(into, "f"), "utf8")).toBe("hi");
      } finally {
        link.close();
      }

      // Strict, and never asked here while the thread boots: only the thread can answer.
      const reg = pools.createRegistryPool({
        registry,
        size: 1,
        startAt: 0,
        strict: true,
        graceMs: 60_000,
        noThreads,
      });
      try {
        expect((await reg.manifest("a", "1.0.0")).version).toBe("1.0.0");
      } finally {
        reg.close();
      }
      expect(alone).toBe(0);
    });
  }

  // In a CommonJS bundle upm's own code has no `import.meta` to resolve with.
  for (const format of ["esm", "cjs"] as const) {
    it(`resolves an import from a directory in an app's ${format} bundle`, async () => {
      const app = join(dir, `resolvex-${format}`);
      const hi = join(app, "node_modules", "hi");
      await mkdir(hi, { recursive: true });
      await writeFile(join(hi, "package.json"), '{"name":"hi","version":"1.0.0"}');
      await writeFile(join(hi, "index.js"), "");
      const input = join(app, "entry.mjs");
      await writeFile(input, `export { resolvex } from ${JSON.stringify(join(out, "index.mjs"))};`);
      const { rolldown } = await loadRolldown();
      const bundle = await rolldown({ input, platform: "node", logLevel: "silent" });
      const ext = format === "esm" ? "mjs" : "cjs";
      await bundle.write({ dir: join(app, "out"), format, entryFileNames: `app.${ext}` });
      await bundle.close();
      const file = join(app, "out", `app.${ext}`);
      const { resolvex } = (
        format === "cjs"
          ? createRequire(import.meta.url)(file)
          : await import(pathToFileURL(file).href)
      ) as { resolvex: (specifier: string, options: object) => Promise<string> };
      const url = await resolvex("hi", { from: app, registry });
      expect(url).toBe(pathToFileURL(join(hi, "index.js")).href);
    });
  }

  it("keeps the commands out of the workers and the resolver", async () => {
    // Each worker is bundled whole into its pool: a module of the commands imported by mistake
    // would be in every thread's boot (+5 ms), and in `upm/resolver` too. The markers are
    // messages of api.ts and link.ts, checked to be in `main` so a stale one cannot pass.
    const markers = ["needs at least one spec", "a symlink that leads nowhere"];
    const main = await readFile(join(out, "_chunks", "main.mjs"), "utf8");
    for (const marker of markers) expect(main).toContain(marker);
    const files = ["link-pool", "registry-pool", "unpack-pool"].map((pool) => `_chunks/${pool}`);
    for (const file of [...files, "resolver"]) {
      const code = await readFile(join(out, `${file}.mjs`), "utf8");
      expect(code, file).not.toMatch(/\/main\.mjs/);
      for (const marker of markers) expect(code, file).not.toContain(marker);
    }
  });
});
