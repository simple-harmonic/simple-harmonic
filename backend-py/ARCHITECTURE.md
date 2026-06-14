# Python backend — architecture & stack decision

An idiomatic Python re-implementation of the Simple Harmonic backend
(`packages/backend` + `packages/a2ax`), running on FastAPI as a **parallel
service** in `backend-py/`. It speaks the **same HTTP/WS contract** as the
TypeScript runtime, so the existing Next.js frontend can point at either one
unchanged. The TypeScript backend is left intact; this is an experiment and a
slice-by-slice migration, not an in-place edit.

## Stack decision

A judge panel scored three agent-orchestration approaches against *this
specific* design (recursive agent teams, a meta-agent planner, a cron tick
loop, coding tools, the A2A-Extended protocol, a provider cascade):

| Approach | Fit | Why |
| --- | --- | --- |
| **Raw `anthropic` + `openai` SDKs + custom asyncio orchestration** | **9/10** | The existing backend is *already* "raw SDKs + a custom loop behind a duck-typed LLM seam." Every subsystem map independently prescribed exactly this. Adoption cost is effort, not architectural friction. **Chosen.** |
| Pydantic AI | 4/10 | Cannot express the suspend/resume runner, codex harness, or the cascade/spend/approval seams without being fought. At most a narrow fit for the planner's structured output. |
| LangGraph | 3/10 | Only fits the durable pause/resume slice (`interrupt`/checkpointer ≈ `AgentSuspension`) — the *easy* part to hand-roll — and replaces almost none of the hard custom logic (tick scheduling, the file-backed recursive team tree, the cascade). |

**Resulting stack:**

| Concern | Choice |
| --- | --- |
| Language / runtime | Python 3.14, managed by `uv` |
| Web | FastAPI on uvicorn (ASGI) |
| Validation / models | Pydantic v2 (replaces Zod; `model_json_schema()` feeds the LLM tools array) |
| LLM | `anthropic` + `openai` async SDKs behind an `LLMClient` Protocol; a custom sequential cascade |
| Async model | `asyncio` throughout; blocking fs via `anyio.to_thread`; **explicit `asyncio.Lock` around every store read-modify-write** |
| Persistence | The existing `.simple-harmonic/data/` JSON/JSONL tree — **shared on-disk format**, no migration |
| Lint / test | ruff + pytest (+ pytest-asyncio) |

## Layered design

```
simple_harmonic/
  settings.py        # pydantic-settings; reads the repo's .env vars verbatim  (<- config.ts)
  app.py             # create_app() factory + module-level `app` ASGI entry     (<- server.ts/routes.ts)
  dependencies.py    # FastAPI DI (get_store, later: operator gate, llm, registry)
  domain.py          # thin service layer the routes call into
  routes/            # APIRouter per area; paths mirror the TS contract exactly
  a2ax/              # the A2A-Extended protocol library (Pydantic models + facade + transports)
  store/             # JSON file store: fs primitives, data-dir, repos, location index
  llm/      (slice 5) # cascade, adapters, spend ledger, connectors, custom tools
  tools/    (slice 6) # ToolRegistry + tool impls + sandbox (path jail, SSRF, env scrub)
  meta_agent/ (slice 7) # planner, runner, suspend/resume, contract validation
  tick.py   (slice 8) # cron tick orchestrator + self-scheduling loop
```

### TS → Python module map

| TypeScript | Python |
| --- | --- |
| `server/config.ts` | `settings.py` (pydantic-settings) |
| `server/standalone/{server,routes,main}.ts` | `app.py` + `__main__` |
| `server/api/**` | `routes/**` |
| `server/store/**` | `store/**` |
| `server/llm.ts`, `spend.ts`, `connectors.ts`, `custom-tools.ts`, `apollo.ts`, `proxy-fetch.ts`, `codex-auth.ts` | `llm/**` |
| `server/tools/**` | `tools/**` |
| `lib/meta-agent/**` | `meta_agent/**` |
| `server/team-tree.ts`, `tick.ts`, `api/tick.ts` | `tick.py` |
| `server/operator-auth.ts`, `app-events.ts`, `trace.ts`, `validation.ts` | `auth.py`, `events.py`, `trace.py`, `validation.py` |
| `packages/a2ax/src/**` | `a2ax/**` |

## Wire-compatibility rules (non-negotiable for frontend parity)

- **Field names stay camelCase.** Pydantic models keep the TS JSON key names
  (`channelId`, `fromAgentId`, `createdAt`, …) so the frontend is unaffected.
- **Datetimes serialize to ISO-8601 strings** (matching `JSON.stringify(Date)`).
- **No auth on `team/*` and `teams`** (the TS handlers read no session). The
  `settings/*`, `chat`, `spawn`, `seed`, `infra-report`, `agent/{id}` routes sit
  behind the shared `OPERATOR_PASSWORD` gate; `tick` is cron-gated; `login` is
  public. The gate lands as middleware in slice 4.
- **Status codes match** (e.g. `POST team/{id}/messages` → 201; default 200).
- **SSE endpoints** (`chat`, `team/{id}/narration`, `team/{id}/trace`) stream
  `text/event-stream` — ported with FastAPI `StreamingResponse`.

## Fidelity risk register (load-bearing behaviors discovered during mapping)

These are subtle behaviors the port **must** preserve. They are the traps:

1. **`agents.claim()` race-freeness.** Node's single thread makes read-check-write
   atomic for free; asyncio does not split a function without an `await`, but the
   store wraps blocking IO — so every read-modify-write (`claim`, `update`,
   `resolve`, `acknowledge`, `incrementTickCount`, JSONL append) must hold an
   explicit `asyncio.Lock`. Lose this and two ticks double-claim an agent.
2. **Selective date revival.** Only declared top-level `DATE_KEYS` become
   `datetime`; ISO-looking strings inside `payload`/`metadata`/`data`/
   `conversationState`/`outputContract` MUST stay strings.
3. **Mixed-type id field.** `PlatformStatus.id` is the literal integer `1`; every
   other id is a UUID string. Preserve the union.
4. **`PendingApproval.toolArguments` is a JSON string**, not an object — don't auto-parse.
5. **a2ax per-recipient read tracking.** Reads are keyed `{messageId}:{agentId}`
   in a set, not a global status flag — one broadcast row, many readers.
6. **a2ax `completeTask()` does NOT validate the transition** (force-sets
   `completed` from any state), unlike `updateTaskState()`.
7. **`directChannelId` sorts the pair** (`direct:{min}:{max}`); `queryMessages`
   reconstructs the expected id to test relevance, and always excludes the
   sender's own messages.
8. **SSRF ordering.** `assertPublicAndResolve` must run and pass **before** any
   connector bearer token is attached or `proxyFetch` is called.
9. **Private-IP ranges are test-pinned** (0/8, 127/8, 10/8, CGNAT 100.64/10,
   169.254 link-local/metadata, 172.16-31, 192.168, 198.18/15 benchmark,
   multicast/reserved). Replicate exactly.
10. **`run_command` is shell-free.** `;`, `&&`, `|`, `$(...)`, backticks, `>` must
    be inert literal argv tokens — never `shell=True`.
11. **Tool kill-switch.** `write_file`, `run_command`, `coding_task`, and mutating
    `github_api`/`api-tool` calls are blocked unless `SH_ENABLE_TOOLS ∈ {1,true,yes}`.
12. **Env scrubbing is a security guarantee.** Keep only
    PATH/HOME/USER/SHELL/LANG/LC_ALL/TMPDIR/TZ; coding adds only uppercase-validated
    provider keys per backend.
13. **Spend cap fails OPEN.** `checkSpendAllowed` returns `allowed:true` on any
    ledger read error; `recordSpend` swallows write errors.
14. **Cascade abort short-circuit.** Re-throw immediately if the signal is
    aborted; otherwise fall through to the next provider. The cascade is
    sequential (first success wins), not parallel.
15. **Model-id attribution.** The cascade stamps `res.model = candidate.model`
    when absent; spend pricing reads the served model.
16. **Apollo AES-256-GCM byte layout.** Node stores `[iv][tag][ciphertext]` with
    the tag from `getAuthTag()` separately; Python's `AESGCM` appends the tag to
    the ciphertext. The port must re-lay the bytes or decryption breaks. Also,
    `Apollo.load()` must NOT overwrite already-set env vars (operator-wins).
17. **proxy-fetch pins IPv4** to dodge hanging IPv6/Teredo tunnels — preserve.
18. **Suspend/resume is round-atomic.** The runner suspends the entire round on
    the first destructive batch *before executing anything that round*; safe
    calls are deferred. Two suspension shapes share `conversationState`,
    disambiguated only by `kind==='codex-thread'`.
19. **Unknown tool ⇒ destructive (fail-safe).** `registry.isDestructive` returns
    true for unregistered tools; approval defaults to "needs approval."
20. **`FALLBACK_TOOL_NAMES`** (`send_message`, `broadcast`, `report_action`) are
    force-added to every agent's allowlist.
21. **Cookie wire-compat.** Session cookie is literally `sha256(OPERATOR_PASSWORD)`
    under `sh_operator`, HttpOnly, Secure-in-prod, SameSite=Lax, Path=/, Max-Age=30d,
    constant-time compare.
22. **Cron auth.** `x-vercel-cron` trusted only when `VERCEL` is set; dev with no
    `CRON_SECRET` is permissive (the self-POST tick loop relies on this).
23. **`scrubPII` regex order matters** and one pattern uses a lookbehind — replicate
    patterns and order in Python `re`.

See [MIGRATION.md](MIGRATION.md) for the slice-by-slice plan and status.
