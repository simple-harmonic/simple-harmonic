"""Repo singletons for the JSON file store.

TS source: packages/backend/src/server/store/repos/*.ts

Each repo mirrors the TS module-level object (`teams`, `agents`, ...): a single
instance whose method names and row shapes match the TS surface byte-for-byte.
"""

from __future__ import annotations

from simple_harmonic.store.repos.action_log import NewAction, actionLog
from simple_harmonic.store.repos.agents import NewAgent, agents
from simple_harmonic.store.repos.app_events import AppEventQuery, NewAppEvent, appEvents
from simple_harmonic.store.repos.approvals import NewApproval, approvals
from simple_harmonic.store.repos.platform_status import platformStatus
from simple_harmonic.store.repos.spend import NewSpend, spend
from simple_harmonic.store.repos.teams import NewTeam, teams
from simple_harmonic.store.repos.trace_events import NewTraceEvent, TraceQuery, traceEvents

__all__ = [
    "AppEventQuery",
    "NewAction",
    "NewAgent",
    "NewAppEvent",
    "NewApproval",
    "NewSpend",
    "NewTeam",
    "NewTraceEvent",
    "TraceQuery",
    "actionLog",
    "agents",
    "appEvents",
    "approvals",
    "platformStatus",
    "spend",
    "teams",
    "traceEvents",
]
