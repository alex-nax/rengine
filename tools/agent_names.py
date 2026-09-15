#!/usr/bin/env python3
"""Fail the build when an agent CLI's name appears in shared code (F217, spec 141).

The rule this enforces is the project's own, and it already existed as prose:

    Shared code asks the recipe what a CLI can do. It never asks who the CLI is.

A file that is not an agent's own may contain no agent name — not in a function name, not in a
branch, not in a string it prints. Where behaviour differs per agent, either a recipe key describes
the difference, or the agent gets an adapter file of its own. `docs/lessons-learned.md` records what
this costs when it is only prose: spec 140 said "one adapter per CLI" and the code that violated it
was written in the same session, by the agent that had written the spec. `design.py check` has
failed the build on a hand-written product name for a year; an agent name had nothing.

WHAT IT READS. The roster is the registry's — `orchestrator/agents/registry.toml` — so this check
cannot drift from the document it defends, and a CLI added as data is guarded the day it is added.

WHAT IT SKIPS, and why each is not a loophole:

  * comments and doc comments — prose explaining WHY code is shaped a way legitimately names the CLI
    that motivated it; the ban is on code that BEHAVES differently per name;
  * `#[cfg(test)]` modules and everything under a tests directory — a fixture naming a CLI
    deliberately is the point of the fixture;
  * files whose own name is the agent's (`conversations/claude.rs`, `handoff/codex.rs`) — that is
    what an adapter is;
  * the registry document itself, and the specs.

EXCEPTIONS are declared below, in ONE list, each with a reason and the row that will remove it.
Widening it is a visible decision in a diff, which is the whole design: a check whose exceptions are
inferred teaches nothing, and one with no exceptions at all gets deleted the first time it is
inconvenient.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "orchestrator/agents/registry.toml"
SOURCES = [("red", (".rs",)), ("orchestrator", (".mjs", ".c", ".h", ".js"))]
SKIP = ("node_modules", "red/target", "third_party", ".cache", "/tests/", "orchestrator/tests")

# Every place an agent name is allowed to stay, with the reason and what will remove it. A path is
# a file; a (path, line-substring) pair narrows an exception to the one line that earned it.
EXCEPTIONS = [
    ("red/red-agents/src/lib.rs", 'const PARSERS',
     "The values registry.mjs refused, frozen with the record its projection is judged against. "
     "`conversation.read` is the live declaration; `parser` is a vestigial atom of the frozen shape."),
    ("red/red-agents/src/spawn.rs", 'CLAUDE',
     "The environment variables one CLI stamps on its own children, scrubbed so a pane does not "
     "inherit another session's identity (KI-113). Which variables those are is that CLI's, and "
     "belongs in its recipe: F220."),
    ("orchestrator/server/sessions-client.mjs", 'CLAUDE',
     "The JS half of the same identity scrub. F220."),
    ("red/red-project/src/bin/red_project.rs", 'codexModels',
     "A service method named for the CLI whose model list it reads, beside tasks.rs's own naming. "
     "F220 takes both."),
    ("red/red-agents/src/spawn.rs", '.opencode/bin',
     "Where a CLI installs itself, in a PATH search list. F220 declares it per recipe."),
    ("orchestrator/server/sessions-client.mjs", '.opencode/bin',
     "The JS half of the same PATH search list. F220."),
    ("orchestrator/agents/handoff.mjs", None,
     "The JavaScript half of the `rollout-jsonl` kind — codex's own adapter, in the JS host that is "
     "retiring under D57. Its gate and its probe already ask the recipe (F216)."),
    ("orchestrator/agents/mcp.mjs", 'refreshes on tools/list_changed',
     "A message explaining that two CLIs differ in how they take a changed tool list. F220 declares "
     "the behaviour rather than describing it in shared prose."),
    ("orchestrator/launch.mjs", '--agent codex|claude',
     "The usage line's list of agents. F220 prints the roster the registry declares."),
    ("orchestrator/native/render/syntax_theme.h", "Claude Design",
     "The name of a DESIGN SOURCE, not an agent: the theme this workspace's colours came from "
     "(spec 064). It is the one place the word is not about a CLI."),
    ("red/red-ide/src/lock.rs", None,
     "The IDE lock file lives in claude's own directory because the protocol is claude's. F220 "
     "gives red-ide the adapter split red-project's conversations already have."),
    ("red/red-ide/src/bridge.rs", 'x-claude-code-ide-authorization',
     "The header name the IDE bridge protocol defines. F220."),
    ("red/red-ide/src/discovery.rs", None,
     "Finding a published editor means looking where claude publishes one. F220."),
    ("red/red-project/src/tasks.rs", None,
     "Task rows carry the agent that owns them and name the CLIs a task may be handed to. F220 "
     "decides whether that is a roster read or a declaration."),
    ("red/red-token/src/lib.rs", None,
     "The token ledger names agents in its own records, which is data about who holds a token "
     "rather than behaviour that differs by name. F220 confirms or removes it."),
    ("red/red-mcp/src/workspace.rs", None,
     "One message naming a CLI. F220."),
    ("red/red-host/src/handoff/mod.rs", 'codex',
     "The adapter roster: `mod codex;` and the arm mapping a declared KIND to its reader. A module "
     "dispatch IS the prescribed shape — the key is the kind, never the name."),
    ("red/red-project/src/conversations/mod.rs", None,
     "The adapter roster: `pub mod`, the dispatch to one file each, and ADAPTERS, which is the list "
     "of CLIs this crate has a reader for. Membership comes from the registry."),
]


def roster():
    """The agent names the registry declares. The check defends this document, so it reads it."""
    names = re.findall(r"^\[recipes\.([A-Za-z0-9_-]+)\]\s*$", REGISTRY.read_text(), re.M)
    if not names:
        raise SystemExit(f"ERROR: no recipes found in {REGISTRY}; the check has nothing to defend.")
    return names


def strip_block_comments(text):
    """Blank out /* ... */ keeping line numbers, so a reported line is the real one."""
    return re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)


def strip_line_comments(text):
    """Drop `//` comments, but only where the `//` is OUTSIDE a string.

    A naive strip truncates `"https://claude.ai/code"` at the slashes and hides everything after —
    which is a name this check would then never see. That is not hypothetical: it is the shape of
    every URL and every `file://` path in the tree.
    """
    kept = []
    for line in text.split("\n"):
        quote, escaped, cut = None, False, None
        for index, character in enumerate(line):
            if escaped:
                escaped = False
                continue
            if character == "\\":
                escaped = True
                continue
            if quote:
                if character == quote:
                    quote = None
                continue
            if character in "\"'`":
                quote = character
                continue
            if character == "/" and line[index + 1:index + 2] == "/":
                cut = index
                break
        kept.append(line if cut is None else line[:cut])
    return "\n".join(kept)


def strip_test_modules(text):
    """Blank out `#[cfg(test)] mod name { ... }` by brace matching, keeping line numbers."""
    out, index = [], 0
    while True:
        found = re.search(r"#\[cfg\(test\)\]\s*mod\s+\w+\s*\{", text[index:])
        if not found:
            out.append(text[index:])
            return "".join(out)
        start, brace = index + found.start(), index + found.end() - 1
        out.append(text[index:start])
        depth, cursor = 1, brace + 1
        while cursor < len(text) and depth:
            depth += {"{": 1, "}": -1}.get(text[cursor], 0)
            cursor += 1
        out.append("\n" * text[start:cursor].count("\n"))
        index = cursor


def walk(targets):
    """The shipping tree, or exactly the paths named. Naming paths is how the check is checked: a
    decoy is written OUTSIDE the tree, because other agents are working inside it."""
    if targets:
        for given in targets:
            path = Path(given).resolve()
            suffixes = tuple({suffix for _, group in SOURCES for suffix in group})
            yield path, path.as_posix(), suffixes
        return
    for root, suffixes in SOURCES:
        for path in sorted((ROOT / root).rglob("*")):
            yield path, path.relative_to(ROOT).as_posix(), suffixes


def excused(relative, line):
    for path, needle, _ in EXCEPTIONS:
        if relative == path and (needle is None or needle in line):
            return True
    return False


def is_adapter(relative, name):
    """A file whose own name is the agent's is that agent's adapter, and may say so."""
    return Path(relative).stem == name


def findings(targets=None):
    """`\b` is the WRONG boundary here: `_` is a word character, so `\bkimi\b` does not match
    `kimi_flags` — which is the exact function name this check exists to catch, and it passed the
    first time it was tried. The boundary is "not a letter or digit", so `kimi_flags`,
    `claude-flags` and `.kimi-code` all count."""
    names = roster()
    pattern = {name: re.compile(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", re.I) for name in names}
    found = []
    for path, relative, suffixes in walk(targets):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        if targets is None and any(skip in relative for skip in SKIP):
            continue
        text = strip_block_comments(path.read_text(encoding="utf-8", errors="replace"))
        text = strip_line_comments(text)
        if path.suffix == ".rs":
            text = strip_test_modules(text)
        for number, line in enumerate(text.split("\n"), 1):
            for name in names:
                if not pattern[name].search(line):
                    continue
                if is_adapter(relative, name) or excused(relative, line):
                    continue
                found.append((relative, number, name, line.strip()[:120]))
    return found


def main(argv):
    if argv[1:2] not in ([], ["check"]):
        raise SystemExit("Usage: agent_names.py [check] [PATH...]")
    found = findings(argv[2:] or None)
    if not found:
        print(f"No agent name appears in shared code ({len(roster())} declared, "
              f"{len(EXCEPTIONS)} declared exceptions).")
        return 0
    print("ERROR: an agent CLI's name appears in shared code — the antipattern in "
          "docs/lessons-learned.md, 'one file that knows every agent'.\n")
    for relative, number, name, line in found:
        print(f"  {relative}:{number}: [{name}] {line}")
    print("\nShared code asks the recipe what a CLI CAN DO; it never asks who the CLI is "
          "(docs/specs/141-provider-abstraction.md).")
    print("Give the agent an adapter file of its own, or declare the difference as a recipe key.")
    print("If this one genuinely belongs, add it to EXCEPTIONS in tools/agent_names.py with the "
          "reason and the feature that will remove it.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
