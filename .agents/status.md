# Status and next work

upm is prerelease and self-hosting. Registry compatibility does not mean full npm
compatibility. Keep this page about open work, not completed implementation steps.

## Open correctness and usability gaps

- **Stored corruption:** only `--verify` reads content: it hashes every stored and
  installed file. A plain install trusts the store, so an edit through a project's hardlink
  reaches the next tree built from it. A default check costs a stat per file (about 50 ms
  of a warm `nuxt` on the main thread) plus hashing what the mtime gate in `sound`
  (`src/verify.ts`) flags; moving it onto the link pool's threads is the next thing to try.
- **Prune safety and retention:** valid indexes keep content even after every project
  stops using it. Prune can also race an install; the grace period is not a lock.
  Separate reclaiming unused packages from safe concurrent deletion. A fix needs a
  retention policy and a test that pauses an install at the deletion race.
  Start at `src/gc.ts` and `test/gc.test.ts`.
- **Exec projects are never reclaimed:** every set of versions `upm exec` or `importx`
  installs keeps a project under the root's `node_modules/.upm/.exec`, or `~/.upm/exec`
  outside a project, and `prune` knows nothing of them. The first go only with their `node_modules`; the second
  never. A tag that moves often (`upm publish` runs npm's `latest`) leaves one per version.
  Needs a retention rule (last use, count) and a prune test that keeps a running command's
  project. Start at `execHome` in `src/exec.ts` and `execProject` in `src/api.ts`.
- **Switching package managers:** unrelated real directories in an old `node_modules`
  can survive and remain importable. Use a clean `node_modules` when switching today.
  Define an explicit migration or refusal policy rather than deleting user files silently.
  Start at `src/link.ts`.
- **Missing libc metadata:** abbreviated registry documents can hide a `libc` restriction
  when a package declares neither `os` nor `cpu`. An optional dependency's exact pin is read
  from the full document, so only ranges and other edges miss it. Test this shape before
  changing metadata reads; never guess libc from the package name. Start at `needsLibc` in
  `src/resolve.ts`.
- **Platform support:** CI tests Linux, macOS and Windows. On Windows a directory link is
  an absolute junction, so a moved tree is relinked, not reused. A bin there is cmd-shim's
  `.cmd`, `.ps1` and `sh` trio (`src/shim.ts`), and an argument to a `.cmd` is escaped twice,
  as npm does; `test/shim.test.ts` and the `upm exec` tests run them. `upm run`'s own process
  tests still skip Windows: they are written in `sh`. As with npm, a script's arguments are
  escaped for its first word, though they land on its last. Nobody has run the shims by hand in
  cmd, PowerShell or Git Bash, and the `%` escape (`quoteCmd` in `src/run.ts`) is proven only
  by those tests.
  Read-only is a file attribute there, shared by every hardlink: repairing a damaged blob
  leaves the old copy writable in projects still linked to it.
  Two files a case-insensitive disk folds to one name (`A.js`, `a.js`) link the later, as npm's
  tar does, and the entry checks take that file for both (`shadowed` in `src/verify.ts`). A
  package linked on several workers is split by exact directory, so files under `Lib/` and `lib/`
  can land in either order; when the earlier wins, every `--verify` builds it again, and every
  full link too when the sizes differ. On a disk that keeps both names, those checks also pass
  an `A.js` made a link to `a.js`, which only an edit by hand does.
  Reserved Windows names (`con`, `aux.js`) and names ending in a dot or space are not handled.
  Start at `place` in `src/link.ts`.
  A portable lockfile is not proof of a portable installer. Add real install/run checks,
  plus glibc/musl and CPU-limited cases, before making broader support claims. Nobody has
  run these by hand off Linux: the bin's flush-then-exit (`exit` in `src/cli.ts`; stdout to a
  pipe is asynchronous there), the spool's temp rename (`adopt` in `src/unpack.ts`), index-path
  shards in the link worker and the state's root links as `readLink` spells them.
- **Torn store index, required package:** the linker reads an index where it links it (on
  a worker for a small entry), not in the fill, so a torn index of a required package fails
  the link, and the install repairs it through the verifying refill — every file of every
  entry stat'd, then a second link, about half again the time of an install that parsed
  every index in the fill. An optional's index is still read in the fill, so a torn one
  is dropped as a missing one is. A targeted repair (refetch the one integrity the failure
  names, link again) would keep the fast fill and the fast repair. Start at `installTree`'s
  `ELINK` catch in `src/api.ts`.
- **A url tarball changed in place is not picked up:** the lockfile pins its bytes, so a
  server that now serves others fails the install with `EINTEGRITY` naming the source (`stale`
  in `src/api.ts`); the way out is remove and add. A local one is read again (`movedTarballs`).
  Checking a url on every install would cost a request and fail offline; the fix is an explicit
  `upm update <name>` that unlocks a name's entries and resolves them again, which registry
  packages want too. Start at `keep` in `src/api.ts`.
- **Git refs are not resolved to commits:** a git spec becomes its host's archive url for the
  ref as written (`git` in `src/spec.ts`), so a branch or `HEAD` is the moving url above. Git's
  smart http route (`info/refs?service=git-upload-pack`) lists every ref's commit in one GET,
  with no clone; locking the commit's archive would make the bytes stay put. GitHub's archive
  bytes are not promised stable either. No `prepare` runs, so a repo without built files fails
  to load; running it needs the package's dev dependencies and a script sandbox decision.
- **A url override of a package's own dependency fails the link:** `"overrides": { "x": "<url>" }`
  with `x` declared as `^1` by a dependency resolves, then fails with `EMISMATCH` (`misdeclared`
  in `src/util.ts` holds the edge to the package.json, which never names the url). A git or url
  override of a root dependency works. The check needs to know an override moved the edge.
- **Symlinked workspace:** when a workspace directory is itself a symlink, its dep links
  are spelled relative to the path linked through, not where they sit, so on Linux and
  macOS they dangle. The test pins that spelling. Start at `linkTop` in `src/link.ts`.
- **Compile cache is never reclaimed:** the bin's V8 cache in `~/.upm/compile-cache` gains
  entries for every new build and Node version, and nothing removes old ones. Needs a
  retention rule and a place to apply it, `prune` or the bin's start. Start at `src/upm.ts`.
- **Kept registry documents are never reclaimed:** the store's `metadata` directory keeps
  every document any resolve read, and `prune` walks only `files` and `index`. The same
  retention question as the compile cache and exec projects; one rule could serve all three.
  A torn or damaged file is a miss, so deleting any of them is always safe (one a resolve is reading in
  parts sends that name to the registry, or fails it offline), and the paths name the
  registry and package, ready for a `upm cache clean <name>`. Start at `src/metadata.ts`.
- **npm's commands need the network:** `upm publish`, `version`, `login` and the rest run
  `upm exec npm`, which asks the registry for npm's `latest` once the kept document is older
  than the release cutoff, a day by default (a `304`; `--prefer-offline` skips it). npm on `PATH` would be faster but
  is not what exec runs. Commands that read the tree (`ls`, `outdated`, `explain`, `fund`) or need
  `package-lock.json` (`audit`) are not passed on. Start at `NPM` in `src/cli.ts`.
- **No audit:** `npm audit` needs `package-lock.json`, so there is no way to check the tree
  for advisories. A native `upm audit` needs no npm: POST every locked name and its
  versions from `upm.lock` to the registry's `/-/npm/v1/security/advisories/bulk`, then
  report the advisories whose `vulnerable_versions` match, with the paths that reach them.
  Decide first how to treat dev-only and other-platform entries, scoped registries that
  do not serve the endpoint, and a registry credential it may need. Test with a controlled
  response, not the live registry. `audit fix` is a separate question: it means choosing
  upgrades.

- **Store backend gaps:** `StoreBackend` (`src/store-backend.ts`) is an API option only;
  there is no CLI or config for it. Load a module only from user config or the environment,
  never a project's `.npmrc`, which would run a cloned repo's code on install. A tarball
  dependency is never read from it (`adopt` and a url's `add` in `src/store.ts`), and a
  package already in the local store is never handed to it, so a warm machine does not fill
  it. Each miss asks it once before its download; one `getMany` of every index key from the
  lockfile at fill start would spare the per-package probe. An untrusted remote (HTTP, S3)
  would need the tarball kept too, so the lockfile's integrity can be checked; values move
  whole, not streamed. Measure an empty
  backend against none with `bench/ab.sh` before and after.

## Deliberate limits

These need a scope decision, not just a patch:

- No dependency lifecycle scripts, Git or directory dependencies but `link:`. Explicit project
  scripts via `upm run` are a separate feature. A tarball dependency's path, and a `link:` one,
  is relative and from the root or a workspace only; `exec`, `resolve` and `fetch` take
  registry specs only. `link:` is pnpm's (a path, linked as it is, its dependencies not
  installed), not bun's `link:<name>`, which would need a global registry and a `link`
  command. A `link:` directory is never offered as a peer: its version is read only at install.
  A `pnpm-lock.yaml` with a `link:` importer edge is still refused (`src/foreign-lock.ts`).
- Another manager's lockfile (`package-lock.json`, `pnpm-lock.yaml`, `bun.lock`) is read in
  memory when there is no `upm.lock` (`src/foreign-lock.ts`), and never written: whatever needs a
  resolve is refused, not saved to a new `upm.lock`. Not read: yarn (berry has no tarball
  integrity, v1 no bins or platform lists: a registry request per package), workspaces,
  patches, git, file and tarball url dependencies. bun records no libc and writes an os or
  cpu it does not know as `"none"`, so those builds install as unrestricted; pnpm records
  only `hasBin`, so those bins are read out of the store before the state hash (a package
  that names its bins only by `directories.bin` gets none). A `name@version` held with two
  peer sets is folded onto the highest. Staleness is checked on the root's ranges and pins
  and on bun's overrides; the `overrides` map pnpm records is not compared, though a root
  specifier it wrote from one of the project's overrides is taken. `yarn.lock`, `bun.lockb`
  and `npm-shrinkwrap.json` are not looked for, so such a project still resolves and writes
  `upm.lock`: decide whether to refuse there too. Start at `src/foreign-lock.ts`.
- Workspaces are direct-only and whole-tree. Left out on purpose: `install -w` and any other
  filtered install (one state file describes one tree), hoisting to the root, a workspace capturing a
  registry package's transitive edge (npm links one; here a `.upm` entry never points at a
  workspace, which keeps the store portable), `workspace:<other>@<range>` installed under a
  different name, `workspace:./path`, `catalog:`, injected packages, `init -w` and
  `--no-workspaces`. Publishing a manifest with a `workspace:` range is another manager's
  job: `upm publish` is npm's, which keeps it.
- `.npmrc` is read for the registry, `@scope:registry`, the credential keys, `save-exact`,
  `min-release-age`, `before`, `min-release-age-exclude`, `offline`, `prefer-offline` and `hoist`, from the project,
  user and global files and `npm_config_*`. Not npm's own built-in npmrc, and no `proxy`, `strict-ssl`,
  `cafile` or `always-auth`: those need an HTTP layer upm does not have. `upm login` and
  `upm config set` are npm's, run through exec. A credential is sent under its
  `//host/path/`, and to the rest of that host as npm's same-host fallback does — where two
  registries with different credentials share a host, the first covers paths outside both,
  where npm goes by the package's scope. A cross-origin redirect
  drops it, which is Node's fetch behavior and what `test/config.test.ts` pins.
- A lock's `resolved` on its registry's host is trusted by host, and in the
  `…/<name>/-/<file>` layout by name too: not GitHub Packages' `/download/@owner/…` urls or any
  odd path, and not whose GitLab project a url names. On a host many publish to, such a url
  can name another publisher's tarball that says it is this package. Holding every such url to
  the registry would cost a GitLab instance registry a request per entry. Settled by knowing
  each such host's own layout, or by measuring that cost. Start at `named` in `src/lock.ts`.
- The release age (default one day) filters fresh picks through the registry's view only:
  exact versions, locked ones and libc reads are never held back, since a package's exact pins
  are older than the package. A name whose abbreviated document changed after the cutoff costs
  a full-document read for its `time`; a registry that leaves `modified` out of that document
  costs one per fresh pick. Exclude globs know `*`, `**` and `?`, not minimatch's classes and
  braces. A registry that gives no publish dates holds nothing back, said once per registry
  (`undated`). A locked version is checked only as its tarball downloads, by the
  `last-modified` it is served with (`src/newer.ts`), and only warned about: one already in the
  store is not checked, and a server that copied a tarball since can flag an old one: npmjs
  itself serves a later date for batches of old tarballs it has copied again, a mirror for
  each copy. A lock pointing `resolved` off its registries is held to the registry's integrity,
  not its dates: that server's `last-modified` can say anything. Its exempt exact pins are
  guessed from the tree: one only newer packages depend on is passed, even under a parent the
  cutoff passes (an exact pin or an excluded name) whose range would have taken an older one.
  Checking every locked version would need its date from the full document, a request per
  name. Start at `loadAged` in `src/registry.ts`.
- Overrides (`readOverrides` in `src/overrides.ts`) change every edge, a top's included, and
  installed packages' peer ranges. A rule scoped to a parent reaches that parent's own edges only;
  deeper nesting is warned about and skipped, since a `name@version` has one set of edges. It
  would need a package keyed by the rules over it, as peer copies would. A rule's range matches
  an edge whose declared range intersects it, as npm and pnpm 12 match. Of
  `pnpm-workspace.yaml` only `overrides` is read (`pnpmOverrides`); its `catalog:` values, which
  pnpm 12 prefers to `$name`, are not supported, and neither are workspaces' own overrides.
- No separate copies of a consumer for different peer environments. Different
  consumers can have different peer versions, but an own dependency can still conflict
  with that consumer's peer range. `--verify` reports such conflicts; it cannot fix them.
- Undeclared imports resolve only through `.upm/node_modules`, pnpm's `hoist-pattern=*`
  with its version rule (`linkHoisted` in `src/link.ts`). `hoist=false` turns it off. No
  `hoist-pattern`, `public-hoist-pattern` or `shamefully-hoist`, and no `.bin` there, since
  no dependency script runs. A workspace is never hoisted (pnpm hoists them), and the
  project's own code and each workspace's still see only what they declare.
- Consumers missing the same peer in one settling round share a version only when one they
  would each pick alone fits all their ranges, so `^1 || ^3` and `^1 || ^2` still get a copy
  each. One found in a later round, behind a fetched peer, settles against what is already
  fetched and can also get its own. Start at `fetchPeer` in `src/resolve.ts`.
- An alias does not supply a peer under the package's real name.
- A tarball is held to the name and version its package.json claims, and each edge to what its
  dependent's package.json declares (`mismatch`, `misdeclared` in `src/util.ts`). A package.json
  without a name, and an index or backend entry written before names were kept, cannot say,
  and pass. The edges are the packument's, the declarations the tarball's package.json: a
  version whose two disagree on an alias fails with EMISMATCH. A peer on an alias or a tarball
  reads its dependent's package.json, which must make it a peer alone (`src/vouch.ts`). One
  that only a dependency installs also waits for every tarball, then for a walk that reads each
  reached package.json; an optional dropped from the tree vouches for nothing. Its range is not
  checked, as no nested edge's is. A peer whose own spec is an alias
  (`"vite": "npm:rolldown-vite@^7"` in peerDependencies) is asked of the registry by its name.
- `dedupe` prefers versions already locked; it is not an upgrade strategy. A fresh resolve
  requires removing the lockfile and `node_modules`, whose copy of the lockfile an install
  takes back (`upm update` is the url tarball gap above).
- The tarball spool is Node-only (it runs in the unpack worker); the portable tar reader
  still buffers whole files.
- Off Node, version picking has no target Node version for `engines.node`. Add an explicit
  target only if a caller needs cross-runtime resolution.

## Performance candidates

Unranked: take a fresh profile before choosing one. Use [perf.md](perf.md) for evidence.

- Coordinate throttling across registry workers. Each thread now runs the whole request
  ceiling (the walk's pick gate is what bounds the total), so a 429 halves one thread's gate
  while the other two keep asking at full rate: three uncoordinated backoffs against one
  registry. Test total traffic under a throttling registry and the handover from local
  requests to workers.
- The metadata walk's end on a cold install is bound by per-request latency and main-thread
  delay on the two thread hops per pick, not by the gate; wider gates made the install slower
  ([walk results][walk]). The next check is `bench/ab.sh lock` on a build that takes a hop
  off the pick path; what would settle it is a walk that runs off the main thread with the
  same `upm.lock`. Start at `ask` in `src/registry-pool.ts`.
- A warm link from a full store is bound by the workers' `link` and `mkdir` calls, and their
  `mkdir` CPU grows faster than the thread count, likely on `.upm`'s directory lock, where
  every entry's temp dir is made and renamed in. The next check is a temp dir outside `.upm`,
  or fewer directories per entry; what would settle it is less worker CPU for the same tree at
  eight threads. Start at `tempName` and `plan` in `src/link.ts`.
- The biggest tarballs' tail is their inflate and the hash of their biggest files; overlapping
  the two means helpers writing before the tarball's integrity has passed, which design.md
  forbids ([unpack results][unpack]). A design decision, not a benchmark, comes first.
  Start at `split` and `writePart` in `src/unpack.ts`.
- Registry threads at pool creation are a wash on a big tree and cost a one-package install
  most of its time ([thread start results][start]); what would make that start free is a
  cheaper thread boot and first request, most of which is the thread's first load of the
  fetch machinery (at its first request, so a walk over kept documents never pays it). A
  resolve with no lockfile of a root that declares `START_AT` names, or workspaces, starts
  them before the workspaces are read (`openEarly` in `src/api.ts`); a root with fewer, or a
  lockfile that turns out stale, still starts them at the walk's fourth name.
  Measure `tiny` cold and `nuxt` cold together. Start at `START_AT` in `src/registry-pool.ts`
  and `src/registry-worker.ts`.
- Fewer threads (unpack, registry) save CPU at a small wall cost on a many-core machine and are
  untested on a CPU-limited one; a `taskset -c 0-3` run of a few pairs is all there is. Decide
  whether pool sizes should follow the cores more steeply. Start at `defaultPoolSize` in
  `src/api.ts` and the size in `createRegistryPool`.
- Untested beyond one Linux machine: slow links (the streaming cutoff and the packument
  cutoff both assume a fast wire), a registry that throttles (above), and a resolver with a
  local stub (the lookup cache and hedge change nothing there).
- A slow-but-alive tarball transfer is not caught: a cold `next` run was seen taking a minute
  because the big tarball trickled in with no silence long enough for the stall watchdog,
  the main thread idle and no lookup slow. A throughput floor after the first megabytes, or a
  second range request racing the slow one, would bound it. Start at `once` in `src/store.ts`.
- A cold install of many small tarballs is bound by round trips and the main thread: on
  `large` with a lockfile, 32 downloads are in flight from start to end while main is busy for
  about 70% of the install. The same 1,350 GETs alone took 1.35 s at 32 at a time and 0.9 s at
  64, yet 64 slots in the install were a wash on `large` and a quarter slower on `next`, whose
  big tarballs then share the wire: at 64 a request waited ~55 ms for its first byte against
  ~30 ms, main being too busy to read it. Past the request, each tarball costs main its index
  write (a `JSON.stringify` and several threadpool calls, about a tenth of its busy time) and
  the pool's messages. Writing the index in the worker that stored the files would take the
  first away, but only main writes an index today: decide that first. Start at `publish` in
  `src/store.ts`; the fetch thread below is the other way.
- Through the library, a host that has imported `node:http` never gets upm's agent: on Node 22
  and 24 an ESM import of it makes undici's default dispatcher (a `require` does not), which
  `install` in `src/dns.ts` takes for the host's own, so its requests go through `fetch` with
  no lookup cache. Telling a default the host never configured from one it did would fix it;
  test from a process that imported `node:http` first, as `test/get.test.ts` explains.
- The tarball GET (`getter` in `src/dns.ts`) uses undici's legacy handler callbacks, which
  undici 6 and 7 both call. An undici that drops them would fail every download with
  `ENETWORK`, with no fallback to `fetch`: check `test/get.test.ts` on each new Node major.
- Prefetch decides per package with its parent's fate, which may wait on a libc read
  (`prefetch` in `src/api.ts`): what only an off-platform build reaches is never fetched. A
  regression here shows as extra store indexes on a cold install; check the index count
  against the platform's tree, not only the wall time, when touching `onPick` or `libcOf`.
- Kept registry documents (`src/metadata.ts`) are stored uncompressed: `upm lock` on `nuxt`
  over kept documents took 297 ms, against 326 ms with zstd level 1, for 60 MB on disk
  against 19 MB. Full packuments are trimmed by structure (`trimPackument`) to a
  fifth to a half, at about the cost of one `JSON.parse` of them, with a cold `nuxt` or `next`
  install unchanged; the same trim of the abbreviated documents keeps 85% of their bytes (the
  `dist` signatures stay) at 1.5 times the cost of the index scan, and is not done. The
  release-age window made `upm lock` over documents past their `max-age` 299 ms where
  revalidating them took 993 ms (`next`: 214 against 624). Writing documents after the walk,
  where nothing waits on them, is untried. A compressed body could not be read in parts.
- The workspace glob (Node's `fs.glob`, `listWorkspaces` in `src/workspaces.ts`) still runs
  wherever the install state holds no proof of the set: a warm resolve of a fresh clone, where
  on an 86-workspace monorepo it is about a third of the time before the walk (`packages/**/*`
  walks every directory under it and tries a package.json in each), and the first install
  after a folder changes under a `**` pattern (a build writing `dist/`, a branch switch).
  Under `**` any symlink means no proof at all. The proof's own walk (`record`) reads the same
  folders in a fraction of the glob's time; answering from it instead needs the glob's
  matching rules, and `implied` already checks the two agree. Measure with `bench/ab.sh
relock` on a workspace project, and the no-op with a folder toggled under `packages/`
  before each run; the `monorepo` fixture has no sources to walk.
- On a warm walk the registry threads are still the bound on a large workspace, about 85%
  busy: parsing the manifests a pick reads, the head of each kept document (its index is
  three JSON entries per version, and is parsed whole even when a pick reads one version),
  and each thread's own boot. A fourth thread was a wash (−18 ms of 650, 8/10, +160 ms CPU).
  Start at `get` in `src/metadata.ts`.
- For large archives, check both many-file and few-file shapes. Helper startup and retained
  buffers can cost more than parallel writes save. Include peak memory in the result.
- For warm installs, profile planning, messages and index work before adding more threads.
  A no-op or small incremental install must not pay for a whole-tree optimization.
- A tarball fetch thread freed main-thread CPU without a clear end-to-end gain worth its
  resource cost, when the download slots still waited on the unpack. Now that they do not, the
  main thread bounds a cold install of small tarballs (above), which is a reason to measure it
  again; test abort of a stream main opened, recovery after the fetch thread dies, and exit
  when it never reports ready.
