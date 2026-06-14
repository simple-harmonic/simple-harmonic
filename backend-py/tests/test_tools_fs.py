"""Filesystem tool tests: read_file / write_file with the path jail enforced.

TS source: packages/backend/tests/unit/server-tools.test.ts (filesystem group)
         + packages/backend/tests/unit/security/tools-security.test.ts

Fully offline: every path resolves under an isolated SH_TOOLS_CWD temp jail; no
network and no external process. The jail root may itself live under a symlinked
/tmp (macOS), which the symlink-aware resolver realpaths, so legitimate
inside-jail access still succeeds.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic.tools.filesystem import (
    ReadFileArgs,
    WriteFileArgs,
    read_file_def,
    read_file_impl,
    write_file_def,
    write_file_impl,
)
from simple_harmonic.tools.types import ToolRunContext


def ctx() -> ToolRunContext:
    return ToolRunContext(teamId="t1", agentId="a1", agentName="agent", peers=[])


@pytest.fixture
def jail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Path, Path]]:
    """Isolated jail + an outside dir; kill switch ON so write_file is reachable."""
    jail_dir = tmp_path / "jail"
    outside_dir = tmp_path / "outside"
    jail_dir.mkdir()
    outside_dir.mkdir()
    monkeypatch.setenv("SH_TOOLS_CWD", str(jail_dir))
    monkeypatch.setenv("SH_ENABLE_TOOLS", "1")
    yield jail_dir, outside_dir


# --- definitions ------------------------------------------------------------


def test_read_file_is_safe_and_write_is_destructive() -> None:
    assert read_file_def.risk == "safe"
    assert read_file_def.category == "filesystem"
    assert write_file_def.risk == "destructive"
    assert write_file_def.category == "filesystem"


# --- read_file --------------------------------------------------------------


async def test_read_file_reads_inside_jail(jail) -> None:
    jail_dir, _outside = jail
    (jail_dir / "note.txt").write_text("inside-content")
    res = await read_file_impl(ReadFileArgs(path="note.txt"), ctx())
    assert res.success is True
    assert res.result == "inside-content"
    assert res.action is not None
    assert res.action.actionType == "file_read"


async def test_read_file_missing_file(jail) -> None:
    res = await read_file_impl(ReadFileArgs(path="nope.txt"), ctx())
    assert res.success is False
    assert "not found" in res.result.lower()


@pytest.mark.parametrize(
    "path",
    ["../outside/secret.txt", "../../etc/passwd", "/etc/passwd", "a/../../b"],
)
async def test_read_file_rejects_traversal(jail, path: str) -> None:
    _jail_dir, outside_dir = jail
    (outside_dir / "secret.txt").write_text("TOPSECRET")
    res = await read_file_impl(ReadFileArgs(path=path), ctx())
    assert res.success is False
    assert "TOPSECRET" not in res.result


async def test_read_file_refuses_sensitive_path(jail) -> None:
    jail_dir, _outside = jail
    (jail_dir / ".simple-harmonic").mkdir()
    (jail_dir / ".simple-harmonic" / "secrets.json").write_text('{"GITHUB_TOKEN":"ghp_x"}')
    res = await read_file_impl(ReadFileArgs(path=".simple-harmonic/secrets.json"), ctx())
    assert res.success is False
    assert "sensitive" in res.result.lower()
    assert "ghp_x" not in res.result


# --- write_file -------------------------------------------------------------


async def test_write_file_writes_inside_jail(jail) -> None:
    jail_dir, _outside = jail
    res = await write_file_impl(WriteFileArgs(path="sub/dir/out.txt", content="payload"), ctx())
    assert res.success is True
    assert (jail_dir / "sub" / "dir" / "out.txt").read_text() == "payload"
    assert res.action is not None
    assert res.action.actionType == "file_written"


@pytest.mark.parametrize("path", ["../outside/evil.txt", "../../tmp/evil.txt", "/tmp/evil.txt"])
async def test_write_file_rejects_traversal_and_writes_nothing(jail, path: str) -> None:
    _jail_dir, outside_dir = jail
    res = await write_file_impl(WriteFileArgs(path=path, content="x"), ctx())
    assert res.success is False
    assert not (outside_dir / "evil.txt").exists()
