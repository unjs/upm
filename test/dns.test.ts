import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { builtin } from "../src/builtin.ts";
import { DISPATCHER, lookup } from "../src/dns.ts";

const ANSWER: LookupAddress[] = [
  { address: "10.0.0.1", family: 4 },
  { address: "10.0.0.2", family: 4 },
  { address: "10.0.0.3", family: 4 },
  { address: "fd00::1", family: 6 },
  { address: "fd00::2", family: 6 },
];

/** The resolver, answering by host; a host it does not know fails as getaddrinfo does. */
type Resolve = (
  host: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, list?: LookupAddress[]) => void,
) => void;
const RESOLVE: Resolve = (host, _options, callback) => {
  setTimeout(() => {
    if (host === "registry.test") callback(null, ANSWER);
    else callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  }, 1);
};
const resolver = vi.fn(RESOLVE);
Object.defineProperty(builtin, "dns", {
  value: { lookup: resolver, ADDRCONFIG: 32 },
  configurable: true,
});

function ask(host: string, options: object): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    lookup(host, options, (error, ...found) => (error ? reject(error) : resolve(found)));
  });
}

const addresses = (list: unknown[]) => (list[0] as LookupAddress[]).map((a) => a.address);

describe("lookup", () => {
  it("asks the resolver once per host and turns each family's list per connection", async () => {
    const [first, second, third] = await Promise.all([
      ask("registry.test", { all: true }),
      ask("registry.test", { all: true }),
      ask("registry.test", { all: true }),
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![1]).toEqual({ all: true, hints: 32 });
    expect(addresses(first!)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3", "fd00::1", "fd00::2"]);
    expect(addresses(second!)).toEqual(["10.0.0.2", "10.0.0.3", "10.0.0.1", "fd00::2", "fd00::1"]);
    expect(addresses(third!)).toEqual(["10.0.0.3", "10.0.0.1", "10.0.0.2", "fd00::1", "fd00::2"]);
    // A fourth turns on, each family by its own length; still one question to the resolver.
    expect(addresses(await ask("registry.test", { all: true }))).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
      "fd00::2",
      "fd00::1",
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("answers one address, of the family asked for", async () => {
    expect(await ask("registry.test", { family: 6 })).toEqual(["fd00::1", 6]);
    expect(await ask("registry.test", { family: 6, all: true })).toEqual([
      [
        { address: "fd00::2", family: 6 },
        { address: "fd00::1", family: 6 },
      ],
    ]);
    expect(await ask("registry.test", {})).toEqual([expect.stringMatching(/^10\.0\.0\./), 4]);
  });

  it("asks again after a second when the resolver has not answered, and takes the first answer", async () => {
    vi.useFakeTimers();
    try {
      // The first query is dropped: it comes back only after glibc's 5 s. The second answers.
      let calls = 0;
      resolver.mockImplementation((host, _options, callback) => {
        const nth = ++calls;
        setTimeout(() => callback(null, ANSWER), nth === 1 ? 5000 : 1);
      });
      const asked = ask("hedged.test", { all: true });
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(calls).toBe(2);
      expect(addresses(await asked)).toEqual([
        "10.0.0.1",
        "10.0.0.2",
        "10.0.0.3",
        "fd00::1",
        "fd00::2",
      ]);
      // The late first answer changes nothing, and the host is not asked about again.
      await vi.advanceTimersByTimeAsync(5000);
      expect(addresses(await ask("hedged.test", { all: true }))).toEqual([
        "10.0.0.2",
        "10.0.0.3",
        "10.0.0.1",
        "fd00::2",
        "fd00::1",
      ]);
      expect(calls).toBe(2);
      // A failure of the first before the second is asked is final: no second query, no wait.
      calls = 0;
      resolver.mockImplementation((host, _options, callback) => {
        calls++;
        setTimeout(() => callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), 1);
      });
      const failing = ask("gone.test", { all: true });
      failing.catch(() => {});
      await vi.advanceTimersByTimeAsync(2);
      await expect(failing).rejects.toMatchObject({ code: "ENOTFOUND" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
      resolver.mockReset();
      resolver.mockImplementation(RESOLVE);
    }
  });

  it("fails like the resolver, and asks again next time", async () => {
    await expect(ask("nowhere.test", { all: true })).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(ask("nowhere.test", { all: true })).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(resolver.mock.calls.filter(([host]) => host === "nowhere.test")).toHaveLength(2);
  });
});

describe("cacheLookups", () => {
  const global = globalThis as unknown as Record<symbol, object | undefined>;
  const before = global[DISPATCHER];
  afterEach(() => {
    global[DISPATCHER] = before;
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  // Module state (installed once) is per import: a fresh copy for each case.
  const fresh = async () => {
    const { cacheLookups, fetching } = await import("../src/dns.ts");
    return { cacheLookups, fetching };
  };
  /** What `fetching()` hands `fetch` as the dispatcher, if anything. */
  const dispatcherOf = async (fetching: () => typeof fetch) => {
    const spy = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", spy);
    await fetching()("https://example.test/", { headers: { a: "b" } });
    const [, init] = spy.mock.calls.at(-1) as unknown as [
      string,
      RequestInit & { dispatcher?: object },
    ];
    expect(init.headers).toEqual({ a: "b" }); // the caller's init travels as it was
    return init.dispatcher;
  };

  /** undici's `Agent`, from the dispatcher the first case makes; the cases run in order. */
  let Agent: new (options: object) => object;

  it("sends its requests through an agent of its own, made once, and leaves fetch's alone", async () => {
    global[DISPATCHER] = undefined; // as in a process that has not fetched yet
    const { cacheLookups, fetching } = await fresh();
    const installing = cacheLookups();
    expect(installing).toBeInstanceOf(Promise);
    await installing;
    // The probe left undici's own default in place; ours is a second one of the same class.
    const made = global[DISPATCHER] as { constructor: { name: string } } | undefined;
    expect(made?.constructor.name).toBe("Agent");
    const ours = (await dispatcherOf(fetching)) as { constructor: { name: string } };
    expect(ours.constructor.name).toBe("Agent");
    expect(ours).not.toBe(made);
    expect(global[DISPATCHER]).toBe(made);
    Agent = made!.constructor as typeof Agent;
    // In place: a caller with a request ready need not wait a tick, and gets the same agent.
    expect(cacheLookups()).toBeUndefined();
    expect(await dispatcherOf(fetching)).toBe(ours);
  });

  it("uses a dispatcher the caller configured, options and all", async () => {
    // A library caller's own agent — a proxy, custom TLS, a keep-alive policy — of the same class.
    const mine = new Agent({ connect: { rejectUnauthorized: false }, keepAliveTimeout: 1234 });
    global[DISPATCHER] = mine;
    const { cacheLookups, fetching } = await fresh();
    await cacheLookups();
    expect(global[DISPATCHER]).toBe(mine);
    expect(await dispatcherOf(fetching)).toBeUndefined(); // fetch takes theirs
    // A dispatcher of another shape too.
    class ProxyAgent {}
    const theirs = new ProxyAgent();
    global[DISPATCHER] = theirs;
    const again = await fresh();
    await again.cacheLookups();
    expect(global[DISPATCHER]).toBe(theirs);
    expect(await dispatcherOf(again.fetching)).toBeUndefined();
  });

  it("makes its agent before its first request, and not before", async () => {
    global[DISPATCHER] = undefined;
    const { cacheLookups, fetching } = await fresh();
    const request = fetching();
    expect(global[DISPATCHER]).toBeUndefined(); // nothing loaded for a run that asks nothing
    // The probe makes undici's default agent, as a first `fetch` does; nothing goes out.
    const spy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).startsWith("data:")) global[DISPATCHER] ??= new Agent({});
      return new Response("");
    });
    vi.stubGlobal("fetch", spy);
    await request("https://example.test/");
    expect(spy.mock.calls.map(([input]) => String(input))).toEqual([
      "data:,",
      "https://example.test/",
    ]);
    const [, init] = spy.mock.calls[1] as [string, RequestInit & { dispatcher?: object }];
    expect(init.dispatcher?.constructor.name).toBe("Agent");
    expect(cacheLookups()).toBeUndefined();
  });

  it("leaves things as they are when the dispatcher is not where undici keeps it", async () => {
    // A `fetch` that makes no default agent: the symbol stays unset after the probe request.
    global[DISPATCHER] = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("")),
    );
    const { cacheLookups, fetching } = await fresh();
    await cacheLookups();
    expect(global[DISPATCHER]).toBeUndefined();
    expect(cacheLookups()).toBeUndefined(); // not tried again
    expect(await dispatcherOf(fetching)).toBeUndefined();
  });

  it("makes no agent from a default it does not know", async () => {
    // The probe made something whose class is not undici's Agent: requests go out as they are.
    class ProxyAgent {}
    global[DISPATCHER] = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        global[DISPATCHER] = new ProxyAgent();
        return new Response("");
      }),
    );
    const { cacheLookups, fetching } = await fresh();
    await cacheLookups();
    expect(global[DISPATCHER]).toBeInstanceOf(ProxyAgent);
    expect(await dispatcherOf(fetching)).toBeUndefined();
  });

  it("sends no probe off Node, where there is no undici to find", async () => {
    global[DISPATCHER] = undefined;
    const bare = Object.create(process, { getBuiltinModule: { value: undefined } });
    vi.stubGlobal("process", bare);
    const { fetching } = await fresh();
    vi.unstubAllGlobals();
    const spy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response(""),
    );
    vi.stubGlobal("fetch", spy);
    await fetching()("https://example.test/");
    expect(spy.mock.calls.map(([input]) => String(input))).toEqual(["https://example.test/"]);
  });

  it("does nothing without fetch", async () => {
    vi.stubGlobal("fetch", undefined);
    global[DISPATCHER] = undefined;
    const { cacheLookups } = await fresh();
    await cacheLookups();
    expect(global[DISPATCHER]).toBeUndefined();
  });
});
