// A package's Markdown, rendered by md4x's wasm build (its `browser` export).
import { highlightText } from "rangi";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { isRunnable, nodeboxPlaceholder } from "../lib/nodebox.ts";
import { schemeMedia } from "../theme.ts";
import { mountNodeboxes } from "./nodebox.ts";
import { Pulse, Waiting } from "./ui.tsx";

/**
 * Where a README's link or image goes: an absolute url, `#/<tree path>` for a file to open in the
 * editor, or nothing when it has nowhere to go.
 */
export type Link = (value: string, image: boolean) => string | undefined;

type Renderer = (text: string, link: Link) => string;

let ready: Promise<Renderer> | undefined;

/**
 * md4x and DOMPurify in their own chunks, loaded once. A run calls this as it starts, so the wasm
 * is ready by the time the tarball lands with the README.
 */
export function loadMarkdown(): Promise<Renderer> {
  if (!ready) {
    ready = Promise.all([import("md4x"), import("dompurify")]).then(async ([md4x, purify]) => {
      await md4x.init();
      return renderer(md4x, purify.default);
    });
    // A failed load tries again on the next run.
    ready.catch(() => (ready = undefined));
  }
  return ready;
}

/**
 * Markdown keeps raw HTML, and a README is the publisher's, so DOMPurify strips scripts and
 * other XSS before it goes into the page. `link` resolves the README's relative links and images.
 * `children` go above it, in the same scroll.
 */
export function Markdown(props: {
  text: string;
  link: Link;
  onOpen: (path: string) => void;
  children?: ReactNode;
}) {
  const { text, link, onOpen } = props;
  const [loaded, setLoaded] = useState<Renderer | Error>();
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    loadMarkdown().then(
      (render) => setLoaded(() => render),
      (error: Error) => setLoaded(error),
    );
  }, []);
  const html = useMemo(
    () => (typeof loaded === "function" ? loaded(text, link) : ""),
    [loaded, text, link],
  );
  useLayoutEffect(() => (article.current ? mountNodeboxes(article.current) : undefined), [html]);
  if (!loaded) return <MarkdownSkeleton />;
  if (loaded instanceof Error) return <Waiting>md4x failed to load: {loaded.message}</Waiting>;
  return (
    <div
      className="h-full scroll-pt-(--covered-top) overflow-auto pt-(--covered-top) pb-(--covered-bottom)"
      onClick={(e) => jump(e, onOpen)}
    >
      {props.children}
      <article ref={article} className="readme" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/**
 * A `#heading` link scrolls the README; ids carry DOMPurify's `user-content-` prefix. A `#/<path>`
 * link opens a file of the tree.
 */
function jump(e: MouseEvent<HTMLElement>, open: (path: string) => void) {
  const href = (e.target as Element).closest("a")?.getAttribute("href");
  if (!href?.startsWith("#")) return;
  e.preventDefault();
  if (href.startsWith("#/")) return open(href.slice(2));
  const id = `user-content-${decodeURIComponent(href.slice(1))}`;
  e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
}

/** A README's shape while it loads: a title, badges, prose, headings and a code block. */
export function MarkdownSkeleton({ children }: { children?: ReactNode }) {
  const bar = "rounded bg-zinc-200/80 dark:bg-zinc-800";
  const lines = (widths: string[]) => (
    <div className="space-y-2.5">
      {widths.map((width, i) => (
        <div key={i} className={`h-3 ${bar} ${width}`} />
      ))}
    </div>
  );
  const heading = (width: string) => (
    <div className="border-b border-zinc-200 pb-2.5 dark:border-zinc-800">
      <div className={`h-5 ${bar} ${width}`} />
    </div>
  );
  return (
    <div
      role="status"
      aria-label="Loading README"
      className="flex h-full animate-appear flex-col overflow-hidden"
    >
      <div className="mx-auto w-full max-w-[860px] min-h-0 flex-1 space-y-6 px-8 pt-8 motion-safe:animate-pulse">
        <div className="space-y-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
          <div className={`h-8 w-2/5 ${bar}`} />
          <div className="flex gap-1.5">
            {["w-20", "w-24", "w-16", "w-20"].map((width, i) => (
              <div key={i} className={`h-5 rounded-sm bg-zinc-200/80 dark:bg-zinc-800 ${width}`} />
            ))}
          </div>
        </div>
        {lines(["w-full", "w-11/12", "w-3/5"])}
        {heading("w-1/4")}
        {lines(["w-10/12", "w-2/3"])}
        <div className="h-28 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="space-y-2.5">
            {["w-1/3", "w-1/2", "w-2/5"].map((width, i) => (
              <div key={i} className={`h-2.5 ${bar} ${width}`} />
            ))}
          </div>
        </div>
        {heading("w-1/5")}
        {lines(["w-full", "w-4/5", "w-11/12", "w-1/2"])}
      </div>
      {children && (
        <div className="flex h-9 shrink-0 items-center justify-center gap-2 text-xs text-zinc-500">
          <Pulse />
          {children}
        </div>
      )}
    </div>
  );
}

const GITHUB_BLOB = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+?)\//;

function renderer(
  { renderToHtml }: typeof import("md4x"),
  purify: typeof import("dompurify").default,
): Renderer {
  let link: Link = (value) => value;
  // Other pages open in a new tab.
  const resolve = (value: string, image: boolean) => {
    const url = link(value, image);
    // A GitHub `blob/` link is a page, not the file: GitHub itself shows the raw one.
    return image ? url?.replace(GITHUB_BLOB, "https://raw.githubusercontent.com/$1/$2/") : url;
  };
  const set = (node: Element, name: string, value: string | undefined) =>
    value === undefined ? node.removeAttribute(name) : node.setAttribute(name, value);
  purify.addHook("afterSanitizeAttributes", (node) => {
    const href = node.getAttribute("href");
    if (href && !href.startsWith("#")) set(node, "href", resolve(href, false));
    const src = node.getAttribute("src");
    if (src) set(node, "src", resolve(src, true));
    // Tailwind's preflight sets `height: auto` on images, over the attribute: a style wins it back.
    const height = node.tagName === "IMG" && /^\d+(\.\d+)?/.exec(node.getAttribute("height") ?? "");
    if (height) (node as HTMLElement).style.height = `${height[0]}px`;
    // `<picture>` sources: `url descriptor, url descriptor`.
    const srcset = node.getAttribute("srcset");
    if (srcset) {
      const parts = srcset.split(",").flatMap((part) => {
        const [url = "", ...rest] = part.trim().split(/\s+/);
        const to = resolve(url, true);
        return to ? [[to, ...rest].join(" ")] : [];
      });
      set(node, "srcset", parts.join(", ") || undefined);
    }
    // A source for one scheme follows the site's toggle, not the system (src/theme.ts).
    const scheme = /^\(prefers-color-scheme:\s*(light|dark)\)$/.exec(
      node.getAttribute("media") ?? "",
    )?.[1] as "light" | "dark" | undefined;
    if (node.tagName === "SOURCE" && scheme) {
      node.setAttribute("data-scheme", scheme);
      node.setAttribute("media", schemeMedia(scheme));
    }
    if (node.tagName === "A" && !node.getAttribute("href")?.startsWith("#")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (text, to) => {
    const html = renderToHtml(text, {
      headingIds: true,
      // rangi escapes the code; md4x puts what this returns in place of its own block.
      highlighter: (code, { lang }) => {
        const pre = `<pre>${highlightText(code, { lang: lang || "plain", lineNumbers: false })}</pre>`;
        return isRunnable(lang) ? nodeboxPlaceholder(code, pre) : pre;
      },
    });
    link = to;
    // Page-wide styles and forms stay out; ids get a prefix so they cannot clash with the app's.
    return purify.sanitize(html, {
      FORBID_TAGS: ["style", "form"],
      SANITIZE_NAMED_PROPS: true,
    });
  };
}
