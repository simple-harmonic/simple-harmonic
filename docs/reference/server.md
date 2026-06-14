# Reference — backend server layer (`packages/backend/src/server/`)

This is the symbol-level reference for the I/O-bearing service layer of Simple Harmonic, excluding the `tools/` subdirectory (documented separately) and excluding on-disk layout detail (see [docs/02-data-model.md](../02-data-model.md)). Every exported symbol in the fifteen top-level modules plus the `store/` subtree (the JSON file store that replaced Postgres/Drizzle in PR #16) has an entry; non-exported helpers with real logic get full entries too. The fifteen include `llm.ts` (PR #14, LLM provider cascade) and `trace.ts` (PR #12, play-by-play trace sink). These modules are consumed by the extracted route handlers under `packages/backend/src/server/api/**` (PR #13 — the Next.js routes in `src/app/api/` are two-line re-exports of these handlers, and the standalone node:http host in `packages/backend/src/server/standalone/` serves the same handlers), the edge proxy gate (`src/proxy.ts`), server startup instrumentation (`src/instrumentation.ts`), the tool implementations in `server/tools/`, and `scripts/seed-demo.ts`. The chapter-level narrative lives in [docs/04-server-layer.md](../04-server-layer.md).

Persistence is a single-process, single-writer JSON file store on local disk (`packages/backend/src/server/store/`), rooted at `<dataDir>` (default `join(process.cwd(), ".simple-harmonic", "data")`). There is no database, no connection pool, and no schema DDL: all IO is synchronous (`node:fs`), JSON objects are written atomically (temp file + rename) and JSONL logs are appended one line at a time. The eight domain repos (`teams`, `agents`, `actionLog`, `appEvents`, `approvals`, `platformStatus`, `spend`, `traceEvents`) wrap the sync primitives in `async` methods so existing `await repo.x()` call sites are unchanged, and the row types in `store/types.ts` match the old Postgres row shapes field-for-field (names, optionality, `Date` vs `string`) so API JSON responses are unchanged.

```
src/instrumentation.ts ──────────────► apollo.load()
src/proxy.ts (edge) ─────────────────► operator-auth (isOperatorAuthorized, isProductionRuntime)

packages/backend/src/server/api/      (Next routes in src/app/api/ are thin re-exports;
                                       the standalone host serves the same handlers)
  login ─────────────────────────────► operator-auth (constantTimeEqual, sha256Hex, OPERATOR_COOKIE)
  tick ──────────────────────────────► operator-auth (isCronAuthorized), llm (resolveLLM), a2ax (getA2AX),
  │                                    config (getApiKeySource), app-events (emit/query/format/status),
  │                                    spend (cap+ledger), trace (sink+prune),
  │                                    store (teams/agents/actionLog/approvals)
  chat ──────────────────────────────► planner-deps (buildPlannerDeps), app-events (emitAppEvent),
  │                                    store (teams/agents)
  seed ──────────────────────────────► a2ax (getA2AX), store (teams/agents)
  infra-report ──────────────────────► app-events (queryAppEvents), store (appEvents.acknowledge)
  team/id/messages ──────────────────► a2ax (getA2AX), store (teams/agents)
  settings ──────────────────────────► config (getSafeConfig, setConfig, getConfig)
  settings/setup-db, test-db ────────► config, store (ensureDataDir)
  settings/test-llm ─────────────────► config, llm (resolveLLMCandidates), codex-auth, proxy-fetch
  settings/codex, codex-login,
  settings/coding ───────────────────► codex-auth (+ config for coding)
  settings/connectors ───────────────► connectors, validation
  settings/credentials ──────────────► apollo (set)
  settings/telemetry ────────────────► app-events (invalidateTelemetryCache), store (teams)
  (most other handlers) ─────────────► store repos directly

standalone/{server,main}.ts ─────────► operator-auth (isOperatorAuthorized, isProductionRuntime)
server/tools/ (other author) ────────► connectors, custom-tools, team-tree, app-events,
                                       proxy-fetch, config, validation (transitively), store
scripts/seed-demo.ts ────────────────► connectors (saveConnector), custom-tools (saveCustomToolFile),
                                       store

Internal wiring:
  config ──► codex-auth (API-key fallback)        store/data-dir ──► config (dataDir)
  planner-deps ──► config + codex-auth + proxy-fetch
  connectors / custom-tools ──► validation + tools/sandbox (toolsRoot)
  a2ax ──► store/data-dir (teamsRoot) + @simple-harmonic/a2ax/adapters/json-file (JsonFileTransport)
  app-events / team-tree / spend ──► store (repos)
  store/index ──► repos/* + data-dir + index-cache;  repos ──► fs-store + data-dir + index-cache + serialize + types
  llm ──► config + lib/meta-agent (cascade + codex/anthropic adapters)
  trace ──► app-events (scrubPII) + store (traceEvents)
```

---

## `packages/backend/src/server/a2ax.ts`

Singleton wrapper around the `@simple-harmonic/a2ax` protocol package.

### Module state: `instance` — `packages/backend/src/server/a2ax.ts:9`

`let instance: A2AX | null = null` — module-level singleton holding the one `A2AX` instance per process. Reset at runtime only via `resetA2AXForTests()`.

### `getA2AX(): A2AX` — `packages/backend/src/server/a2ax.ts:11`

Lazily constructs and caches the process-wide `A2AX` instance. On first call it builds a **`JsonFileTransport`** (from `@simple-harmonic/a2ax/adapters/json-file`) over `teamsRoot()` (`store/data-dir.ts:42` — `<dataDir>/teams`) and constructs `A2AX` with `maxContextMessages: 20` and `defaultExpiryMs: 7 * 24 * 60 * 60 * 1000` (7 days). Subsequent calls return the cached instance — note the transport captures the `teamsRoot()` path resolved at first call, so tests that repoint `SH_DATA_DIR`/`setDataDir` between cases must call `resetA2AXForTests()` to rebuild. There is no `db()` and no Drizzle adapter; the transport persists each team's a2ax state under that team's folder (`<teamDir>/messages/{log.jsonl, reads.jsonl, channels.json, members.json, tasks.json, cards.json, tokens.json}`) and hydrates it into memory by walking the team tree once.

- **Calls:** `teamsRoot()` (`store/data-dir.ts:42`), `new JsonFileTransport` (`packages/a2ax/src/adapters/json-file.ts:44`), `new A2AX`
- **Called by:** `packages/backend/src/server/api/tick.ts:140` (also as a type at `:331`, `:586`), `packages/backend/src/server/api/seed.ts:51`, `packages/backend/src/server/api/team/id/messages.ts:20`, `:77`, `packages/backend/src/server/api/team/id/conversations.ts:23`, `packages/backend/src/server/api/team/id/agent-hub.ts:22`, `packages/backend/src/server/api/team/id/tasks.ts:23`; tests `packages/backend/tests/unit/a2ax.test.ts`, mocked in `api-messages.test.ts`, `api-seed.test.ts`, `api-tick.test.ts`

### `resetA2AXForTests(): void` — `packages/backend/src/server/a2ax.ts:27`

Drops the cached `instance` so the next `getA2AX()` rebuilds the transport against the current `teamsRoot()`. New in PR #16 — needed because the transport now binds to a data-dir path at construction, so tests that swap data dirs between cases must reset the singleton.

- **Calls:** nothing
- **Called by:** test-only — `packages/backend/tests/unit/a2ax.test.ts`, `packages/backend/tests/unit/api-tick.test.ts`, `packages/backend/tests/helpers/store.ts`

---

## `packages/backend/src/server/apollo.ts`

File-backed AES-256-GCM encrypted secrets vault ("Apollo" is internal branding, not an LLM client). Secrets live in `<root>/.apollo/vault.enc` and are decrypted into `process.env` at server start.

### Constants — `packages/backend/src/server/apollo.ts:36`

| Constant | Value | Meaning |
|---|---|---|
| `APOLLO_DIR` | `".apollo"` | Vault directory under the project root |
| `VAULT_FILE` | `"vault.enc"` | Encrypted vault blob |
| `MASTER_KEY_FILE` | `"master.key"` | Auto-generated master key file |
| `ALGO` | `"aes-256-gcm"` | Cipher |
| `SALT_FILE` | `"salt"` | Per-install random scrypt salt |
| `LEGACY_SALT` | `"simple-harmonic-apollo-v1"` | Fixed salt fallback for pre-salt-file vaults |
| `SALT_LEN` / `KEY_LEN` / `IV_LEN` / `TAG_LEN` | 16 / 32 / 12 / 16 | Byte sizes; vault layout is `[iv (12)][auth tag (16)][ciphertext]` |

### Module state: `projectRoot`, `cache` — `packages/backend/src/server/apollo.ts:55`

`projectRoot` (line 55) defaults to `process.cwd()` and is overridden by `init()`. `cache: Record<string, string>` (line 58) is the in-memory plaintext secret map, populated by `load()` and mutated by `set()`/`remove()`. `get()`, `listKeys()`, and `has()` read only this cache, never disk.

### `init(root: string): void` — `packages/backend/src/server/apollo.ts:67`

Sets `projectRoot`. Pure setter; used by tests and non-standard layouts. Does not clear `cache`.

- **Calls:** nothing
- **Called by:** test-only — `packages/backend/tests/unit/apollo.test.ts:21,72,86,102,159,161,188`

### `load(): { count: number }` — `packages/backend/src/server/apollo.ts:76`

Decrypts the whole vault into `cache`, then copies each entry into `process.env` **only when the env var is not already set** ("operator always wins", line 91). Returns the number of env vars actually set. Returns `{ count: 0 }` when no master key or no vault file exists; on a decrypt failure it logs `[apollo] Failed to decrypt vault:` to `console.error` and returns `{ count: 0 }` (never throws). Idempotent — safe to call repeatedly.

- **Calls:** `resolveMasterKey`, `decrypt` (→ `deriveKey`, `resolveSalt`), `readFileSync`, `existsSync`
- **Called by:** `src/instrumentation.ts:14` (server startup, nodejs runtime only); tests `apollo.test.ts:73,87,103,146,189`

### `set(key: string, value: string): void` — `packages/backend/src/server/apollo.ts:110`

Stores a secret with immediate persistence: updates `cache` and `process.env`, then read-merge-re-encrypt-writes the vault (`{ ...existing, ...cache }`). A corrupted existing vault is treated as empty (start fresh from the cache). Creates `.apollo/` and auto-generates the master key on first use via `ensureMasterKey()`. The write path also migrates the install to a random per-install salt via `encrypt` → `ensureSalt`.

- **Calls:** `ensureMasterKey`, `decrypt`, `encrypt`, `mkdirSync`, `writeFileSync`
- **Called by:** `packages/backend/src/server/api/settings/credentials.ts:23` (the Harmon credential-request card); tests `apollo.test.ts` (many)

### `remove(key: string): void` — `packages/backend/src/server/apollo.ts:139`

Deletes a secret from `cache`, `process.env`, and the vault. No-ops when there is no master key or vault file; vault rewrite is best-effort (a corrupted vault is silently left alone).

- **Calls:** `resolveMasterKey`, `decrypt`, `encrypt`, `writeFileSync`
- **Called by:** test-only — `apollo.test.ts:97`

### `get(key: string): string | null` — `packages/backend/src/server/apollo.ts:162`

Cache-only read; returns `null` when absent. Does NOT touch disk — `load()` must run first.

- **Calls:** nothing
- **Called by:** test-only — `apollo.test.ts:109,110`

### `listKeys(): string[]` — `packages/backend/src/server/apollo.ts:169`

`Object.keys(cache)` — key names only, no values.

- **Calls:** nothing
- **Called by:** test-only — `apollo.test.ts:122`

### `has(key: string): boolean` — `packages/backend/src/server/apollo.ts:176`

True when the key is in `cache` **or** truthy in `process.env` (the only reader that consults env).

- **Calls:** nothing
- **Called by:** test-only — `apollo.test.ts:115,116`

### `mask(value: string): string` — `packages/backend/src/server/apollo.ts:183`

Display masking: `""` for empty, `"••••••••"` when length ≤ 8, else `first4••••last4`. (Same logic is duplicated privately as `maskSecret` in `config.ts:115`.)

- **Calls:** nothing
- **Called by:** test-only — `apollo.test.ts:128-130`

### `deriveKey(masterKey: string, salt: Buffer): Buffer` (internal) — `packages/backend/src/server/apollo.ts:193`

`scryptSync(masterKey, salt, 32)` — synchronous scrypt KDF producing the 32-byte AES key.

- **Calls:** `node:crypto.scryptSync`
- **Called by:** `encrypt` (`apollo.ts:201`), `decrypt` (`apollo.ts:224`)

### `encrypt(data: Record<string, string>, masterKey: string): Buffer` (internal) — `packages/backend/src/server/apollo.ts:197`

JSON-stringifies the secret map and AES-256-GCM-encrypts it with a fresh random 12-byte IV. Key is derived with the salt from `ensureSalt()` (creating a per-install random salt on first write). Output layout: `[iv (12)][auth tag (16)][ciphertext]`.

- **Calls:** `deriveKey`, `ensureSalt`, `randomBytes`, `createCipheriv`
- **Called by:** `set` (`apollo.ts:130`), `remove` (`apollo.ts:152`)

### `decrypt(raw: Buffer, masterKey: string): Record<string, string>` (internal) — `packages/backend/src/server/apollo.ts:216`

Splits the blob per the layout above, verifies the GCM auth tag, and JSON-parses the plaintext. Throws `"Vault file too short to be valid"` for blobs under 28 bytes; throws on tag mismatch or bad JSON (callers catch). Key derivation uses `resolveSalt()`, which falls back to the legacy fixed salt, so pre-salt vaults still decrypt.

- **Calls:** `deriveKey`, `resolveSalt`, `createDecipheriv`
- **Called by:** `load` (`apollo.ts:85`), `set` (`apollo.ts:122`), `remove` (`apollo.ts:150`)

### `resolveMasterKey(): string | null` (internal) — `packages/backend/src/server/apollo.ts:254`

Master key priority: `APOLLO_MASTER_KEY` env var, then the trimmed contents of `.apollo/master.key`. Returns `null` if neither exists (first-time setup not yet triggered). Read-only.

- **Calls:** `existsSync`, `readFileSync`
- **Called by:** `load` (`apollo.ts:77`), `remove` (`apollo.ts:143`), `ensureMasterKey` (`apollo.ts:272`)

### `ensureMasterKey(): string` (internal) — `packages/backend/src/server/apollo.ts:271`

Returns the existing master key or generates one: 32 random bytes hex-encoded, written to `.apollo/master.key` with mode `0600` plus a trailing newline, logging a one-line notice. Happens once per machine.

- **Calls:** `resolveMasterKey`, `randomBytes`, `mkdirSync`, `writeFileSync`
- **Called by:** `set` (`apollo.ts:111`)

### `resolveSalt(): Buffer` / `ensureSalt(): Buffer` (internal) — `packages/backend/src/server/apollo.ts:293,307`

`resolveSalt` (read path) returns `.apollo/salt` if present, else `Buffer.from(LEGACY_SALT)` — so legacy vaults keep decrypting. `ensureSalt` (write path) returns the existing salt or generates 16 random bytes, persisting them with mode `0600`; the next vault write thereby migrates a legacy install to a random salt.

- **Calls:** `existsSync`, `readFileSync`, `randomBytes`, `mkdirSync`, `writeFileSync`
- **Called by:** `decrypt` (`apollo.ts:224`) / `encrypt` (`apollo.ts:201`)

### Internal helpers (trivial)

- `apolloDir(): string` (`apollo.ts:244`) — `join(projectRoot, ".apollo")`.

---

## `packages/backend/src/server/app-events.ts`

App-event telemetry pipeline: emit (with rate limiting, PII scrubbing, telemetry opt-out), query, prompt formatting, and the platform-status singleton. PR #12's only change to this file was exporting `scrubPII` (previously private) so the agent-trace sink shares it.

### `AppEventLevel` (type) — `packages/backend/src/server/app-events.ts:28`

`"agent" | "team" | "tool" | "infra"`. Semantics: `agent` = single-agent issues (agents self-correct); `team` = composition/goal/coordination (lead/Harmon corrects); `tool` = tool bugs (agents see it, founder fixes); `infra` = platform-level, founder-only, never agent-visible.

### `AppEvent` (interface) — `packages/backend/src/server/app-events.ts:30`

| Field | Type | Notes |
|---|---|---|
| `severity` | `"info" \| "warning" \| "error"` | required |
| `level?` | `AppEventLevel` | defaults to `"agent"` in `emitAppEvent` |
| `source` | `string` | e.g. `"tick"`, `"tool"`, `"api"` |
| `message` | `string` | PII-scrubbed before persistence |
| `teamId?` | `string` | forced to `null` for `infra` events |
| `agentId?` | `string` | rate-limit key |
| `metadata?` | `Record<string, unknown>` | persisted as an opaque JSON blob |

### Module state: `rateCounts` + `RATE_LIMIT`/`RATE_WINDOW_MS` — `packages/backend/src/server/app-events.ts:44`

`RATE_LIMIT = 50`, `RATE_WINDOW_MS = 3600_000` (1 h). `rateCounts: Map<string, { count, windowStart, limited }>` keyed by `agentId` tracks per-agent emission counts per process. Never pruned — entries reset lazily when a stale window is touched again.

### `checkRateLimit(agentId: string | undefined): boolean` (internal) — `packages/backend/src/server/app-events.ts:48`

Returns `true` (allow) for system events with no `agentId`. Otherwise increments the agent's window counter, resetting it when the 1-hour window has elapsed. The 51st event in a window is allowed through once (so a final "rate_limited" event can be written, flagging `limited = true`); everything after is dropped (`false`).

- **Calls:** `Date.now`
- **Called by:** `emitAppEvent` (`app-events.ts:146`)

### `PII_PATTERNS` (internal constant) — `packages/backend/src/server/app-events.ts:75`

Eight regexes replaced with `[REDACTED]`: OpenAI-style `sk-…` keys (20+ chars), GitHub `ghp_`/`gho_` tokens (36+), Slack `xoxb-`/`xoxp-` tokens, `Bearer <20+ chars>` (case-insensitive), generic base64-ish strings of 32+ chars following `=` or `:` (lookbehind), and email addresses.

### `scrubPII(message: string): string` — `packages/backend/src/server/app-events.ts:91`

Sequentially applies every `PII_PATTERNS` regex with global replace. Pure string transform. **Exported since PR #12** — previously a private helper — so the agent-trace sink shares the same PII guardrails as app events.

- **Calls:** `String.replace`
- **Called by:** `emitAppEvent` (`app-events.ts:143`); `sanitizeValue` in `packages/backend/src/server/trace.ts:121`

### Module state: `telemetryCache` + `TELEMETRY_CACHE_TTL_MS` — `packages/backend/src/server/app-events.ts:103`

`Map<teamId, { enabled, checkedAt }>` with a 60 s TTL, avoiding a store read on every emit.

### `isTelemetryEnabled(teamId: string): Promise<boolean>` (internal) — `packages/backend/src/server/app-events.ts:106`

Returns the cached flag when fresh (< 60 s); otherwise reads the team's `telemetryEnabled` via `teams.byId(teamId)` (defaulting to `true` when the team is missing) and caches the result. **Fails open**: any read error returns `true` without caching.

- **Calls:** `teams.byId` (`store/repos/teams.ts:48`)
- **Called by:** `emitAppEvent` (`app-events.ts:159`)

### `invalidateTelemetryCache(teamId: string): void` — `packages/backend/src/server/app-events.ts:122`

Deletes the team's entry from `telemetryCache` so the next emit re-reads the store. Call when the setting changes.

- **Calls:** `Map.delete`
- **Called by:** `packages/backend/src/server/api/settings/telemetry.ts` (PR #13 extracted the handler; the Next route is a thin re-export)

### `emitAppEvent(event: AppEvent): void` — `packages/backend/src/server/app-events.ts:139`

Fire-and-forget event write with four guardrails: (1) message is PII-scrubbed; (2) per-agent rate limiting via `checkRateLimit` — the one allowed over-limit event has its message replaced with a fixed "Rate limited: …" string; (3) `infra` events always get `teamId = null` (platform-wide); (4) for `tool`/`infra` events with a `teamId`, the write is deferred behind an async `isTelemetryEnabled` check and skipped when the team opted out. All failure paths (store not yet initialized, write rejection) are swallowed — emission can never break a caller.

- **Calls:** `scrubPII`, `checkRateLimit`, `isTelemetryEnabled`, `doInsert`
- **Called by:** `packages/backend/src/server/api/chat.ts:113`; `packages/backend/src/server/api/tick.ts:149` (LLM cascade `onFallback` warning, PR #14), `:173` (spend ledger unreadable), `:179` (daily cap reached), `:598` (`failAgent` error record)

### `doInsert(level, teamId, event, message): void` (internal) — `packages/backend/src/server/app-events.ts:172`

Calls `appEvents.insert({...})` on the store repo (the call is **synchronous** — the repo appends one JSONL line and fills `id`/`acknowledgedAt`/`createdAt`), defaulting `agentId`/`metadata` to `null`. A thrown write error is logged to `console.error` (`[app-events] Failed to write event:`) and swallowed. The repo routes team-scoped events to the owning team's `events.jsonl` and `infra`/team-less events to `system/events.jsonl`.

- **Calls:** `appEvents.insert` (`store/repos/app-events.ts:52`)
- **Called by:** `emitAppEvent` (`app-events.ts:161`, `:166`)

### `EventQuery` (interface) — `packages/backend/src/server/app-events.ts:204`

| Field | Type | Notes |
|---|---|---|
| `teamId?` | `string` | exact match |
| `severity?` | `"info" \| "warning" \| "error"` | |
| `level?` | `AppEventLevel` | |
| `source?` | `string` | |
| `since?` | `Date` | `createdAt >= since` |
| `limit?` | `number` | default 20 |
| `includeInfra?` | `boolean` | default false — infra events excluded unless true (founder report) |
| `unacknowledgedOnly?` | `boolean` | filters `acknowledgedAt IS NULL` |

### `queryAppEvents(query: EventQuery = {}): Promise<AppEvent[]>` — `packages/backend/src/server/app-events.ts:219`

Thin pass-through to `appEvents.query(...)` on the store repo (return type is the store's `AppEvent` row, re-exported as `StoreAppEvent`). The repo reads the relevant `events.jsonl` files (one team's file when `teamId` is set, else every team's plus `system/events.jsonl`), applies the filters in memory, sorts newest-first by `createdAt`, and caps at `limit ?? 20`. By default it excludes `infra` events so agent-facing callers never receive them; `includeInfra: true` lifts that. Read errors propagate to the caller.

- **Calls:** `appEvents.query` (`store/repos/app-events.ts:71`)
- **Called by:** `packages/backend/src/server/api/tick.ts:369`, `packages/backend/src/server/api/infra-report.ts`, `packages/backend/src/server/tools/observe.ts:54`

### `formatEventsForPrompt(events: StoreAppEvent[]): string | undefined` — `packages/backend/src/server/app-events.ts:241`

Formats event rows into `[HH:MM:SS] SEV [level] [source] (agent xxxxxxxx): message` lines for tick-prompt injection. Defensively skips `infra` rows (even though `queryAppEvents` already excludes them by default); `tool` events older than 24 h are dropped and replaced by a single trailing `"N known tool issue(s) (under review)"` summary line. Returns `undefined` for an empty input or when everything was filtered.

- **Calls:** `Date.now`, string formatting
- **Called by:** `packages/backend/src/server/api/tick.ts:380`, `packages/backend/src/server/tools/observe.ts:72`

### `PlatformStatusValue` (type) — `packages/backend/src/server/app-events.ts:278`

`"healthy" | "degraded" | "maintenance"`.

### `PlatformStatusRow` (interface) — `packages/backend/src/server/app-events.ts:280`

| Field | Type |
|---|---|
| `status` | `PlatformStatusValue` |
| `message` | `string \| null` |
| `updatedAt` | `Date` |

### `getPlatformStatus(): Promise<PlatformStatusRow>` — `packages/backend/src/server/app-events.ts:287`

Reads the singleton via `platformStatus.get()` (the `system/platform-status.json` file). Any failure (including the file not existing yet) and the `null` (unset) case both fall through to a synthetic `{ status: "healthy", message: null, updatedAt: new Date() }`.

- **Calls:** `platformStatus.get` (`store/repos/platform-status.ts:14`)
- **Called by:** `packages/backend/src/server/api/tick.ts:375`

### `formatPlatformStatusForPrompt(ps: PlatformStatusRow): string | undefined` — `packages/backend/src/server/app-events.ts:298`

Returns `undefined` when healthy; otherwise `"Platform status: DEGRADED|MAINTENANCE[: message]. Reduce non-essential work and avoid retrying failed operations."`.

- **Calls:** nothing
- **Called by:** `packages/backend/src/server/api/tick.ts:381`

---

## `packages/backend/src/server/codex-auth.ts`

Reads and refreshes the Codex CLI's ChatGPT OAuth credentials from `~/.codex/auth.json`, letting Simple Harmonic ride an existing ChatGPT subscription instead of an API key.

### Constants — `packages/backend/src/server/codex-auth.ts:4`

- `CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` — the Codex CLI's public OAuth client id, used for the refresh grant.
- `TOKEN_URL = "https://auth.openai.com/oauth/token"` — OAuth token endpoint.

### `CodexAuthStatus` (interface) — `packages/backend/src/server/codex-auth.ts:18`

| Field | Type | Source |
|---|---|---|
| `found` | `boolean` | auth.json exists with an access token |
| `authMode` | `string \| null` | `auth_mode` field of auth.json |
| `email` | `string \| null` | JWT claim `https://api.openai.com/profile`.email |
| `plan` | `string \| null` | JWT claim `https://api.openai.com/auth`.chatgpt_plan_type |
| `accountId` | `string \| null` | `tokens.account_id` |
| `lastRefresh` | `string \| null` | `last_refresh` field |
| `tokenExpiry` | `string \| null` | JWT `exp` as ISO string |
| `hasAccessToken` | `boolean` | |

### `CodexModel` (interface) — `packages/backend/src/server/codex-auth.ts:99`

| Field | Type | Notes |
|---|---|---|
| `slug` | `string` | model id |
| `displayName` | `string` | falls back to slug |
| `description` | `string` | falls back to `""` |
| `priority` | `number` | falls back to 999 |
| `supportedInApi` | `boolean` | `supported_in_api !== false` |

### `codexAuthPath(): string` (internal helper, trivial) — `packages/backend/src/server/codex-auth.ts:29`

`$CODEX_HOME/auth.json`, defaulting `CODEX_HOME` to `$HOME/.codex` (literal `~/.codex` if `HOME` is also unset).

### `readCodexAuth(): CodexAuthFile | null` (internal) — `packages/backend/src/server/codex-auth.ts:35`

Reads and JSON-parses `auth.json`; returns `null` when missing or unparsable (errors swallowed). `CodexAuthFile` (internal interface, line 7) carries `auth_mode`, `tokens { id_token, access_token, refresh_token, account_id }`, and `last_refresh`.

- **Calls:** `existsSync`, `readFileSync`, `JSON.parse`
- **Called by:** `getCodexAuthStatus` (`codex-auth.ts:59`), `getCodexAccessToken` (`:95`), `refreshCodexToken` (`:139`)

### `decodeJwtPayload(token: string): Record<string, unknown> | null` (internal) — `packages/backend/src/server/codex-auth.ts:47`

Splits the JWT on `.`, requires exactly 3 parts, base64-decodes the payload (manually padding with `"="` to a multiple of 4 — note when `length % 4 === 0` this appends 4 `=` chars, which Node's lenient base64 decoder tolerates), and JSON-parses it. **No signature verification** — display/metadata use only. Returns `null` on any failure.

- **Calls:** `Buffer.from(..., "base64")`, `JSON.parse`
- **Called by:** `getCodexAuthStatus` (`codex-auth.ts:73`)

### `getCodexAuthStatus(): CodexAuthStatus` — `packages/backend/src/server/codex-auth.ts:58`

Reads `auth.json` and decodes the access-token JWT to populate a `CodexAuthStatus`. Returns the all-null `found: false` shape when the file or access token is absent. File I/O only; never throws.

- **Calls:** `readCodexAuth`, `decodeJwtPayload`
- **Called by:** `packages/backend/src/server/planner-deps.ts:21`, `packages/backend/src/server/api/settings/codex-login.ts:27`, `:104`, `packages/backend/src/server/api/settings/codex.ts:9`, `packages/backend/src/server/api/settings/coding.ts:30`, `packages/backend/src/server/api/settings/test-llm.ts:87`; tests `codex-auth.test.ts`, mocked in `api-codex-login/api-settings/api-test-llm/meta-agent-index/planner` tests

### `getCodexAccessToken(): string | null` — `packages/backend/src/server/codex-auth.ts:94`

Raw access token from `auth.json`, or `null`. This is the third fallback in `getConfig()`'s API-key resolution, making "logged into Codex CLI" a zero-config auth path.

- **Calls:** `readCodexAuth`
- **Called by:** `packages/backend/src/server/config.ts:55`, `:102`, `packages/backend/src/server/planner-deps.ts:20`, `packages/backend/src/server/api/settings/test-llm.ts:79`; tests/mocks in `codex-auth.test.ts`, `config.test.ts:13`, `coding-config.test.ts:4`, `meta-agent-index.test.ts:15`, `planner.test.ts`, `api-test-llm.test.ts:36`

### `getCodexModels(): CodexModel[]` — `packages/backend/src/server/codex-auth.ts:107`

Parses `$CODEX_HOME/models_cache.json` (accepting either `{ models: [...] }` or a bare array), skips entries without a `slug`, normalizes fields per the `CodexModel` table above, filters to `supportedInApi`, and sorts by ascending `priority`. Returns `[]` when the cache is missing or malformed.

- **Calls:** `existsSync`, `readFileSync`, `JSON.parse`
- **Called by:** `packages/backend/src/server/api/settings/codex.ts:10`; tests `codex-auth.test.ts:166-246`, mocked in `api-settings.test.ts:20`

### `refreshCodexToken(): Promise<{ ok: boolean; accessToken?: string; error?: string }>` — `packages/backend/src/server/codex-auth.ts:134`

POSTs a `grant_type=refresh_token` form to `TOKEN_URL` with `CODEX_CLIENT_ID` using **global `fetch`** (not `proxyFetch`). On success, rewrites `auth.json` in place with the new `access_token` (and `id_token`/`refresh_token` when returned), bumping `last_refresh` — keeping the Codex CLI itself in sync. Error returns: no refresh token found; non-OK HTTP (status + first 200 chars of body); missing `access_token` in the response; or a caught exception message. Never throws.

- **Calls:** `readCodexAuth`, `fetch`, `writeFileSync`, `codexAuthPath`
- **Called by:** `packages/backend/src/server/api/settings/codex.ts:15` (POST handler); tests `codex-auth.test.ts:295-431`, mocked in `api-settings.test.ts:21`

---

## `packages/backend/src/server/config.ts`

Application configuration resolved from `simple-harmonic.config.json` (at `process.cwd()`), environment variables, and the Codex token, with per-key precedence **file > env > (codex, API key only) > default**. When the config file is absent from disk every key resolves from env vars and the code defaults. PR #16 replaced the `databaseUrl` key (and `DATABASE_URL` env) with `dataDir` (and `SH_DATA_DIR`), the JSON file store's root directory.

### `CodingBackendType` (type) — `packages/backend/src/server/config.ts:5`

`"codex" | "claude-code" | "opencode"`. (The prompt-era name `CodingBackendName` does not exist; this is the current export.)

### `CodingBackendConfig` (interface) — `packages/backend/src/server/config.ts:7`

| Field | Type |
|---|---|
| `model?` | `string` |
| `timeout?` | `number` |

### `AppConfig` (interface) — `packages/backend/src/server/config.ts:12`

| Field | Type | Env fallback | Default |
|---|---|---|---|
| `openaiApiKey` | `string` | `OPENAI_API_KEY`, then `getCodexAccessToken()` | `""` |
| `openaiBaseUrl` | `string` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `model` | `string` | `OPENAI_MODEL` | `o4-mini` (`config.ts:33`) |
| `dataDir` | `string` | `SH_DATA_DIR` | `join(process.cwd(), ".simple-harmonic", "data")` (`config.ts:34`) |
| `codingBackend` | `CodingBackendType` | `SH_CODING_BACKEND` | `codex` (invalid values coerced to `codex`) |
| `codingConfig` | `Record<CodingBackendType, CodingBackendConfig>` | — | `{ codex: {}, "claude-code": {}, opencode: {} }` |

`dataDir` is PR #16's replacement for the old `databaseUrl` field — the JSON file store's root directory.

### Constants — `packages/backend/src/server/config.ts:22`

- `CONFIG_PATH` (line 22) — `join(process.cwd(), "simple-harmonic.config.json")`, resolved once at module load.
- `DEFAULT_CODING_CONFIG` (line 24), `DEFAULTS` (line 30) — default value tables backing the resolution above. `DEFAULTS.model` (`config.ts:33`) is `o4-mini`; `DEFAULTS.dataDir` (`config.ts:34`) is `<cwd>/.simple-harmonic/data`. With no config file on disk, each key resolves to its env var or these defaults.

### `readFile(): Partial<AppConfig>` (internal) — `packages/backend/src/server/config.ts:39`

Parses `CONFIG_PATH`, returning `{}` when the file is missing or corrupt (parse errors swallowed). Re-read on **every** config call — there is no in-memory config cache, so external edits to the JSON take effect immediately.

- **Calls:** `existsSync`, `readFileSync`, `JSON.parse`
- **Called by:** `getConfig` (`config.ts:51`), `getApiKeySource` (`:85`), `setConfig` (`:93`)

### `getConfig(): AppConfig` — `packages/backend/src/server/config.ts:50`

Resolves every key with the precedence above. The API key uniquely has a third fallback to the Codex CLI access token (lines 53–57). `codingBackend` is validated against the allowed list (lines 59–62); `codingConfig` is merged per-backend over the defaults (file values win, no env fallback). `dataDir` resolves `file.dataDir || SH_DATA_DIR || DEFAULTS.dataDir` (line 77). File I/O on every call; never throws.

- **Calls:** `readFile`, `getCodexAccessToken`
- **Called by:** `packages/backend/src/server/store/data-dir.ts:32` (`getDataDir`), `packages/backend/src/server/planner-deps.ts:12`, `packages/backend/src/server/llm.ts`, `packages/backend/src/server/tools/coding/index.ts`, `packages/backend/src/server/api/settings/coding.ts`, `packages/backend/src/server/api/settings/index.ts`, `packages/backend/src/server/api/settings/test-llm.ts`, plus `getSafeConfig` internally; widely mocked in tests

### `getApiKeySource(): "config" | "env" | "codex" | "none"` — `packages/backend/src/server/config.ts:84`

Reports where the API key would come from, checking in precedence order (`file.openaiApiKey` → `OPENAI_API_KEY` → `getCodexAccessToken()` → none). The tick handler and planner branch on `"codex"` to use the ChatGPT-subscription path instead of the OpenAI API, and the LLM cascade uses it to decide whether to build a codex candidate and whether to add an OpenAI platform candidate. Unchanged by PR #16.

- **Calls:** `readFile`, `getCodexAccessToken`
- **Called by:** `packages/backend/src/server/planner-deps.ts:19`, `packages/backend/src/server/llm.ts:49`, `packages/backend/src/server/api/tick.ts:145`, `getSafeConfig` (`config.ts:109`); tests/mocks in `config.test.ts`, `api-tick.test.ts`, `api-test-llm.test.ts`, `planner.test.ts`, `meta-agent-index.test.ts`

### `setConfig(partial: Partial<AppConfig>): AppConfig` — `packages/backend/src/server/config.ts:92`

Shallow-merges `partial` into the **raw file contents** (not the resolved config — env-derived values are never written back) and rewrites `CONFIG_PATH` as pretty-printed JSON with a trailing newline. Returns the freshly re-resolved `getConfig()`. Throws on write failure.

- **Calls:** `readFile`, `writeFileSync`, `getConfig`
- **Called by:** `packages/backend/src/server/api/settings/index.ts:48`, `packages/backend/src/server/api/settings/setup-db.ts:20` (persisting a custom `dataDir`); tests `config.test.ts`, mocked in `api-settings.test.ts`, `api-setup-db.test.ts`

### `getSafeConfig()` — `packages/backend/src/server/config.ts:100`

Client-safe view: API key masked via `maskSecret`, plus `dataDir` (a plain path, no masking), derived booleans `hasOpenaiKey`/`hasDataDir`, `apiKeySource`, `codingBackend`, and the full `codingConfig` (which contains no secrets). Return type is inferred (no named interface). PR #16 swapped the old `databaseUrl`/`hasDatabase` fields (and the `maskDbUrl` call) for `dataDir`/`hasDataDir`.

- **Calls:** `getConfig`, `getApiKeySource`, `maskSecret`
- **Called by:** `packages/backend/src/server/api/settings/index.ts:11`, `:49`; tests `config.test.ts`, mocked in `api-settings.test.ts`

### Internal helpers (trivial)

- `maskSecret(s: string): string` (`config.ts:115`) — `first4••••last4`, `"••••••••"` when ≤ 8 chars (duplicate of `apollo.mask`). The `maskDbUrl` helper is removed — there is no DB URL to mask.

---

## `packages/backend/src/server/connectors.ts`

Connector store: metadata as flat JSON files in `.simple-harmonic/connectors/<KEY>.json`, secret values in gitignored `.simple-harmonic/secrets.json` with `process.env` fallback. Agents discover connectors by reading the files with `read_file`; no DB involved. All paths are rooted at `toolsRoot()` (`tools/sandbox.ts:24` — `SH_TOOLS_CWD` or `process.cwd()`).

### Constants — `packages/backend/src/server/connectors.ts:19`

- `DIR = ".simple-harmonic/connectors"` — metadata directory (relative to `toolsRoot()`).
- `SECRETS_FILE = ".simple-harmonic/secrets.json"` — plaintext secret map (relative to `toolsRoot()`).

### `ConnectorMeta` (interface) — `packages/backend/src/server/connectors.ts:22`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | display name; defaults to filename |
| `description` | `string` | defaults to `""` |
| `type` | `"api_key" \| "oauth_token" \| "env_var"` | defaults to `"api_key"` |
| `key` | `string` | env-var-style key; defaults to filename |

### `readSecrets(): Record<string, string>` (internal) — `packages/backend/src/server/connectors.ts:37`

Parses `secrets.json`, returning `{}` when missing or corrupted (errors swallowed). Read fresh on every call. There is no `writeSecrets` helper — `saveConnector` and `deleteConnectorByKey` rewrite the file inline.

- **Calls:** `existsSync`, `readFileSync`, `JSON.parse`
- **Called by:** `resolveConnector` (`connectors.ts:54`), `saveConnector` (`:100`), `deleteConnectorByKey` (`:120`)

### `resolveConnector(key: string): string | null` — `packages/backend/src/server/connectors.ts:53`

Secret resolution: `secrets.json` value > `process.env[key]` > `null`. No key validation here (read-only lookup, no path building beyond the fixed secrets file).

- **Calls:** `readSecrets`
- **Called by:** `packages/backend/src/server/tools/api-tool-runtime.ts:73`, `packages/backend/src/server/tools/network.ts:115`, `packages/backend/src/server/api/settings/connectors.ts:32`, `:104`

### `listConnectorMetas(): ConnectorMeta[]` — `packages/backend/src/server/connectors.ts:62`

Reads every `*.json` in the connectors directory, normalizing each per the `ConnectorMeta` defaults table (filename without extension backs `name` and `key`). Malformed files are skipped; a missing directory yields `[]`.

- **Calls:** `existsSync`, `readdirSync`, `readFileSync`, `JSON.parse`, `basename`
- **Called by:** `packages/backend/src/server/api/settings/connectors.ts:100`; tests `connectors.test.ts:51-82`

### `saveConnector(meta: ConnectorMeta, secretValue?: string): void` — `packages/backend/src/server/connectors.ts:87`

Validates `meta.key` (throws via `assertValidConnectorKey` on anything not matching `^[A-Z][A-Z0-9_]*$` — the path-traversal guard), then writes `<connectors dir>/<key>.json` (pretty JSON + newline), creating directories as needed. When `secretValue` is provided it is merged into `secrets.json` (read-modify-write, plaintext).

- **Calls:** `assertValidConnectorKey`, `mkdirSync`, `writeFileSync`, `readSecrets`
- **Called by:** `packages/backend/src/server/api/settings/connectors.ts:139`, `scripts/seed-demo.ts:273`

### `deleteConnectorByKey(key: string): boolean` — `packages/backend/src/server/connectors.ts:111`

Validates the key, unlinks the metadata file (returning whether it existed), and removes the entry from `secrets.json` when present (rewriting the file). The boolean reflects metadata deletion only.

- **Calls:** `assertValidConnectorKey`, `existsSync`, `unlinkSync`, `readSecrets`, `writeFileSync`
- **Called by:** `packages/backend/src/server/api/settings/connectors.ts:159`

### Internal helpers (trivial)

- `connectorsDir(): string` (`connectors.ts:29`) — `join(toolsRoot(), DIR)`.
- `secretsPath(): string` (`connectors.ts:33`) — `join(toolsRoot(), SECRETS_FILE)`.

---

## `packages/backend/src/server/custom-tools.ts`

Custom tool loading: each skill is one **flat JSON file** `.simple-harmonic/skills/<name>.json` defining an API tool template (`{ name, description, config }`, header comment `custom-tools.ts:1-19`). The tick loop reads these files and registers them into the tool registry; agents discover them by reading the files with `read_file`. Paths are rooted at `toolsRoot()`.

### Constants — `packages/backend/src/server/custom-tools.ts:27`

- `DIR = ".simple-harmonic/skills"` — skills directory (relative to `toolsRoot()`).

### `CustomToolFile` (interface) — `packages/backend/src/server/custom-tools.ts:29`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | must satisfy `TOOL_NAME_RE` on save; becomes the registered tool name |
| `description` | `string` | `""` when absent in the file |
| `config` | `ApiToolConfig` | required — a file without a string `config.baseUrl` is skipped, so every loaded custom tool is a callable HTTP API tool |

### `listCustomToolFiles(): CustomToolFile[]` — `packages/backend/src/server/custom-tools.ts:39`

Reads every `*.json` in the skills directory and JSON-parses it; entries missing a `name` or a `config.baseUrl` are skipped (`custom-tools.ts:48`), malformed JSON is skipped silently, and a missing directory yields `[]`. `description` defaults to `""`. No name validation on the read path — the filename is not consulted beyond the `.json` filter (the `name` field inside the file wins).

- **Calls:** `existsSync`, `readdirSync`, `readFileSync`, `JSON.parse`
- **Called by:** `packages/backend/src/server/tools/index.ts:72` (registry construction — custom tools become registry entries each tick); tests `custom-tools.test.ts:19-77`

### `saveCustomToolFile(tool: CustomToolFile): void` — `packages/backend/src/server/custom-tools.ts:61`

Validates `tool.name` with `assertValidToolName` (`validation.ts:31` — the path-traversal guard), then writes `.simple-harmonic/skills/<name>.json` as pretty-printed JSON with a trailing newline, creating the directory recursively.

- **Calls:** `assertValidToolName`, `mkdirSync`, `writeFileSync`
- **Called by:** `scripts/seed-demo.ts:259`; tests `custom-tools.test.ts:78-95`, `:163-203` (traversal rejection)

### `deleteCustomToolFile(name: string): boolean` — `packages/backend/src/server/custom-tools.ts:71`

Validates the name, then unlinks `<skills dir>/<name>.json`. Returns `false` when the file does not exist.

- **Calls:** `assertValidToolName`, `existsSync`, `unlinkSync`
- **Called by:** test-only — `custom-tools.test.ts:96-114`, `:190-203` (no production caller; deletion currently happens only via direct file manipulation)

### Internal helpers (trivial)

- `skillsDir(): string` (`custom-tools.ts:35`) — `join(toolsRoot(), DIR)`.

### Parked: the skills-directory migration (stash@{0})

An uncommitted migration once replaced this module with a Claude Code-style loader: skills as **directories** containing a `SKILL.md` (YAML frontmatter + markdown playbook), nested directories as sub-skills, progressive disclosure in the runner (`openSkills` persisted on the `agents` table, a `close_skills` internal tool), and an optional `api:` frontmatter block for callable skills. That code was discarded on 2026-06-11 and exists nowhere in the repo; only its untracked data files survive, parked in `git stash@{0}` — the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees plus `packages/backend/tests/unit/skill-tree.test.ts`. HEAD behavior is the flat-JSON loader documented above.

---

## `packages/backend/src/server/llm.ts`

**New in PR #14.** LLM provider resolution for the tick: builds every configured provider into ordered cascade candidates — Codex CLI subscription > Anthropic > OpenRouter > OpenAI platform key — and wraps them in one cascading `LLMClient` via `createCascadeLLM` (`packages/backend/src/lib/meta-agent/cascade.ts:31`), so a provider error on one step falls through to the next instead of stalling every agent. `cascade.ts` is library core and must not import server modules; this module is the server-side composition point.

### `OPENROUTER_BASE_URL` (constant) — `packages/backend/src/server/llm.ts:27`

`"https://openrouter.ai/api/v1"` — default endpoint for the OpenRouter client, overridable per process via the `OPENROUTER_BASE_URL` env var (`llm.ts:71`).

- **Used by:** `resolveLLMCandidates` internally; no external importers (the resolved `baseURL` is asserted in `packages/backend/tests/unit/llm-cascade.test.ts:237`)

### Internal default constants — `packages/backend/src/server/llm.ts:29`

| Constant | Value | Applies when |
|---|---|---|
| `DEFAULT_CODEX_MODEL` | `"gpt-5.5"` | codex candidate and `cfg.model` is empty (`llm.ts:54`) |
| `DEFAULT_ANTHROPIC_MODEL` | `"claude-sonnet-4-20250514"` | anthropic candidate and `ANTHROPIC_MODEL` is unset (`llm.ts:62`) |
| `DEFAULT_OPENROUTER_MODEL` | `"anthropic/claude-sonnet-4"` | openrouter primary and `OPENROUTER_MODEL` is unset (`llm.ts:77`) |
| `DEFAULT_TIMEOUT_MS` | `120_000` | per-request client timeout, when `ResolveOptions.timeoutMs` is unset (`llm.ts:50`) |

`ANTHROPIC_MODEL` is new in PR #14 — pre-cascade, the tick hardcoded the sonnet id when `ANTHROPIC_API_KEY` was set. `DEFAULT_CODEX_MODEL` matters only when `cfg.model` resolves empty; note the separate uncommitted `config.ts` edit also sets the *config* default model to `gpt-5.5` (committed: `o4-mini`).

### `ResolveOptions` (interface) — `packages/backend/src/server/llm.ts:36`

| Field | Type | Notes |
|---|---|---|
| `timeoutMs?` | `number` | per-request client timeout; default 120 s (matches the tick budget). `test-llm` passes `10_000`. |

### `resolveLLMCandidates(opts: ResolveOptions = {}): LLMCandidate[]` — `packages/backend/src/server/llm.ts:47`

Builds the cascade's `LLMCandidate[]` (`{ provider, model, llm }`, `cascade.ts:12`) in priority order: (1) **codex** when `getApiKeySource() === "codex"` (`llm.ts:53-56`) — `createCodexClient`, model `cfg.model || DEFAULT_CODEX_MODEL`; (2) **anthropic** when `ANTHROPIC_API_KEY` is set (`llm.ts:58-65`) — `createAnthropicClient({ apiKey, timeout })`, model `ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL`; (3) **openrouter** when `OPENROUTER_API_KEY` is set (`llm.ts:67-85`) — a stock `new OpenAI({ apiKey, baseURL, timeout })` cast to `LLMClient`, with model list `[OPENROUTER_MODEL || default, ...OPENROUTER_FALLBACK_MODELS.split(",")]` trimmed, empty-filtered, and deduped via `new Set` — **one cascade candidate per model, all sharing the same client instance**, so within-OpenRouter model fallback rides the same cascade machinery; (4) **openai** when the key source is `"config"` or `"env"` (`llm.ts:89-99`) — deliberately **skipped under the codex source**, because there `cfg.openaiApiKey` holds the ChatGPT token, not a platform key (comment `llm.ts:87-88`). Always returns at least one candidate: with nothing configured it pushes a key-less OpenAI client (`llm.ts:101-111`) so a clear auth error surfaces on first call rather than at resolve time (preserving pre-cascade behavior).

- **Calls:** `getConfig`, `getApiKeySource`, `createCodexClient` (`lib/meta-agent/codex-adapter`), `createAnthropicClient` (`lib/meta-agent/anthropic-adapter`), `new OpenAI`
- **Called by:** `resolveLLM` (`llm.ts:126`); `packages/backend/src/server/api/settings/test-llm.ts:39` (POST probes only the cascade's *primary* candidate via its real client); tests `llm-cascade.test.ts:209-270`

### `ResolvedLLM` (interface) — `packages/backend/src/server/llm.ts:116`

| Field | Type | Notes |
|---|---|---|
| `llm` | `LLMClient` | the single cascading client |
| `model` | `string` | the primary candidate's model id (becomes the tick's `modelOverride`) |
| `chain` | `string[]` | `"provider/model"` per cascade step, for logs and status surfaces |

### `resolveLLM(opts: CascadeOptions & ResolveOptions = {}): ResolvedLLM` — `packages/backend/src/server/llm.ts:125`

Resolves all configured providers and wraps them in one cascading client: `createCascadeLLM(candidates, opts)`. The cascade walks candidates in order on every `chat.completions.create`, overrides `params.model` per candidate, falls through on **any** thrown error (no error-type filtering), rethrows immediately when `options?.signal?.aborted` (the tick's wall-clock budget), throws the last error after exhaustion, stamps `res.model` when the response lacks one (so spend attributes the serving model), and reports each failure through `CascadeOptions.onFallback` (`cascade.ts:20-29`; a throwing observer is swallowed). `model` is `candidates[0].model`; `chain` maps every candidate to `"provider/model"`.

- **Calls:** `resolveLLMCandidates`, `createCascadeLLM` (`cascade.ts:31`)
- **Called by:** `packages/backend/src/server/api/tick.ts:169` — its `onFallback` (`tick.ts:170-180`) emits a warning app event per fallback: `LLM <provider>/<model> failed (<reason, sliced to 200 chars>); falling back to <next>` or `…; cascade exhausted`; tests `llm-cascade.test.ts:276`

### Env vars read by this module

| Var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | enables the anthropic cascade step (`llm.ts:58`) |
| `ANTHROPIC_MODEL` | overrides `DEFAULT_ANTHROPIC_MODEL` (`llm.ts:62`); new in PR #14 |
| `OPENROUTER_API_KEY` | enables the openrouter cascade step(s) (`llm.ts:67`) |
| `OPENROUTER_MODEL` | primary OpenRouter model (`llm.ts:77`) |
| `OPENROUTER_FALLBACK_MODELS` | comma-separated extra OpenRouter cascade steps, trimmed and deduped (`llm.ts:78`) |
| `OPENROUTER_BASE_URL` | endpoint override (`llm.ts:71`); **not documented in `.env.example`** |

---

## `packages/backend/src/server/operator-auth.ts`

Operator/cron authentication, **edge-safe by contract**: only Web Crypto (`globalThis.crypto`), `TextEncoder`, and header parsing — no `node:crypto`, no fs, no DB — so the module can be imported from the Next proxy (edge runtime), node route handlers, and vitest alike. Single-operator model: one shared `OPERATOR_PASSWORD` gates the app; one `CRON_SECRET` gates the tick endpoint. Permissive in local dev when the secret is unset, fails closed in production. Since PR #13 the standalone node:http host also imports it (`packages/backend/src/server/standalone/server.ts:15`, `standalone/main.ts:20`), and `isCronAuthorized` carries a spoofing fix (see below).

### `OPERATOR_COOKIE` (constant) — `packages/backend/src/server/operator-auth.ts:15`

`"sh_operator"` — the cookie name carrying `sha256(password)`.

- **Used by:** the login handler — `packages/backend/src/server/api/login.ts:22` sets `sh_operator=<sha256(password)>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+`Secure` in production) — and `isOperatorAuthorized` internally; tests `operator-auth.test.ts`, `standalone-server.test.ts`

### `isProductionRuntime(): boolean` — `packages/backend/src/server/operator-auth.ts:18`

`NODE_ENV === "production" || !!process.env.VERCEL` — true when an unset secret should fail closed.

- **Calls:** nothing
- **Called by:** `src/proxy.ts:32`, `isCronAuthorized` (`operator-auth.ts:88`), `packages/backend/src/server/standalone/server.ts:88` (503 when `OPERATOR_PASSWORD` unset in production), `packages/backend/src/server/standalone/main.ts:54` (refuses to start the in-process tick loop without `CRON_SECRET` in production)

### `sha256Hex(input: string): Promise<string>` — `packages/backend/src/server/operator-auth.ts:23`

SHA-256 hex digest via `globalThis.crypto.subtle` (async because of Web Crypto). Used to derive the operator cookie value so the raw password never sits in the cookie jar.

- **Calls:** `crypto.subtle.digest`
- **Called by:** the login handler (`packages/backend/src/server/api/login.ts:22`), `isOperatorAuthorized` (`operator-auth.ts:66`); tests `operator-auth.test.ts:21-22,49`

### `constantTimeEqual(a: string, b: string): boolean` — `packages/backend/src/server/operator-auth.ts:32`

Length-checked constant-time comparison (XOR-accumulate over char codes). The early length check leaks only length, not content.

- **Calls:** nothing
- **Called by:** the login handler (`packages/backend/src/server/api/login.ts:14`), `isOperatorAuthorized` (`operator-auth.ts:64`, `:66`), `isCronAuthorized` (`:86`); tests `operator-auth.test.ts:27-30`

### `isOperatorAuthorized(req: Request, password: string): Promise<boolean>` — `packages/backend/src/server/operator-auth.ts:59`

True when the request carries either `Authorization: Bearer <OPERATOR_PASSWORD>` (curl/scripts) or the `sh_operator` cookie equal to `sha256Hex(password)` (browser sessions). Both comparisons are constant-time.

- **Calls:** `bearerToken`, `constantTimeEqual`, `readCookie`, `sha256Hex`
- **Called by:** `src/proxy.ts:40` (every non-tick request when a password is configured), `packages/backend/src/server/standalone/server.ts:93` (the standalone host's `/api/*` gate, PR #13); tests `operator-auth.test.ts:33-58`

### `isCronAuthorized(req: Request, cronSecret: string | undefined): boolean` — `packages/backend/src/server/operator-auth.ts:76`

Tick-endpoint gate, checked in order: (1) the `x-vercel-cron` header ⇒ allow, but **only when `process.env.VERCEL` is set** (`operator-auth.ts:83`); (2) when `cronSecret` is set, require a matching Bearer token; (3) when unset, allow in local dev and **fail closed in production** (`!isProductionRuntime()`, `:88`). The Vercel guard is PR #13's security fix: on Vercel the edge strips client-supplied copies of the header, but on any other host — notably the standalone node:http server — an unconditionally trusted `x-vercel-cron` would be trivially spoofable and allow unauthenticated agent ticks (LLM spend).

- **Calls:** `bearerToken`, `constantTimeEqual`, `isProductionRuntime`
- **Called by:** `packages/backend/src/server/api/tick.ts:133`; tests `operator-auth.test.ts:62` ("accepts the x-vercel-cron header only on Vercel"), `:73`, `:78`

### Internal helpers (trivial)

- `bearerToken(req: Request): string | null` (`operator-auth.ts:41`) — extracts the token after `"Bearer "`.
- `readCookie(req: Request, name: string): string | null` (`operator-auth.ts:46`) — manual `cookie` header parse (edge-safe, no framework dependency).

---

## `packages/backend/src/server/planner-deps.ts`

The single explicit bridge between the server layer and the NPM-extractable library core: `lib/meta-agent/planner.ts` declares a `PlannerDeps` interface and this module fills it from server modules, so the planner itself never imports `server/`.

### `buildPlannerDeps(): PlannerDeps` — `packages/backend/src/server/planner-deps.ts:11`

Assembles the planner's dependency object on each call: `config` (`model`, `openaiApiKey`, `openaiBaseUrl` from `getConfig()`), `apiKeySource` (`getApiKeySource()`), `codexAccessToken` (`getCodexAccessToken()`), `codexAccountId` (`getCodexAuthStatus().accountId || ""`), and `fetchImpl: proxyFetch`. File I/O on every call (config + auth.json reads); no caching.

- **Calls:** `getConfig`, `getApiKeySource`, `getCodexAccessToken`, `getCodexAuthStatus`, references `proxyFetch`
- **Called by:** `packages/backend/src/server/api/chat.ts:61` (passed into `plannerStream`)

---

## `packages/backend/src/server/proxy-fetch.ts`

Proxy-aware HTTPS fetch for Node. Exists because Node's undici-backed global `fetch` can hang 10s+ on unreachable IPv6 AAAA records (e.g. chatgpt.com behind Teredo tunnels) and ignores macOS system proxies; this module pins IPv4, honors `HTTPS_PROXY`-style env vars via HTTP CONNECT, and supports DNS pinning against rebinding attacks.

### `PinnedAddress` (interface) — `packages/backend/src/server/proxy-fetch.ts:7`

| Field | Type | Notes |
|---|---|---|
| `ip` | `string` | pre-validated public IP to pin the connection to (anti-rebinding) |
| `family` | `4 \| 6` | IP family |

### Module state: `cachedSystemProxy` — `packages/backend/src/server/proxy-fetch.ts:16`

`string | null | undefined` — `undefined` = not yet probed, `null` = probed and absent, string = proxy URL. Caches the `scutil --proxy` result for the lifetime of the process (a settings change requires a server restart to be noticed).

### `getSystemProxyMac(): string | null` (internal) — `packages/backend/src/server/proxy-fetch.ts:17`

macOS-only fallback proxy discovery: runs `scutil --proxy` synchronously (1 s timeout), and when `HTTPSEnable: 1`, extracts `HTTPSProxy`/`HTTPSPort` into `http://host:port`. Returns `null` on non-darwin platforms, scutil failure, or no proxy configured. Result is cached in `cachedSystemProxy`. Note an early-return subtlety: the darwin check and the "enabled but host/port missing" path return before re-assigning the cache, but `cachedSystemProxy` was already set to `null` at line 19, so caching still holds.

- **Calls:** `execSync("scutil --proxy")`
- **Called by:** `proxyFetch` (`proxy-fetch.ts:143`); exercised in tests `proxy-fetch.test.ts:447-529`

### `fetchViaHttps(url, init: RequestInit & { signal?: AbortSignal } = {}, pin?: PinnedAddress): Promise<Response>` (internal) — `packages/backend/src/server/proxy-fetch.ts:44`

Direct (no-proxy) path built on `https.request`. Key behaviors: (1) without a pin, sets `family: 4` so connections behave like curl and skip broken v6 routes; (2) with a pin, overrides DNS via a custom `lookup` that returns `pin.ip` while TLS SNI + certificate verification still use the original hostname — closing the DNS-rebinding TOCTOU without weakening cert checks; (3) computes `Content-Length` for string/Buffer/Uint8Array bodies when not already set (without it the server waits forever and aborts surface as "socket hang up"); (4) adapts the Node response into a WHATWG `Response` wrapping a `ReadableStream`; (5) `init.signal` abort destroys the in-flight request. Rejects on request errors.

- **Calls:** `https.request`, `URL`, `Buffer.from`
- **Called by:** `proxyFetch` (`proxy-fetch.ts:146`)

### `proxyFetch(url, init: RequestInit & { signal?: AbortSignal } = {}, pin?: PinnedAddress): Promise<Response>` — `packages/backend/src/server/proxy-fetch.ts:130`

Entry point. Resolves a proxy URL from `HTTPS_PROXY`/`HTTP_PROXY`/lowercase variants, falling back to `getSystemProxyMac()`. With no proxy it delegates to `fetchViaHttps` (passing the pin through). With a proxy it performs the tunnel path inline (there is no separate `fetchViaProxy` helper): an HTTP `CONNECT` to the proxy (10 s timeout ⇒ rejects `"Proxy CONNECT timeout"`), then an `https.request` over the tunneled socket via `new https.Agent({ socket, rejectUnauthorized: true })`, again adapted to a WHATWG `Response` with a streaming body. The IP pin is deliberately **not** applied on the proxy path — the proxy resolves the target itself and is treated as a trust boundary. Abort signals destroy both the CONNECT request and the tunneled request. The tunneled-response handler also accumulates chunks into a `chunks` array that is never read (vestigial).

- **Calls:** `getSystemProxyMac`, `fetchViaHttps`, `http.request` (CONNECT), `https.request`, `https.Agent`
- **Called by:** `packages/backend/src/server/planner-deps.ts:22` (as `fetchImpl`), `packages/backend/src/server/tools/api-tool-runtime.ts:126`, `packages/backend/src/server/tools/network.ts:44`, `:144`, `packages/backend/src/server/api/settings/test-llm.ts:98`; tests `proxy-fetch.test.ts`, mocked in `api-test-llm/api-tool-runtime/api-tool-ssrf/server-tools/security/meta-agent-index` tests

---

## `packages/backend/src/server/spend.ts`

LLM spend ledger and daily cap — bounds runaway cost from the autonomous tick loop. Every agent run records token usage into the spend ledger (`system/spend.jsonl`); the tick loop compares the day's total against `SH_DAILY_SPEND_CAP_CENTS` before doing any LLM work. PR #16 dropped the old `DB`-handle parameter from `spentTodayCents`/`checkSpendAllowed`/`recordSpend` (they now reach the store directly via the `spend` repo); PR #14 changed `costCents` (vendor-namespace stripping) and `makeCountingLLM` (serving-model attribution); tick call sites are the extracted handler `packages/backend/src/server/api/tick.ts` (PR #13).

### `RATES` / `FALLBACK_RATE` (internal constants) — `packages/backend/src/server/spend.ts:15`

Per-1M-token prices in US cents, matched by **model-id prefix** (first match wins, case-insensitive):

| Prefix | Input ¢/M | Output ¢/M |
|---|---|---|
| `claude-sonnet` | 300 | 1500 |
| `claude-opus` | 1500 | 7500 |
| `claude-haiku` | 80 | 400 |
| `gpt-5` | 125 | 1000 |
| `o4` | 110 | 440 |
| *(fallback)* | 1500 | 7500 |

The fallback is deliberately the most expensive rate so unknown models over-count rather than under-count. PR #14 added **no** new rate rows — OpenRouter ids reach these same five prefixes via the namespace stripping in `costCents`; a namespaced model whose bare id matches no prefix (e.g. `google/gemini-2.5-pro` → `gemini-2.5-pro`) still over-counts at the fallback rate.

### `costCents(model: string, inputTokens: number, outputTokens: number): number` — `packages/backend/src/server/spend.ts:25`

Looks up the rate by prefix on the lowercased model id (fallback as above) and returns `ceil((in·rateIn + out·rateOut) / 1_000_000)` — rounded **up** to whole cents. Pure. Since PR #14 it strips OpenRouter-style vendor namespaces before prefix matching — `const bare = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m` (`spend.ts:33`) — so `anthropic/claude-sonnet-4` hits the `claude-sonnet` rate row instead of the expensive fallback.

- **Calls:** nothing
- **Called by:** `recordSpend` (`spend.ts:100`); tests `spend.test.ts` (namespace strip)

### `dailyCapCents(): number` — `packages/backend/src/server/spend.ts:41`

Parses `SH_DAILY_SPEND_CAP_CENTS`; any non-finite or non-positive value falls back to `5000` (= $50/day).

- **Calls:** `Number.parseInt`
- **Called by:** `checkSpendAllowed` (`spend.ts:72`); tests `spend.test.ts`

### `todayUtc(now: Date): string` — `packages/backend/src/server/spend.ts:47`

UTC calendar day as `YYYY-MM-DD` (`toISOString().slice(0, 10)`).

- **Calls:** nothing
- **Called by:** `spentTodayCents` (`spend.ts:52`), `recordSpend` (`:101`); tests `spend.test.ts`

### `spentTodayCents(now: Date): Promise<number>` — `packages/backend/src/server/spend.ts:51`

Returns `spend.sumForDay(todayUtc(now))` — the repo reads `system/spend.jsonl` and totals `costCents` for rows whose `day` matches the UTC calendar day. No more `DB` parameter (PR #16). Read errors propagate (handled by `checkSpendAllowed`).

- **Calls:** `todayUtc`, `spend.sumForDay` (`store/repos/spend.ts:38`)
- **Called by:** `checkSpendAllowed` (`spend.ts:74`) — no other callers

### `SpendStatus` (interface) — `packages/backend/src/server/spend.ts:55`

| Field | Type | Notes |
|---|---|---|
| `allowed` | `boolean` | whether another tick is within budget |
| `spentCents` | `number` | `-1` when unknown |
| `capCents` | `number` | resolved daily cap |
| `unknown?` | `boolean` | true when the ledger could not be read |

### `checkSpendAllowed(now: Date): Promise<SpendStatus>` — `packages/backend/src/server/spend.ts:71`

Compares today's recorded spend against the cap (`allowed = spentCents < capCents`). On a ledger **read** error (transient fs hiccup) it deliberately **fails OPEN**: `{ allowed: true, spentCents: -1, capCents, unknown: true }` — a read failure must not silently halt every team's agents; the tick handler logs the failure loudly (warning app-event at `packages/backend/src/server/api/tick.ts:173`) and the cap re-engages once the ledger is readable. No more `DB` parameter (PR #16).

- **Calls:** `dailyCapCents`, `spentTodayCents`
- **Called by:** `packages/backend/src/server/api/tick.ts:171`; tests `spend.test.ts`

### `recordSpend(now: Date, entry): Promise<void>` — `packages/backend/src/server/spend.ts:82`

`entry: { teamId?: string | null; agentId?: string | null; model: string; inputTokens: number; outputTokens: number }`. Appends one ledger row via `spend.insert(...)` with the computed `costCents` and UTC `day`. Skips entirely when both token counts are ≤ 0. Best-effort: write failures are swallowed — a ledger write failure never breaks a tick. No more `DB` parameter (PR #16).

- **Calls:** `costCents`, `todayUtc`, `spend.insert` (`store/repos/spend.ts:22`)
- **Called by:** `packages/backend/src/server/api/tick.ts:429` (fresh) and `:552` (resume) — once per agent run on both the runner path (usage from `makeCountingLLM`) and the engine-mode codex-harness path. Tests `spend.test.ts`.

### `UsageAccumulator` (interface) — `packages/backend/src/server/spend.ts:108`

| Field | Type |
|---|---|
| `inputTokens` | `number` |
| `outputTokens` | `number` |
| `model` | `string` |

### `makeCountingLLM(llm: LLMClient, model: string): { llm: LLMClient; usage: UsageAccumulator }` — `packages/backend/src/server/spend.ts:118`

Wraps an `LLMClient` (the `lib/meta-agent/runner` interface) so every `chat.completions.create` call accumulates token usage into the returned `usage` object. Accepts both Anthropic-style (`input_tokens`/`output_tokens`) and OpenAI-style (`prompt_tokens`/`completion_tokens`) usage fields (`spend.ts:139-140`) — which is also why OpenRouter usage is captured with no OpenRouter-specific code: it returns the OpenAI wire shape. Since PR #14, `usage.model` prefers the **response's** model over the requested one — `usage.model = rm || pm || usage.model` (`spend.ts:146`) — because with the cascade the serving model can differ from the request; the cascade stamps `res.model` when absent (`cascade.ts:53-54`) and the Anthropic adapter now echoes `model: response.model`, so spend is attributed to the model that actually served. Used per-agent in the tick loop so each agent run records its own spend via `recordSpend`.

- **Calls:** the wrapped `llm.chat.completions.create`
- **Called by:** `packages/backend/src/server/api/tick.ts:418`, `:534` (runner path only, requested model `modelOverride ?? "unknown"` — the engine-mode codex-harness path reports its own usage); tests `spend.test.ts` (serving-model attribution)

---

## `packages/backend/src/server/team-tree.ts`

Queries over the recursive team hierarchy (`parentTeamId`). All functions load **every** team row via the store and traverse in memory — deliberate, since the expected scale is < 100 teams and in-memory traversal beats anything cleverer. The repo behind `teams.all()` reads each team's `team.json` (the team folder paths come from the in-memory location index in `store/index-cache.ts`, which already encodes the parent/child relation), so this module re-derives ancestry from `parentTeamId` rather than from the on-disk nesting.

### `allTeams(): Promise<TeamRow[]>` (internal helper, trivial) — `packages/backend/src/server/team-tree.ts:17`

`teams.all()` — every team row, backing every traversal below. `TeamRow = Team` (line 11, the store row type, not exported).

### `getChildTeams(teamId: string): Promise<TeamRow[]>` — `packages/backend/src/server/team-tree.ts:24`

Direct children only — delegates to `teams.children(teamId)` (the location-index filter on `parentTeamId`).

- **Calls:** `teams.children` (`store/repos/teams.ts:59`)
- **Called by:** **unused** (no callers anywhere in the repo, including tests)

### `getRootTeams(): Promise<TeamRow[]>` — `packages/backend/src/server/team-tree.ts:31`

All teams with `parentTeamId === null` — delegates to `teams.roots()`.

- **Calls:** `teams.roots` (`store/repos/teams.ts:53`)
- **Called by:** **unused** (no callers anywhere in the repo, including tests)

### `getSubTreeIds(teamId: string): Promise<Set<string>>` — `packages/backend/src/server/team-tree.ts:40`

All team IDs in the sub-tree rooted at `teamId`, **inclusive of the root** (and returning `{teamId}` even for an unknown id). Builds a parent→children map from the full table, then iterative DFS with a stack. This is the authorization primitive: a lead agent can only manage teams/agents within its sub-tree.

- **Calls:** `allTeams`
- **Called by:** `packages/backend/src/server/tools/management.ts:36`, `:142`, `packages/backend/src/server/tools/action-history.ts:98`; tests `team-tree.test.ts:30-44`. (Note: `packages/backend/src/server/api/team/id/index.ts:38` defines its **own local** `getSubTreeIds` over an already-fetched team list rather than importing this one.)

### `isAncestor(ancestorId: string, teamId: string): Promise<boolean>` — `packages/backend/src/server/team-tree.ts:66`

True when `ancestorId` equals `teamId` or appears on `teamId`'s parent chain. Walks upward via a parent map with a `visited` set guarding against cycles (returns `false` on a cycle).

- **Calls:** `allTeams`
- **Called by:** test-only — `team-tree.test.ts:48-70`

### `getAncestorChain(teamId: string): Promise<string[]>` — `packages/backend/src/server/team-tree.ts:88`

The chain `[teamId, parentId, grandparentId, …, rootId]`, walking up via the parent map; cycle-guarded (breaks on revisit).

- **Calls:** `allTeams`
- **Called by:** test-only — `team-tree.test.ts:73-81`

### `getTeamTree(): Promise<TeamTreeNode[]>` — `packages/backend/src/server/team-tree.ts:107`

Builds the full display tree: groups teams by parent, then recursively materializes `TeamTreeNode`s from the roots (`parentTeamId = null`).

- **Calls:** `allTeams`
- **Called by:** test-only — `team-tree.test.ts:85-87`. (The sidebar's `TeamTreeNode` in `packages/frontend/src/components/sidebar.tsx:268` is an unrelated React component that builds its tree client-side from `/api/teams`.)

### `TeamTreeNode` (interface) — `packages/backend/src/server/team-tree.ts:126`

| Field | Type |
|---|---|
| `id` | `string` |
| `name` | `string` |
| `paused` | `boolean` |
| `children` | `TeamTreeNode[]` |

---

## `packages/backend/src/server/trace.ts`

**New in PR #12.** Server-side play-by-play trace sink: bridges the runner's fire-and-forget `TraceSink` callback (`packages/backend/src/lib/meta-agent/trace.ts`) to the `traceEvents` store repo (per-agent `trace.jsonl` files), which the SSE handler `GET /api/team/[id]/trace` (`packages/backend/src/server/api/team/id/trace.ts`) polls. Design constraints (header comment, `trace.ts:1-18`): `emit()` is synchronous and never throws; steps are buffered and batch-appended in emission order by a single background drain loop, so the runner never blocks on IO and a tick is observable **live**; `flush()` is awaited in the tick handler's `finally` so steps survive run failures and timeouts; a resumed tick reuses the original `tickId`. PR #16 swapped only the persistence target (Drizzle insert → `traceEvents.append`); the buffering/drain/flush machinery is unchanged.

### Constants (internal) — `packages/backend/src/server/trace.ts:26`

| Constant | Value | Meaning |
|---|---|---|
| `MAX_STRING_LENGTH` | `4000` | per-string cap; longer strings cut with a truncation marker (`trace.ts:26`) |
| `MAX_DEPTH` | `6` | nested values deeper than this become `"[max depth]"` (`trace.ts:28`) |
| `MAX_ENTRIES` | `50` | arrays/objects keep at most this many entries/keys (`trace.ts:30`) |
| `PRUNE_INTERVAL_MS` | `3600_000` | retention sweep throttle, 1 h (`trace.ts:153`) |

### `PersistentTraceSink` (interface) — `packages/backend/src/server/trace.ts:32`

| Field | Type | Notes |
|---|---|---|
| `tickId` | `string` | groups every step of one logical tick; stable across suspend/resume |
| `emit` | `(step: TraceStep) => void` | runner-facing callback — buffers one step; never throws, never blocks |
| `flush` | `() => Promise<void>` | awaits all buffered writes; call after the run settles, success or not |

### `createTraceSink(args: { teamId: string; agentId: string; tickId?: string }): PersistentTraceSink` — `packages/backend/src/server/trace.ts:41`

Builds one sink per agent run. `tickId = args.tickId ?? randomUUID()` — the resume path passes the tickId parked on the suspended agent's `conversationState` so one logical tick reads as one thread; `seq` restarts at 0 per invocation, which is why `(emittedAt, seq)` is the global sort key (`emittedAt` comes from the **emitting process clock**, so batched appends keep runner order). `emit` pushes `{ teamId, agentId, tickId, seq++, type, data: sanitizeTraceData(step.data), emittedAt }` into a buffer and kicks the single drain loop (`drain`, `trace.ts:53`) when idle; each iteration splices the whole buffer and writes it as one batch via `traceEvents.append(batch)` (the repo appends to the owning agent's `trace.jsonl`). A failed batch is **dropped** with a `console.error` (`[trace] dropped N step(s)`) — telemetry must never break a tick. `flush` awaits the writer promise and then re-drains once more to pick up the race where a step lands between the loop's last empty check and its `finally` (delayed, never lost — comment `trace.ts:90-94`).

- **Calls:** `randomUUID`, `sanitizeTraceData`, `traceEvents.append` (`store/repos/trace-events.ts:50`)
- **Called by:** `packages/backend/src/server/api/tick.ts:362` (fresh run) and `:496` (resume, passing the parked `tickId`); both flush in `finally` (`tick.ts:441`, `:565`) and hand the sink to `failAgent` for the terminal `tick_failed` step (`tick.ts:581`). Tests `trace-sink.test.ts`.

### `sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown>` — `packages/backend/src/server/trace.ts:110`

PII scrub + truncation so a verbose tool result (file dumps, command output) can't bloat the trace files or leak credentials. Recursive `sanitizeValue` (`trace.ts:121`, internal): strings are scrubbed via `scrubPII` (`app-events.ts:91` — the same guardrails as app events) and cut at 4000 chars with an `… [truncated N chars]` marker; depth ≥ 6 becomes `"[max depth]"`; arrays/objects are capped at 50 entries with a trailing `… [N more]` marker; numbers/booleans/null pass through; functions, symbols, and bigints are defensively `String()`ed. A non-object top-level result is wrapped as `{ value }`; a throwing input yields `{ unserializable: <message> }` — the function itself never throws.

- **Calls:** `sanitizeValue` → `scrubPII` (`app-events.ts:91`)
- **Called by:** `createTraceSink`'s `emit` (`trace.ts:74`); tests `trace-sink.test.ts` (truncation marker, email/API-key scrub, depth/entry caps, exotic stringify)

### `pruneTraceEvents(now = Date.now()): Promise<void>` — `packages/backend/src/server/trace.ts:163`

Retention sweep: deletes trace steps with `emittedAt` older than the retention window via `traceEvents.pruneOlderThan(cutoff)` (the repo rewrites each agent's `trace.jsonl`, keeping only rows at/after the cutoff). `retentionDays()` (`trace.ts:156`, internal) parses `SH_TRACE_RETENTION_DAYS`, falling back to 14 for non-finite or non-positive values. Throttled by module state `lastPruneAt` (`trace.ts:154`) to once per hour; failures are logged (`[trace] prune failed`) and swallowed — never throws.

- **Calls:** `traceEvents.pruneOlderThan` (`store/repos/trace-events.ts:87`)
- **Called by:** `packages/backend/src/server/api/tick.ts:120` (`void pruneTraceEvents()`, fire-and-forget once per cron tick); tests `trace-sink.test.ts` (prune + hourly throttle + never throws)

### `resetPruneThrottleForTests(): void` — `packages/backend/src/server/trace.ts:175`

Test hook: resets `lastPruneAt` so the next `pruneTraceEvents` call runs despite the hourly throttle.

- **Calls:** nothing
- **Called by:** test-only — `trace-sink.test.ts`

---

## `packages/backend/src/server/validation.ts`

Path-safety validators for identifiers interpolated into filesystem paths (connector keys → `.simple-harmonic/connectors/<KEY>.json`, skill names → `.simple-harmonic/skills/<name>.json`). Without these, a key like `"../../secrets"` escapes the intended directory. Applied at the API route boundary **and** inside the path-building functions (defense in depth).

### `CONNECTOR_KEY_RE` (constant) — `packages/backend/src/server/validation.ts:10`

`/^[A-Z][A-Z0-9_]*$/` — env-var-style keys (e.g. `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`).

### `TOOL_NAME_RE` (constant) — `packages/backend/src/server/validation.ts:13`

`/^[A-Za-z][A-Za-z0-9_-]*$/` — skill/tool names (e.g. `slack_api`, `my-tool`). Notably permits no `.`, `/`, or leading digit, which is what blocks traversal.

### `isValidConnectorKey(key: unknown): key is string` — `packages/backend/src/server/validation.ts:15`

Type-guard: string and matches `CONNECTOR_KEY_RE`.

- **Calls:** regex test
- **Called by:** `assertValidConnectorKey` (`validation.ts:24`), `packages/backend/src/server/api/settings/connectors.ts:135`, `:155`

### `isValidToolName(name: unknown): name is string` — `packages/backend/src/server/validation.ts:19`

Type-guard: string and matches `TOOL_NAME_RE`.

- **Calls:** regex test
- **Called by:** `assertValidToolName` (`validation.ts:32`) only

### `assertValidConnectorKey(key: unknown): asserts key is string` — `packages/backend/src/server/validation.ts:23`

Throws `Error("invalid connector key: …")` on failure.

- **Calls:** `isValidConnectorKey`
- **Called by:** `packages/backend/src/server/connectors.ts:91` (`saveConnector`), `:112` (`deleteConnectorByKey`)

### `assertValidToolName(name: unknown): asserts name is string` — `packages/backend/src/server/validation.ts:31`

Throws `Error("invalid tool name: …")` on failure.

- **Calls:** `isValidToolName`
- **Called by:** `packages/backend/src/server/custom-tools.ts:62` (`saveCustomToolFile`), `:72` (`deleteCustomToolFile`)

---

## `packages/backend/src/server/store/index.ts`

Public entry point for the JSON file store — replaces the deleted `db/index.ts` (`db()`) and `db/schema.ts`. Re-exports the eight domain repos and their `New*` input types, the `types.ts` row interfaces (`export type * from "./types"`), and `getDataDir`/`setDataDir`. Adds three lifecycle helpers. Import repos from here, e.g. `import { teams, agents } from "../store"`.

### Re-exports — `packages/backend/src/server/store/index.ts:17`

| Export | From | Symbols |
|---|---|---|
| `actionLog`, `NewAction` | `repos/action-log` | line 17 |
| `agents`, `NewAgent` | `repos/agents` | line 18 |
| `appEvents`, `AppEventQuery`, `NewAppEvent` | `repos/app-events` | line 19 |
| `approvals`, `NewApproval` | `repos/approvals` | line 20 |
| `platformStatus` | `repos/platform-status` | line 21 |
| `spend`, `NewSpend` | `repos/spend` | line 22 |
| `teams`, `NewTeam` | `repos/teams` | line 23 |
| `traceEvents`, `NewTraceEvent`, `TraceQuery` | `repos/trace-events` | line 24 |
| `getDataDir`, `setDataDir` | `data-dir` | line 26 |
| `* (row types)` | `types` | line 27 |

### `ensureDataDir(): string` — `packages/backend/src/server/store/index.ts:30`

Creates the data-directory skeleton (`mkdirSync` of `teamsRoot()` and `systemDir()`, recursive) and returns `getDataDir()`. Idempotent.

- **Calls:** `mkdirSync`, `teamsRoot`, `systemDir`, `getDataDir`
- **Called by:** `packages/backend/src/server/api/settings/setup-db.ts:24`, `packages/backend/src/server/api/settings/test-db.ts:14`; the `data:init` CLI (`standalone/setup-db-cli.ts`)

### `resetStore(): void` — `packages/backend/src/server/store/index.ts:37`

Drops in-memory caches (`invalidateIndex()`). Call after pointing the store at a new data dir.

- **Calls:** `invalidateIndex` (`store/index-cache.ts:65`)
- **Called by:** test helpers (`packages/backend/tests/helpers/store.ts`)

### `clearStore(): void` — `packages/backend/src/server/store/index.ts:42`

Wipes all data — `rmSync` of `teamsRoot()` and `systemDir()` (recursive, force) — then `invalidateIndex()`. For seeds and test setup.

- **Calls:** `rmSync`, `teamsRoot`, `systemDir`, `invalidateIndex`
- **Called by:** test helpers / seeds

---

## `packages/backend/src/server/store/fs-store.ts`

Low-level synchronous filesystem primitives. All IO is synchronous: Node is single-threaded, so a sync read-modify-write runs to completion before any other event-loop task — concurrent agent runs (`Promise.allSettled` in the tick) cannot interleave a mutation and there is no write queue. JSON objects are written atomically (temp file + rename); JSONL logs append one line at a time. Every reader treats `ENOENT` as empty (missing file → fallback / `[]`); a corrupt JSON file throws.

| Function — `fs-store.ts:line` | Signature | Behavior |
|---|---|---|
| `pathExists` (`:30`) | `(p: string): boolean` | `existsSync`. |
| `readJson` (`:35`) | `<T>(path, fallback: T): T` | Read+parse; missing or empty file → `fallback`; corrupt → throws. |
| `writeJson` (`:48`) | `(path, value: unknown): void` | Atomic pretty-printed write (`<path>.tmp` then `renameSync`), trailing newline; `mkdir -p` parent. |
| `updateJson` (`:56`) | `<T>(path, fallback: T, mutate: (cur: T) => T): T` | Read → `mutate` → write atomically; returns the written value. |
| `readJsonl` (`:63`) | `<T>(path): T[]` | Parse each non-blank line; missing → `[]`. |
| `appendJsonl` (`:80`) | `(path, row: unknown): void` | Append one JSON line (`appendFileSync`); `mkdir -p` parent. |
| `appendJsonlMany` (`:86`) | `(path, rows: unknown[]): void` | Append many rows in one write; no-op on empty. |
| `rewriteJsonl` (`:93`) | `(path, rows: unknown[]): void` | Atomic full rewrite (temp + rename); empty array writes an empty file. Used by retention/prune and bulk edits. |
| `removePath` (`:101`) | `(p: string): void` | `rmSync(recursive, force)` — cascade-delete a file or folder subtree. |
| `movePath` (`:106`) | `(from, to): void` | `mkdir -p` the destination parent, then `renameSync`. |
| `listSubdirs` (`:112`) | `(dir): string[]` | Immediate sub-directory names; missing parent → `[]`. |
| `listFiles` (`:124`) | `(dir): string[]` | Immediate file names; missing parent → `[]`. |

- **Called by:** the eight repos, `index-cache.ts` (`listSubdirs`, `pathExists`), and `store/index.ts` indirectly. `ensureDir` (`:26`) is a private `mkdir -p` of `dirname(path)`.

---

## `packages/backend/src/server/store/data-dir.ts`

Data-directory resolution and path helpers. The default lives under `.simple-harmonic/data` so it sits beside the existing `connectors/` and `skills/` conventions. Team/agent folder paths are **not** fixed (they depend on hierarchy depth — sub-teams nest under their parent's `teams/`), so only the fixed roots live here; per-team/agent paths take the resolved directory as an argument and the resolution itself comes from the location index (`index-cache.ts`). On-disk layout is in the header comment (`data-dir.ts:4-15`).

### Module state: `override` — `packages/backend/src/server/store/data-dir.ts:27`

`let override: string | null = null` — the test-only data-dir override set by `setDataDir`.

### `getDataDir(): string` — `packages/backend/src/server/store/data-dir.ts:31`

Resolution order: `override` (test) > `getConfig().dataDir` (which itself resolves `simple-harmonic.config.json` > `SH_DATA_DIR` env > default `<cwd>/.simple-harmonic/data`).

- **Calls:** `getConfig` (`config.ts:50`)
- **Called by:** `teamsRoot`/`systemDir`/`getDataDir`-derived paths, `ensureDataDir`/`clearStore`; re-exported from `store/index.ts`

### `setDataDir(dir: string | null): void` — `packages/backend/src/server/store/data-dir.ts:36`

Sets `override`. Used by tests for isolation (`null` clears it back to config/env resolution). Note: callers swapping data dirs at runtime must also `resetStore()` and `resetA2AXForTests()` to drop the location index and the bound a2ax transport.

- **Calls:** nothing
- **Called by:** test helpers (`packages/backend/tests/helpers/store.ts`); re-exported from `store/index.ts`

### Fixed-root helpers

| Helper — `data-dir.ts:line` | Returns |
|---|---|
| `teamsRoot()` (`:42`) | `<dataDir>/teams` (the recursive team tree root; passed to `JsonFileTransport`). |
| `systemDir()` (`:46`) | `<dataDir>/system` (infra-level/global files). |
| `platformStatusPath()` (`:50`) | `<systemDir>/platform-status.json`. |
| `spendLogPath()` (`:55`) | `<systemDir>/spend.jsonl` (global day-keyed spend ledger). |
| `infraEventsPath()` (`:60`) | `<systemDir>/events.jsonl` (infra / team-less app events). |

### Within-team / within-agent path helpers (take a resolved dir)

| Helper — `data-dir.ts:line` | Returns |
|---|---|
| `teamJsonPath(teamDir)` (`:66`) | `<teamDir>/team.json` (the team-folder marker). |
| `teamEventsPath(teamDir)` (`:70`) | `<teamDir>/events.jsonl`. |
| `teamAgentsDir(teamDir)` (`:74`) | `<teamDir>/agents`. |
| `teamMessagesDir(teamDir)` (`:78`) | `<teamDir>/messages` (a2ax state). |
| `teamChildrenDir(teamDir)` (`:83`) | `<teamDir>/teams` (sub-team recursion). |
| `agentJsonPath(agentDir)` (`:89`) | `<agentDir>/agent.json`. |
| `agentApprovalsPath(agentDir)` (`:93`) | `<agentDir>/approvals.json`. |
| `agentActionsPath(agentDir)` (`:97`) | `<agentDir>/actions.jsonl`. |
| `agentTracePath(agentDir)` (`:101`) | `<agentDir>/trace.jsonl`. |

- **Called by:** the repos (each repo imports the helpers for its files) and `index-cache.ts` (`teamJsonPath`, `teamAgentsDir`, `teamChildrenDir`, `teamsRoot`).

---

## `packages/backend/src/server/store/index-cache.ts`

In-memory location index for the recursive team tree. A team's on-disk path is not derivable from its id (sub-teams nest under their parent's `teams/` to arbitrary depth), so this module walks the tree once and caches `teamId → { dir, parentTeamId }` and `agentId → { teamId, dir }`. Tree queries (roots / children / sub-tree / by-id) read from the cache instead of re-walking. The cache is invalidated on any team/agent create/delete/move; rebuild is cheap (< 100 teams).

### `TeamLoc` / `AgentLoc` (interfaces) — `index-cache.ts:22`, `:28`

`TeamLoc { teamId, dir, parentTeamId }`; `AgentLoc { agentId, teamId, dir }`.

### Module state: `cache` — `packages/backend/src/server/store/index-cache.ts:39`

`let cache: Index | null` — the lazily built `{ teams: Map, agents: Map }`. `build()` (`:53`) seeds the maps by walking `teamsRoot()`; `walk()` (`:41`) recurses, treating a folder as a team only when it contains `team.json`, and recursing into each team's `teams/` for sub-teams.

### `invalidateIndex(): void` — `packages/backend/src/server/store/index-cache.ts:65`

Sets `cache = null` so the next access re-walks.

- **Called by:** `teams.insert`/`delete`, `agents.insert`/`insertMany`/`move`/`delete`, `resetStore`/`clearStore`.

### Lookups (all build the cache on first access via `index()`)

| Function — `index-cache.ts:line` | Returns |
|---|---|
| `teamLoc(teamId)` (`:69`) | `TeamLoc \| undefined`. |
| `teamDir(teamId)` (`:73`) | the team's folder path, or `undefined`. |
| `allTeamLocs()` (`:77`) | every `TeamLoc`. |
| `childTeamLocs(parentTeamId)` (`:81`) | direct children (filter on `parentTeamId`). |
| `rootTeamLocs()` (`:85`) | teams with `parentTeamId === null`. |
| `agentLoc(agentId)` (`:89`) | `AgentLoc \| undefined`. |
| `agentLocsForTeam(teamId)` (`:93`) | agents whose `teamId` matches. |
| `allAgentLocs()` (`:97`) | every `AgentLoc`. |

- **Called by:** all repos that resolve a team/agent folder (`teams`, `agents`, `actionLog`, `approvals`, `appEvents`, `traceEvents`).

---

## `packages/backend/src/server/store/serialize.ts`

(De)serialization boundary. `Date` serializes to ISO for free on write (`Date.prototype.toJSON`); on read the store must turn the declared top-level timestamp keys back into `Date` to match the old Drizzle row shape. Revival is shallow on purpose — ISO-looking strings inside opaque blobs (`payload`, `metadata`, `data`, `conversationState`, `outputContract`) stay untouched, exactly as Postgres `jsonb` returned them.

### `reviveDates<T>(row: T, dateKeys: readonly string[]): T` — `packages/backend/src/server/store/serialize.ts:13`

For each named key, replaces a `string` value with `new Date(v)` in place; returns the row.

- **Called by:** every repo's `readX` helper (each declares a `DATE_KEYS` tuple).

### `reviveDatesAll<T>(rows: T[], dateKeys): T[]` — `packages/backend/src/server/store/serialize.ts:27`

`reviveDates` over a list.

- **Called by:** the JSONL/array repos (`actionLog`, `appEvents`, `approvals`, `traceEvents`).

---

## `packages/backend/src/server/store/types.ts`

Plain row interfaces and status unions for the store, moved here from the deleted `db/schema.ts`. Field names, optionality, and `Date`-vs-`string` match the old Postgres `$inferSelect` rows **exactly**, so API responses and the meta-agent engine are unchanged. Column-level / on-disk detail is in [docs/02-data-model.md](../02-data-model.md); the symbols are listed one line each, except `ApiToolConfig` (the one non-row export) which is documented in full.

### Status unions — `packages/backend/src/server/store/types.ts:12`

- `AgentStatus` (`:12`) — `running | paused | errored | awaiting_approval`.
- `ApprovalStatus` (`:13`) — `pending | approved | rejected`.
- `AppEventSeverity` (`:14`) — `info | warning | error`.
- `AppEventLevel` (`:15`) — `agent | team | tool | infra` (twin of the `AppEventLevel` TS type re-declared in `app-events.ts:28`).
- `PlatformStatusValue` (`:16`) — `healthy | degraded | maintenance`.

### Row interfaces (one line each — see docs/02-data-model.md for fields)

- `Team` (`:18`) — team tree (`parentTeamId`), goal, `paused`, `tickCount`, `metaAgentPrompt`, `cofounderName`, `telemetryEnabled`, `lastUserActiveAt`/`createdAt` Dates.
- `Agent` (`:32`) — per-agent config, `tools: string[]`, `scheduleSeconds`, `status`, `nextRunAt`, `inFlight`, opaque `conversationState`/`outputContract`.
- `PendingApproval` (`:49`) — one entry per destructive tool call awaiting sign-off (T2 flow): `status`, `decisionNote`, `resolvedAt`.
- `ActionLogEntry` (`:62`) — executed agent action (`actionType`, opaque `payload`, `metaAgentApprovalId`, `executedAt`).
- `AppEvent` (`:71`) — telemetry event (`severity`/`level`/`source`/`message`, nullable `teamId`/`agentId`, opaque `metadata`, `acknowledgedAt`, `createdAt`).
- `PlatformStatus` (`:84`) — singleton (`id: 1`): `status` + `message` + `updatedAt`.
- `AgentTraceEvent` (`:91`) — play-by-play trace row (PR #12): `tickId` groups one logical tick, sort key `(emittedAt, seq)`; opaque `data`.
- `LlmSpendEntry` (`:103`) — spend ledger row (`costCents`, text `day` as UTC `YYYY-MM-DD`).

### `ApiToolConfig` (interface) — `packages/backend/src/server/store/types.ts:121`

Shape of a custom tool's `config` field in `.simple-harmonic/skills/<name>.json`. Moved here from the deleted `db/schema.ts`; a shared type only — never backed by any table/file row.

| Field | Type | Notes |
|---|---|---|
| `baseUrl` | `string` | required; a file without a string `config.baseUrl` is skipped by the loader (`custom-tools.ts:48`) |
| `connectorKey` | `string` | resolved via `resolveConnector` at call time |
| `authHeader?` | `string` | header to carry the credential |
| `authPrefix?` | `string` | e.g. `"Bearer "` |
| `allowedMethods` | `string[]` | HTTP method allow-list |
| `defaultHeaders?` | `Record<string, string>` | merged into every request |
| `pathPrefix?` | `string` | prepended to request paths |

- **Used by:** `packages/backend/src/server/custom-tools.ts:32` (`CustomToolFile.config`), `packages/backend/src/server/tools/api-tool-runtime.ts:12`, `:23`, `:60`; tests `api-tool-runtime.test.ts`, `custom-tools.test.ts`

---

## `packages/backend/src/server/store/repos/teams.ts`

The `teams` repo. Each team is a folder; its location in the recursive tree encodes the hierarchy. `team.json` holds the row; the location index maps `teamId → dir`. `NewTeam` (`:28`) is the insert input (`name` required; `parentTeamId`/`goal`/`cofounderName`/`metaAgentPrompt`/`paused`/`tickCount`/`telemetryEnabled` optional). Private `readTeam(dir)` (`:23`) reads+revives `team.json`, `DATE_KEYS = [lastUserActiveAt, createdAt]`.

| Method — `teams.ts:line` | Signature | Behavior · index effect |
|---|---|---|
| `all` (`:41`) | `(): Promise<Team[]>` | Every team, oldest-first by `createdAt`. |
| `byId` (`:48`) | `(id): Promise<Team \| null>` | `teamDir(id)` then `readTeam`; `null` if unknown. |
| `roots` (`:53`) | `(): Promise<Team[]>` | `rootTeamLocs()` → rows. |
| `children` (`:59`) | `(parentId): Promise<Team[]>` | `childTeamLocs(parentId)` → rows. |
| `listUnpaused` (`:65`) | `(): Promise<Team[]>` | `all()` filtered to `!paused`. |
| `insert` (`:69`) | `(input: NewTeam): Promise<Team>` | New `randomUUID`; nests under the parent's `teams/` when `parentTeamId` set (throws if parent unknown); writes `team.json`; **invalidates the index**. |
| `update` (`:97`) | `(id, patch): Promise<Team \| null>` | `updateJson` merge of `team.json`; revives dates; `null` if unknown. |
| `incrementTickCount` (`:107`) | `(id): Promise<void>` | `updateJson` bumping `tickCount` (defaults 0). |
| `delete` (`:117`) | `(id): Promise<void>` | `removePath(dir)` (drops the whole subtree — agents, messages, sub-teams) then **invalidates the index**. |

- **Called by:** widely — `api/tick.ts` (`listUnpaused`, `incrementTickCount`), `api/teams.ts`, `api/spawn.ts`, `api/chat.ts`, `api/seed.ts`, `api/settings/{telemetry,skills}.ts`, `api/team/id/{index,pause,heartbeat,approvals,conversations,agent-hub,tasks}.ts`, `tools/management.ts` (`insert`/`update`/`delete`), `tools/action-history.ts`; via `team-tree.ts` (`all`/`children`/`roots`) and `app-events.ts` (`byId`).

---

## `packages/backend/src/server/store/repos/agents.ts`

The `agents` repo. Each agent is a folder under its team's `agents/` dir, holding `agent.json` plus `approvals.json`/`actions.jsonl`/`trace.jsonl`. The location index maps `agentId → dir` so by-id lookups don't need the owning team. `NewAgent` (`:28`) is the insert input. Private `readAgent(dir)` (`:23`) reads+revives, `DATE_KEYS = [nextRunAt, createdAt]`; `buildRow` (`:40`) fills defaults (`status: "running"`, `inFlight: false`, `conversationState: null`).

| Method — `agents.ts:line` | Signature | Behavior · index effect |
|---|---|---|
| `byId` (`:60`) | `(id): Promise<Agent \| null>` | `agentLoc(id)` then `readAgent`. |
| `byTeam` (`:65`) | `(teamId): Promise<Agent[]>` | `agentLocsForTeam` → rows. |
| `byTeams` (`:72`) | `(teamIds: Iterable<string>): Promise<Agent[]>` | Agents across many teams (e.g. a sub-tree). |
| `all` (`:80`) | `(): Promise<Agent[]>` | Every agent. |
| `insert` (`:86`) | `(teamId, input): Promise<Agent>` | Writes `agent.json` under the team (throws if team unknown); **invalidates the index**. |
| `insertMany` (`:95`) | `(teamId, inputs): Promise<Agent[]>` | Batch insert; invalidates the index when any row written. |
| `update` (`:106`) | `(id, patch): Promise<Agent \| null>` | `updateJson` merge; revives dates. |
| `move` (`:117`) | `(id, toTeamId): Promise<Agent \| null>` | Rewrites `teamId`, `movePath`s the folder under the destination team, **invalidates the index**. |
| `delete` (`:131`) | `(id): Promise<void>` | `removePath(dir)` then **invalidates the index**. |
| `claim` (`:144`) | `(id, expectedStatus): Promise<boolean>` | **Atomic in-flight claim** — synchronous read+write (no `await` between) sets `inFlight = true` only when currently not in flight and in `expectedStatus`. The single-thread equivalent of the old conditional `UPDATE … RETURNING`. |
| `resetAllInFlight` (`:156`) | `(): Promise<void>` | Clears `inFlight` on every agent (crash recovery on process start). |

- **Called by:** `api/tick.ts` (`resetAllInFlight`, `byTeam`, `update`, `claim`), `api/spawn.ts`/`api/seed.ts` (`insertMany`), `api/chat.ts`, `api/agent/id.ts`, `api/settings/skills.ts`, `api/team/id/{index,agent-hub,narration,messages,conversations,tasks,approvals}.ts`, `tools/management.ts` (`byTeams`/`insertMany`/`byTeam`/`delete`/`move`/`update`), `tools/action-history.ts`.

---

## `packages/backend/src/server/store/repos/action-log.ts`

The `actionLog` repo. Append-only per-agent history in `actions.jsonl`; reads merge across agents and sort newest-first to match the old `ORDER BY executed_at DESC`. `NewAction` (`:25`) = `{ actionType, payload, metaAgentApprovalId? }`. Private `readForAgent` (`:16`) reads+revives one agent's file (`DATE_KEYS = [executedAt]`).

| Method — `action-log.ts:line` | Signature | Behavior |
|---|---|---|
| `insert` (`:32`) | `(agentId, e: NewAction): Promise<ActionLogEntry>` | Appends one row (`randomUUID`, `executedAt = now`); throws if agent unknown. |
| `byAgents` (`:48`) | `(agentIds, { limit?, since? }): Promise<ActionLogEntry[]>` | Merge across agents, optional `since` filter (`executedAt > since`), sort newest-first, optional `limit`. |
| `recentByAgent` (`:62`) | `(agentId, limit): Promise<ActionLogEntry[]>` | `byAgents([agentId], { limit })`. |

- **Called by:** `api/tick.ts:62`, `:83`, `:673`, `:687`; `api/team/id/narration.ts:42`, `:54`; `api/team/id/agent-hub.ts:27`; `tools/action-history.ts:103`.

---

## `packages/backend/src/server/store/repos/app-events.ts`

The `appEvents` repo. Append-only JSONL: team/agent/tool events live in the owning team's `events.jsonl`, infra and team-less events in `system/events.jsonl`. Queries gather across the relevant files, filter, sort newest-first, limit — mirroring the old `WHERE/ORDER BY/LIMIT`. `NewAppEvent` (`:29`) and `AppEventQuery` (`:39`) mirror the `app-events.ts` shapes. Private `readPath` (`:17`) reads+revives (`DATE_KEYS = [acknowledgedAt, createdAt]`); `allEventPaths` (`:25`) = every team's file plus the infra file.

| Method — `app-events.ts:line` | Signature | Behavior |
|---|---|---|
| `insert` (`:52`) | `(e: NewAppEvent): void` | **Synchronous** — fills `id`/`acknowledgedAt: null`/`createdAt`, then `appendJsonl` to the team file (when `teamId` resolves to a live team) or the infra file. Telemetry never blocks. |
| `query` (`:71`) | `(q?: AppEventQuery): Promise<AppEvent[]>` | Reads one team's file (when `teamId` set) else all; in-memory filters (`severity`/`level`/`source`/`since`/`includeInfra`/`unacknowledgedOnly`); newest-first; `slice(0, limit ?? 20)`. |
| `acknowledge` (`:98`) | `(ids: string[]): Promise<number>` | Sets `acknowledgedAt = now` on matching unacked rows across all files via `rewriteJsonl`; returns the count touched. |

- **Called by:** `app-events.ts` (`doInsert` → `insert`, `queryAppEvents` → `query`), `api/infra-report.ts:69` (`acknowledge`).

---

## `packages/backend/src/server/store/repos/approvals.ts`

The `approvals` repo. Pending approvals stored per agent in `approvals.json` (an array); deleting an agent folder removes its approvals for free (no cascade to manage). `NewApproval` (`:23`) = `{ teamId, toolCallId, toolName, toolArguments }`. Private `readForDir` (`:16`) reads+revives (`DATE_KEYS = [createdAt, resolvedAt]`).

| Method — `approvals.ts:line` | Signature | Behavior |
|---|---|---|
| `byAgent` (`:31`) | `(agentId): Promise<PendingApproval[]>` | All approvals for one agent. |
| `insertMany` (`:37`) | `(agentId, rows: NewApproval[]): Promise<void>` | Appends `status: "pending"` rows (all belong to the one agent). |
| `clearForAgent` (`:60`) | `(agentId): Promise<void>` | Writes `[]` (consumed on resume / defensive clear). |
| `pendingForTeam` (`:67`) | `(teamId): Promise<PendingApproval[]>` | All `pending` approvals across the team's agents. |
| `resolve` (`:81`) | `(teamId, approvalId, decision, note): Promise<{ ok: true; agentId } \| { ok: false; reason: "not_found" \| "already" }>` | Scans the team's agents for the approval, sets `status`/`decisionNote`/`resolvedAt` when still `pending`; returns the owning `agentId` or the failure reason. |

- **Called by:** `api/tick.ts` (`insertMany`/`clearForAgent`/`pendingForTeam` around suspend/resume), `api/team/id/approvals.ts:8`, `:42`.

---

## `packages/backend/src/server/store/repos/platform-status.ts`

The `platformStatus` repo. A single object file (`system/platform-status.json`) replacing the singleton table. Private `DATE_KEYS = [updatedAt]`.

| Method — `platform-status.ts:line` | Signature | Behavior |
|---|---|---|
| `get` (`:14`) | `(): Promise<PlatformStatus \| null>` | Reads+revives the file; `null` when unset. |
| `set` (`:19`) | `({ status, message }): Promise<PlatformStatus>` | Writes `{ id: 1, status, message, updatedAt: now }`. |

- **Called by:** `app-events.ts:289` (`getPlatformStatus` → `get`), `api/settings/platform-status.ts:9`, `:39`.

---

## `packages/backend/src/server/store/repos/spend.ts`

The `spend` repo. One global append-only JSONL (`system/spend.jsonl`), day-keyed. `NewSpend` (`:11`) carries `{ teamId, agentId, model, inputTokens, outputTokens, costCents, day }`.

| Method — `spend.ts:line` | Signature | Behavior |
|---|---|---|
| `insert` (`:22`) | `(e: NewSpend): Promise<void>` | Appends one ledger row (`randomUUID`, `createdAt = now`). |
| `sumForDay` (`:38`) | `(day: string): Promise<number>` | Reads the ledger and totals `costCents` for rows whose `day` matches. |

- **Called by:** `spend.ts` (`recordSpend` → `insert`, `spentTodayCents` → `sumForDay`).

---

## `packages/backend/src/server/store/repos/trace-events.ts`

The `traceEvents` repo. Append-only per-agent `trace.jsonl`, one row per agent step. Queries gather across a team's agents (or one agent), filter by tick, and sort by `(emittedAt, seq)` to match the old global sort key. `NewTraceEvent` (`:17`) is a step ready to persist (`id`/`createdAt` filled here); `TraceQuery` (`:39`) = `{ teamId, agentId?, tickId?, since?, order, limit }`. Private `readForDir` (`:27`) reads+revives (`DATE_KEYS = [emittedAt, createdAt]`); `cmp` (`:34`) orders by `(emittedAt, seq)` asc/desc.

| Method — `trace-events.ts:line` | Signature | Behavior |
|---|---|---|
| `append` (`:50`) | `(rows: NewTraceEvent[]): Promise<void>` | Buckets rows by `agentId` (a batch may span agents), fills `id`/shared `createdAt`, `appendJsonlMany` to each agent's `trace.jsonl`. |
| `query` (`:66`) | `(q: TraceQuery): Promise<AgentTraceEvent[]>` | Reads one agent's file (when `agentId` set) else the team's agents; filters by `teamId`/`agentId`/`tickId`/`since`; sorts by `cmp`; `slice(0, limit)`. |
| `pruneOlderThan` (`:87`) | `(cutoff: Date): Promise<void>` | Rewrites each agent's `trace.jsonl`, keeping only rows at/after `cutoff`. |

- **Called by:** `trace.ts` (`createTraceSink` → `append`, `pruneTraceEvents` → `pruneOlderThan`), `api/team/id/trace.ts:55`, `:73` (the SSE poll → `query`).

---

## a2ax transport (PR #16): `JsonFileTransport`

The a2ax host wiring (`server/a2ax.ts`, documented above) now builds `new JsonFileTransport(teamsRoot())` — **not** `DrizzleTransport`, and with no `db()`. `DrizzleTransport`, `drizzle.ts`, and `drizzle-schema.ts` were removed from the `@simple-harmonic/a2ax` package entirely; nothing in the repo references them (verified: no `DrizzleTransport`/`drizzle` matches under `packages/*/src`). The package's surviving transports are `MemoryTransport` (`packages/a2ax/src/transport/memory.ts`) and the new `JsonFileTransport`.

### `JsonFileTransport` — `packages/a2ax/src/adapters/json-file.ts:44`

Implements the same `Transport` interface as `MemoryTransport`, persisting each team's a2ax state under `<teamDir>/messages/{log.jsonl, reads.jsonl, channels.json, members.json, tasks.json, cards.json, tokens.json}`. Constructed with the absolute `<dataDir>/teams` root. It hydrates all state into memory once by walking the team tree (`discoverTeamMessageDirs`), so the teamId-less methods (`markRead`, `getTask`, `getToken`, …) resolve O(1) in memory while writes are mirrored to the owning team's files. Query/relevance logic is identical to `MemoryTransport`. Single-process, single-writer. Exported via the package's `./adapters/json-file` subpath; `dist/adapters/json-file.js` and `dist/storage/file-store.js` are committed.

- **Calls:** `discoverTeamMessageDirs`, `readJson`/`readJsonl`/`writeJson`/`appendJsonl`/`rewriteJsonl` from `packages/a2ax/src/storage/file-store.ts` (self-contained sync fs helpers — the a2ax package must not import the backend store).
- **Used by:** `packages/backend/src/server/a2ax.ts:15` (`getA2AX`).

### `discoverTeamMessageDirs(teamsRoot): Map<string, string>` — `packages/a2ax/src/storage/file-store.ts:86`

Walks the recursive team tree (a folder is a team if it has `team.json`; children live in its `teams/`) and returns `teamId → <teamDir>/messages`. This is the a2ax package's own copy of the team-tree walk (it cannot depend on the backend's `index-cache.ts`).

- **Called by:** `JsonFileTransport.hydrate` (`json-file.ts:62`) and `dirForTeam` (`:104`).

---

## Python backend (FastAPI port) — symbol reference

The idiomatic Python rewrite (`backend-py/simple_harmonic/`, 2026-06-14: full 43-endpoint parity, 834 tests) mirrors the TS server layer module-for-module, with the same HTTP contract. The cross-cutting naming rule: **module-level TS functions → `snake_case` functions** (`emitAppEvent` → `emit_app_event`), but **store repo objects keep their TS `camelCase` method names verbatim** (`teams.byId`, `actionLog.recentByAgent`, `traceEvents.pruneOlderThan`) so call sites read identically across runtimes — the repo singletons themselves are also `camelCase` (`appEvents`, `platformStatus`). Row types are Pydantic models with `camelCase` fields and `populate_by_name=True`, so Response JSON is byte-identical. Two structural differences from TS worth stating once: the event/telemetry/trace store writes are **injectable hooks** (the slice modules never import `store`), wired at boot by `wiring.py`; and every store read-modify-write runs under a per-event-loop `asyncio.Lock` dispatched to a worker thread, the explicit replacement for Node's implicit single-task atomicity.

### `backend-py/simple_harmonic/app.py`

The FastAPI application factory. TS source: `server.ts` (`createBackendServer`) + `routes.ts` + `standalone/server.ts` (operator gate).

- `create_app(store=None, *, start_tick_loop=None) -> FastAPI` — `backend-py/simple_harmonic/app.py:110` — builds the app: resolves the `Store` (defaults to `RepoStore()`), installs `OperatorGateMiddleware`, includes the routers, and stashes the store on `app.state.store`. TS: `createBackendServer`.
- `lifespan(application)` (async ctx mgr) — `backend-py/simple_harmonic/app.py:126` — startup/shutdown: calls `wire_runtime()`, `store.ensure()`, and conditionally starts the background tick loop as an `asyncio` task (per `start_tick_loop` or `tick_loop_should_start()`), cancelling it on shutdown. Replaces the TS standalone `main.ts` boot.
- `main() -> None` — `backend-py/simple_harmonic/app.py:178` — process entrypoint (TS `standalone/main.ts`): boots uvicorn over `app`, port from `SH_BACKEND_PORT`/`PORT` (default 3001).
- `OperatorGateMiddleware` (class) — `backend-py/simple_harmonic/app.py:85` — Starlette middleware enforcing the operator gate. Unlike the broad TS proxy gate, it gates by an explicit ALLOWLIST: `GATED_PREFIXES` (`:51` — settings/chat/spawn/seed/infra-report/agent) minus `OPEN_PREFIXES` (`:61` — tick/login/health/teams/team). `_is_gated(path)` (`:74`) is the decision; permissive in dev when the password is unset, fails closed (503) in prod.
- `app` (module global) — `backend-py/simple_harmonic/app.py:175` — the ASGI entry point for `uvicorn simple_harmonic.app:app`.

### `backend-py/simple_harmonic/dependencies.py`

FastAPI dependency provider.

- `get_store(request) -> Store` — `backend-py/simple_harmonic/dependencies.py:15` — hands route handlers the store stashed on `app.state` by the factory. Overridable in tests via `app.dependency_overrides`. (No single TS analogue — replaces ad-hoc store imports in the TS handlers.)

### `backend-py/simple_harmonic/config.py`

File-based config over `simple-harmonic.config.json`. TS source: `config.ts`. Precedence matches `getConfig`: file > env > Codex token (api key only) > default.

- `get_config() -> AppConfig` — `backend-py/simple_harmonic/config.py:110` — resolves the effective config (TS `getConfig`). The Codex token lookup is an injectable hook (`codex_access_token`, `:82`, default `None`) so this module stays free of the codex-auth dependency.
- `get_api_key_source() -> ApiKeySource` — `backend-py/simple_harmonic/config.py:147` — which source the API key came from (`"config"|"env"|"codex"|"none"`); the tick branches on `"codex"`. TS `getApiKeySource`.
- `get_safe_config() -> SafeConfig` — `backend-py/simple_harmonic/config.py:167` — client-safe view with the API key masked, plus `hasOpenaiKey`/`hasDataDir`/`apiKeySource`. TS `getSafeConfig`.
- `set_config(partial) -> AppConfig` — `backend-py/simple_harmonic/config.py:159` — shallow-merges `partial` into the raw file and rewrites it, returning the re-resolved config. TS `setConfig`.
- `AppConfig` / `SafeConfig` / `CodingBackendConfig` (Pydantic models) — `backend-py/simple_harmonic/config.py:56` / `:66` / `:51` — config row shapes; `AppConfig.dataDir` (PR #16) replaces the old `databaseUrl`.
- `CodingBackendType` / `ApiKeySource` (Literal types) — `backend-py/simple_harmonic/config.py:30` / `:31`. Defaults at `:34` (`DEFAULT_MODEL = "gpt-5.5"`, `DEFAULT_OPENAI_BASE_URL`, `DEFAULT_CODING_BACKEND`).
- Private `_read_file()` (`:85`), `_mask_secret()` (`:183`, TS `maskSecret`), `_str()` coercion (`:191`).

### `backend-py/simple_harmonic/auth.py`

Operator / cron auth. TS source: `operator-auth.ts`. Preserves the exact wire contract: cookie = hex `sha256(OPERATOR_PASSWORD)`, constant-time compares, cron header trusted only on Vercel.

- `is_operator_authorized(headers, password) -> bool` — `backend-py/simple_harmonic/auth.py:82` — Bearer `OPERATOR_PASSWORD` or `sh_operator` cookie. TS `isOperatorAuthorized`.
- `is_cron_authorized(headers, cron_secret) -> bool` — `backend-py/simple_harmonic/auth.py:92` — Vercel cron header or Bearer `CRON_SECRET`; permissive in dev, fails closed in prod. TS `isCronAuthorized`.
- `is_production_runtime() -> bool` — `backend-py/simple_harmonic/auth.py:29` — `NODE_ENV=production` or `VERCEL`. TS `isProductionRuntime`.
- `sha256_hex(value) -> str` — `backend-py/simple_harmonic/auth.py:34` (TS `sha256Hex`); `constant_time_equal(a, b) -> bool` — `:39` (TS `constantTimeEqual`, via `hmac.compare_digest`).
- `OPERATOR_COOKIE = "sh_operator"` — `backend-py/simple_harmonic/auth.py:26`. Private cookie/header parsers `_read_cookie` (`:72`), `_get_header` (`:56`), `_bearer_token` (`:51`).

### `backend-py/simple_harmonic/apollo.py`

AES-256-GCM encrypted secrets vault. TS source: `apollo.ts`. Crypto-interoperable with the Node vault (`[iv(12)][tag(16)][ciphertext]` layout, `scrypt` N=16384/r=8/p=1) — a vault written by either runtime decrypts under the other.

- `load() -> dict[str, int]` — `backend-py/simple_harmonic/apollo.py:142` — decrypts the vault into `os.environ` (operator-set vars win), returns `{"count": n}`. Never throws. TS `load`.
- `set(key, value) -> None` — `backend-py/simple_harmonic/apollo.py:175` — store a secret, encrypt + persist immediately. TS `set`.
- `remove(key) -> None` — `backend-py/simple_harmonic/apollo.py:201`; `get(key) -> str | None` — `:223` (cache-only); `list_keys() -> list[str]` — `:229` (TS `listKeys`); `has(key) -> bool` — `:234`; `mask(value) -> str` — `:239`; `init(root) -> None` — `:136`.
- Crypto primitives `encrypt_gcm(key, iv, plaintext)` — `:89`, `decrypt_gcm(key, iv, ciphertext, tag)` — `:96` (split-tag layout matching Node's `getAuthTag`/`setAuthTag`). Private `_encrypt` (`:110`, TS `encrypt`), `_decrypt` (`:119`, TS `decrypt`), `_derive_key` (`:75`, TS `deriveKey`), `_resolve_master_key` (`:257`), `_ensure_master_key` (`:273`), `_resolve_salt`/`_ensure_salt` (`:291`/`:301`).
- Constants `APOLLO_DIR`/`VAULT_FILE`/`MASTER_KEY_FILE`/`SALT_FILE`/`LEGACY_SALT` — `backend-py/simple_harmonic/apollo.py:34`.

### `backend-py/simple_harmonic/events.py`

App-event emitter. TS source: `app-events.ts` (the two store-independent pieces). Store persistence + telemetry read are injectable hooks (`set_event_sink`/`set_telemetry_reader`), wired by `wiring.py`.

- `emit_app_event(*, severity, source, message, level=None, team_id=None, agent_id=None, metadata=None) -> None` — `backend-py/simple_harmonic/events.py:163` — fire-and-forget event write; swallows ALL errors; per-agent rate limiting, PII scrub, infra→`team_id=None`, telemetry gate for tool/infra. TS `emitAppEvent` (kwargs-only here vs the TS single-object arg).
- `scrub_pii(message) -> str` — `backend-py/simple_harmonic/events.py:66` — strips keys/tokens/emails; the lookbehind pattern is rewritten as a capturing prefix (Python `re` rejects JS's variable-width lookbehind) but emits byte-identical output. Shared with `trace.py`. TS `scrubPII`.
- `set_event_sink(sink) -> None` — `backend-py/simple_harmonic/events.py:137`; `set_telemetry_reader(reader) -> None` — `:143` — the wiring seam (no TS analogue; TS calls `appEvents.insert`/`teams.byId` directly).
- `reset_rate_limiter_for_tests() -> None` — `backend-py/simple_harmonic/events.py:232`. Constants `RATE_LIMIT = 50` / `RATE_WINDOW_MS` — `:79`. `AppEventLevel`/`Severity` Literals — `:33`. Private `_check_rate_limit` (`:99`, TS `checkRateLimit`), `_is_telemetry_enabled` (`:149`), `_do_insert` (`:225`).

### `backend-py/simple_harmonic/trace.py`

Server-side play-by-play trace sink. TS source: `trace.ts`. The store appender is an injectable callback (`append`); the documented drain/flush race window is preserved.

- `create_trace_sink(*, team_id, agent_id, tick_id=None, append=_noop_append) -> PersistentTraceSink` — `backend-py/simple_harmonic/trace.py:58` — builds a buffering sink draining via a single background `asyncio` task; `tick_id` is reused on resume. TS `createTraceSink`.
- `PersistentTraceSink` (dataclass: `tick_id`, `emit`, `flush`) — `backend-py/simple_harmonic/trace.py:46` — the runner-facing handle.
- `sanitize_trace_data(data) -> dict` — `backend-py/simple_harmonic/trace.py:136` — PII-scrub + truncate (`MAX_STRING_LENGTH=4000`, `MAX_DEPTH=6`, `MAX_ENTRIES=50`, constants at `:33`). TS `sanitizeTraceData`. Private `_sanitize_value` (`:146`).
- `prune_trace_events(prune_older_than=None, now_ms=None)` (async) — `backend-py/simple_harmonic/trace.py:197` — hourly-throttled retention sweep (default 14d, `SH_TRACE_RETENTION_DAYS`); the store deletion is injected as `prune_older_than`. TS `pruneTraceEvents`.
- `reset_prune_throttle_for_tests()` — `backend-py/simple_harmonic/trace.py:217`.

### `backend-py/simple_harmonic/tick.py`

Tick orchestrator — the self-scheduling agent loop. TS source: `api/tick.ts` (`run_tick`) + `standalone/main.ts` (the 10s loop).

- `run_tick(now=None) -> dict` — `backend-py/simple_harmonic/tick.py:271` — one tick pass over every active team: resets stuck `inFlight` once per process, filters hibernated teams, daily spend cap (fail-open), then per team resumes parked agents and runs due agents. Returns `{ok, agentsRan, timestamp}`. TS `tick.ts` POST handler.
- `with_timeout(run, ms, label)` (async) — `backend-py/simple_harmonic/tick.py:144` — races a run against a wall-clock budget; passes an `asyncio.Event` cancellation token (the Python mapping of TS `AbortSignal`), raises `AgentTimeoutError` (`:137`) on timeout.
- `run_tick_loop(stop, interval_ms=10_000)` (async) — `backend-py/simple_harmonic/tick.py:905` — the background task driving `run_tick` every 10s until `stop` is set; in-process call replaces the TS self-POST loop.
- `tick_loop_should_start() -> bool` — `backend-py/simple_harmonic/tick.py:883` — boot rules: off when `SH_TICK_LOOP=0`; refuses to start in prod without `CRON_SECRET`. TS `main.ts` boot logic.
- Private but load-bearing: `_try_resume_agent(args)` (`:535`) — the HOLD/RESUME/DENY resume guard (TS `tryResumeAgent`); `_run_fresh_agent(args)` (`:442`); `_handle_run_result` (`:747`); `_fail_agent` (`:814`); `_resolve_tick_llm` (`:694`, the cascade `on_fallback` hook); `_LazyLLM` (`:671`). `reset_in_flight_guard_for_tests()` — `:112`.

### `backend-py/simple_harmonic/wiring.py`

Runtime wiring: closes the store-decoupling seam at boot. No single TS analogue (TS wires the store directly inside `app-events.ts`).

- `wire_runtime() -> None` — `backend-py/simple_harmonic/wiring.py:75` — idempotently points the event sink at `appEvents.insert` and the telemetry reader at a cached `teams.byId` lookup. Called by the lifespan.
- `invalidate_telemetry_cache(team_id) -> None` — `backend-py/simple_harmonic/wiring.py:85` — drops one team's cached telemetry flag (TS `invalidateTelemetryCache`); called by the telemetry PUT handler.
- `reset_telemetry_cache_for_tests() -> None` — `backend-py/simple_harmonic/wiring.py:95`. Private `_event_sink` (`:28`), `_telemetry_reader` (`:50`, sync + fail-open with a background refresh), `_refresh_telemetry` (`:68`).

### `backend-py/simple_harmonic/a2ax_singleton.py`

Process-wide a2ax instance. TS source: `a2ax.ts`.

- `get_a2ax() -> A2AX` — `backend-py/simple_harmonic/a2ax_singleton.py:26` — the shared `A2AX` facade over `JsonFileTransport(teams_root())`, created on first use (`max_context_messages=20`, 7-day expiry). TS `getA2AX`.
- `reset_a2ax_for_tests() -> None` — `backend-py/simple_harmonic/a2ax_singleton.py:40` — drops the cached instance so the next call rebinds to the current `teams_root()`. TS `resetA2AXForTests`.

### `backend-py/simple_harmonic/team_tree.py`

Recursive team-hierarchy queries + lead-agent authorization scoping. TS source: `team-tree.ts`.

- `get_sub_tree_ids(team_id) -> set[str]` — `backend-py/simple_harmonic/team_tree.py:41` — all team ids in the sub-tree (inclusive); the authorization-scoping primitive. TS `getSubTreeIds`.
- `is_ancestor(ancestor_id, team_id) -> bool` — `backend-py/simple_harmonic/team_tree.py:61` (TS `isAncestor`); `get_ancestor_chain(team_id) -> list[str]` — `:83` (TS `getAncestorChain`).
- `get_child_teams(team_id)` — `:31`; `get_root_teams()` — `:36`; `get_team_tree() -> list[TeamTreeNode]` — `:113` (TS `getTeamTree`). `TeamTreeNode` (dataclass) — `:103`.

### `backend-py/simple_harmonic/validation.py`

Path-traversal guards for identifiers. TS source: `validation.ts`. TS `is*` type guards → bool predicates; TS `assert*` (which narrow to `string`) → functions that raise `ValueError`.

- `assert_valid_connector_key(key) -> str` — `backend-py/simple_harmonic/validation.py:34` (TS `assertValidConnectorKey`); `assert_valid_tool_name(name) -> str` — `:46` (TS `assertValidToolName`).
- `is_valid_connector_key(key) -> bool` — `:26`; `is_valid_tool_name(name) -> bool` — `:30`. Patterns `CONNECTOR_KEY_RE` (`:20`), `TOOL_NAME_RE` (`:23`).

---

### `backend-py/simple_harmonic/store/types.py`

Pydantic row models. TS source: `store/types.ts`. All `camelCase` fields + `populate_by_name=True` so Response JSON is byte-identical (datetimes → ISO-8601).

- Models — `backend-py/simple_harmonic/store/types.py`: `Team` (`:23`), `Agent` (`:39`), `PendingApproval` (`:58`), `AppEvent` (`:73`), `PlatformStatus` (`:88`), `ActionLogEntry` (`:97`), `AgentTraceEvent` (`:108`), `LlmSpendEntry` (`:122`), `ApiToolConfig` (`:136`).
- Literal status types — `:16`: `AgentStatus`, `ApprovalStatus`, `AppEventSeverity`, `AppEventLevel`, `PlatformStatusValue`.

### `backend-py/simple_harmonic/store/serialize.py`

(De)serialization boundary. TS source: `store/serialize.ts`. Revives ONLY declared top-level date keys (never deep-walks opaque blobs).

- `revive_dates(row, date_keys) -> dict` — `backend-py/simple_harmonic/store/serialize.py:21` — ISO string → `datetime` in place for the named keys. TS `reviveDates`.
- `revive_dates_all(rows, date_keys) -> list[dict]` — `:34` (list variant, no TS analogue — TS maps inline).
- `json_default(value) -> str` — `backend-py/simple_harmonic/store/serialize.py:43` — the `json.dumps(default=...)` hook serializing `datetime` to UTC ISO with trailing `Z` + ms precision, matching JS `Date.prototype.toJSON`. Private `_to_iso_z` (`:56`).

### `backend-py/simple_harmonic/store/fs.py`

Blocking filesystem primitives (atomic write + rename). TS source: `store/fs-store.ts`. Called off the event loop via `anyio.to_thread.run_sync` (see `_runner.py`).

- `read_json[T](path, fallback) -> T` — `backend-py/simple_harmonic/store/fs.py:28`; `write_json(path, value)` — `:39` (atomic temp+rename); `update_json[T](path, fallback, mutate)` — `:47`.
- `read_jsonl(path) -> list` — `:54`; `append_jsonl(path, row)` — `:68`; `append_jsonl_many(path, rows)` — `:74`; `rewrite_jsonl(path, rows)` — `:84` (atomic, for prune).
- `move_path(src, dst)` — `:93`; `remove_path(path)` — `:99`; `list_subdirs(directory)` — `:109`; `list_files(directory)` — `:117`; `path_exists(path)` — `:24`.

### `backend-py/simple_harmonic/store/data_dir.py`

Data-directory resolution + path helpers. TS source: `store/data-dir.ts`.

- `get_data_dir() -> Path` — `backend-py/simple_harmonic/store/data_dir.py:26` (test override > settings); `set_data_dir(directory)` — `:33` (test isolation).
- `ensure_data_dir() -> Path` — `backend-py/simple_harmonic/store/data_dir.py:104` — creates the `teams/` + `system/` skeleton, idempotent. TS `ensureDataDir`.
- Fixed roots: `teams_root()` (`:42`), `system_dir()` (`:46`), `platform_status_path()` (`:50`), `spend_log_path()` (`:54`), `infra_events_path()` (`:58`). Per-team/per-agent path builders at `:65`–`:101` (`team_json_path`, `agent_json_path`, `agent_approvals_path`, `agent_actions_path`, `agent_trace_path`, …).

### `backend-py/simple_harmonic/store/index_cache.py`

Location index for the recursive team tree + the store lock. TS source: `store/index-cache.ts`. Maps `teamId → TeamLoc` / `agentId → AgentLoc`; invalidated on any create/delete/move.

- `store_lock() -> asyncio.Lock` — `backend-py/simple_harmonic/store/index_cache.py:37` — the per-event-loop process-wide lock serializing every store read-modify-write (one lock per running loop, kept in a `WeakKeyDictionary` so pytest's per-test loops don't share). No TS analogue — restores Node's implicit single-task atomicity.
- `invalidate_index() -> None` — `:97`; lookups `team_loc` (`:103`), `team_dir` (`:107`), `all_team_locs` (`:112`), `child_team_locs` (`:116`), `root_team_locs` (`:120`), `agent_loc` (`:124`), `agent_locs_for_team` (`:128`), `all_agent_locs` (`:132`).
- `TeamLoc` / `AgentLoc` (frozen dataclasses) — `:47` / `:54`. Private `_walk` (`:70`), `_build` (`:84`).

### `backend-py/simple_harmonic/store/base.py`

The `Store` Protocol — the storage contract route handlers depend on (decoupled from the concrete JSON impl).

- `Store` (Protocol) — `backend-py/simple_harmonic/store/base.py:19` — async methods `ensure`, `list_teams`, `get_team`, `get_platform_status`, `set_platform_status`. TS source: the implicit `index.ts` repo surface.

### `backend-py/simple_harmonic/store/repo_store.py`

Repo-backed `Store` implementation. TS source: `store/index.ts` (the `teams`/`platformStatus` repo surface).

- `RepoStore` (class) — `backend-py/simple_harmonic/store/repo_store.py:24` — thin Protocol adapter delegating to the slice-2 repos. `ensure()` (`:35`) creates the skeleton + invalidates the index; `list_teams` (`:43`), `get_team` (`:47`), `get_platform_status` (`:52`), `set_platform_status` (`:55`).

### `backend-py/simple_harmonic/store/repos/_runner.py`

Shared concurrency helper for the repos.

- `locked[T](fn) -> T` (async) — `backend-py/simple_harmonic/store/repos/_runner.py:21` — runs a synchronous fs op under `store_lock()`, off the event loop via `anyio.to_thread.run_sync`. Every repo method routes its read-modify-write through this. No TS analogue.

### `backend-py/simple_harmonic/store/repos/teams.py`

The `teams` repo singleton. TS source: `store/repos/teams.ts`. Method names match TS `camelCase` verbatim.

- `teams = TeamsRepo()` — `backend-py/simple_harmonic/store/repos/teams.py:180`. Methods on `TeamsRepo` (`:46`): `all()` (`:47`, oldest-first), `byId(team_id)` (`:56`), `roots()` (`:63`), `children(parent_id)` (`:68`), `listUnpaused()` (`:75`), `create(input)` (`:78`) / `insert` alias (`:82`), `update(team_id, patch)` (`:115`), `incrementTickCount(team_id)` (`:125`), `move(team_id, to_parent_id)` (`:139`), `delete(team_id)` (`:168`).
- `NewTeam` (Pydantic) — `:35`. `DATE_KEYS = ("lastUserActiveAt", "createdAt")` — `:25`. Private `_read_team` (`:28`).

### `backend-py/simple_harmonic/store/repos/agents.py`

The `agents` repo. TS source: `store/repos/agents.ts`.

- `agents = AgentsRepo()` — `backend-py/simple_harmonic/store/repos/agents.py:215`. Methods on `AgentsRepo` (`:67`): `byId` (`:68`), `byTeam` (`:75`), `byTeams` (`:84`), `all` (`:94`), `create`/`insert` (`:101`/`:105`), `insertMany` (`:120`), `update` (`:137`), `move` (`:147`), `delete` (`:166`), `claim(agent_id, expected_status) -> bool` (`:176`, the atomic tick claim under `store_lock`), `resetAllInFlight()` (`:202`, crash recovery).
- `NewAgent` (Pydantic) — `:36`. `DATE_KEYS = ("nextRunAt", "createdAt")` — `:26`. Private `_read_agent` (`:29`), `_build_row` (`:48`).

### `backend-py/simple_harmonic/store/repos/approvals.py`

The `approvals` repo (per-agent `approvals.json` array). TS source: `store/repos/approvals.ts`.

- `approvals = ApprovalsRepo()` — `backend-py/simple_harmonic/store/repos/approvals.py:153`. Methods on `ApprovalsRepo` (`:64`): `byAgent` (`:65`), `insertMany(agent_id, rows)` (`:72`), `clearForAgent(agent_id)` (`:99`, consumed on resume), `pendingForTeam(team_id)` (`:109`), `resolve(team_id, approval_id, decision, note) -> ResolveResult` (`:119`).
- `NewApproval` (Pydantic) — `:42`. `ResolveOk` / `ResolveErr` / `ResolveResult` (tagged result union) — `:49` / `:55` / `:61` — Python dataclass discriminated union standing in for the TS result object.

### `backend-py/simple_harmonic/store/repos/action_log.py`

The `actionLog` repo (append-only per-agent `actions.jsonl`). TS source: `store/repos/action-log.ts`.

- `actionLog = ActionLogRepo()` — `backend-py/simple_harmonic/store/repos/action_log.py:87`. Methods on `ActionLogRepo` (`:42`): `insert(agent_id, e)` (`:43`), `byAgents(agent_ids, *, limit=None, since=None)` (`:61`, newest-first), `recentByAgent(agent_id, limit)` (`:83`).
- `NewAction` (Pydantic) — `:36`. `DATE_KEYS = ("executedAt",)` — `:24`. Private `_read_for_agent` (`:27`).

### `backend-py/simple_harmonic/store/repos/app_events.py`

The `appEvents` repo. TS source: `store/repos/app-events.ts`. Team/agent/tool events → owning team's `events.jsonl`; infra/team-less → `system/events.jsonl`.

- `appEvents = AppEventsRepo()` — `backend-py/simple_harmonic/store/repos/app_events.py:145`. Methods on `AppEventsRepo` (`:62`): `insert(e)` (`:63`, **synchronous** — fire-and-forget, no lock; matches the TS surface), `query(q=None)` (`:88`, filter + sort newest-first + limit, default 20, excludes infra unless `includeInfra`), `acknowledge(ids) -> int` (`:122`, founder dismiss).
- `NewAppEvent` (`:41`), `AppEventQuery` (`:51`) Pydantic models. `DATE_KEYS` — `:27`. Private `_read_path` (`:30`), `_all_event_paths` (`:36`).

### `backend-py/simple_harmonic/store/repos/platform_status.py`

The `platformStatus` repo (single `system/platform-status.json`). TS source: `store/repos/platform-status.ts`.

- `platformStatus = PlatformStatusRepo()` — `backend-py/simple_harmonic/store/repos/platform_status.py:42`. Methods on `PlatformStatusRepo` (`:23`): `get() -> PlatformStatus | None` (`:24`, `None` when unset), `set(status, message) -> PlatformStatus` (`:33`). `id` is the literal `1`.

### `backend-py/simple_harmonic/store/repos/spend.py`

The `spend` ledger repo (global append-only `system/spend.jsonl`, day-keyed). TS source: `store/repos/spend.ts`.

- `spend = SpendRepo()` — `backend-py/simple_harmonic/store/repos/spend.py:64`. Methods on `SpendRepo` (`:33`): `insert(e)` (`:34`), `sumForDay(day) -> float` (`:51`, totals `costCents` for the UTC day; the daily-cap input).
- `NewSpend` (Pydantic) — `:23`.

### `backend-py/simple_harmonic/store/repos/trace_events.py`

The `traceEvents` repo (append-only per-agent `trace.jsonl`). TS source: `store/repos/trace-events.ts`.

- `traceEvents = TraceEventsRepo()` — `backend-py/simple_harmonic/store/repos/trace_events.py:129`. Methods on `TraceEventsRepo` (`:61`): `append(rows)` (`:62`, buckets a multi-agent batch per agent file), `query(q) -> list[AgentTraceEvent]` (`:91`, sorts by `(emittedAt, seq)` asc/desc), `pruneOlderThan(cutoff)` (`:116`, retention rewrite).
- `NewTraceEvent` (`:30`), `TraceQuery` (`:42`) Pydantic models. `DATE_KEYS` — `:27`. Private `_read_for_dir` (`:51`), `_sort_key` (`:57`).
