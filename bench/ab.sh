#!/usr/bin/env bash
# ab.sh <mode> <pairs> <label:dist> <label:dist> [more label:dist...] -- <fixture>...
#
# Paired A/B of two or more upm builds on the fixtures in bench/fixtures, alternating build
# order each pair. Each run is measured by measure.pl (wall ms, tree peak RSS, CPU) into a
# rows file under bench/.work/ab (gitignored); summ.mjs then prints medians and paired
# differences against the first build.
#
#   mode   cold   — empty private store, no lockfile, no node_modules, every run
#          warm   — primed once per build (store + upm.lock kept), node_modules removed per run
#          repeat — primed once per build, nothing removed per run
#          cache  — primed once per build (store kept), upm.lock and node_modules removed per run
#          lock   — `upm lock` on a fresh project dir and store
#          relock — `upm lock`, primed once per build (store kept), upm.lock removed per run
#          lock, relock and cache fail when the builds' upm.lock differ
#   pairs  10 or more for a claim (see .agents/perf.md)
#   fixture  a name in bench/fixtures, or a path to a project directory (with a `/`); either
#          is copied whole, without node_modules and upm.lock
#
# Env:  AB_ENV="K=V K2=V2"    extra env for every run
#       AB_ENV_<label>="K=V"  extra env for one build (the label must be a shell word)
#       AB_ARGS="--flag"      extra arguments for every timed command, e.g. --prefer-offline
#       AB_OUT=<file>         rows file (default bench/.work/ab/<stamp>-<mode>.rows)
#       AB_KEEP=1             keep the work dirs
#
# Holds bench/.work/ab/.lock while it runs, so two runs on one machine queue instead of
# timing over each other. Projects go outside the repo, as with bench.sh (BENCH_WORK).
set -u
BENCH=$(cd "$(dirname "$0")" && pwd)
FIX=$BENCH/fixtures
MEASURE=$BENCH/measure.pl
AB=$BENCH/.work/ab
WORK=${BENCH_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/upm-bench}/ab-$$
[ $# -ge 2 ] || { sed -n 2,26p "$0"; exit 2; }
MODE=$1; RUNS=$2; shift 2
BUILDS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do BUILDS+=("$1"); shift; done
shift || true
FIXTURES=("$@")
[ ${#BUILDS[@]} -ge 2 ] && [ ${#FIXTURES[@]} -ge 1 ] || { sed -n 2,26p "$0"; exit 2; }
case $MODE in cold|warm|repeat|cache|lock|relock) ;; *) echo "bad mode $MODE"; exit 2;; esac
# A fixture's directory: under bench/fixtures, or the path given. Rows and work dirs use its name.
source_of() { case $1 in */*) (cd "$1" && pwd);; *) echo "$FIX/$1";; esac; }
for fx in "${FIXTURES[@]}"; do
  [ -f "$(source_of "$fx")/package.json" ] || { echo "no fixture $fx in $FIX"; exit 2; }
done

label() { echo "${1%%:*}"; }
dist()  { local d="${1#*:}"; cd "$(dirname "$d")" && echo "$(pwd)/$(basename "$d")"; }
# The `upm` bin of a build: `upm.mjs`, or `cli.mjs` in one from before `src/cli.ts` was the CLI.
bin()   { [ -f "$1/upm.mjs" ] && echo "$1/upm.mjs" || echo "$1/cli.mjs"; }
for b in "${BUILDS[@]}"; do
  [ -f "$(bin "$(dist "$b")")" ] || { echo "no upm.mjs in $(dist "$b")"; exit 2; }
done

mkdir -p "$AB"
exec 9>"$AB/.lock"
flock 9
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=${AB_OUT:-$AB/$STAMP-$MODE.rows}
mkdir -p "$WORK" "$(dirname "$OUT")"
trap '[ -n "${AB_KEEP:-}" ] && echo "work: $WORK" || rm -rf "$WORK"' EXIT
# The same 1-day gate as bench.sh, not the machine's npmrc. An inherited dashed spelling
# is dropped in run(), since upm would pick between the two by environment order.
export npm_config_min_release_age="${BENCH_MIN_AGE_DAYS:-1}" npm_config_ignore_scripts=

run() { # <label> <dist> <fixture> <measure-out|-> [command] ; in the build's project dir
  local lbl=$1 d=$2 fx=$3 mo=$4 cmd=${5:-} dir=$WORK/$1-$(basename "$3") envvar
  envvar="AB_ENV_$lbl"
  [ -n "$cmd" ] || case $MODE in lock|relock) cmd=lock;; *) cmd=install;; esac
  # shellcheck disable=SC2086 # AB_ENV, AB_ENV_<label> and AB_ARGS are word lists
  ( cd "$dir/p" && env -u npm_config_min-release-age ${AB_ENV:-} ${!envvar:-} perl "$MEASURE" "$mo" node "$(bin "$d")" $cmd --store "$dir/store" ${AB_ARGS:-} >"$dir/out.log" 2>&1 )
}
prepare() { # <label> <fixture> — the project dir (fresh, with a fresh store, for cold and lock)
  local dir=$WORK/$1-$(basename "$2")
  case $MODE in cold|lock) rm -rf "$dir";; esac
  mkdir -p "$dir/p" "$dir/store"
  # Copied once: a new mtime would send every repeat run past upm's up-to-date stamps.
  [ -f "$dir/p/package.json" ] ||
    tar -C "$(source_of "$2")" --exclude=node_modules --exclude=upm.lock -cf - . | tar -C "$dir/p" -xf -
  # A workspace has a node_modules of its own.
  case $MODE in warm|cache) find "$dir/p" -name node_modules -prune -exec rm -rf {} +;; esac
  case $MODE in cache|relock) rm -f "$dir/p/upm.lock";; esac
  return 0
}
entries() { # <label> <fixture> — what the run produced: lockfile entries, or .upm entries
  local dir=$WORK/$1-$(basename "$2")
  case $MODE in lock|relock) grep -c '^    "[^"]*@[^"]*": {' "$dir/p/upm.lock" 2>/dev/null || echo 0;;
    *) ls "$dir/p/node_modules/.upm" 2>/dev/null | wc -l;; esac
}

echo "# $STAMP mode=$MODE runs=$RUNS builds=${BUILDS[*]} fixtures=${FIXTURES[*]} env=${AB_ENV:-}" | tee -a "$OUT"
for fx in "${FIXTURES[@]}"; do
  name=$(basename "$fx")
  case $MODE in warm|repeat|cache|relock) # prime each build once
    for b in "${BUILDS[@]}"; do
      prepare "$(label "$b")" "$fx"; run "$(label "$b")" "$(dist "$b")" "$fx" /dev/null install || { echo "prime failed: $b $fx"; cat "$WORK/$(label "$b")-$name/out.log"; exit 1; }
    done;;
  esac
  for i in $(seq 1 "$RUNS"); do
    order=("${BUILDS[@]}"); if (( i % 2 == 0 )); then mapfile -t order < <(printf '%s\n' "${BUILDS[@]}" | tac); fi
    for b in "${order[@]}"; do
      l=$(label "$b"); prepare "$l" "$fx"
      m=$WORK/m.txt; : >"$m"
      run "$l" "$(dist "$b")" "$fx" "$m"; ok=$?
      read -r ms rss prss us ss <"$m" || { ms=; rss=; prss=; us=; ss=; }
      echo "$name $l $i ms=${ms:-NA} rss=${rss:-NA} cpu_us=$(( ${us:-0} + ${ss:-0} )) ok=$ok entries=$(entries "$l" "$fx")" | tee -a "$OUT"
    done
  done
  case $MODE in lock|relock|cache) # the last pair's lockfiles must agree, or the builds resolve differently
    first=$(label "${BUILDS[0]}")
    for b in "${BUILDS[@]:1}"; do
      other=$(label "$b")
      if cmp -s "$WORK/$first-$name/p/upm.lock" "$WORK/$other-$name/p/upm.lock"; then
        echo "$name: upm.lock identical ($first vs $other)"
      else
        echo "$name: upm.lock DIFFERS ($first vs $other)" >&2
        diff "$WORK/$first-$name/p/upm.lock" "$WORK/$other-$name/p/upm.lock" | head -20 >&2
        AB_KEEP=1; exit 1
      fi
    done;;
  esac
done
node "$BENCH/summ.mjs" "$OUT"
echo "rows: $OUT"
