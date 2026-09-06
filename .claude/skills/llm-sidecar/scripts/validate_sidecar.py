#!/usr/bin/env python3
"""Validate and repair `<file>._llm.json` sidecar anchors.

Usage:
  validate_sidecar.py path/to/file.ts            # validate (auto-finds sidecar)
  validate_sidecar.py path/to/file.ts._llm.json  # same, starting from the sidecar
  validate_sidecar.py path/to/file.ts --fix      # repair drifted anchors in place

Exit codes: 0 = clean (including fully repaired with --fix), 1 = problems remain.
"""

import argparse
import json
import sys
from pathlib import Path

SUFFIX = "._llm.json"


def die(msg: str) -> None:
    print(f"ERROR  {msg}")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="source file or its ._llm.json sidecar")
    parser.add_argument(
        "--fix",
        action="store_true",
        help="re-anchor drifted entries in place when the snippet is found exactly once",
    )
    args = parser.parse_args()

    path = Path(args.path)
    if path.name.endswith(SUFFIX):
        sidecar, source = path, path.with_name(path.name[: -len(SUFFIX)])
    else:
        source, sidecar = path, path.with_name(path.name + SUFFIX)

    if not source.exists():
        die(f"source file not found: {source}")
    if not sidecar.exists():
        die(f"sidecar not found: {sidecar}")

    lines = source.read_text(encoding="utf-8").splitlines()
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"sidecar is not valid JSON: {e}")

    entries = data.get("entries")
    if not isinstance(entries, list):
        die("sidecar has no 'entries' list")

    problems: list[str] = []
    fixed: list[str] = []
    seen_ids: set[str] = set()

    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            problems.append(f"entries[{i}]: not an object")
            continue
        label = entry.get("id") or f"entries[{i}]"

        for field in ("id", "anchor", "note"):
            if field not in entry:
                problems.append(f"{label}: missing field '{field}'")
        if entry.get("id") in seen_ids:
            problems.append(f"{label}: duplicate id")
        if isinstance(entry.get("id"), str):
            seen_ids.add(entry["id"])

        anchor = entry.get("anchor")
        if not isinstance(anchor, dict):
            continue
        start, end, snippet = anchor.get("start"), anchor.get("end"), anchor.get("snippet")
        if not (isinstance(start, int) and isinstance(end, int) and isinstance(snippet, str)):
            problems.append(f"{label}: anchor needs integer start/end and string snippet")
            continue
        if not snippet.strip():
            problems.append(f"{label}: snippet is blank — anchor to a distinctive non-blank line")
            continue
        if not 1 <= start <= end:
            problems.append(f"{label}: invalid range {start}..{end}")
            continue

        anchored = 1 <= start <= len(lines) and lines[start - 1].strip() == snippet.strip()
        if anchored:
            if end > len(lines):
                if args.fix:
                    anchor["end"] = len(lines)
                    fixed.append(f"{label}: clamped end {end} -> {len(lines)} (EOF)")
                else:
                    problems.append(f"{label}: end {end} is beyond EOF ({len(lines)} lines)")
            continue

        # Snippet no longer at `start` — try to relocate it.
        matches = [n for n, line in enumerate(lines, 1) if line.strip() == snippet.strip()]
        if len(matches) == 1:
            new_start = matches[0]
            if args.fix:
                delta = new_start - start
                anchor["start"] = new_start
                anchor["end"] = min(end + delta, len(lines))
                fixed.append(f"{label}: moved {start}..{end} -> {anchor['start']}..{anchor['end']}")
            else:
                problems.append(f"{label}: drifted — snippet now at line {new_start} (run --fix)")
        elif matches:
            problems.append(
                f"{label}: snippet matches {len(matches)} lines ({matches}) — fix manually"
            )
        else:
            problems.append(
                f"{label}: snippet not found in {source.name} — code was rewritten or removed; "
                "update or delete the entry"
            )

    if args.fix and fixed:
        sidecar.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    for msg in fixed:
        print(f"FIXED  {msg}")
    for msg in problems:
        print(f"ERROR  {msg}")
    if problems:
        sys.exit(1)
    n = len(entries)
    repaired = f" ({len(fixed)} repaired)" if fixed else ""
    print(f"OK     {sidecar.name}: {n} entr{'y' if n == 1 else 'ies'}, all anchors valid{repaired}")


if __name__ == "__main__":
    main()
