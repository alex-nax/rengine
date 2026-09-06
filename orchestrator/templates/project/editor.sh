#!/usr/bin/env bash
# editor.sh — bootstrap the pinned rEngine orchestrator (third_party/rengine) and open this
# checkout in it. Copy this file to the project root and keep it there; it is the project's
# launching point. Recipe: rEngine docs/runbooks/project-integration.md (spec 077).
#
# Contract
#   ./editor.sh                    bootstrap what is missing, then exec the launcher on this root
#   ./editor.sh --check            report prerequisites and build state, change nothing (1 if missing)
#   ./editor.sh --dry-run          print every command as "+ …" instead of running it
#   ./editor.sh --bootstrap-only   install and build, do not open the desktop
#   ./editor.sh --rebuild          re-run npm ci and both native builds even if their outputs exist
# Launcher options (--agent, --state, --launch-game, --no-agent, --inspect-ui, -- …) are forwarded.
# Everything installed lands under third_party/rengine/{node_modules,.cache}, which the pinned
# tree's own .gitignore covers, so this checkout stays clean.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RENGINE="$ROOT/third_party/rengine"
MODE=launch
DRY=0
REBUILD=0
LAUNCH_ARGS=()

usage() {
    cat <<'USAGE'
usage: ./editor.sh [mode] [options] [-- extra rEngine launcher args]

Bootstraps the rEngine orchestrator pinned at third_party/rengine (submodule init, npm ci,
surface adapter, native desktop) and opens this checkout as its project.

modes (default: bootstrap then launch)
  --check            report prerequisites and build state; change nothing (exit 1 if missing)
  --bootstrap-only   install dependencies and build, do not launch the desktop

options
  --dry-run          print every command instead of running it (combines with any mode)
  --rebuild          re-run npm ci and both native builds even if their outputs exist
  --agent NAME       codex | claude | gemini | opencode | EXEC (default: saved preference / menu)
  --state DIR        sidecar state directory (default: rEngine's ~/.local/state/rengine)
  --launch-game      also open this project's declared game in a game tab
  --no-agent         open without an agent pane
  -h, --help         this text
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE=check ;;
        --dry-run) DRY=1 ;;
        --bootstrap-only) MODE=bootstrap-only ;;
        --rebuild) REBUILD=1 ;;
        --agent|--state)
            [ $# -ge 2 ] || { echo "editor.sh: $1 needs a value" >&2; exit 2; }
            LAUNCH_ARGS+=("$1" "$2"); shift ;;
        --launch-game|--no-agent|--inspect-ui) LAUNCH_ARGS+=("$1") ;;
        -h|--help) usage; exit 0 ;;
        --) shift; [ $# -eq 0 ] || LAUNCH_ARGS+=("$@"); break ;;
        *) echo "editor.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

log() { printf '[editor] %s\n' "$*" >&2; }
run() {
    if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else log "+ $*"; "$@"; fi
}
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

case "$(uname -s)" in
    Darwin*) PLATFORM=macos; SURFACE_LIB=librengine_surface.dylib; DESKTOP_BIN=.cache/desktop/bin/rengine ;;
    Linux*) PLATFORM=linux; SURFACE_LIB=librengine_surface.so; DESKTOP_BIN=.cache/desktop/bin/rengine ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows; SURFACE_LIB=rengine_surface.dll; DESKTOP_BIN=.cache/desktop/bin/Release/rengine.exe ;;
    *) PLATFORM=unknown; SURFACE_LIB=librengine_surface.so; DESKTOP_BIN=.cache/desktop/bin/rengine ;;
esac

# ---- 1. submodule ----------------------------------------------------------------
if [ ! -f "$RENGINE/package.json" ]; then
    if [ "$MODE" = check ]; then
        log "MISSING third_party/rengine (run: git submodule update --init third_party/rengine)"
    else
        run git -C "$ROOT" submodule update --init third_party/rengine
    fi
fi

# ---- 2. toolchain --------------------------------------------------------------------
SDL_REQUIRED=""
[ -f "$RENGINE/CMakeLists.txt" ] && SDL_REQUIRED="$(sed -nE 's/.*find_package\(SDL2 ([0-9.]+) EXACT.*/\1/p' "$RENGINE/CMakeLists.txt" | head -n1)"
CMAKE_REQUIRED="$( [ -f "$RENGINE/CMakeLists.txt" ] && sed -nE 's/^cmake_minimum_required\(VERSION ([0-9.]+).*/\1/p' "$RENGINE/CMakeLists.txt" | head -n1 || true)"
CMAKE_REQUIRED="${CMAKE_REQUIRED:-3.24}"
NODE_REQUIRED="22.12.0"

BREW_MISSING=()
PROBLEMS=()
check_tool() {  # name, required-version, brew formula
    local name="$1" required="$2" formula="$3" found=""
    if command -v "$name" >/dev/null 2>&1; then
        case "$name" in
            cmake) found="$(cmake --version | sed -nE '1s/.* ([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/p')" ;;
            *) found="present" ;;
        esac
        if [ -n "$required" ] && [ "$found" != present ] && ! version_ge "$found" "$required"; then
            PROBLEMS+=("$name $found is older than the required $required")
        fi
        log "ok      $name ${found}"
    else
        log "MISSING $name"
        BREW_MISSING+=("$formula")
    fi
}
check_tool git "" git
check_tool cmake "$CMAKE_REQUIRED" cmake
command -v cc >/dev/null 2>&1 && log "ok      cc $(command -v cc)" || { log "MISSING C compiler (macOS: xcode-select --install)"; PROBLEMS+=("no C compiler"); }

NODE="${RENGINE_NODE:-$(command -v node 2>/dev/null || true)}"
if [ -n "$NODE" ] && [ -x "$NODE" ]; then
    NODE_VERSION="$("$NODE" -p 'process.versions.node')"
    if version_ge "$NODE_VERSION" "$NODE_REQUIRED"; then log "ok      node $NODE_VERSION ($NODE)"; else PROBLEMS+=("node $NODE_VERSION at $NODE is older than $NODE_REQUIRED (set RENGINE_NODE or install node >= 22.12)"); fi
else
    log "MISSING node (>= $NODE_REQUIRED)"; BREW_MISSING+=(node)
fi

SDL_FOUND="$(pkg-config --modversion sdl2 2>/dev/null || sdl2-config --version 2>/dev/null || true)"
if [ -z "$SDL_FOUND" ]; then
    log "MISSING SDL2 ${SDL_REQUIRED:+(rEngine pins $SDL_REQUIRED exactly)}"; BREW_MISSING+=(sdl2)
elif [ -n "$SDL_REQUIRED" ] && [ "$SDL_FOUND" != "$SDL_REQUIRED" ]; then
    PROBLEMS+=("SDL2 $SDL_FOUND installed but the pinned rEngine requires exactly $SDL_REQUIRED (third_party/rengine/CMakeLists.txt)")
else
    log "ok      SDL2 $SDL_FOUND"
fi

if [ ${#BREW_MISSING[@]} -gt 0 ]; then
    if [ "$MODE" = check ]; then
        PROBLEMS+=("missing: ${BREW_MISSING[*]}")
    elif [ "$PLATFORM" = macos ] && command -v brew >/dev/null 2>&1; then
        run brew install "${BREW_MISSING[@]}"
        NODE="${RENGINE_NODE:-$(command -v node 2>/dev/null || true)}"
    else
        PROBLEMS+=("install first: ${BREW_MISSING[*]} (macOS: brew install ${BREW_MISSING[*]}; Debian: apt install cmake libsdl2-dev nodejs)")
    fi
fi

if [ "$PLATFORM" = windows ]; then
    log "note    rEngine's Windows desktop/game surface is unqualified at the pinned commit; requires Git Bash (RENGINE_BASH)"
fi

if [ "$MODE" = check ]; then
    for step in "node_modules:npm ci" ".cache/native/$SURFACE_LIB:npm run build:surface" "$DESKTOP_BIN:npm run build"; do
        target="${step%%:*}"; cmd="${step#*:}"
        if [ -e "$RENGINE/$target" ]; then log "built   $target"; else log "pending $target ($cmd)"; fi
    done
fi
if [ ${#PROBLEMS[@]} -gt 0 ]; then
    for p in "${PROBLEMS[@]}"; do log "PROBLEM $p"; done
    [ "$DRY" = 1 ] || exit 1
fi
[ "$MODE" = check ] && exit 0

# ---- 3. bootstrap the pinned rEngine ------------------------------------------------
if [ -d "$RENGINE" ]; then
    cd "$RENGINE"
elif [ "$DRY" = 1 ]; then
    printf '+ cd %s\n' "$RENGINE"
else
    log "third_party/rengine is missing; run git submodule update --init third_party/rengine"; exit 1
fi
[ -n "$NODE" ] && [ -x "$NODE" ] && export PATH="$(dirname "$NODE"):$PATH"

if [ "$REBUILD" = 1 ] || [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    run npm ci
fi
if [ "$REBUILD" = 1 ] || [ ! -f ".cache/native/$SURFACE_LIB" ]; then
    run npm run build:surface
fi
if [ "$REBUILD" = 1 ] || [ ! -x "$DESKTOP_BIN" ]; then
    run npm run build
fi
[ "$MODE" = bootstrap-only ] && { log "bootstrap complete; launch with ./editor.sh"; exit 0; }

# ---- 4. launch ----------------------------------------------------------------------
if [ ${#LAUNCH_ARGS[@]} -gt 0 ]; then
    if [ "$DRY" = 1 ]; then printf '+ %s\n' "$NODE orchestrator/launch.mjs --project $ROOT ${LAUNCH_ARGS[*]}"; exit 0; fi
    log "+ $NODE orchestrator/launch.mjs --project $ROOT ${LAUNCH_ARGS[*]}"
    exec "$NODE" orchestrator/launch.mjs --project "$ROOT" "${LAUNCH_ARGS[@]}"
fi
if [ "$DRY" = 1 ]; then printf '+ %s\n' "$NODE orchestrator/launch.mjs --project $ROOT"; exit 0; fi
log "+ $NODE orchestrator/launch.mjs --project $ROOT"
exec "$NODE" orchestrator/launch.mjs --project "$ROOT"
