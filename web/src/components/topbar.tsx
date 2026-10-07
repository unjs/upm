// The top bar: the landing's hero in one row, with the spec to resolve and the package's links.
import { useEffect, useRef } from "react";
import type { View } from "../app.tsx";
import {
  ARROW,
  BOOK,
  BUTTON,
  FORM,
  INPUT,
  KEY,
  LINK,
  LOGO,
  logo,
  MOON,
  OCTOCAT,
  PLACEHOLDER,
  REPO,
  SMALL,
  SUN,
  TOGGLE,
} from "./hero.ts";
import { allowedSource } from "../lib/route.ts";
import { repoUrl } from "./package.tsx";
import { suggest } from "./suggest.ts";
import { Icon, type IconName } from "./ui.tsx";

export function TopBar(props: {
  spec: string;
  setSpec: (spec: string) => void;
  onRun: (spec: string) => void;
  /** The version the spec resolved to, shown after it until the box is focused. */
  version?: string;
  view: View | undefined;
}) {
  const { spec, view } = props;
  const top = view?.top instanceof Error ? undefined : view?.top;
  const manifest = view?.manifest instanceof Error ? undefined : view?.manifest;
  const repo = repoUrl(manifest);
  const input = useRef<HTMLInputElement>(null);
  // The latest props, for the suggestions bound once below.
  const latest = useRef(props);
  latest.current = props;
  useEffect(
    () =>
      suggest(input.current!, (name, run) => {
        latest.current.setSpec(name);
        if (run) latest.current.onRun(name);
      }),
    [],
  );
  // Equal side columns keep the search box centered on the page.
  return (
    <header className="grid shrink-0 grid-cols-[1fr_minmax(0,24rem)_1fr] items-center gap-3 px-4 py-2 sm:gap-6 sm:px-8">
      <h1 className={`${LOGO} ${SMALL.logo}`}>
        <a href="/" title="upm" data-key="u" dangerouslySetInnerHTML={{ __html: logo }} />
      </h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onRun(spec);
        }}
        className={`${FORM} ${SMALL.form}`}
      >
        <div className="relative flex min-w-0 flex-1">
          <input
            ref={input}
            autoFocus={!spec}
            value={spec}
            onChange={(e) => props.setSpec(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Package spec"
            data-key="k"
            className={`peer ${INPUT}`}
          />
          {props.version && (
            // Drawn over the input, past its text: an unseen copy of the spec pushes it along.
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-3 font-mono whitespace-pre peer-focus:hidden"
            >
              <span className="invisible">{spec}</span>
              <span className="text-zinc-400">@{props.version}</span>
            </span>
          )}
        </div>
        {top && (
          <span className="hidden shrink-0 items-center gap-1 pr-2 text-zinc-400 sm:flex">
            {manifest?.homepage && <Link icon="home" title="Homepage" href={manifest.homepage} />}
            {repo && (
              <Link
                icon={/github\.com\//.test(repo) ? "github" : "repo"}
                title="Repository"
                href={repo}
              />
            )}
            {!allowedSource(top.resolved) && (
              <Link
                icon="package"
                title="npm"
                href={`https://www.npmjs.com/package/${top.name}/v/${top.version}`}
              />
            )}
          </span>
        )}
        <button title="Resolve (Enter)" aria-label="Explore" className={BUTTON}>
          <HeroIcon icon={ARROW} width={2.25} />
        </button>
      </form>

      <nav className="flex items-center justify-self-end text-xs sm:gap-1">
        <a href="/docs" title="Docs" data-key="d" className={`${LINK} max-sm:px-1.5`}>
          <HeroIcon icon={BOOK} width={2} />
          <span className="hidden sm:inline">
            <span className={KEY}>D</span>ocs
          </span>
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          title="GitHub"
          data-key="g"
          className={`${LINK} max-sm:px-1.5`}
        >
          <HeroIcon icon={OCTOCAT} width={2} />
          <span className="hidden sm:inline">
            <span className={KEY}>G</span>itHub
          </span>
        </a>
        <button
          type="button"
          title="Toggle dark mode"
          aria-label="Toggle dark mode"
          data-theme-toggle
          className={TOGGLE}
        >
          <HeroIcon icon={MOON} width={2} />
          <HeroIcon icon={SUN} width={2} />
        </button>
      </nav>
    </header>
  );
}

function HeroIcon({ icon, width }: { icon: typeof ARROW; width: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={icon.className}
      dangerouslySetInnerHTML={{ __html: icon.paths }}
    />
  );
}

function Link({ icon, title, href }: { icon: IconName; title: string; href: string }) {
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer"
      className="rounded p-1 hover:bg-zinc-200/70 hover:text-amber-600 dark:hover:bg-zinc-800"
    >
      <Icon name={icon} className="size-3.5" />
    </a>
  );
}
