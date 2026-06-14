# Migration plan — TypeScript backend → Python (FastAPI)

Dependency-ordered, independently-verifiable slices. Each slice is shippable on
its own and verified before the next. The on-disk JSON store format is shared
with the TS runtime, so both can run against the same data dir during cutover.

Source of truth for behavior to preserve: the fidelity risk register in
[ARCHITECTURE.md](ARCHITECTURE.md#fidelity-risk-register-load-bearing-behaviors-discovered-during-mapping).

## Status

| # | Slice | Scope | Depends on | Verify by | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **Foundation** | project (uv), `settings`, `app` factory, a2ax core *types*, store skeleton, `/health` + `/api/settings/platform-status` + `/api/teams` + `/api/tick` | — | offline pytest smoke (ASGI), live uvicorn curl | ✅ **done** |
| 2 | **Store layer** | all 8 repos (teams, agents, approvals, actionLog, appEvents, platformStatus, spend, traceEvents) with byte-compatible rows; recursive team-tree; lazy location index + invalidation; selective date revival; atomic write/rename; JSONL append; **`asyncio.Lock` on every read-modify-write** | 1 | port TS store tests; round-trip vs real `.simple-harmonic/data/` | ✅ **done** (38 tests; lock proven by a peak-concurrency==1 test that fails without it) |
| 3 | **a2ax protocol** | `A2AX` facade (all **22** transport methods), `MemoryTransport` + `JsonFileTransport`, channel-id derivation, task state machine, per-recipient read tracking, `getAgentContext` 4-query assembler, token auth | 1 | port a2ax tests | ✅ **done** (72 tests) |
| 4 | **Config / auth / host x-cutting** | `AppConfig`, operator gate (sha256 cookie wire-compat, constant-time, cron rules) as allowlist middleware; Apollo vault (GCM `[iv][tag][ct]` byte layout, `cryptography` lib); app-events + `scrubPII`; trace sink drain loop; validation | 1 | cookie round-trip + Apollo Node-interop golden vector | ✅ **done** (261 tests; Node v26 interop proven; vault uses `cryptography`) |
| 5 | **LLM cascade + spend + codex-auth** | `LLMClient` Protocol; `resolve_llm_candidates`; AsyncOpenAI/AsyncAnthropic adapters; sequential cascade (abort short-circuit, model attribution); spend ledger (fail-open); `makeCountingLLM`; codex token refresh | 4 | cascade fallback + spend-cap + fail-open tests (fake clients, offline) | ✅ **done** (315 tests; factory hooks documented for slice 7) |
| 6 | **Tools + sandbox + egress** | `ToolRegistry`; tool impls (filesystem w/ path jail, shell-free `run_command`, SSRF-guarded `http_fetch`/`github_api`, `coding_task` CLI driver, management); **url-guard + proxy-fetch (IPv4 pin)**; **connectors + custom HTTP skill tools**; sandbox (path jail realpath, env scrub allowlist, SSRF egress ranges); kill-switch | 4, 5 | port tools-security tests (IP ranges, shell-injection inertness, env scrub, symlink jail) | ✅ **done** (576 tests; verifier caught + fixed real SNI-pin & streaming-cap bugs in proxy_fetch; `team_tree.py` started early for slice 8) |
| 7 | **Meta-agent orchestration** | `meta_agent/` package: planner (`plannerStream`), runner (`runAgent` multi-round loop), **round-atomic suspend/resume** state machine, approval gate, contract validation, codex/anthropic adapters; discriminated-union Pydantic models | 5, 6 | port meta-agent tests; suspend/resume scenarios | ✅ **done** (703 tests; verifier strengthened round-atomic ordering test; `tryResumeAgent` HOLD guard correctly belongs to slice 8/tick.ts) |
| 8 | **Tick loop + remaining endpoints** | cron tick orchestrator (sequential per-team, claim/incrementTickCount, withTimeout, `tryResumeAgent` HOLD/resume/deny guard); self-scheduling asyncio loop; **all 43 method+path combos** — `chat` (SSE), `spawn`, `seed`, `login` (cookie issuance), `infra-report`, `agent` PATCH, full `settings/*`, full `team/{id}/*` incl. `narration`/`trace` SSE. Retired slice-1 `json_store.py`/`domain.py` stubs → `RepoStore` over the slice-2 repos (fixes the trailing-`Z` seam). | 2,3,4,5,6,7 | parity tests vs TS contract; SSE streaming; live boot | ✅ **done** (834 tests; integration verifier confirmed full parity — 0 missing/0 extra — & fixed `null`-vs-omitted masking bugs) |
| 9 | **Cutover** | env-gated Next.js `rewrites()` (`PY_BACKEND_URL` → forwards `/api/*` to the Python host via `beforeFiles`); default behavior unchanged | 8 | live uvicorn boot across full surface | ✅ **done** ([next.config.ts](../next.config.ts)) |

## Status: complete

All 9 slices done. **834 tests pass, ruff clean, ~30.6K LOC of Python.** The
backend boots under uvicorn and serves all 43 endpoints (live-verified: gate
401/200, `/api/login` issues the exact `sh_operator` cookie, repo-backed JSON
with trailing-`Z` datetimes). The TypeScript backend is untouched.

### Deferred / known divergences (honest)

All are intentional and non-correctness; tracked for follow-up:

- **Codex app-server harness *resume* path** is not ported — a parked
  `codex-thread` tick resumes through the legacy runner via `AgentSuspension`.
  The legacy-runner resume (the load-bearing HOLD/resume/deny trichotomy) IS
  fully ported and tested. `use_codex_harness` is computed/stored for parity but
  unread in the resume path.
- **Per-team agents run sequentially** (await per agent) vs the TS
  `Promise.allSettled` per pass. Correctness preserved (claim is the double-run
  guard; each run is independently time-bounded; the store lock already
  serializes read-modify-writes). A latency, not a behavior, gap.
- **LLM resolution is lazy** (built on first agent run) vs eager-at-top-of-POST,
  because the Python OpenAI SDK raises at client *construction* with no key.
  Observable behavior is identical once an agent actually runs.
- **SSE cleanup** uses Python async-generator teardown (`GeneratorExit`) rather
  than the TS `ReadableStream.cancel()` callback. In prod the stream runs until
  client disconnect; tests drive a finite source.

## Slice 1 — what's in it (done & verified)

- `pyproject.toml` (uv), ruff + pytest config, `.python-version` (3.14).
- `settings.py` — pydantic-settings reading the repo's exact env vars
  (`OPENAI_*`, `ANTHROPIC_*`, `OPENROUTER_*`, `SH_DATA_DIR`, `OPERATOR_PASSWORD`,
  `CRON_SECRET`, `SH_DAILY_SPEND_CAP_CENTS`, `SH_ENABLE_TOOLS`, `SH_TOOLS_CWD`),
  defaults lifted from `config.ts`.
- a2ax **core types** as Pydantic v2 (camelCase preserved): Message/Part/Artifact,
  Channel/ChannelMember + channel-id helpers, Task + `TASK_TRANSITIONS` +
  `is_valid_transition`, AgentToken + `DEFAULT_SCOPES` + `has_scope`, AgentCard +
  `create_agent_card`.
- `store/` skeleton: `data_dir` (path helpers + `set_data_dir` test override),
  `fs` (atomic write/rename, JSONL), `base.Store` Protocol, `json_store` (recursive
  team-tree walk mirroring `index-cache.ts`, blocking IO via `anyio.to_thread`),
  `types` (Team/Agent/PendingApproval/AppEvent/PlatformStatus).
- routes: `/health`, `/api/settings/platform-status`, `/api/teams`, `GET|POST /api/tick`.
- `tests/`: conftest isolates the store under `tmp_path`; smoke test drives the
  app via httpx `ASGITransport` through the lifespan (fully offline) and asserts
  boot, the contract shapes, exact key sets, and a2ax model round-trips.

**Verified:** `uv sync` ✓ · `uv run pytest` → 9 passed ✓ · `uv run ruff check` →
clean ✓ · live uvicorn returns contract-shaped JSON on all four endpoints ✓.

## Run it

```bash
cd backend-py
uv sync
uv run pytest                                   # 834 tests, fully offline
uv run ruff check
uv run uvicorn simple_harmonic.app:app --port 3001
```

**Point the frontend at the Python backend** — the cutover is wired in
[next.config.ts](../next.config.ts) behind an env var (default = unchanged, Next
routes serve):

```bash
# terminal 1 — Python backend
cd backend-py && uv run uvicorn simple_harmonic.app:app --port 3001
# terminal 2 — Next.js, forwarding /api/* to the Python host
PY_BACKEND_URL=http://localhost:3001 npm run dev
```

Both runtimes share the same `.simple-harmonic/data/` store, so you can run them
side by side and flip `PY_BACKEND_URL` on/off to compare.
