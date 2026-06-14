# Reference — `@simple-harmonic/a2ax`

`@simple-harmonic/a2ax` ("A2A-Extended") is the agent-to-agent communication protocol package: a storage-agnostic messaging, task, agent-card, and auth layer used by every Simple Harmonic agent to talk to its peers. It is built in three layers: **types** (`src/types/*` — message/channel/task/auth/agent-card shapes plus pure helper functions), a **transport interface with two implementations** (`src/core/transport.ts` defines `Transport`; `src/transport/memory.ts` is the in-memory test implementation, `src/adapters/json-file.ts` is the production implementation that persists each team's communication state as JSON/JSONL files under that team's folder in the data tree), and the **`A2AX` protocol class** (`src/core/protocol.ts`) that composes transport calls into high-level operations (send, broadcast, tasks, context injection, tokens). (Through PR #15 the production transport was `DrizzleTransport` over seven Postgres tables; PR #16 replaced Postgres with the on-disk file store, and `DrizzleTransport`/`drizzle-schema.ts`/`drizzle.ts` were deleted from the package — no code, build, or test references them anymore.)

```
host app (backend server handlers;                 @simple-harmonic/a2ax
 Next routes are thin re-exports)
─────────────────────────────────────              ───────────────────────────────
packages/backend/src/server/api/
  tick.ts                        ─┐
  seed.ts                         ├─ getA2AX() ──► A2AX (core/protocol.ts)
  team/id/messages.ts             │  (packages/      │ sendDirect/broadcast/createTask/
  team/id/{conversations,tasks,   │  backend/src/    │ getAgentContext/listMessages/
   agent-hub}.ts                  │  server/a2ax.ts) │ listTasks/issueToken/…
packages/backend/src/lib/         │                  ▼
  meta-agent/default-tools.ts ────┘                Transport (core/transport.ts)
  (via A2AXSender facade)                            ├─ MemoryTransport (tests)
                                                     └─ JsonFileTransport (production)
                                                          │ per-team files under
                                                          ▼ <dataDir>/teams/<id>/messages/
                                            log.jsonl · reads.jsonl · channels.json ·
                                            members.json · tasks.json ·
                                            cards.json · tokens.json
```

Note on the storage layer: there are no a2ax tables anymore. `JsonFileTransport` is constructed with the `teamsRoot()` path (`<dataDir>/teams`) and persists each team's communication state under that team's own folder — `<teamDir>/messages/{log.jsonl, reads.jsonl, channels.json, members.json, tasks.json, cards.json, tokens.json}`. Because sub-teams nest recursively on disk, the transport hydrates its in-memory state once by walking the team tree with `discoverTeamMessageDirs` (`packages/a2ax/src/storage/file-store.ts:86`), which lets the teamId-less methods (`markRead`, `getTask`, `getToken`, …) resolve in O(1). The package carries its own self-contained sync fs helpers (`src/storage/file-store.ts`) and must **not** import the backend store. Team-tree cleanup on `modify_team` delete now happens by removing the team's directory (recursively, taking its `messages/` files with it); there is no longer any `ON DELETE CASCADE` machinery.

---

## packages/a2ax/src/index.ts

Package entry point. Pure re-export module, no logic.

### Exports — `packages/a2ax/src/index.ts:5`

Re-exports `A2AX` (value) and `A2AXOptions`, `AgentContext` (types) from `./core/protocol.js`; `MessageQuery`, `Transport` (types) from `./core/transport.js`; and everything from `./types/index.js`. Note that `MemoryTransport` and `JsonFileTransport` are *not* re-exported here — they are reached through the package.json subpath exports `@simple-harmonic/a2ax/transport/memory` and `@simple-harmonic/a2ax/adapters/json-file` (and via the deep `./types` subpath for the type barrel). The `./adapters/json-file` subpath has no extra peer dependencies — the transport relies only on `node:fs`/`node:path` — so it is plain Node, unlike the former drizzle subpath which gated `drizzle-orm`.

- **Called by:** `packages/backend/src/server/a2ax.ts:5` (`import { A2AX }`), `packages/a2ax/tests/protocol.test.ts:2`.

---

## packages/a2ax/src/types/index.ts

### Barrel — `packages/a2ax/src/types/index.ts:1`

Re-exports all of `agent-card.js`, `auth.js`, `channel.js`, `message.js`, `task.js`. No logic.

---

## packages/a2ax/src/types/message.ts

Message envelope types. All type-only except none — this file has no runtime code.

### `ChannelType` — `packages/a2ax/src/types/message.ts:6`

Union `"direct" | "broadcast" | "group" | "task"`. The four channel families the protocol supports; drives routing in `A2AX.getAgentContext` and relevance filtering in both transports. Persisted as the plain `channelType` string on each message/channel row in the JSON store (no DB enum).

### `MessageStatus` — `packages/a2ax/src/types/message.ts:9`

Union `"pending" | "delivered" | "read" | "expired"`. In practice only `pending` (initial) and `expired` (set by `markExpired`) are ever written — per-recipient read state lives in each team's `messages/reads.jsonl` file, not on the message row, so `delivered`/`read` are currently vestigial members.

### `MessageRole` — `packages/a2ax/src/types/message.ts:12`

Union `"agent" | "meta" | "system" | "user"`. Sender role; defaults to `"agent"` in both transports' `insertMessage`. `A2AX.createGroup` is the only in-package producer of `"system"`.

### `GeneralKind` — `packages/a2ax/src/types/message.ts:15`

Union `"text" | "data" | "artifact" | "ack" | "error"`. Generic message kinds.

### `TaskKind` — `packages/a2ax/src/types/message.ts:18`

Union `"task.create" | "task.accept" | "task.status" | "task.input_required" | "task.result" | "task.cancel" | "task.reject"`. Task-lifecycle message kinds; `A2AX` emits `task.create` (createTask), `task.status` (updateTaskState), and `task.result` (completeTask). The other four are defined but never produced inside the package.

### `SystemKind` — `packages/a2ax/src/types/message.ts:28`

Union `"system.join" | "system.leave" | "system.created"`. Only `system.created` is produced (by `A2AX.createGroup`).

### `MessageKind` — `packages/a2ax/src/types/message.ts:31`

`GeneralKind | TaskKind | SystemKind`. The `kind` field of every message.

### `Part` — `packages/a2ax/src/types/message.ts:34`

A2A-compatible unit of content. Exactly one of the content fields is expected to be set (not enforced at runtime).

| Field | Type | Meaning |
|---|---|---|
| `text?` | `string` | Plain-text content |
| `raw?` | `string` | Raw (e.g. base64) content |
| `url?` | `string` | Content by reference |
| `data?` | `Record<string, unknown>` | Structured data content |
| `mediaType?` | `string` | MIME type of the content |
| `filename?` | `string` | Suggested filename |
| `metadata?` | `Record<string, unknown>` | Arbitrary part metadata |

### `Artifact` — `packages/a2ax/src/types/message.ts:47`

A named collection of output parts (task results, deliverables).

| Field | Type | Meaning |
|---|---|---|
| `artifactId` | `string` | Stable artifact identifier |
| `name?` | `string` | Display name |
| `description?` | `string` | Human description |
| `parts` | `Part[]` | The artifact's content units |
| `metadata?` | `Record<string, unknown>` | Arbitrary metadata |

### `Message` — `packages/a2ax/src/types/message.ts:56`

The core message envelope returned by all transport reads/writes.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | UUID, generated by the transport |
| `teamId` | `string` | Owning team (tenant key for every query) |
| `channelType` | `ChannelType` | Channel family |
| `channelId` | `string` | Channel identifier (see channel ID helpers) |
| `fromAgentId` | `string` | Sender agent id |
| `role` | `MessageRole` | Sender role (default `"agent"`) |
| `kind` | `MessageKind` | Semantic message kind |
| `content` | `string` | Primary text content (convenience field) |
| `parts?` | `Part[]` | Structured A2A parts |
| `artifacts?` | `Artifact[]` | Output artifacts |
| `payload?` | `Record<string, unknown>` | Structured payload (back-compat / simple cases) |
| `replyTo?` | `string` | Threaded reply target message id |
| `status` | `MessageStatus` | Delivery status (`pending` on insert) |
| `urgent?` | `boolean` | Intended to wake the recipient on next tick; stored but not read by any package code |
| `expiresAt?` | `Date \| null` | Expiry timestamp consumed by `markExpired` |
| `createdAt` | `Date` | Insert time |

### `CreateMessageInput` — `packages/a2ax/src/types/message.ts:84`

Input accepted by `Transport.insertMessage`. Same fields as `Message` minus `id`, `status`, `createdAt`, with `role` optional (defaults to `"agent"` in transports).

| Field | Type | Meaning |
|---|---|---|
| `teamId` | `string` | required |
| `channelType` | `ChannelType` | required |
| `channelId` | `string` | required |
| `fromAgentId` | `string` | required |
| `role?` | `MessageRole` | default `"agent"` |
| `kind` | `MessageKind` | required |
| `content` | `string` | required |
| `parts?` / `artifacts?` / `payload?` / `replyTo?` / `urgent?` / `expiresAt?` | as in `Message` | optional |

---

## packages/a2ax/src/types/channel.ts

Channel types plus four pure, deterministic channel-ID constructors. The ID helpers are load-bearing: both transports reconstruct expected direct-channel ids during relevance filtering, so the format is part of the protocol contract.

### `Channel` — `packages/a2ax/src/types/channel.ts:8`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Channel id (text, format per helper functions below) |
| `teamId` | `string` | Owning team |
| `channelType` | `ChannelType` | Channel family |
| `name?` | `string` | Display name (group name, task title, `"team-broadcast"`) |
| `metadata?` | `Record<string, unknown>` | Arbitrary metadata |
| `createdAt` | `Date` | Creation time (set by the transport) |

### `ChannelMember` — `packages/a2ax/src/types/channel.ts:18`

Membership row, only meaningful for `group` channels.

| Field | Type | Meaning |
|---|---|---|
| `channelId` | `string` | Group channel id |
| `agentId` | `string` | Member agent id |
| `joinedAt` | `Date` | Join time |

### `directChannelId(agentA: string, agentB: string): string` — `packages/a2ax/src/types/channel.ts:29`

Returns `direct:<lo>:<hi>` where the two agent ids are lexicographically sorted, so the same pair always yields the same channel id regardless of who initiates. Pure.

- **Calls:** nothing.
- **Called by:** `packages/a2ax/src/core/protocol.ts:76` (`A2AX.sendDirect`), `packages/a2ax/src/transport/memory.ts:71` (`MemoryTransport.queryMessages` direct-relevance check), `packages/a2ax/src/adapters/json-file.ts:198` (`JsonFileTransport.queryMessages` direct-relevance check). No callers outside the package.

### `broadcastChannelId(teamId: string): string` — `packages/a2ax/src/types/channel.ts:35`

Returns `team:<teamId>` — one broadcast channel per team. Pure.

- **Calls:** nothing.
- **Called by:** `packages/a2ax/src/core/protocol.ts:109` (`A2AX.broadcast`). No callers outside the package.

### `groupChannelId(groupId: string): string` — `packages/a2ax/src/types/channel.ts:40`

Returns `group:<groupId>`. Pure.

- **Calls:** nothing.
- **Called by:** `packages/a2ax/src/core/protocol.ts:136` (`A2AX.createGroup`). No callers outside the package.

### `taskChannelId(taskId: string): string` — `packages/a2ax/src/types/channel.ts:45`

Returns `task:<taskId>`. Pure. Both transports also hard-code the `` `task:${id}` `` format inline when creating tasks and building relevance sets rather than calling this helper.

- **Calls:** nothing.
- **Called by:** `packages/a2ax/src/core/protocol.ts:207, 247, 274` (`A2AX.createTask`, `updateTaskState`, `completeTask`). No callers outside the package (a string literal of the same shape appears in `packages/backend/tests/unit/api-conversations.test.ts:388`).

---

## packages/a2ax/src/types/task.ts

A2A task lifecycle types plus the transition table and its validator.

### `TaskState` — `packages/a2ax/src/types/task.ts:6`

Union `"submitted" | "accepted" | "working" | "input_required" | "completed" | "failed" | "canceled" | "rejected"`. Stored verbatim as the `state` string on each task in `messages/tasks.json` (no DB enum).

### `Task` — `packages/a2ax/src/types/task.ts:17`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | UUID |
| `teamId` | `string` | Owning team |
| `channelId` | `string` | Always `task:<id>` — the task's dedicated channel |
| `requestorId` | `string` | Agent that created the task |
| `assigneeId` | `string` | Agent responsible for the task |
| `title` | `string` | Short title (also used as the task channel name) |
| `description` | `string` | Full work description |
| `state` | `TaskState` | Current lifecycle state (`submitted` on creation) |
| `metadata?` | `Record<string, unknown>` | Arbitrary metadata |
| `createdAt` / `updatedAt` | `Date` | Timestamps |

### `CreateTaskInput` — `packages/a2ax/src/types/task.ts:32`

Input for `Transport.createTask` / `A2AX.createTask`: `teamId`, `requestorId`, `assigneeId`, `title`, `description`, optional `metadata`. The transport generates `id`, `channelId`, `state`, and timestamps.

### `UpdateTaskInput` — `packages/a2ax/src/types/task.ts:42`

Partial update for `Transport.updateTask`: optional `state` and optional `metadata`.

### `TASK_TRANSITIONS` — `packages/a2ax/src/types/task.ts:48`

`Record<TaskState, TaskState[]>` constant encoding the legal state machine:

| From | Allowed targets |
|---|---|
| `submitted` | `accepted`, `rejected`, `canceled` |
| `accepted` | `working`, `canceled` |
| `working` | `input_required`, `completed`, `failed`, `canceled` |
| `input_required` | `working`, `canceled` |
| `completed` / `failed` / `canceled` / `rejected` | (terminal — empty) |

- **Called by:** `isValidTransition` (`packages/a2ax/src/types/task.ts:61`) only.

### `isValidTransition(from: TaskState, to: TaskState): boolean` — `packages/a2ax/src/types/task.ts:60`

Returns whether `to` is listed in `TASK_TRANSITIONS[from]`. Pure lookup, no errors.

- **Calls:** `TASK_TRANSITIONS`.
- **Called by:** `packages/a2ax/src/core/protocol.ts:240` (`A2AX.updateTaskState`). Notably **not** called by `A2AX.completeTask`, which force-sets `completed` from any state. No callers outside the package.

---

## packages/a2ax/src/types/auth.ts

Bearer-token auth types and two runtime helpers.

### `AgentToken` — `packages/a2ax/src/types/auth.ts:6`

A bearer token issued to an agent (intended at spawn time).

| Field | Type | Meaning |
|---|---|---|
| `agentId` | `string` | Token owner |
| `teamId` | `string` | Team the token is scoped to |
| `token` | `string` | The bearer value itself (primary key in storage) |
| `scopes` | `string[]` | Granted scope strings |
| `expiresAt?` | `Date` | Optional expiry, checked by `A2AX.authenticate`/`authorize` |
| `createdAt` | `Date` | Issue time |

### `DEFAULT_SCOPES` — `packages/a2ax/src/types/auth.ts:16`

`as const` array of the eight scopes for team-internal agents: `message:send`, `message:read`, `task:create`, `task:update`, `broadcast:send`, `group:join`, `group:send`, `card:read`.

- **Called by:** unused. `A2AX.issueToken` (`packages/a2ax/src/core/protocol.ts:385-394`) re-lists the identical eight scopes as an inline literal instead of referencing this constant.

### `Scope` — `packages/a2ax/src/types/auth.ts:28`

Union of all thirteen scope strings: the eight defaults plus `task:cancel`, `group:leave`, `group:create`, `card:write`, and `admin` (wildcard).

### `hasScope(token: AgentToken, scope: Scope): boolean` — `packages/a2ax/src/types/auth.ts:44`

Returns true if `token.scopes` includes the requested scope **or** includes `"admin"` (admin implies everything). Pure, no expiry check — expiry is the caller's job.

- **Calls:** nothing.
- **Called by:** `packages/a2ax/src/core/protocol.ts:413` (`A2AX.authorize`). No callers outside the package.

### `generateToken(): string` — `packages/a2ax/src/types/auth.ts:49`

Generates a 64-hex-character token from 32 bytes of `crypto.getRandomValues` (CSPRNG). No side effects beyond randomness.

- **Calls:** `crypto.getRandomValues`.
- **Called by:** `packages/a2ax/src/core/protocol.ts:380` (`A2AX.issueToken`). No callers outside the package.

---

## packages/a2ax/src/types/agent-card.ts

A2A-spec-compliant Agent Card types with a2ax extensions, plus one factory function.

### `AgentCapabilities` — `packages/a2ax/src/types/agent-card.ts:6`

| Field | Type | Meaning |
|---|---|---|
| `streaming` | `boolean` | A2A: supports streaming responses |
| `pushNotifications` | `boolean` | A2A: supports push notifications |
| `extendedAgentCard` | `boolean` | A2A: serves an extended card |
| `broadcast?` | `boolean` | a2ax extension: listens on the broadcast channel |
| `groups?` | `boolean` | a2ax extension: supports group channels |
| `tasks?` | `boolean` | a2ax extension: supports task management |

### `AgentSkill` — `packages/a2ax/src/types/agent-card.ts:19`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Skill identifier |
| `name` | `string` | Display name |
| `description?` | `string` | What the skill does |
| `inputSchema?` / `outputSchema?` | `Record<string, unknown>` | JSON-schema-shaped I/O contracts |
| `acceptedMediaTypes?` | `string[]` | MIME types the skill accepts |

### `AgentProvider` — `packages/a2ax/src/types/agent-card.ts:29`

`name`, optional `url`, optional `contact` — who operates the agent.

### `SecurityScheme` — `packages/a2ax/src/types/agent-card.ts:36`

OpenAPI-compatible security scheme description.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"apiKey" \| "http" \| "oauth2" \| "openIdConnect" \| "mutualTls"` | Scheme family |
| `name?` | `string` | apiKey: header/query-param name |
| `in?` | `"header" \| "query"` | apiKey: location |
| `scheme?` | `string` | http: `bearer`/`basic` |
| `bearerFormat?` | `string` | http bearer format hint |
| `flows?` | `OAuthFlows` | oauth2 flows |
| `openIdConnectUrl?` | `string` | OIDC discovery URL |
| `certificateUrl?` | `string` | mutualTls cert URL |
| `description?` | `string` | Human description |

### `OAuthFlows` — `packages/a2ax/src/types/agent-card.ts:54`

Optional `authorizationCode`, `clientCredentials`, `deviceCode` — each an `OAuthFlow`.

### `OAuthFlow` — `packages/a2ax/src/types/agent-card.ts:60`

`tokenUrl` (required), `scopes: Record<string, string>` (required, scope → description), optional `authorizationUrl`, `refreshUrl`.

### `AgentCardSignature` — `packages/a2ax/src/types/agent-card.ts:68`

`algorithm`, `signature`, optional `keyId` — for card verification. No signing/verification code exists in the package; this is a data carrier only.

### `AgentCard` — `packages/a2ax/src/types/agent-card.ts:75`

The full card.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Agent id (primary key in storage) |
| `name` | `string` | Display name |
| `description?` | `string` | What the agent does |
| `provider?` | `AgentProvider` | Operator info |
| `endpoint` | `string` | The agent's A2A endpoint URL |
| `capabilities` | `AgentCapabilities` | Feature flags |
| `skills` | `AgentSkill[]` | Declared skills |
| `securitySchemes?` | `Record<string, SecurityScheme>` | Named auth schemes |
| `security?` | `Record<string, string[]>[]` | Security requirements (OpenAPI shape) |
| `signature?` | `AgentCardSignature` | Card signature |
| `metadata?` | `Record<string, unknown>` | Arbitrary metadata — **`metadata.teamId` is the de-facto team key** used by both transports' `listCards` filters |

### `createAgentCard(opts: Pick<AgentCard, "id" | "name" | "endpoint"> & Partial<AgentCard>): AgentCard` — `packages/a2ax/src/types/agent-card.ts:90`

Factory that builds a card from at minimum `id`/`name`/`endpoint`, defaulting `capabilities` to `{ streaming: false, pushNotifications: false, extendedAgentCard: false, broadcast: true, groups: true, tasks: true }` and `skills` to `[]`. Caller-provided fields spread over the defaults (a caller-supplied `capabilities` replaces the default object wholesale). Pure, no validation.

- **Calls:** nothing.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:2, 199, 223, 231`).

---

## packages/a2ax/src/core/transport.ts

The storage abstraction. Contains no runtime code — two interfaces only.

### `MessageQuery` — `packages/a2ax/src/core/transport.ts:12`

Filter passed to `Transport.queryMessages`.

| Field | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Tenant scope (required) |
| `agentId` | `string` | Perspective agent — results are messages *relevant to* this agent, excluding its own |
| `unreadOnly?` | `boolean` | Only messages not yet read by `agentId` and not expired |
| `limit?` | `number` | Max rows |
| `channelType?` | `string` | Restrict to one channel family |

### `Transport` — `packages/a2ax/src/core/transport.ts:27`

The contract both `MemoryTransport` and `JsonFileTransport` implement. Method semantics (the contract; per-implementation differences are documented on each class):

| Method | Contract |
|---|---|
| `insertMessage(input: CreateMessageInput): Promise<Message>` | Persist a message with `status: "pending"`, generated id and `createdAt`; `role` defaults to `"agent"`. Returns the full message. |
| `queryMessages(query: MessageQuery): Promise<Message[]>` | Return messages in `teamId` relevant to `agentId`: never the agent's own; direct only if the agent is a party of the channel; broadcast always; group only if a member; task only if requestor or assignee. Honors `unreadOnly` (per-recipient read state + not expired), `channelType`, `limit`; sorted oldest-first by `createdAt`. |
| `listTeamMessages(teamId, limit?): Promise<Message[]>` | All messages for a team, chronological — for the UI/inspection dashboards, **not** relevance-filtered like `queryMessages`. (Added in PR #16; surfaced as `A2AX.listMessages`.) |
| `markRead(agentId, messageIds): Promise<void>` | Record that *this agent* read these messages (per-recipient, not global — one broadcast row is shared by all readers). Idempotent. |
| `markExpired(before: Date): Promise<number>` | Flip messages whose `expiresAt < before` to `status: "expired"`; returns the count flipped. |
| `getChannel(channelId): Promise<Channel \| null>` | Fetch one channel or null. |
| `createChannel(channel: Omit<Channel, "createdAt">): Promise<Channel>` | Persist a channel, stamping `createdAt`. |
| `listChannels(teamId): Promise<Channel[]>` | All channels for a team. |
| `addMember(channelId, agentId): Promise<ChannelMember>` | Idempotently add a group member, returning the membership. |
| `removeMember(channelId, agentId): Promise<void>` | Delete a membership. |
| `getMembers(channelId): Promise<ChannelMember[]>` | Members of a channel. |
| `getMemberships(agentId): Promise<ChannelMember[]>` | Channels an agent belongs to. |
| `createTask(input: CreateTaskInput): Promise<Task>` | Persist a task with generated id, `channelId = task:<id>`, `state: "submitted"`. |
| `getTask(taskId): Promise<Task \| null>` | Fetch one task or null. |
| `updateTask(taskId, input: UpdateTaskInput): Promise<Task>` | Apply state/metadata updates, bump `updatedAt`; throws `Error("Task <id> not found")` if missing. |
| `listTasks(teamId, agentId?): Promise<Task[]>` | Tasks for a team, optionally restricted to those where `agentId` is requestor or assignee. |
| `getCard(agentId): Promise<AgentCard \| null>` | Fetch one agent card or null. |
| `upsertCard(card: AgentCard): Promise<AgentCard>` | Insert-or-update a card keyed by `card.id`. |
| `listCards(teamId): Promise<AgentCard[]>` | Cards whose `metadata.teamId` strictly equals `teamId` (no cross-team leak). |
| `createToken(token: AgentToken): Promise<AgentToken>` | Persist a token row. |
| `getToken(token: string): Promise<AgentToken \| null>` | Look up a token by value. |
| `revokeToken(token: string): Promise<void>` | Delete a token. |

- **Implemented by:** `MemoryTransport` (`packages/a2ax/src/transport/memory.ts:13`), `JsonFileTransport` (`packages/a2ax/src/adapters/json-file.ts:44`).
- **Consumed by:** `A2AX` (`packages/a2ax/src/core/protocol.ts:50`) — the only consumer. `listChannels`, `getMembers`, `getMemberships`, and `revokeToken` are never called by `A2AX` or any host code; they exist as interface surface only. (`listTeamMessages` and `listTasks` are now consumed — `A2AX.listMessages`/`A2AX.listTasks` delegate straight to them, powering the conversation/task/agent-hub dashboards. Unlike `DrizzleTransport`, `JsonFileTransport.queryMessages` does its relevance filtering against in-memory `members`/`tasks` rather than calling `getMemberships`.)

---

## packages/a2ax/src/transport/memory.ts

### `MemoryTransport` — `packages/a2ax/src/transport/memory.ts:13`

In-memory `Transport` implementation for tests and prototyping. Constructed with no arguments; holds all state in private fields: `messages: Message[]`, `reads: Set<string>` (per-recipient read tracking keyed `` `${messageId}:${agentId}` ``), `channels: Map<string, Channel>`, `members: ChannelMember[]`, `tasks: Map<string, Task>`, `cards: Map<string, AgentCard>`, `tokens: Map<string, AgentToken>`. Returned objects are the live stored objects (no cloning), so callers can mutate state — fine for tests, not for production.

- **Called by (construction):** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:3, 13, 274`). Not used anywhere in the host app.

Methods below note only behavior beyond the `Transport` contract (see `core/transport.ts`).

### `insertMessage(input: CreateMessageInput): Promise<Message>` — `packages/a2ax/src/transport/memory.ts:27`

Builds the `Message` with `crypto.randomUUID()`, `status: "pending"`, `expiresAt: input.expiresAt ?? null`, `createdAt: new Date()`, pushes to the array.

### `queryMessages(query: MessageQuery): Promise<Message[]>` — `packages/a2ax/src/transport/memory.ts:50`

Filters by `teamId`; if `unreadOnly`, drops expired messages and any with a `reads` entry for this agent; applies `channelType`; then per-message relevance: own messages excluded, `direct` matched by recomputing `directChannelId(query.agentId, m.fromAgentId)`, `broadcast` always relevant, `group` requires a `members` entry, `task` requires the channel to be `task:<id>` of a task where the agent is assignee or requestor. Sorts ascending by `createdAt` and applies `limit`.

- **Calls:** `directChannelId` (`packages/a2ax/src/types/channel.ts:29`).

### `listTeamMessages(teamId: string, limit?: number): Promise<Message[]>` — `packages/a2ax/src/transport/memory.ts:107`

All team messages, chronological (no relevance filter), sliced to `limit`. The unfiltered read view backing `A2AX.listMessages`.

### `markRead(agentId: string, messageIds: string[]): Promise<void>` — `packages/a2ax/src/transport/memory.ts:114`

Adds `` `${id}:${agentId}` `` keys to the `reads` set. Idempotent by Set semantics.

### `markExpired(before: Date): Promise<number>` — `packages/a2ax/src/transport/memory.ts:120`

Mutates matching messages' `status` to `"expired"` in place; counts only messages not already expired.

### `getChannel` / `createChannel` / `listChannels` — `packages/a2ax/src/transport/memory.ts:133,137,143`

Straight Map operations; `createChannel` stamps `createdAt: new Date()`.

### `addMember(channelId: string, agentId: string): Promise<ChannelMember>` — `packages/a2ax/src/transport/memory.ts:147`

Checks for an existing membership first and returns it unchanged (true idempotence). `JsonFileTransport.addMember` does the same de-dup check (see that entry).

### `removeMember` / `getMembers` / `getMemberships` — `packages/a2ax/src/transport/memory.ts:157,163,167`

Array filter operations over `members`.

### `createTask(input: CreateTaskInput): Promise<Task>` — `packages/a2ax/src/transport/memory.ts:173`

Generates the task id, initially sets `channelId` to `` `task:${crypto.randomUUID()}` `` with a *throwaway* UUID, then immediately overwrites it with `` `task:${task.id}` `` — the first UUID is dead work. `state: "submitted"`.

### `getTask` / `updateTask` / `listTasks` — `packages/a2ax/src/transport/memory.ts:193,197,206`

`updateTask` mutates in place, **merges** `metadata` (`{ ...task.metadata, ...input.metadata }`) and bumps `updatedAt`; throws `Error("Task <id> not found")` if missing. (`JsonFileTransport.updateTask` merges metadata the same way.)

### `getCard` / `upsertCard` / `listCards` — `packages/a2ax/src/transport/memory.ts:218,222,227`

`upsertCard` is a Map set keyed by `card.id`. `listCards` filters strictly on `card.metadata.teamId === teamId` (a comment notes a previous `|| true` bug that leaked every card across teams).

### `createToken` / `getToken` / `revokeToken` — `packages/a2ax/src/transport/memory.ts:237,242,246`

Map operations keyed by the token string.

---

## packages/a2ax/src/storage/file-store.ts

Self-contained synchronous fs helpers for the JSON-file transport. The a2ax package must **not** import the backend store, so this mirrors the backend's fs primitives independently: atomic JSON writes (temp + rename), JSONL append logs, and a recursive walk that locates team folders by the `team.json` marker. No exported constant or class — just functions.

### `readJson<T>(path, fallback): T` — `packages/a2ax/src/storage/file-store.ts:24`

Reads and `JSON.parse`s a file; returns `fallback` on `ENOENT` or an empty/whitespace file; rethrows other errors. Used by `loadDir` for `channels.json`/`members.json`/`tasks.json`/`cards.json`/`tokens.json` (each with `[]` fallback) and by the per-collection persisters' inverse.

### `writeJson(path, value): void` — `packages/a2ax/src/storage/file-store.ts:35`

Atomic object write: `mkdirSync` the parent, stringify pretty-printed with a trailing newline to `<path>.tmp`, then `renameSync` over `path`. Backs every `persist*` rewrite (channels/members/tasks/cards/tokens).

### `readJsonl<T>(path): T[]` — `packages/a2ax/src/storage/file-store.ts:42`

Reads a JSONL file, `JSON.parse`-ing each non-blank line into an array; `[]` on `ENOENT`. Used to hydrate `log.jsonl` (messages) and `reads.jsonl` (read receipts).

### `appendJsonl(path, row): void` — `packages/a2ax/src/storage/file-store.ts:58`

`mkdirSync` the parent, then `appendFileSync` one `JSON.stringify(row)` line. Used for each new message (`log.jsonl`) and each read receipt (`reads.jsonl`); single-line appends are the durability primitive for the append-only logs.

### `rewriteJsonl(path, rows): void` — `packages/a2ax/src/storage/file-store.ts:63`

Atomic full-file rewrite of a JSONL log (temp + rename; empty file when `rows` is empty). The only non-append mutation of `log.jsonl` — `markExpired` calls it to flip statuses on the affected teams' message logs.

### `discoverTeamMessageDirs(teamsRoot): Map<string, string>` — `packages/a2ax/src/storage/file-store.ts:86`

Walks the recursive team tree under `teamsRoot` and returns `teamId → <teamDir>/messages`. A folder is a team iff it contains `team.json`; its sub-teams live in its `teams/` subfolder, which the walk recurses into. This is what lets `JsonFileTransport` resolve every team's files (and answer teamId-less methods) without a fixed path. Internally uses a private `listSubdirs` (directory entries only, `[]` on `ENOENT`).

- **Called by:** `JsonFileTransport.hydrate` (`packages/a2ax/src/adapters/json-file.ts:64`) and `JsonFileTransport.dirForTeam` (`packages/a2ax/src/adapters/json-file.ts:107`, the re-walk path for a team that appeared after first hydration). No callers outside the package.

---

## packages/a2ax/src/adapters/json-file.ts

The production `Transport` implementation (PR #16) — persists each team's communication state as JSON/JSONL files under that team's folder in the recursive data tree. Replaced `DrizzleTransport`, which (with `drizzle.ts`/`drizzle-schema.ts`) was deleted from the package. The query/relevance logic is **identical** to `MemoryTransport`: the adapter holds all state in memory (hydrated once by walking the team tree) and mirrors every write through to the owning team's files. Single-process, single-writer.

### `JsonFileTransport` — `packages/a2ax/src/adapters/json-file.ts:44`

Constructed with one argument, `teamsRoot` (absolute path to `<dataDir>/teams`), supplied by the host as `new JsonFileTransport(teamsRoot())`. Holds the same in-memory collections as `MemoryTransport` (`messages: Message[]`, `reads: Set<string>` keyed `` `${messageId}:${agentId}` ``, `channels`/`tasks`/`cards`/`tokens` Maps, `members: ChannelMember[]`) plus storage bookkeeping: `teamDirs: Map<teamId, messagesDir>`, a `loaded` set of already-read dirs, and a `hydrated` flag.

- **Called by (construction):** `packages/backend/src/server/a2ax.ts:15` (`getA2AX()` singleton, `new JsonFileTransport(teamsRoot())`).

### `hydrate()` / `loadDir(dir)` (private) — `packages/a2ax/src/adapters/json-file.ts:62,69`

`hydrate` runs once (guarded by `hydrated`): `discoverTeamMessageDirs(this.teamsRoot)` fills `teamDirs`, then `loadDir` reads each team's `messages/` files into memory. `loadDir` is idempotent per dir (`loaded` set) and revives ISO-string timestamps to `Date` as it loads (`createdAt`/`expiresAt` on messages, `createdAt` on channels, `joinedAt` on members, `createdAt`/`updatedAt` on tasks, `createdAt`/`expiresAt` on tokens). Every public method calls `hydrate()` first.

### `dirForTeam(teamId)` (private) — `packages/a2ax/src/adapters/json-file.ts:104`

Resolves a team's `messages/` dir from `teamDirs`; if absent, re-walks the tree once (`discoverTeamMessageDirs`) and loads the dir — handling teams created after first hydration. Throws `` Error(`a2ax: team <id> folder not found under <root>`) `` if still missing. Every write goes through this to find the file to append/rewrite.

### `persistChannels` / `persistMembers` / `persistTasks` / `persistCards` / `persistTokens` (private) — `packages/a2ax/src/adapters/json-file.ts:117,124,131,138,147`

Each filters the relevant in-memory collection down to one team and `writeJson`s the whole list back to that team's `channels.json`/`members.json`/`tasks.json`/`cards.json`/`tokens.json`. `persistMembers` scopes by the member's channel's `teamId`; `persistCards`/`persistTokens` by `metadata.teamId`/`token.teamId`. These full-collection rewrites are why the JSON files (not the JSONL logs) are always the current snapshot.

Methods below note only behavior beyond the `Transport` contract (see `core/transport.ts`); the relevance/sort logic matches `MemoryTransport`.

### `insertMessage(input: CreateMessageInput): Promise<Message>` — `packages/a2ax/src/adapters/json-file.ts:156`

Builds the `Message` with `crypto.randomUUID()`, `status: "pending"`, `expiresAt: input.expiresAt ?? null`, `createdAt: new Date()`, pushes to memory, and `appendJsonl`s it to the team's `log.jsonl`.

### `queryMessages(query: MessageQuery): Promise<Message[]>` — `packages/a2ax/src/adapters/json-file.ts:181`

Identical filtering to `MemoryTransport.queryMessages`: `teamId`, then `unreadOnly` (not expired + no `reads` entry), then `channelType`, then per-message relevance — own messages excluded, `direct` matched by recomputing `directChannelId(query.agentId, m.fromAgentId)`, `broadcast` always, `group` requires a `members` entry, `task` requires the channel to be `task:<id>` of a task where the agent is assignee or requestor. Sorted ascending by `createdAt`, sliced to `limit` (no default cap — unlike the old Drizzle `?? 100`; there is no post-LIMIT-relevance footgun because filtering happens before the slice).

- **Calls:** `directChannelId` (`packages/a2ax/src/types/channel.ts:29`).

### `listTeamMessages(teamId: string, limit?: number): Promise<Message[]>` — `packages/a2ax/src/adapters/json-file.ts:225`

All of a team's messages, chronological (no relevance filter), sliced to `limit`. Backs `A2AX.listMessages`, which the conversation and agent-hub dashboards call.

### `markRead(agentId: string, messageIds: string[]): Promise<void>` — `packages/a2ax/src/adapters/json-file.ts:233`

For each id not already in `reads`, adds the `` `${id}:${agentId}` `` key and `appendJsonl`s a `{messageId, agentId, readAt}` row to the message's team's `reads.jsonl`. Idempotent (skips keys already present), so the append-only log never double-writes a receipt.

### `markExpired(before: Date): Promise<number>` — `packages/a2ax/src/adapters/json-file.ts:250`

Flips every non-expired message with `expiresAt < before` to `"expired"` in memory, tracks the affected `teamId`s, then `rewriteJsonl`s each affected team's whole `log.jsonl` (the only place the append-only log is rewritten). Returns the count flipped.

### `getChannel` / `createChannel` / `listChannels` — `packages/a2ax/src/adapters/json-file.ts:272,277,285`

Map/array reads; `createChannel` stamps `createdAt: new Date()`, stores it, and `persistChannels(teamId)`.

### `addMember(channelId: string, agentId: string): Promise<ChannelMember>` — `packages/a2ax/src/adapters/json-file.ts:290`

Returns an existing membership unchanged (de-dup check, like `MemoryTransport`); otherwise pushes `{channelId, agentId, joinedAt: new Date()}` and `persistMembers` for the channel's team (skipping the rewrite if the channel is unknown).

### `removeMember` / `getMembers` / `getMemberships` — `packages/a2ax/src/adapters/json-file.ts:301,310,315`

Array filters over `members`; `removeMember` then `persistMembers` for the channel's team.

### `createTask(input: CreateTaskInput): Promise<Task>` — `packages/a2ax/src/adapters/json-file.ts:322`

Generates the id once, writes `channelId: `` `task:${id}` `` directly (no throwaway UUID, unlike `MemoryTransport`), `state: "submitted"`, stamps both timestamps, stores, and `persistTasks(input.teamId)`.

### `getTask` / `updateTask` / `listTasks` — `packages/a2ax/src/adapters/json-file.ts:344,349,360`

`updateTask` mutates in place, **merges** `metadata` (like `MemoryTransport`), bumps `updatedAt`, throws `Error("Task <id> not found")` if missing, and `persistTasks(task.teamId)`. `listTasks` filters by team and optionally by participant (assignee or requestor).

### `getCard` / `upsertCard` / `listCards` — `packages/a2ax/src/adapters/json-file.ts:371,376,384`

`upsertCard` sets the card in the Map and `persistCards` only when `metadata.teamId` is a string. `listCards` filters strictly on `metadata.teamId === teamId` (no cross-team leak).

### `createToken` / `getToken` / `revokeToken` — `packages/a2ax/src/adapters/json-file.ts:393,400,405`

Map operations keyed by the token string; `createToken`/`revokeToken` `persistTokens` for the token's team.

---

## packages/a2ax/src/core/protocol.ts

### `A2AXOptions` — `packages/a2ax/src/core/protocol.ts:25`

Constructor options for `A2AX`.

| Field | Type | Meaning |
|---|---|---|
| `transport` | `Transport` | Storage backend (required) |
| `maxContextMessages?` | `number` | Cap on messages injected per tick (default 20) |
| `defaultExpiryMs?` | `number` | Default message TTL in ms (default 7 days) |

### `AgentContext` — `packages/a2ax/src/core/protocol.ts:34`

Return shape of `getAgentContext` — a context block ready to inject into an agent's prompt.

| Field | Type | Meaning |
|---|---|---|
| `messages` | `Message[]` | The selected unread messages, oldest first |
| `formatted` | `string` | Prompt-ready text block (see `formatContext`) |
| `messageIds` | `string[]` | Ids to pass to `markContextRead` after a successful tick |

### `A2AX` — `packages/a2ax/src/core/protocol.ts:49`

The protocol facade and primary public API. Constructed from `A2AXOptions` (`constructor` at `:54`); holds three private fields: the `transport`, `maxContextMessages` (default 20), and `defaultExpiryMs` (default `7 * 24 * 60 * 60 * 1000`). Stateless beyond configuration — all persistence goes through the transport, so a single instance is safe to share process-wide (the host keeps a singleton in `packages/backend/src/server/a2ax.ts:9-24`, `getA2AX()`).

- **Constructed by:** `packages/backend/src/server/a2ax.ts:17`; tests `packages/a2ax/tests/protocol.test.ts:13, 273`. The backend's meta-agent never sees the class itself — it receives a structural two-method facade `A2AXSender` (`packages/backend/src/lib/meta-agent/tools.ts:56`) that the tick handler satisfies with the real instance.

### `sendDirect(teamId: string, fromAgentId: string, toAgentId: string, content: string, opts?: { kind?; parts?; payload?; urgent? }): Promise<Message>` — `packages/a2ax/src/core/protocol.ts:64`

Sends a 1:1 message. Computes the deterministic channel id, lazily creates the channel if missing, then inserts a message with `kind` defaulting to `"text"` and `expiresAt = now + defaultExpiryMs`. No validation that the agents exist or are on the team.

- **Calls:** `directChannelId`, `ensureChannel`, `Transport.insertMessage`.
- **Called by:** `packages/backend/src/server/api/seed.ts:107-393` (30 calls seeding demo conversations), `packages/backend/src/server/api/team/id/messages.ts:105` (POST messages API), and via the `A2AXSender` facade from the `send_message` agent tool `packages/backend/src/lib/meta-agent/default-tools.ts:69`.

### `broadcast(teamId: string, fromAgentId: string, content: string, opts?: { kind?; parts?; payload? }): Promise<Message>` — `packages/a2ax/src/core/protocol.ts:99`

Sends one message to the team-wide broadcast channel (`team:<teamId>`, lazily created with name `"team-broadcast"`). Single row; fan-out happens at read time via per-recipient relevance/read tracking. Default kind `"text"`, expiry `defaultExpiryMs`. No `urgent` option (unlike `sendDirect`).

- **Calls:** `broadcastChannelId`, `ensureChannel`, `Transport.insertMessage`.
- **Called by:** `packages/backend/src/server/api/seed.ts:201, 229`; `packages/backend/src/server/api/team/id/messages.ts:87`; `packages/backend/src/server/api/tick.ts:661` (`failAgent` — fire-and-forget `[SYSTEM]` error alert to peers); via `A2AXSender` from the `broadcast` agent tool `packages/backend/src/lib/meta-agent/default-tools.ts:92`.

### `createGroup(teamId: string, name: string, memberIds: string[]): Promise<{ channelId: string }>` — `packages/a2ax/src/core/protocol.ts:130`

Creates a group channel (`group:<random uuid>`), adds each member sequentially via `Transport.addMember`, then inserts a `role: "system"`, `kind: "system.created"` announcement message attributed to `memberIds[0]` (undefined `fromAgentId` if the member list is empty — not guarded). The system message has no `expiresAt`.

- **Calls:** `groupChannelId`, `Transport.createChannel`, `Transport.addMember`, `Transport.insertMessage`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:85, 105, 124`).

### `sendToGroup(teamId: string, channelId: string, fromAgentId: string, content: string, opts?): Promise<Message>` — `packages/a2ax/src/core/protocol.ts:163`

Inserts a group message with default kind `"text"` and `defaultExpiryMs` expiry. Does **not** verify the channel exists, that it is a group, or that the sender is a member.

- **Calls:** `Transport.insertMessage`.
- **Called by:** `packages/backend/src/server/api/team/id/messages.ts:96`; otherwise tests only.

### `joinGroup(channelId: string, agentId: string): Promise<void>` — `packages/a2ax/src/core/protocol.ts:187`

Fetches the channel and throws `Error("Channel <id> is not a group")` if it is missing or not `channelType === "group"`, then adds the membership. No `system.join` message is emitted despite the kind existing.

- **Calls:** `Transport.getChannel`, `Transport.addMember`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:132`).

### `leaveGroup(channelId: string, agentId: string): Promise<void>` — `packages/a2ax/src/core/protocol.ts:195`

Thin passthrough to `Transport.removeMember` — no existence/type check (asymmetric with `joinGroup`) and no `system.leave` message.

- **Calls:** `Transport.removeMember`.
- **Called by:** unused — no callers anywhere, including tests.

### `createTask(input: CreateTaskInput): Promise<{ task: Task; channelId: string }>` — `packages/a2ax/src/core/protocol.ts:203`

Three writes: creates the task row (state `submitted`), creates its dedicated channel (`task:<taskId>`, named after the title), and inserts an initial `kind: "task.create"` message from the requestor carrying the description as content and `{ title, assigneeId }` as payload, flagged `urgent: true`. Task messages get **no** `expiresAt` (they never expire, unlike direct/broadcast/group traffic). Not transactional — a failure between steps leaves a task without channel or vice versa.

- **Calls:** `Transport.createTask`, `taskChannelId`, `Transport.createChannel`, `Transport.insertMessage`.
- **Called by:** `packages/backend/src/server/api/seed.ts:403, 412, 427, 443, 459, 476, 486, 502, 511` (demo seeding); otherwise tests only.

### `updateTaskState(taskId: string, agentId: string, newState: TaskState, content?: string): Promise<Task>` — `packages/a2ax/src/core/protocol.ts:231`

Loads the task (throws `Error("Task <id> not found")`), validates the transition with `isValidTransition` (throws `` Error(`Invalid transition: <from> -> <to>`) `` if illegal), persists the new state, and posts a `kind: "task.status"` message to the task channel with `content ?? "Task moved to <state>"` and `payload: { state }`. Does not check that `agentId` is a task participant.

- **Calls:** `Transport.getTask`, `isValidTransition`, `Transport.updateTask`, `taskChannelId`, `Transport.insertMessage`.
- **Called by:** `packages/backend/src/server/api/seed.ts:420, 435-436, 451-452, 467-469, 494-495`; otherwise tests only.

### `completeTask(taskId: string, agentId: string, content: string, opts?: { parts?; payload? }): Promise<Task>` — `packages/a2ax/src/core/protocol.ts:262`

Loads the task (throws if missing), then force-sets `state: "completed"` **without** calling `isValidTransition` — completion is legal from any state, including terminal ones. Posts a `kind: "task.result"` message with the result content and optional parts/payload to the task channel.

- **Calls:** `Transport.getTask`, `Transport.updateTask`, `taskChannelId`, `Transport.insertMessage`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:173`).

### `getAgentContext(teamId: string, agentId: string): Promise<AgentContext>` — `packages/a2ax/src/core/protocol.ts:294`

The read side of the protocol: runs four `queryMessages` calls (one per channel type: direct, broadcast, group, task), each `unreadOnly: true` and limited to `maxContextMessages`; merges, sorts ascending by `createdAt`, and takes the **first** `maxContextMessages` — i.e. the *oldest* unread messages win (FIFO backlog draining; newer messages wait for a later tick). The `urgent` flag plays no role in selection. Returns the messages, their ids, and the `formatContext` string.

- **Calls:** `Transport.queryMessages` (x4), `formatContext`.
- **Called by:** `packages/backend/src/server/api/tick.ts:401` (context injection for each agent tick), `packages/backend/src/server/api/team/id/messages.ts:23` (GET messages API); tests.

### `markContextRead(agentId: string, messageIds: string[]): Promise<void>` — `packages/a2ax/src/core/protocol.ts:349`

Per-recipient acknowledgment of a previously returned context: passes the ids to `Transport.markRead`, skipping the call entirely for an empty list. The tick handler calls this only after a successful agent run, so messages from failed ticks are redelivered.

- **Calls:** `Transport.markRead`.
- **Called by:** `packages/backend/src/server/api/tick.ts:462`; tests.

### `listMessages(teamId: string, limit?: number): Promise<Message[]>` — `packages/a2ax/src/core/protocol.ts:360`

Read view added in PR #16: all of a team's messages, chronological and **not** relevance-filtered (the unfiltered dashboard counterpart to `getAgentContext`). Thin passthrough to `Transport.listTeamMessages`.

- **Calls:** `Transport.listTeamMessages`.
- **Called by:** `packages/backend/src/server/api/team/id/conversations.ts` (full team feed, then filtered per participant), `packages/backend/src/server/api/team/id/agent-hub.ts` (the dashboard's message column). Replaces the raw Drizzle selects those handlers used to run against the a2ax message tables.

### `listTasks(teamId: string, agentId?: string): Promise<Task[]>` — `packages/a2ax/src/core/protocol.ts:365`

Read view added in PR #16: all of a team's tasks, optionally narrowed to a participant (assignee or requestor). Thin passthrough to `Transport.listTasks`.

- **Calls:** `Transport.listTasks`.
- **Called by:** `packages/backend/src/server/api/team/id/tasks.ts` (task board), `packages/backend/src/server/api/team/id/conversations.ts` (task-title map). Replaces the raw Drizzle selects over the a2ax task table.

### `registerCard(card: AgentCard): Promise<AgentCard>` — `packages/a2ax/src/core/protocol.ts:373`

Passthrough to `Transport.upsertCard`. Team association must be supplied by the caller in `card.metadata.teamId` or the card is invisible to `discoverAgents`.

- **Calls:** `Transport.upsertCard`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:212, 222, 230`).

### `getCard(agentId: string): Promise<AgentCard | null>` — `packages/a2ax/src/core/protocol.ts:377`

Passthrough to `Transport.getCard`.

- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:213`).

### `discoverAgents(teamId: string): Promise<AgentCard[]>` — `packages/a2ax/src/core/protocol.ts:381`

Passthrough to `Transport.listCards` (strict `metadata.teamId` match).

- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:239`).

### `issueToken(agentId: string, teamId: string, scopes?: Scope[]): Promise<string>` — `packages/a2ax/src/core/protocol.ts:389`

Generates a 64-hex bearer token via `generateToken`, persists it with the provided scopes or an inline copy of the eight default scopes (it does not reference the `DEFAULT_SCOPES` constant), `createdAt: new Date()`, and **no expiry**. Returns the raw token string.

- **Calls:** `generateToken`, `Transport.createToken`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:246`).

### `authenticate(token: string): Promise<{ agentId: string; teamId: string } | null>` — `packages/a2ax/src/core/protocol.ts:414`

Looks up the token; returns null when unknown or expired (`expiresAt < now`), otherwise the owning agent/team identity.

- **Calls:** `Transport.getToken`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:248`).

### `authorize(token: string, scope: Scope): Promise<boolean>` — `packages/a2ax/src/core/protocol.ts:423`

Same lookup-and-expiry check as `authenticate`, then delegates the scope decision to `hasScope` (admin wildcard included). Returns false rather than throwing on any failure.

- **Calls:** `Transport.getToken`, `hasScope`.
- **Called by:** no callers outside tests (`packages/a2ax/tests/protocol.test.ts:252, 255`).

### `expireMessages(): Promise<number>` — `packages/a2ax/src/core/protocol.ts:434`

Maintenance hook: passes `new Date()` to `Transport.markExpired` and returns the number of messages expired.

- **Calls:** `Transport.markExpired`.
- **Called by:** unused — no callers anywhere, including tests. Nothing in the host schedules expiry, so `expiresAt` currently only matters if this is wired up later.

### `ensureChannel(channelId, teamId, channelType, name?): Promise<void>` (private) — `packages/a2ax/src/core/protocol.ts:442`

Get-then-create-if-missing for lazily materialized channels (direct and broadcast). Not atomic — but in the single-process, single-writer file store a synchronous get-then-create runs to completion before any other event-loop task, so two concurrent senders cannot both pass the existence check (the old Postgres race that could violate the channel primary key no longer applies).

- **Calls:** `Transport.getChannel`, `Transport.createChannel`.
- **Called by:** `sendDirect` (`:79`), `broadcast` (`:111`).

### `formatContext(messages: Message[]): string` (private) — `packages/a2ax/src/core/protocol.ts:459`

Renders the prompt block: empty string for no messages; otherwise each message as `<prefix>\n<content>` joined by blank lines, wrapped in `--- Messages since last tick ---` / `---` delimiters. This exact string surfaces in agent prompts as `a2axContext` (`packages/backend/src/server/api/tick.ts:425`).

- **Calls:** `formatPrefix`.
- **Called by:** `getAgentContext` (`:344`).

### `formatPrefix(m: Message): string` (private) — `packages/a2ax/src/core/protocol.ts:470`

Per-channel-type source label: `[direct from <agent>]:`, `[broadcast from <agent>]:`, `[<channelId> from <agent>]:` for groups, `[<channelId> from <agent>] (<kind>):` for tasks, falling back to `[<agent>]:`. Pure.

- **Called by:** `formatContext` (`:463`).

---

## Appendix — cross-package consumers (grep-verified)

| a2ax symbol | Consumed from |
|---|---|
| `A2AX` (class) | `packages/backend/src/server/a2ax.ts:5,17` (singleton `getA2AX()`) |
| `JsonFileTransport` | `packages/backend/src/server/a2ax.ts:6,15` (`new JsonFileTransport(teamsRoot())`) |
| `A2AX.sendDirect` | `packages/backend/src/server/api/seed.ts`; `packages/backend/src/server/api/team/id/messages.ts:105`; `packages/backend/src/lib/meta-agent/default-tools.ts:69` (via `A2AXSender` facade) |
| `A2AX.broadcast` | `packages/backend/src/server/api/seed.ts`; `packages/backend/src/server/api/team/id/messages.ts:87`; `packages/backend/src/server/api/tick.ts` (`failAgent`); `packages/backend/src/lib/meta-agent/default-tools.ts:92` |
| `A2AX.sendToGroup` | `packages/backend/src/server/api/team/id/messages.ts:96` |
| `A2AX.createTask` | `packages/backend/src/server/api/seed.ts` |
| `A2AX.updateTaskState` | `packages/backend/src/server/api/seed.ts` |
| `A2AX.getAgentContext` | `packages/backend/src/server/api/tick.ts:401`; `packages/backend/src/server/api/team/id/messages.ts:23` |
| `A2AX.markContextRead` | `packages/backend/src/server/api/tick.ts:462` |
| `A2AX.listMessages` | `packages/backend/src/server/api/team/id/conversations.ts`; `packages/backend/src/server/api/team/id/agent-hub.ts` (PR #16; replaced raw a2ax-table SQL) |
| `A2AX.listTasks` | `packages/backend/src/server/api/team/id/tasks.ts`; `packages/backend/src/server/api/team/id/conversations.ts` (PR #16; replaced raw a2ax-table SQL) |
| everything else (`createGroup`, `joinGroup`, `leaveGroup`, `completeTask`, cards, auth, `expireMessages`) | package tests only, or unused |

The meta-agent layer deliberately depends on a two-method structural type, `A2AXSender` (`packages/backend/src/lib/meta-agent/tools.ts:56`), rather than this package — the tick handler passes the real `A2AX` instance, and tests pass `vi.fn()` stubs.

---

## Python backend (FastAPI port) — symbol reference

The idiomatic FastAPI port lives under `backend-py/simple_harmonic/a2ax/` and mirrors this package symbol-for-symbol with the same HTTP/wire contract. The type layer (TS `src/types/*.ts`) collapses into a few flat modules; the `Transport` interface and `MemoryTransport` share one file (`transport.py`); the JSON-file adapter is `json_file_transport.py`. Naming conventions for the correspondence:

- **Wire/model field names stay camelCase** — Pydantic models keep `teamId`, `channelType`, `fromAgentId`, `expiresAt`, `messageIds`, etc. verbatim so the JSON matches the TS exactly (`ConfigDict(populate_by_name=True)` allows both). So the *fields* did **not** rename; only the *callable symbols* did.
- **Functions and methods are snake_case** — every method/function camelCase→snake_case: `sendDirect`→`send_direct`, `getAgentContext`→`get_agent_context`, `markContextRead`→`mark_context_read`, `directChannelId`→`direct_channel_id`, `isValidTransition`→`is_valid_transition`, `createAgentCard`→`create_agent_card`, `discoverTeamMessageDirs`→`discover_team_message_dirs`, etc.
- **Transport is a `typing.Protocol`** (structural, `@runtime_checkable`) rather than a TS `interface`; both `MemoryTransport` and `JsonFileTransport` satisfy it by duck-typing (no explicit `implements`).
- **`A2AXOptions`/`AgentContext` are dataclasses**, not TS object literals; `A2AX` takes a single `A2AXOptions` (no keyword spread). Errors raise `ValueError` where the TS threw `Error`.
- The TS `src/types/auth.ts` symbols (`Scope`, `DEFAULT_SCOPES`, `AgentToken`, `hasScope`, `generateToken`) are ported into **`token.py`**, not a separate `auth.py`.

### `backend-py/simple_harmonic/a2ax/message.py`

Message envelope + channel-family/kind literal aliases. TS source: `src/types/message.ts`. Literal unions become `typing.Literal` aliases.

- `ChannelType` — `backend-py/simple_harmonic/a2ax/message.py:13` — `Literal["direct","broadcast","group","task"]` (= TS `ChannelType`).
- `MessageStatus` — `backend-py/simple_harmonic/a2ax/message.py:14` — `Literal["pending","delivered","read","expired"]` (only `pending`/`expired` ever written).
- `MessageRole` — `backend-py/simple_harmonic/a2ax/message.py:15` — `Literal["agent","meta","system","user"]`.
- `GeneralKind` — `backend-py/simple_harmonic/a2ax/message.py:16` — `Literal["text","data","artifact","ack","error"]`.
- `TaskKind` — `backend-py/simple_harmonic/a2ax/message.py:17` — the seven `task.*` lifecycle kinds.
- `SystemKind` — `backend-py/simple_harmonic/a2ax/message.py:26` — `Literal["system.join","system.leave","system.created"]`.
- `MessageKind` — `backend-py/simple_harmonic/a2ax/message.py:29` — aliased to plain `str` (NOT the TS union of literals), so arbitrary `kind` strings round-trip without over-constraining.
- `Part(BaseModel)` — `backend-py/simple_harmonic/a2ax/message.py:32` — A2A content unit (`text`/`raw`/`url`/`data`/`mediaType`/`filename`/`metadata`).
- `Artifact(BaseModel)` — `backend-py/simple_harmonic/a2ax/message.py:46` — named collection of output `Part`s.
- `Message(BaseModel)` — `backend-py/simple_harmonic/a2ax/message.py:58` — the core envelope; `role` defaults `"agent"`, `kind` defaults `"text"`, `status` defaults `"pending"` on the model.
- `CreateMessageInput(BaseModel)` — `backend-py/simple_harmonic/a2ax/message.py:81` — insert input (= TS `CreateMessageInput`); `role` optional (transports default it to `"agent"`).

### `backend-py/simple_harmonic/a2ax/channel.py`

Channel models + the four deterministic channel-ID constructors. TS source: `src/types/channel.ts`. Helpers renamed camelCase→snake_case.

- `Channel(BaseModel)` — `backend-py/simple_harmonic/a2ax/channel.py:15` — channel row; `createdAt` stamped server-side by the transport.
- `ChannelMember(BaseModel)` — `backend-py/simple_harmonic/a2ax/channel.py:28` — group membership row (`channelId`, `agentId`, `joinedAt`).
- `direct_channel_id(agent_a, agent_b) -> str` — `backend-py/simple_harmonic/a2ax/channel.py:38` — `directChannelId`; returns `direct:<lo>:<hi>` with the two ids sorted. Called by `A2AX.send_direct` and both transports' relevance check (`_is_relevant`).
- `broadcast_channel_id(team_id) -> str` — `backend-py/simple_harmonic/a2ax/channel.py:44` — `broadcastChannelId`; returns `team:<teamId>`.
- `group_channel_id(group_id) -> str` — `backend-py/simple_harmonic/a2ax/channel.py:48` — `groupChannelId`; returns `group:<groupId>`.
- `task_channel_id(task_id) -> str` — `backend-py/simple_harmonic/a2ax/channel.py:52` — `taskChannelId`; returns `task:<taskId>`.

### `backend-py/simple_harmonic/a2ax/task.py`

Task lifecycle types + the transition table and its validator. TS source: `src/types/task.ts`.

- `TaskState` — `backend-py/simple_harmonic/a2ax/task.py:13` — `Literal[...]` of the eight states.
- `Task(BaseModel)` — `backend-py/simple_harmonic/a2ax/task.py:25` — task row; `state` defaults `"submitted"`; `channelId` is always `task:<id>`.
- `CreateTaskInput(BaseModel)` — `backend-py/simple_harmonic/a2ax/task.py:43` — input for `create_task` (transport generates id/channelId/state/timestamps).
- `UpdateTaskInput(BaseModel)` — `backend-py/simple_harmonic/a2ax/task.py:54` — partial update (`state?`, `metadata?`).
- `TASK_TRANSITIONS: dict[TaskState, list[TaskState]]` — `backend-py/simple_harmonic/a2ax/task.py:62` — the legal state machine (terminal states map to `[]`); same table as TS `TASK_TRANSITIONS`.
- `is_valid_transition(from_state, to_state) -> bool` — `backend-py/simple_harmonic/a2ax/task.py:74` — `isValidTransition`; pure `TASK_TRANSITIONS[from]` membership lookup. Called by `A2AX.update_task_state` (not `complete_task`).

### `backend-py/simple_harmonic/a2ax/token.py`

Bearer-token auth: token model, scope alias, default scopes, and two helpers. TS source: `src/types/auth.ts` (folded into this module — there is no `auth.py`).

- `Scope` — `backend-py/simple_harmonic/a2ax/token.py:14` — `Literal[...]` of all thirteen scope strings (the eight defaults plus `task:cancel`/`group:leave`/`group:create`/`card:write`/`admin`).
- `DEFAULT_SCOPES: tuple[Scope, ...]` — `backend-py/simple_harmonic/a2ax/token.py:31` — the eight team-internal default scopes (a `tuple`, vs the TS `as const` array). Actually referenced here by both `AgentToken`'s default and `A2AX.issue_token`, unlike the TS where the constant was dead.
- `AgentToken(BaseModel)` — `backend-py/simple_harmonic/a2ax/token.py:43` — bearer token row; `scopes` defaults to `list(DEFAULT_SCOPES)`.
- `has_scope(token, scope) -> bool` — `backend-py/simple_harmonic/a2ax/token.py:56` — `hasScope`; true if `scope in token.scopes` OR `"admin" in token.scopes`. No expiry check (caller's job). Called by `A2AX.authorize`.
- `generate_token() -> str` — `backend-py/simple_harmonic/a2ax/token.py:61` — `generateToken`; 32 random bytes as 64-hex via `secrets.token_hex(32)` (Python's CSPRNG replaces `crypto.getRandomValues`). Called by `A2AX.issue_token`.

### `backend-py/simple_harmonic/a2ax/types.py`

A2A-spec agent-card models + the one factory. TS source: `src/types/agent-card.ts`. (NB the module is named `types.py`, not `agent_card.py`.)

- `AgentCapabilities(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:13` — feature flags (`streaming`/`pushNotifications`/`extendedAgentCard` + a2ax `broadcast`/`groups`/`tasks`).
- `AgentSkill(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:24` — declared skill.
- `AgentProvider(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:35` — operator info.
- `OAuthFlow(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:43` — single OAuth flow (`tokenUrl` required, `scopes` dict).
- `OAuthFlows(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:52` — `authorizationCode`/`clientCredentials`/`deviceCode`.
- `SecurityScheme(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:60` — OpenAPI security scheme; the TS `in` field becomes `in_` aliased to `"in"` (reserved-word workaround) via `Field(alias="in")`.
- `AgentCardSignature(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:74` — card signature data carrier (no signing code).
- `AgentCard(BaseModel)` — `backend-py/simple_harmonic/a2ax/types.py:82` — the full card; **`teamId` is NOT a field** — the owning team rides on `metadata["teamId"]` (the de-facto team key for `list_cards`).
- `create_agent_card(*, id, name, endpoint, ...) -> AgentCard` — `backend-py/simple_harmonic/a2ax/types.py:100` — `createAgentCard`; keyword-only factory defaulting `capabilities` to `{streaming:False, pushNotifications:False, extendedAgentCard:False, broadcast:True, groups:True, tasks:True}` and `skills` to `[]`.

### `backend-py/simple_harmonic/a2ax/transport.py`

The `Transport` contract, `MessageQuery`, the in-memory reference implementation, and the **shared** query/relevance helpers. TS sources: `src/core/transport.ts` (interface + `MessageQuery`) and `src/transport/memory.ts` (`MemoryTransport`) — collapsed into one Python module. All 22 methods are `async` to match the TS `Promise`-returning interface.

- `MessageQuery(BaseModel)` — `backend-py/simple_harmonic/a2ax/transport.py:31` — query filter for `query_messages` (`teamId`, `agentId`, `unreadOnly?`, `limit?`, `channelType?`).
- `Transport(Protocol)` — `backend-py/simple_harmonic/a2ax/transport.py:44` — `@runtime_checkable` structural protocol; the 22-method storage contract (5 messages + 7 channels + 4 tasks + 3 cards + 3 auth). Method names are the snake_case forms of the TS interface (`insert_message`, `query_messages`, `list_team_messages`, `mark_read`, `mark_expired`, `get_channel`, `create_channel`, `list_channels`, `add_member`, `remove_member`, `get_members`, `get_memberships`, `create_task`, `get_task`, `update_task`, `list_tasks`, `get_card`, `upsert_card`, `list_cards`, `create_token`, `get_token`, `revoke_token`). Note: `create_channel(channel: Channel)` takes a full `Channel` (TS took `Omit<Channel,"createdAt">`); the transport overrides `createdAt`.
- `_now() -> datetime` (private) — `backend-py/simple_harmonic/a2ax/transport.py:83` — timezone-aware `datetime.now(UTC)`.
- `_read_key(message_id, agent_id) -> str` (private) — `backend-py/simple_harmonic/a2ax/transport.py:87` — per-recipient read key `f"{message_id}:{agent_id}"` (= the TS `` `${messageId}:${agentId}` `` template). Imported by `json_file_transport.py`.
- `_card_team_id(card) -> object | None` (private) — `backend-py/simple_harmonic/a2ax/transport.py:92` — pulls `metadata["teamId"]` off a card (the team key). Imported by `json_file_transport.py`.
- `MemoryTransport` — `backend-py/simple_harmonic/a2ax/transport.py:99` — in-memory `Transport` (the canonical reference for query/relevance), constructed with no args; holds `_messages`/`_reads`(set)/`_channels`/`_members`/`_tasks`/`_cards`/`_tokens`. Mirrors `transport/memory.ts`. Its `query_messages` (`:141`) delegates to the shared `_query_messages`; `create_task` (`:210`) writes `channelId = f"task:{task_id}"` directly (no throwaway-UUID dead work that the TS `MemoryTransport.createTask` had).
- `_query_messages(messages, reads, members, tasks, query) -> list[Message]` (module fn) — `backend-py/simple_harmonic/a2ax/transport.py:279` — the shared relevance/sort pipeline used by **both** transports (team filter → unread filter → channelType filter → relevance → sort ascending by `createdAt` → limit). The Python port factors this out as a free function (the two TS classes duplicated the logic inline).
- `_is_relevant(m, agent_id, members, tasks) -> bool` (module fn) — `backend-py/simple_harmonic/a2ax/transport.py:316` — per-message relevance: excludes the agent's own messages, recomputes `direct_channel_id` for direct, broadcast always relevant, group gated on membership, task gated on requestor/assignee.

### `backend-py/simple_harmonic/a2ax/file_store.py`

Self-contained synchronous fs primitives for the JSON-file transport (the a2ax package must not import the backend store). TS source: `src/storage/file-store.ts`. Plain blocking helpers; `JsonFileTransport` runs them off the event loop via `anyio.to_thread.run_sync`.

- `read_json[T](path, fallback) -> T` — `backend-py/simple_harmonic/a2ax/file_store.py:25` — `readJson`; parse a JSON file, returning `fallback` on `FileNotFoundError` or an empty/whitespace file.
- `write_json(path, value) -> None` — `backend-py/simple_harmonic/a2ax/file_store.py:36` — `writeJson`; atomic pretty-printed write via temp `.tmp` + `replace`.
- `read_jsonl[T](path) -> list[T]` — `backend-py/simple_harmonic/a2ax/file_store.py:44` — `readJsonl`; parse each non-blank line; `[]` on missing file.
- `append_jsonl(path, row) -> None` — `backend-py/simple_harmonic/a2ax/file_store.py:58` — `appendJsonl`; append one `json.dumps(row)` line (durability primitive for `log.jsonl`/`reads.jsonl`).
- `rewrite_jsonl(path, rows) -> None` — `backend-py/simple_harmonic/a2ax/file_store.py:64` — `rewriteJsonl`; atomic full-file rewrite of a JSONL log (used only by `mark_expired`).
- `discover_team_message_dirs(teams_root) -> dict[str, Path]` — `backend-py/simple_harmonic/a2ax/file_store.py:80` — `discoverTeamMessageDirs`; recursively walks the team tree (a folder is a team iff it has `team.json`; sub-teams under its `teams/` subfolder) and returns `teamId -> <teamDir>/messages`. Called by `JsonFileTransport._hydrate` and `._dir_for_team`. Uses a private `_list_subdirs` (`:73`).

### `backend-py/simple_harmonic/a2ax/json_file_transport.py`

The production `Transport` adapter — persists each team's communication state as JSON/JSONL files under its folder in the recursive data tree. TS source: `src/adapters/json-file.ts`. Relevance/query logic is **identical** to `MemoryTransport` (it calls the shared `_query_messages`). Each public async method dispatches its blocking `*_sync` body through `anyio.to_thread.run_sync`; every `*_sync` calls `_hydrate()` first.

- `JsonFileTransport` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:55` — constructed with one arg, `teams_root: str | Path` (absolute path to `<dataDir>/teams`); holds the same in-memory collections as `MemoryTransport` plus `_team_dirs` (teamId→messages dir), a `_loaded` set, and a `_hydrated` flag. Satisfies the `Transport` protocol structurally.
- `_hydrate()` (private) — `backend-py/simple_harmonic/a2ax/json_file_transport.py:79` — runs once (guarded by `_hydrated`): `discover_team_message_dirs` fills `_team_dirs`, then `_load_dir` reads each team's `messages/` files. (= TS `hydrate`.)
- `_load_dir(directory)` (private) — `backend-py/simple_harmonic/a2ax/json_file_transport.py:87` — idempotent per dir; `Message`/`Channel`/`Task`/`AgentCard`/`AgentToken`.`model_validate` revives ISO timestamps to `datetime` as it loads (Pydantic replaces the TS hand-rolled date revival). (= TS `loadDir`.)
- `_dir_for_team(team_id) -> Path` (private) — `backend-py/simple_harmonic/a2ax/json_file_transport.py:110` — resolves a team's `messages/` dir, re-walking the tree once if the team appeared after first hydration; raises `ValueError("a2ax: team <id> folder not found under <root>")` if still missing. (= TS `dirForTeam`.)
- `_persist_channels` / `_persist_members` / `_persist_tasks` / `_persist_cards` / `_persist_tokens` (private) — `backend-py/simple_harmonic/a2ax/json_file_transport.py:126,132,143,149,155` — each filters the in-memory collection to one team and `write_json`s the whole list back to that team's `channels.json`/`members.json`/`tasks.json`/`cards.json`/`tokens.json`. (= TS `persist*`.)
- `insert_message` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:163` (sync body `_insert_message_sync` `:166`) — builds the `Message`, appends in-memory, and `append_jsonl`s it to the team's `log.jsonl`.
- `query_messages` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:190` (sync `:193`) — delegates to the shared `_query_messages` (same relevance/sort as `MemoryTransport`; no default limit cap).
- `list_team_messages` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:199` (sync `:206`) — unfiltered chronological team feed, sliced to `limit`; backs `A2AX.list_messages`.
- `mark_read` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:216` (sync `:219`) — idempotent; for each new id, adds the read key and `append_jsonl`s a `{messageId, agentId, readAt}` row to the message's team's `reads.jsonl`.
- `mark_expired` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:237` (sync `:240`) — flips expired messages in memory, then `rewrite_jsonl`s each affected team's whole `log.jsonl`; returns the count.
- `create_channel` / `add_member` / `remove_member` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:265,282,306` — mutate memory then `_persist_channels`/`_persist_members`; `add_member` de-dups (returns the existing membership), matching `MemoryTransport`.
- `create_task` / `update_task` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:336,367` — `create_task` writes `channelId = f"task:{task_id}"` directly then `_persist_tasks`; `update_task` merges `metadata`, bumps `updatedAt`, raises `ValueError("Task <id> not found")` if missing, then `_persist_tasks`.
- `upsert_card` / `create_token` / `revoke_token` — `backend-py/simple_harmonic/a2ax/json_file_transport.py:406,426,442` — mutate memory then `_persist_cards`/`_persist_tokens` (cards only persist when `metadata["teamId"]` is a `str`).

### `backend-py/simple_harmonic/a2ax/protocol.py`

The `A2AX` protocol facade + its option/return dataclasses. TS source: `src/core/protocol.ts`. The class composes `Transport` calls into the high-level operations; all method names are snake_case. The four `task.*` lifecycle messages, the deterministic channel ids, and the FIFO-backlog context selection are identical to the TS.

- `A2AXOptions` (dataclass) — `backend-py/simple_harmonic/a2ax/protocol.py:57` — `transport` (required), `max_context_messages=20`, `default_expiry_ms` (7 days). TS field `maxContextMessages`→`max_context_messages`, `defaultExpiryMs`→`default_expiry_ms`.
- `AgentContext` (dataclass) — `backend-py/simple_harmonic/a2ax/protocol.py:66` — return shape of `get_agent_context`: `messages`, `formatted`, `messageIds` (the last kept camelCase to match the wire/TS shape).
- `A2AX` — `backend-py/simple_harmonic/a2ax/protocol.py:79` — the protocol facade and primary public API; `__init__(self, opts: A2AXOptions)` (`:85`) takes a single options object. Stateless beyond config (transport + two settings), so one instance is shareable process-wide.
- `send_direct(team_id, from_agent_id, to_agent_id, content, *, kind="text", parts=None, payload=None, urgent=None)` — `backend-py/simple_harmonic/a2ax/protocol.py:95` — `sendDirect`; computes `direct_channel_id`, lazily ensures the channel, inserts with `expiresAt = now + default_expiry_ms`. The `opts` object becomes keyword-only params.
- `broadcast(team_id, from_agent_id, content, *, kind="text", parts=None, payload=None)` — `backend-py/simple_harmonic/a2ax/protocol.py:126` — `broadcast`; one row to `team:<teamId>` (lazily created `"team-broadcast"`); no `urgent` option.
- `create_group(team_id, name, member_ids) -> dict[str, str]` — `backend-py/simple_harmonic/a2ax/protocol.py:154` — `createGroup`; creates `group:<uuid>`, adds members, posts a `role="system"` / `kind="system.created"` announcement from `member_ids[0]`. Returns `{"channelId": ...}`.
- `send_to_group(team_id, channel_id, from_agent_id, content, *, ...)` — `backend-py/simple_harmonic/a2ax/protocol.py:187` — `sendToGroup`; inserts a group message; no membership/existence check.
- `join_group(channel_id, agent_id)` — `backend-py/simple_harmonic/a2ax/protocol.py:212` — `joinGroup`; raises `ValueError("Channel <id> is not a group")` if missing or not a group, then adds the member.
- `leave_group(channel_id, agent_id)` — `backend-py/simple_harmonic/a2ax/protocol.py:218` — `leaveGroup`; thin passthrough to `remove_member` (no checks, asymmetric with `join_group`).
- `create_task(input: CreateTaskInput) -> dict[str, object]` — `backend-py/simple_harmonic/a2ax/protocol.py:223` — `createTask`; three writes (task row, `task:<id>` channel, initial `kind="task.create"` message with `{title, assigneeId}` payload, `urgent=True`, no expiry). Returns `{"task": ..., "channelId": ...}`. Not transactional.
- `update_task_state(task_id, agent_id, new_state, content=None) -> Task` — `backend-py/simple_harmonic/a2ax/protocol.py:252` — `updateTaskState`; loads the task (raises `ValueError("Task <id> not found")`), validates via `is_valid_transition` (raises `ValueError("Invalid transition: <from> -> <to>")`), persists, posts a `kind="task.status"` message.
- `complete_task(task_id, agent_id, content, *, parts=None, payload=None) -> Task` — `backend-py/simple_harmonic/a2ax/protocol.py:285` — `completeTask`; force-sets `state="completed"` **without** `is_valid_transition` (legal from any state), posts a `kind="task.result"` message.
- `get_agent_context(team_id, agent_id) -> AgentContext` — `backend-py/simple_harmonic/a2ax/protocol.py:323` — `getAgentContext`; four per-channel-type `query_messages` calls (each `unreadOnly=True`, capped at `max_context_messages`), merges, sorts ascending by `createdAt`, takes the first `max_context_messages` (oldest-wins FIFO backlog draining). Helper `_ctx_query` at `:350`.
- `mark_context_read(agent_id, message_ids)` — `backend-py/simple_harmonic/a2ax/protocol.py:361` — `markContextRead`; passes ids to `mark_read`, skipping the call for an empty list.
- `list_messages(team_id, limit=None) -> list[Message]` — `backend-py/simple_harmonic/a2ax/protocol.py:367` — `listMessages`; passthrough to `Transport.list_team_messages` (unfiltered dashboard feed).
- `list_tasks(team_id, agent_id=None) -> list[Task]` — `backend-py/simple_harmonic/a2ax/protocol.py:370` — `listTasks`; passthrough to `Transport.list_tasks`, optionally narrowed to a participant.
- `register_card(card) -> AgentCard` — `backend-py/simple_harmonic/a2ax/protocol.py:375` — `registerCard`; passthrough to `upsert_card`.
- `get_card(agent_id) -> AgentCard | None` — `backend-py/simple_harmonic/a2ax/protocol.py:378` — `getCard`; passthrough to `Transport.get_card`.
- `discover_agents(team_id) -> list[AgentCard]` — `backend-py/simple_harmonic/a2ax/protocol.py:381` — `discoverAgents`; passthrough to `list_cards` (strict `metadata["teamId"]` match).
- `issue_token(agent_id, team_id, scopes=None) -> str` — `backend-py/simple_harmonic/a2ax/protocol.py:386` — `issueToken`; `generate_token` + `create_token` with the given scopes or `list(DEFAULT_SCOPES)`, `createdAt` now, no expiry; returns the raw token. (Python references `DEFAULT_SCOPES`; the TS inlined the eight scopes.)
- `authenticate(token) -> dict[str, str] | None` — `backend-py/simple_harmonic/a2ax/protocol.py:401` — `authenticate`; returns `None` when unknown or expired, else `{"agentId", "teamId"}`.
- `authorize(token, scope) -> bool` — `backend-py/simple_harmonic/a2ax/protocol.py:409` — `authorize`; same lookup/expiry check then `has_scope` (admin wildcard); returns `False` on any failure.
- `expire_messages() -> int` — `backend-py/simple_harmonic/a2ax/protocol.py:419` — `expireMessages`; passes `now` to `mark_expired`, returns the count.
- `_ensure_channel(channel_id, team_id, channel_type, name=None)` (private) — `backend-py/simple_harmonic/a2ax/protocol.py:424` — `ensureChannel`; get-then-create-if-missing for lazily materialized direct/broadcast channels. Called by `send_direct` and `broadcast`.
- `_format_context(messages) -> str` (private) — `backend-py/simple_harmonic/a2ax/protocol.py:443` — `formatContext`; renders the `--- Messages since last tick ---` / `---` prompt block (empty string for no messages).
- `_format_prefix(m) -> str` (private) — `backend-py/simple_harmonic/a2ax/protocol.py:450` — `formatPrefix`; per-channel-type source label (`[direct from <agent>]:`, `[broadcast from <agent>]:`, `[<channelId> from <agent>]:` for groups, `[<channelId> from <agent>] (<kind>):` for tasks).

### `backend-py/simple_harmonic/a2ax/__init__.py`

Package barrel. TS source: `src/index.ts` (plus the `/transport/memory`, `/adapters/json-file`, and `/types` subpath exports — the Python port collapses them into one flat namespace). Re-exports the full public surface and declares `__all__` (`backend-py/simple_harmonic/a2ax/__init__.py:71`). Unlike the TS `index.ts`, **both** `MemoryTransport` and `JsonFileTransport` are exported from this top-level package (the TS reached them only via package.json subpaths).
