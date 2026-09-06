#!/usr/bin/env python3
"""The project's rEngine declaration (.rengine/project.json).

Three tiers, none of which needs a network or a running orchestrator:

* Structure — always runs. Contract 1 (formats) and contract 2 (game, dashboard) rules.
* PinnedContract — validates the declaration with rEngine's own schema and reader from
  third_party/rengine; skips until the pin carries a contract this declaration uses.
* Behaviour — executes the declared format commands exactly as rEngine does (argv,
  placeholders substituted, cwd = root, no shell); skips per case when the declared
  executable is not built or no file in the root matches the format.

Copied from rEngine orchestrator/templates/project/; recipe: rEngine
docs/runbooks/project-integration.md. Run standalone or from the project's test runner:

    python3 tests/test_rengine_project_decl.py [--root DIR] [--rengine DIR]
"""
import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECL = os.path.join(ROOT, ".rengine", "project.json")
RENGINE = os.path.join(ROOT, "third_party", "rengine")
SCHEMA_REL = os.path.join("contracts", "project-v1.schema.json")
VALIDATOR_REL = os.path.join("orchestrator", "server", "schema.mjs")
FORMATS_REL = os.path.join("orchestrator", "server", "formats.mjs")
PLACEHOLDER = re.compile(r"\$\{(\w+)\}")
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
UPPER_SNAKE = re.compile(r"^[A-Z][A-Z0-9_]*$")
KNOWN_PLACEHOLDERS = {"file", "entry"}
MODES = {"raw", "preview", "text"}
PREVIEW_KINDS = {"tree", "text"}
ACTION_KINDS = {"script", "log", "capture"}
SURFACES = {"external", "sdl2-interpose"}
SKIP_DIRS = {".git", "node_modules", "third_party", ".cache", "build", "dist"}


def load():
    with open(DECL, encoding="utf-8") as handle:
        return json.load(handle)


def substitute(command, **values):
    return [PLACEHOLDER.sub(lambda match: values[match.group(1)], argument) for argument in command]


def executable(command):
    return command[0] if os.path.isabs(command[0]) else os.path.join(ROOT, command[0])


def run_declared(spec, **values):
    argv = substitute(spec["command"], **values)
    argv[0] = executable(argv)
    started = time.monotonic()
    result = subprocess.run(argv, cwd=ROOT, capture_output=True,
                            timeout=spec.get("timeoutMs", 10000) / 1000.0)
    return result, (time.monotonic() - started) * 1000.0


def relative_inside_root(path):
    return bool(path) and not os.path.isabs(path) and ".." not in path.replace("\\", "/").split("/")


def actions(decl):
    for group in decl.get("dashboard", {}).get("groups", []):
        for action in group.get("actions", []):
            yield group, action


class Structure(unittest.TestCase):
    def setUp(self):
        self.decl = load()

    def test_header(self):
        self.assertIn(self.decl["contract"], (1, 2))
        self.assertTrue(self.decl["project"].strip())
        self.assertIsInstance(self.decl["formats"], list)
        if "dashboard" in self.decl or "game" in self.decl:
            self.assertEqual(self.decl["contract"], 2, "game and dashboard need contract 2")

    def test_format_records(self):
        ids = [fmt["id"] for fmt in self.decl["formats"]]
        self.assertEqual(len(ids), len(set(ids)))
        for fmt in self.decl["formats"]:
            self.assertRegex(fmt["id"], KEBAB)
            self.assertTrue(fmt["title"].strip())
            self.assertTrue(fmt["match"] and all(isinstance(m, str) and m for m in fmt["match"]))
            self.assertTrue(set(fmt["modes"]) <= MODES, fmt["modes"])
            self.assertIn(fmt["default"], fmt["modes"])
            if "preview" in fmt["modes"]:
                self.assertIn("preview", fmt, f"{fmt['id']}: preview mode needs a preview command")
                self.assertIn(fmt["preview"]["kind"], PREVIEW_KINDS)
            for key in ("preview", "entry"):
                if key in fmt:
                    self.check_command(fmt[key], key, fmt["id"])

    def check_command(self, spec, key, ident):
        command = spec["command"]
        self.assertIsInstance(command, list)
        self.assertTrue(command and all(isinstance(a, str) and a for a in command), command)
        used = {name for argument in command for name in PLACEHOLDER.findall(argument)}
        self.assertTrue(used <= KNOWN_PLACEHOLDERS, f"{ident}.{key}: unknown placeholders {used}")
        self.assertIn("file", used, f"{ident}.{key} command must name ${{file}}")
        if key == "entry":
            self.assertIn("entry", used, f"{ident}.entry command must name ${{entry}}")
        self.assertFalse(any(ch in command[0] for ch in "|;&$`"), command[0])
        for bound in ("timeoutMs", "maxBytes"):
            if bound in spec:
                self.assertIsInstance(spec[bound], int)
                self.assertGreater(spec[bound], 0)

    def test_game_record(self):
        game = self.decl.get("game")
        if game is None:
            self.skipTest("no game declared")
        self.assertRegex(game["id"], KEBAB)
        self.assertTrue(game["title"].strip())
        self.assertLessEqual(len(game["title"]), 32, "the toolbar button label is bounded")
        self.assertTrue(game["executable"], "declare at least one candidate executable")
        for candidate in game["executable"]:
            self.assertTrue(relative_inside_root(candidate), candidate)
        self.assertIn(game["surface"], SURFACES)
        for argument in game.get("args", []):
            self.assertIsInstance(argument, str)
        for key, value in game.get("env", {}).items():
            self.assertRegex(key, UPPER_SNAKE)
            self.assertIsInstance(value, str)
        for required in game.get("requires", []):
            self.assertTrue(relative_inside_root(required), required)

    def test_dashboard_records(self):
        dashboard = self.decl.get("dashboard")
        if dashboard is None:
            self.skipTest("no dashboard declared")
        self.assertTrue(dashboard["title"].strip())
        self.assertTrue(dashboard["groups"])
        group_ids, action_ids = set(), set()
        for group, action in actions(self.decl):
            self.assertRegex(group["id"], KEBAB)
            self.assertTrue(group["title"].strip())
            group_ids.add(group["id"])
            self.assertRegex(action["id"], KEBAB)
            self.assertNotIn(action["id"], action_ids, "action ids are unique across the dashboard")
            action_ids.add(action["id"])
            self.assertTrue(action["title"].strip())
            self.assertIn(action["kind"], ACTION_KINDS)
            for key in ("requires", "artifacts"):
                for path in action.get(key, []):
                    self.assertTrue(relative_inside_root(path), f"{action['id']}.{key}: {path}")
            for tool in action.get("tools", []):
                self.assertNotIn("/", tool, "tools are bare executable names on PATH")
            if action["kind"] == "script":
                self.assertNotIn("command", action, f"{action['id']}: script actions carry no command")
                self.assertTrue(relative_inside_root(action["script"]), action["script"])
                self.assertTrue(action["script"].endswith(".sh"), action["script"])
                for argument in action.get("args", []):
                    self.assertIsInstance(argument, str)
                for key, value in action.get("env", {}).items():
                    self.assertRegex(key, UPPER_SNAKE)
                    self.assertIsInstance(value, str)
            else:
                self.assertNotIn("script", action, f"{action['id']}: only script actions carry a script")
                self.assertTrue(action["command"] and all(isinstance(a, str) and a for a in action["command"]))
                self.assertFalse(any(ch in action["command"][0] for ch in "|;&$`"), action["command"][0])
            if action["kind"] == "capture":
                self.assertTrue(relative_inside_root(action["into"]), action["into"])
                self.assertEqual(action.get("format", "png"), "png")
        self.assertEqual(len(group_ids), len(dashboard["groups"]), "group ids are unique")

    def test_dashboard_scripts_exist_and_parse(self):
        scripts = [action["script"] for _, action in actions(self.decl) if action["kind"] == "script"]
        if not scripts:
            self.skipTest("no script actions declared")
        bash = shutil.which("bash")
        for script in scripts:
            path = os.path.join(ROOT, script)
            self.assertTrue(os.path.isfile(path), f"declared script is missing: {script}")
            if bash:
                self.assertEqual(subprocess.run([bash, "-n", path], capture_output=True).returncode, 0, script)


class PinnedContract(unittest.TestCase):
    """Validate with rEngine's own schema and reader from the pinned checkout
    (third_party/rengine, or --rengine DIR before a pin bump)."""

    def need(self):
        for rel in (SCHEMA_REL, VALIDATOR_REL, FORMATS_REL):
            if not os.path.isfile(os.path.join(RENGINE, rel)):
                self.skipTest(f"pinned rEngine lacks {rel} (bump the pin)")
        if shutil.which("node") is None:
            self.skipTest("node not on PATH")
        with open(os.path.join(RENGINE, SCHEMA_REL), encoding="utf-8") as handle:
            contract = json.load(handle)["properties"]["contract"]
        supported = contract.get("enum", [contract["const"]] if "const" in contract else [])
        declared = load()["contract"]
        if declared not in supported:
            self.skipTest(f"pinned rEngine supports contract {supported}; this declaration is contract {declared}")

    def node(self, script):
        result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=RENGINE,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_schema_accepts_the_declaration_and_rejects_a_typo(self):
        self.need()
        report = self.node(f"""
import {{ readFile }} from 'node:fs/promises';
import {{ validateSchema }} from './{VALIDATOR_REL}';
const schema = JSON.parse(await readFile('{SCHEMA_REL}', 'utf8'));
const decl = JSON.parse(await readFile({json.dumps(DECL)}, 'utf8'));
const typo = JSON.parse(JSON.stringify(decl)); typo.formatz = typo.formats;
const unknown = JSON.parse(JSON.stringify(decl)); unknown.contract = 99;
console.log(JSON.stringify({{ ok: validateSchema(schema, decl), typo: validateSchema(schema, typo),
  unknown: validateSchema(schema, unknown) }}));
""")
        self.assertEqual(report["ok"], [], report["ok"])
        self.assertTrue(report["typo"], "an unknown key must be rejected")
        self.assertTrue(report["unknown"], "an unknown contract version must be rejected")

    def test_reader_accepts_the_declaration_and_matches_its_globs(self):
        self.need()
        names = sorted({glob.replace("*", "sample").replace("?", "x")
                        for fmt in load()["formats"] for glob in fmt["match"] if "[" not in glob})
        report = self.node(f"""
import {{ readDeclaration, matchFormat }} from './{FORMATS_REL}';
const decl = await readDeclaration({json.dumps(ROOT)});
const names = {json.dumps(names)};
console.log(JSON.stringify({{ declared: decl.declared, error: decl.error ?? null,
  ids: decl.formats.map(format => format.id),
  matches: Object.fromEntries(names.map(name => [name, matchFormat(decl.formats, name)?.id ?? null])) }}));
""")
        self.assertTrue(report["declared"])
        self.assertIsNone(report["error"])
        self.assertEqual(report["ids"], [fmt["id"] for fmt in load()["formats"]])
        for name, matched in report["matches"].items():
            self.assertIsNotNone(matched, f"{name} should match a declared format")


class Behaviour(unittest.TestCase):
    """Run the declared commands the way rEngine runs them."""

    def sample(self, fmt):
        for base, directories, files in os.walk(ROOT):
            directories[:] = [d for d in directories if d not in SKIP_DIRS and not d.startswith(".")]
            for name in files:
                if any(fnmatch.fnmatch(name.lower(), glob.lower()) for glob in fmt["match"]):
                    return os.path.join(base, name)
        return None

    def test_declared_commands_run_on_a_matching_file(self):
        ran = 0
        for fmt in load()["formats"]:
            if "preview" not in fmt:
                continue
            exe = executable(fmt["preview"]["command"])
            if not os.path.isfile(exe):
                continue
            sample = self.sample(fmt)
            if sample is None:
                continue
            result, elapsed = run_declared(fmt["preview"], file=sample)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLess(len(result.stdout), fmt["preview"].get("maxBytes", 4194304))
            self.assertLess(elapsed, fmt["preview"].get("timeoutMs", 10000))
            if fmt["preview"]["kind"] == "tree":
                tree = json.loads(result.stdout)
                self.assertIsInstance(tree["dirs"], list)
                self.assertIsInstance(tree["files"], list)
                if "entry" in fmt and tree["files"]:
                    entry, _ = run_declared(fmt["entry"], file=sample, entry=tree["files"][0]["path"])
                    self.assertEqual(entry.returncode, 0, entry.stderr)
            else:
                result.stdout.decode("utf-8")
            ran += 1
        if not ran:
            self.skipTest("no declared preview command is built with a matching file in the root")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=ROOT)
    parser.add_argument("--rengine", default=None, help="rEngine checkout (default: third_party/rengine)")
    parsed, rest = parser.parse_known_args()
    ROOT = os.path.abspath(parsed.root)
    DECL = os.path.join(ROOT, ".rengine", "project.json")
    RENGINE = os.path.abspath(parsed.rengine) if parsed.rengine else os.path.join(ROOT, "third_party", "rengine")
    sys.exit(0 if unittest.main(argv=[sys.argv[0], *rest], verbosity=2, exit=False).result.wasSuccessful() else 1)
