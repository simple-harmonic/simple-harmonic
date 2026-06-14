"""Coding backend interface: the contract all coding CLI adapters implement.

TS source: packages/backend/src/server/tools/coding/types.ts

Each backend (Codex, Claude Code, OpenCode) translates its CLI's streaming-JSON
output into this common shape. The ``coding_task`` tool consumes a
:class:`CodingResult` and doesn't know which backend produced it.

These are dataclasses (an in-process call frame, never crossing the wire), in
keeping with :mod:`simple_harmonic.tools.types`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class CodingCommand:
    """A command the coding agent ran, distilled from the CLI's event stream."""

    command: str
    output: str
    exitCode: int


@dataclass
class CodingRunOpts:
    task: str
    cwd: str
    model: str | None = None
    # Timeout in milliseconds. Backends default to 300_000 (5 min) if not set.
    timeout: int | None = None


@dataclass
class CodingResult:
    messages: list[str] = field(default_factory=list)
    commands: list[CodingCommand] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class CodingBackend(Protocol):
    name: str

    def run(self, opts: CodingRunOpts) -> Awaitable[CodingResult]: ...


# A backend factory: ``() -> CodingBackend``.
CodingBackendFactory = Callable[[], CodingBackend]

# A per-backend JSONL parser: ``(stdout) -> CodingResult``.
ParseEvents = Callable[[str], CodingResult]
