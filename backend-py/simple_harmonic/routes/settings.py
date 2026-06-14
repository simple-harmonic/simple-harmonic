"""settings/* endpoints.

TS source: packages/backend/src/server/api/settings/*.ts

The settings/* routes sit behind the shared operator gate (OPERATOR_PASSWORD),
enforced by the middleware in :mod:`simple_harmonic.app`; the handlers themselves
do no auth (they assume the gate passed).

Endpoints (one per TS module):
  index.ts            GET  /api/settings                  (safe/masked config)
                      POST /api/settings                  (update config)
  coding.ts           GET  /api/settings/coding
  codex.ts            GET  /api/settings/codex
                      POST /api/settings/codex            (refresh token)
  codex-login.ts      GET  /api/settings/codex-login
                      POST /api/settings/codex-login      (spawn `codex login`)
  connectors.ts       GET  /api/settings/connectors
                      POST /api/settings/connectors
                      DELETE /api/settings/connectors
  credentials.ts      POST /api/settings/credentials      (writes Apollo vault)
  platform-status.ts  GET  /api/settings/platform-status
                      PUT  /api/settings/platform-status
  setup-db.ts         POST /api/settings/setup-db         (ensure data-dir)
  skills.ts           GET  /api/settings/skills
                      PATCH /api/settings/skills          (set agent tools)
  telemetry.ts        GET  /api/settings/telemetry
                      PUT  /api/settings/telemetry
  test-db.ts          POST /api/settings/test-db
  test-llm.ts         POST /api/settings/test-llm
"""

from __future__ import annotations

import shutil
import subprocess
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from simple_harmonic import apollo
from simple_harmonic import connectors as connectors_mod
from simple_harmonic.config import (
    SafeConfig,
    get_config,
    get_safe_config,
    set_config,
)
from simple_harmonic.connectors import ConnectorMeta
from simple_harmonic.dependencies import get_store
from simple_harmonic.llm import codex_auth
from simple_harmonic.store import data_dir as dd
from simple_harmonic.store.base import Store
from simple_harmonic.store.repos import agents, teams
from simple_harmonic.store.types import PlatformStatus
from simple_harmonic.tools.index import create_app_registry
from simple_harmonic.validation import CONNECTOR_KEY_RE, is_valid_connector_key
from simple_harmonic.wiring import invalidate_telemetry_cache

router = APIRouter(prefix="/api/settings", tags=["settings"])

_VALID_STATUSES = ("healthy", "degraded", "maintenance")
_KEY_FORMAT_ERROR = (
    "key must be uppercase letters, digits, and underscores (e.g. GITHUB_TOKEN)"
)
_CODING_BACKENDS: tuple[str, ...] = ("codex", "claude-code", "opencode")


def _mask_secret(s: str) -> str:
    """Two-bullet mask used by config/coding (matches the unicode-bullet form of
    config.py._mask_secret)."""
    if not s or len(s) <= 8:
        return "••••••••" if s else ""
    return f"{s[:4]}••••{s[-4:]}"


def _mask_secret_stars(s: str) -> str:
    """Asterisk mask used by the connectors handler (matches connectors.ts)."""
    if not s:
        return ""
    if len(s) <= 8:
        return "********"
    return f"{s[:4]}****{s[-4:]}"


# ---------------------------------------------------------------------------
# index.ts — GET/POST /api/settings (safe config + update)
# ---------------------------------------------------------------------------


@router.get("", response_model=SafeConfig)
async def get_settings_config() -> SafeConfig:
    """Masked config view for the client (getSafeConfig)."""
    return get_safe_config()


@router.post("")
async def update_settings_config(request: Request) -> Any:
    """Merge string fields + codingConfig into the on-disk config; 400 when no
    valid fields are present."""
    body = await _read_json(request)

    string_fields = ("openaiApiKey", "openaiBaseUrl", "model", "dataDir", "codingBackend")
    update: dict[str, object] = {}
    for key in string_fields:
        value = body.get(key)
        if isinstance(value, str) and len(value) > 0:
            update[key] = value

    coding_config = body.get("codingConfig")
    if isinstance(coding_config, dict):
        current = get_config().codingConfig
        merged = {name: cfg.model_dump() for name, cfg in current.items()}
        for backend in _CODING_BACKENDS:
            patch = coding_config.get(backend)
            if isinstance(patch, dict):
                merged[backend] = {**merged[backend], **patch}
        update["codingConfig"] = merged

    if not update:
        return JSONResponse({"error": "no valid fields"}, status_code=400)

    set_config(update)
    return JSONResponse(get_safe_config().model_dump())


# ---------------------------------------------------------------------------
# coding.ts — GET /api/settings/coding (CLI status + coding-backend connectors)
# ---------------------------------------------------------------------------


def _check_cli(name: str) -> dict[str, Any]:
    """Run ``<name> --version`` and report install state + first-line version.

    Mirrors coding.ts ``checkCli``: any spawn/exit error -> not installed.
    OFFLINE: this only execs a local binary, never the network. In tests the
    helper is patched so no subprocess runs.
    """
    binary = shutil.which(name)
    if not binary:
        return {"installed": False, "version": None}
    try:
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return {"installed": False, "version": None}
    if proc.returncode != 0:
        return {"installed": False, "version": None}
    first_line = (proc.stdout or "").strip().split("\n")[0] or None
    return {"installed": True, "version": first_line}


def _coding_connector(
    *, name: str, env_var: str, configured: bool, value: str | None
) -> dict[str, Any]:
    """Coding-backend connector entry. ``value`` is OMITTED when None to match the
    TS ``value: ... || undefined`` (JSON.stringify drops undefined keys)."""
    row: dict[str, Any] = {"name": name, "envVar": env_var, "configured": configured}
    if value is not None:
        row["value"] = value
    return row


@router.get("/coding")
async def get_coding(request: Request) -> Any:
    cfg = get_config()
    codex = _check_cli("codex")
    claude = _check_cli("claude")
    opencode = _check_cli("opencode")

    codex_status = codex_auth.get_codex_auth_status()
    import os

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or ""
    openai_key = os.environ.get("OPENAI_API_KEY") or ""
    codex_authed = codex_status.found and codex_status.hasAccessToken

    coding_config = {name: cfg.model_dump() for name, cfg in cfg.codingConfig.items()}

    return JSONResponse(
        {
            "current": cfg.codingBackend,
            "codingConfig": coding_config,
            "backends": {
                "codex": {
                    "installed": codex["installed"],
                    "version": codex["version"],
                    "authenticated": codex_authed,
                    "account": codex_status.email,
                    "plan": codex_status.plan,
                    "connectors": [
                        _coding_connector(
                            name="Codex OAuth",
                            env_var="~/.codex/auth.json",
                            configured=codex_authed,
                            value=codex_status.email or None,
                        )
                    ],
                },
                "claude-code": {
                    "installed": claude["installed"],
                    "version": claude["version"],
                    "authenticated": len(anthropic_key) > 0,
                    "connectors": [
                        _coding_connector(
                            name="Anthropic API Key",
                            env_var="ANTHROPIC_API_KEY",
                            configured=len(anthropic_key) > 0,
                            value=_mask_secret(anthropic_key) if anthropic_key else None,
                        )
                    ],
                },
                "opencode": {
                    "installed": opencode["installed"],
                    "version": opencode["version"],
                    "authenticated": len(anthropic_key) > 0 or len(openai_key) > 0,
                    "connectors": [
                        _coding_connector(
                            name="Anthropic API Key",
                            env_var="ANTHROPIC_API_KEY",
                            configured=len(anthropic_key) > 0,
                            value=_mask_secret(anthropic_key) if anthropic_key else None,
                        ),
                        _coding_connector(
                            name="OpenAI API Key",
                            env_var="OPENAI_API_KEY",
                            configured=len(openai_key) > 0,
                            value=_mask_secret(openai_key) if openai_key else None,
                        ),
                    ],
                },
            },
        }
    )


# ---------------------------------------------------------------------------
# codex.ts — GET/POST /api/settings/codex (auth status + models / refresh)
# ---------------------------------------------------------------------------


@router.get("/codex")
async def get_codex() -> Any:
    status = codex_auth.get_codex_auth_status()
    models = codex_auth.get_codex_models()
    return JSONResponse(
        {
            "found": status.found,
            "authMode": status.authMode,
            "email": status.email,
            "plan": status.plan,
            "accountId": status.accountId,
            "lastRefresh": status.lastRefresh,
            "tokenExpiry": status.tokenExpiry,
            "hasAccessToken": status.hasAccessToken,
            "models": [
                {
                    "slug": m.slug,
                    "displayName": m.displayName,
                    "description": m.description,
                    "priority": m.priority,
                    "supportedInApi": m.supportedInApi,
                }
                for m in models
            ],
        }
    )


@router.post("/codex")
async def refresh_codex() -> Any:
    result = codex_auth.refresh_codex_token()
    payload: dict[str, Any] = {"ok": result.ok}
    if result.accessToken is not None:
        payload["accessToken"] = result.accessToken
    if result.error is not None:
        payload["error"] = result.error
    return JSONResponse(payload)


# ---------------------------------------------------------------------------
# codex-login.ts — GET/POST /api/settings/codex-login (spawn `codex login`)
# ---------------------------------------------------------------------------

# Track the running login process (module state, mirroring the TS module vars).
_login_process: subprocess.Popen[bytes] | None = None
_login_started_at: float = 0.0


def _codex_login_running() -> bool:
    """Whether a tracked `codex login` process is still alive."""
    global _login_process
    if _login_process is None:
        return False
    if _login_process.poll() is not None:
        _login_process = None
        return False
    return True


@router.get("/codex-login")
async def get_codex_login() -> Any:
    status = codex_auth.get_codex_auth_status()
    return JSONResponse(
        {
            "authenticated": status.found and status.hasAccessToken,
            "loginRunning": _codex_login_running(),
        }
    )


# Overridable for tests so nothing spawns a real `codex login` subprocess.
def _spawn_codex_login() -> subprocess.Popen[bytes]:  # pragma: no cover - real spawn
    return subprocess.Popen(
        ["codex", "login"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )


@router.post("/codex-login")
async def post_codex_login(request: Request) -> Any:
    import time

    global _login_process, _login_started_at

    force = request.query_params.get("force") == "true"

    status = codex_auth.get_codex_auth_status()
    if not force and status.found and status.hasAccessToken:
        return JSONResponse({"ok": True, "status": "already_authenticated"})

    # Kill a stale process (older than 5 minutes).
    if _login_process is not None and time.time() - _login_started_at > 5 * 60:
        with _suppress():
            _login_process.kill()
        _login_process = None

    if _codex_login_running():
        return JSONResponse({"ok": True, "status": "already_running"})

    # For a forced re-auth, delete ~/.codex/auth.json so `codex login` doesn't
    # short-circuit on the existing token (best-effort).
    if force:
        with _suppress():
            path = codex_auth._codex_auth_path()
            if path.exists():
                path.unlink()

    try:
        proc = _spawn_codex_login()
    except Exception as err:
        print(f"[codex-login] spawn failed: {err}")
        return JSONResponse(
            {
                "ok": False,
                "error": (
                    "Failed to spawn `codex` — is the codex CLI installed and on PATH?"
                ),
            },
            status_code=500,
        )

    _login_process = proc
    _login_started_at = time.time()
    return JSONResponse({"ok": True, "status": "started"})


# ---------------------------------------------------------------------------
# connectors.ts — GET/POST/DELETE /api/settings/connectors
# ---------------------------------------------------------------------------


def _connector_status(
    *,
    id: str,
    name: str,
    description: str,
    configured: bool,
    masked_value: str | None,
    env_var: str,
    source: str,
) -> dict[str, Any]:
    """Build a ConnectorStatus dict, OMITTING ``maskedValue`` when it is None.

    The TS ``ConnectorStatus.maskedValue`` is ``string | undefined`` and is built
    with ``... : undefined``, so ``JSON.stringify`` drops the key entirely when
    unset. Emitting ``"maskedValue": null`` would diverge from the TS wire shape,
    so we omit the key instead (matching the null-vs-undefined handling used in the
    team/core message handlers).
    """
    row: dict[str, Any] = {
        "id": id,
        "name": name,
        "description": description,
        "configured": configured,
    }
    if masked_value is not None:
        row["maskedValue"] = masked_value
    row["envVar"] = env_var
    row["source"] = source
    return row


def _builtin_connectors() -> list[dict[str, Any]]:
    import os

    from simple_harmonic.tools.sandbox import tools_enabled, tools_root

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or ""
    openrouter_key = os.environ.get("OPENROUTER_API_KEY") or ""
    github_token = connectors_mod.resolve_connector("GITHUB_TOKEN")

    enabled = tools_enabled()
    return [
        _connector_status(
            id="builtin-tools-enabled",
            name="Agent Tools",
            description=(
                "Master switch for destructive tools (write_file, run_command, "
                "mutating github_api). Read-only tools always work."
            ),
            configured=enabled,
            masked_value="enabled" if enabled else "disabled",
            env_var="SH_ENABLE_TOOLS",
            source="env",
        ),
        _connector_status(
            id="builtin-tools-cwd",
            name="Project Root",
            description=(
                "Working directory for agent file and shell operations. All paths "
                "are jailed to this directory."
            ),
            configured=True,
            masked_value=str(tools_root()),
            env_var="SH_TOOLS_CWD",
            source="env",
        ),
        _connector_status(
            id="builtin-anthropic",
            name="Anthropic API",
            description="Claude models for agent LLM calls.",
            configured=len(anthropic_key) > 0,
            masked_value=_mask_secret_stars(anthropic_key) if anthropic_key else None,
            env_var="ANTHROPIC_API_KEY",
            source="env",
        ),
        _connector_status(
            id="builtin-openrouter",
            name="OpenRouter",
            description=(
                "OpenRouter API key. Cascade fallback for agent LLM calls (set "
                "OPENROUTER_MODEL / OPENROUTER_FALLBACK_MODELS to pick models)."
            ),
            configured=len(openrouter_key) > 0,
            masked_value=_mask_secret_stars(openrouter_key) if openrouter_key else None,
            env_var="OPENROUTER_API_KEY",
            source="env",
        ),
        _connector_status(
            id="builtin-github",
            name="GitHub",
            description="GitHub personal access token for the github_api tool.",
            configured=bool(github_token),
            masked_value=_mask_secret_stars(github_token) if github_token else None,
            env_var="GITHUB_TOKEN",
            source="env",
        ),
    ]


@router.get("/connectors")
async def list_connectors() -> Any:
    builtin = _builtin_connectors()
    builtin_env_vars = {b["envVar"] for b in builtin}

    file_connectors: list[dict[str, Any]] = []
    for meta in connectors_mod.list_connector_metas():
        if meta.key in builtin_env_vars:
            continue
        value = connectors_mod.resolve_connector(meta.key)
        file_connectors.append(
            _connector_status(
                id=f"file-{meta.key}",
                name=meta.name,
                description=meta.description,
                configured=bool(value),
                masked_value=_mask_secret_stars(value) if value else None,
                env_var=meta.key,
                source="file",
            )
        )

    return JSONResponse({"connectors": [*builtin, *file_connectors]})


@router.post("/connectors")
async def save_connector_route(request: Request) -> Any:
    body = await _read_json(request)
    name = body.get("name")
    key = body.get("key")
    value = body.get("value")
    description = body.get("description")
    ctype = body.get("type")

    if not name or not key:
        return JSONResponse({"error": "name and key are required"}, status_code=400)

    if not is_valid_connector_key(key):
        return JSONResponse({"error": _KEY_FORMAT_ERROR}, status_code=400)

    connectors_mod.save_connector(
        ConnectorMeta(
            name=name,
            key=key,
            description=description if isinstance(description, str) else "",
            type=ctype if ctype in ("api_key", "oauth_token", "env_var") else "api_key",
        ),
        value if isinstance(value, str) and value else None,
    )

    return JSONResponse({"ok": True, "key": key})


@router.delete("/connectors")
async def delete_connector_route(request: Request) -> Any:
    key = request.query_params.get("key")
    if not key:
        return JSONResponse({"error": "key is required"}, status_code=400)

    if not is_valid_connector_key(key):
        return JSONResponse({"error": _KEY_FORMAT_ERROR}, status_code=400)

    deleted = connectors_mod.delete_connector_by_key(key)
    if not deleted:
        return JSONResponse({"error": "Connector not found"}, status_code=404)

    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# credentials.ts — POST /api/settings/credentials (writes the Apollo vault)
# ---------------------------------------------------------------------------


@router.post("/credentials")
async def post_credentials(request: Request) -> Any:
    body = await _read_json(request)
    key = body.get("key")
    value = body.get("value")

    if not key or not isinstance(key, str) or not CONNECTOR_KEY_RE.match(key):
        return JSONResponse(
            {"error": "key must be uppercase with underscores (e.g. GITHUB_TOKEN)"},
            status_code=400,
        )

    if not value or not isinstance(value, str) or len(value) < 1:
        return JSONResponse({"error": "value is required"}, status_code=400)

    # Encrypt and persist via Apollo (also sets os.environ immediately).
    apollo.set(key, value)

    return JSONResponse({"ok": True, "key": key})


# ---------------------------------------------------------------------------
# platform-status.ts — GET (above) + PUT /api/settings/platform-status
# ---------------------------------------------------------------------------


@router.get("/platform-status", response_model=PlatformStatus)
async def get_platform_status(
    store: Annotated[Store, Depends(get_store)],
) -> PlatformStatus:
    """Returns the stored status, or the default healthy row when never set.

    Status code 200 always (default object on unset; no 404).
    """
    existing = await store.get_platform_status()
    if existing is not None:
        return existing
    return PlatformStatus(id=1, status="healthy", message=None, updatedAt=datetime.now(UTC))


@router.put("/platform-status")
async def put_platform_status(
    request: Request,
    store: Annotated[Store, Depends(get_store)],
) -> Any:
    body = await _read_json_or_none(request)
    status = body.get("status") if isinstance(body, dict) else None

    if not isinstance(body, dict) or status not in _VALID_STATUSES:
        return JSONResponse(
            {"error": f"status must be one of: {', '.join(_VALID_STATUSES)}"},
            status_code=400,
        )

    message = body.get("message")
    message = message if isinstance(message, str) else None
    await store.set_platform_status(status, message)
    return JSONResponse({"ok": True, "status": status, "message": message})


# ---------------------------------------------------------------------------
# setup-db.ts — POST /api/settings/setup-db (ensure the data-dir skeleton)
# ---------------------------------------------------------------------------


@router.post("/setup-db")
async def setup_db(request: Request) -> Any:
    steps: list[str] = []
    body = await _read_json(request)
    try:
        data_dir_in = body.get("dataDir")
        if isinstance(data_dir_in, str) and data_dir_in.strip():
            set_config({"dataDir": data_dir_in.strip()})
            steps.append(f"Set data directory to {data_dir_in.strip()}")

        directory = dd.ensure_data_dir()
        steps.append(f"Data directory ready: {directory}")

        return JSONResponse({"ok": True, "steps": steps})
    except Exception as err:
        return JSONResponse(
            {"ok": False, "steps": steps, "error": str(err) or "setup failed"}
        )


# ---------------------------------------------------------------------------
# skills.ts — GET/PATCH /api/settings/skills (tool defs + agent tool assignment)
# ---------------------------------------------------------------------------


@router.get("/skills")
async def get_skills() -> Any:
    registry = create_app_registry()
    all_defs = registry.list_for_agent()

    all_agents: list[Any] = []
    team_map: dict[str, str] = {}
    try:
        all_agents = await agents.all()
        all_teams = await teams.all()
        team_map = {t.id: t.name for t in all_teams}
    except Exception:
        all_agents = []
        team_map = {}

    skills: list[dict[str, Any]] = []
    for d in all_defs:
        using = [a for a in all_agents if d.name in (a.tools or [])]
        skills.append(
            {
                "name": d.name,
                "description": d.description,
                "category": d.category,
                "risk": d.risk,
                "agentCount": len(using),
                "agents": [
                    {
                        "id": a.id,
                        "name": a.name,
                        "teamName": team_map.get(a.teamId, "Unknown"),
                    }
                    for a in using
                ],
            }
        )

    return JSONResponse({"skills": skills})


@router.patch("/skills")
async def patch_skills(request: Request) -> Any:
    body = await _read_json(request)
    agent_id = body.get("agentId")
    tools = body.get("tools")

    if not agent_id or not isinstance(tools, list):
        return JSONResponse({"error": "agentId and tools[] required"}, status_code=400)

    registry = create_app_registry()
    valid_names = {d.name for d in registry.list_for_agent()}
    invalid = [t for t in tools if t not in valid_names]
    if invalid:
        return JSONResponse(
            {"error": f"Unknown tools: {', '.join(invalid)}"}, status_code=400
        )

    updated = await agents.update(agent_id, {"tools": tools})
    if updated is None:
        return JSONResponse({"error": "Agent not found"}, status_code=404)

    return JSONResponse({"ok": True, "agent": {"id": updated.id, "tools": updated.tools}})


# ---------------------------------------------------------------------------
# telemetry.ts — GET/PUT /api/settings/telemetry
# ---------------------------------------------------------------------------


@router.get("/telemetry")
async def get_telemetry(request: Request) -> Any:
    team_id = request.query_params.get("teamId")
    if not team_id:
        return JSONResponse({"error": "teamId required"}, status_code=400)

    try:
        team = await teams.byId(team_id)
    except Exception as err:
        return JSONResponse({"error": str(err) or "Unknown error"}, status_code=500)

    if team is None:
        return JSONResponse({"error": "Team not found"}, status_code=404)

    return JSONResponse({"teamId": team.id, "telemetryEnabled": team.telemetryEnabled})


@router.put("/telemetry")
async def put_telemetry(request: Request) -> Any:
    body = await _read_json_or_none(request)
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("teamId"), str)
        or not isinstance(body.get("enabled"), bool)
    ):
        return JSONResponse(
            {"error": "Body must include teamId (string) and enabled (boolean)"},
            status_code=400,
        )

    team_id = body["teamId"]
    enabled = body["enabled"]
    try:
        updated = await teams.update(team_id, {"telemetryEnabled": enabled})
    except Exception as err:
        return JSONResponse({"error": str(err) or "Unknown error"}, status_code=500)

    if updated is None:
        return JSONResponse({"error": "Team not found"}, status_code=404)

    invalidate_telemetry_cache(team_id)
    return JSONResponse({"ok": True, "teamId": team_id, "telemetryEnabled": enabled})


# ---------------------------------------------------------------------------
# test-db.ts — POST /api/settings/test-db (data-dir write probe)
# ---------------------------------------------------------------------------


@router.post("/test-db")
async def test_db() -> Any:
    try:
        directory = dd.ensure_data_dir()
        probe = directory / f".write-test-{uuid.uuid4()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return JSONResponse({"ok": True, "dataDir": str(directory)})
    except Exception as err:
        return JSONResponse(
            {"ok": False, "error": str(err) or "Data directory not writable"}
        )


# ---------------------------------------------------------------------------
# test-llm.ts — POST /api/settings/test-llm (one tiny live call on the primary)
# ---------------------------------------------------------------------------


@router.post("/test-llm")
async def test_llm() -> Any:
    """Exercise the cascade's PRIMARY provider with a one-token round trip.

    OFFLINE in tests: the candidate resolver and the client's
    ``chat.completions.create`` are mocked, so nothing touches the network.
    """
    import os

    from simple_harmonic.config import get_api_key_source
    from simple_harmonic.llm import candidates as cand_mod
    from simple_harmonic.llm.candidates import ResolveOptions

    # The resolver's last-resort candidate is a key-less OpenAI client. The
    # OpenAI SDK raises at *construction* with no key, so — unlike the TS path
    # which fails only on the call — surface the setup hint BEFORE resolving when
    # nothing at all is configured (the only case that yields the openai+no-key
    # primary). Mirrors test-llm.ts's openai/no-key short-circuit.
    no_codex = get_api_key_source() != "codex"
    no_anthropic = not os.environ.get("ANTHROPIC_API_KEY")
    no_openrouter = not os.environ.get("OPENROUTER_API_KEY")
    if (
        no_codex
        and no_anthropic
        and no_openrouter
        and not get_config().openaiApiKey
    ):
        return JSONResponse(
            {
                "ok": False,
                "error": (
                    "No API key configured. Add an OpenAI, Anthropic, or "
                    "OpenRouter key — or sign in with Codex."
                ),
            }
        )

    primary = cand_mod.resolve_llm_candidates(ResolveOptions(timeout_s=10.0))[0]

    if primary.provider == "codex":
        return await _test_codex(primary.model)

    if primary.provider == "openai" and not get_config().openaiApiKey:
        # Belt-and-suspenders: any other route to an openai+no-key primary.
        return JSONResponse(
            {
                "ok": False,
                "error": (
                    "No API key configured. Add an OpenAI, Anthropic, or "
                    "OpenRouter key — or sign in with Codex."
                ),
            }
        )

    return await _test_chat_client(primary)


async def _test_chat_client(candidate: Any) -> Any:
    try:
        res = await candidate.llm.chat.completions.create(
            {
                "model": candidate.model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "Reply with the word OK."}],
            }
        )
        text = ""
        if res.choices and res.choices[0].message.content:
            text = res.choices[0].message.content
        return JSONResponse(
            {
                "ok": True,
                "provider": candidate.provider,
                "model": candidate.model,
                "response": text[:50],
            }
        )
    except Exception as err:
        print(f"[test-llm {candidate.provider}]", err)
        return JSONResponse({"ok": False, "error": _describe_error(err)})


async def _test_codex(model: str) -> Any:
    token = codex_auth.get_codex_access_token()
    if not token:
        return JSONResponse(
            {
                "ok": False,
                "error": "No Codex access token. Sign in (or re-authenticate) above.",
            }
        )

    status = codex_auth.get_codex_auth_status()
    account_id = status.accountId or ""
    if not account_id:
        return JSONResponse(
            {
                "ok": False,
                "error": (
                    "Codex auth file is present but has no account_id. "
                    "Re-authenticate."
                ),
            }
        )

    try:
        raw = await _codex_responses_call(model, token, account_id)
    except Exception as err:
        print("[test-llm codex]", err)
        return JSONResponse({"ok": False, "error": _describe_error(err)})

    if isinstance(raw, dict) and "error" in raw:
        return JSONResponse({"ok": False, "error": raw["error"]})

    output_text = ""
    for line in str(raw).split("\n"):
        if not line.startswith("data: "):
            continue
        try:
            import json

            data = json.loads(line[6:])
        except Exception:
            continue
        if isinstance(data, dict) and data.get("type") == "response.output_text.done":
            output_text = data.get("text") or ""

    import re

    match = re.search(r'"model":"([^"]+)"', str(raw))
    actual_model = match.group(1) if match else model

    return JSONResponse(
        {"ok": True, "model": actual_model, "response": output_text[:50] or "OK"}
    )


# Overridable for tests so the codex test path never touches the network.
async def _codex_responses_call(model: str, token: str, account_id: str) -> Any:
    """POST to the Codex responses endpoint and return the raw SSE text, or a
    ``{"error": ...}`` dict on a non-OK response. Network call — patched in tests.
    """  # pragma: no cover - real network
    import json

    from simple_harmonic.proxy_fetch import proxy_fetch, read_capped

    resp = await proxy_fetch(
        "https://chatgpt.com/backend-api/codex/responses",
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "ChatGPT-Account-ID": account_id,
            "User-Agent": "codex_cli_rs/0.0.0",
            "originator": "codex_cli_rs",
        },
        body=json.dumps(
            {
                "model": model,
                "instructions": "You are a helpful assistant.",
                "input": [{"role": "user", "content": "Reply with the word OK."}],
                "store": False,
                "stream": True,
            }
        ),
    )
    text = await read_capped(resp)
    if resp.status_code >= 400:
        return {"error": f"Codex API {resp.status_code}: {text[:200]}"}
    return text


def _describe_error(err: object) -> str:
    """Flatten an exception (and its __cause__ chain) into a single message,
    mirroring test-llm.ts ``describeError`` so undici-style nested causes
    surface as ``code=ECONNREFUSED`` instead of a bare "fetch failed"."""
    if not isinstance(err, BaseException):
        return "Unknown error"
    parts: list[str] = [str(err) or err.__class__.__name__]
    cause = err.__cause__
    depth = 0
    while cause is not None and depth < 4:
        if isinstance(cause, BaseException):
            parts.append(str(cause) or cause.__class__.__name__)
            cause = cause.__cause__
        else:
            break
        depth += 1
    out: list[str] = []
    for p in parts:
        if not out or out[-1] != p:
            out.append(p)
    return " · ".join(out)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


async def _read_json(request: Request) -> dict[str, Any]:
    """Parse the JSON body, returning {} on any error (TS ``req.json()`` with a
    catch-to-{} on the handlers that use it)."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


async def _read_json_or_none(request: Request) -> dict[str, Any] | None:
    """Parse the JSON body, returning None on any error (TS
    ``req.json().catch(() => null)`` — the platform-status/telemetry PUTs)."""
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


class _suppress:
    """Tiny contextlib.suppress(Exception) without the import churn at call site."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> bool:
        return True
