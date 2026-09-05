#!/usr/bin/env python3
"""Read and validate the rEngine feature inventory or its review proposal."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIORITIES = {"high": 0, "medium": 1, "low": 2}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(data):
    require(isinstance(data, dict), "Inventory must be an object.")
    require(type(data.get("schema_version")) is int and data["schema_version"] == 1,
            "Use schema_version 1.")
    require(data.get("project") == "rengine", "Set project to rengine.")
    require(data.get("review_status") in ("proposed", "approved"),
            "Set review_status to proposed or approved; only recorded owner review approves it.")
    require(isinstance(data.get("features"), list) and data["features"],
            "Provide a non-empty features list.")
    rows = {}
    for feature in data["features"]:
        require(isinstance(feature, dict), "Each feature must be an object.")
        ident = feature.get("id")
        require(type(ident) is int and ident > 0, "Feature IDs must be positive integers.")
        require(ident not in rows, f"Duplicate F{ident}; assign a unique ID.")
        for key in ("description", "category", "milestone", "owner_workspace", "deliverable"):
            value = feature.get(key)
            require(isinstance(value, str) and value.strip(), f"F{ident}: provide {key}.")
        priority = feature.get("priority")
        require(isinstance(priority, str) and priority in PRIORITIES, f"F{ident}: invalid priority.")
        require(type(feature.get("passes")) is bool, f"F{ident}: passes must be boolean.")
        for key in ("acceptance_criteria", "external_references", "evidence"):
            values = feature.get(key)
            require(isinstance(values, list) and
                    all(isinstance(v, str) and v.strip() for v in values),
                    f"F{ident}: {key} must be a list of non-empty strings.")
        require(feature["acceptance_criteria"], f"F{ident}: acceptance criteria cannot be empty.")
        deps = feature.get("dependencies")
        require(isinstance(deps, list) and all(type(dep) is int and dep > 0 for dep in deps),
                f"F{ident}: dependencies must be positive integer IDs.")
        require(len(set(deps)) == len(deps), f"F{ident}: remove duplicate dependencies.")
        require(not feature["passes"] or feature["evidence"],
                f"F{ident}: passing requires evidence references for the verified criteria.")
        require(data["review_status"] != "proposed" or not feature["passes"],
                f"F{ident}: a proposal cannot contain completed product work.")
        rows[ident] = feature
    for ident, feature in rows.items():
        for dep in feature["dependencies"]:
            require(dep in rows, f"F{ident}: unknown dependency F{dep}; add or correct it.")
            require(not feature["passes"] or rows[dep]["passes"],
                    f"F{ident}: passing feature depends on non-passing F{dep}.")
    remaining = set(rows)
    resolved = set()
    while remaining:
        wave = {ident for ident in remaining if set(rows[ident]["dependencies"]) <= resolved}
        require(wave, "Dependency cycle: inspect " + ", ".join(f"F{i}" for i in sorted(remaining)))
        resolved.update(wave)
        remaining.difference_update(wave)
    return rows


def load(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = validate(data)
    if data["review_status"] == "approved":
        require(isinstance(data.get("review_record"), str) and data["review_record"].strip(),
                "Approved inventory must reference its recorded owner review in review_record.")
    return data, rows


def state(data, rows, feature):
    # Proposal status is never execution readiness; see sidecar: review-boundary.
    if data["review_status"] != "approved":
        return "proposed"
    if feature["passes"]:
        return "passing"
    if not all(rows[dep]["passes"] for dep in feature["dependencies"]):
        return "blocked"
    if feature["owner_workspace"] != "rengine":
        return "host handoff"
    return "ready"


def graph(data, rows, path):
    print("# Roadmap graph\n")
    print(f"Generated from `{path.name}`; review status: **{data['review_status']}**.\n")
    print("Local readiness does not satisfy external prerequisites or host-workspace authority.\n")
    print("```mermaid\nflowchart TD")
    for ident, feature in sorted(rows.items()):
        print(f'  F{ident}["F{ident}: {state(data, rows, feature)}"]')
        for dep in feature["dependencies"]:
            print(f"  F{dep} --> F{ident}")
    print("```\n")
    print("| ID | Milestone | Owner | State | Description |")
    print("| --- | --- | --- | --- | --- |")
    for ident, feature in sorted(rows.items()):
        values = [f"F{ident}", feature["milestone"], feature["owner_workspace"],
                  state(data, rows, feature), feature["description"]]
        print("| " + " | ".join(v.replace("|", "\\|").replace("\n", " ") for v in values) + " |")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, help="Inspect an explicit inventory file.")
    parser.add_argument("command", choices=("validate", "status", "next", "show", "graph"))
    parser.add_argument("ids", nargs="*", type=int)
    args = parser.parse_args(argv)
    if args.command == "show" and not args.ids:
        parser.error("show requires at least one feature ID")
    if args.command != "show" and args.ids:
        parser.error("feature IDs are only accepted by show")
    path = args.file or (ROOT / "features.json")
    if args.file is None and not path.exists():
        path = ROOT / "docs/features.proposed.json"
    try:
        data, rows = load(path)
        if args.command == "graph":
            graph(data, rows, path)
            return 0
        print(f"Inventory: {path.name} ({data['review_status']})")
        if args.command == "validate":
            print(f"Validated {len(rows)} features, types, evidence requirements and dependency graph.")
        elif args.command == "status":
            counts = Counter(state(data, rows, f) for f in rows.values())
            print(", ".join(f"{count} {label}" for label, count in sorted(counts.items())))
            for milestone, count in sorted(Counter(f["milestone"] for f in rows.values()).items()):
                print(f"  {milestone}: {count} features")
        elif args.command == "next":
            if data["review_status"] != "approved":
                print("No executable feature: finish the charter interview and record owner review.")
                return 0
            ready = sorted((f for f in rows.values() if state(data, rows, f) == "ready"),
                           key=lambda f: (PRIORITIES[f["priority"]], f["id"]))
            for feature in ready:
                print(f"F{feature['id']} [{feature['priority']}] {feature['description']}")
            if not ready:
                print("No local ready feature. Inspect dependencies and host-owned handoffs.")
        elif args.command == "show":
            for ident in args.ids:
                require(ident in rows, f"Unknown feature F{ident}.")
                feature = rows[ident]
                print(f"\nF{ident} [{state(data, rows, feature)}] {feature['description']}")
                print(f"Owner: {feature['owner_workspace']} | Deliverable: {feature['deliverable']}")
                print("Dependencies: " + (", ".join(f"F{d}" for d in feature['dependencies']) or "none"))
                for criterion in feature["acceptance_criteria"]:
                    print(f"  - {criterion}")
                for ref in feature["external_references"]:
                    print(f"  External reference (verify in owner workspace): {ref}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
