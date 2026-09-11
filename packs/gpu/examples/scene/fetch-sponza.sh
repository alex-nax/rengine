#!/usr/bin/env bash
set -euo pipefail
# Fetch Crytek Sponza for the scene example (spec 124).
#
# NOTHING IN THIS REPOSITORY REQUIRES THIS. The scene example renders a procedural scene that is
# committed as code, and that is what every test and comparison uses: it is deterministic, it is
# always present, and it needs no network. `AGENTS.md` forbids hidden downloads and F123's sixth
# criterion says a consumer's build downloads nothing — a gate that depends on an 80 MB fetch is a
# gate that fails on an aeroplane.
#
# This script exists for the other job: rendering a real, large, widely recognised scene by hand,
# for screenshots and for frame-time numbers that mean something next to other renderers' published
# ones. It is run deliberately, by a person, and it writes outside the repository.
#
# The model is Crytek Sponza (Frank Meinl, Crytek), as republished by Morgan McGuire's Computer
# Graphics Archive. Licence: CC BY 3.0 — attribution required if you publish an image of it.
RE_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_URL='https://casual-effects.com/g3d/data10/common/model/crytek_sponza/sponza.zip'
RE_SHA256='da005cbee0be2df2abc8513f3ceb61bcb6f69aac112babcd9c00169a27c2770c'
RE_DEST="${RENGINE_SCENE_ASSETS:-$HOME/assets/sponza}"
RE_FORCE=0 RE_DRY=0

usage() {
  cat <<'USAGE'
fetch-sponza.sh [options]

Downloads Crytek Sponza (~80 MB) for the scene example's optional --scene argument. No build,
test or gate in this repository needs it; the committed procedural scene is what they render.

  --dest DIR     where to unpack (default: $RENGINE_SCENE_ASSETS, else ~/assets/sponza)
  --force        re-download and re-unpack over an existing copy
  --dry-run      print what would happen and fetch nothing
  --help         this text

Afterwards:
  scene --backend vulkan --scene "$DEST/sponza.obj"

Licence: CC BY 3.0. Model by Frank Meinl (Crytek), republished by Morgan McGuire's Computer
Graphics Archive. Attribute both if you publish an image.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) RE_DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --force) RE_FORCE=1; shift ;;
    --dry-run) RE_DRY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "fetch-sponza.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# Refuse to write inside the repository. An 80 MB model in a checkout that two games pin as a
# submodule is everyone's problem, and `git add -A` in a hurry is all it would take.
RE_ROOT=$(CDPATH= cd -- "$RE_SCRIPT_DIR/../../../.." && pwd)
case "$(cd -- "$(dirname -- "$RE_DEST")" 2>/dev/null && pwd || echo "$RE_DEST")/" in
  "$RE_ROOT"/*) echo "fetch-sponza.sh: --dest is inside $RE_ROOT; choose a path outside the repository" >&2; exit 2 ;;
esac

for tool in curl unzip shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "fetch-sponza.sh: $tool is not on PATH" >&2; exit 1; }
done

if [ -f "$RE_DEST/sponza.obj" ] && [ "$RE_FORCE" -eq 0 ]; then
  echo "Sponza is already at $RE_DEST/sponza.obj (use --force to replace it)"
  exit 0
fi

RE_ARCHIVE="$RE_DEST/.sponza.zip"
if [ "$RE_DRY" -eq 1 ]; then
  echo "+ mkdir -p $RE_DEST"
  echo "+ curl -fL --retry 3 -o $RE_ARCHIVE $RE_URL"
  echo "+ shasum -a 256 -c  # expecting $RE_SHA256"
  echo "+ unzip -q -o $RE_ARCHIVE -d $RE_DEST"
  exit 0
fi

mkdir -p "$RE_DEST"
echo "Fetching Crytek Sponza (~80 MB) into $RE_DEST"
curl -fL --retry 3 --progress-bar -o "$RE_ARCHIVE" "$RE_URL"

# The checksum is the point of fetching over HTTPS from a third party: it says you got the bytes
# this script was written against, not whatever the host serves today.
RE_GOT=$(shasum -a 256 "$RE_ARCHIVE" | cut -d' ' -f1)
if [ "$RE_SHA256" = 'REPLACE_ME' ]; then
  echo "fetch-sponza.sh: no checksum recorded; this archive is $RE_GOT" >&2
elif [ "$RE_GOT" != "$RE_SHA256" ]; then
  echo "fetch-sponza.sh: checksum mismatch" >&2
  echo "  expected $RE_SHA256" >&2
  echo "  received $RE_GOT" >&2
  echo "  left at $RE_ARCHIVE; delete it or investigate before using it" >&2
  exit 1
fi

unzip -q -o "$RE_ARCHIVE" -d "$RE_DEST"
rm -f "$RE_ARCHIVE"

# The archive may carry its own top directory; find the model rather than assume the layout.
RE_OBJ=$(find "$RE_DEST" -name '*.obj' -maxdepth 3 | head -1)
[ -n "$RE_OBJ" ] || { echo "fetch-sponza.sh: no .obj found under $RE_DEST after unpacking" >&2; exit 1; }

cat <<EOF

Sponza is at $RE_OBJ
  scene --backend vulkan --scene "$RE_OBJ"

Crytek Sponza by Frank Meinl (Crytek), republished by Morgan McGuire's Computer Graphics Archive.
Licence: CC BY 3.0 — attribute both if you publish an image of it.
EOF
