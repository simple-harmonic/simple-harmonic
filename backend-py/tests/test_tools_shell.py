"""Shell tool tests: run_command is SHELL-FREE.

TS source: packages/backend/tests/unit/server-tools.test.ts (shell group)
         + packages/backend/tests/unit/security/tools-security.test.ts

The load-bearing property: shell metacharacters (``;`` ``&&`` ``|`` ``$(...)``
backtick ``>``) are passed to the program as INERT literal argv tokens — there
is no shell — so they are echoed verbatim and produce NO side-effect file in the
jail. The only program these tests spawn is ``echo`` (allowlisted, on PATH);
everything else is rejected before any spawn, so the suite stays offline and
never runs an arbitrary CLI.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic.tools.shell import RunCommandArgs, run_command_def, run_command_impl
from simple_harmonic.tools.types import ToolRunContext


def ctx() -> ToolRunContext:
    return ToolRunContext(teamId="t1", agentId="a1", agentName="agent", peers=[])


@pytest.fixture
def jail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    jail_dir = tmp_path / "jail"
    jail_dir.mkdir()
    monkeypatch.setenv("SH_TOOLS_CWD", str(jail_dir))
    monkeypatch.setenv("SH_ENABLE_TOOLS", "1")
    yield jail_dir


def test_run_command_is_destructive_shell_tool() -> None:
    assert run_command_def.risk == "destructive"
    assert run_command_def.category == "shell"


# --- the core property: metachars are inert literal args --------------------

# (payload, marker the metachar would create if a shell interpreted it)
INJECTION_CASES = [
    ("hi; touch pwned_semi", "pwned_semi"),
    ("hi && touch pwned_and", "pwned_and"),
    ("hi | tee pwned_pipe", "pwned_pipe"),
    ("$(touch pwned_subshell)", "pwned_subshell"),
    ("`touch pwned_backtick`", "pwned_backtick"),
    ("hi > pwned_redirect", "pwned_redirect"),
]


@pytest.mark.parametrize(("payload", "marker"), INJECTION_CASES)
async def test_metachars_are_literal_no_side_effect(jail: Path, payload: str, marker: str) -> None:
    res = await run_command_impl(RunCommandArgs(command="echo", args=[payload]), ctx())
    assert res.success is True
    # Echoed verbatim — no shell substitution or expansion.
    assert payload in res.result
    # No metachar was interpreted: the side-effect file does NOT exist.
    assert not (jail / marker).exists()
    # Nothing at all leaked into the jail.
    assert list(jail.iterdir()) == []


async def test_run_command_records_action(jail: Path) -> None:
    res = await run_command_impl(RunCommandArgs(command="echo", args=["plain"]), ctx())
    assert res.success is True
    assert res.action is not None
    assert res.action.actionType == "command_run"
    assert res.action.payload["command"] == "echo"


# --- allowlist + git subcommand gating --------------------------------------


@pytest.mark.parametrize("prog", ["sh", "bash", "curl", "python3", "rm", "/bin/sh"])
async def test_off_allowlist_programs_rejected(jail: Path, prog: str) -> None:
    res = await run_command_impl(RunCommandArgs(command=prog, args=[]), ctx())
    assert res.success is False
    assert "not allowed" in res.result


@pytest.mark.parametrize("sub", ["clean", "gc", "filter-branch", "reflog"])
async def test_dangerous_git_subcommands_rejected(jail: Path, sub: str) -> None:
    res = await run_command_impl(RunCommandArgs(command="git", args=[sub]), ctx())
    assert res.success is False
    assert "not allowed" in res.result


async def test_escaping_arg_rejected(jail: Path) -> None:
    res = await run_command_impl(RunCommandArgs(command="cat", args=["../../etc/passwd"]), ctx())
    assert res.success is False
    assert "outside the working directory" in res.result


async def test_disabled_without_kill_switch(jail: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    res = await run_command_impl(RunCommandArgs(command="echo", args=["hi"]), ctx())
    assert res.success is False
    assert "disabled" in res.result
