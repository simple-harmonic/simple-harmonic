"""Tests for simple_harmonic.validation.

Ported from the TS source's path-safety contract (packages/backend/src/server/
validation.ts has no standalone *.test.ts; these assert the documented regex
behavior directly — connector keys must be env-var-style and tool names must be
identifier-style, both anchored so "../../secrets" and similar can't slip
through).
"""

from __future__ import annotations

import pytest

from simple_harmonic.validation import (
    assert_valid_connector_key,
    assert_valid_tool_name,
    is_valid_connector_key,
    is_valid_tool_name,
)


@pytest.mark.parametrize(
    "key",
    ["GITHUB_TOKEN", "SLACK_BOT_TOKEN", "A", "X1", "OPENAI_API_KEY", "A_B_C_123"],
)
def test_valid_connector_keys(key: str) -> None:
    assert is_valid_connector_key(key) is True


@pytest.mark.parametrize(
    "key",
    [
        "github_token",  # lowercase
        "1ABC",  # starts with digit
        "_ABC",  # starts with underscore
        "../../secrets",  # path traversal
        "A-B",  # hyphen not allowed
        "A.B",  # dot not allowed
        "A B",  # space
        "",  # empty
        "FOO\nBAR",  # newline injection
    ],
)
def test_invalid_connector_keys(key: str) -> None:
    assert is_valid_connector_key(key) is False


def test_connector_key_non_string_is_invalid() -> None:
    assert is_valid_connector_key(None) is False
    assert is_valid_connector_key(123) is False
    assert is_valid_connector_key(["GITHUB_TOKEN"]) is False


@pytest.mark.parametrize(
    "name",
    ["slack_api", "my-tool", "Tool", "a", "b1", "X_y-Z_9"],
)
def test_valid_tool_names(name: str) -> None:
    assert is_valid_tool_name(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "1tool",  # starts with digit
        "-tool",  # starts with hyphen
        "_tool",  # starts with underscore
        "../evil",  # path traversal
        "a/b",  # slash
        "a.b",  # dot
        "",  # empty
        "a b",  # space
    ],
)
def test_invalid_tool_names(name: str) -> None:
    assert is_valid_tool_name(name) is False


def test_assert_valid_connector_key_returns_value_or_raises() -> None:
    assert assert_valid_connector_key("GITHUB_TOKEN") == "GITHUB_TOKEN"
    with pytest.raises(ValueError, match="invalid connector key"):
        assert_valid_connector_key("../../secrets")


def test_assert_valid_tool_name_returns_value_or_raises() -> None:
    assert assert_valid_tool_name("slack_api") == "slack_api"
    with pytest.raises(ValueError, match="invalid tool name"):
        assert_valid_tool_name("../evil")
