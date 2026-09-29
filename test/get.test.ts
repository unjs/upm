// A tarball download with no `fetch` given: the store asks through its agent's own callbacks.
// Loading `node:http` makes undici's default dispatcher, and one that is there before ours is
// used as is, so the agent is made first and the server's module loaded after it.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cacheLookups, getter } from "../src/dns.ts";
import { createStore } from "../src/store.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let dir: string;
const servers: Server[] = [];

beforeAll(async () => {
  await cacheLookups();
  // Every test below is about this route; `fetch` would pass them too.
  expect(getter()).toBeTypeOf("function");
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-get-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(dir, { recursive: true, force: true });
});

async function serve(handler: Handler): Promise<string> {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a download without fetch", () => {
  it("stores what fetch would, small or streamed to a thread, whatever its headers repeat", async () => {
    const small = makeTarball([{ path: "a.js", data: "alpha" }]);
    // Past the size that streams to a worker as it lands.
    const big = makeTarball([
      { path: "big.txt", data: randomBytes(3 * 1024 * 1024).toString("base64") },
    ]);
    const base = await serve((request, response) => {
      const bytes = request.url === "/big.tgz" ? big : small;
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.writeHead(200, { "content-length": String(bytes.length) });
      response.end(Buffer.from(bytes));
    });
    const direct = createStore({ dir: join(dir, "direct"), workers: 2 });
    const fetched = createStore({ dir: join(dir, "fetched"), fetch: globalThis.fetch, workers: 2 });
    for (const [name, bytes] of [
      ["small", small],
      ["big", big],
    ] as const) {
      const url = `${base}/${name}.tgz`;
      const one = await direct.add(url, hashOf(bytes));
      const two = await fetched.add(url, hashOf(bytes));
      expect(one.index).toEqual(two.index);
      expect(one.cached).toBe(false);
    }
    direct.close();
    fetched.close();
  });

  it("asks again when busy or cut off, and not when missing", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const hits = new Map<string, number>();
    const base = await serve((request, response) => {
      const url = request.url ?? "";
      const nth = (hits.get(url) ?? 0) + 1;
      hits.set(url, nth);
      if (url === "/missing.tgz") return void response.writeHead(404).end();
      if (url === "/busy.tgz" && nth === 1) {
        return void response.writeHead(503, { "retry-after": "0" }).end();
      }
      if (url === "/cut.tgz" && nth === 1) {
        // Headers and a few bytes, then the socket goes: an error out of the middle of the body.
        response.writeHead(200, { "content-length": String(tarball.length) });
        response.write(Buffer.from(tarball.subarray(0, 8)));
        setTimeout(() => response.socket?.destroy(), 10);
        return;
      }
      response.end(Buffer.from(tarball));
    });
    const store = (name: string) => createStore({ dir: join(dir, name), workers: 0 });
    await store("busy").add(`${base}/busy.tgz`, hashOf(tarball));
    await store("cut").add(`${base}/cut.tgz`, hashOf(tarball));
    await expect(store("missing").add(`${base}/missing.tgz`, hashOf(tarball))).rejects.toMatchObject(
      { code: "E404", status: 404 },
    );
    expect(Object.fromEntries(hits)).toEqual({ "/busy.tgz": 2, "/cut.tgz": 2, "/missing.tgz": 1 });
  });

  it("follows a redirect on its origin with the credential, and gives up on a loop", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const seen: (string | undefined)[] = [];
    const base = await serve((request, response) => {
      seen.push(request.headers.authorization);
      const to = { "/loop.tgz": "/loop.tgz", "/a.tgz": "/b.tgz", "/b.tgz": "c.tgz" }[
        request.url ?? ""
      ];
      if (to) return void response.writeHead(request.url === "/b.tgz" ? 307 : 302, { location: to }).end();
      response.end(Buffer.from(tarball));
    });
    const auth = { [`//${base.slice("http://".length)}/`]: "Bearer t" };
    await createStore({ dir, auth, workers: 0 }).add(`${base}/a.tgz`, hashOf(tarball));
    expect(seen).toEqual(["Bearer t", "Bearer t", "Bearer t"]);

    const loop = createStore({ dir: join(dir, "loop"), workers: 0 });
    await expect(loop.add(`${base}/loop.tgz`, hashOf(tarball))).rejects.toMatchObject({
      status: 302,
    });
    expect(seen).toHaveLength(3 + 21); // the first ask and twenty redirects, as fetch allows
  });

  it("drops the credential on a redirect to another origin", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    const seen: (string | undefined)[] = [];
    const elsewhere = await serve((request, response) => {
      seen.push(request.headers.authorization);
      response.end(Buffer.from(tarball));
    });
    // Same address, another port: another origin.
    const registry = await serve((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(302, { location: `${elsewhere}${request.url}` }).end();
    });
    const auth = { [`//${registry.slice("http://".length)}/`]: "Bearer t" };
    await createStore({ dir, auth, workers: 0 }).add(`${registry}/a.tgz`, hashOf(tarball));
    expect(seen).toEqual(["Bearer t", undefined]);
  });

  it("gives up on a download that goes quiet, and asks again", async () => {
    const tarball = makeTarball([{ path: "a.js", data: "alpha" }]);
    let hits = 0;
    const base = await serve((_request, response) => {
      hits++;
      response.writeHead(200, { "content-length": String(tarball.length) });
      response.write(Buffer.from(tarball.subarray(0, 8))); // then nothing
    });
    const store = createStore({ dir, workers: 0, stall: 50 });
    await expect(store.add(`${base}/quiet.tgz`, hashOf(tarball))).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(hits).toBe(5);
  });
});
