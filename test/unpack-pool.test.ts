import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashOf } from "./hash.ts";
import type { Pool, Unpack } from "../src/unpack-pool.ts";
import { createPool, poolSize, WORKER_DIED } from "../src/unpack-pool.ts";
import { createStore } from "../src/store.ts";
import type { PackageIndex } from "../src/store.ts";
import { createWriter } from "../src/unpack.ts";

let dir: string;
const open: Pool[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-pool-"));
});

afterEach(async () => {
  for (const pool of open.splice(0)) pool.kill();
  // Windows can hold a just-written file for a moment after the thread that wrote it is done.
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("createPool", () => {
  it("takes a tarball split into chunks, all views onto one buffer", async () => {
    // Every chunk of a sliced tarball shares one ArrayBuffer; listing it twice as a transfer
    // would be a DataCloneError, and transferring it at all would detach the other chunks.
    const tarball = bigTarball("chunked");
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);
    const worked = await worker(pool(join(dir, "pooled")), tarball.slice(), 8192);

    expect(worked).toEqual(alone);
  });

  it("writes in a worker exactly what this thread would", async () => {
    const tarball = bigTarball("alpha");
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);
    const worked = await worker(pool(join(dir, "pooled")), tarball.slice());

    expect(worked).toEqual(alone);
    const blob = createStore({ dir: join(dir, "pooled") }).blobPath(worked.files[0]!);
    expect((await stat(blob)).size).toBe(worked.files[0]!.size);
    expect((await stat(blob)).mode & 0o777).toBe(0o444);
  });

  it("lets two workers write content they share at the same time", async () => {
    const shared = randomBytes(300 * 1024);
    const one = tarballOf([
      { path: "big.bin", data: shared },
      { path: "a.js", data: "a" },
    ]);
    const two = tarballOf([
      { path: "big.bin", data: shared },
      { path: "b.js", data: "b" },
    ]);
    const both = pool(dir, 2);

    const [a, b] = await Promise.all([worker(both, one), worker(both, two)]);

    const big = a.files.find((file) => file.path === "big.bin");
    expect(big).toEqual(b.files.find((file) => file.path === "big.bin"));
    expect(await readFile(createStore({ dir }).blobPath(big!))).toEqual(shared);
    // One shared blob and one unique file each, with no temp name left behind.
    expect(await blobs(dir)).toHaveLength(3);
  });

  it("marks a declared bin executable when a worker unpacked it", async () => {
    const tarball = tarballOf([
      { path: "big.bin", data: randomBytes(300 * 1024) },
      { path: "cli.js", data: "run" },
      { path: "package.json", data: JSON.stringify({ name: "p", bin: { p: "cli.js" } }) },
    ]);

    const index = await worker(pool(dir), tarball);

    expect(index.files.find((file) => file.path === "cli.js")?.blob).toMatch(/-exec$/);
  });

  it("surfaces a worker's failure with the code the caller checks", async () => {
    // Valid gzip, but the tar inside declares an entry far longer than the archive.
    const broken = gzipSync(
      Buffer.concat([blockOf("package/big.bin", 1 << 20), randomBytes(300 * 1024)]),
    );

    await expect(worker(pool(dir), broken)).rejects.toMatchObject({
      code: "EBADTAR",
    });
  });

  it("writes the same store through the blocking calls as through the threadpool", async () => {
    // A worker writes a one-block tarball with the blocking calls and a bigger one through the
    // threadpool; this thread never blocks. Every route must leave identical content.
    const shared = randomBytes(64 * 1024);
    const small = tarballOf([
      { path: "index.js", data: "small" },
      { path: "cli.js", data: "run" },
      { path: "package.json", data: JSON.stringify({ name: "p", bin: { p: "cli.js" } }) },
    ]);
    const big = tarballOf([
      { path: "big.bin", data: randomBytes(1536 * 1024) },
      { path: "shared.bin", data: shared },
      { path: "index.js", data: "big" },
    ]);
    expect(big.byteLength).toBeGreaterThan(1024 * 1024);
    const split = (tarball: Uint8Array) => {
      const parts: Uint8Array[] = [];
      for (let at = 0; at < tarball.length; at += 1024 * 1024) {
        parts.push(tarball.slice(at, at + 1024 * 1024));
      }
      return parts;
    };
    const fill = async (name: string, blocking: boolean) => {
      const writer = createWriter(join(dir, name), { blocking });
      const indexes = [
        await writer.unpack(hashOf(small), [small], false),
        await writer.unpack(hashOf(big), split(big), false),
      ];
      return { indexes, files: await contents(join(dir, name)) };
    };

    const pooled = await fill("pooled", false);
    const direct = await fill("direct", true);

    expect(direct.indexes).toEqual(pooled.indexes);
    expect(direct.files).toEqual(pooled.files);
    expect(pooled.indexes[0]!.files.find((file) => file.path === "cli.js")?.blob).toMatch(/-exec$/);
    expect(pooled.files.size).toBe(6);
  });

  it("checks the hash in the worker, before a byte is written", async () => {
    const tarball = bigTarball("wrong");

    await expect(
      pool(dir).offer(hashOf(Buffer.from("other")), [tarball], false),
    ).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await blobs(dir)).toHaveLength(0);
  });

  it("takes a tarball of any size, however small", async () => {
    const tiny = tarballOf([{ path: "index.js", data: "x" }]);
    expect(tiny.byteLength).toBeLessThan(1024);

    const index = await worker(pool(dir), tiny);

    expect(index.files.map((file) => file.path)).toEqual(["index.js"]);
  });

  it("queues what its workers cannot take yet and drains in order", async () => {
    // One worker, six tarballs at once: every offer is taken, none unpacks on this thread.
    const one = pool(dir, 1);
    const tarballs = Array.from({ length: 6 }, (_, i) =>
      tarballOf([{ path: "i.js", data: `${i}` }]),
    );

    const taken = tarballs.map((tarball) => one.offer(hashOf(tarball), [tarball], false));
    expect(taken.every((promise) => promise !== undefined)).toBe(true);

    const indexes = await Promise.all(taken as Promise<PackageIndex>[]);
    expect(indexes.map((index) => index.files[0]!.size)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await blobs(dir)).toHaveLength(6);
  });

  it("starts one worker per tarball queued with no idle one, up to its cap", async () => {
    const eight = pool(dir, 8, MARKING);
    const burst = (n: number) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          worker(eight, tarballOf([{ path: "i.js", data: `${i}` }])),
        ),
      );

    // Three at once on an empty pool: three threads. Three more onto idle threads: none.
    await burst(3);
    expect(await booted(dir, 3)).toBe(3);
    // One thread can drain the burst while another is still booting; a tarball offered then
    // would rightly start a fourth.
    await loaded(dir, 3);
    await burst(3);
    expect(await booted(dir, 4)).toBe(3);
    // Past the cap the rest wait in the queue.
    const two = pool(join(dir, "two"), 2, MARKING);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => worker(two, tarballOf([{ path: "i.js", data: `${i}` }]))),
    );
    expect(await booted(join(dir, "two"), 2)).toBe(2);
  });

  it("starts a thread only for every eight tarballs behind the one offered", async () => {
    const few = pool(dir, 8, MARKING);
    const tarball = bigTarball("few");

    // Seven behind it, this one included: not worth a boot, so the caller unpacks it.
    expect(few.offer(hashOf(tarball), [tarball], false, 7)).toBeUndefined();
    expect(await started(dir)).toBe(0);
    // Eight: one thread. Once a thread is up, a tarball with nothing behind it still goes to it.
    expect((await few.offer(hashOf(tarball), [tarball], false, 8)!).files).toHaveLength(2);
    expect(await started(dir)).toBe(1);
    const last = bigTarball("last");
    expect((await few.offer(hashOf(last), [last], false, 1)!).files).toHaveLength(2);
    expect(await started(dir)).toBe(1);
  });

  it("starts no worker for an install of one package, and two for one of sixteen", async () => {
    const one = bigTarball("one");
    const single = createStore({
      dir: join(dir, "one"),
      workers: 8,
      workerEntry: MARKING,
      fetch: stub(one),
    });
    await single.add("https://reg/p.tgz", hashOf(one));
    expect(await started(join(dir, "one"))).toBe(0);

    // Everything asked for at once, as an install does: sixteen behind the first landing.
    const shelf = new Map<string, Uint8Array>();
    for (let i = 0; i < 16; i++) shelf.set(`https://reg/p${i}.tgz`, bigTarball(`sixteen-${i}`));
    const many = createStore({
      dir: join(dir, "many"),
      workers: 8,
      workerEntry: MARKING,
      fetch: serve(shelf, []),
    });
    await Promise.all([...shelf].map(([url, tarball]) => many.add(url, hashOf(tarball))));
    expect(await booted(join(dir, "many"), 2)).toBe(2);
  });

  it("closing lets a busy thread finish and takes nothing more", async () => {
    const here = createWriter(dir);
    const fallback = vi.fn((integrity: string, tarball: Uint8Array[], repair: boolean) =>
      here.unpack(integrity, tarball, repair),
    );
    const slow = pool(dir, 1, SLOW, fallback);
    const tarballs = [bigTarball("drain-a"), bigTarball("drain-b")];
    // Both queued behind a thread still 300 ms from speaking; the close keeps it for them.
    const taken = tarballs.map((tarball) => slow.offer(hashOf(tarball), [tarball], false)!);
    slow.close();
    // The slow worker answers an empty index: both came from it, not from here.
    const indexes = await Promise.all(taken);
    expect(indexes.map((index) => index.files.length)).toEqual([0, 0]);
    expect(fallback).not.toHaveBeenCalled();
    expect(slow.offer(hashOf(tarballs[0]!), [tarballs[0]!], false)).toBeUndefined();
    expect(slow.open(hashOf(tarballs[0]!), false, 1 << 20)).toBeUndefined();
    // The thread went once it had answered.
    await new Promise((done) => setTimeout(done, 200));
    expect(process.getActiveResourcesInfo().filter((r) => r === "Worker")).toHaveLength(0);
  });

  it("runs what it still had queued on this thread when it is killed", async () => {
    const here = createWriter(dir);
    const fallback = vi.fn((integrity: string, tarball: Uint8Array[], repair: boolean) =>
      here.unpack(integrity, tarball, repair),
    );
    const slow = pool(dir, 1, SLOW, fallback);
    const tarballs = [bigTarball("closed-a"), bigTarball("closed-b")];

    // Both queued behind a thread still 300 ms from speaking; killing must not leave them.
    const taken = tarballs.map((tarball) => slow.offer(hashOf(tarball), [tarball], false)!);
    slow.kill();

    const indexes = await Promise.all(taken);
    expect(indexes.map((index) => index.files.length)).toEqual([2, 2]);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(slow.offer(hashOf(tarballs[0]!), [tarballs[0]!], false)).toBeUndefined();
  });

  it("outlives one thread that dies before it speaks while others are booting", async () => {
    const fallback = vi.fn();
    const some = pool(dir, 4, FIRST_DIES, fallback);
    const tarballs = Array.from({ length: 3 }, (_, i) => bigTarball(`boot-${i}`));

    const indexes = await Promise.all(tarballs.map((tarball) => worker(some, tarball)));

    expect(indexes.map((index) => index.files.length)).toEqual([2, 2, 2]);
    expect(fallback).not.toHaveBeenCalled();
    expect((await worker(some, bigTarball("boot-more"))).files).toHaveLength(2);
  });

  it("runs what it had queued on this thread when the worker entry cannot start", async () => {
    const here = createWriter(dir);
    const fallback = vi.fn((integrity: string, tarball: Uint8Array[], repair: boolean) =>
      here.unpack(integrity, tarball, repair),
    );
    const noThreads = vi.fn();
    const entry = new URL("./no-such-worker.mjs", import.meta.url);
    const broken = createPool(dir, { size: 2, entry, fallback, noThreads });
    open.push(broken);
    const tarball = bigTarball("beta");

    // Taken before any thread has spoken; the thread then fails to load, and the tarball is
    // still whole in the queue, so the pool unpacks it here rather than handing it back.
    const taken = broken.offer(hashOf(tarball), [tarball], false);
    expect(taken).toBeDefined();
    expect((await taken)?.files).toHaveLength(2);
    expect(fallback).toHaveBeenCalledTimes(1);
    // From then on it is not a pool: the caller unpacks.
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(broken.offer(hashOf(tarball), [tarball], false)).toBeUndefined();
      await pause();
    }
    expect(noThreads).toHaveBeenCalledTimes(1);
  });

  it("says its worker died rather than that the work failed", async () => {
    // A real thread, really killed with the tarball in it — not a rejection stood in for one.
    await expect(worker(pool(dir, 1, DYING), bigTarball("kill"))).rejects.toMatchObject({
      code: WORKER_DIED,
    });
  });

  it("stops offering once its workers keep dying", async () => {
    const dying = pool(dir, 4, DYING);
    const tarball = bigTarball("poison");

    // Every thread it starts dies on its first tarball, so it has to give up on itself.
    const taken = Array.from({ length: 3 }, () =>
      dying.offer(hashOf(tarball), [copyOf(tarball)], false)!.then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    for (const one of taken) expect(await one).toMatchObject({ code: WORKER_DIED });
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(dying.offer(hashOf(tarball), [copyOf(tarball)], false)).toBeUndefined();
      await pause();
    }
  });

  it("keeps the process alive for a tarball queued before any thread has spoken", async () => {
    // A queued tarball refs nothing itself, so the booting thread must. A `message` listener
    // added before the pool's (a Worker subclass, a preload) takes the port's own ref: counted
    // on, this child exits with the offer unsettled — code 13, no error, no index.
    // Plain `-e`, not `--input-type=module`: a worker inherits the flag and refuses to start.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `${LISTENS_FIRST}
         import(${JSON.stringify(POOL.href)}).then(async ({ createPool }) => {
           const pool = createPool("/", { size: 1, entry: new URL(${JSON.stringify(SLOW.href)}) });
           console.log("settled", (await pool.offer("sha512-x", [new Uint8Array(1)], false)).files);
         });`,
      ],
      { timeout: 10_000 },
    );
    expect(stdout).toContain("settled");
  });

  it("offers nothing at all when it is allowed no workers", () => {
    const big = bigTarball("gamma");
    expect(pool(dir, 0).offer(hashOf(big), [big], false)).toBeUndefined();
  });

  it("never allows more than eight workers", () => {
    expect(poolSize(64)).toBeLessThanOrEqual(8);
  });

  it("never asks for more workers than tarballs in flight", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(0)).toBe(1);
    expect(poolSize(1024)).toBeLessThanOrEqual(1024);
  });
});

// A 6 MiB tarball of 900 files takes seconds to write on Windows. Its 6 MiB file is spooled
// while it inflates, so the rest must still be worth two parts.
const timeout = process.platform === "win32" ? 60_000 : 20_000;
describe("createPool with a big tarball", { timeout }, () => {
  it("shards it across threads and writes exactly what this thread would", async () => {
    const tarball = hugeTarball("shard");
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);
    const four = pool(join(dir, "pooled"), 4, MARKING);

    const worked = await worker(four, tarball.slice());

    expect(worked).toEqual(alone);
    expect(await contents(join(dir, "pooled"))).toEqual(await contents(join(dir, "alone")));
    expect(worked.files.find((file) => file.path === "cli.js")?.blob).toMatch(/-exec$/);
    expect(worked.files.find((file) => file.path === "run.sh")?.blob).toMatch(/-exec$/);
    expect(worked.files.filter((file) => file.path === "lib/twice.js")).toHaveLength(1);
    expect(worked.files.find((file) => file.path === "lib/twice.js")?.size).toBe(11);
    // The parse thread plus helpers for its parts.
    expect(await booted(join(dir, "pooled"), 2)).toBeGreaterThanOrEqual(2);
  });

  it("spools big files as they inflate and still keeps tar's last entry and the bin's mode", async () => {
    // Files past the spool size are hashed and written to a temp name during the parse. One is
    // a bin the manifest names only after it, one path ships twice, big then small.
    const big = randomBytes(5 * 1024 * 1024);
    const tarball = tarballOf([
      { path: "lib/blob.bin", data: big },
      { path: "tool", data: randomBytes(4 * 1024 * 1024 + 1) },
      { path: "twice", data: randomBytes(4 * 1024 * 1024 + 7) },
      { path: "package.json", data: `{"name":"spool","bin":{"tool":"tool"}}` },
      { path: "twice", data: "small wins" },
      { path: "lib/blob.bin", data: big },
    ]);
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);
    const four = pool(join(dir, "pooled"), 4);

    const worked = await worker(four, tarball.slice(), 1024 * 1024);

    expect(worked).toEqual(alone);
    expect(await contents(join(dir, "pooled"))).toEqual(await contents(join(dir, "alone")));
    expect(worked.files.find((file) => file.path === "tool")?.blob).toMatch(/-exec$/);
    expect(worked.files.find((file) => file.path === "twice")?.size).toBe(10);
    expect(await readdir(join(dir, "pooled", "files"))).not.toContainEqual(
      expect.stringMatching(/\.tmp$/),
    );
  });

  it("drops the second temp when two spooled paths hold the same content", async () => {
    // Both are spooled during the parse; only one can become the blob, the other temp must go.
    const same = randomBytes(5 * 1024 * 1024);
    const tarball = tarballOf([
      { path: "a.bin", data: same },
      { path: "b.bin", data: same },
      { path: "index.js", data: "x" },
    ]);
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);

    const worked = await worker(pool(join(dir, "pooled"), 4), tarball.slice(), 1024 * 1024);

    expect(worked).toEqual(alone);
    expect(await contents(join(dir, "pooled"))).toEqual(await contents(join(dir, "alone")));
    expect(await readdir(join(dir, "pooled", "files"))).not.toContainEqual(
      expect.stringMatching(/\.tmp$/),
    );
  });

  it("writes it whole on one thread when it is allowed no helpers", async () => {
    const tarball = hugeTarball("one");
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);

    expect(await worker(pool(join(dir, "pooled"), 1), tarball.slice())).toEqual(alone);
  });

  it("checks the hash before any part is written", async () => {
    const tarball = hugeTarball("wrong");

    await expect(
      pool(dir, 4).offer(hashOf(Buffer.from("other")), [tarball], false),
    ).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(await blobs(dir)).toHaveLength(0);
  });

  it("streams a download to a worker as it lands and stores the same package", async () => {
    const tarball = hugeTarball("stream");
    const alone = await createWriter(join(dir, "alone")).unpack(hashOf(tarball), [tarball], false);
    const hits: string[] = [];
    // The last piece waits for a thread to start. Only a stream starts one before the body
    // ends; a tarball taken whole is offered after, so the wait would run out.
    let streamed = false;
    const started = async () => {
      for (let waited = 0; waited < 5000 && !streamed; waited += 10) {
        streamed = existsSync(join(dir, "workers"));
        if (!streamed) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const fetch = trickle(tarball, hits, undefined, started);
    // The first miss of a fresh store: the one that finds the pool still loading.
    const store = createStore({ dir, workers: 4, workerEntry: MARKING, fetch });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(streamed).toBe(true);
    expect(index).toEqual(alone);
    expect(hits).toHaveLength(1);
    expect(await createStore({ dir }).index(hashOf(tarball))).toEqual(index);
    for (const file of index.files) {
      expect((await stat(store.blobPath(file))).size).toBe(file.size);
    }
  });

  it("leaves nothing behind when a streamed tarball does not verify", async () => {
    const tarball = hugeTarball("bad");
    const store = createStore({ dir, workers: 4, fetch: trickle(tarball, []) });

    await expect(store.add("https://reg/p.tgz", hashOf(Buffer.from("nope")))).rejects.toMatchObject(
      { code: "EINTEGRITY" },
    );
    expect(await blobs(dir)).toHaveLength(0);
    expect(await readdir(join(dir, "index")).catch(() => [])).toHaveLength(0);
    // The 6 MiB file was spooled to a temp name while the stream ran; a failed tarball leaves none.
    expect(await readdir(join(dir, "files")).catch(() => [])).toHaveLength(0);
  });

  it("retries a download that dies mid-stream, and the worker drops what it had", async () => {
    const tarball = hugeTarball("cut");
    const hits: string[] = [];
    const store = createStore({ dir, workers: 4, fetch: trickle(tarball, hits, 3 * 1024 * 1024) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index).toEqual(await alone(tarball));
    expect(hits).toHaveLength(2);
    expect(await contents(dir)).toEqual(await contents(join(dir, "alone")));
  });

  it("drops what it spooled when the stream dies after the parse has finished", async () => {
    // Bytes after the archive's end marker: the parse stops there and the split is done while
    // the download still runs, and then the download fails. The 6 MiB file's temp must still go.
    const padded = Buffer.concat([
      gunzipSync(hugeTarball("trailer")),
      randomBytes(2 * 1024 * 1024),
    ]);
    const tarball = new Uint8Array(gzipSync(padded));
    const hits: string[] = [];
    const cut = tarball.length - 1024 * 1024;
    const store = createStore({ dir, workers: 4, fetch: trickle(tarball, hits, cut) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index).toEqual(await alone(tarball));
    expect(hits).toHaveLength(2);
    expect(await readdir(join(dir, "files"))).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });

  it("finishes on this thread when the worker holding a stream dies", async () => {
    const tarball = hugeTarball("dies");
    const hits: string[] = [];
    const store = createStore({
      dir,
      workers: 4,
      workerEntry: DYING,
      fetch: trickle(tarball, hits),
    });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index).toEqual(await alone(tarball));
    expect(hits).toHaveLength(2);
    expect(await contents(dir)).toEqual(await contents(join(dir, "alone")));
  });

  it("finishes on this thread when a thread dies with a part of it", async () => {
    const tarball = hugeTarball("part");
    const hits: string[] = [];
    const store = createStore({
      dir,
      workers: 4,
      workerEntry: PART_DIES,
      fetch: serve(new Map([["https://reg/p.tgz", tarball]]), hits),
    });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index).toEqual(await alone(tarball));
    expect(hits).toHaveLength(2);
    expect(await contents(dir)).toEqual(await contents(join(dir, "alone")));
  });

  it("keeps a dropped stream's abort away from the stream that took its worker", async () => {
    // A: a gzip header over garbage, so the worker fails it on the first blocks and goes idle
    // while the download is still running. B takes that worker. Then A's network drops: the
    // abort is A's, and A's worker has already answered.
    const one = pool(dir, 1);
    const good = tarballOf([
      { path: "package.json", data: "{}" },
      { path: "a.bin", data: randomBytes(9 * 1024 * 1024) },
    ]);
    const a = one.open(hashOf(Buffer.from("a")), false, 20 * 1024 * 1024)!;
    a.push(
      Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]), randomBytes(1 << 20)]),
    );
    a.push(randomBytes(1 << 20));
    await expect(a.end()).rejects.toMatchObject({ code: "EBADTAR" });
    const b = one.open(hashOf(good), false, good.length)!;
    for (let at = 0; at < good.length; at += 1 << 20) b.push(good.slice(at, at + (1 << 20)));
    await pause();
    a.abort();

    const index = await b.end();
    expect(index.files.map((file) => file.path)).toEqual(["a.bin", "package.json"]);
  });

  it("streams a small tarball whose content-length claims big, and writes it whole", async () => {
    const small = tarballOf([
      { path: "package.json", data: '{"name":"s","bin":"cli.js"}' },
      { path: "cli.js", data: "#!/usr/bin/env node" },
    ]);
    const store = createStore({ dir, workers: 4, fetch: claiming(small, 20 * 1024 * 1024) });

    const { index } = await store.add("https://reg/p.tgz", hashOf(small));

    expect(index).toEqual(await alone(small));
    expect(index.files.find((file) => file.path === "cli.js")?.blob).toMatch(/-exec$/);
    expect(await contents(dir)).toEqual(await contents(join(dir, "alone")));
  });

  it("survives the worker dying and the network dropping on one attempt", async () => {
    // The abort for the dropped download goes to a thread that is already gone.
    const tarball = hugeTarball("gone");
    const hits: string[] = [];
    const store = createStore({
      dir,
      workers: 2,
      workerEntry: DYING,
      fetch: trickle(tarball, hits, 3 * 1024 * 1024),
    });

    const { index } = await store.add("https://reg/p.tgz", hashOf(tarball));

    expect(index).toEqual(await alone(tarball));
    expect(await contents(dir)).toEqual(await contents(join(dir, "alone")));
  });

  it("leaves nothing behind when a streamed tarball is not a tarball", async () => {
    const junk = randomBytes(9 * 1024 * 1024);
    const hits: string[] = [];
    const store = createStore({ dir, workers: 4, fetch: trickle(junk, hits) });

    await expect(store.add("https://reg/p.tgz", hashOf(junk))).rejects.toMatchObject({
      code: "EBADTAR",
    });
    expect(hits).toHaveLength(1);
    expect(await contents(dir)).toEqual(new Map());
  });

  /** The same package into `<dir>/alone` with no worker at all: index and content to match. */
  async function alone(tarball: Uint8Array): Promise<PackageIndex> {
    const store = createStore({ dir: join(dir, "alone"), workers: 0, fetch: stub(tarball) });
    return (await store.add("https://reg/p.tgz", hashOf(tarball))).index;
  }
});

describe("createStore with workers", () => {
  it("stores the same package whether or not a worker unpacks it", async () => {
    const shelf = eightOf("delta");
    const [url, tarball] = [...shelf][0]!;
    const integrity = hashOf(tarball);

    const alone = await createStore({
      dir: join(dir, "alone"),
      workers: 0,
      fetch: serve(shelf, []),
    }).add(url, integrity);
    const pooled = await burst(join(dir, "pooled"), 4, shelf, MARKING);

    expect(pooled.get(url)).toEqual(alone.index);
    expect(await started(join(dir, "pooled"))).toBe(1);
  });

  it("fills a store the same way with no pool, a pool, and a pool that dies", async () => {
    // Every route into the store — this thread, a worker, a worker that died and this thread
    // finishing the tarball after it — must leave the same files and the same indexes.
    const shelf = new Map<string, Uint8Array>();
    for (const [i, entries] of [
      [{ path: "index.js", data: "tiny" }],
      [
        { path: "big.bin", data: randomBytes(300 * 1024) },
        { path: "index.js", data: "big" },
      ],
      [
        { path: "cli.js", data: "run" },
        { path: "package.json", data: JSON.stringify({ name: "p", bin: { p: "cli.js" } }) },
      ],
      [{ path: "big.bin", data: randomBytes(300 * 1024) }],
    ].entries()) {
      shelf.set(`https://reg/p${i}.tgz`, tarballOf(entries));
    }
    for (const [url, tarball] of eightOf("route")) shelf.set(url, tarball);
    const fill = async (name: string, workers: number, workerEntry?: URL) => {
      await burst(join(dir, name), workers, shelf, workerEntry);
      return await contents(join(dir, name));
    };

    const alone = await fill("alone", 0);
    const pooled = await fill("pooled", 2);
    const dying = await fill("dying", 2, DYING);

    expect(alone.size).toBeGreaterThan(12);
    expect(pooled).toEqual(alone);
    expect(dying).toEqual(alone);
  });

  it("leaves no content or index behind when a big tarball does not verify", async () => {
    const store = createStore({ dir, workers: 4, fetch: stub(bigTarball("epsilon")) });

    await expect(store.add("https://reg/p.tgz", hashOf(Buffer.from("nope")))).rejects.toMatchObject(
      { code: "EINTEGRITY" },
    );
    expect(await blobs(dir)).toHaveLength(0);
    expect(await readdir(join(dir, "index")).catch(() => [])).toHaveLength(0);
    // The 6 MiB file was spooled to a temp name while the stream ran; a failed tarball leaves none.
    expect(await readdir(join(dir, "files")).catch(() => [])).toHaveLength(0);
  });

  it("finishes the package on this thread when the worker holding it dies", async () => {
    const shelf = eightOf("death");
    const hits: string[] = [];

    // Eight at once, so a thread starts; it dies with the first tarball it is handed.
    const indexes = await burst(dir, 2, shelf, DYING, hits);

    const refetched = [...shelf].filter(([url]) => hits.filter((hit) => hit === url).length === 2);
    expect(refetched.length).toBeGreaterThan(0);
    for (const [url, tarball] of refetched) {
      // That one went to a worker, the worker died, and the install still has the package.
      const integrity = hashOf(tarball);
      const index = indexes.get(url);
      expect(index).toEqual(
        await createWriter(join(dir, "alone")).unpack(integrity, [tarball], false),
      );
      // And it is in the store to stay: content on disk, index written, readable again.
      expect(await createStore({ dir }).index(integrity)).toEqual(index);
      for (const file of index!.files) {
        expect((await stat(createStore({ dir }).blobPath(file))).size).toBe(file.size);
      }
    }
  });

  it("fails a tarball the unpack rejected instead of retrying it into a success", async () => {
    // Valid gzip, hashed as it stands so integrity passes, but the tar inside declares an entry
    // far longer than the archive. A worker saying that is the work talking, not a dead thread.
    const broken = gzipSync(
      Buffer.concat([blockOf("package/big.bin", 1 << 20), randomBytes(300 * 1024)]),
    );
    const warm = bigTarball("warm");
    const shelf = new Map<string, Uint8Array>([
      ["https://reg/bad.tgz", broken],
      ["https://reg/warm.tgz", warm],
    ]);
    for (const [url, tarball] of eightOf("warm")) shelf.set(url, tarball);
    const hits: string[] = [];
    const store = createStore({ dir, workers: 1, fetch: serve(shelf, hits) });
    // Warm the pool first, so the corrupt tarball has a live worker to land in.
    await Promise.all(
      [...shelf]
        .filter(([url]) => url !== "https://reg/bad.tgz")
        .map(([url, tarball]) => store.add(url, hashOf(tarball))),
    );
    for (let wait = 0; wait < 10; wait++) await pause();

    await expect(store.add("https://reg/bad.tgz", hashOf(broken))).rejects.toMatchObject({
      code: "EBADTAR",
    });
    expect(hits.filter((hit) => hit === "https://reg/bad.tgz")).toHaveLength(1);
    expect(await blobs(dir)).toHaveLength(18);
  });
});

// --- fixtures ---

interface Entry {
  path: string;
  data: string | Uint8Array;
  mode?: number;
}

/** A worker that exits the moment it is given work, the way an OOM kill takes one. */
const DYING = new URL("./dying-worker.ts", import.meta.url);
/** The real worker, except that one handed a part of a big tarball dies with it. */
const PART_DIES = new URL("./part-dies-worker.ts", import.meta.url);
/** A worker that is 300 ms loading before it says so. */
const SLOW = new URL("./slow-worker.ts", import.meta.url);
/** The real worker, marking `<dir>/workers/<threadId>` per thread started. */
const MARKING = new URL("./marking-worker.ts", import.meta.url);
/** The real worker, except that the first thread to load dies before it speaks. */
const FIRST_DIES = new URL("./first-dies-worker.ts", import.meta.url);
const POOL = new URL("../src/unpack-pool.ts", import.meta.url);
/** For a child: every Worker gets a `message` listener before its pool adds one. */
const LISTENS_FIRST = `const threads = require("node:worker_threads");
  threads.Worker = class extends threads.Worker {
    constructor(entry, options) { super(entry, options); this.on("message", () => {}); }
  };`;

/** The pool transfers a tarball's buffer, so an offer that is taken detaches the original. */
function copyOf(tarball: Uint8Array): Uint8Array {
  return new Uint8Array(tarball);
}

function pool(root: string, size = 1, entry?: URL, fallback?: Unpack): Pool {
  const made = createPool(root, { size, entry, fallback });
  open.push(made);
  return made;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Hand a tarball to the pool, hashed for real: the worker checks it before it writes. */
async function worker(from: Pool, tarball: Uint8Array, chunk = 0): Promise<PackageIndex> {
  const integrity = hashOf(tarball);
  const parts: Uint8Array[] = [];
  if (chunk > 0) {
    for (let at = 0; at < tarball.length; at += chunk) {
      parts.push(tarball.subarray(at, Math.min(at + chunk, tarball.length)));
    }
  } else {
    parts.push(tarball);
  }
  const taken = from.offer(integrity, parts, false);
  if (!taken) throw new Error("the pool did not take the tarball");
  return await taken;
}

function blockOf(path: string, size: number, mode = 0o644): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function tarballOf(entries: Entry[]): Uint8Array {
  const blocks = entries.flatMap((entry) => {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data) : entry.data;
    const pad = (512 - (data.length % 512)) % 512;
    return [blockOf(`package/${entry.path}`, data.length, entry.mode), data, Buffer.alloc(pad)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/**
 * Past the sharding threshold and worth two parts: 18 MiB of random bytes over many files, a
 * declared bin the tarball ships non-executable, a file with its own exec bit, one path twice,
 * and an empty file first — the first entry of a part has no buffer to land in yet.
 */
function hugeTarball(seed: string): Uint8Array {
  const entries: Entry[] = [
    { path: "empty", data: "" },
    { path: "a.bin", data: randomBytes(6 * 1024 * 1024) },
  ];
  for (let i = 0; i < 900; i++)
    entries.push({ path: `lib/${i}.bin`, data: randomBytes(20 * 1024) });
  entries.push({ path: "lib/twice.js", data: "first" });
  entries.push({ path: "package.json", data: `{"name":"${seed}","bin":{"x":"cli.js"}}` });
  entries.push({ path: "cli.js", data: "#!/usr/bin/env node" });
  entries.push({ path: "run.sh", data: "#!/bin/sh", mode: 0o755 });
  entries.push({ path: "lib/twice.js", data: "second wins" });
  return tarballOf(entries);
}

/** Serve one tarball in 64 KiB pieces with a content-length, so the store streams it. */
function trickle(
  tarball: Uint8Array,
  hits: string[],
  cutFirstAt?: number,
  beforeLast?: () => Promise<void>,
): typeof fetch {
  return (async (url: string) => {
    hits.push(url);
    const cut = hits.length === 1 ? cutFirstAt : undefined;
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cut !== undefined && at >= cut) return controller.error(new TypeError("reset"));
        if (at >= tarball.length) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (at + 65536 >= tarball.length) await beforeLast?.();
        controller.enqueue(tarball.subarray(at, Math.min(at + 65536, tarball.length)));
        at += 65536;
      },
    });
    return new Response(body, { headers: { "content-length": String(tarball.length) } });
  }) as unknown as typeof fetch;
}

/** One tarball, whole, under a content-length of the caller's choosing. */
function claiming(body: Uint8Array, length: number): typeof fetch {
  return (async () =>
    new Response(body as unknown as BodyInit, {
      headers: { "content-length": String(length) },
    })) as unknown as typeof fetch;
}

/** Random bytes do not compress, so this clears the pool's size threshold. */
function bigTarball(seed: string): Uint8Array {
  return tarballOf([
    { path: "big.bin", data: randomBytes(300 * 1024) },
    { path: "index.js", data: seed },
  ]);
}

function stub(body: Uint8Array): typeof fetch {
  return (async () => new Response(body as unknown as BodyInit)) as unknown as typeof fetch;
}

/** Canned tarballs by URL, recording every request — a retry shows up as a second hit. */
function serve(shelf: Map<string, Uint8Array>, hits: string[]): typeof fetch {
  return (async (url: string) => {
    hits.push(url);
    const body = shelf.get(url);
    return new Response(body as unknown as BodyInit, { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;
}

/** Every file under `files/` and `index/`, by relative path, with what is in it. */
async function contents(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // On a case-insensitive filesystem (macOS) shards `Ee` and `EE` are one directory, spelled
  // by whichever write made it first, so compare shard names without case.
  const key = (path: string) =>
    path.replace(/^([\\/]\w+[\\/])([^\\/]+)/, (_, top, shard) => top + shard.toLowerCase());
  const walk = async (path: string): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const full = join(path, item.name);
      if (item.isDirectory()) await walk(full);
      else found.set(key(full.slice(root.length)), (await readFile(full)).toString("base64"));
    }
  };
  await walk(join(root, "files"));
  await walk(join(root, "index"));
  return new Map([...found].sort());
}

/** Eight big tarballs by URL: what a store needs asked for at once before it starts a thread. */
function eightOf(seed: string): Map<string, Uint8Array> {
  const shelf = new Map<string, Uint8Array>();
  for (let i = 0; i < 8; i++) shelf.set(`https://reg/${seed}${i}.tgz`, bigTarball(`${seed}-${i}`));
  return shelf;
}

/** Fill a fresh store with every tarball on the shelf at once, the way an install asks. */
async function burst(
  root: string,
  workers: number,
  shelf: Map<string, Uint8Array>,
  workerEntry?: URL,
  hits: string[] = [],
): Promise<Map<string, PackageIndex>> {
  const store = createStore({ dir: root, workers, workerEntry, fetch: serve(shelf, hits) });
  const indexes = new Map<string, PackageIndex>();
  await Promise.all(
    [...shelf].map(async ([url, tarball]) => {
      indexes.set(url, (await store.add(url, hashOf(tarball))).index);
    }),
  );
  return indexes;
}

/** How many threads a `MARKING` pool started. */
async function started(root: string): Promise<number> {
  return (await readdir(join(root, "workers")).catch(() => [])).length;
}

/**
 * The count once `n` threads are up, or after a wait: one thread can drain a whole burst
 * before the others it started with have booted, and a thread started for nothing at all
 * (the `n` past the expected count) needs time to show.
 */
async function booted(root: string, n: number): Promise<number> {
  for (let wait = 0; wait < 100 && (await started(root)) < n; wait++) await pause();
  return await started(root);
}

/** Wait for `n` threads of a `MARKING` pool to have said they loaded, and for the pool to hear. */
async function loaded(root: string, n: number): Promise<void> {
  const count = async () => (await readdir(join(root, "loaded")).catch(() => [])).length;
  for (let wait = 0; wait < 100 && (await count()) < n; wait++) await pause();
  await pause();
}

async function blobs(root: string): Promise<string[]> {
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
