"""Platform status repo.

TS source: packages/backend/src/server/store/repos/platform-status.ts

A single object file (system/platform-status.json). Replaces the singleton
platform_status table; get() returns None when unset. `id` is the literal
integer 1 (every other row id is a UUID string).
"""

from __future__ import annotations

from datetime import UTC, datetime

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates
from simple_harmonic.store.types import PlatformStatus, PlatformStatusValue

DATE_KEYS = ("updatedAt",)


class PlatformStatusRepo:
    async def get(self) -> PlatformStatus | None:
        return await locked(self._get_sync)

    def _get_sync(self) -> PlatformStatus | None:
        raw = fs.read_json(dd.platform_status_path(), None)
        if not isinstance(raw, dict):
            return None
        return PlatformStatus.model_validate(revive_dates(raw, DATE_KEYS))

    async def set(self, status: PlatformStatusValue, message: str | None) -> PlatformStatus:
        return await locked(lambda: self._set_sync(status, message))

    def _set_sync(self, status: PlatformStatusValue, message: str | None) -> PlatformStatus:
        row = PlatformStatus(id=1, status=status, message=message, updatedAt=datetime.now(UTC))
        fs.write_json(dd.platform_status_path(), row.model_dump(by_alias=True))
        return row


platformStatus = PlatformStatusRepo()
