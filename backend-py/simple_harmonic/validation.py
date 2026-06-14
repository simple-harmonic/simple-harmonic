"""Input validators for identifiers interpolated into filesystem paths.

TS source: packages/backend/src/server/validation.ts

Connector keys land at .simple-harmonic/connectors/<KEY>.json and skill/tool
names at .simple-harmonic/skills/<name>.json; without these guards a key like
"../../secrets" escapes the intended directory. Reused at the API boundary AND
inside the path-building helpers (defense in depth).

TS `is*` type guards -> Python bool predicates; TS `assert*` (which narrow to
`string`) -> functions that raise ValueError on bad input.
"""

from __future__ import annotations

import json
import re

# Connector keys are env-var-style, e.g. GITHUB_TOKEN, SLACK_BOT_TOKEN.
CONNECTOR_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

# Skill/tool names are lowercase-ish identifiers, e.g. slack_api, my-tool.
TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")


def is_valid_connector_key(key: object) -> bool:
    return isinstance(key, str) and CONNECTOR_KEY_RE.match(key) is not None


def is_valid_tool_name(name: object) -> bool:
    return isinstance(name, str) and TOOL_NAME_RE.match(name) is not None


def assert_valid_connector_key(key: object) -> str:
    """Return the key when valid; raise ValueError otherwise (mirrors the TS
    `asserts ... is string`)."""
    if not is_valid_connector_key(key):
        raise ValueError(
            f"invalid connector key: {json.dumps(key)} "
            f"(must match {CONNECTOR_KEY_RE.pattern})"
        )
    assert isinstance(key, str)
    return key


def assert_valid_tool_name(name: object) -> str:
    if not is_valid_tool_name(name):
        raise ValueError(
            f"invalid tool name: {json.dumps(name)} (must match {TOOL_NAME_RE.pattern})"
        )
    assert isinstance(name, str)
    return name
