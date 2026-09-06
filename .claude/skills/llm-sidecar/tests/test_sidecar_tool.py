#!/usr/bin/env python3
"""Deterministic tests for the indexed LLM-sidecar agent CLI."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
CLI = SKILL_ROOT / "scripts" / "sidecar_tool.py"
LEGACY_VALIDATOR = SKILL_ROOT / "scripts" / "validate_sidecar.py"


def source_tracking(root: Path, source: Path, file_format: str) -> dict[str, str]:
    catalog_fingerprint = hashlib.sha256(
        f"format-catalog:1\0{file_format}".encode()
    ).hexdigest()
    return {
        "path": source.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "format": file_format,
        "format_fingerprint": catalog_fingerprint,
    }


def write_sidecar(
    root: Path,
    source: Path,
    *,
    start: int = 1,
    end: int = 2,
    snippet: str | None = None,
    note: str = "Full jitter prevents synchronized retry storms.",
    tracking: bool = True,
) -> Path:
    lines = source.read_text(encoding="utf-8").splitlines()
    data: dict[str, object] = {
        "version": 1,
        "entries": [
            {
                "id": "full-jitter-rationale",
                "kind": "rationale",
                "anchor": {
                    "start": start,
                    "end": end,
                    "symbol": "retry",
                    "snippet": snippet if snippet is not None else lines[start - 1].strip(),
                },
                "note": note,
                "refs": ["docs/retries.md"],
            }
        ],
    }
    if tracking:
        data["source"] = source_tracking(root, source, "python")
    sidecar = source.with_name(source.name + "._llm.json")
    sidecar.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return sidecar


class SidecarToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.index = self.root.parent / f"{self.root.name}-index.sqlite3"

    def tearDown(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(self.index) + suffix)
            if path.exists():
                path.unlink()
        self.temp_dir.cleanup()

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--root",
                str(self.root),
                "--index",
                str(self.index),
                *arguments,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def run_json(self, *arguments: str) -> tuple[subprocess.CompletedProcess[str], dict]:
        result = self.run_cli(*arguments, "--json")
        self.assertTrue(result.stdout, result.stderr)
        return result, json.loads(result.stdout)

    def test_pinned_vendor_tree_is_not_indexed(self) -> None:
        (self.root / "source.py").write_text("answer = 42\n", encoding="utf-8")
        vendor = self.root / "third_party"
        vendor.mkdir()
        (vendor / "graphics.h").write_text("int vendor_fixture_symbol;\n", encoding="utf-8")
        result, payload = self.run_json("index")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["index"]["stats"]["discovered"], 1)

    def test_project_cache_is_not_indexed(self) -> None:
        (self.root / "source.py").write_text("answer = 42\n", encoding="utf-8")
        cache = self.root / ".cache"
        cache.mkdir()
        (cache / "capability.json").write_text('{"token": "fixture-private-marker"}', encoding="utf-8")
        result, payload = self.run_json("index")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["index"]["stats"]["discovered"], 1)
        _, query = self.run_json("query", "fixture-private-marker")
        self.assertEqual(query["results"], [])

    def test_index_build_and_incremental_refresh(self) -> None:
        source = self.root / "service.py"
        source.write_text("def answer():\n    return 42\n", encoding="utf-8")

        first, first_payload = self.run_json("index")
        second, second_payload = self.run_json("index")
        source.write_text("def answer():\n    return 420\n", encoding="utf-8")
        third, third_payload = self.run_json("index")
        source.unlink()
        fourth, fourth_payload = self.run_json("index")
        query, query_payload = self.run_json("query", "answer")

        self.assertEqual(first.returncode, 0)
        self.assertEqual(first_payload["index"]["format"], "llm-sidecar-sqlite-fts")
        self.assertEqual(first_payload["index"]["schema_version"], 2)
        self.assertEqual(first_payload["index"]["format_catalog_version"], 1)
        self.assertEqual(first_payload["index"]["sidecar_schema_version"], 1)
        self.assertEqual(first_payload["index"]["stats"]["indexed"], 1)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(second_payload["index"]["stats"]["unchanged"], 1)
        self.assertEqual(second_payload["index"]["stats"]["indexed"], 0)
        self.assertEqual(third.returncode, 0)
        self.assertEqual(third_payload["index"]["stats"]["indexed"], 1)
        self.assertEqual(fourth.returncode, 0)
        self.assertEqual(fourth_payload["index"]["stats"]["removed"], 1)
        self.assertEqual(query.returncode, 0)
        self.assertEqual(query_payload["results"], [])

    def test_schema_version_change_invalidates_and_rebuilds_cache(self) -> None:
        (self.root / "service.py").write_text("value = 1\n", encoding="utf-8")
        self.assertEqual(self.run_cli("index").returncode, 0)
        connection = sqlite3.connect(self.index)
        connection.execute("PRAGMA user_version=999")
        connection.close()

        result, payload = self.run_json("index")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            payload["index"]["rebuilt_reason"], "index_schema_version_changed"
        )
        connection = sqlite3.connect(self.index)
        self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
        metadata = dict(connection.execute("SELECT key, value FROM meta"))
        self.assertEqual(metadata["index_format"], "llm-sidecar-sqlite-fts")
        self.assertEqual(metadata["index_schema_version"], "2")
        self.assertEqual(metadata["format_catalog_version"], "1")
        connection.close()

    def test_query_returns_code_context_and_anchored_metadata(self) -> None:
        source = self.root / "retry.py"
        source.write_text(
            "def retry(attempt):\n"
            "    # short breadcrumb\n"
            "    jitter = attempt * 2\n"
            "    return jitter\n",
            encoding="utf-8",
        )
        write_sidecar(
            self.root,
            source,
            start=1,
            end=4,
            note="Full jitter prevents synchronized retry storms.",
        )

        result, payload = self.run_json("query", "jitter")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(payload["status"], "clean")
        self.assertEqual(len(payload["results"]), 1)
        item = payload["results"][0]
        self.assertIn("jitter = attempt * 2", item["source"]["context"]["text"])
        self.assertEqual(item["source"]["format"], "python")
        self.assertEqual(
            item["sidecar"]["entries"][0]["id"], "full-jitter-rationale"
        )
        self.assertIn("retry storms", item["sidecar"]["entries"][0]["note"])

    def test_query_uses_fts_and_trigram_indexes(self) -> None:
        source = self.root / "retry.py"
        source.write_text(
            "def jitter(attempt):\n    return attempt * 2\n", encoding="utf-8"
        )
        write_sidecar(
            self.root,
            source,
            note="Full jitter prevents synchronized retry storms.",
        )

        word_result, word_payload = self.run_json("query", "jitter")
        literal_result, literal_payload = self.run_json(
            "query", "nchronized retry"
        )

        self.assertEqual(word_result.returncode, 0)
        self.assertIn("trigram", word_payload["search_modes"])
        if word_payload["index"]["capabilities"]["fts5"]:
            self.assertIn("fts5", word_payload["search_modes"])
        self.assertEqual(literal_result.returncode, 0)
        self.assertEqual(literal_payload["search_modes"], ["trigram"])
        self.assertEqual(literal_payload["results"][0]["source"]["path"], "retry.py")
        self.assertIn(
            "synchronized retry storms",
            literal_payload["results"][0]["sidecar"]["entries"][0]["note"],
        )

    def test_explicit_missing_sidecar_is_actionable_but_repo_query_is_not_noisy(self) -> None:
        source = self.root / "plain.py"
        source.write_text("def plain():\n    return 'needle'\n", encoding="utf-8")

        explicit, explicit_payload = self.run_json(
            "query", "needle", "--path", "plain.py"
        )
        broad, broad_payload = self.run_json("query", "needle")

        self.assertEqual(explicit.returncode, 1)
        self.assertEqual(explicit_payload["status"], "needs_action")
        diagnostic = explicit_payload["diagnostics"][0]
        self.assertEqual(diagnostic["code"], "SIDECAR_MISSING")
        self.assertEqual(diagnostic["status"], "needs_action")
        self.assertEqual(diagnostic["severity"], "warning")
        self.assertIn("Decide whether", diagnostic["action"])
        self.assertEqual(broad.returncode, 0, broad.stdout)
        self.assertEqual(broad_payload["status"], "clean")
        self.assertEqual(broad_payload["diagnostics"], [])

    def test_repo_check_tracks_existing_sidecars_and_strict_mode_requires_all(self) -> None:
        plain = self.root / "plain.py"
        plain.write_text("plain = True\n", encoding="utf-8")
        tracked = self.root / "tracked.py"
        tracked.write_text("def tracked():\n    return True\n", encoding="utf-8")
        write_sidecar(self.root, tracked)

        normal, normal_payload = self.run_json("check")
        strict, strict_payload = self.run_json("check", "--require-sidecars")

        self.assertEqual(normal.returncode, 0, normal.stdout)
        self.assertEqual(
            [item["path"] for item in normal_payload["checked"]], ["tracked.py"]
        )
        self.assertEqual(strict.returncode, 1)
        self.assertIn(
            "SIDECAR_MISSING",
            {item["code"] for item in strict_payload["diagnostics"]},
        )
        missing = next(
            item
            for item in strict_payload["diagnostics"]
            if item["code"] == "SIDECAR_MISSING"
        )
        self.assertEqual(missing["path"], str(plain.resolve()))

    def test_check_reports_malformed_and_missing_source_sidecars(self) -> None:
        malformed = self.root / "broken.py"
        malformed.write_text("value = 1\n", encoding="utf-8")
        malformed.with_name("broken.py._llm.json").write_text("{bad json\n", encoding="utf-8")
        orphan_sidecar = self.root / "gone.py._llm.json"
        orphan_sidecar.write_text('{"version": 1, "entries": []}\n', encoding="utf-8")

        malformed_result, malformed_payload = self.run_json("check", "broken.py")
        orphan_result, orphan_payload = self.run_json("check", "gone.py._llm.json")

        self.assertEqual(malformed_result.returncode, 1)
        self.assertEqual(
            malformed_payload["diagnostics"][0]["code"], "SIDECAR_JSON_INVALID"
        )
        self.assertIn("Repair", malformed_payload["diagnostics"][0]["action"])
        self.assertEqual(orphan_result.returncode, 1)
        self.assertEqual(orphan_payload["diagnostics"][0]["code"], "SOURCE_MISSING")

    def test_check_reports_bad_anchor_missing_tracking_and_stale_fingerprint(self) -> None:
        bad_anchor = self.root / "bad_anchor.py"
        bad_anchor.write_text("value = 1\n", encoding="utf-8")
        write_sidecar(
            self.root,
            bad_anchor,
            start=1,
            end=99,
            tracking=False,
        )
        bad_result, bad_payload = self.run_json("check", "bad_anchor.py")
        bad_codes = {item["code"] for item in bad_payload["diagnostics"]}

        stale = self.root / "stale.py"
        stale.write_text("def stable():\n    return 1\n", encoding="utf-8")
        write_sidecar(self.root, stale, start=1, end=2)
        stale.write_text("def stable():\n    return 100\n", encoding="utf-8")
        stale_result, stale_payload = self.run_json("check", "stale.py")
        stale_codes = {item["code"] for item in stale_payload["diagnostics"]}

        self.assertEqual(bad_result.returncode, 1)
        self.assertIn("ANCHOR_END_OUT_OF_RANGE", bad_codes)
        self.assertIn("SOURCE_TRACKING_MISSING", bad_codes)
        self.assertEqual(stale_result.returncode, 1)
        self.assertIn("SOURCE_FINGERPRINT_CHANGED", stale_codes)

    def test_check_reports_invalid_drifted_ambiguous_and_missing_anchors(self) -> None:
        source = self.root / "anchors.py"
        source.write_text(
            "first = 1\nrepeat = True\ntarget = 3\nrepeat = True\n",
            encoding="utf-8",
        )
        entries = [
            {
                "id": "invalid-fields",
                "anchor": {"start": True, "end": 1, "snippet": "first = 1"},
                "note": "Invalid boolean line number.",
            },
            {
                "id": "invalid-range",
                "anchor": {"start": 3, "end": 2, "snippet": "target = 3"},
                "note": "Invalid descending range.",
            },
            {
                "id": "blank-snippet",
                "anchor": {"start": 1, "end": 1, "snippet": " "},
                "note": "Blank snippets cannot relocate.",
            },
            {
                "id": "drifted",
                "anchor": {"start": 1, "end": 1, "snippet": "target = 3"},
                "note": "Unique snippet moved.",
            },
            {
                "id": "ambiguous",
                "anchor": {"start": 1, "end": 1, "snippet": "repeat = True"},
                "note": "Repeated snippet is ambiguous.",
            },
            {
                "id": "missing",
                "anchor": {"start": 1, "end": 1, "snippet": "gone = True"},
                "note": "Snippet was removed.",
            },
        ]
        source.with_name("anchors.py._llm.json").write_text(
            json.dumps({"version": 1, "entries": entries}) + "\n",
            encoding="utf-8",
        )

        result, payload = self.run_json("check", "anchors.py")
        codes = {item["code"] for item in payload["diagnostics"]}

        self.assertEqual(result.returncode, 1)
        self.assertTrue(
            {
                "ANCHOR_FIELDS_INVALID",
                "ANCHOR_RANGE_INVALID",
                "ANCHOR_SNIPPET_BLANK",
                "ANCHOR_DRIFTED",
                "ANCHOR_AMBIGUOUS",
                "ANCHOR_SNIPPET_MISSING",
            }.issubset(codes)
        )

    def test_check_rejects_malformed_entry_metadata_types_and_ids(self) -> None:
        source = self.root / "metadata.py"
        source.write_text("value = 1\n", encoding="utf-8")
        entries = [
            {
                "id": 7,
                "kind": False,
                "anchor": {
                    "start": 1,
                    "end": 1,
                    "symbol": 3,
                    "snippet": "value = 1",
                },
                "note": ["not", "prose"],
                "refs": "docs/design.md",
            },
            {
                "id": "Not Kebab",
                "kind": "edge case",
                "anchor": {"start": 1, "end": 1, "snippet": "value = 1"},
                "note": " ",
                "refs": ["docs/design.md", "", 42],
            },
            {
                "id": "bad-anchor-object",
                "anchor": "line one",
                "note": "The anchor has the wrong JSON type.",
            },
        ]
        source.with_name("metadata.py._llm.json").write_text(
            json.dumps({"version": True, "entries": entries}) + "\n",
            encoding="utf-8",
        )

        result, payload = self.run_json("check", "metadata.py")
        codes = {item["code"] for item in payload["diagnostics"]}

        self.assertEqual(result.returncode, 1)
        self.assertTrue(
            {
                "SIDECAR_VERSION_UNSUPPORTED",
                "ENTRY_ID_TYPE_INVALID",
                "ENTRY_ID_FORMAT_INVALID",
                "ENTRY_NOTE_TYPE_INVALID",
                "ENTRY_NOTE_BLANK",
                "ENTRY_KIND_TYPE_INVALID",
                "ENTRY_KIND_FORMAT_INVALID",
                "ENTRY_REFS_TYPE_INVALID",
                "ENTRY_REFS_ITEM_INVALID",
                "ANCHOR_SYMBOL_INVALID",
                "ANCHOR_TYPE_INVALID",
            }.issubset(codes)
        )

    def test_check_reports_source_and_format_fingerprint_changes(self) -> None:
        source = self.root / "format.py"
        source.write_text("value = 1\n", encoding="utf-8")
        sidecar = write_sidecar(self.root, source, start=1, end=1)
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        data["source"]["format"] = "rust"
        data["source"]["format_fingerprint"] = "stale-catalog-fingerprint"
        sidecar.write_text(json.dumps(data) + "\n", encoding="utf-8")

        format_result, format_payload = self.run_json("check", "format.py")
        source.write_text("value = 2\n", encoding="utf-8")
        source_result, source_payload = self.run_json("check", "format.py")

        self.assertEqual(format_result.returncode, 1)
        format_codes = {item["code"] for item in format_payload["diagnostics"]}
        self.assertIn("SOURCE_FORMAT_CHANGED", format_codes)
        self.assertIn("FORMAT_FINGERPRINT_CHANGED", format_codes)
        self.assertNotIn("SOURCE_FINGERPRINT_CHANGED", format_codes)
        self.assertEqual(source_result.returncode, 1)
        self.assertIn(
            "SOURCE_FINGERPRINT_CHANGED",
            {item["code"] for item in source_payload["diagnostics"]},
        )

    def test_stamp_and_check_use_raw_source_fingerprint_for_crlf(self) -> None:
        source = self.root / "windows.py"
        source.write_bytes(b"def windows():\r\n    return True\r\n")
        write_sidecar(self.root, source, tracking=False)

        stamp, stamp_payload = self.run_json("stamp", "windows.py")
        check, check_payload = self.run_json("check", "windows.py")

        self.assertEqual(stamp.returncode, 0, stamp.stdout)
        self.assertEqual(stamp_payload["status"], "clean")
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertEqual(check_payload["status"], "clean")

    def test_stamp_records_tracking_then_check_is_clean(self) -> None:
        source = self.root / "fresh.py"
        source.write_text("def fresh():\n    return True\n", encoding="utf-8")
        sidecar = write_sidecar(self.root, source, start=1, end=2, tracking=False)

        before, before_payload = self.run_json("check", "fresh.py")
        stamped, stamp_payload = self.run_json("stamp", "fresh.py")
        after, after_payload = self.run_json("check", "fresh.py")

        self.assertEqual(before.returncode, 1)
        self.assertEqual(
            before_payload["diagnostics"][0]["code"], "SOURCE_TRACKING_MISSING"
        )
        self.assertEqual(stamped.returncode, 0, stamped.stdout)
        self.assertEqual(stamp_payload["stamped"], ["fresh.py._llm.json"])
        tracked = json.loads(sidecar.read_text(encoding="utf-8"))["source"]
        self.assertEqual(tracked["path"], "fresh.py")
        self.assertEqual(tracked["format"], "python")
        self.assertEqual(after.returncode, 0, after.stdout)
        self.assertEqual(after_payload["status"], "clean")

    def test_anchor_fix_is_explicit_and_human_output_is_readable(self) -> None:
        source = self.root / "shifted.py"
        source.write_text("header = True\ndef shifted():\n    return 1\n", encoding="utf-8")
        write_sidecar(
            self.root,
            source,
            start=1,
            end=2,
            snippet="def shifted():",
            tracking=False,
        )

        before = self.run_cli("check", "shifted.py")
        fixed = self.run_cli("check", "shifted.py", "--fix-anchors")
        payload = json.loads(
            source.with_name("shifted.py._llm.json").read_text(encoding="utf-8")
        )
        stamped = self.run_cli("stamp", "shifted.py")
        clean = self.run_cli("check", "shifted.py")

        self.assertEqual(before.returncode, 1)
        self.assertIn("ERROR ANCHOR_DRIFTED", before.stdout)
        self.assertIn("action:", before.stdout)
        # Tracking still requires conscious review/stamping, so fixing an anchor returns 1.
        self.assertEqual(fixed.returncode, 1)
        self.assertEqual(payload["entries"][0]["anchor"]["start"], 2)
        self.assertEqual(stamped.returncode, 0, stamped.stdout)
        self.assertEqual(clean.returncode, 0, clean.stdout)

    def test_json_diagnostics_are_stable_and_cli_usage_exits_two(self) -> None:
        source = self.root / "plain.py"
        source.write_text("plain = True\n", encoding="utf-8")

        diagnostic_result, payload = self.run_json("check", "plain.py")
        usage_result = self.run_cli("query")

        self.assertEqual(diagnostic_result.returncode, 1)
        self.assertEqual(payload["schema_version"], 1)
        diagnostic = payload["diagnostics"][0]
        self.assertTrue(
            {"status", "severity", "code", "path", "message", "action"}.issubset(
                diagnostic
            )
        )
        self.assertEqual(diagnostic["status"], "needs_action")
        self.assertEqual(usage_result.returncode, 2)
        self.assertIn("query requires search text", usage_result.stderr)

    def test_default_cache_is_outside_project_and_index_override_is_honored(self) -> None:
        (self.root / "cache.py").write_text("cached = True\n", encoding="utf-8")
        with tempfile.TemporaryDirectory() as cache_dir:
            environment = os.environ.copy()
            environment["XDG_CACHE_HOME"] = cache_dir
            default_result = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    "--root",
                    str(self.root),
                    "index",
                    "--json",
                ],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            payload = json.loads(default_result.stdout)
            default_path = Path(payload["index"]["path"])
            self.assertEqual(default_result.returncode, 0)
            self.assertTrue(default_path.is_relative_to(Path(cache_dir)))
            self.assertFalse(default_path.is_relative_to(self.root))

        override_result, override_payload = self.run_json("index")
        self.assertEqual(override_result.returncode, 0)
        self.assertEqual(Path(override_payload["index"]["path"]), self.index.resolve())

    def test_legacy_validator_accepts_tracked_schema_and_repairs_anchors(self) -> None:
        source = self.root / "legacy.py"
        source.write_text("def legacy():\n    return True\n", encoding="utf-8")
        write_sidecar(self.root, source)

        clean = subprocess.run(
            [sys.executable, str(LEGACY_VALIDATOR), str(source)],
            check=False,
            capture_output=True,
            text=True,
        )
        source.write_text(
            "header = True\ndef legacy():\n    return True\n", encoding="utf-8"
        )
        repaired = subprocess.run(
            [sys.executable, str(LEGACY_VALIDATOR), str(source), "--fix"],
            check=False,
            capture_output=True,
            text=True,
        )
        data = json.loads(
            source.with_name("legacy.py._llm.json").read_text(encoding="utf-8")
        )

        self.assertEqual(clean.returncode, 0, clean.stdout)
        self.assertIn("all anchors valid", clean.stdout)
        self.assertEqual(repaired.returncode, 0, repaired.stdout)
        self.assertIn("FIXED", repaired.stdout)
        self.assertEqual(data["entries"][0]["anchor"]["start"], 2)


if __name__ == "__main__":
    unittest.main()
