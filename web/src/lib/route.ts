// Routes: `/` is the landing, `/docs` the README, `/npm/<spec>` the app for a spec and
// `/<host>/<path>` for a tarball url on an allowed host, where `?file=<tree path>&line=<n>[-<m>]`
// opens a file at its lines and `?platform=<name>` installs as that platform. Any other `/<spec>`
// redirects to `/npm/<spec>`.

import type { Platform } from "upm/src/resolve.ts";

export const NPM = "/npm/";
export const DOCS = /^\/docs\/?$/;

/** Whether `pathname` is the app's: a `/npm/<spec>` or an allowed host's url without `https:/`. */
export function isApp(pathname: string): boolean {
  return pathname.startsWith(NPM) || Object.hasOwn(SOURCES, pathname.split("/")[1]!);
}

/** The spec in an app path. */
export function specOf(pathname: string): string {
  const start = pathname.startsWith(NPM) ? NPM.length : 1;
  return decodeURIComponent(pathname.slice(start)).replace(/\/$/, "");
}

/** A spec's path; a scope's `@` and `/` stay readable. An allowed url is its own path. */
export function pathOf(spec: string): string {
  const source = sourceOf(spec);
  const path = source ? `/${source.spec}` : NPM + spec;
  return encodeURIComponent(path).replace(/%40/g, "@").replace(/%2F/gi, "/");
}

/** An allowed url in the form the box and the path show it; any other spec as it is. */
export function normalSpec(spec: string): string {
  return sourceOf(spec)?.spec ?? spec;
}

/**
 * Hosts the app fetches a tarball from by its url, and how each one's path names the package.
 * Only these: the page reads the bytes, so the host has to allow it with CORS.
 */
const SOURCES: Record<string, (path: string) => Source | undefined> = {
  // `/<name>@<ref>`, `/<owner>/<repo>/<name>@<ref>`, where the name may have a scope, or
  // `/<owner>/<repo>@<ref>` for the package named as the repo. `/~/<owner>/<repo>` is the repo's
  // page on the site, read as the last. No ref, or `latest`, is the newest build of `main`.
  "pkg.pr.new": (path) => {
    const match =
      /^\/(?:~\/)?(?:([^@/~][^@/]*\/([^@/]+))(\/(?:@[^@/]+\/)?[^@/]+)?|((?:@[^@/]+\/)?[^@/]+))(?:@([^/]+))?\/?$/.exec(
        path,
      );
    if (!match) return undefined;
    const [, repo, repoName, inRepo, name, ref] = match;
    const at = `/${repo ? repo + (inRepo ?? "") : name}`;
    return {
      name: inRepo?.slice(1) ?? repoName ?? name!,
      spec: ref ? `${at}@${ref}` : at,
      url: `${at}@${!ref || ref === "latest" ? "main" : ref}`,
    };
  },
};

/** A url's package, and its path in the form shown (`spec`) and fetched (`url`). */
interface Source {
  name: string;
  spec: string;
  url: string;
}

export const SOURCE_HOSTS = Object.keys(SOURCES);

/** Whether `url` is an https tarball on an allowed host. */
export function allowedSource(url: string): boolean {
  return URL.canParse(url) && isSource(new URL(url));
}

function isSource(url: URL): boolean {
  return url.protocol === "https:" && Object.hasOwn(SOURCES, url.host);
}

/**
 * A tarball url on an allowed host and the package its path names, from `https://<host>/…` or
 * just `<host>/…`, with the `<host>/…` form to show. Undefined for any other spec.
 */
export function sourceOf(spec: string): Source | undefined {
  const text = /^https:\/\//i.test(spec) ? spec : `https://${spec}`;
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (!isSource(url) || url.username || url.search || url.hash) return undefined;
  const found = SOURCES[url.host]!(decodeURIComponent(url.pathname));
  if (!found) return undefined;
  return { name: found.name, spec: url.host + found.spec, url: new URL(found.url, url).href };
}

/** A range of lines, first and last, from 1. */
export type Lines = [from: number, to: number];

/**
 * The platforms the install can run as, by their `?platform=` name. The browser first: the
 * default, Linux wasm32, whose optional builds are the ones this tab can run.
 */
export const PLATFORMS: { name: string; label: string; target: Platform }[] = [
  { name: "browser", label: "Browser", target: { os: "linux", cpu: "wasm32", libc: "glibc" } },
  { name: "darwin-arm64", label: "macOS arm64", target: { os: "darwin", cpu: "arm64" } },
  { name: "linux-x64", label: "Linux x64", target: { os: "linux", cpu: "x64", libc: "glibc" } },
  {
    name: "linux-arm64",
    label: "Linux arm64",
    target: { os: "linux", cpu: "arm64", libc: "glibc" },
  },
  {
    name: "linux-x64-musl",
    label: "Linux x64 musl",
    target: { os: "linux", cpu: "x64", libc: "musl" },
  },
  { name: "win32-x64", label: "Windows x64", target: { os: "win32", cpu: "x64" } },
];

/** A preset's platform; the browser's for a name not on the list. */
export function targetOf(name: string): Platform {
  return (PLATFORMS.find((p) => p.name === name) ?? PLATFORMS[0]!).target;
}

/** The open file, its picked lines and the install's platform, as a `/npm/<spec>` path's query keeps them. */
export function openOf(search: string): { file?: string; lines?: Lines; platform: string } {
  const query = new URLSearchParams(search);
  const named = query.get("platform");
  const platform = PLATFORMS.some((p) => p.name === named) ? named! : PLATFORMS[0]!.name;
  const file = query.get("file") || undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(query.get("line") ?? "");
  if (!file || !match) return { file, platform };
  const from = Number(match[1]);
  const to = Number(match[2] ?? from);
  const lines: Lines = [Math.min(from, to), Math.max(from, to)];
  return from > 0 ? { file, lines, platform } : { file, platform };
}

/** The query for an open file and a platform other than the browser; the path's `/` and `@` stay readable. */
export function searchOf(file: string | undefined, lines?: Lines, platform?: string): string {
  const parts: string[] = [];
  if (file) {
    parts.push(`file=${encodeURIComponent(file).replace(/%40/g, "@").replace(/%2F/gi, "/")}`);
    if (lines) parts.push(`line=${lines[0] === lines[1] ? lines[0] : `${lines[0]}-${lines[1]}`}`);
  }
  if (platform && platform !== PLATFORMS[0]!.name) parts.push(`platform=${platform}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Specs worth a try, offered on both pages: build and UI, then full-stack frameworks, then servers, then upm itself. */
export const EXAMPLES = [
  "vite",
  "vue",
  "nuxt",
  "next",
  "@tanstack/react-start",
  "nitro",
  "h3",
  "express",
  "upm",
];
