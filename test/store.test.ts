import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fromShasum } from "../src/integrity.ts";
import { hashOf } from "./hash.ts";
import { createStore } from "../src/store.ts";
import { indexKey } from "../src/store-backend.ts";
import type { BackendIndex, StoreBackend } from "../src/store-backend.ts";
import { makeTarball } from "./tarball.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createStore", () => {
  it("writes content and an index on the first add", async () => {
    const tarball = makeTarball([
      { path: "b.js", data: "beta" },
      { path: "a.js", data: "alpha" },
    ]);
    const fetch = stubFetch(tarball);
    const store = createStore({ dir, fetch });

    const { index, cached } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(cached).toBe(false);
    expect(fetch.calls).toEqual(["https://reg/p.tgz"]);
    expect(index.files.map((f) => f.path)).toEqual(["a.js", "b.js"]); // sorted
    expect(index.unpackedSize).toBe(9);
    expect(index.integrity).toBe(hashOf(tarball));
    for (const file of index.files) {
      expect(await exists(store.blobPath(file))).toBe(true);
    }
    expect(await store.index(hashOf(tarball))).toEqual(index);
  });

  it("remembers an index size it found, and asks the disk again after a miss", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });
    const integrity = hashOf(tarball);

    expect(store.indexSize(integrity)).toBe(0);
    await store.add("https://reg/p.tgz", integrity);
    const size = store.indexSize(integrity);
    expect(size).toBe((await stat(store.indexPath(integrity))).size);
    // Found once, it is not asked of the disk again, as a read index is not read again.
    await rm(store.indexPath(integrity));
    expect(store.indexSize(integrity)).toBe(size);
    expect(createStore({ dir }).indexSize(integrity)).toBe(0);
  });

  it("holds tarballs against the ceiling and `held`, not against the size of the tree", async () => {
    // A download counts against the ceiling until its last byte, and its bytes against `held`
    // until they are written out as content. Downloading past both would queue whole tarballs
    // in memory behind a busy disk, so what is in hand at once has to track them and nothing
    // else — least of all how many packages were asked for. A `held` of one byte lets no new
    // download start while anything landed waits.
    async function peak(packages: number, ceiling: number): Promise<number> {
      const tarballs: Record<string, Uint8Array> = {};
      for (let i = 0; i < packages; i++) {
        const url = `https://reg/${ceiling}-${packages}-${i}.tgz`;
        tarballs[url] = makeTarball([{ path: "a.js", data: `pkg ${url}` }]);
      }
      let held = 0;
      let most = 0;
      const instant = (async (input: string | URL) => {
        most = Math.max(most, ++held);
        return new Response(tarballs[String(input)] as unknown as BodyInit);
      }) as typeof globalThis.fetch;
      const store = createStore({ dir, fetch: instant, concurrency: ceiling, workers: 0, held: 1 });
      await Promise.all(
        Object.entries(tarballs).map(async ([url, bytes]) => {
          await store.add(url, hashOf(bytes));
          held--;
        }),
      );
      return most;
    }

    // With `held` at one byte, a download starts only once nothing landed waits to be stored,
    // index and all: the slots' worth downloading, and at most as many more landing meanwhile.
    // Bounds, not a comparison of two runs, whose peaks move with the scheduler by one or two.
    for (const [packages, ceiling] of [
      [30, 8],
      [150, 8],
      [150, 4],
    ] as const) {
      expect(await peak(packages, ceiling)).toBeLessThanOrEqual(2 * ceiling);
    }
  });

  it("gives a download's slot back at its last byte, while its tarball waits for a thread", async () => {
    // Held through the unpack, a slot waited on busy threads with nothing on the wire: every
    // tarball here lands while the only thread is still booting, not just the first two.
    const tarballs: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) {
      tarballs[`https://reg/s${i}.tgz`] = makeTarball([{ path: "a.js", data: `pkg ${i}` }]);
    }
    const fetch = stubFetch(tarballs);
    const SLOW = new URL("./slow-worker.ts", import.meta.url);
    const store = createStore({ dir, fetch, concurrency: 2, workers: 1, workerEntry: SLOW });
    let asked = -1;
    await Promise.all(
      Object.entries(tarballs).map(async ([url, bytes]) => {
        await store.add(url, hashOf(bytes));
        if (asked < 0) asked = fetch.calls.length; // when the first one was stored
      }),
    );
    store.close();
    expect(asked).toBe(20);
  });

  it("is a cache hit on the second add, with zero fetch calls", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const integrity = hashOf(tarball);
    const cold = createStore({ dir, fetch: stubFetch(tarball) });
    const first = await cold.add("https://reg/p.tgz", integrity);

    // A fresh store, so nothing is answered from the in-memory memo.
    const fetch = stubFetch(tarball);
    const warm = createStore({ dir, fetch });
    const second = await warm.add("https://reg/p.tgz", integrity);

    expect(second.cached).toBe(true);
    expect(second.index).toEqual(first.index);
    expect(fetch.calls).toEqual([]);
  });

  it("finds an index whose shard directory a case-insensitive disk spells differently", async () => {
    // A shard is two base64url characters, so `Ab` and `aB` are one directory on macOS or
    // Windows, listed under whichever spelling made it. The listing that answers misses must
    // not turn that into a refetch — or an offline warm install into a failure. Simulated on
    // a case-sensitive disk: the listing is taken while the shard wears the other spelling.
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const integrity = hashOf(tarball);
    await createStore({ dir, fetch: stubFetch(tarball) }).add("https://reg/p.tgz", integrity);
    const shard = dirname(await indexFile(dir));
    const flipped = join(dirname(shard), swapCase(basename(shard)));
    if (flipped === shard) return; // digits only: nothing to flip

    await rename(shard, flipped);
    const fetch = stubFetch(tarball);
    const warm = createStore({ dir, fetch });
    expect(warm.index(hashOf(Buffer.from("other")))).toBeUndefined(); // lists the shards now
    await rename(flipped, shard);

    expect((await warm.add("https://reg/p.tgz", integrity)).cached).toBe(true);
    expect(fetch.calls).toEqual([]);
  });

  it("asks again for a tarball the registry was too busy to serve", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const seen: string[] = [];
    const busy = (async (input: string | URL) => {
      seen.push(String(input));
      if (seen.length === 1) return new Response("slow down", { status: 429 });
      return new Response(tarball as unknown as BodyInit);
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: busy });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index.files.map((f) => f.path)).toEqual(["a.js"]);
    expect(seen).toHaveLength(2);
  });

  it("asks for fewer tarballs at a time once the registry has said 429", async () => {
    // A tarball retried into a success looks like nothing happened. The gate is told anyway,
    // and what it does about it shows up on a later, healthy batch.
    const tarballs: Record<string, Uint8Array> = {};
    for (let i = 0; i < 80; i++) {
      tarballs[`https://reg/t${i}.tgz`] = makeTarball([{ path: "a.js", data: `pkg ${i}` }]);
    }
    const seen = new Map<string, number>();
    let open = 0;
    let peak = 0;
    let busy = true;
    const throttling = (async (input: string | URL) => {
      const url = String(input);
      const nth = (seen.get(url) ?? 0) + 1;
      seen.set(url, nth);
      peak = Math.max(peak, ++open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open--;
      if (busy && nth === 1) return new Response("slow down", { status: 429 });
      return new Response(tarballs[url] as unknown as BodyInit);
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: throttling, workers: 0 });
    // The gate may grow again a second after the last 429. A slow runner can take that long
    // over the first batch, so the clock stands still here.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    onTestFinished(() => now.mockRestore());

    const add = (url: string) => store.add(url, hashOf(tarballs[url] as Uint8Array));
    await Promise.all(Object.keys(tarballs).slice(0, 20).map(add));
    busy = false;
    peak = 0;
    await Promise.all(Object.keys(tarballs).slice(20).map(add));

    expect(peak).toBeLessThanOrEqual(4); // the floor, reached by halving 16 four times
  });

  it("asks again for a tarball whose connection died mid-download", async () => {
    // The ordinary transient failure is not a status at all: the socket goes away in the
    // middle of the body, which arrives as an uncoded error out of the stream.
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const seen: string[] = [];
    const flaky = (async (input: string | URL) => {
      seen.push(String(input));
      if (seen.length > 1) return new Response(tarball as unknown as BodyInit);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tarball.subarray(0, 8));
            controller.error(new TypeError("socket hang up"));
          },
        }) as unknown as BodyInit,
      );
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: flaky });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index.files.map((f) => f.path)).toEqual(["a.js"]);
    expect(seen).toHaveLength(2);
  });

  it("gives up on a download that goes quiet, rather than holding its slot forever", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const signals: (AbortSignal | undefined)[] = [];
    const silent = (async (_input: string | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      // Never answers on its own; only the stall clock can end this.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: silent, stall: 20 });

    await expect(store.add("https://reg/p.tgz", hashOf(tarball))).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(signals).toHaveLength(5); // asked again to the attempt limit before giving up
    expect(signals.every((each) => each !== undefined)).toBe(true);
  });

  it(
    "gives up on a real download that goes quiet, over both routes",
    { timeout: 15_000 },
    async () => {
      // The stall abort reaches a real `fetch` as a DOMException whose `code` is the number 20,
      // not a string of ours: rethrown as-is it was neither ETIMEDOUT nor retried. Once whole on
      // this thread, and once as a big tarball streamed to a worker as it lands.
      const hanging = new Set<ServerResponse>();
      const hits: string[] = [];
      const server = createServer((request, response) => {
        hits.push(request.url ?? "");
        const big = request.url === "/big.tgz";
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(big ? 20 * 1024 * 1024 : 4096),
        });
        // A few bytes, then silence: only the stall clock can end this.
        response.write(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]));
        hanging.add(response);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const integrity = hashOf(makeTarball([{ path: "a.js", data: "alpha" }]));
        // Long enough for each attempt to reach the server on a slow runner before it goes quiet.
        const here = createStore({ dir, workers: 0, stall: 100 });
        await expect(here.add(`${base}/small.tgz`, integrity)).rejects.toMatchObject({
          code: "ETIMEDOUT",
        });
        const streamed = createStore({ dir, workers: 2, stall: 100 });
        await expect(streamed.add(`${base}/big.tgz`, integrity)).rejects.toMatchObject({
          code: "ETIMEDOUT",
        });
        // Asked again to the attempt limit before giving up, on both routes.
        expect(hits.filter((hit) => hit === "/small.tgz")).toHaveLength(5);
        expect(hits.filter((hit) => hit === "/big.tgz")).toHaveLength(5);
      } finally {
        for (const response of hanging) response.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("does not give up on a download that is slow but still arriving", async () => {
    // The clock watches for silence, not for slowness: a big tarball on a thin line takes
    // many times the stall to arrive and must not be abandoned for it.
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const dribble = (async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let at = 0; at < tarball.length; at += 16) {
              await new Promise((resolve) => setTimeout(resolve, 4));
              controller.enqueue(tarball.subarray(at, Math.min(at + 16, tarball.length)));
            }
            controller.close();
          },
        }) as unknown as BodyInit,
      );
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: dribble, stall: 40 });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));
    expect(index.files.map((f) => f.path)).toEqual(["a.js"]);
  });

  it("waits as long as the registry asked before asking for a tarball again", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const at: number[] = [];
    const busy = (async () => {
      at.push(Date.now());
      if (at.length === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0.3" } });
      }
      return new Response(tarball as unknown as BodyInit);
    }) as typeof globalThis.fetch;
    const store = createStore({ dir, fetch: busy });

    await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(at).toHaveLength(2);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(250);
  });

  it("does not ask again for a tarball that is missing or corrupt", async () => {
    // Asking twice would only turn a loud failure into a slow one.
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const missing = stubFetch({});
    await expect(
      createStore({ dir, fetch: missing }).add("https://reg/p.tgz", hashOf(tarball)),
    ).rejects.toMatchObject({ code: "E404" });
    expect(missing.calls).toHaveLength(1);

    const wrong = stubFetch(makeTarball([{ path: "a.js", data: "not alpha" }]));
    await expect(
      createStore({ dir, fetch: wrong }).add("https://reg/p.tgz", hashOf(tarball)),
    ).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(wrong.calls).toHaveLength(1);
  });

  it("throws EINTEGRITY and leaves no index when the tarball does not match", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const wrong = hashOf(Buffer.from("something else"));
    const store = createStore({ dir, fetch: stubFetch(tarball) });

    await expect(store.add("https://reg/p.tgz", wrong)).rejects.toMatchObject({
      code: "EINTEGRITY",
    });
    expect(await store.index(wrong)).toBeUndefined();
    expect(await contents(dir)).toEqual([]);
  });

  it("stores two identical files in one package once", async () => {
    const tarball = makeTarball([
      { path: "a.js", data: "same" },
      { path: "nested/b.js", data: "same" },
    ]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index.files).toHaveLength(2);
    expect(index.files[0]?.blob).toBe(index.files[1]?.blob);
    expect(await contents(dir)).toHaveLength(1);
  });

  it("stores the same file across two packages once", async () => {
    const shared = { path: "license.md", data: "MIT" };
    const one = makeTarball([shared, { path: "one.js", data: "one" }]);
    const two = makeTarball([shared, { path: "two.js", data: "two" }]);
    const store = createStore({ dir, fetch: stubFetch({ "/one": one, "/two": two }) });

    const a = await store.add("/one", hashOf(one));
    const b = await store.add("/two", hashOf(two));

    const licenseA = a.index.files.find((f) => f.path === "license.md");
    const licenseB = b.index.files.find((f) => f.path === "license.md");
    expect(licenseA?.blob).toBe(licenseB?.blob);
    // three distinct blobs, not four
    expect(await contents(dir)).toHaveLength(3);
  });

  it("keeps exec and non-exec variants of the same content side by side", async () => {
    const tarball = makeTarball([
      { path: "lib.js", data: "#!/usr/bin/env node\n", mode: 0o644 },
      { path: "bin/cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
    ]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    const plain = index.files.find((f) => f.path === "lib.js");
    const exec = index.files.find((f) => f.path === "bin/cli.js");
    expect(exec?.blob).toBe(`${plain?.blob}-exec`);

    const plainPath = store.blobPath(plain!);
    const execPath = store.blobPath(exec!);
    expect(execPath).toBe(`${plainPath}-exec`);
    expect((await stat(plainPath)).mode & 0o111).toBe(0);
    // Windows has no exec bit; the `-exec` name is what keeps the two apart there.
    if (process.platform !== "win32") expect((await stat(execPath)).mode & 0o111).not.toBe(0);
    expect(await contents(dir)).toHaveLength(2);
  });

  it("shards content paths by the base64url digest", () => {
    const store = createStore({ dir });
    const hash = hashOf(Buffer.from("x"));
    const digest = hash
      .slice("sha512-".length)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const path = store.contentPath(hash, false);

    expect(path).toBe(join(dir, "files", digest.slice(0, 2), `sha512-${digest.slice(2)}`));
    expect(store.contentPath(hash, true)).toBe(`${path}-exec`);
    expect(basename(path)).not.toMatch(/[+=]/);
    expect(store.dir).toBe(dir);
  });

  it("makes one fetch for concurrent adds of the same integrity", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const fetch = stubFetch(tarball);
    const store = createStore({ dir, fetch });

    const all = await Promise.all([
      store.add("https://reg/p.tgz", hashOf(tarball)),
      store.add("https://reg/p.tgz", hashOf(tarball)),
      store.add("https://reg/p.tgz", hashOf(tarball)),
    ]);

    expect(fetch.calls).toHaveLength(1);
    expect(all.map((r) => r.index.files[0]?.path)).toEqual(["a.js", "a.js", "a.js"]);
  });

  it("accepts an integrity derived from a legacy shasum", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const shasum = createHash("sha1").update(tarball).digest("hex");
    const store = createStore({ dir, fetch: stubFetch(tarball) });

    const { index } = await store.add("https://reg/p.tgz", fromShasum(shasum));

    expect(index.integrity.startsWith("sha1-")).toBe(true);
    expect(index.files).toHaveLength(1);
  });

  it("defaults the directory to UPM_STORE", () => {
    process.env.UPM_STORE = join(dir, "env");
    try {
      expect(createStore().dir).toBe(join(dir, "env"));
    } finally {
      delete process.env.UPM_STORE;
    }
  });

  it("surfaces a failed tarball download", async () => {
    const store = createStore({
      dir,
      fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    });

    await expect(store.add("https://reg/p.tgz", hashOf(Buffer.from("x")))).rejects.toMatchObject({
      code: "E404",
    });
  });
  it.each([
    ["torn json", '{"integrity'],
    ["the wrong shape", '"pwned"'],
    ["files that are not entries", '{"integrity":"x","files":[1,2],"unpackedSize":0}'],
    [
      "entries in the shape an older upm wrote",
      '{"integrity":"x","files":[{"path":"a.js","hash":"sha512-x","exec":false,"size":5}],"unpackedSize":5}',
    ],
    [
      "a blob outside the store",
      '{"integrity":"x","files":[{"path":"a.js","blob":"../../etc/passwd","size":5}],"unpackedSize":5}',
    ],
  ])("heals an index containing %s", async (_label, bad) => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const integrity = hashOf(tarball);
    const first = createStore({ dir, fetch: stubFetch(tarball) });
    const good = await first.add("https://reg/p.tgz", integrity);
    await writeFile(await indexFile(dir), bad);

    expect(await createStore({ dir }).index(integrity)).toBeUndefined();

    // A bad index must be replaced, not merely ignored, or the store never recovers.
    const store = createStore({ dir, fetch: stubFetch(tarball) });
    expect((await store.add("https://reg/p.tgz", integrity)).cached).toBe(false);
    expect(await createStore({ dir }).index(integrity)).toEqual(good.index);
  });

  it("marks a declared bin executable even when the tarball ships it 0644", async () => {
    const tarball = makeTarball([
      { path: "package.json", data: JSON.stringify({ name: "p", bin: { p: "cli.js" } }) },
      { path: "cli.js", data: "run", mode: 0o644 },
    ]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index.files.find((f) => f.path === "cli.js")?.blob).toMatch(/-exec$/);
  });

  it.each([
    [
      "a truncated blob",
      async (file: string) => {
        await chmod(file, 0o644); // blobs are read-only, so damage has to be forced
        await writeFile(file, "x");
      },
    ],
    ["a missing blob", async (file: string) => await rm(file)],
  ])(
    "re-extracts over %s under verify, and believes the index without it",
    async (_label, damage) => {
      const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
      const integrity = hashOf(tarball);
      const cold = createStore({ dir, fetch: stubFetch(tarball) });
      const { index } = await cold.add("https://reg/p.tgz", integrity);
      const blob = cold.blobPath(index.files[0]!);
      await damage(blob);

      // Stating every file of every package is what --verify buys. A plain install believes the
      // index, and a blob that has gone missing is caught later by the link that fails on it.
      expect(
        (await createStore({ dir, fetch: stubFetch(tarball) }).add("https://reg/p.tgz", integrity))
          .cached,
      ).toBe(true);

      // Hardlinking damaged content into a project would corrupt it silently.
      const store = createStore({ dir, fetch: stubFetch(tarball), verify: true });
      const repaired = await store.add("https://reg/p.tgz", integrity);

      expect(repaired.cached).toBe(false);
      expect(await readFile(blob, "utf8")).toBe("alpha");
      expect(
        (
          await createStore({ dir, fetch: stubFetch(tarball), verify: true }).add(
            "https://reg/p.tgz",
            integrity,
          )
        ).cached,
      ).toBe(true);
    },
  );
  it("stores content read-only so a linked file cannot be written through", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });
    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));
    const blob = store.blobPath(index.files[0]!);

    // Every project sharing this store hardlinks the same inode.
    await expect(writeFile(blob, "tampered")).rejects.toMatchObject({
      code: process.platform === "win32" ? "EPERM" : "EACCES",
    });
  });

  it("touches a blob it already has, so a prune sees it is still wanted", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const integrity = hashOf(tarball);
    const first = createStore({ dir, fetch: stubFetch(tarball) });
    const { index } = await first.add("https://reg/p.tgz", integrity);
    const blob = first.blobPath(index.files[0]!);
    const past = new Date(Date.now() - 9e8);
    await utimes(blob, past, past);
    await rm(join(dir, "index"), { recursive: true });

    // The index is gone, so the blob looks unreferenced until someone claims it again.
    await createStore({ dir, fetch: stubFetch(tarball) }).add("https://reg/p.tgz", integrity);

    expect((await stat(blob)).mtimeMs).toBeGreaterThan(past.getTime());
  });

  it("replaces a blob an interrupted write left short", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const store = createStore({ dir, fetch: stubFetch(tarball) });
    const blob = store.contentPath(hashOf(Buffer.from("alpha")), false);
    // No index names it, so only the length says this blob is not the content it is named for.
    await mkdir(dirname(blob), { recursive: true });
    await writeFile(blob, "alp", { mode: 0o444 });

    await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(await readFile(blob, "utf8")).toBe("alpha");
  });

  it("lets both of two stores racing for the same content finish", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const integrity = hashOf(tarball);

    // Separate stores, so neither answers from the other's in-memory memo.
    const [a, b] = await Promise.all([
      createStore({ dir, fetch: stubFetch(tarball) }).add("https://reg/p.tgz", integrity),
      createStore({ dir, fetch: stubFetch(tarball) }).add("https://reg/p.tgz", integrity),
    ]);

    expect(a.index).toEqual(b.index);
    const entry = a.index.files[0]!;
    expect(await readFile(createStore({ dir }).blobPath(entry), "utf8")).toBe("alpha");
    expect(await contents(dir)).toHaveLength(1);
  });

  // Windows ignores a directory's read-only bit, so there is no write to refuse.
  it.skipIf(process.platform === "win32")(
    "surfaces a content write it is not allowed to make",
    async () => {
      const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
      const store = createStore({ dir, fetch: stubFetch(tarball) });
      const shard = dirname(store.contentPath(hashOf(Buffer.from("alpha")), false));
      await mkdir(shard, { recursive: true });
      await chmod(shard, 0o555);

      try {
        await expect(store.add("https://reg/p.tgz", hashOf(tarball))).rejects.toMatchObject({
          code: "ESTORE",
        });
      } finally {
        await chmod(shard, 0o755); // or the temp directory cannot be cleaned up
      }
    },
  );

  // A tarball arrives as however many chunks the response gives us. Small ones are joined
  // and big ones are handed to gunzip as they came, so both shapes have to unpack the same.
  for (const chunk of [1, 7, 64 * 1024]) {
    it(`unpacks a tarball delivered in ${chunk}-byte chunks`, async () => {
      const tarball = makeTarball([
        { path: "a.js", data: "alpha" },
        { path: "b.js", data: "beta" },
        { path: "run.sh", data: "#!/bin/sh", mode: 0o755 },
      ]);
      const integrity = hashOf(tarball);

      const whole = createStore({ dir: join(dir, "whole"), fetch: stubFetch(tarball) });
      const split = createStore({
        dir: join(dir, "split"),
        fetch: chunkedFetch(tarball, chunk),
      });

      const { index: want } = await whole.add("https://reg/p.tgz", integrity);
      const { index: got } = await split.add("https://reg/p.tgz", integrity);

      expect(got).toEqual(want);
      for (const file of got.files) {
        expect(await readFile(split.blobPath(file), "utf8")).toBe(
          await readFile(whole.blobPath(file), "utf8"),
        );
      }
    });
  }

  it("unpacks a tarball past the size that keeps its chunks apart", async () => {
    // Over 1 MiB the chunks are not joined, and a worker takes them, so this exercises the
    // multi-buffer transfer as well. Random, or gzip would shrink it below one block.
    const big = randomBytes(2 * 1024 * 1024).toString("base64");
    const tarball = makeTarball([
      { path: "big.txt", data: big },
      { path: "small.txt", data: "small" },
    ]);
    expect(tarball.byteLength).toBeGreaterThan(1024 * 1024);
    const integrity = hashOf(tarball);

    const store = createStore({ dir, fetch: chunkedFetch(tarball, 64 * 1024) });
    const { index } = await store.add("https://reg/p.tgz", integrity);

    expect(index.files.map((f) => f.path)).toEqual(["big.txt", "small.txt"]);
    expect(index.unpackedSize).toBe(big.length + 5);
    expect(await readFile(store.blobPath(index.files[0]!), "utf8")).toBe(big);
  });

  it("rejects a corrupt tarball however it is chunked", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const store = createStore({ dir, fetch: chunkedFetch(tarball, 13) });
    // The digest of different bytes: verification runs over the chunks, before any unpack.
    await expect(
      store.add("https://reg/p.tgz", hashOf(Buffer.from("other"))),
    ).rejects.toMatchObject({ code: "EINTEGRITY" });
  });
});

// --- fixtures ---

interface Stub {
  (input: string | URL | Request): Promise<Response>;
  calls: string[];
}

describe("a store backend", () => {
  const tarball = makeTarball([
    { path: "lib.js", data: "#!/usr/bin/env node\n", mode: 0o644 },
    { path: "bin/cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
    { path: "b.js", data: "beta" },
  ]);
  const integrity = hashOf(tarball);
  const url = "https://reg/p.tgz";

  /** A backend that holds `tarball`, as a first store put it there. */
  async function filled(): Promise<ReturnType<typeof memoryBackend>> {
    const backend = memoryBackend();
    const first = createStore({ dir, fetch: stubFetch(tarball), backend });
    await first.add(url, integrity);
    await first.flush();
    return backend;
  }

  async function otherDir(): Promise<string> {
    const other = await mkdtemp(join(tmpdir(), "upm-store-"));
    onTestFinished(() => rm(other, { recursive: true, force: true }));
    return other;
  }

  it("is handed what a download stored, a blob once for both modes", async () => {
    const backend = memoryBackend();
    const store = createStore({ dir, fetch: stubFetch(tarball), backend });
    const { index } = await store.add(url, integrity);
    await store.flush();

    const kept = backend.index(integrity)!;
    expect(kept).toMatchObject({ v: 1, integrity, unpackedSize: index.unpackedSize });
    expect(kept.files.map((f) => f.path)).toEqual(index.files.map((f) => f.path));
    expect(kept.files.find((f) => f.path === "bin/cli.js")?.exec).toBe(true);
    expect(backend.blobs()).toHaveLength(2);
    for (const [key, data] of backend.blobs()) {
      expect(key).toBe(`blob/sha512-${createHash("sha512").update(data).digest("base64url")}`);
    }
    // The index goes last, once its blobs are in.
    expect(backend.sets.at(-1)).toBe(indexKey(integrity));
  });

  it("skips a package downloaded with credentials, unless the backend is private", async () => {
    const auth = { "//reg/": "Bearer secret" };
    const shared = memoryBackend();
    const one = createStore({ dir, fetch: stubFetch(tarball), backend: shared, auth });
    await one.add(url, integrity);
    await one.flush();
    expect(shared.sets).toEqual([]);

    const own = { ...memoryBackend(), private: true };
    const other = createStore({
      dir: await otherDir(),
      fetch: stubFetch(tarball),
      backend: own,
      auth,
    });
    await other.add(url, integrity);
    await other.flush();
    expect(own.index(integrity)).toBeDefined();
  });

  it("fills a store without a download, the same files as one", async () => {
    const backend = await filled();
    const other = await otherDir();
    const fetch = stubFetch(tarball);
    const store = createStore({ dir: other, fetch, backend, offline: true });
    const got = await store.add(url, integrity);

    expect(fetch.calls).toEqual([]);
    expect(got.index).toEqual(await createStore({ dir }).index(integrity));
    const exec = got.index.files.find((f) => f.path === "bin/cli.js")!;
    expect(await readFile(store.blobPath(exec), "utf8")).toBe("#!/usr/bin/env node\n");
    const relative = async (root: string) =>
      (await contents(root)).map((p) => p.slice(root.length));
    expect(await relative(other)).toEqual(await relative(dir));
    // The content shared by both modes is asked for once.
    expect(backend.asked.flat()).toHaveLength(2);
  });

  it("asks only for blobs the store has not got", async () => {
    const backend = await filled();
    const other = await otherDir();
    const one = makeTarball([{ path: "b.js", data: "beta" }]);
    await createStore({ dir: other, fetch: stubFetch(one) }).add(
      "https://reg/one.tgz",
      hashOf(one),
    );

    await createStore({ dir: other, fetch: stubFetch(tarball), backend }).add(url, integrity);
    expect(backend.asked.flat()).toHaveLength(1);
  });

  it("downloads instead, and says so once, when a blob does not match its hash", async () => {
    const backend = await filled();
    const [key, data] = backend.blobs()[0]!;
    backend.data.set(
      key,
      data.map((byte) => byte ^ 1),
    );

    const fetch = stubFetch(tarball);
    const failed = vi.fn();
    const store = createStore({ dir: await otherDir(), fetch, backend, backendFailed: failed });
    await store.add(url, integrity);
    expect(fetch.calls).toEqual([url]);
    expect(failed).toHaveBeenCalledOnce();
    expect(String(failed.mock.calls[0]![0])).toMatch(/damaged/);
  });

  it("takes a trusted backend's blobs without hashing them", async () => {
    const backend = await filled();
    const [key, data] = backend.blobs()[0]!;
    backend.data.set(
      key,
      data.map((byte) => byte ^ 1),
    );
    const fetch = stubFetch(tarball);
    const store = createStore({
      dir: await otherDir(),
      fetch,
      backend: { ...backend, trusted: true },
    });
    await store.add(url, integrity);
    expect(fetch.calls).toEqual([]);
  });

  it.each([
    ["a path out of the package", { path: "../../ESCAPED.txt" }],
    ["an absolute path", { path: "/etc/passwd" }],
    ["a windows path", { path: "a\\..\\b" }],
    ["a dot part", { path: "./a.js" }],
    ["an empty path", { path: "" }],
    ["an empty part", { path: "a//b.js" }],
    ["a drive letter", { path: "C:x.js" }],
    ["a duplicate path", { path: "lib.js" }],
    ["a weak hash", { hash: `sha1-${"a".repeat(27)}` }],
    ["a size that is not one", { size: -1 }],
    ["a mode that is not one", { exec: "yes" }],
  ])("downloads instead of trusting an index with %s", async (_, change) => {
    const backend = await filled();
    const kept = backend.index(integrity)!;
    kept.files[0] = { ...kept.files[0]!, ...(change as object) };
    backend.setIndex(integrity, kept);
    const fetch = stubFetch(tarball);
    const failed = vi.fn();
    const store = createStore({ dir: await otherDir(), fetch, backend, backendFailed: failed });
    await store.add(url, integrity);
    expect(fetch.calls).toEqual([url]);
    expect(failed).toHaveBeenCalledOnce();
    expect(String(failed.mock.calls[0]![0])).toMatch(/store backend index/);
  });

  it("downloads instead of taking another package's index", async () => {
    const backend = await filled();
    const other = makeTarball([{ path: "a.js", data: "other" }]);
    backend.setIndex(hashOf(other), backend.index(integrity)!);
    const fetch = stubFetch(other);
    await createStore({ dir: await otherDir(), fetch, backend }).add(url, hashOf(other));
    expect(fetch.calls).toEqual([url]);
  });

  it.each([
    [
      "an index cut short",
      (backend: ReturnType<typeof memoryBackend>) => {
        const key = indexKey(integrity);
        backend.data.set(key, backend.data.get(key)!.subarray(0, 10));
      },
    ],
    [
      "a blob cut short",
      (backend: ReturnType<typeof memoryBackend>) => {
        const [key, data] = backend.blobs()[0]!;
        backend.data.set(key, data.subarray(0, 1));
      },
    ],
  ])("downloads, and says nothing, for %s", async (_, cut) => {
    const backend = await filled();
    cut(backend);
    const fetch = stubFetch(tarball);
    const failed = vi.fn();
    const store = createStore({ dir: await otherDir(), fetch, backend, backendFailed: failed });
    await store.add(url, integrity);
    await store.flush();
    expect(fetch.calls).toEqual([url]);
    expect(failed).not.toHaveBeenCalled();
    // And the put writes it whole again.
    expect(backend.index(integrity)).toBeDefined();
    for (const [key, data] of backend.blobs()) expect(`blob/${sha512(data)}`).toBe(key);
  });

  it("is still offline when the backend has not got every blob", async () => {
    const backend = await filled();
    backend.data.delete(backend.blobs()[0]![0]);
    const store = createStore({ dir: await otherDir(), backend, offline: true });
    await expect(store.add(url, integrity)).rejects.toMatchObject({ code: "EOFFLINE" });
  });

  it("stops asking a failing backend, and counts every failure as a miss", async () => {
    let calls = 0;
    const down = () => {
      calls++;
      return Promise.reject(new Error("down"));
    };
    const backend: StoreBackend = { get: down, set: down };
    const tarballs: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++)
      tarballs[`https://reg/${i}.tgz`] = makeTarball([{ path: "a.js", data: `${i}` }]);
    const failed = vi.fn();
    const store = createStore({
      dir,
      fetch: stubFetch(tarballs),
      backend,
      backendFailed: failed,
      concurrency: 1,
    });
    for (const [at, bytes] of Object.entries(tarballs)) await store.add(at, hashOf(bytes));
    await store.flush();
    expect(failed).toHaveBeenCalledOnce();
    expect(calls).toBe(3);
  });

  it("moves on from a backend that never answers", async () => {
    const never = () => new Promise<never>(() => {});
    const backend: StoreBackend = { get: never };
    const fetch = stubFetch(tarball);
    const failed = vi.fn();
    const store = createStore({ dir, fetch, backend, backendFailed: failed, stall: 50 });
    await store.add(url, integrity);
    expect(fetch.calls).toEqual([url]);
    expect(failed.mock.calls[0]![0]).toMatchObject({ code: "ETIMEDOUT" });
  });

  it("gives up on a set that goes quiet, and counts `alive` as progress", async () => {
    const set = vi.fn<NonNullable<StoreBackend["set"]>>(async (_, __, { signal, alive }) => {
      for (let i = 0; i < 3; i++) {
        await sleep(30);
        alive();
      }
      await new Promise((_, reject) => signal.addEventListener("abort", reject));
    });
    const backend: StoreBackend = { ...memoryBackend(), set, concurrency: 1 };
    const failed = vi.fn();
    const store = createStore({
      dir,
      fetch: stubFetch(tarball),
      backend,
      backendFailed: failed,
      stall: 50,
    });
    await store.add(url, integrity);
    await store.flush();
    // Three signs 30 ms apart outlast a 50 ms stall, then the set is abandoned, and the rest.
    expect(set).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0]).toMatchObject({ code: "ETIMEDOUT" });
  });

  it("keeps a lookup from waiting behind puts", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const backend: StoreBackend = { ...memoryBackend(), set: () => held, concurrency: 1 };
    const one = makeTarball([{ path: "a.js", data: "one" }]);
    const store = createStore({
      dir,
      fetch: stubFetch({ [url]: tarball, "https://reg/one.tgz": one }),
      backend,
    });
    await store.add(url, integrity);
    const start = performance.now();
    await store.add("https://reg/one.tgz", hashOf(one));
    expect(performance.now() - start).toBeLessThan(1000);
    release();
    await store.flush();
  });

  it("waits in every flush for every put", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const backend: StoreBackend = { ...memoryBackend(), set: () => held };
    const store = createStore({ dir, fetch: stubFetch(tarball), backend });
    await store.add(url, integrity);
    let flushed = 0;
    const both = [store.flush(), store.flush()].map((p) => p.then(() => flushed++));
    await sleep(10);
    expect(flushed).toBe(0);
    release();
    await Promise.all(both);
    expect(flushed).toBe(2);
  });

  it("does not hand the backend a package its readers would refuse", async () => {
    const odd = makeTarball([{ path: "c:odd.js", data: "odd" }]);
    const backend = memoryBackend();
    const failed = vi.fn();
    const store = createStore({ dir, fetch: stubFetch(odd), backend, backendFailed: failed });
    await store.add(url, hashOf(odd));
    await store.flush();
    expect(backend.data.size).toBe(0);
    expect(failed).not.toHaveBeenCalled();
  });

  it("reads from the backend a few packages at a time", async () => {
    const backend = memoryBackend();
    const tarballs: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) {
      tarballs[`https://reg/${i}.tgz`] = makeTarball([
        { path: "a.js", data: `a ${i}` },
        { path: "b.js", data: `b ${i}` },
      ]);
    }
    const first = createStore({ dir, fetch: stubFetch(tarballs), backend });
    await Promise.all(Object.entries(tarballs).map(([at, bytes]) => first.add(at, hashOf(bytes))));
    await first.flush();

    let held = 0;
    let most = 0;
    const slow: StoreBackend = {
      ...backend,
      async getMany(keys) {
        most = Math.max(most, ++held);
        await sleep(5);
        held--;
        return await backend.getMany(keys);
      },
      concurrency: 4,
    };
    const store = createStore({ dir: await otherDir(), fetch: stubFetch({}), backend: slow });
    await Promise.all(Object.entries(tarballs).map(([at, bytes]) => store.add(at, hashOf(bytes))));
    expect(most).toBeLessThanOrEqual(4);
  });
});

/** An in-memory backend, and what it was asked for and handed. */
function memoryBackend() {
  const data = new Map<string, Uint8Array>();
  const asked: string[][] = [];
  const sets: string[] = [];
  const text = (value: Uint8Array) => new TextDecoder().decode(value);
  return {
    data,
    asked,
    sets,
    index: (integrity: string): BackendIndex | undefined => {
      const value = data.get(indexKey(integrity));
      return value && JSON.parse(text(value));
    },
    setIndex: (integrity: string, index: BackendIndex) =>
      data.set(indexKey(integrity), new TextEncoder().encode(JSON.stringify(index))),
    blobs: () => [...data].filter(([key]) => key.startsWith("blob/")),
    get: async (key: string) => data.get(key),
    async getMany(keys: string[]) {
      asked.push(keys);
      return keys.map((key) => data.get(key));
    },
    async set(key: string, value: Uint8Array) {
      sets.push(key);
      data.set(key, new Uint8Array(value));
    },
  } satisfies StoreBackend & Record<string, unknown>;
}

const sha512 = (data: Uint8Array) =>
  `sha512-${createHash("sha512").update(data).digest("base64url")}`;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The single index file in a store with one package. */
async function indexFile(root: string): Promise<string> {
  const shard = join(root, "index");
  const bucket = (await readdir(shard))[0] as string;
  const file = (await readdir(join(shard, bucket)))[0] as string;
  return join(shard, bucket, file);
}

function stubFetch(body: Uint8Array | Record<string, Uint8Array>): Stub & typeof fetch {
  const calls: string[] = [];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const bytes = body instanceof Uint8Array ? body : body[url];
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes as unknown as BodyInit);
  };
  return Object.assign(stub, { calls }) as Stub & typeof fetch;
}

/** Serves the tarball as a stream of fixed-size chunks, the way a real response arrives. */
function chunkedFetch(bytes: Uint8Array, size: number): Stub & typeof fetch {
  const calls: string[] = [];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += size) {
          controller.enqueue(bytes.subarray(at, Math.min(at + size, bytes.length)));
        }
        controller.close();
      },
    });
    return new Response(stream as unknown as BodyInit);
  };
  return Object.assign(stub, { calls }) as Stub & typeof fetch;
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** Every blob under `<store>/files`, ignoring leftover temp names. */
async function contents(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const full = join(path, item.name);
      if (item.isDirectory()) await walk(full);
      else if (!item.name.endsWith(".tmp")) found.push(full);
    }
  };
  await walk(join(root, "files"));
  return found;
}

function swapCase(text: string): string {
  return text.replace(/[a-z]/gi, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
}

describe("tarballs with no integrity yet, and on disk", () => {
  const tarball = makeTarball([
    { path: "package.json", data: '{"name":"a","version":"1.0.0"}' },
    { path: "index.js", data: "alpha" },
  ]);

  it("adopts a tarball under the hash of its bytes, and fetches it once", async () => {
    const fetch = stubFetch(tarball);
    const store = createStore({ dir, fetch });
    const { integrity, index } = await store.adopt("https://t.test/a.tgz");
    expect(integrity).toBe(hashOf(tarball));
    expect(index.files.map((f) => f.path)).toEqual(["index.js", "package.json"]);
    // The install after the resolve finds it there, in this store and in a fresh one.
    await store.ensure("https://t.test/a.tgz", integrity);
    expect(createStore({ dir, fetch }).index(integrity)).toEqual(index);
    expect(fetch.calls).toEqual(["https://t.test/a.tgz"]);
  });

  it("puts back a file its index names and the disk lost, whatever verify says", async () => {
    const fetch = stubFetch(tarball);
    const { index } = await createStore({ dir, fetch }).adopt("https://t.test/a.tgz");
    const manifest = index.files.find((f) => f.path === "package.json")!;
    const store = createStore({ dir, fetch });
    await rm(store.blobPath(manifest), { force: true });
    await store.adopt("https://t.test/a.tgz");
    expect(await readFile(store.blobPath(manifest), "utf8")).toContain('"name":"a"');
  });

  it("reads a local file off the disk, checked like any other", async () => {
    const file = join(dir, "a.tgz");
    await writeFile(file, tarball);
    const fetch = stubFetch({});
    const store = createStore({ dir: join(dir, "store"), fetch });
    expect((await store.adopt({ path: file })).integrity).toBe(hashOf(tarball));
    const again = createStore({ dir: join(dir, "other"), fetch });
    const { index } = await again.add({ path: file }, hashOf(tarball));
    expect(index.files).toHaveLength(2);
    // Other bytes than the lockfile pinned are refused, as a registry's would be.
    const other = createStore({ dir: join(dir, "third"), fetch });
    await expect(other.add({ path: file }, hashOf(makeTarball([])))).rejects.toMatchObject({
      code: "EINTEGRITY",
    });
    expect(fetch.calls).toEqual([]);
  });

  it("never reads a file: url off the disk: a registry may send one", async () => {
    const file = join(dir, "a.tgz");
    await writeFile(file, tarball);
    const fetch = stubFetch({});
    const store = createStore({ dir: join(dir, "store"), fetch });
    await expect(store.add(`file:${file}`, hashOf(tarball))).rejects.toMatchObject({
      code: "E404",
    });
    expect(fetch.calls).toEqual([`file:${file}`]);
  });

  it("fails a missing or irregular local file with a code of its own", async () => {
    const store = createStore({ dir, fetch: stubFetch({}) });
    const missing = join(dir, "missing.tgz");
    await expect(store.add({ path: missing }, hashOf(tarball))).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining(missing),
    });
    await mkdir(join(dir, "folder.tgz"));
    await expect(store.adopt({ path: join(dir, "folder.tgz") })).rejects.toMatchObject({
      code: "EINVAL",
    });
  });
});
