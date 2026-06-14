"""Planner tests — streamed tokens + accumulated discriminated-union results.

Ports packages/backend/tests/unit/planner.test.ts (both the OpenAI chat path and
the Codex Responses SSE path).

OFFLINE: the OpenAI path is exercised through a fake streaming client injected
via ``planner.openai_client_factory``; the Codex path through a fake
``deps.fetch_impl``. No network, no real SDK calls.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest

from simple_harmonic.meta_agent import planner as planner_mod
from simple_harmonic.meta_agent.planner import (
    PlannerConfig,
    PlannerDeps,
    planner_stream,
)
from simple_harmonic.meta_agent.types import PlannerMessage

# ---------------------------------------------------------------------------
# OpenAI path fakes
# ---------------------------------------------------------------------------


def _text_chunk(content: str) -> dict[str, Any]:
    return {"choices": [{"delta": {"content": content, "tool_calls": None}}]}


def _tool_chunk(id_: str | None, name: str | None, args: str) -> dict[str, Any]:
    return {
        "choices": [
            {
                "delta": {
                    "content": None,
                    "tool_calls": [{"id": id_, "function": {"name": name, "arguments": args}}],
                }
            }
        ]
    }


@dataclass
class _FakeOpenAIStream:
    chunks: list[dict[str, Any]]

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        async def gen() -> AsyncIterator[dict[str, Any]]:
            for c in self.chunks:
                yield c

        return gen()


@dataclass
class _FakeCompletions:
    chunks: list[dict[str, Any]]
    captured: dict[str, Any] = field(default_factory=dict)

    async def create(self, **params: Any) -> _FakeOpenAIStream:
        self.captured.update(params)
        return _FakeOpenAIStream(self.chunks)


@dataclass
class _FakeChat:
    completions: _FakeCompletions


@dataclass
class _FakeOpenAIClient:
    chat: _FakeChat


@pytest.fixture
def openai_chunks(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """Install a fake OpenAI client factory that replays ``chunks`` and restore
    the real factory on teardown."""
    chunks: list[dict[str, Any]] = []
    completions = _FakeCompletions(chunks=chunks)

    def factory(_config: PlannerConfig) -> _FakeOpenAIClient:
        return _FakeOpenAIClient(chat=_FakeChat(completions=completions))

    monkeypatch.setattr(planner_mod, "openai_client_factory", factory)
    yield chunks


def _config_deps() -> PlannerDeps:
    return PlannerDeps(
        config=PlannerConfig(
            model="gpt-5.4-mini",
            openaiApiKey="sk-test",
            openaiBaseUrl="https://api.openai.com/v1",
        ),
        api_key_source="config",
        codex_access_token=None,
        codex_account_id="",
        fetch_impl=_never_fetch,
    )


async def _never_fetch(*_args: Any, **_kwargs: Any) -> Any:  # pragma: no cover - guard
    raise AssertionError("config path must not hit fetch_impl")


# ---------------------------------------------------------------------------
# OpenAI chat path
# ---------------------------------------------------------------------------


async def test_streams_tokens_and_returns_message(openai_chunks: list[dict[str, Any]]) -> None:
    openai_chunks.extend([_text_chunk("Hello"), _text_chunk(" founder.")])
    tokens: list[str] = []
    result = await planner_stream(
        [PlannerMessage(role="user", content="I run a SaaS startup")],
        tokens.append,
        _config_deps(),
    )
    assert result.type == "message"
    assert result.content == "Hello founder."
    assert tokens == ["Hello", " founder."]


async def test_detects_spawn_team(openai_chunks: list[dict[str, Any]]) -> None:
    spawn_input = {
        "agents": [
            {
                "name": "inbox-scanner",
                "role": "Monitors email for urgent items",
                "archetype": "support-responder",
                "tools": ["mock-inbox"],
                "schedule_seconds": 300,
                "initial_prompt": "Scan inbox for urgent items.",
            }
        ]
    }
    openai_chunks.extend(
        [
            _text_chunk("Setting up your team."),
            _tool_chunk("call_1", "spawn_team", json.dumps(spawn_input)),
        ]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Email and content. Ready to go.")],
        lambda _t: None,
        _config_deps(),
    )
    assert result.type == "spawn"
    assert len(result.result.agents) == 1
    assert result.result.agents[0].name == "inbox-scanner"
    assert result.result.agents[0].archetype == "support-responder"


async def test_fallback_content_when_no_text(openai_chunks: list[dict[str, Any]]) -> None:
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hello")], lambda _t: None, _config_deps()
    )
    assert result.type == "message"
    assert result.content == "I need a moment. Try again."


async def test_malformed_spawn_json_is_message(openai_chunks: list[dict[str, Any]]) -> None:
    openai_chunks.extend(
        [_text_chunk("Almost there."), _tool_chunk("call_1", "spawn_team", "not valid json {{{")]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Let's go")], lambda _t: None, _config_deps()
    )
    assert result.type == "message"
    assert result.content == "Almost there."


async def test_non_spawn_tool_name_is_message(openai_chunks: list[dict[str, Any]]) -> None:
    openai_chunks.extend(
        [_text_chunk("Text response."), _tool_chunk("call_1", "unknown_tool", '{"foo":"bar"}')]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Do something")], lambda _t: None, _config_deps()
    )
    assert result.type == "message"
    assert result.content == "Text response."


async def test_detects_modify_agent(openai_chunks: list[dict[str, Any]]) -> None:
    modify_input = {
        "agent_name": "bug-hunter",
        "team_name": "Acme Studio",
        "updates": {
            "tools": ["read_file", "run_command", "coding_task", "slack_api"],
            "schedule_seconds": 300,
        },
    }
    openai_chunks.extend(
        [
            _text_chunk("Adding Slack to the bug-hunter."),
            _tool_chunk("call_1", "modify_agent", json.dumps(modify_input)),
        ]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Add slack_api to the bug-hunter")],
        lambda _t: None,
        _config_deps(),
    )
    assert result.type == "modify_agent"
    assert result.result.agent_name == "bug-hunter"
    assert result.result.team_name == "Acme Studio"
    assert "slack_api" in (result.result.updates.tools or [])
    assert result.result.updates.schedule_seconds == 300


async def test_malformed_modify_json_is_message(openai_chunks: list[dict[str, Any]]) -> None:
    openai_chunks.extend(
        [_text_chunk("Updating."), _tool_chunk("call_1", "modify_agent", "broken json{{{")]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Modify something")], lambda _t: None, _config_deps()
    )
    assert result.type == "message"
    assert result.content == "Updating."


async def test_chunk_with_no_choices(openai_chunks: list[dict[str, Any]]) -> None:
    openai_chunks.extend([{"choices": []}, _text_chunk("After empty.")])
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hi")], lambda _t: None, _config_deps()
    )
    assert result.type == "message"
    assert result.content == "After empty."


async def test_accumulates_tool_args_across_chunks(openai_chunks: list[dict[str, Any]]) -> None:
    part1 = '{"agents":[{"name":"inbox-scanner","role":"Email"'
    part2 = (
        ',"archetype":"support-responder","tools":[],"schedule_seconds":300,'
        '"initial_prompt":"Scan."}]}'
    )
    openai_chunks.extend(
        [_tool_chunk("call_1", "spawn_team", part1), _tool_chunk(None, None, part2)]
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Go")], lambda _t: None, _config_deps()
    )
    assert result.type == "spawn"
    assert result.result.agents[0].name == "inbox-scanner"


async def test_includes_team_name_and_cofounder_name(openai_chunks: list[dict[str, Any]]) -> None:
    spawn_input = {
        "team_name": "Acme Studio",
        "cofounder_name": "Atlas",
        "agents": [
            {
                "name": "ops-monitor",
                "role": "Monitor ops",
                "archetype": "ops-monitor",
                "tools": [],
                "schedule_seconds": 300,
                "initial_prompt": "Watch things.",
            }
        ],
    }
    openai_chunks.append(_tool_chunk("call_1", "spawn_team", json.dumps(spawn_input)))
    result = await planner_stream(
        [PlannerMessage(role="user", content="Build")], lambda _t: None, _config_deps()
    )
    assert result.type == "spawn"
    assert result.result.team_name == "Acme Studio"
    assert result.result.cofounder_name == "Atlas"


# ---------------------------------------------------------------------------
# Codex Responses SSE path
# ---------------------------------------------------------------------------


@dataclass
class _FakeResponse:
    ok: bool
    status: int = 200
    body_chunks: list[bytes] = field(default_factory=list)
    text_body: str = ""

    async def text(self) -> str:
        return self.text_body

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        for c in self.body_chunks:
            yield c


def _codex_deps(response: _FakeResponse, captured: dict[str, Any] | None = None) -> PlannerDeps:
    async def fetch_impl(url: str, **kwargs: Any) -> _FakeResponse:
        if captured is not None:
            captured["url"] = url
            captured.update(kwargs)
        return response

    return PlannerDeps(
        config=PlannerConfig(
            model="gpt-5.5", openaiApiKey="", openaiBaseUrl="https://api.openai.com/v1"
        ),
        api_key_source="codex",
        codex_access_token="test-codex-token",
        codex_account_id="acc-1",
        fetch_impl=fetch_impl,
    )


def _sse(data: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(data)}\n\n".encode()


async def test_codex_streams_tokens() -> None:
    captured: dict[str, Any] = {}
    response = _FakeResponse(
        ok=True,
        body_chunks=[
            _sse({"type": "response.output_text.delta", "delta": "Hello"}),
            _sse({"type": "response.output_text.delta", "delta": " world"}),
        ],
    )
    tokens: list[str] = []
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hi")], tokens.append, _codex_deps(response, captured)
    )
    assert result.type == "message"
    assert result.content == "Hello world"
    assert tokens == ["Hello", " world"]
    # The codex auth header was attached.
    assert captured["headers"]["Authorization"] == "Bearer test-codex-token"
    assert captured["headers"]["ChatGPT-Account-ID"] == "acc-1"


async def test_codex_handles_spawn_team() -> None:
    spawn_args = json.dumps(
        {
            "team_name": "Test Team",
            "agents": [
                {
                    "name": "bot",
                    "role": "Bot",
                    "archetype": "ops-monitor",
                    "tools": [],
                    "schedule_seconds": 300,
                    "initial_prompt": "Go.",
                }
            ],
        }
    )
    response = _FakeResponse(
        ok=True,
        body_chunks=[
            _sse({"type": "response.output_text.delta", "delta": "Setting up."}),
            _sse(
                {
                    "type": "response.output_item.added",
                    "item": {"type": "function_call", "name": "spawn_team"},
                }
            ),
            _sse({"type": "response.function_call_arguments.delta", "delta": spawn_args}),
        ],
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Go")], lambda _t: None, _codex_deps(response)
    )
    assert result.type == "spawn"
    assert result.result.team_name == "Test Team"
    assert len(result.result.agents) == 1


async def test_codex_raises_on_non_ok() -> None:
    response = _FakeResponse(ok=False, status=429, text_body="Rate limited")
    with pytest.raises(RuntimeError, match="Codex API error 429"):
        await planner_stream(
            [PlannerMessage(role="user", content="Hi")], lambda _t: None, _codex_deps(response)
        )


async def test_codex_skips_malformed_json_lines() -> None:
    response = _FakeResponse(
        ok=True,
        body_chunks=[
            b"data: not json\n\n",
            _sse({"type": "response.output_text.delta", "delta": "ok"}),
        ],
    )
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hi")], lambda _t: None, _codex_deps(response)
    )
    assert result.type == "message"
    assert result.content == "ok"


async def test_codex_handles_event_prefix_format() -> None:
    # event: and data: lines in one chunk so the line parser matches the event
    # type to the data on the same pass.
    chunk = (
        f"event: response.output_text.delta\ndata: {json.dumps({'delta': 'event prefix'})}\n\n"
    ).encode()
    response = _FakeResponse(ok=True, body_chunks=[chunk])
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hi")], lambda _t: None, _codex_deps(response)
    )
    assert result.content == "event prefix"


async def test_codex_fallback_when_no_text() -> None:
    response = _FakeResponse(ok=True, body_chunks=[])
    result = await planner_stream(
        [PlannerMessage(role="user", content="Hi")], lambda _t: None, _codex_deps(response)
    )
    assert result.type == "message"
    assert result.content == "I need a moment. Try again."


async def test_codex_no_token_raises() -> None:
    response = _FakeResponse(ok=True, body_chunks=[])
    deps = _codex_deps(response)
    deps.codex_access_token = None
    with pytest.raises(ValueError, match="No Codex access token"):
        await planner_stream(
            [PlannerMessage(role="user", content="Hi")], lambda _t: None, deps
        )
