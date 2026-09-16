#!/usr/bin/env bash
# Arm ONE agent pane so another agent may say one line to it, for a counted number of messages and a
# bounded stretch of time (F222, spec 148). This is the permission the project token deliberately is
# not: the token transfers to a contester on silence, so an agent can hold it without anyone acting,
# and relaying into somebody's conversation needs a person to have said so about a named pane.
#
# The confirmation here has no non-interactive bypass, on purpose: no --yes, and a prompt that
# refuses outright when stdin is not a terminal. Open it as a script tab and answer it.
# Taking it back: --revoke, or let it expire. Stopping a relay that is already armed also works
# through the token and through stop_session, and the keyboard is never gated at all.
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"

RE_STATE=${RENGINE_STATE_DIR:-} RE_SESSION='' RE_MESSAGES='' RE_MINUTES='' RE_REVOKE=0 RE_LIST=0

# `re_confirm` answers 1 for "no" and 2 for "there was nobody to ask", and those are different
# outcomes for a PERMISSION: a person declining is an answer and a non-interactive run is not one.
# Both write nothing; only the second is a failure, so a caller cannot read "nobody was asked" as
# "granted" or as "declined".
re_answered() {
  local re_status=0
  re_confirm "$1" || re_status=$?
  if [[ $re_status -eq 2 ]]; then
    printf 'Nothing was granted or revoked: this needs a person to answer. Open it as a script tab.\n' >&2
    exit 2
  fi
  return $re_status
}
usage() {
  cat <<'USAGE'
grant-session-message.sh [--state DIR] [--session ID] [--messages N] [--minutes M] [--revoke] [--list]

Lets another agent of this project say one line to one named agent pane, for at most N messages
and at most M minutes, whichever runs out first. Nothing is relayable before this is answered.

  --state DIR     the workspace state directory (default: $RENGINE_STATE_DIR)
  --session ID    the pane to arm, as the Sessions list reports it
  --messages N    how many lines may be said to it (1-50)
  --minutes M     how long the grant lasts (1-720)
  --revoke        take the grant back; the pane goes back to refusing
  --list          show what is armed right now and change nothing
  --help          this text

What an armed pane still refuses: a line with a control character in it, a line over 400
characters, a pane that is mid-turn, a pane somebody has typed into in the last minute, and any
caller that does not also hold the project token. Every delivery is one frame on the project feed.
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) [[ $# -ge 2 ]] || { printf 'Missing value for --state\n' >&2; exit 2; }; RE_STATE=$2; shift 2;;
    --session) [[ $# -ge 2 ]] || { printf 'Missing value for --session\n' >&2; exit 2; }; RE_SESSION=$2; shift 2;;
    --messages) [[ $# -ge 2 ]] || { printf 'Missing value for --messages\n' >&2; exit 2; }; RE_MESSAGES=$2; shift 2;;
    --minutes) [[ $# -ge 2 ]] || { printf 'Missing value for --minutes\n' >&2; exit 2; }; RE_MINUTES=$2; shift 2;;
    --revoke) RE_REVOKE=1; shift;;
    --list) RE_LIST=1; shift;;
    --help) usage; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ -n "$RE_STATE" ]] || re_ask RE_STATE 'Workspace state directory'
[[ -d "$RE_STATE" ]] || { printf 'State directory is unavailable: %s\n' "$RE_STATE" >&2; exit 2; }

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

if [[ $RE_LIST == 1 ]]; then
  "$RE_TOOL" message-grant --state "$RE_STATE" --list
  exit 0
fi

trap 'printf "Canceled. Nothing was granted or revoked.\n" >&2; exit 130' INT
re_wizard 'Relay a message to an agent pane' 3

re_stage 'What is armed now'
re_run 'Read the grants' "$RE_TOOL" message-grant --state "$RE_STATE" --list

[[ -n "$RE_SESSION" ]] || re_ask RE_SESSION 'Pane to arm (session id)'
if [[ $RE_REVOKE == 1 ]]; then
  re_stage 'Confirm'
  printf 'The grant for pane %s will be taken back. Nothing may be relayed to it afterwards.\n' "$RE_SESSION"
  re_answered 'Revoke it now?' || { printf 'Left as it was.\n'; exit 0; }
  re_stage 'Revoke'
  re_run 'Revoke' "$RE_TOOL" message-grant --state "$RE_STATE" --session "$RE_SESSION" --revoke
  re_finish
  exit 0
fi

[[ -n "$RE_MESSAGES" ]] || re_ask RE_MESSAGES 'How many messages may be said to it (1-50)'
[[ -n "$RE_MINUTES" ]] || re_ask RE_MINUTES 'For how many minutes (1-720)'

re_stage 'Confirm'
printf 'Another agent of this project, holding the project token, will be able to type one printable\nline into pane %s and have it submitted once the pane echoes it back.\nAt most %s message(s), for at most %s minute(s), whichever runs out first.\nEvery delivery is on the project feed. Revoke with --revoke; your own keyboard is never gated.\n' \
  "$RE_SESSION" "$RE_MESSAGES" "$RE_MINUTES"
re_answered 'Grant it now?' || { printf 'Not granted. The pane still refuses every relay.\n'; exit 0; }

re_stage 'Grant'
re_run 'Grant' "$RE_TOOL" message-grant --state "$RE_STATE" --session "$RE_SESSION" --messages "$RE_MESSAGES" --minutes "$RE_MINUTES"
re_finish
printf '\nThis tab retains the log. Run it again with --list to see what is armed, or --revoke to take it back.\n'
