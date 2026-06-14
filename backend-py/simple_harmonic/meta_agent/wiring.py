"""Wire the slice-7 meta-agent adapters into the slice-5 LLM resolver hooks.

TS source: packages/backend/src/server/llm.ts wires the codex + anthropic client
builders. In Python those builders are the pluggable module hooks declared in
:mod:`simple_harmonic.llm.candidates`:

  * ``candidates.codex_client_factory``     -> :func:`codex_adapter.create_codex_app_server_client`
    (the ``codex app-server`` engine adapted to the LLMClient contract — one turn
    per call — replacing the slice-5 raising placeholder).
  * ``candidates.anthropic_client_factory`` -> :func:`anthropic_adapter.create_anthropic_client`
    (the cancellation-aware adapter; replaces the slice-5 subset adapter).

The OpenAI hook is left at its slice-5 default. Codex is the *same* app-server
engine the agent tick drives via :func:`run_codex_agent_tick`; here it is exposed
through the cascade for chat / planner / test-llm.

:func:`wire_candidate_factories` is idempotent and is called once at import of
:mod:`simple_harmonic.meta_agent`. It mutates module attributes only (no network,
no process spawn). Tests that override the hooks via ``monkeypatch.setattr`` still
win — they patch after import.
"""

from __future__ import annotations

from simple_harmonic.llm import candidates
from simple_harmonic.meta_agent import anthropic_adapter, codex_adapter


def wire_candidate_factories() -> None:
    """Point the resolver's provider hooks at the slice-7 adapters. Idempotent."""
    candidates.codex_client_factory = codex_adapter.create_codex_app_server_client
    candidates.anthropic_client_factory = anthropic_adapter.create_anthropic_client
