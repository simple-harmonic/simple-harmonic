# 01 — System Overview and Architecture

Simple Harmonic is a self-hosted, single-operator web application in which a human founder runs a hierarchy of autonomous LLM agents organized into teams. Agents execute on a scheduler tick, communicate with each other (and with the founder) over an A2A-extended message protocol persisted as per-team JSON/JSONL files, and act on the world through a permissioned tool registry — filesystem, shell, HTTP, GitHub, coding CLIs, team management, and user-defined API tools. Every destructive action suspends the agent mid-run until the founder approves or rejects it in the UI. Teams are created and reconfigured conversationally through a streaming planner chat persona (default name "Harmon"). All state lives in a **local JSON file store** rooted at `.simple-harmonic/data/` (no database server, single process, single writer); the HTTP layer is a set of transport-agnostic handlers served by **two interchangeable hosts** — the Next.js app and a standalone `node:http` backend that runs without Next. Agent LLM calls go through a **multi-provider cascade** (Codex subscription → Anthropic → OpenRouter → OpenAI) that falls through on provider errors, and every agent run emits a **play-by-play trace** persisted to a per-agent `trace.jsonl` and streamed live to the UI.

This document is the synthesis: what the pieces are, how a request and a tick flow through them, and the cross-cutting facts (model selection, security model, environment variables) that the per-subsystem chapters share. Everything here is derived from the working code at `main @ 0ff84520` (PRs #10–#16 merged; PR #16 replaced Postgres/Drizzle with the JSON file store), as noted in "Repo state" below.

## Repository layout

```
simple-harmonic/
├── src/                          # The Next.js 16 app (App Router)
│   ├── app/api/                  #   30 thin route files re-exporting backend handlers
│   ├── app/(app)/, (auth)/       #   Pages (dashboard, team views, chat, settings, login)
│   ├── proxy.ts                  #   Next 16 proxy (auth gate, formerly middleware)
│   └── instrumentation.ts        #   Startup: secret vault load + dev tick loop
├── packages/
│   ├── backend/                  # @simple-harmonic/backend — source-only workspace package
│   │   ├── src/lib/meta-agent/   #   The engine: runner, planner, registry, adapters,
│   │   │                         #   codex app-server bridge + harness, trace contract, cascade
│   │   ├── src/server/           #   I/O layer: config, auth, secrets, spend, events,
│   │   │                         #   LLM provider resolution (llm.ts), trace sink (trace.ts)
│   │   ├── src/server/api/       #   ALL HTTP route handlers (shared by both hosts)
│   │   ├── src/server/standalone/#   node:http host: main.ts, server.ts, routes.ts, setup-db-cli.ts
│   │   ├── src/server/store/     #   The JSON file store: data-dir + path helpers, sync fs
│   │   │                         #   primitives, location index, serialize, types, repos/ (8)
│   │   ├── src/server/tools/     #   The 12 server tool implementations + sandbox + SSRF guard
│   │   └── tests/unit/           #   The unit suite (incl. route-handler and host-parity tests)
│   ├── frontend/                 # @simple-harmonic/frontend — source-only React components
│   └── a2ax/                     # @simple-harmonic/a2ax — agent-comm protocol library (built dist/ committed)
├── scripts/                      # seed-demo.ts (destructive seeder; wipes + repopulates the data dir)
├── tests/e2e/                    # Playwright specs
├── .simple-harmonic/             # Runtime root: data/ (the JSON state store — see below), JSON custom
│                                 #   tools, connectors, secrets.json, codex-home/ (isolated CODEX_HOME)
└── vercel.json                   # Production cron: GET /api/tick every minute
```

`.simple-harmonic/data/` is the live state root (overridable via `SH_DATA_DIR` or config). Its on-disk layout — recursive teams, per-agent folders, per-team a2ax message files, and a global `system/` folder — is detailed in [02 — Data Model](02-data-model.md).

The backend and frontend packages export raw TypeScript (`"./*": "./src/*"`) and are compiled by the root Next build via tsconfig path mappings; only `a2ax` ships a built `dist/`, which is committed to git. Details in [09 — Testing and Tooling](09-testing-and-tooling.md).

## Runtime topology

One Node.js process — either the Next.js server **or** the standalone backend host (`npm run dev:backend`, port 3001; see [10 — Standalone Host](10-standalone-host.md)) — talks to:

| Dependency | Used for | Where |
|---|---|---|
| Local JSON file store under `.simple-harmonic/data/` (no database server) | All state: teams, agents, approvals, a2ax messaging, events, spend ledger, trace events — synchronous fs IO, single process / single writer | [02 — Data Model](02-data-model.md) |
| The LLM provider cascade: Codex app-server subprocess, Anthropic API, OpenRouter, OpenAI-compatible APIs | Agent ticks (cascading) and the planner chat (single provider) | [03 — Meta-Agent Engine](03-meta-agent-engine.md), [04 — Server Layer](04-server-layer.md) |
| `codex app-server` (persistent JSON-RPC subprocess) | Engine-mode agent ticks on the Codex subscription path | [03 — Meta-Agent Engine](03-meta-agent-engine.md) |
| `codex` / `claude` / `opencode` CLIs (one-shot subprocesses) | The `coding_task` tool | [05 — Tool System](05-tool-system.md) |
| GitHub REST API, arbitrary public HTTPS hosts | `github_api`, `http_fetch`, and JSON-defined custom API tools (all behind the SSRF guard) | [05 — Tool System](05-tool-system.md) |
| Local files: `.simple-harmonic/`, `.apollo/`, `~/.codex/` | Custom tools, connectors, plaintext + encrypted secrets, Codex OAuth (copied into an isolated `codex-home/`) | [04 — Server Layer](04-server-layer.md) |

There are no background workers. Time advances only when `POST /api/tick` is called: by a Vercel cron every minute in production, by a 10-second self-POST loop in local dev (from `src/instrumentation.ts` under Next, or in-process in the standalone host; `SH_TICK_LOOP=0` disables the latter). The UI's SSE surfaces (chat tokens, narration feed, trace stream) are streamed HTTP responses fed by the LLM stream and by short-interval polling of the file store — there is no pub/sub.

## Core domain concepts

- **Team** — a `team.json` record under `teams/<teamId>/`, optionally nested inside a parent team's `teams/` folder (recursive), forming a tree. Teams carry a goal, a pause flag, a tick counter, and `lastUserActiveAt`, which drives hibernation. A team's on-disk path is not derivable from its id (depth varies), so the store keeps an in-memory **location index** (`store/index-cache.ts`) mapping teamId/agentId → folder.
- **Agent** — an `agent.json` record under `teams/<teamId>/agents/<agentId>/`: name, role, free-form archetype, a tool-name allowlist, a schedule in seconds, a system prompt, an optional JSON-schema output contract, and scheduler state (`status`, `nextRunAt`, `inFlight`, `conversationState`).
- **Tick** — one invocation of `POST /api/tick`: every due agent in every active team gets one run — either the in-process runner loop (max 3 tool rounds) or, on the Codex path, an engine-mode turn driven by the `codex app-server`.
- **A2AX** — the message bus: direct/broadcast/group/task channels persisted per team under `teams/<teamId>/messages/` (`log.jsonl`, `reads.jsonl`, `channels.json`, `members.json`, `tasks.json`, `cards.json`, `tokens.json`) with per-recipient read tracking. The `JsonFileTransport` hydrates this into memory by walking the team tree so teamId-less protocol methods resolve O(1). Agents read their unread context at the start of a tick and send via `send_message`/`broadcast` tools.
- **Harmon (the planner)** — a separate streaming LLM path behind `POST /api/chat` that converses with the founder and emits structured `spawn_team` / `modify_agent` / `request_credential` tool calls. It is not a tick-driven agent; on root teams, `POST /api/spawn` additionally creates a Harmon *agent* (archetype `meta-agent`, management tools, hourly schedule) that participates in ticks.
- **Identity sentinels** — two fixed UUIDs let non-agents use the bus: the cofounder (`…c0f0`) and the human founder (`…fffe`), defined in `packages/backend/src/lib/meta-agent/identity.ts`.
- **Custom tool** — a JSON file `.simple-harmonic/skills/<name>.json` describing an authenticated HTTP API (`ApiToolConfig`); loaded per team per tick and registered as a callable tool whose non-GET calls require approval.
- **Approval** — a pending-approval record (in the agent's `approvals.json`) created when an agent's run hits a destructive tool call; the run is suspended until the founder decides, then resumed on a later tick. Two suspension shapes exist in the agent's `conversationState`: the runner's serialized message-list `AgentSuspension`, and the engine-mode `{ kind: "codex-thread", threadId, pending }` (the conversation lives in the codex thread).
- **Trace** — every agent run emits typed play-by-play events (LLM request/response, tool calls, decisions) through a fire-and-forget sink that appends to the agent's `trace.jsonl`, streamed to the UI via `GET /api/team/[id]/trace` and pruned after `SH_TRACE_RETENTION_DAYS` (default 14).

## The life of a tick (end to end)

This is the system's central control flow, stitched across [06 — HTTP API](06-http-api.md) (the handler), [03 — Meta-Agent Engine](03-meta-agent-engine.md) (the runner, harness, and cascade), and [05 — Tool System](05-tool-system.md) (the tools).

1. **Trigger + auth.** Vercel cron (or a dev loop) hits `/api/tick`. The proxy exempts this path; the handler (`packages/backend/src/server/api/tick.ts`) accepts an `x-vercel-cron` header or `Bearer CRON_SECRET`.
2. **Housekeeping.** Once per process, stale `inFlight` flags are cleared; every tick fires the hourly-throttled trace retention sweep (`pruneTraceEvents`, `tick.ts:120`), which rewrites each `trace.jsonl` past the retention window.
3. **Team selection.** Unpaused teams whose `lastUserActiveAt` is within 5 minutes tick; everything else hibernates. The UI keeps watched teams awake with a 30-second heartbeat; resolving an approval also bumps the timestamp.
4. **LLM resolution.** `resolveLLM` (`tick.ts:146`) builds one cascading client per tick from every configured provider, in priority order: Codex subscription → Anthropic (`ANTHROPIC_MODEL`, default `claude-sonnet-4-20250514`) → OpenRouter (`OPENROUTER_MODEL` plus comma-separated `OPENROUTER_FALLBACK_MODELS`, one cascade step each) → OpenAI platform key. A provider error on one step falls through to the next (`onFallback` is observed for events/logs); an abort from the per-run timeout stops the chain. The tick also decides engine mode here: `useCodexHarness = apiKeySource === "codex" && SH_CODEX_RUNTIME !== "exec"` (`tick.ts:164`).
5. **Spend gate.** Today's UTC total in the `spend` ledger (`system/spend.jsonl`) is compared to the daily cap (default $50). Over cap → the tick exits early. An unreadable ledger fails open with a warning event.
6. **Per team:** the tool registry is rebuilt (15 built-ins + on-disk JSON custom tools), errored agents are flipped back to `running`, then two concurrent passes run — a **resume pass** for parked agents whose approvals are all resolved (resume routing is by suspension *shape*: codex-thread suspensions resume through the app-server harness, legacy ones through `runAgent`), and a **fresh pass** for agents passing the pure `approveAgentTick` gate, each claimed by a compare-and-set on `inFlight`.
7. **Inside a run** — each run gets its own trace sink and counting LLM wrapper. In **runner mode** (`runAgent`): the model sees its system prompt, peers, unread a2ax messages, recent history, and the offered tool set; tool calls are Zod-validated and dispatched; the first round containing any destructive call suspends the whole round before executing anything. In **engine mode** (`runCodexAgentTick`): a persistent `codex app-server` owns the loop — every Simple Harmonic tool is registered as a dynamic tool on the thread, the model calls back over JSON-RPC, safe calls execute through the same registry, and a destructive call answers "requires human approval", interrupts the turn, and parks a codex-thread suspension. Codex-native tools run read-only with `approvalPolicy: never` — all mutations flow through the SH tools where the approval gate lives.
8. **Result handling.** A suspension parks the agent (writes `conversationState`) and appends pending-approval records to the agent's `approvals.json` without advancing `nextRunAt` (the trace `tickId` is parked alongside, so the resumed run continues the same trace thread); because store IO is synchronous and single-writer, the park-and-record is effectively atomic within the tick. A completion appends an action-log entry to the agent's `actions.jsonl` (with contract validation merged in, runner mode only) and reschedules `nextRunAt = now + scheduleSeconds`. On any non-throwing fresh result the gathered a2ax messages are marked read and spend is appended to `system/spend.jsonl` — engine-mode runs report **real** token usage from the app-server (`thread/tokenUsage/updated`), so Codex-path ticks now write genuine spend rows (the legacy exec adapter still reports none). Any failure (including the 120-second per-run timeout) marks the agent `errored`, advances its schedule, emits an app event, broadcasts a `[SYSTEM]` alert to peers, and records nothing.
9. **Feedback loops.** The agent's `actions.jsonl` feeds the UI narration stream and the agent's own "recent actions" memory next tick; the per-agent `trace.jsonl` feeds the live trace view; app events (per-team `events.jsonl`, plus `system/events.jsonl` for infra-level events) feed agent prompts and the `observe_app` tool (infra-level events go only to the founder's infra report).

## The founder loop (chat → spawn → watch → approve)

1. `/new` streams the founder's conversation through `POST /api/chat` → `plannerStream`. Text tokens stream as SSE; a `spawn_team` tool call surfaces as an editable proposal card.
2. Accepting the card calls `POST /api/spawn`, which creates the team, agents (staggered `nextRunAt`), and — on root teams — the Harmon cofounder agent. The browser navigates to `/f/{teamId}`.
3. The team page polls state every 10 s, heartbeats every 30 s (keeping the team out of hibernation — an unwatched team stops ticking after 5 minutes), renders the narration SSE feed, and offers the play-by-play trace view (per-agent trace tab; dashboard toggle).
4. Destructive tool calls appear in the approval queue (4-second poll); approve/reject resolves the pending-approval record (in the agent's `approvals.json`), and the next tick's resume pass continues the agent's run.
5. `modify_agent` planner calls are applied server-side directly — but the UI has no handler for the resulting SSE event, so the founder sees no confirmation (see Known gaps). `request_credential` calls render a card that stores the secret in the encrypted Apollo vault via `POST /api/settings/credentials`.

## Model and provider selection

The API-key source resolves config file → env → Codex CLI token (`getApiKeySource()` in `packages/backend/src/server/config.ts`). Three call sites use it differently:

| Surface | Selection | Models |
|---|---|---|
| Agent ticks (`/api/tick`) | `resolveLLMCandidates` cascade (`packages/backend/src/server/llm.ts:47`): Codex → Anthropic → OpenRouter (one step per configured model) → OpenAI; per-call fallback on provider errors. On the Codex step, engine mode (app-server harness) unless `SH_CODEX_RUNTIME=exec` | Codex `cfg.model \|\| "gpt-5.5"`; Anthropic `ANTHROPIC_MODEL \|\| claude-sonnet-4-20250514`; OpenRouter `OPENROUTER_MODEL \|\| anthropic/claude-sonnet-4` (+ fallback list); OpenAI `cfg.model` |
| Planner chat (`/api/chat`) | **No cascade** — single provider: `apiKeySource === "codex"` → direct SSE POST to `chatgpt.com/backend-api/codex/responses`; anything else → OpenAI SDK streaming | `cfg.model` |
| `coding_task` tool | Independent: `codingBackend` config (`codex` default \| `claude-code` \| `opencode`) | per-backend `codingConfig.model` |

With no config file on disk (see "Repo state") and no `OPENAI_API_KEY`, a machine with a Codex CLI login runs ticks through the app-server harness and the planner through the ChatGPT subscription; `cfg.model` falls back to the committed code default `o4-mini` (`config.ts:33`). Only if `cfg.model` were empty would the Codex cascade step itself fall back to `DEFAULT_CODEX_MODEL = "gpt-5.5"` (`llm.ts:29`); since `cfg.model` always resolves to at least `o4-mini`, that default is unreachable in practice.

## Security model

Defense layers, each detailed in its chapter:

1. **Operator gate** ([04](04-server-layer.md), [06](06-http-api.md)): single shared `OPERATOR_PASSWORD`; the `sh_operator` cookie is the deterministic `sha256(password)` (no sessions, no logout). `src/proxy.ts` gates everything except `/login`, `/api/login`, and `/api/tick`; the standalone host applies the same gate to API paths ([10](10-standalone-host.md)). Production with no password set fails closed (503); dev is open.
2. **Cron gate**: `/api/tick` accepts `x-vercel-cron` (trusted header) or `Bearer CRON_SECRET`.
3. **Filesystem jail**: all file/shell/coding tool paths resolve under `toolsRoot()` (`SH_TOOLS_CWD` or cwd) with symlink-aware containment; `read_file` additionally denies secret-bearing paths (`.env*`, `secrets.json`, `.apollo/`, SSH keys, `*.pem`/`*.key`).
4. **Shell hardening**: `run_command` is shell-free `execFile` over a program allowlist with git-subcommand and argument screening; child env is scrubbed to a small benign set.
5. **SSRF guard**: every agent-driven outbound request (https only, no credentials in URL, no localhost/private/CGNAT/link-local/multicast ranges, all DNS records checked) gets an IP pin carried into the TLS connection, closing the rebinding TOCTOU — and the check runs before any bearer token is attached.
6. **Two destructive gates**: the `SH_ENABLE_TOOLS` kill switch (default **off**; covers `write_file`, `run_command`, `coding_task`, mutating `github_api`) and the per-call human approval suspend (all destructive built-ins plus non-GET custom-tool calls; unknown tool names are fail-safe destructive). In engine mode the same registry gate applies — codex-native tools are confined to a read-only sandbox with `approvalPolicy: never`, so mutations can only happen through the gated SH dynamic tools.
7. **Codex credential isolation**: engine-mode agents run against a copied `CODEX_HOME` under `.simple-harmonic/codex-home/` (gitignored) with an empty `config.toml`, so agents inherit none of the operator's MCP servers/plugins and token refreshes don't rotate the operator's interactive session.
8. **Secrets**: two stores — the AES-256-GCM Apollo vault (`.apollo/vault.enc`, loaded into `process.env` at boot) and the **plaintext** `.simple-harmonic/secrets.json` (which shadows env/vault values in `resolveConnector`). Trace messages are PII-scrubbed before insert. Spend is capped globally per UTC day.

## Environment variables (master list)

| Variable | Default | Purpose |
|---|---|---|
| `OPERATOR_PASSWORD` | unset (dev open, prod 503) | The single operator credential |
| `CRON_SECRET` | unset (dev open, prod closed) | Bearer auth for `/api/tick` |
| `SH_DATA_DIR` | `<cwd>/.simple-harmonic/data` | Root of the JSON file store (config file `dataDir` takes precedence when present) |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — / `https://api.openai.com/v1` / code default | OpenAI-compatible LLM config fallbacks |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | — / `claude-sonnet-4-20250514` / — | Enables the Anthropic cascade step; claude-code coding engine auth |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_BASE_URL` | — / `anthropic/claude-sonnet-4` / — / `https://openrouter.ai/api/v1` | Enables the OpenRouter cascade step(s) |
| `SH_CODEX_RUNTIME` | unset (engine mode) | `exec` reverts Codex-path ticks to the legacy one-shot exec adapter |
| `SH_TRACE_RETENTION_DAYS` | `14` | Trace-event retention; pruned hourly from the tick |
| `SH_ENABLE_TOOLS` | off | Kill switch for write/shell/coding/github-write tools |
| `SH_TOOLS_CWD` | `process.cwd()` | Filesystem jail root (also roots `.simple-harmonic/`) |
| `SH_AGENT_TIMEOUT_MS` | `120000` | Per-agent-run wall-clock budget |
| `SH_DAILY_SPEND_CAP_CENTS` | `5000` ($50) | Global daily LLM spend cap |
| `SH_CODING_BACKEND` | `codex` | Coding engine: `codex` \| `claude-code` \| `opencode` |
| `SH_BACKEND_PORT` / `PORT` | `3001` | Standalone host port |
| `SH_TICK_LOOP` | on (`0` disables) | Standalone host in-process tick loop |
| `APOLLO_MASTER_KEY` | auto-generated file | Vault master key override |
| `CODEX_HOME` (`HOME`) | `~/.codex` | Source of Codex CLI OAuth files (copied into the isolated agent home) |
| `GITHUB_TOKEN` | — | `github_api` auth (via connector resolution) |
| `HTTPS_PROXY` / `HTTP_PROXY` (+ lowercase) | macOS `scutil` fallback | Outbound proxy for all server HTTPS |
| `NODE_ENV`, `VERCEL`, `NEXT_RUNTIME` | — | Runtime detection (prod fail-closed, dev tick loop) |
| arbitrary `UPPER_SNAKE` keys | — | Connector secrets via Apollo vault / `secrets.json` / env |

## Repo state and parked work

The documented system is `main @ 0ff84520` (PRs #10–#16; PR #16 ripped out Postgres/Drizzle and replaced it with the JSON file store). The local checkout this report was written from is **stale**: it still sits at `9f301cc` (the Postgres world) and has **not** pulled PR #16, and it carries uncommitted edits that all *predate* PR #16 — a `packages/backend/src/server/config.ts` change flipping the default model from `o4-mini` to `gpt-5.5`, and a `packages/frontend/src/components/chat/use-chat.ts` frontend edit (plus an untracked `.vscode/`). Once that checkout pulls, Postgres and those config edits are gone or superseded: PR #16 already rewrote `config.ts` (removing `databaseUrl`/`DATABASE_URL`, adding `dataDir`/`SH_DATA_DIR`, committed model `o4-mini`), so the local model edit is moot. `simple-harmonic.config.json` is absent from disk, so configuration resolves entirely from environment variables and code defaults.

**Parked: the skills-directory migration (`stash@{0}`).** A previously-documented uncommitted work line replaced the flat-JSON custom tools with directory-based `SKILL.md` skills (sub-skill trees, progressive disclosure, persisted `open_skills`, a `close_skills` tool). That code was discarded from the working tree on 2026-06-11 and exists nowhere in the repo; only its untracked files survive in `git stash@{0}` — the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees and `packages/backend/tests/unit/skill-tree.test.ts` (the stash also holds the swept `simple-harmonic.config.json` and gitignored artifacts). Re-landing the feature means re-implementing the loader/registry/runner changes on top of the extracted-handler layout.

## Known gaps and inconsistencies (as of this report)

The chapters flag these in place; the load-bearing ones, collected:

- **Vestigial surface**: conversation/session records are created on every team-creation path but only ever read to cascade-delete; `cards.json`/`tokens.json` (a2ax agent cards and tokens), group lifecycle, and message expiry are persisted by the `JsonFileTransport` but never exercised by the app.
- **Single-process, single-writer**: all store IO is synchronous and there is no write queue or lock file. One process per data dir — the model relies on Node's single-threaded event loop, so it does **not** support horizontal scaling, multiple replicas, or a serverless/multi-instance deployment sharing one data dir.
- **Location index full-rebuild**: any team/agent create/delete/move invalidates the in-memory location index, so the *next* tree access re-walks the entire `teams/` tree from disk. Cheap at the intended scale (<100 teams) but O(tree) per mutation, not incremental.
- **Data dir must be writable and persistent**: the store assumes a durable local filesystem. On ephemeral or read-only hosts (e.g. serverless functions, immutable container layers) state is lost or writes fail; `POST /api/settings/test-db` round-trips a probe file to surface this, but nothing enforces persistence at runtime.
- **The planner does not cascade**: `/api/chat` still uses a single provider (Codex subscription or one OpenAI-compatible endpoint); a provider outage that ticks survive via fallback still breaks the founder chat. The legacy `SH_CODEX_RUNTIME=exec` path also still records zero spend (no usage reporting), unlike engine mode.
- **Planner→UI contract gaps**: the chat route emits a `modify_agent` SSE event that `useChat` has no branch for — Harmon's agent edits apply server-side with no visible confirmation; the `spawn` event's `parentTeam` field is dropped by the UI's spawn POST, so planner sub-team proposals always spawn as **root** teams (and gain an auto-added Harmon cofounder agent).
- **Suspension side effects (runner mode)**: messages consumed by a run that suspends are marked read and never re-delivered — the resume path gathers no context, so messages arriving while parked wait for the next fresh tick; resumed completions are never contract-validated; and a failed or timed-out resume deletes the pending-approval records (`approvals.json`) and clears `conversationState`, losing the suspension and the human decisions entirely.
- **Allowlist gates offering, not execution** (runner mode): the runner executes any *registered* tool the model names, even if not offered this round (the destructive gate still applies).
- **The skills settings routes use the built-ins-only registry** (`createAppRegistry`, GET catalog and PATCH validation alike), so JSON custom tools neither appear there nor can be granted through that endpoint (the tick loop honors them).
- **`write_file` skips the sensitive-path denylist** that `read_file` enforces.
- **Auth is a deterministic hash cookie** with no rotation/logout; `x-vercel-cron` is trusted on header presence alone.
- **Misc**: seed route reports `messageCount: 27` but sends 32; agent-hub fetches the *oldest* 200 messages; `getAgentContext` truncation keeps oldest unread; teams with null `lastUserActiveAt` never tick; UI token/cost stat cards remain synthetic tick-count estimates even though engine-mode runs now write real usage to the spend ledger (`system/spend.jsonl`); the messages view's broadcast compose placeholder uses channel id `broadcast:<teamId>` while the backend uses `team:<teamId>`, so the placeholder thread never merges with the real one; the UI swallows the 409 returned when waking/pausing a parked agent.

## Chapter map

| Doc | Covers |
|---|---|
| [02 — Data Model](02-data-model.md) | The JSON file store: on-disk layout, the 8 repos and their row types, the sync fs primitives, the location index, the data-dir init mechanism (route + `data:init` CLI) |
| [03 — Meta-Agent Engine](03-meta-agent-engine.md) | The runner loop, suspension/resume, registry, the codex app-server engine mode, the trace contract, the provider cascade, planner, adapters, eval harness |
| [04 — Server Layer](04-server-layer.md) | Config, Apollo vault, Codex auth, connectors, custom-tool loader, operator auth, spend, LLM provider resolution, trace sink, team tree, app events |
| [05 — Tool System](05-tool-system.md) | All 15 built-in tools, sandbox/jail, SSRF guard, coding engines, JSON-defined API tools |
| [06 — HTTP API](06-http-api.md) | All 30 routes and their extracted handlers, the tick in depth, the chat SSE protocol, proxy/auth, deployment config |
| [07 — Frontend](07-frontend.md) | Every page, the chat/team-view/trace components, polling and SSE cadences, theming |
| [08 — A2AX Protocol](08-a2ax-protocol.md) | The agent-messaging library: protocol class, transports, task state machine, used vs. dormant surface |
| [09 — Testing and Tooling](09-testing-and-tooling.md) | Monorepo wiring, test architecture, CI, lint, seeds, deploy, README drift, repo state |
| [10 — Standalone Host](10-standalone-host.md) | The Next-free `node:http` host: startup, request bridge, route manifest, auth, the `data:init` CLI, parity tests |

## Python backend (FastAPI port)

A second, byte-compatible implementation of the entire backend lives under [`backend-py/`](../backend-py/) — an idiomatic Python rewrite of `packages/backend` + `packages/a2ax`, running on FastAPI as a **parallel service** rather than an in-place edit. It speaks the **same HTTP/WS contract** as the TypeScript runtime (all 43 method+path combos, camelCase JSON keys, ISO-8601 datetimes, matching status codes) and reads/writes the **same on-disk JSON file store** at `.simple-harmonic/data/`, so the Next.js frontend can point at either host unchanged and both runtimes can run side by side against one data dir. Cutover is env-gated: `PY_BACKEND_URL` makes Next's `rewrites()` forward `/api/*` to the Python host (default off; see [`next.config.ts`](../next.config.ts) and [10 — Standalone Host](10-standalone-host.md) for the host parallel). The port is described stack-and-slices in [`backend-py/ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md) and [`backend-py/MIGRATION.md`](../backend-py/MIGRATION.md); this section is the overview-level orientation.

### Stack decision

A judge panel scored three agent-orchestration approaches against *this specific* design (recursive teams, a meta-agent planner, a cron tick loop, coding tools, the A2A-Extended protocol, a provider cascade). The winner (9/10) was **raw `anthropic` + `openai` async SDKs behind a duck-typed `LLMClient` Protocol plus a custom asyncio orchestration loop** — because the existing TS backend is *already* "raw SDKs + a custom loop behind a duck-typed LLM seam," so adopting it is effort, not architectural friction. Pydantic AI (4/10) and LangGraph (3/10) each fit only a narrow slice (structured planner output; durable pause/resume) and would be fought everywhere else — full rationale in [ARCHITECTURE.md](../backend-py/ARCHITECTURE.md#stack-decision). The resulting stack: **Python 3.14** managed by `uv`; **FastAPI on uvicorn** (ASGI); **Pydantic v2** replacing Zod (its `model_json_schema()` feeds the LLM tools array exactly as Zod's `zodToJsonSchema` did); **asyncio throughout** with blocking fs IO pushed to threads via `anyio.to_thread`; and the *defining* idiomatic-Python choice — an **explicit `asyncio.Lock` around every store read-modify-write** to recover the atomicity Node got for free from its single-threaded event loop (see "Fidelity behaviors" below). `ruff` + `pytest` (+ `pytest-asyncio`) replace Biome + Vitest.

### TS subsystem → Python module map

The Python package is a layered `simple_harmonic/` tree whose directories mirror the TS subsystems one-to-one. The high-level map (per-chapter detail follows each chapter's own Python section):

| TS subsystem | Python module(s) | Chapter |
|---|---|---|
| `server/config.ts` | [`settings.py`](../backend-py/simple_harmonic/settings.py) (pydantic-settings, same env vars) + [`config.py`](../backend-py/simple_harmonic/config.py) (`get_api_key_source`) | [04](04-server-layer.md) |
| `server/standalone/{server,routes,main}.ts` + the proxy gate | [`app.py`](../backend-py/simple_harmonic/app.py) (`create_app` factory, `OperatorGateMiddleware`, lifespan, `main()`) | [10](10-standalone-host.md) |
| `server/api/**` (the 30+ handlers) | [`routes/`](../backend-py/simple_harmonic/routes/) — `health`, `login`, `settings`, `teams`, `team`, `core` (chat/spawn/seed/infra-report/agent) | [06](06-http-api.md) |
| `server/store/**` (JSON file store, 8 repos, location index) | [`store/`](../backend-py/simple_harmonic/store/) — `fs`, `data_dir`, `index_cache` (`store_lock`), `serialize`, `repo_store`, `repos/` (the 8 repos) | [02](02-data-model.md) |
| `packages/a2ax/src/**` | [`a2ax/`](../backend-py/simple_harmonic/a2ax/) (Pydantic models + `A2AX` facade + `MemoryTransport`/`JsonFileTransport`); process-wide instance in [`a2ax_singleton.py`](../backend-py/simple_harmonic/a2ax_singleton.py) | [08](08-a2ax-protocol.md) |
| `server/llm.ts`, `spend.ts`, `connectors.ts`, `custom-tools.ts`, `apollo.ts`, `proxy-fetch.ts`, `codex-auth.ts` | [`llm/`](../backend-py/simple_harmonic/llm/) (cascade/candidates/adapters/spend/codex_auth) + [`apollo.py`](../backend-py/simple_harmonic/apollo.py), [`connectors.py`](../backend-py/simple_harmonic/connectors.py), [`custom_tools.py`](../backend-py/simple_harmonic/custom_tools.py), [`proxy_fetch.py`](../backend-py/simple_harmonic/proxy_fetch.py) | [03](03-meta-agent-engine.md), [04](04-server-layer.md) |
| `server/tools/**` | [`tools/`](../backend-py/simple_harmonic/tools/) (registry, sandbox, url_guard, filesystem/shell/network/management/observe, `coding/` CLI drivers) | [05](05-tool-system.md) |
| `lib/meta-agent/**` | [`meta_agent/`](../backend-py/simple_harmonic/meta_agent/) (planner, runner, approval, contract, identity, codex/anthropic adapters) | [03](03-meta-agent-engine.md) |
| `server/team-tree.ts`, `tick.ts`, `api/tick.ts`, `standalone/main.ts` (the loop) | [`team_tree.py`](../backend-py/simple_harmonic/team_tree.py) + [`tick.py`](../backend-py/simple_harmonic/tick.py) (`run_tick` orchestrator + `run_tick_loop`) | [06](06-http-api.md) |
| `server/operator-auth.ts`, `app-events.ts`, `trace.ts`, `validation.ts` | [`auth.py`](../backend-py/simple_harmonic/auth.py), [`events.py`](../backend-py/simple_harmonic/events.py), [`trace.py`](../backend-py/simple_harmonic/trace.py), [`validation.py`](../backend-py/simple_harmonic/validation.py) | [04](04-server-layer.md) |

The port was built in 9 dependency-ordered, independently-verifiable slices (foundation → store → a2ax → config/auth → llm cascade → tools/sandbox → meta-agent → tick+endpoints → cutover); all 9 are complete (**834 tests, ruff clean, ~30.6K LOC**, the backend live-boots under uvicorn). The slice table is in [MIGRATION.md](../backend-py/MIGRATION.md#status).

### The app factory and runtime topology

Where the TS world has *two interchangeable hosts* (Next.js + `node:http`), the Python port is a *third* host that owns its own port and lifecycle. [`app.py:create_app()`](../backend-py/simple_harmonic/app.py) builds a `FastAPI` instance: it constructs the repo-backed store (`RepoStore` over the slice-2 repos), installs the `OperatorGateMiddleware`, includes the six `APIRouter`s, and registers a `lifespan` that calls `wire_runtime()` (see below) + `store.ensure()` and — guarded by `tick_loop_should_start()` (`SH_TICK_LOOP` + the prod/`CRON_SECRET` rules) — starts the self-scheduling tick loop as a single `asyncio.create_task`. The module-level `app = create_app()` is the ASGI entrypoint for `uvicorn simple_harmonic.app:app`; `main()` boots uvicorn on `SH_BACKEND_PORT`/`PORT` (default 3001), the same port as the TS standalone host.

The runtime topology is identical to the TS picture in "Runtime topology" above: one process, no background workers, no pub/sub, all state in the shared local JSON tree, time advancing only on `POST /api/tick`. The Python tick loop is the asyncio analogue of the TS standalone host's 10-second self-POST: [`run_tick_loop`](../backend-py/simple_harmonic/tick.py) calls `run_tick` directly in-process every 10s (no self-HTTP), and [`run_tick`](../backend-py/simple_harmonic/tick.py) reproduces the full life-of-a-tick from "The life of a tick" above — once-per-process `inFlight` reset, hourly-throttled trace prune, the 5-minute hibernation filter, the fail-open spend gate, then per team the registry rebuild + auto-recover-errored + resume-pass + fresh-pass (gated by the pure `approve_agent_tick`, claimed by the atomic `agents.claim`) + `incrementTickCount`.

One overview-level seam worth naming: [`wiring.py:wire_runtime()`](../backend-py/simple_harmonic/wiring.py) closes a deliberate decoupling — the slice-4 [`events.py`](../backend-py/simple_harmonic/events.py) app-event emitter never imports the store; instead the app's lifespan injects the event sink (`appEvents.insert`) and a fail-open telemetry reader, mirroring `app-events.ts`'s direct `teams.byId().telemetryEnabled` read.

### Idiomatic-Python choices at the overview altitude

- **Pydantic v2 is the Zod replacement, end to end.** Every store row, a2ax message, tool argument, and planner output is a Pydantic model with the TS JSON key names preserved (camelCase: `channelId`, `fromAgentId`, `createdAt`, …) so the frontend is byte-for-byte unaffected. `model_json_schema()` generates the LLM tools array the way `zodToJsonSchema` did.
- **asyncio + ASGI replace the Node event loop + `node:http`.** Routes are async; blocking filesystem IO is offloaded via `anyio.to_thread`; SSE endpoints (`chat`, `team/{id}/narration`, `team/{id}/trace`) stream through FastAPI `StreamingResponse`.
- **The operator gate is an explicit allowlist, not the broad TS proxy gate.** [`OperatorGateMiddleware`](../backend-py/simple_harmonic/app.py) gates only the operator-only prefixes (`settings/*`, `chat`, `spawn`, `seed`, `infra-report`, `agent`) and leaves `teams`/`team/*` open (the TS handlers read no session), with `tick` cron-gated and `login`/`health` public — same security outcome, opt-in-by-prefix shape (full gate detail in [04](04-server-layer.md)/[06](06-http-api.md)).

### Load-bearing fidelity behaviors (overview-level)

The port carries a 23-item **fidelity risk register** ([ARCHITECTURE.md](../backend-py/ARCHITECTURE.md#fidelity-risk-register-load-bearing-behaviors-discovered-during-mapping)) of subtle TS behaviors it must not lose; the per-subsystem behaviors are preserved in their own chapters' Python sections. Two are system-level and surface here:

- **Store atomicity via an explicit lock.** This document's "Single-process, single-writer" gap notes that the TS store relies on Node's single-threaded event loop for free read-check-write atomicity. asyncio does *not* split a coroutine without an `await`, but the store wraps blocking IO in threads — so every read-modify-write (`agents.claim`, `update`, `resolve`, `incrementTickCount`, JSONL append) holds a single process-wide `asyncio.Lock` ([`store/index_cache.py:store_lock`](../backend-py/simple_harmonic/store/index_cache.py), entered by the repo runner [`store/repos/_runner.py`](../backend-py/simple_harmonic/store/repos/_runner.py)). This is the linchpin of the whole port: lose it and two ticks double-claim an agent. A peak-concurrency==1 test proves it (it fails without the lock).
- **The double-claim guard is what makes sequential per-team safe.** Because `claim` is atomic under that lock, the orchestrator's choice to run agents sequentially (see divergences) cannot cause a double-run.

### Known divergences relevant to this chapter

All are intentional, non-correctness, and tracked in [MIGRATION.md](../backend-py/MIGRATION.md#deferred--known-divergences-honest):

- **Per-team agents run sequentially** (`await` per agent in `run_tick`) versus the TS `Promise.allSettled` per pass. Correctness is preserved (the atomic `claim` is the double-run guard, each run is independently time-bounded, and the store lock already serializes writes); this is a latency gap, not a behavior gap.
- **LLM resolution is lazy** — the cascade client is built on the first agent run, not eagerly at the top of `POST /api/tick`, because the Python OpenAI SDK raises at client *construction* with no key (the JS SDK tolerates a key-less client). Observable behavior is identical once an agent actually runs; a tick over an empty/all-idle store never constructs a client.
- **The Codex app-server harness *resume* path is not ported.** A parked `codex-thread` tick resumes through the legacy runner via `AgentSuspension` (the load-bearing HOLD/resume/deny trichotomy *is* fully ported); `use_codex_harness` is computed and stored for parity but unread on the resume path. The system-wide "engine vs runner mode" split itself carries forward — see [03 — Meta-Agent Engine](03-meta-agent-engine.md)'s Python section.
- **SSE teardown** uses Python async-generator `GeneratorExit` rather than the TS `ReadableStream.cancel()` callback (same lifetime: the stream runs until client disconnect).

The Python port inherits, not fixes, this document's "Known gaps" — it reproduces the *behavior* of the TS contract (vestigial a2ax surface, the planner's lack of cascade, the location-index full-rebuild, the single-writer constraint), so those gaps apply equally to either host.
