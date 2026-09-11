#!/usr/bin/env bash
# Bootstrap an agent CLI's SessionStart hook so its sessions report the conversation they are
# actually running back to the workspace (spec 127). Only kimi needs this: claude's launcher hands
# it per-launch settings with the same hook, and codex/gemini/opencode publish no hook channel
# rEngine can use. This is the one edit rEngine ever offers to make to a person's global agent
# configuration, and only on explicit request: the change is shown, confirmed, backed up, verified
# with kimi doctor, and the backup is restored on any failure. Panes work without it; the hook is
# what heals the record after a session switch inside the CLI.
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"

RE_AGENT='' RE_YES=0 RE_DRY=0
usage() {
  cat <<'USAGE'
bootstrap-agent-hooks.sh --agent kimi [--yes] [--dry-run]

Installs the one hook rEngine offers an agent CLI: kimi's SessionStart hook, which reports the
session the CLI is actually running back to the workspace, so the pane record follows a session
switch made inside the CLI (spec 127). The change is shown, confirmed, backed up and verified
with kimi doctor; on any failure the previous configuration is restored.

  --agent AGENT   the CLI to bootstrap (only kimi is supported; the other CLIs are refused
                  by name with the reason)
  --yes           do not ask for confirmation (a script tab: answer the prompt instead)
  --dry-run       print the exact change and write nothing
  --help          this text

The hook lives in $KIMI_CODE_HOME/config.toml (~/.kimi-code/config.toml) and takes effect for
kimi sessions started afterwards. Removal: restore the printed backup, or delete the marked
block from the config.
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for --agent\n' >&2; exit 2; }; RE_AGENT=$2; shift 2;;
    --yes) RE_YES=1; shift;;
    --dry-run) RE_DRY=1; shift;;
    --help) usage; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ -n "$RE_AGENT" ]] || re_ask RE_AGENT 'Agent to bootstrap (kimi)'
case "$RE_AGENT" in
  kimi) ;;
  claude) printf 'claude needs no bootstrap: the launcher hands it per-launch settings carrying the same hook.\n' >&2; exit 2;;
  *) printf '%s has no hook channel rEngine can use; only kimi is bootstrapped this way.\n' "$RE_AGENT" >&2; exit 2;;
esac
RE_NODE=${RENGINE_NODE:-$(command -v node || true)}
[[ -n "$RE_NODE" && -x "$RE_NODE" ]] || { printf 'Node is required\n' >&2; exit 2; }
RE_REPORTER="$RE_ENGINE_ROOT/orchestrator/agents/report-session.mjs"
[[ -f "$RE_REPORTER" ]] || { printf 'The reporter is missing: %s\n' "$RE_REPORTER" >&2; exit 2; }
case "$RE_NODE$RE_REPORTER" in *"'"*) printf 'Paths containing a single quote cannot be written into a TOML literal string.\n' >&2; exit 2;; esac
RE_HOME=${KIMI_CODE_HOME:-"$HOME/.kimi-code"}
RE_CONFIG="$RE_HOME/config.toml"
RE_MARKER='# rEngine session reporting (spec 127)'
# A TOML literal string keeps Windows backslashes intact; the guard above keeps out the one
# character it cannot hold. Shell quoting inside it keeps paths with spaces working.
RE_HOOK="$RE_MARKER
[[hooks]]
event = \"SessionStart\"
command = '\"$RE_NODE\" \"$RE_REPORTER\" --provider kimi'"

trap 'printf "Bootstrap canceled. Nothing was written.\n" >&2; exit 130' INT
re_wizard 'rEngine agent hook bootstrap (kimi)' 4

re_stage 'Detect the CLI'
command -v kimi >/dev/null || { printf 'kimi is not installed. Install it explicitly first (scripts/agent.sh --agent kimi --action install, or https://www.kimi.com/code).\n' >&2; exit 127; }
kimi --version || true

re_stage 'What changes, and where'
printf 'Config: %s\nThis block is appended; nothing else in the file is touched:\n\n%s\n\n' "$RE_CONFIG" "$RE_HOOK"
if grep -qF "$RE_MARKER" "$RE_CONFIG" 2>/dev/null; then printf 'Already bootstrapped: the rEngine hook block is present. Nothing was written.\n'; exit 0; fi
if [[ $RE_DRY == 1 ]]; then printf 'Dry run: nothing was written.\n'; exit 0; fi

re_stage 'Confirm'
if [[ $RE_YES == 1 ]]; then printf 'Confirmed with --yes.\n'
else
  # A person answering no is a clean exit; a missing terminal is a failed confirmation and stops.
  RE_CONFIRMED=0; re_confirm "Append this hook to $RE_CONFIG?" || RE_CONFIRMED=$?
  case "$RE_CONFIRMED" in
    0) ;;
    1) printf 'Left unchanged. Nothing was written.\n'; exit 0;;
    *) exit "$RE_CONFIRMED";;
  esac
fi

re_stage 'Back up, append, verify with kimi doctor — restoring on any failure'
RE_BACKUP=''
if [[ -f "$RE_CONFIG" ]]; then
  RE_BACKUP="$RE_CONFIG.rengine-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$RE_CONFIG" "$RE_BACKUP"
  printf 'Backup: %s\n' "$RE_BACKUP"
fi
mkdir -p "$RE_HOME"
printf '\n%s\n' "$RE_HOOK" >> "$RE_CONFIG"
if ! kimi doctor config "$RE_CONFIG" >/dev/null 2>&1; then
  printf 'kimi doctor rejected the result; restoring the previous configuration.\n' >&2
  if [[ -n "$RE_BACKUP" ]]; then mv -f "$RE_BACKUP" "$RE_CONFIG"; else rm -f "$RE_CONFIG"; fi
  exit 1
fi
re_finish
printf '\nThe hook reports kimi sessions started from now on. Removal: restore the backup above, or delete the marked block from %s.\n' "$RE_CONFIG"
