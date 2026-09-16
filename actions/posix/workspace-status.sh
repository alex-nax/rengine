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
  re_run "Read $RE_QUERY" "$RE_CLIENT" client "$RE_QUERY" --context "$RE_CONTEXT"
done
