# upm web

upm's site, built from `../src` (no build of upm needed). Three routes, one `index.html`:

- `/` is the landing: the logo and the spec box in the middle of the screen, with a Docs
  button in the top bar.
- `/docs` is the repo's `README.md`, rendered by md4x at build time (`readme.ts`, a Vite plugin
  that serves it as `virtual:readme`, with its logo split off as `virtual:readme/logo`).
  For agents, the same plugin serves the README as `/README.md` (the page's
  `rel="alternate"` link) and as plain text in `/llms.txt`.
- The landing and the app share the hero's classes (`src/components/hero.ts`), large
  on one and small on the other. `src/router.ts` moves between the two in place, in a view
  transition, so the logo and the box move into the app's top bar and back (the
  logo link, or the browser's back and forward). The app's run waits for the animation.
- `/npm/<spec>` is the app for a spec, e.g. `/npm/@nuxt/kit` or `/npm/vue@^3`. A tarball url on
  an allowed host is its own path, without `https:/`: `/pkg.pr.new/nitro@be2edec`. Any other
  `/<spec>` path and old `?q=<spec>` links redirect there.

`src/` holds the entries and the app's state (`app.tsx`), `src/components/` the UI, and
`src/lib/` the rest: the routes, the registry client and the in-tab install.

The nitro Vite plugin serves `index.html` for every path. `vite build` writes `.output/`, a
Node server by default (`node .output/server/index.mjs`); set `NITRO_PRESET` for another host.

## App

A browser client for upm. Enter a package spec:
it picks the version with `upm/resolver`, and fetches, verifies and lists the package's tarball —
all from the browser, against the registry's CORS. The package's `README.md` shows as soon as
the tarball's stream yields it, which npm packs near the start, while the rest still downloads
and before the integrity check (a failed check takes it back). It opens with the package at a
glance (links, license, what the tarball holds, and a year of weekly downloads from npm's
`api.npmjs.org/downloads`), then the Install button beside a toggle for the commands that
install upm and add the package (remembered in `localStorage`). On a small screen nothing else is
asked for until the Install button (also small in the sidebar) is pressed; a wider one presses it
itself once the README has painted. Then it resolves the whole tree and shows the lockfile upm
would write.

Besides registry specs, the box takes a tarball url on an allowed host (`SOURCES` in
`src/lib/route.ts`; only `pkg.pr.new` for now), with or without `https://`, as in
`pkg.pr.new/nitro@be2edec`. With no ref, or `@latest`, a pkg.pr.new url means `@main`, the newest
build of that branch. `pkg.pr.new/<owner>/<repo>` is the package named as the repo, and the
site's repo page, `pkg.pr.new/~/<owner>/<repo>`, opens as that. The host's path names the package, the tarball's `package.json` gives
its version and dependencies, and the integrity is the hash of its bytes. Each host must allow the
page with CORS. A tarball dependency from any other host fails the resolve.

While a name is typed, the spec box on both pages suggests packages from the registry's
`/-/v1/search` (`src/components/suggest.ts`), and after `@`, the package's tags and versions from
its abbreviated document, asked with the resolver's `accept` so a run finds it in the HTTP cache.
Each keystroke asks right away, and until its answer lands, an earlier answer narrowed to the
new text shows instead.

```sh
node ./upm install         # from the repo root
npm run web                # or: cd web && npx vite
```

Once that resolve is in, upm's own `install` runs in the tab: `src/lib/node.ts` puts a
`process` in place whose `getBuiltinModule` hands out an in-memory `fs`, a posix `path` and
`os`, and nothing else — hashing and gunzip stay WebCrypto and `DecompressionStream`, and with no
`worker_threads` every pool runs on the one thread. The Explorer then shows the project
(`node_modules/.upm`, the links, `upm.lock`) and the content store. The platform is Linux wasm32
with glibc, so of the optional platform builds the tab gets the wasm ones, the only ones a
browser can run. upm calls the global `fetch`, so while it runs, the tab swaps in one that sends
the registry's requests (the install's downloads) through the Requests panel too.

The `fs` lives in memory, since upm's sync calls cannot wait for OPFS, and the project is made
fresh for each run. What outlives the tab is the store's content: `src/lib/opfs.ts` keeps it on
OPFS as upm's store backend, which upm asks before a download and hands each package it
downloads. It is keyed by content, so every tab shares it. The registry documents the resolver
reads are kept there too, and answer a reload with no request while the registry's `max-age`
(5 minutes) lasts, or for a day for a version's own document, which never changes once
published. After that they are asked for again: the registry lets a page read no `etag`, so
the browser's HTTP cache does the revalidating. No lockfile is kept between loads:
each resolves against the registry, as a project with no `upm.lock` does, and hands its lockfile
to the install. A package the store already has shows its files from there, without a download.
The bottom panel's Storage tab (`src/components/storage.tsx`) lists what OPFS holds: the store's
packages and the kept documents with how long each stays fresh, each part's size, the site's
quota and whether the browser keeps it when the disk runs low. It clears a part or all of it.

`public/install.sh` and `public/install.ps1` are the installers behind
`curl -fsSL https://upm.sh/install.sh | sh` and `irm https://upm.sh/install.ps1 | iex`, which the
install card (`src/components/install.ts`) offers next to `npm i -g upm`.

`public/og.png`, the Open Graph image, is rendered by `scripts/og.ts` with
[takumi](https://github.com/kane50613/takumi). Run `node scripts/og.ts` after changing it.
