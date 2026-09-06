#!/usr/bin/env python3
"""Query code with adjacent ``._llm.json`` metadata and check its freshness.

The persistent SQLite index is a disposable cache: source and sidecar files are
always canonical. Exit code 0 means clean, 1 means actionable diagnostics were
reported, and 2 is reserved for invalid command-line usage.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Sequence

from sidecar_common import (
    FORMAT_CATALOG_VERSION,
    INDEX_FORMAT,
    INDEX_SCHEMA_VERSION,
    OUTPUT_SCHEMA_VERSION,
    SIDECAR_SCHEMA_VERSION,
    SIDECAR_SUFFIX,
    TOOL_VERSION,
    Diagnostic,
    default_index_path,
    format_fingerprint,
    format_for,
    relative_path,
    sha256_file,
    sidecar_for_source,
    source_from_argument,
)
from sidecar_index import (
    index_capabilities,
    matching_paths,
    open_index,
    refresh_index,
    tracked_sources,
)
from sidecar_validation import validate_source


def _entry_dict(row: sqlite3.Row) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": row["entry_id"],
        "kind": row["kind"],
        "anchor": {
            "start": row["start_line"],
            "end": row["end_line"],
            "symbol": row["symbol"],
            "snippet": row["snippet"],
        },
        "note": row["note"],
    }
    if row["refs_json"]:
        try:
            result["refs"] = json.loads(row["refs_json"])
        except json.JSONDecodeError:
            result["refs"] = None
    return result


def _entry_text(row: sqlite3.Row) -> str:
    return "\n".join(
        str(row[key] or "")
        for key in ("entry_id", "kind", "symbol", "snippet", "note", "refs_json")
    )


def _context_window(
    content: str, query: str, preferred_line: int | None, radius: int
) -> tuple[int, int, str, list[int]]:
    lines = content.splitlines()
    matches = [
        number
        for number, source_line in enumerate(lines, 1)
        if query and query.casefold() in source_line.casefold()
    ]
    center = preferred_line or (matches[0] if matches else 1)
    center = min(max(center, 1), max(len(lines), 1))
    start = max(1, center - radius)
    end = min(len(lines), center + radius)
    text = "\n".join(
        f"{number:>6}  {lines[number - 1]}" for number in range(start, end + 1)
    )
    return start, end, text, matches


def query_results(
    connection: sqlite3.Connection,
    root: Path,
    query: str,
    arguments: Sequence[str],
    *,
    line: int | None,
    radius: int,
    limit: int,
) -> tuple[list[dict[str, Any]], list[Diagnostic], list[str]]:
    explicit = bool(arguments)
    if explicit:
        candidate_paths = [
            relative_path(source_from_argument(argument, root), root)
            for argument in arguments
        ]
        search_modes = ["explicit-path"]
    else:
        candidate_paths, search_modes = matching_paths(connection, query, limit)

    results: list[dict[str, Any]] = []
    all_diagnostics: list[Diagnostic] = []
    needle = query.casefold()
    for source_path in dict.fromkeys(candidate_paths):
        row = connection.execute(
            "SELECT * FROM files WHERE kind='source' AND path = ?", (source_path,)
        ).fetchone()
        source = root / source_path
        if row is None:
            diagnostics, _, _ = validate_source(
                source, root, strict_tracking=True, require_sidecar=explicit
            )
            all_diagnostics.extend(diagnostics)
            continue

        entry_rows = connection.execute(
            "SELECT * FROM entries WHERE source_path = ? ORDER BY start_line, entry_id",
            (source_path,),
        ).fetchall()
        directly_matching_entries = [
            entry for entry in entry_rows if query and needle in _entry_text(entry).casefold()
        ]
        metadata_center = next(
            (
                entry["start_line"]
                for entry in directly_matching_entries
                if isinstance(entry["start_line"], int)
            ),
            None,
        )
        start, end, context, code_matches = _context_window(
            row["content"], query, line or metadata_center, radius
        )
        metadata_matches = []
        for entry in entry_rows:
            anchor_near_context = (
                isinstance(entry["start_line"], int)
                and isinstance(entry["end_line"], int)
                and entry["start_line"] <= end
                and entry["end_line"] >= start
            )
            if not query or needle in _entry_text(entry).casefold() or anchor_near_context:
                metadata_matches.append(entry)

        sidecar_path = source_path + SIDECAR_SUFFIX
        indexed_sidecar = connection.execute(
            "SELECT 1 FROM files WHERE kind='sidecar' AND path = ?", (sidecar_path,)
        ).fetchone()
        diagnostics, _, _ = validate_source(
            source,
            root,
            strict_tracking=True,
            require_sidecar=explicit or indexed_sidecar is not None,
        )
        all_diagnostics.extend(diagnostics)
        score = (100 if code_matches else 0) + (50 if directly_matching_entries else 0)
        results.append(
            {
                "status": "needs_action" if diagnostics else "clean",
                "score": score,
                "source": {
                    "path": source_path,
                    "format": row["format"],
                    "format_fingerprint": row["format_fingerprint"],
                    "sha256": row["sha256"],
                    "context": {
                        "start_line": start,
                        "end_line": end,
                        "text": context,
                        "matching_lines": code_matches[:50],
                    },
                },
                "sidecar": {
                    "status": "present" if indexed_sidecar else "missing",
                    "path": sidecar_path if indexed_sidecar else None,
                    "entries": [_entry_dict(entry) for entry in metadata_matches],
                },
                "diagnostics": [item.as_dict() for item in diagnostics],
            }
        )
    results.sort(key=lambda result: (-result["score"], result["source"]["path"]))
    return results[:limit], all_diagnostics, search_modes


def index_info(
    index_path: Path,
    rebuilt_reason: str | None,
    stats: dict[str, int],
    capabilities: dict[str, Any],
) -> dict[str, Any]:
    return {
        "path": str(index_path),
        "format": INDEX_FORMAT,
        "schema_version": INDEX_SCHEMA_VERSION,
        "sidecar_schema_version": SIDECAR_SCHEMA_VERSION,
        "format_catalog_version": FORMAT_CATALOG_VERSION,
        "tool_version": TOOL_VERSION,
        "rebuilt_reason": rebuilt_reason,
        "capabilities": capabilities,
        "stats": stats,
    }


def emit(payload: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    print(f"status: {payload.get('status', 'unknown')}")
    if "index" in payload:
        index = payload["index"]
        stats = index.get("stats", {})
        print(
            f"index: {index['path']} ({index['format']} schema {index['schema_version']}; "
            f"{stats.get('indexed', 0)} changed, {stats.get('unchanged', 0)} unchanged, "
            f"{stats.get('removed', 0)} removed)"
        )
        if index.get("rebuilt_reason"):
            print(f"index rebuilt: {index['rebuilt_reason']}")
    if payload.get("search_modes"):
        print(f"search: {', '.join(payload['search_modes'])}")
    for result in payload.get("results", []):
        print(f"\n{result['source']['path']} [{result['source']['format']}] ({result['status']})")
        context = result["source"].get("context")
        if context and context.get("text"):
            print(context["text"])
        for entry in result.get("sidecar", {}).get("entries", []):
            anchor = entry.get("anchor", {})
            print(
                f"  metadata {entry.get('id')} @ {anchor.get('start')}..{anchor.get('end')}: "
                f"{entry.get('note')}"
            )
    for item in payload.get("diagnostics", []):
        entry = f"#{item['entry_id']}" if item.get("entry_id") else ""
        print(
            f"{item['severity'].upper()} {item['code']} "
            f"{item['path']}{entry}: {item['message']}"
        )
        print(f"  action: {item['action']}")


def _open_refreshed(
    index_path: Path, root: Path, *, full: bool = False
) -> tuple[sqlite3.Connection, str | None, dict[str, int], dict[str, Any]]:
    connection, rebuilt_reason = open_index(index_path, root)
    stats = refresh_index(connection, root, full=full)
    return connection, rebuilt_reason, stats, index_capabilities(connection)


def handle_index(args: argparse.Namespace, root: Path, index_path: Path) -> int:
    connection, rebuilt_reason, stats, capabilities = _open_refreshed(
        index_path, root, full=args.full
    )
    connection.close()
    payload = {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "command": "index",
        "status": "clean",
        "root": str(root),
        "index": index_info(index_path, rebuilt_reason, stats, capabilities),
        "diagnostics": [],
    }
    emit(payload, as_json=args.json)
    return 0


def handle_check(args: argparse.Namespace, root: Path, index_path: Path) -> int:
    connection, rebuilt_reason, stats, capabilities = _open_refreshed(
        index_path, root, full=args.full
    )
    try:
        if args.paths:
            paths = [
                relative_path(source_from_argument(argument, root), root)
                for argument in args.paths
            ]
        elif args.require_sidecars:
            paths = [
                row[0]
                for row in connection.execute(
                    "SELECT path FROM files WHERE kind='source' ORDER BY path"
                )
            ]
        else:
            paths = tracked_sources(connection)
        diagnostics: list[Diagnostic] = []
        checked: list[dict[str, Any]] = []
        for source_path in dict.fromkeys(paths):
            current, _, line_count = validate_source(
                root / source_path,
                root,
                fix_anchors=args.fix_anchors,
                strict_tracking=True,
                require_sidecar=True,
            )
            diagnostics.extend(current)
            checked.append(
                {
                    "path": source_path,
                    "status": "needs_action" if current else "clean",
                    "line_count": line_count,
                    "diagnostics": [item.as_dict() for item in current],
                }
            )
        if args.fix_anchors:
            stats = refresh_index(connection, root)
    finally:
        connection.close()
    status = "needs_action" if diagnostics else "clean"
    payload = {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "command": "check",
        "status": status,
        "root": str(root),
        "index": index_info(index_path, rebuilt_reason, stats, capabilities),
        "checked": checked,
        "diagnostics": [item.as_dict() for item in diagnostics],
    }
    emit(payload, as_json=args.json)
    return 1 if diagnostics else 0


def handle_query(args: argparse.Namespace, root: Path, index_path: Path) -> int:
    if not args.query and not args.paths:
        raise SystemExit("query requires search text, --path, or both")
    connection, rebuilt_reason, stats, capabilities = _open_refreshed(
        index_path, root, full=args.full
    )
    try:
        results, diagnostics, search_modes = query_results(
            connection,
            root,
            args.query or "",
            args.paths,
            line=args.line,
            radius=args.radius,
            limit=args.limit,
        )
    finally:
        connection.close()
    status = "needs_action" if diagnostics else "clean"
    payload = {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "command": "query",
        "status": status,
        "root": str(root),
        "query": args.query or "",
        "search_modes": search_modes,
        "index": index_info(index_path, rebuilt_reason, stats, capabilities),
        "results": results,
        "diagnostics": [item.as_dict() for item in diagnostics],
    }
    emit(payload, as_json=args.json)
    return 1 if diagnostics else 0


def handle_stamp(args: argparse.Namespace, root: Path, index_path: Path) -> int:
    diagnostics: list[Diagnostic] = []
    stamped: list[str] = []
    for argument in args.paths:
        source = source_from_argument(argument, root).resolve()
        current, data, _ = validate_source(
            source, root, strict_tracking=False, require_sidecar=True
        )
        if current or data is None:
            diagnostics.extend(current)
            continue
        sidecar = sidecar_for_source(source)
        file_format = format_for(source)
        data["source"] = {
            "path": relative_path(source, root),
            "sha256": sha256_file(source),
            "format": file_format,
            "format_fingerprint": format_fingerprint(file_format),
        }
        sidecar.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        stamped.append(relative_path(sidecar, root))

    connection, rebuilt_reason, stats, capabilities = _open_refreshed(index_path, root)
    connection.close()
    status = "needs_action" if diagnostics else "clean"
    payload = {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "command": "stamp",
        "status": status,
        "root": str(root),
        "stamped": stamped,
        "index": index_info(index_path, rebuilt_reason, stats, capabilities),
        "diagnostics": [item.as_dict() for item in diagnostics],
    }
    emit(payload, as_json=args.json)
    return 1 if diagnostics else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="project root (default: current directory)")
    parser.add_argument(
        "--index",
        help="SQLite index path (default: user cache keyed by resolved project root)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    index_parser = subparsers.add_parser("index", help="incrementally refresh the project index")
    index_parser.add_argument("--full", action="store_true", help="rehash every indexed file")
    index_parser.add_argument("--json", action="store_true", help="emit stable machine JSON")
    index_parser.set_defaults(handler=handle_index)

    check_parser = subparsers.add_parser("check", help="check sidecar structure and freshness")
    check_parser.add_argument("paths", nargs="*", help="source files or sidecars to check")
    check_parser.add_argument(
        "--all",
        action="store_true",
        help="legacy alias for the default repo-wide tracked-sidecar check",
    )
    check_parser.add_argument(
        "--require-sidecars",
        action="store_true",
        help="repo-wide strict mode: require metadata for every indexed source",
    )
    check_parser.add_argument(
        "--fix-anchors",
        action="store_true",
        help="repair uniquely relocated snippets; never stamp fingerprints automatically",
    )
    check_parser.add_argument("--full", action="store_true", help="rehash every indexed file")
    check_parser.add_argument("--json", action="store_true", help="emit stable machine JSON")
    check_parser.set_defaults(handler=handle_check)

    query_parser = subparsers.add_parser(
        "query", help="return code context together with nearby/anchored metadata"
    )
    query_parser.add_argument("query", nargs="?", help="case-insensitive text to find")
    query_parser.add_argument(
        "--path",
        dest="paths",
        action="append",
        default=[],
        help="limit to an explicit source/sidecar; repeat for multiple files",
    )
    query_parser.add_argument("--line", type=int, help="center context on this 1-based line")
    query_parser.add_argument("--radius", type=int, default=12, help="context lines around a hit")
    query_parser.add_argument("--limit", type=int, default=20, help="maximum result files")
    query_parser.add_argument("--full", action="store_true", help="rehash every indexed file")
    query_parser.add_argument("--json", action="store_true", help="emit stable machine JSON")
    query_parser.set_defaults(handler=handle_query)

    stamp_parser = subparsers.add_parser(
        "stamp", help="record reviewed source/format fingerprints in clean sidecars"
    )
    stamp_parser.add_argument("paths", nargs="+", help="source files or sidecars to stamp")
    stamp_parser.add_argument("--json", action="store_true", help="emit stable machine JSON")
    stamp_parser.set_defaults(handler=handle_stamp)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "check" and args.all and args.paths:
        parser.error("check accepts explicit paths or --all, not both")
    if args.command == "query" and not args.query and not args.paths:
        parser.error("query requires search text, --path, or both")
    if getattr(args, "radius", 0) < 0:
        parser.error("--radius must be non-negative")
    if getattr(args, "limit", 1) < 1:
        parser.error("--limit must be positive")
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"project root is not a directory: {root}")
    index_path = (
        Path(args.index).expanduser().resolve()
        if args.index
        else default_index_path(root)
    )
    return args.handler(args, root, index_path)


if __name__ == "__main__":
    sys.exit(main())
