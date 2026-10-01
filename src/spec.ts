// Replacement for `npm-package-arg`: version, range, tag, alias, workspace, link and tarball specs.
import { parse, validRange } from "./semver.ts";

export interface Spec {
  raw: string;
  /** The name the dependency is installed under. An alias makes this differ from `fetchName`. */
  name: string;
  /** The registry package to ask for. Same as `name` unless the spec is an alias. */
  fetchName: string;
  /** Scope of `fetchName`. */
  scope?: string;
  /**
   * `workspace` never asks the registry: `fetchSpec` is the range a workspace's version must
   * satisfy. Nor does `tarball`: `fetchSpec` is its http(s) url as given, or `file:` and a path
   * relative to the package.json that declares it, `/`-separated and without `.` segments.
   * Nor does `link`: `fetchSpec` is a directory in that same form, linked as it is.
   */
  type: "version" | "range" | "tag" | "workspace" | "link" | "tarball";
  fetchSpec: string;
  /** Registry path form of `fetchName`: `@scope/foo` -> `@scope%2ffoo`. */
  escapedName: string;
}

const NAME_RE = /^(?:@([^/]+)\/)?([^/]+)$/;
const BLOCKED = new Set(["node_modules", "favicon.ico"]);
const ALIAS = "npm:";
const WORKSPACE = "workspace:";
const LINK = "link:";
const URL_RE = /^https?:\/\//i;
const TARBALL_RE = /\.(?:tgz|tar\.gz|tar)$/i;

/**
 * A CLI argument that is a tarball on its own, with no name before it — an http(s) url, a
 * `file:`, `./` or `../` path, or a file name ending as a tarball does — as a tarball spec's
 * `fetchSpec`; undefined for anything else. Its name is in its package.json, so only a caller
 * that reads the tarball can make a spec of it.
 */
export function bareTarball(arg: string): string | undefined {
  if (URL_RE.test(arg) || /^(?:file:|\.\.?[\\/])/.test(arg)) return tarball(arg, arg);
  if (!arg.includes("@") && TARBALL_RE.test(arg)) return tarball(`file:${arg}`, arg);
  return undefined;
}

/**
 * Where a tarball spec's bytes are, as a lockfile key spells it: a url as given, a path joined
 * onto `base`, the root-relative directory of the package.json that declared it.
 */
export function tarballSource(fetchSpec: string, base: string): string {
  return fetchSpec.startsWith("file:") ? `file:${joinPath(base, fetchSpec.slice(5))}` : fetchSpec;
}

/** Parse a CLI argument such as `foo@^1.2`, `@scope/foo@latest` or `foo@npm:bar@^1`. */
export function parseSpec(arg: string, where?: string): Spec {
  const [name, spec] = splitAt(arg);
  return build(name, spec, arg, where);
}

/** A registry package name, checked as `parseDep` checks it, in `escapedName`'s form. */
export function escapeName(name: string): string {
  checkName(name, name);
  return name.replace("/", "%2f");
}

/** Parse an already split `package.json` dependencies entry. */
export function parseDep(name: string, spec: string, where?: string): Spec {
  return build(name, spec, spec ? `${name}@${spec}` : name, where);
}

/** Split `name@spec` on the `@` that is not a scope marker. */
function splitAt(arg: string): [name: string, spec: string] {
  const at = arg.indexOf("@", 1); // index 1 skips the scope marker
  return at > 0 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, ""];
}

function build(name: string, spec: string, raw: string, where?: string): Spec {
  checkName(name, raw, where);
  let fetchName = name;
  let s = spec.trim();
  let local = false;
  // Named by the dep, as an alias is: the package.json inside may call itself anything.
  const source = tarball(s, raw, where);
  if (s.startsWith(WORKSPACE)) {
    local = true;
    [fetchName, s] = workspace(name, s.slice(WORKSPACE.length), raw, where);
  } else if (s.startsWith(ALIAS)) {
    // `name@npm:pkg@range` installs the registry package `pkg` under `name`. Only the name
    // moves: everything after it is an ordinary version, range or tag.
    [fetchName, s] = splitAt(s.slice(ALIAS.length));
    checkName(fetchName, raw, where);
    s = s.trim();
    if (s.startsWith(ALIAS) || s.startsWith(WORKSPACE) || s.startsWith(LINK)) {
      throw fail(`Invalid alias of package "${raw}": an alias cannot point at an alias`, where);
    }
  }

  const base = {
    raw,
    name,
    fetchName,
    scope: fetchName.startsWith("@") ? fetchName.slice(0, fetchName.indexOf("/")) : undefined,
    escapedName: fetchName.replace("/", "%2f"),
  };

  if (source !== undefined) {
    return { ...base, type: "tarball", fetchSpec: source };
  }
  if (s.startsWith(LINK)) {
    return { ...base, type: "link", fetchSpec: link(s.slice(LINK.length), raw, where) };
  }
  if (local) {
    return { ...base, type: "workspace", fetchSpec: s };
  }
  if (!s || s === "*") {
    return { ...base, type: "range", fetchSpec: "*" };
  }
  if (validRange(s)) {
    // An exact version is also a valid range; version wins.
    return { ...base, type: parse(s) ? "version" : "range", fetchSpec: s };
  }
  if (encodeURIComponent(s) !== s) {
    throw fail(`Invalid tag "${s}" of package "${raw}": tags must be url-safe`, where);
  }
  return { ...base, type: "tag", fetchSpec: s };
}

/**
 * A tarball spec's `fetchSpec`, or nothing when `s` is not one. A path must be relative, since
 * the lockfile names it from the root and an absolute one would not travel with it; and it
 * must end as a tarball does, since a directory is a workspace's job.
 */
function tarball(s: string, raw: string, where?: string): string | undefined {
  if (URL_RE.test(s)) {
    if (!URL.canParse(s)) throw fail(`Invalid url "${s}" of package "${raw}"`, where);
    return s;
  }
  const path = s.startsWith("file:") ? s.slice(5) : /^(?:\.{0,2}|~)[\\/]/.test(s) ? s : undefined;
  if (path === undefined) return undefined;
  const clean = path.replaceAll("\\", "/");
  if (/^(?:\/|~|[A-Za-z]:)/.test(clean)) {
    throw fail(
      `Invalid path "${path}" of package "${raw}": give it relative to package.json`,
      where,
    );
  }
  if (!TARBALL_RE.test(clean)) {
    const why = "only a tarball (.tgz, .tar.gz or .tar) installs from a path";
    throw fail(`Invalid path "${path}" of package "${raw}": ${why}`, where);
  }
  return `file:${joinPath("", clean)}`;
}

/**
 * pnpm's `link:` protocol: a directory, relative to package.json, symlinked into node_modules
 * as it is. Its own dependencies are its business, so none are installed for it.
 */
function link(path: string, raw: string, where?: string): string {
  const clean = path.trim().replaceAll("\\", "/");
  if (/^(?:\/|~|[A-Za-z]:)/.test(clean)) {
    throw fail(
      `Invalid link "${path}" of package "${raw}": give it relative to package.json`,
      where,
    );
  }
  const joined = joinPath("", clean);
  if (!joined)
    throw fail(`Invalid link "${path}" of package "${raw}": it names no directory`, where);
  return joined;
}

/**
 * `path` under `base`, both `/`-separated: `.` and empty segments dropped, `..` taking one off
 * where there is one to take. What is left can start with `..`, and nothing else can be one.
 */
export function joinPath(base: string, path: string): string {
  const out: string[] = [];
  for (const part of `${base}/${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * pnpm's `workspace:` protocol: `workspace:*`, `workspace:^`, `workspace:~` and a bare
 * `workspace:` take any version of the workspace named `name`; `workspace:<range>` only one that
 * satisfies it; `workspace:<pkg>@<range>` names another workspace, the way `npm:` names another
 * registry package. A path is not a spec: a workspace is found by name.
 */
function workspace(
  name: string,
  rest: string,
  raw: string,
  where?: string,
): [fetchName: string, range: string] {
  let fetchName = name;
  let s = rest.trim();
  if (s.indexOf("@", 1) > 0) {
    [fetchName, s] = splitAt(s);
    checkName(fetchName, raw, where);
    s = s.trim();
  }
  if (s === "" || s === "^" || s === "~") s = "*";
  if (!validRange(s)) {
    const why = /^\.|^\//.test(s) ? "a workspace is named, not given by path" : "not a range";
    throw fail(`Invalid workspace spec "${rest}" of package "${raw}": ${why}`, where);
  }
  return [fetchName, s];
}

function checkName(name: string, raw: string, where?: string): void {
  const bad = (why: string) =>
    fail(`Invalid package name "${name}" of package "${raw}": ${why}`, where);

  // npm only warns on uppercase and >214 chars, and published packages rely on both.
  if (!name) throw bad("name is empty");
  if (name.startsWith(".") || name.startsWith("_")) throw bad("name starts with . or _");
  if (name.startsWith("-")) throw bad("name starts with a hyphen");
  if (BLOCKED.has(name)) throw bad("name is reserved");

  const parts = NAME_RE.exec(name);
  const pkg = parts?.[2];
  if (pkg === undefined) throw bad("name is malformed");

  const scope = parts?.[1];
  if (scope !== undefined && encodeURIComponent(scope) !== scope) {
    throw bad("scope has url-unsafe characters");
  }
  if (encodeURIComponent(pkg) !== pkg) throw bad("name has url-unsafe characters");
  if (pkg === "." || pkg === "..") throw bad("name is a path segment");
}

function fail(message: string, where?: string): Error {
  const error = new Error(where ? `${message} (at ${where})` : message);
  // Callers need to tell a bad spec from a network failure to keep optional deps non-fatal.
  return Object.assign(error, { code: "EINVALIDSPEC" });
}
