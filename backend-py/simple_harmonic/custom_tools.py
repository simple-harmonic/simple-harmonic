"""Custom tool loading: flat files in ``.simple-harmonic/skills/``.

TS source: packages/backend/src/server/custom-tools.ts

Each JSON file defines an API tool template. The tick loop reads these files and
registers them into the tool registry. Agents discover them by reading the files
with read_file.

File format (``.simple-harmonic/skills/<name>.json``)::

  {
    "name": "slack_api",
    "description": "Slack Web API",
    "config": {
      "baseUrl": "https://slack.com/api",
      "connectorKey": "SLACK_TOKEN",
      "allowedMethods": ["GET", "POST"],
      "authPrefix": "Bearer"
    }
  }
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from simple_harmonic.store.types import ApiToolConfig
from simple_harmonic.tools.sandbox import tools_root
from simple_harmonic.validation import assert_valid_tool_name

_DIR = ".simple-harmonic/skills"


class CustomToolFile(BaseModel):
    name: str
    description: str
    config: ApiToolConfig


def _skills_dir() -> Path:
    return tools_root() / _DIR


def list_custom_tool_files() -> list[CustomToolFile]:
    """Read and validate every skill file. Skips files missing a name or a
    ``config.baseUrl``, and skips malformed JSON."""
    directory = _skills_dir()
    if not directory.exists():
        return []

    tools: list[CustomToolFile] = []
    for file in sorted(directory.iterdir()):
        if file.suffix != ".json":
            continue
        try:
            raw = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(raw, dict):
            continue
        config = raw.get("config")
        if not raw.get("name") or not isinstance(config, dict) or not config.get("baseUrl"):
            continue
        try:
            tools.append(
                CustomToolFile(
                    name=raw["name"],
                    description=raw.get("description") or "",
                    config=ApiToolConfig.model_validate(config),
                )
            )
        except Exception:
            continue
    return tools


def save_custom_tool_file(tool: CustomToolFile) -> None:
    """Write a skill file. Validates the tool name against path traversal."""
    assert_valid_tool_name(tool.name)
    directory = _skills_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{tool.name}.json").write_text(
        json.dumps(tool.model_dump(), indent=2) + "\n", encoding="utf-8"
    )


def delete_custom_tool_file(name: str) -> bool:
    """Delete a skill file by name. Returns whether a file was removed."""
    assert_valid_tool_name(name)
    file = _skills_dir() / f"{name}.json"
    if not file.exists():
        return False
    file.unlink()
    return True
