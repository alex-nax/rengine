#!/bin/bash
set -euo pipefail

RENGINE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$RENGINE_ROOT"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3.9+ is required."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: Git is required."; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "ERROR: Python 3.9+ is required.")'

python3 tools/features.py validate
python3 tools/shaders.py check
python3 tools/seam_prefix.py check
python3 tools/features.py status

if [ -d .git ] || [ -f .git ]; then
    git diff --check
    git diff --cached --check
fi

echo "Local rEngine harness checks passed. See docs/specs/000-charter.md for review status."
