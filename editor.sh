#!/usr/bin/env bash
# editor.sh — open THIS checkout's own workspace in the editor, without npm (F163, spec 145).
#
# The project's own front door. `templates/project/editor.sh` is the one a GAME project
# copies to its root, which bootstraps a pinned rEngine under `third_party/rengine` and opens itself
# as that rEngine's project; this one opens rEngine in rEngine and bootstraps nothing it does not
# build from source here.
#
# Contract
#   ./editor.sh                  build what is missing, then open this checkout's workspace
#   ./editor.sh --resume         the same, resuming the paused conversation .cache/handoff names
#   ./editor.sh --check          report prerequisites and build state, change nothing (1 if missing)
#   ./editor.sh --dry-run        print every command as "+ …" instead of running it
#   ./editor.sh --bootstrap-only build, do not open the window
#   ./editor.sh --rebuild        rebuild the Rust binaries and the native desktop from scratch
#   ./editor.sh --print-state    print the state directory this checkout uses, then exit
# Launcher options (--agent, --state, --handoff, --launch-game, --no-agent, --headless,
# --inspect-ui, --replace-host, -- …) are forwarded to red-launch unchanged.
#
# npm is not on this path. `cargo` builds the launcher, the launcher builds the desktop through
# cmake, and `node` is still required only because the desktop execs `actions/pane/posix/agent.sh` and the MCP
# facade — the last coupling F163 removes, which is why it is named in the prerequisite report
# rather than assumed.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# This checkout's own workspace. It is a path in the repository rather than under
# $XDG_STATE_HOME because rEngine is developed in the workspace it builds: the state a session is
# resumed from, the handoff manifest and the build output live together, and a person reading a
# failure should find all three without being told where the machine put them.
STATE_DIR="$ROOT/.cache/orchestrator-development"
HANDOFF_DEFAULT="$ROOT/.cache/handoff/current.json"

MODE=launch
DRY=0
REBUILD=0
PRINT_STATE=0
STATE_GIVEN=0
LAUNCH_ARGS=()

usage() {
    cat <<'USAGE'
usage: ./editor.sh [mode] [options] [-- extra red-launch args]

Builds this checkout (cargo, then the native desktop through cmake) and opens it as its own
workspace. No npm, and no network fetch beyond what cargo and cmake already pin.

modes (default: build then launch)
  --check            report prerequisites and build state; change nothing (exit 1 if missing)
  --bootstrap-only   build, do not open the window

options
  --resume           resume the paused conversation named by .cache/handoff/current.json
  --dry-run          print every command instead of running it (combines with any mode)
  --rebuild          rebuild the Rust binaries and the native desktop even if their outputs exist
  --print-state      print the workspace state directory, then exit
  -h, --help         this text

forwarded to red-launch
  --agent NAME       which CLI opens in the agent pane (default: saved preference / menu)
  --handoff FILE     resume the conversation this manifest names
  --state DIR        a different workspace state directory
  --no-agent         open with no agent pane
  --launch-game      also open this project's declared game
  --headless         run the session host alone: no desktop, no agent, no C toolchain needed
  --inspect-ui       enable the desktop's stdin automation channel
  --replace-host     stop this state directory's retained host first, ENDING its sessions
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE=check ;;
        --bootstrap-only) MODE=bootstrap-only ;;
        --dry-run) DRY=1 ;;
        --rebuild) REBUILD=1 ;;
        --print-state) PRINT_STATE=1 ;;
        --resume) LAUNCH_ARGS+=(--handoff "$HANDOFF_DEFAULT") ;;
        --state)
            [ $# -ge 2 ] || { echo "editor.sh: --state needs a value" >&2; exit 2; }
            STATE_DIR="$2"; STATE_GIVEN=1; shift ;;
        --agent|--handoff|--declaration|--project)
            [ $# -ge 2 ] || { echo "editor.sh: $1 needs a value" >&2; exit 2; }
            LAUNCH_ARGS+=("$1" "$2"); shift ;;
        --no-agent|--launch-game|--headless|--inspect-ui|--replace-host) LAUNCH_ARGS+=("$1") ;;
        -h|--help) usage; exit 0 ;;
        --) shift; [ $# -eq 0 ] || LAUNCH_ARGS+=("$@"); break ;;
        *) echo "editor.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

[ "$PRINT_STATE" = 1 ] && { printf '%s\n' "$STATE_DIR"; exit 0; }

log() { printf '[editor] %s\n' "$*" >&2; }
run() {
    if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else log "+ $*"; "$@"; fi
}
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

case "$(uname -s)" in
    Darwin*) DESKTOP_BIN="$ROOT/.cache/desktop/bin/rengine" ;;
    MINGW*|MSYS*|CYGWIN*) DESKTOP_BIN="$ROOT/.cache/desktop/bin/Release/rengine.exe" ;;
    *) DESKTOP_BIN="$ROOT/.cache/desktop/bin/rengine" ;;
esac

# ---- 1. prerequisites ----------------------------------------------------------------------
# Read from the files that declare them, so this report cannot drift from what the build enforces.
SDL_REQUIRED="$(sed -nE 's/.*find_package\(SDL2 ([0-9.]+) EXACT.*/\1/p' "$ROOT/CMakeLists.txt" | head -n1)"
CMAKE_REQUIRED="$(sed -nE 's/^cmake_minimum_required\(VERSION ([0-9.]+).*/\1/p' "$ROOT/CMakeLists.txt" | head -n1)"
CMAKE_REQUIRED="${CMAKE_REQUIRED:-3.24}"
RUST_REQUIRED="$(sed -nE 's/^channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/rust-toolchain.toml" | head -n1)"
NODE_REQUIRED="$(sed -nE 's/.*"node"[[:space:]]*:[[:space:]]*">=([0-9.]+)".*/\1/p' "$ROOT/package.json" | head -n1)"
NODE_REQUIRED="${NODE_REQUIRED:-22.12.0}"

PROBLEMS=()
BREW_MISSING=()

if command -v cargo >/dev/null 2>&1; then
    log "ok      cargo $(cargo --version 2>/dev/null | awk '{print $2}') (toolchain pinned at $RUST_REQUIRED)"
else
    log "MISSING cargo (install rustup: https://rustup.rs); rust-toolchain.toml pins $RUST_REQUIRED"
    PROBLEMS+=("no cargo")
fi

if command -v cmake >/dev/null 2>&1; then
    CMAKE_FOUND="$(cmake --version | sed -nE '1s/.* ([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/p')"
    version_ge "$CMAKE_FOUND" "$CMAKE_REQUIRED" || PROBLEMS+=("cmake $CMAKE_FOUND is older than the required $CMAKE_REQUIRED")
    log "ok      cmake $CMAKE_FOUND"
else
    log "MISSING cmake"; BREW_MISSING+=(cmake)
fi

command -v cc >/dev/null 2>&1 && log "ok      cc $(command -v cc)" \
    || { log "MISSING C compiler (macOS: xcode-select --install)"; PROBLEMS+=("no C compiler"); }

SDL_FOUND="$(pkg-config --modversion sdl2 2>/dev/null || sdl2-config --version 2>/dev/null || true)"
if [ -z "$SDL_FOUND" ]; then
    log "MISSING SDL2 ${SDL_REQUIRED:+(pinned at $SDL_REQUIRED exactly)}"; BREW_MISSING+=(sdl2)
elif [ -n "$SDL_REQUIRED" ] && [ "$SDL_FOUND" != "$SDL_REQUIRED" ]; then
    PROBLEMS+=("SDL2 $SDL_FOUND is installed but CMakeLists.txt requires exactly $SDL_REQUIRED")
else
    log "ok      SDL2 $SDL_FOUND"
fi

# node is NOT the launcher's any more; it is what the desktop execs for actions/pane/posix/agent.sh and the MCP
# facade. F163 removes this line, and until it does, a missing node is a broken agent pane rather
# than a broken launch — so it is reported and does not stop anything.
# A bare RENGINE_NODE is a NAME, not a path: a host older than this checkout exports the word
# `node`, and `[ -x node ]` says no on a machine that has one. Resolve it as a shell would.
NODE="${RENGINE_NODE:-node}"
case "$NODE" in */*) ;; *) NODE="$(command -v "$NODE" 2>/dev/null || true)" ;; esac
if [ -n "$NODE" ] && [ -x "$NODE" ]; then
    NODE_VERSION="$("$NODE" -p 'process.versions.node' 2>/dev/null || echo 0)"
    if version_ge "$NODE_VERSION" "$NODE_REQUIRED"; then
        log "ok      node $NODE_VERSION ($NODE) — still execed by the desktop for agent panes (F163)"
    else
        log "warn    node $NODE_VERSION at $NODE is older than $NODE_REQUIRED; agent panes may fail"
    fi
else
    log "warn    no node on PATH; the workspace opens, but agent panes and the MCP facade will not"
fi

if [ ${#BREW_MISSING[@]} -gt 0 ]; then
    PROBLEMS+=("install first: ${BREW_MISSING[*]} (macOS: brew install ${BREW_MISSING[*]}; Debian: apt install cmake libsdl2-dev)")
fi

if [ "$MODE" = check ]; then
    log "state   $STATE_DIR"
    for step in "red/target/debug/red-launch:cargo build --manifest-path red/Cargo.toml --bins" "${DESKTOP_BIN#"$ROOT/"}:./editor.sh --bootstrap-only"; do
        target="${step%%:*}"; cmd="${step#*:}"
        if [ -e "$ROOT/$target" ]; then log "built   $target"; else log "pending $target ($cmd)"; fi
    done
    if [ -f "$STATE_DIR/sidecar.json" ]; then
        log "host    $STATE_DIR/sidecar.json names PID $(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$STATE_DIR/sidecar.json")"
    else
        log "host    none retained; one will be started"
    fi
fi

if [ ${#PROBLEMS[@]} -gt 0 ]; then
    for problem in "${PROBLEMS[@]}"; do log "PROBLEM $problem"; done
    [ "$DRY" = 1 ] || exit 1
fi
[ "$MODE" = check ] && exit 0

# ---- 2. build ------------------------------------------------------------------------------
# The Rust binaries are rebuilt on EVERY launch, not only when they are missing (KI-112). Nothing
# else in the launch path rebuilds them: the launcher resolves the host, the store, the PTY service
# and the agent registry out of red/target, and a binary one commit old is a committed fix that
# silently is not there — which reads as broken rather than as absent.
LAUNCH="${RENGINE_RED_LAUNCH:-}"
if [ "$REBUILD" = 1 ]; then
    run cargo clean --manifest-path "$ROOT/red/Cargo.toml"
    run rm -rf "$ROOT/.cache/desktop"
fi
if [ -z "$LAUNCH" ]; then
    run cargo build --manifest-path "$ROOT/red/Cargo.toml" --bins
    for profile in release debug; do
        [ -x "$ROOT/red/target/$profile/red-launch" ] && { LAUNCH="$ROOT/red/target/$profile/red-launch"; break; }
    done
fi
[ -n "$LAUNCH" ] || LAUNCH="$ROOT/red/target/debug/red-launch"

if [ "$MODE" = bootstrap-only ]; then
    run "$LAUNCH" build
    log "bootstrap complete; open the workspace with ./editor.sh"
    exit 0
fi

# ---- 3. launch -----------------------------------------------------------------------------
# The identity variables an agent CLI stamps on its children, read from the registry that declares
# them — this script names no CLI, and a CLI added as data is scrubbed the day it is declared.
# A shell running inside an agent session carries them, so a host started from here would inherit
# them and every pane it spawns would become a CHILD session of this one, saving no transcript
# (KI-113). The host scrubs them downstream too; it is cleaner never to have handed them over.
SCRUB=()
while IFS= read -r name; do
    [ -n "$name" ] && SCRUB+=(-u "$name")
done < <(awk '
    /^\[recipes\.[^]]*\.identity\]/ { grab = 1; next }
    /^\[/ { grab = 0 }
    grab && /^vars[[:space:]]*=/ {
        line = $0
        while (match(line, /"[^"]+"/)) {
            print substr(line, RSTART + 1, RLENGTH - 2)
            line = substr(line, RSTART + RLENGTH)
        }
    }' "$ROOT/agents/registry.toml")

ARGS=(--project "$ROOT" --state "$STATE_DIR")
[ ${#LAUNCH_ARGS[@]} -gt 0 ] && ARGS+=("${LAUNCH_ARGS[@]}")
[ "$STATE_GIVEN" = 1 ] && log "state   $STATE_DIR (given)"

if [ "$DRY" = 1 ]; then
    printf '+ env %s %s %s\n' "${SCRUB[*]}" "$LAUNCH" "${ARGS[*]}"
    exit 0
fi
log "+ $LAUNCH ${ARGS[*]}"
# exec, in a normal process context: the desktop is a GUI process and a launcher detached from the
# session (nohup, setsid) opens no window and exits 0 having drawn nothing.
exec env "${SCRUB[@]}" "$LAUNCH" "${ARGS[@]}"
