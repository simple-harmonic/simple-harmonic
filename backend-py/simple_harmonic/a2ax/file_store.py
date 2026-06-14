"""Synchronous file-store primitives for the JSON-file transport.

TS source: packages/a2ax/src/storage/file-store.ts

Self-contained (the a2ax package must not depend on the backend store). Mirrors
the backend's fs primitives: atomic JSON writes (temp + rename), JSONL append
logs + bulk rewrite, and a recursive walk that locates team folders by the
team.json marker.

These are plain blocking helpers, identical in spirit to
simple_harmonic.store.fs. The JsonFileTransport calls them off the event loop
via `anyio.to_thread.run_sync`.
"""

from __future__ import annotations

import json
from pathlib import Path


def _ensure_dir(file_path: Path) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)


def read_json[T](path: Path, fallback: T) -> T:
    """Read+parse a JSON file. Missing or empty file -> fallback."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return fallback
    if raw.strip() == "":
        return fallback
    return json.loads(raw)


def write_json(path: Path, value: object) -> None:
    """Atomically write a pretty-printed JSON file (temp + rename)."""
    _ensure_dir(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_jsonl[T](path: Path) -> list[T]:
    """Read a JSONL file into a list. Missing -> []. Blank lines skipped."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    out: list[T] = []
    for line in raw.split("\n"):
        if line.strip() == "":
            continue
        out.append(json.loads(line))
    return out


def append_jsonl(path: Path, row: object) -> None:
    _ensure_dir(path)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def rewrite_jsonl(path: Path, rows: list[object]) -> None:
    """Atomically rewrite a JSONL file from `rows` (empty list -> empty file)."""
    _ensure_dir(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    body = "" if len(rows) == 0 else "\n".join(json.dumps(r) for r in rows) + "\n"
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


def _list_subdirs(directory: Path) -> list[str]:
    try:
        return [p.name for p in directory.iterdir() if p.is_dir()]
    except FileNotFoundError:
        return []


def discover_team_message_dirs(teams_root: Path) -> dict[str, Path]:
    """Walk the recursive team tree and return teamId -> its messages/ dir.

    A folder is a team if it contains team.json; its children live in its teams/
    subfolder. TS source: discoverTeamMessageDirs.
    """
    out: dict[str, Path] = {}

    def walk(container: Path) -> None:
        for team_id in _list_subdirs(container):
            team_dir = container / team_id
            if not (team_dir / "team.json").exists():
                continue
            out[team_id] = team_dir / "messages"
            walk(team_dir / "teams")

    walk(teams_root)
    return out
