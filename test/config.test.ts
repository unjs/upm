import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envConfig, parseNpmrc, readConfig, toConfig } from "../src/config.ts";
import { authFor, createRegistry } from "../src/registry.ts";
import { createStore } from "../src/store.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

const NPM = "https://registry.npmjs.org";
const DAY = 86_400_000;
const DEFAULTS = {
  registry: NPM,
  scopes: {},
  auth: {},
  saveExact: false,
  before: expect.any(Number),
  releaseAgeExclude: [],
  offline: false,
};

describe("parseNpmrc", () => {
  it("reads key=value lines and skips comments, blanks and sections", () => {
    const text = [
      "# a comment",
      "; another",
      "",
      "[section]",
      "registry = https://r.test/ # the mirror",
      "save-exact",
      'always-auth="true"',
      "@acme:registry=https://acme.test/npm/;inline",
      'quoted="a ; b # c"',
      "//r.test/:_authToken=abc#def",
      "empty=",
    ].join("\r\n");
    expect(parseNpmrc(text, {})).toEqual({
      registry: "https://r.test/",
      "save-exact": "true",
      "always-auth": "true",
      "@acme:registry": "https://acme.test/npm/",
      quoted: "a ; b # c",
      "//r.test/:_authtoken": "abc",
      empty: "",
    });
  });

  it("refuses a credential with no url, as npm does", () => {
    // It would go to whichever registry wins, and a cloned project's .npmrc can name one.
    expect(() => parseNpmrc("registry=https://r.test\n_authToken=top", {})).toThrow(
      "_authToken in .npmrc must be keyed by its registry: //host/path/:_authToken",
    );
    expect(() => parseNpmrc("_auth=b", {})).toThrow("_auth in .npmrc");
    expect(() => parseNpmrc("username=u\n_password=cA==", {})).toThrow("username in .npmrc");
    expect(parseNpmrc("_authToken=", {})).toEqual({ _authtoken: "" });
  });

  it("expands ${VAR} from the environment the way npm does", () => {
    const env = { TOKEN: "abc", EMPTY: "" };
    const read = (value: string) => parseNpmrc(`k=${value}`, env).k;
    expect(read("${TOKEN}")).toBe("abc");
    expect(read("x-${TOKEN}-${EMPTY}-y")).toBe("x-abc--y");
    // Unset: left as written, unless `?` asks for nothing instead.
    expect(read("${NOPE}")).toBe("${NOPE}");
    expect(read("${NOPE?}")).toBe("");
    expect(read("${TOKEN?}")).toBe("abc");
    // A backslash keeps the `$`; two are one backslash and the value.
    expect(read("\\${TOKEN}")).toBe("${TOKEN}");
    expect(read("\\\\${TOKEN}")).toBe("\\abc");
  });

  it("lowercases keys but not a credential's url", () => {
    expect(parseNpmrc("Save-Exact=true\n//R.test/Path/:_AuthToken=t", {})).toEqual({
      "save-exact": "true",
      "//R.test/Path/:_authtoken": "t",
    });
  });
});

describe("envConfig", () => {
  it("reads npm_config_* in any case, with underscores as dashes", () => {
    const env = {
      npm_config_registry: "https://a.test",
      NPM_CONFIG_SAVE_EXACT: "true",
      "npm_config_//r.test/:_authToken": "t",
      npm_config_empty: "",
      PATH: "/bin",
    };
    expect(envConfig(env)).toEqual({
      registry: "https://a.test",
      "save-exact": "true",
      "//r.test/:_authtoken": "t",
    });
  });

  it("ignores a credential with no url, as npm does", () => {
    // Not an error as in a file: an old CI image may still export one.
    expect(envConfig({ npm_config__authToken: "t", NPM_CONFIG__AUTH: "b" })).toEqual({});
  });

  it("takes UPM_REGISTRY when npm did not set a registry", () => {
    expect(envConfig({ UPM_REGISTRY: "https://b.test" })).toEqual({ registry: "https://b.test" });
    expect(
      envConfig({ UPM_REGISTRY: "https://b.test", npm_config_registry: "https://a.test" }),
    ).toEqual({
      registry: "https://a.test",
    });
  });
});

describe("release age", () => {
  /** How many days before now the cutoff is, to the minute. */
  const age = (before?: number) =>
    before === undefined ? undefined : Math.round(((Date.now() - before) / DAY) * 1440) / 1440;

  it("holds back versions under a day old unless a layer says otherwise", () => {
    expect(age(toConfig([]).before)).toBe(1);
    expect(age(toConfig([{ "min-release-age": "7" }]).before)).toBe(7);
    expect(age(toConfig([{ "min-release-age": "0.5" }]).before)).toBe(0.5);
    expect(toConfig([{ "min-release-age": "0" }]).before).toBeUndefined();
  });

  it("takes a layer's before over its own min-release-age, and a higher layer over both", () => {
    const date = "2025-01-02T03:04:05.000Z";
    expect(toConfig([{ before: date, "min-release-age": "3" }]).before).toBe(Date.parse(date));
    expect(age(toConfig([{ before: date }, { "min-release-age": "3" }]).before)).toBe(3);
    expect(toConfig([{ "min-release-age": "3" }, { before: date }]).before).toBe(Date.parse(date));
    expect(toConfig([{ before: date }, { "min-release-age": "0" }]).before).toBeUndefined();
    // An empty value is no value, as for every other key.
    expect(age(toConfig([{ "min-release-age": "3" }, { "min-release-age": "" }]).before)).toBe(3);
  });

  it("refuses what is not a number of days or a date", () => {
    expect(() => toConfig([{ "min-release-age": "a week" }])).toThrow(/min-release-age/);
    expect(() => toConfig([{ "min-release-age": "-1" }])).toThrow(/min-release-age/);
    expect(() => toConfig([{ before: "someday" }])).toThrow(/before/);
  });

  it("reads the exclude list from key[] lines or commas, the highest layer winning", () => {
    const file = parseNpmrc(
      "min-release-age-exclude[]=@acme/*\nmin-release-age-exclude[]=own, @acme/*\n",
    );
    expect(file).toEqual({ "min-release-age-exclude": "@acme/*,own, @acme/*" });
    expect(toConfig([file]).releaseAgeExclude).toEqual(["@acme/*", "own"]);
    expect(toConfig([file, { "min-release-age-exclude": "x" }]).releaseAgeExclude).toEqual(["x"]);
  });

  it("comes from npm's environment names and the flag, the flag last", () => {
    const env = envConfig({
      npm_config_min_release_age: "3",
      npm_config_min_release_age_exclude: "a,b",
    });
    expect(env).toEqual({ "min-release-age": "3", "min-release-age-exclude": "a,b" });
    expect(age(toConfig([env]).before)).toBe(3);
    expect(toConfig([env]).releaseAgeExclude).toEqual(["a", "b"]);
  });
});

describe("toConfig", () => {
  it("defaults to npmjs with nothing configured", () => {
    expect(toConfig([])).toEqual(DEFAULTS);
  });

  it("lets a later layer win per key, and the flag win the registry alone", () => {
    const user = { registry: "https://user.test/", "@a:registry": "https://a-user.test" };
    const project = { registry: "https://project.test", "@b:registry": "https://b.test/" };
    const config = toConfig([user, project], "https://flag.test/");
    expect(config.registry).toBe("https://flag.test");
    expect(config.scopes).toEqual({ "@a": "https://a-user.test", "@b": "https://b.test" });
    expect(toConfig([user, project]).registry).toBe("https://project.test");
    // An empty value in a later layer is no value.
    expect(toConfig([user, { registry: "", "@a:registry": "" }]).registry).toBe(
      "https://user.test",
    );
    expect(toConfig([user, { "@a:registry": "" }]).scopes).toEqual({ "@a": "https://a-user.test" });
  });

  it("makes a header of each credential form, in npm's order of preference", () => {
    const pair = `Basic ${Buffer.from("user:pässword").toString("base64")}`;
    const config = toConfig([
      {
        "//token.test/:_authtoken": "t",
        "//basic.test/:_auth": "dXNlcjpwYXNz",
        "//pair.test/npm/:username": "user",
        "//pair.test/npm/:_password": Buffer.from("pässword").toString("base64"),
        "//all.test/:_authtoken": "t",
        "//all.test/:_auth": "b",
        "//all.test/:username": "user",
        "//all.test/:_password": "cA==",
        "//both.test/:_auth": "b",
        "//both.test/:username": "user",
        "//both.test/:_password": Buffer.from("pässword").toString("base64"),
        "//half.test/:username": "alone",
        "//unset.test/:_authtoken": "",
      },
    ]);
    expect(config.auth).toEqual({
      "//token.test/": "Bearer t",
      "//basic.test/": "Basic dXNlcjpwYXNz",
      "//pair.test/npm/": pair,
      "//all.test/": "Bearer t",
      // `_auth` before the pair: it is what npm-registry-fetch puts on the wire.
      "//both.test/": "Basic b",
    });
  });

  it("lets a registry's credential cover the rest of its host, as npm does", () => {
    // Some registries serve tarballs beside the registry path, not under it.
    const auth = toConfig([
      { registry: "https://r.test/npm", "//r.test/npm/:_authtoken": "t" },
      { "@a:registry": "https://a.test/x/", "//a.test/x/:_authtoken": "a" },
      { "@b:registry": "https://a.test/y/", "//a.test/y/:_authtoken": "b" },
      { "@c:registry": "https://c.test/", "//other.test/:_authtoken": "o" },
      { "@d:registry": "not a url" },
    ]).auth;
    expect(auth).toEqual({
      "//r.test/npm/": "Bearer t",
      "//r.test/": "Bearer t",
      "//a.test/x/": "Bearer a",
      "//a.test/y/": "Bearer b",
      "//a.test/": "Bearer a",
      "//other.test/": "Bearer o",
    });
    expect(authFor(auth, "https://r.test/_apis/blob.tgz")).toBe("Bearer t");
    expect(authFor(auth, "https://a.test/y/pkg/-/pkg-1.0.0.tgz")).toBe("Bearer b");
    expect(authFor(auth, "https://c.test/pkg.tgz")).toBeUndefined();
  });

  it("reads save-exact", () => {
    expect(toConfig([{ "save-exact": "true" }]).saveExact).toBe(true);
    expect(toConfig([{ "save-exact": "true" }, { "save-exact": "false" }]).saveExact).toBe(false);
  });

  it("reads offline", () => {
    expect(toConfig([{ offline: "true" }]).offline).toBe(true);
    expect(toConfig([{ offline: "true" }, { offline: "false" }]).offline).toBe(false);
  });
});

describe("authFor", () => {
  const auth = { "//r.test/": "host", "//r.test/npm/": "path", "//bare.test": "bare" };

  it("finds the longest configured prefix of the url", () => {
    expect(authFor(auth, "https://r.test/foo")).toBe("host");
    expect(authFor(auth, "https://r.test/npm/foo/-/foo-1.0.0.tgz")).toBe("path");
    expect(authFor(auth, "https://r.test/npm")).toBe("host");
    expect(authFor(auth, "https://bare.test/x")).toBe("bare");
  });

  it("gives nothing to another host, another port, or what is not a url", () => {
    expect(authFor(auth, "https://other.test/foo")).toBeUndefined();
    expect(authFor(auth, "https://r.test:8443/foo")).toBeUndefined();
    expect(authFor(auth, "not a url")).toBeUndefined();
    expect(authFor({}, "https://r.test/foo")).toBeUndefined();
  });
});

describe("readConfig", () => {
  let dir: string;
  const env = { ...process.env };

  afterEach(async () => {
    process.env = { ...env };
    await rm(dir, { recursive: true, force: true });
  });

  /** Only the files under `dir`: nothing of this machine's own config. */
  function isolate(): void {
    // In any case: a CI image may set NPM_CONFIG_GLOBALCONFIG in capitals.
    for (const name of Object.keys(process.env)) {
      if (
        /^(npm_config_(globalconfig|userconfig|registry|prefix|before|min_release_age\w*)|prefix|upm_registry)$/i.test(
          name,
        )
      ) {
        delete process.env[name];
      }
    }
    process.env.npm_config_globalconfig = join(dir, "missing-global");
    process.env.npm_config_userconfig = join(dir, "missing-user");
  }

  it("layers the global, user and project files, the environment and the flag", async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    isolate();
    await writeFile(
      join(dir, "global.npmrc"),
      "registry=https://global.test\n@g:registry=https://g.test\n//g.test/:_authToken=g\n",
    );
    await writeFile(
      join(dir, "user.npmrc"),
      "registry=https://user.test\n@a:registry=https://a.test\n//a.test/:_authToken=${A_TOKEN}\n",
    );
    await writeFile(join(dir, ".npmrc"), "registry=https://project.test\nsave-exact=true\n");
    process.env.npm_config_globalconfig = join(dir, "global.npmrc");
    process.env.npm_config_userconfig = join(dir, "user.npmrc");
    process.env.A_TOKEN = "secret";

    expect(readConfig(dir)).toEqual({
      registry: "https://project.test",
      scopes: { "@a": "https://a.test", "@g": "https://g.test" },
      auth: { "//a.test/": "Bearer secret", "//g.test/": "Bearer g" },
      saveExact: true,
      before: expect.any(Number),
      releaseAgeExclude: [],
      offline: false,
    });
    process.env.npm_config_registry = "https://env.test";
    expect(readConfig(dir).registry).toBe("https://env.test");
    expect(readConfig(dir, { registry: "https://flag.test" }).registry).toBe("https://flag.test");
  });

  it("takes --before and --min-release-age-exclude over the files", async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    isolate();
    await writeFile(join(dir, ".npmrc"), "min-release-age=3\nmin-release-age-exclude[]=@acme/*\n");
    const date = "2024-01-02T03:04:05Z";
    const flags = { minReleaseAge: 5, before: date, minReleaseAgeExclude: ["a", "b"] };
    expect(readConfig(dir, flags)).toMatchObject({
      before: Date.parse(date),
      releaseAgeExclude: ["a", "b"],
    });
    expect(readConfig(dir).releaseAgeExclude).toEqual(["@acme/*"]);
  });

  it("takes offline from the file, and the option over it either way", async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    isolate();
    await writeFile(join(dir, ".npmrc"), "offline=true\n");
    expect(readConfig(dir).offline).toBe(true);
    expect(readConfig(dir, { offline: false }).offline).toBe(false);
    await writeFile(join(dir, ".npmrc"), "");
    expect(readConfig(dir, { offline: true }).offline).toBe(true);
  });

  it("finds the global file under the prefix, as npm's --location=global writes it", async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    isolate();
    delete process.env.npm_config_globalconfig;
    await mkdir(join(dir, "prefix", "etc"), { recursive: true });
    await writeFile(join(dir, "prefix", "etc", "npmrc"), "registry=https://prefix.test\n");
    // Where Node is installed, unless the environment or the user file says otherwise.
    process.env.PREFIX = join(dir, "nowhere");
    expect(readConfig(dir).registry).toBe(NPM);
    process.env.PREFIX = join(dir, "prefix");
    expect(readConfig(dir).registry).toBe("https://prefix.test");
    process.env.PREFIX = join(dir, "nowhere");
    process.env.npm_config_prefix = join(dir, "prefix");
    expect(readConfig(dir).registry).toBe("https://prefix.test");
    delete process.env.npm_config_prefix;
    // `~/` as npm reads it, in the user file's own prefix and globalconfig.
    process.env.npm_config_userconfig = join(dir, "user.npmrc");
    await writeFile(join(dir, "user.npmrc"), "prefix=~/prefix\n");
    expect(readConfig(dir, {}, dir).registry).toBe("https://prefix.test");
    await writeFile(join(dir, "user.npmrc"), "globalconfig=~/prefix/etc/npmrc\n");
    expect(readConfig(dir, {}, dir).registry).toBe("https://prefix.test");
    // The user file itself, found under the home directory.
    delete process.env.npm_config_userconfig;
    await writeFile(join(dir, ".npmrc"), "registry=https://home.test\n");
    expect(readConfig(join(dir, "prefix"), {}, dir).registry).toBe("https://home.test");
    // One that cannot be read (a directory here) is no file, not a failure.
    await writeFile(join(dir, "user.npmrc"), `globalconfig=${join(dir, "prefix")}\n`);
    process.env.npm_config_userconfig = join(dir, "user.npmrc");
    expect(readConfig(join(dir, "prefix")).registry).toBe(NPM);
  });

  it("reads nothing into a project without files", async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    isolate();
    expect(readConfig(dir)).toEqual(DEFAULTS);
    // `--min-release-age` is the last layer.
    await writeFile(join(dir, ".npmrc"), "min-release-age=3\n");
    expect(readConfig(dir, { minReleaseAge: 0 }).before).toBeUndefined();
  });
});

/** A fetch that records the `authorization` each url was asked with. */
function recorder(body: () => Response): { fetch: typeof fetch; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const impl: typeof fetch = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.set(String(input), headers.authorization ?? "");
    return Promise.resolve(body());
  };
  return { fetch: impl, seen };
}

describe("credentials on requests", () => {
  const doc = (name: string) => ({
    name,
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": { name, version: "1.0.0", dist: { tarball: "", integrity: "" } } },
  });

  it("reads a scope from its registry, with that registry's credential", async () => {
    const r = recorder(() => new Response(JSON.stringify(doc("x")), { status: 200 }));
    const registry = createRegistry({
      registry: "https://public.test",
      scopes: { "@acme": "https://acme.test/npm/" },
      auth: { "//acme.test/npm/": "Bearer t" },
      fetch: r.fetch,
    });
    expect(registry.base).toBe("https://public.test");
    expect(registry.baseFor("@acme/x")).toBe("https://acme.test/npm");
    expect(registry.baseFor("@other/x")).toBe("https://public.test");
    expect(registry.baseFor("x")).toBe("https://public.test");

    await registry.packument("@acme/x");
    await registry.packument("x");
    await registry.manifest("x", "1.0.0");
    expect(r.seen.get("https://acme.test/npm/@acme%2fx")).toBe("Bearer t");
    expect(r.seen.get("https://public.test/x")).toBe("");
    expect(r.seen.get("https://public.test/x/1.0.0")).toBe("");
  });

  it("sends the credential with a tarball under the registry and not with another", async () => {
    // Two packages: a second add of the same content is a cache hit that asks for nothing.
    const a = makeTarball([{ path: "index.js", data: "a" }]);
    const b = makeTarball([{ path: "index.js", data: "b" }]);
    const sent = [a, b];
    const r = recorder(() => new Response(Buffer.from(sent.shift()!), { status: 200 }));
    const dir = await mkdtemp(join(tmpdir(), "upm-store-"));
    try {
      const store = createStore({ dir, fetch: r.fetch, auth: { "//r.test/": "Basic x" } });
      await store.add("https://r.test/a/-/a-1.0.0.tgz", hashOf(a));
      await store.add("https://cdn.test/a/-/a-1.0.0.tgz", hashOf(b));
      expect(r.seen.get("https://r.test/a/-/a-1.0.0.tgz")).toBe("Basic x");
      expect(r.seen.get("https://cdn.test/a/-/a-1.0.0.tgz")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a redirect to another host", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("does not carry the credential along, for a document or a tarball", async () => {
    const tarball = makeTarball([{ path: "index.js", data: "1" }]);
    const seen: (string | undefined)[] = [];
    const elsewhere = await listen((request, response) => {
      seen.push(request.headers.authorization);
      if (request.url?.endsWith(".tgz")) response.end(Buffer.from(tarball));
      else response.end(JSON.stringify({ name: "a", "dist-tags": {}, versions: {} }));
    });
    // Same address, another port: another origin, which is what fetch checks.
    const registry = await listen((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(302, { location: `${elsewhere}${request.url}` }).end();
    });
    const auth = { [`//${registry.slice("http://".length)}/`]: "Bearer t" };

    await createRegistry({ registry, auth }).packument("a");
    const dir = await mkdtemp(join(tmpdir(), "upm-store-"));
    try {
      await createStore({ dir, auth }).add(`${registry}/a/-/a-1.0.0.tgz`, hashOf(tarball));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual(["Bearer t", undefined, "Bearer t", undefined]);
  });
});
