// Registry documents kept on disk: revalidated, preferred, or the only source offline.
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentCache, metadataDir } from "../src/metadata.ts";
import type { CacheMode } from "../src/registry.ts";
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
  };
}

let dir: string;
let server: Server;
let doc: Packument;
let control: string;
/** Each request, as `status url`. */
let log: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-metadata-"));
  doc = packument("1.0.0");
  control = "public, max-age=0";
  log = [];
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const body = url === "/foo" ? JSON.stringify(doc) : undefined;
    const etag = body && `"${body.length}-${doc["dist-tags"]!.latest}"`;
    const status = !body ? 404 : request.headers["if-none-match"] === etag ? 304 : 200;
    log.push(`${status} ${url}`);
    const headers = { "content-type": "application/json", "cache-control": control };
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
function run(mode: CacheMode, registry = base()) {
  const cache = createDocumentCache({ dir: join(dir, "metadata"), mode });
  return createRegistry({ registry, cache });
}

const pick = async (mode: CacheMode, spec: string, registry?: string) =>
  (await run(mode, registry).pick!(parseSpec(spec))).version;

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
    await expect(pick("only", "foo@^1", "http://127.0.0.1:9")).rejects.toMatchObject({
      code: "EOFFLINE",
    });
    expect(log).toEqual(["200 /foo"]);
  });

  it("keeps the document as sent, compressed with zstd, and reads gzip too", async () => {
    await pick("revalidate", "foo@^1");
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    const read = () =>
      JSON.parse(new TextDecoder().decode(cache.get(`corgi ${base()}/foo`)!.bytes));
    expect(read()).toEqual(doc);
    const [shard] = await readdir(join(dir, "metadata"));
    const file = join(dir, "metadata", shard!, (await readdir(join(dir, "metadata", shard!)))[0]!);
    const bytes = await readFile(file);
    const end = bytes.indexOf(10);
    const head = JSON.parse(bytes.subarray(0, end).toString());
    expect(head.codec).toBe("zstd");
    // Where Node has no zstd, the file is gzip and says so.
    const body = gzipSync(zstdDecompressSync(bytes.subarray(end + 1)));
    await writeFile(
      file,
      Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, codec: "gzip" })}\n`), body]),
    );
    expect(read()).toEqual(doc);
  });

  it("keeps nothing the registry says not to store, nor what is not a document", async () => {
    const cache = createDocumentCache({ dir: join(dir, "metadata"), mode: "only" });
    cache.set("corgi http://x.test/foo", new TextEncoder().encode("<html>portal</html>"));
    expect(cache.get("corgi http://x.test/foo")).toBeUndefined();
    control = "no-store";
    await pick("revalidate", "foo@^1");
    await expect(pick("only", "foo@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("takes a torn or foreign file as a miss", async () => {
    await pick("revalidate", "foo@^1");
    const cacheDir = join(dir, "metadata");
    const [shard] = await readdir(cacheDir);
    const [file] = await readdir(join(cacheDir, shard!));
    await writeFile(join(cacheDir, shard!, file!), "not a head");
    await expect(pick("only", "foo@^1")).rejects.toMatchObject({ code: "EOFFLINE" });
    await writeFile(join(cacheDir, shard!, file!), '{"key":"corgi http://other"}\n{}');
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
