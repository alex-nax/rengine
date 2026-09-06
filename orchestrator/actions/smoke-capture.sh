#!/usr/bin/env bash
# Capture the desktop's smoke frame as a PNG on stdout for the dashboard's capture action.
# Nothing but the PNG may reach stdout, so the desktop's own output goes to stderr.
set -euo pipefail
RE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$RE_ROOT"
RE_BINARY=${RENGINE_NATIVE_BINARY:-.cache/desktop/bin/rengine}
[[ -x "$RE_BINARY" ]] || { printf 'Build the desktop first (npm run build).\n' >&2; exit 2; }
RE_SHOT=$(mktemp -t rengine-smoke).bmp
trap 'rm -f "$RE_SHOT"' EXIT
"$RE_BINARY" ${1:+--renderer "$1"} --smoke-test --snapshot "$RE_SHOT" >&2
python3 tools/bmp_to_png.py "$RE_SHOT" 2
