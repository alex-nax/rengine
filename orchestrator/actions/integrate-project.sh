#!/usr/bin/env bash
set -euo pipefail
RE_ACTION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RE_ENGINE_ROOT=$(CDPATH= cd -- "$RE_ACTION_DIR/../.." && pwd)
# shellcheck source=lib/wizard.sh
source "$RE_ACTION_DIR/lib/wizard.sh"
RE_TEMPLATES="$RE_ENGINE_ROOT/orchestrator/templates/project"
RE_PROJECT='' RE_NAME='' RE_URL='' RE_PIN='' RE_CONTRACT='' RE_DRY=0 RE_SUBMODULE=1
RE_GAME_TITLE='' RE_GAME_EXE='' RE_GAME_SURFACE=external
RE_NAME_RE='^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'
RE_TITLE_RE='^[A-Za-z0-9][A-Za-z0-9 ._():+-]{0,31}$'
RE_PATH_RE='^[A-Za-z0-9._][A-Za-z0-9._/-]*$'
RE_URL_RE='^[A-Za-z0-9._:/@~%+-]+$'
RE_PIN_RE='^[0-9a-f]{7,40}$'
usage() {
  cat <<'USAGE'
integrate-project.sh --project ABS_DIR --name NAME [options]

Scaffolds a project that is adopting rEngine: pins rEngine as a submodule, installs the
editor.sh launching point, writes .rengine/project.json and copies the declaration test.
Existing files are reported and skipped, never overwritten. Recipe and follow-ups:
docs/runbooks/project-integration.md (spec 077).

  --project ABS_DIR       the consumer checkout (an existing git repository)
  --name NAME             the project name in the declaration and dashboard title
  --rengine-url URL       submodule URL (default: this checkout's origin remote)
  --pin SHA               submodule commit (default: this checkout's HEAD)
  --contract 1|2|3        declaration contract to write (default: 3 with a game, else 2)
  --game-title TITLE      game toolbar label, at most 32 characters (contract 3)
  --game-exe REL          root-relative game executable, e.g. build/my-game (contract 3)
  --game-surface KIND     external (default) or embedded
  --no-submodule          skip the submodule stage (offline scaffolding, existing pin)
  --dry-run               print every command as "+ …" and write nothing
  --help                  this text

The game arguments scaffold ONE record in the declaration's "games" array. Further targets
on the same engine are added by hand from orchestrator/templates/project/project.json, which
carries the multi-record reference; ids must stay unique across the array.

Missing values are prompted only in a human terminal; supplied arguments run unattended.
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--name|--rengine-url|--pin|--contract|--game-title|--game-exe|--game-surface)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --project) RE_PROJECT=$2;; --name) RE_NAME=$2;; --rengine-url) RE_URL=$2;; --pin) RE_PIN=$2;;
        --contract) RE_CONTRACT=$2;; --game-title) RE_GAME_TITLE=$2;; --game-exe) RE_GAME_EXE=$2;;
        --game-surface) RE_GAME_SURFACE=$2;;
      esac
      shift 2;;
    --no-submodule) RE_SUBMODULE=0; shift;;
    --dry-run) RE_DRY=1; shift;;
    --help) usage; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ -n "$RE_PROJECT" ]] || re_ask RE_PROJECT 'Absolute project directory'
[[ -n "$RE_NAME" ]] || re_ask RE_NAME 'Project name'
[[ "$RE_PROJECT" == /* && -d "$RE_PROJECT" ]] || { printf 'Provide an existing absolute project directory\n' >&2; exit 2; }
[[ "$RE_NAME" =~ $RE_NAME_RE ]] || { printf 'Invalid name %s: use letters, digits, space, dot, underscore or dash\n' "$RE_NAME" >&2; exit 2; }
if [[ -n "$RE_GAME_EXE" || -n "$RE_GAME_TITLE" ]]; then
  [[ -n "$RE_CONTRACT" ]] || RE_CONTRACT=3
  [[ "$RE_CONTRACT" == 3 ]] || { printf 'A games array requires --contract 3\n' >&2; exit 2; }
  [[ -n "$RE_GAME_EXE" && -n "$RE_GAME_TITLE" ]] || { printf 'Declare both --game-title and --game-exe\n' >&2; exit 2; }
  [[ "$RE_GAME_TITLE" =~ $RE_TITLE_RE ]] || { printf 'Invalid game title: at most 32 plain characters\n' >&2; exit 2; }
  [[ "$RE_GAME_EXE" =~ $RE_PATH_RE && "$RE_GAME_EXE" != *..* ]] || { printf 'The game executable must be a root-relative path\n' >&2; exit 2; }
  [[ "$RE_GAME_SURFACE" != sdl2-interpose ]] || { printf 'Game surface sdl2-interpose is retired: use embedded, which hosts the frames in the game tab through the cooperative SDL adapter\n' >&2; exit 2; }
  [[ "$RE_GAME_SURFACE" == external || "$RE_GAME_SURFACE" == embedded ]] || { printf 'Game surface must be embedded or external\n' >&2; exit 2; }
fi
[[ -n "$RE_CONTRACT" ]] || RE_CONTRACT=2
[[ "$RE_CONTRACT" == 1 || "$RE_CONTRACT" == 2 || "$RE_CONTRACT" == 3 ]] || { printf 'Contract must be 1, 2 or 3\n' >&2; exit 2; }
if [[ "$RE_SUBMODULE" == 1 ]]; then
  [[ -n "$RE_URL" ]] || RE_URL=$(git -C "$RE_ENGINE_ROOT" remote get-url origin 2>/dev/null || true)
  [[ -n "$RE_URL" ]] || re_ask RE_URL 'rEngine submodule URL'
  [[ -n "$RE_PIN" ]] || RE_PIN=$(git -C "$RE_ENGINE_ROOT" rev-parse HEAD 2>/dev/null || true)
  [[ -n "$RE_PIN" ]] || re_ask RE_PIN 'rEngine pin (full commit SHA present on the remote)'
  [[ "$RE_URL" =~ $RE_URL_RE ]] || { printf 'Invalid rEngine URL\n' >&2; exit 2; }
  [[ "$RE_PIN" =~ $RE_PIN_RE ]] || { printf 'Invalid pin: use a commit SHA\n' >&2; exit 2; }
fi

re_do() {  # label, then the literal command; --dry-run prints it instead of running it
  local re_label=$1; shift
  if [[ "$RE_DRY" == 1 ]]; then printf '+ %s\n' "$*"; return 0; fi
  re_run "$re_label" "$@"
}
re_install() {  # source, root-relative destination, optional mode
  local re_source=$1 re_relative=$2 re_mode=${3:-} re_dest="$RE_PROJECT/$2"
  if [[ -e "$re_dest" ]]; then printf 'exists, skipped: %s\n' "$re_relative" >&2; return 0; fi
  if [[ "$RE_DRY" == 1 ]]; then
    printf '+ cp %s %s\n' "$re_source" "$re_dest"
    [[ -z "$re_mode" ]] || printf '+ chmod %s %s\n' "$re_mode" "$re_dest"
    return 0
  fi
  mkdir -p "$(dirname "$re_dest")"
  cp "$re_source" "$re_dest"
  [[ -z "$re_mode" ]] || chmod "$re_mode" "$re_dest"
  printf 'installed: %s\n' "$re_relative" >&2
}
re_game_id() {
  printf '%s' "$RE_GAME_EXE" | tr 'A-Z' 'a-z' | sed -e 's#.*/##' -e 's#[^a-z0-9]\{1,\}#-#g' -e 's#^-##' -e 's#-$##'
}
re_game_candidates() {
  local re_base=${RE_GAME_EXE#build/}
  printf '"%s"' "$RE_GAME_EXE"
  [[ "$RE_GAME_EXE" == build/* && "$re_base" != */* ]] && printf ', "build/Release/%s"' "$re_base"
  return 0
}
re_declaration() {
  printf '{\n  "contract": %s,\n  "project": "%s",\n' "$RE_CONTRACT" "$RE_NAME"
  printf '  "formats": [\n    {\n      "id": "example-format",\n'
  printf '      "title": "Example format (replace this record)",\n'
  printf '      "match": ["*.example"],\n      "modes": ["raw"],\n      "default": "raw"\n    }\n  ]'
  if [[ "$RE_CONTRACT" == 3 && -n "$RE_GAME_EXE" ]]; then
    printf ',\n  "games": [\n    {\n      "id": "%s",\n      "title": "%s",\n' "$(re_game_id)" "$RE_GAME_TITLE"
    printf '      "executable": [%s],\n      "surface": "%s"\n    }\n  ]' "$(re_game_candidates)" "$RE_GAME_SURFACE"
  fi
  if [[ "$RE_CONTRACT" != 1 ]]; then
    printf ',\n  "dashboard": {\n    "title": "%s",\n    "groups": [\n' "$RE_NAME"
    printf '      {\n        "id": "quick-start",\n        "title": "Quick start",\n        "actions": [\n'
    printf '          {\n            "id": "editor-check",\n'
    printf '            "title": "Editor prerequisites (editor.sh --check)",\n'
    printf '            "description": "Reports the toolchain and build state of the pinned rEngine without changing anything.",\n'
    printf '            "kind": "script",\n            "script": "editor.sh",\n            "args": ["--check"]\n'
    printf '          }\n        ]\n      }\n    ]\n  }'
  fi
  printf '\n}\n'
}
re_write_declaration() {
  local re_relative='.rengine/project.json' re_dest="$RE_PROJECT/.rengine/project.json"
  if [[ -e "$re_dest" ]]; then printf 'exists, skipped: %s\n' "$re_relative" >&2; return 0; fi
  if [[ "$RE_DRY" == 1 ]]; then printf '+ write %s\n' "$re_relative"; return 0; fi
  mkdir -p "$RE_PROJECT/.rengine"
  re_declaration > "$re_dest"
  printf 'installed: %s (contract %s)\n' "$re_relative" "$RE_CONTRACT" >&2
}

trap 'printf "Canceled; the project keeps whatever this run already installed. Re-run to continue.\n" >&2; exit 130' INT
re_wizard "Integrate $RE_NAME with rEngine" 5

re_stage 'Verify the project and the rEngine pin'
git -C "$RE_PROJECT" rev-parse --git-dir >/dev/null 2>&1 || { printf 'Not a git repository: %s\n' "$RE_PROJECT" >&2; exit 2; }
[[ -d "$RE_TEMPLATES" ]] || { printf 'Missing templates: %s\n' "$RE_TEMPLATES" >&2; exit 2; }
printf 'project %s is a git repository\n' "$RE_PROJECT" >&2
if [[ "$RE_SUBMODULE" == 1 ]]; then
  RE_REFS=$(git ls-remote --quiet "$RE_URL" 2>/dev/null) || { printf 'Cannot reach %s\n' "$RE_URL" >&2; exit 2; }
  if printf '%s\n' "$RE_REFS" | grep -q "^$RE_PIN"; then
    printf 'pin %s is advertised by %s\n' "$RE_PIN" "$RE_URL" >&2
  else
    printf 'warning: pin %s is not a current ref tip on %s; the submodule checkout will confirm it\n' "$RE_PIN" "$RE_URL" >&2
  fi
else
  printf 'submodule stage disabled (--no-submodule)\n' >&2
fi

re_stage 'Pin rEngine as a submodule at third_party/rengine'
if [[ "$RE_SUBMODULE" == 0 ]]; then
  printf 'skipped: third_party/rengine (--no-submodule)\n' >&2
elif [[ -e "$RE_PROJECT/third_party/rengine/.git" ]]; then
  printf 'exists, skipped: third_party/rengine (bump the pin from the project instead)\n' >&2
else
  re_do 'Add the submodule' git -C "$RE_PROJECT" submodule add "$RE_URL" third_party/rengine
  re_do 'Check out the pin' git -C "$RE_PROJECT/third_party/rengine" checkout --detach "$RE_PIN"
  re_do 'Record the pinned gitlink' git -C "$RE_PROJECT" add third_party/rengine
fi

re_stage 'Install the editor.sh launching point'
re_install "$RE_TEMPLATES/editor.sh" editor.sh 755

re_stage 'Write the .rengine/project.json declaration'
re_write_declaration

re_stage 'Copy the declaration test'
re_install "$RE_TEMPLATES/test_rengine_project_decl.py" tests/test_rengine_project_decl.py 644

re_finish
cat <<FOLLOWUPS
Follow-ups this wizard deliberately leaves to the project:
  1. Register tests/test_rengine_project_decl.py with the project's own test runner.
  2. Add one line to CLAUDE.md/AGENTS.md naming ./editor.sh as the launching point.
  3. Replace the placeholder format: write the CLI that produces previews and declare it
     in .rengine/project.json with \${file}/\${entry} argv.
  4. Fill the dashboard groups (quick start, device, distribution) with the project's scripts.
  5. Add any further game targets to the "games" array by hand (unique kebab-case ids); the
     multi-record reference is orchestrator/templates/project/project.json.
  6. Run ./editor.sh --check, then ./editor.sh to open the project window.
Recipe: docs/runbooks/project-integration.md
FOLLOWUPS
