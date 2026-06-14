# Reference — HTTP routes, backend handlers, and the standalone host

This file documents every exported HTTP handler, every local helper function, and every module-level constant in the HTTP surface: the **30 transport-agnostic handler modules** under `packages/backend/src/server/api/**`, their 30 thin Next.js wrapper routes under `src/app/api/**`, the standalone `node:http` host under `packages/backend/src/server/standalone/`, the operator gate in `src/proxy.ts`, the startup hook in `src/instrumentation.ts`, and the standalone demo seeder `scripts/seed-demo.ts`. The handlers are deliberately thin adapters: validation, auth, and response shaping live here; all business logic lives elsewhere in `@simple-harmonic/backend` (the JSON file-store repos, the a2ax messaging layer, the meta-agent runner/planner, config, connectors, spend accounting). Persistence runs through `packages/backend/src/server/store/` (PR #16) — typed repos (`teams`, `agents`, `actionLog`, `appEvents`, `approvals`, `platformStatus`, `spend`, `traceEvents`) over JSON/JSONL files under `<dataDir>/teams/<id>/…` and `<dataDir>/system/…`; the old Postgres/Drizzle `db()` singleton was removed entirely. Repo methods are `async` (file IO is synchronous under the hood), so the `await repo.x()` call sites read the same as before.

**The wrapper pattern (PR #13).** Every `src/app/api/**/route.ts` is exactly two lines: the comment `// Thin Next.js adapter — logic lives in @simple-harmonic/backend.` plus a single re-export, e.g. `export { GET, POST } from "@simple-harmonic/backend/server/api/tick"` (`src/app/api/tick/route.ts`). Handler modules export per-HTTP-method functions with the exact Next.js App Router signature — `(req: Request, ctx: { params: Promise<Record<string,string>> }) => Response | Promise<Response>` (`packages/backend/src/server/standalone/routes.ts:44-47`) — parse their own bodies via `req.json()`, return web-standard `Response.json()` / `new Response(stream)`, and import nothing from `next` (test-enforced by `packages/backend/tests/unit/standalone-routes.test.ts`, which also regex-checks the wrapper shape and fails if the wrapper's method list drifts from the handler module's). Import resolution: `packages/backend/package.json` exports `"./*": "./src/*"` plus the root `tsconfig.json` path `@simple-harmonic/backend/*` → `./packages/backend/src/*`. The same 30 handler modules are served a second time by the standalone host (see [the standalone section](#packagesbackendsrcserverstandalone)). Per-route entries below therefore document the backend handler module and name the wrapper once; "Called by" lists are unchanged because all in-repo callers go through the Next route paths (or the standalone host's identical patterns).

> **Parked: the skills-directory migration (stash@{0}).** An uncommitted 2026-06 branch of work migrated custom skills from flat JSON files to directory-based `SKILL.md` skills with a sub-skill tree and progressive disclosure (`open_skills` persistence, a `close_skills` tool), threading an `openSkills` list through the tick route (into `runAgent` in both passes, persisted back in `handleRunResult`) and adding an `open_skills` agent field. That code was discarded on 2026-06-11 and is no longer anywhere in the repo: `custom-tools.ts` loads flat `.simple-harmonic/skills/<name>.json` files and the tick route has no `openSkills`. (Moot anyway since PR #16: there is no Postgres schema or `SCHEMA_SQL` to add a column to — the agent row is just a JSON file.) Only the migration's untracked data survives, parked in git `stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees, `packages/backend/tests/unit/skill-tree.test.ts`, and `simple-harmonic.config.json`.

The one handler with real internal structure is `POST /api/tick`, the scheduler heartbeat (`packages/backend/src/server/api/tick.ts`). Its internal call graph:

```
POST /api/tick  (cron-authed: isCronAuthorized)
  │
  ├─ pruneTraceEvents()  (fire-and-forget trace retention, hourly-throttled)
  ├─ one-time: reset stale inFlight flags (didResetInFlight)
  ├─ resolveLLM({onFallback})  ← Codex > Anthropic > OpenRouter > OpenAI cascade
  │                                              fallback ─▶ warning app event
  ├─ useCodexHarness = apiKeySource==="codex" && SH_CODEX_RUNTIME!=="exec"
  ├─ checkSpendAllowed ──(cap hit)──▶ early return {skipped:"spend_cap"}
  │
  └─ for each active team (not paused, heartbeat < HIBERNATE_THRESHOLD_MS)
       ├─ createAppRegistryWithCustomTools()          (fresh registry per team)
       ├─ auto-recover: errored agents → running
       │
       ├─ RESUME pass: status=awaiting_approval ──▶ tryResumeAgent ──┐
       ├─ FRESH  pass: approveAgentTick(...)    ──▶ runFreshAgent  ──┤
       │   (both passes run their agents concurrently; countRan tallies)
       │                                                             │
       │            ┌────────────────────────────────────────────────┘
       │            ├─ agents.claim        (atomic inFlight CAS; skip if lost)
       │            ├─ createTraceSink     (play-by-play steps → agent_trace_events)
       │            ├─ withTimeout(runCodexAgentTick | runAgent)   ← engine mode vs runner
       │            │     └─ AgentTimeoutError on budget overrun (abort signal)
       │            ├─ ok  ─▶ handleRunResult   (park on suspension, else log + reschedule)
       │            ├─ ok  ─▶ recordSpend       (makeCountingLLM usage, or real harness tokens)
       │            ├─ err ─▶ failAgent         (tick_failed step + emitAppEvent + a2ax broadcast)
       │            └─ finally ─▶ trace.flush()
       │
       └─ teams.tickCount += 1

GET /api/tick ──▶ POST  (Vercel cron sends GET)
```

Callers of the tick endpoint: the dev loop in `src/instrumentation.ts:29` (every 10 s), the Vercel cron defined in `vercel.json` (production, every minute), and the standalone host's in-process loop (`packages/backend/src/server/standalone/main.ts:54-62`, every 10 s, calls the imported handler directly — no HTTP hop). `src/proxy.ts:23` exempts `/api/tick` from the operator gate because the route enforces its own `CRON_SECRET` auth; the standalone host's `gate` does the same (`packages/backend/src/server/standalone/server.ts:82`).

---

## `src/proxy.ts`

Next 16 proxy (the renamed `middleware` convention). Gates every matched request behind the single shared `OPERATOR_PASSWORD`. Edge-safe: only Web Crypto and header parsing, no node-only APIs. The standalone host re-implements the same gate for `/api/*` only in `gate` (`packages/backend/src/server/standalone/server.ts:79`); this proxy additionally gates every page.

### `proxy(req)` — `src/proxy.ts:18`

The request gate. Control flow: (1) if the path is `/api/tick` or under it, pass through immediately (`NextResponse.next()`) — the tick route does its own cron auth (`src/proxy.ts:23-25`). (2) Read `process.env.OPERATOR_PASSWORD`; if unset, fail closed with 503 when `isProductionRuntime()` is true (JSON body for `/api/*` paths, plain text for pages), otherwise pass everything through so local dev works with zero config (`src/proxy.ts:30-38`). (3) Call `isOperatorAuthorized(req, password)`; authorized requests pass. (4) Unauthorized API requests get JSON `{error:"unauthorized"}` 401; unauthorized page requests are redirected to `/login` via a cloned URL.

- **Calls:** `isOperatorAuthorized`, `isProductionRuntime` (`@simple-harmonic/backend/server/operator-auth`)
- **Called by:** Next.js runtime for every request matched by `config.matcher`

### `config` (matcher) — `src/proxy.ts:54`

`matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/login).*)"]` — applies the proxy to everything except Next static assets, the favicon, the `/login` page, and `POST /api/login`. The login surfaces must stay reachable so the operator can authenticate at all.

---

## `src/instrumentation.ts`

Next.js instrumentation hook; runs once on server startup.

### `register()` — `src/instrumentation.ts:9`

Only acts when `NEXT_RUNTIME === "nodejs"`. Two phases: (1) dynamically imports `@simple-harmonic/backend/server/apollo` and calls `apollo.load()`, which decrypts `.apollo/vault.enc` and writes the stored secrets into `process.env`; logs the secret count if any were loaded. This must run before anything reads env vars (config, connectors, tools). (2) If `process.env.VERCEL` is not set (i.e., not on Vercel), starts the **dev tick loop**: a `setInterval` with `TICK_INTERVAL_MS = 10_000` (`src/instrumentation.ts:20`) that POSTs `http://localhost:${PORT||3000}/api/tick`, attaching `authorization: Bearer ${CRON_SECRET}` when `CRON_SECRET` is set. Fetch errors are swallowed (server not ready yet; retried next interval). On Vercel, the cron in `vercel.json` ticks instead. The standalone entrypoint `packages/backend/src/server/standalone/main.ts` mirrors this exact boot order (apollo load, then the tick loop) without Next.

- **Calls:** `apollo.load()` (`@simple-harmonic/backend/server/apollo`); `fetch` against `POST /api/tick` (`packages/backend/src/server/api/tick.ts:112`)
- **Called by:** Next.js runtime at server startup

---

## `packages/backend/src/server/api/tick.ts` (wrapper: `src/app/api/tick/route.ts`)

The scheduler heartbeat. One POST steps every due/resumable agent across all active teams, concurrently per team, each agent under a wall-clock budget, with a daily spend cap in front. It also resolves the multi-provider LLM cascade (PR #14), selects engine mode vs the runner (PR #12), and emits/persists play-by-play trace events (PR #12).

### `HIBERNATE_THRESHOLD_MS` — `packages/backend/src/server/api/tick.ts:40`

`5 * 60 * 1000` (5 minutes). A team only ticks if `teams.lastUserActiveAt` is within this window (`packages/backend/src/server/api/tick.ts:134-137`). Teams with `lastUserActiveAt = null` never tick. The heartbeat route and the approvals POST both bump this field on the team's `team.json`.

### `didResetInFlight` (module state) — `packages/backend/src/server/api/tick.ts:43`

Boolean module flag, initially `false`. On the first POST of a process lifetime, the handler sets it `true` and clears `inFlight` on every agent stuck `inFlight=true` from a previous crash via `agents.resetAllInFlight()` (`packages/backend/src/server/api/tick.ts:125`). If the reset throws, the flag is set back to `false` so the next tick retries. Process-local: each Next.js worker (or the standalone host process) performs its own reset — and since the file store is single-writer, only one process should run against a data dir anyway.

### `agentTimeoutMs()` — `packages/backend/src/server/api/tick.ts:49`

Returns the per-agent wall-clock budget for one tick: `SH_AGENT_TIMEOUT_MS` parsed as a positive integer, else 120 000 ms (matches the LLM client timeout). A hung LLM call or slow tool therefore cannot pin an agent `inFlight` forever or stall the tick response.

- **Calls:** nothing (env read only)
- **Called by:** `POST` (`packages/backend/src/server/api/tick.ts:166`)

### `HISTORY_LIMIT` / `VALIDATION_HISTORY_LIMIT` — `packages/backend/src/server/api/tick.ts:57,59`

`10` and `5`. How many recent action-log rows feed back into the agent prompt as working memory, and how many validation outcomes are surfaced. `fetchRecentValidations` over-fetches `VALIDATION_HISTORY_LIMIT * 2` rows because not every row carries a validation.

### `fetchRecentValidations(d, agentId)` — `packages/backend/src/server/api/tick.ts:61`

Loads the agent's last 10 action-log entries (newest first, then reversed to chronological), extracts `payload.validation` from each entry that has one, and formats up to 5 lines of `[HH:MM:SS] PASS` or `[HH:MM:SS] FAIL: path: message; ...`. Returns the joined string or `undefined` when no validations exist. Only invoked when the agent has an `outputContract`.

- **Calls:** `actionLog.recentByAgent(agentId, VALIDATION_HISTORY_LIMIT * 2)` (`server/store`; reads the agent's `actions.jsonl`)
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:368`)

### `fetchRecentHistory(d, agentId)` — `packages/backend/src/server/api/tick.ts:82`

Loads the agent's last `HISTORY_LIMIT` (10) action-log entries, reverses to chronological order, and renders each as `[HH:MM:SS] actionType: summary` using `summarizePayload`. Returns `undefined` when the log is empty. This is the agent's per-tick working memory.

- **Calls:** `summarizePayload` (`packages/backend/src/server/api/tick.ts:87`); `actionLog.recentByAgent(agentId, HISTORY_LIMIT)` (`server/store`)
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:367`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:502`)

### `summarizePayload(actionType, payload)` — `packages/backend/src/server/api/tick.ts:93`

One-line summary of an action-log payload, in priority order: `awaiting_approval` rows become `requested approval for <toolName|tool|unknown>`; payloads with `tool` + `args` become `tool(jsonArgs)` with args truncated at 120 chars; otherwise `payload.summary` (first 150 chars), then `payload.message` (first 150 chars), then the whole payload JSON truncated at 150 chars.

- **Calls:** nothing
- **Called by:** `fetchRecentHistory` (`packages/backend/src/server/api/tick.ts:87`)

### `POST(req)` — `packages/backend/src/server/api/tick.ts:112`

The tick. Request: empty body; auth via `isCronAuthorized(req, CRON_SECRET)` (bearer token, or the `x-vercel-cron` header — trusted only when `process.env.VERCEL` is set, since the standalone host has no edge stripping client-supplied copies) — 401 `{error:"unauthorized"}` on failure. Control flow: (1) fire-and-forget `pruneTraceEvents()` (`tick.ts:120`) — trace retention sweep, internally throttled to hourly. (2) One-time in-flight reset (see `didResetInFlight`). (3) Load all non-paused teams; filter to those with a user heartbeat within `HIBERNATE_THRESHOLD_MS`. (4) Resolve the LLM via `resolveLLM({onFallback})` (`tick.ts:146`, `server/llm.ts`) — one cascading client over the candidates **Codex CLI > Anthropic > OpenRouter > OpenAI**; each provider failure invokes `onFallback` (`tick.ts:147-156`), which emits a warning app event `LLM <provider>/<model> failed (<reason, 200 chars>); falling back to <next>` (or `...; cascade exhausted`). `modelOverride` is the primary candidate's model. (5) Compute `useCodexHarness = apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec"` (`tick.ts:164`) — engine mode, where codex owns the agent loop; the cascade client is still built either way to serve legacy message-based suspensions. (6) Daily spend cap via `checkSpendAllowed`: if the ledger is unreadable, emit a warning app event and proceed (fail-open so a corrupt/unreadable `system/spend.jsonl` can't halt all agents); if the cap is hit, emit an error event and return 200 `{ok:true, agentsRan:0, skipped:"spend_cap", spentCents, capCents, timestamp}`. (7) Per team: rebuild the tool registry with custom skills (`createAppRegistryWithCustomTools`), auto-recover `errored` agents to `running`, then run two sequential passes whose member agents run **concurrently** via `Promise.allSettled` — the resume pass (`tryResumeAgent` for every `awaiting_approval` agent) then the fresh pass (`runFreshAgent` for every agent `approveAgentTick(team, agent, now).allowed` — that backend gate blocks parked agents, in-flight agents, and agents not yet due); both passes receive `useCodexHarness`. Finally increment the team's tick count once via `teams.incrementTickCount(team.id)`. Response 200: `{ok:true, agentsRan, timestamp}`. (Note: the concurrent `Promise.allSettled` agents share the single-writer file store; each agent's synchronous read-modify-write runs to completion before any other event-loop task, so concurrent runs cannot interleave a mutation — the atomic `agents.claim` CAS still guards against double-running.)

- **Calls:** `isCronAuthorized` (`server/operator-auth`), `pruneTraceEvents` (`server/trace`), `teams`/`agents`/`approvals`/`actionLog` repos (`server/store`), `getA2AX` (`server/a2ax`), `getApiKeySource` (`server/config`), `resolveLLM` (`server/llm`), `checkSpendAllowed` (`server/spend`), `emitAppEvent` (`server/app-events`), `createAppRegistryWithCustomTools` (`server/tools`), `approveAgentTick` (`lib/meta-agent`); local: `agentTimeoutMs`, `tryResumeAgent`, `runFreshAgent`, `countRan`
- **Called by:** `src/instrumentation.ts:29` (dev loop), Vercel cron via `vercel.json` (as GET, see below), the standalone tick loop (`packages/backend/src/server/standalone/main.ts:54-62`, imported and called in-process), local `GET` (`packages/backend/src/server/api/tick.ts:698`)

### `buildPeers(allAgents, selfId)` — `packages/backend/src/server/api/tick.ts:267`

Maps the team's agent rows (excluding the agent itself) to the runner's `PeerAgent` shape `{id, name, role}` so prompts can list teammates.

- **Calls:** nothing
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:398`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:512`)

### `countRan(outcomes)` — `packages/backend/src/server/api/tick.ts:274`

Counts how many `PromiseSettledResult<boolean>` entries are fulfilled with `true` — i.e., agents that actually ran (a resumed-and-still-waiting agent or a failed one returns `false`; a rejected promise is also not counted).

- **Calls:** nothing
- **Called by:** `POST` (`packages/backend/src/server/api/tick.ts:234,255`)

### `class AgentTimeoutError` — `packages/backend/src/server/api/tick.ts:282`

`Error` subclass with message `"<label> exceeded the <ms>ms tick budget"` and `name = "AgentTimeoutError"`. Constructed inside `withTimeout` and used both as the rejection reason and as the `AbortController.abort()` reason.

- **Called by:** `withTimeout` (`packages/backend/src/server/api/tick.ts:295`)

### `withTimeout(run, ms, label)` — `packages/backend/src/server/api/tick.ts:295`

Races `run(signal)` against a wall-clock budget. Creates an `AbortController`; on timeout it aborts the signal (so provider adapters that honor cancellation stop working) and rejects with `AgentTimeoutError`. A `settled` flag makes resolve/reject/timeout mutually exclusive, and the timer is always cleared on settlement so a resolved race doesn't keep the event loop alive.

- **Calls:** local `AgentTimeoutError`
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:410,419`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:525,535`)

### `interface RunArgs` — `packages/backend/src/server/api/tick.ts:327`

Shared argument bag for both run paths: `{d, team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry, useCodexHarness}` — the last field selects the codex app-server harness over the runner.

### `interface RunOutcome` — `packages/backend/src/server/api/tick.ts:344`

Structural result type that both `runAgent` (runner) and `runCodexAgentTick` (harness) satisfy: `{actionType, payload, suspension?: {pending: PendingToolCall[]}, validation?}`. Only `pending` is typed on the suspension because the whole object is persisted opaquely into the agent's `conversationState` field (written to `agent.json` as JSON) — the route never inspects the rest. `serialize.reviveDates` only revives declared top-level date keys, so the opaque suspension blob round-trips untouched.

### `runFreshAgent(args)` — `packages/backend/src/server/api/tick.ts:356`

Runs one fresh tick for a due agent, time-bounded. Returns `true` if the agent ran (even if it then suspended), `false` on claim loss or failure/timeout. Flow: (1) `agents.claim(agent.id, "running")` (`tick.ts:359`) — bail if another worker already claimed it. (2) `createTraceSink({teamId, agentId})` (`tick.ts:362`) — fresh play-by-play thread. (3) In parallel, gather context: `a2ax.getAgentContext` (unread messages), `fetchRecentHistory`, `fetchRecentValidations` (only when an `outputContract` exists), `queryAppEvents` (team-scoped, last hour, max 10, no infra), and `getPlatformStatus`. (4) Build `appHealthContext` by joining `formatEventsForPrompt` + `formatPlatformStatusForPrompt`. (5) Build the shared prompt config (`tick.ts:385-404`: name, archetype, tools, initialPrompt, a2ax context, history, team goal, contract, validations, health, peers, registry + `registry.isDestructive`, `trace: trace.emit`), then branch on `useCodexHarness` (`tick.ts:409`): **engine mode** runs `runCodexAgentTick({...shared, signal})` inside `withTimeout`, taking real token usage from the harness result with model `modelOverride ?? "gpt-5.5"`; **runner mode** wraps the cascade LLM in `makeCountingLLM` and runs `runAgent` inside `withTimeout`. (6) On success: `a2ax.markContextRead` for the consumed messages, `handleRunResult` (persist outcome, passing `traceTickId: trace.tickId`), `recordSpend` (token usage). (7) Any throw (including `AgentTimeoutError`) goes to `failAgent` with phase `"tick"` (which emits the `tick_failed` trace step) and returns `false`. (8) `finally`: `await trace.flush()` (`tick.ts:441`) — buffered trace rows always land.

- **Calls:** inline `agents.claim` CAS, `fetchRecentHistory`, `fetchRecentValidations`, `buildPeers`, `withTimeout`, `handleRunResult`, `failAgent`; backend `createTraceSink` (`server/trace`), `a2ax.getAgentContext`/`markContextRead` (`server/a2ax`), `queryAppEvents`/`getPlatformStatus`/`formatEventsForPrompt`/`formatPlatformStatusForPrompt` (`server/app-events`), `makeCountingLLM`/`recordSpend` (`server/spend`), `runAgent` (`lib/meta-agent`), `runCodexAgentTick` (`lib/meta-agent/codex-harness`); persistence via the `agents`/`actionLog` repos (`server/store`)
- **Called by:** `POST` fresh pass (`packages/backend/src/server/api/tick.ts:240`)

### `tryResumeAgent(args)` — `packages/backend/src/server/api/tick.ts:450`

Resumes an agent parked `awaiting_approval`, but only if every pending approval is resolved. Returns `true` only when the agent actually resumed and ran. Flow: (1) read the saved suspension from the agent's `conversationState` field — either shape may be parked: a legacy message-based `AgentSuspension` or an engine-mode `CodexThreadSuspension` (`tick.ts:455-458`); both carry `pending`. If missing (defensive), clear the agent's approvals (`approvals.clearForAgent`) and reset it to `running` with cleared state — both sides of the parked state are wiped so stale approval cards can't linger. (2) Load the agent's approvals (`approvals.byAgent`, `tick.ts:471`) and intersect with the suspension's expected tool-call ids; if any expected row is *missing* (incomplete parking write), hold — a missing human decision is never treated as a rejection. If any row is still `pending`, hold. (3) Build `ToolDecision[]` (`approved` iff row status is `approved`, plus `decisionNote`). (4) `agents.claim(agent.id, "awaiting_approval")` (`tick.ts:491`). (5) `createTraceSink({teamId, agentId, tickId: extractTraceTickId(...)})` (`tick.ts:496-500`) — continues the original tick's trace thread. (6) Branch on the **suspension shape**, not the `useCodexHarness` flag: `isCodexThreadSuspension(suspension)` (`tick.ts:523`) → `runCodexAgentTick` with `resume: {suspension, decisions}` (codex thread resume); otherwise the legacy path (pre-harness parks, or `SH_CODEX_RUNTIME=exec`) → `makeCountingLLM` + `runAgent` with `resume`. Both run under `withTimeout` with a leaner context (history + peers, no a2ax/health/validation context). (7) On success: clear the consumed approvals (`approvals.clearForAgent`), `handleRunResult` (with `traceTickId`), `recordSpend`. On failure: also clear the approvals, then `failAgent` with phase `"resume"`. (8) `finally`: `await trace.flush()` (`tick.ts:565`).

- **Calls:** inline `agents.claim` CAS, `fetchRecentHistory`, `buildPeers`, `withTimeout`, `extractTraceTickId`, `handleRunResult`, `failAgent`; backend `createTraceSink` (`server/trace`), `makeCountingLLM`/`recordSpend` (`server/spend`), `runAgent` (`lib/meta-agent`), `runCodexAgentTick`/`isCodexThreadSuspension` (`lib/meta-agent/codex-harness`); `approvals`/`agents` repos (`server/store`)
- **Called by:** `POST` resume pass (`packages/backend/src/server/api/tick.ts:218`)

### `extractTraceTickId(conversationState)` — `packages/backend/src/server/api/tick.ts:571`

Pulls the `traceTickId` that `handleRunResult` parked alongside a suspension, validated against `UUID_RE` (`tick.ts:573`); returns `undefined` (→ fresh tickId) for pre-trace suspensions or bad data. Keeps one logical suspended-and-resumed tick reading as a single play-by-play thread.

- **Calls:** nothing
- **Called by:** `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:499`)

### The atomic agent claim — `packages/backend/src/server/store/repos/agents.ts:144`

There is no `claimAgent` wrapper in `tick.ts`; both run paths call the store method `agents.claim(id, expectedStatus)` directly (inline at `tick.ts:359` in `runFreshAgent` and `tick.ts:491` in `tryResumeAgent`). The CAS itself is a synchronous read-modify-write of the agent's `agent.json` (`agents.ts:144-153`) that sets `inFlight = true` only if the current row has `inFlight === false` and `status === expectedStatus`, returning `true` iff it flipped the flag. Because the file store is single-threaded and the read-modify-write runs to completion uninterrupted, this is an effective compare-and-set that lets concurrent ticks within the process never double-run an agent (the Postgres `UPDATE ... WHERE ... RETURNING` CAS is gone).

- **Calls:** `readJson`/`writeJson` (`server/store/fs-store`)
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:359`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:491`)

### `failAgent(args)` — `packages/backend/src/server/api/tick.ts:581`

Common failure handling, double-written: (1) `console.error`; (2) terminal play-by-play step `trace?.emit({type:"tick_failed", data:{phase, error}})` (`tick.ts:595` — the caller flushes the sink); (3) persistent record via `emitAppEvent` (severity `error`, level `agent`, source `tick` or `tick-resume`, queryable later by the `observe_app` tool); (4) fire-and-forget `a2ax.broadcast` of `[SYSTEM] Agent <name> errored during <phase>: <msg>` with `{systemAlert:true}` payload so peers see the failure on their next tick — a failed broadcast never blocks recovery (`.catch(() => {})`); (5) reset the agent via `agents.update`: `inFlight=false, status="errored", conversationState=null, nextRunAt = now + scheduleSeconds` — advancing `nextRunAt` prevents tight-looping. (The next tick's auto-recover loop flips `errored` back to `running`.)

- **Calls:** `emitAppEvent` (`server/app-events`), `a2ax.broadcast` (`server/a2ax`), `PersistentTraceSink.emit` (`server/trace`), `agents.update` (`server/store`)
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:438`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:562`)

### `handleRunResult(args)` — `packages/backend/src/server/api/tick.ts:631`

Applies a `RunOutcome` (from either `runAgent` or `runCodexAgentTick`) to the store. Two branches: **Suspension** — set the agent to `awaiting_approval` with `conversationState` = the opaque suspension object **plus a `traceTickId` key riding along** (`tick.ts:649-657`; the runner ignores it and `extractTraceTickId` reads it back on resume), write one approval per pending tool call via `approvals.insertMany` (`toolCallId`, `toolName`, `toolArguments`), and `actionLog.insert` an `awaiting_approval` entry so the suspension shows in the narration feed. Critically, `nextRunAt` is **not** advanced — the resume pass owns the agent until decisions land. These are separate sync file writes rather than one DB transaction; the single-writer store means no other tick interleaves between them, though there is no rollback if the process dies mid-sequence (the defensive missing-suspension reset in `tryResumeAgent` covers a half-written park). **Normal completion** — `actionLog.insert` an entry with `result.actionType` and the payload (merging in `{validation: {valid, issues}}` when the run validated an output contract), then `agents.update` the agent back to `running` with cleared `conversationState` and `nextRunAt = now + scheduleSeconds`.

- **Calls:** `agents.update`, `approvals.insertMany`, `actionLog.insert` (`server/store`)
- **Called by:** `runFreshAgent` (`packages/backend/src/server/api/tick.ts:428`), `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:551`)

### `GET(req)` — `packages/backend/src/server/api/tick.ts:698`

`return POST(req)` — Vercel cron sends GET requests, so GET is an alias of POST (including the cron auth check).

- **Calls:** local `POST`
- **Called by:** Vercel cron (`vercel.json`, path `/api/tick`)

---

## `packages/backend/src/server/api/chat.ts` (wrapper: `src/app/api/chat/route.ts`)

Operator ↔ planner ("Harmon") conversation endpoint. Streams planner tokens over SSE and emits one structured terminal event.

### `applyModifyAgent(result)` — `packages/backend/src/server/api/chat.ts:9`

Applies a planner `ModifyAgentResult` to the store. Looks up the team **by name** (`teams.all().find`), then the agent **by name within that team** (`agents.byTeam(...).find`) (returns `{ok:false, error}` for either miss). Translates the snake_case update fields to row field names — `tools`, `initial_prompt`→`initialPrompt`, `schedule_seconds`→`scheduleSeconds`, `role`, `status`, `output_contract`→`outputContract` — rejecting an empty update set with `"No updates provided"`. Performs a single `agents.update` and returns `{ok:true}`.

- **Calls:** `teams`/`agents` repos (`server/store`)
- **Called by:** `POST` (`packages/backend/src/server/api/chat.ts:78`)

### `POST(request)` — `packages/backend/src/server/api/chat.ts:43`

Request: `{messages: PlannerMessage[]}`; 400 `{error:"messages required"}` when missing/empty. Otherwise returns a 200 `text/event-stream` (headers `Cache-Control: no-cache`, `Connection: keep-alive`) built from a `ReadableStream`. Inside `start`: calls `plannerStream(messages, onToken, buildPlannerDeps())`, emitting `data: {type:"token", text}` per token. The terminal frame depends on the planner result: `spawn` → `{type:"spawn", agents, teamName, parentTeam, cofounderName, content}` (the **frontend** then POSTs `/api/spawn`; this route does not create the team); `modify_agent` → applies via `applyModifyAgent` and emits `{type:"modify_agent", agentName, teamName, updates, applied, content}`; `request_credential` → `{type:"request_credential", key, label, reason, helpUrl, content}`; anything else → `{type:"done", content}`. Errors are caught, recorded via `emitAppEvent` (severity error, level infra, source api), and emitted as `{type:"error", message}`; the stream always closes in `finally`.

- **Calls:** `plannerStream` (`lib/meta-agent`), `buildPlannerDeps` (`server/planner-deps`), `emitAppEvent` (`server/app-events`); local `applyModifyAgent`
- **Called by:** `packages/frontend/src/components/chat/use-chat.ts:76`

---

## `packages/backend/src/server/api/spawn.ts` (wrapper: `src/app/api/spawn/route.ts`)

Creates a team (optionally as a child team) with its agents, auto-adding a Harmon cofounder agent on root teams.

### `HARMON_TOOLS` — `packages/backend/src/server/api/spawn.ts:5`

The auto-spawned cofounder agent's tool list: `read_file`, `write_file`, `action_history`, `set_team_goal`, `modify_team`, `spawn_sub_team`, `modify_agent`, `send_message`, `broadcast`, `report_action` — i.e., management plus file access, no shell/coding tools.

### `HARMON_PROMPT` — `packages/backend/src/server/api/spawn.ts:18`

The hard-coded initial prompt for the cofounder agent: "You are Harmon, the AI cofounder and team lead… management, not execution." It prescribes a per-tick loop (review team history via `action_history` scope team, check output-contract validation pass/fail, identify stuck/idle agents and missing capabilities, act via `modify_agent`/`spawn_sub_team`/`modify_team`/`set_team_goal`, then summarize via `report_action`) and a "be surgical, don't change what's working" doctrine.

### `POST(request)` — `packages/backend/src/server/api/spawn.ts:54`

Request: `{agents: SpawnAgent[], teamName?, parentTeam?, parentTeamId?, cofounderName?, goal?, noHarmon?}` (the body shape is the local `interface SpawnPayload`) where each `SpawnAgent` is `{name, role, archetype, tools, schedule_seconds, initial_prompt}`. 400 if `agents` is missing/empty; 400 `Parent team "X" not found` if `parentTeam` (a name) doesn't resolve and no `parentTeamId` was given (resolved via `teams.all().find`). Behavior: team name defaults to the joined archetypes truncated to 50 chars; cofounder name defaults to `"Harmon"`. `teams.insert` creates the team (with `parentTeamId`, `cofounderName`, `goal`) — the repo writes `<dataDir>/teams/<id>/team.json`, nesting under the parent's `teams/` folder when `parentTeamId` is set — then `agents.insertMany` writes the agent rows with `nextRunAt = now + schedule_seconds*1000 + i*2000` (2 s stagger per index so a fresh team doesn't thundering-herd one tick). If the team is a root team (`!resolvedParentId`) and `noHarmon` is not set, appends an extra agent: name = slugified cofounder name, archetype `meta-agent`, `HARMON_TOOLS`, `scheduleSeconds: 3600`, `HARMON_PROMPT`, first run `now + 1h + 2s*len(agents)`. (No separate chat-session record is created; conversation state lives as files under the team folder.) Response 200: `{teamId, parentTeamId}`.

- **Calls:** `teams.insert`, `agents.insertMany`, `teams.all` (`server/store`)
- **Called by:** `src/app/(app)/new/page.tsx:61` (after a chat `spawn` event)

---

## `packages/backend/src/server/api/teams.ts` (wrapper: `src/app/api/teams/route.ts`)

### `GET()` — `packages/backend/src/server/api/teams.ts:5`

No parameters. `teams.all()` returns every team oldest-first; the handler `reverse()`s to newest-first (matching the old `ORDER BY created_at DESC`) and returns 200 with the array. No pagination.

- **Calls:** `teams.all` (`server/store`)
- **Called by:** `packages/frontend/src/components/sidebar.tsx:68`, `src/app/(app)/page.tsx:62`, `src/app/(app)/settings/skills/page.tsx:42`

---

## `packages/backend/src/server/api/team/id/index.ts` (wrapper: `src/app/api/team/[id]/route.ts`)

Team detail with recursive sub-tree, plus a whitelisted PATCH.

### `GET(_req, {params})` — `packages/backend/src/server/api/team/id/index.ts:5`

Awaits the route param (`params` is a Promise in Next 15+). 404 `{error:"not found"}` if the team doesn't exist (`teams.byId`). Loads the team's direct agents (`agents.byTeam`), then loads **all** teams (`teams.all`), computes the descendant set with `getSubTreeIds`, removes the root id, and fetches the agents of every descendant team in one `agents.byTeams(subTreeIds)` call. Response 200: `{team, agents, childTeams, childAgents}`.

- **Calls:** local `getSubTreeIds`; `teams`/`agents` repos (`server/store`)
- **Called by:** `packages/frontend/src/components/sidebar.tsx:80`, `packages/frontend/src/components/team/use-team.ts:58,79`, `src/app/(app)/page.tsx:69`, `src/app/(app)/settings/skills/page.tsx:50`

### `getSubTreeIds(rootId, allTeams)` — `packages/backend/src/server/api/team/id/index.ts:38`

Pure traversal: builds a parent→children map from `parentTeamId`, then walks an explicit DFS stack from `rootId` to collect the full sub-tree as a `Set<string>` (including the root itself; the caller deletes it). No cycle guard beyond the Set semantics — `result.add` plus stack-pushing children means an accidental cycle would loop; team rows only set `parentTeamId` at creation, so cycles aren't constructible via this app's writers. Note a sibling implementation of the same algorithm exists in the backend (used by the meta-agent tools); this one is route-local.

- **Calls:** nothing
- **Called by:** `GET` (`packages/backend/src/server/api/team/id/index.ts:17`)

### `PATCH(req, {params})` — `packages/backend/src/server/api/team/id/index.ts:60`

Request: JSON body; only `name`, `metaAgentPrompt`, `cofounderName` are accepted (whitelist loop). 400 `{error:"no valid fields"}` if nothing matched; 404 if `teams.update` returned null (no such team). Response 200: the full updated team row.

- **Calls:** `teams.update` (`server/store`)
- **Called by:** `src/app/(app)/f/[id]/team-view.tsx:110`

---

## `packages/backend/src/server/api/team/id/agent-hub.ts` (wrapper: `src/app/api/team/[id]/agent-hub/route.ts`)

One-shot agent dashboard. The whole payload (agents, cofounder name, action log, messages) is assembled from four parallel store/a2ax reads — file IO is local and cheap, so the previous single `json_build_object` SQL round trip (a workaround for Neon's ~300 ms per-query latency) is gone.

### `GET(req, {params})` — `packages/backend/src/server/api/team/id/agent-hub.ts:14`

Request: `?agentId=` required (400 without it). `agentId` may be a real agent UUID or one of the sentinel ids `COFOUNDER_AGENT_ID` / `USER_AGENT_ID`. A single `Promise.all` runs four reads: `agents.byTeam(teamId)` (all team agents), `teams.byId(teamId)` (for `cofounderName`), `actionLog.recentByAgent(agentId, 100)` (the **latest 100** action-log entries for the requested agent), and `a2ax.listMessages(teamId, 200)` (the **oldest 200** team messages — note the asymmetry: actions are newest-first, messages oldest-first). The handler maps those into the same snake_case shapes the old SQL emitted, builds a name map (agent rows + cofounder display name via `resolveCofounderName` + `USER_DISPLAY_NAME`), 404s when a non-sentinel `agentId` matches no agent, and assembles a merged timeline (local inline types `TimelineAction`/`TimelineReceived`/`TimelineSent`): every action; received messages = not from the agent AND (broadcast OR `channel_id` contains the agent id); sent messages only for the cofounder/user POVs (their `from_agent_id` matches), with `toName` derived by splitting the channel id on `:` and mapping peer ids through the name map. Sorted ascending by timestamp. Response 200: `{agentId, agentName, agentRole, agentStatus, agentSchedule, nextRunAt, inFlight, timeline}` — sentinel POVs get synthetic values (`running`, schedule 0, `nextRunAt` null). There are no top-level helper functions; all mapping is inline in the handler.

- **Calls:** `COFOUNDER_AGENT_ID`/`USER_AGENT_ID`/`USER_DISPLAY_NAME`/`resolveCofounderName` (`lib/meta-agent/identity`), `agents.byTeam`/`teams.byId`/`actionLog.recentByAgent` (`server/store`), `getA2AX().listMessages` (`server/a2ax`)
- **Called by:** `packages/frontend/src/components/team/agent-pov-view.tsx:324,483`

---

## `packages/backend/src/server/api/team/id/approvals.ts` (wrapper: `src/app/api/team/[id]/approvals/route.ts`)

Approval queue for human-in-the-loop tool calls.

### `GET(_req, {params})` — `packages/backend/src/server/api/team/id/approvals.ts:7`

Lists the team's pending approvals (`approvals.pendingForTeam(id)`, which walks the team's agents and reads each agent's `approvals.json`, keeping `status === "pending"`). Response 200: `{approvals: [{id, agentId, toolName, toolArguments, createdAt}]}`.

- **Calls:** `approvals.pendingForTeam` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/approval-queue.tsx:36` (polled on an interval)

### `interface DecisionBody` — `packages/backend/src/server/api/team/id/approvals.ts:21`

`{approvalId, decision: "approved"|"rejected", note?}` — the POST body shape.

### `POST(req, {params})` — `packages/backend/src/server/api/team/id/approvals.ts:30`

Resolves one approval. 400 unless `approvalId` and a valid `decision` are present. The resolution itself is delegated to `approvals.resolve(teamId, approvalId, decision, note)`, which returns `{ok:false, reason:"not_found"}` → 404 `approval not found`, or `{ok:false, reason}` (already decided) → 409 `approval already resolved`. The repo does the read-modify-write of the agent's `approvals.json`, only flipping a row that is still `pending` (guarding the read-then-write race in a single synchronous mutation). Side effects on success: the resolved row gets `status`, `decisionNote`, `resolvedAt`; then `agents.update(result.agentId, {inFlight:false})` clears the agent's `inFlight` flag so the resume pass re-checks it promptly (status stays `awaiting_approval` — **the tick route owns the parked→running transition** once all of the agent's approvals are resolved); and `teams.update(id, {lastUserActiveAt})` bumps the team so it doesn't hibernate mid-approval. Response 200: `{ok:true, decision}`.

- **Calls:** `approvals.resolve`, `agents.update`, `teams.update` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/approval-queue.tsx:57`; consumed downstream by `tryResumeAgent` (`packages/backend/src/server/api/tick.ts:471`)

---

## `packages/backend/src/server/api/team/id/conversations.ts` (wrapper: `src/app/api/team/[id]/conversations/route.ts`)

Threaded message view from one participant's point of view.

### `GET(req, {params})` — `packages/backend/src/server/api/team/id/conversations.ts:15`

Request: `?agentId=` required (400 without). Special values: `"team"` (team overview — every message), the POV strings `COFOUNDER_POV`/`USER_POV` (translated to the sentinel UUIDs `COFOUNDER_AGENT_ID`/`USER_AGENT_ID`), or a real agent UUID. Loads team agents (`agents.byTeam`) + the team row (`teams.byId`) in parallel to build the display-name map (cofounder name resolved via `resolveCofounderName`). Fetches up to 1000 team messages via `a2ax.listMessages(teamId, 1000)` (already ascending by `createdAt`), then filters (unless team overview) to messages involving the participant: any broadcast, anything they sent, or direct/group/task channels whose `channelId` contains the participant id (string containment). Task-channel display names come from a `task:<id>` → title map built from `a2ax.listTasks(teamId)`. Messages are grouped into threads keyed by `channelId`; the first message of each thread determines the header: direct channels split `direct:<id1>:<id2>` — team overview shows `"name1 ↔ name2"`, a participant POV shows the peer's name; broadcast → `"Team Broadcast"`; group → `"Group Chat"`; task → the task title. Each message is enriched with `fromAgentName` and `isSelf`. Threads are sorted by last-message time, newest thread first. Response 200: `{agentId, agentName, threads}`. All mapping is inline; there are no top-level helpers.

- **Calls:** identity sentinels + `resolveCofounderName` (`lib/meta-agent/identity`), `agents.byTeam`/`teams.byId` (`server/store`), `getA2AX().listMessages`/`.listTasks` (`server/a2ax`)
- **Called by:** `packages/frontend/src/components/team/agent-messages-view.tsx:217`

---

## `packages/backend/src/server/api/team/id/heartbeat.ts` (wrapper: `src/app/api/team/[id]/heartbeat/route.ts`)

### `POST(_req, {params})` — `packages/backend/src/server/api/team/id/heartbeat.ts:5`

Anti-hibernation keepalive: `teams.update(id, {lastUserActiveAt: now})`. No body, no validation, no 404 (an unknown id resolves to no team and updates nothing). Response 200: `{ok:true}`. The tick handler's hibernation filter (`packages/backend/src/server/api/tick.ts:134`) reads this field.

- **Calls:** `teams.update` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/use-team.ts:109,111` (on mount and on a visibility/interval loop)

---

## `packages/backend/src/server/api/team/id/messages.ts` (wrapper: `src/app/api/team/[id]/messages/route.ts`)

Read an agent's unread context / send a message through a2ax.

### `GET(req, {params})` — `packages/backend/src/server/api/team/id/messages.ts:13`

Request: `?agentId=` required (400 without). Calls `a2ax.getAgentContext(teamId, agentId)` — the same unread-message context an agent sees at tick time — then enriches each message with `fromAgentName` from a team-agent name map. Response 200: array of `{id, channelType, channelId, fromAgentId, fromAgentName, kind, content, status, urgent, createdAt}`. Does **not** mark messages read.

- **Calls:** `getA2AX().getAgentContext` (`server/a2ax`), `agents.byTeam` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/agent-pov-view.tsx:731`

### `POST(req, {params})` — `packages/backend/src/server/api/team/id/messages.ts:49`

Request: `{fromAgentId, toAgentId?, content, channelType?, channelId?}`. 400 unless `fromAgentId` and `content` are present. Dispatches on `channelType`: `"broadcast"` → `a2ax.broadcast`; `"group"` → `a2ax.sendToGroup` (400 without `channelId`); anything else → `a2ax.sendDirect` (400 without `toAgentId`). Response 201: the created a2ax message object.

- **Calls:** local `translatePov`; `getA2AX().broadcast`/`.sendToGroup`/`.sendDirect` (`server/a2ax`)
- **Called by:** `packages/frontend/src/components/team/agent-messages-view.tsx:279`, `packages/frontend/src/components/team/agent-pov-view.tsx:752`

### `translatePov(id)` (nested in `POST`) — `packages/backend/src/server/api/team/id/messages.ts:72`

Function declaration with overloads, defined inside `POST`. Maps the UI POV strings to sentinel UUIDs: `COFOUNDER_POV` → `COFOUNDER_AGENT_ID`, `USER_POV` → `USER_AGENT_ID`, anything else passes through (including `undefined`, preserved by the overload signatures).

- **Calls:** nothing (constant comparison)
- **Called by:** `POST` (`packages/backend/src/server/api/team/id/messages.ts:79-80`)

---

## `packages/backend/src/server/api/team/id/narration.ts` (wrapper: `src/app/api/team/[id]/narration/route.ts`)

SSE stream of the team's action log: one `history` frame on connect, then `update` frames from a 3-second DB poll.

### `GET(_req, {params})` — `packages/backend/src/server/api/team/id/narration.ts:8`

First resolves the team's agent ids (`agents.byTeam`; the action log keys on `agentId`, not `teamId`). If the team has no agents, returns a plain one-frame `Response` with `{type:"history", entries:[]}` and SSE headers, closing cleanly. Otherwise builds a `ReadableStream`: `start` emits the last 50 action-log entries across the team's agents (`actionLog.byAgents(agentIds, {limit: 50})`, newest-first, reversed to chronological) as `{type:"history", entries}` and records `lastSeen` from the newest entry; then a 3 s `setInterval` queries up to 20 entries with `executedAt > lastSeen` (same `actionLog.byAgents` with a `since`/`limit`), advancing `lastSeen` and emitting `{type:"update", entries}` (again reversed to chronological). Robustness: a `closed` flag plus a `safeEnqueue` wrapper handle the race where the controller closes between the guard and the enqueue; a read error inside the interval stops the loop and closes the controller rather than spamming it; `cancel()` (client disconnect) sets `closed` and clears the interval. Response 200, headers from `sseHeaders()`.

- **Calls:** local `sseHeaders`; `agents.byTeam`, `actionLog.byAgents` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/use-team.ts:122` (fetch-based SSE reader)

### `sseHeaders()` — `packages/backend/src/server/api/team/id/narration.ts:86`

Returns `{"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no"}` — the last header disables nginx/Vercel proxy buffering so frames stream live.

- **Calls:** nothing
- **Called by:** `GET` (`packages/backend/src/server/api/team/id/narration.ts:16,83`)

---

## `packages/backend/src/server/api/team/id/pause.ts` (wrapper: `src/app/api/team/[id]/pause/route.ts`)

### `POST(_req, {params})` — `packages/backend/src/server/api/team/id/pause.ts:5`

Toggle, not setter: reads the team via `teams.byId` (404 if missing), flips `paused`, writes it back via `teams.update`. Response 200: `{paused: <newValue>}`. A paused team is excluded from the tick's `teams.listUnpaused()` entirely.

- **Calls:** `teams.byId`, `teams.update` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/use-team.ts:193`

---

## `packages/backend/src/server/api/team/id/tasks.ts` (wrapper: `src/app/api/team/[id]/tasks/route.ts`)

### `GET(req, {params})` — `packages/backend/src/server/api/team/id/tasks.ts:15`

Request: `?agentId=` required (400 without). `"team"` returns every a2ax task in the team; `COFOUNDER_POV`/`USER_POV` translate to the sentinel UUIDs; otherwise the literal agent id. The tasks come from `a2ax.listTasks(teamId, isTeamOverview ? undefined : participantId)` — the participant arg filters to tasks where they are `requestorId` **or** `assigneeId` — then sorted by `updatedAt` **ascending** and sliced to the first 200 (oldest 200 if a team ever exceeds the cap). Each task is enriched with `requestorName`/`assigneeName` from a name map (team agents via `agents.byTeam` + cofounder display name via `teams.byId`/`resolveCofounderName` + `USER_DISPLAY_NAME`). Response 200: array of `{id, title, description, state, requestorId, requestorName, assigneeId, assigneeName, createdAt, updatedAt}`. Mapping is inline; no top-level helpers.

- **Calls:** identity sentinels + `resolveCofounderName` (`lib/meta-agent/identity`), `agents.byTeam`/`teams.byId` (`server/store`), `getA2AX().listTasks` (`server/a2ax`)
- **Called by:** `packages/frontend/src/components/team/agent-messages-view.tsx:239`

---

## `packages/backend/src/server/api/team/id/trace.ts` (wrapper: `src/app/api/team/[id]/trace/route.ts`)

SSE stream of play-by-play trace events (PR #12): one entry per agent step from the `traceEvents` store repo (each agent's `trace.jsonl`), written at tick time by `createTraceSink` (`server/trace.ts`). Mirrors the narration route's lifecycle (history frame on connect, then polled updates).

### `HISTORY_LIMIT` / `UPDATE_LIMIT` / `POLL_MS` / `SENT_IDS_CAP` — `packages/backend/src/server/api/team/id/trace.ts:15-18`

`200` / `200` / `2000` / `1000`: how many steps the connect-time history frame carries, the per-poll row cap, the poll interval (2 s), and the FIFO cap on the emitted-id dedupe set.

### `GET(req, {params})` — `packages/backend/src/server/api/team/id/trace.ts:20`

Request: optional `?agentId=<uuid>` (one agent's steps) and `?tickId=<uuid>` (one tick thread); both are ANDed onto the team filter (`trace.ts:27-30`). Builds a `ReadableStream`: `start` emits the newest `HISTORY_LIMIT` rows (ordered by `emittedAt` desc then `seq` desc, reversed to chronological) as `{type:"history", entries}` and records `lastSeen`; then a 2 s `setInterval` queries rows with `emittedAt >= lastSeen` — `gte`, **not** a strict `>`, plus an id-dedupe set, because several steps can share one millisecond and a strict `>` would drop same-ms stragglers that persist slightly later — filters out already-sent ids, and emits `{type:"update", entries}`. The `remember` closure (`trace.ts:40`) caps the dedupe set at `SENT_IDS_CAP` ids FIFO-style. Robustness mirrors narration: `closed` flag + `safeEnqueue`, a DB error stops the loop and closes the controller, `cancel()` clears the interval (`trace.ts:103-107`). Response 200 with the same four SSE headers as `sseHeaders()` (inlined here, `trace.ts:110-118`).

- **Calls:** `traceEvents.query` (`server/store`) — the repo reads the relevant agents' `trace.jsonl` files, filters by `teamId`/`agentId`/`tickId`/`since`, and sorts by `(emittedAt, seq)` to match the old global ordering
- **Called by:** `packages/frontend/src/components/team/trace-view.tsx:63` (fetch-based SSE reader; `packages/frontend/src/lib/trace.ts` `buildTickThreads` groups the rows into per-tick threads)

---

## `packages/backend/src/server/api/agent/id.ts` (wrapper: `src/app/api/agent/[id]/route.ts`)

Whitelisted agent update, plus the `wake` action.

### `PUBLIC_STATUSES` — `packages/backend/src/server/api/agent/id.ts:5`

`Set(["running", "paused", "errored"])`. The statuses an operator may write directly — `awaiting_approval` is reserved for the tick machinery and rejected with 400 `invalid status`.

### `PATCH(req, {params})` — `packages/backend/src/server/api/agent/id.ts:7`

Request: JSON body; whitelist `name, role, archetype, tools, scheduleSeconds, initialPrompt, status` (status validated against `PUBLIC_STATUSES` first). Special action `wake: true` sets `nextRunAt = now` and, unless a status was explicitly supplied, forces `status = "running"` so the next tick picks the agent up immediately. 400 `no valid fields` when the update set is empty. Reads the current row via `agents.byId` (404 if missing); if the agent is currently `awaiting_approval` and the request tries to wake it or change status, responds 409 — the pending approval must be resolved or rejected first (otherwise the parked conversation state and approval files would desync). Response 200: the full updated agent row (`agents.update`, second 404 guard when it returns null).

- **Calls:** `agents.byId`, `agents.update` (`server/store`)
- **Called by:** `packages/frontend/src/components/team/agent-pov-view.tsx:915`, `packages/frontend/src/components/team/agent-messages-view.tsx:301,319`

---

## `packages/backend/src/server/api/login.ts` (wrapper: `src/app/api/login/route.ts`)

The only route excluded from the proxy matcher (besides assets and the login page); the standalone host's `gate` exempts it too (`packages/backend/src/server/standalone/server.ts:83`).

### `POST(req)` — `packages/backend/src/server/api/login.ts:5`

Exchanges the shared password for the session cookie. 503 `OPERATOR_PASSWORD not configured` when the env var is unset. Parses `{password}` from the body (a malformed body degrades to `{}` via `.catch`). Compares with `constantTimeEqual` — 401 `Invalid password` on mismatch. On success sets the `OPERATOR_COOKIE` (`sh_operator`) to `sha256Hex(password)` with `HttpOnly`, `Secure` in production, `SameSite=Lax`, path `/`, max-age 30 days; responds 200 `{ok:true}`. The proxy later validates the cookie by recomputing the hash.

- **Calls:** `constantTimeEqual`, `sha256Hex`, `OPERATOR_COOKIE` (`server/operator-auth`)
- **Called by:** `src/app/(auth)/login/page.tsx:18`

---

## `packages/backend/src/server/api/seed.ts` (wrapper: `src/app/api/seed/route.ts`)

Creates the hard-coded "Simple Harmonic v0.0 Launch" demo team with a scripted message history and task board. Distinct from `scripts/seed-demo.ts` (which wipes the whole data dir first; this route is additive and idempotent-by-name).

### `TEAM_NAME` / `META_PROMPT` — `packages/backend/src/server/api/seed.ts:10,11`

`"Simple Harmonic v0.0 Launch"` and the cofounder meta-prompt (ship v0.0 by June 1 2026, 1.5k GitHub stars by month 6, MRR at month 6; "Be direct and opinionated"). `TEAM_NAME` doubles as the idempotency key.

### `AGENT_DEFS` — `packages/backend/src/server/api/seed.ts:13`

Four hard-coded agents: Scout (market research, 30 s), Relay (content & distribution, 45 s), Chisel (dev ops & shipping, 20 s), Pulse (community & feedback, 40 s). All four have only `send_message`, `broadcast`, `report_action`, each with a persona prompt.

### `POST()` — `packages/backend/src/server/api/seed.ts:52`

No body. Flow: (1) 409 `{error:"Mock team already exists", teamId}` if a team named `TEAM_NAME` exists (`teams.all().find`). (2) `teams.insert` the team — notably `paused: true` (the demo doesn't burn tokens) and `tickCount: 12` (cosmetic), `cofounderName: "Harmon"`. (3) `agents.insertMany` the four agents with `nextRunAt = now + scheduleSeconds`. (4) **Message script**: 32 scripted a2ax sends, each separated by a 50 ms `delay` helper (an inline arrow) so `createdAt` ordering is deterministic — 8 agent↔agent threads (14 directs + 2 broadcasts), 4 cofounder→agent management threads (11 directs using the `COFOUNDER_AGENT_ID` sentinel), and a human-in-the-loop block (5 directs using `USER_AGENT_ID`, including the user steering Scout directly). (5) **Task script**: 9 `a2ax.createTask` calls (6 agent-requested, 3 cofounder-requested) with `updateTaskState` transitions exercising `accepted`, `working`, and one `completed` (the README task). Response 200: `{teamId, agents, messageCount: 27, taskCount: 9}` — both counts are hard-coded; `messageCount` is stale (the script actually sends 32 direct/broadcast messages). (No `chat_sessions` record is created — conversation state lives in files under the team folder.)

- **Calls:** `COFOUNDER_AGENT_ID`/`USER_AGENT_ID` (`lib/meta-agent/identity`), `getA2AX().sendDirect`/`.broadcast`/`.createTask`/`.updateTaskState` (`server/a2ax`), `teams.insert`/`teams.all`/`agents.insertMany` (`server/store`)
- **Called by:** no in-repo caller (manual `curl`/operator invocation)

---

## `packages/backend/src/server/api/infra-report.ts` (wrapper: `src/app/api/infra-report/route.ts`)

Founder-facing feed of unacknowledged tool/infra events.

### `MAX_UNACKNOWLEDGED` — `packages/backend/src/server/api/infra-report.ts:6`

`100`. Per-level query limit and the cap on the merged result.

### `GET()` — `packages/backend/src/server/api/infra-report.ts:12`

Runs two `queryAppEvents` calls in parallel — level `infra` (with `includeInfra: true`) and level `tool` — both `unacknowledgedOnly`, then merges, sorts newest-first, and slices to 100. Response 200: `{events: [{id, level, severity, source, message, metadata, agentId, teamId, createdAt}], total, infraCount, toolCount}`. Errors → 500 `{error}`.

- **Calls:** `queryAppEvents` (`server/app-events`)
- **Called by:** `src/app/(app)/settings/platform/page.tsx:38`

### `POST(request)` — `packages/backend/src/server/api/infra-report.ts:63`

Acknowledge (dismiss) events. Request: `{eventIds: string[]}` — 400 unless a non-empty array (malformed JSON degrades to `null` via `.catch`). `appEvents.acknowledge(eventIds)` sets `acknowledgedAt = now` on every matching event. Response 200: `{ok:true, acknowledged: <count returned by the repo>}`. Errors → 500.

- **Calls:** `appEvents.acknowledge` (`server/store`)
- **Called by:** `src/app/(app)/settings/platform/page.tsx:76,102` (single-dismiss and dismiss-all)

---

## `packages/backend/src/server/api/settings/index.ts` (wrapper: `src/app/api/settings/route.ts`)

Read/write the file-backed app config (`simple-harmonic.config.json`, resolved from `process.cwd()`). When the config file is absent, reads resolve from env vars and code defaults until `setConfig` recreates it. The committed default model is `o4-mini` (`packages/backend/src/server/config.ts:33`) and the committed default data dir is `join(cwd, ".simple-harmonic", "data")` (`config.ts:34`). With no config file, `model` resolves to `OPENAI_MODEL` or that default and `dataDir` to `SH_DATA_DIR` or that default (`config.ts:76-77`).

### `GET()` — `packages/backend/src/server/api/settings/index.ts:10`

Returns 200 `getSafeConfig()` — the config with secrets masked. Since PR #16 the safe config exposes `dataDir` + `hasDataDir` (was `databaseUrl` + `hasDatabase`).

- **Calls:** `getSafeConfig` (`server/config`)
- **Called by:** `src/app/(app)/settings/page.tsx`, `settings/database/page.tsx`, `settings/model/page.tsx` (multiple sites)

### `POST(req)` — `packages/backend/src/server/api/settings/index.ts:14`

Request: JSON body. Accepts the string fields `openaiApiKey`, `openaiBaseUrl`, `model`, `dataDir`, `codingBackend` — only when present **and non-empty**, so fields can be set but never cleared through this route (`dataDir` replaced the former `databaseUrl` field). `codingConfig` is deep-merged per backend (`codex`, `claude-code`, `opencode`) over the current config. 400 `no valid fields` if nothing valid was submitted. Side effect: `setConfig(update)` persists to the JSON config file. Response 200: the new `getSafeConfig()`.

- **Calls:** `getConfig`, `setConfig`, `getSafeConfig` (`server/config`)
- **Called by:** `src/app/(app)/settings/database/page.tsx`, `settings/model/page.tsx`, `settings/coding/page.tsx`

---

## `packages/backend/src/server/api/settings/codex.ts` (wrapper: `src/app/api/settings/codex/route.ts`)

### `GET()` — `packages/backend/src/server/api/settings/codex.ts:7`

Returns 200 with the spread of `getCodexAuthStatus()` (found / hasAccessToken / email / plan / accountId / expiry info) plus `models: getCodexModels()`.

- **Calls:** `getCodexAuthStatus`, `getCodexModels` (`server/codex-auth`)
- **Called by:** `src/app/(app)/settings/model/page.tsx` (status polling)

### `POST()` — `packages/backend/src/server/api/settings/codex.ts:14`

Forces a Codex OAuth token refresh; returns 200 with whatever `refreshCodexToken()` reports (success or error object — no non-200 paths).

- **Calls:** `refreshCodexToken` (`server/codex-auth`)
- **Called by:** `src/app/(app)/settings/model/page.tsx` (refresh button)

---

## `packages/backend/src/server/api/settings/codex-login.ts` (wrapper: `src/app/api/settings/codex-login/route.ts`)

Spawns and tracks a detached `codex login` OAuth flow. The only route that launches a long-lived child process.

### `codexAuthPath()` — `packages/backend/src/server/api/settings/codex-login.ts:6`

Returns the path of the Codex auth file: `$CODEX_HOME/auth.json`, falling back to `$HOME/.codex/auth.json` (literal `~/.codex` if even `HOME` is unset).

- **Calls:** node `path.join`
- **Called by:** `POST` (`packages/backend/src/server/api/settings/codex-login.ts:47`, force re-auth branch)

### `loginProcess` / `loginStartedAt` (module state) — `packages/backend/src/server/api/settings/codex-login.ts:12-13`

`ChildProcess | null` handle of the in-flight `codex login` process and its start timestamp. Process-local (each Next.js worker has its own); used to dedupe concurrent login attempts and to kill stale processes older than 5 minutes.

### `POST(req)` — `packages/backend/src/server/api/settings/codex-login.ts:23`

Request: optional `?force=true`. Flow: (1) without `force`, short-circuit 200 `{ok:true, status:"already_authenticated"}` if `getCodexAuthStatus()` shows a usable token. (2) Kill `loginProcess` if it's older than 5 minutes; if one is still tracked, return `{ok:true, status:"already_running"}`. (3) With `force`, best-effort `unlinkSync(codexAuthPath())` so `codex login` doesn't see the existing token and short-circuit (deliberately avoids spawning `codex logout`, which can prompt interactively and hang). (4) `spawn("codex", ["login"], {stdio:["ignore","pipe","pipe"], detached:true})` — a synchronous spawn throw yields 500 `{ok:false, error:"Failed to spawn `codex` — is the codex CLI installed and on PATH?"}`. stdout/stderr are piped to the server log prefixed `[codex login]` so the operator can copy the OAuth URL if the browser doesn't auto-open. `proc.unref()` detaches it; `exit`/`error` listeners clear `loginProcess` (warning on non-zero exit). Response 200: `{ok:true, status:"started"}`. After OAuth completes, the codex CLI writes `auth.json` itself — this route never touches tokens directly.

- **Calls:** `getCodexAuthStatus` (`server/codex-auth`); node `child_process.spawn`, `fs.existsSync`/`unlinkSync`; local `codexAuthPath`
- **Called by:** `src/app/(app)/settings/model/page.tsx` (sign-in and `?force=true` re-auth buttons)

### `GET()` — `packages/backend/src/server/api/settings/codex-login.ts:103`

Poll endpoint for the login flow. Response 200: `{authenticated: <auth.json present with access token>, loginRunning: <loginProcess !== null>}`.

- **Calls:** `getCodexAuthStatus` (`server/codex-auth`); module state `loginProcess`
- **Called by:** `src/app/(app)/settings/model/page.tsx` (polled while the login flow runs)

---

## `packages/backend/src/server/api/settings/coding.ts` (wrapper: `src/app/api/settings/coding/route.ts`)

Installed-CLI and credential status for the three coding backends.

### `checkCli(name)` — `packages/backend/src/server/api/settings/coding.ts:5`

Promise-wrapped `execFile(name, ["--version"], {timeout: 5000})`. Never rejects: errors resolve `{installed:false, version:null}`; success resolves `{installed:true, version: <first line of stdout>}`.

- **Calls:** node `child_process.execFile`
- **Called by:** `GET` (`packages/backend/src/server/api/settings/coding.ts:24-28`)

### `maskSecret(s)` — `packages/backend/src/server/api/settings/coding.ts:17`

Strings of length ≤ 8 become `"••••••••"` (or `""` for empty); longer strings keep the first/last 4 chars around `••••`. (A near-duplicate with `****` lives in the connectors handler.)

- **Calls:** nothing
- **Called by:** `GET` (`packages/backend/src/server/api/settings/coding.ts:62,75,81`)

### `GET()` — `packages/backend/src/server/api/settings/coding.ts:22`

Probes `codex`, `claude`, and `opencode` CLIs in parallel via `checkCli`, reads `getCodexAuthStatus()` and the `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` env vars. Response 200: `{current: cfg.codingBackend, codingConfig, backends: {codex, "claude-code", opencode}}` where each backend has `installed`, `version`, `authenticated`, optional `account`/`plan` (codex), and a `connectors` array describing the credential source (env var or `~/.codex/auth.json`) with masked values.

- **Calls:** local `checkCli`, `maskSecret`; `getCodexAuthStatus` (`server/codex-auth`), `getConfig` (`server/config`)
- **Called by:** `src/app/(app)/settings/coding/page.tsx` (two sites)

---

## `packages/backend/src/server/api/settings/connectors.ts` (wrapper: `src/app/api/settings/connectors/route.ts`)

Built-in + file-based connector (secret) management.

### `KEY_FORMAT_ERROR` — `packages/backend/src/server/api/settings/connectors.ts:10`

Shared 400 message: "key must be uppercase letters, digits, and underscores (e.g. GITHUB_TOKEN)".

### `interface ConnectorStatus` — `packages/backend/src/server/api/settings/connectors.ts:13`

`{id, name, description, configured, maskedValue?, envVar, source: "env"|"file"}` — the shape of every entry in the GET payload.

### `maskSecret(s)` — `packages/backend/src/server/api/settings/connectors.ts:23`

Same shape as the coding handler's helper but with ASCII `****`/`********` instead of bullets.

- **Calls:** nothing
- **Called by:** `getBuiltinConnectors` (`packages/backend/src/server/api/settings/connectors.ts:60,70,79`), `GET` (`packages/backend/src/server/api/settings/connectors.ts:110`)

### `getBuiltinConnectors()` — `packages/backend/src/server/api/settings/connectors.ts:29`

Returns the five hard-coded `ConnectorStatus` entries: `SH_ENABLE_TOOLS` (the destructive-tools master switch, status from `toolsEnabled()`), `SH_TOOLS_CWD` (the jail root, value from `toolsRoot()`, always "configured"), `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (the cascade fallback key, PR #14 — its description points at `OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODELS`), and `GITHUB_TOKEN` (resolved through `resolveConnector`, so a file connector counts). The former `DATABASE_URL` builtin was dropped in PR #16 (no database to connect to).

- **Calls:** `resolveConnector` (`server/connectors`), `toolsEnabled`/`toolsRoot` (`server/tools/sandbox`); local `maskSecret`
- **Called by:** `GET` (`packages/backend/src/server/api/settings/connectors.ts:98`)

### `GET()` — `packages/backend/src/server/api/settings/connectors.ts:97`

Merges `getBuiltinConnectors()` with the file-based connector metas from `listConnectorMetas()`, skipping file connectors whose key collides with a builtin's env var, and resolving each file connector's current value via `resolveConnector` for the `configured` flag and masked value. Response 200: `{connectors: [...]}` with `source: "env" | "file"` on each entry.

- **Calls:** local `getBuiltinConnectors`, `maskSecret`; `listConnectorMetas`, `resolveConnector` (`server/connectors`)
- **Called by:** `src/app/(app)/settings/connectors/page.tsx`

### `POST(req)` — `packages/backend/src/server/api/settings/connectors.ts:121`

Request: `{name, key, value?, description?, type?}`. 400 unless `name` and `key` are present; 400 `KEY_FORMAT_ERROR` unless `isValidConnectorKey(key)`. Side effect: `saveConnector({name, key, description, type: type ?? "api_key"}, value || undefined)` — persists the meta (and the secret, when given) to the connectors file. Response 200: `{ok:true, key}`.

- **Calls:** `isValidConnectorKey` (`server/validation`), `saveConnector` (`server/connectors`)
- **Called by:** `src/app/(app)/settings/connectors/page.tsx`

### `DELETE(req)` — `packages/backend/src/server/api/settings/connectors.ts:147`

Request: `?key=` query param. 400 when missing or invalid format; 404 `Connector not found` when `deleteConnectorByKey(key)` returns false. Response 200: `{ok:true}`.

- **Calls:** `isValidConnectorKey` (`server/validation`), `deleteConnectorByKey` (`server/connectors`)
- **Called by:** `src/app/(app)/settings/connectors/page.tsx`

---

## `packages/backend/src/server/api/settings/credentials.ts` (wrapper: `src/app/api/settings/credentials/route.ts`)

### `POST(req)` — `packages/backend/src/server/api/settings/credentials.ts:8`

Endpoint for the Harmon credential-request flow (the chat route's `request_credential` event renders a card that POSTs here). Request: `{key, value}`. 400 unless `key` matches `/^[A-Z][A-Z0-9_]*$/` and `value` is a non-empty string. Side effect: `apollo.set(key, value)` — encrypts the secret into `.apollo/vault.enc` **and** writes it into `process.env` immediately, so agents can use it via `resolveConnector()` on the very next tick without a restart. Agents never see the raw value or the vault file. Response 200: `{ok:true, key}`.

- **Calls:** `apollo.set` (`server/apollo`)
- **Called by:** `packages/frontend/src/components/chat/credential-request-card.tsx`

---

## `packages/backend/src/server/api/settings/platform-status.ts` (wrapper: `src/app/api/settings/platform-status/route.ts`)

Singleton platform status (now `<dataDir>/system/platform-status.json`), surfaced into agent prompts by the tick route via `getPlatformStatus`/`formatPlatformStatusForPrompt`.

### `GET()` — `packages/backend/src/server/api/settings/platform-status.ts:7`

Returns `platformStatus.get()`, or a synthetic default `{id:1, status:"healthy", message:null, updatedAt:now}` when the status file is unset (`get()` returns null). Errors → 500 `{error}`.

- **Calls:** `platformStatus.get` (`server/store`)
- **Called by:** `src/app/(app)/settings/platform/page.tsx:39`

### `PUT(request)` — `packages/backend/src/server/api/settings/platform-status.ts:24`

Request: `{status: "healthy"|"degraded"|"maintenance", message?}` — 400 listing the valid statuses otherwise (malformed JSON degrades to `null`). `platformStatus.set({status, message})` overwrites the single status file, always refreshing `updatedAt`. Response 200: `{ok:true, status, message}`. Errors → 500.

- **Calls:** `platformStatus.set` (`server/store`)
- **Called by:** `src/app/(app)/settings/platform/page.tsx:57`

---

## `packages/backend/src/server/api/settings/skills.ts` (wrapper: `src/app/api/settings/skills/route.ts`)

Tool ("skill") catalog with per-agent usage, and per-agent tool assignment.

### `interface SkillInfo` — `packages/backend/src/server/api/settings/skills.ts:6`

`{name, description, category, risk, agentCount, agents: [{id, name, teamName}]}` — one entry per tool in the GET payload.

### `GET()` — `packages/backend/src/server/api/settings/skills.ts:15`

Builds the registry via `createAppRegistry()` (built-ins only — note: **not** `createAppRegistryWithCustomTools`, so file-based custom skills don't appear here) and lists all definitions via `registry.listForAgent()`. Loads all agents and teams (`teams.all` + per-team `agents.byTeam`, or equivalent) to compute, per tool, the agents whose `tools` array contains it; if the store read fails the catch leaves the lists empty and the route still returns tool definitions without assignments. Response 200: `{skills: SkillInfo[]}`.

- **Calls:** `createAppRegistry` (`server/tools`), `agents`/`teams` repos (`server/store`)
- **Called by:** `src/app/(app)/settings/skills/page.tsx:37` (alongside `/api/teams` at `:42`)

### `PATCH(req)` — `packages/backend/src/server/api/settings/skills.ts:53`

Replaces an agent's whole tool list. Request: `{agentId, tools: string[]}` — 400 unless both present. Validates every tool name against the registry's `listForAgent()` set; 400 `Unknown tools: ...` listing the invalid names (this also means custom file-based skills can't be assigned through this route, since the validation registry excludes them). 404 `Agent not found` when `agents.update` returns null. Response 200: `{ok:true, agent: {id, tools}}`.

- **Calls:** `createAppRegistry` (`server/tools`), `agents.update` (`server/store`)
- **Called by:** `src/app/(app)/settings/skills/page.tsx`

---

## `packages/backend/src/server/api/settings/telemetry.ts` (wrapper: `src/app/api/settings/telemetry/route.ts`)

Per-team telemetry toggle (`teams.telemetryEnabled` gates `emitAppEvent` persistence for that team).

### `GET(request)` — `packages/backend/src/server/api/settings/telemetry.ts:10`

Request: `?teamId=` required (400). 404 `Team not found` when `teams.byId` returns null. Response 200: `{teamId, telemetryEnabled}`. Errors → 500.

- **Calls:** `teams.byId` (`server/store`)
- **Called by:** no in-repo caller found (API-only surface today)

### `PUT(request)` — `packages/backend/src/server/api/settings/telemetry.ts:42`

Request: `{teamId: string, enabled: boolean}` — 400 on shape mismatch. `teams.update(teamId, {telemetryEnabled})`; 404 if it returns null. Then calls `invalidateTelemetryCache(teamId)` so the next `emitAppEvent` sees the change immediately instead of waiting out the cache TTL. Response 200: `{ok:true, teamId, telemetryEnabled}`. Errors → 500.

- **Calls:** `invalidateTelemetryCache` (`server/app-events`), `teams.update` (`server/store`)
- **Called by:** no in-repo caller found

---

## `packages/backend/src/server/api/settings/test-llm.ts` (wrapper: `src/app/api/settings/test-llm/route.ts`)

Live smoke test of the configured LLM. Since PR #14 it tests the **cascade's primary candidate** — the provider agent ticks hit first — rather than a single configured client. Always responds 200; success/failure is in the `ok` field.

### `describeError(err)` — `packages/backend/src/server/api/settings/test-llm.ts:10`

Undici hides the real network failure in `err.cause`; this walks the cause chain (max depth 4), collecting messages and `code=` fragments (so the operator sees `ECONNREFUSED`/`EAI_AGAIN`/`ETIMEDOUT` instead of the useless top-level "fetch failed"), dedupes consecutive duplicates, and joins with ` · `.

- **Calls:** nothing
- **Called by:** `testChatClient` (`packages/backend/src/server/api/settings/test-llm.ts:74`), `testCodex` (`packages/backend/src/server/api/settings/test-llm.ts:148`)

### `POST()` — `packages/backend/src/server/api/settings/test-llm.ts:37`

Resolves the cascade and takes the first candidate: `resolveLLMCandidates({timeoutMs: 10_000})[0]` (`test-llm.ts:39`, `server/llm.ts`). Provider `codex` → `testCodex(primary.model)`. Provider `openai` with no configured key (the resolver's key-less last resort) → `{ok:false, error:"No API key configured. Add an OpenAI, Anthropic, or OpenRouter key — or sign in with Codex."}` — a setup hint instead of the SDK's auth error. Anything else → `testChatClient(primary)`.

- **Calls:** `resolveLLMCandidates` (`server/llm`), `getConfig` (`server/config`); local `testCodex`, `testChatClient`
- **Called by:** `src/app/(app)/settings/model/page.tsx`

### `testChatClient(c)` — `packages/backend/src/server/api/settings/test-llm.ts:58`

Sends one chat completion ("Reply with the word OK.", `max_tokens: 10`) through the candidate's own client (`c.llm` — OpenAI-compatible for the Anthropic adapter, OpenRouter, and OpenAI alike). Success → `{ok:true, provider, model, response: <first 50 chars>}`; any throw → `{ok:false, error: describeError(err)}` (also logged with the provider name).

- **Calls:** the candidate's `llm.chat.completions.create` (`lib/meta-agent/cascade` `LLMCandidate`); local `describeError`
- **Called by:** `POST` (`packages/backend/src/server/api/settings/test-llm.ts:55`)

### `testCodex(model)` — `packages/backend/src/server/api/settings/test-llm.ts:78`

Validates the local Codex auth (`{ok:false}` with guidance when the access token or `account_id` is missing), then POSTs directly to `https://chatgpt.com/backend-api/codex/responses` through `proxyFetch`, impersonating the Codex CLI (`User-Agent: codex_cli_rs/0.0.0`, `originator: codex_cli_rs`, `ChatGPT-Account-ID` header), with a streaming Responses-API body and a 15 s `AbortSignal.timeout`. Non-OK HTTP → `{ok:false, error:"Codex API <status>: <first 200 chars>"}`. On success it hand-parses the SSE text: scans `data:` lines for a `response.output_text.done` event to extract the output text, and regexes the raw body for the actual `"model"` echoed by the API. Returns `{ok:true, model: <actual>, response: <first 50 chars or "OK">}`; throws → `{ok:false, error: describeError(err)}`.

- **Calls:** `getCodexAccessToken`, `getCodexAuthStatus` (`server/codex-auth`), `proxyFetch` (`server/proxy-fetch`); local `describeError`
- **Called by:** `POST` (`packages/backend/src/server/api/settings/test-llm.ts:42`)

---

## `packages/backend/src/server/api/settings/setup-db.ts` (wrapper: `src/app/api/settings/setup-db/route.ts`)

Initialize the JSON file store (PR #16). Formerly created a Postgres database and pushed the schema (raw `SCHEMA_SQL` DDL, `pgError` mapper, a 1-connection admin `Pool`); now it just ensures the data-dir skeleton exists and optionally persists a custom data dir. There are no migrations and no schema — the layout is created lazily. The route kept its `/api/settings/setup-db` path so the Settings UI button and the CLI keep working without churn; the npm script was renamed from `db:setup` to `data:init` (`packages/backend/src/server/standalone/setup-db-cli.ts`). No more module-level `pgError`/`SCHEMA_SQL` exports.

### `POST(req)` — `packages/backend/src/server/api/settings/setup-db.ts:14`

Request: optional `{dataDir}`. Accumulates a human-readable `steps: string[]`. Flow: if a non-empty `dataDir` string is supplied, `setConfig({dataDir})` and push `Set data directory to <dir>`; then `ensureDataDir()` (`server/store`) — creates `<dataDir>/teams/` and `<dataDir>/system/` (idempotent) — and push `Data directory ready: <dir>`. Response 200: `{ok:true, steps}`. Any throw → 200 `{ok:false, steps, error}` (failures are reported as `ok:false` with HTTP 200, like before).

- **Calls:** `setConfig` (`server/config`), `ensureDataDir` (`server/store`)
- **Called by:** `src/app/(app)/settings/database/page.tsx`; `packages/backend/src/server/standalone/setup-db-cli.ts:22` (in-process, via `data:init`)

---

## `packages/backend/src/server/api/settings/test-db.ts` (wrapper: `src/app/api/settings/test-db/route.ts`)

### `POST()` — `packages/backend/src/server/api/settings/test-db.ts:12`

Writability check for the file store (PR #16; formerly a Postgres `SELECT 1`). `ensureDataDir()` creates the skeleton, then a probe file `.write-test-<uuid>` is written with `writeFileSync` and removed with `rmSync({force:true})`. Success → 200 `{ok:true, dataDir}`; any throw → 200 `{ok:false, error}` (e.g. "Data directory not writable"). Never returns a non-200 status.

- **Calls:** `ensureDataDir` (`server/store`); node `fs.writeFileSync`/`rmSync`, `crypto.randomUUID`
- **Called by:** `src/app/(app)/settings/database/page.tsx`

---

## `packages/backend/src/server/standalone/`

Standalone `node:http` host (PR #13): serves the same 30 handler modules without Next.js. Started with `npm run dev:backend` (root `package.json` script → `tsx packages/backend/src/server/standalone/main.ts`). Parity with the Next wrapper tree is test-enforced by `packages/backend/tests/unit/standalone-routes.test.ts`: the manifest patterns must equal the `src/app/api/**` tree exactly, every manifest module must export at least one HTTP method, every wrapper must be a thin re-export whose method list matches its handler module, and no backend handler may import `next`.

### `routes.ts` — the route manifest

#### `type RouteHandler` — `packages/backend/src/server/standalone/routes.ts:44`

`(req: Request, ctx: {params: Promise<Record<string,string>>}) => Response | Promise<Response>` — the Next.js App Router route-handler contract every backend handler satisfies.

#### `interface RouteModule` — `packages/backend/src/server/standalone/routes.ts:50`

`{GET?, POST?, PUT?, PATCH?, DELETE?}`, all typed `unknown` because handler modules export per-method functions with narrower param types.

#### `interface RouteEntry` / `routes` — `packages/backend/src/server/standalone/routes.ts:58,63`

`{pattern, module}` and the manifest itself: 30 entries, one per API route, each importing its handler module via `import * as` and binding it to a `:param`-style pattern (`/api/team/:id/trace`, etc.). The header comment states the contract: when adding an API route, add it here **and** as a wrapper under `src/app/api/` — the parity test fails if the two surfaces drift.

#### `matchPath(pattern, pathname)` — `packages/backend/src/server/standalone/routes.ts:97`

Segment-wise matcher: splits both strings on `/`, requires equal segment counts, captures `:name` segments through `decodeURIComponent`, and returns the params record or `null`. Malformed percent-encoding is caught and returns `null` — a 404, not a 500 (`routes.ts:104-109`).

- **Called by:** `dispatch` (`packages/backend/src/server/standalone/server.ts:113`); unit tests in `standalone-routes.test.ts`

### `server.ts` — the node:http bridge

Bridges `node:http` to the web-standard handlers and enforces the same operator gate as `src/proxy.ts` — but for `/api/*` paths only (this host serves no pages).

#### `HTTP_METHODS` / `isHttpMethod(m)` — `packages/backend/src/server/standalone/server.ts:18,21`

`["GET","POST","PUT","PATCH","DELETE"]` and its type-guard membership check.

#### `allowHeader(module)` — `packages/backend/src/server/standalone/server.ts:26`

RFC 9110 `Allow` header for a route module: the methods it exports, plus `OPTIONS`, plus `HEAD` when `GET` exists. Used by the 405 and OPTIONS responses.

#### `toRequest(req)` — `packages/backend/src/server/standalone/server.ts:34`

Converts a node `IncomingMessage` into a web-standard `Request`: rebuilds the URL from the `host` header, copies headers (array values appended), and for non-GET/HEAD methods streams the body via `Readable.toWeb` with `duplex: "half"` (required for streamed request bodies).

#### `sendResponse(nodeRes, response)` — `packages/backend/src/server/standalone/server.ts:54`

Writes a web `Response` back to the node `ServerResponse`. `set-cookie` is carried via `getSetCookie()` (multi-value safe); the body streams through `Readable.fromWeb(...).pipe(...)`. A `close` listener destroys the source stream because `pipe()` doesn't — without it an aborted SSE response (e.g. `/api/chat`) would keep streaming from the LLM into a dead socket (`server.ts:71`).

#### `gate(req, pathname)` — `packages/backend/src/server/standalone/server.ts:79`

The operator gate, mirroring `src/proxy.ts`. Returns a `Response` to short-circuit with, or `null` to let the request through: `/api/tick*` passes (own cron auth, `server.ts:82`), `/api/login*` passes (must stay reachable, `server.ts:83`); with no `OPERATOR_PASSWORD` it fails closed 503 in production and open in dev; otherwise `isOperatorAuthorized` or 401.

- **Calls:** `isOperatorAuthorized`, `isProductionRuntime` (`server/operator-auth`)
- **Called by:** `dispatch` (`packages/backend/src/server/standalone/server.ts:109`)

#### `dispatch(request)` — `packages/backend/src/server/standalone/server.ts:97`

Request router. Non-`/api/` paths: `/` returns the unauthenticated banner `{name:"@simple-harmonic/backend", mode:"standalone"}` (no endpoint listing — the path is reachable without auth); everything else 404s. `/api/` paths run `gate`, then linear-scan the manifest with `matchPath`. On a match: `OPTIONS` → 204 with `Allow`; `HEAD` is served through the `GET` handler (mirroring Next) with the body cancelled and only status/headers returned (`server.ts:130-133`); a missing method export → 405 with `Allow`; otherwise the handler is invoked with `{params: Promise.resolve(params)}`. No pattern match → 404.

- **Calls:** local `gate`, `allowHeader`, `isHttpMethod`; `matchPath`/`routes` (`standalone/routes`)
- **Called by:** `createBackendServer` (`packages/backend/src/server/standalone/server.ts:143`)

#### `createBackendServer()` — `packages/backend/src/server/standalone/server.ts:140`

The module's only export. `createServer` wrapping `dispatch(toRequest(req))` → `sendResponse`; a throw logs and returns 500 `{error:"internal error"}` when headers haven't been sent, else destroys the socket. The caller decides the port and lifecycle.

- **Calls:** local `dispatch`, `toRequest`, `sendResponse`; node `http.createServer`
- **Called by:** `packages/backend/src/server/standalone/main.ts:47`

### `main.ts` — the standalone entrypoint

Top-level script, no exports (`npm run dev:backend`). Boot order mirrors `src/instrumentation.ts`: (1) `loadApolloSecrets()` decrypts `.apollo/vault.enc` into `process.env`; (2) `getConfig()` is logged with cwd, model, coding backend, and `dataDir` (`main.ts:32-35` — the data-dir path replaced the former `redactedDbHost(databaseUrl)` log line; there is no DB host anymore); (3) `createBackendServer().listen(port)` where `port = SH_BACKEND_PORT || PORT || 3001` (`main.ts:25`); (4) the **tick loop**: skipped with a log when `SH_TICK_LOOP === "0"` (`main.ts:43`, for external-cron setups); refused with a loud error when `isProductionRuntime()` and no `CRON_SECRET` (`main.ts:45-52` — the loop would 401 against its own server every 10 s); otherwise a `setInterval` every `TICK_INTERVAL_MS = 10_000` (`main.ts:23`) that calls the **imported** tick handler in-process — `tick(new Request("http://localhost:<port>/api/tick", {method:"POST", headers}))` with `authorization: Bearer ${CRON_SECRET}` when set (`main.ts:60-62`) — logging non-OK statuses (first 200 chars). Run from the repo root so `simple-harmonic.config.json`, `.apollo/`, and the default `.simple-harmonic/data/` resolve from `process.cwd()`. (One process per data dir — the file store is single-writer.)

- **Calls:** `POST` (`server/api/tick`), `load` (`server/apollo`), `getConfig` (`server/config`), `isProductionRuntime` (`server/operator-auth`), `createBackendServer` (`standalone/server`)
- **Called by:** `npm run dev:backend` (root `package.json:10`)

### `setup-db-cli.ts` — headless data-store bootstrap

Top-level script, no exports (`npm run data:init [-- /path/to/dir]`). Same behavior as the Settings → Storage UI button: (1) `loadApolloSecrets()` first (same boot order as `main.ts`, `setup-db-cli.ts:17`); (2) an optional `process.argv[2]` becomes the request body `{dataDir}` (then persisted to config by the handler); (3) calls the imported setup-db `POST` in-process with a synthetic `Request` (`setup-db-cli.ts:22-28`); (4) prints every `steps[]` line, then `✓ Data store ready` + exit 0 on `ok`, else the error + exit 1. The npm script was renamed from `db:setup` to `data:init` in PR #16; the file kept its `setup-db-cli.ts` name.

- **Calls:** `POST` (`server/api/settings/setup-db`), `load` (`server/apollo`)
- **Called by:** `npm run data:init` (root `package.json:11`)

---

## `scripts/seed-demo.ts`

Standalone demo seeder (`npx tsx scripts/seed-demo.ts`). Unlike `POST /api/seed`, it **wipes the data dir first** and showcases the full feature surface: recursive teams, a lead agent, output contracts on every agent, a custom skill, and a connector. Imports the backend by **relative path** (`../packages/backend/src/server/...`), not the `@simple-harmonic/backend` package alias, so it runs without a build.

### `main()` — `scripts/seed-demo.ts:20`

Phases, in order:

1. **Clear** (`scripts/seed-demo.ts:21`): one `clearStore()` call (`server/store`) — `rmSync` of both `<dataDir>/teams/` and `<dataDir>/system/` plus a location-index invalidation, wiping the entire dataset (no FK-ordered deletes anymore; there is no DB). Because `system/` is removed too, this also clears app events, platform status, the spend ledger, and trace events — unlike the old Drizzle clear, which left those four tables alone.
2. **Teams** (`scripts/seed-demo.ts:25-35`): `teams.insert` for root team "Harmonic Labs" (cofounder "Harmon"; fresh `lastUserActiveAt` so it isn't hibernated) and two sub-teams, "Engineering" and "Growth", each with `parentTeamId` set to the root (the repo nests them under the root's `teams/` folder on disk). No separate chat-session record.
3. **Engineering agents** (`scripts/seed-demo.ts:70-184`): four agents inserted into the Engineering team, every one with a JSON-Schema `outputContract` and staggered `nextRunAt` (+2 s per index): `eng-lead` (archetype `code-reviewer`; the lead agent — tools include `coding_task`, `github_api`, `spawn_sub_team`, `modify_agent`; contract requires `status` + `blockers`), `bug-hunter` (contract requires `bugs[]` with file/description/severity), `test-runner` (contract requires `passed`/`failed`), `docs-writer` (contract requires `updated[]`).
4. **Growth agents** (`scripts/seed-demo.ts:187-256`): `content-scheduler` (contract requires `posts[]`) and `research-scout` (archetype `research-summarizer`, contract requires `findings[]`), both `http_fetch`-based.
5. **Custom skill** (`scripts/seed-demo.ts:259-270`): `saveCustomToolFile` writes the flat JSON skill `.simple-harmonic/skills/httpbin_api.json` (baseUrl `https://httpbin.org`, connector `HTTPBIN_TOKEN`, custom auth header `X-Test-Auth`, methods GET/POST) — the format `createAppRegistryWithCustomTools` loads at tick time.
6. **Connector** (`scripts/seed-demo.ts:273-277`): `saveConnector` stores a `GITHUB_TOKEN` connector with the real `process.env.GITHUB_TOKEN` if present, else the placeholder `"ghp_demo_placeholder"`.
7. **Summary** (`scripts/seed-demo.ts:280-306`): re-queries all teams/agents and prints counts (agents with contracts, lead agents detected by `spawn_sub_team` in their tool list) plus an ASCII team tree, then `process.exit(0)`.

A top-level `main().catch(...)` (`scripts/seed-demo.ts:309`) logs any error and exits 1.

- **Calls:** `teams`/`agents` repos + `clearStore` (`packages/backend/src/server/store/index.js`), `saveConnector` (`packages/backend/src/server/connectors.js`), `saveCustomToolFile` (`packages/backend/src/server/custom-tools.js`)
- **Called by:** module top level (`scripts/seed-demo.ts:309`); invoked manually via `npx tsx scripts/seed-demo.ts`

---

## Python backend (FastAPI port) — symbol reference

The idiomatic Python port (`backend-py/`, 834 tests, full 43-endpoint parity) serves the **same HTTP contract** as the TS surface above, but its shape is FastAPI-native rather than the Next/standalone split: there are no thin per-route wrappers and no hand-rolled `node:http` dispatcher. Instead, `APIRouter`s grouped by domain are mounted on one app built by `create_app()` (`backend-py/simple_harmonic/app.py:110`), the operator gate is a single Starlette middleware (`OperatorGateMiddleware`, `app.py:85`) rather than `src/proxy.ts` + the standalone `gate`, and the path matcher is FastAPI's own (`{id}` path params replace the standalone manifest's `:id`). Method handlers are `async def` functions decorated `@router.get/post/...` instead of named `GET`/`POST` exports. The cutover is env-gated at the Next edge: when `PY_BACKEND_URL` is set, `next.config.ts` rewrites every `/api/*` to the Python host before the filesystem routes (`/Users/yc/dev/projects/simple-harmonic/.claude/worktrees/quirky-hertz-e7b0b3/next.config.ts:8,16-28`); unset, the TS Next routes serve unchanged.

**Naming correspondence.** TS handler exports `GET`/`POST`/`PATCH`/etc. become uniquely-named `async def`s (FastAPI needs distinct operation ids), e.g. `teams.ts` `GET` → `list_teams`, `tick.ts` `GET`/`POST` → `tick_get`/`tick_post`, `agent/[id].ts` `PATCH` → `patch_agent`. Module-level helpers go camelCase→snake_case (`maskSecret` → `_mask_secret`, `getSubTreeIds` → `_sub_tree_ids`, `applyModifyAgent` → `_apply_modify_agent`, `checkCli` → `_check_cli`, `describeError` → `_describe_error`). The operator-auth helpers keep their identities renamed (`isOperatorAuthorized` → `is_operator_authorized`, `isCronAuthorized` → `is_cron_authorized`, `constantTimeEqual` → `constant_time_equal`, `sha256Hex` → `sha256_hex`, `OPERATOR_COOKIE` unchanged). Per-route entries below list `METHOD /path` and the one-line behavior; per-route "called by" lists are omitted because the front end and cron callers are unchanged from the TS surface (they hit the same paths).

### `backend-py/simple_harmonic/app.py` — application factory + operator gate

The FastAPI equivalent of `packages/backend/src/server/server.ts` (`createBackendServer`) + `routes.ts` (the manifest) + `standalone/server.ts` (`gate`). Owns its port/lifecycle via uvicorn instead of `node:http`.

- `create_app(store=None, *, start_tick_loop=None) -> FastAPI` — `backend-py/simple_harmonic/app.py:110` — the only app constructor (TS `createBackendServer`). Builds the `FastAPI`, attaches `OperatorGateMiddleware`, and `include_router`s the six domain routers (`health`, `login`, `settings`, `teams`, `team`, `core`). Its `lifespan` calls `wire_runtime()` + `store.ensure()` on boot and, per `tick_loop_should_start()` (or an explicit `start_tick_loop`), spawns `run_tick_loop` as an asyncio task — the in-process tick loop that replaces `standalone/main.ts`'s `setInterval` and `src/instrumentation.ts`'s dev loop. Tests pass `start_tick_loop=False`.
- `app` (module-level) — `backend-py/simple_harmonic/app.py:175` — `create_app()` instance; the ASGI entry point for `uvicorn simple_harmonic.app:app`.
- `main() -> None` — `backend-py/simple_harmonic/app.py:178` — standalone entrypoint (TS `standalone/main.ts`): boots uvicorn over `simple_harmonic.app:app`; port from `SH_BACKEND_PORT` / `PORT` (default `3001`, same as the TS host). The lifespan owns apollo-load-equivalent wiring and the tick loop.
- `OperatorGateMiddleware(BaseHTTPMiddleware)` — `backend-py/simple_harmonic/app.py:85` — the single operator gate (TS `src/proxy.ts` `proxy` + standalone `gate`, unified). `dispatch` short-circuits 401 `{error:"unauthorized"}` for gated paths without a valid operator credential; 503 `OPERATOR_PASSWORD not configured` when the password is unset in production (fail-closed), pass-through in dev.
- `GATED_PREFIXES` — `backend-py/simple_harmonic/app.py:51` — operator-only path prefixes (`/api/settings`, `/api/chat`, `/api/spawn`, `/api/seed`, `/api/infra-report`, `/api/agent`). NB this is an explicit **allowlist** of gated prefixes, unlike the TS broad "everything under `/api/*` minus tick+login"; `/api/teams` + `/api/team/*` stay open.
- `OPEN_PREFIXES` — `backend-py/simple_harmonic/app.py:61` — always-open paths (`/api/tick`, `/api/login`, `/health`, `/api/teams`, `/api/team`), checked first so they shadow any gated prefix.
- `_is_gated(path) -> bool` — `backend-py/simple_harmonic/app.py:74` — open-then-gated prefix test; `_matches(path, prefix)` (`app.py:70`) does exact-or-`prefix + "/"` matching.

### `backend-py/simple_harmonic/auth.py` — operator / cron auth helpers

Port of `packages/backend/src/server/operator-auth.ts`. Same wire contract (hex-sha256 cookie, constant-time compares, Vercel-only cron-header trust) using `hashlib`/`hmac` instead of Web Crypto.

- `OPERATOR_COOKIE = "sh_operator"` — `backend-py/simple_harmonic/auth.py:26` — session cookie name (unchanged from TS).
- `is_operator_authorized(headers, password) -> bool` — `backend-py/simple_harmonic/auth.py:82` — accepts a Bearer `OPERATOR_PASSWORD` or the `sh_operator` cookie (= `sha256_hex(password)`). Called by the gate middleware.
- `is_cron_authorized(headers, cron_secret) -> bool` — `backend-py/simple_harmonic/auth.py:92` — tick auth: trusts `x-vercel-cron` only when `VERCEL` is set, else a Bearer `CRON_SECRET`; unset secret → allowed in dev, fail-closed in prod. Called by the tick route's `_run_tick_authorized`.
- `is_production_runtime() -> bool` — `backend-py/simple_harmonic/auth.py:29` — `NODE_ENV == "production"` or `VERCEL` set; the fail-closed switch.
- `sha256_hex(value) -> str` — `backend-py/simple_harmonic/auth.py:34` — SHA-256 hex digest (TS `sha256Hex`).
- `constant_time_equal(a, b) -> bool` — `backend-py/simple_harmonic/auth.py:39` — length-checked `hmac.compare_digest` (TS `constantTimeEqual`).

### `backend-py/simple_harmonic/routes/health.py` — liveness probe

- `health()` → **GET `/health`** — `backend-py/simple_harmonic/routes/health.py:19` — returns `HealthResponse(status="ok", version=__version__)`. No TS equivalent (operational liveness probe, always open).

### `backend-py/simple_harmonic/routes/login.py` — operator login

Port of `packages/backend/src/server/api/login.ts`. Public (in `OPEN_PREFIXES`); does its own password check.

- `login(request)` → **POST `/api/login`** — `backend-py/simple_harmonic/routes/login.py:40` — exchanges `OPERATOR_PASSWORD` for the `sh_operator` cookie (= `sha256_hex(password)`). 503 when unset, 401 `Invalid password` on constant-time mismatch, else 200 `{ok:true}` + the `Set-Cookie` header (Secure only in prod), byte-for-byte with `login.ts`. `_read_json` (`login.py:65`) degrades a bad body to `{}` (TS `req.json().catch(() => ({}))`).

### `backend-py/simple_harmonic/routes/teams.py` — teams list + tick

Ports `packages/backend/src/server/api/teams.ts` and the routing half of `tick.ts` (the tick body lives in `simple_harmonic/tick.py`, documented in the tick reference).

- `list_teams(store)` → **GET `/api/teams`** — `backend-py/simple_harmonic/routes/teams.py:31` — all teams newest-first (`store.list_teams()` then `.reverse()`, mirroring the TS `reverse()`). No auth, no pagination.
- `tick_get(request)` → **GET `/api/tick`** — `backend-py/simple_harmonic/routes/teams.py:47` — Vercel-cron alias; delegates to `_run_tick_authorized` (TS `GET → POST`).
- `tick_post(request)` → **POST `/api/tick`** — `backend-py/simple_harmonic/routes/teams.py:53` — the heartbeat: cron-gated, then `run_tick()`.
- `_run_tick_authorized(request)` — `backend-py/simple_harmonic/routes/teams.py:38` — shared cron gate (`is_cron_authorized`, 401 `{error:"unauthorized"}`) → `run_tick()` (`simple_harmonic/tick.py`).

### `backend-py/simple_harmonic/routes/team.py` — `team/{id}/*` endpoints

Ports `packages/backend/src/server/api/team/id/*.ts`. All open (no gate). Datetimes serialize through `json_default` / `_to_iso_z` (`store/serialize`) for byte-parity with TS `Date#toISOString()` via the `_TeamJSONResponse` (`team.py:74`).

- `get_team(id)` → **GET `/api/team/{id}`** — `backend-py/simple_harmonic/routes/team.py:109` — team detail + recursive sub-tree (`index.ts` `GET`); 404 `{error:"not found"}` on miss. Uses `_sub_tree_ids` (`team.py:93`, TS `getSubTreeIds`) for the descendant DFS.
- `patch_team(id, request)` → **PATCH `/api/team/{id}`** — `backend-py/simple_harmonic/routes/team.py:137` — whitelisted update (`name`, `metaAgentPrompt`, `cofounderName`); `index.ts` `PATCH`.
- `agent_hub(id, request)` → **GET `/api/team/{id}/agent-hub`** — `backend-py/simple_harmonic/routes/team.py:159` — one-shot agent dashboard (merged timeline); `agent-hub.ts` `GET`. `_ts_key` (`team.py:318`) keys the timeline sort.
- `list_approvals(id)` → **GET `/api/team/{id}/approvals`** — `backend-py/simple_harmonic/routes/team.py:332` — pending approval queue; `approvals.ts` `GET`.
- `resolve_approval(id, request)` → **POST `/api/team/{id}/approvals`** — `backend-py/simple_harmonic/routes/team.py:351` — resolve one approval (404/409 paths); `approvals.ts` `POST`.
- `conversations(id, request)` → **GET `/api/team/{id}/conversations`** — `backend-py/simple_harmonic/routes/team.py:384` — threaded message view from a POV; `conversations.ts` `GET`.
- `heartbeat(id)` → **POST `/api/team/{id}/heartbeat`** — `backend-py/simple_harmonic/routes/team.py:508` — anti-hibernation keepalive (`lastUserActiveAt = now`); `heartbeat.ts` `POST`.
- `list_messages(id, request)` → **GET `/api/team/{id}/messages`** — `backend-py/simple_harmonic/routes/team.py:519` — an agent's unread a2ax context; `messages.ts` `GET`.
- `send_message(id, request)` → **POST `/api/team/{id}/messages`** — `backend-py/simple_harmonic/routes/team.py:554` — send via a2ax (broadcast/group/direct, 201); `messages.ts` `POST`.
- `pause_team(id)` → **POST `/api/team/{id}/pause`** — `backend-py/simple_harmonic/routes/team.py:608` — toggle `paused`; `pause.ts` `POST`.
- `list_tasks(id, request)` → **GET `/api/team/{id}/tasks`** — `backend-py/simple_harmonic/routes/team.py:624` — a2ax task board for a POV; `tasks.ts` `GET`.
- `narration(id)` → **GET `/api/team/{id}/narration`** — `backend-py/simple_harmonic/routes/team.py:696` — SSE action-log stream (history frame + 3 s poll) via `StreamingResponse`; `narration.ts` `GET`. `_sse(data)` (`team.py:691`) formats frames.
- `trace(id, request)` → **GET `/api/team/{id}/trace`** — `backend-py/simple_harmonic/routes/team.py:756` — SSE play-by-play trace stream (`?agentId`/`?tickId` filters); `trace.ts` `GET`.

### `backend-py/simple_harmonic/routes/core.py` — top-level (non-team) endpoints

Ports the flat `packages/backend/src/server/api/*.ts` handlers (chat, spawn, seed, infra-report, agent). All gated except none — the gate middleware covers `/api/chat`, `/api/spawn`, `/api/seed`, `/api/infra-report`, `/api/agent`, so handlers do no per-handler auth.

- `chat(request)` → **POST `/api/chat`** — `backend-py/simple_harmonic/routes/core.py:189` — operator↔planner ("Harmon") SSE stream over `StreamingResponse`; `chat.ts` `POST`. Emits per-token frames then one terminal frame (`spawn`/`modify_agent`/`request_credential`/`done`). `_apply_modify_agent(result)` (`core.py:149`, TS `applyModifyAgent`) applies a `modify_agent` result; `build_planner_deps()` (`core.py:107`, TS `buildPlannerDeps`) and `_chat_frame` (`core.py:145`) support it.
- `spawn(request)` → **POST `/api/spawn`** — `backend-py/simple_harmonic/routes/core.py:331` — create a team (optionally a child) + agents, auto-adding the Harmon cofounder on root teams; `spawn.ts` `POST`.
- `seed()` → **POST `/api/seed`** — `backend-py/simple_harmonic/routes/core.py:489` — create the hard-coded demo team with scripted message/task history; `seed.ts` `POST` (additive, idempotent-by-name).
- `infra_report_get()` → **GET `/api/infra-report`** — `backend-py/simple_harmonic/routes/core.py:963` — founder feed of unacknowledged infra+tool events; `infra-report.ts` `GET`.
- `infra_report_post(request)` → **POST `/api/infra-report`** — `backend-py/simple_harmonic/routes/core.py:1013` — acknowledge (dismiss) events by id; `infra-report.ts` `POST`.
- `patch_agent(id, request)` → **PATCH `/api/agent/{id}`** — `backend-py/simple_harmonic/routes/core.py:1049` — whitelisted agent update + the `wake` action (409 while `awaiting_approval`); `agent/[id].ts` `PATCH`.

### `backend-py/simple_harmonic/routes/settings.py` — settings sub-tree

Ports the whole `packages/backend/src/server/api/settings/*.ts` tree. Mounted with `prefix="/api/settings"` (`settings.py:62`), so handler paths below are relative to that prefix. All gated (covered by the `/api/settings` gated prefix).

- `get_settings_config()` → **GET `/api/settings`** — `backend-py/simple_harmonic/routes/settings.py:94` — masked safe config; `settings/index.ts` `GET`.
- `update_settings_config(request)` → **POST `/api/settings`** — `backend-py/simple_harmonic/routes/settings.py:100` — set-but-never-clear string fields + deep-merged `codingConfig`; `settings/index.ts` `POST`.
- `get_coding(request)` → **GET `/api/settings/coding`** — `backend-py/simple_harmonic/routes/settings.py:171` — installed-CLI + credential status for the three coding backends; `settings/coding.ts` `GET`. `_check_cli` (`settings.py:134`, TS `checkCli`) and `_coding_connector` (`settings.py:159`) build it.
- `get_codex()` → **GET `/api/settings/codex`** — `backend-py/simple_harmonic/routes/settings.py:249` — Codex auth status + models; `settings/codex.ts` `GET`.
- `refresh_codex()` → **POST `/api/settings/codex`** — `backend-py/simple_harmonic/routes/settings.py:277` — force a Codex OAuth token refresh; `settings/codex.ts` `POST`.
- `get_codex_login()` → **GET `/api/settings/codex-login`** — `backend-py/simple_harmonic/routes/settings.py:308` — poll the login flow (`authenticated` / `loginRunning`); `settings/codex-login.ts` `GET`. `_codex_login_running` (`settings.py:296`) reads the in-flight handle.
- `post_codex_login(request)` → **POST `/api/settings/codex-login`** — `backend-py/simple_harmonic/routes/settings.py:330` — spawn the detached `codex login` flow (`?force=true` re-auth); `settings/codex-login.ts` `POST`. `_spawn_codex_login` (`settings.py:319`) does the `subprocess.Popen`.
- `list_connectors()` → **GET `/api/settings/connectors`** — `backend-py/simple_harmonic/routes/settings.py:482` — builtin + file connector status; `settings/connectors.ts` `GET`. `_builtin_connectors` (`settings.py:413`) and `_connector_status` (`settings.py:382`) build the entries.
- `save_connector_route(request)` → **POST `/api/settings/connectors`** — `backend-py/simple_harmonic/routes/settings.py:507` — persist a connector meta (+ optional secret); `settings/connectors.ts` `POST`.
- `delete_connector_route(request)` → **DELETE `/api/settings/connectors`** — `backend-py/simple_harmonic/routes/settings.py:535` — delete by `?key=`; `settings/connectors.ts` `DELETE`.
- `post_credentials(request)` → **POST `/api/settings/credentials`** — `backend-py/simple_harmonic/routes/settings.py:556` — Harmon credential-request flow → `apollo.set` (vault + live env); `settings/credentials.ts` `POST`.
- `get_platform_status(...)` → **GET `/api/settings/platform-status`** — `backend-py/simple_harmonic/routes/settings.py:582` — singleton platform status (synthetic default when unset); `settings/platform-status.ts` `GET`.
- `put_platform_status(...)` → **PUT `/api/settings/platform-status`** — `backend-py/simple_harmonic/routes/settings.py:596` — overwrite the single status; `settings/platform-status.ts` `PUT`.
- `setup_db(request)` → **POST `/api/settings/setup-db`** — `backend-py/simple_harmonic/routes/settings.py:621` — ensure the JSON-store data-dir skeleton (no migrations); `settings/setup-db.ts` `POST`.
- `get_skills()` → **GET `/api/settings/skills`** — `backend-py/simple_harmonic/routes/settings.py:646` — tool ("skill") catalog with per-agent usage; `settings/skills.ts` `GET`.
- `patch_skills(request)` → **PATCH `/api/settings/skills`** — `backend-py/simple_harmonic/routes/settings.py:685` — replace an agent's tool list (validated against the registry); `settings/skills.ts` `PATCH`.
- `get_telemetry(request)` → **GET `/api/settings/telemetry`** — `backend-py/simple_harmonic/routes/settings.py:714` — per-team telemetry flag; `settings/telemetry.ts` `GET`.
- `put_telemetry(request)` → **PUT `/api/settings/telemetry`** — `backend-py/simple_harmonic/routes/settings.py:731` — toggle telemetry + invalidate cache; `settings/telemetry.ts` `PUT`.
- `test_db()` → **POST `/api/settings/test-db`** — `backend-py/simple_harmonic/routes/settings.py:763` — file-store writability probe (always 200); `settings/test-db.ts` `POST`.
- `test_llm()` → **POST `/api/settings/test-llm`** — `backend-py/simple_harmonic/routes/settings.py:782` — live smoke test of the cascade's primary candidate (always 200); `settings/test-llm.ts` `POST`. Helpers: `_test_chat_client` (`settings.py:838`, TS `testChatClient`), `_test_codex` (`settings.py:863`, TS `testCodex`) + `_codex_responses_call` (`settings.py:919`), `_describe_error` (`settings.py:953`, TS `describeError`).
- Shared masking/body helpers: `_mask_secret` (`settings.py:71`, bullets, TS `maskSecret`), `_mask_secret_stars` (`settings.py:79`, ASCII `****`), `_read_json` (`settings.py:981`), `_read_json_or_none` (`settings.py:991`).
