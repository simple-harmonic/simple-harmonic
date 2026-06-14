# 04 — Backend Server Layer (`packages/backend/src/server/`)

This document covers the fifteen modules directly under `packages/backend/src/server/` (excluding the `store/`, `tools/`, `api/`, and `standalone/` subdirectories, documented separately). Together they form the I/O-bearing service layer of Simple Harmonic: configuration resolution (`config.ts`), two secret stores (`apollo.ts`, `connectors.ts`), Codex/ChatGPT credential reuse (`codex-auth.ts`), custom-skill loading (`custom-tools.ts` — flat JSON files), operator and cron authentication (`operator-auth.ts`), the LLM spend ledger (`spend.ts`), LLM provider/cascade resolution (`llm.ts`), team-hierarchy queries (`team-tree.ts`), the app-event telemetry pipeline (`app-events.ts`), the persistent agent-trace sink (`trace.ts`), the a2ax messaging singleton (`a2ax.ts`), planner dependency injection (`planner-deps.ts`), a proxy-aware HTTPS fetch (`proxy-fetch.ts`), and path-safety validators (`validation.ts`). Persistence is the **JSON file store** under `server/store/` — a single-process, synchronous-IO domain-aggregate store on local disk that replaced the former PostgreSQL + Drizzle stack; this layer's persistence-bearing modules (`spend.ts`, `app-events.ts`, `trace.ts`, `team-tree.ts`, `a2ax.ts`) reach it through the repos re-exported from `server/store/index.ts`. The store's internals are the subject of [02-data-model.md](02-data-model.md); this chapter documents how the server modules *use* it and does not duplicate the deep dive. These modules are consumed by the transport-agnostic HTTP handlers under `packages/backend/src/server/api/` — the Next.js routes under `src/app/api/` are thin re-exports — by the standalone `node:http` host under `packages/backend/src/server/standalone/`, by the Next proxy gate (`src/proxy.ts`), by server startup instrumentation (`src/instrumentation.ts`), and by the tool implementations in `server/tools/`. The library core in `lib/meta-agent/` never imports them directly; `planner-deps.ts` and `llm.ts` are the explicit bridges.

## Module map

| Module | Role | Primary consumers |
|---|---|---|
| `store/index.ts` | Public entry point for the JSON file store — re-exports the 8 repos + `ensureDataDir`/`getDataDir` | `spend.ts`, `app-events.ts`, `trace.ts`, `team-tree.ts`, `a2ax.ts`, settings setup/test handlers (see [02-data-model.md](02-data-model.md)) |
| `config.ts` | App config from `simple-harmonic.config.json` + env | `store/data-dir.ts`, `llm.ts`, `planner-deps.ts`, tick/settings routes, `tools/coding`, `standalone/main.ts` |
| `apollo.ts` | AES-256-GCM encrypted secret vault → `process.env` | `src/instrumentation.ts`, `standalone/main.ts`, `/api/settings/credentials` |
| `codex-auth.ts` | Read/refresh Codex CLI OAuth tokens in `~/.codex/auth.json` | `config.ts`, `planner-deps.ts`, `/api/settings/codex*`, `/api/settings/coding`, `/api/settings/test-llm` |
| `connectors.ts` | Connector metadata files + plaintext secret store | `/api/settings/connectors`, `tools/network.ts`, `tools/api-tool-runtime.ts`, `scripts/seed-demo.ts` |
| `custom-tools.ts` | Custom-skill discovery/CRUD — flat `.simple-harmonic/skills/<name>.json` files | `tools/index.ts` (registry), `scripts/seed-demo.ts` |
| `operator-auth.ts` | Edge-safe operator-password + cron-secret checks | `src/proxy.ts`, `/api/login`, `/api/tick`, standalone host gate (`standalone/server.ts`) |
| `spend.ts` | Per-call cost accounting + daily cap, via the `spend` repo | `/api/tick` |
| `llm.ts` | Provider resolution → cascading LLM client (Codex > Anthropic > OpenRouter > OpenAI) | `/api/tick`, `/api/settings/test-llm` |
| `team-tree.ts` | Recursive team hierarchy queries, via the `teams` repo | `tools/management.ts`, `tools/action-history.ts` |
| `app-events.ts` | Event emit/query/format + platform status, via the `appEvents`/`platformStatus`/`teams` repos | `/api/tick`, `/api/chat`, `/api/infra-report`, `/api/settings/telemetry`, `tools/observe.ts`, `server/trace.ts` |
| `trace.ts` | Persistent agent-trace sink into per-agent `trace.jsonl` (via the `traceEvents` repo) + retention pruning | `/api/tick` (sink + prune); read back by `/api/team/[id]/trace` SSE |
| `a2ax.ts` | Singleton `A2AX` protocol instance over `JsonFileTransport` | `/api/tick`, `/api/seed`, `/api/team/[id]/{messages,conversations,agent-hub,tasks}` |
| `planner-deps.ts` | Builds `PlannerDeps` for the library planner | `/api/chat` |
| `proxy-fetch.ts` | HTTPS fetch with proxy/IPv4/IP-pin handling | `planner-deps.ts`, `tools/network.ts`, `tools/api-tool-runtime.ts`, `/api/settings/test-llm` |
| `validation.ts` | Connector-key / tool-name regex guards | `connectors.ts`, `custom-tools.ts`, `/api/settings/connectors` |

Three further subdirectories live under `server/`: `store/` — the JSON file store (entry point `store/index.ts`, documented in [02-data-model.md](02-data-model.md)); `api/` — the transport-agnostic web-standard HTTP handlers, one module per route (the Next routes under `src/app/api/**/route.ts` are thin re-exports); and `standalone/` — a `node:http` host serving the same `/api/*` surface without Next. They are documented in [02-data-model.md](02-data-model.md) (store), [06-http-api.md](06-http-api.md) (handlers/routes), and [10-standalone-host.md](10-standalone-host.md) (host) respectively and are not covered here; this document cites store repos and handler files only as consumers.

---

## `config.ts` — application configuration

Source: `packages/backend/src/server/config.ts`.

Config lives in a single JSON file at `join(process.cwd(), "simple-harmonic.config.json")` (`config.ts:22`). `readFile()` (`config.ts:39`) parses it, returning `{}` if the file is missing or corrupt. When the file is absent every key resolves env var > default and `getApiKeySource()` cannot return `"config"` until `setConfig` writes the file.

### Exported API

| Export | Behavior |
|---|---|
| `getConfig(): AppConfig` (`config.ts:50`) | Resolves all keys with the precedence below. |
| `getApiKeySource(): "config" \| "env" \| "codex" \| "none"` (`config.ts:84`) | Reports where the API key came from. The tick handler and planner branch on `"codex"` to use the ChatGPT-subscription path. |
| `setConfig(partial): AppConfig` (`config.ts:92`) | Shallow-merges into the raw file contents and rewrites `simple-harmonic.config.json` (pretty-printed JSON + trailing newline), then returns the re-resolved config. |
| `getSafeConfig()` (`config.ts:100`) | Client-safe view: API key masked (`first4••••last4`, or `••••••••` when ≤ 8 chars), plus the plaintext `dataDir`, `hasOpenaiKey`, `hasDataDir`, `apiKeySource`, `codingBackend`, `codingConfig`. The `dataDir` is a local filesystem path, not a secret, so it is returned unmasked. |

### Keys and precedence

Precedence is per key: **config file > env var > (Codex token, for the API key only) > default** (`config.ts:50-81`). Confirmed by `tests/unit/config.test.ts` ("config file takes precedence over env vars").

| `AppConfig` key | Env fallback | Default | Notes |
|---|---|---|---|
| `openaiApiKey` | `OPENAI_API_KEY` | `""` | Third fallback: `getCodexAccessToken()` — the raw Codex OAuth access token from `~/.codex/auth.json` (`config.ts:53-57`). |
| `openaiBaseUrl` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | |
| `model` | `OPENAI_MODEL` | `o4-mini` (`config.ts:33`) | With no config file on disk the model resolves to `OPENAI_MODEL` or this default (`config.ts:76`). |
| `dataDir` | `SH_DATA_DIR` | `join(process.cwd(), ".simple-harmonic", "data")` (`config.ts:34`) | Root directory of the JSON file store — **replaces the former `databaseUrl`** (`config.ts:16-17,77`). Resolved by `store/data-dir.ts:31-33` as: test override (`setDataDir`) > this config value > `SH_DATA_DIR` env > default. No pool, no connection string. |
| `codingBackend` | `SH_CODING_BACKEND` | `codex` | Validated against `["codex", "claude-code", "opencode"]`; invalid values fall back to `codex` (`config.ts:59-62`). |
| `codingConfig` | — (no env fallback) | `{ codex: {}, "claude-code": {}, opencode: {} }` | Per-backend `{ model?, timeout? }` (`config.ts:7-10`), merged per backend over defaults (`config.ts:64-71`). |

Consumers: `GET/POST /api/settings` (`packages/backend/src/server/api/settings/index.ts:11,48-49`) reads `getSafeConfig()` and writes via `setConfig` (string fields — now including `dataDir`, `:21-22` — plus a per-backend `codingConfig` merge); `/api/settings/setup-db` optionally persists a submitted `dataDir` then calls `ensureDataDir()` (`packages/backend/src/server/api/settings/setup-db.ts:19-25`); `/api/settings/test-db`, `/api/settings/coding`, and `tools/coding/index.ts` read `getConfig()`. The store's `getDataDir()` reads `getConfig().dataDir` (`store/data-dir.ts:32`). The tick reads `getApiKeySource()` (`packages/backend/src/server/api/tick.ts:145`) and reaches `getConfig()` through `server/llm.ts` (`/api/settings/test-llm` likewise goes through `resolveLLMCandidates`). The standalone host logs the resolved config — including `dataDir` — at boot (`standalone/main.ts:33-36`).

---

## `apollo.ts` — encrypted secrets vault

Source: `packages/backend/src/server/apollo.ts`. Apollo is **not** an LLM client or an orchestrator agent — it is a file-backed encrypted secrets manager (the name is internal branding only).

### Storage

- Vault: `<root>/.apollo/vault.enc` — a single AES-256-GCM blob laid out `[iv (12)][auth tag (16)][ciphertext]` whose plaintext is a JSON `Record<string,string>` (`apollo.ts:197-242`).
- Master key: `APOLLO_MASTER_KEY` env var wins; otherwise `<root>/.apollo/master.key` (`apollo.ts:254-265`). If neither exists, `ensureMasterKey()` generates 32 random bytes (hex) and writes the file with mode `0600` (`apollo.ts:271-286`).
- Key derivation: `scryptSync(masterKey, salt, 32)` (`apollo.ts:193-195`). Salt is per-install random 16 bytes at `<root>/.apollo/salt` (mode `0600`), created on first encrypt; decryption falls back to the legacy fixed string `"simple-harmonic-apollo-v1"` when no salt file exists, so pre-salt vaults still open (`apollo.ts:293-316`). Tests confirm legacy decryption and that two installs get different salts (`tests/unit/apollo.test.ts:150-188`).
- `<root>` defaults to `process.cwd()`; `init(root)` overrides it (used by tests) (`apollo.ts:55,67-69`).

### Exported API

| Export | Behavior |
|---|---|
| `init(root)` | Set the project root. |
| `load(): { count }` (`apollo.ts:76`) | Decrypts the vault into the in-memory cache and copies each entry into `process.env` **only if not already set** ("operator always wins", `apollo.ts:91`). Returns the number of env vars set. Returns `{count: 0}` when no key/vault, and logs+returns 0 on decrypt failure. |
| `set(key, value)` (`apollo.ts:110`) | Updates cache and `process.env`, then read-merge-re-encrypt-writes the vault (corrupted vault ⇒ start fresh from cache). Creates `.apollo/` and the master key on first use. |
| `remove(key)` (`apollo.ts:139`) | Deletes from cache, `process.env`, and the vault (best-effort). |
| `get(key)` / `listKeys()` / `has(key)` | Cache reads; `has` also checks `process.env` (`apollo.ts:162-178`). |
| `mask(value)` (`apollo.ts:183`) | `first4••••last4` display masking. |

### Call sites

- `src/instrumentation.ts:13-16` calls `apollo.load()` once at Next.js server startup (`NEXT_RUNTIME === "nodejs"`) before anything reads env vars. The standalone host's entrypoint does the same at boot: `packages/backend/src/server/standalone/main.ts:18,36-39` imports `load as loadApolloSecrets` and decrypts the vault before `getConfig()` runs — see [10-standalone-host.md](10-standalone-host.md).
- `POST /api/settings/credentials` (`packages/backend/src/server/api/settings/credentials.ts:8-25`, behind a thin Next wrapper) validates `key` against `/^[A-Z][A-Z0-9_]*$/` and calls `apollo.set(key, value)` — this is the persistence path for the Harmon credential-request card in the chat UI.

Nothing reads the vault directly at request time; secrets reach agents only through `process.env`, typically via `resolveConnector()` in `connectors.ts`. The agent file tools additionally refuse to read `.apollo/` paths (and `.simple-harmonic/secrets.json`) via `isSensitivePath` (`tools/filesystem.ts:150-155`), so agents cannot exfiltrate the vault, master key, or salt by path.

---

## `codex-auth.ts` — Codex CLI credential reuse

Source: `packages/backend/src/server/codex-auth.ts`. This module does **not** implement a login flow itself; it reads and refreshes the token files written by the external `codex` CLI. The browser-based login is triggered by `POST /api/settings/codex-login` (handler `packages/backend/src/server/api/settings/codex-login.ts:23-101`), which spawns a detached `codex login` subprocess (piping its output to the server log) and lets the CLI write `auth.json`; `?force=true` deletes `auth.json` first to force re-auth. `GET` on the same route polls completion (`codex-login.ts:103`).

### Files read/written

- `${CODEX_HOME || $HOME/.codex}/auth.json` — shape `{ auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }` (`codex-auth.ts:7-16,29-33`).
- `${CODEX_HOME || $HOME/.codex}/models_cache.json` — model catalog cache (`codex-auth.ts:107-132`).

### Exported API

| Export | Behavior |
|---|---|
| `getCodexAuthStatus(): CodexAuthStatus` (`codex-auth.ts:58`) | Reads `auth.json`; if an access token exists, base64-decodes the JWT payload (no signature verification, `codex-auth.ts:47-56`) and extracts `email` (from the `https://api.openai.com/profile` claim), `plan` (`chatgpt_plan_type` from the `https://api.openai.com/auth` claim), `accountId`, `lastRefresh`, and `tokenExpiry` (from `exp`). Missing file/token ⇒ `found: false` with all-null fields. |
| `getCodexAccessToken(): string \| null` (`codex-auth.ts:94`) | Raw `tokens.access_token` or null. Used by `config.ts` as the API-key fallback and by `planner-deps.ts`. |
| `getCodexModels(): CodexModel[]` (`codex-auth.ts:107`) | Parses `models_cache.json` (accepts `{models: [...]}` or a flat array), maps `slug/display_name/description/priority/supported_in_api`, filters to API-supported, sorts by `priority` ascending. Returns `[]` on any error. |
| `refreshCodexToken()` (`codex-auth.ts:134`) | POSTs `grant_type=refresh_token` to `https://auth.openai.com/oauth/token` with the hardcoded public client id `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-auth.ts:4-5`), using the **global `fetch`** (not `proxyFetch`). On success it rewrites `auth.json` with the new `access_token`/`id_token`/`refresh_token` and `last_refresh = now` "so Codex CLI stays in sync" (`codex-auth.ts:174-187`). Returns `{ok, accessToken?, error?}`; never throws. |

There is no automatic refresh scheduling — `POST /api/settings/codex` (`packages/backend/src/server/api/settings/codex.ts:14`) triggers refresh manually, and `GET` on that route returns status + models (`codex.ts:7-11`). `/api/settings/test-llm` exercises the token end-to-end against `https://chatgpt.com/backend-api/codex/responses` via `proxyFetch`, sending `ChatGPT-Account-ID` and `originator: codex_cli_rs` headers — only when the LLM cascade's primary candidate is the codex provider (`packages/backend/src/server/api/settings/test-llm.ts:41-43`; the probe itself is `testCodex`, `test-llm.ts:78-150`).

---

## `connectors.ts` — connector metadata + plaintext secret fallback

Source: `packages/backend/src/server/connectors.ts`. Connectors are how agents and custom skills get API credentials. There is no DB involvement; everything is flat files under `toolsRoot()` (= `SH_TOOLS_CWD` or `process.cwd()`, defined in `tools/sandbox.ts:24-26`).

### Storage

- Metadata: one JSON file per connector at `.simple-harmonic/connectors/<KEY>.json` with shape `ConnectorMeta = { name, description, type: "api_key" | "oauth_token" | "env_var", key }` (`connectors.ts:22-27`). Malformed files are skipped; missing fields default from the filename (`connectors.ts:62-82`).
- Secret values: a single **plaintext** JSON map at `.simple-harmonic/secrets.json` (`connectors.ts:20,37-47`).

### Exported API

| Export | Behavior |
|---|---|
| `resolveConnector(key)` (`connectors.ts:53`) | Priority: `secrets.json` value > `process.env[key]` > `null`. Because Apollo loads its vault into `process.env` at startup, Apollo-stored secrets resolve here through the env fallback — but a plaintext `secrets.json` entry shadows them. |
| `listConnectorMetas()` (`connectors.ts:62`) | All parseable metadata files. |
| `saveConnector(meta, secretValue?)` (`connectors.ts:87`) | Validates `meta.key` via `assertValidConnectorKey`, writes the metadata file, and (if a value is given) merges it into `secrets.json`. |
| `deleteConnectorByKey(key)` (`connectors.ts:111`) | Validates the key, removes the metadata file and the `secrets.json` entry; returns whether a metadata file was deleted. |

### Redaction and consumers

Raw values never leave the server. `GET /api/settings/connectors` (handler `packages/backend/src/server/api/settings/connectors.ts`) merges file connectors with five built-in env-derived rows (`getBuiltinConnectors`, handler `:29-84`) — `SH_ENABLE_TOOLS`, `SH_TOOLS_CWD`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (added with the LLM cascade; its description points at `OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODELS`, handler `:65-73`), and `GITHUB_TOKEN` — and returns only `configured` + `maskedValue` (`first4****last4`). The `DATABASE_URL` built-in row is **gone** with the Postgres removal; there is no connection string to surface. `POST`/`DELETE` on the same route call `saveConnector`/`deleteConnectorByKey` after re-validating the key at the route boundary. Tool-side consumers: `tools/network.ts` (GitHub token for `github_api`) and `tools/api-tool-runtime.ts` (per-skill `connectorKey` auth). `scripts/seed-demo.ts` seeds a demo connector.

---

## `custom-tools.ts` — custom skills (flat JSON files)

Source: `packages/backend/src/server/custom-tools.ts`. Despite the filename, this module is the **custom-skill loader**. Each skill is a single flat JSON file at `.simple-harmonic/skills/<name>.json` (`custom-tools.ts:8-19,27`) with shape `{ name, description, config }`, where `config` is an `ApiToolConfig` (`store/types.ts:121-129`: `{ baseUrl, connectorKey, authHeader?, authPrefix?, allowedMethods, defaultHeaders?, pathPrefix? }` — a shared type only, never backed by a table; PR #16 moved it from the deleted `db/schema.ts` into `store/types.ts` with the row interfaces, `custom-tools.ts:25`). There is no directory nesting and no skill hierarchy.

### Exported API

| Export | Behavior |
|---|---|
| `listCustomToolFiles(): CustomToolFile[]` (`custom-tools.ts:39`) | Reads every `*.json` file directly in `.simple-harmonic/skills/`. Files missing `name` or `config.baseUrl` are skipped (`custom-tools.ts:48`), as is malformed JSON. No recursion, no dedup beyond the filesystem's filename uniqueness. |
| `saveCustomToolFile(tool)` (`custom-tools.ts:61`) | Validates `tool.name` via `assertValidToolName`, creates the directory, writes `<name>.json` (pretty-printed + trailing newline). |
| `deleteCustomToolFile(name)` (`custom-tools.ts:71`) | Validates the name, unlinks the file; returns `false` when absent. |

### How skills become runnable tools

`createAppRegistryWithCustomTools()` (`tools/index.ts:68-83`) calls `listCustomToolFiles()` and registers each entry via `buildApiToolDef`/`buildApiToolImpl` (`tools/api-tool-runtime.ts:20,58`), skipping names that collide with built-ins. Every custom skill is a destructive-risk HTTP tool: methods restricted to `allowedMethods`, auth resolved via `resolveConnector(connectorKey)` (`api-tool-runtime.ts:73`), requests issued through `proxyFetch` (`api-tool-runtime.ts:126`). The built-in registry beneath them holds exactly **15 tools** — 3 internal (`send_message`, `broadcast`, `report_action`) plus 12 app tools (`read_file`, `write_file`, `run_command`, `coding_task`, `http_fetch`, `github_api`, `set_team_goal`, `spawn_sub_team`, `modify_agent`, `modify_team`, `action_history`, `observe_app`, registered in `tools/index.ts:45-62`) — pinned by `tests/unit/server-tools.test.ts:400` (`toHaveLength(15)`). The tick rebuilds the registry per team per tick (`packages/backend/src/server/api/tick.ts:219`). `scripts/seed-demo.ts:259` writes a demo skill via `saveCustomToolFile`.

Skill names must match `^[A-Za-z][A-Za-z0-9_-]*$`; traversal attempts (`../x`) throw before any filesystem write (`tests/unit/custom-tools.test.ts:163-203`).

### Parked: the skills-directory migration (stash@{0})

A previous uncommitted iteration replaced this loader with directory-based skills — one `SKILL.md` (YAML frontmatter + markdown body) per directory under `.simple-harmonic/skills/`, nested sub-skill trees, registry-level progressive disclosure (children revealed only after a parent skill was opened), a `close_skills` internal tool, and an `open_skills` field on the agent row persisting open state. That code was discarded on 2026-06-11 and exists **nowhere in the repo**: `custom-tools.ts`, the registry, and the runner have none of it. The current `Agent` row type (`store/types.ts:32-47`) has no `open_skills` field.

Only its untracked data files survive, parked in git `stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` `SKILL.md` trees and `packages/backend/tests/unit/skill-tree.test.ts`.

---

## `operator-auth.ts` — operator and cron authentication

Source: `packages/backend/src/server/operator-auth.ts`. Deliberately edge-safe: only Web Crypto, `TextEncoder`, and header parsing, so it runs in the Next proxy (edge runtime) as well as node routes (`operator-auth.ts:1-13`).

### Model

Single-operator, password-based. There are no users, sessions, or tokens persisted anywhere:

- `OPERATOR_COOKIE = "sh_operator"` (`operator-auth.ts:15`). The cookie **value is deterministic**: `sha256Hex(OPERATOR_PASSWORD)` — not a random session id.
- `isOperatorAuthorized(req, password)` (`operator-auth.ts:59-68`) accepts either `Authorization: Bearer <password>` (for curl/scripts) or the `sh_operator` cookie equal to `sha256(password)`. Both comparisons use `constantTimeEqual` (`operator-auth.ts:32-39`, length-checked XOR loop).
- `isCronAuthorized(req, cronSecret)` (`operator-auth.ts:76-89`) trusts the `x-vercel-cron` header **only when `process.env.VERCEL` is set** (`operator-auth.ts:83`) — on Vercel the edge strips client-supplied copies, but on any other host (e.g. the standalone server) the header is trivially spoofable and would allow unauthenticated agent ticks (LLM spend). Otherwise a `Bearer CRON_SECRET` match (constant-time); when `CRON_SECRET` is unset it allows in local dev and fails closed when `isProductionRuntime()` (`NODE_ENV === "production"` or `VERCEL` set, `operator-auth.ts:18-20`).

### Enforcement points

- `src/proxy.ts:18-57` (the Next 16 proxy, formerly middleware) gates everything except `_next` internals, favicon, `/login`, `/api/login`, and `/api/tick` (which does its own cron check). No `OPERATOR_PASSWORD` ⇒ 503 in production, open in dev. Unauthorized API calls get 401 JSON; page requests redirect to `/login`.
- `POST /api/login` (handler `packages/backend/src/server/api/login.ts:5-25`) exchanges the password for the cookie: `httpOnly`, `secure` in production, `sameSite: "lax"`, `path: "/"`, 30-day `maxAge`.
- `POST /api/tick` checks `isCronAuthorized(req, process.env.CRON_SECRET)` (`packages/backend/src/server/api/tick.ts:113`); `GET` on the route delegates to `POST` because Vercel cron sends GETs (`tick.ts:761-763`). The dev tick loop in `src/instrumentation.ts:26-29` attaches `Bearer CRON_SECRET` when set, as does the standalone host's in-process tick loop.
- The standalone `node:http` host applies the same operator gate to every `/api/*` request at `packages/backend/src/server/standalone/server.ts:82-94`, mirroring `src/proxy.ts`: `/api/tick*` and `/api/login*` pass through, missing `OPERATOR_PASSWORD` ⇒ 503 in production / open in dev, otherwise `isOperatorAuthorized` or 401 — see [10-standalone-host.md](10-standalone-host.md).

Behavior is pinned by `tests/unit/operator-auth.test.ts` (bearer, cookie, dev-open/prod-closed cases, and the Vercel-only cron header at `operator-auth.test.ts:62`).

---

## `spend.ts` — LLM spend ledger and daily cap

Source: `packages/backend/src/server/spend.ts`. Accounting is **per LLM call**, attributed to `teamId`/`agentId` (both nullable), aggregated **per UTC day across the whole installation** — the cap is global, not per team.

### Data

Appends one row per agent run to the global spend ledger `system/spend.jsonl` via the `spend` repo (`store/repos/spend.ts`): `model`, `inputTokens`, `outputTokens`, `costCents` (integer cents, rounded up), `day` (UTC `YYYY-MM-DD` text), plus a generated `id`/`teamId`/`agentId`/`createdAt`. There is no `llm_spend` table — the cap reads a single append-only JSONL file under `system/` (infra-level, not per-team), so a runaway day is a `grep` away. The repo exposes just `insert(NewSpend)` and `sumForDay(day)` (`store/repos/spend.ts:21-46`); `sumForDay` reads the whole file and totals `costCents` for the matching day.

### Exported API

| Export | Behavior |
|---|---|
| `costCents(model, in, out)` (`spend.ts:25`) | Cents via a model-prefix rate table (`spend.ts:15-22`): `claude-sonnet` 300/1500, `claude-opus` 1500/7500, `claude-haiku` 80/400, `gpt-5` 125/1000, `o4` 110/440 (per-1M-token in/out, US cents). Vendor-namespaced OpenRouter ids are stripped to the bare model before prefix matching (`spend.ts:31-34`): `anthropic/claude-sonnet-4` hits the `claude-sonnet` rate; a stripped id matching no prefix (e.g. `google/gemini-2.5-pro` → `gemini-2.5-pro`) still over-counts at the deliberately expensive fallback 1500/7500. `Math.ceil` rounding. |
| `dailyCapCents()` (`spend.ts:41`) | `SH_DAILY_SPEND_CAP_CENTS` if a positive integer, else 5000 (= $50/day). |
| `todayUtc(now)` (`spend.ts:47`) | `YYYY-MM-DD`. |
| `spentTodayCents(now)` (`spend.ts:51`) | `spend.sumForDay(todayUtc(now))` — total `costCents` over today's ledger rows. |
| `checkSpendAllowed(now): SpendStatus` (`spend.ts:71`) | `{allowed: spent < cap, spentCents, capCents}`. On a ledger **read** error it fails OPEN with `{allowed: true, spentCents: -1, unknown: true}` — a transient store read failure must not halt all agents (`spend.ts:63-79`; confirmed by `tests/unit/spend.test.ts`). |
| `recordSpend(now, entry)` (`spend.ts:82`) | Calls `spend.insert`; skips zero-usage; swallows write errors (best-effort). |
| `makeCountingLLM(llm, model)` (`spend.ts:118`) | Wraps an `LLMClient` so each `chat.completions.create` call accumulates `usage` tokens (accepting both `input_tokens/output_tokens` and `prompt_tokens/completion_tokens` shapes — OpenRouter returns the OpenAI wire shape, so it is covered by the same accumulator, `spend.ts:139-140`). `usage.model` prefers the **response's** model over the requested one (`spend.ts:142-146`): with the cascade the serving model can differ from the requested one, and the cascade/adapters stamp `response.model` accordingly. |

The `costCents` rate table and the `dailyCapCents`/`SH_DAILY_SPEND_CAP_CENTS` cap logic are unchanged by the store swap — only `spentTodayCents`/`checkSpendAllowed`/`recordSpend` lost their old leading `db` argument now that there is no pool to thread through.

### Consumer

Only the tick handler (`packages/backend/src/server/api/tick.ts`): before any LLM work it calls `checkSpendAllowed(now)` and returns `{skipped: "spend_cap"}` when over budget (`tick.ts:171,187`), emitting an `error` app event; an unreadable ledger emits a `warning` and proceeds (`tick.ts:173-185`). On the runner path each agent run wraps the cascading client from `resolveLLM` with `makeCountingLLM` (`tick.ts:418,534`) and follows with `recordSpend(now, …)` (`tick.ts:429,552`); on the engine-mode codex path the harness sums real token usage from `thread/tokenUsage/updated` notifications instead, and `recordSpend` attributes it to `modelOverride ?? "gpt-5.5"` (`tick.ts:416,531`).

---

## `llm.ts` — LLM provider resolution and cascade

Source: `packages/backend/src/server/llm.ts`. Resolves every configured LLM provider into an ordered list of cascade candidates and wraps them in the single cascading client from `lib/meta-agent/cascade.ts` (library core — it must not import server modules; documented in 03-meta-agent-engine.md), so one down or rate-limited provider cannot stall every agent while another key is configured.

### Exported API

| Export | Behavior |
|---|---|
| `OPENROUTER_BASE_URL` (`llm.ts:27`) | `https://openrouter.ai/api/v1`. |
| `ResolveOptions` (`llm.ts:36-39`) | `{ timeoutMs? }` — per-request client timeout, default `DEFAULT_TIMEOUT_MS = 120_000` (`llm.ts:34`), matching the tick budget. |
| `resolveLLMCandidates(opts): LLMCandidate[]` (`llm.ts:47`) | Builds the priority-ordered `{provider, model, llm}` list (below). Always returns at least one candidate. |
| `ResolvedLLM` (`llm.ts:116-122`) | `{ llm, model, chain }` — `model` is the primary candidate's id (the tick's `modelOverride`); `chain` is one `"provider/model"` string per step, for logs and status surfaces. |
| `resolveLLM(opts): ResolvedLLM` (`llm.ts:125`) | `createCascadeLLM(resolveLLMCandidates(opts), opts)`; `opts` also accepts `CascadeOptions`, so callers can pass an `onFallback` observer. |

### Resolution order

`resolveLLMCandidates` pushes, in order (`llm.ts:47-114`):

1. **Codex CLI** when `getApiKeySource() === "codex"` (`llm.ts:53-56`): `createCodexClient`, model `cfg.model || "gpt-5.5"` (`DEFAULT_CODEX_MODEL`, `llm.ts:29`).
2. **Anthropic** when `ANTHROPIC_API_KEY` is set (`llm.ts:58-65`): `createAnthropicClient({apiKey, timeout})`, model `ANTHROPIC_MODEL || "claude-sonnet-4-20250514"` (`llm.ts:30`).
3. **OpenRouter** when `OPENROUTER_API_KEY` is set (`llm.ts:67-85`): a stock `OpenAI` SDK client pointed at `OPENROUTER_BASE_URL` (env override or the default, `llm.ts:69-73`), cast to `LLMClient`. Models = `[OPENROUTER_MODEL || "anthropic/claude-sonnet-4", ...OPENROUTER_FALLBACK_MODELS.split(",")]`, trimmed, empty-filtered, deduped via `Set` (`llm.ts:76-84`); **one cascade candidate per model**, all sharing the same client instance, so within-OpenRouter model fallback rides the same cascade machinery.
4. **OpenAI** when `getApiKeySource()` is `"config"` or `"env"` (`llm.ts:89-99`), model `cfg.model`, honoring `cfg.openaiBaseUrl`. Deliberately skipped under the codex source: there `cfg.openaiApiKey` holds the ChatGPT token, not a platform key (`llm.ts:87-88`).

With nothing configured, a key-less OpenAI candidate is pushed (`llm.ts:101-111`) so a clear auth error surfaces on the first call rather than at resolve time — the pre-cascade behavior, preserved.

### Cascade semantics (summary)

`createCascadeLLM` (`lib/meta-agent/cascade.ts:31`) walks the candidates on every `chat.completions.create` call, overriding `params.model` per step. **Any** thrown error falls through to the next candidate (no error-type filtering), except an abort (`options.signal.aborted`), which rethrows immediately; after exhaustion the last error is thrown. On success `res.model` is stamped with the serving candidate's model when the response lacks one — which is what `makeCountingLLM` reads for spend attribution. `CascadeOptions.onFallback` fires once per failed candidate with `{provider, model, error, next?}`; a throwing observer is swallowed. Full detail in 03-meta-agent-engine.md.

### Callers

- The tick handler: `resolveLLM({ onFallback })` at `packages/backend/src/server/api/tick.ts:146`; the observer emits a `warning` app event per fallback — `"LLM <provider>/<model> failed (<reason, 200 chars>); falling back to <next>"`, or `"…; cascade exhausted"` on final failure (`tick.ts:147-156`).
- `POST /api/settings/test-llm` probes only the **primary** candidate via `resolveLLMCandidates({ timeoutMs: 10_000 })[0]` (`server/api/settings/test-llm.ts:39`): a codex primary routes to the direct chatgpt.com probe (`test-llm.ts:41-43,78-150`), the key-less last resort returns a setup hint, and anything else gets a one-shot `"Reply with the word OK."` through the candidate's own client, returning `{ok, provider, model, response}`.

Behavior is pinned by `tests/unit/llm-cascade.test.ts` (cascade fall-through, abort, exhaustion, observer immunity at `:95-207`; resolver ordering, OpenRouter model expansion, defaults at `:209-277`).

---

## `trace.ts` — persistent agent-trace sink

Source: `packages/backend/src/server/trace.ts`. Bridges the runner's `TraceSink` callback contract (`lib/meta-agent/trace.ts`, library core) to per-agent `trace.jsonl` files via the `traceEvents` repo (`store/repos/trace-events.ts`), powering the play-by-play trace view in the dashboard and agent POV. The sink module itself was untouched by PR #16 apart from the persistence target: it imports `traceEvents`/`NewTraceEvent` from `./store` (`trace.ts:23`) and calls `traceEvents.append`/`pruneOlderThan` where it used to issue Drizzle inserts/deletes.

### `createTraceSink(args): PersistentTraceSink` (`trace.ts:41`)

Returns `{ tickId, emit, flush }` (`trace.ts:32-39`):

- `tickId` groups every step of one logical tick; pass the original tick's id when resuming a parked suspension so the thread stays grouped (`trace.ts:44-47`). `seq` restarts per invocation; `(emittedAt, seq)` is the global sort key.
- `emit(step)` (`trace.ts:66-86`) is synchronous and never throws: it buffers `{teamId, agentId, tickId, seq, type, data, emittedAt}` and kicks a single background drain loop that calls `traceEvents.append(batch)` in emission order (`trace.ts:53-64`), so the runner is never blocked on persistence and a tick stays observable live while it runs. The repo groups a batch by agent and appends to each agent's `trace.jsonl` (`store/repos/trace-events.ts:50-64`). Append failures drop the batch and log — telemetry never breaks a tick.
- `flush()` (`trace.ts:88-100`) awaits everything buffered so far, including steps that raced the drain loop's shutdown.

### Sanitization

Every step's `data` passes through `sanitizeTraceData` (`trace.ts:110-146`) before persistence: strings are scrubbed with the **shared** `scrubPII` from `app-events.ts:91` then truncated at 4 000 chars with a `[truncated N chars]` marker; nesting is cut at depth 6 (`[max depth]`); arrays/objects keep at most 50 entries/keys with an overflow marker; functions/symbols/bigints are stringified defensively (`trace.ts:26-30,144-145`).

### Retention

`pruneTraceEvents(now?)` (`trace.ts:163`) calls `traceEvents.pruneOlderThan(cutoff)`, dropping steps older than `SH_TRACE_RETENTION_DAYS` days (positive-integer override; default 14, `trace.ts:156-159`), throttled in-process to once per hour (`PRUNE_INTERVAL_MS`, `trace.ts:153`). The repo rewrites each agent's `trace.jsonl` in place via `rewriteJsonl`, touching only files whose kept-row count actually changed (`store/repos/trace-events.ts:87-95`). The tick handler fire-and-forgets it on every cron invocation (`packages/backend/src/server/api/tick.ts:120`); prune errors are logged, never thrown. `resetPruneThrottleForTests()` (`trace.ts:175`) resets the throttle.

### Consumers

The tick handler creates one sink per agent run (`tick.ts:362`) and per resume — reusing the parked suspension's `tickId` (`tick.ts:496`) — passes `trace.emit` into the runner/harness (`tick.ts:403,517`), emits a `tick_failed` step on failure (`tick.ts:595`), and calls `trace.flush()` in a `finally` block so steps survive run failures and timeouts (`tick.ts:441,565`). Read-back is `GET /api/team/[id]/trace` (`packages/backend/src/server/api/team/id/trace.ts`): an SSE stream that calls `traceEvents.query(...)` to emit a `history` event on connect (handler `:55-67`) then re-queries every 2 s (`POLL_MS`, handler `:15`), with optional `?agentId=`/`?tickId=` filters (handler `:21-22`). Behavior is pinned by `tests/unit/trace-sink.test.ts` (ordering, tickId reuse, in-flight drain, swallowed append failures) and `tests/unit/api-trace.test.ts` / `runner-trace.test.ts`.

---

## `team-tree.ts` — recursive team hierarchy

Source: `packages/backend/src/server/team-tree.ts`. Teams form a tree via `parentTeamId` on the `Team` row (`store/types.ts:18-30`); on disk a sub-team's folder nests under its parent's `teams/` (the recursion documented in [02-data-model.md](02-data-model.md)). This module now reads through the `teams` repo (`team-tree.ts:8`) — `teams.all()`, `teams.children()`, `teams.roots()` — and traverses the result in memory. The repo answers those from the in-memory **location index** (`store/index-cache.ts`), which walks the recursive team tree once and caches `teamId → {dir, parentTeamId}`, so a query no longer pays a tree re-walk or a DB round trip (sized for <100 teams).

| Export | Behavior |
|---|---|
| `getChildTeams(teamId)` (`team-tree.ts:24`) | `teams.children(teamId)` — direct children (index-cache filter on `parentTeamId`). |
| `getRootTeams()` (`team-tree.ts:31`) | `teams.roots()` — teams with `parentTeamId === null`. |
| `getSubTreeIds(teamId): Set<string>` (`team-tree.ts:40`) | All team ids in the subtree rooted at `teamId`, inclusive; loads `teams.all()` then does an iterative stack walk over a child map built in memory. This is the **authorization scope** for lead agents. |
| `isAncestor(ancestorId, teamId)` (`team-tree.ts:66`) | True for self or any ancestor; cycle-guarded via a visited set, over a `teams.all()` parent map. |
| `getAncestorChain(teamId)` (`team-tree.ts:88`) | `[teamId, parent, …, root]`, cycle-guarded. |
| `getTeamTree(): TeamTreeNode[]` (`team-tree.ts:107`) | Display tree of `{id, name, paused, children}` from the roots down. |

Consumers: `tools/management.ts:28,129` (a lead agent may only `modify_team`/`spawn_sub_team` within its own subtree) and `tools/action-history.ts:91` (history queries scoped to the subtree). Note that the team-detail handler contains its own private `getSubTreeIds` reimplementation taking an explicit `allTeams` array rather than importing this module (`packages/backend/src/server/api/team/id/index.ts:14-15,33`). Behavior is pinned by `tests/unit/team-tree.test.ts` over a five-team fixture (root → eng → frontend/backend, root → growth).

---

## `app-events.ts` — event pipeline and platform status

Source: `packages/backend/src/server/app-events.ts`. The dogfooding feedback loop: errors/warnings/health signals are persisted via the `appEvents` repo (`store/repos/app-events.ts`) and re-surfaced to agents in their tick prompts or via the `observe_app` tool. The emit/scrub/rate-limit/telemetry-gate pipeline is **intact** through the store swap — only the persistence call at the end changed. Each event lands in the **owning team's** `events.jsonl`; infra and team-less events land in `system/events.jsonl` (`store/repos/app-events.ts:65-68`). Queries gather across the relevant files, then filter newest-first and limit, mirroring the old `WHERE/ORDER BY/LIMIT`.

### Event taxonomy

| Dimension | Values |
|---|---|
| `severity` | `info`, `warning`, `error` |
| `level` | `agent` (single-agent issues; agents self-correct), `team` (composition/goal/coordination), `tool` (tool bugs/missing capability), `infra` (platform/DB/deploy — founder-only, never agent-visible) |

### `emitAppEvent(event)` (`app-events.ts:139`)

Fire-and-forget, never throws. Pipeline, in order:

1. `level` defaults to `"agent"`.
2. PII scrub (`app-events.ts:75-97`): regexes redact `sk-…`/`ghp_…`/`gho_…`/`xoxb-…`/`xoxp-…` tokens, `Bearer …` values, base64-ish ≥32-char strings after `=`/`:`, and email addresses, each replaced with `[REDACTED]`. `scrubPII` is **exported** (`app-events.ts:91`) so the trace sink (`server/trace.ts:22`) shares the same guardrails.
3. Rate limit (`app-events.ts:44-69`): in-memory map, 50 events per `agentId` per rolling hour; the 51st becomes a single synthetic "Rate limited…" event, then silence until the window resets. Events without an `agentId` are unlimited.
4. `infra` events are forcibly stored with `teamId = null` (platform-wide) (`app-events.ts:155`).
5. Telemetry gate: `tool`/`infra` events carrying a `teamId` are dropped if that team's `telemetryEnabled` is false; the lookup goes through `teams.byId(teamId)` (`app-events.ts:112`), is cached 60 s, and fails open (`app-events.ts:103-119,158-164`). `invalidateTelemetryCache(teamId)` (`app-events.ts:122`) is called by `PUT /api/settings/telemetry` when the flag changes (`api/settings/telemetry.ts:57`, which flips `teams.update(teamId, { telemetryEnabled })`).
6. `appEvents.insert(...)` — a **synchronous** JSONL append routed to the team or system events file (`app-events.ts:179`); append errors are logged, not thrown (`app-events.ts:172-194`). The repo's `insert` is sync (telemetry never blocks), unlike the other repos.

### Query and formatting

- `queryAppEvents(query)` (`app-events.ts:219`) → `appEvents.query(...)`: filters on `teamId`/`severity`/`level`/`source`/`since`/`unacknowledgedOnly`, newest-first, default `limit` 20. A `teamId` filter narrows the read to that team's single `events.jsonl`; otherwise it reads every team's file plus the system file before filtering (`store/repos/app-events.ts:71-95`). **By default it excludes `infra` events**; `includeInfra: true` is only used by the founder report.
- `formatEventsForPrompt(events)` (`app-events.ts:241`): one line per event (`[HH:MM:SS] SEV [level] [source] (agent xxxxxxxx): message`), silently drops `infra` rows even if present, and collapses `tool` events older than 24 h into a trailing `N known tool issue(s) (under review)` summary line.
- Platform status: `getPlatformStatus()` (`app-events.ts:287`) reads `platformStatus.get()` — the single object file `system/platform-status.json` (`store/repos/platform-status.ts`) — defaulting to `healthy` when the file is missing; `formatPlatformStatusForPrompt` (`app-events.ts:298`) returns a "reduce non-essential work" banner only for `degraded`/`maintenance`. The file is written by `/api/settings/platform-status` via `platformStatus.set(...)` (overwrites the single object). Founder dismissal of `infra`/`tool` events goes through `appEvents.acknowledge(ids)` (`store/repos/app-events.ts:98-115`), which rewrites the affected JSONL files in place.

### Consumers

`/api/tick` emits LLM-fallback, spend-cap, and per-agent failure events (`packages/backend/src/server/api/tick.ts:149,173,179,598`) and injects `formatEventsForPrompt` + the platform banner into every agent's prompt (`tick.ts:369-381`, via `queryAppEvents` + `getPlatformStatus`); `/api/chat` emits planner errors (`api/chat.ts:106`); `tools/observe.ts` backs the `observe_app` tool with `queryAppEvents` (infra always excluded); `GET /api/infra-report` is the founder view (unacknowledged `infra` + `tool` events, max 100, `api/infra-report.ts:14-23`) and `POST` acknowledges via `appEvents.acknowledge` (`infra-report.ts:69`).

There is no push/streaming mechanism for app events — rows are read back from the JSONL files per tick / per API call (the play-by-play SSE stream is the separate per-agent `trace.jsonl` pipeline above).

---

## `a2ax.ts` — protocol singleton

Source: `packages/backend/src/server/a2ax.ts` (29 lines). The entire wiring of the `@simple-harmonic/a2ax` workspace package into the app:

`getA2AX()` lazily constructs and caches a single `A2AX` instance configured with `new JsonFileTransport(teamsRoot())`, `maxContextMessages: 20`, and `defaultExpiryMs: 7 days` (`a2ax.ts:11-24`). The transport is pointed at the store's `teamsRoot()` (`store/data-dir.ts:42`) and persists each team's messaging state **under that team's own folder** at `<dataDir>/teams/<teamId>/messages/{log.jsonl, reads.jsonl, channels.json, members.json, tasks.json, cards.json, tokens.json}` — no DB, no pool, no `a2ax_*` tables. `JsonFileTransport` (`packages/a2ax/src/adapters/json-file.ts`) implements the same `Transport` interface as the in-memory `MemoryTransport`; on construction it hydrates state into memory by walking the team tree (`packages/a2ax/src/storage/file-store.ts`, a self-contained sync fs helper so the a2ax package never imports the backend store) and mirrors every write back to the files, so `teamId`-less context lookups still resolve O(1). Constructor arguments are pinned by `tests/unit/a2ax.test.ts`.

The former `DrizzleTransport` and its `drizzle.ts`/`drizzle-schema.ts` (the `a2ax_*` table definitions) are **gone from the package** — `packages/a2ax/src/adapters/` now contains only `json-file.ts`, and nothing in the backend or the package references `DrizzleTransport` or `drizzle` any longer. The built `dist/adapters/json-file.js` and `dist/storage/file-store.js` were rebuilt and committed.

The singleton is still process-wide and lazily cached; there is no pool to go stale, so the old "stale db handle" hazard no longer exists. The new `resetA2AXForTests()` (`a2ax.ts:27-29`) drops the cached instance so a test that repoints `SH_DATA_DIR` between cases gets a transport bound to the new data dir.

Consumers: `/api/tick` (agent message context per tick, `tick.ts:140`), `/api/team/[id]/messages` (`GET` reads `a2ax.getAgentContext(teamId, agentId)`; `POST` sends via `a2ax.broadcast` / `a2ax.sendToGroup` / direct send), `/api/team/[id]/{conversations,agent-hub,tasks}`, and `/api/seed` (seeding initial messages).

---

## `planner-deps.ts` — server-to-library bridge

Source: `packages/backend/src/server/planner-deps.ts`. The planner (`lib/meta-agent/planner.ts`) is NPM-extractable and must not import `server/` modules, so the app injects its dependencies. `buildPlannerDeps()` (`planner-deps.ts:11-24`) assembles a `PlannerDeps` (`lib/meta-agent/planner.ts:10-28`):

- `config`: `{model, openaiApiKey, openaiBaseUrl}` from `getConfig()`.
- `apiKeySource`: from `getApiKeySource()` — `"codex"` routes the planner to the ChatGPT-subscription path.
- `codexAccessToken` / `codexAccountId`: from `codex-auth.ts` (`accountId` defaults to `""`).
- `fetchImpl`: `proxyFetch`.

Sole consumer: the streaming chat handler, `packages/backend/src/server/api/chat.ts:61` (re-exported by `src/app/api/chat/route.ts`), which passes the result into the planner call.

---

## `proxy-fetch.ts` — proxy-aware HTTPS fetch

Source: `packages/backend/src/server/proxy-fetch.ts`. A fetch-shaped wrapper around `node:https` used everywhere the server talks to external HTTPS services.

`proxyFetch(url, init?, pin?)` (`proxy-fetch.ts:130`) resolves a proxy URL from `HTTPS_PROXY` > `HTTP_PROXY` > `https_proxy` > `http_proxy` > (macOS only) the system HTTPS proxy read once per process via `scutil --proxy` (`proxy-fetch.ts:12-35`; honored only when `HTTPSEnable: 1`). Precedence and the scutil fallback/caching are pinned by `tests/unit/proxy-fetch.test.ts:366-590`.

- **Direct path** (no proxy): `fetchViaHttps` (`proxy-fetch.ts:44-123`) issues an `https.request` pinned to `family: 4` (avoids hangs on unreachable advertised IPv6 routes). When a `PinnedAddress` (`{ip, family}`) is supplied, a custom DNS `lookup` returns the pre-validated IP while TLS SNI/cert checks still use the hostname — closing the DNS-rebinding TOCTOU for SSRF-guarded calls (`proxy-fetch.ts:49-55,88-90`). String/`Buffer`/`Uint8Array` bodies get an explicit `Content-Length`; the response streams through a `ReadableStream`-backed `Response`. `init.signal` aborts destroy the request. Only HTTPS is supported — the port defaults to 443 and the TLS client is used unconditionally.
- **Proxy path**: establishes an HTTP `CONNECT` tunnel (10 s timeout) and runs `https.request` over the tunneled socket with `rejectUnauthorized: true` (`proxy-fetch.ts:154-240`). The IP pin is intentionally not applied here ("a corporate proxy is already a trust boundary", `proxy-fetch.ts:148-150`).

Consumers: `planner-deps.ts` (planner LLM calls), `/api/settings/test-llm` (Codex connectivity probe, `test-llm.ts:98`), `tools/network.ts:44,144` (`http_fetch` and `github_api`, which pass the pinned IP from `assertPublicAndResolve`), and `tools/api-tool-runtime.ts:14,126` (custom API skills).

---

## `validation.ts` — identifier guards

Source: `packages/backend/src/server/validation.ts`. Guards identifiers that get interpolated into filesystem paths, applied both at API route boundaries and inside the path-building functions (defense in depth):

| Export | Rule |
|---|---|
| `CONNECTOR_KEY_RE` / `isValidConnectorKey` / `assertValidConnectorKey` | `^[A-Z][A-Z0-9_]*$` (env-var style, e.g. `GITHUB_TOKEN`) — guards `.simple-harmonic/connectors/<KEY>.json` and `secrets.json` keys. |
| `TOOL_NAME_RE` / `isValidToolName` / `assertValidToolName` | `^[A-Za-z][A-Za-z0-9_-]*$` — guards skill file names (`.simple-harmonic/skills/<name>.json`) and registered tool names. |

The `assert*` variants throw with the offending value JSON-stringified. Used by `connectors.ts:17`, `custom-tools.ts:24,62,72`, and `/api/settings/connectors`. Traversal payloads like `"../../secrets"` fail the regex before any path is built (tests in `connectors.test.ts:133-163` and `custom-tools.test.ts:163-203` assert nothing is written outside the intended directories).

---

## Environment variables read by this layer

| Variable | Module / line | Effect |
|---|---|---|
| `OPENAI_API_KEY` | `config.ts:55` | API key fallback (after config file, before Codex token). |
| `OPENAI_BASE_URL` | `config.ts:75` | Base URL fallback. |
| `OPENAI_MODEL` | `config.ts:76` | Model fallback (default `o4-mini`). |
| `SH_DATA_DIR` | `config.ts:77` (resolved in `store/data-dir.ts:32`) | JSON file store root directory — **replaces the former `DATABASE_URL`**. Falls back to `join(cwd, ".simple-harmonic", "data")`. |
| `SH_CODING_BACKEND` | `config.ts:59` | Coding backend fallback (`codex`/`claude-code`/`opencode`). |
| `ANTHROPIC_API_KEY` | `llm.ts:58` | Enables the Anthropic cascade candidate (also surfaced by the connectors route). |
| `ANTHROPIC_MODEL` | `llm.ts:62` | Anthropic model override (default `claude-sonnet-4-20250514`). |
| `OPENROUTER_API_KEY` | `llm.ts:67` | Enables the OpenRouter cascade candidate(s) (also surfaced by the connectors route). |
| `OPENROUTER_MODEL` | `llm.ts:77` | Primary OpenRouter model (default `anthropic/claude-sonnet-4`). |
| `OPENROUTER_FALLBACK_MODELS` | `llm.ts:78` | Comma-separated extra OpenRouter models, one cascade step each. |
| `OPENROUTER_BASE_URL` | `llm.ts:71` | OpenRouter endpoint override (default `https://openrouter.ai/api/v1`). |
| `SH_TRACE_RETENTION_DAYS` | `trace.ts:157` | Trace retention window in days (default 14). |
| `APOLLO_MASTER_KEY` | `apollo.ts:255` | Vault master key (overrides `.apollo/master.key`). |
| `CODEX_HOME`, `HOME` | `codex-auth.ts:30-31,108-109` | Location of `auth.json` / `models_cache.json`. |
| `NODE_ENV`, `VERCEL` | `operator-auth.ts:19,83` | Production detection (fail-closed behavior); Vercel-only trust of `x-vercel-cron`. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy` | `proxy-fetch.ts:135-139` | Outbound proxy selection. |
| `SH_DAILY_SPEND_CAP_CENTS` | `spend.ts:42` | Daily cap override (default 5000 = $50). |
| `SH_TOOLS_CWD` | via `tools/sandbox.ts:25` | Root for `.simple-harmonic/` paths used by `connectors.ts` and `custom-tools.ts`. |
| (arbitrary keys) | `connectors.ts:56`, `apollo.ts:91-94,115` | `resolveConnector` falls back to `process.env[key]`; Apollo loads/sets arbitrary keys into `process.env`. |

Related variables read by direct callers of this layer (not by the modules themselves): `OPERATOR_PASSWORD` (`src/proxy.ts:27`, `/api/login`, standalone gate), `CRON_SECRET` (`/api/tick`, `src/instrumentation.ts`, standalone tick loop), `SH_CODEX_RUNTIME` (`packages/backend/src/server/api/tick.ts:164` — `exec` falls back to the legacy per-round exec adapter instead of the codex app-server harness), `SH_AGENT_TIMEOUT_MS` (`/api/tick`), `SH_ENABLE_TOOLS` (`tools/sandbox.ts`), `SH_BACKEND_PORT`/`PORT` and `SH_TICK_LOOP` (`standalone/main.ts` — port selection and `0`-to-disable for the in-process tick loop; see [10-standalone-host.md](10-standalone-host.md)).

## Files on disk owned or read by this layer

| Path | Module | Contents |
|---|---|---|
| `simple-harmonic.config.json` (cwd) | `config.ts` | App config JSON (may contain the raw OpenAI key; no DB URL — `dataDir` is just a local path). Written by `setConfig`; absent until first write, in which case keys resolve env > default. |
| `.simple-harmonic/data/` (the store root, `dataDir`) | `store/*` | The JSON file store: `teams/<teamId>/{team.json, events.jsonl, agents/<agentId>/{agent.json, approvals.json, actions.jsonl, trace.jsonl}, conversations/, messages/, teams/<subTeamId>/…}` plus `system/{platform-status.json, spend.jsonl, events.jsonl}`. Sits alongside `connectors/`, `skills/`, and `codex-home/`. Override with `SH_DATA_DIR`. Gitignored (`.gitignore:47`). See [02-data-model.md](02-data-model.md). |
| `.apollo/vault.enc` | `apollo.ts` | AES-256-GCM encrypted secrets map. |
| `.apollo/master.key` | `apollo.ts` | Auto-generated master key, mode 0600. |
| `.apollo/salt` | `apollo.ts` | Per-install scrypt salt, mode 0600. |
| `.simple-harmonic/connectors/<KEY>.json` | `connectors.ts` | Connector metadata (no secrets). |
| `.simple-harmonic/secrets.json` | `connectors.ts` | **Plaintext** secret values, highest-priority connector source. |
| `.simple-harmonic/skills/<name>.json` | `custom-tools.ts` | Custom-skill definitions (`{name, description, config: ApiToolConfig}`). |
| `.simple-harmonic/codex-home/` | `lib/meta-agent/codex-app-server.ts:255-285` (adjacent to this layer) | Isolated `CODEX_HOME` for engine-mode agent threads: the user's `auth.json` is copied in so codex subprocesses don't inherit the real `~/.codex`. Gitignored (`.gitignore:49`). |
| `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) | `codex-auth.ts` | Codex CLI OAuth tokens; rewritten on refresh (also deleted by the codex-login route on `?force=true`). |
| `~/.codex/models_cache.json` | `codex-auth.ts` | Codex model catalog cache (read-only). |

The store's `dataDir` defaults to `join(cwd, ".simple-harmonic", "data")` and resolves via `store/data-dir.ts` (test override > config > `SH_DATA_DIR` > default), so it normally sits under the same `.simple-harmonic/` tree as the connector/skill files. The `.simple-harmonic/` connector and skill paths resolve against `toolsRoot()` (`SH_TOOLS_CWD` or cwd); `.apollo/` resolves against `process.cwd()` unless `apollo.init()` overrides it — these roots can diverge when `SH_TOOLS_CWD` or `SH_DATA_DIR` is set.

---

## Python backend (FastAPI port)

The `backend-py/` tree is an idiomatic FastAPI re-implementation of this same server layer, running as a **parallel service** that speaks the identical HTTP/WS contract (the Next.js frontend points at either runtime unchanged via `PY_BACKEND_URL`; see [backend-py/MIGRATION.md](../backend-py/MIGRATION.md) slice 9 and [next.config.ts](../next.config.ts)). The stack — Python 3.14/`uv`, FastAPI on uvicorn, Pydantic v2 in place of Zod, `asyncio` with an explicit `asyncio.Lock` around every store read-modify-write, raw `anthropic`/`openai` async SDKs behind an `LLMClient` Protocol — and the rationale for choosing "raw SDKs + a custom loop" over Pydantic AI / LangGraph are documented in [backend-py/ARCHITECTURE.md](../backend-py/ARCHITECTURE.md). The on-disk `.simple-harmonic/data/` JSON/JSONL format is **shared**, so both runtimes can run against the same data dir during cutover.

The TS server layer documented above does **not** map one-to-one onto Python files. The TS `config.ts` splits into two Python modules (an env-process layer and a config-file layer); the standalone host + Next proxy gate collapse into the app factory + one middleware; and the spend/llm/connectors/codex-auth/proxy-fetch group moves under a `llm/` + `tools/` package (covered by [05-tools.md](05-tools.md) / the LLM chapter, not here). This section covers the cross-cutting services for *this* chapter: the operator gate, the Apollo vault, `scrubPII`, the trace sink, app-events, team-tree, and the tick orchestrator's resume guard.

### Module map (this chapter's subsystems)

| TS module | Python module | Notes |
|---|---|---|
| `config.ts` (env half) | [`backend-py/simple_harmonic/settings.py`](../backend-py/simple_harmonic/settings.py) | `pydantic-settings` `BaseSettings`; reads the **same** env var names (`OPENAI_*`, `SH_DATA_DIR`, `OPERATOR_PASSWORD`, `CRON_SECRET`, `SH_DAILY_SPEND_CAP_CENTS`, …) so one `.env` drives both runtimes. |
| `config.ts` (file half) | [`backend-py/simple_harmonic/config.py`](../backend-py/simple_harmonic/config.py) | `get_config`/`get_api_key_source`/`set_config`/`get_safe_config` over `simple-harmonic.config.json`; precedence file > env > Codex token > default, identical to the TS module. |
| `operator-auth.ts` | [`backend-py/simple_harmonic/auth.py`](../backend-py/simple_harmonic/auth.py) | `is_operator_authorized`, `is_cron_authorized`, `sha256_hex`, `constant_time_equal`, `is_production_runtime`. |
| `apollo.ts` | [`backend-py/simple_harmonic/apollo.py`](../backend-py/simple_harmonic/apollo.py) | AES-256-GCM vault via the `cryptography` library, `[iv][tag][ciphertext]` byte layout. |
| `app-events.ts` (scrub + emit pipeline) | [`backend-py/simple_harmonic/events.py`](../backend-py/simple_harmonic/events.py) + [`wiring.py`](../backend-py/simple_harmonic/wiring.py) | `scrub_pii` + `emit_app_event` live in `events.py` decoupled from the store via injectable hooks; `wiring.py` closes the seam onto the real repos at boot. |
| `trace.ts` | [`backend-py/simple_harmonic/trace.py`](../backend-py/simple_harmonic/trace.py) | `create_trace_sink` drain loop, `sanitize_trace_data`, `prune_trace_events`. |
| `team-tree.ts` | [`backend-py/simple_harmonic/team_tree.py`](../backend-py/simple_harmonic/team_tree.py) | `get_sub_tree_ids`, `is_ancestor`, `get_ancestor_chain`, `get_team_tree`. |
| `a2ax.ts` | [`backend-py/simple_harmonic/a2ax_singleton.py`](../backend-py/simple_harmonic/a2ax_singleton.py) | `get_a2ax()` lazy singleton over `JsonFileTransport(teams_root())`, 20-message context, 7-day expiry. |
| `validation.ts` | [`backend-py/simple_harmonic/validation.py`](../backend-py/simple_harmonic/validation.py) | `CONNECTOR_KEY_RE` / `TOOL_NAME_RE` + `assert_*` guards, same regexes. |
| `planner-deps.ts` | [`backend-py/simple_harmonic/dependencies.py`](../backend-py/simple_harmonic/dependencies.py) (+ tick wiring) | FastAPI DI; `get_store` reads the store off `app.state`, the planner deps assemble in the chat route / tick. |
| `standalone/server.ts` + `src/proxy.ts` (gate) | [`backend-py/simple_harmonic/app.py`](../backend-py/simple_harmonic/app.py) | `create_app()` factory + `OperatorGateMiddleware`. |
| `tick.ts` (resume guard) | [`backend-py/simple_harmonic/tick.py`](../backend-py/simple_harmonic/tick.py) | `_try_resume_agent` HOLD/resume/deny, `run_tick`, `run_tick_loop`. |

### The operator gate — allowlist middleware, not a broad deny

`app.py` builds the app with `create_app()` and registers a single `OperatorGateMiddleware` (a Starlette `BaseHTTPMiddleware`, `app.py:85-107`). It delegates the actual credential check to `auth.py`'s `is_operator_authorized` — which preserves the exact wire contract: a `Bearer OPERATOR_PASSWORD` header **or** the `sh_operator` cookie equal to `sha256_hex(password)`, both compared with `constant_time_equal` (a length guard + `hmac.compare_digest`, `auth.py:39-48,82-89`). Because the Python host has no edge-runtime constraint, `auth.py` uses `hashlib`/`hmac` directly instead of Web Crypto, but the cookie value is still literally the hex SHA-256 of the password — risk-register item 21.

The one **deliberate structural divergence** from the TS layer is the gate's shape (`app.py:33-82`). The TS `src/proxy.ts` / `standalone/server.ts` gate is a broad deny — everything under `/api/*` *except* `/api/tick` and `/api/login`. The Python gate instead enumerates an explicit `GATED_PREFIXES` allowlist of operator-only routes (`/api/settings`, `/api/chat`, `/api/spawn`, `/api/seed`, `/api/infra-report`, `/api/agent`) and an `OPEN_PREFIXES` list (`/api/tick`, `/api/login`, `/health`, `/api/teams`, `/api/team`). `_is_gated` returns true only when a path matches a gated prefix and no open prefix (`app.py:74-82`). This keeps `team/*` and `teams` open per the wire-compat rule ("the TS handlers read no session" — [backend-py/ARCHITECTURE.md](../backend-py/ARCHITECTURE.md) wire-compatibility rules) while making the careful `/api/teams`-vs-`/api/team` prefix distinction explicit rather than relying on path-order luck. The fail-open-in-dev / fail-closed-503-in-prod behavior for an unset `OPERATOR_PASSWORD` matches `operator-auth.ts`, keyed off `is_production_runtime()` (`NODE_ENV === "production"` or `VERCEL` set).

Cron auth is identical: `is_cron_authorized` trusts `x-vercel-cron` **only when `VERCEL` is set** (spoofable everywhere else), else a constant-time `Bearer CRON_SECRET` match, and when `CRON_SECRET` is unset it allows in dev and fails closed in production (`auth.py:92-105`) — risk-register item 22, the property the self-scheduling tick loop relies on. The tick route is intentionally *not* in `GATED_PREFIXES`; it runs its own cron check, exactly as `/api/tick` does in TS.

### Apollo GCM vault — the `[iv][tag][ciphertext]` interop

`apollo.py` keeps the TS module's stateful module-level shape (`load`/`set`/`remove`/`get`/`list_keys`/`has`/`mask` over module-level `_cache` and `_project_root`, `apollo.py:142-245`). The single load-bearing concern here is **byte-for-byte vault interop with Node** so a vault written by either runtime decrypts under the other (risk-register item 16, proven by a Node-produced golden vector in `tests/test_apollo.py`):

- **Tag layout.** Node lays the vault out `[iv (12)][auth tag (16)][ciphertext]` and obtains the tag separately via `getAuthTag()`. Python's `cryptography` `AESGCM` *appends* the 16-byte tag to the ciphertext, so `encrypt_gcm` splits it back out and `decrypt_gcm` re-appends it (`apollo.py:89-102`), letting `_encrypt`/`_decrypt` control the on-disk order exactly (`iv + tag + ciphertext`, `apollo.py:110-128`). This is the trap the TS layer never had to think about.
- **Key derivation.** `_derive_key` calls `hashlib.scrypt` with Node's `scryptSync` defaults — `N=16384, r=8, p=1, dklen=32` — and raises `maxmem` to 64 MiB so `N=16384` fits under OpenSSL's stricter default (`apollo.py:75-86`).
- **Salt + master key.** The per-install random 16-byte salt at `.apollo/salt` (mode `0600`), the legacy fixed `simple-harmonic-apollo-v1` fallback when no salt file exists, and the `APOLLO_MASTER_KEY` env > `.apollo/master.key` (auto-generated 32 hex bytes, mode `0600`) resolution all match the TS module (`apollo.py:257-311`).
- **`load()` operator-wins.** Decrypted entries are copied into `os.environ` **only if not already set**, and only newly-set keys are counted (`apollo.py:163-169`) — the second half of risk-register item 16. `mask()` is the same `first4••••last4` / `••••••••` display rule.

The persistence call site is `POST /api/settings/credentials` (`routes/settings.py:555-573`), which re-validates `key` against `CONNECTOR_KEY_RE` before `apollo.set(key, value)`. The agent file tools still refuse `.apollo/` paths (`tools/filesystem.py:82`), preserving the exfiltration guard. **Known divergence (deferred):** unlike the TS runtime, which calls `apollo.load()` once at startup (`src/instrumentation.ts` / `standalone/main.ts`), the Python app's lifespan does **not** yet auto-decrypt the vault into `os.environ` at boot — `apollo.load()` exists and is tested but is not wired into `create_app`'s lifespan. Vault-stored secrets set during a running process are live (via `set`), but a fresh boot does not repopulate them. This is the only material gap in this subsystem's parity and is not on the deferred list in MIGRATION.md.

### `scrub_pii` and the app-events pipeline

`events.py` ports the two load-bearing, store-independent pieces of `app-events.ts`: `scrub_pii` and `emit_app_event`. The **PII patterns and their order are replicated exactly** (risk-register item 23) — `sk-…`/`ghp_…`/`gho_…`/`xoxb-…`/`xoxp-…`/`Bearer …` token redaction, then the generic long-secret pattern, then emails, each `→ [REDACTED]` (`events.py:50-72`). Python's stdlib `re` rejects the JS variable-width lookbehind `(?<=[=:]\s*)`, so that one pattern is rewritten as a capturing prefix `([=:]\s*)` plus a replacement that re-emits the prefix (`\g<1>`) and redacts only the secret — byte-for-byte identical output (`events.py:58-60`). As in TS, `scrub_pii` is **exported and shared** by the trace sink (`trace.py:30`), so both pipelines carry the same guardrails.

`emit_app_event` (`events.py:163-222`) is fire-and-forget and swallows all errors, with the same in-order pipeline: `level` defaults to `agent`, PII scrub, per-agent rate limit (50/hour, the 51st becomes one synthetic "Rate limited…" event then silence, `events.py:99-117,191-197`), `infra` events forced to `team_id=None`, and the telemetry gate dropping `tool`/`infra` events for telemetry-off teams.

The idiomatic-Python choice here is **decoupling via injectable hooks** to honor the slice boundary (`events.py` must not import `store/`). The persistence sink (`set_event_sink`) and telemetry reader (`set_telemetry_reader`) default to a no-op / fail-open, and `wiring.py`'s `wire_runtime()` closes the seam at boot (called in the app lifespan, `app.py:130`) by pointing the sink at `appEvents.insert` and the reader at a cached `teams.byId` lookup. Because `appEvents.insert` is synchronous (telemetry never blocks) but the repo read is async, `wiring.py` resolves telemetry against a short-lived in-process cache that **fails open** on a miss and schedules a background refresh (`wiring.py:50-72`) — preserving the TS module's 60-second cache + fail-open semantics. `invalidate_telemetry_cache` is wired into the telemetry PUT handler (`routes/settings.py:753`), so a toggled flag is picked up on the next emit, matching `app-events.ts`.

### The trace sink — single background drain loop

`trace.py`'s `create_trace_sink` (`trace.py:58-128`) returns the same `{ tick_id, emit, flush }` contract. `emit(step)` is synchronous and never throws: it buffers a fully-shaped row (`teamId/agentId/tickId/seq/type/data/emittedAt`) and kicks a single background drain task that batch-appends in emission order, so the runner is never blocked on persistence (risk-register: telemetry never breaks a tick). The asyncio realization of the TS drain loop is faithful down to the documented race: a step pushed in the gap between the drain loop's last empty-check and its `finally` sees `draining=True`, isn't picked up by that loop, and is drained by `flush()`'s second pass (`trace.py:117-127`) — never lost, only delayed. `tick_id` is reused on resume so a resumed tick reads as one play-by-play thread.

`sanitize_trace_data` (`trace.py:136-177`) applies the same caps: `scrub_pii` on every string then truncate at 4 000 chars with a `[truncated N chars]` marker, depth cut at 6 (`[max depth]`), at most 50 entries/keys with an overflow marker, defensive `str()` for anything else. (One Python nuance handled explicitly: `bool` is an `int` subclass, so booleans are passed through as primitives, `trace.py:158`.) Retention is the same throttled-hourly prune with a 14-day default overridable by `SH_TRACE_RETENTION_DAYS` (`trace.py:188-214`). As with events, the actual JSONL append/prune is injected — `tick.py`'s `_make_trace_appender()` binds `traceEvents.append` and the tick fire-and-forgets `traceEvents.pruneOlderThan` each pass (`tick.py:283-285,405,725-742`).

### Team-tree and the a2ax singleton

`team_tree.py` mirrors `team-tree.ts` query-for-query: `get_sub_tree_ids` (the authorization scope for lead agents) does an iterative stack walk over a child map built from `teams.all()`; `is_ancestor` and `get_ancestor_chain` are cycle-guarded with a visited set; `get_team_tree` builds the `{id, name, paused, children}` display tree from the roots. The functions are `async` (the repo reads are async) but the traversal logic is the same in-memory parent-map walk, sized for the <100-team scale. `a2ax_singleton.py`'s `get_a2ax()` is the lazy process-wide singleton over `JsonFileTransport(teams_root())` with `max_context_messages=20` and a 7-day default expiry, plus `reset_a2ax_for_tests()` for tests that repoint `SH_DATA_DIR` — a direct port of `a2ax.ts`.

### The tick orchestrator's resume guard — HOLD / resume / deny

`tick.py`'s `_try_resume_agent` (`tick.py:535-649`) is the Python home of the load-bearing approval trichotomy (risk-register item 18; the TS equivalent lives in `api/tick.ts`):

- **HOLD** — an agent parked `awaiting_approval` returns `False` *without running and without rejecting* while the approval rows are **missing** (`len(decision_rows) < len(pending_calls)` — an incomplete parking write must not be read as an implicit rejection, `tick.py:566-569`) or while **any** approval is still `pending` (`tick.py:570-572`).
- **RESUME** — only once every pending approval has a decision does it `agents.claim(agent.id, "awaiting_approval")` and re-enter `run_agent` with the verdicts (`tick.py:586-630`).
- **DENY** — a denied approval becomes a `ToolDecision(approved=False)` that aborts that specific tool call inside the runner while the rest of the round still resumes (`tick.py:574-584`).

The resume pass runs **before** the due-agent pass (`tick.py:356-392`), and `agents.claim` — guarded by the store's `asyncio.Lock` (risk-register item 1) — is the double-run guard. The daily spend cap is checked first via `check_spend_allowed` and **fails open** on a ledger read error (`spend.unknown` ⇒ emit a `warning` and proceed, not halt; `tick.py:319-341` calling [`llm/spend.py`](../backend-py/simple_harmonic/llm/spend.py)) — risk-register item 13. The self-scheduling loop (`run_tick_loop`, `tick.py:905`) calls `run_tick` directly in-process every 10 s rather than self-POSTing `/api/tick` over HTTP; `tick_loop_should_start` enforces the TS boot rules (disabled on `SH_TICK_LOOP=0`; refuses to start in production without `CRON_SECRET` because the endpoint would 401 against its own server, `tick.py:883-902`).

### Deferred / known divergences relevant to this chapter

From [backend-py/MIGRATION.md](../backend-py/MIGRATION.md) ("Deferred / known divergences") and the gaps found above — all intentional and non-correctness:

- **Codex app-server harness *resume* path is not ported.** A parked `codex-thread` suspension resumes through the legacy runner via `AgentSuspension`; the load-bearing legacy-runner HOLD/resume/deny trichotomy above *is* fully ported and tested. `use_codex_harness` is computed/stored for parity but unread on the resume path (`tick.py:599-603`).
- **Per-team agents run sequentially** (`await` per agent) rather than the TS `Promise.allSettled` per pass — a latency gap, not a behavior one; `claim` + the store lock + per-run time bounds preserve correctness.
- **LLM resolution is lazy** (built on first agent run, because the Python OpenAI SDK raises at *client construction* with no key) vs eager-at-top-of-POST. Observable behavior is identical once an agent runs.
- **Apollo `load()` is not invoked at boot** in the Python lifespan (detailed above); the vault decrypts on demand via `set` but is not auto-populated into `os.environ` on a fresh start.

See [backend-py/ARCHITECTURE.md](../backend-py/ARCHITECTURE.md) for the full fidelity risk register and the stack decision, and [backend-py/MIGRATION.md](../backend-py/MIGRATION.md) for the slice-by-slice status (834 tests, full 43-endpoint parity).
