"""Coding backends + the unified ``coding_task`` tool.

TS source: packages/backend/src/server/tools/coding/

``coding_task`` drives an external coding CLI (codex / claude-code / opencode)
via a scrubbed subprocess to run end-to-end coding/research/testing tasks. The
backend is selected from app config (or per-call); each adapter normalizes its
CLI's streaming-JSON output into the common :class:`CodingResult`.
"""

from __future__ import annotations

from simple_harmonic.tools.coding.index import (
    BACKENDS,
    build_summary,
    coding_task_def,
    coding_task_impl,
    create_coding_backend,
)
from simple_harmonic.tools.coding.types import (
    CodingBackend,
    CodingCommand,
    CodingResult,
    CodingRunOpts,
)

__all__ = [
    "BACKENDS",
    "CodingBackend",
    "CodingCommand",
    "CodingResult",
    "CodingRunOpts",
    "build_summary",
    "coding_task_def",
    "coding_task_impl",
    "create_coding_backend",
]
