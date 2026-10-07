// The app as an IDE: top bar, sidebar views, the editor, a bottom panel and a status bar.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPackage } from "upm/resolver";
import { runsOn, type Platform, type Resolution } from "upm/src/resolve.ts";
import { createSbom, SBOM } from "upm/src/sbom.ts";
import type { TarEntry } from "upm/src/tar.ts";
import {
  createClient,
  DEFAULT_REGISTRY,
  type Client,
  type FullManifest,
  type Resolved,
  type Size,
  type Tarball,
  type Top,
} from "./lib/client.ts";
import { Dependencies, type Picks } from "./components/deps.tsx";
import { Breadcrumb, Editor } from "./components/editor.tsx";
import { Explorer, STORE_ENTRY, treePath } from "./components/files.tsx";
import { loadMarkdown } from "./components/markdown.tsx";
import { fillCrypto } from "./lib/insecure.ts";
import { opfsSize } from "./lib/opfs.ts";
import {
  installInTab,
  installProgress,
  manifestOf,
  type Installed,
  type InstalledFile,
  type Target,
} from "./lib/install.ts";
import { Panel, type PanelTab, type Problem } from "./components/panel.tsx";
import { EXAMPLES, normalSpec, openOf, pathOf, searchOf, specOf, type Lines } from "./lib/route.ts";
import { StatusBar } from "./components/statusbar.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { TopBar } from "./components/topbar.tsx";

// Off https and localhost, WebCrypto is missing: fill it in before anything hashes.
const insecure = fillCrypto();

/** What ./lib/node.ts's shim says it is unless told otherwise: the builds a browser can run. */
export const WASM: Target = { arch: "wasm32", libc: "glibc" };

/** One query as it lands: each part is undefined while pending, an Error when it failed. */
export interface View {
  /** The run it belongs to; a new run remounts what was made for the last one. */
  id: number;
  spec: string;
  name: string;
  started: number;
  top?: Top | Error;
  manifest?: FullManifest | Error;
  tarball?: Tarball | Error;
  /** The README, out of the tarball's stream while the rest still downloads. */
  readme?: TarEntry;
  /** The Install button was pressed: the tree's walk, then upm's install, are under way. */
  requested?: boolean;
  resolved?: Resolved | Error;
  /** What the resolve installs: set once the run starts. */
  dependencies?: Record<string, string>;
  /** The arch and libc the install runs as: it skips other platforms' builds. */
  target: Target;
  /** upm's install of it in this tab: true while it runs. */
  installed?: Installed | Error | true;
  sbomTarget?: Platform;
  sbomError?: Error;
  /** When the install was asked for, to draw its time while it runs. */
  installStarted?: number;
  /** Its warnings, as upm logs them. */
  installWarnings?: string[];
}

export function App({ ready }: { ready?: Promise<unknown> }) {
  const [registryUrl, setRegistryUrl] = useState(DEFAULT_REGISTRY);
  // A ref too: a change starts its run in the same handler, before the state lands.
  const [target, setTarget] = useState(WASM);
  const targetRef = useRef(target);
  const [spec, setSpec] = useState(() => specOf(location.pathname));
  // A shared link's run starts after the first draw (and the landing's transition): not the welcome.
  const [shared] = useState(() => !!spec.trim());
  const [view, setView] = useState<View>();
  const [client, setClient] = useState<Client>();
  const [selected, setSelected] = useState("");
  // A shared link's file and lines, opened once its run has them.
  const [linked] = useState(() => openOf(location.search));
  const [lines, setLines] = useState(linked.lines);
  // Whether the open file goes in the url: one picked, not the README a run opens on.
  const [pinned, setPinned] = useState(!!linked.file);
  const [panel, setPanel] = useState<PanelTab>();
  // Once the panel was opened or closed, it stays as left. A small screen can't spare the room.
  const panelSet = useRef(narrow());
  // A small screen opens on the README: the sidebar waits for the Install button.
  const [sidebar, setSidebar] = useState(() => !narrow());
  const [breadcrumb, setBreadcrumb] = useState<HTMLElement | null>(null);
  // A breadcrumb part to show in the Explorer; a new object each click, so the same one repeats.
  const [reveal, setReveal] = useState<{ path: string }>();
  const column = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const picks = useRef<Picks>(new Map());
  /** The picks the registry gave a size for. */
  const sized = useRef<{ pkg: ResolvedPackage; size: Size }[]>([]);
  /** The last install that finished, shown while a reinstall of the same run is under way. */
  const last = useRef<{ id: number; installed: Installed }>(undefined);
  const run = useRef(0);
  /** Starts the current run's resolve and install: the Install button. */
  const startInstall = useRef<() => void>(() => {});

  // Many requests and picks move per frame; draw at most once a frame.
  const redraw = useThrottledRedraw(() => setTick((n) => n + 1));

  /**
   * A run fetches the package alone; `andInstall` presses the Install button with it. It opens
   * on `file` when given, else on the package's README.
   */
  function submit(
    raw = spec,
    registry = registryUrl,
    after?: Promise<unknown>,
    andInstall = false,
    file?: string,
  ) {
    if (!raw.trim()) return;
    // A url on an allowed host shows in one form, however it was pasted.
    raw = normalSpec(raw.trim());
    setSpec(raw);
    history.replaceState(null, "", pathOf(raw.trim()));
    // The README opens as soon as the tarball's stream yields it: load its renderer alongside.
    void loadMarkdown().catch(() => {});
    const id = ++run.current;
    const next = createClient(registry, redraw);
    const live: Picks = new Map();
    picks.current = live;
    const sizes: { pkg: ResolvedPackage; size: Size }[] = [];
    sized.current = sizes;
    setClient(next);
    const update = (part: Partial<View>) =>
      run.current === id && setView((view) => view && { ...view, ...part });
    const settle = <K extends keyof View>(key: K, promise: Promise<View[K]>) =>
      promise.then(
        (value) => update({ [key]: value }),
        (error: Error) => update({ [key]: error }),
      );
    try {
      const query = next.run(raw, after);
      setView({
        id,
        spec: raw,
        name: query.name,
        started: performance.now(),
        dependencies: query.dependencies,
        target: targetRef.current,
      });
      const first = treePath(query.name, "package.json");
      const root = treePath(query.name);
      setSelected(file ?? first);
      if (!file) {
        setLines(undefined);
        setPinned(false);
      }
      settle("top", query.top);
      settle("manifest", query.manifest);
      // Open the README once it is in, unless another file was picked meanwhile. Set in the same
      // callback as the file, so the tree mounts with it already selected.
      query.readme.then((readme) => {
        if (!readme || run.current !== id) return;
        // A linked file stays, even the package's package.json.
        if (!file) setSelected((now) => (now === first ? treePath(query.name, readme.path) : now));
        update({ readme });
      });
      query.tarball.then(
        (tarball) => {
          if (run.current !== id) return;
          const paths = tarball.files.map((f) => f.path);
          const readme = readmeOf(paths);
          // A link to a file the package does not have opens on its README.
          const lost = !!file?.startsWith(root) && !paths.includes(file.slice(root.length));
          if (lost) setLines(undefined);
          if (readme) {
            setSelected((now) =>
              (now === first && !file) || (lost && now === file)
                ? treePath(query.name, readme)
                : now,
            );
          }
          update({ tarball });
        },
        (error: Error) => update({ tarball: error }),
      );
      const runTarget = targetRef.current;
      let started = false;
      startInstall.current = () => {
        if (run.current !== id || started) return;
        started = true;
        update({ requested: true });
        const resolved = query.resolve((pkg, from, size) => {
          if (size) sizes.push({ pkg, size });
          const list = live.get(from) ?? [];
          list.push({ name: pkg.name, version: pkg.source ?? pkg.version, optional: pkg.optional });
          live.set(from, list);
          redraw();
        });
        settle("resolved", resolved);
        // Then upm installs it, which finds the registry's answers in the HTTP cache.
        // Not for a run already replaced: in dev, StrictMode starts each run twice.
        resolved.then(
          (done) =>
            run.current === id &&
            install(
              id,
              query.name,
              query.dependencies,
              registry,
              next.fetch,
              done,
              runTarget,
              file,
            ),
          () => {},
        );
      };
      // A link to a file the install adds, the lockfile or a dependency's, needs the install.
      const deep = !!file && file !== "package.json" && !file.startsWith(root);
      if (andInstall) startInstall.current();
      else if (!narrow() || deep) {
        // A wide screen presses Install itself once the README (or the tarball, without one) has
        // painted, so the walk's requests don't hold it back. A small one waits for the button.
        const start = startInstall.current;
        Promise.all([query.top, query.readme, loadMarkdown().catch(() => {})]).then(
          () => requestAnimationFrame(() => setTimeout(start)),
          () => {},
        );
      }
    } catch (error) {
      setView({
        id,
        spec: raw,
        name: raw,
        started: performance.now(),
        target: targetRef.current,
        top: error as Error,
      });
    }
  }

  /** upm's own install of a run's dependencies, in this tab. */
  function install(
    id: number,
    name: string,
    dependencies: Record<string, string>,
    registry: string,
    logged: typeof fetch,
    resolved: Resolved,
    target: Target,
    file?: string,
  ) {
    const warnings: string[] = [];
    const update = (part: Partial<View>) =>
      run.current === id && setView((view) => view && { ...view, ...part });
    update({ installed: true, installStarted: performance.now(), installWarnings: warnings });
    // Its progress is upm's own, not this client's: redraw on a clock while it runs.
    const clock = setInterval(redraw, 100);
    installInTab(
      dependencies,
      registry,
      (message, level) => {
        if (level === "warn") warnings.push(message);
      },
      resolved.lockfile,
      logged,
      target,
    )
      .then(
        (installed) => {
          if (run.current !== id) return;
          installed.files.set(SBOM, sbomFile(resolved.resolution, name));
          last.current = { id, installed };
          update({ installed });
          // The tree keeps its paths through the install, so what was open still is. A linked
          // file in `.upm` may be under another hash now: its package's deps changed since.
          const moved = file && !installed.files.has(file) && rehashed(installed.files, file);
          if (file && !installed.files.has(file) && !moved) setLines(undefined);
          setSelected((now) =>
            installed.files.has(now) ? now : now === file && moved ? moved : "package.json",
          );
        },
        (error: Error) => update({ installed: error }),
      )
      .finally(() => clearInterval(clock));
  }

  // The editor pads its ends by what floats over them, so both can scroll into view.
  useEffect(() => {
    const el = overlay.current!;
    const measure = () => {
      const slot = el.firstElementChild as HTMLElement;
      const panel = el.lastElementChild as HTMLElement;
      const top = slot.offsetTop + slot.offsetHeight;
      const bottom = panel === slot ? 0 : el.clientHeight - panel.offsetTop;
      column.current!.style.setProperty("--covered-top", `${top}px`);
      column.current!.style.setProperty("--covered-bottom", `${bottom}px`);
    };
    const resize = new ResizeObserver(measure);
    // The panel mounts and unmounts; the breadcrumb slot stays and resizes with what it holds.
    const watch = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
    };
    const mutation = new MutationObserver(watch);
    mutation.observe(el, { childList: true });
    watch();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  // A shared link runs its query, once the landing's view transition allows.
  useEffect(() => {
    if (spec) submit(spec, registryUrl, ready, false, linked.file);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The url keeps the picked file and lines, so a reload or a shared link opens them again.
  const shownSpec = view?.spec.trim();
  useEffect(() => {
    if (!shownSpec) return;
    history.replaceState(
      null,
      "",
      pathOf(shownSpec) + searchOf(pinned ? selected : undefined, lines),
    );
  }, [shownSpec, pinned, selected, lines]);

  const requests = client?.requests ?? [];
  const picked = [...picks.current.values()].reduce((sum, list) => sum + list.length, 0);
  const tarball = view?.tarball instanceof Error ? undefined : view?.tarball;
  // Until the tarball lands; a tarball that fails its check takes it back.
  const readme = view?.tarball === undefined ? view?.readme : undefined;
  const name = view?.name ?? "";
  const installed =
    view?.installed === true && last.current?.id === view.id
      ? last.current.installed
      : view?.installed === true || view?.installed instanceof Error
        ? undefined
        : view?.installed;
  const dependencies = view?.dependencies;
  // In the shape the install leaves, from the start: package.json, then the package's files
  // where its link shows them, then everything else the install adds around them.
  const files = useMemo(() => {
    if (installed) return installed.files;
    if (!dependencies) return undefined;
    const early = new Map<string, InstalledFile>([["package.json", manifestOf(dependencies)]]);
    for (const file of tarball?.files ?? (readme ? [readme] : [])) {
      early.set(treePath(name, file.path), file);
    }
    return early;
  }, [tarball, readme, name, installed, dependencies]);
  // Until the install lands, what the registry says it will write here. A libc read that lands
  // later drops a pick, so it is summed again each draw.
  const estimate =
    installed || view?.installed instanceof Error
      ? undefined
      : estimateOf(sized.current, view?.target ?? WASM);
  // upm's own counts, as the CLI's bar draws them, on the install's clock. Pending while there
  // is nothing to count yet: the resolve, and the install's first downloads.
  const busy =
    !!view?.requested &&
    !(view.top instanceof Error || view.resolved instanceof Error) &&
    (view.installed === undefined || view.installed === true);
  const progress = busy ? progressOf(view.installed === true) : undefined;
  const problems = useMemo(() => problemsOf(view), [view]);
  // The console maps the stack through the sourcemaps, which the Problems panel cannot.
  useEffect(() => {
    for (const { source, error } of problems) {
      if (!error || logged.has(error)) continue;
      logged.add(error);
      console.error(`[${source}]`, error);
    }
  }, [problems]);
  // A bare name shows the version it resolved to, while the box still holds that run's spec.
  const top = view?.top instanceof Error ? undefined : view?.top;
  const version = top && spec === view?.spec && spec.trim() === view.name ? top.version : undefined;

  // The panel opens on its own once it has a request or a problem to show.
  const hasEntries = requests.length > 0 || problems.length > 0;
  useEffect(() => {
    if (!hasEntries || panelSet.current) return;
    panelSet.current = true;
    setPanel(requests.length > 0 ? "requests" : "problems");
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEntries]);

  /** A fresh run of the same spec that installs right away, on the same picked file. */
  const reinstall = () => {
    if (!view) return;
    submit(view.spec, registryUrl, undefined, true, pinned ? selected : undefined);
    setSidebar(true);
  };
  /** A run that installed, or was asked to, installs again as the new target. */
  const chooseTarget = (next: Target) => {
    targetRef.current = next;
    setTarget(next);
    if (view?.requested) reinstall();
  };
  const chooseSbomTarget = (target?: Platform) => {
    const resolved = view?.resolved;
    if (!view || !installed || !resolved || resolved instanceof Error) return;
    try {
      const file = sbomFile(resolved.resolution, view.name, target);
      const next = { ...installed, files: new Map(installed.files) };
      next.files.set(SBOM, file);
      last.current = { id: view.id, installed: next };
      setView({ ...view, installed: next, sbomTarget: target, sbomError: undefined });
    } catch (error) {
      setView({
        ...view,
        sbomTarget: target,
        sbomError: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };
  /** A file the user opens: it goes in the url. */
  const pick = (path: string) => {
    setSelected(path);
    setLines(undefined);
    setPinned(true);
  };
  const pickLines = (picked: Lines | undefined) => {
    setLines(picked);
    setPinned(true);
  };
  /** The Install button: the sidebar shows the tree as it comes in. */
  const installNow = () => {
    startInstall.current();
    setSidebar(true);
  };

  const choosePanel = (tab: PanelTab | undefined) => {
    panelSet.current = true;
    setPanel(tab);
  };
  const togglePanel = (tab: PanelTab) => choosePanel(panel === tab ? undefined : tab);

  // OPFS's size, for the status bar and the Storage tab: asked again as the panel changes and as
  // an install starts or ends. The store's writes trail the install, so it may lag a little.
  const [opfs, setOpfs] = useState<number>();
  const installState = view?.installed;
  useEffect(() => {
    void opfsSize().then(setOpfs);
  }, [panel, installState]);

  // Ctrl or Cmd and ` shows or hides the panel, as in VS Code: it opens on the tab it last had.
  const lastPanel = useRef<PanelTab>("requests");
  useEffect(() => {
    if (panel) lastPanel.current = panel;
  }, [panel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Backquote" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (e.repeat) return;
      panelSet.current = true;
      setPanel((tab) => (tab ? undefined : lastPanel.current));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-(--chrome-bg) text-sm text-zinc-900 dark:text-zinc-100">
      <TopBar
        spec={spec}
        setSpec={setSpec}
        onRun={(raw) => submit(raw)}
        version={version}
        view={view}
      />

      {/* Margins grow with the page; the sidebar floats on the right at full height, the editor
          runs to the left edge and the panel sits below it. */}
      <div
        className={`relative flex min-h-0 flex-1 pb-3 ${sidebar ? "max-sm:flex-col sm:flex-row-reverse" : "flex-col"}`}
      >
        <Sidebar
          reveal={reveal}
          open={sidebar}
          setOpen={setSidebar}
          explorer={
            <Explorer
              view={view}
              files={files}
              links={installed?.links}
              estimate={estimate}
              progress={progress}
              picked={picked}
              selected={selected}
              reveal={reveal}
              onInstall={installNow}
              onReinstall={reinstall}
              onSelect={(path) => {
                pick(path);
                // On a small screen the sidebar floats over the editor: get it out of the way.
                if (narrow()) setSidebar(false);
              }}
            />
          }
          dependencies={
            <Dependencies
              view={view}
              onInstall={installNow}
              picks={picks.current}
              picked={picked}
              resolved={view?.resolved}
            />
          }
        />

        {/* The breadcrumb and the panel float over the editor's ends, which scroll under them. */}
        <div ref={column} className="relative min-h-0 min-w-0 flex-1">
          <main className="h-full">
            <Breadcrumb
              value={{
                slot: breadcrumb,
                reveal: (path) => {
                  setSidebar(true);
                  setReveal({ path });
                },
                open: (path) => {
                  pick(path);
                  setReveal({ path });
                },
              }}
            >
              <Editor
                view={view}
                files={files}
                selected={selected}
                lines={lines}
                onLines={pickLines}
                picked={picked}
                starting={shared}
                examples={EXAMPLES}
                onRun={submit}
                onInstall={installNow}
                onSbomTarget={chooseSbomTarget}
              />
            </Breadcrumb>
          </main>

          <div
            ref={overlay}
            className="pointer-events-none absolute inset-0 flex flex-col justify-between *:pointer-events-auto"
          >
            <div ref={setBreadcrumb} className="shrink-0" />

            <Panel
              tab={panel}
              setTab={choosePanel}
              onClose={() => choosePanel(undefined)}
              requests={requests}
              problems={problems}
              opfs={opfs}
              setOpfs={setOpfs}
            />
          </div>
        </div>
      </div>

      <StatusBar
        view={view}
        picked={picked}
        requests={requests}
        problems={problems}
        panel={panel}
        togglePanel={togglePanel}
        opfs={opfs}
        target={target}
        setTarget={chooseTarget}
        registry={registryUrl}
        setRegistry={(url) => {
          setRegistryUrl(url);
          submit(spec, url);
        }}
      />
    </div>
  );
}

function sbomFile(resolution: Resolution, name: string, target?: Platform): InstalledFile {
  const data = new TextEncoder().encode(
    `${JSON.stringify(createSbom(resolution, name, { target }), null, 2)}\n`,
  );
  return { path: SBOM, mode: 0o644, size: data.length, data };
}

function progressOf(installing: boolean): number | "pending" {
  const done = installing ? installProgress() : undefined;
  return done ? done : "pending";
}

/** What the picks that run here unpack to, as the registry says. */
function estimateOf(sized: { pkg: ResolvedPackage; size: Size }[], target: Target): Size {
  const platform = { os: "linux", cpu: target.arch, libc: target.libc };
  const sum = { files: 0, bytes: 0 };
  for (const { pkg, size } of sized) {
    if (!runsOn(pkg, platform)) continue;
    sum.files += size.files;
    sum.bytes += size.bytes;
  }
  return sum;
}

/** Too small a screen to spare room for the panel, or for the sidebar beside the editor. */
function narrow(): boolean {
  return innerWidth < 640;
}

/** Errors already in the console: a view is set again on every update. */
const logged = new WeakSet<Error>();

/** Each failed part once (a failed walk fails the parts after it with the same error), then the warnings. */
function problemsOf(view: View | undefined): Problem[] {
  if (!view) return [];
  const problems: Problem[] = [];
  const seen = new Set<Error>();
  for (const [source, part] of [
    ["resolve", view.top],
    ["resolve", view.resolved],
    ["manifest", view.manifest],
    ["tarball", view.tarball],
    ["install", view.installed],
  ] as const) {
    if (!(part instanceof Error) || seen.has(part)) continue;
    seen.add(part);
    problems.push({ level: "error", source, message: part.message, error: part });
  }
  const done = view.resolved instanceof Error ? undefined : view.resolved;
  for (const message of done?.resolution.warnings ?? []) {
    problems.push({ level: "warning", source: "resolver", message });
  }
  for (const message of view.installWarnings ?? []) {
    problems.push({ level: "warning", source: "install", message });
  }
  if (insecure) problems.push({ level: "warning", source: "app", message: insecure });
  return problems;
}

function useThrottledRedraw(redraw: () => void): () => void {
  const pending = useRef(false);
  const latest = useRef(redraw);
  latest.current = redraw;
  return useMemo(
    () => () => {
      if (pending.current) return;
      pending.current = true;
      requestAnimationFrame(() => {
        pending.current = false;
        latest.current();
      });
    },
    [],
  );
}

/** `path` in the same `.upm` entry, `<name>@<version>`, under another hash. */
function rehashed(files: Map<string, InstalledFile>, path: string): string | undefined {
  const parts = path.split("/");
  const at = parts.indexOf(".upm") + 1;
  const entry = at > 0 && STORE_ENTRY.exec(parts[at] ?? "");
  if (!entry) return;
  const rest = `/${parts.slice(at + 1).join("/")}`;
  const head = `${parts.slice(0, at).join("/")}/${entry[1]}-`;
  for (const other of files.keys()) {
    if (other.startsWith(head) && other.endsWith(rest) && other.length === path.length) {
      return other;
    }
  }
}

/** The package's README at its root, Markdown first. */
function readmeOf(paths: string[]): string | undefined {
  return (
    paths.find((path) => /^readme\.(md|markdown)$/i.test(path)) ??
    paths.find((path) => /^readme(\.|$)/i.test(path))
  );
}
