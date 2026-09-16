#!/usr/bin/env python3
"""The dashboard actions an externally-integrated project gets (spec 085, spec 146).

Copied into a project's PROFILE by `red-project install-external`, and run from the project's own
directory by the declaration's commands. It is deliberately small and deliberately dull: read a
file, print it, or hand a subprocess the argv it was going to get anyway.

It used to be JavaScript, on the reasoning that a helper which reads `package.json` and runs `pnpm`
is a helper about the Node ecosystem. That was mistaking the subject for the requirement — reading
`package.json` is reading JSON, and running `pnpm` is running a subprocess. Neither wants the Node
runtime, and this repository's tooling is already Python (standard library only), so this is Python.
With it, no JavaScript ships from this repository at all.

Actions:
  json FILE   pretty-print a JSON file
  status      the project directory and its short git status
  scripts     the package manager it declares, and every script it declares
  <script>    run one of the declared scripts through pnpm
"""
import json
import os
import subprocess
import sys

# The scripts a dashboard control may run. A closed list, because the declaration offers exactly
# these as buttons and an open one would make any package.json entry a thing this profile runs.
SCRIPTS = ("dev", "lint", "typecheck", "test", "build", "docs:dev")


def manifest():
    with open("package.json", encoding="utf-8") as handle:
        return json.load(handle)


def run(command, args):
    """Hand the child this terminal, and carry its exit code back out.

    `stdio: inherit` in the original: the dashboard shows a log session, and what it shows is the
    child's own output rather than something re-printed around it.

    Flushed FIRST, and that is not a detail: stdout here is a pipe, so Python block-buffers it while
    the child writes straight to the same descriptor. Without this the "Project: …" line a person
    reads as a header lands after the output it is heading.
    """
    sys.stdout.flush()
    try:
        return subprocess.call([command, *args])
    except FileNotFoundError:
        print(f"{command} is not installed or not on PATH.", file=sys.stderr)
        return 1


def main(argv):
    action = argv[0] if argv else None
    if action == "json":
        if len(argv) < 2:
            raise ValueError("JSON preview requires a file.")
        with open(argv[1], encoding="utf-8") as handle:
            print(json.dumps(json.load(handle), indent=2))
        return 0
    if action == "status":
        print(f"Project: {os.getcwd()}")
        return run("git", ["--no-optional-locks", "status", "--short", "--branch"])
    if action == "scripts":
        data = manifest()
        print(f"{data.get('name') or 'Project'} — {data.get('packageManager') or 'package manager not declared'}")
        for name, command in (data.get("scripts") or {}).items():
            print(f"{name}\n  {command}")
        return 0
    if action in SCRIPTS:
        data = manifest()
        if not (data.get("scripts") or {}).get(action):
            raise ValueError(f"package.json does not declare {action}.")
        print(f"Project: {os.getcwd()}\nRunning: pnpm run {action}")
        return run("pnpm", ["run", action])
    raise ValueError(f"Unknown external action: {action or '(missing)'}")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # noqa: BLE001 — every failure here is a sentence for a person
        print(str(error) or error.__class__.__name__, file=sys.stderr)
        sys.exit(1)
