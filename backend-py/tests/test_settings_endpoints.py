"""Settings endpoint tests (slice 8).

TS source: packages/backend/src/server/api/settings/*.ts + login.ts

Drives the ASGI app through the operator gate (Bearer OPERATOR_PASSWORD). Every
handler is exercised for its happy path + the contract-shaping edges (validation
400s, masking, 404s). Fully OFFLINE: no real CLI subprocess, no real LLM call,
no network — the codex-auth reads, the CLI probe, the `codex login` spawn, and
the test-llm provider call are all patched.

Isolation notes:
  - ``operator_password`` fixture activates the gate; we attach a Bearer header.
  - Config writes (POST /api/settings, setup-db) and the connectors/skills file
    store land under a temp cwd / SH_TOOLS_CWD so the real repo tree is never
    touched.
  - ``codex_auth`` is patched per-test to a known status so the coding/codex
    handlers are deterministic regardless of the host's ~/.codex state.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from httpx import AsyncClient

from simple_harmonic.auth import OPERATOR_COOKIE, sha256_hex
from simple_harmonic.llm import codex_auth
from simple_harmonic.llm.codex_auth import CodexAuthStatus, CodexModel, RefreshResult
from simple_harmonic.routes import settings as settings_route

OPERATOR_PASSWORD = "test-operator-pw"


def _auth() -> dict[str, str]:
    return {"authorization": f"Bearer {OPERATOR_PASSWORD}"}


def _no_codex() -> CodexAuthStatus:
    return CodexAuthStatus(
        found=False,
        authMode=None,
        email=None,
        plan=None,
        accountId=None,
        lastRefresh=None,
        tokenExpiry=None,
        hasAccessToken=False,
    )


@pytest.fixture
def isolated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    """Run a test in a clean temp cwd (config file) + SH_TOOLS_CWD (connectors /
    skills file store), with the env keys the handlers read cleared and the
    Codex auth reads stubbed to "no codex". Per-test overrides re-stub as needed.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SH_TOOLS_CWD", str(tmp_path))
    for key in (
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "GITHUB_TOKEN",
        "SH_ENABLE_TOOLS",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(codex_auth, "get_codex_auth_status", _no_codex)
    monkeypatch.setattr(codex_auth, "get_codex_models", lambda: [])
    monkeypatch.setattr(codex_auth, "get_codex_access_token", lambda: None)
    # No real CLI version probes.
    monkeypatch.setattr(
        settings_route,
        "_check_cli",
        lambda name: {"installed": False, "version": None},
    )
    yield tmp_path


# ---------------------------------------------------------------------------
# index.ts — GET/POST /api/settings
# ---------------------------------------------------------------------------


async def test_get_settings_masks_api_key(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    (isolated / "simple-harmonic.config.json").write_text(
        json.dumps({"openaiApiKey": "sk-1234567890abcdef"}), encoding="utf-8"
    )
    resp = await client.get("/api/settings", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    # Secret is masked, never returned raw.
    assert body["openaiApiKey"] == "sk-1••••cdef"
    assert "sk-1234567890abcdef" not in json.dumps(body)
    assert body["hasOpenaiKey"] is True
    assert body["apiKeySource"] == "config"
    assert body["codingBackend"] == "codex"
    assert set(body["codingConfig"].keys()) == {"codex", "claude-code", "opencode"}


async def test_post_settings_updates_config(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post(
        "/api/settings",
        headers=_auth(),
        json={"model": "gpt-5.5-new", "openaiApiKey": "sk-abcdefghijklmnop"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Response is the masked safe config.
    assert body["model"] == "gpt-5.5-new"
    assert body["openaiApiKey"] == "sk-a••••mnop"
    written = json.loads((isolated / "simple-harmonic.config.json").read_text())
    assert written["model"] == "gpt-5.5-new"
    assert written["openaiApiKey"] == "sk-abcdefghijklmnop"


async def test_post_settings_merges_coding_config(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post(
        "/api/settings",
        headers=_auth(),
        json={"codingConfig": {"codex": {"model": "gpt-5.5", "timeout": 60}}},
    )
    assert resp.status_code == 200
    written = json.loads((isolated / "simple-harmonic.config.json").read_text())
    assert written["codingConfig"]["codex"]["model"] == "gpt-5.5"
    assert written["codingConfig"]["codex"]["timeout"] == 60


async def test_post_settings_no_valid_fields_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post(
        "/api/settings", headers=_auth(), json={"bogus": "x", "model": ""}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "no valid fields"}


# ---------------------------------------------------------------------------
# coding.ts — GET /api/settings/coding
# ---------------------------------------------------------------------------


async def test_get_coding_shape_and_masking(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-1234567890")
    resp = await client.get("/api/settings/coding", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["current"] == "codex"
    assert set(body["backends"].keys()) == {"codex", "claude-code", "opencode"}
    cc = body["backends"]["claude-code"]
    assert cc["installed"] is False
    assert cc["authenticated"] is True
    # Masked, never raw.
    assert cc["connectors"][0]["value"] == "sk-a••••7890"
    assert "sk-ant-1234567890" not in json.dumps(body)
    # No codex auth in this test.
    assert body["backends"]["codex"]["authenticated"] is False
    # An unconfigured coding connector OMITS `value` (TS `value: ... || undefined`),
    # it does NOT emit `"value": null`. opencode's OpenAI connector has no key here.
    openai_conn = next(
        c for c in body["backends"]["opencode"]["connectors"]
        if c["envVar"] == "OPENAI_API_KEY"
    )
    assert openai_conn["configured"] is False
    assert "value" not in openai_conn
    # The codex OAuth connector also omits value when not signed in.
    codex_conn = body["backends"]["codex"]["connectors"][0]
    assert "value" not in codex_conn


# ---------------------------------------------------------------------------
# codex.ts — GET/POST /api/settings/codex
# ---------------------------------------------------------------------------


async def test_get_codex_status_and_models(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        codex_auth,
        "get_codex_auth_status",
        lambda: CodexAuthStatus(
            found=True,
            authMode="chatgpt",
            email="dev@example.com",
            plan="pro",
            accountId="acct_1",
            lastRefresh="2026-06-14T00:00:00.000Z",
            tokenExpiry="2026-06-15T00:00:00.000Z",
            hasAccessToken=True,
        ),
    )
    monkeypatch.setattr(
        codex_auth,
        "get_codex_models",
        lambda: [
            CodexModel(
                slug="gpt-5.5",
                displayName="GPT-5.5",
                description="flagship",
                priority=1,
                supportedInApi=True,
            )
        ],
    )
    resp = await client.get("/api/settings/codex", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["found"] is True
    assert body["email"] == "dev@example.com"
    assert body["hasAccessToken"] is True
    assert body["models"][0]["slug"] == "gpt-5.5"
    assert body["models"][0]["displayName"] == "GPT-5.5"


async def test_post_codex_refresh(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        codex_auth, "refresh_codex_token", lambda: RefreshResult(ok=True, accessToken="new-tok")
    )
    resp = await client.post("/api/settings/codex", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["accessToken"] == "new-tok"


async def test_post_codex_refresh_failure(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        codex_auth,
        "refresh_codex_token",
        lambda: RefreshResult(ok=False, error="No Codex refresh token found"),
    )
    resp = await client.post("/api/settings/codex", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["error"] == "No Codex refresh token found"


# ---------------------------------------------------------------------------
# codex-login.ts — GET/POST /api/settings/codex-login
# ---------------------------------------------------------------------------


async def test_get_codex_login_status(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.get("/api/settings/codex-login", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["authenticated"] is False
    assert body["loginRunning"] is False


async def test_post_codex_login_already_authenticated(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        codex_auth,
        "get_codex_auth_status",
        lambda: CodexAuthStatus(
            found=True,
            authMode="chatgpt",
            email="dev@example.com",
            plan="pro",
            accountId="acct_1",
            lastRefresh=None,
            tokenExpiry=None,
            hasAccessToken=True,
        ),
    )
    resp = await client.post("/api/settings/codex-login", headers=_auth())
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "status": "already_authenticated"}


async def test_post_codex_login_started(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spawned: list[bool] = []

    class _FakeProc:
        def poll(self) -> None:
            return None  # still running

        def kill(self) -> None:  # pragma: no cover - not reached here
            pass

    def _fake_spawn() -> _FakeProc:
        spawned.append(True)
        return _FakeProc()

    # Reset module state so a prior test's process doesn't leak in.
    monkeypatch.setattr(settings_route, "_login_process", None)
    monkeypatch.setattr(settings_route, "_spawn_codex_login", _fake_spawn)
    resp = await client.post("/api/settings/codex-login", headers=_auth())
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "status": "started"}
    assert spawned == [True]
    # Clean up the module-global so other tests see no running login.
    settings_route._login_process = None


# ---------------------------------------------------------------------------
# connectors.ts — GET/POST/DELETE /api/settings/connectors
# ---------------------------------------------------------------------------


async def test_get_connectors_builtins_masked(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_1234567890abcd")
    resp = await client.get("/api/settings/connectors", headers=_auth())
    assert resp.status_code == 200
    connectors = resp.json()["connectors"]
    ids = {c["id"] for c in connectors}
    assert {
        "builtin-tools-enabled",
        "builtin-tools-cwd",
        "builtin-anthropic",
        "builtin-openrouter",
        "builtin-github",
    } <= ids
    github = next(c for c in connectors if c["id"] == "builtin-github")
    assert github["configured"] is True
    assert github["maskedValue"] == "ghp_****abcd"  # asterisk mask, never raw
    assert "ghp_1234567890abcd" not in json.dumps(resp.json())
    # Unconfigured builtins OMIT maskedValue (TS `: undefined` -> JSON drops the
    # key), they do NOT emit `"maskedValue": null`.
    anthropic = next(c for c in connectors if c["id"] == "builtin-anthropic")
    assert anthropic["configured"] is False
    assert "maskedValue" not in anthropic


async def test_post_then_get_then_delete_connector(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    # Save a file connector with a secret value.
    resp = await client.post(
        "/api/settings/connectors",
        headers=_auth(),
        json={"name": "Slack", "key": "SLACK_TOKEN", "value": "xoxb-secret-12345"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "key": "SLACK_TOKEN"}

    # It surfaces in GET as a file connector, masked.
    resp = await client.get("/api/settings/connectors", headers=_auth())
    slack = next(
        c for c in resp.json()["connectors"] if c["envVar"] == "SLACK_TOKEN"
    )
    assert slack["source"] == "file"
    assert slack["configured"] is True
    assert slack["maskedValue"] == "xoxb****2345"
    assert "xoxb-secret-12345" not in json.dumps(resp.json())

    # Delete it.
    resp = await client.delete(
        "/api/settings/connectors", headers=_auth(), params={"key": "SLACK_TOKEN"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


async def test_post_connector_validation(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    # Missing name/key.
    resp = await client.post(
        "/api/settings/connectors", headers=_auth(), json={"key": "X_KEY"}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "name and key are required"}

    # Bad key format.
    resp = await client.post(
        "/api/settings/connectors",
        headers=_auth(),
        json={"name": "Bad", "key": "lower-case"},
    )
    assert resp.status_code == 400
    assert "uppercase" in resp.json()["error"]


async def test_delete_connector_not_found_404(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.delete(
        "/api/settings/connectors", headers=_auth(), params={"key": "NOPE_TOKEN"}
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "Connector not found"}


async def test_delete_connector_missing_key_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.delete("/api/settings/connectors", headers=_auth())
    assert resp.status_code == 400
    assert resp.json() == {"error": "key is required"}


# ---------------------------------------------------------------------------
# credentials.ts — POST /api/settings/credentials
# ---------------------------------------------------------------------------


async def test_post_credentials_writes_vault(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from simple_harmonic import apollo

    apollo.init(isolated)
    monkeypatch.setenv("APOLLO_MASTER_KEY", "test-master-key")
    resp = await client.post(
        "/api/settings/credentials",
        headers=_auth(),
        json={"key": "GITHUB_TOKEN", "value": "ghp_real_secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "key": "GITHUB_TOKEN"}
    # Vault file exists and the plaintext secret is NOT readable in it.
    vault = isolated / ".apollo" / "vault.enc"
    assert vault.exists()
    assert b"ghp_real_secret" not in vault.read_bytes()


async def test_post_credentials_validation(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post(
        "/api/settings/credentials",
        headers=_auth(),
        json={"key": "lower", "value": "v"},
    )
    assert resp.status_code == 400
    assert "uppercase" in resp.json()["error"]

    resp = await client.post(
        "/api/settings/credentials",
        headers=_auth(),
        json={"key": "GITHUB_TOKEN", "value": ""},
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "value is required"}


# ---------------------------------------------------------------------------
# platform-status.ts — PUT /api/settings/platform-status
# ---------------------------------------------------------------------------


async def test_put_platform_status(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.put(
        "/api/settings/platform-status",
        headers=_auth(),
        json={"status": "degraded", "message": "scheduled maintenance"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True,
        "status": "degraded",
        "message": "scheduled maintenance",
    }
    # It persists: the GET now returns the set status.
    resp = await client.get("/api/settings/platform-status", headers=_auth())
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["message"] == "scheduled maintenance"


async def test_put_platform_status_invalid_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.put(
        "/api/settings/platform-status", headers=_auth(), json={"status": "exploded"}
    )
    assert resp.status_code == 400
    assert "status must be one of" in resp.json()["error"]


# ---------------------------------------------------------------------------
# setup-db.ts — POST /api/settings/setup-db
# ---------------------------------------------------------------------------


async def test_setup_db_idempotent(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post("/api/settings/setup-db", headers=_auth(), json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert any("Data directory ready" in s for s in body["steps"])

    # Idempotent: a second call also succeeds.
    resp = await client.post("/api/settings/setup-db", headers=_auth(), json={})
    assert resp.json()["ok"] is True


# ---------------------------------------------------------------------------
# skills.ts — GET/PATCH /api/settings/skills
# ---------------------------------------------------------------------------


async def test_get_skills_lists_tool_defs(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.get("/api/settings/skills", headers=_auth())
    assert resp.status_code == 200
    skills = resp.json()["skills"]
    assert len(skills) > 0
    names = {s["name"] for s in skills}
    assert "read_file" in names
    one = next(s for s in skills if s["name"] == "read_file")
    assert set(one.keys()) == {
        "name",
        "description",
        "category",
        "risk",
        "agentCount",
        "agents",
    }
    # No agents created -> zero usage.
    assert one["agentCount"] == 0
    assert one["agents"] == []


async def test_patch_skills_updates_agent_tools(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    from simple_harmonic.store.repos import NewAgent, NewTeam, agents, teams

    team = await teams.create(NewTeam(name="eng"))
    agent = await agents.create(
        team.id,
        NewAgent(
            name="Scout",
            role="researcher",
            archetype="default",
            tools=["read_file"],
            scheduleSeconds=60,
            initialPrompt="go",
        ),
    )
    resp = await client.patch(
        "/api/settings/skills",
        headers=_auth(),
        json={"agentId": agent.id, "tools": ["read_file", "write_file"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["agent"]["id"] == agent.id
    assert set(body["agent"]["tools"]) == {"read_file", "write_file"}


async def test_patch_skills_unknown_tool_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.patch(
        "/api/settings/skills",
        headers=_auth(),
        json={"agentId": "a1", "tools": ["read_file", "not_a_real_tool"]},
    )
    assert resp.status_code == 400
    assert "Unknown tools: not_a_real_tool" in resp.json()["error"]


async def test_patch_skills_missing_args_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.patch(
        "/api/settings/skills", headers=_auth(), json={"agentId": "a1"}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "agentId and tools[] required"}


async def test_patch_skills_agent_not_found_404(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    resp = await client.patch(
        "/api/settings/skills",
        headers=_auth(),
        json={"agentId": "missing-agent", "tools": ["read_file"]},
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "Agent not found"}


# ---------------------------------------------------------------------------
# telemetry.ts — GET/PUT /api/settings/telemetry
# ---------------------------------------------------------------------------


async def test_get_telemetry(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    from simple_harmonic.store.repos import NewTeam, teams

    team = await teams.create(NewTeam(name="eng"))
    resp = await client.get(
        "/api/settings/telemetry", headers=_auth(), params={"teamId": team.id}
    )
    assert resp.status_code == 200
    assert resp.json() == {"teamId": team.id, "telemetryEnabled": True}


async def test_get_telemetry_missing_teamid_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.get("/api/settings/telemetry", headers=_auth())
    assert resp.status_code == 400
    assert resp.json() == {"error": "teamId required"}


async def test_get_telemetry_not_found_404(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    resp = await client.get(
        "/api/settings/telemetry", headers=_auth(), params={"teamId": "nope"}
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "Team not found"}


async def test_put_telemetry_toggles(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    from simple_harmonic.store.repos import NewTeam, teams

    team = await teams.create(NewTeam(name="eng"))
    resp = await client.put(
        "/api/settings/telemetry",
        headers=_auth(),
        json={"teamId": team.id, "enabled": False},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True,
        "teamId": team.id,
        "telemetryEnabled": False,
    }
    # It persists.
    refreshed = await teams.byId(team.id)
    assert refreshed is not None
    assert refreshed.telemetryEnabled is False


async def test_put_telemetry_validation_400(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.put(
        "/api/settings/telemetry",
        headers=_auth(),
        json={"teamId": "t1", "enabled": "yes"},
    )
    assert resp.status_code == 400
    assert "teamId (string) and enabled (boolean)" in resp.json()["error"]


async def test_put_telemetry_not_found_404(
    client: AsyncClient, operator_password: str, isolated: Path, data_dir: Path
) -> None:
    resp = await client.put(
        "/api/settings/telemetry",
        headers=_auth(),
        json={"teamId": "missing", "enabled": True},
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "Team not found"}


# ---------------------------------------------------------------------------
# test-db.ts — POST /api/settings/test-db
# ---------------------------------------------------------------------------


async def test_test_db_writable(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    resp = await client.post("/api/settings/test-db", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert isinstance(body["dataDir"], str)
    # The write-probe temp file is cleaned up (only the skeleton remains).
    assert not any(p.name.startswith(".write-test-") for p in Path(body["dataDir"]).iterdir())


# ---------------------------------------------------------------------------
# test-llm.ts — POST /api/settings/test-llm  (LLM call mocked: OFFLINE)
# ---------------------------------------------------------------------------


async def test_test_llm_no_api_key(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    # No keys configured -> primary is a key-less OpenAI candidate -> setup hint.
    resp = await client.post("/api/settings/test-llm", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "No API key configured" in body["error"]


async def test_test_llm_success_mocked(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from simple_harmonic.llm import candidates as cand_mod
    from simple_harmonic.llm.cascade import LLMCandidate
    from simple_harmonic.llm.client import (
        Choice,
        ChoiceMessage,
        LLMResponse,
        make_client,
    )

    async def _fake_create(params, options=None):
        return LLMResponse(
            choices=[Choice(message=ChoiceMessage(content="OK from mock"))],
            model="anthropic/claude-sonnet-4",
        )

    fake = make_client(_fake_create)

    def _fake_resolve(opts=None):
        return [
            LLMCandidate(
                provider="anthropic", model="claude-sonnet-4", llm=fake
            )
        ]

    # A configured provider (anthropic) keeps the handler past the no-key guard.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(cand_mod, "resolve_llm_candidates", _fake_resolve)
    resp = await client.post("/api/settings/test-llm", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["provider"] == "anthropic"
    assert body["response"] == "OK from mock"


async def test_test_llm_provider_error_mocked(
    client: AsyncClient,
    operator_password: str,
    isolated: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from simple_harmonic.llm import candidates as cand_mod
    from simple_harmonic.llm.cascade import LLMCandidate
    from simple_harmonic.llm.client import make_client

    async def _boom(params, options=None):
        raise RuntimeError("ECONNREFUSED")

    fake = make_client(_boom)

    def _fake_resolve(opts=None):
        return [LLMCandidate(provider="anthropic", model="claude-sonnet-4", llm=fake)]

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(cand_mod, "resolve_llm_candidates", _fake_resolve)
    resp = await client.post("/api/settings/test-llm", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "ECONNREFUSED" in body["error"]


# ---------------------------------------------------------------------------
# login.ts — POST /api/login (PUBLIC, issues the sh_operator cookie)
# ---------------------------------------------------------------------------


async def test_login_issues_cookie(
    client: AsyncClient, operator_password: str
) -> None:
    # /api/login is PUBLIC (no Bearer needed) and sets the operator cookie.
    resp = await client.post("/api/login", json={"password": OPERATOR_PASSWORD})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    set_cookie = resp.headers.get("set-cookie")
    assert set_cookie is not None
    expected = sha256_hex(OPERATOR_PASSWORD)
    assert f"{OPERATOR_COOKIE}={expected}" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Lax" in set_cookie
    # The issued cookie then authenticates a gated route.
    cookie = f"{OPERATOR_COOKIE}={expected}"
    gated = await client.get(
        "/api/settings/platform-status", headers={"cookie": cookie}
    )
    assert gated.status_code == 200


async def test_login_wrong_password_401(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/login", json={"password": "nope"})
    assert resp.status_code == 401
    assert resp.json() == {"error": "Invalid password"}
    assert resp.headers.get("set-cookie") is None


async def test_login_not_configured_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.settings import get_settings

    monkeypatch.delenv("OPERATOR_PASSWORD", raising=False)
    get_settings.cache_clear()
    try:
        resp = await client.post("/api/login", json={"password": "anything"})
        assert resp.status_code == 503
        assert resp.json() == {"error": "OPERATOR_PASSWORD not configured"}
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Gate: settings routes reject unauthenticated requests
# ---------------------------------------------------------------------------


async def test_settings_routes_gated(
    client: AsyncClient, operator_password: str, isolated: Path
) -> None:
    # A representative gated route refuses an unauthenticated request.
    for method, path in (
        ("get", "/api/settings"),
        ("get", "/api/settings/coding"),
        ("post", "/api/settings/test-db"),
        ("put", "/api/settings/platform-status"),
    ):
        resp = await getattr(client, method)(path)
        assert resp.status_code == 401, f"{method} {path} should be gated"
        assert resp.json() == {"error": "unauthorized"}
