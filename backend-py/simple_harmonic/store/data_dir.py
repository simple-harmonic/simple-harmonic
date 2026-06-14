"""Data-directory resolution + path helpers for the JSON store.

TS source: packages/backend/src/server/store/data-dir.ts

Layout (recursive on teams):

  <dataDir>/
  ├─ teams/<teamId>/
  │  ├─ team.json
  │  ├─ events.jsonl
  │  ├─ agents/<agentId>/{ agent.json, approvals.json, actions.jsonl, trace.jsonl }
  │  ├─ messages/{ channels.json, ... }   (a2ax)
  │  └─ teams/<subTeamId>/…                (recursive)
  └─ system/{ platform-status.json, spend.jsonl, events.jsonl }
"""

from __future__ import annotations

from pathlib import Path

from simple_harmonic.settings import get_settings

_override: Path | None = None


def get_data_dir() -> Path:
    """Resolution: test override > settings (SH_DATA_DIR / default)."""
    if _override is not None:
        return _override
    return get_settings().data_dir


def set_data_dir(directory: str | Path | None) -> None:
    """Point the store at a different directory (used by tests for isolation)."""
    global _override
    _override = Path(directory).expanduser().resolve() if directory is not None else None


# --- Fixed roots ---


def teams_root() -> Path:
    return get_data_dir() / "teams"


def system_dir() -> Path:
    return get_data_dir() / "system"


def platform_status_path() -> Path:
    return system_dir() / "platform-status.json"


def spend_log_path() -> Path:
    return system_dir() / "spend.jsonl"


def infra_events_path() -> Path:
    return system_dir() / "events.jsonl"


# --- Within a team folder ---


def team_json_path(team_dir: Path) -> Path:
    return team_dir / "team.json"


def team_events_path(team_dir: Path) -> Path:
    return team_dir / "events.jsonl"


def team_agents_dir(team_dir: Path) -> Path:
    return team_dir / "agents"


def team_messages_dir(team_dir: Path) -> Path:
    return team_dir / "messages"


def team_children_dir(team_dir: Path) -> Path:
    return team_dir / "teams"


# --- Within an agent folder ---


def agent_json_path(agent_dir: Path) -> Path:
    return agent_dir / "agent.json"


def agent_approvals_path(agent_dir: Path) -> Path:
    return agent_dir / "approvals.json"


def agent_actions_path(agent_dir: Path) -> Path:
    return agent_dir / "actions.jsonl"


def agent_trace_path(agent_dir: Path) -> Path:
    return agent_dir / "trace.jsonl"


def ensure_data_dir() -> Path:
    """Create the teams/ and system/ skeleton dirs. Idempotent.

    TS source: store ensureDataDir() — returns the data-dir path.
    """
    root = get_data_dir()
    (root / "teams").mkdir(parents=True, exist_ok=True)
    (root / "system").mkdir(parents=True, exist_ok=True)
    return root
