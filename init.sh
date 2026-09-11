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
# protoc builds the red-core contract (spec 128 decision 5). A prerequisite like SDL2, not something
# this repository ships: prost-build shells out to it, and a vendored compiler binary would be a
# compiled third-party artifact with none of the provenance third_party/sources.json records.
# The Android SDK and the pinned NDK build apps/companion (spec 128, decision 10). Reported rather
# than required: unlike cargo, which the desktop build itself now drives, this toolchain is needed
# only to build the companion — gating desktop work on a mobile SDK would be a worse trade than
# saying plainly what is missing and where it matters.
RENGINE_NDK_PIN=$(sed -n 's/.*ndkVersion = "\(.*\)".*/\1/p' apps/companion/app/build.gradle.kts 2>/dev/null)
if [ -n "$RENGINE_NDK_PIN" ]; then
    RENGINE_SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
    if [ ! -d "$RENGINE_SDK" ]; then
        echo "NOTE: no Android SDK at $RENGINE_SDK; apps/companion cannot be built here. Set ANDROID_HOME, or install Android Studio's SDK. Nothing else needs it."
    elif [ ! -d "$RENGINE_SDK/ndk/$RENGINE_NDK_PIN" ]; then
        echo "NOTE: the pinned Android NDK $RENGINE_NDK_PIN is not installed under $RENGINE_SDK/ndk. Install it with: sdkmanager \"ndk;$RENGINE_NDK_PIN\". Only apps/companion needs it."
    fi
fi

command -v protoc >/dev/null 2>&1 || { echo "ERROR: protoc is required to build the red/ contract (charter D57, spec 128). Install it: brew install protobuf, or apt-get install -y protobuf-compiler"; exit 1; }
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
