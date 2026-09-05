#!/usr/bin/env bash
set -euo pipefail

project="$PWD"
agent="${RENGINE_AGENT:-}"
action="menu"
version="latest"
agent_home="${RENGINE_AGENT_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/rengine/agents}"
extra=()
launcher_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'HELP'
rEngine agent launcher
  agent.sh --project DIR [--agent codex|claude|gemini|opencode|EXECUTABLE]
           [--action menu|list|launch|install|update|check-resume] [--version VERSION] [-- ARGS...]
Install/download uses an isolated npm prefix under RENGINE_AGENT_HOME.
Launch never silently installs or updates an agent. Choose that action explicitly.
Windows: run with Git Bash and native Node/npm; WSL is a separate environment.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--agent|--action|--version)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in --project) project="$2";; --agent) agent="$2";; --action) action="$2";; --version) version="$2";; esac
      shift 2 ;;
    --) shift; extra=("$@"); break ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd -- "$project"
project="$PWD"
case "$action" in menu|list|launch|install|update|check-resume) ;; *) echo "Unknown action: $action" >&2; exit 2;; esac
case "$version" in ''|*[!a-zA-Z0-9._+-]*) echo "Invalid package version." >&2; exit 2;; esac

package_for() {
  case "$1" in
    codex) printf '%s' '@openai/codex' ;;
    claude) printf '%s' '@anthropic-ai/claude-code' ;;
    gemini) printf '%s' '@google/gemini-cli' ;;
    opencode) printf '%s' 'opencode-ai' ;;
    *) echo "No install recipe for '$1'; supply an installed executable to launch it." >&2; return 2 ;;
  esac
}

find_agent() {
  case "$1" in
    codex|claude|gemini|opencode)
      if [ -x "$agent_home/$1/node_modules/.bin/$1" ]; then printf '%s\n' "$agent_home/$1/node_modules/.bin/$1"; return; fi ;;
  esac
  command -v -- "$1" 2>/dev/null
}

list_agents() {
  local item found
  for item in codex claude gemini opencode; do
    found="$(find_agent "$item" || true)"
    printf '%s\t%s\n' "$item" "${found:-not installed}"
  done
}

install_agent() {
  local package executable
  package="$(package_for "$agent")"
  command -v npm >/dev/null || { echo "Install native Node.js/npm before downloading an agent." >&2; return 127; }
  mkdir -p -- "$agent_home"
  printf 'Installing %s@%s from https://registry.npmjs.org into %s\n' "$package" "$version" "$agent_home/$agent"
  npm install --prefix "$agent_home/$agent" --no-audit --no-fund "$package@$version"
  hash -r
  executable="$agent_home/$agent/node_modules/.bin/$agent"
  [ -x "$executable" ] || { echo 'Installer did not produce the expected managed executable.' >&2; return 126; }
  "$executable" --version
  printf 'Installation verified: %s\n' "$executable"
}

update_agent() {
  local executable
  executable="$(find_agent "$agent" || true)"
  [ -n "$executable" ] || { echo "Agent is missing; choose Install first." >&2; return 127; }
  case "$executable" in "$agent_home"/*) install_agent; return;; esac
  printf 'Updating installed agent: %s\n' "$executable"
  case "$agent" in
    codex|claude) "$executable" update ;;
    opencode) "$executable" upgrade ;;
    gemini) install_agent ;;
    *) echo "No update recipe for this custom executable." >&2; return 2 ;;
  esac
}

launch_agent() {
  local executable
  executable="$(find_agent "$agent" || true)"
  [ -n "$executable" ] || { echo "Agent '$agent' is missing; choose Install in the launcher." >&2; return 127; }
  mkdir -p -- "$agent_home"
  printf '%s\n' "$agent" > "$agent_home/preferred-agent"
  printf 'Launching %s in %s\n' "$executable" "$project"
  if [ -n "${RENGINE_WORKSPACE_CONTEXT:-}" ]; then
    exec "${RENGINE_NODE:-node}" "$launcher_dir/../orchestrator/agents/launch.mjs" "$agent" "$executable" "$RENGINE_WORKSPACE_CONTEXT" ${extra[@]+"${extra[@]}"}
  fi
  exec "$executable" ${extra[@]+"${extra[@]}"}
}

if [ "$action" = list ]; then list_agents; exit 0; fi
if [ "$action" = check-resume ]; then
  [ "$agent" = codex ] || { echo 'Resume currently supports Codex.' >&2; exit 2; }
  executable="$(find_agent codex || true)"
  [ -n "$executable" ] || { echo 'Codex is missing; install it explicitly through Manage.' >&2; exit 127; }
  "$executable" resume --help >/dev/null
  "$executable" login status
  exit 0
fi
if [ -z "$agent" ] && [ -f "$agent_home/preferred-agent" ]; then IFS= read -r agent < "$agent_home/preferred-agent" || true; fi
if [ "$action" != menu ]; then
  [ -n "$agent" ] || { echo 'Select --agent or set RENGINE_AGENT.' >&2; exit 2; }
  case "$action" in launch) launch_agent;; install) install_agent;; update) update_agent;; esac
  exit 0
fi

while true; do
  printf '\nrEngine agents — %s\n' "$project"
  list_agents
  printf 'Preferred: %s\nAgent name or executable path (Enter keeps preferred, q quits): ' "${agent:-none}"
  IFS= read -r selected || exit 0
  [ "$selected" != q ] || exit 0
  [ -z "$selected" ] || agent="$selected"
  [ -n "$agent" ] || continue
  printf 'Action: [l]aunch, [i]nstall/download, [u]pdate, [b]ack: '
  IFS= read -r selected || exit 0
  case "$selected" in
    l|'') launch_agent ;;
    i) install_agent ;;
    u) update_agent ;;
    b) continue ;;
    *) echo 'Choose l, i, u or b.' ;;
  esac
done
