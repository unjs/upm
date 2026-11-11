// The package at a glance: what the registry says about it, and what its tarball holds.
import { useMemo } from "react";
import type { View } from "../app.tsx";
import type { FullManifest } from "../lib/client.ts";
import { allowedSource } from "../lib/route.ts";
import { formatBytes } from "./code.tsx";
import { Downloads } from "./downloads.tsx";
import { tally } from "./files.tsx";
import { installState } from "./install-button.tsx";
import { Badge, Icon, type IconName } from "./ui.tsx";

/** The repository's web page, from the manifest's git url. */
export function repoUrl(manifest: FullManifest | undefined): string | undefined {
  const repo =
    typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url;
  if (!repo) return undefined;
  // npm's shorthands, kept as written in the tarball's package.json: `owner/name`, `github:…`.
  const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(repo);
  if (short) {
    const host = short[1] === "bitbucket" ? "bitbucket.org" : `${short[1] ?? "github"}.com`;
    return `https://${host}/${short[2]!.replace(/\.git$/, "")}`;
  }
  return repo
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^(?:git|ssh):\/\/(?:git@)?/, "https://")
    .replace(/\.git$/, "");
}

/**
 * The package's folder on GitHub, as a `blob/` url: at the commit it was published from when the
 * manifest says, and in `repository.directory` for a monorepo's package.
 */
export function sourceUrl(manifest: FullManifest | undefined): string | undefined {
  const repo = repoUrl(manifest);
  if (!repo?.startsWith("https://github.com/")) return undefined;
  const dir = typeof manifest?.repository === "object" ? manifest.repository.directory : "";
  const path = dir?.replace(/^\/+|\/+$/g, "");
  return `${repo}/blob/${manifest?.gitHead || "HEAD"}/${path ? `${path}/` : ""}`;
}

/**
 * The package at a glance, over its README: name, links, and what it holds. What
 * only an install finds out is a dimmed label until then, and a click on it installs.
 */
export function PackageMeta({ view, onInstall }: { view: View; onInstall: () => void }) {
  const installed =
    view.installed === true || view.installed instanceof Error ? undefined : view.installed;
  // The installed project, without the store: what the install puts on disk here.
  const size = useMemo(
    () => installed && tally(installed.files, installed.links).project,
    [installed],
  );
  if (!view.top || view.top instanceof Error) return null;
  const top = view.top;
  const manifest = view.manifest instanceof Error ? undefined : view.manifest;
  const files = view.tarball instanceof Error ? undefined : view.tarball;
  const repo = repoUrl(manifest);
  const deps = Object.keys(manifest?.dependencies ?? top.dependencies ?? {}).length;
  const state = installState(view);
  const tree = (icon: IconName, value: string | number | undefined, text: string): Tag => ({
    icon,
    text: value === undefined ? text : `${value} ${text}`,
    accent: value !== undefined,
    placeholder: value === undefined,
    busy: state === "resolving" || state === "installing",
    onClick: state === "idle" ? onInstall : undefined,
  });
  const facts: Tag[] = [
    { icon: "deps", text: `${deps} ${deps === 1 ? "dependency" : "dependencies"}` },
    manifest?.engines?.node && { icon: "cpu", text: `node ${manifest.engines.node}` },
    files && { icon: "files", text: `${files.files.length} files` },
    files && { icon: "package", text: `${formatBytes(unpacked(files))} unpacked` },
    files && {
      icon: "download",
      text: files.stored ? "in store" : `${formatBytes(files.bytes)} tarball`,
    },
    manifest?.hasInstallScript && { icon: "code", text: "install script" },
  ];
  // The whole tree's, once installed.
  const totals = [
    tree("deps", installed?.result.packages, "packages installed"),
    tree("package", size && formatBytes(size.bytes), "install size"),
    tree("files", size?.files, "files installed"),
  ];
  return (
    <header className="space-y-3">
      {/* The downloads beside the title and description, under them on a small screen. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="font-mono text-xl font-semibold break-all text-zinc-900 dark:text-zinc-100">
              {view.name}
            </h1>
            {/* A tarball url's version is its package.json's, which says little: its ref says more. */}
            {allowedSource(top.resolved) ? (
              <span
                title={`${top.version}, from ${top.resolved}`}
                className="font-mono text-sm text-amber-600 dark:text-amber-500"
              >
                {top.resolved.slice(top.resolved.lastIndexOf("@"))}
              </span>
            ) : (
              <span className="font-mono text-sm text-amber-600 dark:text-amber-500">
                {top.version}
              </span>
            )}
            {manifest?.license && <Badge>{manifest.license}</Badge>}
            {manifest?.deprecated && <Badge tone="red">deprecated</Badge>}
          </div>
          {manifest?.description && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{manifest.description}</p>
          )}
        </div>
        <Downloads name={view.name} className="shrink-0 sm:w-64" />
      </div>
      {manifest?.deprecated && (
        <p className="text-sm text-red-700 dark:text-red-300">{String(manifest.deprecated)}</p>
      )}
      <ul className="flex flex-wrap gap-x-4 text-xs">
        {manifest?.homepage && <Link icon="home" href={manifest.homepage} />}
        {repo && <RepoLink href={repo} />}
        {!allowedSource(top.resolved) && (
          <Link
            icon="npm"
            label="npm"
            href={`https://www.npmjs.com/package/${top.name}/v/${top.version}`}
          />
        )}
      </ul>
      <Tags words={facts} />
      <Tags words={totals} />
    </header>
  );
}

const unpacked = (tarball: { files: { size: number }[] }) =>
  tarball.files.reduce((sum, f) => sum + f.size, 0);

/**
 * A tag: its text, with an icon before it, amber when `accent`, pulsing when `busy`, a button with
 * `onClick`. An empty one is left out.
 */
type Tag = Chip | false | undefined | "";
interface Chip {
  icon?: IconName;
  text: string;
  accent?: boolean;
  /** Not known yet: dimmed. */
  placeholder?: boolean;
  busy?: boolean;
  onClick?: () => void;
}

function Tags({ words }: { words: Tag[] }) {
  const shown = words.filter((word): word is Chip => !!word);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1 text-xs">
      {shown.map((tag) => {
        const As = tag.onClick ? "button" : "span";
        return (
          <As
            key={tag.text}
            {...(tag.onClick && {
              type: "button",
              title: "Install in this tab to find out",
              onClick: tag.onClick,
            })}
            className={`flex items-center gap-1 rounded px-1.5 leading-5 tabular-nums ${
              tag.accent
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : tag.placeholder
                  ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            } ${tag.onClick ? "cursor-pointer hover:text-amber-600 dark:hover:text-amber-400" : ""} ${tag.busy ? "animate-pulse" : ""}`}
          >
            {tag.icon && (
              <Icon
                name={tag.icon}
                className={`size-3 ${tag.accent ? "opacity-70" : "text-zinc-400"}`}
              />
            )}
            {tag.text}
          </As>
        );
      })}
    </div>
  );
}

/** A GitHub repository by name, any other by its url. */
function RepoLink({ href }: { href: string }) {
  return href.startsWith("https://github.com/") ? (
    <Link icon="github" label="GitHub" href={href} />
  ) : (
    <Link icon="repo" href={href} />
  );
}

/** `label`, or the url without its scheme. */
function Link({ icon, href, label }: { icon: IconName; href: string; label?: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={label && href}
        className="-mx-1.5 flex h-6 items-center gap-2 rounded px-1.5 text-zinc-600 hover:bg-zinc-200/70 hover:text-amber-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Icon name={icon} className="size-3.5" />
        <span className="truncate">{label ?? href.replace(/^https?:\/\/(www\.)?/, "")}</span>
      </a>
    </li>
  );
}
