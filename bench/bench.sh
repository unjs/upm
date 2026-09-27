#!/usr/bin/env bash
# bench.sh — cold / warm / repeat install benchmark across package managers.
#
#   ./bench.sh                          # everything, default iteration counts
#   ./bench.sh -r upm,bun -f nitro  # a subset
#   ./bench.sh --cold 3 --warm 5        # more samples
#
# Results go to results/<stamp>.jsonl, one JSON object per timed run, and the charts beside
# them, one per phase: <stamp>.<phase>.svg, .<phase>.memory.svg and .<phase>.cpu.svg,
# plus <stamp>.size.svg for each manager's size on disk.
# A full suite also refreshes the committed charts/<phase>.svg, charts/size.svg and the like.
# Tables: node report.ts results/<stamp>.jsonl
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/runners.sh"

ALL_FIXTURES="nitro nuxt next"

RUNNERS="$ALL_RUNNERS"
FIXTURES="$ALL_FIXTURES"
COLD_RUNS=3
WARM_RUNS=3
REPEAT_RUNS=3
KEEP=0
CHART=1
DRY=0
MIN_FREE_MB=3072
# Outside the repo: aube and nub install into the nearest directory above with `workspaces` or
# a pnpm-workspace.yaml, member or not, and this repo has both. `check_work` holds any override
# to the same rule.
WORK="${BENCH_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/upm-bench}"
OUT=""

die() { echo "bench: $*" >&2; exit 1; }

usage() {
  sed -n '2,11p' "$HERE/bench.sh" | sed 's/^# \?//'
  cat <<EOF

Options
  -r, --runners <list>   comma separated (default: all)
                         available: $ALL_RUNNERS
  -f, --fixtures <list>  comma separated (default: all)
                         available: $ALL_FIXTURES
      --cold <n>         cold iterations per pair (default $COLD_RUNS)
      --warm <n>         warm iterations per pair (default $WARM_RUNS)
      --repeat <n>       repeat/no-op iterations per pair (default $REPEAT_RUNS)
      --keep             do not delete each pair's project + cache when done
      --min-free <mb>    abort if free disk drops below this (default $MIN_FREE_MB)
  -o, --out <file>       results file (default results/<stamp>.jsonl)
      --no-chart         skip rendering the SVG at the end
      --dry-run          print the plan and exit
  -h, --help             this
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -r|--runners)  RUNNERS="${2//,/ }"; shift 2 ;;
    -f|--fixtures) FIXTURES="${2//,/ }"; shift 2 ;;
    --cold)        COLD_RUNS="$2"; shift 2 ;;
    --warm)        WARM_RUNS="$2"; shift 2 ;;
    --repeat)      REPEAT_RUNS="$2"; shift 2 ;;
    --keep)        KEEP=1; shift ;;
    --no-chart)    CHART=0; shift ;;
    --min-free)    MIN_FREE_MB="$2"; shift 2 ;;
    -o|--out)      OUT="$2"; shift 2 ;;
    --dry-run)     DRY=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

for r in $RUNNERS; do
  case " $ALL_RUNNERS " in *" $r "*) ;; *) die "unknown runner: $r" ;; esac
done
for f in $FIXTURES; do
  [ -f "$HERE/fixtures/$f/package.json" ] || die "unknown fixture: $f"
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
[ -n "$OUT" ] || OUT="$HERE/results/$STAMP.jsonl"
mkdir -p "$(dirname "$OUT")"

# Every manager gets the same quiet, non-interactive, no-telemetry environment.
export NO_COLOR=1 NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 ADBLOCK=1
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
unset CI || true   # pnpm turns on --frozen-lockfile under CI, which breaks a cold run
# A manager that segfaults is a failed run, which the results already record. Without this it
# is also a core dump the size of its heap dropped in whatever directory it died in — `aube
# --version` alone left 1.7 GB in the repo root. Nothing here ever wants to open one.
ulimit -c 0 2>/dev/null || true

free_mb() { df -Pm "$WORK" | awk 'NR==2 {print $4}'; }

# Apparent size and a package count, recorded so an obviously-wrong run (a
# manager that installed nothing) shows up in the results instead of looking
# fast. Both follow symlinks and dedupe by inode: an isolated layout holds the
# real directory *and* symlinks pointing at it, and aube symlinks its whole tree
# out to a global store, so a plain count is not comparable across managers.
tree_stats() {
  local proj="$1" bytes=0 pkgs=0
  if [ -d "$proj/node_modules" ]; then
    bytes="$(timeout 120 du -sbL "$proj/node_modules" 2>/dev/null | awk '{print $1}')"
    pkgs="$(timeout 120 find -L "$proj/node_modules" -name package.json -not -path '*/.bin/*' \
              -printf '%i\n' 2>/dev/null | sort -u | wc -l)"
  fi
  echo "${bytes:-0} ${pkgs:-0}"
}

# A small private cache may mean the manager used a shared cache elsewhere.
# Record the size so the report can flag it for inspection.
cache_bytes() {
  du -sb "$1" 2>/dev/null | awk '{print $1+0}'
}

emit() { # runner version fixture phase iter ms ok bytes pkgs cache_bytes runner_bytes runner_packed_bytes rss_bytes rss_process_bytes user_us sys_us
  node -e '
const fields = ["runner","version","fixture","phase","iter","ms","ok","bytes","packages","cache_bytes","runner_bytes","runner_packed_bytes","rss_bytes","rss_process_bytes","user_ms","sys_ms"];
const row = Object.fromEntries(fields.map((key, i) => [key, process.argv[i + 1]]));
for (const key of ["iter","ms","bytes","packages","cache_bytes","runner_bytes","runner_packed_bytes"]) row[key] = Number(row[key]);
for (const key of ["runner_bytes","runner_packed_bytes"]) if (!row[key]) delete row[key];
// Without rusage (the run failed before measure.pl started) these stay out, not zero.
for (const key of ["rss_bytes","rss_process_bytes"]) {
  if (row[key]) row[key] = Number(row[key]); else delete row[key];
}
for (const key of ["user_ms","sys_ms"]) {
  if (row[key]) row[key] = Math.round(Number(row[key]) / 1000); else delete row[key];
}
row.ok = row.ok === "true";
row.ts = new Date().toISOString();
console.log(JSON.stringify(row));
' "$@" >> "$OUT"
}

# Cold means nothing carried over: no cache, no lockfile of any manager, no tree.
reset_project() {
  local proj="$1" fixture="$2"
  rm -rf "$proj"
  mkdir -p "$proj"
  cp "$HERE/fixtures/$fixture/package.json" "$proj/package.json"
}

# One timed install. Echoes "<ms> <ok> <tree rss bytes> <process rss bytes> <user us> <sys us>".
# measure.pl times the install command alone and reads its rusage; the outer clock is only
# for a run that failed before it got that far, which has no rusage.
timed_install() {
  local runner="$1" proj="$2" cache="$3" log="$4" usage="$5"
  local t0 t1 ok=true ms rss="" one="" user="" sys=""
  rm -f "$usage"
  t0=$(date +%s%N)
  if ! ( cd "$proj" && MEASURE_OUT="$usage" runner_install "$runner" "$cache" ) >>"$log" 2>&1; then
    ok=false
  fi
  t1=$(date +%s%N)
  ms=$(( (t1 - t0) / 1000000 ))
  [ -s "$usage" ] && read -r ms rss one user sys < "$usage"
  echo "$ms $ok $rss $one $user $sys"
}

progress() { # phase iter ms ok pkgs rss_bytes user_us sys_us
  printf '   %-6s %2d  %8s ms  ok=%-5s %5s pkgs  %6s MB rss  %8s ms cpu\n' "$1" "$2" "$3" "$4" "$5" \
    "$(( ${6:-0} / 1000000 ))" "$(( (${7:-0} + ${8:-0}) / 1000 ))"
  # Every fixture installs something: a success with nothing in node_modules went elsewhere.
  if [ "$4" = true ] && [ "${5:-0}" = 0 ]; then
    echo "   ! $1 run $2 succeeded with no packages in the project: check where it installed" >&2
  fi
}

# A package.json or workspace file above the projects is a root a manager may install into
# instead of the project: see WORK.
check_work() {
  local dir; dir="$(cd "$WORK" && pwd -P)"
  while [ "$dir" != / ]; do
    dir="$(dirname "$dir")"
    for f in package.json pnpm-workspace.yaml aube-workspace.yaml; do
      [ -e "$dir/$f" ] && die "$dir/$f is above the work directory $WORK; set BENCH_WORK elsewhere"
    done
  done
  return 0
}

command -v perl >/dev/null || die "perl is needed to measure memory and CPU (measure.pl)"

echo "bench: runners  : $RUNNERS"
echo "bench: fixtures : $FIXTURES"
echo "bench: samples  : cold=$COLD_RUNS warm=$WARM_RUNS repeat=$REPEAT_RUNS"
echo "bench: workdir  : $WORK"
echo "bench: results  : $OUT"
[ "$DRY" = 1 ] && exit 0

mkdir -p "$WORK"
check_work
LOGDIR="$WORK/logs"; mkdir -p "$LOGDIR"
# `ulimit -c 0` covers anything this script starts, but a runner that raises it again leaves
# one behind anyway. On the way out, drop what this run dropped: `core.<pid>`, younger than
# the marker, in one of the two directories a runner is ever started from. On the way out and
# not at the end, so a run that dies partway still tidies up after itself.
touch "$OUT.started"
sweep_cores() {
  for dir in "$UPM_ROOT" "$HERE"; do
    find "$dir" -maxdepth 1 -name 'core.[0-9]*' -newer "$OUT.started" -delete 2>/dev/null || true
  done
  rm -f "$OUT.started"
}
trap sweep_cores EXIT

# The upm runner measures dist/, so it has to be this working tree's build and not
# whatever was left there last. Skipped when UPM_CLI points somewhere else.
if [[ " $RUNNERS " == *" upm "* && "$UPM_CLI" == "$UPM_ROOT/dist/upm.mjs" ]]; then
  echo "bench: building upm dist/..."
  ( cd "$UPM_ROOT" && npm run build ) >"$LOGDIR/upm-build.log" 2>&1 \
    || die "upm build failed, see $LOGDIR/upm-build.log"
fi

# Resolve every manager to its entry first: the download of a pinned manager is jup's cost,
# not the manager's, and it must not land inside a timed run. Running each once also shows
# the entry works before anything is timed.
command -v node >/dev/null || die "node is needed to run the benchmark"
[ -f "$JUP" ] || die "jup is missing from node_modules, run: node $UPM_ROOT/upm install --frozen-lockfile"
echo "bench: resolving managers..."
# Packed once per manager: compressing the largest takes about a second.
declare -A PACKED=()
for r in $RUNNERS; do
  runner_resolve "$r" >"$LOGDIR/$r-resolve.log" 2>&1 || die "runner $r did not resolve, see $LOGDIR/$r-resolve.log"
  PACKED[$r]="$(runner_packed_bytes "$r" 2>/dev/null)"
  # upm has no --version; its build above is its check.
  [ "$r" = upm ] || { runner_cmd "$r" && "${CMD[@]}" --version >>"$LOGDIR/$r-resolve.log" 2>&1; } \
    || die "runner $r is not usable here, see $LOGDIR/$r-resolve.log"
  echo "  $r $(runner_version "$r")  ${RUNNER_ENTRY[$r]}"
done

for fixture in $FIXTURES; do
  for runner in $RUNNERS; do
    version="$(runner_version "$runner")"
    size="$(runner_bytes "$runner" 2>/dev/null)"
    packed="${PACKED[$runner]}"
    pair="$WORK/$runner-$fixture"
    proj="$pair/project"
    cache="$pair/cache"
    log="$LOGDIR/$runner-$fixture.log"
    usage="$pair/usage"
    : > "$log"

    avail="$(free_mb)"
    if [ "$avail" -lt "$MIN_FREE_MB" ]; then
      die "only ${avail}MB free, below --min-free ${MIN_FREE_MB}MB; stopping before $runner/$fixture"
    fi

    echo "== $runner / $fixture (${avail}MB free)"

    # ---- cold: empty cache, no lockfile, no node_modules
    for i in $(seq 1 "$COLD_RUNS"); do
      reset_project "$proj" "$fixture"
      rm -rf "$cache"; mkdir -p "$cache"
      read -r ms ok rss one user sys <<<"$(timed_install "$runner" "$proj" "$cache" "$log" "$usage")"
      read -r bytes pkgs <<<"$(tree_stats "$proj")"
      emit "$runner" "$version" "$fixture" cold "$i" "$ms" "$ok" "$bytes" "$pkgs" "$(cache_bytes "$cache")" "$size" "$packed" "$rss" "$one" "$user" "$sys"
      progress cold "$i" "$ms" "$ok" "$pkgs" "$rss" "$user" "$sys"
    done

    # ---- warm: cache and lockfile kept, tree removed
    for i in $(seq 1 "$WARM_RUNS"); do
      rm -rf "$proj/node_modules"
      read -r ms ok rss one user sys <<<"$(timed_install "$runner" "$proj" "$cache" "$log" "$usage")"
      read -r bytes pkgs <<<"$(tree_stats "$proj")"
      emit "$runner" "$version" "$fixture" warm "$i" "$ms" "$ok" "$bytes" "$pkgs" "$(cache_bytes "$cache")" "$size" "$packed" "$rss" "$one" "$user" "$sys"
      progress warm "$i" "$ms" "$ok" "$pkgs" "$rss" "$user" "$sys"
    done

    # ---- repeat: everything already in place, so this is the no-op cost
    for i in $(seq 1 "$REPEAT_RUNS"); do
      read -r ms ok rss one user sys <<<"$(timed_install "$runner" "$proj" "$cache" "$log" "$usage")"
      read -r bytes pkgs <<<"$(tree_stats "$proj")"
      emit "$runner" "$version" "$fixture" repeat "$i" "$ms" "$ok" "$bytes" "$pkgs" "$(cache_bytes "$cache")" "$size" "$packed" "$rss" "$one" "$user" "$sys"
      progress repeat "$i" "$ms" "$ok" "$pkgs" "$rss" "$user" "$sys"
    done

    if [ "$KEEP" = 0 ]; then
      rm -rf "$pair"
    fi
  done
done

echo
echo "bench: done -> $OUT"
echo "bench: report with: node $HERE/report.ts $OUT"

if [ "$CHART" = 1 ]; then
  # Only a full suite replaces the committed charts/ the README links to.
  full=0
  [ "$RUNNERS" = "$ALL_RUNNERS" ] && [ "$FIXTURES" = "$ALL_FIXTURES" ] && full=1
  for measure in time memory cpu; do
    node "$HERE/chart.ts" "$OUT" --measure "$measure" \
      || echo "bench: $measure chart failed, results are still in $OUT" >&2
    if [ "$full" = 1 ]; then
      node "$HERE/chart.ts" "$OUT" --measure "$measure" -o "$HERE/charts/" \
        || echo "bench: $measure chart failed for charts/" >&2
    fi
  done
  node "$HERE/chart.ts" "$OUT" --size || echo "bench: size chart failed" >&2
  if [ "$full" = 1 ]; then
    node "$HERE/chart.ts" "$OUT" --size -o "$HERE/charts/" \
      || echo "bench: size chart failed for charts/" >&2
  fi
fi
