/**
 * The POSIX installer every GH remote runtime archive ships as `bootstrap.sh`.
 *
 * The script is generated once and embedded verbatim; it never requires Node
 * on the target for its OWN stages: probing, archive digest checks, guarded
 * extraction, per-file manifest verification, home seeding, flock-serialized
 * staging, and detached supervisor launch run on the POSIX toolchain alone.
 * Every mutating step that owns shared state — pointer switches, drains,
 * stops, garbage collection — is delegated to the supervisor CLI the archive
 * itself carries (`<release>/bin/node` plus `<release>/runtime/node_modules/
 * @glm-harness/gh-remote-supervisor/lib/index.js`), so one lifecycle
 * transaction lock serializes every verb, bootstrap included. Every failure
 * names its stage and exits with the stage's code so controllers can localize
 * errors (F24).
 */

/** Exit codes double as the stage identity for machine-localized failures. */
export const BOOTSTRAP_STAGE_CODES = {
  probe: 90, 'verify-archive': 91, extract: 92, 'verify-payload': 93, activate: 94, home: 95, lock: 96, runner: 97, usage: 98,
} as const

/** Commands checked by the controller probe and by the target installer. */
export const BOOTSTRAP_REQUIRED_TOOLS = ['tar', 'gzip', 'sha256sum', 'flock', 'awk', 'find', 'sort', 'mv', 'ln', 'chmod', 'cp', 'cmp', 'sed', 'mktemp', 'readlink', 'date', 'grep', 'cut', 'cat', 'mkdir', 'rm', 'uname', 'basename', 'ls'] as const

/**
 * Render the installer script for an archive payload.
 * @returns complete POSIX sh source; identical for every release (state comes from manifest.json).
 */
export function renderBootstrapScript(): string {
  return String.raw`#!/bin/sh
# GH remote runtime bootstrap: install, supervise, and maintain a GH runtime
# release without Node preinstalled on this host. Linux only for now. The
# supervisor CLI inside each release owns every shared-state mutation; this
# script only stages bytes and delegates.
set -e

PROGRAM=gh-remote
ARCHIVE_TOP=gh-remote
ROOT=$GH_REMOTE_HOME
[ -n "$ROOT" ] || ROOT=$HOME/.glmh-remote
set -u
LOCK_TIMEOUT=300

die() { stage=$1; code=$2; shift 2; echo "$PROGRAM: stage=$stage: $*" >&2; exit "$code"; }
usage() {
  cat >&2 <<'USAGE'
usage: bootstrap.sh <command> [options]
  install <archive.tar.gz> [--lock-timeout <seconds>]        verify, stage, seal, and atomically activate through the supervisor
  run                                                        run the supervisor profile in the foreground
  start                                                      start the supervisor profile detached (pid + log)
  stop [--timeout <seconds>]                                 stop the supervisor and drain its service
  status                                                     release, supervisor identity, lifecycle, and runtime id
  update <archive.tar.gz> [--drain-timeout <seconds>]        stage a new release, drain, switch, and supervise it
  rollback [--drain-timeout <seconds>]                       drain, switch back, and supervise the previous release
  gc | uninstall [--purge]                                   delegate to the supervisor CLI's same verbs
USAGE
  exit 98
}

need_tools() {
  missing=""
  for tool in ${BOOTSTRAP_REQUIRED_TOOLS.join(' ')}; do
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

# The release id the supervisor's current.json pointer names.
current_release() {
  [ -f "$ROOT/releases/current.json" ] || return 0
  awk -v key='"releaseId"' '
    index($0, "  " key ":") == 1 {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/,$/, "", line)
      gsub(/^"|"$/, "", line)
      print line
      exit
    }
  ' "$ROOT/releases/current.json"
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

# Verify one extracted payload against its embedded manifest.json. Scratch
# files live under a fixed staging scratch dir wiped on entry, so a killed
# verification never poisons the release directory itself.
verify_payload_dir() {
  dir=$1
  [ -f "$dir/manifest.json" ] || die verify-payload 93 "payload has no manifest.json"
  if find "$dir" ! -type d ! -type f -print | grep -q .; then
    die verify-payload 93 "payload contains links or special files"
  fi
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
  done) || die verify-payload 93 "payload permissions differ from manifest.json"
  rm -rf "$scratch"
}

# Resolve the bundled node and supervisor CLI one release carries.
supervisor_binaries() {
  dir=$1
  SUP_NODE="$dir/bin/node"
  [ -x "$SUP_NODE" ] || die runner 97 "release $dir has no bundled node"
  SUP_CLI="$dir/runtime/node_modules/@glm-harness/gh-remote-supervisor/lib/index.js"
  [ -f "$SUP_CLI" ] || die runner 97 "release $dir has no supervisor CLI at $SUP_CLI"
}

supervise_env() {
  GH_REMOTE_HOME=$ROOT
  GH_REMOTE_ROOT=$ROOT
  DSH_HOME=$ROOT/home
  export GH_REMOTE_HOME GH_REMOTE_ROOT DSH_HOME
}

# Run one supervisor CLI verb with the release's bundled node.
supervisor_verb() {
  dir=$1; verb=$2; shift 2
  supervise_env
  supervisor_binaries "$dir"
  "$SUP_NODE" "$SUP_CLI" --root "$ROOT" "$verb" "$@"
}

# Extract + verify one archive into a caller-named directory.
stage_archive() {
  archive=$1; into=$2
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
  if tar -tzf "$archive" | awk -v top="$ARCHIVE_TOP" '
      $0 == top || $0 == top "/" { next }
      index($0, top "/") != 1 { bad = 1 }
      END { exit bad }'; then :; else
    die extract 92 "archive contains entries outside $ARCHIVE_TOP/"
  fi
  if tar -tzf "$archive" | grep -Eq '(^|/)(\.\.)(/|$)'; then
    die extract 92 "archive contains parent-directory escapes"
  fi
  if ! tar -tvzf "$archive" | awk 'substr($0, 1, 1) != "d" && substr($0, 1, 1) != "-" { bad = 1 } END { exit bad }'; then
    die extract 92 "archive contains links or special files"
  fi
  mkdir -p "$into" || die extract 92 "cannot create staging $into"
  if ! tar -xzf "$archive" --strip-components=1 -C "$into"; then
    rm -rf "$into"
    die extract 92 "extraction failed"
  fi
  verify_payload_dir "$into"
}

# Seed the shared home once; later installs never touch it.
seed_home() {
  from=$1
  if [ ! -d "$ROOT/home" ]; then
    mkdir -p "$ROOT/home" || die home 95 "cannot create home"
    cp -a "$from/home-template/." "$ROOT/home/" || die home 95 "cannot seed home from template"
  fi
}

cmd_install() {
  [ $# -ge 1 ] || usage
  archive=$1
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --force) : ;; # Compatibility flag; every install still creates an immutable release.
      --lock-timeout) shift; if [ $# -lt 1 ]; then usage; fi; LOCK_TIMEOUT=$1 ;;
      *) usage ;;
    esac
    shift
  done
  need_tools
  mkdir -p "$ROOT/releases" "$ROOT/locks" "$ROOT/log" "$ROOT/run" "$ROOT/staging" \
    || die activate 94 "cannot create install root $ROOT"
  exec 9>"$ROOT/locks/install.lock"
  flock -w "$LOCK_TIMEOUT" 9 || die lock 96 "another install holds the lock"
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || echo unknown)
  echo "$PROGRAM: probe ok (linux-$(machine_arch), libc $libc)"
  commit8=$(printf '%s\n' "$(tar -xzOf "$archive" "$ARCHIVE_TOP/manifest.json" | manifest_field commit)" | cut -c1-8)
  id="$(date -u +%Y%m%dT%H%M%SZ)-$commit8-$(basename "$(mktemp -u XXXXXXXX)")"
  staging="$ROOT/releases/.staging-$id"
  stage_archive "$archive" "$staging"
  seed_home "$staging"
  # Seal the release manifest the supervisor's commit verb requires, then hand
  # the staging directory over: one lifecycle transaction renames it into
  # place and switches the pointer.
  printf '{\n  "kind": "gh-remote-release",\n  "id": "%s",\n  "installedAt": %s000,\n  "note": "bootstrap install"\n}\n' "$id" "$(date +%s)" > "$staging/gh-release.json"
  supervisor_verb "$staging" commit --id "$id" || die activate 94 "supervisor commit refused release $id"
  echo "$PROGRAM: activated $id"
}

cmd_run() {
  [ -n "$(current_release)" ] || die runner 97 "no current release; run install first"
  release_dir=$ROOT/releases/$(current_release)
  supervise_env
  supervisor_binaries "$release_dir"
  exec "$SUP_NODE" "$release_dir/runtime/lib/bin.js" --profile gh-supervisor --no-open --host 127.0.0.1 --port 0
}

cmd_start() {
  [ -n "$(current_release)" ] || die runner 97 "no current release; run install first"
  release_dir=$ROOT/releases/$(current_release)
  if [ -f "$ROOT/run/runner.pid" ] && kill -0 "$(cat "$ROOT/run/runner.pid")" 2>/dev/null; then
    die runner 97 "runner already running (pid $(cat "$ROOT/run/runner.pid"))"
  fi
  mkdir -p "$ROOT/run" "$ROOT/log"
  supervise_env
  supervisor_binaries "$release_dir"
  ( exec "$SUP_NODE" "$release_dir/runtime/lib/bin.js" --profile gh-supervisor --no-open --host 127.0.0.1 --port 0 ) >>"$ROOT/log/runner.log" 2>&1 &
  echo $! > "$ROOT/run/runner.pid"
  echo "$PROGRAM: started supervisor pid $(cat "$ROOT/run/runner.pid") (release $(current_release))"
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

cmd_stop() {
  timeout=10
  while [ $# -gt 0 ]; do
    case $1 in
      --timeout) shift; if [ $# -lt 1 ]; then usage; fi; timeout=$1 ;;
      *) usage ;;
    esac
    shift
  done
  [ -n "$(current_release)" ] || die runner 97 "no current release; run install first"
  release_dir=$ROOT/releases/$(current_release)
  if [ -f "$ROOT/run/runner.pid" ]; then
    pid=$(cat "$ROOT/run/runner.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      if wait_gone "$pid" "$timeout"; then
        echo "$PROGRAM: stopped supervisor pid $pid"
      else
        kill -9 "$pid" 2>/dev/null || true
        echo "$PROGRAM: killed supervisor pid $pid after $timeout seconds"
      fi
    fi
    rm -f "$ROOT/run/runner.pid"
  fi
  # The supervisor CLI's stop also drains a service a crashed supervisor
  # orphaned, and clears the root's lock and identity leftovers.
  supervisor_verb "$release_dir" stop || die runner 97 "supervisor stop failed"
}

cmd_update() {
  [ $# -ge 1 ] || usage
  archive=$1
  shift
  drain_timeout=30000
  while [ $# -gt 0 ]; do
    case $1 in
      --drain-timeout) shift; if [ $# -lt 1 ]; then usage; fi; drain_timeout=$1 ;;
      --force) : ;;
      --lock-timeout) shift; if [ $# -lt 1 ]; then usage; fi ;;
      *) usage ;;
    esac
    shift
  done
  [ -n "$(current_release)" ] || die runner 97 "no current release; run install first"
  need_tools
  mkdir -p "$ROOT/releases" "$ROOT/locks" "$ROOT/log" "$ROOT/run" "$ROOT/staging"
  exec 9>"$ROOT/locks/install.lock"
  flock -w "$LOCK_TIMEOUT" 9 || die lock 96 "another install holds the lock"
  temp=$(mktemp -d "$ROOT/staging/update-XXXXXX") || die extract 92 "cannot create update staging"
  if ! stage_archive "$archive" "$temp/payload"; then
    rm -rf "$temp"
    exit 92
  fi
  update_commit8=$(printf '%s\n' "$(tar -xzOf "$archive" "$ARCHIVE_TOP/manifest.json" | manifest_field commit)" | cut -c1-8)
  newid="$(date -u +%Y%m%dT%H%M%SZ)-$update_commit8-$(basename "$(mktemp -u XXXXXXXX)")"
  if ! supervisor_verb "$ROOT/releases/$(current_release)" install --from "$temp/payload" --id "$newid" --note "bootstrap update"; then
    rm -rf "$temp"
    die activate 94 "supervisor install refused the update payload"
  fi
  rm -rf "$temp"
  rm -f "$ROOT/run/runner.pid"
  # Drain, stop, switch, and supervise in the foreground exactly like run.
  release_dir=$ROOT/releases/$(current_release)
  supervise_env
  supervisor_binaries "$release_dir"
  exec "$SUP_NODE" "$SUP_CLI" --root "$ROOT" update --release "$newid" --drain-timeout "$drain_timeout"
}

delegate_verb() {
  verb=$1; shift
  [ -n "$(current_release)" ] || die runner 97 "no current release; run install first"
  release_dir=$ROOT/releases/$(current_release)
  supervisor_verb "$release_dir" "$verb" "$@"
}

[ $# -ge 1 ] || usage
command=$1
shift
case $command in
  install) cmd_install "$@" ;;
  run) cmd_run "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) delegate_verb status "$@" ;;
  update) cmd_update "$@" ;;
  rollback) delegate_verb rollback "$@" ;;
  gc) delegate_verb gc "$@" ;;
  uninstall) delegate_verb uninstall "$@" ;;
  help|-h|--help) usage ;;
  *) usage ;;
esac
`
}
