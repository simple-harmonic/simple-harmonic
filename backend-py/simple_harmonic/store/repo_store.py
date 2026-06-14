"""Repo-backed `Store` implementation.

TS source: packages/backend/src/server/store/index.ts (the `teams` / `platformStatus`
repo surface the HTTP handlers call directly).

Slice 8 retires the ad-hoc slice-1 :mod:`simple_harmonic.store.json_store`
(`JsonFileStore`) and the :mod:`simple_harmonic.domain` stubs. The route handlers
keep depending on the small :class:`~simple_harmonic.store.base.Store` protocol,
but it is now satisfied by delegating to the slice-2 repos
(:mod:`simple_harmonic.store.repos`) — the same recursive-team-tree, location-index,
store-lock implementation the tick orchestrator uses. This removes the duplicate
team-walk / platform-status read paths (and the trailing-Z serialization seam: the
repos serialize via their own ``json_default``).
"""

from __future__ import annotations

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos import platformStatus, teams
from simple_harmonic.store.types import PlatformStatus, PlatformStatusValue, Team


class RepoStore:
    """Concrete `Store` backed by the slice-2 repos.

    The repos are module-level singletons reading the data dir resolved through
    :mod:`simple_harmonic.store.data_dir`; this class is a thin protocol adapter
    so route handlers stay decoupled from the repo surface (and remain trivially
    overridable in tests).
    """

    # --- lifecycle ---

    async def ensure(self) -> None:
        # Create the teams/ + system/ skeleton, then drop any stale location
        # index so the next read re-walks the (possibly repointed) data dir.
        dd.ensure_data_dir()
        ic.invalidate_index()

    # --- teams ---

    async def list_teams(self) -> list[Team]:
        """All teams, OLDEST-first (the handler reverses for newest-first)."""
        return await teams.all()

    async def get_team(self, team_id: str) -> Team | None:
        return await teams.byId(team_id)

    # --- platform status ---

    async def get_platform_status(self) -> PlatformStatus | None:
        return await platformStatus.get()

    async def set_platform_status(
        self, status: PlatformStatusValue, message: str | None
    ) -> PlatformStatus:
        return await platformStatus.set(status, message)
