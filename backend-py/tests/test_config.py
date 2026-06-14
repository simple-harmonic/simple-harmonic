"""Tests for simple_harmonic.config.

Ported from packages/backend/tests/unit/config.test.ts. The TS test mocks
node:fs; the Python port reads a real simple-harmonic.config.json relative to
cwd, so each test chdir's into a temp dir and writes (or omits) the file.

DEFAULT MODEL NOTE: config.test.ts asserts the default model is "o4-mini", but
that is STALE — the live config.ts DEFAULTS.model is "gpt-5.5" (changed in the
"change default model" commit, and the env settings.py default agrees). This
port asserts the CURRENT source default (gpt-5.5).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic import config

_ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "SH_DATA_DIR",
    "SH_CODING_BACKEND",
]


@pytest.fixture(autouse=True)
def isolated_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Run each test in a clean temp cwd with config-relevant env cleared and
    the Codex token hook reset to None (matching the TS mock)."""
    monkeypatch.chdir(tmp_path)
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    saved = config.codex_access_token
    config.codex_access_token = lambda: None
    try:
        yield tmp_path
    finally:
        config.codex_access_token = saved


def _write_config(root: Path, data: dict) -> None:
    (root / "simple-harmonic.config.json").write_text(json.dumps(data), encoding="utf-8")


# ---------------------------------------------------------------------------
# get_config
# ---------------------------------------------------------------------------


def test_returns_defaults_when_no_config_file(isolated_cwd: Path) -> None:
    cfg = config.get_config()
    assert cfg.openaiApiKey == ""
    assert cfg.openaiBaseUrl == "https://api.openai.com/v1"
    assert cfg.model == "gpt-5.5"
    assert cfg.dataDir == str(isolated_cwd / ".simple-harmonic" / "data")


def test_reads_values_from_config_file(isolated_cwd: Path) -> None:
    _write_config(
        isolated_cwd,
        {
            "openaiApiKey": "sk-test-key",
            "openaiBaseUrl": "https://custom.api.com/v1",
            "model": "gpt-5.5",
            "dataDir": "/var/lib/simple-harmonic",
        },
    )
    cfg = config.get_config()
    assert cfg.openaiApiKey == "sk-test-key"
    assert cfg.openaiBaseUrl == "https://custom.api.com/v1"
    assert cfg.model == "gpt-5.5"
    assert cfg.dataDir == "/var/lib/simple-harmonic"


def test_falls_back_to_env_when_file_empty(
    isolated_cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(isolated_cwd, {})
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.api.com/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-env")
    monkeypatch.setenv("SH_DATA_DIR", "/env/data/dir")

    cfg = config.get_config()
    assert cfg.openaiApiKey == "sk-env-key"
    assert cfg.openaiBaseUrl == "https://env.api.com/v1"
    assert cfg.model == "gpt-env"
    assert cfg.dataDir == "/env/data/dir"


def test_handles_corrupted_config_file_gracefully(isolated_cwd: Path) -> None:
    (isolated_cwd / "simple-harmonic.config.json").write_text(
        "not valid json {{{", encoding="utf-8"
    )
    cfg = config.get_config()
    assert cfg.model == "gpt-5.5"  # falls back to defaults


def test_file_takes_precedence_over_env(
    isolated_cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(isolated_cwd, {"model": "from-file"})
    monkeypatch.setenv("OPENAI_MODEL", "from-env")
    assert config.get_config().model == "from-file"


def test_file_data_dir_precedence_over_env(
    isolated_cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(isolated_cwd, {"dataDir": "/from/file"})
    monkeypatch.setenv("SH_DATA_DIR", "/from/env")
    assert config.get_config().dataDir == "/from/file"


# ---------------------------------------------------------------------------
# get_api_key_source
# ---------------------------------------------------------------------------


def test_api_key_source_config(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-file"})
    assert config.get_api_key_source() == "config"


def test_api_key_source_env(isolated_cwd: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_config(isolated_cwd, {})
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    assert config.get_api_key_source() == "env"


def test_api_key_source_codex(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {})
    config.codex_access_token = lambda: "codex-token"
    assert config.get_api_key_source() == "codex"


def test_api_key_source_none(isolated_cwd: Path) -> None:
    assert config.get_api_key_source() == "none"


# ---------------------------------------------------------------------------
# set_config
# ---------------------------------------------------------------------------


def test_set_config_writes_merged_config(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"model": "old-model"})
    config.set_config({"model": "new-model"})
    written = json.loads((isolated_cwd / "simple-harmonic.config.json").read_text())
    assert written["model"] == "new-model"


def test_set_config_preserves_existing_fields(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"model": "existing", "dataDir": "/keep/this/dir"})
    config.set_config({"model": "updated"})
    written = json.loads((isolated_cwd / "simple-harmonic.config.json").read_text())
    assert written["model"] == "updated"
    assert written["dataDir"] == "/keep/this/dir"


# ---------------------------------------------------------------------------
# get_safe_config
# ---------------------------------------------------------------------------


def test_safe_config_masks_api_key(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-1234567890abcdef"})
    safe = config.get_safe_config()
    assert safe.openaiApiKey != "sk-1234567890abcdef"
    assert "sk-1" in safe.openaiApiKey
    assert "cdef" in safe.openaiApiKey
    assert "••••" in safe.openaiApiKey


def test_safe_config_masks_empty_api_key_as_empty(isolated_cwd: Path) -> None:
    safe = config.get_safe_config()
    assert safe.openaiApiKey == ""


def test_safe_config_masks_short_key_as_dots(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-short"})  # exactly 8 chars
    safe = config.get_safe_config()
    assert safe.openaiApiKey == "••••••••"


def test_safe_config_masks_long_key_first4_last4(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-123456789"})
    safe = config.get_safe_config()
    assert safe.openaiApiKey == "sk-1••••6789"


def test_safe_config_data_dir_unmasked(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"dataDir": "/var/lib/simple-harmonic/data"})
    safe = config.get_safe_config()
    assert safe.dataDir == "/var/lib/simple-harmonic/data"


def test_safe_config_has_flags(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-test", "dataDir": "/some/data/dir"})
    safe = config.get_safe_config()
    assert safe.hasOpenaiKey is True
    assert safe.hasDataDir is True


def test_safe_config_reports_api_key_source(isolated_cwd: Path) -> None:
    _write_config(isolated_cwd, {"openaiApiKey": "sk-test"})
    safe = config.get_safe_config()
    assert safe.apiKeySource == "config"


def test_safe_config_includes_coding_backend_and_config(isolated_cwd: Path) -> None:
    safe = config.get_safe_config()
    assert safe.codingBackend == "codex"
    assert safe.codingConfig is not None
