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
import { pluckModified, pluckTimes, pluckVersion } from "../src/pluck.ts";
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
    expect(JSON.parse(bytes.subarray(0, end).toString())).toEqual({
      at: expect.any(Number),
      key: `corgi ${base()}/foo`,
      etag: expect.any(String),
      maxAge: 0,
    });
    expect(JSON.parse(bytes.subarray(end + 1).toString())).toEqual(doc);
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
    expect(pluckVersion(kept, "1.0.0")).toEqual(expected.versions["1.0.0"]);
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
