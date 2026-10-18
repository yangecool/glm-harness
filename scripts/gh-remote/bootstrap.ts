/**
 * The POSIX installer every GH remote runtime archive ships as `bootstrap.sh`.
 *
 * The script is generated once and embedded verbatim; it never requires Node on
 * the target: probing, archive digest checks, guarded extraction, per-file
 * manifest verification (sha256sum), flock-serialized staging, atomic symlink
 * activation, rollback, and runner management all run on the POSIX toolchain
 * (sh, tar, sha256sum, flock, awk). Every failure names its stage and exits
 * with the stage's code so controllers can localize errors (F24).
 */

/** Exit codes double as the stage identity for machine-localized failures. */
export const BOOTSTRAP_STAGE_CODES = {
  probe: 90, 'verify-archive': 91, extract: 92, 'verify-payload': 93, activate: 94, home: 95, lock: 96, runner: 97, usage: 98,
} as const

/**
 * Render the installer script for an archive payload.
 * @returns complete POSIX sh source; identical for every release (state comes from manifest.json).
 */
export function renderBootstrapScript(): string {
  return String.raw`#!/bin/sh
# GH remote runtime bootstrap: install, activate, roll back, and run a GH
# runtime release without Node preinstalled on this host. Linux only for now.
set -eu

PROGRAM=gh-remote
ARCHIVE_TOP=gh-remote
ROOT=$GH_REMOTE_HOME
[ -n "$ROOT" ] || ROOT=$HOME/.glmh-remote
LOCK_TIMEOUT=300
FORCE=no

die() { stage=$1; code=$2; shift 2; echo "$PROGRAM: stage=$stage: $*" >&2; exit "$code"; }
usage() {
  cat >&2 <<'USAGE'
usage: bootstrap.sh <command> [options]
  install <archive.tar.gz> [--force] [--lock-timeout <seconds>]   verify, stage, and atomically activate
  run -- <dsh args>...                                            exec the active release in the foreground
  start -- <dsh args>...                                          start the active release detached (pid + log)
  stop [--timeout <seconds>]                                      stop a detached runner
  status                                                          print the active release and runner state
  rollback                                                        reactivate the previous release after verifying it
USAGE
  exit 98
}

need_tools() {
  missing=""
  for tool in tar sha256sum flock awk find sort mv ln chmod cp cmp sed; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ -z "$missing" ] || die probe 90 "required tools missing:$missing"
}

machine_arch() {
  case "$(uname -m)" in
    x86_64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die probe 90 "unsupported machine $(uname -m)" ;;
  esac
}

# Extract one top-level scalar field from a manifest.json read on stdin. The
# builder emits stable two-space indentation; awk keeps Node off this host.
manifest_field() {
  awk -v key="\"$1\"" '
    index($0, "  " key ":") == 1 {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/,$/, "", line)
      gsub(/^"|"$/, "", line)
      print line
      exit
    }
  '
}

# Emit "<sha256>  <path>" checklist lines for the files array read on stdin.
manifest_checklist() {
  awk '
    /"files": \[/ { inside = 1; next }
    inside && /\]/ { inside = 0 }
    inside && /"path":/ { path = $0; sub(/^[^:]*:[[:space:]]*"/, "", path); sub(/",$/, "", path) }
    inside && /"sha256":/ { sum = $0; sub(/^[^:]*:[[:space:]]*"/, "", sum); sub(/",$/, "", sum); printf "%s  %s\n", sum, path }
  '
}

# Emit "mode path" pairs with the JSON decimal mode kept for printf '%o'.
manifest_modes() {
  awk '
    /"files": \[/ { inside = 1; next }
    inside && /\]/ { inside = 0 }
    inside && /"path":/ { path = $0; sub(/^[^:]*:[[:space:]]*"/, "", path); sub(/",$/, "", path) }
    inside && /"mode":/ { mode = $0; sub(/^[^:]*:[[:space:]]*/, "", mode); sub(/,$/, "", mode); printf "%d %s\n", mode, path }
  '
}

# Verify one release-shaped directory: exact inventory, digests, then modes.
# Scratch files live under a fixed staging scratch dir wiped on entry, so a
# killed verification never poisons the release directory itself.
verify_release_dir() {
  dir=$1
  [ -f "$dir/manifest.json" ] || die verify-payload 93 "release $dir has no manifest.json"
  scratch="$ROOT/staging/.verify-scratch"
  rm -rf "$scratch"
  mkdir -p "$scratch" || die verify-payload 93 "cannot create scratch $scratch"
  manifest_checklist < "$dir/manifest.json" > "$scratch/checklist"
  sed 's/^[0-9a-f]*  //' "$scratch/checklist" | sort > "$scratch/declared"
  (cd "$dir" && find . -type f ! -path ./manifest.json) | sed 's|^\./||' | sort > "$scratch/actual"
  if ! cmp -s "$scratch/declared" "$scratch/actual"; then
    die verify-payload 93 "file inventory differs from manifest.json in $dir"
  fi
  (cd "$dir" && sha256sum -c "$scratch/checklist" >/dev/null 2>&1) \
    || die verify-payload 93 "payload digest mismatch in $dir"
  (cd "$dir" && manifest_modes < manifest.json | while read -r mode path; do
    [ -n "$mode" ] || continue
    octal=$(printf '%o' "$mode")
    chmod "$octal" "$path" || exit 1
  done) || die verify-payload 93 "payload permissions differ from manifest.json in $dir"
  rm -rf "$scratch"
}

current_release() { readlink "$ROOT/current" 2>/dev/null || true; }

release_meta() {
  release_dir=$ROOT/current
  [ -d "$release_dir" ] || die runner 97 "no active release; run install first"
  VERSION=$(manifest_field < "$release_dir/manifest.json" version)
  COMMIT=$(manifest_field < "$release_dir/manifest.json" commit)
  DIRTY=$(manifest_field < "$release_dir/manifest.json" dirty)
  TARGET=$(manifest_field < "$release_dir/manifest.json" target)
  NODE=$(manifest_field < "$release_dir/manifest.json" nodeVersion)
}

cmd_install() {
  [ $# -ge 1 ] || usage
  archive=$1
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --force) FORCE=yes ;;
      --lock-timeout) shift; if [ $# -lt 1 ]; then usage; fi; LOCK_TIMEOUT=$1 ;;
      *) usage ;;
    esac
    shift
  done
  need_tools
  [ -f "$archive" ] || die verify-archive 91 "archive not found: $archive"
  checksum_file=$archive.sha256
  [ -f "$checksum_file" ] || die verify-archive 91 "missing sidecar $checksum_file"
  expected=$(awk '{print $1}' "$checksum_file")
  actual=$(sha256sum "$archive" | awk '{print $1}')
  [ "$actual" = "$expected" ] || die verify-archive 91 "archive digest mismatch (expected $expected, got $actual)"

  if ! tar -xzOf "$archive" "$ARCHIVE_TOP/manifest.json" >/dev/null 2>&1; then
    die extract 92 "archive does not contain $ARCHIVE_TOP/manifest.json"
  fi
  payload_manifest=$(tar -xzOf "$archive" "$ARCHIVE_TOP/manifest.json")
  want_target=$(printf '%s\n' "$payload_manifest" | manifest_field target)
  kernel=$(uname -s)
  [ "$kernel" = Linux ] || die probe 90 "this bootstrap supports Linux targets, host kernel is $kernel"
  [ "linux-$(machine_arch)" = "$want_target" ] \
    || die probe 90 "archive targets $want_target but this host is linux-$(machine_arch)"
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || echo unknown)
  echo "$PROGRAM: probe ok (linux-$(machine_arch), libc $libc)"

  if tar -tzf "$archive" | awk -v top="$ARCHIVE_TOP" '
      $0 == top || $0 == top "/" { next }
      index($0, top "/") != 1 { bad = 1 }
      END { exit bad }'; then :; else
    die extract 92 "archive contains entries outside $ARCHIVE_TOP/"
  fi
  if tar -tzf "$archive" | grep -Eq '(^|/)(\.\.)(/|$)'; then
    die extract 92 "archive contains parent-directory escapes"
  fi

  mkdir -p "$ROOT/releases" "$ROOT/locks" "$ROOT/log" "$ROOT/run" "$ROOT/staging" \
    || die activate 94 "cannot create install root $ROOT"
  exec 9>"$ROOT/locks/install.lock"
  flock -w "$LOCK_TIMEOUT" 9 || die lock 96 "another install holds the lock"

  version=$(printf '%s\n' "$payload_manifest" | manifest_field version)
  commit=$(printf '%s\n' "$payload_manifest" | manifest_field commit)
  id="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$commit" | cut -c1-8)"
  stage="$ROOT/staging/$id"
  rm -rf "$stage"
  mkdir -p "$stage" || die extract 92 "cannot create staging $stage"
  # A killed install leaves an incomplete staging directory behind; the next
  # attempt of the same id re-extracts over it completely.
  if ! tar -xzf "$archive" --strip-components=1 -C "$stage"; then
    rm -rf "$stage"
    die extract 92 "extraction failed"
  fi
  verify_release_dir "$stage"

  release_dir="$ROOT/releases/$id"
  if [ -d "$release_dir" ]; then
    if [ "$FORCE" = yes ]; then rm -rf "$release_dir"; else die activate 94 "release $id already installed (use --force)"; fi
  fi
  if ! mv "$stage" "$release_dir"; then
    rm -rf "$stage"
    die activate 94 "cannot move staging into releases"
  fi

  if [ ! -d "$ROOT/home" ]; then
    mkdir -p "$ROOT/home" || die home 95 "cannot create home"
    cp -a "$release_dir/home-template/." "$ROOT/home/" || die home 95 "cannot seed home from template"
  fi

  ln -sfn "releases/$id" "$ROOT/.current.new"
  if ! mv -T "$ROOT/.current.new" "$ROOT/current"; then
    die activate 94 "cannot activate release $id"
  fi
  echo "$PROGRAM: activated $id (version $version, target $want_target)"
}

cmd_run() {
  [ -d "$ROOT/current" ] || die runner 97 "no active release; run install first"
  release_dir=$ROOT/current
  node=$release_dir/bin/node
  [ -x "$node" ] || die runner 97 "bundled node missing at $node"
  DSH_HOME=$ROOT/home
  export DSH_HOME
  exec "$node" "$release_dir/runtime/lib/bin.js" "$@"
}

wait_gone() {
  pid=$1
  budget=$2
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt "$budget" ]; then return 1; fi
    sleep 1
  done
  return 0
}

cmd_start() {
  release_meta
  if [ -f "$ROOT/run/runner.pid" ] && kill -0 "$(cat "$ROOT/run/runner.pid")" 2>/dev/null; then
    die runner 97 "runner already running (pid $(cat "$ROOT/run/runner.pid"))"
  fi
  release_dir=$ROOT/current
  node=$release_dir/bin/node
  [ -x "$node" ] || die runner 97 "bundled node missing at $node"
  mkdir -p "$ROOT/run" "$ROOT/log"
  DSH_HOME=$ROOT/home
  export DSH_HOME
  ( exec "$node" "$release_dir/runtime/lib/bin.js" "$@" ) >>"$ROOT/log/runner.log" 2>&1 &
  echo $! > "$ROOT/run/runner.pid"
  echo "$PROGRAM: started pid $(cat "$ROOT/run/runner.pid") (release $(current_release | sed 's|releases/||'))"
}

cmd_stop() {
  timeout=10
  while [ $# -gt 0 ]; do
    case $1 in
      --timeout) shift; if [ $# -lt 1 ]; then usage; fi; timeout=$1 ;;
      *) usage ;;
    esac
    shift
  done
  [ -f "$ROOT/run/runner.pid" ] || die runner 97 "no runner pid recorded"
  pid=$(cat "$ROOT/run/runner.pid")
  kill "$pid" 2>/dev/null || die runner 97 "runner $pid is not running"
  if wait_gone "$pid" "$timeout"; then
    rm -f "$ROOT/run/runner.pid"
    echo "$PROGRAM: stopped pid $pid"
  else
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$ROOT/run/runner.pid"
    echo "$PROGRAM: killed pid $pid after $timeout seconds"
  fi
}

cmd_status() {
  release_meta
  pid=-; alive=no
  if [ -f "$ROOT/run/runner.pid" ]; then
    pid=$(cat "$ROOT/run/runner.pid")
    if kill -0 "$pid" 2>/dev/null; then alive=yes; else pid=-; fi
  fi
  cat <<STATUS
root=$ROOT
release=$(current_release | sed 's|releases/||')
version=$VERSION
commit=$COMMIT
dirty=$DIRTY
target=$TARGET
node=$NODE
pid=$pid
alive=$alive
STATUS
}

cmd_rollback() {
  need_tools
  mkdir -p "$ROOT/releases" "$ROOT/locks" "$ROOT/staging" || die activate 94 "no releases installed"
  current=$(basename "$(current_release)")
  previous=$(ls -1 "$ROOT/releases" | sort -r | awk -v cur="$current" '$0 != cur { print; exit }')
  [ -n "$previous" ] || die activate 94 "no previous release to roll back to"
  exec 9>"$ROOT/locks/install.lock"
  flock -w "$LOCK_TIMEOUT" 9 || die lock 96 "another install holds the lock"
  verify_release_dir "$ROOT/releases/$previous"
  ln -sfn "releases/$previous" "$ROOT/.current.new"
  if ! mv -T "$ROOT/.current.new" "$ROOT/current"; then
    die activate 94 "cannot reactivate release $previous"
  fi
  echo "$PROGRAM: rolled back to $previous (was $current)"
}

[ $# -ge 1 ] || usage
command=$1
shift
case $command in
  install) cmd_install "$@" ;;
  run) if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then shift; fi; cmd_run "$@" ;;
  start) if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then shift; fi; cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  rollback) cmd_rollback ;;
  help|-h|--help) usage ;;
  *) usage ;;
esac
`
}
