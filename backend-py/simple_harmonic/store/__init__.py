"""JSON file store over the existing .simple-harmonic/data/ layout.

TS source: packages/backend/src/server/store/**

The store types (Team, Agent, PendingApproval, AppEvent, ...), the data-dir
path helpers, the low-level fs primitives, the location index, and the eight
repos (teams, agents, approvals, actionLog, appEvents, platformStatus, spend,
traceEvents) behind a `Store` protocol. The on-disk layout and field names match
the TS store exactly so both runtimes can share a data directory.

This module mirrors the TS `store/index.ts` re-export surface.
"""

from __future__ import annotations

from simple_harmonic.store import fs
from simple_harmonic.store.base import Store
from simple_harmonic.store.data_dir import (
    ensure_data_dir,
    get_data_dir,
    set_data_dir,
    system_dir,
    teams_root,
)
from simple_harmonic.store.index_cache import invalidate_index
from simple_harmonic.store.repo_store import RepoStore
from simple_harmonic.store.repos import (
    AppEventQuery,
    NewAction,
    NewAgent,
    NewAppEvent,
    NewApproval,
    NewSpend,
    NewTeam,
    NewTraceEvent,
    TraceQuery,
    actionLog,
    agents,
    appEvents,
    approvals,
    platformStatus,
    spend,
    teams,
    traceEvents,
)
from simple_harmonic.store.types import (
    ActionLogEntry,
    Agent,
    AgentStatus,
    AgentTraceEvent,
    ApiToolConfig,
    AppEvent,
    AppEventLevel,
    AppEventSeverity,
    ApprovalStatus,
    LlmSpendEntry,
    PendingApproval,
    PlatformStatus,
    PlatformStatusValue,
    Team,
)


def reset_store() -> None:
    """Drop in-memory caches. Call after pointing the store at a new data dir."""
    invalidate_index()


def clear_store() -> None:
    """Wipe all data (teams + system) and drop caches. For seeds and test setup."""
    fs.remove_path(teams_root())
    fs.remove_path(system_dir())
    invalidate_index()


__all__ = [
    "ActionLogEntry",
    "Agent",
    "AgentStatus",
    "AgentTraceEvent",
    "ApiToolConfig",
    "AppEvent",
    "AppEventLevel",
    "AppEventQuery",
    "AppEventSeverity",
    "ApprovalStatus",
    "LlmSpendEntry",
    "NewAction",
    "NewAgent",
    "NewAppEvent",
    "NewApproval",
    "NewSpend",
    "NewTeam",
    "NewTraceEvent",
    "PendingApproval",
    "PlatformStatus",
    "PlatformStatusValue",
    "RepoStore",
    "Store",
    "Team",
    "TraceQuery",
    "actionLog",
    "agents",
    "appEvents",
    "approvals",
    "clear_store",
    "ensure_data_dir",
    "get_data_dir",
    "invalidate_index",
    "platformStatus",
    "reset_store",
    "set_data_dir",
    "spend",
    "teams",
    "traceEvents",
]
