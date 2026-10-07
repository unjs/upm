// Suggestions while typing in the spec box: package names from the registry's search, then,
// after `@`, the package's tags and versions. Plain DOM, so the landing and the app's top bar
// share it.
//
// For speed, every keystroke asks at once, with no debounce and no abort, and answers are kept
// for the tab. Until a query's own answer lands, a shorter query's answer that still matches
// shows instead.

import { sourceOf } from "../lib/route.ts";

const REGISTRY = "https://registry.npmjs.org";
const SEARCH = `${REGISTRY}/-/v1/search?size=20&text=`;
// The resolver's own `accept` (src/registry.ts), so its request finds this one in the HTTP cache.
const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const SHOWN = 8;
// The page's own, taken at load: an install swaps the global one to list upm's requests
// (src/lib/install.ts), and these are not upm's.
const pageFetch = globalThis.fetch;

interface Hit {
  /** What the box takes when picked. */
  spec: string;
  /** Shown on the right: the latest version, or a version's tag. */
  note?: string;
  description?: string;
}

interface SearchResult {
  objects: {
    package: { name: string; version: string; description?: string };
    downloads?: { weekly?: number };
  }[];
}

interface Packument {
  "dist-tags": Record<string, string>;
  versions: Record<string, { deprecated?: string }>;
}

interface Versions {
  tags: [tag: string, version: string][];
  /** Newest first. */
  versions: string[];
  tagOf: Map<string, string>;
  deprecated: Set<string>;
}

const found = new Map<string, Hit[]>();
const docs = new Map<string, Versions>();
const asked = new Map<string, Promise<void>>();

/** Asks once per key, again after a failure. */
function ask<T>(key: string, url: string, init: RequestInit, done: (body: T) => void) {
  let pending = asked.get(key);
  if (!pending) {
    pending = pageFetch(url, init)
      .then((res) => (res.ok ? (res.json() as Promise<T>) : Promise.reject()))
      .then(done, () => void asked.delete(key));
    asked.set(key, pending);
  }
  return pending;
}

function search(text: string) {
  return ask<SearchResult>(`?${text}`, SEARCH + encodeURIComponent(text), {}, (body) => {
    const hits = body.objects.map(({ package: p, downloads }) => ({
      spec: p.name,
      note: p.version,
      description: p.description,
      weekly: downloads?.weekly ?? 0,
    }));
    // The registry matches whole words, so a half-typed name finds little: the exact name
    // first, then names that start with the text, each by weekly downloads.
    const score = (h: Hit) => (h.spec === text ? 2 : h.spec.startsWith(text) ? 1 : 0);
    found.set(
      text,
      hits.sort((a, b) => score(b) - score(a) || b.weekly - a.weekly),
    );
  });
}

function versions(name: string) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  return ask<Packument>(`@${name}`, url, { headers: { accept: CORGI } }, (doc) => {
    const tags = Object.entries(doc["dist-tags"] ?? {});
    // `latest` first, then the other tags by version.
    tags.sort(([a, x], [b, y]) => +(b === "latest") - +(a === "latest") || compare(y, x));
    const list = Object.keys(doc.versions ?? {});
    docs.set(name, {
      tags,
      versions: list.sort((a, b) => compare(b, a)),
      tagOf: new Map(tags.map(([tag, version]) => [version, tag])),
      deprecated: new Set(list.filter((v) => doc.versions[v]!.deprecated)),
    });
  });
}

const collator = new Intl.Collator(undefined, { numeric: true });

// Semver order, near enough for a list: a prerelease comes before its release.
function compare(a: string, b: string): number {
  const [x, xPre] = splitPre(a);
  const [y, yPre] = splitPre(b);
  return (
    collator.compare(x, y) ||
    (xPre === yPre ? 0 : !xPre ? 1 : !yPre ? -1 : collator.compare(xPre, yPre))
  );
}

function splitPre(version: string): [string, string] {
  const dash = version.indexOf("-");
  return dash < 0 ? [version, ""] : [version.slice(0, dash), version.slice(dash + 1)];
}

// Tags, then versions, that start with what is typed after `@`. A leading `^`, `~` or comparison
// stays in front of the version. Prereleases only once a `-` is typed.
function versionHits(
  name: string,
  range: string,
  { tags, versions, tagOf, deprecated }: Versions,
): Hit[] {
  const op = /^(?:[\^~=]|[<>]=?)/.exec(range)?.[0] ?? "";
  const typed = range.slice(op.length);
  const hits: Hit[] = op
    ? []
    : tags
        .filter(([tag]) => tag.startsWith(typed))
        .map(([tag, version]) => ({ spec: `${name}@${tag}`, note: version }));
  for (const version of versions) {
    if (hits.length >= SHOWN) break;
    if (version.startsWith(typed) && (typed.includes("-") || !version.includes("-")))
      hits.push({
        spec: `${name}@${op}${version}`,
        note: tagOf.get(version) ?? (deprecated.has(version) ? "deprecated" : undefined),
      });
  }
  return hits;
}

// The longest shorter query with an answer, narrowed to the names that still match.
function nearest(text: string): Hit[] | undefined {
  for (let end = text.length - 1; end > 0; end--) {
    const hits = found.get(text.slice(0, end));
    if (hits) return hits.filter((h) => h.spec.includes(text));
  }
}

// What is being typed: a name, or a name and what follows its `@`. Nothing for an alias, URL
// or path.
function parse(value: string): { name: string; range?: string } | undefined {
  const text = value.trim().toLowerCase();
  if (!text || /[\s:\\]/.test(text) || text.startsWith(".") || sourceOf(text)) return;
  const at = text.indexOf("@", 1);
  return at < 0 ? { name: text } : { name: text.slice(0, at), range: text.slice(at + 1) };
}

const LIST =
  "absolute z-50 overflow-hidden rounded-xl border border-zinc-300 bg-(--editor-bg) py-1 text-sm shadow-lg dark:border-zinc-700";
const ITEM =
  "flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 aria-selected:bg-amber-500/10 [&[aria-selected=true]_b]:text-amber-600 dark:[&[aria-selected=true]_b]:text-amber-400";

let lists = 0;

/**
 * Suggests package names and versions under `input`. `pick` gets the chosen spec, and `run`
 * when it should open too (Enter or a click) rather than only fill the box (Tab). Returns how
 * to take it down.
 */
export function suggest(
  input: HTMLInputElement,
  pick: (spec: string, run: boolean) => void,
): () => void {
  const list = document.createElement("ul");
  list.id = `suggest-${++lists}`;
  list.role = "listbox";
  list.ariaLabel = "Packages";
  list.className = LIST;
  list.hidden = true;
  document.body.append(list);
  input.role = "combobox";
  input.ariaAutoComplete = "list";
  input.ariaExpanded = "false";
  input.setAttribute("aria-controls", list.id);

  let hits: Hit[] = [];
  let active = -1;

  function place() {
    const box = (input.form ?? input).getBoundingClientRect();
    list.style.left = `${box.left + scrollX}px`;
    list.style.top = `${box.bottom + scrollY + 6}px`;
    list.style.width = `${box.width}px`;
  }

  function close() {
    list.hidden = true;
    input.ariaExpanded = "false";
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function select(index: number) {
    active = index;
    for (const [i, item] of [...list.children].entries()) {
      item.ariaSelected = String(i === index);
      if (i === index) item.scrollIntoView({ block: "nearest" });
    }
    if (index < 0) input.removeAttribute("aria-activedescendant");
    else input.setAttribute("aria-activedescendant", `${list.id}-${index}`);
  }

  function show(next: Hit[]) {
    hits = next.slice(0, SHOWN);
    if (!hits.length) return close();
    // Stay on the same spec when a later answer reorders the list.
    const current = (list.children[active] as HTMLElement | undefined)?.dataset.spec;
    const was = hits.findIndex((h) => h.spec === current);
    list.replaceChildren(
      ...hits.map((h, i) => {
        const item = document.createElement("li");
        item.id = `${list.id}-${i}`;
        item.role = "option";
        item.dataset.spec = h.spec;
        item.className = ITEM;
        const head = document.createElement("div");
        head.className = "flex items-baseline gap-2";
        const spec = document.createElement("b");
        spec.className = "truncate font-mono font-medium";
        spec.textContent = h.spec;
        const note = document.createElement("span");
        note.className = "ml-auto shrink-0 font-mono text-xs text-zinc-400";
        note.textContent = h.note ?? "";
        head.append(spec, note);
        item.append(head);
        if (h.description) {
          const about = document.createElement("span");
          about.className = "truncate text-xs text-zinc-500 dark:text-zinc-400";
          about.textContent = h.description;
          item.append(about);
        }
        return item;
      }),
    );
    place();
    list.hidden = false;
    input.ariaExpanded = "true";
    select(was);
  }

  // Answers land after more typing: each shows only if the box still asks for it.
  const still = (value: string) => document.activeElement === input && input.value === value;

  function update() {
    const value = input.value;
    const typed = parse(value);
    if (!typed) return close();
    const { name, range } = typed;
    if (range !== undefined) {
      const doc = docs.get(name);
      if (doc) return show(versionHits(name, range, doc));
      close();
      void versions(name).then(() => still(value) && update());
      return;
    }
    const known = found.get(name);
    if (known) return show(known);
    // No match yet keeps the list as it is, rather than flashing it shut.
    const near = nearest(name);
    if (near?.length) show(near);
    void search(name).then(() => still(value) && found.has(name) && update());
  }

  function choose(index: number, run: boolean) {
    const hit = hits[index];
    if (!hit) return;
    close();
    pick(hit.spec, run);
    // A name filled in is likely followed by `@`: have its versions ready.
    if (!run && !hit.spec.includes("@", 1)) void versions(hit.spec);
  }

  const onKey = (e: KeyboardEvent) => {
    if (list.hidden || e.isComposing) return;
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (move) {
      e.preventDefault();
      // Past either end is back in the box, with nothing picked.
      const stops = hits.length + 1;
      select(((active + 1 + move + stops) % stops) - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
      e.preventDefault();
      choose(active, e.key === "Enter");
    } else if (e.key === "Enter") close();
  };
  // Pressing keeps the focus in the box, so the list is still there for the click.
  const onPress = (e: PointerEvent) => e.preventDefault();
  const onClick = (e: MouseEvent) => {
    const item = (e.target as Element).closest("li");
    if (item) choose([...list.children].indexOf(item), true);
  };
  const onHover = (e: PointerEvent) => {
    const item = (e.target as Element).closest("li");
    if (item) select([...list.children].indexOf(item));
  };
  const onResize = () => list.hidden || place();

  input.addEventListener("input", update);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", close);
  list.addEventListener("pointerdown", onPress);
  list.addEventListener("pointermove", onHover);
  list.addEventListener("click", onClick);
  addEventListener("resize", onResize);
  return () => {
    input.removeEventListener("input", update);
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", close);
    removeEventListener("resize", onResize);
    list.remove();
  };
}
