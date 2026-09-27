// .npmrc: where packages come from and what to say to get them. The global file, the user
// file over it, the project file over that, then `npm_config_*` in the environment over all
// three, then `--registry`.
// Only what upm has a use for is read; the rest of the file is ignored, as npm ignores keys it
// does not know.
import { builtin } from "./builtin.ts";
import { authFor, registryBase } from "./registry.ts";
import { fromBase64, toBase64 } from "./runtime.ts";

export interface Config {
  /** The registry, trailing slashes off. */
  registry: string;
  /** `@scope` → the registry its packages are read from instead. */
  scopes: Record<string, string>;
  /**
   * `//host/path/` → the `authorization` header for every request under it, packument and
   * tarball alike (`authFor` in `src/registry.ts`). Plain strings, so a registry thread can
   * be handed the same map.
   */
  auth: Record<string, string>;
  /** `save-exact`: `add` saves the version a range resolved to, not a caret range. */
  saveExact: boolean;
  /**
   * The release cutoff in epoch ms, or nothing when it is off: `before`, or `min-release-age`
   * days before now. One day unless a layer says otherwise.
   */
  before?: number;
  /** `min-release-age-exclude`: names or globs the cutoff never applies to. */
  releaseAgeExclude: string[];
  /** `offline`: never ask the registry or download a tarball. */
  offline: boolean;
  /** `prefer-offline`: pick from a kept registry document without asking whether it changed. */
  preferOffline: boolean;
}

const NPMRC = ".npmrc";
/** The credential keys, which are only ever read behind a `//host/path/:`. */
const AUTH_FIELDS = new Set(["_authtoken", "_auth", "username", "_password"]);
/** How npm hands its config to a script it runs: `npm run deps` sets `npm_config_registry`. */
const ENV_PREFIX = /^npm_config_/i;
/**
 * `${VAR}` in a value, as npm reads it: `${VAR?}` is empty when the variable is unset where
 * `${VAR}` stays as written, and a backslash before the `$` keeps it literal.
 */
const ENV_EXPR = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;
/** Days, when no layer sets `min-release-age` or `before`. */
const MIN_RELEASE_AGE = 1;
const DAY = 86_400_000;

/**
 * The file's `key=value` lines, as npm's ini reads them: an unquoted value ends at a `;` or
 * `#`. Keys are lowercased, except a credential's `//host/path/` which is a url and stays as
 * written. A credential with no url is refused: it would go to whatever registry wins, and a
 * cloned project's .npmrc can name one. npm refuses these too.
 */
export function parseNpmrc(
  text: string,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    const written = eq === -1 ? line : line.slice(0, eq).trim();
    const key = normalizeKey(written);
    let value = eq === -1 ? "true" : line.slice(eq + 1).trim();
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s*[;#].*$/, "");
    if (AUTH_FIELDS.has(key) && value) {
      throw fail(`${written} in .npmrc must be keyed by its registry: //host/path/:${written}`);
    }
    value = value.replace(ENV_EXPR, (whole, esc: string, name: string, opt?: string) => {
      if (esc.length % 2) return whole.slice((esc.length + 1) / 2);
      return esc.slice(esc.length / 2) + (env[name] ?? (opt ? "" : `\${${name}}`));
    });
    // `key[]=a` lines add up to a list, which npm also takes as `key=a,b`.
    if (key.endsWith("[]")) {
      const list = key.slice(0, -2);
      out[list] = out[list] && value ? `${out[list]},${value}` : out[list] || value;
    } else out[key] = value;
  }
  return out;
}

/**
 * `npm_config_save_exact=true` is `save-exact=true`, and `UPM_REGISTRY` stands in for a
 * `npm_config_registry` npm did not set. Nothing in a value is expanded.
 */
export function envConfig(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_PREFIX.test(name) || !value) continue;
    const key = name.slice("npm_config_".length);
    const normalized = normalizeKey(key.startsWith("//") ? key : key.replace(/(?!^)_/g, "-"));
    // A credential with no url is not a setting npm takes from the environment either.
    if (!AUTH_FIELDS.has(normalized)) out[normalized] = value;
  }
  if (!out.registry && env.UPM_REGISTRY) out.registry = env.UPM_REGISTRY;
  return out;
}

/**
 * The config the layers add up to, last layer winning per key. A `--registry` beats them all
 * for the default registry alone: a scope sent elsewhere still goes there, as with npm.
 */
export function toConfig(layers: Record<string, string>[], registry?: string): Config {
  const merged: Record<string, string> = {};
  // An empty value is no value: `registry=` does not unset a lower layer's, as with npm.
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) if (v) merged[k] = v;
  const base = registryBase(registry || merged.registry);
  const scopes: Record<string, string> = {};
  const fields = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith("@") && key.endsWith(":registry")) {
      scopes[key.slice(0, -":registry".length)] = registryBase(value);
    } else if (key.startsWith("//")) {
      // `//host/path/:_authToken`: the url is everything before the field's colon.
      const colon = key.lastIndexOf(":");
      if (colon === -1) continue;
      const dart = key.slice(0, colon);
      fields.set(dart, { ...fields.get(dart), [key.slice(colon + 1)]: value });
    }
  }
  const auth: Record<string, string> = {};
  for (const [dart, found] of fields) {
    const header = authorization(found);
    if (header) auth[dart] = header;
  }
  // As npm does: a registry's credential also covers what its host serves from another path,
  // for the registries whose tarballs live beside the registry rather than under it. The
  // first registry with a credential on a host is the one that covers the rest of it.
  for (const url of [base, ...Object.values(scopes)]) {
    const host = hostOf(url);
    const found = host && authFor(auth, `${url}/`);
    if (host && found && !auth[host]) auth[host] = found;
  }
  return {
    registry: base,
    scopes,
    auth,
    saveExact: merged["save-exact"] === "true",
    before: cutoff(layers),
    releaseAgeExclude: [
      ...new Set((merged["min-release-age-exclude"] ?? "").split(",").map((v) => v.trim())),
    ].filter(Boolean),
    offline: merged.offline === "true",
    preferOffline: merged["prefer-offline"] === "true",
  };
}

/**
 * The release cutoff, as npm settles it: a layer's `before` beats its own `min-release-age`,
 * and a higher layer beats a lower one either way. `min-release-age=0` turns it off.
 */
function cutoff(layers: Record<string, string>[]): number | undefined {
  let before: number | undefined = Date.now() - MIN_RELEASE_AGE * DAY;
  for (const layer of layers) {
    if (layer.before) {
      before = Date.parse(layer.before);
      if (Number.isNaN(before)) throw fail(`before=${layer.before} is not a date`);
    } else if (layer["min-release-age"]) {
      const days = Number(layer["min-release-age"]);
      if (!(days >= 0)) {
        throw fail(`min-release-age=${layer["min-release-age"]} is not a number of days`);
      }
      before = days === 0 ? undefined : Date.now() - days * DAY;
    }
  }
  return before;
}

/** The header a registry's credential fields make, in the order npm sends them. */
function authorization(fields: Record<string, string>): string | undefined {
  if (fields._authtoken) return `Bearer ${fields._authtoken}`;
  if (fields._auth) return `Basic ${fields._auth}`;
  if (fields.username && fields._password) {
    // `_password` is base64 in the file; the header wants `user:password` base64 as a whole.
    const password = new TextDecoder().decode(fromBase64(fields._password));
    return `Basic ${toBase64(new TextEncoder().encode(`${fields.username}:${password}`))}`;
  }
  return undefined;
}

/** `//host/` for a url, or nothing for a registry that is not one. */
function hostOf(url: string): string | undefined {
  try {
    return `//${new URL(url).host}/`;
  } catch {
    return undefined;
  }
}

/**
 * The config a project runs under. The user file is `~/.npmrc`, or what `npm_config_userconfig`
 * names; the global one is where npm's `--location=global` writes. Not npm's own built-in
 * file: that belongs to an npm installation, not to a user. `home` is injectable for tests.
 */
export function readConfig(
  dir: string,
  flags: {
    registry?: string;
    minReleaseAge?: number;
    before?: string;
    minReleaseAgeExclude?: string[];
    offline?: boolean;
    preferOffline?: boolean;
  } = {},
  home = builtin.os.homedir(),
): Config {
  const env = globalThis.process?.env ?? {};
  const fromEnv = envConfig(env);
  // A path as npm reads one: `~/` is the home directory.
  const path = (p?: string) => (p?.startsWith("~/") ? builtin.path.join(home, p.slice(2)) : p);
  const user = parseNpmrc(read(path(fromEnv.userconfig) || builtin.path.join(home, NPMRC)), env);
  const global = parseNpmrc(
    read(
      path(fromEnv.globalconfig || user.globalconfig) ||
        globalFile(env, path(fromEnv.prefix || user.prefix)),
    ),
    env,
  );
  const project = parseNpmrc(read(builtin.path.join(dir, NPMRC)), env);
  const cli: Record<string, string> = {};
  if (flags.minReleaseAge !== undefined) cli["min-release-age"] = `${flags.minReleaseAge}`;
  if (flags.before !== undefined) cli.before = flags.before;
  if (flags.minReleaseAgeExclude) {
    cli["min-release-age-exclude"] = flags.minReleaseAgeExclude.join(",");
  }
  if (flags.offline !== undefined) cli.offline = `${flags.offline}`;
  if (flags.preferOffline !== undefined) cli["prefer-offline"] = `${flags.preferOffline}`;
  return toConfig([global, user, project, fromEnv, cli], flags.registry);
}

/**
 * npm's global file is `<prefix>/etc/npmrc`, the prefix being where Node is installed:
 * `/usr/local/bin/node` is `/usr/local`, and on Windows the directory of the exe. `prefix`
 * in the environment or the user file moves it, as with npm.
 */
function globalFile(env: Record<string, string | undefined>, prefix?: string): string {
  const { dirname, join } = builtin.path;
  const exec = globalThis.process.execPath;
  const base =
    prefix ||
    env.PREFIX ||
    (globalThis.process.platform === "win32"
      ? dirname(exec)
      : join(env.DESTDIR ?? "", dirname(dirname(exec))));
  return join(base, "etc", "npmrc");
}

/** Unreadable is absent, as with npm: a root-only global file must not stop an install. */
function read(file: string): string {
  try {
    return builtin.fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Case only matters in a url, and `_authToken` is the one key people write in two cases. */
function normalizeKey(key: string): string {
  if (!key.startsWith("//")) return key.toLowerCase();
  const colon = key.lastIndexOf(":");
  return colon === -1 ? key : key.slice(0, colon) + key.slice(colon).toLowerCase();
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "ECONFIG" });
}
