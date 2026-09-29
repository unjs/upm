import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, registryBase } from "../src/registry.ts";
import { resolveTree } from "../src/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import type { Manifest, Packument } from "../src/types.ts";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const REGISTRY = "https://registry.test";

const doc = {
  name: "foo",
  "dist-tags": { latest: "1.0.0" },
  versions: {},
} satisfies Packument;

interface Call {
  url: string;
  accept: string;
  signal?: AbortSignal | null;
}

/** Fake fetch. The handler gets the 1-based attempt number. */
function stub(handler: (call: Call, attempt: number) => Response): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const call: Call = { url: String(input), accept: headers?.accept ?? "", signal: init?.signal };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length));
  };
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Poll until `done`, a few ms at a time, for at most two seconds. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 5) {
    if (waited > 2000) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createRegistry", () => {
  it("asks for the abbreviated packument first", async () => {
    const s = stub(() => json(doc));
    const packument = await createRegistry({ registry: REGISTRY, fetch: s.fetch }).packument("foo");

    expect(packument).toEqual(doc);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.accept).toBe(CORGI);
  });

  it("falls back to plain json when the abbreviated doc is rejected", async () => {
    const s = stub((call) =>
      call.accept === CORGI ? new Response("no corgi", { status: 400 }) : json(doc),
    );
    const packument = await createRegistry({ registry: REGISTRY, fetch: s.fetch }).packument("foo");

    expect(packument).toEqual(doc);
    expect(s.calls.map((call) => call.accept)).toEqual([CORGI, "application/json"]);
  });

  it("makes one request for concurrent calls of the same name", async () => {
    const s = stub(() => json(doc));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    const [a, b] = await Promise.all([registry.packument("foo"), registry.packument("foo")]);

    expect(s.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(await registry.packument("foo")).toBe(a);
    expect(s.calls).toHaveLength(1);
  });

  it("memoizes per name, not globally", async () => {
    const s = stub(() => json(doc));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    await Promise.all([registry.packument("foo"), registry.packument("bar")]);

    expect(s.calls.map((call) => call.url)).toEqual([
      "https://registry.test/foo",
      "https://registry.test/bar",
    ]);
  });

  it("does not memoize a failure", async () => {
    const s = stub((_call, attempt) => (attempt === 1 ? json(doc, 404) : json(doc)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("E404");
    expect(await registry.packument("foo")).toEqual(doc);
  });

  it("escapes the slash in a scoped name", async () => {
    const s = stub(() => json(doc));
    await createRegistry({ registry: REGISTRY, fetch: s.fetch }).packument("@scope/foo");

    expect(s.calls[0]?.url).toBe("https://registry.test/@scope%2ffoo");
  });

  it("rejects a name that is not a package name", async () => {
    const s = stub(() => json(doc));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("../evil"))).toBe("EINVALIDSPEC");
    expect(s.calls).toHaveLength(0);
  });

  it("does not double the slash on a trailing-slash registry", async () => {
    const s = stub(() => json(doc));
    await createRegistry({ registry: "https://registry.test/", fetch: s.fetch }).packument("foo");

    expect(s.calls[0]?.url).toBe("https://registry.test/foo");
  });

  it("throws E404 and does not retry it", async () => {
    const s = stub(() => new Response("not found", { status: 404 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("E404");
    expect(s.calls).toHaveLength(1);
  });

  it("retries a 500 to the attempt limit then throws EREGISTRY", async () => {
    const s = stub(() => new Response("boom", { status: 503 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("EREGISTRY");
    expect(s.calls).toHaveLength(5);
    expect(s.calls.every((call) => call.accept === CORGI)).toBe(true);
  });

  it("recovers when a 500 is followed by a good response", async () => {
    const s = stub((_call, attempt) =>
      attempt === 1 ? new Response("boom", { status: 500 }) : json(doc),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.packument("foo")).toEqual(doc);
    expect(s.calls).toHaveLength(2);
  });

  it("codes a real network failure and retries it", async () => {
    const calls: string[] = [];
    // `fetch` rejects with an uncoded TypeError, so the client must supply the code.
    const failing: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.reject(new TypeError("fetch failed"));
    };
    const registry = createRegistry({ registry: REGISTRY, fetch: failing });

    expect(await codeOf(registry.packument("foo"))).toBe("ENETWORK");
    expect(calls).toHaveLength(5);
  });

  it("codes a timeout separately", async () => {
    const failing: typeof fetch = () =>
      Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const registry = createRegistry({ registry: REGISTRY, fetch: failing });

    expect(await codeOf(registry.packument("foo"))).toBe("ETIMEDOUT");
  });

  it("passes an abort signal so a dead socket cannot hang the install", async () => {
    const s = stub(() => json(doc));
    await createRegistry({ registry: REGISTRY, fetch: s.fetch }).packument("foo");

    expect(s.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["malformed json", "{oops"],
    ["an empty body", ""],
    ["an html login page", "<html>login</html>"],
    ["a null body", "null"],
    ["an array body", "[]"],
  ])("throws EJSONPARSE on %s", async (_label, payload) => {
    const s = stub(() => new Response(payload, { status: 200 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("EJSONPARSE");
    expect(s.calls).toHaveLength(1);
  });

  it("retries a 429 instead of failing at once", async () => {
    const s = stub(() => new Response("slow down", { status: 429 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("EREGISTRY");
    expect(s.calls).toHaveLength(5);
  });

  it("does not retry or re-ask a 401", async () => {
    const s = stub(() => new Response("nope", { status: 401 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.packument("foo"))).toBe("EREGISTRY");
    expect(s.calls).toHaveLength(1);
  });

  it("shares one slow in-flight request between many callers", async () => {
    let calls = 0;
    const slow: typeof fetch = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json(doc);
    };
    const registry = createRegistry({ registry: REGISTRY, fetch: slow });

    const results = await Promise.all(Array.from({ length: 20 }, () => registry.packument("foo")));

    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });
});

describe("pick over a document's text", () => {
  const entry = (version: string) =>
    JSON.stringify({ name: "foo", version, dist: { tarball: `${REGISTRY}/foo-${version}.tgz` } });

  it("answers as the whole parse does when the registry wrote `versions` twice", async () => {
    // `JSON.parse` keeps the second; an index of the first would call 1.1.0 missing.
    const text = `{"name":"foo","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":${entry("1.0.0")}},"versions":{"1.0.0":${entry("1.0.0")},"1.1.0":${entry("1.1.0")}}}`;
    const s = stub((call) =>
      call.url.endsWith("/foo") ? new Response(text) : new Response("", { status: 404 }),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    expect((await registry.pick!(parseSpec("foo@1.1.0"))).version).toBe("1.1.0");
    expect((await registry.pick!(parseSpec("foo@>1.0.0"))).version).toBe("1.1.0");
  });

  it("parses only the manifests a range reads, and fails on one it cannot", async () => {
    const pick = (text: string, spec: string) =>
      createRegistry({ registry: REGISTRY, fetch: stub(() => new Response(text)).fetch }).pick!(
        parseSpec(spec),
      );
    // An older version no pick reads goes unparsed, so its damage goes unseen.
    const old = `{"name":"foo","dist-tags":{},"versions":{"1.0.0":{oops},"1.1.0":${entry("1.1.0")}}}`;
    expect((await pick(old, "foo@^1")).version).toBe("1.1.0");
    // The one a pick wants is an error, never the next one down.
    const wanted = `{"name":"foo","dist-tags":{},"versions":{"1.0.0":${entry("1.0.0")},"1.1.0":{oops}}}`;
    expect(await codeOf(pick(wanted, "foo@^1"))).toBe("EJSONPARSE");
    expect((await pick(wanted, "foo@~1.0")).version).toBe("1.0.0");
  });
});

describe("registryBase", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("strips every trailing slash, so a derived tarball url has exactly one", () => {
    expect(registryBase(`${REGISTRY}///`)).toBe(REGISTRY);
    expect(registryBase(REGISTRY)).toBe(REGISTRY);
  });

  it("is the base the client itself requests against", () => {
    const { fetch } = stub(() => json(doc));
    const registry = createRegistry({ registry: `${REGISTRY}/`, fetch });
    expect(registry.base).toBe(registryBase(`${REGISTRY}/`));
  });

  it("falls back to npmjs; the environment is the CLI's business (src/config.ts)", () => {
    process.env.npm_config_registry = "https://a.test/";
    expect(registryBase()).toBe("https://registry.npmjs.org");
    expect(registryBase("https://explicit.test/")).toBe("https://explicit.test");
  });
});

/** `foo` and `@s/foo` alike, each in its own document. Scoped names read the packument first. */
const one = { name: "foo", version: "1.0.0", dist: { tarball: "t" } } satisfies Manifest;
const small = { ...doc, versions: { "1.0.0": one } } satisfies Packument;
/** Comfortably over the cutoff, and only the size matters. */
const fat = {
  ...doc,
  versions: { "1.0.0": { ...one, deprecated: "x".repeat(3_000_000) } },
} satisfies Packument;
const two = { ...one, version: "2.0.0" } satisfies Manifest;
const scoped = { ...small, name: "@s/foo" } satisfies Packument;
const route = (call: Call) => call.url.endsWith("/1.0.0");
const urls = (calls: Call[]) => calls.map((call) => call.url.slice(REGISTRY.length));

describe("manifest", () => {
  it("reads a scoped name's version out of the full packument", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(small)));
    const got = await createRegistry({ registry: REGISTRY, fetch: s.fetch }).manifest(
      "@s/foo",
      "1.0.0",
    );

    // The packument is a CDN hit where a scoped per-version document is served by the origin.
    expect(got).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo"]);
    expect(s.calls[0]?.accept).toBe("application/json");
  });

  it("asks an unscoped name's per-version route first", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.manifest("foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/foo/1.0.0"]);
    expect(s.calls[0]?.accept).toBe("application/json");
  });

  it("asks a scoped name's per-version route when the packument is over the cutoff", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
  });

  it("starts the route while a document is still being read, once it looks too big", async () => {
    // A document streamed in 512 KiB pieces, so the read passes the halfway mark with more
    // to come: the route is asked then, and the abandoned read finds it already answered.
    const text = JSON.stringify(fat);
    const slow = () => {
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (at >= text.length) return controller.close();
          controller.enqueue(new TextEncoder().encode(text.slice(at, at + 512 * 1024)));
          at += 512 * 1024;
        },
      });
      return new Response(stream, { status: 200 });
    };
    const s = stub((call) => (route(call) ? json(one) : slow()));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(s.calls).toHaveLength(2); // the route is memoized, and the full document skipped
  });

  it("asks the route as well when a scoped pin's document is slow to answer", async () => {
    // The document's headers never come until the test lets them: past the late mark the route
    // is asked, and its answer is the pin's, with the document still on the way.
    let release!: (response: Response) => void;
    const held = new Promise<Response>((r) => (release = r));
    const s = stub((call) => (route(call) ? json(one) : (held as never)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    const found = registry.pinned("@s/foo", "1.0.0");
    await until(() => s.calls.length === 2);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
    expect(await found).toEqual(one); // the route's answer, not the document's
    // The document is still read: a range on the name finds it, and asks for nothing.
    release(json(small));
    expect((await registry.view("@s/foo")).version("1.0.0")).toEqual(small.versions["1.0.0"]);
    expect(s.calls).toHaveLength(2);
  });

  it("skips the full packument when the abbreviated one `pinned` read says it would be abandoned", async () => {
    // 1 MB abbreviated: read whole by `pinned`, but the full document is ~2.3x that and
    // would only be read to the cutoff and dropped for the route. So the route, at once.
    const wide = {
      ...doc,
      versions: { "1.0.0": { ...one, deprecated: "x".repeat(1_000_000) } },
    } satisfies Packument;
    const s = stub((call) => (route(call) ? json(one) : json(call.accept === CORGI ? wide : fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(wide.versions["1.0.0"]);
    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
    expect(s.calls.map((call) => call.accept)).toEqual([CORGI, "application/json"]);
  });

  it("skips the full packument when the abbreviated one was itself over the cutoff", async () => {
    // `pinned` read a megabyte of the abbreviated document and took the route; the full one
    // is bigger still, so `manifest` is the memoized route and no second megabyte.
    const s = stub((call) => (route(call) ? json(one) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
  });

  it("reads the full packument when the abbreviated one read whole is small", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo"]);
    expect(s.calls.map((call) => call.accept)).toEqual([CORGI, "application/json"]);
  });

  it("shares one request between concurrent callers", async () => {
    let calls = 0;
    const s = stub(() => {
      calls++;
      return json(small);
    });
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    await Promise.all(Array.from({ length: 10 }, () => registry.manifest("foo", "1.0.0")));
    await Promise.all(Array.from({ length: 10 }, () => registry.manifest("@s/foo", "1.0.0")));

    expect(calls).toBe(2);
  });

  it("reads the whole document when the peek failed and the route is missing", async () => {
    // The peek has no retry, so a 503 there is one answer; the route 404s; then the document.
    let peeked = false;
    const s = stub((call) => {
      if (route(call)) return new Response("nope", { status: 404 });
      if (peeked) return json(small);
      peeked = true;
      return new Response("boom", { status: 503 });
    });
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.manifest("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0", "/@s%2ffoo"]);
    expect(s.calls.every((call) => call.accept === "application/json")).toBe(true);
  });

  it("reads an unscoped name's packument when the route is missing", async () => {
    const s = stub((call) => (route(call) ? new Response("nope", { status: 404 }) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.manifest("foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/foo/1.0.0", "/foo"]);
  });

  it("asks the route once when a packument read whole lacks the version, then throws E404", async () => {
    const s = stub((call) =>
      call.url.endsWith("/2.0.0") ? new Response("nope", { status: 404 }) : json(small),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.manifest("@s/foo", "2.0.0"))).toBe("E404");
    expect(await codeOf(registry.manifest("@s/foo", "2.0.0"))).toBe("E404");
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/2.0.0"]);
  });

  it("finds a version newer than the CDN's packument on the route, once for pinned and manifest", async () => {
    const s = stub((call) => (call.url.endsWith("/2.0.0") ? json(two) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "2.0.0")).toEqual(two);
    expect(await registry.manifest("@s/foo", "2.0.0")).toEqual(two);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/2.0.0", "/@s%2ffoo"]);
  });

  it("throws E404 when no route has the version", async () => {
    const s = stub((call) =>
      call.url.endsWith("/2.0.0") ? new Response("nope", { status: 404 }) : json(fat),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.manifest("foo", "2.0.0"))).toBe("E404");
    expect(await codeOf(registry.manifest("@s/foo", "2.0.0"))).toBe("E404");
  });

  it("does not fall back to the full document on a server error from the route", async () => {
    const s = stub(() => new Response("boom", { status: 503 }));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await codeOf(registry.manifest("foo", "1.0.0"))).toBe("EREGISTRY");
    expect(s.calls).toHaveLength(5); // five tries at the route, nothing else
    expect(s.calls.every(route)).toBe(true);
  });
});

describe("pinned", () => {
  it("reads a scoped name's abbreviated packument, not the per-version route", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo"]);
    expect(s.calls[0]?.accept).toBe(CORGI);
  });

  it("asks an unscoped name's per-version route, not the packument", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/foo/1.0.0"]);
    expect(s.calls[0]?.accept).toBe("application/json");
  });

  it("reads the version out of a packument a range already asked for, whichever came first", async () => {
    const s = stub((call) => (call.url.endsWith("/2.0.0") ? json(two) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    // Started by the range, still on its way: the pin waits for it rather than take the route.
    const [seen, pinned] = await Promise.all([
      registry.view("foo"),
      registry.pinned("foo", "1.0.0"),
    ]);
    expect(seen.version("1.0.0")).toEqual(one);
    expect(pinned).toEqual(one);
    expect(urls(s.calls)).toEqual(["/foo"]);
    // A version the document lacks is still the route's to answer.
    expect(await registry.pinned("foo", "2.0.0")).toEqual(two);
    expect(urls(s.calls)).toEqual(["/foo", "/foo/2.0.0"]);
    // The same for a scoped name whose pin came first and read the document.
    const t = stub((call) => (route(call) ? json(one) : json(scoped)));
    const other = createRegistry({ registry: REGISTRY, fetch: t.fetch });
    expect(await other.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect((await other.view("@s/foo")).version("1.0.0")).toEqual(one);
    expect(await other.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(t.calls)).toEqual(["/@s%2ffoo"]);
  });

  it("takes a scoped name's per-version route past the cutoff", async () => {
    const s = stub((call) => (route(call) ? json(one) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
    expect(s.calls[1]?.accept).toBe("application/json");
  });

  it("falls back to the packument for an unscoped name whose route is missing", async () => {
    const s = stub((call) => (route(call) ? new Response("nope", { status: 404 }) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/foo/1.0.0", "/foo"]);
    expect(s.calls[1]?.accept).toBe(CORGI);
  });

  it("answers undefined past the cutoff for a registry that does not serve per-version", async () => {
    const s = stub((call) => (route(call) ? new Response("nope", { status: 404 }) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("foo", "1.0.0")).toBeUndefined();
    expect(await registry.pinned("@s/foo", "1.0.0")).toBeUndefined();
  });

  it("keeps a packument it did read for a later caller", async () => {
    const s = stub((call) => (route(call) ? new Response("nope", { status: 404 }) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    await registry.pinned("@s/foo", "1.0.0");
    await registry.pinned("foo", "1.0.0");
    expect(await registry.packument("@s/foo")).toEqual(small);
    expect(await registry.packument("foo")).toEqual(small);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/foo/1.0.0", "/foo"]);
  });

  it("never widens to the full document", async () => {
    const s = stub((call) => (route(call) ? new Response("nope", { status: 404 }) : json(fat)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toBeUndefined();
    expect(await registry.pinned("foo", "1.0.0")).toBeUndefined();
    expect(s.calls.every((call) => call.accept !== "application/json" || route(call))).toBe(true);
  });

  it("asks the route for a version a scoped packument read whole lacks: the CDN copy can trail a publish", async () => {
    const s = stub((call) => (call.url.endsWith("/2.0.0") ? json(two) : json(small)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "2.0.0")).toEqual(two);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/2.0.0"]);
    expect(s.calls[1]?.accept).toBe("application/json");
    // The version it does hold costs nothing more.
    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(s.calls).toHaveLength(2);
  });

  it("answers undefined once the route has no such version either, asking each once", async () => {
    const s = stub((call) =>
      call.url.endsWith("/2.0.0") ? new Response("nope", { status: 404 }) : json(small),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "2.0.0")).toBeUndefined();
    expect(await registry.pinned("@s/foo", "2.0.0")).toBeUndefined();
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/2.0.0"]);
  });

  it("resolves a scoped exact pin the packument lacks, and fails ETARGET only when the route lacks it too", async () => {
    const fresh = { ...two, name: "@s/foo", dist: { tarball: "t", integrity: "sha512-x" } };
    const s = stub((call) => (call.url.endsWith("/2.0.0") ? json(fresh) : json(scoped)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    const out = await resolveTree({ dependencies: { "@s/foo": "2.0.0" } }, { registry });
    expect(Object.keys(out.packages)).toEqual(["@s/foo@2.0.0"]);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/2.0.0"]);

    const miss = stub((call) =>
      call.url.endsWith("/3.0.0") ? new Response("nope", { status: 404 }) : json(scoped),
    );
    const stale = createRegistry({ registry: REGISTRY, fetch: miss.fetch });
    await expect(
      resolveTree({ dependencies: { "@s/foo": "3.0.0" } }, { registry: stale }),
    ).rejects.toMatchObject({ code: "ETARGET" });
    expect(urls(miss.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/3.0.0"]);
  });

  it("shares one read between concurrent callers", async () => {
    let calls = 0;
    const s = stub(() => {
      calls++;
      return json(small);
    });
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    await Promise.all(Array.from({ length: 10 }, () => registry.pinned("@s/foo", "1.0.0")));

    expect(calls).toBe(1);
  });

  it("does not retry the peek, having had its one answer refused", async () => {
    // The peek reads a 503 and gives up rather than retrying; the route 404s.
    const s = stub((call) =>
      route(call) ? new Response("nope", { status: 404 }) : new Response("boom", { status: 503 }),
    );
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toBeUndefined();
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
  });
});

describe("createRegistry concurrency", () => {
  it("never has more requests in flight than the ceiling allows", async () => {
    let open = 0;
    let peak = 0;
    const slow: typeof fetch = async (input) => {
      peak = Math.max(peak, ++open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open--;
      const name = String(input).slice(REGISTRY.length + 1);
      return json({ name, "dist-tags": { latest: "1.0.0" }, versions: {} });
    };
    const registry = createRegistry({ registry: REGISTRY, fetch: slow, concurrency: 4 });

    await Promise.all(Array.from({ length: 24 }, (_, i) => registry.packument(`p${i}`)));

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps asking for less once the registry has said 429", async () => {
    // Each request is throttled once and then served, so from outside every call succeeds.
    // The gate is the only thing that can tell, and what it does about it is ask for fewer —
    // measured on a later, healthy batch, so what is seen is the gate and not a queue winding
    // down.
    const seen = new Map<string, number>();
    let open = 0;
    let peak = 0;
    let busy = true;
    const registry = createRegistry({
      registry: REGISTRY,
      concurrency: 16,
      fetch: async (input) => {
        const url = String(input);
        const nth = (seen.get(url) ?? 0) + 1;
        seen.set(url, nth);
        peak = Math.max(peak, ++open);
        await new Promise((resolve) => setTimeout(resolve, 2));
        open--;
        if (busy && nth === 1) return new Response("slow down", { status: 429 });
        return json({ name: url.slice(REGISTRY.length + 1), "dist-tags": {}, versions: {} });
      },
    });

    await Promise.all(Array.from({ length: 20 }, (_, i) => registry.packument(`busy${i}`)));
    busy = false;
    peak = 0;
    await Promise.all(Array.from({ length: 60 }, (_, i) => registry.packument(`well${i}`)));

    expect(peak).toBeLessThanOrEqual(4); // the floor, reached by halving 16 four times
  });

  it("starts at 16 by default and grows toward 32 on a registry that keeps up", async () => {
    let open = 0;
    let peak = 0;
    let first = 0;
    const registry = createRegistry({
      registry: REGISTRY,
      fetch: async (input) => {
        peak = Math.max(peak, ++open);
        // Constant latency: nothing to read as drift, so every contended success grows it.
        await new Promise((resolve) => setTimeout(resolve, 2));
        open--;
        return json({
          name: String(input).slice(REGISTRY.length + 1),
          "dist-tags": {},
          versions: {},
        });
      },
    });
    const batch = (n: number, from: number) =>
      Promise.all(Array.from({ length: n }, (_, i) => registry.packument(`grow${from + i}`)));
    await batch(16, 0);
    first = peak;
    await batch(200, 16);
    expect(first).toBe(16);
    expect(peak).toBeGreaterThan(16);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it("hears a 429 answered to a peek, which has no retry to hide it", async () => {
    let open = 0;
    let peak = 0;
    let busy = true;
    const registry = createRegistry({
      registry: REGISTRY,
      concurrency: 16,
      fetch: async (input) => {
        const url = String(input);
        peak = Math.max(peak, ++open);
        await new Promise((resolve) => setTimeout(resolve, 2));
        open--;
        // Drive everything onto the peek, which is where a 429 has no retry to hide it.
        if (url.includes("/1.0.0")) return new Response("nope", { status: 404 });
        if (busy) return new Response("slow down", { status: 429 });
        const name = url.slice(url.lastIndexOf("/") + 1);
        return json({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { name, version: "1.0.0", dist: { tarball: "t" } } },
        });
      },
    });

    await Promise.all(Array.from({ length: 20 }, (_, i) => registry.pinned(`p${i}`, "1.0.0")));
    busy = false;
    peak = 0;
    await Promise.all(Array.from({ length: 60 }, (_, i) => registry.pinned(`q${i}`, "1.0.0")));

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("waits as long as the registry asked, not as long as it guessed", async () => {
    // Three tries 100 ms apart all land inside the one second a server just asked us to skip,
    // which is how a retry that looks correct still fails every time.
    const at: number[] = [];
    const registry = createRegistry({
      registry: REGISTRY,
      fetch: async () => {
        at.push(Date.now());
        if (at.length === 1) {
          return new Response("slow down", { status: 429, headers: { "retry-after": "0.3" } });
        }
        return json({ name: "p", "dist-tags": {}, versions: {} });
      },
    });

    await registry.packument("p");

    expect(at).toHaveLength(2);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(250); // not the 100 ms guess
  });
});

describe("view", () => {
  const two = { ...one, version: "2.0.0" } satisfies Manifest;
  const wide = {
    ...doc,
    "dist-tags": { latest: "2.0.0", next: "1.0.0" },
    versions: { "1.0.0": one, "2.0.0": two },
  } satisfies Packument;

  it("reads tags and one version out of the text, and the whole document on demand", async () => {
    const s = stub(() => json(wide));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });
    const view = await registry.view("foo");

    expect(view.tags()).toEqual(wide["dist-tags"]);
    expect(view.version("2.0.0")).toEqual(two);
    expect(view.version("3.0.0")).toBeUndefined();
    expect(view.whole()).toEqual(wide);
    // One document behind both, read once.
    expect(await registry.packument("foo")).toBe(view.whole());
    expect(s.calls).toHaveLength(1);
  });

  it("answers a garbage document's members with nothing, and `whole()` with EJSONPARSE", async () => {
    const s = stub(() => new Response("<html>login</html>", { status: 200 }));
    const view = await createRegistry({ registry: REGISTRY, fetch: s.fetch }).view("foo");

    expect(view.tags()).toEqual({});
    expect(view.version("1.0.0")).toBeUndefined();
    expect(() => view.whole()).toThrow(/invalid JSON/);
  });

  it("lets `pinned` take the route past a scoped name's garbage packument, as before", async () => {
    const s = stub((call) => (route(call) ? json(one) : new Response("<html>", { status: 200 })));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch });

    expect(await registry.pinned("@s/foo", "1.0.0")).toEqual(one);
    expect(urls(s.calls)).toEqual(["/@s%2ffoo", "/@s%2ffoo/1.0.0"]);
  });
});

describe("before", () => {
  const FULL = "application/json";
  const DAY = 86_400_000;
  const now = Date.now();
  const at = (days: number) => new Date(now - days * DAY).toISOString();
  const man = (version: string): Manifest => ({
    name: "foo",
    version,
    dist: { tarball: `${REGISTRY}/foo/-/foo-${version}.tgz`, integrity: "sha512-x" },
  });
  const corgi = (modified?: string) => ({
    name: "foo",
    "dist-tags": { latest: "2.0.0" },
    versions: { "1.0.0": man("1.0.0"), "1.1.0": man("1.1.0"), "2.0.0": man("2.0.0") },
    ...(modified && { modified }),
  });
  const time = { "1.0.0": at(30), "1.1.0": at(3), "2.0.0": at(0.1) };
  const serve = (doc: object, full: object = { ...doc, time }) =>
    stub((call) => {
      const version = /\/foo\/([\d.]+)$/.exec(call.url)?.[1];
      return json(version ? man(version) : call.accept === FULL ? full : doc);
    });
  const cutoff = now - DAY;

  it("hides versions newer than the cutoff and moves the tag, reading dates once", async () => {
    const s = serve(corgi(at(0.1)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch, before: cutoff });
    const view = await registry.view("foo");

    expect(view.tags()).toEqual({ latest: "1.1.0" });
    expect(view.version("2.0.0")).toBeUndefined();
    const picked = await resolveTree({ dependencies: { foo: "*" } }, { registry });
    expect(Object.keys(picked.packages)).toEqual(["foo@1.1.0"]);
    expect(s.calls.map((call) => call.accept)).toEqual([CORGI, FULL]);
  });

  it("asks nothing more of a document untouched since the cutoff", async () => {
    const s = serve(corgi(at(2)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch, before: cutoff });

    expect((await registry.view("foo")).tags()).toEqual({ latest: "2.0.0" });
    expect(s.calls).toHaveLength(1);
  });

  it("reads the dates when the document has no `modified`, and passes one with no `time`", async () => {
    const s = serve(corgi(), corgi());
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch, before: cutoff });

    expect((await registry.view("foo")).tags()).toEqual({ latest: "2.0.0" });
    expect(s.calls.map((call) => call.accept)).toEqual([CORGI, FULL]);
  });

  it("leaves an excluded name, or one a glob matches, alone", async () => {
    const scoped = { ...corgi(at(0.1)), name: "@acme/foo" };
    for (const exclude of [["foo", "@acme/foo"], ["fo?", "@acme/*"], ["**"]]) {
      const s = serve(corgi(at(0.1)));
      const t = serve(scoped);
      const one = createRegistry({ registry: REGISTRY, fetch: s.fetch, before: cutoff, exclude });
      const two = createRegistry({ registry: REGISTRY, fetch: t.fetch, before: cutoff, exclude });
      expect((await one.view("foo")).tags()).toEqual({ latest: "2.0.0" });
      expect((await two.view("@acme/foo")).tags()).toEqual({ latest: "2.0.0" });
      expect(s.calls.length + t.calls.length).toBe(2);
    }
    // `*` stays within a segment, and the rest of a pattern is literal.
    const s = serve({ ...corgi(at(0.1)), name: "@acme/foo" });
    const exclude = ["*", "@acme.foo"];
    const registry = createRegistry({
      registry: REGISTRY,
      fetch: s.fetch,
      before: cutoff,
      exclude,
    });
    expect((await registry.view("@acme/foo")).tags()).toEqual({ latest: "1.1.0" });
  });

  it("never filters a pinned version", async () => {
    const s = serve(corgi(at(0.1)));
    const registry = createRegistry({ registry: REGISTRY, fetch: s.fetch, before: cutoff });

    expect(await registry.pinned("foo", "2.0.0")).toEqual(man("2.0.0"));
    const picked = await resolveTree({ dependencies: { foo: "2.0.0" } }, { registry });
    expect(Object.keys(picked.packages)).toEqual(["foo@2.0.0"]);
  });

  it("fails a range only newer versions fit with the cutoff in the message", async () => {
    const registry = createRegistry({
      registry: REGISTRY,
      fetch: serve(corgi(at(0.1))).fetch,
      before: cutoff,
    });
    await expect(resolveTree({ dependencies: { foo: "^2.0.0" } }, { registry })).rejects.toThrow(
      /No version of foo@\^2.0.0 published before .*min-release-age/,
    );
  });
});
