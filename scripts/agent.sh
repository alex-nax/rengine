#!/usr/bin/env bash
set -euo pipefail

project="$PWD"
agent="${RENGINE_AGENT:-}"
action="menu"
version="latest"
agent_home="${RENGINE_AGENT_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/rengine/agents}"
extra=()
extra_count=0
launcher_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The one table every agent fact comes from (spec 114, charter D46): packages, update modes,
# resume spellings. The registry is JavaScript, so reading it needs the node the launcher itself
# runs on; a shell that cannot offer one is told so rather than shown a stale copy of the table.
REGISTRY="$launcher_dir/../orchestrator/agents/registry.mjs"
re_node="${RENGINE_NODE:-$(command -v node || true)}"
registered_names=""
have_names=0

registry_names() {
  if [ "$have_names" = 0 ]; then
    have_names=1
    if [ -n "$re_node" ]; then
      registered_names="$("$re_node" "$REGISTRY" list --names)" || registered_names=""
    else
      echo "Node.js is required to read the agent registry; listing nothing." >&2
      registered_names=""
    fi
  fi
  printf '%s' "$registered_names"
}

is_registered() {
  registry_names | grep -qx -- "$1"
}

registry_field() {
  [ -n "$re_node" ] || return 127
  "$re_node" "$REGISTRY" show "$1" "$2" 2>/dev/null
}

usage() {
  local names
  names="$(registry_names | tr '\n' '|')"
  names="${names%|}"
  [ -n "$names" ] || names="AGENT"
  cat <<HELP
rEngine agent launcher
  agent.sh --project DIR [--agent $names|EXECUTABLE]
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
    --) shift; extra=("$@"); extra_count="$#"; break ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd -- "$project"
project="$PWD"
case "$action" in menu|list|launch|install|update|check-resume) ;; *) echo "Unknown action: $action" >&2; exit 2;; esac
case "$version" in ''|*[!a-zA-Z0-9._+-]*) echo "Invalid package version." >&2; exit 2;; esac

package_for() {
  local package
  if ! package="$(registry_field "$1" PACKAGE)"; then
    echo "No install recipe for '$1'; supply an installed executable to launch it." >&2
    return 2
  fi
  printf '%s' "$package"
}

find_agent() {
  if is_registered "$1" && [ -x "$agent_home/$1/node_modules/.bin/$1" ]; then
    printf '%s\n' "$agent_home/$1/node_modules/.bin/$1"
    return
  fi
  command -v -- "$1" 2>/dev/null
}

list_agents() {
  local item found
  for item in $(registry_names); do
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
  local executable kind subcommand
  executable="$(find_agent "$agent" || true)"
  [ -n "$executable" ] || { echo "Agent is missing; choose Install first." >&2; return 127; }
  case "$executable" in "$agent_home"/*) install_agent; return;; esac
  printf 'Updating installed agent: %s\n' "$executable"
  kind="$(registry_field "$agent" UPDATE_KIND || true)"
  case "$kind" in
    self)
      subcommand="$(registry_field "$agent" UPDATE_COMMAND)"
      "$executable" $subcommand ;;
    reinstall) install_agent ;;
    *) echo "No update recipe for this custom executable." >&2; return 2 ;;
  esac
}

# Offer the conversations this project already has for the chosen agent, so resuming one is a
# choice in the pane rather than a command the person has to remember. The workspace writes the
# listing (id, agent, when) only when it has something to offer, a restart that already named its
# conversation is never asked, and neither is a launch that carries an initial prompt — only an
# interactive bare launch is. See docs/specs/097-agent-conversation-persistence.md.
choose_conversation() {
  # Only an explicit resume suppresses the offer. A workspace-minted id means "this pane is new",
  # not "this pane has already chosen", so it must still see what it could resume instead.
  if [ "${RENGINE_AGENT_RESUME:-}" = "1" ]; then return 0; fi
  # Nor is a pane launched with an initial prompt (spec 103): it was told what to do, so the question
  # this asks is already answered. See sidecar: only-an-explicit-resume-suppresses-the-offer.
  if [ "$extra_count" -gt 0 ]; then return 0; fi
  [ -n "${RENGINE_AGENT_CONVERSATIONS:-}" ] && [ -s "${RENGINE_AGENT_CONVERSATIONS}" ] || return 0
  local ids=() whens=() id owner when count=0 index choice strip shown
  while IFS=$'\t' read -r id owner when || [ -n "${id:-}" ]; do
    [ -n "${id:-}" ] || continue
    [ "${owner:-}" = "$agent" ] || continue
    ids+=("$id"); whens+=("${when:-earlier}"); count=$((count + 1))
  done < "$RENGINE_AGENT_CONVERSATIONS"
  [ "$count" -gt 0 ] || return 0
  printf '\nConversations for %s in this project:\n' "$agent"
  index=1
  strip="$(registry_field "$agent" STRIP_PREFIX || true)"
  # The first eight characters are the name this conversation goes by everywhere else — the pane
  # title, the identity label, the token segment — so the row leads with them, skipping the prefix
  # the recipe says this CLI's ids carry (kimi's `session_`), which would otherwise be all they said.
  while [ "$index" -le "$count" ]; do
    shown="${ids[index-1]#$strip}"
    printf '  %d) %s %s\t%s\t%s\n' "$index" "$agent" "${shown:0:8}" "${whens[index-1]}" "${ids[index-1]}"
    index=$((index + 1))
  done
  printf 'Resume which? (Enter starts a new conversation): '
  IFS= read -r choice || choice=''
  case "${choice:-}" in ''|*[!0-9]*) printf 'Starting a new conversation.\n'; return 0 ;; esac
  if [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
    printf 'No such choice; starting a new conversation.\n'; return 0
  fi
  export RENGINE_AGENT_CONVERSATION="${ids[choice-1]}"
  export RENGINE_AGENT_RESUME=1
  printf 'Resuming %s\n' "$RENGINE_AGENT_CONVERSATION"
}

launch_agent() {
  local executable
  executable="$(find_agent "$agent" || true)"
  [ -n "$executable" ] || { echo "Agent '$agent' is missing; choose Install in the launcher." >&2; return 127; }
  mkdir -p -- "$agent_home"
  printf '%s\n' "$agent" > "$agent_home/preferred-agent"
  choose_conversation
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
