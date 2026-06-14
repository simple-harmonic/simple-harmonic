# 06 — HTTP API: Route Handlers and the Next.js Host

The HTTP layer is split in two pieces: every route's business logic lives in transport-agnostic, web-standard handler modules under `packages/backend/src/server/api/**` (PR #13), and the Next.js app under `src/` hosts them through 30 thin re-export files under `src/app/api/` — plus a Next 16 proxy (`src/proxy.ts`) that gates every request behind a single shared operator password and an instrumentation hook (`src/instrumentation.ts`) that loads encrypted secrets and — outside Vercel — drives the agent scheduler with a self-POSTing 10-second loop. Next.js is also not the only HTTP surface: a standalone `node:http` host under `packages/backend/src/server/standalone/` serves the same 30 handlers without Next (see "The second HTTP host" below and `10-standalone-host.md`). The handlers authenticate, validate, call backend modules (the JSON file store repos, the a2ax messaging layer, the meta-agent runner, the planner), and shape JSON or SSE responses. The system's heartbeat is `POST /api/tick`, which steps every non-hibernated team's due agents concurrently under per-agent wall-clock budgets and a daily spend cap; in production a Vercel cron (`vercel.json`) hits it every minute.

## Thin Next wrappers: where the logic lives

PR #13 extracted every route body into `packages/backend/src/server/api/**`. Each `src/app/api/**/route.ts` is exactly two lines, e.g. `src/app/api/tick/route.ts`:

```ts
// Thin Next.js adapter — logic lives in @simple-harmonic/backend.
export { GET, POST } from "@simple-harmonic/backend/server/api/tick";
```

The handler modules export per-HTTP-method functions (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`) with the exact Next.js App Router signature — `(req: Request, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>` (`packages/backend/src/server/standalone/routes.ts:44-47`) — parse their own bodies via `req.json()`, and return web-standard `Response.json()` / `new Response(stream)`; they import nothing from `next`. The wrapper's import specifier resolves through the backend package's `"./*": "./src/*"` export map plus the root tsconfig path `@simple-harmonic/backend/*` → `./packages/backend/src/*`. All of this is test-enforced: `packages/backend/tests/unit/standalone-routes.test.ts` walks the real `src/app/api` tree and fails if route patterns, exported method lists, the two-line wrapper shape, or the no-`next`-imports rule drift.

Path mapping is mechanical — `src/app/api/<path>/route.ts` ↔ `packages/backend/src/server/api/<path>.ts` — with two irregularities: `[id]` segments become a literal `id` (`/api/agent/[id]` → `server/api/agent/id.ts`) and directory roots become `index.ts` (`/api/team/[id]` → `server/api/team/id/index.ts`, `/api/settings` → `server/api/settings/index.ts`).

## The second HTTP host

The same 30 handler modules are also served without Next.js by a `node:http` bridge under `packages/backend/src/server/standalone/` — `npm run dev:backend` starts it on port 3001 (`SH_BACKEND_PORT` or `PORT` overrides), loads Apollo secrets, applies the same operator gate as `src/proxy.ts` (API paths only), and runs the 10-second tick loop in-process (`SH_TICK_LOOP=0` disables it). Its route manifest (`packages/backend/src/server/standalone/routes.ts:63-94`) lists all 30 patterns and is held equal to the Next route tree by `standalone-routes.test.ts`. See `10-standalone-host.md` for the request/response bridge, the gate, the startup order, and the `npm run data:init` CLI.

## Route table

All routes require the operator session (cookie or bearer password, enforced centrally by `src/proxy.ts`) except where noted. Methods not listed for a path return Next.js's default 405 (the standalone host returns its own 405 with an `Allow` header). Each path's logic lives at the handler module given by the mapping rule above.

| Method(s) | Path | Auth | Purpose |
|---|---|---|---|
| POST, GET | `/api/tick` | CRON_SECRET bearer or `x-vercel-cron` header (exempt from proxy gate) | Run one scheduler tick: step all due/resumable agents across active teams |
| POST | `/api/chat` | operator | Operator ↔ planner ("Harmon") conversation; SSE token stream plus structured spawn/modify/credential events |
| POST | `/api/spawn` | operator | Create a team and its agents; auto-adds a Harmon cofounder agent on root teams |
| GET | `/api/teams` | operator | List all teams, newest first |
| GET, PATCH | `/api/team/[id]` | operator | Team detail (with child-team subtree) / update name, metaAgentPrompt, cofounderName |
| GET | `/api/team/[id]/agent-hub` | operator | One-round-trip agent dashboard: agents, action log, message timeline |
| GET, POST | `/api/team/[id]/approvals` | operator | List pending tool approvals / approve or reject one |
| GET | `/api/team/[id]/conversations` | operator | Threaded message view per agent/cofounder/user/team POV |
| POST | `/api/team/[id]/heartbeat` | operator | Bump `teams.lastUserActiveAt` (anti-hibernation keepalive) |
| GET, POST | `/api/team/[id]/messages` | operator | Unread-context messages for an agent / send a message via a2ax |
| GET | `/api/team/[id]/narration` | operator | SSE stream of the team's action log (history + 3s polling updates) |
| POST | `/api/team/[id]/pause` | operator | Toggle `teams.paused` |
| GET | `/api/team/[id]/tasks` | operator | List a2ax tasks for a participant or the whole team |
| GET | `/api/team/[id]/trace` | operator | SSE stream of play-by-play agent trace events (history + 2 s polling; `?agentId=`/`?tickId=` filters; PR #12) |
| PATCH | `/api/agent/[id]` | operator | Update agent fields; `wake: true` schedules an immediate run |
| POST | `/api/login` | public (excluded from proxy matcher) | Exchange `OPERATOR_PASSWORD` for the `sh_operator` cookie |
| POST | `/api/seed` | operator | Create the hard-coded demo team with seeded messages and tasks |
| GET, POST | `/api/infra-report` | operator | List unacknowledged tool/infra events / acknowledge by id |
| GET, POST | `/api/settings` | operator | Read masked app config / write fields to `simple-harmonic.config.json` |
| GET, POST | `/api/settings/codex` | operator | Codex auth status + model list / refresh the Codex OAuth token |
| GET, POST | `/api/settings/codex-login` | operator | Poll login state / spawn a detached `codex login` OAuth flow |
| GET | `/api/settings/coding` | operator | Installed-CLI and credential status for codex / claude-code / opencode backends |
| GET, POST, DELETE | `/api/settings/connectors` | operator | List built-in + file connectors / save / delete a connector |
| POST | `/api/settings/credentials` | operator | Store a secret in the encrypted Apollo vault and `process.env` |
| GET, PUT | `/api/settings/platform-status` | operator | Read / upsert the singleton platform-status row |
| GET, PATCH | `/api/settings/skills` | operator | List tool definitions with per-agent usage / replace an agent's tool list |
| GET, PUT | `/api/settings/telemetry` | operator | Read / toggle per-team telemetry |
| POST | `/api/settings/test-llm` | operator | Live smoke test of the cascade's primary LLM provider |
| POST | `/api/settings/setup-db` | operator | Ensure the JSON file-store data directory exists (see data-model doc; `packages/backend/src/server/api/settings/setup-db.ts:14`) |
| POST | `/api/settings/test-db` | operator | Writable-probe of the configured data directory (see data-model doc; `packages/backend/src/server/api/settings/test-db.ts:10`) |

## Authentication: the proxy gate and operator auth

`src/proxy.ts` is the Next 16 proxy (the renamed middleware convention; see the comment at `src/proxy.ts:15`). Its `matcher` (`src/proxy.ts:54-58`) applies it to everything except `_next/static`, `_next/image`, `favicon.ico`, `login` (the page), and `api/login`. Within the matched set, `proxy()` (`src/proxy.ts:18`):

1. Short-circuits `/api/tick` and `/api/tick/*` with `NextResponse.next()` (`src/proxy.ts:23-25`) — the tick route enforces its own cron auth, since cron callers carry no operator cookie.
2. Reads `process.env.OPERATOR_PASSWORD`. If unset: returns 503 (`{"error": "OPERATOR_PASSWORD not configured"}` for API paths, plain text for pages) when `isProductionRuntime()` is true, otherwise allows everything — local dev works with zero config (`src/proxy.ts:30-37`).
3. Calls `isOperatorAuthorized(req, password)`. Authorized requests pass through; unauthorized API requests get a JSON 401; unauthorized page requests are redirected to `/login` (`src/proxy.ts:40-51`).

The auth helpers live in `packages/backend/src/server/operator-auth.ts` and are deliberately edge-safe (Web Crypto only, no node imports):

- `isOperatorAuthorized` (`operator-auth.ts:59-68`) accepts either `Authorization: Bearer <OPERATOR_PASSWORD>` (for curl/scripts) or the `sh_operator` cookie whose value must equal `sha256Hex(password)`. Both comparisons use `constantTimeEqual` (`operator-auth.ts:32-39`), a length-checked constant-time string compare.
- `isCronAuthorized` (`operator-auth.ts:76-89`) trusts the `x-vercel-cron` header only when `process.env.VERCEL` is set (`operator-auth.ts:83`) — on Vercel the edge strips client-supplied copies, but on the standalone host the header would be trivially spoofable, so PR #13 closed that hole. Otherwise, if `CRON_SECRET` is set, it requires `Authorization: Bearer <CRON_SECRET>`; if `CRON_SECRET` is unset it allows in dev and fails closed in production.
- `isProductionRuntime` (`operator-auth.ts:18-20`) is `NODE_ENV === "production" || !!process.env.VERCEL`.

`POST /api/login` (`packages/backend/src/server/api/login.ts:5`) is the only public route. It returns 503 if `OPERATOR_PASSWORD` is unset, 401 on a wrong password (constant-time compare), and on success sets the `sh_operator` cookie to `sha256Hex(password)` — httpOnly, `secure` in production, `sameSite: lax`, path `/`, 30-day max age (`login.ts:18-23`). There is no per-user identity: one shared password, one cookie value derived from it.

## Server startup: `src/instrumentation.ts`

`register()` (`src/instrumentation.ts:9`) runs once on server boot when `NEXT_RUNTIME === "nodejs"`:

1. **Apollo secret load.** Dynamically imports `@simple-harmonic/backend/server/apollo` and calls `apollo.load()`, which decrypts `.apollo/vault.enc` (AES-256-GCM) into `process.env` without overwriting existing vars, logging the count loaded (`src/instrumentation.ts:13-17`). This must run before anything reads env vars.
2. **Dev tick loop.** If `process.env.VERCEL` is not set, a `setInterval` fires every 10 000 ms and POSTs `http://localhost:${PORT||3000}/api/tick`, attaching `Authorization: Bearer ${CRON_SECRET}` when `CRON_SECRET` is set; failures are silently swallowed and retried next interval (`src/instrumentation.ts:19-38`). On Vercel this loop is skipped and the platform cron is the only driver.

The standalone host's entrypoint (`packages/backend/src/server/standalone/main.ts`) mirrors this startup — Apollo load, then a 10-second tick loop that calls the tick handler in-process; see `10-standalone-host.md`.

## The tick: `POST /api/tick` (`packages/backend/src/server/api/tick.ts`)

This is the scheduler heart. Line refs in this section are to the handler `packages/backend/src/server/api/tick.ts` (700 lines), which PR #12 (trace + engine mode), PR #14 (LLM cascade), and PR #16 (JSON file store) reworked after PR #13 extracted it; the Next route `src/app/api/tick/route.ts` is its two-line wrapper. `GET` simply delegates to `POST` because Vercel cron sends GET (`tick.ts:697-700`). One tick proceeds as follows.

### 1. Authorization

`isCronAuthorized(req, process.env.CRON_SECRET)` or 401 (`tick.ts:113-115`). The proxy already exempted this path (and the `x-vercel-cron` shortcut only counts when running on Vercel — see the auth section).

### 2. Trace retention sweep and crash recovery

`pruneTraceEvents()` is kicked off fire-and-forget (`tick.ts:120`) to delete play-by-play trace rows older than `SH_TRACE_RETENTION_DAYS` days (default 14); it self-throttles to one sweep per hour (`packages/backend/src/server/trace.ts:155-175`). Then a module-level `didResetInFlight` flag (`tick.ts:43`, `122-129`) guards a one-time `agents.resetAllInFlight()` (`packages/backend/src/server/store/repos/agents.ts:156`), which walks every agent folder and rewrites any `agent.json` whose `inFlight` is still `true` back to `false`. This unjams agents left claimed by a previous process crash. If the reset throws, the flag is cleared so the next tick retries.

### 3. Team selection and hibernation

All unpaused teams are loaded (`teams.listUnpaused`, `tick.ts:131`), then filtered by the hibernation rule (`tick.ts:131-137`): a team only ticks if `lastUserActiveAt` exists and is within `HIBERNATE_THRESHOLD_MS` = 5 minutes (`tick.ts:40`). A team with a null `lastUserActiveAt` is treated as hibernated. The UI keeps teams awake via `POST /api/team/[id]/heartbeat`; resolving an approval also bumps the timestamp.

### 4. LLM resolution: the provider cascade

At `tick.ts:145-164` the old pick-one-provider `if/else` is gone (PR #14). The handler calls `resolveLLM({ onFallback })` (`tick.ts:146`) from `packages/backend/src/server/llm.ts:125`, which composes every configured provider into a single cascading `LLMClient`:

- **Order:** Codex CLI > Anthropic > OpenRouter > OpenAI (`llm.ts:47-114`). Codex joins when `getApiKeySource()` (`packages/backend/src/server/config.ts:98`) is `"codex"` (model `cfg.model || "gpt-5.5"`); Anthropic when `ANTHROPIC_API_KEY` is set (model `ANTHROPIC_MODEL` or `claude-sonnet-4-20250514` — no longer hard-coded in the tick); OpenRouter when `OPENROUTER_API_KEY` is set (one cascade step per model in `OPENROUTER_MODEL` + `OPENROUTER_FALLBACK_MODELS`); OpenAI when the key source is `config`/`env`, deliberately skipped under the codex source. With nothing configured, a key-less OpenAI client is still returned so a clear auth error surfaces on first call.
- **Fallback:** any error from one candidate falls through to the next (only an aborted run's error rethrows immediately); each failure fires the tick's `onFallback` callback (`tick.ts:147-156`), which emits a warning app event — `LLM <provider>/<model> failed (…); falling back to <next>` or `…; cascade exhausted`.
- **`modelOverride`** is the head candidate's model; on success the cascade stamps the serving model onto the response so spend records attribute fallback calls correctly (`packages/backend/src/lib/meta-agent/cascade.ts:51-54`).

One cascade client is built per tick and shared across all teams/agents. Immediately after, the engine-mode gate is computed: `useCodexHarness = apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec"` (`tick.ts:164`) — when true, fresh codex-provider runs go through `runCodexAgentTick` (the codex app-server harness, PR #12) instead of `runAgent`, and the cascade client only serves legacy message-based suspensions. Runner-path runs wrap the client in `makeCountingLLM` (`packages/backend/src/server/spend.ts:128`) to accumulate per-run token usage; harness runs instead report real usage summed from codex's `thread/tokenUsage/updated` notifications (`tick.ts:416`, `531`).

### 5. Daily spend cap

`checkSpendAllowed(now)` (`tick.ts:171`, impl `spend.ts:80`) sums today's (UTC) `costCents` across the entries in the global spend ledger `system/spend.jsonl` (read through the `spend` store repo) against `SH_DAILY_SPEND_CAP_CENTS` (default 5000 = $50, `spend.ts:42`). Three outcomes:

- **Ledger unreadable** (e.g. the data dir is missing or unreadable): the cap **fails open** — a warning app-event is emitted and the tick proceeds (`tick.ts:172-177`).
- **Cap reached**: an error app-event is emitted and the tick returns early with `{ ok: true, agentsRan: 0, skipped: "spend_cap", spentCents, capCents, timestamp }` (`tick.ts:178-191`).
- **Under cap**: proceed.

### 6. Per-team loop (`tick.ts:194-258`)

For each active team, in sequence:

1. **Registry rebuild.** `createAppRegistryWithCustomTools()` (`packages/backend/src/server/tools/index.ts:68`) is called per team (`tick.ts:195`) so custom tools defined as flat JSON files under `.simple-harmonic/skills/<name>.json` are picked up fresh each tick (loader `packages/backend/src/server/custom-tools.ts:39-59`; see the tool-system doc).
2. **Load all agents** of the team — used both for scheduling and to build the peer roster (`buildPeers`, `tick.ts:267-271`, gives each agent its teammates' id/name/role).
3. **Auto-recover errored agents** (`tick.ts:200-207`): every agent with `status = "errored"` is flipped back to `running`, `inFlight = false` (via `agents.update`, plus the in-memory row), so it is retried on this very tick (its `nextRunAt` was advanced when it failed).
4. **Resume pass** (`tick.ts:216-234`): every agent with `status = "awaiting_approval"` goes through `tryResumeAgent`, all in parallel via `Promise.allSettled`.
5. **Fresh pass** (`tick.ts:236-255`): agents passing `approveAgentTick(team, agent, now)` go through `runFreshAgent`, also in parallel via `Promise.allSettled`. The gate (`packages/backend/src/lib/meta-agent/approval.ts:53-100`) is pure and rejects when the team is paused, the agent is paused/errored/awaiting_approval, the agent is `inFlight`, or `nextRunAt` is null/in the future. Because `awaiting_approval` is rejected, a parked agent can never enter the fresh pass; the two passes are sequential so a resuming agent settles before fresh scheduling is evaluated.
6. **Tick counter.** `teams.tickCount` is incremented once per team per tick via `teams.incrementTickCount` (`tick.ts:257`, impl `store/repos/teams.ts:107`) — a synchronous read-modify-write of the team's `team.json`.

Within a pass, agents run **concurrently**; each is a distinct on-disk agent folder with an independent a2ax context, and each run is independently time-bounded, so one slow agent cannot delay its teammates. `Promise.allSettled` plus per-run try/catch means one agent's failure never aborts the pass; `countRan` (`tick.ts:273-280`) tallies only fulfilled `true` results into the response's `agentsRan`. (Note: because the file store is single-writer and its writes are synchronous, the concurrency here is cooperative — runs interleave only at `await` boundaries, e.g. LLM calls; a store mutation runs to completion before any other run resumes.)

### 7. A fresh agent run: `runFreshAgent` (`tick.ts:356-443`)

1. **Claim** via `agents.claim(agent.id, "running")` (`tick.ts:359`, impl `store/repos/agents.ts:144-153`): a race-free synchronous read-then-conditional-write — it reads `agent.json`, returns `false` if `inFlight === true` or `status !== "running"`, otherwise sets `inFlight = true` and writes the file. `false` means another concurrent run already owns the agent and this run silently bails. This is the concurrency lock (the file-store analogue of the old SQL compare-and-set).
2. **Trace sink.** A `PersistentTraceSink` is created for the run (`createTraceSink({ teamId, agentId })`, `tick.ts:362`); its `emit` is handed to the runner/harness so every step of the run is appended to the agent's `trace.jsonl`, and it is flushed in a `finally` (`tick.ts:441`).
3. **Context gathering**, all in parallel: the agent's unread a2ax context (`a2ax.getAgentContext`), the last 10 action-log entries (read from the agent's `actions.jsonl` via the `actionLog` repo) formatted as timestamped one-liners (`fetchRecentHistory`, summarized by `summarizePayload`), the last 5 output-contract validation results if the agent has an `outputContract` (`fetchRecentValidations`, rendered as `PASS`/`FAIL: path: message` lines), the team's app events from the past hour (limit 10, infra excluded), and the platform status. Events + status are joined into `appHealthContext`.
4. **Run.** A `shared` config is built with the agent's name/archetype/tools/prompt, the gathered context, team goal, output contract, peers, the tool registry and its `isDestructive` classifier, and `trace: trace.emit`. The run then branches (`tick.ts:409`): in engine mode, `runCodexAgentTick({ ...shared, signal })`; otherwise `runAgent` with a `makeCountingLLM`-wrapped cascade client. Either way it is wrapped in `withTimeout`; the timeout (`SH_AGENT_TIMEOUT_MS`, default 120 000 ms) creates an `AbortController`, aborts the run's signal on expiry so provider adapters cancel in-flight work, and rejects with `AgentTimeoutError`.
5. **Post-run**: mark the consumed a2ax messages read (`tick.ts:427`), apply the result via `handleRunResult` (carrying the sink's `traceTickId`, `tick.ts:428`), and append an entry to the spend ledger via `recordSpend` (best-effort; `tick.ts:429`, impl `spend.ts:91`, appending to `system/spend.jsonl`) — engine-mode runs record codex's real summed token usage, which the old exec adapter always reported as zero.
6. **On any failure** (including timeout): `failAgent` (`tick.ts:581`) emits a terminal `tick_failed` trace step, logs to console, emits a persistent error app-event (queryable by agents via the `observe_app` tool), fire-and-forget broadcasts a `[SYSTEM] Agent X errored…` message to the team via a2ax so peers see it on their next tick, then sets the agent to `errored`, `inFlight = false`, clears `conversationState`, and advances `nextRunAt` by `scheduleSeconds` — so a failing agent cannot tight-loop the tick.

### 8. Applying a result: `handleRunResult`

The result is a structural `RunOutcome` satisfied by both `runAgent` and `runCodexAgentTick`; the suspension — a runner `AgentSuspension` or an engine-mode `CodexThreadSuspension` — is persisted opaquely as the agent's `conversationState`.

- **Suspension** (the run hit a destructive tool needing human sign-off): the agent is parked — `agents.update` sets `status = "awaiting_approval"`, `inFlight = false`, and the serialized suspension into `conversationState` with the sink's `traceTickId` riding along as an extra key; `approvals.insertMany` writes one record per pending tool call (`toolCallId`, `toolName`, `toolArguments`) into the agent's `approvals.json`; and an `awaiting_approval` entry is appended to `actions.jsonl` so the narration feed shows the pause. These are **sequential synchronous writes, not a single atomic transaction** — each individual file write is atomic (temp + rename), and the resume path tolerates a half-written park (see below). **`nextRunAt` is deliberately not advanced** — scheduling resumes only after the human decides.
- **Normal completion**: an entry is appended to `actions.jsonl` (`actionType`, `payload`, with `validation` merged into the payload when the run validated an output contract), then the agent is returned to `running` with `conversationState` cleared and `nextRunAt = now + scheduleSeconds`.

### 9. Resuming a parked agent: `tryResumeAgent` (`tick.ts:450-567`)

1. If `conversationState` is null while status is `awaiting_approval` (incomplete parking write), the handler self-heals: `approvals.clearForAgent` removes the agent's approval records and `agents.update` resets it to `running` (`tick.ts:462`).
2. It loads the agent's approval records (`approvals.byAgent`) and matches them against the suspension's expected tool-call ids. **Fewer records than expected → hold** (the parking write was incomplete; a missing human decision is never treated as rejection). **Any record still `pending` → hold** (`tick.ts:471-479`). Holding returns `false` without claiming the agent.
3. Once every expected approval is resolved, the decisions array is built (`approved` iff the record's status is `approved`, carrying the optional `decisionNote`, `tick.ts:482`) and the agent is claimed via `agents.claim(agent.id, "awaiting_approval")` (`tick.ts:491`, the same race-free read-then-conditional-write, requiring `status = "awaiting_approval"`). The trace sink is recreated with the tickId that was parked alongside the suspension (`extractTraceTickId`, `tick.ts:571`, UUID-validated) so suspend and resume read as one play-by-play thread. The resume itself branches on the **suspension shape, not the engine-mode flag** (`tick.ts:455`): `isCodexThreadSuspension(suspension)` → `runCodexAgentTick` resumes the persistent codex thread with the decisions; a legacy message-based suspension (pre-harness, or parked under `SH_CODEX_RUNTIME=exec`) → `runAgent` with `resume: { suspension, decisions }` and the counting cascade client. Both run under the same timeout, and the resume path passes only `recentHistory` as context — no a2ax context, team goal, contract, or health context are re-gathered.
4. On success, the consumed approval records are cleared (`approvals.clearForAgent`, `tick.ts:550`, so they cannot contaminate a future suspension), then `handleRunResult` + `recordSpend` run as in the fresh path. On failure, the records are cleared as well (`tick.ts:561`) and `failAgent` runs with phase `"resume"`.

### 10. Response

`{ ok: true, agentsRan: <count>, timestamp: <ISO> }` (`tick.ts:260`).

The behavior above is pinned by `packages/backend/tests/unit/api-tick.test.ts` (1072 lines, importing `@/server/api/tick`), whose suites cover: empty-team no-ops, errored-agent auto-recovery, action logging, error transitions, tickCount increment, approval gating, peer-list construction, a2ax read-marking, multi-team ticks, 401-in-production / `x-vercel-cron` acceptance / spend-cap skip, suspend-park-resume with rejection notes, per-agent timeout, intra-team concurrency and failure isolation, LLM client selection (codex source → harness run, with `SH_CODEX_RUNTIME=exec` opting out; Anthropic; OpenAI fallback), GET-delegates-to-POST — plus two suites added by PR #12: "play-by-play trace" and "codex app-server harness" (harness selection, codex-thread suspension parking/resume, legacy-suspension fallback to `runAgent`).

## The chat route: `POST /api/chat` (`packages/backend/src/server/api/chat.ts`)

This is the operator's conversation with the planner (the "Harmon" onboarding/management chat) — it does not talk to tick-driven agents directly; it can create or modify them.

- **Request:** `{ messages: PlannerMessage[] }`. Missing/empty/non-array → 400 (`chat.ts:46-48`).
- **Response:** an SSE stream (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; `chat.ts:128-134`). The handler calls `plannerStream(messages, onToken, buildPlannerDeps())` (`chat.ts:54-62`); `buildPlannerDeps` (`packages/backend/src/server/planner-deps.ts:11`) wires the planner to the app config, the API-key source, the Codex token/account id, and `proxyFetch`. Every model token is forwarded immediately as `data: {"type":"token","text":...}`.
- **Terminal events**, one per request:
  - `spawn` — the planner decided to create a team: `{ type, agents, teamName, parentTeam|null, cofounderName|null, content }` (`chat.ts:64-76`). The route does **not** create the team; the client is expected to follow up with `POST /api/spawn`.
  - `modify_agent` — the planner edited an existing agent: the route applies it server-side via `applyModifyAgent` (`chat.ts:9-41`), which resolves team by name then agent by name and updates whichever of `tools`, `initial_prompt → initialPrompt`, `schedule_seconds → scheduleSeconds`, `role`, `status`, `output_contract → outputContract` were provided (no-op set → `{ok:false}`). The event carries `{ agentName, teamName, updates, applied: {ok, error?}, content }`.
  - `request_credential` — `{ key, label, reason, helpUrl|null, content }`; the client is expected to collect the secret and POST it to `/api/settings/credentials`.
  - `done` — plain message result: `{ type: "done", content }`.
  - `error` — on a thrown planner error: an infra-level app-event is emitted and `{ type: "error", message }` is streamed (`chat.ts:111-121`). The stream always closes in `finally`.

`api-chat.test.ts` confirms the 400 contracts, token-then-done ordering, the spawn event shape (including `cofounderName: null` passthrough), and error-event fallbacks.

## Team and agent routes

### `POST /api/spawn` (`packages/backend/src/server/api/spawn.ts:53`)

Body: `{ agents: [{ name, role, archetype, tools, schedule_seconds, initial_prompt }], teamName?, parentTeam?, parentTeamId?, cofounderName?, goal?, noHarmon? }`. Empty/missing `agents` → 400. Parent team is resolved by id, else by name (unknown name → 400, `spawn.ts:71-73`; a supplied `parentTeamId` is trusted as-is and written unvalidated, so — there being no foreign keys in the file store — an unknown id silently yields a team whose parent pointer dangles rather than a 400). The team name falls back to the joined archetypes truncated to 50 chars (`spawn.ts:78-83`). Side effects: `teams.insert` writes one `team.json` (with `parentTeamId`, `cofounderName` defaulting to "Harmon", trimmed `goal`; `spawn.ts:88`) and `agents.insertMany` writes one `agent.json` per definition with staggered `nextRunAt = now + schedule_seconds + i*2000ms` (`spawn.ts:95-104`, `119`) — there is no separate chat-session record anymore. On **root** teams (no parent) and unless `noHarmon`, a cofounder agent is auto-appended (`spawn.ts:106-118`): name = lowercased/hyphenated cofounder name, archetype `meta-agent`, the 10 management tools in `HARMON_TOOLS` (`spawn.ts:4-15`), a 3600 s schedule, and the management prompt `HARMON_PROMPT` (`spawn.ts:17-32`) that instructs it to review team history, validation results, and restructure via `modify_agent`/`spawn_sub_team`/`modify_team`/`set_team_goal`. Returns `{ teamId, parentTeamId }`.

### `GET /api/teams` (`packages/backend/src/server/api/teams.ts:5`)

Returns all team rows ordered by `createdAt` desc. No parameters.

### `GET /api/team/[id]` (`packages/backend/src/server/api/team/id/index.ts:5`)

404 if the team doesn't exist. Returns `{ team, agents, childTeams, childAgents }`, where the child sets come from a full-table walk of the parent-pointer tree (`getSubTreeIds`, `index.ts:38-58`) excluding the root itself.

### `PATCH /api/team/[id]` (`packages/backend/src/server/api/team/id/index.ts:60`)

Accepts only `name`, `metaAgentPrompt`, `cofounderName`; no recognized field → 400, unknown id → 404. Returns the updated row. (Pausing has its own route; `goal` is only settable at spawn time or by agent tools.)

### `GET /api/team/[id]/agent-hub?agentId=` (`packages/backend/src/server/api/team/id/agent-hub.ts:14`)

Missing `agentId` → 400. Issues four reads in parallel via `Promise.all` (`agent-hub.ts:24-29`): `agents.byTeam(teamId)` and `teams.byId(teamId)` (store repos), `actionLog.recentByAgent(agentId, 100)` (the agent's last 100 `actions.jsonl` entries), and `a2ax.listMessages(teamId, 200)` (the team's 200 messages through the a2ax protocol). The sentinel ids `COFOUNDER_AGENT_ID` (`…c0f0`) and `USER_AGENT_ID` (`…fffe`) from `packages/backend/src/lib/meta-agent/identity.ts` are handled as virtual participants; a real `agentId` not in the team → 404. The response merges actions, received messages (broadcasts, or channels containing the agent id), and — for cofounder/user POVs — sent messages into a timestamp-sorted `timeline` whose entries are discriminated by `type`: `"action"` (`actionType`, `payload`), `"received"` (`fromName`, `content`, `kind`, `channelType`), or `"sent"` (`toName`, `content`, `kind`, `channelType`, id prefixed `sent-`), each with `id` and `timestamp`. The top level echoes `agentId` plus header fields (`agentName`, `agentRole`, `agentStatus`, `agentSchedule`, `nextRunAt`, `inFlight`), with role/status hard-coded for the two sentinels (`agent-hub.ts:147-152`).

### `GET /api/team/[id]/approvals` (`packages/backend/src/server/api/team/id/approvals.ts:7`)

Returns `{ approvals: [{ id, agentId, toolName, toolArguments, createdAt }] }` for rows with `status = 'pending'` in this team.

### `POST /api/team/[id]/approvals` (`packages/backend/src/server/api/team/id/approvals.ts:30`)

Body `{ approvalId, decision: "approved"|"rejected", note? }`; invalid → 400, not found in this team → 404, already resolved → 409. The resolve (`approvals.resolve`, `approvals.ts:42`; impl `store/repos/approvals.ts:81-98`) is a guarded read-modify-write that flips the record only while it is still `pending` — returning `not_found` (→404) or `already` (→409) otherwise — so a concurrent double-resolve also yields 409 (`approvals.ts:44-46`). Side effects: sets `status`, `decisionNote`, `resolvedAt` in the agent's `approvals.json`; clears the agent's `inFlight` so the resume pass re-checks it promptly (it does **not** change agent status — the tick route owns the parked→running transition); bumps `teams.lastUserActiveAt` so the team won't hibernate before the resume happens (`approvals.ts:52-53`). Returns `{ ok: true, decision }`.

### `GET /api/team/[id]/conversations?agentId=` (`packages/backend/src/server/api/team/id/conversations.ts:15`)

Missing `agentId` → 400. `agentId` may be a real agent UUID, `"team"` (all messages), `"cofounder"`, or `"user"` — the latter two POV strings are translated to the sentinel UUIDs (`conversations.ts:33-34`). Loads up to 1000 team messages via `a2ax.listMessages(teamId, 1000)`, filters to those involving the participant (broadcasts and anything the participant sent always included; direct/group/task channels matched by `channelId.includes(participantId)` — the sender match is what surfaces `task:` threads, whose channel ids contain no participant ids), resolves task-channel titles from `a2ax.listTasks(teamId)` (`conversations.ts:52`), groups messages into threads keyed by `channelId` with computed peer names (`A ↔ B` for direct threads in team overview), and returns `{ agentId, agentName, threads }` sorted by most recent message.

### `POST /api/team/[id]/heartbeat` (`packages/backend/src/server/api/team/id/heartbeat.ts:5`)

No body. Sets `teams.lastUserActiveAt = now` and returns `{ ok: true }`. This is what keeps a team out of tick hibernation while an operator is watching.

### `GET /api/team/[id]/messages?agentId=` (`packages/backend/src/server/api/team/id/messages.ts:13`)

Missing `agentId` → 400. Returns the agent's current a2ax context messages (`a2ax.getAgentContext`) enriched with sender display names — i.e. what the agent itself would see next tick.

### `POST /api/team/[id]/messages` (`packages/backend/src/server/api/team/id/messages.ts:49`)

Body `{ fromAgentId, toAgentId?, content, channelType?, channelId? }`; `fromAgentId` and `content` required → otherwise 400. The POV sentinels `"cofounder"`/`"user"` in either id are translated to their UUIDs (`messages.ts:71-80`). Routing: `channelType "broadcast"` → `a2ax.broadcast`; `"group"` (requires `channelId`, else 400) → `a2ax.sendToGroup`; anything else is a direct message (requires `toAgentId`, else 400) → `a2ax.sendDirect`. Returns the created message with status 201. This is how operator messages reach agents: the message lands in the a2ax store and the recipient picks it up as unread context on its next tick.

### `GET /api/team/[id]/narration` (`packages/backend/src/server/api/team/id/narration.ts:8`)

SSE stream of the team's action log. If the team has no agents it returns a single non-streaming `history` event with empty entries (`narration.ts:13-16`). Otherwise: one `data: {type:"history", entries:[…last 50, chronological]}` event on connect, then a 3-second `setInterval` polls for entries newer than the last seen timestamp and emits `{type:"update", entries:[…chronological]}` (limit 20 per poll). The stream guards against enqueue-after-close races, stops polling on client `cancel()`, and shuts itself down on a store read error (`narration.ts:29-78`). Headers include `X-Accel-Buffering: no` to defeat proxy buffering (`sseHeaders`, `narration.ts:86-94`). Note this is the only narration transport — "SSE" here is store polling re-published over a held-open response.

### `POST /api/team/[id]/pause` (`packages/backend/src/server/api/team/id/pause.ts:5`)

404 if the team doesn't exist; otherwise flips `teams.paused` and returns `{ paused: <new value> }`.

### `GET /api/team/[id]/tasks?agentId=` (`packages/backend/src/server/api/team/id/tasks.ts:15`)

Missing `agentId` → 400. `"team"` returns all team tasks; otherwise tasks where the (POV-translated) participant is requestor or assignee. Limit 200, ordered by `updatedAt` ascending. Each task is enriched with requestor/assignee display names.

### `GET /api/team/[id]/trace` (`packages/backend/src/server/api/team/id/trace.ts:20`)

Added by PR #12. An SSE stream of the team's play-by-play agent trace events (the per-step telemetry emitted by the runner and the codex harness — `tick_started`, `llm_request`/`llm_response`, `tool_started`/`tool_finished`, approval/decision steps, `tick_finished`/`tick_failed`). Optional query params narrow the stream: `?agentId=<uuid>` to one agent, `?tickId=<uuid>` to one tick thread (`trace.ts:21-22`). Lifecycle mirrors the narration route: on connect it emits `data: {type:"history", entries:[…]}` with the newest `HISTORY_LIMIT` = 200 rows reversed to chronological order, then a 2-second `setInterval` emits `{type:"update", entries:[…]}` (limit 200 per poll). New-step detection deliberately uses `emittedAt >= lastSeen` rather than a strict `>` — several steps can share one millisecond — deduped by a FIFO id set capped at 1000 (`trace.ts:36-47`, `76-90`). A store read error closes the stream rather than spamming the controller (`trace.ts:86-93`). Headers: `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (`trace.ts:105-114`). The frontend `TraceView` component (agent-POV "trace" tab and the dashboard's play-by-play feed toggle) is the consumer; events are written by the tick's trace sink (see the tick section) and pruned on the `SH_TRACE_RETENTION_DAYS` window.

### `PATCH /api/agent/[id]` (`packages/backend/src/server/api/agent/id.ts:7`)

Body may set `name`, `role`, `archetype`, `tools`, `scheduleSeconds`, `initialPrompt`, `status` — `status` restricted to `running|paused|errored` (`awaiting_approval` is not settable from outside; invalid → 400). `wake: true` sets `nextRunAt = now` and, if no explicit status was supplied, `status = "running"` so the next tick picks the agent up (`id.ts:32-35`). No valid fields → 400; unknown agent → 404. A parked agent (`awaiting_approval`) rejects both wake and status changes with 409 — the pending approval must be resolved first (`id.ts:47-52`). Returns the updated row.

## Misc routes

### `POST /api/seed` (`packages/backend/src/server/api/seed.ts:52`)

Creates the demo team "Simple Harmonic v0.0 Launch" — 409 with the existing `teamId` if it already exists. Side effects: inserts the team (`paused: true`, `tickCount: 12`, cofounder "Harmon", a meta prompt), a chat session, four agents (Scout/Relay/Chisel/Pulse with internal-only tools and 20–45 s schedules), then writes 32 a2ax direct/broadcast messages (agent↔agent, cofounder↔agent via the `c0f0` sentinel, user↔cofounder/agent via the `fffe` sentinel) with 50 ms delays for chronological ordering, and 9 a2ax tasks with assorted state transitions. Returns `{ teamId, agents, messageCount: 27, taskCount: 9 }` — the counts are hard-coded literals (`seed.ts:520-525`); `messageCount` does not match the 32 `sendDirect`/`broadcast` calls actually made.

### `GET /api/infra-report` (`packages/backend/src/server/api/infra-report.ts:12`)

Returns the newest-first merge of unacknowledged `infra`-level and `tool`-level app events, capped at 100, as `{ events, total, infraCount, toolCount }`. Errors → 500 with the message.

### `POST /api/infra-report` (`packages/backend/src/server/api/infra-report.ts:63`)

Body `{ eventIds: string[] }` (missing/empty → 400). Stamps `acknowledgedAt = now` on the given `app_events` rows. Returns `{ ok: true, acknowledged: <count submitted> }` (the count is the input length, not affected rows).

## Settings routes

### `GET /api/settings` / `POST /api/settings` (`packages/backend/src/server/api/settings/index.ts`)

GET returns `getSafeConfig()` — the resolved config with `openaiApiKey` masked (`abcd••••wxyz`), plus `dataDir`, `hasOpenaiKey`, `hasDataDir`, `apiKeySource`, `codingBackend`, `codingConfig` (`packages/backend/src/server/config.ts:100-113`); there is no DB URL or password to mask. POST accepts the string fields `openaiApiKey`, `openaiBaseUrl`, `model`, `dataDir`, `codingBackend` (`settings/index.ts:18-23`; only non-empty strings are applied) and a `codingConfig` object deep-merged per backend (`codex`, `claude-code`, `opencode`); nothing valid → 400. Side effect: `setConfig` (re)writes `simple-harmonic.config.json` at the repo root (`config.ts:92`). Returns the new safe config.

### `GET`/`POST /api/settings/codex` (`packages/backend/src/server/api/settings/codex.ts`)

GET returns the Codex auth status (parsed from `~/.codex/auth.json`, overridable via `CODEX_HOME`) merged with the available model list. POST calls `refreshCodexToken()` and returns its result.

### `POST /api/settings/codex-login` (`packages/backend/src/server/api/settings/codex-login.ts:23`)

Spawns a **detached** `codex login` child process to run the OAuth browser flow; codex itself writes `~/.codex/auth.json` on completion. Behavior: already authenticated (unless `?force=true`) → `{ ok, status: "already_authenticated" }`; a login process younger than 5 minutes already running → `{ ok, status: "already_running" }` (stale ones are killed); `force` deletes `auth.json` first so codex doesn't short-circuit (`codex-login.ts:45-52`); spawn failure (CLI not installed) → 500 with a hint. The child's stdout/stderr are piped to the server log so the operator can copy the auth URL. Process state is tracked in module-level variables (`loginProcess`, `loginStartedAt`, `codex-login.ts:12-13`) — this only works in a single long-lived server process, not serverless. GET (`codex-login.ts:103`) returns `{ authenticated, loginRunning }` for polling.

### `GET /api/settings/coding` (`packages/backend/src/server/api/settings/coding.ts:22`)

Probes `codex --version`, `claude --version`, `opencode --version` in parallel (5 s timeout each) and returns, per backend: installed/version, an `authenticated` flag (Codex OAuth file for codex; `ANTHROPIC_API_KEY` for claude-code; either Anthropic or OpenAI key for opencode), and masked connector entries, plus the currently selected `codingBackend` and `codingConfig`.

### `GET`/`POST`/`DELETE /api/settings/connectors` (`packages/backend/src/server/api/settings/connectors.ts`)

GET (`connectors.ts:87`) returns five built-in connector statuses (`getBuiltinConnectors`, `connectors.ts:30-83`) — the `SH_ENABLE_TOOLS` destructive-tools master switch (`builtin-tools-enabled`), the `SH_TOOLS_CWD` jail root (`builtin-tools-cwd`), `ANTHROPIC_API_KEY` (`builtin-anthropic`), `OPENROUTER_API_KEY` (`builtin-openrouter`, added by PR #14 for the cascade fallback), and `GITHUB_TOKEN` (`builtin-github`, resolved via `resolveConnector`, which prefers `.simple-harmonic/secrets.json` over env) — plus file-defined connectors from `.simple-harmonic/connectors/` with masked resolved values, deduped against the built-ins. There is no longer a `DATABASE_URL` built-in (the database is gone). POST (`connectors.ts:121`, body `{ name, key, value?, description?, type? }`) validates the key format (`UPPER_SNAKE`, else 400) and persists the connector metadata + optional secret via `saveConnector`. DELETE (`connectors.ts:147`, `?key=`) validates likewise and removes it; unknown key → 404.

### `POST /api/settings/credentials` (`packages/backend/src/server/api/settings/credentials.ts:8`)

Body `{ key, value }`; key must match `/^[A-Z][A-Z0-9_]*$/` and value must be a non-empty string, else 400. Calls `apollo.set(key, value)`, which AES-256-GCM-encrypts the secret into `.apollo/vault.enc` and sets `process.env[key]` immediately. This is the landing endpoint for the chat route's `request_credential` flow. Returns `{ ok: true, key }`.

### `GET`/`PUT /api/settings/platform-status` (`packages/backend/src/server/api/settings/platform-status.ts`)

GET returns the singleton `platform_status` row, or a synthesized `{ id: 1, status: "healthy", message: null }` when none exists. PUT validates `status ∈ {healthy, degraded, maintenance}` (else 400) and upserts row id 1 with the optional `message`. The tick injects this status into every agent prompt via `getPlatformStatus`/`formatPlatformStatusForPrompt`.

### `GET`/`PATCH /api/settings/skills` (`packages/backend/src/server/api/settings/skills.ts`)

GET (`skills.ts:13`) builds the tool registry (`createAppRegistry`) and returns every tool definition (`name`, `description`, `category`, `risk`) joined with which agents have it in their `tools` array; if the store read fails, definitions are still returned with empty assignments (`skills.ts:20-26`). PATCH (`skills.ts:50`, body `{ agentId, tools: string[] }`, else 400) validates every name against the registry (unknown names → 400 listing them), replaces the agent's `tools`, 404 on unknown agent, returns `{ ok, agent: { id, tools } }`. Both handlers use `createAppRegistry()` (`skills.ts:14`, `58`) — the 15 built-in tools only, unlike the tick's per-team `createAppRegistryWithCustomTools()` — so custom JSON tools under `.simple-harmonic/skills/<name>.json` neither appear in the catalog nor pass PATCH validation, even though the tick will execute them.

### `GET`/`PUT /api/settings/telemetry` (`packages/backend/src/server/api/settings/telemetry.ts`)

GET requires `?teamId=` (400) and returns `{ teamId, telemetryEnabled }` (404 unknown team). PUT requires `{ teamId: string, enabled: boolean }` (400), updates the team (404 if absent), and calls `invalidateTelemetryCache(teamId)` so `emitAppEvent`'s cached per-team telemetry check picks the change up immediately.

### `POST /api/settings/test-llm` (`packages/backend/src/server/api/settings/test-llm.ts:37`)

No body; all outcomes are HTTP 200 with an `ok` flag. PR #14 rewrote this handler around the cascade: it probes only the cascade's **primary** candidate — `resolveLLMCandidates({ timeoutMs: 10_000 })[0]` (`test-llm.ts:39`) — the same provider an agent tick would hit first, not the whole chain. If the primary is codex, `testCodex` POSTs a streamed request directly to `https://chatgpt.com/backend-api/codex/responses` with the OAuth bearer, account id, and codex-CLI user-agent headers via `proxyFetch` (15 s timeout), parses the SSE for the output text and the actual model id, and reports failures with status/body excerpts (`test-llm.ts:78-150`). If the primary is the resolver's key-less OpenAI last resort, it returns a setup hint instead of the SDK auth error: "No API key configured. Add an OpenAI, Anthropic, or OpenRouter key — or sign in with Codex." (`test-llm.ts:47-53`). Otherwise `testChatClient` sends a 10-token "Reply with the word OK." completion through the candidate's own client and returns `{ ok, provider, model, response }` — the `provider` field is new in PR #14 (`test-llm.ts:58-76`). `describeError` (`test-llm.ts:10-35`) unwraps undici `cause` chains so the response surfaces `ECONNREFUSED`-class codes instead of "fetch failed".

### `POST /api/settings/setup-db`, `POST /api/settings/test-db`

Covered in depth by the data-model chapter. PR #16 reduced both to file-store operations — there is no database to create, no schema SQL, and no migrations. setup-db (`packages/backend/src/server/api/settings/setup-db.ts:14`) optionally persists a submitted `dataDir` to config, then calls `ensureDataDir()` to create the `teams/` + `system/` skeleton, returning `{ ok, steps[] }` (or `{ ok: false, steps, error }`). The same handler is invoked by the renamed `npm run data:init` CLI (`standalone/setup-db-cli.ts`). test-db (`packages/backend/src/server/api/settings/test-db.ts:10`) round-trips a probe file through the data directory (`writeFileSync` a temp file under it, then `rmSync`) to confirm the store is writable, returning `{ ok: true, dataDir }` or `{ ok: false, error }`.

## Deployment and configuration

- **`next.config.ts`** sets exactly one option: `devIndicators: false`, hiding the floating Next.js dev-tools button (`next.config.ts:3-8`). There are no rewrites, redirects, headers, or experimental flags.
- **`vercel.json`** defines a single cron: `GET /api/tick` on `* * * * *` — every minute (`vercel.json:2-7`). There is no other Vercel config. So the tick cadence is 60 s in production versus the 10 s instrumentation loop in local dev; agent `scheduleSeconds` below the cadence are effectively quantized to it.
- **`simple-harmonic.config.json`** is read from `process.cwd()` on **every** `getConfig()` call (no caching; `packages/backend/src/server/config.ts:22,39-48`) and (re)created by `POST /api/settings` and setup-db's `dataDir` save. When absent, every field resolves from env vars and code defaults. Resolution precedence per field (`config.ts:50-80`): config file > env (`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` / `SH_DATA_DIR` / `SH_CODING_BACKEND`) > defaults (`config.ts:30-37`: model `o4-mini`; `https://api.openai.com/v1`; dataDir `<cwd>/.simple-harmonic/data`; backend `codex`); the API key additionally falls back to the Codex CLI access token, which is what makes `getApiKeySource()` report `"codex"` and routes the tick through the Codex client.

## How the route tests work

The route handlers' unit tests live in the backend package (`packages/backend/tests/unit/api-*.test.ts`), one file per covered route — 19 of the 30 route patterns have a suite (`api-trace.test.ts` covers the trace route; `teams`, `heartbeat`, `pause`, `infra-report`, and the codex/coding/connectors/credentials/platform-status/skills/telemetry settings routes still do not) — plus `api-tool-runtime` / `api-tool-ssrf` for the tool runtime. Since PR #13 they import the backend handlers directly — e.g. `await import("@/server/api/tick")` — through the `"@/" → packages/backend/src` alias; the cross-package `"@/app/" → ../../src/app` alias was deleted from `packages/backend/vitest.config.ts`, and the backend `tsconfig.json` dropped its `tests/unit/api-*.test.ts` exclude, so the api tests are typechecked in the backend workspace. The backend collaborators are mocked via `vi.mock` — the meta-agent runner and its codex harness/adapters (`@/lib/meta-agent`, `…/codex-harness`, `…/anthropic-adapter`, `…/codex-adapter`), the tool registry (`@/server/tools`), a2ax (`@/server/a2ax`), config (`@/server/config`), and the OpenAI SDK — while the JSON file-store repos (`@/server/store`) are imported and run directly; the handlers are invoked with constructed `Request` objects and a `params` promise, matching the Next 16 handler signature — there is no HTTP server in the loop, so the proxy gate is not exercised by these tests (it has its own `operator-auth.test.ts`). Two suites guard the split layout itself: `standalone-routes.test.ts` (route-pattern/wrapper/method parity between `src/app/api` and the handler manifest) and `standalone-server.test.ts` (a smoke test of the `node:http` host's gate, dispatch, and 404/405 handling on endpoints that touch no store — see `10-standalone-host.md`).

## Parked: the skills-directory migration (stash@{0})

An uncommitted skills migration briefly replaced the flat JSON custom tools with directory-based `SKILL.md` skills — a sub-skill tree with progressive disclosure (`open_skills`/`close_skills`), an `agents.open_skills` column persisted across ticks by the tick handler, and matching `setup-db` DDL. That code was discarded on 2026-06-11 and exists nowhere in the repo; HEAD's tick, skills route, and setup-db handler have none of it (and after PR #16 there is no SQL of any kind — the migration's column and DDL predate the file store). Only its untracked data files survive, parked in git `stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees and `packages/backend/tests/unit/skill-tree.test.ts`. The live custom-tool format is the flat `.simple-harmonic/skills/<name>.json` file described above.

## Python backend (FastAPI port)

The Python port (`backend-py/`, complete 2026-06-14) re-implements this entire HTTP surface on FastAPI/uvicorn as a parallel service speaking the byte-for-byte same contract, so the same Next.js frontend points at either host unchanged via the env-gated `PY_BACKEND_URL` rewrite (`next.config.ts`; slice 9 of [`backend-py/MIGRATION.md`](../backend-py/MIGRATION.md)). It does **not** reproduce the TS layering — there is no thin-wrapper / handler split, no second `node:http` host, and no Next proxy. Instead, six `APIRouter` modules carry the bodies directly, the operator gate is one Starlette middleware, and uvicorn owns the port and lifecycle. The stack rationale (raw SDKs + custom asyncio orchestration, scored 9/10 over Pydantic AI and LangGraph) is in [`backend-py/ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md).

### Route-module map

Where TS spreads 30 handler modules across `packages/backend/src/server/api/**` plus 30 two-line Next wrappers under `src/app/api/`, the port groups them into six routers under [`backend-py/simple_harmonic/routes/`](../backend-py/simple_harmonic/routes/), each registered on the app in [`backend-py/simple_harmonic/app.py`](../backend-py/simple_harmonic/app.py) (`include_router`, `app.py:164-169`). FastAPI's path-operation decorators replace the `[id]`→`id.ts` / directory→`index.ts` filename mapping rule entirely: the route path is the decorator argument (`@router.get("/api/team/{id}/agent-hub")`), and `[id]` becomes a `{id}` path parameter bound to a handler argument.

| Python module | Routes carried | TS originals |
|---|---|---|
| [`routes/health.py`](../backend-py/simple_harmonic/routes/health.py) | `GET /health` | none — operational liveness probe, no TS equivalent |
| [`routes/login.py`](../backend-py/simple_harmonic/routes/login.py) | `POST /api/login` | `api/login.ts` |
| [`routes/teams.py`](../backend-py/simple_harmonic/routes/teams.py) | `GET /api/teams`, `GET`+`POST /api/tick` | `api/teams.ts`, `api/tick.ts` |
| [`routes/team.py`](../backend-py/simple_harmonic/routes/team.py) | all 13 `team/{id}/*` handlers incl. the `narration` + `trace` SSE streams | `api/team/id/*.ts` |
| [`routes/core.py`](../backend-py/simple_harmonic/routes/core.py) | `chat` (SSE), `spawn`, `seed`, `infra-report` (GET+POST), `agent/{id}` PATCH | `api/chat.ts`, `spawn.ts`, `seed.ts`, `infra-report.ts`, `agent/id.ts` |
| [`routes/settings.py`](../backend-py/simple_harmonic/routes/settings.py) | all 20 `settings/*` handlers (config, codex, codex-login, connectors, credentials, platform-status, skills, telemetry, coding, test-llm, setup-db, test-db) | `api/settings/*.ts` |

The decorators total **44** method+path combos — the **43** contract endpoints from the Route Table above, plus the extra `GET /health`. The actual tick scheduler lives in [`backend-py/simple_harmonic/tick.py`](../backend-py/simple_harmonic/tick.py) (the equivalent of `api/tick.ts` + `team-tree.ts`); `routes/teams.py` only cron-gates it and delegates (`tick_get` → `_run_tick_authorized` → `tick.run_tick`, mirroring the TS `GET`-delegates-to-`POST`).

### Idiomatic-Python choices on the HTTP layer

- **Pydantic v2 vs Zod at the edge.** Request bodies are read defensively, exactly as the TS handlers do, rather than through FastAPI's automatic body-model binding — every handler does `await request.json()` wrapped in a `_read_json` helper that returns `{}` (or `None`) on a malformed body, mirroring the TS `req.json().catch(() => ({}))` / `.catch(() => null)` idioms (`team.py:78-85`, `core.py:86-99`, `settings.py:981-998`). This keeps the field-presence guards and 400 messages identical to TS rather than letting FastAPI emit its own 422 envelope. Pydantic is used for *outbound* shapes (`response_model=list[Team]` on `/api/teams`, `SafeConfig` on `GET /api/settings`, `PlatformStatus` on platform-status) and to validate the planner message list (`PlannerMessage.model_validate`, `core.py:201-203`).
- **Datetime serialization fidelity (load-bearing).** JS `JSON.stringify(Date)` / `Date#toISOString()` emit millisecond precision with a trailing `Z`; Pydantic's default encoder emits microseconds. Because the frontend parses these strings, both `team.py` and `core.py` route every JSON body through a custom `JSONResponse` subclass (`_TeamJSONResponse` / `_CoreJSONResponse`) whose `render()` calls `json.dumps(..., separators=(",", ":"), default=json_default)`, where `json_default` is the store's millisecond-`Z` encoder (`team.py:60-71`, `core.py:67-79`). This is the wire-compat rule from `ARCHITECTURE.md` ("Datetimes serialize to ISO-8601 strings") applied per-response.
- **`null` vs omitted (load-bearing).** TS `JSON.stringify` drops `undefined` keys but emits `null`. Several handlers replicate this exactly: `POST team/{id}/messages` returns `msg.model_dump(by_alias=True, exclude_none=True)` so unset optionals (`parts`/`artifacts`/`urgent`) vanish rather than serialize as `null` (`team.py:599`); `GET team/{id}/messages` deletes a `None` `urgent` key by hand (`team.py:547-548`); and the connectors / coding handlers omit `maskedValue`/`value` when unset (`settings.py:382-410`, `_coding_connector`, `settings.py:159-167`). MIGRATION.md records that the integration verifier specifically caught and fixed `null`-vs-omitted masking bugs here.
- **asyncio + the store lock.** Where the TS handlers issue parallel reads with `Promise.all`, the port uses `asyncio.gather` — e.g. the four-way `agent-hub` fan-out (`team.py:167-172`) and `conversations` (`team.py:392-394`). The single-writer guarantee that TS gets free from Node's thread is reconstructed by an explicit `asyncio.Lock` inside every store read-modify-write (risk-register item 1); the HTTP handlers above sit on top of that, so e.g. the approval resolve in `POST team/{id}/approvals` (`team.py:350-375`) and the agent claim/update behind `PATCH /api/agent/{id}` (`core.py:1090`) inherit the same race-freeness the TS routes rely on. The deferred note in MIGRATION.md that per-team agents run *sequentially* (vs `Promise.allSettled`) is a tick-loop latency gap, not an HTTP-surface divergence.

### The operator gate (allowlist middleware)

The TS gate is two copies of the same logic — `src/proxy.ts` for Next and the standalone host's gate — both denying everything under `/api/*` except `tick` and `login`. The port collapses this into one Starlette `BaseHTTPMiddleware`, `OperatorGateMiddleware` (`app.py:85-107`), but inverts the rule: instead of deny-by-default, it gates by an explicit **allowlist of operator-only prefixes** (`GATED_PREFIXES = /api/settings, /api/chat, /api/spawn, /api/seed, /api/infra-report, /api/agent`, `app.py:51-58`) and an `OPEN_PREFIXES` set (`/api/tick`, `/api/login`, `/health`, `/api/teams`, `/api/team`, `app.py:61-67`). `_is_gated` (`app.py:74-82`) returns gated only when a path matches a gated prefix and no open prefix — the comment at `app.py:74-79` notes the deliberate care that `/api/teams` is not shadowed by the `/api/team` open prefix (both are listed open, neither gated). This matches the chapter's "all routes require the operator session except where noted": `teams` and `team/*` are open here because the TS handlers read no session, while `settings/*`, `chat`, `spawn`, `seed`, `infra-report`, and `agent/{id}` require it.

Enforcement semantics are byte-identical to `operator-auth.ts`: unset `OPERATOR_PASSWORD` returns 503 `{"error":"OPERATOR_PASSWORD not configured"}` under `is_production_runtime()` and otherwise allows everything (local dev with zero config); an authorized request passes, an unauthorized one gets JSON 401 (`app.py:96-107`). The auth helpers in [`backend-py/simple_harmonic/auth.py`](../backend-py/simple_harmonic/auth.py) preserve every load-bearing detail from the TS module:

- `is_operator_authorized` (`auth.py:82-89`) accepts either `Authorization: Bearer <OPERATOR_PASSWORD>` or the `sh_operator` cookie whose value must equal `sha256_hex(password)`; both go through `constant_time_equal` (`auth.py:39-48`, a length-checked `hmac.compare_digest`). This is risk-register item 21 (cookie wire-compat). The TS module is "edge-safe" (Web Crypto only); the port drops that constraint and uses `hashlib`/`hmac` directly but keeps the wire bytes identical.
- `is_cron_authorized` (`auth.py:92-105`) trusts `x-vercel-cron` **only** when `os.environ["VERCEL"]` is set (`auth.py:100`), else requires `Bearer <CRON_SECRET>`, else allows in dev and fails closed in production — risk-register item 22. The tick path is exempt from the operator gate (it is in `OPEN_PREFIXES`) and does its own cron check in `routes/teams.py:_run_tick_authorized` (`teams.py:38-43`), exactly as the TS proxy short-circuits `/api/tick` so the cron caller's missing operator cookie is not a problem.

### `/api/login` cookie issuance

`POST /api/login` (`login.py:39-62`) is the one public, gate-exempt route. It returns 503 when `OPERATOR_PASSWORD` is unset, 401 `{"error":"Invalid password"}` on a constant-time mismatch, and on success sets the `sh_operator` cookie to `sha256_hex(password)` via a hand-built `Set-Cookie` header: `HttpOnly`, `Secure` only when `is_production_runtime()`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000` (30 days, `login.py:55-61`). The header is assembled as a literal string rather than through Starlette's `set_cookie` so the attribute order and casing match the TS `login.ts` output byte-for-byte. As in TS there is no per-user identity — one shared password, one cookie value derived from it.

### SSE endpoints (`chat`, `narration`, `trace`)

All three Server-Sent-Events streams are FastAPI `StreamingResponse(gen(), media_type="text/event-stream")` wrapping an `async def` generator, replacing the TS web-standard `ReadableStream` + `new Response(stream)`:

- **`POST /api/chat`** (`core.py:188-292`) streams the planner turn. The planner's `on_token` callback is synchronous, so the generator buffers tokens onto an `asyncio.Queue` and races `queue.get()` against the awaited `planner_stream` task with `asyncio.wait(..., FIRST_COMPLETED)` (`core.py:205-233`) — interleaving `{"type":"token","text":...}` frames with the eventual terminal frame. The terminal events match the TS contract exactly: `spawn` (the route does **not** create the team — the client must POST `/api/spawn`), `modify_agent` (applied server-side via `_apply_modify_agent`, `core.py:149-185`, resolving team-by-name then agent-by-name), `request_credential`, `done`, and `error` (which also emits an infra-level app event, `core.py:237-246`). Frames use compact `JSON.stringify` separators (`_COMPACT = (",", ":")`, `core.py:137`) to match `chat.ts` bytes; headers are `Cache-Control: no-cache`, `Connection: keep-alive` (`core.py:139-142`).
- **`GET /api/team/{id}/narration`** (`team.py:695-743`) emits one `{"type":"history", entries:[…last 50, chronological]}` event then polls every `NARRATION_POLL_S = 3.0`s for entries newer than `last_seen`, emitting `{"type":"update", …}` (limit 20). The no-agents edge case returns a single non-streaming history event (`team.py:702-708`), as in TS.
- **`GET /api/team/{id}/trace`** (`team.py:755-825`, PR #12 feature) takes optional `?agentId=`/`?tickId=` filters, emits the newest 200 trace rows reversed to chronological, then polls every `TRACE_POLL_S = 2.0`s. It preserves the TS `emittedAt >= last_seen` (not strict `>`) new-step detection plus the FIFO id-dedupe set capped at 1000 (`remember`, `team.py:766-771`, `_SENT_IDS_CAP = 1000`) — several steps can share one millisecond.

All three share the `X-Accel-Buffering: no` / `Cache-Control: no-cache, no-transform` headers (`_SSE_HEADERS`, `team.py:676-680`) that defeat proxy buffering. The poll intervals and a `MAX_UPDATE_PASSES` cap are module-level so tests can shrink them and bound the otherwise-infinite generator (`team.py:685-688`).

### Deferred / known divergences for this chapter

From MIGRATION.md's honest-divergences list, two touch the HTTP surface:

- **SSE cleanup** uses Python async-generator teardown (`GeneratorExit`) rather than the TS `ReadableStream.cancel()` callback. In production the stream still runs until client disconnect; in tests a finite source (via `MAX_UPDATE_PASSES`) drives it. The behavior — stop polling and shut down on disconnect — is the same; the mechanism differs.
- **LLM resolution is lazy** rather than eager-at-top-of-`POST`, because the Python OpenAI SDK raises at client *construction* with no key. This shows up in `POST /api/settings/test-llm` (`settings.py:781-835`), which surfaces the "No API key configured…" setup hint **before** resolving candidates when nothing is configured (`settings.py:802-816`), where the TS handler fails only on the call — a deliberate short-circuit to avoid the SDK construction error, with identical observable output.

Beyond those, the port carries the chapter's other behavioral quirks faithfully: `seed.ts`'s hard-coded `messageCount: 27` / `taskCount: 9` literals that don't match the actual `send_direct`/`broadcast` count are reproduced verbatim (`core.py:945-952`, with the inter-message `setTimeout` delays dropped since the file store assigns monotonic timestamps); `spawn`'s unvalidated trusted `parentTeamId` (`core.py:349`); and the `GET/PATCH /api/settings/skills` use of the 15-built-in `create_app_registry()` (no custom JSON tools, `settings.py:647,693`) versus the tick's per-team registry — the same catalog/execution skew described above.
