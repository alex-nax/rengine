#!/usr/bin/env bash
# Restart a workspace's update supervisor, keeping its session host and every retained session.
# The supervisor is the layer a layered update cannot replace, so its own code — the IDE port it
# reserves, the routes it serves — changes only this way. It costs the managed desktop windows.
# For the other layer there is `launch.mjs --replace-host` (spec 098), which ends sessions on purpose.
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
RE_NODE=${RENGINE_NODE:-$(command -v node || true)}
[[ -n "$RE_NODE" && -x "$RE_NODE" ]] || { printf 'Node is required\n' >&2; exit 2; }
RE_TOOL="$RE_ENGINE_ROOT/orchestrator/launcher/restart-supervisor.mjs"

trap 'printf "Restart canceled. Nothing was signalled.\n" >&2; exit 130' INT
re_wizard 'rEngine update supervisor restart' 3

re_stage 'What is running, and what a restart would cost'
re_run 'Read the workspace' "$RE_NODE" "$RE_TOOL" --state "$RE_STATE" --plan

re_stage 'Confirm'
printf 'The desktop windows this supervisor manages will close and reopen on the layout the store kept.\nTerminals, agents and drafts live on the session host and are not touched.\n'
re_confirm 'Restart the update supervisor now?' || { printf 'Left running. Nothing was signalled.\n'; exit 0; }

re_stage 'Stop it, then start a detached one from this checkout'
# Detached on purpose: this tab is usually a pane inside the workspace being restarted, and a
# supervisor that stayed a child of it would die with the pane.
re_run 'Restart' "$RE_NODE" "$RE_TOOL" --state "$RE_STATE"
re_finish
printf '\nRun /ide again in any agent pane to reconnect the editor.\nThis tab retains the log.\n'
