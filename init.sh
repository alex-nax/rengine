#!/bin/bash
set -euo pipefail

RENGINE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$RENGINE_ROOT"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3.9+ is required."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: Git is required."; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "ERROR: Python 3.9+ is required.")'

# The red/ workspace (charter D57, spec 128): cargo must exist and the pinned toolchain must be
# installed. init.sh instructs; nothing is installed silently.
command -v cargo >/dev/null 2>&1 || { echo "ERROR: Rust (cargo) is required for the red/ workspace (charter D57, spec 128). Install rustup from https://rustup.rs, then run: rustup toolchain install $(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"; exit 1; }
RENGINE_RUST_PIN="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
if [ -n "$RENGINE_RUST_PIN" ] && command -v rustup >/dev/null 2>&1; then
    rustup toolchain list | grep -q "^${RENGINE_RUST_PIN}" || { echo "ERROR: the pinned Rust toolchain ${RENGINE_RUST_PIN} is not installed. Run: rustup toolchain install ${RENGINE_RUST_PIN}"; exit 1; }
fi

python3 tools/features.py validate
python3 tools/shaders.py check
python3 tools/seam_prefix.py check
python3 tools/features.py status

if [ -d .git ] || [ -f .git ]; then
    git diff --check
    git diff --cached --check
fi

echo "Local rEngine harness checks passed. See docs/specs/000-charter.md for review status."
