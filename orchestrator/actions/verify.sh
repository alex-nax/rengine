#!/usr/bin/env bash
# Verification stages the project dashboard offers (contract 2, .rengine/project.json).
# Each stage is the same command a session would run by hand; nothing here is dashboard-only.
set -euo pipefail
RE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$RE_ROOT"
RE_STAGE=${1:-help}
# The desktop is built by the launcher (F163, spec 146), so this gate needs no npm to build.
RE_LAUNCH=${RENGINE_RED_LAUNCH:-}
if [[ -z "$RE_LAUNCH" ]]; then
  for RE_PROFILE in release debug; do
    [[ -x "$RE_ROOT/red/target/$RE_PROFILE/red-launch" ]] && { RE_LAUNCH="$RE_ROOT/red/target/$RE_PROFILE/red-launch"; break; }
  done
fi
[[ -n "$RE_LAUNCH" ]] || RE_LAUNCH="$RE_ROOT/red/target/debug/red-launch"

case "$RE_STAGE" in
  harness)  printf '== harness gate (init.sh)\n\n'; ./init.sh;;
  design)   printf '== design and shader guards\n\n'; python3 tools/design.py check; python3 tools/shaders.py check;;
  build)    printf '== native build\n\n'; "$RE_LAUNCH" build;;
  ctest)    printf '== native unit tests\n\n'; "$RE_LAUNCH" build; ctest --test-dir .cache/desktop --output-on-failure;;
  render)   printf '== renderer comparison across backends\n\n'; "$RE_LAUNCH" build; node --test tests/native-render.spec.mjs;;
  desktop)  printf '== native desktop suite\n\n'; npm run test:desktop;;
  features) printf '== inventory\n\n'; python3 tools/features.py validate; python3 tools/features.py status; python3 tools/features.py next;;
  *) printf 'verify.sh harness|design|build|ctest|render|desktop|features\n' >&2; exit 2;;
esac
printf '\n== %s finished\n' "$RE_STAGE"
