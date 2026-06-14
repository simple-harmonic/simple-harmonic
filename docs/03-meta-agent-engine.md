# 03 — Meta-Agent Engine (`packages/backend/src/lib/meta-agent/`)

The meta-agent engine is the dependency-free, NPM-extractable core of Simple Harmonic's agent platform: a resumable tool-use agent loop (`runner.ts`), a streaming team-planner for the "Harmon" cofounder chat (`planner.ts`), a Zod-validated tool registry (`registry.ts`, `default-tools.ts`, `tools.ts`), a pure approval gate (`approval.ts`), an output-contract validator (`contract.ts`), the play-by-play trace contract (`trace.ts`), two model adapters that translate the engine's OpenAI-shaped wire format to Anthropic's API and the Codex CLI (`anthropic-adapter.ts`, `codex-adapter.ts`), the codex app-server JSON-RPC bridge and engine-mode harness (`codex-app-server.ts`, `codex-harness.ts`), the cascading multi-provider LLM client (`cascade.ts`), identity sentinels (`identity.ts`), the cofounder system prompt (`default-prompt.ts`), and a planner eval harness (`eval/`). Everything that does real I/O (filesystem, shell, network, DB) is injected by the app layer; the library itself only touches the network through the model adapters, the codex app-server subprocess, and the planner's two backends — a directly-constructed OpenAI SDK client (`planner.ts:34-40`, called at `planner.ts:260`) for Path A, and the injected `fetchImpl` (`planner.ts:357`) for the Codex subscription Path B.

## 1. Library boundary and exports

The package boundary rule (stated and enforced by structure): nothing under `lib/meta-agent/` imports from `packages/backend/src/server/`. Server concerns arrive via injection:

- The runner receives an `LLMClient`, an `A2AXSender`, and a `ToolRegistry` through `AgentConfig` (`packages/backend/src/lib/meta-agent/runner.ts:84`).
- The planner receives config, auth, and a proxy-aware fetch through `PlannerDeps` (`packages/backend/src/lib/meta-agent/planner.ts:10`); the app builds these in `packages/backend/src/server/planner-deps.ts:11`.
- The engine-mode harness receives the registry, a2ax, and an optional injected `CodexAppServerClient` through `CodexHarnessConfig` (`codex-harness.ts:78`); the trace sink arrives via `AgentConfig.trace`/`CodexHarnessConfig.trace`; the cascade receives pre-built `LLMCandidate` clients (`cascade.ts:12`) — provider resolution lives in `packages/backend/src/server/llm.ts`, outside the library.

`packages/backend/src/lib/meta-agent/index.ts` is the public surface. It re-exports: `plannerStream`, `DEFAULT_META_AGENT_PROMPT`, planner result types (`PlannerMessage`, `PlannerResult`, `SpawnTeamAgent`, `SpawnTeamResult`, `ModifyAgentResult`, `ModifyAgentUpdates`, `CredentialRequest`); `validateContract` + types; `runAgent` + `AgentConfig`/`AgentRunResult`/`LLMClient`; the trace types `TraceEventType`/`TraceSink`/`TraceStep` (`index.ts:7`); the back-compat tool surface `AGENT_TOOL_DEFS`/`executeTool` + tool types; `ToolRegistry`, `schemaToParameters` + registry types; `createDefaultRegistry`; `approveAgentAction`, `approveAgentTick` + approval types; and `OpenAIToolDef`. Note `index.ts` does **not** export the adapters, `identity.ts`, anything in `eval/`, nor `cascade.ts`/`codex-app-server.ts`/`codex-harness.ts` — consumers import those by full path (e.g. `@simple-harmonic/backend/lib/meta-agent/anthropic-adapter`; the tick handler imports `runCodexAgentTick`/`isCodexThreadSuspension` from `../../lib/meta-agent/codex-harness`, and `server/llm.ts` imports `createCascadeLLM` from `../lib/meta-agent/cascade`). The export list is pinned by `packages/backend/tests/unit/meta-agent-index.test.ts`.

### Entry points (consumers)

Since the route-extraction refactor, every HTTP handler lives under `packages/backend/src/server/api/**`; the `src/app/api/**/route.ts` files are two-line Next.js re-exports (see [10](10-standalone-host.md)).

| Consumer | What it uses |
|---|---|
| `packages/backend/src/server/api/tick.ts` | `runAgent`, `approveAgentTick`, `runCodexAgentTick`/`isCodexThreadSuspension` (engine mode, §9.3), `AgentSuspension`/`CodexThreadSuspension`, `LLMClient`, `PendingToolCall`, `ToolDecision`, `PeerAgent` — the autonomous tick loop; gets its client via `resolveLLM` (§9.4) |
| `packages/backend/src/server/llm.ts` | `createCascadeLLM`/`CascadeOptions`/`LLMCandidate` (`cascade.ts`), `createAnthropicClient`, `createCodexClient`, `LLMClient` — provider resolution for the tick cascade (§9.4) |
| `packages/backend/src/server/trace.ts` | `TraceStep` type — the persistent trace sink consumes the runner/harness step stream (§3.8) |
| `packages/backend/src/server/api/chat.ts` | `plannerStream`, `PlannerMessage`, `ModifyAgentResult` — the Harmon onboarding/management chat (SSE) |
| `packages/backend/src/server/planner-deps.ts` | `PlannerDeps` (builds them from server config/auth) |
| `packages/backend/src/server/spend.ts` | `LLMClient` (wraps it in a token-counting proxy) |
| `packages/backend/src/server/api/settings/test-llm.ts` | `LLMCandidate` type (probes `resolveLLMCandidates(...)[0]`, `test-llm.ts:39`) |
| `packages/backend/src/server/tools/*` | `ToolDefinition`, `ToolImpl` (the I/O tool implementations conform to the registry contract) |
| `packages/backend/src/server/tools/index.ts` | `createDefaultRegistry` (extends it into the full app registry) |
| `packages/backend/src/server/api/seed.ts`, `packages/backend/src/server/api/team/id/{messages,tasks,conversations,agent-hub}.ts` | `identity.ts` sentinels |
| `packages/frontend/src/components/**` (approval card, chat, team views), `src/app/(app)/new/page.tsx` | `SpawnTeamAgent` type and `identity.ts` sentinels only |

## 2. Wire format and core types

The engine speaks an **OpenAI chat.completions-shaped calling convention** everywhere; adapters translate. `packages/backend/src/lib/meta-agent/types.ts:11` defines the single shared tool-def shape:

```ts
interface OpenAIToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}
```

### `AgentConfig` (`runner.ts:84`)

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Agent display name, used in prompts and payloads |
| `archetype` | `string` | Free-form label injected into the system prompt |
| `tools` | `string[]` | Tool allowlist; `send_message`, `broadcast`, `report_action` are always added (`runner.ts:42`, `runner.ts:448`) |
| `initialPrompt` | `string` | Agent's own system prompt, placed first in the assembled system message |
| `a2axContext?` | `string` | Pre-formatted inbox block (messages since last tick) |
| `recentHistory?` | `string` | Last-N-actions working memory block |
| `teamId`, `agentId` | `string` | Identity for tool execution context |
| `peers` | `PeerAgent[]` | `{ id, name, role }` of teammates (`tools.ts:20`) |
| `a2ax` | `A2AXSender` | Message bus: `sendDirect(teamId, from, to, content)` + `broadcast(teamId, from, content)` (`tools.ts:56`) |
| `llm` | `LLMClient` | OpenAI-compatible client (see below) |
| `model?` | `string` | Model id; defaults to `"o4-mini"` (`runner.ts:307`) |
| `signal?` | `AbortSignal` | Propagated to the provider call for tick-budget cancellation |
| `isDestructive?` | `(toolName, rawArgs?) => boolean` | Approval classifier; defaults to `registry.isDestructive` (`runner.ts:186`) |
| `toolRegistry?` | subset of `ToolRegistry` | `Pick<..., "execute" \| "getOpenAIDefs" \| "isDestructive" \| "listForAgent">` (`runner.ts:115`); defaults to a module-level internal-tools registry (`runner.ts:179`) |
| `teamGoal?` | `string` | Injected into the tick prompt |
| `outputContract?` | `Record<string, unknown>` | JSON-Schema-ish contract; result payload validated against it |
| `recentValidations?` | `string` | Past pass/fail lines injected so the agent self-corrects |
| `appHealthContext?` | `string` | Recent app events block |
| `resume?` | `ResumeState` | `{ suspension, decisions }` — continues a suspended tick |
| `trace?` | `TraceSink` | Play-by-play sink (`runner.ts:140`); receives one step per LLM round, tool call, approval pause, and tick boundary. Sink failures never break a tick (§3.8) |

### `AgentRunResult` (`runner.ts:143`)

`{ actionType: string; payload: Record<string, unknown>; suspension?: AgentSuspension; validation?: ValidationResult }`. `actionType === "suspended"` iff the tick paused for approval; `suspension` is present iff suspended; `validation` is present only when `outputContract` was set and the run completed (a suspension returns before contract validation, `runner.ts:372`–`390` vs `runner.ts:404`).

### `AgentSuspension` (`runner.ts:56`) — the opaque persistable blob

| Field | Meaning |
|---|---|
| `messages` | Full OpenAI-format message list up to and including the assistant turn whose tool calls triggered the suspension |
| `pending` | `PendingToolCall[]` — destructive calls awaiting a decision (`{ id, name, arguments }`, args as raw JSON string, `runner.ts:45`) |
| `deferredSafe?` | Safe calls from the same assistant turn, deferred so every `tool_call` gets a result on resume |
| `actions` | `ToolResult[]` already logged this tick before suspension |
| `round` | Loop round at suspension; resume continues at `round + 1` |

It is plain JSON; the tick handler persists it verbatim in the agent's `conversationState` field (the JSON file store writes it to `agents/<agentId>/agent.json`; see [04](04-server-layer.md)) and hands it back on resume. JSON round-trip stability is pinned by `packages/backend/tests/unit/runner-resume.test.ts:288`. A **second** suspension shape can be parked in the same field: the engine-mode `CodexThreadSuspension` (`{ kind: "codex-thread", threadId, pending, actions }`, `codex-harness.ts:60`), discriminated by the `isCodexThreadSuspension` type guard (`codex-harness.ts:557`) — see §9.3.

### `ToolDecision` / `ResumeState` (`runner.ts:71`, `runner.ts:79`)

`ToolDecision = { id, approved: boolean, note?: string }` matched to `PendingToolCall.id`; `ResumeState = { suspension, decisions }`.

### `LLMClient` (`runner.ts:154`)

```ts
interface LLMClient {
  chat: { completions: { create: (params, options?: { signal?: AbortSignal }) => Promise<LLMResponse> } };
}
```

`LLMResponse` is `{ choices: [{ message: { content, tool_calls? }, finish_reason }] }` (`runner.ts:165`). A raw `openai` SDK instance satisfies it structurally (the provider resolver casts one directly for the OpenRouter and OpenAI candidates, `packages/backend/src/server/llm.ts:73`, `:97`). The cascade client (§9.4) also implements this interface, wrapping other `LLMClient`s. Responses may additionally carry a `usage` object — the engine ignores it, but the server's spend wrapper reads it (see §3.6).

### Tool-layer types (`tools.ts`)

- `ToolResult = { actionType, payload }` (`tools.ts:14`) — an action to log.
- `ToolExecContext = { teamId, agentId, agentName, peers }` (`tools.ts:31`).
- `ToolRunContext = ToolExecContext & { a2ax }` (`tools.ts:39`) — what registry impls receive.
- `ToolCallInput = { name, arguments: Record<string, unknown> }` (`tools.ts:43`).
- `ToolExecResult = { toolName, success, result: string, action?: ToolResult }` (`tools.ts:48`).

## 3. The runner (`runner.ts`)

`runAgent(config)` executes one **tick**: a multi-round tool-use loop, `MAX_TOOL_ROUNDS = 3` (`runner.ts:178`).

### 3.1 Setup (`runner.ts:182`–`199`)

1. `registry = config.toolRegistry ?? defaultRegistry` — the fallback is a module-level `createDefaultRegistry()` instance holding only the internal tools (`runner.ts:179`). The app always passes the full registry.
2. `allowedTools = toolAllowlist(config.tools)` — the allowlist unioned with `FALLBACK_TOOL_NAMES = ["send_message", "broadcast", "report_action"]` (`runner.ts:42`), so every agent gets the messaging tools. `toolAllowlist` is exported (`runner.ts:448`) so the engine-mode harness shares it.
3. `toolDefs = registry.getOpenAIDefs(allowedTools)` is computed **once** at setup (`runner.ts:184`) and offered unchanged every round; `toolDescriptions = registry.listForAgent(allowedTools)` feeds the system prompt.
4. The trace helpers are set up (`emit`, `tracedToolCall`, `finish` — §3.8) and a `tick_started` step is emitted (`runner.ts:254`).

### 3.2 Fresh start vs. resume (`runner.ts:259`–`301`)

**Fresh:** `messages = [system, user]` where the system prompt is `buildSystemPrompt` and the user message is `buildTickPrompt` (see §3.7), `startRound = 0`.

**Resume:** restore `messages`, prior `actions`, and `startRound = suspension.round + 1`; then apply decisions. `orderedResumeCalls` (`runner.ts:471`) walks the **last assistant message's `tool_calls` in original order**, classifying each id as pending-destructive or deferred-safe (unmatched ids are appended afterwards as a fallback), so every tool_call gets exactly one tool-result message in the order the model issued them. For each call:

- approved → `tracedToolCall` (`runner.ts:278`) runs it for real and pushes the tool-result message;
- rejected, or **no decision found** (fail-safe) → a tool message `"Action not approved: <note> Do not retry it; continue with other work or stop."` with default note `"The user rejected this action."` (`runner.ts:281`–`288`); pinned by `runner-resume.test.ts:247`;
- deferred-safe → executed without approval (`runner.ts:289`–`292`).

The resume pass emits one `decision_applied` trace step per pending call before acting on it (`runner.ts:271`–`276`; see §3.8).

Control then falls into the loop for another LLM turn so the model can react to the results. If the suspension happened in the final round (`round === 2`), `startRound === 3` and the loop body never runs: decisions are applied, then the run summarizes without another LLM turn.

### 3.3 The loop (`runner.ts:304`–`400`)

Each round:

1. Emit `llm_request`, then `llm.chat.completions.create({ model: config.model || "o4-mini", messages, tools: toolDefs }, { signal })` (`runner.ts:305`–`317`); emit `llm_response` with the round's thought, tool-call list, finish reason, and duration (`runner.ts:323`).
2. No choice → `break`.
3. **Text-only response (no tool calls):** if no actions were logged yet, return `{ actionType: "agent_thought", payload: { agent, thought: content ?? "no output" } }` immediately through the `finish()` trace helper (`runner.ts:335`–`343`); otherwise `break` to summarize.
4. Push the assistant turn (content + normalized `tool_calls`) onto `messages` **before** executing anything (`runner.ts:346`).
5. **Destructive scan first:** every call's raw args are JSON-parsed (parse failure → `undefined`) and passed to `isDestructive(name, args)`. If any call is destructive, the runner emits an `approval_requested` step (`runner.ts:363`) and returns a suspension **before executing anything in that round** — including the safe calls, which go into `deferredSafe` (`runner.ts:372`–`390`). The result is `{ actionType: "suspended", payload: { agent, pending: [{id, name}] }, suspension }`. Mixed-batch deferral is pinned by `runner-resume.test.ts:116`.
6. Otherwise execute every call inline via `tracedToolCall` and push each tool-result message (`runner.ts:394`–`397`).
7. `finish_reason === "stop"` → `break` (even if tool calls ran this round; pinned by `runner.test.ts:540`).

After the loop: `summarize(name, actions)` (exported at `runner.ts:518` so the harness can share it) collapses logged actions into the return value — zero actions → `{ actionType: "noop" }`; one → that action's type with `{ agent, ...payload }`; several → `{ actionType: "multi_action", payload: { agent, actions: [{type, ...payload}] } }`. If `outputContract` is set, `validation = validateContract(result.payload, contract)` (`runner.ts:404`), and the result returns through `finish()` (`runner.ts:408`).

### 3.4 Tool dispatch and error handling

`runToolCall` (`runner.ts:426`) JSON-parses the raw argument string. Malformed JSON is **returned to the model as a tool-result error string**, never thrown: `` `Error: tool "<name>" arguments were not valid JSON (...). Retry the call with properly formatted JSON arguments.` `` Then `registry.execute(name, args, ctx)` runs (which itself returns structured errors for unknown tools and Zod failures — see §5). Any `result.action` is appended to `actions`. Note the runner executes whatever tool name the model emits; the allowlist only filters which defs are *offered*, not which calls are *executed* — an unoffered-but-registered tool call will run (subject to the destructive gate), and an unregistered name comes back as `"Unknown tool: <name>"` (after passing the gate, since `registry.isDestructive` holds unknown names for approval).

### 3.5 Termination conditions (complete list)

1. Text-only first response with no logged actions → `agent_thought` (early return).
2. Text-only response after actions → break → summarize.
3. Destructive tool call → `suspended` (early return).
4. `finish_reason === "stop"` after a round of safe tool calls → break → summarize.
5. Rounds exhausted (`MAX_TOOL_ROUNDS = 3`) → summarize (pinned by `runner.test.ts:392`).
6. Empty `choices` → break → summarize.
7. A thrown LLM/provider error propagates to the caller (the tick handler catches it, errors the agent, and reschedules).

### 3.6 Token and spend accounting

The library's runner does **no** accounting. The Anthropic adapter attaches `usage` with both Anthropic (`input_tokens`/`output_tokens`) and OpenAI (`prompt_tokens`/`completion_tokens`) keys (`anthropic-adapter.ts:175`); the Codex **exec** adapter returns no usage at all. The server builds a fresh `makeCountingLLM` wrapper around the shared per-tick cascade client for **each runner-path agent run** (`packages/backend/src/server/spend.ts:118`; `packages/backend/src/server/api/tick.ts:418`, `:534`), accumulating either key family per call. After `handleRunResult` the tick handler calls `recordSpend` with the run's `teamId`/`agentId` and the accumulator's model/totals (`tick.ts:429`, `:552`) — on both the fresh and resume paths, **including runs that end suspended**. Failed or timed-out runs record nothing (the `catch` goes straight to `failAgent`), and `recordSpend` itself skips the append when both token counts are zero (`spend.ts:92`), so an exec-adapter codex run writes no spend-ledger entry at all (the ledger is the global `system/spend.jsonl`; see [04](04-server-layer.md)).

Two engine-level details round out the picture:

- **Engine mode reports real usage.** `runCodexAgentTick` sums the `last` block of every `thread/tokenUsage/updated` notification into `usage.{inputTokens,outputTokens}` (`codex-harness.ts:444`–`449`) and returns it on the result (also on suspension); the tick handler records it with model `modelOverride ?? "gpt-5.5"` (`tick.ts:429`, `:552`). Codex-subscription ticks get a real spend-ledger entry — the `makeCountingLLM` wrapper is bypassed on this path.
- **The cascade attributes the serving model.** `createCascadeLLM` stamps `response.model` with the candidate that actually served when the response carries none (`cascade.ts:53`–`54`), and `makeCountingLLM` prefers the response's model over the requested one (`spend.ts:144`–`146`). `costCents` also strips vendor namespaces (`anthropic/claude-sonnet-4` → the `claude-sonnet` rate, `spend.ts:31`–`32`) for OpenRouter ids.

The daily cap (`SH_DAILY_SPEND_CAP_CENTS`, default 5000 cents) is enforced before any LLM work — `checkSpendAllowed(now)` at `packages/backend/src/server/api/tick.ts:171`, with the early-return skip block at `tick.ts:178`–`192`.

### 3.7 Prompt assembly

`buildSystemPrompt` (exported at `runner.ts:577`; the engine-mode harness reuses it as the codex thread's `developerInstructions`, and the narrowed `AgentPromptConfig` at `runner.ts:560` defines exactly what it reads) concatenates, in order: `config.initialPrompt`; `You are "<name>", a <archetype> agent in a team.`; the peer list (`- name (role)` or `"No other agents in this team."`); the offered tool list (`- name: description`); an **engineering context block** iff the agent's allowlist contains any of `read_file`, `write_file`, `run_command`, `coding_task` (`ENGINEERING_TOOLS`, `runner.ts:543` — no archetype check, purely tool-driven) — the block tells the agent to read before writing, use `coding_task` for multi-step work, expect approval pauses on destructive actions, and browse `.simple-harmonic/skills/` / `.simple-harmonic/connectors/`; a coordination paragraph; and the four **improvement levels** (agent / team / tool / infra) with reporting guidance.

`buildTickPrompt` (exported at `runner.ts:607`; it becomes the harness's `turn/start` input text) starts with `"A new tick has fired. Do your job based on your role and system prompt."` and appends, each conditionally: `## Team goal:`; `## Your recent actions (for continuity, don't repeat work already done):`; `## Recent output validation results:` plus a fix-failing-validations instruction; `## Output contract (...)` with the pretty-printed JSON schema and `"Use report_action with a payload matching this schema."`; the a2ax context block with `"Respond to any messages that need a reply, then do your regular work."` (or `"No new messages from other agents."`); and `## Recent app events (...)` with per-level response instructions (agent: fix; team: escalate; tool: work around; platform DEGRADED: reduce work; known issues: don't investigate) plus a pointer to `observe_app`.

### 3.8 Play-by-play trace emission

The runner carries a fire-and-forget telemetry stream.

**The contract (`trace.ts`).** `TraceEventType` (`trace.ts:15`) enumerates 9 step types; `TraceStep = { type, data: Record<string, unknown> }` and `TraceSink = (step: TraceStep) => void` (`trace.ts:35`–`41`). The sink is supplied by the caller via `AgentConfig.trace` (`runner.ts:140`); the library stays storage-agnostic. The contract is **fire-and-forget**: the runner wraps every sink call in try/catch ("a buggy sink must never break a tick", `runner.ts:203`–`209`), so sinks must buffer internally and write asynchronously. All three types are re-exported from `index.ts:7`.

| Step type | Emitted when | `data` |
|---|---|---|
| `tick_started` | Runner invocation begins (`runner.ts:254`) | `{ mode: "fresh" \| "resume", round }` |
| `llm_request` | Before each model call (`runner.ts:305`) | `{ round, model, messageCount }` |
| `llm_response` | After each model call (`runner.ts:323`) | `{ round, thought, toolCalls: [{toolCallId, tool}], finishReason, durationMs }` |
| `tool_started` | Before each tool execution (`runner.ts:212`) | `{ round, toolCallId, tool, args }` (parsed args, raw string on parse failure) |
| `tool_finished` | After each tool execution (`runner.ts:221`/`:230`) | `{ round, toolCallId, tool, result \| error, durationMs }` |
| `approval_requested` | Destructive calls suspend the tick (`runner.ts:363`) | `{ round, pending: [{toolCallId, tool, args}], deferredSafeCount }` |
| `decision_applied` | Each human decision applied on resume (`runner.ts:271`) | `{ toolCallId, tool, approved, note? }` |
| `tick_finished` | Tick completes — **not** emitted on suspension (`runner.ts:241`) | `{ actionType, actionCount, durationMs, validation? }` |
| `tick_failed` | Run threw or timed out — emitted by the **tick handler**, not the runner (`failAgent` at `packages/backend/src/server/api/tick.ts:581`, emit at `tick.ts:595`) | `{ phase, error }` |

**Runner hooks.** Three helpers carry all emission: `emit(type, data)` (`runner.ts:203`), `tracedToolCall(call, round)` which brackets `runToolCall` with `tool_started`/`tool_finished` — recording errors and `durationMs`, and re-throwing after emitting (`runner.ts:211`–`239`) — and `finish(result)` which emits `tick_finished` and passes the result through (`runner.ts:241`–`251`). `tracedToolCall` is used at all three execution sites: resume-approved, resume-deferred-safe, and the main loop. The engine-mode harness emits the **same step types** with `round` always `0`, plus `runtime: "codex-app-server"` on `tick_started`/`llm_request` (`codex-harness.ts:162`–`166`, `:489`), and emits `llm_response` with `finishReason: "reasoning"` for codex reasoning items (`codex-harness.ts:459`–`462`).

**Server side (context, documented in [04](04-server-layer.md)/[06](06-http-api.md)).** The tick handler builds a `createTraceSink({teamId, agentId})` per run (`packages/backend/src/server/trace.ts:41`; PII-scrubbed, truncated, then appended through the `traceEvents` repo to the agent's own `agents/<agentId>/trace.jsonl`; see [04](04-server-layer.md)) and passes `trace.emit` into the run config (`tick.ts:403`); `trace.flush()` runs in `finally` on both fresh and resume paths (`tick.ts:441`, `:565`). Suspend/resume share one logical `tickId`: `handleRunResult` parks a `traceTickId` key alongside the opaque suspension in the agent's `conversationState` (`tick.ts:654`) and `extractTraceTickId` (`tick.ts:571`) reads it back on resume — the runner itself never sees it. Retention is `SH_TRACE_RETENTION_DAYS` (default 14 days, `trace.ts:156`), pruned at most hourly from the tick (`tick.ts:120`). The SSE feed is `packages/backend/src/server/api/team/id/trace.ts` (history + 2 s polling, `agentId`/`tickId` filters). Exact step sequences are pinned by `packages/backend/tests/unit/runner-trace.test.ts` (including throwing-sink immunity and no-`tick_finished`-on-suspend).

## 4. Approval flow (`approval.ts` + tick handler)

`approval.ts` is pure (no DB, no SDK).

**Tick gate — `approveAgentTick(team, agent, now)` (`approval.ts:53`):** decides whether an agent runs a fresh tick. Inputs are structural `TeamLike = { id, paused }` and `AgentLike = { id, name, status, inFlight, nextRunAt }` where `status ∈ running | paused | errored | awaiting_approval`. Checks in priority order, returning `{ allowed: false, reason, reasonCode }` on the first failure:

| Order | Condition | `reasonCode` |
|---|---|---|
| 1 | `team.paused` | `team_paused` |
| 2 | `agent.status === "paused"` | `agent_paused` |
| 3 | `agent.status === "errored"` | `agent_errored` |
| 4 | `agent.status === "awaiting_approval"` | `awaiting_approval` |
| 5 | `agent.inFlight` | `agent_in_flight` |
| 6 | `nextRunAt` null or future | `not_due` |
| — | otherwise | `{ allowed: true }` |

`nextRunAt === now` exactly is allowed (pinned by `approval.test.ts:93`). The seventh `ApprovalReasonCode`, `destructive_unconfirmed`, belongs to the action gate.

**Action gate — `approveAgentAction(_team, _agent, call, isDestructive = () => true)` (`approval.ts:139`):** safe tools allowed; destructive ones held with `destructive_unconfirmed`. The default classifier holds **everything** (fail-safe for callers that pass none). The app backs it with `ToolRegistry.isDestructive`. In practice the runner consults the classifier directly rather than calling `approveAgentAction`; this function is the same logic exposed standalone.

**End-to-end lifecycle (tick handler — `packages/backend/src/server/api/tick.ts`, behind the thin Next wrapper `src/app/api/tick/route.ts`):**

1. Runner returns `suspension` → `handleRunResult` (`tick.ts:631`) sets the agent to `status: "awaiting_approval"`, `conversationState = suspension` (with the `traceTickId` key riding along, `tick.ts:654`), writes one pending-approval entry per pending call (`toolCallId`, `toolName`, `toolArguments`) into the agent's `approvals.json` (`approvals.insertMany`, `tick.ts:661`; see [04](04-server-layer.md)), and logs an `awaiting_approval` action — **without** advancing `nextRunAt`. These are three sequential single-file atomic writes rather than one transaction; a crash between them is recovered by the defensive clear in `tryResumeAgent` (step 3) and the once-per-process `inFlight` reset.
2. A human approves/denies via the approvals API (`packages/backend/src/server/api/team/id/approvals.ts:29`), which calls `approvals.resolve` (`approvals.ts:42`) to flip the entry's `status` to `approved`/`rejected` (only when it is still `pending` — a resolved entry returns a 409) and set `decisionNote`/`resolvedAt`, rewriting the agent's `approvals.json`, then clears the agent's `inFlight` and bumps `teams.lastUserActiveAt` so the team doesn't hibernate before the resume happens (`approvals.ts:52`–`53`). It does **not** touch `agent.status` — the parked → running transition belongs to the tick handler.
3. On the next tick, the **resume pass** runs before the fresh pass (`tick.ts:216`). `tryResumeAgent` (`tick.ts:450`) holds if any expected approval entry is missing or still `pending` (a missing human decision is never implicitly a rejection at this layer), otherwise builds `ToolDecision[]` from the entries, claims the agent with `agents.claim(agent.id, "awaiting_approval")` — a single-file compare-and-set requiring `inFlight = false` **and** `status = 'awaiting_approval'` (`tick.ts:491`), discriminates the suspension shape — `isCodexThreadSuspension` → harness resume (§9.3), else `runAgent({ ..., resume: { suspension, decisions } })` (`tick.ts:535`–`547`). Resolved entries are cleared afterwards via `approvals.clearForAgent` (`tick.ts:550`, also on failure `:561`). A parked agent with no `conversationState` is defensively un-parked and its approvals cleared (`tick.ts:459`–`468`).
4. `approveAgentTick` blocking `awaiting_approval` is what keeps a parked agent out of the fresh pass (`tick.ts:238`).

A resumed run can suspend again (pinned by `runner-resume.test.ts:267`); the cycle repeats.

**What crosses the boundary on fresh vs resume.** The fresh path gathers and passes the full optional context — `a2axContext` (the agent's unread a2ax messages), `recentHistory`, `teamGoal`, `outputContract`, `recentValidations`, `appHealthContext` (`tick.ts:364`–`395`). The resume path re-fetches **only** `recentHistory` (`tick.ts:502`) — and even that is inert on the runner path, since `buildTickPrompt` runs only on fresh starts; the resumed conversation is exactly what the suspension serialized. Two consequences: messages that arrived while the agent was parked are not injected into the resumed run (they wait for the next fresh tick), and a resumed run that completes is **never contract-validated** — the runner validates only when `config.outputContract` is set, and the tick handler doesn't pass it on resume. Both paths pass the same identity/plumbing fields: `name`, `archetype`, `tools`, `initialPrompt`, `teamId`/`agentId`, `peers`, `a2ax`, the per-run LLM client, `model`, the timeout `signal`, `toolRegistry`, `isDestructive`, and `trace`.

**a2ax read receipts.** The tick handler calls `a2ax.markContextRead(agent.id, ctx.messageIds)` only on the fresh path, after the run returns (`tick.ts:427`) — **including when the result is a suspension**, since the gathered messages are already baked into the suspended conversation. A run that throws (LLM error, timeout) never reaches the mark, so its context messages stay unread and are re-delivered on the agent's next fresh tick. The resume path neither gathers nor marks context.

**Failure, timeout, and recovery.** Every run is raced against `withTimeout` (`SH_AGENT_TIMEOUT_MS`, default 120 s; `tick.ts:50`, `:295`); on expiry the handler aborts a controller whose signal the run forwards into the provider call — only the in-flight LLM call is cancellable (Anthropic SDK abort, codex exec `SIGTERM`, harness `turn/interrupt`); tool executions never see the signal. Any throw lands in `failAgent` (`tick.ts:581`): a `tick_failed` trace step is emitted, the agent is set `errored` with `conversationState` cleared and `nextRunAt` advanced by `scheduleSeconds`, an error app-event is emitted, and a fire-and-forget `[SYSTEM]` broadcast alerts peers. A failed **resume** also clears the agent's `approvals.json` entries (`approvals.clearForAgent`, `tick.ts:561`) — a timed-out resume therefore loses the suspended conversation and its decisions entirely. At the start of each team's pass on every tick, errored agents are flipped back to `running` in the store **and on the in-memory row** (`tick.ts:200`–`207`), making a recovered agent eligible for that same tick's fresh pass — it actually runs once its advanced `nextRunAt` comes due.

## 5. The tool registry (`registry.ts`)

A tool is split into a **definition** (pure data) and an **implementation** (the I/O function), registered together.

```ts
interface ToolDefinition<S extends z.ZodType> {
  name: string; description: string;
  category: "internal" | "filesystem" | "shell" | "network";
  risk: "safe" | "destructive";
  isDestructive?: (args: z.infer<S>) => boolean;  // arg-aware override
  schema: S;                                       // Zod, also the JSON-Schema source
}
type ToolImpl<S> = (args: z.infer<S>, ctx: ToolRunContext) => Promise<ToolExecResult>;
```

(`registry.ts:39`, `registry.ts:51`.)

**Surface:**

- `schemaToParameters(schema)` (`registry.ts:66`, module-level export) — `z.toJSONSchema(schema)` with the `$schema` meta key stripped (Anthropic's `input_schema` rejects it).
- `register(def, impl)` — throws on duplicate name (no silent shadowing; `registry.ts:81`).
- `has(name)` / `get(name)` (`registry.ts:91`, `:95`) — lookup; `get` returns the definition only.
- `listForAgent(allowed?)` (`registry.ts:104`) — all defs, or the allowlist intersection; unknown allowlist names are ignored.
- `getOpenAIDefs(allowed?)` (`registry.ts:112`) — `listForAgent` mapped to OpenAI function shape via `schemaToParameters`.
- `isDestructive(toolName, rawArgs?)` (`registry.ts:130`) — `true` for unknown tools (fail safe); if the def has an arg-aware `isDestructive`, the raw args are first Zod-parsed (parse failure → `true`), then the predicate decides; otherwise `risk === "destructive"`.
- `execute(name, rawArgs, ctx)` (`registry.ts:147`) — never throws: unknown tool → `{ success: false, result: "Unknown tool: <name>" }`; Zod failure → `"Invalid arguments for <name>: <path: message; ...>. Retry with arguments matching the tool schema."`; otherwise calls the impl with the **parsed** data.

Behavior is pinned by `packages/backend/tests/unit/registry.test.ts`.

## 6. Built-in internal tools (`default-tools.ts`) and the back-compat shim (`tools.ts`)

`createDefaultRegistry()` (`default-tools.ts:46`) registers exactly **three** tools, all `category: "internal"`, all `risk: "safe"` (never gated):

| Tool | Schema (Zod) | Behavior | Logged action |
|---|---|---|---|
| `send_message` | `{ to_agent: string, content: string }` | Case-insensitive peer lookup in `ctx.peers`; unknown peer → failure listing available agents; otherwise `a2ax.sendDirect(teamId, agentId, peer.id, content)` | `message_sent` `{ to, toId, content }` |
| `broadcast` | `{ content: string }` | `a2ax.broadcast(teamId, agentId, content)` | `broadcast_sent` `{ content, peerCount }` |
| `report_action` | `{ action_type: string, summary: string, details?: record }` | Pure: logs an action with the agent-chosen type; `details` merged into the payload alongside `summary` | `<action_type>` `{ summary, ...details }` |

`tools.ts` keeps the original v0.0 surface as thin shims over its own module-level `createDefaultRegistry()` instance (`tools.ts:76`): `AGENT_TOOL_DEFS` is the internal tools in OpenAI format (`tools.ts:79`; `tools.test.ts:39` pins "exactly 3 tools"), and `executeTool(call, ctx, a2ax)` merges `a2ax` into a `ToolRunContext` and dispatches (`tools.ts:86`). Note `tools.ts`, `runner.ts`, and `codex-harness.ts` each hold their **own** default-registry instance; they are equivalent but distinct objects.

### The full app tool set (for reference)

The app extends the registry in `packages/backend/src/server/tools/index.ts:45`: `createAppRegistry()` adds `read_file`, `write_file`, `run_command`, `coding_task`, `http_fetch`, `github_api`, `set_team_goal`, `spawn_sub_team`, `modify_agent`, `modify_team`, `action_history`, `observe_app` — **15 built-ins total** with the 3 internal ones, pinned by `packages/backend/tests/unit/server-tools.test.ts:400`. `createAppRegistryWithCustomTools()` (`tools/index.ts:68`) additionally loads custom API tools (next section). Those implementations are server-layer code documented elsewhere; the engine sees them only as registry entries.

## 7. Custom API tools (`.simple-harmonic/skills/*.json`)

Custom tools are **flat JSON files** (server layer, summarized for context; see [05](05-tool-system.md)). `packages/backend/src/server/custom-tools.ts:39` (`listCustomToolFiles`) reads `.simple-harmonic/skills/<name>.json`, each of shape `{ name, description, config: ApiToolConfig }` where `config` carries `baseUrl`, optional `connectorKey`, `allowedMethods`, `pathPrefix`, and auth header settings; files missing `name` or `config.baseUrl` are skipped, as are malformed ones. `createAppRegistryWithCustomTools()` registers each (skipping names that collide with built-ins) via `buildApiToolDef`/`buildApiToolImpl` (`packages/backend/src/server/tools/api-tool-runtime.ts:20`, `:58`):

- Definition: a callable HTTP tool, `category: "network"`, `risk: "destructive"` with arg-aware `isDestructive: (args) => args.method !== "GET"` (`api-tool-runtime.ts:53`) — so GETs run free and mutations require approval. Schema: `{ method: enum(allowedMethods|["GET"]), path: string, body?: record, query?: record }`.
- Implementation: resolves the connector secret, SSRF-guards and IP-pins the URL **before** attaching the bearer token (`api-tool-runtime.ts:93`–`99`), caps response bodies at 128 KiB, 20 s timeout, and logs `api_tool_called`.

One real skill file ships in the repo: `.simple-harmonic/skills/httpbin_api.json`.

### Parked: the skills-directory migration (stash@{0})

An uncommitted migration once replaced this flat-JSON loader with **directory skills**: each skill a directory holding a `SKILL.md` (YAML frontmatter + markdown playbook, optional `api:` block), nested directories as sub-skills, a registry-level skill tree (`subSkills`/`expandAllowlist`/`visibleTools`), runner-side progressive disclosure (`openSkills`/`surfaced` sets, a `close_skills` internal tool), and per-agent persistence in an `agents.open_skills` column. On 2026-06-11 that **code was discarded** while updating main; none of it exists anywhere in the repo — `custom-tools.ts` loads flat JSON, the registry has no tree methods, the runner has no `openSkills`, and there are exactly 3 internal tools.

Only the migration's untracked files survive, parked in `git stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `.simple-harmonic/skills/create_agent/` SKILL.md trees, `packages/backend/tests/unit/skill-tree.test.ts`, and `simple-harmonic.config.json` (swept into the same stash, so no config file is currently on disk — config resolves from env vars and code defaults). Reviving the migration means reimplementing the code against the current runner (threading §3.8's trace wrappers around disclosure) and the engine-mode harness, which registers tool defs once at `thread/start` and would otherwise silently lose the tree.

## 8. The planner (`planner.ts`)

The planner is the LLM behind the **Harmon cofounder chat** — it converses with the founder and emits at most one structured tool call per turn. It runs only from the chat handler (`packages/backend/src/server/api/chat.ts`, behind the thin wrapper `src/app/api/chat/route.ts`) and the eval harness, never inside agent ticks. It does **not** use the cascade (§9.4); it picks its own backend per call.

`plannerStream(messages, onToken, deps)` (`planner.ts:240`) takes `PlannerMessage[] = { role: "user" | "assistant", content }[]`, a token callback for SSE streaming, and `PlannerDeps`:

```ts
interface PlannerDeps {
  config: { model: string; openaiApiKey?: string; openaiBaseUrl?: string };
  apiKeySource: string;            // "codex" routes to the Codex path
  codexAccessToken: string | null;
  codexAccountId: string;
  fetchImpl: (url, init?) => Promise<Response>;  // proxy-aware fetch, injected
}
```

Backend selection: `apiKeySource === "codex"` → Path B; anything else → Path A (`planner.ts:245`). The app resolves `apiKeySource` via `getApiKeySource()` (`packages/backend/src/server/config.ts:84`): `"config"` if `simple-harmonic.config.json` has `openaiApiKey`, else `"env"` if `OPENAI_API_KEY` is set, else `"codex"` if a Codex CLI token exists, else `"none"`. (No config file is currently on disk — see §7's parked note — so the file branch never hits.)

**Path A — OpenAI Chat Completions (`planner.ts:255`):** `new OpenAI({ apiKey, baseURL, timeout: 30000 })`, `stream: true`, system message = `DEFAULT_META_AGENT_PROMPT`, the conversation, and three tools. Text deltas are forwarded to `onToken` and accumulated; tool-call name and argument fragments are accumulated across chunks.

**Path B — Codex subscription (`planner.ts:319`):** POST to `https://chatgpt.com/backend-api/codex/responses` via the injected `fetchImpl`, headers `Authorization: Bearer <codexAccessToken>`, `ChatGPT-Account-ID: <codexAccountId>`, `User-Agent: codex_cli_rs/0.0.0`, `originator: codex_cli_rs` (throws if no token). Body: `{ model, instructions: DEFAULT_META_AGENT_PROMPT, input: messages, tools (flattened Responses-API shape), store: false, stream: true }`, `AbortSignal.timeout(60000)`. Non-OK → throws `Codex API error <status>`. The SSE stream is hand-parsed line-by-line; handled event types: `response.output_text.delta` (text), `response.output_item.added` with `item.type === "function_call"` (tool name), `response.function_call_arguments.delta` (argument fragments). Both `event:`-prefix and `data.type` formats are accepted.

**Planner tools** (defined once, shared by both paths):

| Tool | Required args | Purpose |
|---|---|---|
| `spawn_team` (`planner.ts:46`) | `team_name`, `agents[]` (each: `name`, `role`, `archetype`, `tools`, `schedule_seconds`, `initial_prompt`); optional `parent_team`, `cofounder_name` | Propose/spawn a (possibly nested) team. Schedule guidance baked into the schema description: 300–1800 s typical, range 60–3600, "Do NOT use 86400 (daily)" |
| `modify_agent` (`planner.ts:101`) | `agent_name`, `team_name`, `updates` (`tools`, `initial_prompt`, `schedule_seconds`, `status: running|paused`, `role`, `output_contract`) | Reconfigure an existing agent; the chat handler applies it directly via `agents.update` (`applyModifyAgent`, `packages/backend/src/server/api/chat.ts:8`) |
| `request_credential` (`planner.ts:154`) | `key`, `label`, `reason`; optional `help_url` | Ask the founder for a secret, to be stored in Apollo |

**Output contract — `finalize(fullText, toolCallName, toolCallArgs)` (`planner.ts:436`)** returns the `PlannerResult` union (`planner.ts:230`):

- `{ type: "spawn", content, result: SpawnTeamResult }` / `{ type: "modify_agent", ... }` / `{ type: "request_credential", ... }` when the corresponding tool was called and its arguments JSON-parse;
- malformed tool-call JSON or an unrecognized tool name falls back to `{ type: "message", content }`;
- no text at all → `{ type: "message", content: "I need a moment. Try again." }`.

## 9. Model adapters, engine mode, and the cascade

Both adapters implement `LLMClient` so the runner is provider-agnostic. **Selection happens in the tick handler** (`packages/backend/src/server/api/tick.ts`):

- `resolveLLM({ onFallback })` (`tick.ts:146`) returns a single cascading `LLMClient` that walks every configured provider in order Codex CLI > Anthropic > OpenRouter > OpenAI (`tick.ts:142`, resolution in `packages/backend/src/server/llm.ts` — §9.4), emitting a warning app event per fallback (`tick.ts:147`–`156`). The returned `model` becomes the tick's `modelOverride`.
- **Engine mode**: `useCodexHarness = apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec"` (`tick.ts:164`) routes codex-provider agents around the `LLMClient` path entirely, into the codex app-server harness (§9.3). The cascade (whose codex step is the exec adapter) is still constructed even in engine mode — it serves legacy message-based suspensions parked before a deploy (`tick.ts:159`–`163`).
- **Resume branches on the suspension shape**, not the flag: `isCodexThreadSuspension(suspension)` (`tick.ts:523`) → harness resume; a legacy message-based park (pre-harness, or written under `SH_CODEX_RUNTIME=exec`) resumes through `runAgent` with the cascade client.

The planner path is untouched by all of this (§8).

### 9.1 Anthropic adapter (`anthropic-adapter.ts`)

`createAnthropicClient({ apiKey?, baseURL?, timeout? })` (`anthropic-adapter.ts:102`) wraps `@anthropic-ai/sdk`. Auth: explicit `apiKey` arg, else `ANTHROPIC_API_KEY`; base URL: arg, else `ANTHROPIC_BASE_URL`; timeout default 60 s (`anthropic-adapter.ts:110`; the cascade resolver passes 120 s). **Non-streaming** — one `client.messages.create` per call, with the abort signal forwarded.

Request translation (`convertMessages`, `anthropic-adapter.ts:28`): `system` messages are extracted and concatenated into Anthropic's top-level `system`; `tool` messages become `user` messages with a single `tool_result` content block (`tool_use_id` from `tool_call_id`); assistant messages with `tool_calls` become content-block arrays (`text` block if content present, then one `tool_use` block per call, arguments JSON-parsed with `{}` fallback); plain user/assistant messages pass through as strings. Tools (`convertTools`, `anthropic-adapter.ts:18`): OpenAI `function.parameters` → Anthropic `input_schema` (default `{ type: "object", properties: {} }`). Defaults: model `"claude-sonnet-4-20250514"`, `max_tokens` 1024 (`anthropic-adapter.ts:124`–`125`).

Response translation: `text` blocks concatenate into `content`; `tool_use` blocks become OpenAI `tool_calls` with `arguments: JSON.stringify(input)`; `finish_reason` is `"tool_calls"` iff `stop_reason === "tool_use"`, else `"stop"`; the response echoes `model: response.model` (`anthropic-adapter.ts:165`) so the cascade's stamp-if-absent logic and the spend counter attribute calls to the serving model; `usage` carries both `input_tokens/output_tokens` and `prompt_tokens/completion_tokens` aliases for the spend counter (`anthropic-adapter.ts:175`).

### 9.2 Codex exec adapter (`codex-adapter.ts`)

`createCodexClient({ model? })` (`codex-adapter.ts:311`) — default model `"gpt-5.5"`, overridable per call via `params.model` — shells out to the **Codex CLI** (`codex exec`), using the user's ChatGPT-subscription login instead of an API key. This is the **legacy** codex path: codex-provider agents run through the app-server harness (§9.3) by default, and the exec adapter is used only when `SH_CODEX_RUNTIME=exec` opts out, when resuming a legacy message-based suspension, or as the codex step of the cascade (§9.4). Codex exec has no native custom-tool support, so the adapter does **prompt-encoded tool calling**:

- `buildCodexPrompt` (`codex-adapter.ts:43`) flattens system messages, then (if tools exist) instructs the model to respond with ONLY a JSON object of shape `{ content, tool_calls: [{ name, arguments }] }`, lists each tool with its JSON-Schema parameters, then renders the conversation as `[User]` / `[Assistant]` / `[Tool Result]` sections.
- `runCodexExec` (`codex-adapter.ts:244`) runs `codex exec --json --ephemeral --skip-git-repo-check --ignore-rules -c model="<model>" -c model_reasoning_effort="low" -c sandbox="read-only" -` via `execFile`, piping the prompt over **stdin**, with a 120 s timeout, 1 MiB `maxBuffer`, and full env passthrough. (It also writes the prompt to a temp file `sh-codex-*/prompt.txt` that is never passed to the CLI — dead weight that is created and cleaned up every call.) Abort support: `SIGTERM` + reject with the signal's reason. Exec error with no stdout → reject `codex exec failed: ...`.
- `parseCodexOutput` (`codex-adapter.ts:118`) scans the JSONL event stream for the **last** `item.completed` event whose `item.type === "agent_message"` and takes its `text`; `error` events are logged to console and otherwise ignored; non-JSON lines are skipped.
- `extractJsonObject` (`codex-adapter.ts:153`, exported) recovers the JSON object from free text: a fenced ```` ```json ```` / ```` ``` ```` block first, else the first *balanced* top-level `{...}` found by string-aware brace scanning (tolerates surrounding prose).
- `parseStructuredResponse` (`codex-adapter.ts:197`) parses that candidate and **filters `tool_calls` to the names actually offered this turn** — a hallucinated tool name is dropped and can never reach the dispatcher. Surviving calls get deterministic ids `call_0`, `call_1`, … (per-response uniqueness is all the runner needs). If all calls were filtered out, or the text isn't valid JSON, the turn degrades to plain content.

Empty output → `{ content: "No response from agent." , finish_reason: "stop" }`. When no tools are passed, the raw text is returned as content. The exec adapter never reports `usage`, so the counting wrapper stays at zero and `recordSpend` skips the ledger append entirely — exec-adapter runs write no `system/spend.jsonl` entry (`spend.ts:92`). (Engine-mode codex runs **do** report real usage — §9.3.)

### 9.3 Codex app-server engine mode (`codex-app-server.ts`, `codex-harness.ts`)

Engine mode is the default codex runtime. The inversion of control is the headline difference from the exec adapter: in the runner+adapter model, **SH owns the agent loop** and codex is text-in/text-out per round with prompt-encoded tool calls; in engine mode, **codex owns the loop** (model rounds, reasoning, context) and SH owns the hands — every SH tool is registered as a *dynamic tool* on the codex thread, and when the model picks one, codex sends a blocking `item/tool/call` request back to SH, which executes it through the real `ToolRegistry` and replies. The harness does not implement `LLMClient` at all; it replaces `runAgent` wholesale.

**When each is used** (`packages/backend/src/server/api/tick.ts`): fresh ticks branch on `useCodexHarness` (`tick.ts:164`, see §9 intro) — `runCodexAgentTick` at `tick.ts:411` vs `runAgent` at `tick.ts:420`. Resume branches on the **suspension shape**, not the flag: `isCodexThreadSuspension(suspension)` (`tick.ts:523`) → harness resume; a legacy message-based park resumes through `runAgent` with the cascade client.

**Transport (`codex-app-server.ts`).** `CodexAppServerClient` (`codex-app-server.ts:66`) speaks JSON-RPC 2.0 over newline-delimited stdio to one persistent `codex app-server` subprocess (`spawnCodexAppServer`, `codex-app-server.ts:276`); one shared client per Node process (`getSharedCodexClient`, `codex-harness.ts:102`, clientInfo `simple-harmonic`/`0.1.0`). RPC flows both ways — client→server `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`; server→client requests `item/tool/call`, the `item/*/requestApproval` family, `mcpServer/elicitation`; server→client notifications `item/started`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`. `initialize()` sends capabilities `{ experimentalApi: true, requestAttestation: false }` (`codex-app-server.ts:91`) — `experimentalApi` is what unlocks `dynamicTools` on `thread/start`, verified against codex-cli 0.139.0. Server-initiated traffic is routed per thread via `registerThread(threadId, handlers)` keyed on `params.threadId` (`codex-app-server.ts:128`) so concurrent agents share one subprocess without seeing each other's calls; unrouted requests get **fail-closed defaults** (`defaultServerRequestResult`, `codex-app-server.ts:235`): `item/tool/call` → `success:false` "Tool unavailable", elicitations and approvals → decline. Default request timeout 30 s (`codex-app-server.ts:30`). A throwing thread handler becomes RPC error `-32000`; close rejects all in-flight requests.

**Isolated `CODEX_HOME`.** `ensureIsolatedCodexHome` (`codex-app-server.ts:261`) creates `.simple-harmonic/codex-home/` (gitignored — it holds copied OAuth tokens), copies `auth.json` from `$CODEX_HOME` or `~/.codex`, and writes an empty `config.toml` so agents don't inherit the user's MCP servers/plugins/skills/hooks; token refreshes stay local so agent activity can't rotate the user's interactive CLI session. The subprocess env sets `CODEX_HOME` to that dir and `RUST_LOG=error` (`codex-app-server.ts:284`–`285`).

**Harness tick (`runCodexAgentTick`, `codex-harness.ts:134`).** `CodexHarnessConfig` extends the runner's exported `AgentPromptConfig` (prompt reuse is the point — same `buildSystemPrompt`/`buildTickPrompt`). Fresh: `thread/start` (`codex-harness.ts:218`) with model `config.model ?? "gpt-5.5"`, `ephemeral: false` (threads must persist for cross-process resume), `sandbox: "read-only"` and `approvalPolicy: "never"` (codex-native tools stay read-only and approval-free — **all** mutations flow through SH dynamic tools, where the SH approval gate lives), `developerInstructions = buildSystemPrompt(...)`, and `dynamicTools = registry.getOpenAIDefs(toolAllowlist(config.tools))` mapped to `{ name, description, inputSchema }`. Then one turn (`runTurn`, `codex-harness.ts:341`): `turn/start` with `buildTickPrompt(config)` as input text, hard-capped at `TURN_HARD_CAP_MS = 600_000` (`codex-harness.ts:52`) with abort-signal interrupt support. The `item/tool/call` handler: safe call → `registry.execute` via `executeToolTraced` (`codex-harness.ts:507`, emits `tool_started`/`tool_finished`, catches errors into an `Error: tool ... failed` result string), reply `{ success: true, contentItems: [{ type: "inputText", text }] }`; destructive (`registry.isDestructive`) → reply `success: false` "requires human approval", then `setTimeout(interrupt, 0)` so the reply hits the wire before `turn/interrupt`, and the tick returns `actionType: "suspended"` with a `CodexThreadSuspension { kind: "codex-thread", threadId, pending, actions }` (`codex-harness.ts:60`). Unlike the runner there is no transcript in the suspension — codex persists the conversation in its thread — and no `deferredSafe` machinery: calls arrive one at a time because codex blocks per call.

**Resume (`codex-harness.ts:172`–`216`).** `thread/resume { threadId, model, cwd, sandbox: "read-only", approvalPolicy: "never" }`, then one `decision_applied` trace step per pending call; **approved** calls are executed with SH's own hands (`executeToolTraced`) and **rejected** calls never execute. A new turn starts whose input reports outcomes verbatim — `[Approval outcomes]\n- <tool>: APPROVED. Tool result: <verbatim>` / `- <tool>: REJECTED — <note> Do not retry it.` — deliberately un-editorialized so a failed-but-approved call can't prime the model to claim success.

**Results and usage.** Token usage is real: every `thread/tokenUsage/updated` notification's `last` block is summed into `usage.{inputTokens, outputTokens}` (`codex-harness.ts:444`–`449`) and returned on `CodexHarnessResult` — codex-subscription ticks get a spend-ledger entry in `system/spend.jsonl` (recorded with model `modelOverride ?? "gpt-5.5"`, `tick.ts:429`/`:552`). A text-only turn with no actions mirrors the runner's `agent_thought`; otherwise the shared `summarize()` collapses actions; `outputContract` validation applies identically. Trace steps are the runner's 9 types with `round` always `0` plus `runtime: "codex-app-server"` on `tick_started`/`llm_request`; codex `reasoning` items emit `llm_response` with `finishReason: "reasoning"` (`codex-harness.ts:459`–`462`). The `isCodexThreadSuspension` guard (`codex-harness.ts:557`) checks `kind === "codex-thread"` plus a string `threadId`.

**Caveats.** Engine mode assumes a persistent host process (one shared subprocess; the serverless story is explicitly open). It registers tool defs once at `thread/start` from the static allowlist. Behavior is pinned by `packages/backend/tests/unit/codex-app-server.test.ts` (transport: correlation, routing, fail-closed declines, timeouts) and `codex-harness.test.ts` (dynamicTools registration, destructive park exactly-one-interrupt, resume approve/reject, usage summation).

### 9.4 Cascading LLM client (`cascade.ts`)

The library half of multi-provider fallback. `createCascadeLLM(candidates, opts)` (`cascade.ts:31`) composes an ordered `LLMCandidate[]` — `{ provider, model, llm: LLMClient }` (`cascade.ts:12`) — into a **single** `LLMClient`, so the runner stays provider-agnostic and unaware of fallback. Construction throws on an empty candidate list (`cascade.ts:35`). Semantics of each `chat.completions.create` call:

- Walk candidates in order, overriding `params.model` with each candidate's own model (`cascade.ts:47`–`50`).
- **Fall through on any thrown error** — bare `catch`, no error-type filtering (`cascade.ts:56`): rate limit, outage, and bad key all advance the chain. Sole exception: if `options?.signal?.aborted` the error rethrows immediately (`cascade.ts:60`) — the tick's wall-clock budget aborted the call, so burning the rest of the budget on more providers would be pointless.
- On success, stamp `res.model = c.model` only when the response carries no model (`cascade.ts:53`–`54`), so the spend counter attributes the call to the model that actually served (§3.6).
- `CascadeOptions.onFallback` (`cascade.ts:20`–`29`) fires once per failed candidate with `{ provider, model, error, next? }` (`next` absent on the final failure); a throwing observer is swallowed (`cascade.ts:69`–`71` — "a buggy observer must never break a tick").
- After all candidates fail, the **last** error is thrown (`cascade.ts:74`).

`cascade.ts` is library core and must not import server modules (header, `cascade.ts:6`–`7`); its only production importer is `packages/backend/src/server/llm.ts`, which builds the candidates (server layer, summarized for context; see [04](04-server-layer.md)): `resolveLLMCandidates` (`llm.ts:47`) pushes, in order, codex (`getApiKeySource() === "codex"`, exec-adapter client, model `cfg.model || "gpt-5.5"` — and `cfg.model` always resolves non-empty, see model defaults in §13), Anthropic (`ANTHROPIC_API_KEY`; model `ANTHROPIC_MODEL || "claude-sonnet-4-20250514"`), OpenRouter (`OPENROUTER_API_KEY`; a stock OpenAI SDK client pointed at `https://openrouter.ai/api/v1` (`llm.ts:27`, env-overridable via `OPENROUTER_BASE_URL`), **one candidate per model** from `OPENROUTER_MODEL || "anthropic/claude-sonnet-4"` plus comma-separated `OPENROUTER_FALLBACK_MODELS`, trimmed and deduped), and OpenAI (`config`/`env` key source — deliberately skipped under the codex source, where `cfg.openaiApiKey` holds the ChatGPT token). With nothing configured it returns a single key-less OpenAI candidate so a clear auth error surfaces on first call (`llm.ts:101`–`111`). `resolveLLM` (`llm.ts:125`) wraps the candidates in `createCascadeLLM` and returns `{ llm, model, chain }` — `model` is the primary candidate's id (the tick's `modelOverride`), `chain` is `"provider/model"` per step for logs. Cascade behavior and resolver ordering are pinned by `packages/backend/tests/unit/llm-cascade.test.ts`.

## 10. Identity (`identity.ts`) and the cofounder prompt (`default-prompt.ts`)

`identity.ts` defines the fixed sentinel UUIDs that let non-agent participants use the a2ax message bus:

| Constant | Value | Meaning |
|---|---|---|
| `COFOUNDER_AGENT_ID` | `00000000-0000-0000-0000-00000000c0f0` | Harmon's bus identity ("c0f0" tail) |
| `DEFAULT_COFOUNDER_NAME` | `"Harmon"` | Overridable per team via `teams.cofounderName` |
| `PRIMARY_USER_AGENT_ID` | `00000000-0000-0000-0000-00000000fffe` | The human founder ("fffe" tail) |
| `PRIMARY_USER_DISPLAY_NAME` | `"You"` | — |
| `USER_AGENT_ID` / `USER_DISPLAY_NAME` | aliases of the two above | Back-compat |
| `COFOUNDER_POV` / `USER_POV` | `"cofounder"` / `"user"` | POV sentinels the messaging APIs translate to UUIDs |

`getTeamHumans(_teamId)` returns the fixed singleton `[{ id: PRIMARY_USER_AGENT_ID, name: "You" }]` (the parameter is ignored; `identity.ts:32`). `resolveCofounderName(name)` returns the trimmed team override or the default (`identity.ts:36`).

`default-prompt.ts` exports the single constant `DEFAULT_META_AGENT_PROMPT` — the planner's system prompt (used as `system`/`instructions` in both planner paths; also re-exported from `planner.ts:185`). Its content, as written: Harmon's identity and **voice rules** (calm authority, first-person singular, short sentences, one question at a time, *no em dashes*, adopt a founder-given name); the conversation job (understand the founder → 1–2 follow-ups → propose a right-sized team → call `spawn_team` when aligned, then `modify_agent` for changes; sub-teams via `parent_team`; leads are made by granting `spawn_sub_team` + `modify_agent`, not a role type); agent anatomy (kebab-case name, free-form archetype, automatic `send_message`/`broadcast`/`report_action`); a **catalog of assignable tools** with risk labels (`read_file`, `write_file`, `run_command`, `coding_task`, `github_api`, `http_fetch`, `observe_app`, `spawn_sub_team`, `modify_agent`); custom tools/connectors paths under `.simple-harmonic/` (`.simple-harmonic/skills/<name>.json`, matching the actual loader in `custom-tools.ts`); the `request_credential` policy (secrets live in Apollo, never agent-readable); the four improvement levels with classification guidance; output contracts; schedule guidance (300/600/1800 s, never 86400); and "2-4 turns before proposing."

## 11. Output contracts (`contract.ts`)

`validateContract(payload, contract)` (`contract.ts:33`) is a Tier-1 structural validator over a simplified JSON Schema: supported keywords are `type`, `properties`, `required`, `items`, `description`; supported types `object | array | string | number | boolean | null` (and `type` may be an array of these, acting as a union). No `$ref`, `allOf/anyOf/oneOf`, `pattern`, etc. Behavior: a `type` mismatch records one issue and stops descending that path; `required` keys must be present and not `undefined`; declared `properties` and `items` recurse; an objectless/`type`-less schema with `properties` (or `items`) infers the expected container type. Returns `{ valid, issues: [{ path, message }] }` with `(root)` for the root path; never throws. The runner attaches the result to completed runs (§3.3), the engine-mode harness applies it identically (§9.3), and the tick handler merges it into the action-log payload (`packages/backend/src/server/api/tick.ts:680`–`687` — the action log is the agent's `actions.jsonl`; see [04](04-server-layer.md)), which `fetchRecentValidations` later reads back into the tick prompt (`tick.ts:62`).

## 12. Eval harness (`eval/`)

**Fixtures (`eval/fixtures.ts`):** `VISION_INPUTS` — 10 founder-vision prompts (`saas-analytics`, `indie-game`, `newsletter`, `open-source`, `consultancy`, `hardware`, `creator`, `local-biz`, `fintech`, `minimal`), each with an advisory `expectAgentsBetween` range used only for logging, not pass/fail. `TOOL_USE_SCENARIOS` — 5 single-correct-tool prompts (`read_file`, `send_message`, `report_action`, `http_fetch`, `broadcast`).

**Validators (`eval/validators.ts`):** pure and unit-tested (`eval-validators.test.ts`), no I/O.

- `validateSpawnResult(spawn, knownTools?)` (`validators.ts:50`) grades a `SpawnTeamResult`. **Errors** (fail): empty team name; zero agents; more than `MAX_AGENTS = 6`; case-insensitive duplicate agent names; empty agent name; missing/`< 10`-char initial prompt; non-numeric schedule; schedule `< 10` s; unknown tool reference (only when `knownTools` provided). **Warnings** (pass): missing role; missing archetype; schedule over 24 h; no tools assigned. `passed` is true iff no error-severity issues.
- `validateToolUse(attempt, registry)` (`validators.ts:164`) grades one `{ toolName, args, expectedTool? }` against a `ToolSchemaLookup` (anything with `get(name) → { schema }`, e.g. a `ToolRegistry`): errors for unknown tool, Zod-invalid args, or wrong tool selection.
- `summarize(reports)` (`validators.ts:197`) → `{ total, passed, failed, passRate }` (passRate 1 for zero reports).

**Runner (`eval/run-eval.ts`):** a manually-invoked live harness, not part of the unit suite — `npx tsx packages/backend/src/lib/meta-agent/eval/run-eval.ts`. Only `main()` does I/O; importing the module is side-effect-free (direct-execution guard at `run-eval.ts:112`). It bails (exit 1) unless `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, then builds `PlannerDeps` straight from env — `apiKeySource: "env"`, model `OPENAI_MODEL || "o4-mini"`, key `OPENAI_API_KEY`, base URL `OPENAI_BASE_URL || "https://api.openai.com/v1"`, plain `fetch` — so it only ever exercises the OpenAI-compatible planner path (the codex path is explicitly not exercised). Note the mismatch: the guard accepts `ANTHROPIC_API_KEY` alone, but the deps never use it, so an Anthropic-only environment passes the guard and then fails every call unless `OPENAI_BASE_URL` points at an OpenAI-compatible Anthropic endpoint. For each vision input it calls the real `plannerStream`; a non-`spawn` result is a `no_spawn` failure, a throw is a `threw` failure, otherwise `validateSpawnResult(result.result, KNOWN_TOOLS)` grades it, where `KNOWN_TOOLS` is the literal 8-name set `send_message, broadcast, report_action, read_file, write_file, run_command, http_fetch, github_api` (`run-eval.ts:22` — deliberately not importing the app registry, and narrower than the 15 actually-registered tools, so a planner that assigns e.g. `observe_app` fails the eval). Exit code: 1 if any input failed, else 0. The tool-use half (`validateToolUse` against `TOOL_USE_SCENARIOS`) is implemented and tested but **not wired into the runner** — `main()` only runs the planner eval.

## 13. Cross-cutting behavior summary

- **Action types the engine produces:** `agent_thought`, `noop`, `multi_action`, `suspended` (runner and the engine-mode harness, which produces the same set); `message_sent`, `broadcast_sent`, any agent-chosen `report_action` type (internal tools); plus server-layer types that flow through the same channel (`api_tool_called` from custom API tools, and the tick handler's `awaiting_approval` log row).
- **Trace event types:** `tick_started`, `llm_request`, `llm_response`, `tool_started`, `tool_finished`, `approval_requested`, `decision_applied`, `tick_finished`, `tick_failed` (`trace.ts:15`; §3.8 — `tick_failed` is emitted by the tick handler, the rest by the runner/harness).
- **Suspension shapes** parked in the agent's `conversationState` field (`agents/<agentId>/agent.json`): the runner's `AgentSuspension` (messages + pending + deferredSafe + actions + round, `runner.ts:56`) and the harness's `CodexThreadSuspension` (`kind: "codex-thread"` + threadId + pending + actions, `codex-harness.ts:60`), discriminated by `isCodexThreadSuspension`.
- **Approval reason codes:** `team_paused`, `agent_paused`, `agent_errored`, `awaiting_approval`, `agent_in_flight`, `not_due`, `destructive_unconfirmed`.
- **Planner result types:** `message`, `spawn`, `modify_agent`, `request_credential`.
- **Model defaults:** runner `o4-mini` (`runner.ts:307`); Anthropic adapter `claude-sonnet-4-20250514` (max_tokens 1024); Codex exec adapter `gpt-5.5`; engine-mode harness `config.model ?? "gpt-5.5"` (`codex-harness.ts:179`, `:219`, `:247`). The app-level default lives in `packages/backend/src/server/config.ts` (`DEFAULTS.model`, `config.ts:32`): the **committed** default is `o4-mini`; an **uncommitted** working-tree edit currently sets it to `gpt-5.5`. With no `simple-harmonic.config.json` on disk (see §7's parked note), `getConfig().model` resolves to `OPENAI_MODEL` or that default (`config.ts:76`) — this feeds the planner, the tick's OpenAI/codex cascade candidates, and the `modelOverride`. Server-layer cascade defaults (`packages/backend/src/server/llm.ts:29`–`33`): codex `gpt-5.5` (fallback literal; in practice `cfg.model` wins), Anthropic `claude-sonnet-4-20250514` (overridable via `ANTHROPIC_MODEL`), OpenRouter `anthropic/claude-sonnet-4` (overridable via `OPENROUTER_MODEL`).
- **Env vars read inside this library:** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (anthropic adapter); full `process.env` passthrough to the `codex` child process (codex exec adapter); `CODEX_HOME` (source for the copied `auth.json`, then overridden to the isolated home for the subprocess, `codex-app-server.ts:266`, `:284`) and `RUST_LOG` (subprocess default `error`, `codex-app-server.ts:285`); `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` (eval runner only). Everything else (e.g. `SH_AGENT_TIMEOUT_MS`, `SH_DAILY_SPEND_CAP_CENTS`, `CRON_SECRET`, `SH_CODEX_RUNTIME`, `SH_TRACE_RETENTION_DAYS`, `OPENAI_*` for the planner/config, `ANTHROPIC_MODEL`, `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODELS`/`OPENROUTER_BASE_URL`) is read by the server layer and injected.

## Python backend (FastAPI port)

The Python port at [`backend-py/`](../backend-py/) re-implements this engine as **slice 7** of an idiomatic FastAPI rewrite that speaks the same HTTP contract as the TS runtime (834 tests, full 43-endpoint parity; see [`backend-py/ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md) and [`backend-py/MIGRATION.md`](../backend-py/MIGRATION.md)). The stack-decision panel scored "raw `anthropic` + `openai` SDKs + custom asyncio orchestration" at 9/10 *precisely because* this chapter's subsystem is the hard part: Pydantic AI (4/10) and LangGraph (3/10) were both rejected on the grounds that they "cannot express the suspend/resume runner, codex harness, or the cascade/spend/approval seams without being fought" ([`ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md) stack-decision table). So the engine is hand-rolled, mirroring the TS module-for-module rather than delegating to a framework.

### Module map

The TS `lib/meta-agent/` library lands as the [`backend-py/simple_harmonic/meta_agent/`](../backend-py/simple_harmonic/meta_agent/) package. The split differs in two places: the **tool registry/default-tools live one slice down** (slice 6, [`simple_harmonic/tools/`](../backend-py/simple_harmonic/tools/)) and are re-exported, and the **three codex TS files collapse into one module** ([`codex_adapter.py`](../backend-py/simple_harmonic/meta_agent/codex_adapter.py), 49 KB — exec adapter + JSON-RPC transport + engine-mode harness together).

| TS (`lib/meta-agent/…`) | Python (`simple_harmonic/…`) | Notes |
|---|---|---|
| `runner.ts` | [`meta_agent/runner.py`](../backend-py/simple_harmonic/meta_agent/runner.py) | `run_agent`, the round-atomic loop, `tool_allowlist`, `summarize`, prompt builders |
| `planner.ts` | [`meta_agent/planner.py`](../backend-py/simple_harmonic/meta_agent/planner.py) | `planner_stream`, both backend paths, the three tool defs |
| `approval.ts` | [`meta_agent/approval.py`](../backend-py/simple_harmonic/meta_agent/approval.py) | `approve_agent_tick` / `approve_agent_action` (pure) |
| `contract.ts` | [`meta_agent/contract.py`](../backend-py/simple_harmonic/meta_agent/contract.py) | `validate_contract` (Tier-1 structural) |
| `types.ts` + the call-frame/wire types scattered across `runner.ts`/`trace.ts`/`codex-harness.ts`/`planner.ts` | [`meta_agent/types.py`](../backend-py/simple_harmonic/meta_agent/types.py) | all shapes consolidated into one types module |
| `anthropic-adapter.ts` | [`meta_agent/anthropic_adapter.py`](../backend-py/simple_harmonic/meta_agent/anthropic_adapter.py) | `create_anthropic_client` |
| `codex-adapter.ts` + `codex-app-server.ts` + `codex-harness.ts` | [`meta_agent/codex_adapter.py`](../backend-py/simple_harmonic/meta_agent/codex_adapter.py) | `CodexAppServerClient`, `run_codex_agent_tick`, `create_codex_app_server_client` (app-server only — exec dropped; the engine is also adapted to an `LLMClient` for the cascade) |
| `cascade.ts` | (slice 5) [`simple_harmonic/llm/`](../backend-py/simple_harmonic/llm/) | the cascade lives with the LLM resolver, not in `meta_agent/` |
| `default-prompt.ts` / `identity.ts` | [`meta_agent/default_prompt.py`](../backend-py/simple_harmonic/meta_agent/default_prompt.py) / [`meta_agent/identity.py`](../backend-py/simple_harmonic/meta_agent/identity.py) | `DEFAULT_META_AGENT_PROMPT`; the cofounder/user sentinels |
| `registry.ts` / `default-tools.ts` / `tools.ts` | [`tools/registry.py`](../backend-py/simple_harmonic/tools/registry.py) / [`tools/default_tools.py`](../backend-py/simple_harmonic/tools/default_tools.py) | reused from slice 6; re-exported through `meta_agent/__init__.py` |
| `index.ts` | [`meta_agent/__init__.py`](../backend-py/simple_harmonic/meta_agent/__init__.py) | public surface; also wires the adapters into the resolver hooks at import |

The `tools.ts` back-compat shims (`AGENT_TOOL_DEFS` / `executeTool`) are **deliberately not ported** — the runner never depended on them, classifying through `registry.is_destructive` and the optional `AgentConfig.isDestructive` predicate instead ([`__init__.py`](../backend-py/simple_harmonic/meta_agent/__init__.py) header). The consumers (§1) map to slice-8/slice-5 Python files: the tick handler is [`simple_harmonic/tick.py`](../backend-py/simple_harmonic/tick.py), the chat SSE handler is [`simple_harmonic/routes/core.py`](../backend-py/simple_harmonic/routes/core.py), and provider resolution is [`simple_harmonic/llm/candidates.py`](../backend-py/simple_harmonic/llm/candidates.py).

### Idiomatic-Python choices for this subsystem

**Two type families, two tools.** [`types.py`](../backend-py/simple_harmonic/meta_agent/types.py) makes an explicit split the TS code gets for free from structural typing:

- **In-process call frames** — `AgentConfig`, `AgentPromptConfig`, `ResumeState`, `AgentRunResult`, `TraceStep` — are `@dataclass`es. They carry live objects (the `LLMClient`, the a2ax bus, an `asyncio.Event` cancellation token, a callable `TraceSink`) and never cross the wire, so Pydantic validation would only add cost.
- **Persisted / wire shapes** — `AgentSuspension`, `CodexThreadSuspension`, `PendingToolCall`, `ToolDecision`, the `PlannerResult` union and its arms — are **Pydantic v2 models** with `ConfigDict(populate_by_name=True)` and **camelCase field names** (`deferredSafe`, `threadId`, `toolArguments`). They round-trip through `agents.conversationState` and the planner HTTP surface untouched, preserving the exact on-disk JSON the TS runtime writes (the two backends share the `.simple-harmonic/data/` tree, so the shapes must match byte-for-byte).

**Zod → Pydantic at the registry seam.** The runner offers `registry.get_openai_defs(allowed)` exactly as in TS; the Zod-schema-to-JSON-Schema conversion (`schemaToParameters`) becomes `schema_to_parameters` over Pydantic's `model_json_schema()`, living in the reused slice-6 [`tools/registry.py`](../backend-py/simple_harmonic/tools/registry.py).

**`AbortSignal` → `asyncio.Event`.** `AgentConfig.signal` is an `asyncio.Event` whose `set()` state means "aborted" — the Python mapping of the TS `AbortSignal`. It is threaded into the LLM call via `CompletionOptions(signal=...)` ([`runner.py`](../backend-py/simple_harmonic/meta_agent/runner.py) `run_agent`, and [`llm/client.py`](../backend-py/simple_harmonic/llm/client.py)); the cascade bails immediately when the signal is already set. Only the in-flight provider call is cancellable — tool executions never see the signal, matching TS.

**`async`/`await` end to end.** `run_agent`, `planner_stream`, and `run_codex_agent_tick` are coroutines; tool execution is `await registry.execute(...)`. The store lock (the project-wide `asyncio.Lock` around every read-modify-write, [risk #1](../backend-py/ARCHITECTURE.md#fidelity-risk-register-load-bearing-behaviors-discovered-during-mapping)) is **not** held inside the engine — the engine is I/O-pure exactly as in TS; it is the tick handler ([`tick.py`](../backend-py/simple_harmonic/tick.py)) and the repos that take the lock when they persist the suspension. The pure approval gate stays pure: [`approval.py`](../backend-py/simple_harmonic/meta_agent/approval.py) has no DB and no SDK, taking structural `Protocol`s (`TeamLike`, `AgentLike`, `ToolCallLike`) so it remains trivially testable.

**Planner backend split + a test seam.** `planner_stream` picks Path A (OpenAI Chat Completions via `AsyncOpenAI`) vs Path B (the Codex-subscription `chatgpt.com/backend-api/codex/responses` SSE endpoint via an injected proxy-aware `fetch_impl`) on `deps.api_key_source == "codex"`, identical to TS. The OpenAI SDK client is built through a pluggable module hook `openai_client_factory` so tests inject a fake streaming client and never touch the network ([`planner.py`](../backend-py/simple_harmonic/meta_agent/planner.py)). The four-arm `PlannerResult` is a Pydantic **discriminated union** on `type` (`Field(discriminator="type")`, [`types.py`](../backend-py/simple_harmonic/meta_agent/types.py)).

### Load-bearing fidelity behaviors preserved

These are the traps from the risk register ([`ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md#fidelity-risk-register-load-bearing-behaviors-discovered-during-mapping)) that belong to this chapter:

- **Round-atomic suspend (risk #18).** `run_agent` scans the whole round's tool calls for any destructive one *before executing anything that round*; the first destructive batch ends the tick early, returning the full serialized conversation plus the pending call(s) with **nothing destructive run** ([`runner.py`](../backend-py/simple_harmonic/meta_agent/runner.py), the ROUND-ATOMIC block). Safe calls from the same assistant turn go into `AgentSuspension.deferredSafe` and run after resume so every `tool_call` still gets a result. On resume, `_ordered_resume_calls` walks the **last assistant message's `tool_calls` in issue order**, classifying each id as pending-destructive or deferred-safe (unmatched ids appended defensively), so resume produces exactly one tool-result message per call in the model's original order. The MIGRATION note records that the verifier specifically *strengthened* the round-atomic ordering test during the port.
- **Two suspension shapes, one field (risk #18).** `AgentSuspension` (message transcript + pending + deferredSafe + actions + round) and `CodexThreadSuspension` (`kind="codex-thread"` + `threadId` + pending + actions, no transcript) both park in `agents.conversationState`, disambiguated **only** by `is_codex_thread_suspension(value)` — `kind == "codex-thread"` and a `str` `threadId` ([`types.py`](../backend-py/simple_harmonic/meta_agent/types.py)).
- **Unknown tool ⇒ destructive, fail-safe (risk #19).** The classifier holds unregistered names for approval; `approve_agent_action`'s default classifier (`_hold_everything`) holds *everything* when no registry vouches ([`approval.py`](../backend-py/simple_harmonic/meta_agent/approval.py)).
- **`FALLBACK_TOOL_NAMES` (risk #20).** `["send_message", "broadcast", "report_action"]` are force-added to every agent's allowlist by `tool_allowlist`, which is order-stable and deduped (fallbacks first) and **shared with the codex harness** ([`runner.py`](../backend-py/simple_harmonic/meta_agent/runner.py)).
- **Malformed-JSON self-correction (D10).** `_run_tool_call` returns the malformed-args error string to the model rather than raising; the destructive scan and trace parse args with `_parse_tool_args` returning `None` on bad JSON; an unmatched/undecided pending call on resume defaults to **rejected** (fail-safe), emitting the same `"Action not approved: … Do not retry it; continue with other work or stop."` note.
- **Fire-and-forget trace.** The runner's `emit` wraps every sink call in `contextlib.suppress(Exception)` ("a buggy sink must never break a tick"); the 9 `TraceEventType` literals and the `tick_finished`-not-on-suspend rule are preserved, and the harness emits the same step types with `round` always `0` plus `runtime: "codex-app-server"`.
- **Planner arm-on-JSON-validity.** The TS planner selects the `spawn`/`modify_agent` arm on a *bare* `JSON.parse(...) as T` cast — no shape check — so a tool call that parses but omits e.g. `team_name` still yields the spawn arm. `_try_parse` reproduces this exactly: it tries strict `model_validate`, and on validation failure falls back to `model_construct` over the known fields (no validation), only degrading to a `message` when the payload isn't even an object ([`planner.py`](../backend-py/simple_harmonic/meta_agent/planner.py); the `SpawnTeamResult.team_name` / `ModifyAgentResult` defaults of `""` in [`types.py`](../backend-py/simple_harmonic/meta_agent/types.py) exist solely to keep nested agents strictly typed while tolerating the absent top-level field).
- **Anthropic model-id attribution (risks #14/#15).** The Anthropic adapter echoes the served `model` and the cascade stamps it when absent, so the spend counter attributes the call correctly — the cascade itself lives in slice 5 ([`llm/candidates.py`](../backend-py/simple_harmonic/llm/candidates.py)), and the adapters are wired into the resolver's provider hooks at import time by [`wiring.py`](../backend-py/simple_harmonic/meta_agent/wiring.py) (`codex_client_factory` → `create_codex_client`, `anthropic_client_factory` → `create_anthropic_client`), mirroring the TS `server/llm.ts` importing the adapter constructors.

### Deferred / known divergences

One divergence touches this chapter directly, and it is intentional and non-correctness ([`MIGRATION.md`](../backend-py/MIGRATION.md) "Deferred / known divergences"):

- **The codex app-server harness *resume* path is not ported.** The fresh engine-mode tick (`run_codex_agent_tick`) and its transport, dynamic-tool registration, destructive-park-and-interrupt, real token-usage summation, and the `[Approval outcomes]` resume turn are all implemented in [`codex_adapter.py`](../backend-py/simple_harmonic/meta_agent/codex_adapter.py). But on **resume**, a parked `codex-thread` tick is routed back through the legacy runner: the tick handler validates `suspension_raw` as an `AgentSuspension` and calls `run_agent`, never `thread/resume` ([`tick.py`](../backend-py/simple_harmonic/tick.py) `_try_resume_agent`, with the explicit comment that "the codex app-server resume path is not ported to Python yet … a parked tick always resumes through the runner"). `use_codex_harness` is computed and stored for parity but **unread** on the resume path. The load-bearing HOLD/resume/deny trichotomy of the legacy-runner resume — the part this chapter's approval lifecycle (§4) hinges on — *is* fully ported and tested.

Other slice-8/cross-cutting divergences (per-team agents run sequentially with `await` rather than `Promise.allSettled`; LLM resolution is lazy-on-first-run rather than eager-at-top-of-POST, because the Python OpenAI SDK raises at client *construction* without a key; SSE teardown via async-generator `GeneratorExit`) are documented in [`MIGRATION.md`](../backend-py/MIGRATION.md) and are latency/plumbing gaps, not behavior changes — the agent-claim compare-and-set remains the double-run guard.
