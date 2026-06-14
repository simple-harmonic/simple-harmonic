"""Adversarial coverage for the tool sandbox.

TS source: packages/backend/tests/unit/security/tools-security.test.ts

Groups: path traversal & symlink escape (read/write), command injection
(run_command argv vs shell), argument validation via the registry, env
scrubbing, and the destructive kill-switch boundary. These are the cases the
sandbox MUST hold before SH_ENABLE_TOOLS is flipped on a real checkout.

Everything runs offline: run_command only ever invokes ``echo`` (allowlisted,
present on the PATH) and the github_api network path is never reached (the
kill-switch test asserts proxy_fetch is not called; proxy_fetch is patched to a
mock that raises if hit).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic import proxy_fetch as proxy_fetch_mod
from simple_harmonic.tools.filesystem import read_file_impl, write_file_impl
from simple_harmonic.tools.index import create_app_registry
from simple_harmonic.tools.network import github_api_impl
from simple_harmonic.tools.sandbox import (
    JailEscapeError,
    resolve_in_jail,
    resolve_in_jail_real,
    scrubbed_env,
)
from simple_harmonic.tools.shell import run_command_impl
from simple_harmonic.tools.types import ToolRunContext


def ctx() -> ToolRunContext:
    return ToolRunContext(teamId="t1", agentId="a1", agentName="agent", peers=[])


@pytest.fixture
def jail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Path, Path]]:
    """An isolated jail dir + an outside dir, with SH_TOOLS_CWD pinned to the
    jail and the destructive kill switch ON (we exercise dangerous paths on
    purpose). tmp_path may itself be under a symlinked /tmp; the symlink-aware
    check realpaths the jail root so legitimate inside-jail access still works."""
    jail_dir = tmp_path / "jail"
    outside_dir = tmp_path / "outside"
    jail_dir.mkdir()
    outside_dir.mkdir()
    monkeypatch.setenv("SH_TOOLS_CWD", str(jail_dir))
    monkeypatch.setenv("SH_ENABLE_TOOLS", "1")
    yield jail_dir, outside_dir


# --- path traversal (logical) ----------------------------------------------

ESCAPES = [
    "../escape.txt",
    "../../etc/passwd",
    "../../../../../../etc/passwd",
    "a/../../b",
    "/etc/passwd",
    "/",
]


@pytest.mark.parametrize("p", ESCAPES)
def test_resolve_in_jail_rejects_traversal(jail, p: str) -> None:
    with pytest.raises(JailEscapeError):
        resolve_in_jail(p)


def test_resolve_in_jail_rejects_null_byte(jail) -> None:
    with pytest.raises(JailEscapeError):
        resolve_in_jail("ok.txt\0../../etc/passwd")


def test_resolve_in_jail_allows_nested_path(jail) -> None:
    # Does not raise.
    resolve_in_jail("sub/dir/file.txt")


async def test_read_file_refuses_traversal_end_to_end(jail) -> None:
    _jail_dir, outside_dir = jail
    (outside_dir / "secret.txt").write_text("TOPSECRET")
    res = await read_file_impl(
        type("A", (), {"path": "../outside/secret.txt"})(), ctx()
    )
    assert res.success is False
    assert "TOPSECRET" not in res.result


# --- symlink escape (symlink-aware) ----------------------------------------


async def test_resolve_in_jail_real_rejects_symlinked_dir_pointing_outside(jail) -> None:
    jail_dir, outside_dir = jail
    (outside_dir / "secret.txt").write_text("TOPSECRET")
    os.symlink(outside_dir, jail_dir / "link")
    with pytest.raises(JailEscapeError):
        await resolve_in_jail_real("link/secret.txt")


async def test_resolve_in_jail_real_rejects_symlinked_file_pointing_outside(jail) -> None:
    jail_dir, outside_dir = jail
    (outside_dir / "secret.txt").write_text("TOPSECRET")
    os.symlink(outside_dir / "secret.txt", jail_dir / "alias.txt")
    with pytest.raises(JailEscapeError):
        await resolve_in_jail_real("alias.txt")


async def test_read_file_does_not_leak_through_symlink(jail) -> None:
    jail_dir, outside_dir = jail
    (outside_dir / "secret.txt").write_text("TOPSECRET")
    os.symlink(outside_dir / "secret.txt", jail_dir / "alias.txt")
    res = await read_file_impl(type("A", (), {"path": "alias.txt"})(), ctx())
    assert res.success is False
    assert "TOPSECRET" not in res.result


async def test_write_file_refuses_symlinked_dir_pointing_outside(jail) -> None:
    jail_dir, outside_dir = jail
    os.symlink(outside_dir, jail_dir / "link")
    res = await write_file_impl(
        type("A", (), {"path": "link/evil.txt", "content": "x"})(), ctx()
    )
    assert res.success is False
    # The file must NOT exist outside the jail.
    assert not (outside_dir / "evil.txt").exists()


async def test_allows_symlink_that_stays_inside_jail(jail) -> None:
    jail_dir, _outside = jail
    (jail_dir / "real").mkdir()
    (jail_dir / "real" / "f.txt").write_text("inside")
    os.symlink(jail_dir / "real", jail_dir / "innerlink")
    res = await read_file_impl(type("A", (), {"path": "innerlink/f.txt"})(), ctx())
    assert res.success is True
    assert res.result == "inside"


# --- command injection (run_command is shell-free) -------------------------

INJECTION_PAYLOADS = [
    "hi; touch pwned1",
    "hi && touch pwned2",
    "hi | tee pwned3",
    "$(touch pwned4)",
    "`touch pwned5`",
    "hi > pwned6",
]


@pytest.mark.parametrize("payload", INJECTION_PAYLOADS)
async def test_run_command_treats_metachars_as_literal(jail, payload: str) -> None:
    jail_dir, _outside = jail
    res = await run_command_impl(
        type("A", (), {"command": "echo", "args": [payload]})(), ctx()
    )
    assert res.success is True
    # Echoed verbatim (no substitution).
    assert payload in res.result
    # No shell side-effect file landed in the jail.
    for marker in ["pwned1", "pwned2", "pwned3", "pwned4", "pwned5", "pwned6"]:
        assert not (jail_dir / marker).exists()


@pytest.mark.parametrize("prog", ["rm", "sh", "bash", "curl", "python3", "/bin/sh"])
async def test_run_command_refuses_off_allowlist_programs(jail, prog: str) -> None:
    res = await run_command_impl(type("A", (), {"command": prog, "args": []})(), ctx())
    assert res.success is False
    assert "not allowed" in res.result


@pytest.mark.parametrize("sub", ["clean", "gc", "filter-branch", "reflog"])
async def test_run_command_refuses_dangerous_git_subcommands(jail, sub: str) -> None:
    res = await run_command_impl(type("A", (), {"command": "git", "args": [sub]})(), ctx())
    assert res.success is False
    assert "not allowed" in res.result


@pytest.mark.parametrize("sub", ["push", "commit", "checkout", "add"])
async def test_run_command_allows_write_git_subcommands(jail, sub: str) -> None:
    # On the allowlist; will fail with a git error (no repo), not "not allowed".
    res = await run_command_impl(type("A", (), {"command": "git", "args": [sub]})(), ctx())
    assert "not allowed" not in res.result


async def test_run_command_disabled_without_kill_switch(
    jail, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    res = await run_command_impl(type("A", (), {"command": "echo", "args": ["hi"]})(), ctx())
    assert res.success is False
    assert "disabled" in res.result


# --- env scrubbing ----------------------------------------------------------


def test_scrubbed_env_strips_secret_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")
    monkeypatch.setenv("DATABASE_URL", "postgres://u:pw@host/db")
    env = scrubbed_env()
    assert "ANTHROPIC_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert "GITHUB_TOKEN" not in env
    assert "DATABASE_URL" not in env


def test_scrubbed_env_keeps_path() -> None:
    assert scrubbed_env().get("PATH") == os.environ.get("PATH")


async def test_run_command_cannot_echo_secret(
    jail, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-LEAKME")
    # Interpreters are not allowlisted; this blocks the most direct bypass.
    res = await run_command_impl(
        type("A", (), {"command": "node", "args": ["-e", "process.env.ANTHROPIC_API_KEY"]})(),
        ctx(),
    )
    assert res.success is False
    assert "LEAKME" not in res.result
    assert "not allowed" in res.result


# --- argument validation via the registry ----------------------------------


async def test_registry_rejects_wrong_typed_args() -> None:
    r = create_app_registry()
    res = await r.execute("read_file", {"path": 123}, ctx())
    assert res.success is False
    assert "Invalid arguments for read_file" in res.result


async def test_registry_rejects_missing_required_fields() -> None:
    r = create_app_registry()
    res = await r.execute("write_file", {"path": "x.txt"}, ctx())
    assert res.success is False
    assert "Invalid arguments for write_file" in res.result


async def test_registry_rejects_unknown_tool_name() -> None:
    r = create_app_registry()
    res = await r.execute("exec_anything", {"cmd": "rm -rf /"}, ctx())
    assert res.success is False
    assert "Unknown tool" in res.result


async def test_registry_rejects_non_url_for_http_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    async def boom(*_a, **_k):
        calls["n"] += 1
        raise AssertionError("proxy_fetch must not be called")

    monkeypatch.setattr(proxy_fetch_mod, "proxy_fetch", boom)
    r = create_app_registry()
    res = await r.execute("http_fetch", {"url": "not a url"}, ctx())
    assert res.success is False
    assert "Invalid arguments for http_fetch" in res.result
    assert calls["n"] == 0


# --- destructive boundary: classifier + kill switch ------------------------


def test_registry_marks_mutating_tools_destructive() -> None:
    r = create_app_registry()
    assert r.is_destructive("write_file") is True
    assert r.is_destructive("run_command") is True
    assert r.is_destructive("github_api", {"method": "POST", "path": "/repos/o/r/issues"}) is True
    assert r.is_destructive("github_api", {"method": "GET", "path": "/repos/o/r"}) is False
    assert r.is_destructive("github_api") is True
    assert r.is_destructive("read_file") is False
    assert r.is_destructive("http_fetch") is False
    assert r.is_destructive("send_message") is False
    # Unknown tools are treated as destructive (fail safe).
    assert r.is_destructive("ghost") is True


async def test_github_api_write_blocked_without_kill_switch_even_with_token(
    jail, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")

    called = {"n": 0}

    async def boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("proxy_fetch must not be called")

    # Patch on the network module's reference (it imported the name directly).
    import simple_harmonic.tools.network as network_mod

    monkeypatch.setattr(network_mod, "proxy_fetch", boom)

    res = await github_api_impl(
        type("A", (), {"method": "DELETE", "path": "/repos/o/r", "body": None})(), ctx()
    )
    assert res.success is False
    assert "disabled" in res.result
    assert called["n"] == 0
