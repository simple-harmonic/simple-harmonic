"""Application settings.

Mirrors the TS `config.ts` defaults and reads the SAME environment variables
that the Node backend reads (see repo-root .env.example), so a single .env file
can drive both runtimes during the migration.

TS -> Python mapping:
  config.ts DEFAULTS / getConfig()  ->  Settings (this module)
  process.env.SH_DATA_DIR           ->  Settings.sh_data_dir
  OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
  ANTHROPIC_API_KEY / OPENROUTER_API_KEY
  OPERATOR_PASSWORD / CRON_SECRET
  SH_DAILY_SPEND_CAP_CENTS / SH_ENABLE_TOOLS / SH_TOOLS_CWD
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Defaults lifted verbatim from packages/backend/src/server/config.ts DEFAULTS.
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_CODING_BACKEND = "codex"
DEFAULT_DAILY_SPEND_CAP_CENTS = 5000


class Settings(BaseSettings):
    """Process-wide configuration, populated from env (and optional .env file).

    Field names are snake_case; the env aliases match the TS env var names
    exactly so the existing .env keeps working.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- LLM providers (cascade order: Codex CLI > Anthropic > OpenRouter > OpenAI) ---
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    openai_base_url: str = Field(default=DEFAULT_OPENAI_BASE_URL, alias="OPENAI_BASE_URL")
    openai_model: str = Field(default=DEFAULT_MODEL, alias="OPENAI_MODEL")
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    anthropic_model: str = Field(default="", alias="ANTHROPIC_MODEL")
    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    openrouter_model: str = Field(default="", alias="OPENROUTER_MODEL")

    # --- Store location (TS: SH_DATA_DIR, default .simple-harmonic/data) ---
    sh_data_dir: str | None = Field(default=None, alias="SH_DATA_DIR")

    # --- Operator gate + cron + cost controls ---
    operator_password: str = Field(default="", alias="OPERATOR_PASSWORD")
    cron_secret: str = Field(default="", alias="CRON_SECRET")
    daily_spend_cap_cents: int = Field(
        default=DEFAULT_DAILY_SPEND_CAP_CENTS, alias="SH_DAILY_SPEND_CAP_CENTS"
    )

    # --- Tools ---
    sh_enable_tools: bool = Field(default=False, alias="SH_ENABLE_TOOLS")
    sh_tools_cwd: str | None = Field(default=None, alias="SH_TOOLS_CWD")

    # --- Effective model (TS config.ts: file.model || OPENAI_MODEL || default) ---
    @property
    def model(self) -> str:
        return self.openai_model or DEFAULT_MODEL

    @property
    def data_dir(self) -> Path:
        """Absolute path to the JSON store root.

        TS resolution: SH_DATA_DIR env > <cwd>/.simple-harmonic/data.
        """
        if self.sh_data_dir:
            return Path(self.sh_data_dir).expanduser().resolve()
        return (Path.cwd() / ".simple-harmonic" / "data").resolve()

    @property
    def coding_backend(self) -> str:
        return DEFAULT_CODING_BACKEND

    def is_production(self) -> bool:
        """TS operator-auth.isProductionRuntime() parity (NODE_ENV / VERCEL)."""
        return os.getenv("NODE_ENV") == "production" or bool(os.getenv("VERCEL"))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor. Override in tests via dependency injection or
    by clearing the cache (`get_settings.cache_clear()`).
    """
    return Settings()
