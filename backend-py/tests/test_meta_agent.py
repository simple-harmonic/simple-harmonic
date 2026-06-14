"""Meta-agent package surface: re-exports + the two-suspension discriminator.

The runner/planner/contract behaviors live in test_runner / test_planner /
test_contract. This file covers index.ts parity (re-exports) and the
``is_codex_thread_suspension`` guard that disambiguates the two shapes parked in
``agents.conversationState``.
"""

from __future__ import annotations

import simple_harmonic.meta_agent as ma
from simple_harmonic.meta_agent import (
    DEFAULT_META_AGENT_PROMPT,
    AgentSuspension,
    CodexThreadSuspension,
    PendingToolCall,
    is_codex_thread_suspension,
    planner_stream,
    run_agent,
    tool_allowlist,
    validate_contract,
)


def test_index_reexports_runtime_symbols() -> None:
    assert callable(run_agent)
    assert callable(planner_stream)
    assert callable(validate_contract)
    assert callable(tool_allowlist)
    assert isinstance(DEFAULT_META_AGENT_PROMPT, str)
    # ToolRegistry is reused from slice 6 but re-exported here for index parity.
    assert hasattr(ma, "ToolRegistry")
    assert hasattr(ma, "schema_to_parameters")


def test_codex_thread_suspension_recognized() -> None:
    s = CodexThreadSuspension(
        threadId="thread-1",
        pending=[PendingToolCall(id="c1", name="write_file", arguments="{}")],
    )
    assert is_codex_thread_suspension(s) is True
    # ...and as a serialized dict (the shape persisted in conversationState).
    assert is_codex_thread_suspension(s.model_dump(by_alias=True)) is True


def test_agent_suspension_is_not_codex_thread() -> None:
    s = AgentSuspension(
        messages=[{"role": "assistant", "tool_calls": []}],
        pending=[PendingToolCall(id="c1", name="write_file", arguments="{}")],
        round=0,
    )
    assert is_codex_thread_suspension(s) is False
    assert is_codex_thread_suspension(s.model_dump(by_alias=True)) is False


def test_discriminator_requires_string_thread_id() -> None:
    # kind matches but threadId is not a str -> not a codex-thread suspension.
    assert is_codex_thread_suspension({"kind": "codex-thread", "threadId": 123}) is False
    assert is_codex_thread_suspension({"kind": "codex-thread"}) is False
    assert is_codex_thread_suspension({"threadId": "t1"}) is False
    assert is_codex_thread_suspension(None) is False
    assert is_codex_thread_suspension("not a suspension") is False


def test_two_shapes_share_conversation_state_field() -> None:
    # Both shapes carry `pending`; only the discriminator tells them apart. This
    # is the load-bearing invariant the tick route's try_resume_agent relies on.
    codex = CodexThreadSuspension(threadId="t1")
    runner = AgentSuspension(round=2)
    assert hasattr(codex, "pending")
    assert hasattr(runner, "pending")
    assert is_codex_thread_suspension(codex) != is_codex_thread_suspension(runner)
