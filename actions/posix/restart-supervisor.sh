#!/usr/bin/env bash
# Restart a workspace's update supervisor, keeping its session host and every retained session.
# The supervisor is the layer a layered update cannot replace, so its own code — the IDE port it
# reserves, the routes it serves — changes only this way. It costs the managed desktop windows.
# For the other layer there is `red-launch --replace-host` (spec 098), which ends sessions on purpose.
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"

RE_STATE=${RENGINE_STATE_DIR:-}
if [[ ${1:-} == --state && $# == 2 ]]; then RE_STATE=$2
elif [[ $# != 0 ]]; then printf 'restart-supervisor.sh [--state DIR]\n' >&2; exit 2; fi
[[ -n "$RE_STATE" ]] || re_ask RE_STATE 'Workspace state directory'
[[ -d "$RE_STATE" ]] || { printf 'State directory is unavailable: %s\n' "$RE_STATE" >&2; exit 2; }
# The launcher is a binary (spec 145): the environment names one, then the checkout's release or
# debug build. A missing one is named with the command that makes it, because this action is read by
# a person deciding whether to restart their own editor.
RE_TOOL=${RENGINE_RED_LAUNCH:-}
if [[ -z "$RE_TOOL" ]]; then
  for RE_PROFILE in release debug; do
    if [[ -x "$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch" ]]; then
      RE_TOOL="$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch"; break
    fi
  done
fi
[[ -n "$RE_TOOL" && -x "$RE_TOOL" ]] || {
  printf 'The red-launch binary is required (run: cargo build -p red-supervisor, or set RENGINE_RED_LAUNCH).\n' >&2; exit 2; }

trap 'printf "Restart canceled. Nothing was signalled.\n" >&2; exit 130' INT
re_wizard 'rEngine update supervisor restart' 3

re_stage 'What is running, and what a restart would cost'
re_run 'Read the workspace' "$RE_TOOL" restart-supervisor --state "$RE_STATE" --plan

re_stage 'Confirm'
printf 'The desktop windows this supervisor manages will close and reopen on the layout the store kept.\nTerminals, agents and drafts live on the session host and are not touched.\n'
re_confirm 'Restart the update supervisor now?' || { printf 'Left running. Nothing was signalled.\n'; exit 0; }

re_stage 'Stop it, then start a detached one from this checkout'
# Detached on purpose: this tab is usually a pane inside the workspace being restarted, and a
# supervisor that stayed a child of it would die with the pane.
re_run 'Restart' "$RE_TOOL" restart-supervisor --state "$RE_STATE"
re_finish
printf '\nRun /ide again in any agent pane to reconnect the editor.\nThis tab retains the log.\n'
