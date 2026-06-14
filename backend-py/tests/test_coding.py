"""coding_task tests: backend selection + command/env construction, parsing.

TS source: packages/backend/src/server/tools/coding/* (codex/claude-code/opencode,
           run-subprocess, index) and tests/unit/run-subprocess.test.ts

The subprocess is MOCKED: ``asyncio.create_subprocess_exec`` (the seam inside
run_subprocess) is patched to a fake process that returns canned JSONL on
stdout. No external CLI ever runs and no network is touched. We assert:
  - create_coding_backend selects codex / claude-code / opencode (+ rejects unknown)
  - each backend builds the exact argv its CLI expects
  - the child env is coding_env(): the scrubbed base + only the named provider
    keys; other secrets (e.g. GITHUB_TOKEN) are withheld
  - cwd handed to the child is the jail root
  - each backend's parse_events distills messages / commands / errors
  - run_subprocess truncates stdout on a line boundary and reports spawn failure
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

import simple_harmonic.tools.coding.run_subprocess as rs
from simple_harmonic.tools.coding import (
    build_summary,
    coding_task_impl,
    create_coding_backend,
)
from simple_harmonic.tools.coding.claude_code import create_claude_code_backend
from simple_harmonic.tools.coding.claude_code import parse_events as claude_parse
from simple_harmonic.tools.coding.codex import create_codex_backend
from simple_harmonic.tools.coding.codex import parse_events as codex_parse
from simple_harmonic.tools.coding.index import CodingTaskArgs
from simple_harmonic.tools.coding.opencode import create_opencode_backend
from simple_harmonic.tools.coding.opencode import parse_events as opencode_parse
from simple_harmonic.tools.coding.types import CodingCommand, CodingResult, CodingRunOpts
from simple_harmonic.tools.sandbox import JailEscapeError
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


class _FakeStream:
    """Async-iterable stdout/stderr backed by canned bytes lines."""

    def __init__(self, text: str) -> None:
        self._lines = [(line + "\n").encode() for line in text.split("\n") if line]

    def __aiter__(self):
        async def gen():
            for line in self._lines:
                yield line

        return gen()


class _FakeProc:
    def __init__(self, stdout: str, stderr: str = "", returncode: int = 0) -> None:
        self.stdout = _FakeStream(stdout)
        self.stderr = _FakeStream(stderr)
        self.returncode = returncode
        self._killed = False

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        self._killed = True


def _patch_spawn(monkeypatch: pytest.MonkeyPatch, stdout: str, *, returncode: int = 0,
                 stderr: str = "", capture: dict | None = None):
    async def fake_exec(cmd, *argv, cwd=None, env=None, **_kwargs):
        if capture is not None:
            capture["cmd"] = cmd
            capture["argv"] = list(argv)
            capture["cwd"] = cwd
            capture["env"] = env
        return _FakeProc(stdout, stderr, returncode)

    monkeypatch.setattr(rs.asyncio, "create_subprocess_exec", fake_exec)


# --- backend selection ------------------------------------------------------


def test_create_coding_backend_selects_by_name() -> None:
    assert create_coding_backend("codex").name == "codex"
    assert create_coding_backend("claude-code").name == "claude-code"
    assert create_coding_backend("opencode").name == "opencode"


def test_create_coding_backend_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # Default resolves from config; with no config file present it falls back to
    # the SH_CODING_BACKEND env / the codex default.
    monkeypatch.delenv("SH_CODING_BACKEND", raising=False)
    assert create_coding_backend().name == "codex"
    monkeypatch.setenv("SH_CODING_BACKEND", "opencode")
    assert create_coding_backend().name == "opencode"


def test_create_coding_backend_unknown_raises() -> None:
    with pytest.raises(ValueError, match="Unknown coding backend"):
        create_coding_backend("ghost")


# --- argv + env + cwd construction per backend ------------------------------


async def test_codex_builds_argv_and_scrubbed_env(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")  # must NOT leak
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")  # codex forwards this
    capture: dict = {}
    _patch_spawn(monkeypatch, json.dumps({"type": "item.completed",
                 "item": {"type": "agent_message", "text": "done"}}), capture=capture)

    res = await create_codex_backend().run(
        CodingRunOpts(task="do X", cwd=str(jail), model="gpt-5")
    )
    assert capture["cmd"] == "codex"
    assert capture["argv"][:5] == ["exec", "--json", "--skip-git-repo-check", "-s",
                                   "workspace-write"]
    assert "-m" in capture["argv"] and "gpt-5" in capture["argv"]
    assert capture["argv"][-1] == "do X"
    assert capture["cwd"] == str(jail)
    # env is coding_env: forwards OPENAI_API_KEY, withholds GITHUB_TOKEN.
    assert capture["env"].get("OPENAI_API_KEY") == "sk-openai"
    assert "GITHUB_TOKEN" not in capture["env"]
    assert res.messages == ["done"]


async def test_claude_code_builds_argv(jail: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    capture: dict = {}
    _patch_spawn(monkeypatch, "", capture=capture)

    await create_claude_code_backend().run(CodingRunOpts(task="fix Y", cwd=str(jail)))
    assert capture["cmd"] == "claude"
    assert capture["argv"][:4] == ["-p", "--output-format", "stream-json", "--verbose"]
    assert "--dangerously-skip-permissions" in capture["argv"]
    assert capture["argv"][-1] == "fix Y"
    assert capture["env"].get("ANTHROPIC_API_KEY") == "sk-ant"


async def test_opencode_builds_argv(jail: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    capture: dict = {}
    _patch_spawn(monkeypatch, "", capture=capture)

    await create_opencode_backend().run(
        CodingRunOpts(task="investigate Z", cwd=str(jail), model="o1")
    )
    assert capture["cmd"] == "opencode"
    assert capture["argv"][:6] == ["run", "--format", "json", "-q", "--working-dir", str(jail)]
    assert "--model" in capture["argv"] and "o1" in capture["argv"]
    assert capture["argv"][-1] == "investigate Z"


# --- run_subprocess behaviors -----------------------------------------------


async def test_run_subprocess_rejects_cwd_outside_jail(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # cwd is re-asserted in the jail; an outside path raises before any spawn.
    async def must_not_spawn(*_a, **_k):
        raise AssertionError("must not spawn with an out-of-jail cwd")

    monkeypatch.setattr(rs.asyncio, "create_subprocess_exec", must_not_spawn)
    with pytest.raises(JailEscapeError):
        await rs.run_subprocess(
            "codex", [], codex_parse, cwd="/etc", timeout_ms=1000,
            max_output_bytes=1024, env_keys=[], label="codex",
        )


async def test_run_subprocess_spawn_failure_is_reported(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def enoent(*_a, **_k):
        raise FileNotFoundError("codex not on PATH")

    monkeypatch.setattr(rs.asyncio, "create_subprocess_exec", enoent)
    res = await rs.run_subprocess(
        "codex", [], codex_parse, cwd=str(jail), timeout_ms=1000,
        max_output_bytes=1024, env_keys=[], label="codex",
    )
    assert res.messages == []
    assert any("Failed to spawn codex" in e for e in res.errors)


async def test_run_subprocess_nonzero_exit_appends_stderr(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_spawn(monkeypatch, "", returncode=2, stderr="boom from cli")
    res = await rs.run_subprocess(
        "codex", [], codex_parse, cwd=str(jail), timeout_ms=1000,
        max_output_bytes=1024, env_keys=[], label="codex",
    )
    assert res.messages == []
    assert any("boom from cli" in e for e in res.errors)


async def test_run_subprocess_timeout_returns_partial_plus_error(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    partial = json.dumps({"type": "item.completed",
                          "item": {"type": "agent_message", "text": "partial work"}})

    class _HangingProc(_FakeProc):
        async def wait(self) -> int:
            await asyncio.sleep(10)  # outlives the tiny timeout below
            return 0

    async def fake_exec(_cmd, *_argv, **_kwargs):
        return _HangingProc(partial)

    monkeypatch.setattr(rs.asyncio, "create_subprocess_exec", fake_exec)
    res = await rs.run_subprocess(
        "codex", [], codex_parse, cwd=str(jail), timeout_ms=20,
        max_output_bytes=4096, env_keys=[], label="codex",
    )
    # The partial stdout was still parsed, and a timeout error is appended.
    assert res.messages == ["partial work"]
    assert any("Timed out" in e for e in res.errors)


async def test_run_subprocess_truncates_on_line_boundary(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Emit far more than max_output_bytes; the retained window must start at a
    # clean line so every parsed record is whole and the last record survives.
    lines = "\n".join(json.dumps({"msg": f"m{i}"}) for i in range(2000))

    def parse(jsonl: str) -> CodingResult:
        msgs = []
        for line in jsonl.split("\n"):
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue  # a mid-record cut would land here — must never happen
            if e.get("msg"):
                msgs.append(e["msg"])
        return CodingResult(messages=msgs)

    _patch_spawn(monkeypatch, lines)
    res = await rs.run_subprocess(
        "node", [], parse, cwd=str(jail), timeout_ms=10_000,
        max_output_bytes=200, env_keys=[], label="node",
    )
    assert len(res.messages) > 0
    assert all(m.startswith("m") and m[1:].isdigit() for m in res.messages)
    assert res.messages[-1] == "m1999"


# --- per-backend parse_events -----------------------------------------------


def test_codex_parse_distills_messages_commands_errors() -> None:
    jsonl = "\n".join(
        [
            json.dumps({"type": "item.completed",
                        "item": {"type": "agent_message", "text": "all set"}}),
            json.dumps({"type": "item.completed", "item": {
                "type": "tool_call", "status": "completed",
                "command": "ls -la", "aggregated_output": "files", "exit_code": 0}}),
            json.dumps({"type": "error", "error": {"message": "transient blip"}}),
        ]
    )
    res = codex_parse(jsonl)
    assert res.messages == ["all set"]
    assert res.commands == [CodingCommand(command="ls -la", output="files", exitCode=0)]
    assert res.errors == ["transient blip"]


def test_claude_parse_collects_text_and_result() -> None:
    jsonl = "\n".join(
        [
            json.dumps({"type": "assistant", "message": {
                "content": [{"type": "text", "text": "thinking"},
                            {"type": "tool_use", "name": "Bash",
                             "input": {"command": "pytest", "description": "run tests"}}]}}),
            json.dumps({"type": "result", "result": "final answer"}),
        ]
    )
    res = claude_parse(jsonl)
    assert "thinking" in res.messages
    assert "final answer" in res.messages
    assert res.commands == [CodingCommand(command="pytest", output="run tests", exitCode=0)]


def test_opencode_parse_collects_text_and_step_finish() -> None:
    jsonl = "\n".join(
        [
            json.dumps({"type": "text", "text": "step one"}),
            json.dumps({"type": "tool_use", "input": {"command": "go build"},
                        "output": "ok", "exit_code": 0}),
            json.dumps({"type": "step_finish", "reason": "stop", "content": "wrapped up"}),
        ]
    )
    res = opencode_parse(jsonl)
    assert "step one" in res.messages
    assert "wrapped up" in res.messages
    assert res.commands == [CodingCommand(command="go build", output="ok", exitCode=0)]


# --- build_summary + the coding_task tool end-to-end (mocked spawn) ---------


def test_build_summary_includes_all_sections() -> None:
    result = CodingResult(
        messages=["the conclusion"],
        commands=[CodingCommand(command="pytest", output="3 passed", exitCode=0)],
        errors=["a warning"],
    )
    summary = build_summary(result)
    assert "Errors:" in summary and "a warning" in summary
    assert "Commands run (1)" in summary and "pytest" in summary
    assert "Agent conclusion:" in summary and "the conclusion" in summary


async def test_coding_task_success_records_action(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SH_CODING_BACKEND", raising=False)  # default codex
    _patch_spawn(
        monkeypatch,
        json.dumps({"type": "item.completed",
                    "item": {"type": "agent_message", "text": "task complete"}}),
    )
    res = await coding_task_impl(CodingTaskArgs(task="build the thing", scope="src/"), ctx())
    assert res.success is True
    assert "task complete" in res.result
    assert res.action is not None
    assert res.action.actionType == "coding_task_completed"
    assert res.action.payload["backend"] == "codex"
    assert res.action.payload["scope"] == "src/"


async def test_coding_task_errors_only_is_failure(
    jail: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SH_CODING_BACKEND", raising=False)
    _patch_spawn(monkeypatch, json.dumps({"type": "error", "error": {"message": "fatal"}}),
                 returncode=1)
    res = await coding_task_impl(CodingTaskArgs(task="do X"), ctx())
    assert res.success is False
    assert "fatal" in res.result
