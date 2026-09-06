#!/usr/bin/env python3
"""Shared types, paths, fingerprints, and format discovery for sidecar tools."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SIDECAR_SUFFIX = "._llm.json"
TOOL_VERSION = "2.0.0"
OUTPUT_SCHEMA_VERSION = 1
INDEX_FORMAT = "llm-sidecar-sqlite-fts"
INDEX_SCHEMA_VERSION = 2
SIDECAR_SCHEMA_VERSION = 1
FORMAT_CATALOG_VERSION = 1

SKIP_DIRS = {
    ".cache",
    "third_party",
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
    ".venv",
}

FORMAT_BY_SUFFIX = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "c-header",
    ".hh": "cpp-header",
    ".hpp": "cpp-header",
    ".hxx": "cpp-header",
    ".cs": "csharp",
    ".go": "go",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript-jsx",
    ".json": "json",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".lua": "lua",
    ".m": "objective-c",
    ".mm": "objective-cpp",
    ".md": "markdown",
    ".php": "php",
    ".pl": "perl",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".swift": "swift",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "typescript-tsx",
    ".vue": "vue",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zig": "zig",
}

FORMAT_BY_NAME = {
    "CMakeLists.txt": "cmake",
    "Dockerfile": "dockerfile",
    "GNUmakefile": "make",
    "Makefile": "make",
}


@dataclass(frozen=True)
class Diagnostic:
    """Stable machine-readable prompt for work the caller must consciously resolve."""

    code: str
    severity: str
    path: str
    message: str
    action: str
    entry_id: str | None = None
    status: str = "needs_action"

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "entry_id": self.entry_id,
            "message": self.message,
            "action": self.action,
        }


def diagnostic(
    code: str,
    severity: str,
    path: Path,
    message: str,
    action: str,
    entry_id: str | None = None,
) -> Diagnostic:
    return Diagnostic(code, severity, str(path), message, action, entry_id)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def format_for(path: Path) -> str:
    if path.name in FORMAT_BY_NAME:
        return FORMAT_BY_NAME[path.name]
    suffix = path.suffix.lower()
    if suffix in FORMAT_BY_SUFFIX:
        return FORMAT_BY_SUFFIX[suffix]
    if not suffix:
        try:
            first = path.open("rb").readline(256).decode("utf-8", errors="ignore")
        except OSError:
            return "text"
        if first.startswith("#!"):
            if "python" in first:
                return "python"
            if any(shell in first for shell in ("/sh", "bash", "zsh")):
                return "shell"
    return "text"


def format_fingerprint(file_format: str) -> str:
    material = f"format-catalog:{FORMAT_CATALOG_VERSION}\0{file_format}".encode()
    return sha256_bytes(material)


def is_source_candidate(path: Path) -> bool:
    return path.name in FORMAT_BY_NAME or path.suffix.lower() in FORMAT_BY_SUFFIX


def source_for_sidecar(sidecar: Path) -> Path:
    return sidecar.with_name(sidecar.name[: -len(SIDECAR_SUFFIX)])


def sidecar_for_source(source: Path) -> Path:
    return source.with_name(source.name + SIDECAR_SUFFIX)


def relative_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def source_from_argument(argument: str, root: Path) -> Path:
    path = Path(argument)
    if not path.is_absolute():
        path = root / path
    if path.name.endswith(SIDECAR_SUFFIX):
        return source_for_sidecar(path)
    return path


def default_index_path(root: Path) -> Path:
    """Return an install-safe disposable cache path outside the project tree."""

    cache_root = Path(
        os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))
    ).expanduser()
    root_key = sha256_bytes(str(root.resolve()).encode())[:20]
    return cache_root / "llm-sidecar" / root_key / "index.sqlite3"
