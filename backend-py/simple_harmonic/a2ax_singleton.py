"""Process-wide a2ax instance for Simple Harmonic.

TS source: packages/backend/src/server/a2ax.ts (getA2AX / resetA2AXForTests)

The tick orchestrator and the agent-communication tools share one
:class:`~simple_harmonic.a2ax.A2AX` facade over a
:class:`~simple_harmonic.a2ax.JsonFileTransport`, which persists each team's
messages/channels/tasks/tokens under that team's folder in the recursive data
tree (``<dataDir>/teams/<id>/messages``).

The instance is rebound to the current ``teams_root()`` on first use; tests that
repoint ``SH_DATA_DIR`` between cases call :func:`reset_a2ax_for_tests` so a
fresh transport hydrates from the new tree.
"""

from __future__ import annotations

from simple_harmonic.a2ax import A2AX, A2AXOptions, JsonFileTransport
from simple_harmonic.store.data_dir import teams_root

_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

_instance: A2AX | None = None


def get_a2ax() -> A2AX:
    """The shared a2ax facade, created on first use over ``teams_root()``."""
    global _instance
    if _instance is None:
        _instance = A2AX(
            A2AXOptions(
                transport=JsonFileTransport(teams_root()),
                max_context_messages=20,
                default_expiry_ms=_DEFAULT_EXPIRY_MS,
            )
        )
    return _instance


def reset_a2ax_for_tests() -> None:
    """Drop the cached instance (tests that repoint SH_DATA_DIR between cases)."""
    global _instance
    _instance = None
