"""Anthropic meta-agent adapter tests — request/response mapping + signal threading.

Ports the request/response-mapping coverage of
packages/backend/tests/unit/anthropic-adapter.test.ts plus the cancellation
behavior unique to the richer slice-7 adapter.

OFFLINE: the ``AsyncAnthropic`` SDK is mocked — no network. The mock captures the
params the adapter sends and returns a scripted Anthropic ``Message``-shaped
object so we can assert the OpenAI<->Anthropic translation in both directions.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from simple_harmonic.llm.client import CompletionOptions
from simple_harmonic.meta_agent import anthropic_adapter as aa

# asyncio_mode = "auto" runs ``async def`` tests without a marker.


# ---------------------------------------------------------------------------
# Fake AsyncAnthropic SDK
# ---------------------------------------------------------------------------


@dataclass
class _Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class _TextBlock:
    text: str
    type: str = "text"


@dataclass
class _ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
    type: str = "tool_use"


@dataclass
class _Message:
    content: list[Any]
    model: str = "claude-sonnet-4-20250514"
    stop_reason: str | None = "end_turn"
    usage: _Usage = field(default_factory=_Usage)


class _FakeMessages:
    def __init__(self, response: Any, *, delay: float = 0.0) -> None:
        self._response = response
        self._delay = delay
        self.captured: dict[str, Any] | None = None
        self.create_started = asyncio.Event()
        self.was_cancelled = False

    async def create(self, **params: Any) -> Any:
        self.captured = params
        self.create_started.set()
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
            return self._response
        except asyncio.CancelledError:
            self.was_cancelled = True
            raise


class _FakeAnthropic:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.init_kwargs = kwargs
        self.messages = _FakeAnthropic._messages

    # Class-level so the patched constructor and the test share the instance.
    _messages: _FakeMessages


def _install_fake_sdk(monkeypatch: pytest.MonkeyPatch, messages: _FakeMessages) -> None:
    """Patch ``anthropic.AsyncAnthropic`` so the adapter's local import resolves
    to our fake. The adapter does ``from anthropic import AsyncAnthropic`` inside
    the factory, so patching the attribute on the ``anthropic`` module suffices."""
    import anthropic

    _FakeAnthropic._messages = messages
    monkeypatch.setattr(anthropic, "AsyncAnthropic", _FakeAnthropic)


async def test_maps_request_and_text_response(monkeypatch: pytest.MonkeyPatch) -> None:
    messages = _FakeMessages(
        _Message(content=[_TextBlock(text="Hello")], usage=_Usage(input_tokens=12, output_tokens=3))
    )
    _install_fake_sdk(monkeypatch, messages)

    client = aa.create_anthropic_client(api_key="sk-ant-test", timeout=42.0)
    res = await client.chat.completions.create(
        {
            "model": "claude-sonnet-4-20250514",
            "messages": [
                {"role": "system", "content": "Be terse"},
                {"role": "user", "content": "Hi"},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "description": "Look something up",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
    )

    # Request mapping: system extracted, OpenAI tools -> Anthropic input_schema.
    sent = messages.captured
    assert sent is not None
    assert sent["system"] == "Be terse"
    assert sent["messages"] == [{"role": "user", "content": "Hi"}]
    assert sent["tools"][0]["name"] == "lookup"
    assert sent["tools"][0]["input_schema"] == {"type": "object", "properties": {}}

    # Response mapping: text content + serving model + usage aliases.
    assert res.model == "claude-sonnet-4-20250514"
    assert res.choices[0].message.content == "Hello"
    assert res.choices[0].finish_reason == "stop"
    assert res.usage is not None
    assert res.usage.input_tokens == 12
    assert res.usage.prompt_tokens == 12
    assert res.usage.completion_tokens == 3


async def test_maps_tool_use_response(monkeypatch: pytest.MonkeyPatch) -> None:
    messages = _FakeMessages(
        _Message(
            content=[_ToolUseBlock(id="toolu_1", name="report_action", input={"summary": "done"})],
            stop_reason="tool_use",
            usage=_Usage(input_tokens=5, output_tokens=7),
        )
    )
    _install_fake_sdk(monkeypatch, messages)

    client = aa.create_anthropic_client(api_key="sk-ant-test")
    res = await client.chat.completions.create(
        {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "go"}]}
    )

    tc = res.choices[0].message.tool_calls
    assert tc is not None and len(tc) == 1
    assert tc[0].id == "toolu_1"
    assert tc[0].function.name == "report_action"
    import json

    assert json.loads(tc[0].function.arguments) == {"summary": "done"}
    assert res.choices[0].finish_reason == "tool_calls"


async def test_defaults_max_tokens_and_model(monkeypatch: pytest.MonkeyPatch) -> None:
    messages = _FakeMessages(_Message(content=[_TextBlock(text="ok")]))
    _install_fake_sdk(monkeypatch, messages)

    client = aa.create_anthropic_client()
    await client.chat.completions.create({"messages": [{"role": "user", "content": "hi"}]})

    sent = messages.captured
    assert sent is not None
    assert sent["max_tokens"] == 1024
    assert sent["model"] == aa.DEFAULT_ANTHROPIC_MODEL
    # No tools / no system -> those keys are omitted entirely.
    assert "tools" not in sent
    assert "system" not in sent


async def test_aborts_before_start_when_signal_already_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    messages = _FakeMessages(_Message(content=[_TextBlock(text="nope")]))
    _install_fake_sdk(monkeypatch, messages)

    signal = asyncio.Event()
    signal.set()
    client = aa.create_anthropic_client(api_key="sk-ant-test")
    with pytest.raises(asyncio.CancelledError):
        await client.chat.completions.create(
            {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "hi"}]},
            CompletionOptions(signal=signal),
        )
    # The request was never issued.
    assert messages.captured is None


async def test_signal_cancels_in_flight_request(monkeypatch: pytest.MonkeyPatch) -> None:
    # A slow create that we abort mid-flight; the SDK task must be cancelled.
    messages = _FakeMessages(_Message(content=[_TextBlock(text="late")]), delay=5.0)
    _install_fake_sdk(monkeypatch, messages)

    signal = asyncio.Event()
    client = aa.create_anthropic_client(api_key="sk-ant-test")
    task = asyncio.ensure_future(
        client.chat.completions.create(
            {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "hi"}]},
            CompletionOptions(signal=signal),
        )
    )
    await messages.create_started.wait()
    signal.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    # The in-flight SDK call was cancelled (abort threaded through).
    assert messages.was_cancelled is True


async def test_passes_through_when_no_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    messages = _FakeMessages(_Message(content=[_TextBlock(text="plain")]))
    _install_fake_sdk(monkeypatch, messages)
    client = aa.create_anthropic_client(api_key="sk-ant-test")
    res = await client.chat.completions.create(
        {"model": "claude-sonnet-4-20250514", "messages": [{"role": "user", "content": "hi"}]},
        CompletionOptions(signal=None),
    )
    assert res.choices[0].message.content == "plain"
