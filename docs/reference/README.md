# Symbol-Level Reference — Index and Collaboration Map

This directory catalogs **every interface, type, class, function, component, and behavior-driving constant** in the Simple Harmonic codebase — roughly 663 entries. Each entry gives the signature, exact behavior, **Calls** (what it invokes), and **Called by** (grep-verified call sites with `path:line`). The chapter-level narrative lives one directory up in [docs/](../README.md); this directory answers "what does this symbol do and who uses it."

> **Tree state:** single tree on `main` (PRs #12–#16 merged); PR #16 replaced PostgreSQL + Drizzle with a single-process JSON file store on local disk, so persistence everywhere below is files under the data dir, not SQL. The skills-directory migration is parked in `git stash@{0}` (untracked parts only — see [Parked](#parked-the-skills-directory-migration-stash0)).

| File | Scope | Entries |
|---|---|---|
| [meta-agent.md](meta-agent.md) | `packages/backend/src/lib/meta-agent/` — runner, planner, registry, adapters, LLM cascade, codex app-server client + engine-mode harness, trace contract, approval, contract, identity, eval | ~136 |
| [server.md](server.md) | `packages/backend/src/server/` — config, apollo vault, codex-auth, connectors, custom-tool (skill) loader, LLM provider resolution, trace sink, operator-auth, spend, team-tree, app-events, a2ax wiring, proxy-fetch, validation, the JSON file store (`store/` — fs primitives, data-dir resolution, location index, 8 repos) | ~129 |
| [server-tools.md](server-tools.md) | `packages/backend/src/server/tools/` — the 12 I/O tools, sandbox/jail, SSRF guard, coding engines, declarative API tools | ~68 |
| [a2ax.md](a2ax.md) | `packages/a2ax/` — types, Transport interface, memory + JSON-file transports, the A2AX protocol class | ~105 |
| [http-routes.md](http-routes.md) | the HTTP surface: `packages/backend/src/server/api/**` handlers behind the 30 one-line `src/app/api/` wrappers + the standalone `node:http` host, `src/proxy.ts`, `src/instrumentation.ts`, `scripts/seed-demo.ts` | ~96 |
| [frontend-components.md](frontend-components.md) | `packages/frontend/src/` — chat + team components, trace threads + `TraceView`, useChat/useTeam/useTheme hooks, narration helpers | ~88 |
| [app-pages.md](app-pages.md) | `src/app/` pages and layouts (everything except `api/`) | ~41 |

> **Dual runtime (TS + Python port):** every file above now ends with a **"Python backend (FastAPI port) — symbol reference"** section cataloging the parallel `backend-py/simple_harmonic/` port (idiomatic FastAPI, 834 tests, full 43-endpoint parity, env-gated cutover via `PY_BACKEND_URL` rewrites in `next.config.ts`). The port reimplements the **backend + a2ax** layer only — same HTTP/wire contract, snake_case callables, camelCase model fields preserved for wire parity. The two frontend files ([frontend-components.md](frontend-components.md), [app-pages.md](app-pages.md)) carry only a short note instead, because the React/Next client has no Python counterpart. The TS map and flows below are unchanged; the Python module path is noted inline under each of the four runtime flows it touches.

The rest of this file is the cross-module picture: the architectural boundary rules, the seven flows that connect the symbols at runtime, and a quick-find table for the most load-bearing symbols.

## Boundary rules (how the layers stay apart)

The codebase enforces four dependency rules; every cross-module edge in the catalogs respects them:

1. **`lib/meta-agent/` imports nothing from `server/`.** Everything I/O-shaped reaches the engine by injection through structural types: the runner takes an `LLMClient`, an `A2AXSender` (`{ sendDirect, broadcast }` — satisfied by the real `A2AX` class without importing it), and a `ToolRegistry`; the planner takes `PlannerDeps` (config + tokens + `fetchImpl`), built by `server/planner-deps.ts`. The newer engine modules keep the rule: `cascade.ts` imports only the `LLMClient` type from `./runner` (`packages/backend/src/lib/meta-agent/cascade.ts:10`) and `trace.ts` is pure types; their server-side counterparts are `server/llm.ts` (provider resolution into cascade candidates) and `server/trace.ts` (the persistent `TraceSink`). This is what makes the engine NPM-extractable.
2. **`packages/a2ax` is standalone.** The host touches it in exactly one place — `getA2AX()` in `server/a2ax.ts` constructs the singleton over `new JsonFileTransport(teamsRoot())` (`server/a2ax.ts:15`), persisting each team's messages/channels/tasks/tokens under that team's folder in the data tree (`<dataDir>/teams/<id>/messages/`). The package stays self-contained: `JsonFileTransport` uses the a2ax package's own sync fs helpers (`packages/a2ax/src/storage/file-store.ts`), never the backend store. Both write **and** read paths now go through `A2AX` methods — the UI read handlers (`conversations`, `tasks`, `agent-hub`) call `getA2AX()` then `a2ax.listMessages()`/`a2ax.listTasks()` (`server/api/team/id/conversations.ts:36,52`); the old "duplicate Drizzle schema reading the `a2ax_*` tables directly" bypass is gone with Postgres. Identity sentinels (`COFOUNDER_AGENT_ID`/`USER_AGENT_ID`) translate POV strings before the protocol call.
3. **Route logic lives in `packages/backend/src/server/api/**`; the Next routes are one-line wrappers.** Every route body is a transport-agnostic web-standard handler (`(req: Request, ctx: { params: Promise<…> }) => Response`, no `next` imports — test-enforced). Each `src/app/api/**/route.ts` is exactly one re-export line (e.g. `export { GET, POST } from "@simple-harmonic/backend/server/api/tick"`), and the standalone `node:http` host (`packages/backend/src/server/standalone/server.ts:140`) is a **second consumer of the same 30 handler modules**, kept in lockstep by `standalone-routes.test.ts`. Handlers still do auth, validation, and response shaping, then call `server/` and `lib/` symbols; the one with real orchestration machinery is the tick handler (`runFreshAgent`, `tryResumeAgent`, `claimAgent`, `failAgent`, `handleRunResult`, `withTimeout`… — `packages/backend/src/server/api/tick.ts`). The `conversations`/`agent-hub` read handlers also carry substantial thread-assembly code, but it is pure response shaping.
4. **The frontend package reaches into the backend only for identity.** `COFOUNDER_AGENT_ID`, `USER_AGENT_ID`, `DEFAULT_COFOUNDER_NAME`, `getTeamHumans`, `resolveCofounderName` (value imports) and `SpawnTeamAgent` (type import) — nothing else. All other data arrives over `/api/*` fetch. The trace pipeline adds no new edge: `packages/frontend/src/lib/trace.ts:9` declares its own `TraceEvent` row shape rather than importing the backend's.

## Flow 1 — The scheduler tick (the system's heartbeat)

> **Python port:** `backend-py/simple_harmonic/tick.py` — `run_tick()` (`tick.py:271`) is the per-team pass; the in-process driver is `run_tick_loop()` (`tick.py:905`) gated by `tick_loop_should_start()` (`tick.py:883`), spawned from the app `lifespan` (no self-POST). The private pass helpers are `_run_fresh_agent` (`:442`), `_try_resume_agent` (`:535`), `_handle_run_result` (`:747`), `_fail_agent` (`:814`), with `with_timeout()` (`:144`) racing an `asyncio.Event` token in place of `AbortSignal`. See [server.md](server.md) (tick.py) and [http-routes.md](http-routes.md) (routes).

Trigger: Vercel cron (prod, 1/min), the `setInterval` in `register()` (`src/instrumentation.ts`, dev, 10 s), or the standalone host's in-process loop (`standalone/main.ts:63`, 10 s, calls the imported handler directly — no HTTP hop) → `POST /api/tick`. The handler is `packages/backend/src/server/api/tick.ts`; the Next route is a re-export.

```
POST /api/tick (http-routes.md)
 ├─ isCronAuthorized()                        server/operator-auth
 ├─ agents.resetAllInFlight() · one-time      store/repos/agents  (tick.ts:125)
 ├─ pruneTraceEvents()                        server/trace        (tick.ts:120, hourly-throttled
 │                                                                 trace.jsonl retention)
 ├─ getConfig() → getApiKeySource()           server/config
 │    └─ getCodexAccessToken()                server/codex-auth   (key fallback)
 ├─ resolveLLM({onFallback}) → createCascadeLLM()   server/llm + lib/cascade   (tick.ts:146)
 │    chain: codex > anthropic > openrouter (one step per model) > openai —
 │    any provider error falls through to the next; each fallback → emitAppEvent(warning)
 ├─ useCodexHarness = source==="codex" && SH_CODEX_RUNTIME!=="exec"   (tick.ts:164)
 ├─ checkSpendAllowed()                       server/spend        (daily cap, fails open)
 └─ per active team (hibernation: lastUserActiveAt < 5 min):
     ├─ createAppRegistryWithCustomTools()    server/tools/index
     │    ├─ createAppRegistry() ← createDefaultRegistry()   lib/default-tools
     │    │    └─ 3 internal + 12 app tools = 15 built-ins   lib/registry
     │    │      (pinned by server-tools.test.ts:400)
     │    └─ listCustomToolFiles() → buildApiToolDef()/buildApiToolImpl()
     │       over .simple-harmonic/skills/*.json   server/custom-tools, tools/api-tool-runtime
     ├─ errored agents → running (auto-recovery, before both passes)
     ├─ resume pass: tryResumeAgent() ─┐
     ├─ fresh pass:  approveAgentTick() → runFreshAgent() ─┤
     │                lib/approval                          │
     └──────────────────────────────────────────────────────┘
              both → claimAgent() (guarded compare-and-set on inFlight in agent.json) → createTraceSink() →
              engine mode ? withTimeout(runCodexAgentTick(...))           (tick.ts:411/526)
                          : makeCountingLLM() → withTimeout(runAgent(...))
```

Trace emission: both `runAgent` and `runCodexAgentTick` take `trace: trace.emit` and fire 9 `TraceStep` types (`tick_started`, `llm_request`/`llm_response`, `tool_started`/`tool_finished`, `approval_requested`, `decision_applied`, `tick_finished`; the route itself emits `tick_failed` in `failAgent`, tick.ts:595) into the fire-and-forget `TraceSink`; see Flow 7 for what happens downstream.

Inside `runAgent()` (lib/runner — the engine loop, ≤3 rounds). Codex-source agents take the engine-mode path instead: `runCodexAgentTick()` (codex-harness.ts:134) hands the loop to a persistent `codex app-server` subprocess (JSON-RPC over stdio, `CodexAppServerClient`), registers SH tools as `dynamicTools`, executes safe calls through the same registry, parks destructive ones as a `codex-thread` suspension, and sums **real** token usage from `thread/tokenUsage/updated`.

```
runAgent(config)                                   runner.ts:181
 ├─ trace?.(step)                                  every round: tick_started, llm_request/
 │                                                 llm_response, tool_started/finished…
 ├─ getOpenAIDefs(toolAllowlist(tools))            allowlist + defs computed once (runner.ts:183)
 ├─ llm.chat.completions.create(...)               adapter translates wire format
 │    Anthropic: convertMessages()/convertTools() → messages.create
 │    Codex:     buildCodexPrompt() → runCodexExec("codex exec") → parseCodexOutput()
 │               → extractJsonObject() → parseStructuredResponse()
 │               (exec adapter only under SH_CODEX_RUNTIME=exec or when
 │                resuming a legacy message-based suspension; engine mode otherwise)
 ├─ registry.isDestructive(name, args)?            ── yes → return {actionType:"suspended", suspension}
 │                                                    (whole round parked BEFORE executing anything)
 ├─ tracedToolCall() → runToolCall() → registry.execute() → ToolImpl   Zod-validates, never throws
 │    filesystem → resolveInJailReal()/isSensitivePath()      tools/sandbox, tools/filesystem
 │    shell      → ALLOWED_PROGRAMS/isEscapingArg()/scrubbedEnv()
 │    network    → assertPublicAndResolve() → proxyFetch(pin)  tools/url-guard, server/proxy-fetch
 │    coding     → createCodingBackend() → runSubprocess()     tools/coding/*
 │    management → assertInSubTree() ← getSubTreeIds()         server/team-tree
 │    messaging  → ctx.a2ax.sendDirect()/broadcast()           a2ax protocol (Flow 4)
 └─ summarize(actions) + validateContract(payload)             lib/contract
```

Back in the tick handler, the result lands in `handleRunResult()`:

- **`suspension`** → a sequence of store writes: `agents.update()` sets the agent `awaiting_approval` and parks the suspension JSON (an `AgentSuspension` or, in engine mode, a `CodexThreadSuspension`) into the agent's `conversationState` field in `agent.json` (tick.ts:654), `approvals.insertMany()` writes one approval per `PendingToolCall` into the agent's `approvals.json` (tick.ts:661), `actionLog.insert()` appends an `awaiting_approval` line to `actions.jsonl` (tick.ts:673); `nextRunAt` not advanced. A `traceTickId` key rides along inside the parked state so the resumed run continues the same trace thread (`extractTraceTickId`, tick.ts:571). → Flow 3.
- **completion** → `actionLog.insert()` (validation merged), `agents.update()` advances `nextRunAt = now + schedule`.
- **any throw / `AgentTimeoutError`** → `failAgent()`: `trace.emit(tick_failed)`, `emitAppEvent()` (server/app-events), `a2ax.broadcast("[SYSTEM] …")`, agent → `errored` (auto-recovered next tick), schedule advanced; nothing is recorded to the spend ledger.
- On **any non-throw result — suspension included** — the fresh pass calls `markContextRead()` *before* `handleRunResult()` (unread messages are consumed even when the agent parks) and both passes call `recordSpend()` after it; both passes `await trace.flush()` in `finally` (tick.ts:441/565). Usage caveat: engine-mode runs record **real** tokens summed from `thread/tokenUsage/updated`; only the legacy `codex exec` adapter path still reports zero usage against the daily cap. The cascade stamps `response.model` so spend is attributed to the provider/model that actually served.

## Flow 2 — The founder chat (planner → team)

> **Python port:** `backend-py/simple_harmonic/routes/core.py` — `chat()` (`core.py:189`) is the SSE handler; `build_planner_deps()` (`core.py:107`) assembles the deps and `_apply_modify_agent()` (`core.py:149`) handles the inline modify arm. The stream itself is `planner_stream()` in `backend-py/simple_harmonic/meta_agent/planner.py:322` (the three tool defs at `planner.py:62`/`:144`/`:216`). The `/api/spawn` write is `spawn()` (`core.py:331`). See [http-routes.md](http-routes.md) (routes) and [meta-agent.md](meta-agent.md) (planner).

```
/new page → useChat.sendMessage()                     frontend chat/use-chat
 → POST /api/chat
    ├─ buildPlannerDeps()                             server/planner-deps
    │    = getConfig() + getApiKeySource() + getCodexAccessToken() + proxyFetch
    └─ plannerStream(messages, onToken, deps)         lib/planner
         ├─ apiKeySource==="codex" ? codexResponsesStream() : openaiChatStream()
         ├─ tools: spawn_team / modify_agent / request_credential (planner-only defs)
         └─ finalize(text, toolName, args) → PlannerResult union
 SSE events → useChat reducer:
   token   → streaming placeholder
   spawn   → <ApprovalCard/> → POST /api/spawn → teams.insert() + agents.insertMany()
             (+ HARMON_TOOLS/HARMON_PROMPT cofounder agent on root teams) → router.push(/f/{id})
   modify_agent      → applyModifyAgent() server-side in the chat handler
   request_credential → <CredentialRequestCard/> → POST /api/settings/credentials → apollo.set()
```

`apollo.set()` encrypts into `.apollo/vault.enc` and writes `process.env[key]`; at next boot `register()` → `apollo.load()` restores the vault into the environment, where `resolveConnector()` (server/connectors) picks values up for tools — unless a plaintext `secrets.json` entry shadows them.

## Flow 3 — The approval loop (suspend → decide → resume)

> **Python port:** the resume pass is `_try_resume_agent()` in `backend-py/simple_harmonic/tick.py:535`; the per-tick run gate is `approve_agent_tick()` in `backend-py/simple_harmonic/meta_agent/approval.py:76` (the per-action gate `approve_agent_action()` at `approval.py:115`, `ApprovalDecision` a flat dataclass at `approval.py:63`). The operator decision write lands via `routes/team.py` approvals handlers. See [server.md](server.md) (tick.py), [meta-agent.md](meta-agent.md) (approval), and [http-routes.md](http-routes.md) (team routes).

```
runner suspends (Flow 1) ──▶ agent.json conversationState = AgentSuspension | CodexThreadSuspension
                             approvals.json entries (toolCallId, toolName, toolArguments)

<ApprovalQueue/> polls GET /api/team/[id]/approvals every 4 s     frontend team/approval-queue
 founder clicks → POST approvals {approvalId, decision, note}
   → approvals.resolve() (guarded pending→approved|rejected in approvals.json),
     clear agent.inFlight, teams.update bumps team.lastUserActiveAt (so the team
     doesn't hibernate before resuming)

next tick, resume pass:
 tryResumeAgent()                                    tick handler (tick.ts:450)
   ├─ holds while any expected approvals.json entry is still pending (missing decision ≠ rejection)
   ├─ message-based suspension → ToolDecision[] from the entries → runAgent({resume: {suspension, decisions}})
   │    └─ orderedResumeCalls() (runner.ts:471): walk the last assistant turn's tool_calls
   │       in order — approved → executed for real (tracedToolCall, runner.ts:211);
   │       rejected/missing → "Action not approved"; deferredSafe → executed now.
   │       Loop continues; may suspend again.
   ├─ codex-thread suspension → runCodexAgentTick resume instead (tick.ts:526):
   │    thread/resume, approved calls executed by SH itself, then a turn reporting
   │    "[Approval outcomes]" verbatim
   └─ approvals.clearForAgent() drops the consumed entries → handleRunResult() as in Flow 1
```

## Flow 4 — Agent messaging (a2ax)

> **Python port:** `backend-py/simple_harmonic/a2ax/protocol.py` — the `A2AX` facade (`protocol.py:79`) with `send_direct` (`:95`), `broadcast` (`:126`), `create_task` (`:223`), `get_agent_context` (`:323`), and `mark_context_read` (`:361`); the founder-UI read path uses `list_messages` (`:367`)/`list_tasks` (`:370`). The production transport is `JsonFileTransport` (`backend-py/simple_harmonic/a2ax/json_file_transport.py`) over the package's own sync fs helpers; the singleton is wired in `backend-py/simple_harmonic/a2ax_singleton.py`. See [a2ax.md](a2ax.md).

```
write side                                   read side (agents)
──────────                                   ──────────────────
send_message tool (lib/default-tools)        tick route: getAgentContext(teamId, agentId)
 └─ ctx.a2ax.sendDirect()                      └─ queryMessages() ×4 channel types, unreadOnly
broadcast tool → ctx.a2ax.broadcast()              (JsonFileTransport: in-memory filter over
operator: POST /api/team/[id]/messages              the team's hydrated messages)
 └─ sendDirect/broadcast/sendToGroup           formatted block → AgentConfig.a2axContext
failAgent → a2ax.broadcast("[SYSTEM]…")        → buildTickPrompt() injects it
seed route → createTask()/updateTaskState()  after any non-throw run (suspension included):
                                               markContextRead(messageIds)

sendDirect/broadcast → ensureChannel(); createGroup/createTask create their channel up front;
sendToGroup and task-state updates write into it unchecked (deterministic ids:
direct:<a>:<b> sorted, team:<id>, group:<id>, task:<id>)
                 → Transport (JsonFileTransport in prod) → per-team files under
                   <dataDir>/teams/<id>/messages/{log.jsonl, reads.jsonl, channels.json,
                   members.json, tasks.json, cards.json, tokens.json}

read side (founder UI) — now goes THROUGH A2AX:
 conversations/tasks/agent-hub routes call getA2AX() then a2ax.listMessages()/listTasks()
 (server/api/team/id/conversations.ts:36,52); identity sentinels COFOUNDER_AGENT_ID/USER_AGENT_ID
 translate POV strings. (The old duplicate-schema SQL bypass went away with Postgres.)
```

## Flow 5 — The founder watching (UI data loops)

```
/f/[id] team-view → useTeam (frontend team/use-team), four channels:
  1. GET /api/team/[id] once + every 10 s while unpaused
  2. POST /api/team/[id]/heartbeat every 30 s  ──▶ team.lastUserActiveAt (team.json)
     (this is what keeps the team out of tick hibernation — closing the tab stops the company
      5 minutes later)
  3. GET /api/team/[id]/narration — held-open SSE; server polls the agents' actions.jsonl every 3 s
     entries → describeAction()/extractDetail() (frontend lib/narration) → activity feed
  4. POV components: <ApprovalQueue/> 4 s · <AgentPovView/> agent-hub 5 s ·
     <AgentMessagesView/> conversations+tasks 5 s · <TraceView/> trace SSE (Flow 7)
```

## Flow 6 — Startup and configuration

```
next start → register() (src/instrumentation.ts, NEXT_RUNTIME==="nodejs")
 ├─ apollo.load(): decrypt .apollo/vault.enc → process.env (existing vars win)
 └─ !VERCEL: setInterval 10 s → self-POST /api/tick (Bearer CRON_SECRET)

npm run dev:backend → standalone/main.ts (no Next.js at all)
 ├─ apollo.load() → getConfig() boot banner (model, coding backend, data dir)
 ├─ createBackendServer().listen(SH_BACKEND_PORT | PORT | 3001)    standalone/server.ts:140
 │    node:http ⇄ web Request/Response bridge over the same 30 handlers
 │    (routes.ts manifest; bodies/SSE stream through, client abort propagates);
 │    gate() mirrors proxy(): tick + login passthrough, else 503 (no password,
 │    prod) / 401; OPTIONS·HEAD·405 served per RFC 9110; only "/" outside /api/*
 └─ tick loop 10 s: calls the imported tick POST handler in-process (main.ts:69,
    Bearer CRON_SECRET); SH_TICK_LOOP=0 disables it (external cron instead);
    prod without CRON_SECRET → the loop refuses to start (it would 401 itself)
    (sibling CLI: npm run data:init → standalone/setup-db-cli.ts, headless setup-db
     = ensureDataDir())

every request (Next host) → proxy() (src/proxy.ts)
 ├─ /api/tick passthrough (route does its own cron auth)
 ├─ no OPERATOR_PASSWORD: prod → 503, dev → open
 └─ isOperatorAuthorized(): Bearer password | sh_operator cookie == sha256Hex(password)
     fail → 401 JSON (API) | redirect /login (pages)

config reads, everywhere, every time (no cache):
 getConfig() = simple-harmonic.config.json > env > (codex token for the API key) > defaults
 (no config file is on disk right now — it was swept into stash@{0} — so values resolve
  from env + defaults; the committed default model is "o4-mini", config.ts:33. The data dir
  resolves config.dataDir > SH_DATA_DIR env > default join(cwd, ".simple-harmonic", "data").)
 (separate caches elsewhere: the store keeps an in-memory location index of the team tree,
  invalidated on create/delete/move (store/index-cache.ts); app-events caches the per-team
  telemetry flag for 60 s)
```

## Flow 7 — The trace pipeline (play-by-play)

```
runner / codex harness (lib/meta-agent)            trace.ts: TraceStep + TraceSink contract
 └─ trace(step) — 9 event types (trace.ts:15)
     ──▶ createTraceSink()                          server/trace.ts:43
          buffered batch; sanitizeTraceData() PII scrub + truncation
          ──▶ traceEvents.append()                  store/repos/trace-events.ts
               appends to each agent's <agentDir>/trace.jsonl (one line per step;
               tickId groups a logical tick across suspend/resume — the parked
                traceTickId; reads gather across a team's agents and sort by
                (emittedAt, seq) to match the old global order)
 tick route: trace.flush() in finally;
 pruneTraceEvents() (server/trace.ts:163) sweeps rows older than
 SH_TRACE_RETENTION_DAYS (default 14 days) via rewriteJsonl, throttled to hourly (tick.ts:120)

GET /api/team/[id]/trace                            server/api/team/id/trace.ts:20
 └─ SSE: 200-event history, then 2 s polling with id-dedupe; agentId/tickId filters
     ──▶ <TraceView/> (trace-view.tsx:51) streams the route, feeds
         buildTickThreads() (frontend lib/trace.ts:99): flat events → per-tick
         threads, request/response and started/finished paired into single step
         rows (an unpaired "started" renders as a live, pulsing step)
         — shown in the agent-POV "trace" tab and the dashboard play-by-play toggle
```

## Quick-find: the load-bearing symbols

| Symbol | Where | One-liner |
|---|---|---|
| `runAgent(config)` | [meta-agent.md](meta-agent.md), `runner.ts:181` | One agent tick: ≤3 tool rounds, suspension on destructive calls, resume support |
| `AgentSuspension` | [meta-agent.md](meta-agent.md), `runner.ts:56` | The JSON blob that freezes a run mid-round; persisted in the agent's `conversationState` field in `agent.json` |
| `ToolRegistry` | [meta-agent.md](meta-agent.md), `registry.ts:72` | def+impl map; `getOpenAIDefs`/`listForAgent`; `isDestructive`; never-throw `execute` |
| `plannerStream(...)` | [meta-agent.md](meta-agent.md), `planner.ts:240` | Harmon chat: streams tokens, emits one spawn/modify/credential tool call |
| `approveAgentTick(...)` | [meta-agent.md](meta-agent.md), `approval.ts:53` | Pure gate deciding whether an agent runs this tick (7 reason codes) |
| `createAnthropicClient` / `createCodexClient` | [meta-agent.md](meta-agent.md) | `LLMClient` adapters: SDK translation vs `codex exec` prompt-encoded tool calling; cascade candidates via `resolveLLM` |
| `resolveLLM` / `resolveLLMCandidates` | [server.md](server.md), `llm.ts:125`/`:47` | Provider chain codex > anthropic > openrouter (per model) > openai → `{llm, model, chain}`; always ≥1 candidate |
| `createCascadeLLM(candidates)` | [meta-agent.md](meta-agent.md), `cascade.ts:31` | One `LLMClient` over the chain: any provider error falls through, abort rethrows, serving model stamped, `onFallback` observer |
| `runCodexAgentTick(config)` | [meta-agent.md](meta-agent.md), `codex-harness.ts:134` | Engine mode: `codex app-server` owns the loop, SH tools as `dynamicTools`, destructive → `codex-thread` park, real token usage |
| `CodexAppServerClient` | [meta-agent.md](meta-agent.md), `codex-app-server.ts:66` | JSON-RPC 2.0 over `codex app-server` stdio: per-thread routing, fail-closed declines, isolated `CODEX_HOME` |
| `TraceSink` / `TraceStep` | [meta-agent.md](meta-agent.md), `trace.ts:41`/`:35` | The fire-and-forget 9-step trace contract emitted by runner and harness |
| `createTraceSink` / `pruneTraceEvents` | [server.md](server.md), `server/trace.ts:43`/`:163` | PII-scrubbed buffered append into per-agent `trace.jsonl` (via `traceEvents` repo); hourly-throttled 14-day retention sweep using `rewriteJsonl` |
| `createAppRegistryWithCustomTools()` | [server-tools.md](server-tools.md), `tools/index.ts:68` | The 15 built-ins (3 internal + 12 app, pinned by `server-tools.test.ts:400`) + on-disk `*.json` skills, rebuilt per team per tick |
| `listCustomToolFiles()` | [server.md](server.md), `custom-tools.ts:39` | Loads `.simple-harmonic/skills/*.json` into the custom-tool (skill) list |
| `resolveInJailReal(p)` | [server-tools.md](server-tools.md), `sandbox.ts:89` | Symlink-aware filesystem jail containment |
| `assertPublicAndResolve(url)` | [server-tools.md](server-tools.md), `url-guard.ts:67` | SSRF egress policy + DNS pin for every agent-driven outbound request |
| `runSubprocess(opts)` | [server-tools.md](server-tools.md), `coding/run-subprocess.ts:28` | Shared coding-CLI lifecycle: jail cwd, scrubbed env, timeout, JSONL tail |
| `getConfig()` / `getApiKeySource()` | [server.md](server.md), `config.ts` | All config resolution; the `"codex"` source selects the ChatGPT-subscription path; `dataDir` (file-store root) replaces the old `databaseUrl`; default model `o4-mini` (config.ts:33) |
| `apollo.load()` / `apollo.set()` | [server.md](server.md), `apollo.ts` | Encrypted secret vault ↔ `process.env` |
| `resolveConnector(key)` | [server.md](server.md), `connectors.ts:53` | Secret lookup: plaintext `secrets.json` > env (which includes vault values) |
| `emitAppEvent(e)` / `queryAppEvents(q)` | [server.md](server.md), `app-events.ts` | The telemetry loop: scrub → rate-limit → insert; agents read it back in prompts |
| `makeCountingLLM` / `checkSpendAllowed` / `recordSpend` | [server.md](server.md), `spend.ts:128`/`:80`/`:91` | Token counting wrapper + global daily cap + ledger writes |
| `getSubTreeIds(teamId)` | [server.md](server.md), `team-tree.ts:48` | The authorization scope for lead-agent management tools |
| `isOperatorAuthorized` / `isCronAuthorized` | [server.md](server.md), `operator-auth.ts` | The two auth gates (password/cookie; Bearer `CRON_SECRET` — `x-vercel-cron` trusted only when `VERCEL` is set, `operator-auth.ts:83`) |
| `proxyFetch(url, init, pin)` | [server.md](server.md), `proxy-fetch.ts:130` | HTTPS-only fetch: proxy detection, IPv4 pin, anti-rebinding |
| `A2AX` (class) | [a2ax.md](a2ax.md), `core/protocol.ts:49` | The message/task protocol facade over `Transport` |
| `JsonFileTransport` | [a2ax.md](a2ax.md), `adapters/json-file.ts:44` | The production transport: persists each team's messages/channels/tasks/tokens under `<dataDir>/teams/<id>/messages/`, hydrating into memory by walking the team tree (own sync fs helpers, no backend store) |
| `getAgentContext` / `markContextRead` | [a2ax.md](a2ax.md), `protocol.ts:294/349` | What an agent "hears" each tick, and the read receipts after a successful run |
| `POST /api/tick` + helpers | [http-routes.md](http-routes.md), `server/api/tick.ts` | The scheduler: passes, claiming, timeouts, parking, resuming, failing |
| `handleRunResult` / `tryResumeAgent` / `failAgent` | [http-routes.md](http-routes.md), `server/api/tick.ts:631`/`:450`/`:581` | The three outcomes of a run: park, continue, error |
| `GET /api/team/[id]/trace` | [http-routes.md](http-routes.md), `server/api/team/id/trace.ts:20` | Trace SSE: 200-step history then 2 s-poll updates; `agentId`/`tickId` filters |
| `proxy()` | [http-routes.md](http-routes.md), `src/proxy.ts:18` | The Next 16 request gate |
| `register()` | [http-routes.md](http-routes.md), `src/instrumentation.ts:9` | Boot: vault load + dev tick loop |
| `createBackendServer()` | [http-routes.md](http-routes.md), `standalone/server.ts:140` | node:http host serving the same 30 handlers without Next; `gate()` mirrors `proxy()` |
| `routes` / `matchPath` | [http-routes.md](http-routes.md), `standalone/routes.ts:63`/`:97` | The 30-pattern manifest + `:param` matcher, parity-tested against `src/app/api` |
| standalone `main.ts` | [http-routes.md](http-routes.md), `standalone/main.ts` | `npm run dev:backend`: apollo load → server → in-process 10 s tick loop (`SH_TICK_LOOP=0` to disable) |
| store entry point (`teams`, `agents`, `actionLog`, …) | [server.md](server.md), `server/store/index.ts:17` | Public re-export of the 8 repos + `ensureDataDir`/`resetStore`/`clearStore`/`getDataDir`/`setDataDir`; all repo methods async over synchronous fs IO |
| `getDataDir()` / `setDataDir()` | [server.md](server.md), `server/store/data-dir.ts:31`/`:36` | File-store root: test override > `config.dataDir` > `SH_DATA_DIR` env > `join(cwd, ".simple-harmonic", "data")` |
| `traceEvents` repo | [server.md](server.md), `server/store/repos/trace-events.ts:48` | Append-only per-agent `trace.jsonl`; gathers across a team's agents, filters by tick, sorts by `(emittedAt, seq)` |
| `buildTickThreads` / `TraceView` | [frontend-components.md](frontend-components.md), `lib/trace.ts:99` · `trace-view.tsx:51` | Trace events → per-tick threads; live SSE viewer behind the agent "trace" tab and the play-by-play feed |
| `useChat()` | [frontend-components.md](frontend-components.md), `chat/use-chat.ts` | The `/new` chat state machine over the chat SSE protocol |
| `useTeam(teamId)` | [frontend-components.md](frontend-components.md), `team/use-team.ts` | The four-channel team data loop (load, poll, heartbeat, narration SSE) |
| `describeAction(type, payload)` | [frontend-components.md](frontend-components.md), `lib/narration.ts` | `actions.jsonl` entries → human narration lines |
| `COFOUNDER_AGENT_ID` / `USER_AGENT_ID` | [meta-agent.md](meta-agent.md), `identity.ts` | The sentinel UUIDs that let Harmon and the founder use the agent message bus |

## Parked: the skills-directory migration (stash@{0})

An uncommitted migration once replaced the flat `*.json` custom tools with directory skills (`.simple-harmonic/skills/<name>/SKILL.md`), a registry skill tree (`subSkills`, `expandAllowlist`, `visibleTools`), runner-side progressive disclosure (`openSkills`, a `close_skills` built-in, surfaced instructions), and an `agents.open_skills` column. On 2026-06-11 that code was discarded when `main` was updated; **none of it exists anywhere in the repo** — at HEAD the loader is the flat JSON `listCustomToolFiles()` (`packages/backend/src/server/custom-tools.ts:39`), the registry has no skill tree, and the built-in count is 15.

Only the migration's untracked artifacts survive, parked in `git stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees, `packages/backend/tests/unit/skill-tree.test.ts`, and `simple-harmonic.config.json` (swept along, which is why no config file is on disk).

## Reading the entries

- **Signatures** are as written in source (TypeScript), with the defining `path:line`.
- **Called by** is grep-verified against the whole repo at the time of writing; "tests only" and "unused" are explicit verdicts, not omissions. Dead code is labeled (e.g. `MessagesTab` in `agent-pov-view.tsx`, `getChildTeams`/`getRootTeams` in `team-tree.ts`, `extractJsonObject`'s export, the a2ax card/token/group surface).
- Tools are documented as single def+impl entries under their tool name (schema, risk logic, behavior, emitted action type).
- Where the same contract has multiple implementations (the a2ax `Transport`, the three coding engines), the contract is described once and each implementation documents only its differences.
