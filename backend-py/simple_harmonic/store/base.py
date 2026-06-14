"""Store interface (Protocol) — the storage contract the API depends on.

The HTTP handlers and domain stubs depend on this Protocol, not on the concrete
JSON implementation, so the store can be swapped (e.g. for an in-memory test
double or a future DB-backed store) without touching call sites.

Slice 1 covers the read paths the slice-1 endpoints need: list teams, get a
team, and read/write platform status. Later slices extend this with agents,
approvals, messages, etc.
"""

from __future__ import annotations

from typing import Protocol

from simple_harmonic.store.types import PlatformStatus, PlatformStatusValue, Team


class Store(Protocol):
    """Async storage contract over the domain-aggregate JSON files."""

    async def ensure(self) -> None:
        """Create the data-dir skeleton (teams/, system/). Idempotent."""
        ...

    async def list_teams(self) -> list[Team]:
        """All teams, OLDEST-first (the handler reverses for newest-first)."""
        ...

    async def get_team(self, team_id: str) -> Team | None:
        ...

    async def get_platform_status(self) -> PlatformStatus | None:
        """Stored platform status, or None when never set."""
        ...

    async def set_platform_status(
        self, status: PlatformStatusValue, message: str | None
    ) -> PlatformStatus:
        ...
