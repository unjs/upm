# Install benchmark

Times cold, warm and repeat installs of one entry package with every supported package
manager, and records time, peak memory and CPU for each run.

```sh
./bench.sh                         # every runner and fixture, then the charts
./bench.sh -r upm,pnpm12 -f nuxt   # a subset
./bench.sh --cold 5 --warm 5       # more samples
node report.ts results/<stamp>.jsonl  # markdown tables (bench.sh does not print them)
node chart.ts                      # re-render the charts for the newest run
```

**Needs:** Linux, Node 24 (the `.ts` tools run with type stripping, no build), Perl for
`measure.pl`, and `jup` in `node_modules` (`node ../upm install --frozen-lockfile`).
`zstd` is optional: without it the size chart has no CI restore estimate.

| option                       | default                 | meaning                                       |
| ---------------------------- | ----------------------- | --------------------------------------------- |
| `-r, --runners`              | all                     | comma separated runner names                  |
| `-f, --fixtures`             | `nitro,nuxt,next`       | comma separated fixture names                 |
| `--cold/--warm/--repeat <n>` | 3 / 3 / 3               | samples per phase for each runner and fixture |
| `--keep`                     | off                     | keep each project and cache after its fixture |
| `--min-free <mb>`            | 3072                    | stop before the disk gets this full           |
| `-o, --out <file>`           | `results/<stamp>.jsonl` | results file                                  |
| `--no-chart`                 | off                     | skip the SVG charts                           |
| `--dry-run`                  | off                     | print the plan and exit                       |

`BENCH_WORK` moves the work directory (default `~/.cache/upm-bench`, or under
`XDG_CACHE_HOME`). Each runner's output goes to `<work>/logs/<runner>-<fixture>.log`.

## What a run does

1. Rebuilds `../dist` so upm is always this working tree.
2. Downloads every manager with jup and runs its `--version` once, so no download lands in a
   timed run.
3. For each fixture, runs the three phases below in order, in rounds: each round runs every
   runner once, starting one runner later than the round before. A slow minute of network then
   lands on every manager, not on whichever ran its samples back to back. Then it deletes the
   fixture's projects and caches (unless `--keep`).
4. Writes `results/<stamp>.jsonl` and, beside it, charts for each phase and measure:
   `<stamp>.<phase>.svg`, `.memory.svg`, `.cpu.svg`, plus `<stamp>.size.svg`. A full suite
   (all runners, default fixtures) also refreshes the committed [`charts/`](charts) that the
   main README links to.

Core dumps are off (`ulimit -c 0`): a crash counts as a failed run, not a heap-sized file in
the repo. Any `core.<pid>` newer than the run is deleted on exit.

## Fixtures

Each fixture is a `package.json` with one pinned entry package, so every manager starts from
the same graph.

| fixture | entry package                                                        |
| ------- | -------------------------------------------------------------------- |
| `nitro` | `nitro@3.0.260903-beta`                                              |
| `nuxt`  | `nuxt@4.5.2`                                                         |
| `next`  | `next@16.3.4`, plus `react` and `react-dom@19.2.0`, which it needs   |
| `tiny`  | `ms@2.1.3`, no dependencies. Not in the default suite; use `-f tiny` |

`tiny` is for A/B tests of startup or thread changes, where a ~150 ms install shows costs
the big fixtures hide. `nuxt` reaches `@isaacs/cliui`, which uses alias specs
(`string-width-cjs@npm:string-width@^4.2.0`), so its tree has both an ESM and a CJS copy of
`string-width`, `strip-ansi` and `wrap-ansi`.

## Phases

Run in this order, so one download fills the cache for the rest.

| phase    | state before the install                        | what it costs                  |
| -------- | ----------------------------------------------- | ------------------------------ |
| `cold`   | no cache, no lockfile, no `node_modules`        | resolve + download + link      |
| `warm`   | cache and lockfile kept, `node_modules` deleted | read lockfile + link           |
| `repeat` | nothing deleted                                 | finding there is nothing to do |

`warm` matters most for CI with a restored cache. `repeat` is what an editor or a `predev`
hook pays when install had nothing to do.

## Runners

upm runs `../dist/upm.mjs`, the same file as the published `bin`. Its version is
`dist-<sha>`, with `-dirty` when `src/` has uncommitted changes. Set `UPM_CLI=../upm` to
measure the source entry instead (`src-<sha>`, slower to start, not what users run).

Other managers come from jup (a dev dependency, so versions do not depend on the machine).
They are **not** run through jup: `runners.sh` finds each manager's own entry in the jup
store and starts it directly, a native binary as is and a JavaScript entry on the same
`node` as upm. A jup shim would add a Node process of about 40 ms and 56 MB.

| runner   | command (lifecycle scripts off in all)          |
| -------- | ----------------------------------------------- |
| `upm`    | `node ../dist/upm.mjs install --store <cache>`  |
| `npm`    | `node <npm> install`                            |
| `pnpm11` | `node <pnpm@11> install --store-dir <cache>`    |
| `pnpm12` | `<pnpm@12> install --store-dir <cache>`         |
| `yarn1`  | `node <yarn@1> install --cache-folder <cache>`  |
| `yarn4`  | `node <yarn@4> install` (`node-modules` linker) |
| `bun`    | `<bun> install`                                 |
| `deno`   | `<deno> install --node-modules-dir=auto`        |
| `aube`   | `<aube> install`                                |
| `nub`    | `<nub> install`                                 |

`node` is not a runner: Node 24 has no `install` command and this build ships no npm.

## Fairness

- **Projects outside any other project.** aube and nub install into the nearest directory
  above the project with `workspaces` in its `package.json` or a `pnpm-workspace.yaml`,
  without checking the project is a member. Under `bench/.work`, that was this repo: they
  installed upm's own dev dependencies there and reported the time as the fixture's. So the
  work directory defaults to outside the repo, and `bench.sh` refuses one with a
  `package.json` or workspace file anywhere above it.
- **Private caches.** Each manager's cache lives under `<work>/<runner>-<fixture>/cache`, so
  "cold" is a directory delete and no real cache is touched. pnpm needs both `--store-dir`
  and `XDG_CACHE_HOME`: with the store alone, a "cold" pnpm read the real metadata cache and
  finished `nuxt` in 696 ms instead of 2.98 s. The others use `npm_config_cache`,
  `YARN_GLOBAL_FOLDER`, `BUN_INSTALL_CACHE_DIR`, `DENO_DIR`, `AUBE_STORE_DIR` and the XDG
  directories. Each cold row records the cache size; a successful cold run with a cache
  under 1 MB gets a warning, as the manager may have used a shared cache, and so does any
  successful run that leaves no packages in the project.
- **Lifecycle scripts are off everywhere**, because upm cannot run them.
- **A 1-day release-age gate for all**, set by the harness and not left to the machine's npmrc,
  yarnrc or environment, so every machine resolves the same versions (`BENCH_MIN_AGE_DAYS`
  changes it). Each manager gets its own key: npm's `min-release-age` (upm, npm, deno), pnpm's
  `minimum-release-age` (pnpm, aube, nub), yarn 4's `npmMinimalAgeGate` and bun's
  `--minimum-release-age`. `runners.sh` has the details.
- **`CI` is unset**, since pnpm turns on `--frozen-lockfile` under CI and a cold run fails.
  Colors, update notices, audit, fund and telemetry are off for all.
- **Packages are counted by inode**, following symlinks. Isolated layouts hold both a real
  directory and links to it, and aube and nub link to a global store, so a plain file count
  would not compare.

Real differences, left in on purpose:

- yarn 1 has no release-age gate, so it can install a version the others hold back. bun
  applies the gate with a stability rule of its own and can pick an older version than the rest.
- yarn 4 uses `nodeLinker: node-modules`, since Plug'n'Play writes no `node_modules` to
  delete or count. A cold yarn 4 run starts with an empty `yarn.lock`, or it treats the repo
  root as its project.
- yarn 1 uses its default `registry.yarnpkg.com`, a proxy of the npm registry.
- Optional-dependency rules differ, so counts can differ by one or two packages. A manager
  that is fast because it installed less shows up in the counts.
- Layouts and hardlinks versus copies change the apparent size on disk.

## Time, memory and CPU

Only the install command is measured, by `perl measure.pl`, not the setup around it.

| field               | meaning                                     | source                                      |
| ------------------- | ------------------------------------------- | ------------------------------------------- |
| `ms`                | wall time                                   | `CLOCK_MONOTONIC` around `fork` and `wait4` |
| `user_ms`, `sys_ms` | CPU time of the whole process tree          | `wait4()` rusage, exact                     |
| `rss_bytes`         | peak memory of the whole tree at one moment | `/proc` VmHWM summed, sampled every 10 ms   |
| `rss_process_bytes` | peak memory of the largest single process   | `wait4()` `ru_maxrss`, exact                |

Perl, because neither bash nor Node can read a child's rusage. Worker threads are part of
their process, so they always count. A daemon that leaves the tree is not counted.

`rss_bytes` is what reports and charts show. It adds up the processes alive at the same
time, so helpers and wrappers count, and it is never below `rss_process_bytes`. For a
single-process manager the two match within about 1 MB. It can miss growth only in a
process's last 10 ms.

- CPU is user + sys, not divided by wall time; a manager using many cores has more CPU than
  wall time.
- A run that fails before `measure.pl` starts has no memory or CPU fields, and its time
  comes from the shell.
- Older results, from before managers ran from their own entry, include the jup launcher:
  about 40 ms, 40 ms of CPU and 56 MB for bun, deno, aube and pnpm 12.

## Output

`results/<stamp>.jsonl` (gitignored) has one object per timed run:

```json
{
  "runner": "upm",
  "version": "dist-c658757",
  "fixture": "nitro",
  "phase": "cold",
  "iter": 1,
  "ms": 936,
  "ok": true,
  "bytes": 45317721,
  "packages": 63,
  "cache_bytes": 52428800,
  "runner_bytes": 142301,
  "runner_packed_bytes": 49152,
  "rss_bytes": 264245248,
  "rss_process_bytes": 264245248,
  "user_ms": 1102,
  "sys_ms": 315,
  "ts": "2026-09-09T23:08:28Z"
}
```

`bytes` and `packages` describe `node_modules`. `runner_bytes` is the manager's own size on
disk: its directory in the jup store, or `dist/` (`src/` with `UPM_CLI`) for upm.
`runner_packed_bytes` is the same files as a POSIX tar through `zstd -T0`, the
way `actions/cache` packs them. The size chart turns it into an estimated restore time,
fitted to measured `actions/cache` restores on `ubuntu-latest` (`RESTORE` in `chart.ts`).
The warm time chart loops between the measured installs and the same installs moved right by
that estimate. With reduced motion it stays on the measured view.

## report.ts

`node report.ts <file.jsonl>...` prints a markdown table per phase, then memory and CPU
tables when the results have them. Options: `--metric min|median|mean|max` (default
median), `--phase` (repeatable) and `--measure time|memory|cpu`.

`results.ts` holds the rules shared with the charts:

- Only successful samples count. Partial failures show their count; an all-failed group
  shows its time to failure and can never win.
- Bold marks the lowest value per phase and fixture, excluding failures and cache warnings.
  It is a ranking, not a significance test.
- Sample counts are real counts per group. Different versions of a manager get their own
  rows, so several files never mix builds.
- Missing pairs say `not run`. A bad JSONL line reports its file and line number.

## chart.ts

Self-contained SVGs for READMEs, one per phase, since phase times differ by orders of
magnitude.

```sh
node chart.ts                                  # newest results/*.jsonl, all phases
node chart.ts results/<stamp>.jsonl -o charts/ # charts/{cold,warm,repeat}.svg
node chart.ts --phase warm -o docs/warm.svg    # one phase, exactly that file
node chart.ts --measure memory                 # or cpu: <stamp>.<phase>.memory.svg
node chart.ts --size                           # <stamp>.size.svg
```

It also takes several result files and `--metric` like `report.ts`, and prints the paths it
writes. "Newest" means most recently modified, not last by name.

- **One row per manager and version**, ranked by score. For each fixture, a manager's time
  is divided by the best time there; the score is the geometric mean of those ratios. Only
  managers with a clean result in every fixture are ranked; the rest follow with a reason.
- **Shapes are fixtures** (circle nitro, square nuxt, diamond next) and **colors are
  phases** (blue cold, orange warm, purple repeat). A light band marks upm. Each row ends
  with its fastest–slowest range.
- **A logo shows what each manager runs on**: Node.js, Rust (Ferris), Bun or Deno. See
  `RUNTIME` in `chart.ts` and the artwork in `icons.ts`.
- **The axis is linear from zero**, so twice as far right is twice as long.
- **Failures stay visible**: all-failed groups are hollow red markers at their time to
  failure, partial failures get a red outline. Small cold caches and empty projects get a footnote.
- **Memory and CPU charts** use the same layout and rules, scored on their own values.
- **`--size`** draws bars of each manager's size on disk, smallest first, with the ratio to
  upm and, when recorded, its packed size and estimated CI restore.
- **Every chart has one canvas size** (`WIDTH` × `HEIGHT` in `chart.ts`), so they line up
  in a README grid. Rows stretch to fill spare height; only a chart too tall for it grows.
- The SVG has its own light background and no scripts, fonts or external files, so it works
  on GitHub in either theme. Open it directly to see exact values in marker tooltips.

For a PNG: `rsvg-convert --zoom 2 results/<stamp>.cold.svg -o cold.png`. After a layout
change, regenerate a chart and look at it at its embedded size.

## A/B of upm builds: `ab.sh`

```sh
bench/ab.sh <mode> <pairs> <label:dist> <label:dist>... -- <fixture>...
bench/ab.sh warm 10 base:/tmp/base/dist new:dist -- nuxt next
```

Compares two or more upm builds (each a directory with `upm.mjs`), alternating their order
each pair. Every run goes through `measure.pl` into a rows file under `.work/ab/`, then
`summ.mjs` prints medians and paired differences against the first build, with how many
pairs the new build won.

- Modes: `cold`, `warm` and `repeat` as above, with a private store per build, and `lock`,
  which times `upm lock` alone in a fresh project and fails if the builds' `upm.lock`
  differ.
- Env: `AB_ENV` / `AB_ENV_<label>` add environment for all builds or one, `AB_OUT` names
  the rows file, `AB_KEEP=1` keeps the work directories. `min-release-age` is cleared.
- It holds `.work/ab/.lock` (via `flock`), so two runs on one machine wait for each other.
- Use ten or more pairs before claiming a result: [../.agents/perf.md](../.agents/perf.md).
