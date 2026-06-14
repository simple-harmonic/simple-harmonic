"""Low-level filesystem primitives for the JSON store (atomic write + rename).

TS source: packages/backend/src/server/store/fs-store.ts

Unlike the TS version (which relies on Node's single-threaded synchronous IO),
these are plain blocking helpers. The FastAPI store calls them off the event
loop via `anyio.to_thread.run_sync`.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

from simple_harmonic.store.serialize import json_default


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def path_exists(path: Path) -> bool:
    return path.exists()


def read_json[T](path: Path, fallback: T) -> T:
    """Read+parse a JSON file. Missing or empty file -> fallback. Corrupt raises."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return fallback
    if raw.strip() == "":
        return fallback
    return json.loads(raw)


def write_json(path: Path, value: object) -> None:
    """Atomically write a pretty-printed JSON file (temp + rename)."""
    _ensure_parent(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, default=json_default) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def update_json[T](path: Path, fallback: T, mutate: Callable[[T], T]) -> T:
    """Read -> mutate -> write a JSON file atomically. Returns the written value."""
    nxt = mutate(read_json(path, fallback))
    write_json(path, nxt)
    return nxt


def read_jsonl(path: Path) -> list[object]:
    """Read a JSONL file into a list. Missing -> []. Blank lines skipped."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    out: list[object] = []
    for line in raw.split("\n"):
        if line.strip() == "":
            continue
        out.append(json.loads(line))
    return out


def append_jsonl(path: Path, row: object) -> None:
    _ensure_parent(path)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, default=json_default) + "\n")


def append_jsonl_many(path: Path, rows: list[object]) -> None:
    """Append many rows to a JSONL file in one write. Empty list is a no-op."""
    if not rows:
        return
    _ensure_parent(path)
    payload = "\n".join(json.dumps(r, default=json_default) for r in rows) + "\n"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(payload)


def rewrite_jsonl(path: Path, rows: list[object]) -> None:
    """Atomically rewrite a JSONL file (used by retention/prune)."""
    _ensure_parent(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    body = "" if not rows else "\n".join(json.dumps(r, default=json_default) for r in rows) + "\n"
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, path)


def move_path(src: Path, dst: Path) -> None:
    """Move a file or directory subtree to a new path (creates the parent)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)


def remove_path(path: Path) -> None:
    """Remove a file or directory subtree if it exists."""
    if path.is_dir():
        import shutil

        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def list_subdirs(directory: Path) -> list[str]:
    """Names of immediate sub-directories. Missing parent -> []."""
    try:
        return sorted(p.name for p in directory.iterdir() if p.is_dir())
    except FileNotFoundError:
        return []


def list_files(directory: Path) -> list[str]:
    """Names of immediate files. Missing parent -> []."""
    try:
        return sorted(p.name for p in directory.iterdir() if p.is_file())
    except FileNotFoundError:
        return []
