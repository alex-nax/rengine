#!/usr/bin/env python3
"""Rich sidecar validation shared by ``check``, ``query``, and ``stamp``."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sidecar_common import (
    SIDECAR_SCHEMA_VERSION,
    Diagnostic,
    diagnostic,
    format_fingerprint,
    format_for,
    relative_path,
    sha256_file,
    sidecar_for_source,
)


KEBAB_CASE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _load_sidecar(
    sidecar: Path,
) -> tuple[dict[str, Any] | None, list[Diagnostic]]:
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except UnicodeDecodeError as error:
        return None, [
            diagnostic(
                "SIDECAR_ENCODING_INVALID",
                "error",
                sidecar,
                f"Sidecar is not UTF-8: {error}.",
                "Rewrite the sidecar as UTF-8 JSON and rerun `check`.",
            )
        ]
    except json.JSONDecodeError as error:
        return None, [
            diagnostic(
                "SIDECAR_JSON_INVALID",
                "error",
                sidecar,
                f"Sidecar is malformed JSON: {error}.",
                "Repair the JSON syntax, preserve applicable notes, and rerun `check`.",
            )
        ]
    if not isinstance(data, dict):
        return None, [
            diagnostic(
                "SIDECAR_ROOT_INVALID",
                "error",
                sidecar,
                "Sidecar root must be a JSON object.",
                "Replace the root with an object containing version, optional source tracking, and entries.",
            )
        ]
    return data, []


def _validate_entry(
    entry: Any,
    position: int,
    sidecar: Path,
    lines: list[str],
    seen_ids: set[str],
    *,
    fix_anchors: bool,
) -> tuple[list[Diagnostic], bool]:
    diagnostics: list[Diagnostic] = []
    entry_path = f"entries[{position}]"
    if not isinstance(entry, dict):
        return [
            diagnostic(
                "ENTRY_INVALID",
                "error",
                sidecar,
                f"{entry_path} is not an object.",
                "Replace it with an object containing id, anchor, and note.",
            )
        ], False

    raw_id = entry.get("id")
    entry_id = raw_id if isinstance(raw_id, str) and raw_id else None
    label = entry_id or entry_path
    for field in ("id", "anchor", "note"):
        if field not in entry:
            diagnostics.append(
                diagnostic(
                    "ENTRY_FIELD_MISSING",
                    "error",
                    sidecar,
                    f"{label} is missing required field {field!r}.",
                    f"Add {field!r} without discarding the entry's applicable rationale.",
                    entry_id,
                )
            )
    if "id" in entry:
        if not isinstance(raw_id, str):
            diagnostics.append(
                diagnostic(
                    "ENTRY_ID_TYPE_INVALID",
                    "error",
                    sidecar,
                    f"{entry_path} id must be a string.",
                    "Replace id with a unique stable kebab-case string and update any references.",
                )
            )
        elif not KEBAB_CASE.fullmatch(raw_id):
            diagnostics.append(
                diagnostic(
                    "ENTRY_ID_FORMAT_INVALID",
                    "error",
                    sidecar,
                    f"{entry_path} id {raw_id!r} is not kebab-case.",
                    "Use lowercase letters/digits separated by single hyphens; keep the corrected id stable.",
                    entry_id,
                )
            )
    note = entry.get("note")
    if "note" in entry:
        if not isinstance(note, str):
            diagnostics.append(
                diagnostic(
                    "ENTRY_NOTE_TYPE_INVALID",
                    "error",
                    sidecar,
                    f"{label} note must be a string.",
                    "Preserve the applicable rationale as non-blank markdown prose.",
                    entry_id,
                )
            )
        elif not note.strip():
            diagnostics.append(
                diagnostic(
                    "ENTRY_NOTE_BLANK",
                    "error",
                    sidecar,
                    f"{label} has a blank note.",
                    "Write the file-local rationale or remove the empty entry.",
                    entry_id,
                )
            )
    kind = entry.get("kind")
    if "kind" in entry:
        if not isinstance(kind, str):
            diagnostics.append(
                diagnostic(
                    "ENTRY_KIND_TYPE_INVALID",
                    "error",
                    sidecar,
                    f"{label} kind must be a string.",
                    "Use a short kebab-case noun such as rationale, constraint, edge-case, history, perf, or cross-ref.",
                    entry_id,
                )
            )
        elif not KEBAB_CASE.fullmatch(kind):
            diagnostics.append(
                diagnostic(
                    "ENTRY_KIND_FORMAT_INVALID",
                    "error",
                    sidecar,
                    f"{label} kind {kind!r} is not a short kebab-case noun.",
                    "Use a short lowercase noun with hyphens between words, or omit kind.",
                    entry_id,
                )
            )
    refs = entry.get("refs")
    if "refs" in entry:
        if not isinstance(refs, list):
            diagnostics.append(
                diagnostic(
                    "ENTRY_REFS_TYPE_INVALID",
                    "error",
                    sidecar,
                    f"{label} refs must be a list of strings.",
                    "Replace refs with a JSON array of non-blank paths, issue IDs, or URLs, or omit it.",
                    entry_id,
                )
            )
        else:
            invalid_refs = [
                index
                for index, ref in enumerate(refs)
                if not isinstance(ref, str) or not ref.strip()
            ]
            if invalid_refs:
                diagnostics.append(
                    diagnostic(
                        "ENTRY_REFS_ITEM_INVALID",
                        "error",
                        sidecar,
                        f"{label} refs contains non-string or blank items at indexes {invalid_refs}.",
                        "Replace each invalid item with a non-blank string or remove it.",
                        entry_id,
                    )
                )
    if entry_id:
        if entry_id in seen_ids:
            diagnostics.append(
                diagnostic(
                    "ENTRY_ID_DUPLICATE",
                    "error",
                    sidecar,
                    f"Entry id {entry_id!r} is duplicated.",
                    "Give each entry a unique stable kebab-case id and update references if necessary.",
                    entry_id,
                )
            )
        seen_ids.add(entry_id)

    anchor = entry.get("anchor")
    if not isinstance(anchor, dict):
        if "anchor" in entry:
            diagnostics.append(
                diagnostic(
                    "ANCHOR_TYPE_INVALID",
                    "error",
                    sidecar,
                    f"{label} anchor must be an object.",
                    "Replace anchor with an object containing integer start/end and an exact snippet.",
                    entry_id,
                )
            )
        return diagnostics, False
    symbol = anchor.get("symbol")
    if "symbol" in anchor and (not isinstance(symbol, str) or not symbol.strip()):
        diagnostics.append(
            diagnostic(
                "ANCHOR_SYMBOL_INVALID",
                "error",
                sidecar,
                f"{label} anchor symbol must be a non-blank string when present.",
                "Use the enclosing function/class/constant name, or omit symbol.",
                entry_id,
            )
        )
    start, end, snippet = anchor.get("start"), anchor.get("end"), anchor.get("snippet")
    valid_fields = (
        isinstance(start, int)
        and not isinstance(start, bool)
        and isinstance(end, int)
        and not isinstance(end, bool)
        and isinstance(snippet, str)
    )
    if not valid_fields:
        diagnostics.append(
            diagnostic(
                "ANCHOR_FIELDS_INVALID",
                "error",
                sidecar,
                f"{label} needs integer start/end and string snippet.",
                "Set a 1-based inclusive range and copy the exact trimmed start-line text into snippet.",
                entry_id,
            )
        )
        return diagnostics, False
    assert isinstance(start, int) and isinstance(end, int) and isinstance(snippet, str)
    if not snippet.strip():
        diagnostics.append(
            diagnostic(
                "ANCHOR_SNIPPET_BLANK",
                "error",
                sidecar,
                f"{label} has a blank anchor snippet.",
                "Anchor to a distinctive non-blank source line.",
                entry_id,
            )
        )
        return diagnostics, False
    if not 1 <= start <= end:
        diagnostics.append(
            diagnostic(
                "ANCHOR_RANGE_INVALID",
                "error",
                sidecar,
                f"{label} has invalid range {start}..{end}.",
                "Choose a 1-based inclusive range with start <= end inside the source.",
                entry_id,
            )
        )
        return diagnostics, False

    anchored = start <= len(lines) and lines[start - 1].strip() == snippet.strip()
    if anchored and end <= len(lines):
        return diagnostics, False
    matches = [number for number, line in enumerate(lines, 1) if line.strip() == snippet.strip()]
    if anchored and end > len(lines):
        if fix_anchors:
            anchor["end"] = len(lines)
            return diagnostics, True
        diagnostics.append(
            diagnostic(
                "ANCHOR_END_OUT_OF_RANGE",
                "error",
                sidecar,
                f"{label} ends at {end}, beyond EOF ({len(lines)} lines).",
                "Run `check --fix-anchors`, then review the repaired range.",
                entry_id,
            )
        )
    elif len(matches) == 1:
        new_start = matches[0]
        if fix_anchors:
            anchor["start"] = new_start
            anchor["end"] = min(new_start + end - start, len(lines))
            return diagnostics, True
        diagnostics.append(
            diagnostic(
                "ANCHOR_DRIFTED",
                "error",
                sidecar,
                f"{label} points at {start}, but its snippet is now at line {new_start}.",
                "Run `check --fix-anchors`, review the repaired range, and update the note if semantics changed.",
                entry_id,
            )
        )
    elif matches:
        diagnostics.append(
            diagnostic(
                "ANCHOR_AMBIGUOUS",
                "error",
                sidecar,
                f"{label} snippet matches multiple lines: {matches}.",
                "Choose a more distinctive start line and update start/end/snippet manually.",
                entry_id,
            )
        )
    else:
        diagnostics.append(
            diagnostic(
                "ANCHOR_SNIPPET_MISSING",
                "error",
                sidecar,
                f"{label} snippet no longer exists in the source.",
                "Find the replacement code and update the anchor/note, or delete the entry if it no longer applies.",
                entry_id,
            )
        )
    return diagnostics, False


def _tracking_diagnostics(
    data: dict[str, Any], source: Path, sidecar: Path, root: Path, source_text: str
) -> list[Diagnostic]:
    tracking = data.get("source")
    current_format = format_for(source)
    current_format_fingerprint = format_fingerprint(current_format)
    current_sha = sha256_file(source)
    if not isinstance(tracking, dict):
        return [
            diagnostic(
                "SOURCE_TRACKING_MISSING",
                "warning",
                sidecar,
                "Sidecar has no source/format fingerprint tracking.",
                "Review that every note still applies, then run `stamp` to record the current source and format fingerprints.",
            )
        ]

    diagnostics: list[Diagnostic] = []
    expected_path = relative_path(source, root)
    checks = (
        (
            tracking.get("path") != expected_path,
            "SOURCE_PATH_CHANGED",
            "error",
            f"Tracked source path {tracking.get('path')!r} does not match {expected_path!r}.",
            "Confirm the move/rename, move the sidecar beside its source, then run `stamp`.",
        ),
        (
            tracking.get("sha256") != current_sha,
            "SOURCE_FINGERPRINT_CHANGED",
            "warning",
            "The source content fingerprint changed since metadata was reviewed.",
            "Review anchors and notes against the changed code; update stale metadata, then run `stamp`.",
        ),
        (
            tracking.get("format") != current_format,
            "SOURCE_FORMAT_CHANGED",
            "warning",
            f"Tracked format {tracking.get('format')!r} differs from detected format {current_format!r}.",
            "Review format-specific assumptions in the notes, then run `stamp`.",
        ),
        (
            tracking.get("format_fingerprint") != current_format_fingerprint,
            "FORMAT_FINGERPRINT_CHANGED",
            "warning",
            "The tracked format-catalog fingerprint is absent or stale.",
            "Review format-sensitive metadata, then run `stamp` with the current tool.",
        ),
    )
    for failed, code, severity, message, action in checks:
        if failed:
            diagnostics.append(diagnostic(code, severity, sidecar, message, action))
    return diagnostics


def validate_source(
    source: Path,
    root: Path,
    *,
    fix_anchors: bool = False,
    strict_tracking: bool = True,
    require_sidecar: bool = True,
) -> tuple[list[Diagnostic], dict[str, Any] | None, int]:
    """Validate one source and its adjacent sidecar without silently approving changes."""

    source = source.resolve()
    sidecar = sidecar_for_source(source)
    if not source.exists():
        return [
            diagnostic(
                "SOURCE_MISSING",
                "error",
                source,
                "The source file does not exist.",
                "Restore the source, move the sidecar with its source, or remove the orphaned sidecar.",
            )
        ], None, 0
    try:
        source_text = source.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        return [
            diagnostic(
                "SOURCE_ENCODING_INVALID",
                "error",
                source,
                f"Source is not UTF-8: {error}.",
                "Use the legacy validator for this encoding or convert the source before indexing it.",
            )
        ], None, 0
    lines = source_text.splitlines()
    if not sidecar.exists():
        if not require_sidecar:
            return [], None, len(lines)
        return [
            diagnostic(
                "SIDECAR_MISSING",
                "warning",
                source,
                "No adjacent ._llm.json metadata exists for this explicitly requested source.",
                "Decide whether the file contains non-obvious file-local rationale. If it does, generate "
                f"{sidecar.name} with anchored entries, then run `stamp`; otherwise no sidecar is required.",
            )
        ], None, len(lines)

    data, diagnostics = _load_sidecar(sidecar)
    if data is None:
        return diagnostics, None, len(lines)
    version = data.get("version")
    if type(version) is not int or version != SIDECAR_SCHEMA_VERSION:
        diagnostics.append(
            diagnostic(
                "SIDECAR_VERSION_UNSUPPORTED",
                "error",
                sidecar,
                f"Expected integer sidecar version {SIDECAR_SCHEMA_VERSION}, found {version!r}.",
                "Migrate the sidecar to the current schema before relying on its metadata.",
            )
        )
    entries = data.get("entries")
    if not isinstance(entries, list):
        diagnostics.append(
            diagnostic(
                "ENTRIES_INVALID",
                "error",
                sidecar,
                "Sidecar has no entries list.",
                "Add an `entries` array and preserve all applicable rationale as anchored entries.",
            )
        )
        entries = []

    seen_ids: set[str] = set()
    fixed = False
    for position, entry in enumerate(entries):
        current, entry_fixed = _validate_entry(
            entry, position, sidecar, lines, seen_ids, fix_anchors=fix_anchors
        )
        diagnostics.extend(current)
        fixed = fixed or entry_fixed
    if fixed:
        sidecar.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    if strict_tracking:
        diagnostics.extend(_tracking_diagnostics(data, source, sidecar, root, source_text))
    return diagnostics, data, len(lines)
