"""Shared concurrency helper for the repos.

Every repo read-modify-write runs inside the process-wide `store_lock` and is
dispatched to a worker thread so blocking fs IO never stalls the event loop.
The lock is what restores Node's implicit single-task atomicity: two coroutines
can no longer both read `inFlight=false` (or interleave any read -> write).

Pure reads also take the lock so they never observe a half-applied write or a
half-built location-index cache.
"""

from __future__ import annotations

from collections.abc import Callable

import anyio

from simple_harmonic.store.index_cache import store_lock


async def locked[T](fn: Callable[[], T]) -> T:
    """Run a synchronous fs operation under the global lock, off the event loop."""
    async with store_lock():
        return await anyio.to_thread.run_sync(fn)
