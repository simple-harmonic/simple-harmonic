# 02 — Data Model and the JSON File Store

Simple Harmonic persists all state as plain JSON and JSONL files on local disk, written and read synchronously through a small store module at `packages/backend/src/server/store/`. There is no database, no ORM, and no SQL: PR #16 removed PostgreSQL, Drizzle (`drizzle-orm`), the `pg`/`@neondatabase/serverless`/`@types/pg` dependencies, and the entire `packages/backend/src/server/db/` directory (its `index.ts` `db()` singleton and `schema.ts` table definitions). The canonical row shapes are now the plain TypeScript interfaces in `packages/backend/src/server/store/types.ts`; the canonical on-disk layout is documented in the header of `packages/backend/src/server/store/data-dir.ts`. State is organized as **domain aggregates**: one folder per team (sub-teams nest recursively inside it), one folder per agent within its team, with the team's messaging, events, conversations, and per-agent approvals/actions/trace living as files under that team's folder. A small set of infra-level records (platform status, the spend ledger, team-less events) lives under a sibling `system/` folder.

> **Historical note.** Through `main @ 9f301cc` this layer was a single Postgres database of ~17 tables accessed through a `db()` `pg.Pool` singleton, with the physical schema created by an idempotent `SCHEMA_SQL` DDL string and guarded against drift by a column-level parity test and a `db-code-diff.py` catalog differ. None of that exists anymore. The row *shapes* below intentionally match those old Postgres rows field-for-field (names, optionality, `Date`-vs-`string`), so API JSON responses and the meta-agent engine are unchanged by the swap — only persistence changed.

## On-disk layout

The store has two fixed roots under the data directory: `teams/` (the recursive team tree) and `system/` (infra-level globals). Everything else is reached by walking the tree. The layout is (from `packages/backend/src/server/store/data-dir.ts:4-15`):

```
<dataDir>/
├─ teams/<teamId>/
│  ├─ team.json                         the Team row
│  ├─ events.jsonl                      app events scoped to this team (append)
│  ├─ agents/<agentId>/
│  │  ├─ agent.json                     the Agent row
│  │  ├─ approvals.json                 PendingApproval[] for this agent
│  │  ├─ actions.jsonl                  ActionLogEntry rows (append)
│  │  └─ trace.jsonl                    AgentTraceEvent rows (append)
│  ├─ conversations/<sessionId>.json    documented slot — no repo/writer today
│  ├─ messages/                         a2ax communication state (see doc 08)
│  │  ├─ channels.json  members.json  tasks.json
│  │  ├─ cards.json     tokens.json
│  │  └─ log.jsonl      reads.jsonl
│  └─ teams/<subTeamId>/…               sub-teams nest RECURSIVELY
└─ system/
   ├─ platform-status.json              the singleton platform status object
   ├─ spend.jsonl                       the global LLM cost ledger (append)
   └─ events.jsonl                      infra-level / team-less app events (append)
```

A team is identified on disk by the presence of `team.json` in its folder (the location index and the a2ax walk both use this as the marker). Sub-teams live in their parent's `teams/` subfolder, so the tree mirrors the team hierarchy directly — `parentTeamId` is encoded by *where the folder sits*, not just by the field in `team.json`. Deleting a team is a single recursive `rmdir` of its folder, which removes its agents, messages, conversations, events, and every sub-team for free; there is no cascade to orchestrate (`packages/backend/src/server/store/repos/teams.ts:117`). Likewise deleting an agent is an `rmdir` of its folder, taking its approvals/actions/trace with it (`packages/backend/src/server/store/repos/agents.ts:131`).

The `messages/` folder is the home of the a2ax agent-to-agent communication state. It is owned and written by the a2ax `JsonFileTransport`, not by the backend store; its file-by-file contents are documented in [08 — A2AX Protocol](08-a2ax-protocol.md). The backend store treats it as opaque (the recursive team delete simply removes it along with the rest of the folder).

## Data directory resolution

There is no connection URL. The store resolves a single absolute `dataDir` path with this precedence (`packages/backend/src/server/store/data-dir.ts:29-38`):

1. a test override set via `setDataDir(dir)` (used for per-case isolation),
2. `getConfig().dataDir` — the `dataDir` field of `simple-harmonic.config.json`,
3. the `SH_DATA_DIR` environment variable,
4. the default `join(process.cwd(), ".simple-harmonic", "data")` (`packages/backend/src/server/config.ts:34`).

Steps 2–4 are folded together inside `getConfig()` (`packages/backend/src/server/config.ts:77`): `file.dataDir || process.env.SH_DATA_DIR || DEFAULTS.dataDir`. The default sits under `.simple-harmonic/data` so it lives alongside the existing `connectors/` and `skills/` file conventions. `getSafeConfig()` returns `dataDir` plus a `hasDataDir` boolean to the client (`packages/backend/src/server/config.ts:108`) — these replaced the old `databaseUrl`/`hasDatabase` fields; there is no password to mask. `setConfig()` still rewrites `simple-harmonic.config.json` (`packages/backend/src/server/config.ts:92`), and `getApiKeySource()` is unchanged.

`data-dir.ts` exports the **fixed-root** path helpers (`teamsRoot()`, `systemDir()`, `platformStatusPath()`, `spendLogPath()`, `infraEventsPath()`) and the **within-folder** helpers that take an already-resolved team or agent directory (`teamJsonPath`, `teamEventsPath`, `teamAgentsDir`, `teamMessagesDir`, `teamChildrenDir`, `agentJsonPath`, `agentApprovalsPath`, `agentActionsPath`, `agentTracePath`). It deliberately does *not* compute a team/agent folder from an id — those paths depend on hierarchy depth and are resolved through the location index (below).

## Filesystem primitives and the durability model

`packages/backend/src/server/store/fs-store.ts` is the only module that touches `node:fs`, and **all of its IO is synchronous**. The primitives:

| Function | Behavior |
|---|---|
| `readJson<T>(path, fallback)` | Read + `JSON.parse`. Missing or empty file → `fallback`. Corrupt JSON throws. (`fs-store.ts:35`) |
| `writeJson(path, value)` | Atomic pretty-printed write: write to `path.tmp`, then `rename` over `path`. Creates parent dirs. (`fs-store.ts:48`) |
| `updateJson<T>(path, fallback, mutate)` | Read → mutate → atomic write; returns the written value. (`fs-store.ts:56`) |
| `readJsonl<T>(path)` | Read a JSONL log into an array; missing → `[]`; blank lines skipped. (`fs-store.ts:63`) |
| `appendJsonl(path, row)` | Append one `JSON.stringify(row)` line. (`fs-store.ts:80`) |
| `appendJsonlMany(path, rows)` | Append many rows in one write. (`fs-store.ts:86`) |
| `rewriteJsonl(path, rows)` | Atomic full rewrite of a JSONL log (temp + rename) — used by retention/prune and acknowledge. (`fs-store.ts:93`) |
| `removePath(p)` | Recursive `rm -rf` of a file or folder (cascade-delete). (`fs-store.ts:101`) |
| `movePath(from, to)` | `rename` a file or subtree, creating the destination parent (agent re-parenting). (`fs-store.ts:106`) |
| `listSubdirs(dir)` / `listFiles(dir)` | Immediate child directory / file names; missing parent → `[]`. (`fs-store.ts:112`, `:124`) |

The durability contract is: **mutable objects/arrays are written atomically** (temp file + `rename`, which is atomic on POSIX), so a crash mid-write can never leave a half-written `team.json`, `agent.json`, `approvals.json`, `channels.json`, etc.; **append-only logs** (`actions.jsonl`, `trace.jsonl`, `events.jsonl`, `spend.jsonl`, a2ax `log.jsonl`/`reads.jsonl`) are written one `appendFileSync` line at a time; and **retention/prune** rewrites a whole log atomically through `rewriteJsonl`.

### Why synchronous IO is the concurrency model (this replaces the old "why `max: 1` pool")

The old layer capped the `pg.Pool` at `max: 1` and asserted it in a unit test so the tick loop couldn't exhaust a pooled connection. The file store needs no pool and no write queue: Node runs one thread, and a synchronous read-modify-write runs to completion before any other event-loop task can start. So when the tick loop fans agents out with `Promise.allSettled`, no two agent runs can interleave a mutation of the same file — each repo call is a single synchronous critical section (`packages/backend/src/server/store/fs-store.ts:1-12`, `packages/backend/src/server/store/index.ts:1-10`). The agents repo leans on this directly: `claim(id, expectedStatus)` does a synchronous read-then-conditional-write with no `await` in between, which is the file-store equivalent of the old conditional `UPDATE … RETURNING` that guaranteed a tick claimed an agent at most once (`packages/backend/src/server/store/repos/agents.ts:138-153`). The repos wrap every sync primitive in an `async` function purely so existing `await repo.x()` call sites compile unchanged — there is no real asynchrony under the hood. The one hard rule this buys: **single-process, single-writer — run exactly one process per data directory** (`packages/backend/src/server/store/index.ts:9-10`).

## The location index

Because sub-teams nest recursively, a team's (and therefore an agent's) on-disk path is *not* derivable from its id alone — you'd have to know its full ancestry. `packages/backend/src/server/store/index-cache.ts` solves this with an in-memory location index. On first access it walks the whole team tree once (`walk` recurses through each team's `teams/` subfolder, `index-cache.ts:41-51`) and caches two maps:

- `teamId → { dir, parentTeamId }` (`TeamLoc`),
- `agentId → { teamId, dir }` (`AgentLoc`).

Tree queries then read straight from the cache instead of re-walking the disk: `teamDir`/`teamLoc` (by id), `allTeamLocs`, `rootTeamLocs` (`parentTeamId === null`), `childTeamLocs(parentId)`, `agentLoc`, `agentLocsForTeam`, `allAgentLocs` (`index-cache.ts:69-99`). The cache is invalidated by `invalidateIndex()` on any structural change — team insert/delete, agent insert/`insertMany`/delete/move — so the next access rebuilds it; a full rebuild is cheap because the dataset is small (the module assumes `<100` teams, `index-cache.ts:9-10`). `resetStore()` (exported from the store entry) is just `invalidateIndex()` and should be called after repointing the store at a new data dir (`packages/backend/src/server/store/index.ts:37`).

The a2ax `JsonFileTransport` keeps its *own* parallel walk for the same reason (it must not import the backend store): `discoverTeamMessageDirs(teamsRoot)` returns `teamId → messages/` dir so its teamId-less methods (`markRead`, `getTask`, `getToken`, …) resolve in O(1) against in-memory state (`packages/a2ax/src/storage/file-store.ts:86`). See doc 08.

## Date revival at the read boundary

`Date` objects serialize to ISO strings for free via `Date.prototype.toJSON`, so writing needs no special handling. On read, the store turns the **declared top-level** timestamp fields of each row back into `Date` objects to match the old Drizzle row shape, via `reviveDates(row, dateKeys)` / `reviveDatesAll(rows, dateKeys)` (`packages/backend/src/server/store/serialize.ts:13`, `:27`). The revival is intentionally shallow: it touches only the listed keys and never deep-walks, so ISO-looking strings *inside* opaque JSON blobs (`payload`, `metadata`, `data`, `conversationState`, `outputContract`) are left exactly as Postgres `jsonb` used to return them — untouched (`serialize.ts:1-10`). Each repo declares its own `DATE_KEYS` (e.g. teams revive `lastUserActiveAt` + `createdAt`; agents revive `nextRunAt` + `createdAt`; approvals revive `createdAt` + `resolvedAt`).

## Row interfaces

The row shapes live in `packages/backend/src/server/store/types.ts` as plain interfaces (moved here from the deleted `db/schema.ts`). They mirror the old Postgres rows exactly — same field names, same optionality, `Date` for timestamp fields, plain objects for the former `jsonb` columns — so call sites and API responses did not change. The status unions are also defined here: `AgentStatus`, `ApprovalStatus`, `AppEventSeverity`, `AppEventLevel`, `PlatformStatusValue` (`types.ts:12-16`). What used to be Postgres enums are now just these TypeScript string-literal unions; there is no DB-level CHECK and never was for some of them.

### `Team` (`types.ts:18`) — file: `teams/<teamId>/team.json`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID, generated by the repo (`randomUUID`) |
| `parentTeamId` | `string \| null` | null for a root team; encoded by folder position too |
| `name` | `string` | |
| `goal` | `string \| null` | |
| `paused` | `boolean` | default `false` |
| `tickCount` | `number` | default `0` |
| `metaAgentPrompt` | `string \| null` | |
| `cofounderName` | `string \| null` | |
| `telemetryEnabled` | `boolean` | default `true` |
| `lastUserActiveAt` | `Date` | revived from ISO |
| `createdAt` | `Date` | revived from ISO |

### `Agent` (`types.ts:32`) — file: `teams/<teamId>/agents/<agentId>/agent.json`

Doubles as the scheduler state for the tick loop.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `teamId` | `string` | also encoded by folder position |
| `name`, `role`, `archetype` | `string` | |
| `tools` | `string[]` | tool names |
| `scheduleSeconds` | `number` | |
| `initialPrompt` | `string` | |
| `outputContract` | `Record<string, unknown> \| null` | opaque blob (not date-revived) |
| `status` | `AgentStatus` | `running` / `paused` / `errored` / `awaiting_approval`; default `running` |
| `nextRunAt` | `Date \| null` | revived |
| `inFlight` | `boolean` | claim flag; default `false` |
| `conversationState` | `Record<string, unknown> \| null` | opaque blob; was the `jsonb` suspension column, holds the parked `AgentSuspension` or `CodexThreadSuspension` (+ `traceTickId`) while `status = awaiting_approval`, else `null`. Written/read/cleared only by the tick handler |
| `createdAt` | `Date` | revived |

### `PendingApproval` (`types.ts:49`) — file: `teams/<teamId>/agents/<agentId>/approvals.json` (a `PendingApproval[]`)

One entry per destructive tool call awaiting human sign-off. Stored as an array inside the *owning agent's* folder, so an agent delete removes its approvals for free.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `teamId` | `string` | |
| `agentId` | `string` | |
| `toolCallId` | `string` | the runner's `PendingToolCall.id`, matched on resume |
| `toolName` | `string` | |
| `toolArguments` | `string` | raw JSON-arguments string as the LLM emitted it |
| `status` | `ApprovalStatus` | `pending` / `approved` / `rejected`; default `pending` |
| `decisionNote` | `string \| null` | human note on rejection, surfaced to the LLM on resume |
| `createdAt` | `Date` | revived |
| `resolvedAt` | `Date \| null` | revived |

### `ActionLogEntry` (`types.ts:62`) — file: `teams/<teamId>/agents/<agentId>/actions.jsonl` (append-only)

One row per completed (or suspended) agent tick — the narration feed and the agents' working memory.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `agentId` | `string` | |
| `metaAgentApprovalId` | `string \| null` | |
| `actionType` | `string` | run result's `actionType`, or `awaiting_approval` for suspensions |
| `payload` | `Record<string, unknown>` | opaque blob; tick loop merges `validation: { valid, issues }` when the agent has an output contract |
| `executedAt` | `Date` | revived |

### `AppEvent` (`types.ts:71`) — file: `teams/<teamId>/events.jsonl` (team/agent/tool events) or `system/events.jsonl` (infra / team-less)

The dogfooding feedback loop: errors, warnings, and health signals.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `teamId` | `string \| null` | null for infra/system-wide events → routed to `system/events.jsonl` |
| `agentId` | `string \| null` | |
| `severity` | `AppEventSeverity` | `info` / `warning` / `error`; default `info` |
| `level` | `AppEventLevel` | `agent` / `team` / `tool` / `infra`; default `agent` |
| `source` | `string` | e.g. `"tick"`, `"tool"`, `"api"` |
| `message` | `string` | PII-scrubbed before write |
| `metadata` | `Record<string, unknown> \| null` | opaque, caller-defined |
| `acknowledgedAt` | `Date \| null` | revived; founder dismisses infra/tool events |
| `createdAt` | `Date` | revived |

### `PlatformStatus` (`types.ts:84`) — file: `system/platform-status.json` (single object)

The former singleton `platform_status` row. The repo's `get()` returns `null` when the file is absent (no seeding step).

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | always `1` |
| `status` | `PlatformStatusValue` | `healthy` / `degraded` / `maintenance` |
| `message` | `string \| null` | |
| `updatedAt` | `Date` | revived |

### `AgentTraceEvent` (`types.ts:91`) — file: `teams/<teamId>/agents/<agentId>/trace.jsonl` (append-only)

The play-by-play agent trace (PR #12): one row per agent step.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `teamId`, `agentId` | `string` | |
| `tickId` | `string` | groups every step of one logical tick; stable across suspend/resume (carried as `traceTickId` on the parked `conversationState`) |
| `seq` | `number` | per-invocation counter; global sort key is `(emittedAt, seq)` |
| `type` | `string` | one of the 9 `TraceEventType` values |
| `data` | `Record<string, unknown>` | opaque, sanitized step payload (not date-revived) |
| `emittedAt` | `Date` | revived; set from the emitting process clock, not a DB default, so batched appends preserve runner step order |
| `createdAt` | `Date` | revived |

### `LlmSpendEntry` (`types.ts:103`) — file: `system/spend.jsonl` (global, append-only)

The LLM cost ledger backing the daily spend cap. Global (not per-team) because the cap is a single daily budget.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID |
| `teamId` | `string \| null` | non-agent calls can be recorded |
| `agentId` | `string \| null` | |
| `model` | `string` | |
| `inputTokens`, `outputTokens` | `number` | |
| `costCents` | `number` | integer cents, rounded up per call |
| `day` | `string` | UTC `YYYY-MM-DD` |
| `createdAt` | `Date` | revived |

### `ApiToolConfig` (`types.ts:121`) — not a persisted record

`{ baseUrl; connectorKey; authHeader?; authPrefix?; allowedMethods; defaultHeaders?; pathPrefix? }` — the shape of the `config` field of the flat JSON skill files `.simple-harmonic/skills/<name>.json` that `custom-tools.ts` loads (e.g. `.simple-harmonic/skills/httpbin_api.json`). It lived in `db/schema.ts` purely as a shared type and was moved here when that file was deleted; it has never been backed by a table. Imported by `packages/backend/src/server/custom-tools.ts` and `packages/backend/src/server/tools/api-tool-runtime.ts:12`.

There is no `chat_sessions`/`chat_messages` equivalent and no repo for them. The layout reserves a `teams/<teamId>/conversations/<sessionId>.json` slot (`data-dir.ts:11`), but as in the old Postgres world nothing currently writes it — there is no store repo, no path helper, and no writer. The `GET /api/team/[id]/conversations` handler reconstructs conversation views from the a2ax message log (the `messages/` folder), not from session files, and the chat handler reads `agents`/`teams` and applies agent updates without persisting a transcript.

## Per-record persistence map

| Domain record | On-disk location |
|---|---|
| Team | `teams/<teamId>/team.json` |
| Agent | `teams/<teamId>/agents/<agentId>/agent.json` |
| Pending approvals (per agent) | `teams/<teamId>/agents/<agentId>/approvals.json` |
| Action log (per agent) | `teams/<teamId>/agents/<agentId>/actions.jsonl` |
| Agent trace (per agent) | `teams/<teamId>/agents/<agentId>/trace.jsonl` |
| App events — team/agent/tool | `teams/<teamId>/events.jsonl` |
| App events — infra / team-less | `system/events.jsonl` |
| Chat session | `teams/<teamId>/conversations/<sessionId>.json` (reserved slot; no writer today) |
| a2ax messaging (channels, members, tasks, cards, tokens, message log, read receipts) | `teams/<teamId>/messages/*` — see [08 — A2AX Protocol](08-a2ax-protocol.md) |
| Platform status (singleton) | `system/platform-status.json` |
| LLM spend ledger (global) | `system/spend.jsonl` |

## The repos

`packages/backend/src/server/store/index.ts` is the public entry point. It re-exports the 8 repo objects and their `New*` input types, plus `ensureDataDir`/`resetStore`/`clearStore`/`getDataDir`/`setDataDir` and `export type * from "./types"`. Call sites import from here: `import { teams, agents, actionLog } from "../store"`. Each repo owns specific files and turns the fs primitives into the small query surface the old Drizzle queries provided.

| Repo (`store/repos/*.ts`) | Files it owns | Key methods |
|---|---|---|
| `teams` | `team.json` (per team folder) | `all` (oldest-first), `byId`, `roots`, `children`, `listUnpaused`, `insert` (places the folder under `teamsRoot()` or the parent's `teams/`), `update`, `incrementTickCount`, `delete` (recursive rmdir of the subtree) |
| `agents` | `agent.json` (per agent folder) | `byId`, `byTeam`, `byTeams`, `all`, `insert`, `insertMany`, `update`, `move` (rewrite `teamId` + `movePath` the folder + invalidate index), `delete`, `claim` (race-free sync read-then-conditional-write), `resetAllInFlight` (crash recovery on process start) |
| `approvals` | `approvals.json` (per agent) | `byAgent`, `insertMany`, `clearForAgent`, `pendingForTeam` (scans the team's agents), `resolve` (finds owning agent, flips status + note + `resolvedAt`) |
| `actionLog` | `actions.jsonl` (per agent) | `insert` (append), `byAgents` (merge across agents, optional `since`, newest-first, optional `limit`), `recentByAgent` |
| `appEvents` | `events.jsonl` (per team) + `system/events.jsonl` | `insert` (**synchronous**, fire-and-forget; routes to the team file or the system file by `teamId`), `query` (narrows files by `teamId`, filters severity/level/source/since, excludes `infra` unless `includeInfra`, optional `unacknowledgedOnly`, newest-first, default limit 20), `acknowledge(ids)` (rewrites touched logs, returns count) |
| `platformStatus` | `system/platform-status.json` | `get` (null when unset), `set` |
| `spend` | `system/spend.jsonl` | `insert` (append), `sumForDay(day)` (sum `costCents` for a UTC day) |
| `traceEvents` | `trace.jsonl` (per agent) | `append` (batches grouped by agent, `appendJsonlMany`), `query` (by team or one agent, optional `tickId`/`since`, sort by `(emittedAt, seq)` asc/desc, `limit`), `pruneOlderThan(cutoff)` (rewrite each agent's log keeping rows ≥ cutoff) |

A few callers worth pinning: the tick loop calls `agents.claim(..., "running")` and `agents.claim(..., "awaiting_approval")` to take an agent at most once per tick (`packages/backend/src/server/api/tick.ts:359`, `:491`) and `agents.resetAllInFlight()` once at the top of a tick run (`:125`); `modify_team`'s move path calls `agents.move(...)` (`packages/backend/src/server/tools/management.ts:324`). These repos are consumed across the server layer (`team-tree.ts`, `app-events.ts`, `spend.ts`, `trace.ts`, `tools/management.ts`, `tools/action-history.ts`, `api/infra-report.ts`, `api/tick.ts`, `api/spawn.ts`, `api/teams.ts`, and others).

## Making the store exist: no schema, no migrations, no parity guard

There is **no schema to create**, so the entire old "schema creation / no migrations / drift guard / constraint drift / two copies of the a2ax tables" machinery is gone:

- No `SCHEMA_SQL` DDL string, no `CREATE TABLE`/`CREATE TYPE`/`ALTER TABLE ADD COLUMN`. Folders and files are created lazily, on demand, by `mkdirSync({ recursive: true })` inside the fs primitives the first time a record is written.
- No Drizzle migrations, no `drizzle-kit`, no `drizzle.config.*` — and none ever existed.
- No `packages/backend/tests/unit/schema-sync.test.ts` and no `scripts/db-code-diff.py` — both deleted. There is no second copy of any schema to keep in sync, so there is nothing for a parity test or a live-catalog differ to compare. (The old `db.test.ts` that asserted the `max: 1` pool is also gone.)
- No "two copies of the a2ax tables": the a2ax package no longer ships a `drizzle-schema.ts` or a `DrizzleTransport`. Its only adapter is `JsonFileTransport` (`packages/a2ax/src/adapters/json-file.ts`); the only "Drizzle" reference left in the package source is a generic comment on the `Transport` interface (`packages/a2ax/src/core/transport.ts:25`). `MemoryTransport` (`packages/a2ax/src/transport/memory.ts`) survives for the package's own tests.

What now plays the role of "make the store exist" is just creating the two root folders. `ensureDataDir()` (`packages/backend/src/server/store/index.ts:30`) does `mkdirSync(teamsRoot())` + `mkdirSync(systemDir())` and is idempotent. It is reached two ways, mirroring the old setup-db button + CLI:

1. **`POST /api/settings/setup-db`** (`packages/backend/src/server/api/settings/setup-db.ts`) — kept at the same route so the Settings UI button still works. It optionally persists a custom `dataDir` from the request body via `setConfig`, then calls `ensureDataDir()` and returns `{ ok, steps }`. No `CREATE DATABASE`, no SQL.
2. **`npm run data:init`** (renamed from `db:setup`; `package.json:11`) runs `packages/backend/src/server/standalone/setup-db-cli.ts` via `tsx`. It decrypts Apollo vault secrets into `process.env`, then invokes the same exported `POST` handler in-process with a synthetic `Request`, prints each step, and exits `0` (`✓ Data store ready`) or `1`. `npm run data:init -- /path/to/dir` passes the dir in the body, which also persists it to `simple-harmonic.config.json`.

The companion `POST /api/settings/test-db` (`packages/backend/src/server/api/settings/test-db.ts`) likewise no longer runs `SELECT 1`: it calls `ensureDataDir()` then round-trips a probe file (`writeFileSync` + `rmSync` of a `.write-test-<uuid>` file) to confirm the data dir is writable, returning `{ ok, dataDir }` or `{ ok: false, error }`.

For seeds and tests, `clearStore()` (`packages/backend/src/server/store/index.ts:42`) recursively removes both roots and drops the index cache; `setDataDir(dir)` + `resetStore()` repoint the store at an isolated directory. On the a2ax side, `resetA2AXForTests()` (`packages/backend/src/server/a2ax.ts:27`) drops the cached `A2AX` singleton so a test can repoint `SH_DATA_DIR` between cases. The host wires a2ax with `new JsonFileTransport(teamsRoot())` (`packages/backend/src/server/a2ax.ts:15`), keeping `maxContextMessages: 20` and a 7-day default message expiry.

## Environment variables

| Variable | Read at | Effect |
|---|---|---|
| `SH_DATA_DIR` | `packages/backend/src/server/config.ts:77` | Data directory root, used only when `simple-harmonic.config.json` has no `dataDir`; defaults to `join(cwd, ".simple-harmonic", "data")`. (Replaces the removed `DATABASE_URL`.) |
| `SH_DAILY_SPEND_CAP_CENTS` | `packages/backend/src/server/spend.ts:42` | Daily cap summed against `system/spend.jsonl`; default 5000 cents ($50) |
| `SH_TRACE_RETENTION_DAYS` | `packages/backend/src/server/trace.ts:157` | Retention window for `trace.jsonl` rows, in days; default 14, pruned at most hourly via `traceEvents.pruneOlderThan` (`trace.ts:168`) |

`DATABASE_URL` no longer exists anywhere in the codebase; configuration of *where* state lives is entirely `dataDir` (config file) / `SH_DATA_DIR` (env) / the cwd default.

## Python backend (FastAPI port)

The parallel Python service in `backend-py/` re-implements this same data model. Like current TypeScript (post-PR #16) and **not** like the historical Postgres/Drizzle layer described at the top of this chapter, the Python port persists everything as the **same JSON/JSONL domain-aggregate tree** under `.simple-harmonic/data/` — the on-disk format is shared byte-for-byte, so a single data directory can be served by either runtime (the cutover in [next.config.ts](../next.config.ts) flips between them). There is no database, no ORM, no SQL in the Python port either; it reads and writes the identical `teams/<teamId>/…` + `system/…` layout documented in the *On-disk layout* and *Per-record persistence map* sections above. The stack rationale and the load-bearing-behavior register live in [backend-py/ARCHITECTURE.md](../backend-py/ARCHITECTURE.md) and the slice plan in [backend-py/MIGRATION.md](../backend-py/MIGRATION.md); this section maps *this chapter's* subsystem onto its Python modules.

### Module map

| TypeScript (`packages/backend/src/server/`) | Python (`backend-py/simple_harmonic/`) |
|---|---|
| `store/types.ts` (row interfaces) | `store/types.py` (Pydantic v2 models) |
| `store/serialize.ts` (`reviveDates`) | `store/serialize.py` (`revive_dates`, `revive_dates_all`, `json_default`) |
| `store/fs-store.ts` (sync fs primitives) | `store/fs.py` (blocking fs primitives) |
| `store/data-dir.ts` (path helpers + resolution) | `store/data_dir.py` |
| `store/index-cache.ts` (location index) | `store/index_cache.py` |
| `store/index.ts` (public re-export surface) | `store/__init__.py` + `store/repos/__init__.py` |
| `store/repos/teams.ts` | `store/repos/teams.py` |
| `store/repos/agents.ts` | `store/repos/agents.py` |
| `store/repos/approvals.ts` | `store/repos/approvals.py` |
| `store/repos/action-log.ts` | `store/repos/action_log.py` |
| `store/repos/app-events.ts` | `store/repos/app_events.py` |
| `store/repos/platform-status.ts` | `store/repos/platform_status.py` |
| `store/repos/spend.ts` | `store/repos/spend.py` |
| `store/repos/trace-events.ts` | `store/repos/trace_events.py` |
| a2ax `types/message.ts`, `task.ts`, `channel.ts`, `auth.ts`, `agent-card.ts` | `a2ax/message.py`, `task.py`, `channel.py`, `token.py`, `types.py` |
| a2ax `storage/file-store.ts` | `a2ax/file_store.py` |

The eight repos are module-level singletons whose method names keep the TS spelling (`byId`, `byTeam`, `insertMany`, `pendingForTeam`, `sumForDay`, `pruneOlderThan`, …) so call sites translate one-to-one. `store/__init__.py` mirrors the TS `index.ts` re-export surface (the repos plus `ensure_data_dir`/`reset_store`/`clear_store`/`set_data_dir`/`get_data_dir` and every row type); `store/repo_store.py` wraps the `teams`/`platformStatus` repos behind the small `Store` Protocol (`store/base.py`) that the route handlers depend on.

### Row shapes as Pydantic v2 models

Where TS declares plain `interface` row shapes, the Python port declares **Pydantic v2 `BaseModel`s** in `store/types.py` — one per row: `Team`, `Agent`, `PendingApproval`, `ActionLogEntry`, `AppEvent`, `PlatformStatus`, `AgentTraceEvent`, `LlmSpendEntry`, plus the non-persisted `ApiToolConfig`. Three idiomatic-Python choices keep these wire-identical to the TS rows:

- **camelCase field names are preserved verbatim** (`parentTeamId`, `tickCount`, `metaAgentApprovalId`, `nextRunAt`, `costCents`, …) so Response JSON matches the frontend's existing keys. Every model carries `model_config = ConfigDict(populate_by_name=True)`, and the repos serialize with `model_dump(by_alias=True)`. This replaces what Zod did on the TS side; Pydantic's `model_json_schema()` is what later feeds the LLM tools array (see doc 03/06), the analogue of Zod-to-JSON-schema.
- The TS `Record<string, unknown> | null` opaque blobs (`outputContract`, `conversationState`, `payload`, `metadata`, `data`) become `dict[str, object] | null` — plain dicts, never sub-models — so they round-trip untouched exactly as the old `jsonb` columns did.
- The status unions (`AgentStatus`, `ApprovalStatus`, `AppEventSeverity`, `AppEventLevel`, `PlatformStatusValue`) become `typing.Literal[...]` aliases at the top of `store/types.py` — the direct equivalent of the TS string-literal unions, with no DB-level CHECK behind them (there never was one).

Each repo declares its own `DATE_KEYS` tuple exactly as TS does — `teams.py` revives `("lastUserActiveAt", "createdAt")`, `agents.py` revives `("nextRunAt", "createdAt")`, `approvals.py` revives `("createdAt", "resolvedAt")`, `trace_events.py` revives `("emittedAt", "createdAt")`, and so on — and validates the revived dict through `Model.model_validate(...)`.

### Selective date revival and the trailing-`Z` serializer

The asymmetric read/write date handling from the *Date revival at the read boundary* section is preserved exactly, but Python has to do **both halves explicitly** because, unlike `Date.prototype.toJSON`, a `datetime` does not serialize for free. `store/serialize.py` carries the two-sided seam:

- **On read**, `revive_dates(row, date_keys)` / `revive_dates_all(rows, date_keys)` mirror TS `reviveDates`: they convert **only the declared top-level keys** from ISO string to `datetime` (via `datetime.fromisoformat`), in place, touching only string values (so already-revived datetimes or `null` are left alone). The revival is deliberately **shallow** — it never deep-walks — so ISO-looking strings nested inside `payload`/`metadata`/`data`/`conversationState`/`outputContract` stay strings, exactly as Postgres `jsonb` used to return them. This is risk-register item #2 ("selective date revival"); losing it would silently rewrite opaque blob contents.
- **On write**, `json_default(value)` is the `json.dumps(default=...)` hook every fs primitive passes, and `_to_iso_z(dt)` renders a `datetime` the way Node's `Date#toISOString` does: coerced to UTC, **millisecond precision, trailing `Z`** (`utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"`). Python's default `datetime.isoformat()` would emit microseconds and a `+00:00` offset instead of `Z`, which would *not* be byte-identical to the TS output; the custom serializer is what closes that gap. (MIGRATION.md slice 8 calls out retiring the slice-1 stub store specifically to route all serialization through this single trailing-`Z` seam.)

### Filesystem primitives, durability, and the asyncio store lock

`store/fs.py` ports `fs-store.ts` primitive-for-primitive: `read_json`/`write_json` (atomic temp-write + `os.replace`, which is atomic on POSIX), `update_json` (read → mutate → atomic write), `read_jsonl`/`append_jsonl`/`append_jsonl_many`, `rewrite_jsonl` (atomic full rewrite for retention/prune), `move_path`, `remove_path` (recursive `shutil.rmtree`), and `list_subdirs`/`list_files`. The durability contract is identical: mutable objects/arrays are written atomically, append-only logs grow one line at a time, and prune rewrites a whole log atomically.

The crucial difference is the **concurrency model**, and it is the single most load-bearing fidelity concern in this chapter. The TS store relies on Node being single-threaded: a synchronous read-modify-write runs to completion before any other event-loop task starts, which is what made `agents.claim()` race-free *for free* (and made the old "why `max: 1` pool" reasoning unnecessary). Python's `asyncio` does **not** give that guarantee — `await` points yield, and these primitives are blocking IO that the port must push off the event loop. So the Python store restores Node's implicit atomicity with **two explicit mechanisms**, both in `store/repos/_runner.py`:

```python
async def locked(fn):
    async with store_lock():
        return await anyio.to_thread.run_sync(fn)
```

Every repo method wraps its synchronous body (`self._..._sync`) in `await locked(...)`, which (1) acquires a **process-wide `asyncio.Lock`** (`store_lock()` in `store/index_cache.py`, one lock per running event loop, held via a `WeakKeyDictionary` so pytest's per-test loops don't collide) and (2) runs the blocking fs work in a worker thread via `anyio.to_thread.run_sync`. The lock is held for the *entire* read-modify-write, so two coroutines can never both observe `inFlight=false`. **Pure reads also take the lock** so they never observe a half-applied write or a half-built location-index cache. This is risk-register item #1 ("`agents.claim()` race-freeness"); MIGRATION.md notes the lock is "proven by a peak-concurrency==1 test that fails without it." The `agents.claim()` port (`_claim_sync` in `store/repos/agents.py`) is the canonical case: read `agent.json`, bail if `inFlight is True` or `status != expected_status`, else set `inFlight=True` and write — the whole sequence inside one `locked(...)` critical section, the file-store equivalent of the old conditional `UPDATE … RETURNING`. `resetAllInFlight()` (crash recovery on process start) and `incrementTickCount()` are guarded the same way.

The one telemetry exception matches TS: `appEvents.insert()` (`store/repos/app_events.py`) is a **synchronous, fire-and-forget** method that does a single atomic append and therefore does *not* take the lock — it never reads-modifies-writes existing rows, and event logging must never block a request path. Its `query()` and `acknowledge()` (which rewrite touched logs) do take the lock.

### Location index

`store/index_cache.py` ports `index-cache.ts`: a lazy in-memory index (`_cache`, built on first access) mapping `teamId → TeamLoc(dir, parentTeamId)` and `agentId → AgentLoc(teamId, dir)`, because a recursively-nested team's on-disk path is not derivable from its id alone. `_walk` recurses through each team's `teams/` subfolder, treating the presence of `team.json` as the team-folder marker, and the same query surface is exposed as module functions (`team_loc`, `team_dir`, `all_team_locs`, `root_team_locs`, `child_team_locs`, `agent_loc`, `agent_locs_for_team`, `all_agent_locs`). `invalidate_index()` drops the cache on any structural change — team/agent insert, `insertMany`, delete, or move — so the next access re-walks; the module keeps the same `<100`-teams "rebuild is cheap" assumption. `reset_store()` in `store/__init__.py` is just `invalidate_index()`. Because the cache is rebuilt inside the same `locked(...)` critical section as the read that triggered it, no coroutine ever observes a half-built index.

The a2ax `JsonFileTransport` keeps its own parallel walk for the same isolation reason (the a2ax package must not import the backend store): `discover_team_message_dirs(teams_root)` in `a2ax/file_store.py` returns `teamId → messages/` dir, mirroring TS `discoverTeamMessageDirs`. See [08 — A2AX Protocol](08-a2ax-protocol.md).

### Data-directory resolution

`store/data_dir.py` exposes the same fixed-root helpers (`teams_root`, `system_dir`, `platform_status_path`, `spend_log_path`, `infra_events_path`) and within-folder helpers (`team_json_path`, `team_events_path`, `team_agents_dir`, `team_messages_dir`, `team_children_dir`, `agent_json_path`, `agent_approvals_path`, `agent_actions_path`, `agent_trace_path`), and like TS it deliberately does *not* compute a team/agent folder from an id — those go through the location index. Resolution precedence is slightly simplified versus the TS `config.ts` chain: a test override set via `set_data_dir(dir)` wins, otherwise `get_settings().data_dir` (pydantic-settings, which reads `SH_DATA_DIR` and falls back to the `.simple-harmonic/data` cwd default lifted from `config.ts`). `ensure_data_dir()` creates the `teams/` + `system/` skeleton idempotently — the Python equivalent of "make the store exist," with no schema, no `CREATE TABLE`, no migrations, and no parity guard, exactly as on the TS side. `clear_store()` wipes both roots and drops the index for seeds/tests.

### a2ax model shapes

The a2ax communication state owned by the `messages/` folder (channels, members, tasks, cards, tokens, message log, read receipts) is fully detailed in doc 08, but the Pydantic models live alongside the store: `a2ax/message.py` (`Message`, `Part`, `Artifact`, `CreateMessageInput`, and the `ChannelType`/`MessageStatus`/`MessageRole`/`MessageKind` literals), `a2ax/task.py` (`Task` + the `TASK_TRANSITIONS` table + `is_valid_transition`), `a2ax/channel.py` (`Channel`, `ChannelMember`, and the deterministic id helpers `direct_channel_id`/`broadcast_channel_id`/`group_channel_id`/`task_channel_id`), `a2ax/token.py` (`AgentToken`, `DEFAULT_SCOPES`, `has_scope`, `generate_token`), and `a2ax/types.py` (`AgentCard` and its nested OpenAPI-flavored shapes). Two data-model fidelity points worth pinning here: `direct_channel_id` **sorts the pair** (`direct:{min}:{max}`), risk-register item #7; and `MessageKind` is intentionally left as a plain `str` on the model (rather than the full literal union) so arbitrary kinds round-trip without over-constraining. `SecurityScheme.in_` is aliased to the wire key `in` (a Python keyword) via `Field(alias="in")`.

### Load-bearing fidelity behaviors preserved (from the risk register)

This chapter's subsystem owns several entries in the [ARCHITECTURE.md fidelity register](../backend-py/ARCHITECTURE.md#fidelity-risk-register-load-bearing-behaviors-discovered-during-mapping):

1. **#1 — `agents.claim()` race-freeness:** restored by the `store_lock` + `anyio.to_thread` wrapper around every read-modify-write (`_runner.py`); covered above.
2. **#2 — selective date revival:** `revive_dates` touches only declared top-level `DATE_KEYS`; nested blob strings stay strings (`store/serialize.py`).
3. **#3 — mixed-type id field:** `PlatformStatus.id` is typed `int = 1` (the literal integer), while every other row's `id` is a UUID `str`; the union is preserved (`store/types.py`, `store/repos/platform_status.py`).
4. **#4 — `PendingApproval.toolArguments` is a JSON string:** typed `str`, stored and read verbatim, never auto-parsed into an object (`store/types.py`; `approvals.py` docstring calls this out explicitly).

### Deferred / known divergences relevant to this chapter

- **No second `move`-less surface gap:** the TS `teams` repo has no `move()`; the Python `teams.py` adds a `move()` analogue of the `agents.move()` pattern to satisfy the public surface, but it is the file-store equivalent (rewrite `parentTeamId` + `move_path` the folder + invalidate the index) and changes no on-disk shape.
- **The reserved `conversations/<sessionId>.json` slot is still unwritten** in the Python port, just as in TS — there is no repo, no path helper, and no writer; conversation views are reconstructed from the a2ax message log (doc 08).
- **Data-dir resolution drops the `simple-harmonic.config.json` `dataDir` precedence step** present in the TS `getConfig()` chain: the Python order is test-override → `SH_DATA_DIR`/default via pydantic-settings. Where state lives is otherwise identical, and `SH_DATA_DIR` + the cwd default behave the same.

For the broader stack decision (raw SDKs + asyncio over Pydantic AI / LangGraph), the wire-compatibility rules, and the full slice-by-slice status, see [backend-py/ARCHITECTURE.md](../backend-py/ARCHITECTURE.md) and [backend-py/MIGRATION.md](../backend-py/MIGRATION.md).
