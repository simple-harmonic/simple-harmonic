# Reference — meta-agent engine (`packages/backend/src/lib/meta-agent/`)

This library is the NPM-extractable core of Simple Harmonic's agent engine: the tick runner (`runAgent`), the codex app-server engine mode (`codex-app-server.ts` transport + `codex-harness.ts` harness), the cofounder chat planner (`plannerStream`), the tool registry, the approval gate, the output-contract validator, the play-by-play trace contract (`trace.ts`), the multi-provider cascade client (`cascade.ts`), the cofounder/user identity sentinels, and two `LLMClient` adapters (Anthropic SDK, Codex CLI exec). It performs no DB or app I/O itself — the app injects a2ax, tool registries, LLM clients, trace sinks, and fetch implementations from `packages/backend/src/server/`. 17 modules plus `eval/` (3 files), 3,944 lines total.

The tick entry point lives at `packages/backend/src/server/api/tick.ts`; the Next route `src/app/api/tick/route.ts` is a 2-line re-export (same pattern for chat). The LLM client an agent tick receives is the provider cascade from `resolveLLM()` (`packages/backend/src/server/llm.ts:125`), and codex-provider agents bypass `runAgent` entirely for `runCodexAgentTick` (engine mode) unless `SH_CODEX_RUNTIME=exec`.

**Parked: the skills-directory migration (stash@{0}).** An uncommitted migration once layered directory-based skills onto this library: `SKILL.md` directory skills loaded by the custom-tools loader, a sub-skill tree on the registry (`subSkills`/`expandAllowlist`/`visibleTools`), progressive disclosure in the runner (`openSkills`/`surfaced` sets, a `close_skills` internal tool), and an `agents.open_skills` column. That code was discarded on 2026-06-11 and exists **nowhere in the repo** — `grep` for `subSkills`, `expandAllowlist`, `visibleTools`, `openSkills`, or `close_skills` returns zero hits. Only its untracked data files survive, parked in git `stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees and `packages/backend/tests/unit/skill-tree.test.ts`. Custom tools load from flat JSON files (`.simple-harmonic/skills/<name>.json`, `packages/backend/src/server/custom-tools.ts:27`), and there are exactly 15 built-in tools — 3 internal + 12 app — pinned by `packages/backend/tests/unit/server-tools.test.ts:400`.

```
POST /api/tick ──► packages/backend/src/server/api/tick.ts   (Next route = 2-line re-export)
      │
      ├─ approveAgentTick(team, agent)         gate: paused / errored / in-flight / not due
      ├─ resolveLLM({onFallback})              cascade: codex > anthropic > openrouter > openai
      ├─ createTraceSink(...)                  play-by-play sink → traceEvents repo (per-agent trace.jsonl)
      │
      ├─ apiKeySource === "codex" && SH_CODEX_RUNTIME !== "exec"
      │     └──► runCodexAgentTick(config) ─── codex-harness.ts (engine mode: codex owns
      │            the loop; SH tools are dynamicTools executed over JSON-RPC)
      ▼
  runAgent(config)  ──────────────────────────── runner.ts
      │
      ├─ registry.getOpenAIDefs(toolAllowlist(tools))   computed once ──► `tools` param
      ├─ config.llm.chat.completions.create(...)        LLMClient: the cascade
      │       (anthropic-adapter | codex-adapter | OpenAI SDK steps), wrapped
      │       per-run by makeCountingLLM
      ├─ trace: tick_started / llm_request / llm_response / tool_* / tick_finished
      │
      ├─ isDestructive(name, args)?
      │     ├─ safe ───► registry.execute(name, args, ctx) ──► ToolImpl
      │     │              (default-tools internal tools + server/tools/* app tools)
      │     └─ destructive ──► SUSPEND: AgentRunResult{actionType:"suspended", suspension}
      │                         tick handler parks AgentSuspension on the agent row + writes approvals.json;
      │                         later tick: runAgent({resume:{suspension, decisions}})
      ▼
  AgentRunResult ── validateContract(payload, outputContract) when contract set

POST /api/chat ──► packages/backend/src/server/api/chat.ts
      │  buildPlannerDeps() ──► PlannerDeps
      ▼
  plannerStream(messages, onToken, deps) ─────── planner.ts
      ├─ apiKeySource === "codex" ─► codexResponsesStream (SSE over chatgpt.com)
      └─ else ─────────────────────► openaiChatStream (OpenAI SDK streaming)
              │ both accumulate text + one tool call
              ▼
          finalize(text, toolName, toolArgs) ──► PlannerResult:
              message | spawn(SpawnTeamResult) | modify_agent | request_credential
```

---

## `packages/backend/src/lib/meta-agent/index.ts`

Barrel module (re-exports only, no logic; 35 lines). Exports the public surface: `validateContract`, `plannerStream`, `DEFAULT_META_AGENT_PROMPT`, `runAgent`, `AGENT_TOOL_DEFS`, `executeTool`, `ToolRegistry`, `schemaToParameters`, `createDefaultRegistry`, `approveAgentAction`, `approveAgentTick`, plus the types from `planner`, `contract`, `runner`, `tools`, `registry`, `approval`, `trace` (`TraceEventType`, `TraceSink`, `TraceStep` at `index.ts:7`), and `types` (`OpenAIToolDef` at `index.ts:35`).

Notable omissions: `identity.ts`, `anthropic-adapter.ts`, `codex-adapter.ts`, `cascade.ts`, `codex-app-server.ts`, `codex-harness.ts`, and everything under `eval/` are **not** re-exported here — consumers deep-import them (`server/llm.ts:17-24` imports the adapters and `./cascade`, `server/api/settings/test-llm.ts:1` imports `./cascade`, `server/api/tick.ts:2-6` imports `./codex-harness`). The runner's prompt/loop pieces (`AgentPromptConfig`, `buildSystemPrompt`, `buildTickPrompt`, `toolAllowlist`, `summarize`) and suspension types (`PendingToolCall`, `AgentSuspension`, `ToolDecision`, `ResumeState`) are likewise deep-import-only (`codex-harness.ts:38-46`, `server/api/tick.ts:7-12`).

- **Called by:** `packages/backend/src/server/api/tick.ts:1`, `packages/backend/src/server/api/chat.ts:1-2`, `packages/frontend/src/components/chat/approval-card.tsx:4`, `packages/frontend/src/components/chat/use-chat.ts:4`, `src/app/(app)/new/page.tsx:3`, `packages/backend/tests/unit/meta-agent-index.test.ts`

---

## `packages/backend/src/lib/meta-agent/types.ts`

Single shared wire-format type. The runner speaks an OpenAI-shaped chat.completions convention; the adapters translate from this shape so they cannot drift from each other.

### `OpenAIToolDef` — `packages/backend/src/lib/meta-agent/types.ts:11`

OpenAI-style function/tool definition passed in the `tools` array of an LLM call.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"function"` | Literal discriminator. |
| `function.name` | `string` | Tool name the model calls. |
| `function.description` | `string?` | Shown to the model. |
| `function.parameters` | `Record<string, unknown>?` | JSON Schema for the arguments. |

- **Used by:** `registry.ts:25` (`getOpenAIDefs`, registry.ts:112), `anthropic-adapter.ts:9` (`convertTools`), `codex-adapter.ts:12` (`buildCodexPrompt`), re-exported at `index.ts:35`. Also consumed structurally by `codex-harness.ts:229-233`, which maps `registry.getOpenAIDefs(...)` output to the codex `dynamicTools` shape (`{name, description, inputSchema}`). No consumers outside the library.

---

## `packages/backend/src/lib/meta-agent/contract.ts`

Tier-1 structural output-contract validation. A contract is a simplified JSON Schema (keywords: `type`, `properties`, `required`, `items`, `description`; types: object, array, string, number, boolean, null). No `$ref`/`allOf`/`anyOf`/`oneOf`/`pattern`. Never throws.

### `ContractIssue` — `packages/backend/src/lib/meta-agent/contract.ts:15`

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Dotted/indexed location of the problem (`"(root)"` for top level). |
| `message` | `string` | Human-readable problem description. |

### `ValidationResult` — `packages/backend/src/lib/meta-agent/contract.ts:20`

| Field | Type | Meaning |
|---|---|---|
| `valid` | `boolean` | True iff `issues` is empty. |
| `issues` | `ContractIssue[]` | Every structural mismatch found. |

- **Used by:** `runner.ts:31` (import; `AgentRunResult.validation` at runner.ts:150), `codex-harness.ts:47` (import; `CodexHarnessResult.validation` at codex-harness.ts:73), the tick handler's structural `RunOutcome.validation` (`packages/backend/src/server/api/tick.ts:383`).

### `validateContract(payload: unknown, contract: Record<string, unknown>): ValidationResult` — `packages/backend/src/lib/meta-agent/contract.ts:33`

Entry point: runs the recursive `validate` against the payload starting at the empty path and wraps the accumulated issues in a `ValidationResult`. Pure, no side effects, never throws.

- **Calls:** `validate`
- **Called by:** `runner.ts:405` (`runAgent`, when `config.outputContract` is set), `codex-harness.ts:310` (`runCodexAgentTick`); tests `packages/backend/tests/unit/contract.test.ts`

### `validate(value, schema: SchemaNode, path, issues): void` (non-exported) — `packages/backend/src/lib/meta-agent/contract.ts:42`

Recursive worker. If `schema.type` is set (string or string array), compares against `typeOf(value)` and records a mismatch (then stops descending that branch). For object schemas (explicit `type: "object"` or inferred from `properties`): checks each `required` key exists and is not `undefined`, then recurses into declared `properties` that are present. For array schemas (explicit or inferred from `items`): recurses `items` against every element with `path[i]` paths. Untyped non-object/non-array values under an inferred schema record an `expected object/array` issue. Returns nothing; mutates `issues`.

- **Calls:** itself, `typeOf`
- **Called by:** `validateContract`

### Internal helpers

- `SchemaNode` (interface, line 25) — the subset of JSON Schema the validator understands (`type`, `properties`, `required`, `items`, `description`).
- `typeOf(value: unknown): string` (line 108) — `typeof` with `null` → `"null"` and arrays → `"array"`.

---

## `packages/backend/src/lib/meta-agent/runner.ts`

The agent tick runner (647 lines). A tick is a multi-round tool-use loop with the resumable-conversation model (D17): safe tools run inline; the first destructive call suspends the whole tick, serializing the conversation as an `AgentSuspension` for the caller to persist. On a later tick the caller passes `resume: { suspension, decisions }` and the loop continues. Every observable step is mirrored to an optional `TraceSink` (play-by-play traces). The prompt/loop pieces the codex harness shares (`AgentPromptConfig`, `buildSystemPrompt`, `buildTickPrompt`, `toolAllowlist`, `summarize`) are exported; codex-provider agents normally bypass `runAgent` entirely for `runCodexAgentTick` (see `codex-harness.ts`).

### `FALLBACK_TOOL_NAMES: string[]` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:42`

`["send_message", "broadcast", "report_action"]`. The internal tools every agent always gets regardless of its configured allowlist; merged in by `toolAllowlist`.

- **Used by:** `toolAllowlist` (runner.ts:449)

### `PendingToolCall` — `packages/backend/src/lib/meta-agent/runner.ts:45`

A tool call the LLM asked for, in OpenAI wire shape.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The LLM's tool-call id; matched against `ToolDecision.id` and the `toolCallId` field on each `approvals.json` entry (the `PendingApproval` row, `store/types.ts:49`). |
| `name` | `string` | Tool name. |
| `arguments` | `string` | Raw JSON arguments string exactly as emitted by the LLM. |

- **Used by:** `AgentSuspension`, `runToolCall`, `tracedToolCall` (runner.ts:211), `orderedResumeCalls`; `CodexThreadSuspension.pending` (codex-harness.ts:64) and the tick handler's structural `RunOutcome.suspension` (`packages/backend/src/server/api/tick.ts:382`); the persisted analogue is the `toolCallId` field on a `PendingApproval` row (`store/types.ts:49`); tests `runner-resume.test.ts`

### `AgentSuspension` — `packages/backend/src/lib/meta-agent/runner.ts:56`

Opaque-to-callers serialized conversation at the point of suspension. Plain JSON; persisted verbatim (the tick handler parks it on the agent row's `conversationState` blob via `agents.update`, `tick.ts:654`) and handed back on resume.

| Field | Type | Meaning |
|---|---|---|
| `messages` | `Array<Record<string, unknown>>` | Full OpenAI-format message list up to and including the assistant turn whose tool calls triggered the suspension. |
| `pending` | `PendingToolCall[]` | Destructive calls awaiting a human decision. |
| `deferredSafe` | `PendingToolCall[]?` | Safe calls from the same assistant turn, deferred so every call gets a tool result on resume. |
| `actions` | `ToolResult[]` | Actions already logged this tick before suspension. |
| `round` | `number` | Loop round at suspension; resume continues at `round + 1`. |

This is no longer the only suspension shape parked in `agents.conversationState` — engine-mode ticks park a `CodexThreadSuspension` instead, discriminated by `isCodexThreadSuspension` (see `codex-harness.ts`).

- **Used by:** the legacy resume branch at `packages/backend/src/server/api/tick.ts:490-493,577` (`suspension as AgentSuspension`); parked opaquely in the `Agent.conversationState` blob (`store/types.ts:45`); tests `runner-resume.test.ts`, `runner-trace.test.ts:2`

### `ToolDecision` — `packages/backend/src/lib/meta-agent/runner.ts:71`

Human decision for one pending tool call, supplied on resume.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Matches `PendingToolCall.id`. |
| `approved` | `boolean` | Whether the human approved the call. |
| `note` | `string?` | Optional note shown to the LLM (e.g. rejection reason). |

- **Used by:** built from each agent's `approvals.json` rows (read via `approvals.byAgent`, `tick.ts:471`) at `packages/backend/src/server/api/tick.ts:482` (`tryResumeAgent`); also consumed by the harness resume path (`codex-harness.ts:44,90,187`).

### `ResumeState` — `packages/backend/src/lib/meta-agent/runner.ts:79`

| Field | Type | Meaning |
|---|---|---|
| `suspension` | `AgentSuspension` | The persisted conversation. |
| `decisions` | `ToolDecision[]` | One decision per pending call. |

- **Used by:** `AgentConfig.resume`; constructed inline in the legacy resume branch (`packages/backend/src/server/api/tick.ts:577`) — the harness has its own resume shape on `CodexHarnessConfig`.

### `AgentConfig` — `packages/backend/src/lib/meta-agent/runner.ts:84`

The full input to `runAgent`.

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Agent display name; appears in prompts and payloads. |
| `archetype` | `string` | Free-form archetype label, injected into the system prompt. |
| `tools` | `string[]` | Configured tool allowlist (fallback tools are merged in automatically). |
| `initialPrompt` | `string` | The agent's own system prompt, leading the composed system message. |
| `a2axContext` | `string?` | Formatted a2ax message block (messages since last tick). |
| `recentHistory` | `string?` | Last-N-ticks action history for working memory. |
| `teamId` | `string` | Team identity for tool execution. |
| `agentId` | `string` | Agent identity for tool execution. |
| `peers` | `PeerAgent[]` | Other agents in the team. |
| `a2ax` | `A2AXSender` | Injected message bus. |
| `llm` | `LLMClient` | OpenAI-compatible client (the cascade, wrapped by `makeCountingLLM`). |
| `model` | `string?` | Model id; the runner's own fallback is the literal `"o4-mini"` (runner.ts:312). The tick handler always passes the cascade's primary model (`modelOverride`, tick.ts:435), which resolves from server config — committed default `o4-mini`, currently `gpt-5.5` via an uncommitted `packages/backend/src/server/config.ts` edit; with no config file on disk, env `OPENAI_MODEL` or that default. |
| `signal` | `AbortSignal?` | Tick-budget abort signal, forwarded to provider calls. |
| `isDestructive` | `((toolName, rawArgs?) => boolean)?` | Approval classifier; defaults to `registry.isDestructive`. |
| `toolRegistry` | `Pick<ToolRegistry, "execute" \| "getOpenAIDefs" \| "isDestructive" \| "listForAgent">?` (runner.ts:115) | Tool registry; defaults to the internal message-passing registry. |
| `teamGoal` | `string?` | Injected into the tick prompt. |
| `outputContract` | `Record<string, unknown>?` | JSON Schema; result validated against it when present. |
| `recentValidations` | `string?` | Recent pass/fail strings, injected so the agent self-corrects. |
| `appHealthContext` | `string?` | Recent app events (errors/warnings) for the team. |
| `resume` | `ResumeState?` | When present, reconstructs the suspended conversation instead of starting fresh. |
| `trace` | `TraceSink?` (runner.ts:140) | Optional play-by-play sink; one step per LLM round, tool call, approval pause, and tick boundary. Sink failures never break a tick. |

- **Used by:** filled by the `shared` config object in `packages/backend/src/server/api/tick.ts` (fresh `:420`, resume `:540`, with `trace: trace.emit` from `createTraceSink`); tests `runner.test.ts:2,36`, `runner-trace.test.ts:2`

How the tick handler fills it: the fresh path (`tick.ts:420-439`) passes every optional context field (`a2axContext`, `recentHistory`, `teamGoal`, `outputContract`, `recentValidations`, `appHealthContext`); the resume path (`tick.ts:540-554`) passes only `recentHistory` plus the identity/plumbing fields and `resume` — no a2ax context is gathered, and the missing `outputContract` means resumed completions skip contract validation.

### `AgentRunResult` — `packages/backend/src/lib/meta-agent/runner.ts:143`

| Field | Type | Meaning |
|---|---|---|
| `actionType` | `string` | `"suspended"` when paused for approval; otherwise the tick's action type (`noop`, `agent_thought`, `multi_action`, or a single action's type). |
| `payload` | `Record<string, unknown>` | Always present (back-compat); summarized actions or `{agent, pending}` when suspended. |
| `suspension` | `AgentSuspension?` | Present iff the tick suspended. |
| `validation` | `ValidationResult?` | Present only when `config.outputContract` was passed and the run completed — never on a suspension, and never on resume (the tick handler does not re-pass the contract). |

The type doubles as `summarize`'s return type, so the codex harness produces identical action summaries (`codex-harness.ts:299`); the tick handler reads it structurally via `RunOutcome` (`packages/backend/src/server/api/tick.ts:379-384`).

- **Used by:** `packages/backend/src/server/api/tick.ts:684` (`handleRunResult` parks/clears state, writes the action log, and parks `traceTickId` alongside the suspension)

### `LLMClient` — `packages/backend/src/lib/meta-agent/runner.ts:154`

Minimal OpenAI-compatible chat client interface: `chat.completions.create(params, options?: { signal? }) => Promise<LLMResponse>`.

| Field | Type | Meaning |
|---|---|---|
| `chat.completions.create` | `(params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<LLMResponse>` | The single method the runner calls; params carry `model`, `messages`, `tools`. |

- **Used by:** `anthropic-adapter.ts:8` and `codex-adapter.ts:11` (both implement it), `createCascadeLLM` (`cascade.ts:10,39`), `packages/backend/src/server/spend.ts:10` (`makeCountingLLM` at spend.ts:128 wraps it to count tokens), resolved per tick via `resolveLLM` (`packages/backend/src/server/llm.ts:24,125`)

### `LLMResponse` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:165`

| Field | Type | Meaning |
|---|---|---|
| `choices[].message.content` | `string \| null` | Assistant text. |
| `choices[].message.tool_calls` | `Array<{id, function: {name, arguments}}>?` | Requested tool calls (args as JSON string). |
| `choices[].finish_reason` | `string` | `"stop"` ends the loop after executing the round's calls. |

### `MAX_TOOL_ROUNDS = 3` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:178`

Hard cap on LLM round-trips per tick (a resume restarts counting at `suspension.round + 1`, so a suspended round still counts).

### `defaultRegistry` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:179`

Module-level `createDefaultRegistry()` instance used when `config.toolRegistry` is omitted (internal tools only).

### `runAgent(config: AgentConfig): Promise<AgentRunResult>` — `packages/backend/src/lib/meta-agent/runner.ts:181`

The tick entry point. Control flow:

1. Resolves the registry (`config.toolRegistry ?? defaultRegistry`), then computes `toolDefs = registry.getOpenAIDefs(toolAllowlist(config.tools))` and `toolDescriptions = registry.listForAgent(allowedTools)` **once** (runner.ts:183-185) — every LLM round sees the same tool list. Resolves the destructive classifier (`config.isDestructive ?? registry.isDestructive`) and builds the `ToolRunContext` (runner.ts:188).
2. Sets up the trace helpers (`emit`, `tracedToolCall`, `finish`, below) and emits `tick_started {mode, round}` (runner.ts:254).
3. **Resume path** (runner.ts:259): restores `messages`/`actions`, sets `startRound = suspension.round + 1`, then walks `orderedResumeCalls(suspension)`: emits `decision_applied` per pending call (runner.ts:271); approved destructive calls and deferred safe calls run via `tracedToolCall`; rejected calls get a `toolMessage` of "Action not approved: <note> Do not retry it…". **Fresh path** (runner.ts:296): seeds `messages` with `buildSystemPrompt` + `buildTickPrompt`.
4. Loops rounds `startRound..MAX_TOOL_ROUNDS`: emits `llm_request {round, model, messageCount}` (runner.ts:305), calls `config.llm.chat.completions.create({model: config.model || "o4-mini", messages, tools: toolDefs}, {signal})` (runner.ts:311), then emits `llm_response {round, thought, toolCalls, finishReason, durationMs}` (runner.ts:323). Text-only response with zero accumulated actions returns `{actionType: "agent_thought"}` immediately (via `finish`, runner.ts:337); with actions it breaks to summarize. Otherwise the assistant turn (with tool_calls) is appended to `messages`.
5. Classifies all of the round's calls with `isDestructive(name, parseToolArgs(args))` (runner.ts:360). If any are destructive, emits `approval_requested {round, pending, deferredSafeCount}` (runner.ts:363) and returns `actionType: "suspended"` **before executing anything in that round** — the suspension carries `messages`, `pending` (destructive), `deferredSafe` (the rest), `actions`, and `round`. A suspension returns **without** `tick_finished` so the trace thread reads as still-open until resume. Otherwise every call executes inline via `tracedToolCall` (runner.ts:395); `finish_reason === "stop"` breaks the loop.
6. After the loop: `summarize(name, actions)` (runner.ts:402), attaches `validateContract(result.payload, config.outputContract)` when a contract is set (runner.ts:405), and returns via `finish` (emits `tick_finished`, runner.ts:408).

Errors from the LLM call or tool impls propagate to the caller (the tick handler wraps in `withTimeout` and `failAgent`, which emits `tick_failed` — `packages/backend/src/server/api/tick.ts:645`); malformed tool-call JSON does not throw (handled in `runToolCall`). Every sink call goes through `emit`, which try/catches so a buggy sink never breaks a tick (covered by `runner-trace.test.ts`).

- **Calls:** `toolAllowlist`, `ToolRegistry.getOpenAIDefs`, `ToolRegistry.listForAgent`, `ToolRegistry.isDestructive` (default), `buildSystemPrompt`, `buildTickPrompt`, `orderedResumeCalls`, `tracedToolCall` → `runToolCall`, `emit`, `finish`, `toolMessage`/`toolResultMessage`, `toPendingToolCall`, `parseToolArgs`, `summarize`, `validateContract`
- **Called by:** `packages/backend/src/server/api/tick.ts:455` (fresh, non-harness branch) and `:573` (resume of legacy message-based suspensions); tests `packages/backend/tests/unit/runner.test.ts`, `runner-resume.test.ts`, `runner-trace.test.ts:3`, mocked in `api-tick.test.ts:112`

### `emit(type: TraceEventType, data: Record<string, unknown>): void` (non-exported closure) — `packages/backend/src/lib/meta-agent/runner.ts:203`

Per-run trace emitter inside `runAgent`: wraps `config.trace?.({type, data})` in try/catch so a throwing sink can never break a tick. Every trace step the runner produces flows through it.

- **Calls:** `config.trace` (the injected `TraceSink`)
- **Called by:** `runAgent` (tick_started :254, llm_request :305, llm_response :323, approval_requested :363, decision_applied :271), `tracedToolCall` (:212/:221/:230), `finish` (:242)

### `tracedToolCall(call: PendingToolCall, round: number): Promise<RunToolOutcome>` (non-exported closure) — `packages/backend/src/lib/meta-agent/runner.ts:211`

Wraps one tool execution in `tool_started` / `tool_finished` trace steps: emits `tool_started {round, toolCallId, tool, args}` (args re-parsed via `parseToolArgs`, raw string on parse failure), runs `runToolCall`, then emits `tool_finished` with `result` and `durationMs` on success or `error` and `durationMs` on throw (rethrowing the error). Used at all three execution sites: resume-approved calls (:278), resume deferred-safe calls (:290), and the main-loop inline round (:395).

- **Calls:** `emit`, `runToolCall`, `parseToolArgs`
- **Called by:** `runAgent` (runner.ts:278, :290, :395)

### `finish(result: AgentRunResult): AgentRunResult` (non-exported closure) — `packages/backend/src/lib/meta-agent/runner.ts:241`

Emits the terminal `tick_finished {actionType, actionCount, durationMs, validation?}` step and passes the result through. Called only on completed ticks (agent_thought early return :337 and the post-loop return :408) — a suspension returns directly so the thread reads as still-open until resume.

- **Calls:** `emit`
- **Called by:** `runAgent` (runner.ts:337, :408)

### `runToolCall(call, ctx, actions, registry): Promise<RunToolOutcome>` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:426`

Parses `call.arguments` as JSON; on `SyntaxError` returns an error string instructing the LLM to retry with valid JSON (D10 self-correction — never throws). On success calls `registry.execute(call.name, args, ctx)`, pushes `result.action` into `actions` if present, and returns `{content: result.result}`.

- **Calls:** `JSON.parse`, `ToolRegistry.execute`
- **Called by:** `tracedToolCall` (runner.ts:220)

### `orderedResumeCalls(suspension): Array<{call: PendingToolCall; needsApproval: boolean}>` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:471`

Reconstructs the original call order for the suspended assistant turn so every `tool_call` gets its result in sequence: finds the last assistant message with `tool_calls` in the suspension, maps each id to either a pending (needsApproval=true) or deferred-safe (false) call, then appends any pending/deferred calls that weren't matched (defensive, preserves all calls even if the message list was tampered with).

- **Calls:** Map/Set operations only
- **Called by:** `runAgent` (runner.ts:268)

### `summarize(agentName, actions: ToolResult[]): AgentRunResult` — `packages/backend/src/lib/meta-agent/runner.ts:518`

Collapses accumulated actions into the tick's return value: zero → `{actionType: "noop"}`; one → that action's type with payload merged under `{agent, ...payload}`; many → `{actionType: "multi_action", payload: {agent, actions: [{type, ...payload}]}}`. Exported so the codex harness produces identical action summaries without going through `runAgent`.

- **Called by:** `runAgent` (runner.ts:402); `runCodexAgentTick` (codex-harness.ts:299)

### `ENGINEERING_TOOLS: Set<string>` (non-exported) — `packages/backend/src/lib/meta-agent/runner.ts:543`

`{"read_file", "write_file", "run_command", "coding_task"}`. Any agent whose allowlist intersects this set gets `ENGINEERING_CONTEXT` (read-before-modify, delegate complex work to `coding_task`, destructive actions need approval, browse `.simple-harmonic/skills/` and `.simple-harmonic/connectors/`) appended to its system prompt. Deliberately not archetype-based: code tools imply code guidance.

- **Used by:** `buildSystemPrompt` (runner.ts:583)

### `AgentPromptConfig` — `packages/backend/src/lib/meta-agent/runner.ts:560`

`Pick<AgentConfig, "name" | "archetype" | "tools" | "initialPrompt" | "peers" | "teamGoal" | "recentHistory" | "recentValidations" | "outputContract" | "a2axContext" | "appHealthContext">` — the subset of `AgentConfig` the prompt builders read, extracted so the codex harness can satisfy it without constructing an `LLMClient`.

- **Used by:** `buildSystemPrompt`/`buildTickPrompt` parameter types (runner.ts:577, :607); extended by `CodexHarnessConfig` (codex-harness.ts:78)

### `buildSystemPrompt(config: AgentPromptConfig, tools: Array<{name, description}>): string` — `packages/backend/src/lib/meta-agent/runner.ts:577`

Composes the system message: `config.initialPrompt`, identity line (`You are "<name>", a <archetype> agent in a team.`), peer list, the passed tool list with descriptions (the full `listForAgent` allowlist), the engineering context when applicable, coordination guidance, and the improvement-levels rubric (agent/team/tool/infra) with reporting instructions.

- **Called by:** `runAgent` (runner.ts:298, fresh ticks only — resumed conversations already contain it); `runCodexAgentTick` (codex-harness.ts:228, injected as the codex thread's `developerInstructions`)

### `buildTickPrompt(config: AgentPromptConfig): string` — `packages/backend/src/lib/meta-agent/runner.ts:607`

Composes the user message for the tick: base "A new tick has fired" line, then conditional sections in order — team goal, recent actions (continuity), recent validation results ("Fix any failing validations"), the output contract pretty-printed with "Use report_action with a payload matching this schema", the a2ax context (or "No new messages from other agents."), and the app-health block with per-level response instructions (agent/team/tool, platform DEGRADED/MAINTENANCE, known tool issues) plus a pointer to `observe_app`.

- **Called by:** `runAgent` (runner.ts:299); `runCodexAgentTick` (codex-harness.ts:239, as the fresh thread's `turn/start` input text)

### `toolAllowlist(tools: string[]): string[]` — `packages/backend/src/lib/meta-agent/runner.ts:448`

Dedup union of `FALLBACK_TOOL_NAMES` and the configured list — the guarantee that every agent always has the internal message-passing tools. Exported so the codex harness builds the same allowlist.

- **Called by:** `runAgent` (runner.ts:183); `runCodexAgentTick` (codex-harness.ts:136)

### Internal helpers

- `RunToolOutcome` (interface, line 416) — `{content: string}`, the result of running or failing to parse one call.
- `toPendingToolCall(tc)` (line 452) — flattens an OpenAI tool_call into a `PendingToolCall`.
- `parseToolArgs(raw: string): unknown` (line 463) — `JSON.parse` returning `undefined` on failure; feeds `isDestructive` arg-aware classifiers and the trace steps' parsed `args`.
- `toolResultMessage(toolCallId, outcome)` (line 508) — `toolMessage` over a `RunToolOutcome.content`.
- `toolMessage(toolCallId, content)` (line 512) — `{role: "tool", tool_call_id, content}`.
- `ENGINEERING_CONTEXT` (string constant, line 547) — the engineering guidance block described under `ENGINEERING_TOOLS`.

---

## `packages/backend/src/lib/meta-agent/trace.ts`

The play-by-play trace contract (41 lines, types only, no logic). The runner and the codex harness emit one `TraceStep` for every observable step of a tick; the sink is supplied by the caller (the tick handler passes `createTraceSink(...).emit` from `packages/backend/src/server/trace.ts`, which buffers and batch-appends steps to each agent's `trace.jsonl` via the `traceEvents` repo — see doc 02), so the library stays storage-agnostic. Contract: emitting is fire-and-forget — emitters wrap every sink call in try/catch ("a buggy sink can never break a tick") and sinks must not block.

### `TraceEventType` — `packages/backend/src/lib/meta-agent/trace.ts:15`

String union of the 9 step types, each with a documented `data` shape:

| Type | `data` shape | Emitted by |
|---|---|---|
| `tick_started` | `{mode: "fresh" \| "resume", round}` (+ `runtime: "codex-app-server"` from the harness) | runner.ts:254, codex-harness.ts:162 |
| `llm_request` | `{round, model, messageCount}` (harness: `{round: 0, model, runtime}`) | runner.ts:305, codex-harness.ts:489 |
| `llm_response` | `{round, thought, toolCalls: [{toolCallId, tool}], finishReason, durationMs}` (harness: `finishReason` `"stop"` or `"reasoning"`, no durationMs) | runner.ts:323, codex-harness.ts:457,462 |
| `tool_started` | `{round, toolCallId, tool, args}` | runner.ts:212, codex-harness.ts:518 |
| `tool_finished` | `{round, toolCallId, tool, result \| error, durationMs}` | runner.ts:221/230, codex-harness.ts:527/537 |
| `approval_requested` | `{round, pending: [{toolCallId, tool, args}], deferredSafeCount}` | runner.ts:363, codex-harness.ts:267 (always `deferredSafeCount: 0`) |
| `decision_applied` | `{toolCallId, tool, approved, note?}` | runner.ts:271, codex-harness.ts:192 |
| `tick_finished` | `{actionType, actionCount, durationMs, validation?}` — not emitted on suspension | runner.ts:242, codex-harness.ts:313 |
| `tick_failed` | `{phase, error}` — emitted by the **tick handler**, never the library | `packages/backend/src/server/api/tick.ts:645` (`failAgent`) |

The harness always emits `round: 0` (codex owns the rounds, SH can't see them). Global ordering of persisted steps is `(emitted_at, seq)`; one logical tick keeps one `tickId` across suspend/resume via the `traceTickId` parked on `conversationState` (`handleRunResult` tick.ts:631+, `extractTraceTickId` tick.ts:571).

- **Used by:** `runner.ts:40,203`, `codex-harness.ts:49,154`; re-exported at `index.ts:7`

### `TraceStep` — `packages/backend/src/lib/meta-agent/trace.ts:35`

| Field | Type | Meaning |
|---|---|---|
| `type` | `TraceEventType` | The step kind. |
| `data` | `Record<string, unknown>` | Type-specific payload (see table above). |

- **Used by:** `TraceSink`; `packages/backend/src/server/trace.ts:22,38,68` (`PersistentTraceSink.emit`, row assembly); tests `runner-trace.test.ts:4`, `codex-harness.test.ts:9`

### `TraceSink` — `packages/backend/src/lib/meta-agent/trace.ts:41`

`(step: TraceStep) => void`. The injection point: must not block, must not throw (emitters guard anyway). The synchronous signature is deliberate — the server sink buffers internally and batch-inserts in a background drain loop.

- **Used by:** `AgentConfig.trace` (runner.ts:140), `CodexHarnessConfig.trace` (codex-harness.ts:89); implemented by `createTraceSink(...).emit` (`packages/backend/src/server/trace.ts:43`); re-exported at `index.ts:7`

---

## `packages/backend/src/lib/meta-agent/planner.ts`

The cofounder ("Harmon") chat planner. Dependency-injected (`PlannerDeps`) so the library core never imports `server/` modules; the app resolves deps in `packages/backend/src/server/planner-deps.ts`. Two backends share one tool surface and one finalizer. The HTTP caller is `packages/backend/src/server/api/chat.ts` (the Next route `src/app/api/chat/route.ts` is a 2-line re-export).

### `PlannerDeps` — `packages/backend/src/lib/meta-agent/planner.ts:10`

| Field | Type | Meaning |
|---|---|---|
| `config` | `{model: string; openaiApiKey?: string; openaiBaseUrl?: string}` | Resolved LLM config. |
| `apiKeySource` | `string` | Backend selector; `"codex"` routes to the Codex subscription path. |
| `codexAccessToken` | `string \| null` | ChatGPT OAuth token (codex path only). |
| `codexAccountId` | `string` | ChatGPT account id header value. |
| `fetchImpl` | `(url, init?) => Promise<Response>` | Proxy-aware fetch, injected so the core doesn't import `server/proxy-fetch`. |

- **Used by:** `packages/backend/src/server/planner-deps.ts:11` (`buildPlannerDeps` fills it from `getConfig`/`getApiKeySource`/`getCodexAccessToken`/`proxyFetch`), `eval/run-eval.ts:45`, tests `planner.test.ts:2`.

### `SPAWN_TOOL_DEF` (non-exported constant) — `packages/backend/src/lib/meta-agent/planner.ts:46`

Tool definition for `spawn_team`: "Spawn a team of agents… root team or sub-team." Parameters schema: `team_name` (string, human-friendly 1-4 words, required), `parent_team` (string, optional nesting), `cofounder_name` (string, optional rename of Harmon), `agents` (array, required) where each agent requires `name` (kebab-case), `role`, `archetype` (free-form, not a preset list), `tools` (string array), `schedule_seconds` (number, 60-3600 guidance, never 86400), `initial_prompt`.

- **Used by:** `openaiChatStream` (planner.ts:268), `codexResponsesStream` (planner.ts:336)

### `MODIFY_AGENT_TOOL_DEF` (non-exported constant) — `packages/backend/src/lib/meta-agent/planner.ts:101`

Tool definition for `modify_agent`: change an existing agent. Parameters: `agent_name` (required), `team_name` (required, disambiguates duplicates), `updates` (required object) with optional `tools` (full replacement list), `initial_prompt`, `schedule_seconds`, `status` (enum `running`/`paused`), `role`, and `output_contract` (JSON Schema object validated against each tick's `report_action` payload, with an inline example in the description).

- **Used by:** `openaiChatStream` (planner.ts:269), `codexResponsesStream` (planner.ts:342)

### `REQUEST_CREDENTIAL_TOOL_DEF` (non-exported constant) — `packages/backend/src/lib/meta-agent/planner.ts:155`

Tool definition for `request_credential`: ask the founder for a secret, stored encrypted in Apollo, never in the DB or agent-readable files. Parameters: `key` (env-var style, required), `label` (human name, required), `reason` (one sentence, required), `help_url` (optional).

- **Used by:** `openaiChatStream` (planner.ts:270), `codexResponsesStream` (planner.ts:348)

### `PlannerMessage` — `packages/backend/src/lib/meta-agent/planner.ts:187`

| Field | Type | Meaning |
|---|---|---|
| `role` | `"user" \| "assistant"` | Chat role (system prompt is added by the planner itself). |
| `content` | `string` | Message text. |

- **Used by:** `packages/backend/src/server/api/chat.ts:1,44` (request body), `eval/run-eval.ts:61`.

### `SpawnTeamAgent` — `packages/backend/src/lib/meta-agent/planner.ts:192`

One agent in a spawn proposal.

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Kebab-case agent name. |
| `role` | `string` | One-line role description. |
| `archetype` | `string` | Free-form function label. |
| `tools` | `string[]` | Assigned tool names. |
| `schedule_seconds` | `number` | Tick cadence. |
| `initial_prompt` | `string` | Agent system prompt. |

- **Used by:** `packages/frontend/src/components/chat/use-chat.ts:4,12`, `packages/frontend/src/components/chat/approval-card.tsx:4,14`, `src/app/(app)/new/page.tsx:3,55`, `eval/validators.ts:15,93`.

### `SpawnTeamResult` — `packages/backend/src/lib/meta-agent/planner.ts:201`

| Field | Type | Meaning |
|---|---|---|
| `team_name` | `string` | Human-friendly team name. |
| `parent_team` | `string?` | Existing parent team name for nesting. |
| `cofounder_name` | `string?` | Only set if the founder renamed Harmon. |
| `agents` | `SpawnTeamAgent[]` | The proposed roster. |

- **Used by:** `packages/backend/src/server/api/chat.ts:64-76` (spawn SSE event), `eval/validators.ts:15,50`, `eval/run-eval.ts:76`, tests `eval-validators.test.ts:8`.

### `ModifyAgentUpdates` — `packages/backend/src/lib/meta-agent/planner.ts:208`

| Field | Type | Meaning |
|---|---|---|
| `tools` | `string[]?` | Full replacement tool list. |
| `initial_prompt` | `string?` | New system prompt. |
| `schedule_seconds` | `number?` | New cadence. |
| `status` | `"running" \| "paused"?` | Pause/resume. |
| `role` | `string?` | New role description. |
| `output_contract` | `Record<string, unknown>?` | New output JSON Schema. |

### `ModifyAgentResult` — `packages/backend/src/lib/meta-agent/planner.ts:217`

| Field | Type | Meaning |
|---|---|---|
| `agent_name` | `string` | Target agent. |
| `team_name` | `string` | Target team (disambiguation). |
| `updates` | `ModifyAgentUpdates` | The changes. |

- **Used by:** `packages/backend/src/server/api/chat.ts:1,8` (`applyModifyAgent` writes the updates via `agents.update`, `chat.ts:32`, before emitting the SSE event at `:77-90`).

### `CredentialRequest` — `packages/backend/src/lib/meta-agent/planner.ts:223`

| Field | Type | Meaning |
|---|---|---|
| `key` | `string` | Env-var name, e.g. `GITHUB_TOKEN`. |
| `label` | `string` | Human-friendly name. |
| `reason` | `string` | One-sentence justification. |
| `help_url` | `string?` | Where to create/find the credential. |

- **Used by:** `packages/backend/src/server/api/chat.ts:91-103` (request_credential SSE event; the frontend mirrors it as its own `CredentialRequestData`).

### `PlannerResult` — `packages/backend/src/lib/meta-agent/planner.ts:230`

Discriminated union; `content` is always the streamed assistant text.

| Variant | Extra field | Meaning |
|---|---|---|
| `{type: "message", content}` | — | Plain reply (also the fallback for malformed tool calls). |
| `{type: "spawn", content, result}` | `result: SpawnTeamResult` | Team proposal. |
| `{type: "modify_agent", content, result}` | `result: ModifyAgentResult` | Agent change. |
| `{type: "request_credential", content, result}` | `result: CredentialRequest` | Credential ask. |

- **Used by:** `packages/backend/src/server/api/chat.ts:64-110` (branches per variant into SSE events), `eval/run-eval.ts:67`.

### `plannerStream(messages: PlannerMessage[], onToken: (token: string) => void, deps: PlannerDeps): Promise<PlannerResult>` — `packages/backend/src/lib/meta-agent/planner.ts:240`

Public entry point. Pure dispatch: `deps.apiKeySource === "codex"` → `codexResponsesStream`, else `openaiChatStream`. `onToken` is called for every streamed text delta.

- **Calls:** `codexResponsesStream`, `openaiChatStream`
- **Called by:** `packages/backend/src/server/api/chat.ts:54`, `eval/run-eval.ts:60`; tests `planner.test.ts`, `api-chat.test.ts:5,9` (mocked)

### `openaiChatStream(messages, onToken, deps): Promise<PlannerResult>` (non-exported) — `packages/backend/src/lib/meta-agent/planner.ts:255`

Path A (Platform API key / env var). Creates a streaming `chat.completions.create` via `openaiClient` with `DEFAULT_META_AGENT_PROMPT` as the system message, the conversation, and the three tool defs. Iterates the async stream: `delta.content` chunks accumulate into `fullText` and fire `onToken`; `delta.tool_calls` chunks accumulate one tool name + concatenated argument string (only a single tool call is tracked). Ends with `finalize`.

- **Calls:** `openaiClient`, OpenAI SDK streaming, `finalize`
- **Called by:** `plannerStream`

### `CODEX_RESPONSES_URL` (non-exported constant) — `packages/backend/src/lib/meta-agent/planner.ts:302`

`"https://chatgpt.com/backend-api/codex/responses"` — the ChatGPT backend Responses endpoint used by the subscription path.

### `codexHeaders(deps): Record<string, string>` (non-exported) — `packages/backend/src/lib/meta-agent/planner.ts:304`

Builds the Codex request headers: `Authorization: Bearer <token>`, `ChatGPT-Account-ID`, `User-Agent: codex_cli_rs/0.0.0`, `originator: codex_cli_rs`. Throws `"No Codex access token available"` when `deps.codexAccessToken` is null.

- **Called by:** `codexResponsesStream` (planner.ts:359)

### `codexResponsesStream(messages, onToken, deps): Promise<PlannerResult>` (non-exported) — `packages/backend/src/lib/meta-agent/planner.ts:319`

Path B (Codex subscription). POSTs a Responses-API body (`model`, `instructions: DEFAULT_META_AGENT_PROMPT`, `input` messages, the three tools in flat Responses shape, `store: false`, `stream: true`) to `CODEX_RESPONSES_URL` via `deps.fetchImpl` with `AbortSignal.timeout(60000)`. Throws on non-OK status (`Codex API error <status>: <first 200 chars>`) or missing body. Then hand-parses the SSE stream with a `ReadableStream` reader + `TextDecoder`, buffering partial lines: tracks `event:` lines, parses `data:` JSON (skipping malformed lines), and reacts to `response.output_text.delta` (append + `onToken`), `response.output_item.added` with `item.type === "function_call"` (capture tool name), and `response.function_call_arguments.delta` (append args). Ends with `finalize`.

- **Calls:** `codexHeaders`, `deps.fetchImpl`, `finalize`
- **Called by:** `plannerStream`

### `finalize(fullText, toolCallName, toolCallArgs): PlannerResult` (non-exported) — `packages/backend/src/lib/meta-agent/planner.ts:436`

Shared result assembler. In order, attempts to `JSON.parse` the accumulated args when the tool name is `spawn_team` / `modify_agent` / `request_credential` and returns the matching variant; a parse failure falls through silently. Default: `{type: "message", content: fullText || "I need a moment. Try again."}`.

- **Called by:** `openaiChatStream` (planner.ts:295), `codexResponsesStream` (planner.ts:429)

### Internal helpers

- `openaiClient(config)` (line 34) — constructs an `OpenAI` SDK client (`apiKey`, `baseURL`, 30s timeout).
- Re-export of `DEFAULT_META_AGENT_PROMPT` (line 185) for backward compatibility; the source of truth is `default-prompt.ts`.

---

## `packages/backend/src/lib/meta-agent/registry.ts`

The tool plugin surface (175 lines). A tool is split into a **definition** (pure data: name, description, category, risk, Zod schema — NPM-safe) and an **implementation** (the I/O function, registered alongside). The registry validates LLM-supplied args against the Zod schema before invoking the impl and converts schemas to OpenAI/JSON-Schema tool defs.

### `ToolCategory` — `packages/backend/src/lib/meta-agent/registry.ts:29`

`"internal" | "filesystem" | "shell" | "network"` — broad grouping used for allowlisting and risk display (surfaced by `packages/backend/src/server/api/settings/skills.ts`).

### `ToolRisk` — `packages/backend/src/lib/meta-agent/registry.ts:36`

`"safe" | "destructive"`. Safe tools run without approval; destructive tools must pass the approval gate (suspension) before their impl runs.

### `ToolDefinition<S extends z.ZodType>` — `packages/backend/src/lib/meta-agent/registry.ts:39`

The data half of a tool.

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Unique tool name. |
| `description` | `string` | Shown to the LLM. |
| `category` | `ToolCategory` | Grouping. |
| `risk` | `ToolRisk` | Default approval classification. |
| `isDestructive` | `((args: z.infer<S>) => boolean)?` | Argument-aware override for dual-mode tools (e.g. `github_api`: GET safe, mutations destructive — see `server/tools/network.ts`, `server/tools/api-tool-runtime.ts`). |
| `schema` | `S` | Zod schema for the args; also the source of the JSON Schema. |

- **Used by:** every app tool module — `packages/backend/src/server/tools/{filesystem,shell,network,management,action-history,observe,api-tool-runtime,coding/index}.ts`.

### `ToolImpl<S extends z.ZodType>` — `packages/backend/src/lib/meta-agent/registry.ts:51`

`(args: z.infer<S>, ctx: ToolRunContext) => Promise<ToolExecResult>` — the behavior half, called only after schema validation succeeds.

- **Used by:** same app tool modules as `ToolDefinition`; `default-tools.ts` impls.

### `schemaToParameters(schema: z.ZodType): Record<string, unknown>` — `packages/backend/src/lib/meta-agent/registry.ts:66`

Converts a Zod schema to JSON Schema via `z.toJSONSchema` and deletes the `$schema` meta key (Anthropic's `input_schema` rejects it).

- **Calls:** `z.toJSONSchema`
- **Called by:** `ToolRegistry.getOpenAIDefs` (registry.ts:118); tests `registry.test.ts:39,47`

### class `ToolRegistry` — `packages/backend/src/lib/meta-agent/registry.ts:72`

Holds a single private `tools: Map<string, RegisteredTool>` where `RegisteredTool = {def: ToolDefinition, impl: ToolImpl}` (line 56). Instantiated by `createDefaultRegistry` (default-tools.ts:47) and extended by the app in `packages/backend/src/server/tools/index.ts` (`createAppRegistry`/`createAppRegistryWithCustomTools`).

#### `register<S>(def: ToolDefinition<S>, impl: ToolImpl<S>): void` — `registry.ts:81`

Adds the pair to the map. Throws `Tool "<name>" is already registered` on a duplicate — fail-loud so one plugin can't silently shadow another's tool.

- **Called by:** `default-tools.ts:49,82,105` (3 internal tools); `packages/backend/src/server/tools/index.ts:48-59` (12 built-in app tools — 15 total, pinned by `server-tools.test.ts:400`) and `:77` (custom JSON API tools via `buildApiToolDef`/`buildApiToolImpl`)

#### `has(name: string): boolean` — `registry.ts:91`

Map membership check.

- **Called by:** `packages/backend/src/server/tools/index.ts:74` (skip custom tools that collide with built-ins)

#### `get(name: string): ToolDefinition | undefined` — `registry.ts:95`

Returns the definition only (not the impl). No direct callers in `src/` — it exists to satisfy `ToolSchemaLookup` structurally (`eval/validators.ts:144,170`).

#### `listForAgent(allowed?: string[]): ToolDefinition[]` — `registry.ts:104`

All registered defs when `allowed` is omitted; otherwise the intersection (unknown allowlist names are silently ignored).

- **Called by:** `getOpenAIDefs` (registry.ts:113), `runner.ts:185` (tool descriptions for the system prompt), `codex-harness.ts:138`, `packages/backend/src/server/api/settings/skills.ts:17,62` (skills settings UI + PATCH validation)

#### `getOpenAIDefs(allowed?: string[]): OpenAIToolDef[]` — `registry.ts:112`

Maps `listForAgent(allowed)` to the OpenAI `tools` wire shape (`{type: "function", function: {name, description, parameters: schemaToParameters(schema)}}`). The mapping is inlined here — there is no separate `toOpenAIToolDefs` function.

- **Called by:** `runner.ts:184` (the per-tick `tools` param), `codex-harness.ts:137` (mapped onward to codex `dynamicTools`), `tools.ts:79` (`AGENT_TOOL_DEFS`); tests `registry.test.ts:97+`

#### `isDestructive = (toolName: string, rawArgs?: unknown): boolean` (arrow-function property) — `registry.ts:130`

Approval classifier backed by the risk labels: unknown tool → `true` (fail safe, never auto-approve an unrecognized name); a def with an `isDestructive` predicate → `safeParse` the raw args first (parse failure → `true`) then delegate; otherwise `risk === "destructive"`. Defined as a bound arrow property so it can be passed detached (`isDestructive: registry.isDestructive`).

- **Called by:** `runner.ts:186` and `codex-harness.ts:139` (default classifier), `packages/backend/src/server/api/tick.ts:437,552` (passed explicitly alongside `toolRegistry`)

#### `execute(name: string, rawArgs: unknown, ctx: ToolRunContext): Promise<ToolExecResult>` — `registry.ts:147`

Validate-then-dispatch; never throws by design. Unknown tool → `{success: false, result: "Unknown tool: <name>"}`. `schema.safeParse(rawArgs)` failure → `{success: false}` with the joined Zod issue paths/messages and a retry instruction. Otherwise `tool.impl(parsed.data, ctx)` (impl errors do propagate — impls are expected to catch their own I/O failures).

- **Calls:** `zod safeParse`, the registered `ToolImpl`
- **Called by:** `runner.ts:442` (`runToolCall`), `codex-harness.ts:521` (`executeToolTraced`), `tools.ts:91` (`executeTool`)

---

## `packages/backend/src/lib/meta-agent/tools.ts`

Agent tool types plus the back-compat dispatch surface (92 lines). The source of truth is the `ToolRegistry`; this file keeps the original v0.0 exports (`AGENT_TOOL_DEFS`, `executeTool`) as thin shims over a shared default registry instance.

### `ToolResult` — `packages/backend/src/lib/meta-agent/tools.ts:14`

An action a tool logged.

| Field | Type | Meaning |
|---|---|---|
| `actionType` | `string` | Short label (e.g. `message_sent`, `broadcast_sent`, or a `report_action` custom type). |
| `payload` | `Record<string, unknown>` | Structured action data. |

- **Used by:** `runner.ts` (`actions` accumulator, `AgentSuspension.actions`, `summarize`), `codex-harness.ts` (`CodexThreadSuspension.actions`, `executeToolTraced`), `ToolExecResult.action`.

### `PeerAgent` — `packages/backend/src/lib/meta-agent/tools.ts:20`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Agent UUID (a2ax addressing). |
| `name` | `string` | Display name (what the LLM uses in `send_message`). |
| `role` | `string` | One-line role, shown in the peer list. |

- **Used by:** `AgentConfig.peers`, `CodexHarnessConfig.peers`, `ToolExecContext.peers`; `packages/backend/src/server/api/tick.ts:13,301` (`buildPeers`).

### `ToolExecContext` — `packages/backend/src/lib/meta-agent/tools.ts:31`

Context for a tool's public callers. Does **not** carry the a2ax sender — back-compat callers pass it separately to `executeTool`.

| Field | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Team scope. |
| `agentId` | `string` | Acting agent id. |
| `agentName` | `string` | Acting agent name. |
| `peers` | `PeerAgent[]` | Teammates. |

### `ToolRunContext` — `packages/backend/src/lib/meta-agent/tools.ts:39`

What a registry impl actually receives: `ToolExecContext` plus the bus.

| Field | Type | Meaning |
|---|---|---|
| *(all of `ToolExecContext`)* | | |
| `a2ax` | `A2AXSender` | The message bus. |

- **Used by:** `registry.ts:26` (`ToolImpl`, `execute`), `runner.ts:188`, `codex-harness.ts:142`; tests `api-tool-runtime.test.ts:4`, `server-tools.test.ts:34`, `security/tools-security.test.ts:35`, `registry.test.ts:5`.

### `ToolCallInput` — `packages/backend/src/lib/meta-agent/tools.ts:43`

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Tool name. |
| `arguments` | `Record<string, unknown>` | Already-parsed args (unlike `PendingToolCall.arguments`, which is a raw string). |

- **Used by:** `executeTool`; tests `tools.test.ts`.

### `ToolExecResult` — `packages/backend/src/lib/meta-agent/tools.ts:48`

| Field | Type | Meaning |
|---|---|---|
| `toolName` | `string` | Echo of the executed tool. |
| `success` | `boolean` | False on unknown tool / schema failure / impl-reported failure. |
| `result` | `string` | Text fed back to the LLM as the tool message. |
| `action` | `ToolResult?` | Present if the tool produced an action to log. |

- **Used by:** `ToolImpl` return type, `ToolRegistry.execute`, `runToolCall`, `executeToolTraced` (codex-harness.ts).

### `A2AXSender` — `packages/backend/src/lib/meta-agent/tools.ts:56`

| Field | Type | Meaning |
|---|---|---|
| `sendDirect` | `(teamId, from, to, content) => Promise<unknown>` | Direct message between agents. |
| `broadcast` | `(teamId, from, content) => Promise<unknown>` | Message to the whole team. |

- **Used by:** `default-tools.ts` impls (via `ctx.a2ax`), `AgentConfig.a2ax`, `CodexHarnessConfig.a2ax`; satisfied by the app's a2ax instance from `packages/backend/src/server/a2ax` in the tick handler.

### `AGENT_TOOL_DEFS: OpenAIToolDef[]` — `packages/backend/src/lib/meta-agent/tools.ts:79`

Module-level constant: `defaultRegistry.getOpenAIDefs()` over the three internal tools (`send_message`, `broadcast`, `report_action`). Back-compat export.

- **Called by:** tests only (`tools.test.ts:38`, `meta-agent-index.test.ts:43`)

### `executeTool(call: ToolCallInput, ctx: ToolExecContext, a2ax: A2AXSender): Promise<ToolExecResult>` — `packages/backend/src/lib/meta-agent/tools.ts:86`

Back-compat 3-arg shim: merges `a2ax` into the context and delegates to the module-level default registry's `execute` (so args still pass Zod validation).

- **Calls:** `ToolRegistry.execute`
- **Called by:** tests only (`tools.test.ts:76+`)

### Internal helpers

- `defaultRegistry` (line 76) — process-wide `createDefaultRegistry()` instance; safe to share because the internal tools are stateless (a2ax arrives via ctx).

---

## `packages/backend/src/lib/meta-agent/default-tools.ts`

The internal message-passing tools every agent has, expressed as registry entries with Zod schemas (129 lines). All are `category: "internal"`, `risk: "safe"`: they only touch the a2ax bus and the action log, never the outside world.

### `createDefaultRegistry(): ToolRegistry` — `packages/backend/src/lib/meta-agent/default-tools.ts:46`

Builds a fresh `ToolRegistry` and registers three tools:

- **`send_message`** (registered line 49; schema line 17: `to_agent`, `content`) — resolves the peer by case-insensitive name; unknown peer returns `success: false` listing available agents; otherwise `ctx.a2ax.sendDirect(teamId, agentId, peer.id, content)` and logs action `message_sent {to, toId, content}`.
- **`broadcast`** (registered line 82; schema line 24: `content`) — `ctx.a2ax.broadcast(...)`; logs `broadcast_sent {content, peerCount}`.
- **`report_action`** (registered line 105; schema line 28: `action_type`, `summary`, optional `details` record) — pure logging: returns action `{actionType: args.action_type, payload: {summary, ...details}}`. This is the payload an `output_contract` validates.

- **Calls:** `ToolRegistry.register` (x3)
- **Called by:** `runner.ts:179`, `tools.ts:76`, and `codex-harness.ts:132` (module-level default registries), `packages/backend/src/server/tools/index.ts:46` (`createAppRegistry` builds on top of it, adding the 12 app tools); tests `registry.test.ts:196+`, `runner.test.ts`, `runner-resume.test.ts`

### Internal helpers

- `sendMessageSchema` (17), `broadcastSchema` (24), `reportActionSchema` (28) — the Zod argument schemas, each field `.describe()`d for the LLM.

---

## `packages/backend/src/lib/meta-agent/default-prompt.ts`

### `DEFAULT_META_AGENT_PROMPT: string` — `packages/backend/src/lib/meta-agent/default-prompt.ts:1`

The Harmon system prompt (67 lines), used by both planner backends. Sections: **voice rules** (calm authority, first-person singular, short sentences, no em dashes, one question at a time, adopts a new name if renamed); **conversation job** (understand the founder, 1-2 follow-ups, propose a sized team, call `spawn_team` when aligned, then `modify_agent` for changes; sub-teams via `parent_team`; lead promotion = granting `spawn_sub_team` + `modify_agent`); **agent shape** (kebab-case name, free-form archetype, every agent auto-gets the internal tools); **available tools catalog** (read_file, write_file, run_command, coding_task, github_api, http_fetch, observe_app, spawn_sub_team, modify_agent, with safe/destructive labels); **custom tools and connectors** (`.simple-harmonic/connectors/`, `.simple-harmonic/skills/`); **credentials** (`request_credential`, encrypted in Apollo); **improvement levels** (agent/team/tool/infra diagnosis rubric); **output contracts**; **schedule guidance** (300/600/1800s, never 86400).

- **Used by:** `planner.ts:264` (`openaiChatStream` system message), `planner.ts:331` (`codexResponsesStream` instructions); re-exported at `planner.ts:185` and `index.ts:4`; tests `default-prompt.test.ts`, `meta-agent-index.test.ts:42`

---

## `packages/backend/src/lib/meta-agent/identity.ts`

Fixed sentinel identities that let the AI cofounder and the human user participate in agent messaging as first-class peers. Not exported via the barrel; consumers deep-import `.../lib/meta-agent/identity`.

### `COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0"` — `identity.ts:4`

Sentinel UUID for the cofounder in a2ax messages and tasks (`c0f0` tail for log recognition).

- **Called by:** `packages/backend/src/server/api/seed.ts:2,263+` (demo data authored as the cofounder), `packages/backend/src/server/api/team/id/tasks.ts:2,31`, `packages/backend/src/server/api/team/id/agent-hub.ts:2,76-80`, `packages/backend/src/server/api/team/id/conversations.ts:2`, `packages/backend/src/server/api/team/id/messages.ts:2,75`, `packages/frontend/src/components/team/agent-messages-view.tsx:5,336-414`

### `DEFAULT_COFOUNDER_NAME = "Harmon"` — `identity.ts:6`

Default display name; teams override via `teams.cofounderName`.

- **Called by:** `resolveCofounderName` (identity.ts:37), `packages/frontend/src/components/chat/approval-card.tsx:5,59` (rename-input placeholder)

### `PRIMARY_USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe"` — `identity.ts:12`
### `PRIMARY_USER_DISPLAY_NAME = "You"` — `identity.ts:13`

The primary human's sentinel identity (`fffe` tail) so the user can DM, wake, or pause agents. v0.0 ships a single human; the structure anticipates multi-human teams.

- **Called by:** `getTeamHumans` (identity.ts:33); tests `identity.test.ts`

### `USER_AGENT_ID` / `USER_DISPLAY_NAME` — `identity.ts:16-17`

Back-compat aliases for the two constants above (legacy single-user API surface).

- **Called by:** `packages/backend/src/server/api/team/id/{conversations,agent-hub,messages,tasks}.ts`, `packages/backend/src/server/api/seed.ts`, `packages/frontend/src/components/team/agent-messages-view.tsx:6`, `packages/frontend/src/components/team/agent-pov-view.tsx:4`

### `COFOUNDER_POV = "cofounder"` / `USER_POV = "user"` — `identity.ts:21-22`

POV sentinels used by the messaging view URLs; the API handlers translate them to the real UUIDs before querying (e.g. `messages.ts:75-76`).

- **Called by:** `packages/backend/src/server/api/team/id/{conversations,messages,tasks}.ts`

### `HumanParticipant` — `identity.ts:24`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Human sentinel UUID. |
| `name` | `string` | Display name. |

### `getTeamHumans(_teamId: string): HumanParticipant[]` — `identity.ts:32`

Returns the humans associated with a team — currently a fixed singleton `[{id: PRIMARY_USER_AGENT_ID, name: PRIMARY_USER_DISPLAY_NAME}]` regardless of the team id (the parameter is reserved for multi-human teams).

- **Called by:** `packages/frontend/src/components/team/agent-messages-view.tsx:191`; tests `identity.test.ts:62+`

### `resolveCofounderName(teamCofounderName: string | null | undefined): string` — `identity.ts:36`

Trims the per-team override and falls back to `DEFAULT_COFOUNDER_NAME` when null/undefined/blank.

- **Called by:** `packages/backend/src/server/api/team/id/conversations.ts:30`, `packages/backend/src/server/api/team/id/agent-hub.ts:72`, `packages/backend/src/server/api/team/id/tasks.ts:31`, `packages/frontend/src/components/team/agent-messages-view.tsx:190`

---

## `packages/backend/src/lib/meta-agent/approval.ts`

The approval gate. Pure module (no DB, no SDK) so both functions are trivially testable; the tick handler supplies real team/agent rows.

### `AgentLike` — `approval.ts:19`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Agent id. |
| `name` | `string` | Used in decision reasons. |
| `status` | `"running" \| "paused" \| "errored" \| "awaiting_approval"` | Lifecycle state. |
| `inFlight` | `boolean` | True while a tick is executing (no overlap). |
| `nextRunAt` | `Date \| null` | Next scheduled tick; null = never due. |

### `TeamLike` — `approval.ts:27`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Team id. |
| `paused` | `boolean` | Team-wide pause. |

### `ApprovalDecision` — `approval.ts:32`

`{allowed: true} | {allowed: false; reason: string; reasonCode: ApprovalReasonCode}` — discriminated on `allowed`.

### `ApprovalReasonCode` — `approval.ts:36`

`"team_paused" | "agent_paused" | "agent_errored" | "agent_in_flight" | "awaiting_approval" | "not_due" | "destructive_unconfirmed"`.

### `approveAgentTick(team: TeamLike, agent: AgentLike, now: Date = new Date()): ApprovalDecision` — `approval.ts:53`

Decides whether an agent runs this tick. Checks in order, returning the first failure: team paused → `team_paused`; agent paused → `agent_paused`; errored → `agent_errored`; `awaiting_approval` → blocked (parked agents are resumed by a separate path, never re-ticked fresh); `inFlight` → `agent_in_flight`; `nextRunAt` null or in the future → `not_due`. Otherwise `{allowed: true}`. Pure; the clock is injectable for tests.

- **Calls:** nothing (pure comparisons)
- **Called by:** `packages/backend/src/server/api/tick.ts:268` (due-agent filter); tests `approval.test.ts:34+,190+`

### `ToolCallLike` — `approval.ts:114`

| Field | Type | Meaning |
|---|---|---|
| `toolName` | `string` | Tool being attempted. |
| `arguments` | `Record<string, unknown>` | Parsed args, forwarded to the classifier. |

### `DestructiveClassifier` — `approval.ts:125`

`(toolName: string, rawArgs?: unknown) => boolean` — injected predicate (the app backs it with `ToolRegistry.isDestructive`) so this module stays pure.

### `approveAgentAction(_team: TeamLike, _agent: AgentLike, call: ToolCallLike, isDestructive: DestructiveClassifier = () => true): ApprovalDecision` — `approval.ts:139`

Per-action gate: safe per the classifier → `{allowed: true}`; otherwise held with `destructive_unconfirmed` (which the runner expresses as a suspension and the tick loop as `approvals.json` rows). The default classifier treats everything as destructive — callers that don't pass one get the conservative pre-T2 stance. Team/agent params are currently unused (reserved for per-agent allowlists).

- **Calls:** the injected classifier
- **Called by:** tests only (`approval.test.ts:125+`, `meta-agent-index.test.ts:41`) — the runner and harness enforce the same policy directly via `isDestructive` rather than through this function

### Internal helpers

- `NOW_FN` (line 45) — `() => new Date()`, the default clock.

---

## `packages/backend/src/lib/meta-agent/anthropic-adapter.ts`

Wraps `@anthropic-ai/sdk` in the `LLMClient` interface so the runner can use Anthropic models without changing its OpenAI-shaped calling convention. Not exported via the barrel.

### `convertTools(tools?: OpenAIToolDef[]): AnthropicTool[] | undefined` (non-exported) — `anthropic-adapter.ts:18`

Maps OpenAI tool defs to Anthropic shape: `function.name` → `name`, `function.description` → `description` (empty-string fallback), `function.parameters` → `input_schema` (default `{type: "object", properties: {}}`). Returns `undefined` for absent/empty input so the `tools` key is omitted entirely.

- **Called by:** `createAnthropicClient`'s `create` (anthropic-adapter.ts:121)

### `convertMessages(messages: Array<Record<string, unknown>>): {system: string | undefined; messages: Array<{role: "user" | "assistant"; content: unknown}>}` (non-exported) — `anthropic-adapter.ts:28`

Maps the OpenAI message list to Anthropic's split system/messages form: `system` messages are concatenated (double-newline joined) into the top-level `system` string; `tool` messages become user messages containing a `tool_result` content block keyed by `tool_call_id`; assistant messages with `tool_calls` become content-block arrays (optional `text` block, then one `tool_use` block per call with `JSON.parse`d input, `{}` on parse failure); plain assistant/user messages become string content.

- **Called by:** `createAnthropicClient`'s `create` (anthropic-adapter.ts:117)

### `createAnthropicClient(opts: {apiKey?: string; baseURL?: string; timeout?: number}): LLMClient` — `anthropic-adapter.ts:102`

Constructs an `Anthropic` SDK client (apiKey falls back to `ANTHROPIC_API_KEY`, baseURL to `ANTHROPIC_BASE_URL`, timeout default 60s) and returns an object implementing `LLMClient`. Its `create`: converts messages and tools, builds params with model default `"claude-sonnet-4-20250514"` and `max_tokens` default 1024, calls `client.messages.create` (forwarding the abort signal when provided), then converts the response back to OpenAI shape — `text` blocks concatenate into `content`, `tool_use` blocks become `tool_calls` with `JSON.stringify`ed arguments, `stop_reason === "tool_use"` maps to `finish_reason: "tool_calls"` (else `"stop"`), and a `usage` block carries both Anthropic (`input_tokens`/`output_tokens`) and OpenAI (`prompt_tokens`/`completion_tokens`) aliases so the spend-counting wrapper can read either.

- **Calls:** `new Anthropic`, `convertMessages`, `convertTools`, `client.messages.create`
- **Called by:** `resolveLLMCandidates` (`packages/backend/src/server/llm.ts:63`, the anthropic cascade step when `ANTHROPIC_API_KEY` is set; model `ANTHROPIC_MODEL` or `claude-sonnet-4-20250514`, llm.ts:62); tests `anthropic-adapter.test.ts` (mocked in `api-tick.test.ts:128-129`)

### Internal helpers

- `AnthropicTool` (interface, line 11) — `{name, description?, input_schema}`.

---

## `packages/backend/src/lib/meta-agent/codex-adapter.ts`

Shells out to `codex exec` so agent ticks can run on the user's ChatGPT subscription (Codex OAuth) without an OpenAI API key. Since `codex exec` has no native tool-use API, tools are encoded into the prompt and the model is instructed to reply with a structured JSON object. Not exported via the barrel. This is **not** the default codex runtime anymore: engine mode (`runCodexAgentTick`, codex-harness.ts) handles codex ticks unless `SH_CODEX_RUNTIME=exec`; this adapter serves the codex cascade step for the non-harness path and resumes legacy message-based suspensions (`packages/backend/src/server/api/tick.ts:568-583`).

### `buildCodexPrompt(messages: OpenAIMessage[], tools?: OpenAIToolDef[]): string` (non-exported) — `codex-adapter.ts:43`

Flattens the conversation into a single prompt: all system messages first; then (when tools exist) an "## Available Tools" section instructing the model to respond with a JSON object — `content` for text or `tool_calls: [{name, arguments}]` — including a pretty-printed format example and a bullet list of every tool with its JSON-Schema parameters; then the user/assistant/tool turns tagged `[User]` / `[Assistant]` / `[Tool Result]`; and finally "Respond with ONLY a valid JSON object. No markdown fences, no extra text."

- **Called by:** `createCodexClient`'s `create` (codex-adapter.ts:322)

### `parseCodexOutput(jsonlOutput: string): string` (non-exported) — `codex-adapter.ts:118`

Scans the `codex exec --json` JSONL stream line by line (skipping non-JSON lines), keeping the text of the **last** `item.completed` event whose item type is `agent_message`. `error` events are logged to `console.error` but don't abort. Returns `""` when no agent message appeared.

- **Called by:** `createCodexClient`'s `create` (codex-adapter.ts:325)

### `extractJsonObject(text: string): string | null` — `codex-adapter.ts:153`

Pulls the most likely JSON object out of free text. Strategy: (1) a ```` ```json ````-or-bare fenced block whose trimmed body starts with `{`; (2) brace-scanning from the first `{` for the first *balanced* top-level object, tracking string/escape state so braces inside strings don't miscount — this tolerates leading/trailing prose that a naive slice can't. Returns the candidate string or `null`. Exported, but has no external callers.

- **Called by:** `parseStructuredResponse` (codex-adapter.ts:207) — no callers elsewhere in the repo

### `parseStructuredResponse(text: string, allowedTools: Set<string>): {content: string | null; tool_calls?: ...}` (non-exported) — `codex-adapter.ts:197`

Tries to interpret the model's text as the structured JSON contract. No object found or invalid JSON → plain `{content: text}`. With a `tool_calls` array: filters to calls whose `name` is a string **and** in `allowedTools` (hallucinated tool names are dropped so they never reach the dispatcher), assigns deterministic ids `call_<index>`, and `JSON.stringify`s the arguments. If every call was filtered out, falls back to `content` (or the raw text) so the turn isn't silently empty.

- **Calls:** `extractJsonObject`, `JSON.parse`
- **Called by:** `createCodexClient`'s `create` (codex-adapter.ts:342)

### `runCodexExec(prompt: string, model: string, signal?: AbortSignal): Promise<string>` (non-exported) — `codex-adapter.ts:244`

Spawns `codex exec --json --ephemeral --skip-git-repo-check --ignore-rules -c model="<model>" -c model_reasoning_effort="low" -c sandbox="read-only" -` via `execFile` (timeout 120s, maxBuffer 1MB, inherited env) and pipes the prompt over stdin. Also writes the prompt to a temp file under `sh-codex-*` (the comment cites shell-escaping, but the file path is never passed to the command — stdin is the actual delivery; the temp dir is removed in cleanup either way). Resolves with stdout; rejects with `codex exec failed: <message>` only when the process errored *and* produced no stdout. Abort handling: a `settled` flag guards double-settlement; on signal abort the child gets `SIGTERM`, the temp dir is cleaned, and the promise rejects with `signal.reason` (or a generic abort error); an already-aborted signal short-circuits before spawn.

- **Calls:** `mkdtempSync`, `writeFileSync`, `execFile("codex", ...)`, `rmSync`
- **Called by:** `createCodexClient`'s `create` (codex-adapter.ts:324)

### `createCodexClient(opts?: {model?: string}): LLMClient` — `codex-adapter.ts:311`

Returns an `LLMClient` whose `create`: resolves the model (`params.model` → opts → `"gpt-5.5"`, codex-adapter.ts:312), builds the prompt with `buildCodexPrompt`, runs `runCodexExec`, extracts the agent text with `parseCodexOutput`. Empty text → a stub `"No response from agent."` completion. When tools were offered, gates and parses the structured response via `parseStructuredResponse` with the offered tool names, setting `finish_reason: "tool_calls"` iff calls survived; otherwise returns the text as a plain `"stop"` completion. Note: unlike the Anthropic adapter, responses carry no `usage` block, so the spend counter stays at zero and `recordSpend` skips the ledger append entirely (no `spend.jsonl` entry on this path; `spend.ts:102`). Engine mode fixes this — the harness sums real token usage.

- **Calls:** `buildCodexPrompt`, `runCodexExec`, `parseCodexOutput`, `parseStructuredResponse`
- **Called by:** `resolveLLMCandidates` (`packages/backend/src/server/llm.ts:55`, the codex cascade step, model `cfg.model || "gpt-5.5"`); tests `codex-adapter.test.ts` (mocked in `api-tick.test.ts:133-134`)

### Internal helpers

- `CodexEvent` (interface, line 14) — the JSONL event shape (`type`, optional `item` with `id/type/text/command/aggregated_output/exit_code/status`, optional `error.message`).
- `OpenAIMessage` (interface, line 28) — `{role, content, tool_calls?}` as read off the runner's message list.

---

## `packages/backend/src/lib/meta-agent/cascade.ts`

Multi-provider cascade client (79 lines). Composes an ordered list of (provider, model, client) candidates into a single `LLMClient` so one rate-limited or down provider can't fail an agent tick while another key is configured. Library core: must not import server modules (header comment, cascade.ts:6-7) — provider resolution lives in `packages/backend/src/server/llm.ts` (`resolveLLMCandidates` llm.ts:47 / `resolveLLM` llm.ts:125; order Codex CLI > Anthropic > OpenRouter > OpenAI, always ≥1 candidate via a keyless OpenAI fallback). The OpenAI candidates use `cfg.model` from server config — committed default `o4-mini`, currently `gpt-5.5` via an uncommitted `packages/backend/src/server/config.ts` edit; with no config file on disk it resolves from env `OPENAI_MODEL` or that default. Not in the barrel; consumers deep-import.

### `LLMCandidate` — `packages/backend/src/lib/meta-agent/cascade.ts:12`

One step of the chain.

| Field | Type | Meaning |
|---|---|---|
| `provider` | `string` | Short provider id for logs/events (e.g. `"anthropic"`, `"openrouter"`). |
| `model` | `string` | Model id sent to this provider; overrides `params.model` per attempt. |
| `llm` | `LLMClient` | The provider's client (adapter, OpenAI SDK, or codex client). |

- **Used by:** `createCascadeLLM`; built by `resolveLLMCandidates` (`packages/backend/src/server/llm.ts:47,51`); `packages/backend/src/server/api/settings/test-llm.ts:1,58` (`testChatClient` probes the primary candidate); tests `llm-cascade.test.ts:37`

### `CascadeOptions` — `packages/backend/src/lib/meta-agent/cascade.ts:20`

| Field | Type | Meaning |
|---|---|---|
| `onFallback` | `((info: {provider, model, error, next?: {provider, model}}) => void)?` | Called once per failed candidate before the next is tried; `next` is absent on the final failure. A throwing observer is swallowed ("a buggy observer must never break a tick", cascade.ts:69-71). |

- **Used by:** `createCascadeLLM`; `resolveLLM`'s options extend it (`packages/backend/src/server/llm.ts:125`); the tick handler's `onFallback` emits warning app events (`packages/backend/src/server/api/tick.ts:169-179`)

### `createCascadeLLM(candidates: LLMCandidate[], opts: CascadeOptions = {}): LLMClient` — `packages/backend/src/lib/meta-agent/cascade.ts:31`

Throws at construction if `candidates` is empty (cascade.ts:35-37). The returned client's `chat.completions.create` walks the candidates in order, overriding `params.model` with each candidate's model (cascade.ts:47-50). On success it stamps `res.model = c.model` only when the response carries no model (cascade.ts:53-54), so the spend counter attributes fallback calls to the model that actually served. Fallback triggers on **any** thrown error (bare catch, cascade.ts:56 — no error-type filtering), with one exception: if `options?.signal?.aborted` (cascade.ts:60) the error rethrows immediately because the tick's wall-clock budget aborted the call. After every candidate fails, the **last** error is thrown (cascade.ts:74).

- **Calls:** each candidate's `llm.chat.completions.create`, `opts.onFallback`
- **Called by:** `resolveLLM` (`packages/backend/src/server/llm.ts:128`); tests `llm-cascade.test.ts:36,95+`

---

## `packages/backend/src/lib/meta-agent/codex-app-server.ts`

JSON-RPC 2.0 over newline-delimited stdio to one persistent `codex app-server` subprocess — the transport layer for engine mode (323 lines). RPC flows both ways: client→server `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`; server→client requests `item/tool/call`, the `item/*/requestApproval` family, `mcpServer/elicitation`; server→client notifications `item/started`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`. Server-initiated traffic is routed to per-thread handlers keyed on `params.threadId`, so concurrent agents share one subprocess without seeing each other's calls. Protocol facts verified against codex-cli 0.139.0 (`codex app-server generate-ts` + live probe). `DEFAULT_REQUEST_TIMEOUT_MS = 30_000` (non-exported, codex-app-server.ts:30).

### `JsonRpcTransport` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:33`

Minimal wire abstraction so tests can drive the client without a subprocess.

| Field | Type | Meaning |
|---|---|---|
| `send` | `(line: string) => void` | Write one NDJSON line. |
| `onLine` | `(cb: (line: string) => void) => void` | Subscribe to incoming lines. |
| `onClose` | `(cb: (reason: string) => void) => void` | Subscribe to transport close. |
| `close` | `() => void` | Tear down (subprocess transport sends SIGTERM). |

- **Used by:** `CodexAppServerClient` constructor, `spawnCodexAppServer` (codex-app-server.ts:310); tests `codex-app-server.test.ts:6,17` (in-memory fake)

### `ThreadHandlers` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:40`

| Field | Type | Meaning |
|---|---|---|
| `onRequest` | `((method, params) => Promise<unknown> \| unknown)?` | Server→client request scoped to this thread; return value becomes the RPC result, throwing produces an RPC error response. |
| `onNotification` | `((method, params) => void)?` | Notification scoped to this thread. |

- **Used by:** `CodexAppServerClient.registerThread`; `runTurn` (codex-harness.ts:406); tests `codex-app-server.test.ts`, `codex-harness.test.ts:2,37`

### class `CodexAppServerError` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:55`

`Error` subclass for every transport failure mode: RPC error responses (carrying the server's `code`), request timeouts, sends on a closed client, and in-flight requests rejected on close. Message shape: `codex app-server <method> failed: <message>`.

- **Used by:** `CodexAppServerClient.request`/`handleClose`/`handleLine`; tests `codex-app-server.test.ts:56-64`

### class `CodexAppServerClient` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:66`

The JSON-RPC client. State: monotonic request id, `pending` map (id → resolve/reject/timer), `threadHandlers` map (threadId → `ThreadHandlers`), closed flag.

- `initialize(clientInfo)` (`:87`) — handshake; sends capabilities `{experimentalApi: true, requestAttestation: false}` (`experimentalApi` unlocks `dynamicTools` on `thread/start`, verified 0.139) then the `initialized` notification. Must be called once before any thread/turn request.
- `request(method, params, opts?)` (`:97`) — id-correlated request with per-call timeout (default 30s); rejects with `CodexAppServerError` on error response, timeout, or closed client.
- `notify(method, params?)` (`:122`) — fire-and-forget notification; no-op when closed.
- `registerThread(threadId, handlers)` / `unregisterThread(threadId)` (`:128/:132`) — route server-initiated traffic for one thread.
- `close()` (`:136`) — marks closed, rejects all in-flight requests, clears handlers, closes the transport.
- `isClosed` getter (`:82`).

Incoming-line dispatch (`handleLine`, `:163`): non-JSON lines are ignored (stray logs); id+method → server request, routed to the thread's `onRequest` — its return value is sent as the RPC result, a throw becomes an RPC error `{code: -32000}` (`:219`), and an **unrouted** request gets the fail-closed `defaultServerRequestResult` so the server never hangs (`:226`); id-only → response correlation; method-only → notification routed to `onNotification` (handler errors are logged, never propagated).

- **Calls:** the injected `JsonRpcTransport`, `defaultServerRequestResult`
- **Called by:** constructed by `spawnCodexAppServer` (codex-app-server.ts:322); held by `getSharedCodexClient`/`CodexHarnessConfig.client` (codex-harness.ts:99-119, :92); tests `codex-app-server.test.ts:42+`

### `defaultServerRequestResult(method: string): Record<string, unknown>` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:235`

Fail-closed defaults for unrouted (or explicitly declined) server→client requests: `item/tool/call` → `{success: false, contentItems: [inputText "Tool unavailable: no handler registered."]}`; `mcpServer/elicitation/request` → `{action: "decline", content: null, _meta: null}`; everything else (the `item/*/requestApproval` family, `execCommandApproval`, `applyPatchApproval`) → `{decision: "decline"}`.

- **Called by:** `CodexAppServerClient.handleServerRequest` (codex-app-server.ts:226); `runTurn`'s `onRequest` for non-`item/tool/call` methods (codex-harness.ts:411); tests `codex-app-server.test.ts:191-198`

### `ensureIsolatedCodexHome(baseDir: string): string` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:261`

Prepares `<baseDir>/codex-home/` as an isolated `CODEX_HOME`: copies `auth.json` from `$CODEX_HOME` (or `~/.codex`) if not already present, and writes an empty `config.toml` so agent threads don't inherit the user's MCP servers, plugins, skills, or hooks — token refreshes stay local so the user's interactive CLI session isn't rotated out. The resulting dir (`.simple-harmonic/codex-home/` in practice) holds copied OAuth tokens and is gitignored (`.gitignore:46`).

- **Calls:** `mkdirSync`, `existsSync`, `copyFileSync`, `writeFileSync`
- **Called by:** `getSharedCodexClient` (codex-harness.ts:106)

### `spawnCodexAppServer(opts?: {codexHome?, command?}): CodexAppServerClient` — `packages/backend/src/lib/meta-agent/codex-app-server.ts:276`

Spawns `codex app-server` (command overridable for tests) with env `CODEX_HOME` set to the isolated home and `RUST_LOG` defaulting to `"error"` (codex-app-server.ts:284-285), wires a readline-based `JsonRpcTransport` over stdin/stdout, keeps a 2000-char stderr tail that is folded into the close reason on exit/spawn failure, and returns a `CodexAppServerClient` (uninitialized — caller runs `initialize`). Transport `close` sends SIGTERM.

- **Calls:** `spawn`, `createInterface`, `new CodexAppServerClient`
- **Called by:** `getSharedCodexClient` (codex-harness.ts:107)

---

## `packages/backend/src/lib/meta-agent/codex-harness.ts`

Engine-mode agent execution (564 lines): **codex owns the agent loop, Simple Harmonic owns the hands**. Every SH tool is registered as a `dynamicTool` on the codex thread; when the model picks one, codex sends a blocking `item/tool/call` request back and the harness executes it through the SH `ToolRegistry`. Contrast with `runner.ts`, where SH owns the loop and codex (via `codex-adapter.ts`) is just text-in/text-out per round. The approval gate moves from the loop into the hands: safe calls execute inline; a destructive call replies "pausing for human approval", interrupts the turn, and parks a `CodexThreadSuspension` — codex persists the conversation itself. Calls arrive one at a time (codex blocks per call), so the runner's batch-suspension/`deferredSafe` machinery has no equivalent. Selected by the tick handler when `apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec"` (`packages/backend/src/server/api/tick.ts:187`). `TURN_HARD_CAP_MS = 600_000` (non-exported, codex-harness.ts:52).

### `CodexThreadSuspension` — `packages/backend/src/lib/meta-agent/codex-harness.ts:60`

The engine-mode park. Unlike `AgentSuspension` there is no message transcript — codex persists the conversation in its thread; SH keeps only the handle and the pending call(s). Persisted opaquely in `agents.conversationState` like the runner's shape; the `kind` discriminator is how the tick handler tells them apart.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"codex-thread"` | Discriminator vs. the runner's `AgentSuspension`. |
| `threadId` | `string` | Codex thread handle for `thread/resume`. |
| `pending` | `PendingToolCall[]` | Destructive calls awaiting a human decision (one per pause in practice). |
| `actions` | `ToolResult[]` | Actions already logged this tick before the pause. |

- **Used by:** `runCodexAgentTick` (park `:284-289`, resume `:172-216`), `isCodexThreadSuspension`; `packages/backend/src/server/api/tick.ts:3,490-492`; tests `codex-harness.test.ts:5,257,291`

### `CodexHarnessResult` — `packages/backend/src/lib/meta-agent/codex-harness.ts:69`

| Field | Type | Meaning |
|---|---|---|
| `actionType` | `string` | `"suspended"` on park, `"agent_thought"` for a text-only turn, otherwise `summarize`'s action type. |
| `payload` | `Record<string, unknown>` | As in `AgentRunResult`. |
| `suspension` | `CodexThreadSuspension?` | Present iff parked for approval. |
| `validation` | `ValidationResult?` | Present when `config.outputContract` is set and the tick completed. |
| `usage` | `{inputTokens: number; outputTokens: number}` | Real token usage summed from `thread/tokenUsage/updated` notifications — the exec adapter always reported zero, so engine mode finally gives codex-subscription ticks a real `spend.jsonl` ledger entry. |

- **Used by:** the tick handler's structural `RunOutcome` + usage recording (`packages/backend/src/server/api/tick.ts:444-451, :559-567`)

### `CodexHarnessConfig` — `packages/backend/src/lib/meta-agent/codex-harness.ts:78`

Extends `AgentPromptConfig` (the runner's exported prompt subset) with the execution plumbing:

| Field | Type | Meaning |
|---|---|---|
| `teamId` / `agentId` | `string` | Identity for tool execution. |
| `peers` | `PeerAgent[]` | Teammates. |
| `a2ax` | `A2AXSender` | Message bus. |
| `model` | `string?` | Defaults to `"gpt-5.5"` in every codex request (codex-harness.ts:179,219,247); in practice the tick handler passes the cascade's primary model. |
| `cwd` | `string?` | Working directory codex's (read-only) native tools see; defaults to `process.cwd()`. |
| `signal` | `AbortSignal?` | Tick-budget abort; triggers `turn/interrupt`. |
| `isDestructive` | `((toolName, rawArgs?) => boolean)?` | Approval classifier; defaults to `registry.isDestructive`. |
| `toolRegistry` | `Pick<ToolRegistry, "execute" \| "getOpenAIDefs" \| "isDestructive" \| "listForAgent">?` | Same pick as `AgentConfig.toolRegistry`. |
| `trace` | `TraceSink?` | Play-by-play sink (same contract as the runner's). |
| `resume` | `{suspension: CodexThreadSuspension; decisions: ToolDecision[]}?` | Engine-mode resume state. |
| `client` | `CodexAppServerClient?` | Injected app-server client (tests); defaults to the shared spawned one. |

- **Used by:** `runCodexAgentTick`; built from the tick handler's `shared` object (`packages/backend/src/server/api/tick.ts:446, :562`); tests `codex-harness.test.ts:4,148`

### `getSharedCodexClient(): Promise<CodexAppServerClient>` — `packages/backend/src/lib/meta-agent/codex-harness.ts:102`

One `codex app-server` subprocess per Node process: returns the live shared client, or (deduplicating concurrent callers via a `sharedClientStarting` promise) spawns one with the isolated home at `<process.cwd()>/.simple-harmonic/codex-home` (`ensureIsolatedCodexHome`, codex-harness.ts:106) and initializes it with clientInfo `{name: "simple-harmonic", title: "Simple Harmonic", version: "0.1.0"}`. A closed client is replaced on the next call.

- **Calls:** `ensureIsolatedCodexHome`, `spawnCodexAppServer`, `CodexAppServerClient.initialize`
- **Called by:** `runCodexAgentTick` (codex-harness.ts:140, when no `config.client` is injected)

### `resetSharedCodexClientForTests(): void` — `packages/backend/src/lib/meta-agent/codex-harness.ts:122`

Test hook: closes and clears the shared client and any in-flight startup promise.

- **Called by:** tests only

### `runCodexAgentTick(config: CodexHarnessConfig): Promise<CodexHarnessResult>` — `packages/backend/src/lib/meta-agent/codex-harness.ts:134`

The engine-mode tick entry point. Control flow:

1. Resolves registry/classifier/client; builds the same `ToolRunContext` the runner builds; emits `tick_started {mode, round: 0, runtime: "codex-app-server"}`.
2. **Fresh:** `thread/start` (`:218`) with `model: config.model ?? "gpt-5.5"`, `ephemeral: false` (threads must persist so an approval pause can resume later, possibly from a different process), `sandbox: "read-only"` + `approvalPolicy: "never"` (codex-native tools stay read-only and approval-free — every mutation flows through SH dynamic tools, where the approval gate lives), `developerInstructions: buildSystemPrompt(config, toolDescriptions)`, and `dynamicTools` mapped from `registry.getOpenAIDefs(toolAllowlist(config.tools))` to `{name, description, inputSchema}`. Turn input = `buildTickPrompt(config)`.
3. **Resume:** `thread/resume` (`:177`) with the parked `threadId`; emits `decision_applied` per pending call; **approved** calls execute with SH's own hands via `executeToolTraced`, **rejected** calls never execute; the new turn's input is an `[Approval outcomes]` block relaying each tool result verbatim ("Don't editorialize success" — a failed-but-approved call can't prime the model to claim success) or `REJECTED — <note> Do not retry it.`
4. One turn via `runTurn` (`:243`). Its `item/tool/call` handler: safe → `executeToolTraced` then reply `{success: true, contentItems: [inputText <result>]}`; destructive (per `isDestructive`) → reply `{success: false}` "requires human approval / the turn is pausing now", then `setTimeout(interrupt, 0)` so the reply hits the wire before `turn/interrupt` (`:424`), and park.
5. Parked → emit `approval_requested` (round 0, `deferredSafeCount: 0`) and return `actionType: "suspended"` with the `CodexThreadSuspension`. Turn error → throw `codex turn failed: …`. Otherwise: zero actions → `agent_thought` with the turn's final text; else `summarize(config.name, actions)`; attach `validateContract` when a contract is set; emit `tick_finished`.

Token usage is summed from `thread/tokenUsage/updated` notifications' `last` block (`:444-450`). Trace steps always carry `round: 0`.

- **Calls:** `toolAllowlist`, `ToolRegistry.getOpenAIDefs`/`listForAgent`/`execute`/`isDestructive` (default), `getSharedCodexClient`, `CodexAppServerClient.request` (`thread/start`/`thread/resume`), `buildSystemPrompt`, `buildTickPrompt`, `runTurn`, `executeToolTraced`, `summarize`, `validateContract`
- **Called by:** `packages/backend/src/server/api/tick.ts:446` (fresh, `useCodexHarness` branch) and `:562` (resume of codex-thread suspensions); tests `codex-harness.test.ts:175+` (mocked in `api-tick.test.ts:117-119`)

### `isCodexThreadSuspension(value: unknown): value is CodexThreadSuspension` — `packages/backend/src/lib/meta-agent/codex-harness.ts:557`

Type guard discriminating the two suspension shapes parked in `agents.conversationState`: true iff `value.kind === "codex-thread"` and `value.threadId` is a string. The resume path branches on the **suspension shape**, not the engine-mode flag, so legacy message-based parks (pre-harness or `SH_CODEX_RUNTIME=exec`) still resume through `runAgent`.

- **Called by:** `packages/backend/src/server/api/tick.ts:559`; tests `codex-harness.test.ts:6,237` (mocked in `api-tick.test.ts:119`)

### Internal helpers

- `runTurn(args)` (`:341`) — the turn pump: registers `ThreadHandlers` for the thread, sends `turn/start` with `[{type: "text", text, text_elements: []}]`, executes/parks tool calls via the injected `handleToolCall`, accumulates `agentMessage`/`reasoning` items into `llm_response` trace steps (finishReason `"stop"`/`"reasoning"`), sums token usage, declines non-tool server requests via `defaultServerRequestResult`, and settles on `turn/completed` (parked / completed / error). Guards: 600s hard cap, abort-signal `turn/interrupt`, settled flag, `unregisterThread` cleanup.
- `executeToolTraced(tool, toolArgs, callId, deps)` (`:507`) — `registry.execute` wrapped in `tool_started`/`tool_finished` trace steps; pushes `result.action` into `actions`; catches impl throws and returns `Error: tool "<tool>" failed: <message>` instead of propagating (unlike the runner, where impl errors fail the tick).
- `parseArgs(raw)` (`:548`) — `JSON.parse` falling back to the raw string.
- `IncomingToolCall` (`:328`) / `TurnOutcome` (`:334`) — the pump's call and settle shapes.
- `defaultRegistry` (`:132`) — module-level `createDefaultRegistry()` used when `config.toolRegistry` is omitted.
- `TURN_HARD_CAP_MS` (`:52`) — 600s backstop so a wedged turn can't outlive a forgotten abort signal.

---

## `packages/backend/src/lib/meta-agent/eval/fixtures.ts`

Eval fixtures (T10/D13). Inputs only — there is no single correct team, so the validators grade structure and coherence, not exact output.

### `VisionInput` — `eval/fixtures.ts:13`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Fixture id (e.g. `saas-analytics`). |
| `vision` | `string` | What the founder types into onboarding. |
| `expectAgentsBetween` | `[number, number]` | Rough expected team size for the runner's sanity log (not a hard gate). |

### `VISION_INPUTS: VisionInput[]` — `eval/fixtures.ts:21`

Ten diverse founder visions fed to the live planner: `saas-analytics`, `indie-game`, `newsletter`, `open-source`, `consultancy`, `hardware`, `creator`, `local-biz`, `fintech`, `minimal`. Expected sizes mostly 2-4 agents (hardware/fintech allow 5, minimal expects 1-2).

- **Called by:** `eval/run-eval.ts:57`; tests `eval-validators.test.ts:191`

### `ToolUseScenario` — `eval/fixtures.ts:79`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Scenario id. |
| `instruction` | `string` | The turn's instruction to the agent. |
| `expectedTool` | `string` | The unambiguous correct tool. |
| `argsHint` | `string` | What valid args look like (report annotation only). |

### `TOOL_USE_SCENARIOS: ToolUseScenario[]` — `eval/fixtures.ts:89`

Five scenarios where the right tool is unambiguous: `read-a-file` → `read_file`, `message-a-peer` → `send_message`, `report-a-finding` → `report_action`, `fetch-a-url` → `http_fetch`, `announce-to-team` → `broadcast`.

- **Called by:** tests only (`eval-validators.test.ts:196`) — the live tool-use harness is not wired yet (see the comment in `run-eval.ts:104-107`)

---

## `packages/backend/src/lib/meta-agent/eval/run-eval.ts`

Live eval harness: feeds the fixtures through the **real** planner and grades output with the validators. Requires a live LLM provider, so it is not part of the unit suite — run manually with `npx tsx packages/backend/src/lib/meta-agent/eval/run-eval.ts`. Side-effect-free on import; only `main()` does I/O.

### `KNOWN_TOOLS: Set<string>` (non-exported) — `eval/run-eval.ts:22`

`{send_message, broadcast, report_action, read_file, write_file, run_command, http_fetch, github_api}` — the assignable tool names, kept as a literal so the library eval doesn't import the app's `server/` registry. (Narrower than the app's actual registry: no `coding_task`, `observe_app`, management tools, or custom tools.)

- **Used by:** `runPlannerEval` (run-eval.ts:76)

### `runPlannerEval(): Promise<EvalReport[]>` (non-exported) — `eval/run-eval.ts:33`

Bails (empty array + stderr message) when neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set. Builds `PlannerDeps` directly from env (OpenAI-compatible path: `OPENAI_MODEL` default `"o4-mini"`, `OPENAI_BASE_URL` default api.openai.com; the codex path is not exercised). For each `VISION_INPUTS` entry: calls `plannerStream` with a single user message and a no-op token sink; a non-`spawn` result records a `no_spawn` error report; otherwise grades with `validateSpawnResult(result.result, KNOWN_TOOLS)`, logging PASS/FAIL with an out-of-range size note. Thrown errors become `threw` reports rather than aborting the run.

- **Calls:** `plannerStream`, `validateSpawnResult`
- **Called by:** `main` (run-eval.ts:96)

### `main(): Promise<void>` (non-exported) — `eval/run-eval.ts:94`

Runs the planner eval, prints `Planner: <passed>/<total> passed (<rate>%)` via `summarize` (run-eval.ts:101), and exits 1 on no-provider or any failure, 0 otherwise. Tool-use eval wiring is deferred (the validators exist; the harness would pull `server/` into the library — run-eval.ts:104-107). Guarded by a `process.argv[1].endsWith("run-eval.ts")` check (line 112) so importing the module never triggers an LLM call.

- **Calls:** `runPlannerEval`, `summarize`, `process.exit`
- **Called by:** direct CLI execution only

---

## `packages/backend/src/lib/meta-agent/eval/validators.ts`

Pure, deterministic graders for planner and tool-use output. No I/O, no SDK; tool knowledge is injected (a name set or a schema lookup), mirroring how the approval gate injects its classifier. Unit-tested in `eval-validators.test.ts`, which is what makes the eval suite usable as a prompt-regression guard without an API key.

### `EvalIssue` — `eval/validators.ts:18`

| Field | Type | Meaning |
|---|---|---|
| `severity` | `"error" \| "warn"` | Errors fail the report; warnings don't. |
| `code` | `string` | Stable machine code (e.g. `too_many_agents`, `unknown_tool`). |
| `message` | `string` | Human-readable detail. |

### `EvalReport` — `eval/validators.ts:24`

| Field | Type | Meaning |
|---|---|---|
| `passed` | `boolean` | True iff no `error`-severity issues. |
| `issues` | `EvalIssue[]` | Everything found. |

- **Used by:** `run-eval.ts:18`, `summarize`.

### Constants — `eval/validators.ts:31-33`

- `MIN_SCHEDULE_SECONDS = 10` — below this slams the LLM API (error).
- `MAX_SCHEDULE_SECONDS = 86400` (24h) — above this the agent effectively never runs (warning).
- `MAX_AGENTS = 6` — per the CLAUDE.md voice line "six is more than you'll supervise" (error above it).

### `validateSpawnResult(spawn: SpawnTeamResult, knownTools?: Set<string>): EvalReport` — `eval/validators.ts:50`

Grades a planner spawn for schema validity and coherence: empty/blank `team_name` (`team_name_empty`), zero agents (`no_agents`), more than `MAX_AGENTS` (`too_many_agents`), case-insensitive duplicate agent names (`duplicate_agent_name`), then per-agent checks via `validateAgent`. Passing `knownTools` enables unknown-tool errors; omitting it skips tool-name checking.

- **Calls:** `validateAgent`, `err`
- **Called by:** `run-eval.ts:76`; tests `eval-validators.test.ts:46+`

### `validateAgent(a: SpawnTeamAgent, knownTools?: Set<string>): EvalIssue[]` (non-exported) — `eval/validators.ts:93`

Per-agent checks: empty name (error `agent_name_empty`); empty role/archetype (warnings); missing or <10-char `initial_prompt` (error `agent_prompt_thin`); `schedule_seconds` non-numeric (error `schedule_invalid`), below 10s (error `schedule_too_fast`), above a day (warning `schedule_too_slow`); empty tools (warning `agent_no_tools`); any tool not in `knownTools` (error `unknown_tool`, only when the set is provided).

- **Calls:** `err`, `warn`
- **Called by:** `validateSpawnResult` (validators.ts:87)

### `ToolSchemaLookup` — `eval/validators.ts:144`

| Field | Type | Meaning |
|---|---|---|
| `get` | `(name: string) => {schema: z.ZodType} \| undefined` | Minimal registry view — `ToolRegistry.get` satisfies it structurally. |

### `ToolUseAttempt` — `eval/validators.ts:149`

| Field | Type | Meaning |
|---|---|---|
| `toolName` | `string` | The tool the agent chose. |
| `args` | `unknown` | Already-JSON-parsed args. |
| `expectedTool` | `string?` | The scenario's expected tool, for selection grading. |

### `validateToolUse(attempt: ToolUseAttempt, registry: ToolSchemaLookup): EvalReport` — `eval/validators.ts:164`

Grades one attempt: unknown tool → error `tool_not_found` (args can't be validated, but the selection check still runs); otherwise `schema.safeParse(args)` failure → error `args_invalid` with joined Zod issue details; and a mismatch against `expectedTool` → error `wrong_tool`. Catches "called write_file when it should read_file" and schema-drift regressions.

- **Calls:** `zod safeParse`, `err`
- **Called by:** tests only (`eval-validators.test.ts:127+`) — live wiring tracked as a follow-up in `run-eval.ts:104-107`

### `summarize(reports: EvalReport[]): {total; passed; failed; passRate}` — `eval/validators.ts:197`

Pass-rate aggregation; `passRate` is 1 for an empty input (vacuous pass).

- **Called by:** `run-eval.ts:101`; tests `eval-validators.test.ts:174`

### Internal helpers

- `err(code, message)` (line 35) / `warn(code, message)` (line 38) — `EvalIssue` constructors fixing the severity.

---

## Python backend (FastAPI port) — symbol reference

The idiomatic Python port lives at `backend-py/simple_harmonic/meta_agent/` (the engine core) and reuses the slice-6 tool layer at `backend-py/simple_harmonic/tools/`. It mirrors the TS `packages/backend/src/lib/meta-agent/` modules above, with the same HTTP contract and the same suspend/resume model (834 tests, full 43-endpoint parity). The mapping is not module-for-module: the TS files `types.ts` + `runner.ts` + `trace.ts` + `codex-harness.ts` (the persisted/wire shapes) collapse into one `types.py`; `codex-adapter.ts` + `codex-app-server.ts` + `codex-harness.ts` collapse into one `codex_adapter.py` (the Python port keeps only the app-server runtime); and the `ToolRegistry` / `schemaToParameters` / default-tools surface is **not** re-derived here — it lives under `backend-py/simple_harmonic/tools/` and is re-exported. One new module with no TS analogue (`wiring.py`) bridges the slice-5 LLM resolver to the slice-7 anthropic adapter (codex is engine-mode only, not a cascade candidate).

Conventions in this section: Python uses snake_case, so almost every TS symbol's name changed (`runAgent` → `run_agent`, `validateContract` → `validate_contract`, `buildSystemPrompt` → `build_system_prompt`, etc.); those are noted inline only where non-obvious. **Pydantic-model fields keep camelCase** (`populate_by_name=True`) because they round-trip through `agents.conversationState` and the planner HTTP surface — so `AgentSuspension.deferredSafe`, `CodexThreadSuspension.threadId`, `AgentConfig.teamId`/`outputContract`/`isDestructive`/`toolRegistry` all stay camelCase on the wire. Planner tool-arg fields (`team_name`, `schedule_seconds`, `initial_prompt`, …) are snake_case in both languages because they are the LLM-facing JSON Schema.

### `backend-py/simple_harmonic/meta_agent/__init__.py`

Barrel module (TS `index.ts`). Re-exports the engine surface and, at import time, calls `wire_candidate_factories()` to point the slice-5 resolver hooks at the slice-7 adapters (the side effect the TS `server/llm.ts` performs via static imports). Unlike the TS barrel it **does** re-export the codex adapters and the suspension/trace types (Python has no "deep-import-only" convention here). `ToolRegistry` and `schema_to_parameters` are re-exported from `simple_harmonic.tools.registry`, not redefined.

- `__all__` — `backend-py/simple_harmonic/meta_agent/__init__.py:113` — the public surface (54 names); the engine entry points are `run_agent`, `run_codex_agent_tick`, `planner_stream`, `approve_agent_tick`, `validate_contract`, `build_system_prompt`/`build_tick_prompt`.
- `wire_candidate_factories()` (called) — `backend-py/simple_harmonic/meta_agent/__init__.py:111` — runs once at import.

### `backend-py/simple_harmonic/meta_agent/types.py`

Collapses the TS `runner.ts` / `codex-harness.ts` / `trace.ts` / `planner.ts` type declarations into one module. Persisted/wire shapes are **Pydantic v2** models (camelCase fields); in-process call frames that carry live objects (`AgentConfig`, `ResumeState`, `TraceStep`, `AgentPromptConfig`, `AgentRunResult`) are **dataclasses**. `OpenAIToolDef` (TS `types.ts`) is re-exported here from `simple_harmonic.tools.types`.

- `TraceEventType` — `backend-py/simple_harmonic/meta_agent/types.py:84` — `Literal[...]` union of the 9 step types (TS `trace.ts:15`).
- `TraceStep(type, data)` (dataclass) — `backend-py/simple_harmonic/meta_agent/types.py:97` — one play-by-play step (TS `trace.ts:35`).
- `TraceSink = Callable[[TraceStep], None]` — `backend-py/simple_harmonic/meta_agent/types.py:106` — the sink injection point (TS `trace.ts:41`).
- `PendingToolCall(id, name, arguments)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:114` — a requested tool call in OpenAI wire shape; `arguments` is the raw JSON string (TS `runner.ts:45`).
- `ToolDecision(id, approved, note=None)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:128` — one human decision applied on resume (TS `runner.ts:71`).
- `AgentSuspension(messages, pending, deferredSafe=None, actions, round=0)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:145` — the serialized runner conversation parked in `agents.conversationState` (TS `runner.ts:56`).
- `CodexThreadSuspension(kind="codex-thread", threadId, pending, actions)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:169` — the engine-mode park (no message transcript; codex persists the thread) (TS `codex-harness.ts:60`).
- `is_codex_thread_suspension(value) -> bool` — `backend-py/simple_harmonic/meta_agent/types.py:188` — discriminates the two parked shapes (`kind == "codex-thread"` and `threadId` is `str`); accepts a model, a `model_dump`, or a raw dict (TS `isCodexThreadSuspension`, `codex-harness.ts:557`).
- `ResumeState(suspension, decisions)` (dataclass) — `backend-py/simple_harmonic/meta_agent/types.py:214` — resume input (TS `runner.ts:79`).
- `AgentPromptConfig(name, archetype, tools, initialPrompt, peers, teamGoal, recentHistory, recentValidations, outputContract, a2axContext, appHealthContext)` (dataclass) — `backend-py/simple_harmonic/meta_agent/types.py:226` — the prompt-only subset the harness can satisfy without an LLM client (TS `runner.ts:560` `Pick<>`).
- `AgentConfig(...)` (dataclass, extends `AgentPromptConfig`) — `backend-py/simple_harmonic/meta_agent/types.py:241` — the full input to `run_agent`; adds `teamId`, `agentId`, `a2ax`, `llm`, `model`, `signal` (an `asyncio.Event`, the Python mapping of TS `AbortSignal`), `isDestructive`, `toolRegistry`, `resume`, `trace` (TS `runner.ts:84`).
- `AgentRunResult(actionType, payload, suspension=None, validation=None)` (dataclass) — `backend-py/simple_harmonic/meta_agent/types.py:276` — tick result; doubles as `summarize`'s return (TS `runner.ts:143`).
- `PlannerMessage(role, content)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:296` — one founder↔planner turn (TS `planner.ts:187`).
- `SpawnTeamAgent(name, role, archetype, tools, schedule_seconds, initial_prompt)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:305` — one agent in a spawn proposal (TS `planner.ts:192`).
- `SpawnTeamResult(team_name="", parent_team, cofounder_name, agents)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:316` — `team_name` defaults to `""` to mirror the TS unchecked cast (arm selected on JSON validity alone) (TS `planner.ts:201`).
- `ModifyAgentUpdates(...)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:329` — the `modify_agent` patch fields (TS `planner.ts:208`).
- `ModifyAgentResult(agent_name="", team_name="", updates)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:340` — (TS `planner.ts:217`).
- `CredentialRequest(key="", label="", reason="", help_url=None)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/types.py:350` — (TS `planner.ts:223`).
- `MessageResult` / `SpawnResult` / `ModifyAgentResultEnvelope` / `RequestCredentialResult` (BaseModel arms) — `backend-py/simple_harmonic/meta_agent/types.py:365`, `:372`, `:380`, `:388` — the four discriminated-union variants, each carrying a literal `type` tag and the streamed `content`; the tool arms add `result`. Note the rename: the TS `modify_agent` variant of `PlannerResult` becomes `ModifyAgentResultEnvelope` (distinct from the inner `ModifyAgentResult` payload).
- `PlannerResult` — `backend-py/simple_harmonic/meta_agent/types.py:399` — `Annotated[Union[...], Field(discriminator="type")]`; the Python port of the TS `PlannerResult` union (TS `planner.ts:230`).

### `backend-py/simple_harmonic/meta_agent/contract.py`

Tier-1 structural output-contract validation (TS `contract.ts`). Never raises; pure.

- `ContractIssue(path, message)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/contract.py:24` — (TS `contract.ts:15`).
- `ValidationResult(valid, issues)` (BaseModel) — `backend-py/simple_harmonic/meta_agent/contract.py:31` — (TS `contract.ts:20`).
- `validate_contract(payload, contract) -> ValidationResult` — `backend-py/simple_harmonic/meta_agent/contract.py:38` — entry point; runs the recursive `_validate` and wraps the issues (TS `validateContract`, `contract.ts:33`).
- `_validate(value, schema, path, issues)` (private) — `backend-py/simple_harmonic/meta_agent/contract.py:67` — recursive worker (TS `validate`, `contract.ts:42`).
- `_type_of(value) -> str` (private) — `backend-py/simple_harmonic/meta_agent/contract.py:45` — JS-`typeof`-flavored type name; checks `bool` before `int`/`float` because `bool` subclasses `int` in Python (TS `typeOf`, `contract.ts:108`).

### `backend-py/simple_harmonic/meta_agent/runner.py`

The agent tick runner (TS `runner.ts`). Async (`async def run_agent`); the multi-round tool-use loop with round-atomic suspend/resume. The TS module-level `emit`/`tracedToolCall`/`finish`/`runToolCall`/`orderedResumeCalls` closures and helpers become nested functions and module-level `_`-prefixed helpers.

- `FALLBACK_TOOL_NAMES` — `backend-py/simple_harmonic/meta_agent/runner.py:68` — `["send_message", "broadcast", "report_action"]`; a list constant, not a non-exported local as in TS (`runner.ts:42`). Public/re-exported here.
- `MAX_TOOL_ROUNDS = 3` — `backend-py/simple_harmonic/meta_agent/runner.py:70` — (TS `runner.ts:178`). Re-exported.
- `DEFAULT_MODEL = "o4-mini"` — `backend-py/simple_harmonic/meta_agent/runner.py:71` — the runner's own fallback model (TS inline literal `"o4-mini"`, `runner.ts:312`).
- `ENGINEERING_TOOLS` — `backend-py/simple_harmonic/meta_agent/runner.py:78` — `{"read_file", "write_file", "run_command", "coding_task"}` (TS `runner.ts:543`).
- `ENGINEERING_CONTEXT` — `backend-py/simple_harmonic/meta_agent/runner.py:80` — the engineering-guidance prompt block (TS `runner.ts:547`).
- `tool_allowlist(tools) -> list[str]` — `backend-py/simple_harmonic/meta_agent/runner.py:92` — dedup union of `FALLBACK_TOOL_NAMES` + the configured list (TS `toolAllowlist`, `runner.ts:448`).
- `summarize(agent_name, actions) -> AgentRunResult` — `backend-py/simple_harmonic/meta_agent/runner.py:203` — collapses actions into noop / single / `multi_action` (TS `summarize`, `runner.ts:518`); shared with the codex harness.
- `build_system_prompt(config, tools) -> str` — `backend-py/simple_harmonic/meta_agent/runner.py:230` — composes the system message; `tools` may be dataclass defs or mappings (read via `_attr`) (TS `buildSystemPrompt`, `runner.ts:577`).
- `build_tick_prompt(config) -> str` — `backend-py/simple_harmonic/meta_agent/runner.py:272` — composes the per-tick user message with the conditional context sections (TS `buildTickPrompt`, `runner.ts:607`).
- `run_agent(config) -> AgentRunResult` (async) — `backend-py/simple_harmonic/meta_agent/runner.py:325` — the tick entry point; resolves the registry, computes `tool_defs`/`tool_descriptions` once, runs the resume or fresh path, loops `start_round..MAX_TOOL_ROUNDS`, round-atomically suspends on the first destructive batch, then `summarize` + optional `validate_contract` + `finish` (TS `runAgent`, `runner.ts:181`).
- `_ordered_resume_calls(suspension) -> list[tuple[PendingToolCall, bool]]` (private) — `backend-py/simple_harmonic/meta_agent/runner.py:159` — reconstructs call order on resume (TS `orderedResumeCalls`, `runner.ts:471`).
- `_run_tool_call(call, ctx, actions, registry)` (private async) — `backend-py/simple_harmonic/meta_agent/runner.py:134` — parses args (malformed JSON → returned error string, never raised) and `await registry.execute(...)` (TS `runToolCall`, `runner.ts:426`).
- Nested closures inside `run_agent`: `emit(type_, data)` (`backend-py/simple_harmonic/meta_agent/runner.py:345`, try/except-guarded sink), `traced_tool_call(call, round_)` (`:353`), `finish(result)` (`:392`) — the Python equivalents of the TS in-`runAgent` closures.
- Other private helpers: `_parse_tool_args` (`:116`), `_to_pending_tool_call` (`:125`), `_tool_message` (`:130`), `_elapsed_ms` (`:580`).

### `backend-py/simple_harmonic/meta_agent/approval.py`

The pure approval gate (TS `approval.ts`). The TS structural interfaces (`AgentLike`, `TeamLike`, `ToolCallLike`) become `@runtime_checkable` `Protocol`s with camelCase attributes mirroring the store rows.

- `AgentStatus` / `ApprovalReasonCode` — `backend-py/simple_harmonic/meta_agent/approval.py:27`, `:29` — `Literal` unions (TS `approval.ts` AgentLike.status / `ApprovalReasonCode`).
- `AgentLike` (Protocol: `id`, `name`, `status`, `inFlight`, `nextRunAt`) — `backend-py/simple_harmonic/meta_agent/approval.py:41` — (TS `approval.ts:19`).
- `TeamLike` (Protocol: `id`, `paused`) — `backend-py/simple_harmonic/meta_agent/approval.py:52` — (TS `approval.ts:27`).
- `ToolCallLike` (Protocol: `toolName`, `arguments`) — `backend-py/simple_harmonic/meta_agent/approval.py:58` — (TS `approval.ts:114`).
- `ApprovalDecision(allowed, reason="", reason_code=None)` (frozen dataclass) — `backend-py/simple_harmonic/meta_agent/approval.py:63` — a flat dataclass rather than the TS discriminated union; note `reason_code` is snake_case (a dataclass field, not a wire shape) (TS `ApprovalDecision`, `approval.ts:32`).
- `DestructiveClassifier = Callable[[str, object], bool]` — `backend-py/simple_harmonic/meta_agent/approval.py:73` — (TS `approval.ts:125`).
- `approve_agent_tick(team, agent, now=None) -> ApprovalDecision` — `backend-py/simple_harmonic/meta_agent/approval.py:76` — ordered first-failure checks; clock injectable (defaults to `datetime.now(UTC)`) (TS `approveAgentTick`, `approval.ts:53`).
- `approve_agent_action(_team, _agent, call, is_destructive=_hold_everything) -> ApprovalDecision` — `backend-py/simple_harmonic/meta_agent/approval.py:115` — per-action gate; default classifier `_hold_everything` (`:110`) treats everything as destructive (TS `approveAgentAction`, `approval.ts:139`).

### `backend-py/simple_harmonic/meta_agent/planner.py`

The cofounder ("Harmon") chat planner (TS `planner.ts`). Two backend paths share one tool surface and one `_finalize`. The TS `openaiClient` factory becomes the pluggable module hook `openai_client_factory` (the same seam pattern as `simple_harmonic.llm.candidates`), so tests swap in a fake streaming client. `PlannerDeps` fields are snake_case (`api_key_source`, `codex_access_token`, `codex_account_id`, `fetch_impl`) — they are a dataclass, not a wire model.

- `CODEX_RESPONSES_URL` — `backend-py/simple_harmonic/meta_agent/planner.py:55` — `"https://chatgpt.com/backend-api/codex/responses"` (TS `planner.ts:302`).
- `SPAWN_TOOL_DEF` / `MODIFY_AGENT_TOOL_DEF` / `REQUEST_CREDENTIAL_TOOL_DEF` — `backend-py/simple_harmonic/meta_agent/planner.py:62`, `:144`, `:216` — the three tool definitions; module-level `dict`s here vs. TS non-exported constants (`planner.ts:46`, `:101`, `:155`).
- `PlannerConfig(model, openaiApiKey=None, openaiBaseUrl=None)` (dataclass) — `backend-py/simple_harmonic/meta_agent/planner.py:257` — the resolved LLM config; the TS `PlannerDeps["config"]` inline object becomes its own dataclass (camelCase kept to mirror the TS field names).
- `PlannerResponse` (Protocol) — `backend-py/simple_harmonic/meta_agent/planner.py:266` — the codex-path response shape the injected `fetch_impl` returns (`ok`, `status`, async `text()`, `aiter_bytes()`); models the `httpx.Response` subset. No direct TS analogue (TS uses the web `Response`).
- `PlannerDeps(config, api_key_source, codex_access_token, codex_account_id, fetch_impl)` (dataclass) — `backend-py/simple_harmonic/meta_agent/planner.py:288` — the injected dependency bundle (TS `PlannerDeps`, `planner.ts:10`).
- `openai_client_factory` — `backend-py/simple_harmonic/meta_agent/planner.py:314` — the swappable OpenAI streaming-client builder (default `_default_openai_client_factory`, `:304`); the planner's test seam.
- `planner_stream(messages, on_token, deps) -> PlannerResult` (async) — `backend-py/simple_harmonic/meta_agent/planner.py:322` — public entry point; dispatches to `_codex_responses_stream` or `_openai_chat_stream` on `deps.api_key_source` (TS `plannerStream`, `planner.ts:240`).
- `_openai_chat_stream(...)` (private async) — `backend-py/simple_harmonic/meta_agent/planner.py:338` — Path A (OpenAI Chat Completions streaming) (TS `openaiChatStream`, `planner.ts:255`).
- `_codex_responses_stream(...)` (private async) — `backend-py/simple_harmonic/meta_agent/planner.py:417` — Path B (Codex subscription); POSTs the Responses body via `deps.fetch_impl` and hand-parses the SSE byte stream (TS `codexResponsesStream`, `planner.ts:319`).
- `_codex_headers(deps) -> dict[str, str]` (private) — `backend-py/simple_harmonic/meta_agent/planner.py:404` — builds the Codex auth headers; raises `"No Codex access token available"` (TS `codexHeaders`, `planner.ts:304`).
- `_finalize(full_text, tool_call_name, tool_call_args) -> PlannerResult` (private) — `backend-py/simple_harmonic/meta_agent/planner.py:518` — the shared result assembler (TS `finalize`, `planner.ts:436`).
- `_try_parse(raw, model)` (private) — `backend-py/simple_harmonic/meta_agent/planner.py:539` — parses a tool-arg string into a Pydantic model; falls back to `model_construct` (no validation) to faithfully mirror the TS unchecked `JSON.parse(args) as T` cast; returns `None` only on malformed JSON or a non-object payload. No direct TS function (the cast is inline in TS `finalize`).

### `backend-py/simple_harmonic/meta_agent/default_prompt.py`

- `DEFAULT_META_AGENT_PROMPT` — `backend-py/simple_harmonic/meta_agent/default_prompt.py:13` — the Harmon system prompt, a verbatim port of the TS template literal (TS `default-prompt.ts:1`). Used by both planner backends.

### `backend-py/simple_harmonic/meta_agent/identity.py`

Fixed sentinel identities for the cofounder + human participants (TS `identity.ts`).

- `COFOUNDER_AGENT_ID` — `backend-py/simple_harmonic/meta_agent/identity.py:16` — `"00000000-0000-0000-0000-00000000c0f0"` (TS `identity.ts:4`).
- `DEFAULT_COFOUNDER_NAME` — `backend-py/simple_harmonic/meta_agent/identity.py:18` — `"Harmon"` (TS `identity.ts:6`).
- `PRIMARY_USER_AGENT_ID` / `PRIMARY_USER_DISPLAY_NAME` — `backend-py/simple_harmonic/meta_agent/identity.py:21`, `:22` — the primary human sentinel (`"...fffe"` / `"You"`) (TS `identity.ts:12-13`).
- `USER_AGENT_ID` / `USER_DISPLAY_NAME` — `backend-py/simple_harmonic/meta_agent/identity.py:25`, `:26` — back-compat aliases (TS `identity.ts:16-17`).
- `COFOUNDER_POV` / `USER_POV` — `backend-py/simple_harmonic/meta_agent/identity.py:29`, `:30` — POV sentinels translated to UUIDs by the route layer (TS `identity.ts:21-22`).
- `HumanParticipant(id, name)` (frozen dataclass) — `backend-py/simple_harmonic/meta_agent/identity.py:33` — (TS `identity.ts:24`).
- `get_team_humans(_team_id) -> list[HumanParticipant]` — `backend-py/simple_harmonic/meta_agent/identity.py:39` — fixed singleton (TS `getTeamHumans`, `identity.ts:32`).
- `resolve_cofounder_name(team_cofounder_name) -> str` — `backend-py/simple_harmonic/meta_agent/identity.py:44` — trim-or-default to `DEFAULT_COFOUNDER_NAME` (TS `resolveCofounderName`, `identity.ts:36`).

### `backend-py/simple_harmonic/meta_agent/anthropic_adapter.py`

The cancellation-aware Anthropic adapter (TS `anthropic-adapter.ts`). The OpenAI↔Anthropic message/tool translation is **reused** from `simple_harmonic.llm.adapters` (`_convert_messages`, `_convert_tools`, `_anthropic_to_response`), not re-derived; this module adds only the cancellation race so a tick whose budget fires aborts the in-flight `AsyncAnthropic` request.

- `DEFAULT_TIMEOUT_S = 60.0` — `backend-py/simple_harmonic/meta_agent/anthropic_adapter.py:56` — SDK timeout default (TS 60_000 ms).
- `create_anthropic_client(*, api_key=None, base_url=None, timeout=DEFAULT_TIMEOUT_S) -> LLMClient` — `backend-py/simple_harmonic/meta_agent/anthropic_adapter.py:59` — builds the client; its nested `create` threads the `CompletionOptions` cancellation token into the call (TS `createAnthropicClient`, `anthropic-adapter.ts:102`). Wired into `candidates.anthropic_client_factory`.
- `_create_with_signal(coro, signal)` (private async) — `backend-py/simple_harmonic/meta_agent/anthropic_adapter.py:105` — awaits the SDK coroutine but cancels it if the `asyncio.Event` fires first; the Python mapping of the TS `{ signal }` option. No TS analogue (TS hands the `AbortSignal` straight to the SDK).

### `backend-py/simple_harmonic/meta_agent/codex_adapter.py`

The codex app-server runtime, in one module (TS `codex-adapter.ts` + `codex-app-server.ts` + `codex-harness.ts`). Unlike the TS backend — which keeps a separate `codex exec` one-shot adapter — the Python port is **app-server only**, and the *same* engine serves two callers: the agent tick drives it via `run_codex_agent_tick` (engine mode), and the cascade gets it via `create_codex_app_server_client`, which adapts the engine to the `LLMClient` contract (one turn per call).

- `DEFAULT_CODEX_MODEL = "gpt-5.5"` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:34` — the default thread model.

App-server JSON-RPC transport (TS `codex-app-server.ts`):
- `DEFAULT_REQUEST_TIMEOUT_S = 30.0` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:416` — (TS `DEFAULT_REQUEST_TIMEOUT_MS`).
- `CodexAppServerError(method, code, message)` (Exception) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:419` — message shape `codex app-server <method> failed: <message>` (TS `CodexAppServerError`, `codex-app-server.ts:55`).
- `JsonRpcTransport(send, on_line, on_close, close)` (dataclass) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:428` — the wire abstraction tests fake (TS `JsonRpcTransport`, `codex-app-server.ts:33`).
- `ThreadHandlers(on_request=None, on_notification=None)` (dataclass) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:442` — per-thread routing for server-initiated traffic (TS `ThreadHandlers`, `codex-app-server.ts:40`).
- `default_server_request_result(method) -> dict` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:455` — fail-closed defaults for unrouted server→client requests (TS `defaultServerRequestResult`, `codex-app-server.ts:235`).
- `CodexAppServerClient(transport)` (class) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:484` — the JSON-RPC client (TS `CodexAppServerClient`, `codex-app-server.ts:66`). Methods: `is_closed` getter (`:511`); `initialize(client_info)` (`:514`, returns a `Future` so the request hits the wire synchronously, mirroring TS eager-until-first-await); `request(method, params, *, timeout_s=None)` (`:548`); `notify(method, params=None)` (`:573`); `register_thread`/`unregister_thread` (`:581`/`:584`); `close()` (`:587`). Incoming-line dispatch is `_handle_line` (`:613`); the server-request handler is `_handle_server_request` (`:661`).
- `ensure_isolated_codex_home(base_dir) -> str` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:690` — prepares `<base_dir>/codex-home/` as an isolated `CODEX_HOME` (copies `auth.json`, writes an empty `config.toml`) (TS `ensureIsolatedCodexHome`, `codex-app-server.ts:261`).
- `spawn_codex_app_server(*, codex_home=None, command="codex") -> CodexAppServerClient` (async) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:716` — spawns `codex app-server`, pumps stdout/stderr via asyncio reader tasks, wraps stdio in a `JsonRpcTransport` (TS `spawnCodexAppServer`, `codex-app-server.ts:276`).

Engine-mode harness (TS `codex-harness.ts`):
- `TURN_HARD_CAP_S = 600.0` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:790` — (TS `TURN_HARD_CAP_MS`).
- `CodexHarnessResult(actionType, payload, usage, suspension=None, validation=None)` (dataclass) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:793` — engine-mode tick result; `usage` is real token usage summed from `thread/tokenUsage/updated` (TS `CodexHarnessResult`, `codex-harness.ts:69`). Note `CodexHarnessConfig` has **no separate Python class** — `run_codex_agent_tick` reuses `AgentConfig` (with extra `cwd`/`client` attributes) instead.
- `run_codex_agent_tick(config) -> CodexHarnessResult` (async) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:830` — the engine-mode tick entry point: registers SH tools as codex dynamic tools, executes safe calls inline, parks the turn on the first destructive call (returns a `CodexThreadSuspension`), and on resume applies decisions with SH's own hands before relaying outcomes in the resumed turn's input. Reuses `build_system_prompt`/`build_tick_prompt`/`summarize`/`tool_allowlist` from `runner.py` and `validate_contract` from `contract.py` (TS `runCodexAgentTick`, `codex-harness.ts:134`).
- `_get_shared_codex_client()` (private async) — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:1279` — one app-server subprocess per process, deduplicating concurrent callers via a holder dict; isolated home at `<cwd>/.simple-harmonic/codex-home` (TS `getSharedCodexClient`, `codex-harness.ts:102`).
- `reset_shared_codex_client_for_tests()` — `backend-py/simple_harmonic/meta_agent/codex_adapter.py:1304` — test hook (TS `resetSharedCodexClientForTests`, `codex-harness.ts:122`).
- Private harness helpers: `_run_turn` (`:1058`, the turn pump; TS `runTurn`), `_execute_tool_traced` (`:1226`, TS `executeToolTraced`), `_parse_args` (`:823`), and the pump shapes `_IncomingToolCall` (`:808`) / `_TurnOutcome` (`:815`) (TS `IncomingToolCall` / `TurnOutcome`).
- `create_codex_app_server_client(model=DEFAULT_CODEX_MODEL) -> LLMClient` — the **cascade adapter**: one `create(params, options)` call runs one app-server turn (system msgs -> developerInstructions, tools -> dynamicTools), returning the model's text or — via the park mechanism — the FIRST tool call as `tool_calls`, so the runner/cascade drives the loop. Wired into `candidates.codex_client_factory`. Helpers `_format_codex_messages` / `_tools_to_dynamic_specs`. No single TS analogue (TS uses the exec adapter for the cascade step).

### `backend-py/simple_harmonic/meta_agent/wiring.py`

Bridges the slice-5 LLM resolver to the slice-7 adapters. No TS analogue as a standalone module (the TS `server/llm.ts` wires the factories via static imports).

- `wire_candidate_factories()` — `backend-py/simple_harmonic/meta_agent/wiring.py:28` — idempotently points `candidates.codex_client_factory` → `create_codex_client` and `candidates.anthropic_client_factory` → `create_anthropic_client`; called once at import of `simple_harmonic.meta_agent`.

### `backend-py/simple_harmonic/tools/registry.py` (reused)

The TS `ToolRegistry` / `schemaToParameters` surface lives here, not in `meta_agent/` — re-exported by the `meta_agent` barrel. Zod is replaced by **Pydantic**: a tool's `schema` is a `BaseModel` subclass (both validator and JSON-Schema source).

- `ToolCategory` / `ToolRisk` — `backend-py/simple_harmonic/tools/registry.py:37`, `:41` — `Literal` unions (TS `registry.ts:29`, `:36`).
- `ToolDefinition(name, description, category, risk, schema, is_destructive=None)` (dataclass) — `backend-py/simple_harmonic/tools/registry.py:44` — the data half; `schema` is a Pydantic model type; `is_destructive` receives the parsed args model (TS `ToolDefinition`, `registry.ts:39`).
- `schema_to_parameters(schema) -> dict` — `backend-py/simple_harmonic/tools/registry.py:84` — `schema.model_json_schema()` with `$schema` stripped and `$defs` inlined (via `_inline_refs`, `:68`) since OpenAI/Anthropic parameter blocks carry no `$defs` (TS `schemaToParameters` via `z.toJSONSchema`, `registry.ts:66`).
- `ToolRegistry` (class) — `backend-py/simple_harmonic/tools/registry.py:96` — name-keyed `(definition, impl)` registry (TS `ToolRegistry`, `registry.ts:72`). Methods: `register(definition, impl)` (`:102`, raises on duplicate); `has(name)` (`:111`); `get(name)` (`:114`); `list_for_agent(allowed=None)` (`:118`); `get_openai_defs(allowed=None)` (`:128`); `is_destructive(tool_name, raw_args=None)` (`:142`, a regular method here, not a bound arrow property as in TS — unknown tool → `True`, fail-safe); `execute(name, raw_args, ctx)` (`:159`, async; `model_validate`-then-dispatch, never raises).
