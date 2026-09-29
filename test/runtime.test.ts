// The web branches. Everything else in the suite runs the Node branches by being on Node.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Packument } from "../src/types.ts";

/** A fresh copy of a module, loaded while `globals` are stubbed and the stubs undone right after. */
async function loadWithout<T>(globals: string[], path: string): Promise<T> {
  vi.resetModules();
  for (const name of globals) vi.stubGlobal(name, undefined);
  try {
    return (await import(path)) as T;
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runtime without Buffer", () => {
  type Runtime = typeof import("../src/runtime.ts");
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([255, 254, 253, 252]),
  ];

  it("concat matches Buffer.concat, including a short total", async () => {
    const { concat } = await loadWithout<Runtime>(["Buffer"], "../src/runtime.ts");
    const parts = [new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3, 4, 5])];
    expect([...concat(parts)]).toEqual([1, 2, 3, 4, 5]);
    expect(Buffer.from(concat(parts, 3))).toEqual(Buffer.concat(parts, 3));
    expect(Buffer.from(concat(parts, 7))).toEqual(Buffer.concat(parts, 7));
    expect(concat([]).length).toBe(0);
    // Always a copy, so a caller may transfer the result.
    expect(concat([parts[0]!]).buffer).not.toBe(parts[0]!.buffer);
  });

  it("base64 and hex round-trip the way Buffer does", async () => {
    const { toBase64, fromBase64, fromHex } = await loadWithout<Runtime>(
      ["Buffer"],
      "../src/runtime.ts",
    );
    for (const bytes of cases) {
      const b64 = Buffer.from(bytes).toString("base64");
      expect(toBase64(bytes)).toBe(b64);
      expect([...fromBase64(b64)]).toEqual([...bytes]);
      expect([...fromBase64(b64.replaceAll("=", ""))]).toEqual([...bytes]); // unpadded
      expect([...fromHex(Buffer.from(bytes).toString("hex"))]).toEqual([...bytes]);
    }
    // A subarray encodes its own bytes, not its backing buffer's.
    expect(toBase64(new Uint8Array([9, 1, 2, 9]).subarray(1, 3))).toBe("AQI=");
  });

  it("base64url is one string with and without Buffer, and one-shot hash is createHash", async () => {
    const web = await loadWithout<Runtime>(["Buffer"], "../src/runtime.ts");
    const node = await import("../src/runtime.ts");
    // Store keys and state hashes are 16 bytes of this: a changed output orphans every store.
    const vectors = [
      ...cases,
      new Uint8Array([0xfb, 0xff, 0xbf]), // "+/+/" in plain base64
      new Uint8Array(16).fill(0xfe), // two padding chars to drop
      new Uint8Array(32).fill(0x3f), // one
    ];
    for (const bytes of vectors) {
      const expected = Buffer.from(bytes)
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      expect(node.toBase64Url(bytes)).toBe(expected);
      expect(web.toBase64Url(bytes)).toBe(expected);
    }
    expect(node.toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(node.toBase64Url(new Uint8Array([9, 1, 2, 9]).subarray(1, 3))).toBe("AQI");

    const data = Buffer.from("the quick brown fox");
    for (const algorithm of ["sha1", "sha256", "sha384", "sha512"] as const) {
      expect(Buffer.from(await node.digest(algorithm, data))).toEqual(
        createHash(algorithm).update(data).digest(),
      );
    }
  });

  it("sleep and cpus work off the globals", async () => {
    const { sleep, cpus, hasNode } = await import("../src/runtime.ts");
    expect(hasNode).toBe(true);
    expect(cpus()).toBeGreaterThan(0);
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("without Node", () => {
  /** `process` with some properties hidden: `getBuiltinModule` is what `hasNode` reads. */
  const bare = (hidden = ["getBuiltinModule"]) =>
    Object.create(
      process,
      Object.fromEntries(hidden.map((name) => [name, { value: undefined }])),
    ) as typeof process;

  it("hasNode is false", async () => {
    vi.resetModules();
    vi.stubGlobal("process", bare());
    try {
      expect((await import("../src/runtime.ts")).hasNode).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("extractTar gunzips through DecompressionStream", async () => {
    vi.resetModules();
    vi.stubGlobal("process", bare());
    let extractTar: typeof import("../src/tar.ts").extractTar;
    try {
      ({ extractTar } = await import("../src/tar.ts"));
    } finally {
      vi.unstubAllGlobals();
    }
    // Prove the route. (Node's DecompressionStream wraps zlib itself, so only this spy can.)
    const inflate = vi.spyOn(globalThis, "DecompressionStream");
    const header = Buffer.alloc(512);
    header.write("package/a.js", 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("00000000002\0", 124, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const tarball = gzipSync(Buffer.concat([header, Buffer.from("hi"), Buffer.alloc(512 + 1024)]));
    const entries = [];
    async function* chunks() {
      yield tarball.subarray(0, 1);
      yield tarball.subarray(1);
    }
    for await (const entry of extractTar(chunks())) entries.push(entry);
    expect(entries.map((e) => [e.path, new TextDecoder().decode(e.data)])).toEqual([
      ["a.js", "hi"],
    ]);
    expect(inflate).toHaveBeenCalledTimes(1);

    // A corrupt stream is one EBADTAR, not a bare TypeError with an empty message.
    async function* corrupt() {
      yield Buffer.concat([tarball.subarray(0, 10), Buffer.from("garbage garbage garbage")]);
    }
    const collect = async () => {
      for await (const _ of extractTar(corrupt())) {
        // drain
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: "EBADTAR", message: /Corrupt gzip/ });
  });

  it("digests through WebCrypto, byte for byte what createHash gives", async () => {
    vi.resetModules();
    vi.stubGlobal("process", bare());
    let web: typeof import("../src/runtime.ts");
    let integrity: typeof import("../src/integrity.ts");
    try {
      web = await import("../src/runtime.ts");
      integrity = await import("../src/integrity.ts");
    } finally {
      vi.unstubAllGlobals();
    }
    const subtle = vi.spyOn(crypto.subtle, "digest");
    const data = Buffer.from("the quick brown fox");
    for (const algorithm of ["sha1", "sha256", "sha384", "sha512"] as const) {
      const expected = createHash(algorithm).update(data).digest();
      expect(Buffer.from(await web.digest(algorithm, data))).toEqual(expected);
      const hasher = web.createHasher(algorithm);
      hasher.update(data.subarray(0, 7));
      hasher.update(data.subarray(7));
      expect(Buffer.from(await hasher.digest())).toEqual(expected);
      expect(await integrity.hashOf(data, algorithm)).toBe(
        `${algorithm}-${expected.toString("base64")}`,
      );
    }
    expect(subtle).toHaveBeenCalledTimes(12);

    const verifier = integrity.createVerifier(await integrity.hashOf(data));
    verifier.update(data.subarray(0, 3));
    verifier.update(data.subarray(3));
    await expect(verifier.verify()).resolves.toBeUndefined();
    const wrong = integrity.createVerifier(await integrity.hashOf(data));
    wrong.update(Buffer.from("something else"));
    await expect(wrong.verify()).rejects.toMatchObject({ code: "EINTEGRITY" });
  });

  it("a process that hands out fs alone hashes and inflates the web way", async () => {
    // A browser's `process` shim: `getBuiltinModule` is there, Node's crypto and zlib are not.
    // Both are asked for on first use, so the shim stays in place until each has been.
    const shim = Object.create(process, {
      getBuiltinModule: { value: (id: string) => (id === "node:fs" ? fs : undefined) },
    }) as typeof process;
    const node = await import("../src/runtime.ts");
    const expected = await node.shortHash("key");
    vi.resetModules();
    const subtle = vi.spyOn(crypto.subtle, "digest");
    const inflate = vi.spyOn(globalThis, "DecompressionStream");
    vi.stubGlobal("process", shim);
    try {
      const web = await import("../src/runtime.ts");
      const { extractTar } = await import("../src/tar.ts");
      expect(web.hasNode).toBe(true);
      const data = Buffer.from("the quick brown fox");
      expect(Buffer.from(await web.digest("sha512", data))).toEqual(
        createHash("sha512").update(data).digest(),
      );
      const hasher = web.createHasher("sha1");
      hasher.update(data);
      expect(Buffer.from(await hasher.digest())).toEqual(createHash("sha1").update(data).digest());
      expect(await web.shortHash("key")).toBe(expected);
      expect(subtle).toHaveBeenCalledTimes(3);

      // One small block: where Node would take the one-shot gunzipSync.
      const entries = [];
      for await (const entry of extractTar(once(tarOf("a.js", "hi")))) entries.push(entry.path);
      expect(entries).toEqual(["a.js"]);
      expect(inflate).toHaveBeenCalledTimes(1);
      expect(web.hasZlib()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Node keeps its own crypto and zlib", async () => {
    const node = await import("../src/runtime.ts");
    const { extractTar } = await import("../src/tar.ts");
    const subtle = vi.spyOn(crypto.subtle, "digest");
    const inflate = vi.spyOn(globalThis, "DecompressionStream");
    await node.digest("sha512", Buffer.from("x"));
    await node.shortHash("x");
    const hasher = node.createHasher("sha256");
    hasher.update(Buffer.from("x"));
    await hasher.digest();
    const big = tarOf("b.js", "x".repeat(4 << 20)); // past the one-shot size: the zlib stream
    for (const tarball of [tarOf("a.js", "hi"), big]) {
      for await (const _ of extractTar(once(tarball))) {
        // drain
      }
    }
    expect(node.hasZlib()).toBe(true);
    expect(subtle).not.toHaveBeenCalled();
    expect(inflate).not.toHaveBeenCalled();
  });

  it("pickManifest accepts every engine when there is no Node version", async () => {
    vi.resetModules();
    vi.stubGlobal("process", bare(["version"]));
    try {
      const { pickManifest } = await import("../src/pick.ts");
      const { parseSpec } = await import("../src/spec.ts");
      const dist = { tarball: "" };
      const packument: Packument = {
        name: "x",
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "1.0.0": { name: "x", version: "1.0.0", dist },
          "2.0.0": { name: "x", version: "2.0.0", engines: { node: ">=999" }, dist },
        },
      };
      expect(pickManifest(packument, parseSpec("x@^1||^2")).version).toBe("2.0.0");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("cpus under a cgroup quota", () => {
  const hardware = 16;
  type Files = Record<string, string>;

  /** `cpus()`, and what both pools make of it, on a Linux box whose cgroup files read `files`. */
  async function on(files: Files) {
    vi.resetModules();
    vi.stubGlobal("navigator", { hardwareConcurrency: hardware });
    vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const text = files[String(file)];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    });
    try {
      const { cpus } = await import("../src/runtime.ts");
      const { defaultPoolSize } = await import("../src/api.ts");
      const { poolSize } = await import("../src/unpack-pool.ts");
      const { fsConcurrency } = await import("../src/limit.ts");
      const cores = cpus();
      // Read once: a second call is the memo.
      const reads = read.mock.calls.length;
      cpus();
      expect(read.mock.calls.length).toBe(reads);
      return { cores, link: defaultPoolSize(cpus()), unpack: poolSize(), fs: fsConcurrency() };
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }

  const v2 = "/sys/fs/cgroup/cpu.max";
  const v1 = "/sys/fs/cgroup/cpu/cpu.cfs_";
  const unlimited = { cores: hardware, link: 8, unpack: 8, fs: 16 };

  it("v2 'max' is unlimited and leaves the benchmark defaults alone", async () => {
    expect(await on({ [v2]: "max 100000\n" })).toEqual(unlimited);
  });

  it("v2 quota caps both pools by the same number, rounded up", async () => {
    expect(await on({ [v2]: "200000 100000\n" })).toEqual({ cores: 2, link: 0, unpack: 1, fs: 4 });
    expect(await on({ [v2]: "250000 100000" })).toEqual({ cores: 3, link: 2, unpack: 2, fs: 4 });
    expect(await on({ [v2]: "50000 100000" })).toEqual({ cores: 1, link: 0, unpack: 1, fs: 4 });
  });

  it("falls back to v1 when there is no cpu.max", async () => {
    expect(await on({ [`${v1}quota_us`]: "-1\n", [`${v1}period_us`]: "100000\n" })).toEqual(
      unlimited,
    );
    expect(await on({ [`${v1}quota_us`]: "400000", [`${v1}period_us`]: "100000" })).toEqual({
      cores: 4,
      link: 3,
      unpack: 3,
      fs: 4,
    });
  });

  it("keeps the hardware count when the files are missing or garbage", async () => {
    expect(await on({})).toEqual(unlimited);
    expect(await on({ [v2]: "" })).toEqual(unlimited);
    expect(await on({ [v2]: "lots" })).toEqual(unlimited);
    expect(await on({ [v2]: "0 0" })).toEqual(unlimited);
    expect(await on({ [`${v1}quota_us`]: "abc", [`${v1}period_us`]: "" })).toEqual(unlimited);
  });

  it("never asks for a file off Linux", async () => {
    vi.resetModules();
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    const read = vi.spyOn(fs, "readFileSync");
    try {
      const { cpus } = await import("../src/runtime.ts");
      expect(cpus()).toBeGreaterThan(0);
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

/** A gzipped tarball of one file. */
function tarOf(path: string, text: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(`package/${path}`, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write(`${Buffer.byteLength(text).toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const body = Buffer.from(text);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}
