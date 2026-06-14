"""Connector resolution: flat files + env var fallback.

TS source: packages/backend/src/server/connectors.ts

Connectors are JSON files in ``<toolsRoot>/.simple-harmonic/connectors/<KEY>.json``.
Each file stores metadata (name, description, type). The actual secret value
resolves from:
  1. ``.simple-harmonic/secrets.json`` (gitignored, local-only)
  2. ``os.environ``

Agents discover connectors by reading the files with read_file. No VFS, no DB.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from simple_harmonic.tools.sandbox import tools_root
from simple_harmonic.validation import assert_valid_connector_key

_DIR = ".simple-harmonic/connectors"
_SECRETS_FILE = ".simple-harmonic/secrets.json"

ConnectorType = Literal["api_key", "oauth_token", "env_var"]


class ConnectorMeta(BaseModel):
    name: str
    description: str
    type: ConnectorType
    key: str


def _connectors_dir() -> Path:
    return tools_root() / _DIR


def _secrets_path() -> Path:
    return tools_root() / _SECRETS_FILE


def _read_secrets() -> dict[str, str]:
    try:
        p = _secrets_path()
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {k: v for k, v in data.items() if isinstance(v, str)}
    except Exception:
        pass
    return {}


def resolve_connector(key: str) -> str | None:
    """Resolve a connector value by key. Priority: secrets.json > env > None."""
    secrets = _read_secrets()
    if secrets.get(key):
        return secrets[key]
    return os.environ.get(key)


def list_connector_metas() -> list[ConnectorMeta]:
    """List all connector metadata from ``.simple-harmonic/connectors/``."""
    directory = _connectors_dir()
    if not directory.exists():
        return []

    metas: list[ConnectorMeta] = []
    for file in sorted(directory.iterdir()):
        if file.suffix != ".json":
            continue
        try:
            raw = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(raw, dict):
            continue
        metas.append(
            ConnectorMeta(
                name=raw.get("name") or file.stem,
                description=raw.get("description") or "",
                type=raw.get("type") or "api_key",
                key=raw.get("key") or file.stem,
            )
        )
    return metas


def save_connector(meta: ConnectorMeta, secret_value: str | None = None) -> None:
    """Write a connector metadata file + optionally store the secret."""
    assert_valid_connector_key(meta.key)
    directory = _connectors_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{meta.key}.json").write_text(
        json.dumps(meta.model_dump(), indent=2) + "\n", encoding="utf-8"
    )

    if secret_value:
        secrets = _read_secrets()
        secrets[meta.key] = secret_value
        (tools_root() / ".simple-harmonic").mkdir(parents=True, exist_ok=True)
        _secrets_path().write_text(json.dumps(secrets, indent=2) + "\n", encoding="utf-8")


def delete_connector_by_key(key: str) -> bool:
    """Delete a connector metadata file and its secret. Returns whether a
    metadata file was removed."""
    assert_valid_connector_key(key)
    file = _connectors_dir() / f"{key}.json"
    deleted = False
    if file.exists():
        file.unlink()
        deleted = True

    secrets = _read_secrets()
    if key in secrets:
        del secrets[key]
        _secrets_path().write_text(json.dumps(secrets, indent=2) + "\n", encoding="utf-8")

    return deleted
