"""Wire the slice-7 meta-agent adapters into the slice-5 LLM resolver hooks.

TS source: packages/backend/src/server/llm.ts wires ``createCodexClient`` /
``createAnthropicClient`` into the candidate builders. In Python those builders
are the pluggable module hooks declared in :mod:`simple_harmonic.llm.candidates`:

  * ``candidates.codex_client_factory``     -> :func:`codex_adapter.create_codex_client`
    (the exec one-shot adapter; replaces the slice-5 raising placeholder).
  * ``candidates.anthropic_client_factory`` -> :func:`anthropic_adapter.create_anthropic_client`
    (the cancellation-aware adapter; replaces the slice-5 subset adapter).

The OpenAI hook is left at its slice-5 default (the OpenAI/OpenRouter SDK wrapper
is already complete; this slice adds no richer variant).

:func:`wire_candidate_factories` is idempotent and is called once at import of
:mod:`simple_harmonic.meta_agent`. It mutates module attributes only (no network,
no process spawn), so importing the engine package is side-effect-free beyond
pointing the hooks at the richer adapters. Tests that override the hooks via
``monkeypatch.setattr(candidates, ...)`` still win — they patch after import.
"""

from __future__ import annotations

from simple_harmonic.llm import candidates
from simple_harmonic.meta_agent import anthropic_adapter, codex_adapter


def wire_candidate_factories() -> None:
    """Point the resolver's provider hooks at the slice-7 adapters. Idempotent."""
    candidates.codex_client_factory = codex_adapter.create_codex_client
    candidates.anthropic_client_factory = anthropic_adapter.create_anthropic_client
