#!/usr/bin/env bash
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"
RE_CONTEXT=${RENGINE_WORKSPACE_CONTEXT:-} RE_PROJECT='' RE_AGENT_ID=${RENGINE_ORCHESTRATOR_SESSION:-}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context|--project|--agent)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in --context) RE_CONTEXT=$2;; --project) RE_PROJECT=$2;; --agent) RE_AGENT_ID=$2;; esac
      shift 2;;
    --help) printf 'project-window.sh --context FILE --project ABSOLUTE_DIR --agent RETAINED_AGENT_ID\nMissing values are prompted only in a human terminal. Opens a view, never a new CLI.\n'; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ -n "$RE_CONTEXT" ]] || re_ask RE_CONTEXT 'Existing workspace context file'
[[ -n "$RE_PROJECT" ]] || re_ask RE_PROJECT 'Absolute integration project directory'
[[ -n "$RE_AGENT_ID" ]] || re_ask RE_AGENT_ID 'Current retained agent session ID'
[[ -r "$RE_CONTEXT" && -d "$RE_PROJECT" ]] || { printf 'Context file or project directory is unavailable\n' >&2; exit 2; }
# The client is a binary (F163, spec 146): this action needs no node, which is also what closes
# KI-125's second half — `command -v node` found nothing inside the bash this action runs in, so a
# dashboard action refused with "Node is required" on a machine that has node.
RE_CLIENT=${RENGINE_RED_LAUNCH:-}
if [[ -z "$RE_CLIENT" ]]; then
  for RE_PROFILE in release debug; do
    [[ -x "$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch" ]] && { RE_CLIENT="$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch"; break; }
  done
fi
[[ -n "$RE_CLIENT" && -x "$RE_CLIENT" ]] || {
  printf 'red-launch is required and this checkout has none: build it with\n  cargo build --manifest-path red/Cargo.toml --bins\n' >&2; exit 2; }
trap 'printf "Canceled; retained sessions remain managed by the workspace. Inspect status before retrying.\n" >&2; exit 130' INT
re_wizard 'Open a project with the current agent' 3
re_stage 'Verify and adopt the original session host'
re_run 'Prepare window management' "$RE_CLIENT" client bootstrap --context "$RE_CONTEXT"
re_stage 'Open or reuse the bound project window'
re_run 'Attach the retained agent' "$RE_CLIENT" client open --context "$RE_CONTEXT" --project "$RE_PROJECT" --agent "$RE_AGENT_ID"
re_stage 'Inspect retained window identities'
re_run 'List project windows' "$RE_CLIENT" client windows --context "$RE_CONTEXT"
re_finish
