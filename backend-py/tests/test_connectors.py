"""Connector resolution + path-traversal validation tests.

TS source: packages/backend/tests/unit/connectors.test.ts
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic.connectors import (
    ConnectorMeta,
    delete_connector_by_key,
    list_connector_metas,
    resolve_connector,
    save_connector,
)


@pytest.fixture
def tools_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    monkeypatch.setenv("SH_TOOLS_CWD", str(tmp_path))
    yield tmp_path


# --- resolve_connector ------------------------------------------------------


def test_resolves_from_secrets_json(tools_cwd: Path) -> None:
    sh_dir = tools_cwd / ".simple-harmonic"
    sh_dir.mkdir(parents=True)
    (sh_dir / "secrets.json").write_text(json.dumps({"MY_TOKEN": "secret123"}))
    assert resolve_connector("MY_TOKEN") == "secret123"


def test_falls_back_to_env(tools_cwd: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FALLBACK_KEY", "from-env")
    assert resolve_connector("FALLBACK_KEY") == "from-env"


def test_returns_none_when_not_found(tools_cwd: Path) -> None:
    assert resolve_connector("DOES_NOT_EXIST_XYZ") is None


def test_secrets_priority_over_env(tools_cwd: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PRIORITY_KEY", "env-value")
    sh_dir = tools_cwd / ".simple-harmonic"
    sh_dir.mkdir(parents=True)
    (sh_dir / "secrets.json").write_text(json.dumps({"PRIORITY_KEY": "file-value"}))
    assert resolve_connector("PRIORITY_KEY") == "file-value"


# --- list_connector_metas ---------------------------------------------------


def test_list_empty_when_no_dir(tools_cwd: Path) -> None:
    assert list_connector_metas() == []


def test_list_reads_metadata_files(tools_cwd: Path) -> None:
    directory = tools_cwd / ".simple-harmonic" / "connectors"
    directory.mkdir(parents=True)
    (directory / "SLACK_TOKEN.json").write_text(
        json.dumps(
            {
                "name": "Slack",
                "description": "Slack bot token",
                "type": "api_key",
                "key": "SLACK_TOKEN",
            }
        )
    )
    metas = list_connector_metas()
    assert len(metas) == 1
    assert metas[0].name == "Slack"
    assert metas[0].key == "SLACK_TOKEN"


def test_list_skips_malformed_files(tools_cwd: Path) -> None:
    directory = tools_cwd / ".simple-harmonic" / "connectors"
    directory.mkdir(parents=True)
    (directory / "BAD.json").write_text("not json{{{")
    (directory / "GOOD.json").write_text(
        json.dumps({"name": "Good", "key": "GOOD", "type": "api_key"})
    )
    metas = list_connector_metas()
    assert len(metas) == 1
    assert metas[0].key == "GOOD"


# --- save_connector ---------------------------------------------------------


def test_save_creates_metadata_file(tools_cwd: Path) -> None:
    save_connector(
        ConnectorMeta(name="Test", description="A test", type="api_key", key="TEST_KEY")
    )
    file = tools_cwd / ".simple-harmonic" / "connectors" / "TEST_KEY.json"
    assert file.exists()
    assert json.loads(file.read_text())["name"] == "Test"


def test_save_stores_secret(tools_cwd: Path) -> None:
    save_connector(
        ConnectorMeta(name="Test", description="", type="api_key", key="SECRET_KEY"),
        "my-secret-value",
    )
    secrets = json.loads((tools_cwd / ".simple-harmonic" / "secrets.json").read_text())
    assert secrets["SECRET_KEY"] == "my-secret-value"


# --- delete_connector_by_key ------------------------------------------------


def test_delete_removes_metadata_and_secret(tools_cwd: Path) -> None:
    save_connector(
        ConnectorMeta(name="Del", description="", type="api_key", key="DEL_KEY"), "to-delete"
    )
    assert resolve_connector("DEL_KEY") == "to-delete"
    assert delete_connector_by_key("DEL_KEY") is True
    assert resolve_connector("DEL_KEY") is None


def test_delete_returns_false_for_missing(tools_cwd: Path) -> None:
    assert delete_connector_by_key("NOPE") is False


# --- key validation (path traversal) ---------------------------------------


@pytest.mark.parametrize("bad", ["../../x", "../escape", "a/b", "", "lower", "BAD.KEY"])
def test_save_rejects_bad_keys(tools_cwd: Path, bad: str) -> None:
    with pytest.raises(ValueError):
        save_connector(ConnectorMeta(name="X", description="", type="api_key", key=bad), "v")


def test_save_never_writes_outside_dir_for_traversal_key(tools_cwd: Path) -> None:
    escape_target = tools_cwd / ".simple-harmonic" / "pwned.json"
    with pytest.raises(ValueError):
        save_connector(
            ConnectorMeta(name="X", description="", type="api_key", key="../pwned"), "v"
        )
    assert not escape_target.exists()


@pytest.mark.parametrize("bad", ["../../x", "a/b", ""])
def test_delete_rejects_traversal_keys(tools_cwd: Path, bad: str) -> None:
    with pytest.raises(ValueError):
        delete_connector_by_key(bad)


def test_valid_uppercase_key_round_trips(tools_cwd: Path) -> None:
    save_connector(
        ConnectorMeta(name="OK", description="", type="api_key", key="VALID_KEY"), "v"
    )
    assert resolve_connector("VALID_KEY") == "v"
