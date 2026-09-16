#!/usr/bin/env bash
# Replace this workspace's retained session host, ending its sessions on purpose.
#
# This is the heavier sibling of restart-supervisor.sh. That one replaces the supervisor and its
# desktop windows and leaves the session host alone; this one replaces the HOST, which is what a
# capability the host does not advertise requires — a retained host serves the code it loaded, so a
# feature added since reads as broken rather than as off (KI-116).
#
# It must detach, because the launcher is almost always run from a pane inside the workspace it is
# replacing, and red-launch refuses that by name: a pane inside dies with the host. The detached
# child is orphaned to init, so the host is not one of its ancestors and the refusal does not apply.
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"

RE_STATE=${RENGINE_STATE_DIR:-}
if [[ ${1:-} == --state && $# == 2 ]]; then RE_STATE=$2
elif [[ $# != 0 ]]; then printf 'replace-host.sh [--state DIR]\n' >&2; exit 2; fi
[[ -n "$RE_STATE" ]] || re_ask RE_STATE 'Workspace state directory'
[[ -d "$RE_STATE" ]] || { printf 'State directory is unavailable: %s\n' "$RE_STATE" >&2; exit 2; }
RE_STATE=$(CDPATH= cd -- "$RE_STATE" && pwd)
# The launcher is a binary (spec 145); this action needs no node of its own. It is resolved HERE,
# before the wizard's first stage, so a checkout that has not been built refuses before it has told
# a person what a replacement would cost and asked them to confirm it.
RE_LAUNCH=${RENGINE_RED_LAUNCH:-}
if [[ -z "$RE_LAUNCH" ]]; then
  for RE_PROFILE in release debug; do
    [[ -x "$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch" ]] && { RE_LAUNCH="$RE_ENGINE_ROOT/red/target/$RE_PROFILE/red-launch"; break; }
  done
fi
[[ -n "$RE_LAUNCH" && -x "$RE_LAUNCH" ]] || {
  printf 'red-launch is required and this checkout has none: build it with\n  cargo build --manifest-path red/Cargo.toml --bins\nNothing was signalled.\n' >&2; exit 2; }
RE_PYTHON=${RENGINE_PYTHON:-$(command -v python3 || true)}
[[ -n "$RE_PYTHON" && -x "$RE_PYTHON" ]] || { printf 'python3 is required for the detach\n' >&2; exit 2; }

trap 'printf "Replacement canceled. Nothing was signalled.\n" >&2; exit 130' INT
re_wizard 'rEngine session host replacement' 3

re_stage 'What is running, and what a replacement would cost'
"$RE_PYTHON" - "$RE_STATE" <<'PY'
import json, os, subprocess, sys, urllib.request
state = sys.argv[1]
try:
    d = json.load(open(os.path.join(state, 'sidecar.json')))
except Exception as error:
    print(f'No session host descriptor in {state}: {error}'); raise SystemExit(2)
pid, url, token = d.get('pid'), d.get('url'), d.get('token')
started = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True).stdout.strip()
print(f'Session host PID {pid} at {url}, started {started or "unknown"}.')
try:
    request = urllib.request.Request(f'{url}/api/state', headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(request, timeout=8) as answer:
        state_json = json.load(answer)
except Exception as error:
    print(f'The host did not answer /api/state ({error}); it may already be gone.'); raise SystemExit(0)
sessions = state_json.get('sessions', [])
running = [s for s in sessions if s.get('state') == 'running']
kinds = {}
for s in running:
    kinds[s.get('type')] = kinds.get(s.get('type'), 0) + 1
print(f'It holds {len(sessions)} sessions, {len(running)} of them running: '
      + (', '.join(f'{n} {k}' for k, n in sorted(kinds.items())) or 'none'))
for s in running:
    print(f'    ends: {s.get("type"):9} pid {str(s.get("pid")):7} {str(s.get("title"))[:46]}')
capabilities = state_json.get('capabilities', {})
print(f'It advertises {len(capabilities)} capabilities: ' + (', '.join(sorted(capabilities)) or 'none'))
print('A host advertising fewer than the build declares is serving the code it loaded, not this checkout.')
PY

re_stage 'Confirm'
printf 'Every session above ENDS. Terminals, agent panes and their conversations stop with the host.\n'
printf 'Drafts and the layout live in the store service and are kept; the desktop windows reopen.\n'
printf 'A pane you are reading this in is one of them: the tab closes when the host goes.\n'
re_confirm 'Replace the session host now?' || { printf 'Left running. Nothing was signalled.\n'; exit 0; }

re_stage 'Detach, then replace'
RE_LOG="$RE_STATE/replace-host.log"
RE_MARK="$RE_STATE/replace-host.detached"
rm -f "$RE_MARK"
printf 'replace-host: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$RE_LOG"
# macOS ships no setsid(1), so python's os.setsid is the portable primitive. Double fork: the
# subshell exits at once, its child is orphaned to init, and its own session means the pty closing
# cannot hang it up — which matters because this tab's pty closes when the host it is replacing
# dies. The child writes the mark once it is in its own session and this script waits for that
# before exiting: a script tab closes its pty within milliseconds of exit, sooner than a child can
# call setsid, and a launcher lost exactly there leaves the workspace with no host at all.
RE_CHILD="sleep 2; cd '$RE_ENGINE_ROOT' && '$RE_LAUNCH' --replace-host --state '$RE_STATE'"
( "$RE_PYTHON" -c 'import os, sys; os.setsid(); open(sys.argv[1], "w").write(str(os.getpid())); os.execvp(sys.argv[2], sys.argv[2:])' \
    "$RE_MARK" bash -c "$RE_CHILD" >> "$RE_LOG" 2>&1 < /dev/null & ) &
for _ in $(seq 1 100); do [[ -s "$RE_MARK" ]] && break; sleep 0.05; done
if [[ ! -s "$RE_MARK" ]]; then
  printf 'replace-host: the detached child never reported its session; nothing was signalled. See %s\n' "$RE_LOG" >&2
  exit 1
fi
re_finish
printf '\nThe launcher is detached as PID %s, in its own session; its log is %s\n' "$(cat "$RE_MARK")" "$RE_LOG"
printf 'This pane ends when the host is replaced. The new window opens on the layout the store kept.\n'
