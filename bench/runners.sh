#!/usr/bin/env bash
# Runner definitions. Sourced by bench.sh.
#
# Every runner installs into $proj and keeps its whole cache/store under $cache,
# so "cold" is `rm -rf $cache` and no real user cache is ever touched.
#
# Contract, per runner:
#   runner_resolve <name>                 -> finds the manager's version and entry, once
#   runner_version <name>                 -> version string, one line
#   runner_install <name> <cache>         -> install in $PWD, inherit stdio, with the
#                                            install command itself run through `measure`
#   runner_lockfiles <name>               -> lockfile names it writes, space separated
#   runner_bytes <name>                   -> apparent size of the manager itself, or nothing
#   runner_packed_bytes <name>            -> its size as a CI cache (tar + zstd), or nothing

# Node has no installer (`node install` is not a command and this build ships no
# bundled npm), so it is deliberately absent from this list.
ALL_RUNNERS="upm npm pnpm11 pnpm12 yarn1 yarn4 bun deno aube nub"

UPM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# dist/, because that is what the published `bin` runs. src/ pays ~60 ms per invocation in
# type stripping, which is most of a repeat install and none of a user's experience.
# Set UPM_CLI=../upm to measure the self-install path instead.
UPM_CLI="${UPM_CLI:-$UPM_ROOT/dist/upm.mjs}"

# jup from devDependencies, so the release each range picks does not depend on whatever jup
# is installed on the machine.
JUP="$UPM_ROOT/node_modules/jup/bin/jup.mjs"

# What jup is asked for. Unversioned names get jup's default release.
runner_spec() {
  case "$1" in
    npm|bun|deno|aube|nub) echo "$1" ;;
    pnpm11) echo pnpm@11 ;;
    pnpm12) echo pnpm@12 ;;
    yarn1)  echo yarn@1 ;;
    yarn4)  echo yarn@4 ;;
  esac
}

# Timed runs start each manager from its own entry in jup's store, never through jup. A jup
# shim is a Node process that loads jup first and stays alive around a native manager: about
# 40 ms, 40 ms of CPU and 56 MB that would be charged to the manager.
declare -gA RUNNER_VERSION=() RUNNER_ENTRY=() RUNNER_DIR=()

# Sets RUNNER_VERSION, RUNNER_ENTRY and RUNNER_DIR for one runner, downloading the manager
# if jup does not have it yet. Must run in the shell that installs, not in `$(...)`.
runner_resolve() {
  local name="$1" spec out
  if [ "$name" = upm ]; then
    # upm's package.json version is a placeholder, so the git commit is what identifies
    # the build under test, prefixed by which of the two entry points ran. `-dirty` because a
    # commit alone would name a build that is not the one that ran.
    local version
    case "$UPM_CLI" in */dist/*) version="dist-" RUNNER_DIR[upm]="$UPM_ROOT/dist" ;; *) version="src-" RUNNER_DIR[upm]="$UPM_ROOT/src" ;; esac
    version+="$(git -C "$UPM_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
    [ -z "$(git -C "$UPM_ROOT" status --porcelain -- src 2>/dev/null)" ] || version+="-dirty"
    RUNNER_VERSION[upm]="$version"
    RUNNER_ENTRY[upm]="$UPM_CLI"
    return
  fi
  spec="$(runner_spec "$name")"
  [ -n "$spec" ] || { echo "unknown runner: $name" >&2; return 2; }
  out="$(node -e '
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const [jup, spec] = process.argv.slice(1);
const jupRun = (...args) => execFileSync(process.execPath, [jup, ...args], { encoding: "utf8" });
// Only this message names the exact release a range picked.
const picked = /Installing (\S+)@(\S+)\.\.\./.exec(jupRun("cache", "install", "-g", spec));
if (!picked) throw new Error(`jup did not name the release it picked for ${spec}`);
const [, pm, version] = picked;
const dir = join(JSON.parse(jupRun("cache", "list", "--json")).store.path, pm, version);
const bin = JSON.parse(readFileSync(join(dir, ".jup"), "utf8")).bin[pm];
if (!bin) throw new Error(`${dir}/.jup has no ${pm} bin`);
console.log([version, dir, join(dir, bin)].join("\t"));
' "$JUP" "$spec")" || return 1
  IFS=$'\t' read -r RUNNER_VERSION[$name] RUNNER_DIR[$name] RUNNER_ENTRY[$name] <<<"$out"
}

runner_version() {
  echo "${RUNNER_VERSION[$1]}"
}

# Sets CMD to the argv that starts the runner's manager. JavaScript entries run on the `node`
# on PATH, the same one upm runs on; jup would start them on its own.
runner_cmd() {
  local entry="${RUNNER_ENTRY[$1]}"
  [ -n "$entry" ] || { echo "runner $1 is not resolved" >&2; return 2; }
  case "$1:$entry" in
    upm:*|*.js|*.cjs|*.mjs) CMD=(node "$entry") ;;
    *) CMD=("$entry") ;;
  esac
}

runner_lockfiles() {
  case "$1" in
    upm) echo "upm.lock" ;;
    npm)     echo "package-lock.json npm-shrinkwrap.json" ;;
    pnpm11|pnpm12) echo "pnpm-lock.yaml" ;;
    yarn1|yarn4) echo "yarn.lock" ;;
    bun)     echo "bun.lock bun.lockb" ;;
    deno)    echo "deno.lock" ;;
    aube)    echo "aube-lock.yaml" ;;
    nub)     echo "nub.lock" ;;
  esac
}

# What a user has on disk to run the manager: its directory in the jup store, where each
# version has its own, or the upm entry being measured. Empty when the directory is missing,
# so the row has no size rather than a wrong one.
runner_bytes() {
  local dir="${RUNNER_DIR[$1]}"
  [ -n "$dir" ] && [ -d "$dir" ] && du -sb "$dir" | awk '{print $1+0}'
}

# The same files packed the way actions/cache packs them, a POSIX tar through zstd: what a
# CI cache downloads to restore the manager. Empty without zstd.
runner_packed_bytes() {
  local dir="${RUNNER_DIR[$1]}"
  [ -n "$dir" ] && [ -d "$dir" ] && command -v zstd >/dev/null || return 0
  tar --posix -cf - -C "$dir" . | zstd -T0 -q -c | wc -c
}

# The release-age gate every manager gets, in whole days. Set here, not left to a machine's
# npmrc, yarnrc or environment, so every machine resolves the same versions. yarn 1 has no gate.
MIN_AGE_DAYS="${BENCH_MIN_AGE_DAYS:-1}"
# Runs its arguments with pnpm's `minimum-release-age`, in minutes, for pnpm, aube and nub:
# without it each uses a day of its own, and npm warns about the key, so it is theirs alone.
pnpm_age() {
  local minutes=$((MIN_AGE_DAYS * 1440))
  npm_config_minimum_release_age="$minutes" pnpm_config_minimum_release_age="$minutes" "$@"
}

# Runs one install command under measure.pl, which times it and records its rusage into
# $MEASURE_OUT. Only the command is measured, not the setup around it in runner_install.
# The gate goes in the environment: npm's `min-release-age` in days (upm, npm) and
# yarn 4's in minutes. An inherited `npm_config_min-release-age` is dropped, since which
# spelling wins would be each manager's choice. pnpm, aube and nub read pnpm's key instead
# (`pnpm_age`), and bun and deno take a flag; both are set in runner_install.
measure() {
  env -u npm_config_min-release-age \
    npm_config_min_release_age="$MIN_AGE_DAYS" YARN_NPM_MINIMAL_AGE_GATE="$((MIN_AGE_DAYS * 1440))" \
    perl "$UPM_ROOT/bench/measure.pl" "$MEASURE_OUT" "$@"
}

# Lifecycle scripts are forced off everywhere. upm cannot run them at all,
# so leaving them on for the others would compare different amounts of work.
#
# Called with the working directory already set to the project, so no runner
# needs its own --dir/--cwd/--prefix flag and there is one less thing to get
# wrong per manager.
runner_install() {
  local name="$1" cache="$2" CMD
  runner_cmd "$name" || return
  case "$name" in
    upm)
      measure "${CMD[@]}" install --store "$cache/store"
      ;;
    npm)
      npm_config_cache="$cache/npm" \
        measure "${CMD[@]}" install --ignore-scripts --no-audit --no-fund
      ;;
    # --store-dir moves the content-addressed store and nothing else. The metadata and
    # tarball cache is a separate directory under XDG_CACHE_HOME, and leaving it alone let a
    # "cold" run read a warm real cache: 696 ms against 2.98 s for nuxt once it is private.
    pnpm11)
      XDG_CACHE_HOME="$cache/xdg" \
        pnpm_age measure "${CMD[@]}" install --store-dir "$cache/store" --ignore-scripts --no-frozen-lockfile
      ;;
    pnpm12)
      XDG_CACHE_HOME="$cache/xdg" \
        pnpm_age measure "${CMD[@]}" install --store-dir "$cache/store" --ignore-scripts --no-frozen-lockfile
      ;;
    yarn1)
      measure "${CMD[@]}" install --cache-folder "$cache/yarn" --ignore-scripts --non-interactive --no-progress
      ;;
    # The global folder holds yarn 4's shared cache. node-modules, not the default PnP, so
    # there is a tree to delete for warm and to count like every other manager's. The empty
    # yarn.lock marks the project root; without one yarn 4 walks up to the repo's package.json
    # and refuses to run. It is the only lockfile a cold run starts with, and it is empty.
    yarn4)
      [ -e yarn.lock ] || : > yarn.lock
      YARN_GLOBAL_FOLDER="$cache/berry" YARN_NODE_LINKER=node-modules \
        YARN_ENABLE_SCRIPTS=false YARN_ENABLE_TELEMETRY=0 YARN_ENABLE_IMMUTABLE_INSTALLS=false \
        measure "${CMD[@]}" install
      ;;
    bun)
      BUN_INSTALL_CACHE_DIR="$cache/bun" measure "${CMD[@]}" install --ignore-scripts \
        --minimum-release-age="$((MIN_AGE_DAYS * 86400))"
      ;;
    deno)
      # DENO_DIR holds the npm cache and everything else deno caches.
      DENO_DIR="$cache/deno" measure "${CMD[@]}" install --node-modules-dir=auto --quiet \
        --min-dep-age="$((MIN_AGE_DAYS * 1440))"
      ;;
    aube)
      AUBE_STORE_DIR="$cache/store" XDG_CACHE_HOME="$cache/xdg" pnpm_age measure "${CMD[@]}" install --ignore-scripts
      ;;
    # nub keeps its store, metadata and global virtual store under the XDG directories.
    nub)
      XDG_CACHE_HOME="$cache/xdg" XDG_DATA_HOME="$cache/xdg-data" pnpm_age measure "${CMD[@]}" install --ignore-scripts
      ;;
  esac
}
