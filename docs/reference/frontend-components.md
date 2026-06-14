# Reference — frontend components (`packages/frontend/src/`)

This is the symbol-level reference for the `@simple-harmonic/frontend` workspace package: every exported and significant internal component, hook, plain function, type, and constant. The package holds all reusable React UI — chat (the `/new` Harmon onboarding flow), team views (`/f/[id]`), the play-by-play trace UI, the sidebar, theming, and narration helpers — and is consumed by the Next.js App Router pages in `src/app/` via the `@simple-harmonic/frontend/*` path alias (root `tsconfig.json`). All data flows through client `fetch` calls against `/api/*` routes; there is no server-side data fetching in any of these components. For chapter-level context see `docs/07-frontend.md`.

```
src/app/layout.tsx (server)
├── <script dangerouslySetInnerHTML={THEME_INIT_SCRIPT}>      theme-provider.tsx
└── ThemeProvider ──────────────────────────────────────────── theme-provider.tsx
    ├── MobileNotice ──────────────────────────────────────── mobile-notice.tsx
    └── src/app/(app)/layout.tsx (server)
        ├── Sidebar → SidebarInner → TeamTreeNode* → SidebarLink   sidebar.tsx
        └── pages
            ├── /new  NewTeamPage ── useChat ───────────────── chat/use-chat.ts
            │   ├── AssistantMessage │ UserMessage │
            │   │   ErrorMessage │ ThinkingIndicator ───────── chat/message.tsx
            │   ├── ApprovalCard ───────────────────────────── chat/approval-card.tsx
            │   ├── CredentialRequestCard ──────────────────── chat/credential-request-card.tsx
            │   └── ChatInputBar ───────────────────────────── chat/input-bar.tsx
            └── /f/[id]  TeamView ── useTeam ───────────────── team/use-team.ts
                ├── ?agent=team  → ApprovalQueue ───────────── team/approval-queue.tsx
                │                + TeamDashboard ───────────── team/team-dashboard.tsx
                │                  └── feedMode "steps" → TraceView
                ├── ?agent=meta|user → AgentMessagesView ───── team/agent-messages-view.tsx
                └── ?agent=<uuid> → AgentPovView ───────────── team/agent-pov-view.tsx
                    ├── DashboardTab │ HistoryTab │ ConfigTab
                    ├── trace tab → TraceView ──────────────── team/trace-view.tsx
                    │       └── buildTickThreads ───────────── lib/trace.ts
                    └── messages tab → AgentMessagesView (initialPovId = agent.id)

(unreferenced: ui/button.tsx, lib/utils.ts cn outside button.tsx,
 MessagesTab inside agent-pov-view.tsx)
```

---

## `packages/frontend/src/components/chat/message.tsx`

Client module (`"use client"`). Pure presentational renderers for the `/new` chat transcript. No fetches, no effects, no imports from `@simple-harmonic/backend`.

### `ChatMessageData` — `packages/frontend/src/components/chat/message.tsx:18`

The message shape shared by `useChat` and all message renderers.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Unique id (`"initial"` for the seeded greeting, otherwise `crypto.randomUUID()`) |
| `role` | `"user" \| "assistant" \| "error"` | Selects the renderer in `NewTeamPage` |
| `content` | `string` | Message body; empty string marks a still-streaming assistant placeholder |
| `isPushback?` | `boolean` | Adds a "· pushback" marker in `AssistantMessage`; never set by current code paths (`useChat` does not produce it) |
| `timestamp?` | `string` | ISO time, rendered HH:MM:SS via `formatTime` |

### `FormattedText({ text })` — `packages/frontend/src/components/chat/message.tsx:3`

Internal. The only "markdown" rendering in the chat: splits `text` on the regex `/(\*\*[^*]+\*\*)/g` and renders `**bold**` segments as `<strong>`, everything else as `<span>`. Keys are `part.slice(0, 20)`, so two segments sharing a 20-char prefix collide (cosmetic React-key risk only).

- **Called by:** `AssistantMessage` only.

### `formatTime(date?)` — `packages/frontend/src/components/chat/message.tsx:26`

Internal. Returns `""` for falsy input, otherwise `toLocaleTimeString("en-US", { hour12: false, hour/minute/second: "2-digit" })` — a 24-hour `HH:MM:SS` string.

- **Called by:** `AssistantMessage`, `ErrorMessage` (`UserMessage` renders no timestamp).

### `MetaAgentBadge()` / `ErrorBadge()` — `packages/frontend/src/components/chat/message.tsx:36,44`

Internal 22×22px square badges: orange (`bg-brand-soft`/`border-brand`) "M" for the meta-agent, red-tinted "!" for errors. There is no user badge — `UserMessage` is a bare right-aligned bubble.

- **Called by:** `AssistantMessage`+`ThinkingIndicator` (MetaAgentBadge), `ErrorMessage` (ErrorBadge).

### `<AssistantMessage message={…} isStreaming={…} />` — `packages/frontend/src/components/chat/message.tsx:52`

Renders one Harmon turn: header row (`MetaAgentBadge`, literal label "meta-agent" in brand color, optional timestamp, optional "· pushback"), then the body through `FormattedText` inside a `max-w-[64ch] whitespace-pre-wrap` block. While `isStreaming` is true a pulsing 2×4 brand-colored block cursor is appended.

| Prop | Type | Meaning |
|---|---|---|
| `message` | `ChatMessageData` | The assistant message |
| `isStreaming?` | `boolean` | Shows the pulsing cursor after the text |

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:106`.
- **Renders:** `MetaAgentBadge`, `FormattedText`.

### `<UserMessage message={…} />` — `packages/frontend/src/components/chat/message.tsx:81`

One user turn: a right-aligned (`flex justify-end`) bubble — `max-w-[60ch] bg-bg-input border border-border rounded-lg` — containing the plain (un-formatted) body text. No badge, no name label, no timestamp.

| Prop | Type | Meaning |
|---|---|---|
| `message` | `ChatMessageData` | The user message |

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:109`.

### `<ErrorMessage message={…} onRetry={…} />` — `packages/frontend/src/components/chat/message.tsx:91`

Connection-error turn: `ErrorBadge`, label "connection error", muted body, and — when `onRetry` is provided — a brand-colored "Retry" button that fires the callback.

| Prop | Type | Meaning |
|---|---|---|
| `message` | `ChatMessageData` | The error message (content = error text) |
| `onRetry?` | `() => void` | Retry button callback; page wires it to `useChat().retry` |

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:112`.

### `<ThinkingIndicator />` — `packages/frontend/src/components/chat/message.tsx:127`

No props. `MetaAgentBadge` + "meta-agent" label + three pulsing dots (staggered `animation-delay` 0/150/300ms). The page shows it while the streaming assistant placeholder is still empty (which the message loop skips rendering).

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:118`.

---

## `packages/frontend/src/components/chat/use-chat.ts`

Client module. The chat state machine for `/new`.

**Backend imports:** `SpawnTeamAgent` type from `@simple-harmonic/backend/lib/meta-agent` (`use-chat.ts:4`) — `{ name, role, archetype, tools, schedule_seconds, initial_prompt }` defined at `packages/backend/src/lib/meta-agent/planner.ts:192`.

### `ChatStatus` — `packages/frontend/src/components/chat/use-chat.ts:7`

Internal union: `"idle" | "streaming" | "error"`.

### `SpawnProposal` — `packages/frontend/src/components/chat/use-chat.ts:9`

| Field | Type | Meaning |
|---|---|---|
| `teamName` | `string` | Proposed team name (`"New Team"` fallback when the SSE event omits it) |
| `cofounderName` | `string \| null` | Proposed cofounder display name; `null` → placeholder shows `DEFAULT_COFOUNDER_NAME` |
| `agents` | `SpawnTeamAgent[]` | Proposed agent roster |

### `CredentialRequestData` — `packages/frontend/src/components/chat/use-chat.ts:15`

| Field | Type | Meaning |
|---|---|---|
| `key` | `string` | Credential key (e.g. env-var-like identifier) POSTed to `/api/settings/credentials` |
| `label` | `string` | Human label shown on the card |
| `reason` | `string` | Why Harmon needs it |
| `helpUrl` | `string \| null` | Optional "Where to get this" link |

### `INITIAL_MESSAGE` — `packages/frontend/src/components/chat/use-chat.ts:33`

Constant `ChatMessageData` with `id: "initial"`, role `assistant`, and a hard-coded greeting from "**Harmon**" asking three things (what you do, who pays you, what's eating your week) and offering to be renamed. Its `timestamp` is evaluated at module load (`new Date().toISOString()`).

### `useChat()` — `packages/frontend/src/components/chat/use-chat.ts:41`

The full chat state machine.

**State:**

| Field | Kind | Initial | Meaning |
|---|---|---|---|
| `messages` | `useState<ChatMessageData[]>` | `[INITIAL_MESSAGE]` | Full transcript including error entries |
| `status` | `useState<ChatStatus>` | `"idle"` | Gate for sends; drives "thinking..." UI |
| `spawnProposal` | `useState<SpawnProposal \| null>` | `null` | Side channel set by the `spawn` SSE event |
| `credentialRequest` | `useState<CredentialRequestData \| null>` | `null` | Side channel set by `request_credential` |
| `streamingIdRef` | `useRef<string \| null>` | `null` | Id of the in-flight assistant placeholder (written, never read back) |

**Effects:** none — all work happens inside callbacks; there are no intervals or listeners in this hook.

**`sendMessage(text)`** (`use-chat.ts:48`):
1. No-op while `status === "streaming"`.
2. Appends the user message, sets `status = "streaming"`, clears `spawnProposal` (but **not** `credentialRequest`), and appends an empty assistant placeholder whose id is stored in `streamingIdRef`.
3. POSTs `{ messages }` to **`POST /api/chat`** — the history is all prior user/assistant messages (error entries filtered out) mapped to `{role, content}`.
4. Reads the response body as a stream (SSE-over-fetch): buffers, splits on `\n\n`, parses `data: ` lines as JSON. Event handling:
   - `token` — appends `data.text` to the placeholder's content.
   - `spawn` — replaces placeholder content with `data.content` (if non-empty), sets `spawnProposal` (`teamName` default `"New Team"`, `cofounderName` default `null`), `status = "idle"`. The event's `parentTeam` field (`packages/backend/src/server/api/chat.ts:71`) is **dropped** — `SpawnProposal` has no parent field, so sub-team proposals lose their parent linkage before `/api/spawn` is ever called.
   - `request_credential` — same content replacement, sets `credentialRequest` (`helpUrl` default `null`), `status = "idle"`.
   - `done` — `status = "idle"`. The event's `content` field is ignored; when no tokens streamed, the planner's fallback text `"I need a moment. Try again."` (`planner.ts:466`) is therefore never displayed and the empty placeholder renders as an empty `AssistantMessage` once idle.
   - `error` — removes the placeholder, appends a new `role: "error"` message with `data.message`, `status = "error"`.
   - `modify_agent` — **not handled.** The route emits this sixth event type after applying the planner's agent edit server-side (`packages/backend/src/server/api/chat.ts:77-90`); no branch matches, so the confirmation `content` and `applied: {ok, error?}` outcome are silently discarded. The store write still happens — the agent's `agent.json` is updated — the user just sees no acknowledgment (and an empty assistant bubble if no tokens streamed before the tool call).
5. After the stream ends, a functional `setStatus` flips `"streaming"` → `"idle"` (covers streams that close without a `done` event).
6. Network/HTTP failure (`catch`): removes the placeholder, appends an error message with the exception text (fallback `"Connection failed"`), `status = "error"`.

**`retry()`** (`use-chat.ts:167`): finds the last `user` message, strips all `error` messages from the transcript, then calls `sendMessage(lastUserMsg.content)` — note this appends the user message **again**, so the retried prompt appears twice in the transcript (and twice in the history POSTed to `/api/chat`).

**`clearSpawnProposal()` / `clearCredentialRequest()`** (`use-chat.ts:175,179`): null out the respective side-channel state.

**Return shape (`UseChatReturn`, `use-chat.ts:22`):**

| Field | Type |
|---|---|
| `messages` | `ChatMessageData[]` |
| `status` | `"idle" \| "streaming" \| "error"` |
| `spawnProposal` | `SpawnProposal \| null` |
| `credentialRequest` | `CredentialRequestData \| null` |
| `sendMessage` | `(text: string) => void` |
| `retry` | `() => void` |
| `clearSpawnProposal` | `() => void` |
| `clearCredentialRequest` | `() => void` |

- **Called by:** `src/app/(app)/new/page.tsx:44`.

---

## `packages/frontend/src/components/chat/input-bar.tsx`

### `<ChatInputBar onSend={…} disabled={…} placeholder={…} />` — `packages/frontend/src/components/chat/input-bar.tsx:11`

Uncontrolled chat composer: a 2-row `<textarea>` read through `textareaRef` (no React state for the text), a "shift+enter for new line" hint, and a Send button. `handleSend` trims the value, no-ops when empty or `disabled`, fires `onSend(text)`, and clears the textarea imperatively. `handleKeyDown` maps plain Enter (without Shift) to send with `preventDefault`. The wrapper drops to `opacity-70` and the textarea/button gain disabled styling while `disabled`.

| Prop | Type | Meaning |
|---|---|---|
| `onSend` | `(text: string) => void` | Fired with the trimmed text |
| `disabled?` | `boolean` (default `false`) | Blocks send + greys out; page passes `status === "streaming"` |
| `placeholder?` | `string` (default `"Tell your AI cofounder about your company..."`) | Page switches it to "Push back or tweak the proposal..." while a proposal shows |

**State/refs:** `textareaRef` (`useRef<HTMLTextAreaElement>`) only. No effects, no fetches.

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:145`.

---

## `packages/frontend/src/components/chat/approval-card.tsx`

**Backend imports:** `SpawnTeamAgent` type from `@simple-harmonic/backend/lib/meta-agent`; `DEFAULT_COFOUNDER_NAME` (`"Harmon"`) from `@simple-harmonic/backend/lib/meta-agent/identity` (`approval-card.tsx:4-5`).

### `formatSchedule(seconds)` — `packages/frontend/src/components/chat/approval-card.tsx:7`

Internal. `<60` → `every Ns`; `<3600` → `every Nm` (rounded); else `every Nh` (rounded). One of four near-duplicate schedule formatters in the workspace (see `team-dashboard.tsx:39` and `agent-pov-view.tsx:111,117`).

- **Called by:** the agent rows in `ApprovalCard`.

### `<ApprovalCard agents={…} teamName={…} cofounderName={…} onSpawn={…} onKeepDiscussing={…} isSpawning={…} />` — `packages/frontend/src/components/chat/approval-card.tsx:26`

The "proposed team" card shown under the chat when Harmon emits a `spawn` event. Copies its three data props into local state on mount (props are *initial* values only — a new proposal with the same mounted card would not reset fields, but in practice `NewTeamPage` unmounts it whenever `spawnProposal` is cleared).

| Prop | Type | Meaning |
|---|---|---|
| `agents` | `SpawnTeamAgent[]` | Initial roster (copied to state) |
| `teamName` | `string` | Initial team name (copied to state) |
| `cofounderName` | `string \| null` | Initial cofounder name; `null` becomes `""` so the input shows the `DEFAULT_COFOUNDER_NAME` placeholder |
| `onSpawn` | `(payload: { agents; teamName; cofounderName }) => void` | Fired with the **edited** values; empty team name → `"New Team"`, empty cofounder → `null` |
| `onKeepDiscussing` | `() => void` | Dismiss button callback |
| `isSpawning?` | `boolean` (default `false`) | Disables both buttons, button label → "Spawning...". In practice always `false`: `NewTeamPage` early-returns to `SpawningScreen` once `spawning` is set (`src/app/(app)/new/page.tsx:77,128`), so this prop is effectively dead |

**State:** `agents`, `teamName`, `cofounderName` (`useState`, seeded from props). `updateAgent(index, field, value)` patches one agent immutably. No effects, no fetches.

**Renders:** header with inline-editable team name input, "N agents · supervised by [editable cofounder input]", a "click any field to edit" hint; one grid row per agent (editable name input, editable role input, read-only `formatSchedule(schedule_seconds)` chip) — rows are keyed by `agent.name` even though the name is editable, so renaming an agent remounts its row; footer with the "Spawn N agents →" button, "keep discussing" link, and "~3 seconds to boot" note.

**Cross-layer note:** the `onSpawn` payload (and the page's resulting `POST /api/spawn` body) carries only `{agents, teamName, cofounderName}`. The route's optional `parentTeam`/`parentTeamId`/`goal`/`noHarmon` fields (`packages/backend/src/server/api/spawn.ts:47-51`) are never sent, so a planner sub-team proposal spawns as a **root** team — and, being root without `noHarmon`, receives an auto-spawned Harmon cofounder agent (`spawn.ts:107-117`).

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:122`.

---

## `packages/frontend/src/components/chat/credential-request-card.tsx`

### `<CredentialRequestCard credentialKey={…} label={…} reason={…} helpUrl={…} onSubmit={…} />` — `packages/frontend/src/components/chat/credential-request-card.tsx:13`

Inline secret-collection card shown when Harmon emits `request_credential`. A password input plus "Save credential" button; on success it flips to a green "configured" state and fires `onSubmit`.

| Prop | Type | Meaning |
|---|---|---|
| `credentialKey` | `string` | Key sent as `key` in the POST body |
| `label` | `string` | Heading + input placeholder ("Paste your {label} here") + configured-state text |
| `reason` | `string` | Explanatory paragraph |
| `helpUrl` | `string \| null` | Optional `target="_blank"` "Where to get this →" link |
| `onSubmit` | `(key: string, value: string) => void` | Fired after a successful POST |

**State:** `value` (input text), `submitting` (disables the button, label → "Saving..."), `submitted` (switches to the green state). No effects.

**Fetches:** `POST /api/settings/credentials` with `{ key: credentialKey, value: value.trim() }` on submit. Non-OK responses are silently swallowed (no error state — the card just stays in the form view).

**Renders:** form view (brand-bordered card, "Credential needed" eyebrow, label/reason/help link, password input with `autoComplete="off"`/`spellCheck=false`, lock-icon footnote stating the value is "encrypted and stored in Apollo, Simple Harmonic's secrets manager" and never readable by agents) or submitted view (green dot, "{label} configured"). Note: `NewTeamPage` passes `onSubmit={() => clearCredentialRequest()}` (`src/app/(app)/new/page.tsx:138`), which unmounts the card immediately on success — the green "configured" state is therefore never actually visible on `/new`.

- **Called by / rendered by:** `src/app/(app)/new/page.tsx:133`.

---

## `packages/frontend/src/components/team/use-team.ts`

Client module. The data hook behind `/f/[id]`. Imports `NarrationEntry`, `describeAction`, `extractDetail` from `../../lib/narration`. No backend imports.

### `TeamAgent` — `packages/frontend/src/components/team/use-team.ts:7`

Internal (not exported; `TeamView` re-declares compatible shapes inline).

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Agent UUID |
| `name` | `string` | Display name |
| `role` | `string` | One-line role description |
| `status` | `"running" \| "paused" \| "errored" \| "awaiting_approval"` | Lifecycle status |
| `inFlight` | `boolean` | Currently executing a tick ("thinking...") |
| `scheduleSeconds` | `number` | Tick cadence |
| `archetype` | `string` | One of the five built-in archetypes |
| `tools` | `string[]` | Tool names |
| `initialPrompt` | `string` | System prompt |
| `teamId` | `string` | Owning team (relevant for `childAgents`) |

### `TeamData` — `packages/frontend/src/components/team/use-team.ts:20`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Team UUID |
| `name` | `string` | Team name |
| `paused` | `boolean` | Pause flag (gates the poll loop) |
| `tickCount` | `number` | Total ticks (drives the synthetic token/cost estimates) |
| `metaAgentPrompt` | `string \| null` | Cofounder prompt (echoed back on rename PATCH) |
| `cofounderName` | `string \| null` | Per-team cofounder display-name override |

### `ChildTeam` — `packages/frontend/src/components/team/use-team.ts:29`

`{ id, name, parentTeamId: string | null, paused: boolean }` — sub-team summary row.

### `useTeam(teamId)` — `packages/frontend/src/components/team/use-team.ts:48`

Four concurrent data channels feeding the team page.

**State:**

| Field | Kind | Initial | Meaning |
|---|---|---|---|
| `team` | `useState<TeamData \| null>` | `null` | Team record |
| `agents` | `useState<TeamAgent[]>` | `[]` | Direct agents |
| `childTeams` | `useState<ChildTeam[]>` | `[]` | Sub-teams (initial load only — not refreshed by the poll) |
| `childAgents` | `useState<TeamAgent[]>` | `[]` | Sub-team agents (initial load only) |
| `narration` | `useState<NarrationEntry[]>` | `[]` | Activity feed, capped at 100 |
| `loading` | `useState<boolean>` | `true` | Cleared after the initial fetch (success or failure) |
| `agentsRef` | `useRef<TeamAgent[]>` | `[]` | Mirror of `agents` so the long-lived SSE parser can resolve agent names without re-subscribing |

**Effects:**

1. **Initial load** (`use-team.ts:57`, deps `[teamId]`) — `GET /api/team/{teamId}` once; populates `team`, `agents`, `childTeams`, `childAgents`, `agentsRef`, clears `loading`.
2. **10s poll** (`use-team.ts:72`, deps `[teamId, isPaused]`) — skipped entirely while `team?.paused ?? true`. Every 10 000ms re-fetches `GET /api/team/{teamId}` and updates `team`/`agents`/`agentsRef` (the code comment claims the poll doubles as the dev-mode tick driver; "In production, Vercel cron hits /api/tick independently" — stale: the GET handler never fires a tick; dev ticking comes from `src/instrumentation.ts`'s 10s self-POST loop). For every agent with `inFlight: true` it prepends a synthetic `NarrationEntry` (`actionType: "thinking"`, description `"processing..."`, id `${agentId}-${Date.now()}`). Cleanup: `clearInterval`.
3. **Heartbeat** (`use-team.ts:108`, deps `[teamId]`) — `POST /api/team/{teamId}/heartbeat` immediately and every 30 000ms, errors swallowed. Cleanup: `clearInterval`.
4. **Narration SSE** (`use-team.ts:117`, deps `[teamId, teamLoaded]`) — once `team` is non-null, opens a long-lived `GET /api/team/{teamId}/narration` fetch and parses the body as SSE (`\n\n` framing, `data: ` lines). Events: `history` replaces the whole feed; `update` prepends only entries whose ids are not already present, then caps at 100. Each raw entry `{id, agentId, actionType, payload, executedAt}` is mapped to a `NarrationEntry`: `agentName` resolved from `agentsRef` (fallback `"agent"`), `isMeta = actionType.startsWith("meta_")`, `description = describeAction(actionType, payload)`, `detail = extractDetail(payload)`. Malformed SSE lines are skipped. Cleanup: `reader?.cancel()`.

**Actions:**

- `togglePause()` (`use-team.ts:191`) — `POST /api/team/{teamId}/pause`, applies the returned `{paused}` to `team`, and prepends a client-side narration entry (`team_paused` → "team paused by user · holding state" / `team_resumed` → "team resumed by user", `agentName: "meta-agent"`, `isMeta: true`).
- `updateAgent(patch)` (`use-team.ts:183`) — optimistic merge into `agents` by id (does **not** update `agentsRef`).
- `updateTeam(patch)` (`use-team.ts:187`) — optimistic merge into `team`.

**Return shape (`UseTeamReturn`, `use-team.ts:36`):**

| Field | Type |
|---|---|
| `team` | `TeamData \| null` |
| `agents` | `TeamAgent[]` |
| `childTeams` | `ChildTeam[]` |
| `childAgents` | `TeamAgent[]` |
| `narration` | `NarrationEntry[]` |
| `loading` | `boolean` |
| `togglePause` | `() => Promise<void>` |
| `updateAgent` | `(updated: Partial<TeamAgent> & { id: string }) => void` |
| `updateTeam` | `(updated: Partial<TeamData>) => void` |

- **Called by:** `src/app/(app)/f/[id]/team-view.tsx:29`.

---

## `packages/frontend/src/components/team/team-dashboard.tsx`

Client module, 272 lines. All data arrives via props from `TeamView`/`useTeam`; the component itself fetches nothing directly — but PR #12 added a summary/play-by-play toggle on the activity feed (`useState` + a `TraceView` import, `team-dashboard.tsx:4,6`, one piece of local state `feedMode`), and in "steps" mode the feed is delegated to `<TraceView/>`, which runs its own SSE fetch. Also imports `NarrationEntry` from `../../lib/narration` and `next/link`.

### `Agent` / `ChildAgent` / `ChildTeam` (local types) — `packages/frontend/src/components/team/team-dashboard.tsx:8,17,21`

`Agent`: `{ id, name, role, status: "running"|"paused"|"errored"|"awaiting_approval", inFlight: boolean, scheduleSeconds: number }`. `ChildAgent extends Agent` adding `teamId: string`. `ChildTeam`: `{ id, name, parentTeamId: string | null, paused: boolean }`. These are structural duplicates of the `use-team.ts` shapes (minus `archetype`/`tools`/`initialPrompt`).

### `formatSchedule(s)` — `packages/frontend/src/components/team/team-dashboard.tsx:39`

Internal. Unlike the chat/POV variants this returns only the unit suffix (`"5s"`, `"3m"`, `"2h"`) without the "every " prefix — `AgentCard` adds `every ` itself.

### `formatTime(iso)` — `packages/frontend/src/components/team/team-dashboard.tsx:45`

Internal. `HH:MM:SS` for today's timestamps; prefixes `"MMM D, YYYY "`-style date for older ones.

### `fmt(n)` — `packages/frontend/src/components/team/team-dashboard.tsx:54`

Internal number compactor: `≥1M` → `X.XM`, `≥1k` → `X.Xk`, else as-is. Duplicated as `fmtNum` in `agent-pov-view.tsx:410` and `fmt` in `src/app/(app)/f/[id]/team-view.tsx:279`.

### `STATUS_STYLE` — `packages/frontend/src/components/team/team-dashboard.tsx:60`

Status → `{dot, label}` map: `running`→`bg-running`/"running", `paused`→`bg-paused`/"paused", `errored`→`bg-error`/"errored", `awaiting_approval`→`bg-brand`/"awaiting approval". Unknown statuses fall back to `running`.

### `<TeamDashboard teamId={…} agents={…} childTeams={…} childAgents={…} narration={…} tickCount={…} paused={…} onAgentClick={…} />` — `packages/frontend/src/components/team/team-dashboard.tsx:67`

The default (`?agent=team`) view body.

| Prop | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Passed to `<TraceView/>` in play-by-play mode (`team-dashboard.tsx:208`); unused elsewhere (child links use `ct.id`) |
| `agents` | `Agent[]` | Direct agents |
| `childTeams?` | `ChildTeam[]` (default `[]`) | Sub-team headers |
| `childAgents?` | `ChildAgent[]` (default `[]`) | Sub-team agents, grouped by `teamId` |
| `narration` | `NarrationEntry[]` | Activity feed entries (first 30 shown) |
| `tickCount` | `number` | Drives all token/cost numbers |
| `paused` | `boolean` | Toggles "live" badge and empty-state copy |
| `onAgentClick` | `(id: string) => void` | Fired when a **direct** agent card is clicked; `TeamView` wires it to a `pushState` + synthetic `PopStateEvent` POV switch |

**State:** `feedMode: useState<"summary" | "steps">` (default `"summary"`, `team-dashboard.tsx:77`) — selects which body the activity panel renders. The only local state in the component.

**Derived values:** `allAgents = agents ∪ childAgents`; an `agentNames: Record<string, string>` id→name map built from `allAgents` for `TraceView` labeling (`team-dashboard.tsx:79-80`); counts of `running`/`errored`/`awaiting_approval`; the synthetic estimate `tokensUp = tickCount*400`, `tokensDown = tickCount*1200`, `cost = (up*3 + down*15)/1e6` ($3/M input + $15/M output) at `team-dashboard.tsx:84-86`.

**Renders:** a 5-column stat row (`StatCard` × Agents/Ticks/Tokens In/Tokens Out/Est. Cost); a two-column grid:
- Left — direct `AgentCard`s; then per child team a `Link` header to `/f/{childId}` (run-state dot, name, agent count) with its agents indented behind a left border. Child agent cards navigate with a full `window.location.href = "/f/{childTeamId}?agent={id}"` assignment (`team-dashboard.tsx:144`) instead of the `onAgentClick` pushState path used for direct agents. Empty state "No agents in this team"; summary chips "N errored" / "N awaiting approval" when nonzero.
- Right (`data-testid="narration-feed"`) — "Activity" header with a two-button segmented toggle labeled `summary` / `play-by-play` writing `feedMode` (`team-dashboard.tsx:183-196`), plus the pulsing "live" badge while unpaused. Body: in `"steps"` mode, `<TraceView teamId={teamId} agentNames={agentNames} compact />` (`team-dashboard.tsx:207-208`) — the live whole-team trace stream; in `"summary"` mode, the scrollable list of the first 30 `narration` entries (time via `formatTime`, agent name, truncated description); empty-state copy differs paused ("Team is paused. Resume to see activity.") vs running ("Waiting for first tick...").

- **Called by / rendered by:** `src/app/(app)/f/[id]/team-view.tsx:201`.
- **Renders:** `StatCard`, `AgentCard`, `next/link`, `TraceView` (steps mode only).

### `AgentCard({ agent, onClick })` — `packages/frontend/src/components/team/team-dashboard.tsx:239`

Internal. A full-width `<button>`: status dot (pulsing while `inFlight`), name (brand on hover), role, "every Ns/m/h" chip, and a status label that reads "thinking..." in brand color while `inFlight`, else `STATUS_STYLE` label.

### `StatCard({ label, value, sub })` — `packages/frontend/src/components/team/team-dashboard.tsx:264`

Internal. Bordered tile: tiny uppercase mono label, 20px value, optional sub-line. A separate, near-identical `StatCard` exists in `agent-pov-view.tsx:400`.

---

## `packages/frontend/src/components/team/approval-queue.tsx`

Client module, self-contained (own polling + mutations). The header comment documents it as "T2, part 3b".

### `ApprovalItem` — `packages/frontend/src/components/team/approval-queue.tsx:14`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Approval row id |
| `agentId` | `string` | Requesting agent (named via the `agentNames` prop) |
| `toolName` | `string` | Tool awaiting sign-off |
| `toolArguments` | `string` | Raw JSON args string (pretty-printed by `formatArgs`) |
| `createdAt` | `string` | Unused in the render |

### `<ApprovalQueue teamId={…} agentNames={…} pollMs={…} />` — `packages/frontend/src/components/team/approval-queue.tsx:30`

Banner above the team dashboard listing destructive tool calls parked for human sign-off. Renders `null` when the queue is empty.

| Prop | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Team whose approvals to poll |
| `agentNames?` | `Record<string, string>` (default `{}`) | agentId → display name; missing ids render as "An agent" |
| `pollMs?` | `number` (default `4000`) | Poll interval (doc comment: chosen against the 10s dev tick loop) |

**State:** `items: ApprovalItem[]`, `busyId: string | null` (disables the buttons of the row being decided).

**Effects:** one (`approval-queue.tsx:45`) — calls `load()` immediately and on a `setInterval(load, pollMs)`; cleanup clears the interval.

**Fetches:** `GET /api/team/{teamId}/approvals` every poll (non-OK and thrown errors silently ignored — next poll retries); `POST` to the same endpoint with `{approvalId, decision: "approved" | "rejected"}` on a button press. `decide` removes the card **optimistically** before the POST and calls `load()` to reconcile if the POST fails or throws.

**Renders:** "Awaiting approval (N)" header; per item a brand-tinted card — "{agent} wants to run `{toolName}`", a `<pre>` with `formatArgs(toolArguments)` (max-height 32, scrollable), and Approve / Reject buttons.

- **Called by / rendered by:** `src/app/(app)/f/[id]/team-view.tsx:196` (only in the `?agent=team` branch — approvals are invisible while viewing an individual agent POV).

### `formatArgs(raw)` — `packages/frontend/src/components/team/approval-queue.tsx:120`

Internal. `JSON.stringify(JSON.parse(raw), null, 2)`; returns the raw string unchanged when parsing fails.

---

## `packages/frontend/src/components/team/agent-pov-view.tsx`

Client module, 1074 lines — the per-agent screen plus a substantial block of dead code. PR #12 added a fifth "trace" tab rendering `<TraceView/>` (import at `agent-pov-view.tsx:6`).

**Backend imports:** `USER_AGENT_ID` from `@simple-harmonic/backend/lib/meta-agent/identity` (`agent-pov-view.tsx:4`) — value `"00000000-0000-0000-0000-00000000fffe"`. **This import is only consumed by the dead `MessagesTab`** (line 756), so it is effectively dead weight too.

### Types — `packages/frontend/src/components/team/agent-pov-view.tsx:12-77`

**`AgentDetail`** (`:12`):

| Field | Type |
|---|---|
| `id`, `name`, `role`, `archetype`, `initialPrompt` | `string` |
| `tools` | `string[]` |
| `scheduleSeconds` | `number` |
| `status` | `"running" \| "paused" \| "errored" \| "awaiting_approval"` |
| `inFlight` | `boolean` |

**`ActionEntry`** (`:24`): `{ type: "action"; id; actionType: string; payload: Record<string, unknown>; timestamp: string }` — one action the agent took.

**`ReceivedEntry`** (`:32`): `{ type: "received"; id; fromName; content; kind; channelType; timestamp }` — one inbound message.

**`TimelineEntry`** (`:42`): `ActionEntry | ReceivedEntry`.

**`HubData`** (`:44`): the `GET /api/team/[id]/agent-hub` response — `{ agentId, agentName, agentRole, agentStatus, agentSchedule, nextRunAt: string | null, inFlight, timeline: TimelineEntry[] }`. Only `timeline` is read by the tabs; the header fields come from the `agent` prop instead. The route can also emit a third timeline kind, `{type: "sent"}`, but only for the cofounder/user sentinel ids (`packages/backend/src/server/api/team/id/agent-hub.ts:79-80,143-155`, behind the thin Next re-export) — which this component never requests (it is rendered only for real agent UUIDs), so the two-variant `TimelineEntry` union holds in practice.

**`A2AXMessage`** (`:55`): `{ id, channelType: "direct"|"broadcast"|"group"|"task", channelId, fromAgentId, fromAgentName, kind, content, status, urgent, createdAt }`. **Dead** — only referenced by the dead `MessagesTab`.

**`AgentPovViewProps`** (`:68`): see the component entry below. **`ActiveTab`** (`:76`): `"dashboard" | "history" | "trace" | "messages" | "config"`. **`ViewMode`** (`:77`): `"normal" | "thinking" | "verbose"`.

### Constants — `packages/frontend/src/components/team/agent-pov-view.tsx:83,91`

- **`ARCHETYPES`** (`:83`): `["support-responder", "content-scheduler", "sales-followup", "ops-monitor", "research-summarizer"]` — the options of the Config tab's archetype `<select>`.
- **`STATUS_STYLE`** (`:91`): status → `{dot, text, label}`; same palette as the dashboard map plus a `text-*` class for the header label.

### Helpers — `packages/frontend/src/components/team/agent-pov-view.tsx:102-198`

- **`formatTime(iso)`** (`:102`) — identical to `team-dashboard.tsx:45` (HH:MM:SS, date-prefixed when not today). Called by `DashboardTab`, `ActionNode`, `ReceivedNode`.
- **`formatSchedule(seconds)`** (`:111`) — "every Ns/m/h"; called by `AgentHeader`.
- **`formatScheduleShort(seconds)`** (`:117`) — "Ns/m/h" without prefix; called by `ConfigTab`'s slider readout.
- **`truncate(s, n)`** (`:123`) — slice + `"..."` (three ASCII dots; the lib version in `narration.ts` uses `…`). Called by the describers and `ReceivedNode`.
- **`timeAgo(iso)`** (`:128`) — "just now"/"Nm ago"/"Nh ago"/"Nd ago". **Dead** — only called by the dead `MessagesTab` (line 816).
- **`describeAction(actionType, payload)`** (`:138`) — local long-form describer, intentionally separate from `lib/narration.ts`'s with longer truncation limits (120/100/140 chars) and a smaller case set: `message_sent`, `broadcast_sent`, `multi_action` ("N action(s) this tick"), `agent_thought`, `noop` ("no action needed this tick"), fallback prefers `payload.summary` then humanizes snake_case. Called by `ActionNode` (thinking/verbose cards).
- **`describeSubAction(action)`** (`:160`) — maps one `multi_action` sub-action to `{glyph, text}`: `message_sent`→`→`, `broadcast_sent`→`→→`, `agent_thought`→`·`, `feedback_scan`→`○` ("scanned {source}"), default→`•` (summary or humanized type). Called by `ActionNode`'s expanded sub-action list.
- **`channelBadge(type)`** (`:178`) — colored channel-type chip (direct/broadcast/group/task → blue/amber/emerald/purple). **Dead** — only called by the dead `MessagesTab` (line 806).
- **`FieldLabel({ children })`** (`:192`) — tiny uppercase mono `<label>`; called by `ConfigTab`.

### `<AgentPovView teamId={…} agent={…} teamAgents={…} cofounderName={…} onUpdated={…} />` — `packages/frontend/src/components/team/agent-pov-view.tsx:204`

The per-agent screen: status header, tab strip, and one of five tab bodies.

| Prop | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Passed to tab fetchers and `AgentMessagesView` |
| `agent` | `AgentDetail` | The selected agent (sourced live from `useTeam`'s `agents`) |
| `teamAgents` | `{ id; name; role?; status? }[]` | Peer list forwarded to `AgentMessagesView` (missing role → `""`, missing status → `"running"`) |
| `cofounderName?` | `string \| null` | Forwarded to `AgentMessagesView` |
| `onUpdated` | `(agent: AgentDetail) => void` | Bubbles the PATCH response from `ConfigTab` up to `TeamView`/`useTeam.updateAgent` |

**State:** `tab: ActiveTab` (default `"dashboard"`), `viewMode: ViewMode` (default `"normal"`). No effects or fetches of its own — those live in the tab components.

**Renders:** `AgentHeader`; a tab strip over `dashboard | history | trace | messages | config` (`agent-pov-view.tsx:216`) plus a `normal | thinking | verbose` segmented toggle **only while the history tab is active**; then `DashboardTab`, `HistoryTab`, `<TraceView teamId={teamId} agentId={agent.id} />` (`agent-pov-view.tsx:261` — the live play-by-play stream scoped to this agent, no `agentNames`/`compact`), `AgentMessagesView` (with `initialPovId={agent.id}` and `onClose` that switches back to the dashboard tab — a callback `AgentMessagesView` never invokes), or `ConfigTab`. Note the messages tab does **not** render the local `MessagesTab` component.

- **Called by / rendered by:** `src/app/(app)/f/[id]/team-view.tsx:239` (when `?agent=` is a real agent id).

### `AgentHeader({ agent })` — `packages/frontend/src/components/team/agent-pov-view.tsx:288`

Internal. Status dot (pulsing while `inFlight`), agent name, one-line role, `formatSchedule` chip, and a status label ("thinking..." while `inFlight`, else `STATUS_STYLE` label/color).

### `DashboardTab({ teamId, agent })` — `packages/frontend/src/components/team/agent-pov-view.tsx:317`

Internal. Per-agent stats overview.

- **State:** `data: HubData | null`.
- **Effects:** one — fetch on mount + `setInterval` every **5 000ms**; a `cancelled` flag prevents state writes after unmount; cleanup clears both.
- **Fetches:** `GET /api/team/{teamId}/agent-hub?agentId={agent.id}` (errors silent).
- **Derived stats:** total actions; active rate = non-`noop` share; messages sent = top-level `message_sent`/`broadcast_sent` **plus** the same types nested inside `multi_action` payloads; messages received = `received` entries; the synthetic token estimate `actions*400` in / `*1200` out and `(up*3 + down*15)/1e6` cost (`agent-pov-view.tsx:348-350`).
- **Renders:** 3-column `StatCard` grid (Total Actions w/ active %, Messages Sent, Messages Received, Tokens In, Tokens Out, Est. Cost); tool chips from `agent.tools`; "Recent Activity" — the last five timeline entries newest-first, actions through `describeActionNormal`, received entries as `← {fromName}`.

### `StatCard({ label, value, sub })` — `packages/frontend/src/components/team/agent-pov-view.tsx:400`

Internal duplicate of the dashboard's `StatCard` (18px value instead of 20px, `bg-bg` instead of `bg-bg-elev`).

### `fmtNum(n)` — `packages/frontend/src/components/team/agent-pov-view.tsx:410`

Internal duplicate of `team-dashboard.tsx`'s `fmt`.

### `describeActionNormal(actionType, payload)` — `packages/frontend/src/components/team/agent-pov-view.tsx:424`

Compact one-line describer for normal mode: `message_sent`→`→ {to}`, `broadcast_sent`→`→→ N peers`, `multi_action`→"2 msgs, 1 other"-style breakdown (fallback "N actions"), `noop`→`idle`, `agent_thought`→60-char truncation, default→`summary` (60-char) or humanized type.

- **Called by:** `DashboardTab` recent-activity rows, `ActionNode` (normal mode).

### `filterTimeline(timeline, mode)` — `packages/frontend/src/components/team/agent-pov-view.tsx:452`

In `normal` mode drops all `received` entries and all `agent_thought` actions; `thinking`/`verbose` return the timeline unchanged.

- **Called by:** `HistoryTab`.

### `HistoryTab({ teamId, agentId, viewMode })` — `packages/frontend/src/components/team/agent-pov-view.tsx:465`

Internal. Vertical timeline of the agent's actions and inbound messages.

- **State:** `data: HubData | null`, `loading` (spinner only before first data), `expanded: Set<string>` (manually expanded `multi_action` ids), refs `endRef` (scroll anchor) + `prevCountRef` (previous timeline length).
- **Effects:** (1) fetch on mount + 5 000ms interval against the same `GET /api/team/{teamId}/agent-hub?agentId=` endpoint (so dashboard+history tabs each run their own 5s poll); (2) auto-scroll — when the timeline length grows (and was previously >0) smooth-scrolls `endRef` into view.
- **Renders:** loading state → empty state (clock icon, "No activity yet… after the first tick") → a left-railed timeline of `filterTimeline` output: `ActionNode` per action (verbose mode forces `isExpanded`), `ReceivedNode` per received message. `toggleExpand(id)` flips membership in `expanded`.

### `ActionNode({ entry, viewMode, isExpanded, onToggle })` — `packages/frontend/src/components/team/agent-pov-view.tsx:572`

Internal. One action on the timeline. Normal mode: a small dot (grey for `noop`, brand otherwise) + time + `describeActionNormal` one-liner. Thinking/verbose: a card with time + action-type chip, `describeAction` body, and styling that distinguishes noops (faded), thoughts (dashed border), and real actions; `multi_action` cards get an expand/collapse button (hidden in verbose, which always expands) and an expanded sub-action list rendered through `describeSubAction` glyphs — verbose additionally prints each sub-action's raw JSON in a `<pre>`, and for non-multi actions prints the whole payload JSON (max-height 300px).

### `ReceivedNode({ entry, viewMode })` — `packages/frontend/src/components/team/agent-pov-view.tsx:686`

Internal. Muted card for an inbound message: time, `←`, sender name, channel type, and the content — truncated at 200 chars except in verbose. Returns `null` in normal mode (defensive; `filterTimeline` already removed these).

### `MessagesTab({ teamId, agent, teamAgents })` — `packages/frontend/src/components/team/agent-pov-view.tsx:714` — **DEAD CODE**

A complete flat message-feed component that is **never rendered**: `AgentPovView`'s messages tab renders `AgentMessagesView` instead (`agent-pov-view.tsx:262-275`), and nothing else references `MessagesTab`. Verified by grep — the only mentions in the repo are its definition and its internal uses of `A2AXMessage`, `channelBadge`, `timeAgo`, and `USER_AGENT_ID`, making all four of those dead by extension. For the record, it: polls `GET /api/team/{teamId}/messages?agentId={agent.id}` every 5s, auto-scrolls on message-count change, renders `A2AXMessage` cards (channel badge, from/sent label, `timeAgo`, urgent marker), and has an auto-growing compose textarea that POSTs `/api/team/{teamId}/messages` with `{fromAgentId: USER_AGENT_ID, toAgentId: agent.id, content, channelType: "direct"}`. Its `teamAgents` prop is also unused within the component.

### `ConfigTab({ agent, onUpdated })` — `packages/frontend/src/components/team/agent-pov-view.tsx:866`

Internal. Editable agent configuration form with dirty tracking.

- **State:** one `useState` per field — `name`, `role`, `archetype`, `toolsText` (comma-joined string), `scheduleSeconds`, `initialPrompt`, `status` — plus `saving` and `dirty`.
- **Effects:** one (`:884`) — re-seeds every field from the `agent` prop and clears `dirty` whenever the prop object changes (e.g. after a save propagates back through `useTeam.updateAgent`). Note the dependency is the `agent` object identity; `TeamView` builds a fresh object every render, so this effect re-runs on each parent render — benign because `useTeam` polling also replaces the underlying data.
- **`markDirty(setter)`** (`:895`) — higher-order helper wrapping each setter to also flip `dirty`.
- **`handleSave`** (`:902`) — splits/trims `toolsText` into `tools`, builds the PATCH body `{name, role, archetype, tools, scheduleSeconds, initialPrompt}` and includes `status` **only when the current selection is not `awaiting_approval`**; PATCHes **`/api/agent/{agent.id}`**; on OK passes the response JSON to `onUpdated` and clears `dirty`.
- **Renders:** Name input; Archetype `<select>` over `ARCHETYPES`; Role input; Status `<select>` (running/paused/errored/awaiting approval, disabled while the agent's live status is `awaiting_approval`); Schedule range slider (min 10, max 3600, step 10) with `formatScheduleShort` readout; Tools comma-separated input with live chips; System Prompt textarea (min-height 200px). When `dirty`, a bottom bar shows "Unsaved changes" with Discard (re-seeds from `agent`) and Save buttons.

---

## `packages/frontend/src/components/team/agent-messages-view.tsx`

Client module. The Slack-like two-pane view of A2AX traffic from a chosen point of view.

**Backend imports** (`agent-messages-view.tsx:4-9`): `COFOUNDER_AGENT_ID` (`"00000000-0000-0000-0000-00000000c0f0"`), `USER_AGENT_ID` (`"…fffe"`), `getTeamHumans`, `resolveCofounderName` from `@simple-harmonic/backend/lib/meta-agent/identity`.

### Types — `packages/frontend/src/components/team/agent-messages-view.tsx:15-69`

**`ThreadMessage`** (`:15`):

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Message id |
| `fromAgentId` / `fromAgentName` | `string` | Sender |
| `content` | `string` | Body |
| `kind` | `string` | Message kind; non-`"text"` kinds get an annotation under the bubble |
| `status` | `string` | `"pending"` counts toward unread badges |
| `urgent` | `boolean` | Adds a brand ring around the bubble |
| `createdAt` | `string` | ISO time |
| `isSelf` | `boolean` | Server-computed "sent by the current POV" |

**`Thread`** (`:27`): `{ channelId, channelType: "direct"|"broadcast"|"group"|"task", peerAgentId: string | null, peerAgentName: string | null, messages: ThreadMessage[] }`.

**`ConversationsResponse`** (`:35`): `{ agentId, agentName, threads: Thread[] }` — the `/conversations` payload (`agentId`/`agentName` are unused by the component).

**`TaskItem`** (`:41`): `{ id, title, description, state, requestorId, requestorName, assigneeId, assigneeName, createdAt, updatedAt }` — one A2AX task.

**`AgentInfo`** (`:54`): `{ id, name, role, status: "running"|"paused"|"errored"|"awaiting_approval" }` — peer summary used for the DM list, wake/pause controls, and name lookups.

**`ActiveTab`** (`:69`): `"messages" | "tasks"` (left-pane tab; distinct from `agent-pov-view.tsx`'s 4-value `ActiveTab`).

### Constants — `packages/frontend/src/components/team/agent-messages-view.tsx:72-74,144`

- **`POV_TEAM` / `POV_COFOUNDER` / `POV_USER`** (`:72-74`): the sentinel POV ids `"team"`, `"cofounder"`, `"user"`. These match the backend's `COFOUNDER_POV`/`USER_POV` constants but are re-declared locally.
- **`TASK_STATE_STYLES`** (`:144`): the eight A2AX task states → `{bg, text, label}`: `submitted` (yellow "Submitted"), `accepted` (blue "Accepted"), `working` (brand "Working"), `input_required` (purple "Needs Input"), `completed` (green "Completed"), `failed` (red "Failed"), `canceled` (neutral "Canceled"), `rejected` (red "Rejected"). Unknown states fall back to `submitted`.

### Helpers — `packages/frontend/src/components/team/agent-messages-view.tsx:80-183`

- **`timeAgo(iso)`** (`:80`) — compact relative time: "now"/"Nm"/"Nh"/"Nd" (no " ago" suffix, unlike the POV-view variant). Called by thread rows.
- **`formatTime(iso)`** (`:90`) — `HH:MM` (no seconds, no date prefix — differs from the other two `formatTime`s). Called by message timestamps and the task detail pane.
- **`statusDot(status)`** (`:98`) — 2×2 colored dot (running/paused/awaiting_approval/errored → green/grey/brand/red). Called by the new-DM peer list.
- **`channelIcon(type)`** (`:110`) — 14×14 inline SVG per channel type (speech bubble / flag / people / checklist). Called by thread rows and the thread header.
- **`TaskStateBadge({ state })`** (`:155`) — chip rendering `TASK_STATE_STYLES[state]`. Called by task rows and the task detail pane.
- **`getPovLabel(povId, agents, cofounderDisplay)`** (`:164`) — "Team Overview" / cofounder name / "You" / agent name / raw id. **Only called once**, for the compose placeholder (`:776`).
- **`getPovRole(povId, agents)`** (`:171`) — **dead code**: defined, never called.
- **`getPovInitial(povId, agents, cofounderDisplay)`** (`:178`) — **dead code**: defined, never called (presumably for a removed POV-switcher avatar).

### `<AgentMessagesView teamId={…} cofounderName={…} agents={…} initialPovId={…} onClose={…} />` — `packages/frontend/src/components/team/agent-messages-view.tsx:189`

| Prop | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Scopes every fetch |
| `cofounderName` | `string \| null` | Resolved via `resolveCofounderName` → display name (fallback "Harmon") |
| `agents` | `AgentInfo[]` | Team agents (peer list, name lookups, wake/pause targets) |
| `initialPovId?` | `string` | Starting POV: an agent UUID or one of the sentinels; defaults to `POV_USER` |
| `onClose` | `() => void` | **Required but never invoked** anywhere in the component body — a dead prop both callers must still supply |

**State:**

| Field | Kind | Meaning |
|---|---|---|
| `povId` | `useState` | Current POV. Effectively **fixed** to `initialPovId ?? "user"`: the only setter is `handlePovChange`, which is itself never called (see below) |
| `activeTab` | `useState<ActiveTab>` | `"messages"` or `"tasks"` left-pane tab |
| `threads` | `useState<Thread[]>` | API threads merged with client-side placeholder threads |
| `tasks` | `useState<TaskItem[]>` | Task list |
| `selectedThread` / `selectedTask` | `useState<string \| null>` | Current selection (mutually exclusive in practice — selecting one clears the other) |
| `loading` | `useState` | True during a conversations fetch |
| `composeContent` / `sending` | `useState` | Compose box state |
| `actionPending` | `useState<string \| null>` | Agent id mid wake/pause (disables both buttons) |
| `actionFlash` | `useState<string \| null>` | 3s confirmation banner text |
| `messagesEndRef` | `useRef` | Scroll anchor |

**Effects:**
1. (`:247`) — on mount/POV change, fetch conversations + tasks immediately and on a **5 000ms** interval; cleanup clears it. Because `fetchConversations` is a `useCallback` depending on `selectedThread`, the interval is also torn down and recreated whenever the selected thread changes.
2. (`:260`) — smooth-scroll `messagesEndRef` into view when the active thread's message count or the selection changes.

**Fetches:**
- `GET /api/team/{teamId}/conversations?agentId={povId}` — thread list. The merge (`:219-225`) keeps client-created **placeholder threads** (zero messages, id not in the API result) alive across polls. Auto-selects the first API thread when nothing is selected.
- `GET /api/team/{teamId}/tasks?agentId={povId}` — task list.
- `POST /api/team/{teamId}/messages` — on send: `{fromAgentId: povId, content, channelType}` plus `toAgentId` for direct threads or `channelId` for group threads (broadcast sends carry neither); refetches conversations after.
- `PATCH /api/agent/{agentId}` — `{wake: true}` from the Wake button; `{status: "running"|"paused"}` from Pause/Resume. Both set a 3-second `actionFlash` confirmation on success. Non-OK responses are silently ignored — including the route's **409** for an `awaiting_approval` agent (`packages/backend/src/server/api/agent/id.ts:47-51`); the UI relies on the disabled-while-`awaiting_approval` buttons, whose status can be up to one 10s team-poll stale.

**Key derived values:**
- `isTeamOverview = povId === "team"`; `isSpecialPov` is an alias of it (`:210`).
- `realParticipantId` (`:334`) — maps the `user`/`cofounder` sentinels to `USER_AGENT_ID`/`COFOUNDER_AGENT_ID` for channel-id computation; agent UUIDs pass through.
- `peers` (`:399`) — DM-able identities: user POV → cofounder + all agents; cofounder POV → user + all agents; agent POV → user + cofounder + other agents. Sentinel peers are synthesized with `status: "running"`.
- `threadsWithoutPeers` (`:418`) — peers with no existing direct thread (empty for team overview).
- `activeTaskCount` (`:425`) — tasks in `submitted/accepted/working/input_required`, shown as the Tasks tab badge.
- `canCompose = povId === POV_USER` (`:429`) — composing, new-DM list, and broadcast creation are restricted to the human-user POV.

**Callbacks:**
- `handleNewDM(peerId)` (`:341`) — selects the existing direct thread with that peer, or prepends a client-side placeholder `Thread` with channel id `direct:<idA>:<idB>` (the two real participant UUIDs, sorted) and selects it. This exactly matches the backend's `directChannelId` scheme (`packages/a2ax/src/types/channel.ts:29-32`), so the placeholder is superseded cleanly once the server thread exists.
- `handleNewBroadcast()` (`:368`) — same pattern with channel id `broadcast:{teamId}` and name "Team Broadcast". This does **not** match the backend: `broadcastChannelId` is `team:{teamId}` (`channel.ts:35-37`), so the server-created broadcast thread returns under a different `channelId`, never replaces the placeholder, and the still-selected placeholder never shows the broadcast that was just sent (a duplicate "Team Broadcast" row appears instead). The send itself works — the POST body for broadcasts carries `channelType` only, and the route routes by type, not id.
- `handlePovChange(newPov)` (`:388`) — resets selection/threads/tasks and sets the POV. **Dead code**: defined but never wired to any UI (the POV switcher lives in the sidebar/team-view URL instead).
- `handleWakeAgent` (`:298`) / `handleToggleAgentStatus` (`:315`) — the PATCH calls described above.

**Renders:** left pane (260px): Messages/Tasks tab strip (thread count, active-task badge); thread rows (channel icon, peer name, unread badge counting non-self `pending` messages, `timeAgo`, last-message preview prefixed with the sender name in team-overview mode or "You: " for self) or task rows (title, `TaskStateBadge`, "requestor → assignee"); for the user POV, a "Direct message" section listing `threadsWithoutPeers` with `statusDot`s and a "Broadcast to all" entry when no broadcast thread exists. Right pane: thread header (icon, name, type, message count) with **Wake** and **Pause/Resume** buttons when the user POV views a direct thread with a real agent — both disabled while `actionPending` or the agent is `awaiting_approval` (button label "Awaiting"); the `actionFlash` banner; chat-style bubbles — team overview renders everything left-aligned with sender names in brand color, otherwise self-right (brand blue) / others-left, name labels on sender change, centered `formatTime` timestamps when >5 minutes (300 000ms) elapse between messages, urgent ring, non-`text` kind annotation; the auto-growing compose box (Enter sends, Shift+Enter newline, max-height 120px) for the user POV only; or the task detail pane (title, state badge, requestor/assignee/created/updated grid, description). Empty-state placeholders for no selection / no threads / no tasks.

**Unused variable:** `const humans = getTeamHumans(teamId)` at `:191` is computed and never read (the backend helper returns the fixed `[{id: USER_AGENT_ID, name: "You"}]` singleton).

- **Called by / rendered by:** `src/app/(app)/f/[id]/team-view.tsx:182` (POV `meta`/`user` → `initialPovId` `"cofounder"`/`"user"`); `packages/frontend/src/components/team/agent-pov-view.tsx:263` (messages tab, `initialPovId = agent.id`).

---

## `packages/frontend/src/components/team/trace-view.tsx`

Client module (`"use client"`), 262 lines, added by PR #12. The play-by-play trace view: renders every agent step (LLM rounds, tool calls, approval pauses, decisions, tick boundaries) as live-updating per-tick threads. Consumes the SSE route `GET /api/team/[id]/trace` and shapes events through `buildTickThreads` from `../../lib/trace`.

### `MAX_EVENTS` — `packages/frontend/src/components/team/trace-view.tsx:12`

`2000` — the in-memory event cap; updates append then `slice(-MAX_EVENTS)`, so old ticks fall off the front of long-running sessions.

### `STATUS_BADGE` — `packages/frontend/src/components/team/trace-view.tsx:24`

`TickStatus` → `{label, cls}` map for the thread-header chip: `live` → "live" (running tint, pulsing), `finished` → "done" (faint), `failed` → "failed" (error tint), `awaiting_approval` → "needs approval" (brand tint).

### `formatTime(iso)` / `fmtDuration(ms)` — `packages/frontend/src/components/team/trace-view.tsx:31,45`

Internal. `formatTime` follows the `team-dashboard.tsx:45` convention (HH:MM:SS, "MMM D"-prefixed when not today) — yet another near-duplicate alongside the `message.tsx`, `team-dashboard.tsx`, `agent-pov-view.tsx`, and `agent-messages-view.tsx` variants. `fmtDuration` mirrors `lib/trace.ts:59` but returns `null` (render nothing) instead of `""` for non-finite input.

### `<TraceView teamId={…} agentId={…} agentNames={…} compact={…} />` — `packages/frontend/src/components/team/trace-view.tsx:51`

| Prop | Type | Meaning |
|---|---|---|
| `teamId` | `string` | Scopes the SSE fetch |
| `agentId?` | `string` | Limits the stream to one agent (`?agentId=` query param); omitted for the whole team. Also controls `showAgent` — agent names are shown on thread headers only in team-wide mode |
| `agentNames?` | `Record<string, string>` | agentId → display name for thread headers (missing ids render as "agent"); passed by `TeamDashboard`, omitted by `AgentPovView` |
| `compact?` | `boolean` (default `false`) | Dense paddings + hidden per-step timestamps, for the team activity panel |

**State:** `events: TraceEvent[]` ([]), `connected: boolean` (false); refs `endRef` (scroll anchor), `prevCountRef` (previous event count).

**Effects:**
1. SSE subscription (`trace-view.tsx:57`, deps `[teamId, agentId]`) — resets `events`, then fetches `GET /api/team/{teamId}/trace[?agentId=…]` and reads the body with a manual `ReadableStream` reader (`\n\n` framing, `data: ` lines — same hand-rolled pattern as `use-team.ts`'s narration stream). `history` events replace the whole list; `update` events are deduped by id against current state, appended, and capped at `MAX_EVENTS`. Malformed SSE chunks are skipped; fetch errors are swallowed (`connected` just flips false). The route's `?tickId=` filter is never used by this component. Cleanup: `cancelled` flag + `reader?.cancel()`.
2. Auto-scroll (`trace-view.tsx:117`) — smooth-scrolls `endRef` into view when the event count grows (skipping the initial render via `prevCountRef > 0`).

**Derived:** `threads = useMemo(buildTickThreads(events))` — re-shaped on every event batch.

**Renders:** empty state ("Connecting…" until the reader attaches, then "No trace yet" + "Every step appears here live on the next tick."); otherwise a scrollable column of `TickThreadBlock`s (max-w-3xl unless `compact`) with the `endRef` anchor at the bottom.

- **Called by / rendered by:** `agent-pov-view.tsx:261` (trace tab — `teamId` + `agentId`, full-size) and `team-dashboard.tsx:208` (activity feed "steps" mode — `teamId` + `agentNames` + `compact`).

### `TickThreadBlock({ thread, agentName, showAgent, compact })` — `packages/frontend/src/components/team/trace-view.tsx:157`

Internal. One bordered card per tick: header row (start time via `formatTime`, agent name when `showAgent` — i.e. whole-team mode, and the `STATUS_BADGE` chip, `animate-pulse` while `live`), then one `StepRow` per `thread.steps`.

### `STEP_TONE` — `packages/frontend/src/components/team/trace-view.tsx:200`

`TraceStepRow["kind"]` → text-color class: `tool` brightest (`text-fg`), `llm`/`decision_applied` muted, `tick_started`/`tick_finished`/`unknown` faint, `approval_requested` brand, `tick_failed` error.

### `StepRow({ step, compact })` — `packages/frontend/src/components/team/trace-view.tsx:211`

Internal. One mono step line: glyph (running-green and pulsing while `step.live`), timestamp (hidden in `compact`), the label tinted by `STEP_TONE`, right-aligned duration, and — when `step.detail` exists — a `+`/`−` affordance toggling local `expanded` state that reveals a `<pre>` (max-height 280px, pre-wrap) with the full args/result/thought. The row is keyboard-accessible (`role="button"`, Enter/Space) only when expandable.

---

## `packages/frontend/src/components/sidebar.tsx`

Client module. The app-wide left navigation. No backend imports — the "Harmon" fallback name is a string literal here (`sidebar.tsx:376`), not `DEFAULT_COFOUNDER_NAME`.

### `Team` / `Agent` (local types) — `packages/frontend/src/components/sidebar.tsx:7,14`

`Team`: `{ id, name, paused: boolean, parentTeamId: string | null }`. `Agent`: `{ id, name, role, status: "running"|"paused"|"errored"|"awaiting_approval" }` (`role` is fetched but unused in the render).

### `<Sidebar />` — `packages/frontend/src/components/sidebar.tsx:229`

Public wrapper: renders `SidebarInner` inside `<Suspense>` (required because `SidebarInner` calls `useSearchParams`, which would otherwise force the whole route into client-side rendering during prerender).

- **Called by / rendered by:** `src/app/(app)/layout.tsx:6` — every `(app)` route shares it.

### `SidebarInner()` — `packages/frontend/src/components/sidebar.tsx:21`

**State:**

| Field | Kind | Meaning |
|---|---|---|
| `teams` | `useState<Team[]>` | All teams (flat) |
| `teamAgents` | `useState<Record<string, Agent[]>>` | teamId → agents, eagerly filled |
| `teamCofounderNames` | `useState<Record<string, string>>` | teamId → cofounder display name |
| `collapsed` | `useState<boolean>` | 48px rail mode |
| `userMenuOpen` | `useState<boolean>` | Footer popover |
| `userMenuRef` | `useRef<HTMLDivElement>` | Outside-click detection target |
| `displayName` / `userRole` | `useState<string>` | From `localStorage["sh:user-profile"]`, defaults "You"/"Founder" |

**Effects:**
1. (`:33`) — reads `localStorage["sh:user-profile"]` on mount and subscribes to window `storage` events (key `sh:user-profile`) so profile edits — including the profile page's synthetic `StorageEvent` — update the footer live. Cleanup removes the listener.
2. (`:52`) — while the user menu is open, a document `mousedown` listener closes it on outside clicks. Cleanup removes the listener.
3. (`:67`) — `GET /api/teams` once on mount (no polling).
4. (`:76`) — whenever `teams` changes, eagerly `GET /api/team/{id}` for **every** team not yet in `teamAgents`, filling `teamAgents` and `teamCofounderNames` so any tree node can expand without a fetch (comment: fine at "<20 teams" scale). Mount-time only — sidebar data never refreshes afterward.

**Derived:** `activeTeamId` from a `/f/([^/]+)` pathname match; `activeAgentId` from the `?agent=` search param.

**Renders:** collapsed → a 48px rail with a single expand chevron. Expanded → header ("Simple Harmonic" wordmark linking `/`, collapse chevron); nav with an "Overview" `SidebarLink` (`/`), a "Teams" section header with a "+" link to `/new` (hover tooltip "New Team"), and the `buildTeamTree(teams)` roots rendered as `TeamTreeNode`s; footer user chip (initial avatar, display name, role) toggling a popover with Profile (`/profile`), Settings (`/settings`), and "Log out" — which only sets `window.location.href = "/login"` without calling any API (`sidebar.tsx:198`).

### `TeamNode` — `packages/frontend/src/components/sidebar.tsx:237`

`{ id, name, paused: boolean, children: TeamNode[] }` — the recursive tree shape.

### `buildTeamTree(teams)` — `packages/frontend/src/components/sidebar.tsx:244`

Groups the flat team list by `parentTeamId` into a `Map`, then recursively builds `TeamNode`s starting from `parentTeamId === null` roots. Teams whose parent is missing from the list are silently dropped (they are only reachable through their parent key).

- **Called by:** `SidebarInner` (`:153`).

### `isInSubTree(node, targetId)` — `packages/frontend/src/components/sidebar.tsx:263`

Recursive membership test: true if `node` or any descendant has `id === targetId`.

- **Called by:** `TeamTreeNode` for active-path auto-expansion.

### `TeamTreeNode({ node, depth, activeTeamId, activeAgentId, teamAgents, teamCofounderNames, displayName })` — `packages/frontend/src/components/sidebar.tsx:268`

Internal recursive tree node.

| Prop | Type | Meaning |
|---|---|---|
| `node` | `TeamNode` | This team |
| `depth` | `number` | 0 = root team; controls indentation, indicator style, and the pinned-people block |
| `activeTeamId` / `activeAgentId` | `string \| null` | Current route selection |
| `teamAgents` / `teamCofounderNames` | maps | Shared lookup state from `SidebarInner` |
| `displayName` | `string` | The user's display name for the pinned "You" entry |

**State:** `expanded` (`useState`, initialized to `isActive || isInActivePath`). **Effect** (`:295`): re-expands (never collapses) when the node becomes active or enters the active path — the user can still manually toggle via the chevron.

**Renders:** a row with a chevron toggle (only when the node has agents or children) and a `SidebarLink` to `/f/{id}` whose indicator is a run-state dot for root teams or a group-of-people icon stroked `var(--color-running)`/`var(--color-paused)` for sub-teams. When expanded, an indented bordered block containing, in order: **(root teams only, `depth === 0`)** two pinned human/AI entries — "You" linking `?agent=user` with a blue person icon, and the cofounder linking `?agent=meta` with an orange sparkle icon, name from `teamCofounderNames` or the literal `"Harmon"` (the code comment explains these are deliberately not repeated on sub-teams, `sidebar.tsx:356-359`); then agent `SidebarLink`s (`?agent={id}`) with status dots (running/errored/awaiting_approval/paused → green/red/brand/grey); then child `TeamTreeNode`s at `depth + 1`.

### `SidebarLink({ href, active, label, indicator, accent, small })` — `packages/frontend/src/components/sidebar.tsx:431`

Internal `next/link` row: optional indicator node, truncated label, 13px (or 12px with `small`). `active` → brand left border + tinted background; otherwise transparent border with hover styles. The **`accent` prop is dead** — it has styling logic (`:454-455`) but no call site ever passes it.

---

## `packages/frontend/src/components/theme-provider.tsx`

Client module. Light/dark theming via a `.dark` class on `<html>`; CSS variables in `src/app/globals.css` key off that class.

### `ThemePref` — `packages/frontend/src/components/theme-provider.tsx:25`

`"system" | "light" | "dark"` — the stored preference (distinct from the *resolved* theme, which is never `"system"`).

### `STORAGE_KEY` — `packages/frontend/src/components/theme-provider.tsx:27`

`"simple-harmonic-theme"` — the localStorage key, shared (via template interpolation) with `THEME_INIT_SCRIPT`.

### `ThemeContextValue` — `packages/frontend/src/components/theme-provider.tsx:29`

| Field | Type | Meaning |
|---|---|---|
| `pref` | `ThemePref` | Stored preference |
| `resolved` | `"light" \| "dark"` | Actually-applied theme ("system" resolved against the OS) |
| `setPref` | `(pref: ThemePref) => void` | Persist + apply a new preference |

### `readSystemPref()` / `readStoredPref()` / `applyTheme(resolved)` — `packages/frontend/src/components/theme-provider.tsx:38,43,50`

Internal helpers: `readSystemPref` resolves `prefers-color-scheme` (SSR-safe, defaults `"light"`); `readStoredPref` validates the localStorage value (anything unexpected → `"system"`); `applyTheme` adds/removes the `.dark` class on `document.documentElement`.

### `<ThemeProvider>{children}</ThemeProvider>` — `packages/frontend/src/components/theme-provider.tsx:59`

| Prop | Type | Meaning |
|---|---|---|
| `children` | `React.ReactNode` | App subtree |

**State:** `pref` (`useState<ThemePref>`, SSR default `"system"`), `resolved` (`useState<"light"|"dark">`, default `"light"`).

**Effects:**
1. (`:65`) — hydrate on mount: read stored pref, resolve it (against the OS for `"system"`), apply the class. First paint is handled by `THEME_INIT_SCRIPT`, not this effect, so there is no flash.
2. (`:74`) — only while `pref === "system"`: subscribes to `matchMedia("(prefers-color-scheme: dark)")` `change` events and re-resolves/re-applies live when the OS theme flips. Cleanup removes the listener.

**`setPref(next)`** (`:86`): writes localStorage, resolves, applies, updates both state fields.

**Renders:** a `ThemeContext.Provider` around `children` — no DOM of its own.

- **Called by / rendered by:** `src/app/layout.tsx:48` (wraps the entire app body).

### `useTheme()` — `packages/frontend/src/components/theme-provider.tsx:101`

Context accessor. Deliberately does **not** throw outside the provider — returns the no-op default `{ pref: "system", resolved: "light", setPref: () => {} }` (comment: for tests).

- **Called by:** `src/app/(app)/settings/page.tsx:3` (the theme picker calls `setPref` directly).

### `THEME_INIT_SCRIPT` — `packages/frontend/src/components/theme-provider.tsx:113`

A string of IIFE JavaScript inlined into `<head>` via `dangerouslySetInnerHTML` (`src/app/layout.tsx:44`). Runs before React hydrates: reads `localStorage["simple-harmonic-theme"]`, resolves `"system"` against `matchMedia`, and toggles `.dark` on `<html>` so the first paint is already themed (the reason `<html>` carries `suppressHydrationWarning`). Wrapped in try/catch so storage errors are silent. Must be kept in sync with the provider's logic (per the file-header comment).

---

## `packages/frontend/src/components/mobile-notice.tsx`

### `<MobileNotice />` — `packages/frontend/src/components/mobile-notice.tsx:5`

No props. A dismissable full-screen overlay shown on viewports ≤767px: gear emoji, "Best on desktop", copy explaining the agent graph and narration sidebar need width ("Mobile support comes in v0.3"), and a "Continue anyway →" button.

**State:** `dismissed`, `isMobile` (both `useState<boolean>`, default `false`).

**Effects:** one (`:9`) — evaluates `matchMedia("(max-width: 767px)")` on mount and subscribes to its `change` events so rotating/resizing updates `isMobile` live; cleanup removes the listener. Note `dismissed` never resets, so once dismissed the notice stays gone for the page lifetime (it is not persisted — a reload brings it back).

**Renders:** `null` unless `isMobile && !dismissed`; otherwise the fixed `z-50` overlay.

- **Called by / rendered by:** `src/app/layout.tsx:49` (inside `ThemeProvider`, above `children`).

---

## `packages/frontend/src/components/ui/button.tsx`

The only shadcn/Base UI primitive in the repo. **Dead code as a whole**: nothing in `src/` or the rest of `packages/frontend` imports it (verified by grep) — every page styles raw `<button>` elements with token utility classes instead. Not a client module (no `"use client"`).

### `buttonVariants` — `packages/frontend/src/components/ui/button.tsx:6`

A `cva` (class-variance-authority) definition. Variants: `default` (primary), `outline`, `secondary`, `ghost`, `destructive`, `link`. Sizes: `default` (h-8), `xs`, `sm`, `lg`, and icon squares `icon`, `icon-xs`, `icon-sm`, `icon-lg`. Defaults: `variant: "default"`, `size: "default"`. The base class string covers focus rings, `aria-invalid` styling, disabled states, and SVG sizing. Exported alongside `Button` but has no consumers.

### `<Button variant={…} size={…} className={…} …props />` — `packages/frontend/src/components/ui/button.tsx:43`

| Prop | Type | Meaning |
|---|---|---|
| `variant?` | `VariantProps<typeof buttonVariants>["variant"]` (default `"default"`) | Visual style |
| `size?` | size union (default `"default"`) | Dimensions |
| `className?` | `string` | Merged via `cn(buttonVariants(...))` |
| `...props` | `ButtonPrimitive.Props` | Forwarded to `@base-ui/react/button` |

Wraps `@base-ui/react/button` with `data-slot="button"` and the cva classes.

- **Called by / rendered by:** nothing — dead code.

---

## `packages/frontend/src/lib/narration.ts`

Shared narration describers for the live team UI. The file header notes these were extracted from a deleted `narration-sidebar` component — "the only parts that were actually used". Pinned by `packages/frontend/tests/unit/narration.test.ts`.

### `NarrationEntry` — `packages/frontend/src/lib/narration.ts:5`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Server id, or a client-synthesized id for thinking/pause entries |
| `agentName` | `string` | Resolved display name (fallback `"agent"`; `"meta-agent"` for client pause events) |
| `isMeta` | `boolean` | `actionType.startsWith("meta_")`, or `true` for client pause events |
| `actionType` | `string` | Raw action type token |
| `description` | `string` | Output of `describeAction` |
| `timestamp` | `string` | ISO time (`executedAt` server-side) |
| `detail?` | `string` | Tool output (file contents, stdout, API body) intended for a collapsible (doc comment references "T8") — currently produced by `extractDetail` but **no component renders it**: `team-dashboard.tsx` shows only `description` |

### `extractDetail(payload)` — `packages/frontend/src/lib/narration.ts:21`

Returns `payload.output` only when it is a non-empty string (the docstring lists `read_file`, `run_command`, `http_fetch`, `github_api` as the tools that store `output`); otherwise `undefined`. The non-string and empty-string cases are pinned by `tests/unit/narration.test.ts`.

- **Called by:** `use-team.ts:157` (SSE entry mapping).

### `truncate(s, n)` — `packages/frontend/src/lib/narration.ts:27`

Internal. Slices to `n` chars and appends the single-char ellipsis `…` (the `agent-pov-view.tsx` copy appends `"..."` instead).

### `describeAction(actionType, payload)` — `packages/frontend/src/lib/narration.ts:36`

Maps an action type + payload to one narration line. Cases, grouped as in the source:

| Group | Types → output |
|---|---|
| a2ax runner | `message_sent` → `messaged {to}: "{content…60}"`; `broadcast_sent` → `broadcast to {peerCount} peers: "{content…50}"`; `multi_action` → `{n} actions this tick`; `agent_thought` → content truncated 80 (fallback "thinking"); `noop` → `no action this tick` |
| v0.1 tools (T1) | `file_read` → `read {path} ({bytes} bytes)`; `file_written` → `wrote {path} ({chars} chars)`; `command_run` → `ran {command} {args…}`; `http_fetched` → `fetched {url} → {status}`; `github_api_called` → `GitHub {method} {path} → {status}`; `awaiting_approval` → `awaiting your approval of a pending action` |
| legacy archetype | `draft_reply` → `drafted reply to '{subject}' · awaiting your review`; `draft_post` → `drafted {platform} post`; `followup_queued` → `scheduled follow-up to {contact}`; `metrics_check` → `checked metrics · {status}`; `research_summary` → `{items.length} items from {source}` |
| client-side team events | `team_paused` → `team paused by user · holding state`; `team_resumed` → `team resumed by user`; `tick_started` → `tick started · {agentsDue} agents due` |
| fallback | `payload.summary` if present, else the snake_case token with `_` → spaces |

- **Called by:** `use-team.ts:155`. **Not** called by `agent-pov-view.tsx`, which carries its own intentionally-separate local variants (`describeAction`/`describeActionNormal`/`describeSubAction`) with longer truncation limits.

---

## `packages/frontend/src/lib/trace.ts`

Pure data shaping for the trace views — no React, no fetches, 311 lines, added by PR #12. Turns the flat trace-event rows streamed by `GET /api/team/[id]/trace` (server-side, the `traceEvents` repo's per-agent `trace.jsonl` entries) into per-tick threads with human-readable, render-ready step rows. Sole consumer: `components/team/trace-view.tsx`. No unit tests pin this module (`packages/frontend/tests/unit/` holds only `narration.test.ts` and `utils.test.ts`).

### `TraceEvent` — `packages/frontend/src/lib/trace.ts:9`

One raw SSE entry, mirroring the backend's `AgentTraceEvent` row (`packages/backend/src/server/store/types.ts:91`): `{ id, agentId, tickId, seq: number, type: string, data: Record<string, unknown>, emittedAt: string }`.

### `TickStatus` — `packages/frontend/src/lib/trace.ts:19`

`"live" | "finished" | "failed" | "awaiting_approval"` — derived from the **last** event of a tick's thread (`tick_finished` → finished, `tick_failed` → failed, `approval_requested` → awaiting_approval, anything else → live).

### `TraceStepRow` — `packages/frontend/src/lib/trace.ts:21`

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Stable React key — the id of the originating event |
| `kind` | union | `tick_started \| llm \| tool \| approval_requested \| decision_applied \| tick_finished \| tick_failed \| unknown` (8 values — note `llm`/`tool` each merge a request/response or started/finished event pair) |
| `glyph` | `string` | `▶` tick start / `↻` resume / `✻` llm / `⏺` tool / `⊗` failed tool or tick / `⏸` approval pause / `✓`/`✗` decision / `■` tick_finished / `•` unknown |
| `label` | `string` | One-line summary, e.g. `read_file({"path":…})` or a quoted thought |
| `detail?` | `string` | Multi-line expandable detail (tool args + `→ result`, full thought, pending list, raw data) |
| `timestamp` | `string` | `emittedAt` of the originating event |
| `durationMs?` | `number` | From `llm_response`/`tool_finished` data |
| `live` | `boolean` | Started but not yet finished — renders pulsing |

### `TickThread` — `packages/frontend/src/lib/trace.ts:44`

`{ tickId, agentId, startedAt, status: TickStatus, outcome?: string, steps: TraceStepRow[] }`. `outcome` is the terminal step's label (e.g. `multi_action · 3 actions · 12.4s`), or the fixed `"waiting for your decision"` for `awaiting_approval`.

### `sortTraceEvents(events)` — `packages/frontend/src/lib/trace.ts:88`

Exported. Non-mutating sort by `emittedAt` then `seq` — `seq` breaks same-millisecond ties within one runner invocation; a resumed tick restarts `seq` but has a later `emittedAt`, so the order is total (the same `(emittedAt, seq)` key the backend `traceEvents` repo sorts its per-agent `trace.jsonl` rows by, `packages/backend/src/server/store/repos/trace-events.ts:48`).

### `buildTickThreads(events)` — `packages/frontend/src/lib/trace.ts:99`

Exported. Sorts, groups by `tickId` (suspend/resume share one `tickId` via the backend's `traceTickId` continuity, so a paused-then-approved tick reads as one thread), builds one `TickThread` per group via `buildThread`, and returns threads sorted oldest-first by `startedAt`.

- **Called by:** `trace-view.tsx:113` (inside a `useMemo`).

### `buildThread(tickId, events)` — `packages/frontend/src/lib/trace.ts:116`

Internal. The pairing state machine. Per event type: `tick_started` → `▶ tick started` or `↻ resumed after approval` (`data.mode === "resume"`); `llm_request` → a **live** `✻ thinking… (model, round N)` row held as `pendingLLM`; `llm_response` → merges into that row (label = quoted thought truncated at 110 chars, else `decided: tool1, tool2`, else `(empty response)`; over-long thoughts move to `detail`) or pushes a standalone row when unpaired; `tool_started` → a live `⏺ tool(compactArgs…80)` row keyed in `pendingTools` by `toolCallId` with pretty-printed args as `detail`; `tool_finished` → merges by `toolCallId` (appends `→ result`/`failed: error` to detail, sets duration, `⊗` on error) or pushes a standalone `tool → outcome` row; `approval_requested` → `⏸ paused — needs approval: <tools>`; `decision_applied` → `✓ you approved <tool>` / `✗ you rejected <tool> — "note"`; `tick_finished` → `■ <actionType> · N actions · Xs` plus `contract ✓/✗` when validation data exists; `tick_failed` → `⊗ tick failed (phase): error`; unknown types → `•` with the type's underscores spaced and raw data as detail. Internal helpers `truncate`/`fmtDuration`/`compactArgs`/`pretty` (`lib/trace.ts:54-84`).

---

## `packages/frontend/src/lib/utils.ts`

### `cn(...inputs)` — `packages/frontend/src/lib/utils.ts:4`

The standard shadcn class helper: `twMerge(clsx(inputs))` — conditional class joining plus Tailwind conflict resolution (e.g. `p-4` + `p-2` → `p-2`, pinned by `tests/unit/utils.test.ts`).

- **Called by:** `packages/frontend/src/components/ui/button.tsx:52` **only** — and since `button.tsx` itself has no consumers, `cn` is live code with no live call path. Every other component concatenates class strings with template literals.

---

## Python backend (FastAPI port) — no symbol reference

The Python port at `backend-py/` reimplements only the **backend** HTTP/domain layer (the `@simple-harmonic/backend` workspace and the `a2ax` runtime). It deliberately stops at the HTTP contract: there is **no Python equivalent for any symbol in this file**. Every component, hook, type, and helper documented above belongs to `packages/frontend/src/` — React client modules (`"use client"`), Next.js App Router pages, and browser-side `fetch`/SSE plumbing — which has no counterpart in the FastAPI rewrite and continues to run unchanged against `/api/*`. The Python port's symbol-level documentation lives in the **backend** reference files (e.g. `docs/reference/*` covering the server API, store, meta-agent, and a2ax modules); see those for the TS→Python symbol correspondence. The only seam the frontend shares with the Python backend is the wire format of the `/api/*` routes, which is held identical by the parity tests.
