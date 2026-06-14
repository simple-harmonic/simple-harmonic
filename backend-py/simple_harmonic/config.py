"""File-based application config over simple-harmonic.config.json.

TS source: packages/backend/src/server/config.ts

This is the config-FILE layer (simple-harmonic.config.json in cwd), kept
deliberately SEPARATE from settings.py (the env-based process settings). The TS
codebase has both: config.ts resolves API key / model / dataDir from the JSON
file with env fallbacks and exposes a masked "safe" view for the client, while
the env settings drive runtime wiring. Mirroring that split keeps the wire
contract of GET /api/settings/config identical.

Resolution precedence (matches getConfig): file value > env var > Codex CLI
token (api key only) > default.

The Codex access token lookup is a hook (codex_access_token) so this module
stays free of the codex-auth dependency; it defaults to returning None, which
the config tests rely on (they mock it to null).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

CodingBackendType = Literal["codex", "claude-code", "opencode"]
ApiKeySource = Literal["config", "env", "codex", "none"]

# Defaults lifted from packages/backend/src/server/config.ts DEFAULTS.
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_CODING_BACKEND: CodingBackendType = "codex"
_CODING_BACKENDS: tuple[CodingBackendType, ...] = ("codex", "claude-code", "opencode")


def _config_path() -> Path:
    """Resolved at call time so tests and a relocated cwd see the right file
    (TS computes CONFIG_PATH once at import; computing per-call is strictly more
    flexible and matches how getConfig re-reads the file each call)."""
    return Path.cwd() / "simple-harmonic.config.json"


def _default_data_dir() -> str:
    return str(Path.cwd() / ".simple-harmonic" / "data")


class CodingBackendConfig(BaseModel):
    model: str | None = None
    timeout: int | None = None


class AppConfig(BaseModel):
    openaiApiKey: str
    openaiBaseUrl: str
    model: str
    # Root directory of the JSON file store (replaces the old databaseUrl).
    dataDir: str
    codingBackend: CodingBackendType
    codingConfig: dict[CodingBackendType, CodingBackendConfig]


class SafeConfig(BaseModel):
    """Config with secrets masked for the client (getSafeConfig)."""

    openaiApiKey: str
    openaiBaseUrl: str
    model: str
    dataDir: str
    hasOpenaiKey: bool
    hasDataDir: bool
    apiKeySource: ApiKeySource
    codingBackend: CodingBackendType
    codingConfig: dict[CodingBackendType, CodingBackendConfig]


# Override in tests; defaults to "no Codex CLI token available". Matches the
# TS getCodexAccessToken() import (mocked to null in config.test.ts).
codex_access_token: Callable[[], str | None] = lambda: None  # noqa: E731


def _read_file() -> dict[str, object]:
    """Read simple-harmonic.config.json; return {} on missing/corrupt file."""
    try:
        path = _config_path()
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _coding_config_from(
    file_coding: dict[str, object] | None,
) -> dict[CodingBackendType, CodingBackendConfig]:
    def merge(name: CodingBackendType) -> CodingBackendConfig:
        raw = (file_coding or {}).get(name) if file_coding else None
        if isinstance(raw, dict):
            return CodingBackendConfig.model_validate(raw)
        return CodingBackendConfig()

    return {name: merge(name) for name in _CODING_BACKENDS}


def get_config() -> AppConfig:
    """Resolve the effective config from file > env > codex > defaults."""
    file = _read_file()

    api_key = (
        _str(file.get("openaiApiKey"))
        or os.environ.get("OPENAI_API_KEY")
        or codex_access_token()
        or ""
    )

    coding_raw = (
        _str(file.get("codingBackend"))
        or os.environ.get("SH_CODING_BACKEND")
        or DEFAULT_CODING_BACKEND
    )
    coding_backend: CodingBackendType = (
        coding_raw if coding_raw in _CODING_BACKENDS else DEFAULT_CODING_BACKEND  # type: ignore[assignment]
    )

    file_coding = file.get("codingConfig")
    coding_config = _coding_config_from(file_coding if isinstance(file_coding, dict) else None)

    return AppConfig(
        openaiApiKey=api_key,
        openaiBaseUrl=(
            _str(file.get("openaiBaseUrl"))
            or os.environ.get("OPENAI_BASE_URL")
            or DEFAULT_OPENAI_BASE_URL
        ),
        model=_str(file.get("model")) or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
        dataDir=_str(file.get("dataDir")) or os.environ.get("SH_DATA_DIR") or _default_data_dir(),
        codingBackend=coding_backend,
        codingConfig=coding_config,
    )


def get_api_key_source() -> ApiKeySource:
    """Which source the API key came from."""
    file = _read_file()
    if _str(file.get("openaiApiKey")):
        return "config"
    if os.environ.get("OPENAI_API_KEY"):
        return "env"
    if codex_access_token():
        return "codex"
    return "none"


def set_config(partial: dict[str, object]) -> AppConfig:
    """Merge `partial` into the on-disk config and return the resolved config."""
    current = _read_file()
    merged = {**current, **partial}
    _config_path().write_text(f"{json.dumps(merged, indent=2)}\n", encoding="utf-8")
    return get_config()


def get_safe_config() -> SafeConfig:
    """Return config with secrets masked for the client."""
    cfg = get_config()
    return SafeConfig(
        openaiApiKey=_mask_secret(cfg.openaiApiKey),
        openaiBaseUrl=cfg.openaiBaseUrl,
        model=cfg.model,
        dataDir=cfg.dataDir,
        hasOpenaiKey=len(cfg.openaiApiKey) > 0,
        hasDataDir=len(cfg.dataDir) > 0,
        apiKeySource=get_api_key_source(),
        codingBackend=cfg.codingBackend,
        codingConfig=cfg.codingConfig,
    )


def _mask_secret(s: str) -> str:
    if not s:
        return ""
    if len(s) <= 8:
        return "••••••••"
    return f"{s[:4]}••••{s[-4:]}"


def _str(value: object) -> str:
    """Coerce a JSON value to a non-empty string or "" (TS treats missing/empty
    as falsy and falls through the `||` chain)."""
    return value if isinstance(value, str) else ""
