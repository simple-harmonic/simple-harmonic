"""LLM provider cascade, spend ledger, and Codex CLI auth (migration slice 5).

TS sources:
  - packages/backend/src/server/llm.ts        -> candidates / cascade
  - packages/backend/src/server/spend.ts       -> spend
  - packages/backend/src/server/codex-auth.ts  -> codex_auth

The :class:`~simple_harmonic.llm.client.LLMClient` Protocol declared here is the
shared seam slice 7 (the meta-agent runner + adapters) reuses.
"""

from __future__ import annotations
