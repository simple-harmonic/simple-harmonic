"""(De)serialization boundary helpers.

TS source: packages/backend/src/server/store/serialize.ts

Dates serialize to ISO strings for free in TS (Date.prototype.toJSON); here the
store explicitly converts `datetime` values to ISO-8601 on write (`json_default`)
and revives the listed top-level timestamp fields back into `datetime` on read.

We revive ONLY the declared keys — never deep-walk — so ISO-looking strings
inside opaque JSON blobs (payload, metadata, data, conversationState,
outputContract) stay untouched, exactly as Postgres jsonb returned them.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any


def revive_dates(row: dict[str, Any], date_keys: Sequence[str]) -> dict[str, Any]:
    """Revive the named top-level keys of a row from ISO string -> datetime, in place.

    Mirrors TS reviveDates(): only string values are converted; missing keys and
    non-string values (e.g. already-revived datetimes or null) are left alone.
    """
    for key in date_keys:
        v = row.get(key)
        if isinstance(v, str):
            row[key] = datetime.fromisoformat(v)
    return row


def revive_dates_all(
    rows: list[dict[str, Any]], date_keys: Sequence[str]
) -> list[dict[str, Any]]:
    """Revive a list of rows in place."""
    for row in rows:
        revive_dates(row, date_keys)
    return rows


def json_default(value: object) -> str:
    """`json.dumps(default=...)` hook: serialize `datetime` to ISO-8601.

    Matches JavaScript's Date.prototype.toJSON used when JSON.stringify writes a
    row whose `*At` fields are Date objects. We mirror Node's Date#toISOString,
    which always renders UTC with a trailing `Z` and millisecond precision.
    """
    if isinstance(value, datetime):
        return _to_iso_z(value)
    msg = f"Object of type {type(value).__name__} is not JSON serializable"
    raise TypeError(msg)


def _to_iso_z(dt: datetime) -> str:
    """Render a datetime the way Node's Date#toISOString does: UTC, ms, `Z`."""
    from datetime import UTC

    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
    utc = aware.astimezone(UTC)
    # Millisecond precision + 'Z', matching JS toISOString().
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
