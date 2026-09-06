#!/usr/bin/env bash
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"
RE_CONTEXT=${RENGINE_WORKSPACE_CONTEXT:-}
if [[ ${1:-} == --context && $# == 2 ]]; then RE_CONTEXT=$2
elif [[ $# != 0 ]]; then printf 'workspace-status.sh [--context FILE]\n' >&2; exit 2; fi
[[ -n "$RE_CONTEXT" ]] || re_ask RE_CONTEXT 'Existing workspace context file'
[[ -r "$RE_CONTEXT" ]] || { printf 'Context file is unavailable\n' >&2; exit 2; }
RE_NODE=${RENGINE_NODE:-$(command -v node || true)}
[[ -n "$RE_NODE" && -x "$RE_NODE" ]] || { printf 'Node is required\n' >&2; exit 2; }
trap 'printf "Inspection canceled. Sessions remain retained.\n" >&2; exit 130' INT
printf '\nrEngine workspace inspection\nChoose a view; this flow only reads workspace state.\n'
while true; do
  printf '\n1) Project windows\n2) Integration inbox\n3) Update status\n0) Finish\n'
  re_ask RE_CHOICE 'Selection'
  case "$RE_CHOICE" in
    1) RE_QUERY=windows;; 2) RE_QUERY=inbox;; 3) RE_QUERY=status;;
    0) printf 'Inspection finished. This tab retains the log.\n'; exit 0;;
    *) printf 'Choose 0, 1, 2 or 3.\n'; continue;;
  esac
  re_run "Read $RE_QUERY" "$RE_NODE" "$RE_ENGINE_ROOT/orchestrator/runtime/client.mjs" "$RE_QUERY" --context "$RE_CONTEXT"
done
