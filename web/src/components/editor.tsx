// The editor pane: the selected file, or what stands in for it.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { View } from "../app.tsx";
import { Code, formatBytes, preview } from "./code.tsx";
import { LOCK, linked, treePath } from "./files.tsx";
import { bindInstall, installCard } from "./install.ts";
import { InstallButton } from "./install-button.tsx";
import type { InstalledFile } from "../lib/install.ts";
import type { Lines } from "../lib/route.ts";
import { toBase64 } from "upm/src/runtime.ts";
import { SBOM } from "upm/src/sbom.ts";
import type { Platform } from "upm/src/resolve.ts";
import { Markdown, MarkdownSkeleton, type Link } from "./markdown.tsx";
import { PackageMeta, sourceUrl } from "./package.tsx";
import { ErrorBox, IconButton, Icon, Waiting } from "./ui.tsx";

/** Where the open file's breadcrumb goes (floating over the top of the editor, unless it sits
 * above rendered Markdown), and what a click on one of its parts does. */
export const Breadcrumb = createContext<{
  slot: HTMLElement | null;
  reveal: (path: string) => void;
  /** Opens a file of the tree, as a README's link to it does. */
  open: (path: string) => void;
}>({ slot: null, reveal: () => {}, open: () => {} });

export function Editor(props: {
  view: View | undefined;
  files: Map<string, InstalledFile> | undefined;
  selected: string;
  /** The open file's picked lines. */
  lines?: Lines;
  onLines: (lines: Lines | undefined) => void;
  picked: number;
  /** A run is about to start, so no welcome. */
  starting?: boolean;
  examples: string[];
  onRun: (spec: string) => void;
  onInstall: () => void;
  onSbomTarget: (target?: Platform) => void;
}) {
  const { view, files, selected, lines, onLines, picked } = props;
  if (!view && props.starting) return <MarkdownSkeleton />;
  if (!view) return <Welcome examples={props.examples} onRun={props.onRun} />;
  // The status bar shows the walk's progress; the README skeleton holds its place.
  if (!view.top) return <MarkdownSkeleton />;
  if (view.top instanceof Error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <ErrorBox error={view.top} title={`Could not resolve ${view.spec}`} />
      </div>
    );
  }
  if (selected === LOCK) {
    return <Lockfile resolved={view.resolved} picked={picked} lines={lines} onLines={onLines} />;
  }
  const file = files?.get(selected);
  if (selected === SBOM && file) {
    return (
      <Sbom view={view} file={file} lines={lines} onLines={onLines} onTarget={props.onSbomTarget} />
    );
  }
  if (files && file) {
    const manifest = view.manifest instanceof Error ? undefined : view.manifest;
    const root = treePath(view.name);
    const own = selected.startsWith(root);
    // The package's own README opens with its details, how to install upm and it, and, until
    // the install is asked for, the Install button.
    const readme = own && /^readme\.(md|markdown)$/i.test(selected.slice(root.length));
    return (
      <FileView
        path={selected}
        file={file}
        files={files}
        lines={lines}
        onLines={onLines}
        install={
          readme && (
            <InstallCard
              spec={view.name}
              meta={<PackageMeta view={view} onInstall={props.onInstall} />}
            >
              <InstallButton view={view} onInstall={props.onInstall} />
            </InstallCard>
          )
        }
        repo={own ? sourceUrl(manifest) : undefined}
        root={root}
      />
    );
  }
  if (view.tarball instanceof Error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <ErrorBox error={view.tarball} title="Could not fetch the tarball" />
      </div>
    );
  }
  // Most packages open on their README once the tarball lands.
  if (!view.tarball) return <MarkdownSkeleton>Fetching tarball</MarkdownSkeleton>;
  // A link to a file the install adds opens it once the install lands.
  const installing =
    view.requested &&
    !(view.resolved instanceof Error) &&
    (view.installed === undefined || view.installed === true);
  if (installing) return <Waiting live>Installing</Waiting>;
  return <Waiting>Select a file</Waiting>;
}

/** A base that resolves a README's relative urls to tree paths. */
const TREE = "https://tree.invalid/";

/** An image of the tree as a `data:` url: no object url to revoke. */
function dataUrl(path: string, data: Uint8Array): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const type = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
  return `data:image/${type};base64,${toBase64(data)}`;
}

function FileView(props: {
  path: string;
  file: InstalledFile;
  files: Map<string, InstalledFile>;
  lines?: Lines;
  onLines: (lines: Lines | undefined) => void;
  /** Shown above the rendered Markdown. */
  install?: ReactNode;
  /** The package's folder in its repository, for what its tarball leaves out. */
  repo?: string;
  /** The package's tree path, where `repo` begins. */
  root: string;
}) {
  const { path, file, files, lines, onLines, repo, root } = props;
  const { open } = useContext(Breadcrumb);
  // A symlink shows the file it leads to; one out of the tree shows its target path.
  const target = useMemo(() => linked(files, file), [files, file]);
  const content = target ?? file;
  const shown = useMemo(() => preview(content.path, content.data), [content]);
  // Markdown opened at its lines, as from a link, shows its source.
  const [source, setSource] = useState(!!lines);
  const markdown = shown.lang === "md" || shown.lang === "markdown";
  // Relative links and images in a README point into the tree, which holds the tarball's files:
  // an image shows from its bytes, a link opens the file here. What the tarball leaves out, such
  // as a logo or a chart, is in the repository, where npm's own site finds it too.
  const link = useMemo<Link>(
    () => (value, image) => {
      const url = URL.parse(value, TREE + path);
      if (url?.origin !== TREE.slice(0, -1)) return url?.href ?? value;
      const at = decodeURIComponent(url.pathname.slice(1));
      const found = files.get(at);
      if (found) return image ? dataUrl(at, found.data) : `#/${at}`;
      if (repo && at.startsWith(root)) return repo + url.href.slice(TREE.length + root.length);
    },
    [path, files, repo, root],
  );
  const crumbs = (
    <Crumbs
      path={path}
      meta={
        target
          ? `${file.link === undefined ? "" : `→ ${file.link} · `}${formatBytes(target.size)} · ${shown.lang || "plain"}`
          : "symlink, to the path shown"
      }
      actions={
        markdown && (
          <IconButton
            icon={source ? "eye" : "code"}
            title={source ? "Show the rendered Markdown" : "Show the Markdown source"}
            onClick={() => {
              setSource(!source);
              if (source) onLines(undefined);
            }}
          >
            {source ? "preview" : "source"}
          </IconButton>
        )
      }
    />
  );
  // Rendered Markdown holds its breadcrumb above the article, in the same scroll.
  if (markdown && !source) {
    return (
      <Markdown text={shown.text} link={link} onOpen={open}>
        {props.install}
        <div className="mx-auto max-w-[860px] px-4 pt-4 first:pt-8 sm:px-8">{crumbs}</div>
      </Markdown>
    );
  }
  return (
    <Frame crumbs={crumbs}>
      <Code {...shown} lines={lines} onLines={onLines} />
    </Frame>
  );
}

/**
 * `meta`, then `children` beside a button that shows the commands that install upm and add this
 * package, as wide as the README under it.
 */
function InstallCard(props: { spec: string; meta: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(commandsOpen);
  useEffect(() => bindInstall(ref.current!), []);
  return (
    <div className="mx-auto max-w-[860px] px-4 pt-8 sm:px-8">
      <div className="space-y-4 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        {props.meta}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          {props.children}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((commandsOpen = !open))}
            className="flex shrink-0 items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-amber-600 dark:text-zinc-400 dark:hover:text-amber-500"
          >
            Install with upm
            <Icon
              name="chevron"
              className={`size-3.5 text-zinc-400 transition-transform ${open ? "-rotate-90" : "rotate-90"}`}
            />
          </button>
        </div>
        <div
          ref={ref}
          hidden={!open}
          dangerouslySetInnerHTML={{ __html: installCard("", props.spec) }}
        />
      </div>
    </div>
  );
}

// Whether the commands to install upm and add the package show, kept for the next package.
let commandsOpen = false;

function Lockfile(props: {
  resolved: View["resolved"];
  picked: number;
  lines?: Lines;
  onLines: (lines: Lines | undefined) => void;
}) {
  const { resolved, picked } = props;
  if (!resolved) return <Waiting live>Resolving · {picked} picked</Waiting>;
  if (resolved instanceof Error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <ErrorBox error={resolved} title="No lockfile: the resolve failed" />
      </div>
    );
  }
  const text = resolved.lockfile;
  return (
    <Frame
      crumbs={
        <Crumbs
          path={LOCK}
          meta={`${formatBytes(text.length)} · json`}
          actions={<FileActions path={LOCK} content={() => text} />}
        />
      }
    >
      <Code text={text} lang="json" lines={props.lines} onLines={props.onLines} />
    </Frame>
  );
}

function Sbom({
  view,
  file,
  lines,
  onLines,
  onTarget,
}: {
  view: View;
  file: InstalledFile;
  lines?: Lines;
  onLines: (lines: Lines | undefined) => void;
  onTarget: (target?: Platform) => void;
}) {
  const shown = useMemo(() => preview(SBOM, file.data), [file]);
  const target = view.sbomTarget;
  return (
    <Frame
      crumbs={
        <Crumbs
          path={SBOM}
          meta={`${formatBytes(file.size)} · json · resolved tree`}
          actions={
            <>
              <select
                aria-label="SBOM target"
                value={target ? [target.os, target.cpu, target.libc].filter(Boolean).join("/") : ""}
                disabled={view.installed === true}
                onChange={(e) => {
                  const [os, cpu, libc] = e.currentTarget.value.split("/");
                  onTarget(os && cpu ? { os, cpu, libc } : undefined);
                }}
                className="h-6 max-w-40 rounded bg-(--editor-bg) px-1 text-xs outline-none focus:ring-1 focus:ring-amber-500 dark:bg-zinc-900"
              >
                <option value="">All platforms</option>
                <option value="linux/x64/glibc">Linux x64 · glibc</option>
                <option value="linux/arm64/glibc">Linux arm64 · glibc</option>
                <option value="linux/x64/musl">Linux x64 · musl</option>
                <option value="linux/arm64/musl">Linux arm64 · musl</option>
                <option value="darwin/x64">macOS x64</option>
                <option value="darwin/arm64">macOS arm64</option>
                <option value="win32/x64">Windows x64</option>
                <option value="win32/arm64">Windows arm64</option>
                <option value="linux/wasm32/glibc">WASM inspection</option>
              </select>
              {!view.sbomError && (
                <FileActions path={SBOM} content={() => new TextDecoder().decode(file.data)} />
              )}
            </>
          }
        />
      }
    >
      {view.sbomError ? (
        <div className="mx-auto max-w-2xl p-8">
          <ErrorBox error={view.sbomError} title="Could not export this target" />
        </div>
      ) : (
        <Code {...shown} lines={lines} onLines={onLines} />
      )}
    </Frame>
  );
}

function FileActions({ path, content }: { path: string; content: () => string }) {
  const [label, setLabel] = useState("copy");
  return (
    <>
      <IconButton
        icon="copy"
        title="Copy"
        onClick={() => {
          const show = (text: string) => {
            setLabel(text);
            setTimeout(() => setLabel("copy"), 1200);
          };
          navigator.clipboard.writeText(content()).then(
            () => show("copied"),
            () => show("failed"),
          );
        }}
      >
        <span className={path === SBOM ? "hidden md:inline" : undefined}>{label}</span>
      </IconButton>
      <IconButton
        icon="download"
        title="Download"
        onClick={() => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([content()], { type: "application/json" }));
          a.download = path;
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        <span className={path === SBOM ? "hidden md:inline" : undefined}>download</span>
      </IconButton>
    </>
  );
}

/** The content, with its breadcrumb floating in the slot over it. */
function Frame(props: { crumbs: ReactNode; children: ReactNode }) {
  const { slot } = useContext(Breadcrumb);
  return (
    <div className="h-full">
      {props.children}
      {slot &&
        createPortal(<div className="pl-3 sm:pl-6 lg:pl-10 xl:pl-16">{props.crumbs}</div>, slot)}
    </div>
  );
}

/** The file's path, details and actions. */
function Crumbs(props: { path: string; meta: string; actions?: ReactNode }) {
  const { reveal } = useContext(Breadcrumb);
  const parts = props.path.split("/");
  return (
    <div className="flex h-9 items-center gap-1 overflow-hidden rounded-xl border border-zinc-200/40 bg-(--editor-bg)/50 px-3 text-xs whitespace-nowrap text-zinc-500 backdrop-blur-xl backdrop-saturate-150 dark:border-white/5">
      <Icon name={props.path === LOCK ? "lock" : "files"} className="mr-1 size-3.5 text-zinc-400" />
      {parts.map((part, i) => (
        <span
          key={i}
          className={`flex items-center gap-1 ${i === parts.length - 1 ? "shrink-0" : "min-w-0"}`}
        >
          {i > 0 && <Icon name="chevron" className="size-3 text-zinc-400" />}
          <button
            type="button"
            title="Show in the Explorer"
            onClick={() => reveal(parts.slice(0, i + 1).join("/"))}
            className={`rounded px-0.5 hover:bg-zinc-200/60 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${
              i === parts.length - 1
                ? "font-medium text-zinc-800 dark:text-zinc-200"
                : "min-w-0 truncate"
            }`}
          >
            {part}
          </button>
        </span>
      ))}
      <span className="ml-auto hidden shrink-0 pl-4 font-mono text-[11px] text-zinc-400 sm:inline">
        {props.meta}
      </span>
      <span className="ml-auto sm:hidden" />
      <span className="flex items-center gap-1">{props.actions}</span>
    </div>
  );
}

function Welcome({ examples, onRun }: { examples: string[]; onRun: (spec: string) => void }) {
  return (
    <div className="flex h-full overflow-auto p-8">
      <div className="m-auto max-w-lg text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <h1 className="mb-3 font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          upm
        </h1>
        <p>
          Type a package spec above and press Enter. Everything runs in this tab, straight against
          the registry:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            The package's tarball is downloaded, integrity-checked and unpacked into the Explorer,
            or read from upm's store once an install has put it there.
          </li>
          <li>Every registry request shows in the Requests panel.</li>
          <li>
            Press Install and <code className="font-mono text-xs">upm/resolver</code> walks the
            whole dependency tree (Dependencies view, live as it picks), and the lockfile upm would
            write lands as <code className="font-mono text-xs">{LOCK}</code>.
          </li>
          <li>
            Then upm's own install runs here, into an in-memory filesystem, and the Explorer shows
            the project it made: the <code className="font-mono text-xs">.upm</code> layout, the
            links and the content store.
          </li>
        </ul>
        <div className="mt-6 flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onRun(example)}
              className="rounded border border-zinc-300 px-2.5 py-0.5 font-mono text-xs hover:border-amber-500 hover:text-amber-600 dark:border-zinc-700"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
