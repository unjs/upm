// The app as an IDE: top bar, sidebar views, the editor, a bottom panel and a status bar.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedPackage } from "upm/resolver";
import { runsOn } from "upm/src/resolve.ts";
import {
  createClient,
  DEFAULT_REGISTRY,
  type Client,
  type FullManifest,
  type Resolved,
  type Size,
  type Tarball,
} from "./lib/client.ts";
import { Dependencies, type Picks } from "./components/deps.tsx";
import { Breadcrumb, Editor } from "./components/editor.tsx";
import { Explorer, treePath } from "./components/files.tsx";
import { loadMarkdown } from "./components/markdown.tsx";
import { fillCrypto } from "./lib/insecure.ts";
import {
  installInTab,
  installProgress,
  manifestOf,
  type Installed,
  type InstalledFile,
} from "./lib/install.ts";
import { Package } from "./components/package.tsx";
import { Panel, type PanelTab, type Problem } from "./components/panel.tsx";
import { EXAMPLES, pathOf, specOf } from "./lib/route.ts";
import { StatusBar } from "./components/statusbar.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { TopBar } from "./components/topbar.tsx";

// Off https and localhost, WebCrypto is missing: fill it in before anything hashes.
const insecure = fillCrypto();

/** The platform ./lib/node.ts's shim says it is: the install skips other platforms' builds. */
const PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" };

/** One query as it lands: each part is undefined while pending, an Error when it failed. */
export interface View {
  /** The run it belongs to; a new run remounts what was made for the last one. */
  id: number;
  spec: string;
  name: string;
  started: number;
  top?: ResolvedPackage | Error;
  manifest?: FullManifest | Error;
  tarball?: Tarball | Error;
  resolved?: Resolved | Error;
  /** What the resolve installs: set once the run starts. */
  dependencies?: Record<string, string>;
  /** upm's install of it in this tab: true while it runs. */
  installed?: Installed | Error | true;
  /** When the install was asked for, to draw its time while it runs. */
  installStarted?: number;
  /** Its warnings, as upm logs them. */
  installWarnings?: string[];
}

export function App({ ready }: { ready?: Promise<unknown> }) {
  const [registryUrl, setRegistryUrl] = useState(DEFAULT_REGISTRY);
  const [spec, setSpec] = useState(() => specOf(location.pathname));
  // A shared link's run starts after the first draw (and the landing's transition): not the welcome.
  const [shared] = useState(() => !!spec.trim());
  const [view, setView] = useState<View>();
  const [client, setClient] = useState<Client>();
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState<PanelTab>();
  // Once the panel was opened or closed, it stays as left. A small screen can't spare the room.
  const panelSet = useRef(narrow());
  const [sidebar, setSidebar] = useState(true);
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

  // Many requests and picks move per frame; draw at most once a frame.
  const redraw = useThrottledRedraw(() => setTick((n) => n + 1));

  function submit(raw = spec, registry = registryUrl, after?: Promise<unknown>) {
    if (!raw.trim()) return;
    setSpec(raw);
    history.replaceState(null, "", pathOf(raw.trim()));
    // The README opens once the tarball lands: load its renderer alongside.
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
      const query = next.run(
        raw,
        (pkg, from, size) => {
          if (size) sizes.push({ pkg, size });
          const list = live.get(from) ?? [];
          list.push({ name: pkg.name, version: pkg.source ?? pkg.version, optional: pkg.optional });
          live.set(from, list);
          redraw();
        },
        after,
      );
      setView({
        id,
        spec: raw,
        name: query.name,
        started: performance.now(),
        dependencies: query.dependencies,
      });
      setSelected(treePath(query.name, "package.json"));
      settle("top", query.top);
      settle("manifest", query.manifest);
      // Open the README once the files are in, unless another file was picked meanwhile. Set in
      // the same callback as the tarball, so the tree mounts with it already selected.
      query.tarball.then(
        (tarball) => {
          if (run.current !== id) return;
          const readme = readmeOf(tarball.files.map((f) => f.path));
          if (readme) {
            const first = treePath(query.name, "package.json");
            setSelected((now) => (now === first ? treePath(query.name, readme) : now));
          }
          update({ tarball });
        },
        (error: Error) => update({ tarball: error }),
      );
      settle("resolved", query.resolved);
      // Then upm installs it, which finds the registry's answers in the HTTP cache.
      // Not for a run already replaced: in dev, StrictMode starts each run twice.
      query.resolved.then(
        (resolved) =>
          run.current === id && install(id, query.dependencies, registry, resolved.lockfile),
        () => {},
      );
    } catch (error) {
      setView({ id, spec: raw, name: raw, started: performance.now(), top: error as Error });
    }
  }

  /** upm's own install of a run's dependencies, in this tab. */
  function install(
    id: number,
    dependencies: Record<string, string>,
    registry: string,
    lockfile?: string,
  ) {
    const warnings: string[] = [];
    const update = (part: Partial<View>) =>
      run.current === id && setView((view) => view && { ...view, ...part });
    update({ installed: true, installStarted: performance.now(), installWarnings: warnings });
    // Its requests are upm's own, not this client's: redraw on a clock while it runs.
    const clock = setInterval(redraw, 100);
    installInTab(
      dependencies,
      registry,
      (message, level) => {
        if (level === "warn") warnings.push(message);
      },
      lockfile,
    )
      .then(
        (installed) => {
          last.current = { id, installed };
          update({ installed });
          // The tree keeps its paths through the install, so what was open still is.
          if (run.current === id) {
            setSelected((now) => (installed.files.has(now) ? now : "package.json"));
          }
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
    if (spec) submit(spec, registryUrl, ready);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requests = client?.requests ?? [];
  const picked = [...picks.current.values()].reduce((sum, list) => sum + list.length, 0);
  const tarball = view?.tarball instanceof Error ? undefined : view?.tarball;
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
    for (const file of tarball?.files ?? []) early.set(treePath(name, file.path), file);
    return early;
  }, [tarball, name, installed, dependencies]);
  // Until the install lands, what the registry says it will write here. A libc read that lands
  // later drops a pick, so it is summed again each draw.
  const estimate =
    installed || view?.installed instanceof Error ? undefined : estimateOf(sized.current);
  // upm's own counts, as the CLI's bar draws them, on the install's clock. Pending while there
  // is nothing to count yet: the resolve, and the install's first downloads.
  const busy =
    !!view &&
    !(view.top instanceof Error || view.resolved instanceof Error) &&
    (view.installed === undefined || view.installed === true);
  const progress = busy ? progressOf(view.installed === true) : undefined;
  const problems = useMemo(() => problemsOf(view), [view]);
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

  const choosePanel = (tab: PanelTab | undefined) => {
    panelSet.current = true;
    setPanel(tab);
  };
  const togglePanel = (tab: PanelTab) => choosePanel(panel === tab ? undefined : tab);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-(--chrome-bg) text-sm text-zinc-900 dark:text-zinc-100">
      <TopBar
        spec={spec}
        setSpec={setSpec}
        onRun={(raw) => submit(raw)}
        version={version}
        view={view}
      />

      {/* Margins grow with the page; the sidebar floats on the left at full height, the editor
          runs to the right edge and the panel sits below it. */}
      <div className="relative flex min-h-0 flex-1 pb-3 max-sm:flex-col">
        <Sidebar
          reveal={reveal}
          open={sidebar}
          setOpen={setSidebar}
          count={view && !view.resolved ? picked : undefined}
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
              onSelect={(path) => {
                setSelected(path);
                // On a small screen the sidebar floats over the editor: get it out of the way.
                if (narrow()) setSidebar(false);
              }}
            />
          }
          package={<Package view={view} />}
          dependencies={
            <Dependencies
              started={!!view}
              picks={picks.current}
              picked={picked}
              resolved={view?.resolved}
            />
          }
        />

        {/* The breadcrumb and the panel float over the editor's ends, which scroll under them. */}
        <div ref={column} className="relative min-h-0 min-w-0 flex-1 max-sm:ml-3">
          <main className="h-full">
            <Breadcrumb
              value={{
                slot: breadcrumb,
                reveal: (path) => {
                  setSidebar(true);
                  setReveal({ path });
                },
                open: (path) => {
                  setSelected(path);
                  setReveal({ path });
                },
              }}
            >
              <Editor
                view={view}
                files={files}
                selected={selected}
                picked={picked}
                starting={shared}
                examples={EXAMPLES}
                onRun={submit}
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
        registry={registryUrl}
        setRegistry={(url) => {
          setRegistryUrl(url);
          submit(spec, url);
        }}
      />
    </div>
  );
}

function progressOf(installing: boolean): number | "pending" {
  const done = installing ? installProgress() : undefined;
  return done ? done : "pending";
}

/** What the picks that run here unpack to, as the registry says. */
function estimateOf(sized: { pkg: ResolvedPackage; size: Size }[]): Size {
  const sum = { files: 0, bytes: 0 };
  for (const { pkg, size } of sized) {
    if (!runsOn(pkg, PLATFORM)) continue;
    sum.files += size.files;
    sum.bytes += size.bytes;
  }
  return sum;
}

/** Too small a screen to spare room for the panel, or for the sidebar beside the editor. */
function narrow(): boolean {
  return innerWidth < 640;
}

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
    problems.push({ level: "error", source, message: part.message });
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

/** The package's README at its root, Markdown first. */
function readmeOf(paths: string[]): string | undefined {
  return (
    paths.find((path) => /^readme\.(md|markdown)$/i.test(path)) ??
    paths.find((path) => /^readme(\.|$)/i.test(path))
  );
}
