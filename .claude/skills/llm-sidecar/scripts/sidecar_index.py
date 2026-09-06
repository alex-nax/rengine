#!/usr/bin/env python3
"""Disposable, incremental SQLite search index for code and LLM sidecars."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from sidecar_common import (
    FORMAT_CATALOG_VERSION,
    INDEX_FORMAT,
    INDEX_SCHEMA_VERSION,
    SIDECAR_SCHEMA_VERSION,
    SIDECAR_SUFFIX,
    SKIP_DIRS,
    TOOL_VERSION,
    format_fingerprint,
    format_for,
    is_source_candidate,
    relative_path,
    sha256_bytes,
    source_for_sidecar,
)


def _create_schema(connection: sqlite3.Connection, root: Path) -> None:
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
            path TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            source_path TEXT,
            format TEXT NOT NULL,
            format_fingerprint TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL,
            ctime_ns INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            content TEXT NOT NULL
        );
        CREATE INDEX files_kind_source ON files(kind, source_path);
        CREATE TABLE entries (
            sidecar_path TEXT NOT NULL,
            source_path TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            kind TEXT,
            start_line INTEGER,
            end_line INTEGER,
            symbol TEXT,
            snippet TEXT,
            note TEXT,
            refs_json TEXT,
            PRIMARY KEY(sidecar_path, entry_id)
        );
        CREATE INDEX entries_source ON entries(source_path);
        CREATE TABLE search_docs (
            doc_key TEXT PRIMARY KEY,
            owner_path TEXT NOT NULL,
            source_path TEXT NOT NULL,
            doc_kind TEXT NOT NULL,
            content TEXT NOT NULL
        );
        CREATE INDEX search_docs_source ON search_docs(source_path);
        CREATE INDEX search_docs_owner ON search_docs(owner_path);
        CREATE TABLE trigrams (
            gram TEXT NOT NULL,
            doc_key TEXT NOT NULL,
            source_path TEXT NOT NULL,
            doc_kind TEXT NOT NULL,
            PRIMARY KEY(gram, doc_key)
        ) WITHOUT ROWID;
        CREATE INDEX trigrams_source ON trigrams(source_path);
        """
    )
    fts5 = True
    try:
        connection.execute(
            "CREATE VIRTUAL TABLE search_fts USING fts5("
            "doc_key UNINDEXED, source_path UNINDEXED, doc_kind UNINDEXED, content, "
            "tokenize='unicode61')"
        )
    except sqlite3.OperationalError:
        fts5 = False
    connection.execute(f"PRAGMA user_version={INDEX_SCHEMA_VERSION}")
    metadata = {
        "index_format": INDEX_FORMAT,
        "index_schema_version": str(INDEX_SCHEMA_VERSION),
        "sidecar_schema_version": str(SIDECAR_SCHEMA_VERSION),
        "format_catalog_version": str(FORMAT_CATALOG_VERSION),
        "tool_version": TOOL_VERSION,
        "root": str(root.resolve()),
        "fts5": "1" if fts5 else "0",
    }
    connection.executemany("INSERT INTO meta(key, value) VALUES (?, ?)", metadata.items())
    connection.commit()


def _index_mismatch(connection: sqlite3.Connection, root: Path) -> str | None:
    try:
        user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        metadata = dict(connection.execute("SELECT key, value FROM meta"))
    except sqlite3.DatabaseError:
        return "unreadable_index"
    expected = {
        "index_format": INDEX_FORMAT,
        "index_schema_version": str(INDEX_SCHEMA_VERSION),
        "sidecar_schema_version": str(SIDECAR_SCHEMA_VERSION),
        "format_catalog_version": str(FORMAT_CATALOG_VERSION),
        "root": str(root.resolve()),
    }
    if user_version != INDEX_SCHEMA_VERSION:
        return "index_schema_version_changed"
    for key, value in expected.items():
        if metadata.get(key) != value:
            return f"{key}_changed"
    if metadata.get("fts5") not in {"0", "1"}:
        return "search_capability_changed"
    return None


def _remove_database(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


def open_index(index_path: Path, root: Path) -> tuple[sqlite3.Connection, str | None]:
    """Open the project-specific cache, rebuilding on any contract mismatch."""

    rebuilt_reason: str | None = None
    if index_path.exists():
        try:
            existing = sqlite3.connect(index_path)
            mismatch = _index_mismatch(existing, root)
            existing.close()
        except sqlite3.DatabaseError:
            mismatch = "unreadable_index"
        if mismatch:
            rebuilt_reason = mismatch
            _remove_database(index_path)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    if not index_path.exists():
        connection = sqlite3.connect(index_path)
        _create_schema(connection, root)
        return connection, rebuilt_reason or "index_missing"
    connection = sqlite3.connect(index_path)
    connection.row_factory = sqlite3.Row
    return connection, rebuilt_reason


def discover_files(root: Path) -> dict[str, tuple[Path, str, str | None, str]]:
    discovered: dict[str, tuple[Path, str, str | None, str]] = {}
    sidecars: list[Path] = []
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRS)
        directory_path = Path(directory)
        for filename in sorted(filenames):
            path = directory_path / filename
            if path.is_symlink() or not path.is_file():
                continue
            relative = relative_path(path, root)
            if filename.endswith(SIDECAR_SUFFIX):
                sidecars.append(path)
                source = source_for_sidecar(path)
                discovered[relative] = (
                    path,
                    "sidecar",
                    relative_path(source, root),
                    "llm-sidecar-json-v1",
                )
            elif is_source_candidate(path):
                discovered[relative] = (path, "source", None, format_for(path))
    for sidecar in sidecars:
        source = source_for_sidecar(sidecar)
        if source.is_file() and not source.is_symlink():
            relative = relative_path(source, root)
            discovered.setdefault(relative, (source, "source", None, format_for(source)))
    return discovered


def _decode_text(path: Path) -> str | None:
    raw = path.read_bytes()
    if b"\0" in raw[:8192]:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def _trigrams(content: str) -> Iterable[str]:
    normalized = content.casefold()
    return sorted({normalized[index : index + 3] for index in range(len(normalized) - 2)})


def _delete_search_owner(connection: sqlite3.Connection, owner_path: str) -> None:
    keys = [
        row[0]
        for row in connection.execute(
            "SELECT doc_key FROM search_docs WHERE owner_path = ?", (owner_path,)
        )
    ]
    if keys and _fts_available(connection):
        connection.executemany("DELETE FROM search_fts WHERE doc_key = ?", ((key,) for key in keys))
    connection.execute("DELETE FROM trigrams WHERE doc_key IN "
                       "(SELECT doc_key FROM search_docs WHERE owner_path = ?)", (owner_path,))
    connection.execute("DELETE FROM search_docs WHERE owner_path = ?", (owner_path,))


def _add_search_doc(
    connection: sqlite3.Connection,
    *,
    doc_key: str,
    owner_path: str,
    source_path: str,
    doc_kind: str,
    content: str,
) -> None:
    connection.execute(
        "INSERT INTO search_docs(doc_key, owner_path, source_path, doc_kind, content) "
        "VALUES (?, ?, ?, ?, ?)",
        (doc_key, owner_path, source_path, doc_kind, content),
    )
    connection.executemany(
        "INSERT INTO trigrams(gram, doc_key, source_path, doc_kind) VALUES (?, ?, ?, ?)",
        ((gram, doc_key, source_path, doc_kind) for gram in _trigrams(content)),
    )
    if _fts_available(connection):
        connection.execute(
            "INSERT INTO search_fts(doc_key, source_path, doc_kind, content) VALUES (?, ?, ?, ?)",
            (doc_key, source_path, doc_kind, content),
        )


def _fts_available(connection: sqlite3.Connection) -> bool:
    row = connection.execute("SELECT value FROM meta WHERE key='fts5'").fetchone()
    return bool(row and row[0] == "1")


def _replace_source_doc(
    connection: sqlite3.Connection, path: str, file_format: str, content: str
) -> None:
    _delete_search_owner(connection, path)
    _add_search_doc(
        connection,
        doc_key=f"source:{path}",
        owner_path=path,
        source_path=path,
        doc_kind="code",
        content=f"{path}\n{file_format}\n{content}",
    )


def _replace_sidecar_docs(
    connection: sqlite3.Connection, sidecar_path: str, source_path: str, content: str
) -> None:
    _delete_search_owner(connection, sidecar_path)
    connection.execute("DELETE FROM entries WHERE sidecar_path = ?", (sidecar_path,))
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        _add_search_doc(
            connection,
            doc_key=f"sidecar:{sidecar_path}",
            owner_path=sidecar_path,
            source_path=source_path,
            doc_kind="metadata-raw",
            content=f"{sidecar_path}\n{content}",
        )
        return
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        anchor = entry.get("anchor") if isinstance(entry.get("anchor"), dict) else {}
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            entry_id = f"__invalid_entry_{position}"
        refs = entry.get("refs")
        refs_json = json.dumps(refs) if isinstance(refs, list) else None
        values = (
            sidecar_path,
            source_path,
            entry_id,
            entry.get("kind") if isinstance(entry.get("kind"), str) else None,
            anchor.get("start") if isinstance(anchor.get("start"), int) else None,
            anchor.get("end") if isinstance(anchor.get("end"), int) else None,
            anchor.get("symbol") if isinstance(anchor.get("symbol"), str) else None,
            anchor.get("snippet") if isinstance(anchor.get("snippet"), str) else None,
            entry.get("note") if isinstance(entry.get("note"), str) else None,
            refs_json,
        )
        connection.execute(
            "INSERT OR REPLACE INTO entries(sidecar_path, source_path, entry_id, kind, "
            "start_line, end_line, symbol, snippet, note, refs_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            values,
        )
        searchable = "\n".join(str(value or "") for value in values[1:])
        _add_search_doc(
            connection,
            doc_key=f"entry:{sidecar_path}#{entry_id}",
            owner_path=sidecar_path,
            source_path=source_path,
            doc_kind="metadata",
            content=f"{sidecar_path}\n{searchable}",
        )


def refresh_index(
    connection: sqlite3.Connection, root: Path, *, full: bool = False
) -> dict[str, int]:
    discovered = discover_files(root)
    old_rows = {
        row["path"]: row
        for row in connection.execute(
            "SELECT path, kind, source_path, format, format_fingerprint, "
            "size, mtime_ns, ctime_ns FROM files"
        )
    }
    stats = {"discovered": len(discovered), "indexed": 0, "unchanged": 0, "removed": 0}
    for relative, (path, kind, source_path, file_format) in discovered.items():
        stat = path.stat()
        fingerprint = format_fingerprint(file_format)
        old = old_rows.get(relative)
        unchanged = (
            not full
            and old is not None
            and old["kind"] == kind
            and old["source_path"] == source_path
            and old["format"] == file_format
            and old["format_fingerprint"] == fingerprint
            and old["size"] == stat.st_size
            and old["mtime_ns"] == stat.st_mtime_ns
            and old["ctime_ns"] == stat.st_ctime_ns
        )
        if unchanged:
            stats["unchanged"] += 1
            continue
        content = _decode_text(path)
        if content is None:
            continue
        digest = sha256_bytes(content.encode("utf-8"))
        connection.execute(
            "INSERT INTO files(path, kind, source_path, format, format_fingerprint, size, "
            "mtime_ns, ctime_ns, sha256, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, source_path=excluded.source_path, "
            "format=excluded.format, format_fingerprint=excluded.format_fingerprint, "
            "size=excluded.size, mtime_ns=excluded.mtime_ns, ctime_ns=excluded.ctime_ns, "
            "sha256=excluded.sha256, content=excluded.content",
            (
                relative,
                kind,
                source_path,
                file_format,
                fingerprint,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
                digest,
                content,
            ),
        )
        if kind == "source":
            _replace_source_doc(connection, relative, file_format, content)
        elif source_path is not None:
            _replace_sidecar_docs(connection, relative, source_path, content)
        stats["indexed"] += 1

    missing = sorted(set(old_rows) - set(discovered))
    for relative in missing:
        _delete_search_owner(connection, relative)
        connection.execute("DELETE FROM entries WHERE sidecar_path = ?", (relative,))
        connection.execute("DELETE FROM files WHERE path = ?", (relative,))
    stats["removed"] = len(missing)
    connection.commit()
    return stats


def tracked_sources(connection: sqlite3.Connection) -> list[str]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT source_path FROM files WHERE kind='sidecar' ORDER BY source_path"
        )
    ]


def _fts_expression(query: str) -> str | None:
    tokens = re.findall(r"[\w]+", query.casefold(), flags=re.UNICODE)
    if not tokens:
        return None
    return " AND ".join(f'"{token.replace(chr(34), chr(34) * 2)}"' for token in tokens)


def _fts_candidates(connection: sqlite3.Connection, query: str, limit: int) -> set[str]:
    expression = _fts_expression(query)
    if not expression or not _fts_available(connection):
        return set()
    rows = connection.execute(
        "SELECT DISTINCT source_path FROM search_fts WHERE search_fts MATCH ? LIMIT ?",
        (expression, limit * 8),
    )
    return {row[0] for row in rows}


def _trigram_candidates(connection: sqlite3.Connection, query: str, limit: int) -> set[str]:
    grams = list(_trigrams(query))
    if not grams:
        return set()
    placeholders = ",".join("?" for _ in grams)
    rows = connection.execute(
        f"SELECT source_path FROM trigrams WHERE gram IN ({placeholders}) "
        "GROUP BY doc_key, source_path HAVING COUNT(DISTINCT gram) = ? LIMIT ?",
        (*grams, len(grams), limit * 8),
    )
    return {row[0] for row in rows}


def matching_paths(
    connection: sqlite3.Connection, query: str, limit: int
) -> tuple[list[str], list[str]]:
    """Use FTS and trigram indexes, then exact-verify candidates without a table scan."""

    if not query:
        return [], []
    fts = _fts_candidates(connection, query, limit)
    trigram = _trigram_candidates(connection, query, limit)
    candidates = fts | trigram
    verified: list[str] = []
    needle = query.casefold()
    for source_path in sorted(candidates):
        rows = connection.execute(
            "SELECT content FROM search_docs WHERE source_path = ?", (source_path,)
        )
        if any(needle in row[0].casefold() for row in rows):
            verified.append(source_path)
    modes = []
    if fts:
        modes.append("fts5")
    if trigram:
        modes.append("trigram")
    # One- and two-character searches cannot form trigrams. Keep a deterministic,
    # bounded compatibility fallback; substantive queries never use this scan.
    if len(query.casefold()) < 3 and not verified:
        rows = connection.execute(
            "SELECT DISTINCT source_path FROM search_docs WHERE instr(lower(content), lower(?)) > 0 "
            "ORDER BY source_path LIMIT ?",
            (query, limit),
        )
        verified = [row[0] for row in rows]
        modes.append("short-literal-scan")
    return verified[:limit], modes


def index_capabilities(connection: sqlite3.Connection) -> dict[str, Any]:
    return {
        "fts5": _fts_available(connection),
        "literal_index": "trigram",
        "short_query_fallback": "bounded-scan",
    }
