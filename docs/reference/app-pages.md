# Reference — app pages (`src/app/`)

Symbol-level reference for every component, helper, and behavior-driving constant in the Next.js App Router page tree (`src/app/` excluding `src/app/api/`, which is covered separately). All routes except the two layouts and `f/[id]/page.tsx` are client components (`"use client"`); there is no server-side data fetching — pages load data with client `fetch` against the app's own `/api/*` routes. Pages compose reusable components from the `@simple-harmonic/frontend` workspace package; the only `@simple-harmonic/backend` import in the whole tree is a single type (`SpawnTeamAgent` in `/new`). See `docs/07-frontend.md` for the chapter-level narrative.

## Route → component tree

```
/ (RootLayout — src/app/layout.tsx; fonts, metadata, THEME_INIT_SCRIPT, ThemeProvider, MobileNotice)
├── (app) AppLayout — src/app/(app)/layout.tsx (Sidebar + <main>)
│   ├── /                    OverviewPage
│   │                          ├── StatCard (×7)
│   │                          └── OverviewTeamNode (recursive, via buildTeamTree)
│   ├── /new                 NewTeamPage
│   │                          ├── SpawningScreen (conditional takeover)
│   │                          ├── AssistantMessage / UserMessage / ErrorMessage / ThinkingIndicator (pkg)
│   │                          ├── ApprovalCard, CredentialRequestCard, ChatInputBar (pkg)
│   │                          └── useChat (pkg hook)
│   ├── /f/[id]              TeamPage (server) → TeamView → <Suspense> → TeamViewInner
│   │                          ├── AgentMessagesView | (ApprovalQueue + TeamDashboard) | AgentPovView (pkg)
│   │                          └── useTeam (pkg hook)
│   ├── /profile             ProfilePage (localStorage only)
│   ├── /settings            SettingsPage
│   │                          ├── SettingsCard (×6)
│   │                          └── ThemeCard (useTheme, pkg)
│   ├── /settings/model      ModelSettingsPage → FieldGroup, TestButton, TestStatusBadge
│   ├── /settings/database   StorageSettingsPage
│   ├── /settings/coding     CodingSettingsPage → FieldGroup
│   ├── /settings/connectors ConnectorsPage → ConnectorCard
│   ├── /settings/skills     SkillsPage → SkillCard, AgentSkillRow
│   └── /settings/platform   PlatformPage → StatusDot, SeverityBadge, LevelBadge
└── (auth)                   (no group layout — root layout only)
    └── /login               LoginPage
```

---

## `src/app/layout.tsx`

Server component. Root layout for every route. Imports from `@simple-harmonic/frontend`: `MobileNotice` (`components/mobile-notice`), `THEME_INIT_SCRIPT` and `ThemeProvider` (`components/theme-provider`). Also imports `./globals.css` (the Tailwind v4 token set) and two Google fonts via `next/font/google`.

### `inter` / `ibmPlexMono` — `src/app/layout.tsx:10,16`

Module-level font constants. `Inter` is bound to the CSS variable `--font-sans` (latin subset, `display: "swap"`); `IBM_Plex_Mono` to `--font-mono` (weights 300/400/500/600, latin, swap). Both variables are attached to `<html className>` so the token set in `globals.css` can reference them.

### `metadata` — `src/app/layout.tsx:23`

Exported Next.js `Metadata`: title `"Simple Harmonic"`, description `"Your company, built by agents, run by agents, managed by agents (with you)"`. No per-page metadata exists anywhere else in the tree, so this is the document title on every route.

### `RootLayout({ children })` — `src/app/layout.tsx:28`

- **Props:** `children: React.ReactNode`.
- **Scripts injected:** a `<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}>` in `<head>`. The script (defined in `packages/frontend/src/components/theme-provider.tsx:113`) runs before paint: reads `localStorage` theme pref, resolves `system` via `prefers-color-scheme`, and toggles the `dark` class on `document.documentElement`. Because it mutates the DOM before hydration, `<html>` carries `suppressHydrationWarning` (commented inline at lines 37–38).
- **Renders:** `<html lang="en">` with both font variables + `h-full antialiased`; `<body className="min-h-full flex flex-col">` wrapping `<ThemeProvider>` → `<MobileNotice />` (small-viewport warning overlay) → `{children}`.
- **Awaits/passes down:** nothing — purely structural.

---

## `src/app/(app)/layout.tsx`

Server component. Layout for the `(app)` route group (every page except `/login`). Single import edge into `@simple-harmonic/frontend`: `Sidebar` (`components/sidebar`).

### `AppLayout({ children })` — `src/app/(app)/layout.tsx:3`

- **Props:** `children: React.ReactNode`.
- **Renders:** `<div className="flex h-screen">` containing `<Sidebar />` and `<main className="flex-1 overflow-hidden flex flex-col">{children}</main>`. No data fetching, no metadata. The `Sidebar` (client component in the package) does its own `/api/teams` + per-team fetches.

---

## `src/app/(app)/page.tsx` — route `/`

Client component. The Overview dashboard: aggregate stat cards plus a recursive team/agent tree. No imports from `@simple-harmonic/frontend` or `@simple-harmonic/backend` — only `next/link` and React. Local interfaces `Team` (lines 6–13: `id`, `name`, `paused`, `tickCount`, `createdAt`, `parentTeamId`), `Agent` (15–22: includes `status: "running" | "paused" | "errored" | "awaiting_approval"` and a client-added `teamId`), and `TeamNode` (24–28: `{ team, agents, children }`).

### `buildTeamTree(teams, agents)` — `src/app/(app)/page.tsx:30`

Pure helper that converts the flat team list into a forest of `TeamNode`. Buckets agents by `teamId` into a `Map`, buckets teams by `parentTeamId ?? null`, then a recursive inner `build(parentId)` assembles nodes top-down starting from `build(null)`. Teams whose parent is missing from the list are silently dropped (they never appear under any key that gets visited). Also used as a pattern (re-implemented, not shared) by the package `Sidebar`.

### `OverviewPage()` — `src/app/(app)/page.tsx:56`

Default export. Loads all teams and their agents once, computes aggregate stats, renders stat cards and the team tree.

- **State:** `teams: Team[]` ([]), `agents: Agent[]` ([]), `loading: boolean` (true).
- **Effects:** one mount-only effect (line 61): `GET /api/teams`, then in parallel (`Promise.all`) `GET /api/team/{id}` for every team, pushing each returned agent into a shared `allAgents` array tagged with its `teamId` (per-team failures are swallowed with `.catch(() => {})`). Sets `agents` and clears `loading`. No polling, no cleanup.
- **API:** `GET /api/teams` (mount), `GET /api/team/[id]` × N (mount, parallel).
- **Derived values (lines 87–93):** `rootTeams` (no `parentTeamId`), `subTeamCount`, `runningRoots`, `totalTicks` (sum of `tickCount`), and hard-coded usage estimates — `tokensUp = totalTicks * 400`, `tokensDown = totalTicks * 1200`, `apiCost = (tokensUp*3 + tokensDown*15)/1_000_000` (i.e. $3/M input, $15/M output). These are fabricated estimates, not measured usage; the cards label them "estimated".
- **Renders:** while loading, a centered `loading...` mono label. Otherwise: H1 "Overview"; a 4-column `StatCard` grid (Teams with running/sub-team subtitle, Total Ticks, Tokens In, Tokens Out); a 3-column grid (API Cost, plus "Agent Spending" and "Income Generated" both hard-coded to `$0.00` / "no integrations yet"); then a "Teams" section — either an empty-state card linking to `/new` ("Create your first team") or the `buildTeamTree` forest rendered with `OverviewTeamNode` at `depth=0`.
- **Navigation:** declarative `<Link>` only (`/new`, and via children `/f/[id]`).

### `OverviewTeamNode({ node, depth })` — `src/app/(app)/page.tsx:154`

Recursive tree row. **Props:** `node: TeamNode`, `depth: number` (drives `marginLeft: depth * 24`).

- **Renders:** a `<Link href={/f/${id}}>` row with a paused/running dot (`bg-paused`/`bg-running`), team name, a `sub-team` mono tag when `depth > 0`, a `running/total agents` count, tick count, and a `paused`/`running` status word. Below the row: a wrap of per-agent chips, each a `<Link href={/f/${teamId}?agent=${agentId}}>` with a status dot colored by agent status (`running` → `bg-running`, `errored` → `bg-error`, `awaiting_approval` → `bg-brand`, else `bg-paused`). Then recurses into `node.children` with `depth + 1`.
- **Navigation:** `<Link>` to the team page; agent chips deep-link to the agent POV via the `?agent=` query param consumed by `TeamViewInner`.

### `StatCard({ label, value, sub })` — `src/app/(app)/page.tsx:215`

Presentational. **Props:** `label: string` (uppercase mono caption), `value: string` (20px number), optional `sub: string` (mono footnote). Renders a bordered `bg-bg-elev` card. No state.

### `fmt(n)` — `src/app/(app)/page.tsx:227`

Number formatter: `>= 1M` → `X.XM`, `>= 1k` → `X.Xk`, else plain string. Duplicated verbatim in `team-view.tsx:279`.

---

## `src/app/(app)/new/page.tsx` — route `/new`

Client component. The meta-agent onboarding chat where the user describes their company and approves a spawn proposal. Import edges: **`@simple-harmonic/backend/lib/meta-agent`** — `type SpawnTeamAgent` (type-only; the lone backend import in the page tree). **`@simple-harmonic/frontend`** — `ApprovalCard` (`components/chat/approval-card`), `CredentialRequestCard` (`components/chat/credential-request-card`), `ChatInputBar` (`components/chat/input-bar`), `AssistantMessage`/`ErrorMessage`/`ThinkingIndicator`/`UserMessage` (`components/chat/message`), `useChat` (`components/chat/use-chat`).

### `SpawningScreen({ agentCount })` — `src/app/(app)/new/page.tsx:17`

Presentational full-screen takeover shown while `POST /api/spawn` is in flight. **Props:** `agentCount: number`. Renders three staggered pulsing brand dots, "Spinning up N agent(s)...", and the subtitle "meta-agent is configuring schedules and tools". No state.

### `NewTeamPage()` — `src/app/(app)/new/page.tsx:33`

Default export. Thin composition over the `useChat` hook, which owns the SSE chat state machine (`POST /api/chat`, handled event kinds `token`/`spawn`/`request_credential`/`done`/`error`; the route additionally emits `modify_agent`, which the hook silently ignores — the edit is applied server-side but no confirmation ever renders — see `packages/frontend/src/components/chat/use-chat.ts`).

- **State:** `spawning: { count: number } | null` (null) — non-null switches the whole page to `SpawningScreen`; `scrollRef: useRef<HTMLDivElement>` — the scrollable transcript container. Everything else (`messages`, `status`, `spawnProposal`, `credentialRequest`, `sendMessage`, `retry`, `clearSpawnProposal`, `clearCredentialRequest`) comes from `useChat()`.
- **Effects:** one auto-scroll effect (line 50) keyed on `scrollKey = messages.length + (spawnProposal ? 1 : 0) + (credentialRequest ? 1 : 0)`; smooth-scrolls `scrollRef` to the bottom whenever a message, proposal, or credential card appears. No cleanup, no interval.
- **API:** `POST /api/spawn` (JSON `{ agents, teamName, cofounderName }` — never the route's optional `parentTeam`/`parentTeamId`/`goal`/`noHarmon` fields, so a planner sub-team proposal always spawns as a root team with an auto-added Harmon cofounder agent) inside `handleSpawn` when the user approves the proposal; `POST /api/chat` indirectly via `useChat.sendMessage`. On spawn success reads `{ teamId }` (the returned `parentTeamId` is ignored) and navigates; on non-OK or thrown error resets `spawning` to null (the chat transcript reappears).
- **Event handlers:** `handleSpawn(payload)` (line 54, typed with `SpawnTeamAgent[]`) — sets `spawning`, posts, redirects; `ApprovalCard.onKeepDiscussing` → `clearSpawnProposal`; `CredentialRequestCard.onSubmit` → `clearCredentialRequest`; `ChatInputBar.onSend` → `sendMessage`; `ErrorMessage.onRetry` → `retry`.
- **Derived status line (lines 81–85):** `statusText` defaults to `"no agents yet"`, becomes `"aligned, ready to spawn"` when a proposal exists, `"thinking..."` while streaming, else `"N messages"` once more than one non-error message exists. Pure display copy in the header.
- **Renders:** header ("New Team" + status text); scrollable transcript mapping messages by role to `AssistantMessage` / `UserMessage` / `ErrorMessage` (an empty assistant message that is currently streaming renders as `null`, with a standalone `ThinkingIndicator` shown instead at line 117); conditional `ApprovalCard` (props: `agents`, `teamName`, `cofounderName`, `onSpawn`, `onKeepDiscussing`, `isSpawning={!!spawning}` — always `false` in practice since `spawning` swaps the whole page); conditional `CredentialRequestCard`; bottom `ChatInputBar` disabled while streaming, with placeholder copy that changes when a proposal is pending ("Push back or tweak the proposal..." vs "Tell your AI cofounder about your company...").
- **Navigation:** `router.push(/f/${teamId})` (`next/navigation` `useRouter`) after successful spawn.

---

## `src/app/(app)/f/[id]/page.tsx` — route `/f/[id]`

### `TeamPage({ params })` — `src/app/(app)/f/[id]/page.tsx:7`

Server component (the only `async` page). **Awaits:** `params` (Next 15+ promise-style `Promise<{ id: string }>`) and passes the resolved `id` down as `teamId` to the client `TeamView`. No metadata export, no data fetching, no other imports — it exists solely to unwrap the dynamic segment.

---

## `src/app/(app)/f/[id]/team-view.tsx`

Client module rendered by `TeamPage`. Import edges into `@simple-harmonic/frontend`: `AgentMessagesView` (`components/team/agent-messages-view`), `AgentPovView` (`components/team/agent-pov-view`), `ApprovalQueue` (`components/team/approval-queue`), `TeamDashboard` (`components/team/team-dashboard`), `useTeam` (`components/team/use-team`).

### `TeamView({ teamId })` — `src/app/(app)/f/[id]/team-view.tsx:271`

Exported wrapper. **Props:** `teamId: string`. Renders `TeamViewInner` inside a bare `<Suspense>` — required because the inner component calls `useSearchParams()`, which would otherwise force the whole route into client-side rendering bailout errors during static generation.

### `TeamViewInner({ teamId })` — `src/app/(app)/f/[id]/team-view.tsx:15`

The team workspace: header (rename, pause/resume, live tick/cost stats) plus one of three POV bodies selected by the `?agent=` search param.

- **POV switch:** `povId = searchParams.get("agent") ?? "team"` (line 60). `"meta"`/`"user"` → `AgentMessagesView`; `"team"` (default) → `ApprovalQueue` + `TeamDashboard`; any other value → looked up in `agents`; found → `AgentPovView`, not found → "Agent not found".
- **State:** from `useTeam(teamId)`: `team`, `agents`, `childTeams`, `childAgents`, `narration`, `loading`, plus actions `togglePause`, `updateAgent`, `updateTeam` (the hook owns `GET /api/team/[id]` mount + 10s polling, 30s heartbeats, the narration SSE stream, and `POST /api/team/[id]/pause`). Locally: `editingName: boolean` (false) — inline rename mode; `draftName: string` ("") — rename input value; `nameInputRef: useRef<HTMLInputElement>` — to `.select()` the input after entering edit mode; `_userName` (`"You"`) — set from localStorage but **never read** (underscore-prefixed; only its setter is used).
- **Effects:** one mount effect (line 36): reads `localStorage["sh:user-profile"]` for `displayName`, then subscribes to `window` `storage` events to track cross-tab profile changes; cleanup removes the listener. (Feeds only the unused `_userName`.)
- **API (direct):** `PATCH /api/team/[id]` on rename blur — body `{ name, metaAgentPrompt, cofounderName }` (the latter two echoed unchanged from the loaded team; this is defensive, not required — the route accepts any subset of those three keys and only 400s when none is present, `packages/backend/src/server/api/team/id/index.ts:64-71`, behind the thin re-export at `src/app/api/team/[id]/route.ts`); on OK calls `updateTeam({ name })` to patch local state. All other traffic goes through `useTeam` and the child package components (approval queue 5s poll, dashboard event feeds, etc.).
- **Derived values (lines 91–95):** `runningCount`; the same fabricated usage estimate as the Overview — `tokensUp = tickCount*400`, `tokensDown = tickCount*1200`, `apiCost = (up*3 + down*15)/1e6` — shown in the header as "X in / Y out · $Z".
- **Event handlers:** team-name `<button>` click → enter edit mode (`setDraftName`, `setEditingName(true)`, deferred `select()`); rename input `onBlur` → PATCH-and-commit (skipped if empty or unchanged), `onKeyDown` Enter → blur (commit), Escape → cancel; pause button (`data-testid="pause-toggle"`) → `togglePause`; `handleAgentUpdated` (line 67, `useCallback`) → forwards `AgentPovView.onUpdated` payloads into `useTeam.updateAgent`; dashboard `onAgentClick` and messages-view `onClose` (below).
- **Renders:** while `loading || !team`, a centered "loading team..." label. Otherwise a header row — editable name (input width tracks `draftName.length` in `ch` units), status dot + "`N` running · tick `T`" (or "`N` agents paused"), token/cost mono line, a "paused by you" indicator (`data-testid="paused-indicator"`) when paused, and the Pause Team / Resume button — followed by the POV body. Props mapped into each child are plain pick-objects from `useTeam` data (agents to `{id, name, role, status[, inFlight, scheduleSeconds]}`, child teams to `{id, name, parentTeamId, paused}`, etc.); `AgentMessagesView` receives `initialPovId` of `"cofounder"` for `?agent=meta` and `"user"` for `?agent=user`.
- **Navigation:** deliberately **not** `router.push` — POV switches use `window.history.pushState(null, "", url)` followed by a manual `window.dispatchEvent(new PopStateEvent("popstate"))` so Next's router updates `useSearchParams` without remounting the page (and without re-running `useTeam`'s mount fetch). Used in two places: `TeamDashboard.onAgentClick` → `/f/{teamId}?agent={id}` (line 230) and `AgentMessagesView.onClose` → `/f/{teamId}` (line 188).

### `fmt(n)` — `src/app/(app)/f/[id]/team-view.tsx:279`

Same M/k number formatter as `src/app/(app)/page.tsx:227` (copy, not shared).

---

## `src/app/(app)/profile/page.tsx` — route `/profile`

Client component. Local-only profile editor ("v0.0 preview: profile is stored locally"). No API calls and no package imports — React only.

### `STORAGE_KEY` — `src/app/(app)/profile/page.tsx:5`

`"sh:user-profile"`. The localStorage key shared (as a literal, not an import) with `team-view.tsx:38` and the package `Sidebar`'s user chip. Value shape: `{ displayName: string, role: string }`.

### `loadProfile()` — `src/app/(app)/profile/page.tsx:12`

SSR-safe reader: returns `{ displayName: "You", role: "Founder" }` when `window` is undefined, on parse failure, or when nothing is stored; otherwise `JSON.parse`s the stored value.

### `saveProfile(profile)` — `src/app/(app)/profile/page.tsx:23`

Writes the profile to localStorage, then dispatches a **synthetic** `StorageEvent` (`new StorageEvent("storage", { key: STORAGE_KEY })`) on `window` so same-tab listeners (sidebar, team view) refresh immediately — native `storage` events only fire in *other* tabs.

### `ProfilePage()` — `src/app/(app)/profile/page.tsx:28`

- **State:** `profile: UserProfile` (defaults, hydrated from localStorage in a mount effect to avoid SSR mismatch), `saved: boolean` (drives a 2-second "Saved" flash).
- **Effects:** mount-only `setProfile(loadProfile())`. No cleanup (the 2s `setTimeout` in `handleSave` is not cleared).
- **API:** none.
- **Event handlers:** controlled inputs update `profile.displayName` / `profile.role`; `handleSave` trims both fields (falling back to "You"/"Founder" when blank), persists via `saveProfile`, re-sets local state to the trimmed values, and flashes `saved`.
- **Renders:** avatar preview (first letter of display name, uppercased, brand-tinted circle) with live name/role; "Display Name" and "Role" labeled inputs; Save button + transient "Saved" badge; footer note about the v0.1 account system.

---

## `src/app/(app)/settings/page.tsx` — route `/settings`

Client component. Settings hub: status-annotated navigation cards plus the theme picker. Import edge into `@simple-harmonic/frontend`: `type ThemePref` and `useTheme` (`components/theme-provider`). Local interface `SafeConfig` (lines 7–14): `model`, `dataDir`, `hasOpenaiKey`, `hasDataDir`, `apiKeySource: "config" | "env" | "codex" | "none"`, `codingBackend: "codex" | "claude-code" | "opencode"`.

### `SettingsPage()` — `src/app/(app)/settings/page.tsx:16`

- **State:** `config: SafeConfig | null` (null), `loading: boolean` (true).
- **Effects:** mount-only `GET /api/settings` → `setConfig`. No polling.
- **API:** `GET /api/settings` once.
- **Renders:** loading label until config arrives, then four sections of `SettingsCard`s:
  - **Configuration** — "LLM Provider" (`/settings/model`; subtitle "`model` · using Codex token|env var|saved key" derived from `apiKeySource`, or "Not configured"; status `warning` when `apiKeySource === "none"`) and "Storage" (`/settings/database`; subtitle is the `dataDir` or "Not configured"; `warning` when `!hasDataDir`).
  - **Agent Tooling** — "Coding Agent" (`/settings/coding`, subtitle prefixed with the active `codingBackend`), "Connectors" (`/settings/connectors`), "Skills" (`/settings/skills`); all hard-coded `status="ok"`.
  - **Platform** — "Platform Health" (`/settings/platform`, `status="ok"`).
  - **Appearance** — `ThemeCard`.
- **Navigation:** `<Link>` via `SettingsCard` only.

### `ThemeCard()` — `src/app/(app)/settings/page.tsx:118`

Theme preference picker. No props. Calls `useTheme()` from the package provider for `{ pref, resolved, setPref }`. A local `options` array (line 121) defines the three `ThemePref` values — `system` ("Match your OS preference"), `light`, `dark`. Renders the current resolved theme ("currently · dark (system)") and a 3-column button grid; clicking a button calls `setPref(value)`, which the provider persists to localStorage and applies as the `.dark` class. Active option gets brand border/tint.

### `SettingsCard({ href, title, subtitle, status })` — `src/app/(app)/settings/page.tsx:164`

Presentational navigation row. **Props:** `href`, `title`, `subtitle` (mono, truncated), `status: "ok" | "warning"` — drives the leading dot color (`bg-running` vs `bg-paused`). Renders a `<Link>` card with a trailing `→` glyph.

---

## `src/app/(app)/settings/model/page.tsx` — route `/settings/model`

Client component, the largest settings page. Codex-subscription panel + model picker. No package imports — React only. Local interfaces: `SafeConfig` (lines 5–11, includes `openaiApiKey`/`openaiBaseUrl` which this page **never edits** — only `model` is ever saved), `CodexModel` (`slug`, `displayName`, `description`), `CodexStatus` (lines 19–28: `found`, `authMode`, `email`, `plan`, `lastRefresh`, `tokenExpiry`, `hasAccessToken`, `models`), `TestStatus`/`TestResult` (idle/testing/ok/error + message).

### `FALLBACK_MODELS` — `src/app/(app)/settings/model/page.tsx:37`

`[{ value: "o4-mini", … "Fast, cost-effective" }, { value: "gpt-4o", … "Balanced capability" }]`. Used as the model option list whenever the Codex status response carries no `models` array (not authenticated, CLI missing, or fetch failed). Behavior-driving: it also feeds `isKnownModel`, which decides whether the "Custom" tile and free-text input are active.

### `ModelSettingsPage()` — `src/app/(app)/settings/model/page.tsx:42`

- **State:** `config: SafeConfig | null`, `codex: CodexStatus | null`, `loading` (true); form state `model: string` (initialized to `cfg.model`) and `customModel: string`; async flags `saving`, `saved` (2s flash), `llmTest: TestResult` (`{status:"idle"}`), `refreshing` (token refresh), `loggingIn` (initial OAuth), `reAuthing` (forced OAuth).
- **Effects:** mount-only parallel `GET /api/settings` + `GET /api/settings/codex` → seeds `config`, `codex`, `model`. No standing polling — polling only happens inside the OAuth handlers below.
- **Derived (lines 71–75):** `modelOptions` = Codex-reported models (`{value: slug, label: slug, desc: description}`) when non-empty, else `FALLBACK_MODELS`; `isKnownModel` = current `model` is in that list. When false the "Custom" tile is highlighted and a free-text input appears (placeholder `ft:gpt-4o:my-org:custom:id`).
- **OAuth-poll logic:** two near-identical implementations.
  - `handleReAuth` (line 117): `confirm()` guard → `POST /api/settings/codex-login?force=true` → `setInterval` polling `GET /api/settings/codex-login` every **2s**; when the response has `authenticated: true`, clears the interval, drops `reAuthing`, and re-fetches `/api/settings` + `/api/settings/codex` in parallel. A `setTimeout` hard-stops the poll after **180s**. The interval is not cleaned up on unmount (only via success or the 180s timeout).
  - The inline "Sign in with OpenAI" `onClick` (lines 266–295, shown when `codex.found` is false): same flow without `?force=true` and driven by `loggingIn` instead of `reAuthing`.
- **Other handlers:** `handleSave` (line 77) — `POST /api/settings` with `{ model: isKnownModel ? model : (customModel || model) }` (nothing else; key/baseUrl/coding fields untouched), replaces `config` with the response, flashes `saved`; `handleRefreshCodex` (line 98) — `POST /api/settings/codex` (token refresh), and on `{ok:true}` re-fetches both GETs; `testLlm` (line 152) — `POST /api/settings/test-llm`, mapping `{ok, model, response}` → `{status:"ok", message:"model: response"}` or `{status:"error", message}`.
- **API summary:** `GET /api/settings`, `GET /api/settings/codex` (mount + after refresh/login), `POST /api/settings` (save), `POST /api/settings/codex` (refresh token), `POST /api/settings/codex-login` (+`?force=true`), `GET /api/settings/codex-login` (2s poll, ≤180s), `POST /api/settings/test-llm`.
- **Renders:** back-arrow `<a href="/settings">` (plain anchor — full page reload, unlike the `<Link>` breadcrumbs on coding/connectors/skills); **Codex Subscription** section — when `codex.found`: a connected card with an "active" badge if `config.apiKeySource === "codex"`, a 2-column grid (Account/Plan/Auth mode/Token expires/Last refresh, each falling back to "unknown"/"never"), Refresh Token and Re-authenticate buttons (mutually disabled while either runs), the literal hint `~/.codex/auth.json`, and contextual copy about quota errors; when not found: a "Not authenticated" card with the Sign in with OpenAI button. **LLM Provider** section — header echoes the key source; `FieldGroup label="Model"` wrapping a 3-column grid of model tiles plus the "Custom" tile and conditional custom input; `TestButton` + `TestStatusBadge` row. Footer Save button with `saved` flash.
- **Navigation:** none programmatic; plain anchor back-link.

### `FieldGroup({ label, hint, children })` — `src/app/(app)/settings/model/page.tsx:401`

Presentational labeled wrapper: 13px medium label, optional mono `hint`, then children. Duplicated verbatim in `settings/coding/page.tsx:316`.

### `TestButton({ status, onClick, label })` — `src/app/(app)/settings/model/page.tsx:421`

Bordered button that disables itself and shows "Testing..." while `status === "testing"`, otherwise the given `label`.

### `TestStatusBadge({ result })` — `src/app/(app)/settings/model/page.tsx:442`

Renders nothing for `idle`/`testing`; green mono "connected · {message}" for `ok`; red mono `message || "failed"` for `error`.

---

## `src/app/(app)/settings/database/page.tsx` — route `/settings/database`

Client component. JSON file-store location: one-click init plus manual data-directory save (PR #16 replaced the Postgres connection panel with this). No package imports. Local types: `SafeConfig` (`dataDir`, `hasDataDir`), `TestStatus`/`TestResult`, and `SetupPhase = "idle" | "running" | "done" | "error"` (line 17).

### `StorageSettingsPage()` — `src/app/(app)/settings/database/page.tsx:19`

- **State:** `config: SafeConfig | null`, `loading` (true); `dataDir: string` (seeded from `cfg.dataDir`; **one** state field bound to **two** inputs — the Initialize data-dir input and the Manual Configuration input stay in lockstep); `saving`/`saved` (2s flash); `writeTest: TestResult`; setup state machine — `setupPhase: SetupPhase` (`"idle"`), `setupSteps: string[]` ([]), `setupError: string | null`.
- **Setup state machine (`handleSetup`, line 76):** `idle → running` (clears steps + error) → `POST /api/settings/setup-db` with `{ dataDir }` → the response's `steps` array (human-readable strings from the setup route — `ensureDataDir()`, e.g. "Data directory ready: …") is stored regardless of outcome → on `ok`: `running → done` and a follow-up `GET /api/settings` re-syncs `config` and `dataDir`; on `ok: false`: `running → error` with `data.error || "Setup failed"`; on thrown fetch: `running → error`, "Request failed". The phase drives the section's status dot: `done` → `bg-running`, `error` → `bg-error`, `running` → pulsing `bg-brand`, `idle` → `bg-fg-faint`. There is no reset back to `idle`; re-running Initialize goes straight to `running`.
- **Other handlers:** `handleSave` (line 43) — no-ops when `dataDir` is empty, else `POST /api/settings` `{ dataDir }`, replaces `config` with the response, flashes `saved`; `testWritable` (line 65) — `POST /api/settings/test-db` (no body; the route round-trips a probe file through the data dir), mapping `{ok}` → "writable" / `{error}` into `writeTest` (rendered inline, not via the model page's badge components).
- **Effects:** mount-only `GET /api/settings`.
- **API:** `GET /api/settings` (mount + after successful init), `POST /api/settings/setup-db`, `POST /api/settings/test-db`, `POST /api/settings`.
- **Renders:** back-arrow plain `<a href="/settings">`; H1 "Storage"; "local JSON file store" mono caption; **Initialize** card — phase dot, explainer ("Creates the data directory skeleton (teams/ and system/). The store is a plain folder of JSON files — no database server required."), Data directory input (placeholder `.simple-harmonic/data`), "Initialize" button (disabled while running or data-dir empty), "Test Writable" button with inline "writable"/error result, then a checkmark list of `setupSteps`, a "Data store ready." line when `done`, and the `setupError` line when set; **Manual Configuration** section — the same-state data-dir input with the current path shown as a hint when `hasDataDir`, and a "Save Path" button (toggling to "Saving...") with `saved` flash.

---

## `src/app/(app)/settings/coding/page.tsx` — route `/settings/coding`

Client component. Chooses and configures the CLI backend behind the `coding_task` tool. No package imports (only `next/link`, React). Local types: `CodingBackend = "codex" | "claude-code" | "opencode"`, `Connector` (`name`, `envVar`, `configured`, `value?`), `BackendStatus` (`installed`, `version`, `authenticated`, `account?`, `plan?`, `connectors`), `BackendConfig` (`model?`, `timeout?`), `CodingData` (`current`, `codingConfig` per backend, `backends` per backend).

### `BACKENDS` — `src/app/(app)/settings/coding/page.tsx:35`

The selectable backend catalog: `codex` ("OpenAI Codex CLI. Uses your ChatGPT subscription via OAuth.", CLI binary `codex`), `claude-code` ("Anthropic Claude Code CLI. Uses your Anthropic API key.", binary `claude`), `opencode` ("Open-source coding agent. Bring your own model and provider.", binary `opencode`). Behavior-driving: the `cli` field is interpolated into the "CLI not installed" warning, and the list defines the radio order and the per-backend model placeholder branches (`o3, gpt-4.1` / `sonnet, opus` / `anthropic/claude-sonnet-4-20250514`).

### `CodingSettingsPage()` — `src/app/(app)/settings/coding/page.tsx:61`

- **State:** `data: CodingData | null`, `loading` (true); `selected: CodingBackend` (`"codex"`, replaced by `d.current` on load); `configs: Record<CodingBackend, BackendConfig>` (empty per-backend objects, replaced by `d.codingConfig`); `saving`/`saved` (2s flash).
- **Effects:** mount-only `GET /api/settings/coding` → seeds all three.
- **Dirty tracking (line 126):** `dirty = selected !== data.current || JSON.stringify(configs) !== JSON.stringify(data.codingConfig)`; the Save button is disabled until something changes.
- **Handlers:** `handleSave` (line 85) — `POST /api/settings` with `{ codingBackend: selected, codingConfig: configs }` (the generic settings route, not a coding-specific one), then re-`GET /api/settings/coding` to refresh statuses and reset dirtiness; `updateBackendConfig(backend, field, value)` (line 105) — immutably patches one field of one backend's config, coercing `timeout` to `Number` and mapping empty strings to `undefined`.
- **API:** `GET /api/settings/coding` (mount + after save), `POST /api/settings` (save).
- **Renders:** breadcrumb (`<Link href="/settings">Settings</Link> / Coding Agent`); intro copy naming the `coding_task` tool; **Backend** section — one large radio-style button per `BACKENDS` entry showing label, an installed badge (green `version` chip) or "not found" chip from `data.backends[value].installed`, description, and a filled/empty radio circle; **Connectors** section scoped to the selected backend — a warning card when the CLI is not installed ("Install the `{cli}` CLI and make sure it is on your PATH"), then read-only cards per connector (configured dot, name, masked `value ?? "not set"`, `envVar` chip); **Configuration** section — `FieldGroup` "Model override" (free text, backend-specific placeholder, "Leave empty to use the CLI default") and "Timeout" (number input 30–1800, hint "seconds, default 300"), both writing through `updateBackendConfig` for the selected backend only (per-backend values are preserved when switching); footer Save (disabled unless `dirty`) + `saved` flash.
- **Navigation:** `<Link>` breadcrumb only.

### `FieldGroup({ label, hint, children })` — `src/app/(app)/settings/coding/page.tsx:316`

Identical copy of the model page's `FieldGroup` (label + optional mono hint + children).

---

## `src/app/(app)/settings/connectors/page.tsx` — route `/settings/connectors`

Client component, read-only. Shows the credential/env-var catalog that agent tools need. No package imports. Local interface `Connector` (lines 6–13): `id`, `name`, `description`, `configured`, `maskedValue?`, `envVar`.

### `ConnectorsPage()` — `src/app/(app)/settings/connectors/page.tsx:15`

- **State:** `connectors: Connector[]` ([]), `loading` (true).
- **Effects:** mount-only `GET /api/settings/connectors` → `data.connectors`.
- **API:** `GET /api/settings/connectors` once. No mutations — the page explicitly directs users to set values "as environment variables in `.env.local`".
- **Renders:** breadcrumb (`Settings / Connectors`); intro copy; a "Not configured" section (paused-amber heading) and an "Active" section (running-green heading), each a stack of `ConnectorCard`s, partitioned by `configured`. Sections are omitted entirely when their partition is empty.

### `ConnectorCard({ connector })` — `src/app/(app)/settings/connectors/page.tsx:90`

Presentational. Status dot (`configured` → `bg-running`, else `bg-paused`), name, `maskedValue ?? "not set"` in mono, the `envVar` as a code chip, and the description paragraph below.

---

## `src/app/(app)/settings/skills/page.tsx` — route `/settings/skills`

Client component. Skill catalog plus the per-agent assignment matrix. No package imports (only `next/link`, React). Local interfaces: `AgentRef` (`id`, `name`, `teamName`), `Skill` (`name`, `description`, `category`, `risk`, `agentCount`, `agents: AgentRef[]`), `TeamAgent` (`id`, `name`, `role`, `tools: string[]`, `teamId`, `teamName`).

### `SkillsPage()` — `src/app/(app)/settings/skills/page.tsx:30`

- **State:** `skills: Skill[]` ([]), `allAgents: TeamAgent[]` ([]), `loading` (true), `saving` (true while any toggle PATCH is in flight — disables **all** checkboxes globally, not per-row).
- **Data loading (`reload`, line 36, `useCallback`):** `GET /api/settings/skills` → `skillData.skills ?? []`; then `GET /api/teams` and, **sequentially** in a `for` loop (unlike the Overview's parallel fetch), `GET /api/team/{id}` per team, flattening every agent into `allAgents` with its team name and `tools ?? []`. A non-array `/api/teams` response or any thrown error short-circuits agent loading but still shows the skill catalog (comment at line 67: "DB unavailable: show skills without agent assignments").
- **Effects:** mount-only `reload()`.
- **Assignment-matrix logic (`toggleTool`, line 78):** given `(agentId, toolName, enabled)`, recomputes the agent's full `tools` array (append or filter), `PATCH /api/settings/skills` with `{ agentId, tools }`; on OK applies the new array to `allAgents` locally **and** calls `reload()` so the catalog's `agentCount`/`agents` chips re-sync. `saving` wraps the whole call in a `finally`.
- **API:** `GET /api/settings/skills`, `GET /api/teams`, `GET /api/team/[id]` × N (mount and after every successful toggle), `PATCH /api/settings/skills` per checkbox change.
- **Derived:** `categories = [...new Set(skills.map(s => s.category))]` — section order follows first appearance in the API response.
- **Renders:** breadcrumb (`Settings / Skills`); intro copy; one section per category containing `SkillCard`s filtered to it; then, only when agents loaded, a "Per-agent assignments" section of `AgentSkillRow`s.

### `SkillCard({ skill })` — `src/app/(app)/settings/skills/page.tsx:168`

Presentational catalog entry: mono skill name; a risk badge — red `bg-error/15 text-error` when `risk === "destructive"`, green otherwise (any non-destructive risk string renders green); description; "N agent(s)" count; and, when assigned, a wrap of chips "`agentName` (`teamName`)".

### `AgentSkillRow({ agent, skills, onToggle, saving })` — `src/app/(app)/settings/skills/page.tsx:208`

One collapsible row per agent. **Props:** `agent: TeamAgent`, `skills: Skill[]` (full catalog), `onToggle(agentId, toolName, enabled)`, `saving` (disables checkboxes). **State:** `expanded: boolean` (false) — toggled by the header button, which shows agent name, team name, "N skill(s)" count, and a chevron SVG that rotates 180° when open. When expanded: a 2-column grid of labeled checkboxes, one per catalog skill, `checked = agent.tools.includes(skill.name)`; `onChange` calls `onToggle(..., !enabled)`; destructive skills get a red `!` marker next to the name.

---

## `src/app/(app)/settings/platform/page.tsx` — route `/settings/platform`

Client component. Operator-facing platform status setter plus the infrastructure event report. No package imports. Local interfaces: `InfraEvent` (`id`, `level`, `severity`, `source`, `message`, `agentId`, `teamId`, `createdAt`), `InfraReport` (`events`, `total`, `infraCount`, `toolCount`), `PlatformStatusData` (`status: "healthy" | "degraded" | "maintenance"`, `message`).

### `PlatformPage()` — `src/app/(app)/settings/platform/page.tsx:28`

- **State:** `report: InfraReport | null`, `platformStatus: PlatformStatusData | null`, `loading` (true), `statusSaving` (disables the three status buttons), `acknowledging: Set<string>` — ids of events whose dismiss POST is in flight (per-event disable; `acknowledgeAll` fills it with every id).
- **Effects:** mount-only `fetchData` (`useCallback`, line 35) — parallel `GET /api/infra-report` + `GET /api/settings/platform-status`. No polling, no cleanup; all fetch failures are silent.
- **Handlers:**
  - `setStatus(status, message?)` (line 54) — `PUT /api/settings/platform-status` with `{ status, message }`, then optimistically sets local state (`message ?? null`). The three buttons call it with just the status string, so `message` is always cleared from the UI. The page copy documents the behavior contract: "When set to degraded or maintenance, all agents are told to reduce non-essential work."
  - `acknowledgeEvent(id)` (line 73) — adds the id to `acknowledging`, `POST /api/infra-report` `{ eventIds: [id] }`, then removes the event from `report.events` and decrements `total` locally (does **not** adjust `infraCount`/`toolCount`).
  - `acknowledgeAll` (line 97) — `POST /api/infra-report` with every event id, then resets the report to all-zero.
- **API:** `GET /api/infra-report`, `GET /api/settings/platform-status` (mount, parallel); `PUT /api/settings/platform-status`; `POST /api/infra-report` (acknowledge one or all).
- **Renders:** **Platform Status** card — `StatusDot` + capitalized status + optional message, explainer copy, and a three-button row (`healthy` / `degraded` / `maintenance`; active one filled brand); **Infrastructure Report** — header with a "Dismiss all" text button when events exist; a "N infra, M tool (T total unacknowledged)" summary; per-event cards with `SeverityBadge`, `LevelBadge`, source, localized timestamp, mono message, and a per-event "dismiss" button (disabled while in `acknowledging`); empty state "No unacknowledged events"; **Telemetry** — static copy noting telemetry is controlled per-team and that agent/team operational events are always recorded.
- **Navigation:** none (no breadcrumb or back link — the only settings subpage without one).

### `StatusDot({ status })` — `src/app/(app)/settings/platform/page.tsx:247`

Dot colored `bg-running` (healthy), `bg-paused` (degraded), or `bg-errored` (anything else, i.e. maintenance). Note: `bg-errored` does not correspond to any token in `src/app/globals.css` (only `--color-error` exists), so the maintenance dot renders without a background color.

### `SeverityBadge({ severity })` — `src/app/(app)/settings/platform/page.tsx:253`

Uppercased severity chip: `error` → `text-errored bg-errored/10` (same nonexistent `errored` token), `warning` → paused-amber tint, anything else → faint on `bg-bg`.

### `LevelBadge({ level })` — `src/app/(app)/settings/platform/page.tsx:267`

Chip rendering the raw `level` string: `infra` → brand tint, anything else (i.e. `tool`) → muted.

---

## `src/app/(auth)/login/page.tsx` — route `/login`

Client component. Operator sign-in. The `(auth)` group has no layout of its own, so this renders inside only `RootLayout` — no sidebar. No package imports.

### `LoginPage()` — `src/app/(auth)/login/page.tsx:6`

- **State:** `email: string` ("") — collected for the form but **never sent**; `password: string` (""); `error: string | null`; `loading: boolean` (drives "Signing in..." and disables submit).
- **Effects:** none.
- **API:** `POST /api/login` on form submit with body `{ password }` only (line 21 — the email field is cosmetic in the v0.0 single-operator-password model).
- **Event handlers:** `handleSubmit` (line 13) — prevents default, clears `error`, posts; on OK → `router.push("/")`; on `503` → the hard-coded message "Operator login is not configured on this server."; on other failures → the response body's `error` or "Invalid password"; on network error → "Could not reach the server. Try again."; `finally` clears `loading`. Controlled `onChange` handlers for both inputs.
- **Renders:** centered 360px card: "Simple Harmonic" wordmark + "Sign in to continue"; Email input (`type="email"`, `autoComplete="email"`, not `required`); "Operator password" input (`type="password"`, `required`); inline `role="alert"` error line; submit button disabled while loading **or while the password is empty**; footer note "v0.0 preview: single shared operator password".
- **Navigation:** `router.push("/")` (`next/navigation`) on success.

---

## Cross-file notes

- **Import edges into `@simple-harmonic/frontend`:** `layout.tsx` (MobileNotice, ThemeProvider, THEME_INIT_SCRIPT), `(app)/layout.tsx` (Sidebar), `new/page.tsx` (ApprovalCard, CredentialRequestCard, ChatInputBar, message components, useChat), `f/[id]/team-view.tsx` (AgentMessagesView, AgentPovView, ApprovalQueue, TeamDashboard, useTeam), `settings/page.tsx` (useTheme, ThemePref). All other pages use only React + `next/link`/`next/navigation`.
- **Import edges into `@simple-harmonic/backend`:** exactly one — `type SpawnTeamAgent` from `@simple-harmonic/backend/lib/meta-agent` in `new/page.tsx:3` (type-only, erased at build time).
- **Duplicated helpers:** `fmt` (`(app)/page.tsx:227` ≡ `team-view.tsx:279`), `FieldGroup` (`settings/model/page.tsx:401` ≡ `settings/coding/page.tsx:316`), the token-estimate formula (`ticks*400` in / `ticks*1200` out / `$3+$15 per M`) in Overview and TeamViewInner, and the `"sh:user-profile"` localStorage key as a literal in three places.
- **Navigation styles in use:** `<Link>` (overview, settings hub, breadcrumbs), `router.push` (`/new` after spawn, `/login` after sign-in), plain `<a href>` full-reload back-arrows (model and database pages), and `pushState` + synthetic `popstate` (team-view POV switching, to avoid remounting). The sidebar's "Log out" (package code) additionally uses `window.location.href`.

---

## Python backend (FastAPI port) — symbol reference

**Not applicable.** The Python FastAPI port (`backend-py/`) is a port of the *backend* and *a2ax* packages only — the HTTP API and agent runtime. The `src/app/` page tree documented here is the Next.js App Router frontend (React client/server components, `next/link`, `next/navigation`); it has no Python equivalent. The pages keep talking to the same `/api/*` HTTP contract regardless of whether those routes are served by the TypeScript or the Python backend (the cutover is env-gated and transparent to the frontend), so nothing in this file changes for the port. For Python symbol references see the backend/a2ax/http-api reference files, not this one.
