// Routes: `/` is the landing, `/docs` the README, `/npm/<spec>` the app for a spec and
// `/<host>/<path>` for a tarball url on an allowed host, where `?file=<tree path>&line=<n>[-<m>]`
// opens a file at its lines and `?arch=<arch>` installs as that arch. Any other `/<spec>`
// redirects to `/npm/<spec>`.

import type { Target } from "./install.ts";

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
 * The arches the install can run as, as `?arch=` spells them: wasm32 first, the default and the
 * builds a browser can run, then the Linux builds sharp, rolldown and oxc-parser all publish.
 */
export const ARCHES = ["wasm32", "x64", "x64-musl", "arm64", "arm64-musl", "arm", "ppc64", "s390x"];

export function targetOf(arch: string): Target {
  const [cpu, libc] = arch.split("-");
  return { arch: cpu!, libc: libc === "musl" ? "musl" : "glibc" };
}

export function archOf(target: Target): string {
  return target.libc === "musl" ? `${target.arch}-musl` : target.arch;
}

/** The open file, its picked lines and the install's arch, as a `/npm/<spec>` path's query keeps them. */
export function openOf(search: string): { file?: string; lines?: Lines; target: Target } {
  const query = new URLSearchParams(search);
  const arch = query.get("arch") ?? "";
  const target = targetOf(ARCHES.includes(arch) ? arch : ARCHES[0]!);
  const file = query.get("file") || undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(query.get("line") ?? "");
  if (!file || !match) return { file, target };
  const from = Number(match[1]);
  const to = Number(match[2] ?? from);
  const lines: Lines = [Math.min(from, to), Math.max(from, to)];
  return from > 0 ? { file, lines, target } : { file, target };
}

/** The query for an open file and an arch other than wasm32; the path's `/` and `@` stay readable. */
export function searchOf(file: string | undefined, lines?: Lines, target?: Target): string {
  const parts: string[] = [];
  if (file) {
    parts.push(`file=${encodeURIComponent(file).replace(/%40/g, "@").replace(/%2F/gi, "/")}`);
    if (lines) parts.push(`line=${lines[0] === lines[1] ? lines[0] : `${lines[0]}-${lines[1]}`}`);
  }
  const arch = target && archOf(target);
  if (arch && arch !== ARCHES[0]) parts.push(`arch=${arch}`);
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
