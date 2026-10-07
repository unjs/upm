// Routes: `/` is the landing, `/docs` the README, `/npm/<spec>` the app for a spec and
// `/<host>/<path>` for a tarball url on an allowed host, where `?file=<tree path>&line=<n>[-<m>]`
// opens a file at its lines. Any other `/<spec>` redirects to `/npm/<spec>`.

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

/**
 * A spec's path; a scope's `@` and `/` stay readable. An allowed url is its own path, as typed
 * but without `https:/`.
 */
export function pathOf(spec: string): string {
  const path = sourceOf(spec) ? `/${spec.replace(/^https:\/\//i, "")}` : NPM + spec;
  return encodeURIComponent(path).replace(/%40/g, "@").replace(/%2F/gi, "/");
}

/**
 * Hosts the app fetches a tarball from by its url, and how each one's path names the package.
 * Only these: the page reads the bytes, so the host has to allow it with CORS.
 */
const SOURCES: Record<string, (path: string) => { name: string; path: string } | undefined> = {
  // `/<name>@<ref>` or `/<owner>/<repo>/<name>@<ref>`, where the name may have a scope. No ref,
  // or `latest`, is the newest build of `main`.
  "pkg.pr.new": (path) => {
    const match = /^(\/(?:[^@/][^/]*\/[^/]+\/)?((?:@[^/]+\/)?[^/@]+))(?:@([^/]+))?$/.exec(path);
    if (!match) return undefined;
    const ref = !match[3] || match[3] === "latest" ? "main" : match[3];
    return { name: match[2]!, path: `${match[1]}@${ref}` };
  },
};

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
 * just `<host>/…`. Undefined for any other spec.
 */
export function sourceOf(spec: string): { name: string; url: string } | undefined {
  const text = /^https:\/\//i.test(spec) ? spec : `https://${spec}`;
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (!isSource(url) || url.username || url.search || url.hash) return undefined;
  const found = SOURCES[url.host]!(decodeURIComponent(url.pathname));
  return found && { name: found.name, url: new URL(found.path, url).href };
}

/** A range of lines, first and last, from 1. */
export type Lines = [from: number, to: number];

/** The open file and its picked lines, as a `/npm/<spec>` path's query keeps them. */
export function openOf(search: string): { file?: string; lines?: Lines } {
  const query = new URLSearchParams(search);
  const file = query.get("file") || undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(query.get("line") ?? "");
  if (!file || !match) return { file };
  const from = Number(match[1]);
  const to = Number(match[2] ?? from);
  return from > 0 ? { file, lines: [Math.min(from, to), Math.max(from, to)] } : { file };
}

/** The query for an open file; its path's `/` and `@` stay readable. */
export function searchOf(file: string | undefined, lines?: Lines): string {
  if (!file) return "";
  const path = encodeURIComponent(file).replace(/%40/g, "@").replace(/%2F/gi, "/");
  const line = !lines ? "" : lines[0] === lines[1] ? lines[0] : `${lines[0]}-${lines[1]}`;
  return `?file=${path}${line && `&line=${line}`}`;
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
