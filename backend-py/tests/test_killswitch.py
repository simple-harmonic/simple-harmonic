"""Destructive-tools kill switch: SH_ENABLE_TOOLS gates the dangerous tools.

TS source: packages/backend/tests/unit/security/tools-security.test.ts
         + packages/backend/tests/unit/server-tools.test.ts

The boundary under test: with SH_ENABLE_TOOLS unset, write_file, run_command,
coding_task, and MUTATING github_api / api_tool calls are BLOCKED and never
touch the filesystem / spawn a process / hit the network. read_file, http_fetch
GET, and GET github_api are NOT gated by this switch.

Fully offline: the kill-switch check short-circuits before any spawn or fetch,
so no external CLI runs and no socket opens. The two network spies raise if the
network layer is ever reached on a blocked call.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

import simple_harmonic.tools.coding.index as coding_index
import simple_harmonic.tools.network as network_mod
from simple_harmonic.tools.coding import coding_task_impl
from simple_harmonic.tools.coding.index import CodingTaskArgs
from simple_harmonic.tools.filesystem import WriteFileArgs, write_file_impl
from simple_harmonic.tools.network import GitHubApiArgs, github_api_impl
from simple_harmonic.tools.shell import RunCommandArgs, run_command_impl
from simple_harmonic.tools.types import ToolRunContext


def ctx() -> ToolRunContext:
    return ToolRunContext(teamId="t1", agentId="a1", agentName="agent", peers=[])


@pytest.fixture
def jail_off(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Jail with the kill switch explicitly OFF."""
    jail_dir = tmp_path / "jail"
    jail_dir.mkdir()
    monkeypatch.setenv("SH_TOOLS_CWD", str(jail_dir))
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    yield jail_dir


async def test_write_file_blocked_and_writes_nothing(jail_off: Path) -> None:
    res = await write_file_impl(WriteFileArgs(path="out.txt", content="x"), ctx())
    assert res.success is False
    assert "disabled" in res.result
    assert not (jail_off / "out.txt").exists()


async def test_run_command_blocked_and_no_spawn(
    jail_off: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # If the gate were bypassed it would try to spawn; assert the gate fires
    # first by patching create_subprocess_exec to raise.
    import asyncio

    async def boom(*_a, **_k):
        raise AssertionError("must not spawn when kill switch is off")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)
    res = await run_command_impl(RunCommandArgs(command="echo", args=["hi"]), ctx())
    assert res.success is False
    assert "disabled" in res.result


async def test_coding_task_blocked_and_no_backend_run(
    jail_off: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a, **_k):
        raise AssertionError("must not select/run a backend when kill switch is off")

    monkeypatch.setattr(coding_index, "create_coding_backend", boom)
    res = await coding_task_impl(CodingTaskArgs(task="do something"), ctx())
    assert res.success is False
    assert "disabled" in res.result


async def test_github_mutating_blocked_before_fetch(
    jail_off: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")

    async def boom(*_a, **_k):
        raise AssertionError("proxy_fetch must not be called for a blocked write")

    monkeypatch.setattr(network_mod, "proxy_fetch", boom)
    res = await github_api_impl(
        GitHubApiArgs(method="DELETE", path="/repos/o/r", body=None), ctx()
    )
    assert res.success is False
    assert "disabled" in res.result


async def test_github_get_not_gated_by_kill_switch(
    jail_off: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A GET is read-only: it is NOT blocked by the kill switch. We stop it at the
    # DNS seam so no network is touched, and assert the failure is NOT "disabled".
    from simple_harmonic.tools import url_guard

    async def resolve_fail(_host: str):
        raise OSError("no dns in test")

    monkeypatch.setattr(url_guard, "_resolve_all", resolve_fail)
    res = await github_api_impl(GitHubApiArgs(method="GET", path="/repos/o/r"), ctx())
    assert res.success is False
    assert "disabled" not in res.result
