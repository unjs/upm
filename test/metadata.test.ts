// Registry documents kept on disk: revalidated, preferred, or the only source offline.
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentCache, metadataDir, trimPackument } from "../src/metadata.ts";
import { indexVersions, parseSlice, pluckModified, pluckTimes } from "../src/pluck.ts";
import type { CacheMode, RegistryOptions } from "../src/registry.ts";
import { createRegistry } from "../src/registry.ts";
import { createRegistryPool } from "../src/registry-pool.ts";
import { parseSpec } from "../src/spec.ts";
import type { Manifest, Packument } from "../src/types.ts";

const manifest = (version: string): Manifest => ({
  name: "foo",
  version,
  dist: { tarball: `http://x.test/foo-${version}.tgz`, integrity: "sha512-x" },
});

function packument(...versions: string[]): Packument {
  return {
    name: "foo",
    "dist-tags": { latest: versions.at(-1)! },
    versions: Object.fromEntries(versions.map((v) => [v, manifest(v)])),
    // Untouched since any cutoff: no publish dates are read.
    modified: "2020-01-01T00:00:00.000Z",
  };
}

const DAY = 86_400_000;

let dir: string;
let server: Server;
let doc: Packument;
let control: string;
/** The `age` header a CDN in front of the registry would add, if any. */
let age: string | undefined;
/** Each request, as `status url`. */
let log: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-metadata-"));
  doc = packument("1.0.0");
  control = "public, max-age=0";
  age = undefined;
  log = [];
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const body = url === "/foo" ? JSON.stringify(doc) : undefined;
    const etag = body && `"${body.length}-${doc["dist-tags"]!.latest}"`;
    const status = !body ? 404 : request.headers["if-none-match"] === etag ? 304 : 200;
    log.push(`${status} ${url}`);
    const headers = {
      "content-type": "application/json",
      "cache-control": control,
      ...(age && { age }),
    };
    response.writeHead(status, etag ? { ...headers, etag } : headers);
    response.end(status === 200 ? body : undefined);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** One run's registry: a new client over the same kept documents. */
function run(mode: CacheMode, options: RegistryOptions = {}) {
  const cache = createDocumentCache({ dir: join(dir, "metadata"), mode });
  return createRegistry({ registry: base(), cache, ...options });
}

const pick = async (mode: CacheMode, spec: string, options?: RegistryOptions) =>
  (await run(mode, options).pick!(parseSpec(spec))).version;

/** Where the abbreviated `foo` is kept. */
const corgiFile = () => join(dir, "metadata", `127.0.0.1+${new URL(base()).port}`, "foo", "_corgi");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Say a kept document's copy was current at `at`, as a run then would have kept it. */
async function backdate(file: string, at: number) {
  const bytes = await readFile(file);
  const end = bytes.indexOf(10);
  const head = { ...JSON.parse(bytes.subarray(0, end).toString()), at };
  await writeFile(file, Buffer.concat([Buffer.from(JSON.stringify(head)), bytes.subarray(end)]));
}

describe("kept registry documents", () => {
  it("revalidates a stale document with its ETag, and asks nothing while it is fresh", async () => {
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0");
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0");
    expect(log).toEqual(["200 /foo", "304 /foo"]);

    control = "max-age=300";
    doc = packument("1.0.0", "1.1.0");
    expect(await pick("revalidate", "foo@^1")).toBe("1.1.0"); // changed: a 200, kept anew
    expect(await pick("revalidate", "foo@^1")).toBe("1.1.0"); // fresh: not asked
    expect(log).toEqual(["200 /foo", "304 /foo", "200 /foo"]);
  });

  it("prefers a kept document, asking once when it cannot satisfy the spec", async () => {
    expect(await pick("prefer", "foo@^1")).toBe("1.0.0");
    doc = packument("1.0.0", "2.0.0");
    expect(await pick("prefer", "foo@^1")).toBe("1.0.0"); // stale, but satisfies: not asked
    expect(log).toEqual(["200 /foo"]);
    expect(await pick("prefer", "foo@^2")).toBe("2.0.0");
    expect(log).toEqual(["200 /foo", "200 /foo"]);
  });

  it("picks from kept documents alone offline, and fails what they cannot answer", async () => {
    await pick("revalidate", "foo@^1");
    expect(await pick("only", "foo@^1")).toBe("1.0.0");
    expect(await pick("only", "foo@1.0.0")).toBe("1.0.0");
    await expect(pick("only", "foo@^2")).rejects.toMatchObject({ code: "EOFFLINE" });
    await expect(pick("only", "bar@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
    // Another registry's documents are other documents.
    await expect(pick("only", "foo@^1", { registry: "http://127.0.0.1:9" })).rejects.toMatchObject({
      code: "EOFFLINE",
    });
    expect(log).toEqual(["200 /foo"]);
  });

  it("asks once when a document still fresh lacks what is picked", async () => {
    control = "max-age=300";
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0");
    doc = packument("1.0.0", "2.0.0");
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0"); // fresh: not asked
    expect(await pick("revalidate", "foo@^2")).toBe("2.0.0");
    expect(log).toEqual(["200 /foo", "200 /foo"]);
  });

  it("trusts a document read since the release cutoff, as pnpm does", async () => {
    const before = Date.now() - DAY;
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0");
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0");
    expect(log).toEqual(["200 /foo"]); // max-age=0, but nothing newer could be picked
    // Read before the cutoff, or for a name the cutoff skips, it is asked about.
    expect(await pick("revalidate", "foo@^1", { before, exclude: ["foo"] })).toBe("1.0.0");
    await backdate(corgiFile(), before - DAY);
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0");
    expect(log).toEqual(["200 /foo", "304 /foo", "304 /foo"]);
    // A version too young to pick is not missed; a pin, which the cutoff never filters, asks once.
    doc = packument("1.0.0", "1.1.0");
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0");
    const pinned = await run("revalidate", { before }).pick!(parseSpec("foo@1.1.0"), "1.1.0");
    expect(pinned.version).toBe("1.1.0");
    expect(log).toEqual(["200 /foo", "304 /foo", "304 /foo", "404 /foo/1.1.0", "200 /foo"]);
  });

  it("dates a document by when the registry's copy was current, not by its file", async () => {
    control = "max-age=300";
    age = "200";
    await pick("revalidate", "foo@^1");
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const kept = () => cache.get(`corgi ${base()}/foo`)!;
    expect(Date.now() - kept().at).toBeGreaterThanOrEqual(200_000);
    // A copied store's files are all new; their heads still say how old each document is.
    await backdate(corgiFile(), Date.now() - 400_000);
    await utimes(corgiFile(), new Date(), new Date());
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0");
    expect(log).toEqual(["200 /foo", "304 /foo"]);
    // A 304 rewrites the date where it is, and nothing else.
    expect(Date.now() - kept().at).toBeLessThan(250_000);
    expect(JSON.parse(new TextDecoder().decode(kept().bytes))).toEqual(doc);
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0"); // fresh again: not asked
    expect(log).toEqual(["200 /foo", "304 /foo"]);
  });

  it("asks for publish dates again when the kept ones miss a version", async () => {
    const before = Date.now() - DAY;
    const old = new Date(before - DAY).toISOString();
    const young = new Date(Date.now() - DAY / 12).toISOString();
    const dated = (...times: [string, string][]): Packument => ({
      ...packument(...times.map(([version]) => version)),
      modified: times.at(-1)![1],
      time: Object.fromEntries(times),
    });
    // Kept by earlier runs: the abbreviated document before the cutoff, the full one since.
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    cache.set(`corgi ${base()}/foo`, encode(dated(["1.0.0", old])), before - DAY);
    cache.set(`full ${base()}/foo`, encode(dated(["1.0.0", old])), Date.now());
    doc = dated(["1.0.0", old], ["1.1.0", young]);
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0"); // 1.1.0 is too young
    expect(log).toEqual(["200 /foo", "200 /foo"]);
    // Offline, a version the kept dates miss is too young too.
    cache.set(`full ${base()}/foo`, encode(dated(["1.0.0", old])), Date.now());
    expect(await pick("only", "foo@^1", { before })).toBe("1.0.0");
  });

  it("revalidates for a tag written out, unless told to prefer what is kept", async () => {
    const before = Date.now() - DAY;
    control = "max-age=300";
    expect(await pick("revalidate", "foo@^1", { before })).toBe("1.0.0");
    doc = packument("1.0.0", "1.1.0");
    expect(await pick("revalidate", "foo", { before })).toBe("1.0.0"); // a bare name: kept
    expect(await pick("prefer", "foo@latest", { before })).toBe("1.0.0");
    expect(log).toEqual(["200 /foo"]);
    // Asked, though fresh and read since the cutoff.
    expect(await pick("revalidate", "foo@latest", { before })).toBe("1.1.0");
    expect(log).toEqual(["200 /foo", "200 /foo"]);
  });

  it("answers for the abbreviated document from a kept full one", async () => {
    const full = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    full.set(`full ${base()}/foo`, encode(doc), Date.now(), undefined, 300);
    expect(await pick("only", "foo@^1")).toBe("1.0.0");
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.0"); // fresh
    expect(log).toEqual([]);
  });

  it("keeps a full packument cut to what is read of it", async () => {
    doc = { ...packument("1.0.0"), readme: "x".repeat(1000) } as Packument;
    doc.versions["1.0.0"] = { ...manifest("1.0.0"), scripts: { test: "x" } } as Manifest;
    expect((await run("revalidate").manifest("foo", "1.0.0")).version).toBe("1.0.0");
    expect(log).toEqual(["404 /foo/1.0.0", "200 /foo"]);
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const kept = JSON.parse(new TextDecoder().decode(cache.get(`full ${base()}/foo`)!.bytes));
    expect(kept).toEqual(packument("1.0.0"));
  });

  it("keeps the document as sent, uncompressed, at a path read off its url", async () => {
    await pick("revalidate", "foo@^1");
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const kept = cache.get(`corgi ${base()}/foo`)!;
    expect(JSON.parse(new TextDecoder().decode(kept.bytes))).toEqual(doc);
    const bytes = await readFile(corgiFile());
    const end = bytes.indexOf(10);
    const body = bytes.subarray(end + 1);
    expect(JSON.parse(bytes.subarray(0, end).toString())).toEqual({
      at: expect.any(Number),
      key: `corgi ${base()}/foo`,
      etag: expect.any(String),
      maxAge: 0,
      index: indexVersions(body),
    });
    expect(JSON.parse(body.toString())).toEqual(doc);
  });

  it("reads only the versions a pick wants, where the head says they are", async () => {
    doc = packument("1.0.0", "1.1.0", "2.0.0");
    await pick("revalidate", "foo@^1");
    // Every other version made unreadable, byte for byte in place: none of them is parsed.
    const bytes = await readFile(corgiFile());
    const end = bytes.indexOf(10);
    const { index } = JSON.parse(bytes.subarray(0, end).toString());
    for (let i = 0; i < index.length; i += 3) {
      if (index[i] === "1.1.0") continue;
      bytes.fill(0x20, end + 1 + index[i + 1] + 1, end + 1 + index[i + 2] - 1);
      bytes[end + 1 + index[i + 1] + 1] = 0x21;
    }
    await writeFile(corgiFile(), bytes);
    expect(await pick("only", "foo@^1")).toBe("1.1.0");
    expect(await pick("only", "foo@~1.1")).toBe("1.1.0");
    // The whole parse, which a range nothing satisfies needs for its error, finds the damage.
    await expect(pick("only", "foo@^3")).rejects.toMatchObject({ code: "EJSONPARSE" });
    // A damaged version the pick wants is an error, never the next one down.
    await expect(pick("only", "foo@^2")).rejects.toMatchObject({ code: "EJSONPARSE" });
    await expect(pick("only", "foo@*")).rejects.toMatchObject({ code: "EJSONPARSE" });
    // So is a pin, read off a peek the registry answers with a 304.
    const pinned = run("revalidate").pick!(parseSpec("foo@2.0.0"), "2.0.0");
    await expect(pinned).rejects.toMatchObject({ code: "EJSONPARSE" });
    expect(log.slice(1)).toEqual(["404 /foo/2.0.0", "304 /foo"]);
  });

  it("reads a document kept before heads had an index, and gives it one on a 304", async () => {
    doc = packument("1.0.0", "1.1.0");
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    cache.set(`corgi ${base()}/foo`, encode(doc), Date.now() - DAY, '"x"');
    const bytes = await readFile(corgiFile());
    const end = bytes.indexOf(10);
    const { index: _, ...old } = JSON.parse(bytes.subarray(0, end).toString());
    await writeFile(corgiFile(), `${JSON.stringify(old)}\n${JSON.stringify(doc)}`);
    expect(cache.get(`corgi ${base()}/foo`)!.index).toBeUndefined();
    expect(await pick("only", "foo@^1")).toBe("1.1.0");
    // The registry says it has not changed: the document is written again, with an index.
    const etag = `"${JSON.stringify(doc).length}-1.1.0"`;
    await writeFile(corgiFile(), `${JSON.stringify({ ...old, etag })}\n${JSON.stringify(doc)}`);
    expect(await pick("revalidate", "foo@^1")).toBe("1.1.0");
    expect(log).toEqual(["304 /foo"]);
    const kept = cache.get(`corgi ${base()}/foo`)!;
    expect(kept.index).toEqual(indexVersions(kept.bytes));
    expect(Date.now() - kept.at).toBeLessThan(DAY / 2);
    expect(kept.etag).toBe(etag);
  });

  it("rewrites the date in place when the head is longer than what it reads", async () => {
    doc = packument(...Array.from({ length: 300 }, (_, i) => `1.0.${i}`));
    await pick("revalidate", "foo@^1");
    const before = await readFile(corgiFile());
    expect(before.indexOf(10)).toBeGreaterThan(4096);
    await backdate(corgiFile(), Date.now() - DAY);
    expect(await pick("revalidate", "foo@^1")).toBe("1.0.299");
    expect(log).toEqual(["200 /foo", "304 /foo"]);
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const kept = cache.get(`corgi ${base()}/foo`)!;
    expect(Date.now() - kept.at).toBeLessThan(60_000);
    expect(kept.index).toEqual(indexVersions(kept.bytes));
    // A head that is not the one `set` writes is left alone.
    await writeFile(corgiFile(), `{"key":"corgi ${base()}/foo","at":${Date.now() - DAY}}\n{}`);
    cache.touch(`corgi ${base()}/foo`, Date.now());
    expect(Date.now() - cache.get(`corgi ${base()}/foo`)!.at).toBeGreaterThan(DAY / 2);
  });

  it("parses the document whole when its index does not fit it", async () => {
    doc = packument("1.0.0", "1.1.0");
    await pick("revalidate", "foo@^1");
    const bytes = await readFile(corgiFile());
    const end = bytes.indexOf(10);
    const head = JSON.parse(bytes.subarray(0, end).toString());
    for (const index of [[0, 1, 2], ["1.1.0", 0, 5, "1.0.0", 3, 9], ["1.1.0", "x", null], "no"]) {
      const body = bytes.subarray(end + 1);
      await writeFile(
        corgiFile(),
        Buffer.concat([Buffer.from(JSON.stringify({ ...head, index }) + "\n"), body]),
      );
      expect(await pick("only", "foo@^1")).toBe("1.1.0");
      expect(await pick("only", "foo@1.0.0")).toBe("1.0.0");
    }
  });

  it("answers a pinned version from its kept route, asking nothing", async () => {
    // A scoped document past the peek's cutoff is never kept; the version's route is.
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const scoped = { ...manifest("1.0.0"), name: "@s/foo" };
    cache.set(`full ${base()}/@s%2ffoo/1.0.0`, encode(scoped), Date.now());
    const found = await run("prefer").pick!(parseSpec("@s/foo@1.0.0"), "1.0.0");
    expect(found).toEqual(scoped);
    expect(log).toEqual([]);
  });

  it("keeps a url it cannot spell as a path under its hash", async () => {
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    for (const url of ["http://x.test/%7Efoo", "http://x.test/a/../foo", "http://[::1]:8/foo"]) {
      cache.set(`corgi ${url}`, encode(doc), Date.now());
      expect(new TextDecoder().decode(cache.get(`corgi ${url}`)!.bytes)).toBe(JSON.stringify(doc));
    }
    expect((await readdir(join(dir, "metadata"))).sort()).toEqual(["_", "x.test"]);
  });

  it("keeps nothing the registry says not to store, nor what is not a document", async () => {
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    cache.set("corgi http://x.test/foo", new TextEncoder().encode("<html>portal</html>"), 0);
    expect(cache.get("corgi http://x.test/foo")).toBeUndefined();
    control = "no-store";
    await pick("revalidate", "foo@^1");
    await expect(pick("only", "foo@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("takes a torn or foreign file as a miss", async () => {
    await pick("revalidate", "foo@^1");
    await writeFile(corgiFile(), "not a head");
    await expect(pick("only", "foo@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
    await writeFile(corgiFile(), '{"key":"corgi http://other"}\n{}');
    await expect(pick("only", "foo@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("is kept by the registry threads too", async () => {
    const metadata = { dir: join(dir, "metadata"), mode: "revalidate" as const };
    const pool = createRegistryPool({ registry: base(), metadata, size: 1, startAt: 0 });
    try {
      expect((await pool.pick!(parseSpec("foo@^1"))).version).toBe("1.0.0");
    } finally {
      pool.close();
    }
    expect(await pick("only", "foo@^1")).toBe("1.0.0");
  });

  it("lives in the store", () => {
    expect(metadataDir(join("/home", ".upm", "store"))).toBe(
      join("/home", ".upm", "store", "metadata"),
    );
  });
});

describe("a big document, read in parts", () => {
  /**
   * Past the size read whole: `1.0.0` to `1.299.9`, with a head past the first read. With
   * `few`, `1.0.0` to `1.29.9` and a short head, as most big documents have.
   */
  function big(pad = "x", few = false): Packument {
    const count = few ? 300 : 3000;
    const versions = Array.from({ length: count }, (_, i) => `1.${Math.floor(i / 10)}.${i % 10}`);
    const out = packument(...versions, "2.0.0-rc.1");
    for (const v of versions) {
      out.versions[v] = { ...manifest(v), description: pad.repeat(few ? 1000 : 100) } as Manifest;
    }
    out["dist-tags"] = { latest: versions.at(-1)!, next: "2.0.0-rc.1" };
    return out;
  }
  const key = () => `corgi ${base()}/foo`;
  const cache = () => createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
  const version = async (registry: ReturnType<typeof run>, raw: string) =>
    (await registry.pick!(parseSpec(raw))) as Manifest & { description?: string };

  beforeEach(async () => {
    doc = big();
    await pick("revalidate", "foo@^1");
  });

  it("reads the head and tail, and the rest only where asked", async () => {
    const file = await readFile(corgiFile());
    const end = file.indexOf(10);
    expect(end).toBeGreaterThan(64 * 1024);
    const body = file.subarray(end + 1);
    const kept = cache().get(key())!;
    const n = body.length;
    expect(kept.size).toBe(n);
    for (const [a, b] of [
      [0, 10],
      [0, 200_000],
      [n - 96, n],
      [n - 5, n + 10],
      [5000, 300_000],
      [n, n + 1],
    ] as const) {
      expect(Buffer.from(kept.read!(a, b)!).equals(body.subarray(a, b)), `${a}-${b}`).toBe(true);
    }
    expect(Buffer.from(kept.bytes).equals(body)).toBe(true);
  });

  it.each([false, true])("picks what the whole document picks (short head: %s)", async (few) => {
    if (few) {
      doc = big("x", few);
      cache().set(key(), encode(doc), Date.now(), undefined, 300, indexVersions(encode(doc)));
      const file = await readFile(corgiFile());
      expect(file.indexOf(10)).toBeLessThan(16 * 1024);
      expect(file.length).toBeGreaterThan(256 * 1024);
    }
    const parts = cache();
    // The same documents, handed over whole.
    const whole = createRegistry({
      registry: base(),
      cache: {
        mode: "only",
        get: (at) => {
          const kept = parts.get(at);
          return kept && { bytes: kept.bytes, at: kept.at, etag: kept.etag, index: kept.index };
        },
        set() {},
        touch() {},
      },
    });
    const before = Date.now() - DAY;
    for (const raw of ["foo@^1", "foo@~1.25", "foo@1.2.3", "foo@latest", "foo@next", "foo@<1.1"]) {
      const spec = parseSpec(raw);
      expect(await run("only").pick!(spec)).toEqual(await whole.pick!(spec));
      expect(await run("only", { before }).pick!(spec)).toEqual(await whole.pick!(spec));
      expect(await run("only").pick!(spec, "1.25.3")).toEqual(await whole.pick!(spec, "1.25.3"));
    }
    expect(log).toEqual(["200 /foo"]);
  });

  it("takes a slice that is not the version asked for from the whole document", async () => {
    const parts = cache();
    const kept = parts.get(key())!;
    const offset = (v: string) => kept.index!.indexOf(v) + 1;
    const [from, to] = [kept.index![offset("1.250.2")], kept.index![offset("1.250.2") + 1]];
    // Where 1.250.3 was, a file replaced since has 1.250.2: the same size, the same inode.
    const shifted = createRegistry({
      registry: base(),
      cache: {
        mode: "only",
        get: (url) => {
          const found = parts.get(url)!;
          const read = found.read!;
          const moved = (a: number, b: number) =>
            a === kept.index![offset("1.250.3")] ? read(from as number, to as number) : read(a, b);
          return Object.assign(found, { read: moved });
        },
        set() {},
        touch() {},
      },
    });
    expect((await shifted.pick!(parseSpec("foo@1.250.3"), "1.250.3")).version).toBe("1.250.3");
  });

  it("reads on from the file a 304 rewrote with an index", async () => {
    const file = await readFile(corgiFile());
    const end = file.indexOf(10);
    const { index: _, ...old } = JSON.parse(file.subarray(0, end).toString());
    const body = file.subarray(end);
    await writeFile(corgiFile(), Buffer.concat([Buffer.from(JSON.stringify(old)), body]));
    await backdate(corgiFile(), Date.now() - DAY);
    const registry = run("revalidate");
    expect((await version(registry, "foo@~1.250")).version).toBe("1.250.9");
    expect((await version(registry, "foo@~1.260")).version).toBe("1.260.9");
    expect(log).toEqual(["200 /foo", "304 /foo"]);
    expect(cache().get(key())!.index).toEqual(indexVersions(file.subarray(end + 1)));
  });

  it("reads publish dates off the start of a big full document", async () => {
    const before = Date.now() - DAY;
    const old = new Date(before - DAY).toISOString();
    const young = new Date(Date.now() - DAY / 12).toISOString();
    const dated = big();
    dated.time = Object.fromEntries(Object.keys(dated.versions).map((v) => [v, old]));
    dated.time["1.299.9"] = young;
    dated.modified = young;
    const parts = cache();
    parts.set(key(), encode(dated), Date.now(), undefined, 300, indexVersions(encode(dated)));
    parts.set(`full ${base()}/foo`, encode(dated), Date.now());
    expect((await parts.get(`full ${base()}/foo`)!.read!(0, 10))!.length).toBe(10);
    // `latest` is too young: it moves down, and so does a range it tops.
    expect((await version(run("only", { before }), "foo@latest")).version).toBe("1.299.8");
    expect((await version(run("only", { before }), "foo@^1")).version).toBe("1.299.8");
    expect(log).toEqual(["200 /foo"]);
  });

  it("reads a document replaced since its head afresh, never at the old offsets", async () => {
    const registry = run("only");
    expect((await version(registry, "foo@^1")).description).toMatch(/^x/);
    // Another run keeps a new copy meanwhile: another file, its versions elsewhere.
    const next = big("yz");
    cache().set(key(), encode(next), Date.now(), undefined, 300, indexVersions(encode(next)));
    const found = await version(registry, "foo@~1.250");
    expect(found).toMatchObject({ version: "1.250.9", description: "yz".repeat(100) });
    // What the first read holds is still the old file's.
    const kept = cache().get(key())!;
    await writeFile(corgiFile(), "gone");
    expect(kept.read!(0, 10)).toBeDefined();
    expect(kept.read!(400_000, 400_010)).toBeUndefined();
    expect(() => kept.bytes).toThrow(expect.objectContaining({ code: "ECHANGED" }));
  });

  it("asks the registry for a document removed while it is read, unless offline", async () => {
    const offline = run("only");
    const prefer = run("prefer");
    expect((await version(offline, "foo@^1")).version).toBe("1.299.9");
    expect((await version(prefer, "foo@^1")).version).toBe("1.299.9");
    await rm(corgiFile());
    await expect(version(offline, "foo@~1.250")).rejects.toMatchObject({ code: "EOFFLINE" });
    expect((await version(prefer, "foo@~1.250")).version).toBe("1.250.9");
    expect(log).toEqual(["200 /foo", "200 /foo"]);
  });
});

describe("trimPackument", () => {
  const entry = (version: string, extra: object = {}) => ({ ...manifest(version), ...extra });
  const tags = { latest: "2.0.0" };
  const bytes = (value: unknown, space?: number) =>
    new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value, null, space),
    );
  const full = {
    _id: "foo",
    name: "foo",
    "dist-tags": tags,
    versions: {
      "1.0.0": entry("1.0.0", {
        readme: 'a "quoted" \\ readme}{',
        scripts: { test: "vitest" },
        libc: ["glibc"],
        bin: "cli.js",
        maintainers: [{ name: "x" }],
      }),
      "2.0.0": entry("2.0.0", { deprecated: "old", _npmUser: { name: "y" } }),
    },
    time: { "1.0.0": "2025-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" },
    readme: "x".repeat(1000),
    maintainers: [],
    modified: "2026-01-01T00:00:00.000Z",
  };
  const trim = (value: unknown, space?: number) =>
    JSON.parse(new TextDecoder().decode(trimPackument(bytes(value, space))));

  it("keeps what the resolver reads, `modified` last, however the document is spaced", () => {
    const expected = {
      name: "foo",
      "dist-tags": tags,
      time: full.time,
      versions: {
        "1.0.0": entry("1.0.0", { libc: ["glibc"], bin: "cli.js" }),
        "2.0.0": entry("2.0.0", { deprecated: "old" }),
      },
      modified: full.modified,
    };
    for (const space of [undefined, 2]) {
      const trimmed = trim(full, space);
      expect(trimmed).toEqual(expected);
      expect(Object.keys(trimmed).at(-1)).toBe("modified");
    }
    const kept = trimPackument(bytes(full))!;
    expect(pluckModified(kept)).toBe(full.modified);
    const [version, start, end] = indexVersions(kept)!;
    expect(version).toBe("1.0.0");
    expect(parseSlice(kept, start as number, end as number)).toEqual(expected.versions["1.0.0"]);
    expect(pluckTimes(kept)).toEqual(full.time);
  });

  it("finds the end of long strings with escapes wherever they fall", () => {
    // Past 256 bytes a string's end is found by native search: escapes around the switch.
    for (let at = 245; at < 270; at++) {
      for (const escaped of ['"', "\\", '\\"', "\\\\"]) {
        const readme = `${"x".repeat(at)}${escaped}"}{${"y".repeat(300)}${escaped}`;
        const versions = { "1.0.0": { ...entry("1.0.0"), readme } };
        expect(trim({ ...full, versions }).versions).toEqual({ "1.0.0": entry("1.0.0") });
      }
    }
  });

  it("keeps nothing it cannot read as a packument", () => {
    expect(trimPackument(bytes(entry("1.0.0")))).toBeUndefined(); // a version's route
    // One whose package.json has fields called `versions` and `dist-tags`, all the same.
    const odd = entry("1.0.0", { versions: {}, "dist-tags": {} });
    expect(trimPackument(bytes(odd))).toBeUndefined();
    expect(trimPackument(bytes('{"versions":{"1.0.0":{"name":"foo"'))).toBeUndefined();
    expect(trimPackument(bytes('{"versions":[]}'))).toBeUndefined();
    expect(trimPackument(bytes("<html></html>"))).toBeUndefined();
    expect(trimPackument(bytes({ name: "foo", versions: {} }))).toBeUndefined(); // no tags
    const empty = { name: "foo", "dist-tags": {}, versions: {} };
    expect(trim(empty)).toEqual(empty);
  });
});
