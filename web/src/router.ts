// Moves between the landing, the app and the docs in place. All open with the logo, so a view
// transition morphs one into the other, both ways.
import { DOCS, isApp } from "./lib/route.ts";

interface Page {
  /** Returns how to take the page down, if it needs to. */
  mount(root: HTMLElement, ready?: Promise<unknown>): (() => void) | void;
}

const root = document.getElementById("root")!;
let shown: string | undefined;
let unmount: (() => void) | void;
let latest = 0;

function load(path: string): Promise<Page> {
  if (isApp(path)) return import("./play.tsx");
  if (DOCS.test(path)) return import("./docs.ts");
  return import("./landing.ts");
}

/** Shows the page for the URL, in a view transition when `morph`. */
export async function route(morph = false) {
  const path = location.pathname;
  const id = ++latest;
  // Loaded before the transition: the page is frozen while its callback runs.
  const page = await load(path);
  if (id !== latest) return;
  const show = (ready?: Promise<unknown>) => {
    unmount?.();
    root.replaceChildren();
    shown = path;
    unmount = page.mount(root, ready);
  };
  if (!morph || !document.startViewTransition) return show();
  // Which size the logo ends at, for src/style.css. Only the landing shows it large.
  document.documentElement.dataset.to = isApp(path) || DOCS.test(path) ? "small" : "large";
  // The app's run starts once the animation ends; its work on this thread would drop frames.
  const transition = document.startViewTransition(() => show(transition.finished.catch(() => {})));
}

export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  void route(true);
}

// A hash link changes the entry but not the page.
addEventListener("popstate", () => {
  if (location.pathname !== shown) void route(true);
});

// Links between the pages stay in the page.
root.addEventListener("click", (e) => {
  const link = (e.target as Element).closest("a");
  // A click that asks for a new tab or window keeps the link's own way.
  if (!link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || link.target) return;
  // A hash link within the page is left to the browser.
  if (link.origin !== location.origin || link.pathname === location.pathname) return;
  e.preventDefault();
  navigate(link.pathname + link.hash);
});

// Cmd, Ctrl or Alt and a letter open the link that names it in `data-key`: u the landing,
// d the docs, g GitHub. k names the spec box, which takes focus instead; / does the same.
addEventListener("keydown", (e) => {
  if (e.repeat || e.shiftKey || !(e.metaKey || e.ctrlKey || e.altKey)) return;
  // Alt changes the character on Mac, so it goes by the key's place instead.
  const key =
    e.code === "Slash" ? "k" : (e.altKey ? e.code.replace(/^Key/, "") : e.key).toLowerCase();
  const el = /^[a-z]$/.test(key) && document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!el) return;
  e.preventDefault();
  if (el instanceof HTMLInputElement) el.select();
  else el.click();
});
