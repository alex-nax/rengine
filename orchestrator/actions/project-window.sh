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
RE_NODE=${RENGINE_NODE:-$(command -v node || true)}
[[ -n "$RE_NODE" && -x "$RE_NODE" ]] || { printf 'Node is required; use the project prerequisites\n' >&2; exit 2; }
RE_CLIENT="$RE_ENGINE_ROOT/orchestrator/runtime/client.mjs"
trap 'printf "Canceled; retained sessions remain managed by the workspace. Inspect status before retrying.\n" >&2; exit 130' INT
re_wizard 'Open a project with the current agent' 3
re_stage 'Verify and adopt the original session host'
re_run 'Prepare window management' "$RE_NODE" "$RE_CLIENT" bootstrap --context "$RE_CONTEXT"
re_stage 'Open or reuse the bound project window'
re_run 'Attach the retained agent' "$RE_NODE" "$RE_CLIENT" open --context "$RE_CONTEXT" --project "$RE_PROJECT" --agent "$RE_AGENT_ID"
re_stage 'Inspect retained window identities'
re_run 'List project windows' "$RE_NODE" "$RE_CLIENT" windows --context "$RE_CONTEXT"
re_finish
