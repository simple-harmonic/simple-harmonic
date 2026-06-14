# 10 — Standalone Backend Host

Since PR #13 (commit `a035e7e`), the entire HTTP API is extracted out of Next.js: all 30 route bodies live as transport-agnostic web-standard handlers under `packages/backend/src/server/api/**`, the Next routes under `src/app/api/**/route.ts` are thin re-exports, and a `node:http` host under `packages/backend/src/server/standalone/` serves the identical `/api/*` surface without Next at all — `npm run dev:backend` boots Apollo secrets, the config banner, the HTTP server (port 3001 by default), and an in-process 10-second tick loop, while `npm run data:init` ensures the JSON file store's data directory exists headlessly (since PR #16 there is no database to bootstrap — see [02 — Data Model](02-data-model.md)). The standalone host re-implements the operator gate that `src/proxy.ts` provides in the Next app, but only for `/api/*`; it serves no pages, no static assets, and no UI. This Next-free host is also the production-shaped run mode for PR #16's file store, which assumes a single-writer persistent disk. Two parity tests pin the arrangement: one fails if the standalone route manifest and the Next wrapper tree ever diverge, the other smoke-tests the host end-to-end.

## The shared handler contract (`packages/backend/src/server/api/**`)

Every handler module exports per-HTTP-method named functions (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`) with the exact Next.js App Router signature — `params` arrives as a *Promise*:

- `export async function POST(req: Request)` — `packages/backend/src/server/api/tick.ts:132`; `GET` at `tick.ts:761-763` just delegates to `POST` because Vercel cron sends GET.
- `export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> })` — `packages/backend/src/server/api/team/id/index.ts:5`, with `PATCH` at `:60`.
- Zero-argument handlers are fine too: `export async function GET()` — `packages/backend/src/server/api/teams.ts:5`.

The standalone host types this as `RouteHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>` (`packages/backend/src/server/standalone/routes.ts:44-47`). Handlers parse their own bodies via `req.json()` and return `Response.json(...)` or `new Response(stream)` — never `NextResponse`; importing `next` from any handler is forbidden and test-enforced (`packages/backend/tests/unit/standalone-routes.test.ts:71-84`).

Both hosts consume the same modules:

- **Next host**: every `src/app/api/**/route.ts` is exactly two lines — the comment `// Thin Next.js adapter — logic lives in @simple-harmonic/backend.` plus `export { METHODS } from "@simple-harmonic/backend/server/api/<path>"` (e.g. `src/app/api/tick/route.ts` re-exports `{ GET, POST }`; `src/app/api/team/[id]/route.ts` re-exports `{ GET, PATCH }` from `.../server/api/team/id/index`). Resolution works through the backend package's source-only exports map `"./*": "./src/*"` (`packages/backend/package.json:6-8`) and the root tsconfig path `@simple-harmonic/backend/* → ./packages/backend/src/*` (`tsconfig.json:21-25`).
- **Standalone host**: `routes.ts` imports all 30 modules with `import * as` and dispatches to them from a manifest (next section), passing `{ params: Promise.resolve(params) }` to match the Next contract (`server.ts:127-129`).

Handler internals (tick scheduler, chat SSE, settings, approvals, …) are chapter 06's subject; the changes from PRs #12 and #14 (trace sinks, codex harness, `resolveLLM` cascade) are covered in their own chapters.

## Entrypoint and startup order: `main.ts`

`packages/backend/src/server/standalone/main.ts` is the headless equivalent of `src/instrumentation.ts` and deliberately mirrors its boot order (comment at `main.ts:7-11`). It must run **from the repo root** so `simple-harmonic.config.json` and `.apollo/` resolve from `process.cwd()` (`main.ts:13-14`).

1. **Port selection** — `Number(process.env.SH_BACKEND_PORT || process.env.PORT || 3001)` (`main.ts:34`).
2. **Apollo vault** — `loadApolloSecrets()` decrypts `.apollo/vault.enc` into `process.env`, logging the count when nonzero (`main.ts:36-39`). This must precede `getConfig()` so vault-stored vars (e.g. `DATABASE_URL`) are visible.
3. **Config banner** — `getConfig()` then one log line with cwd, model, codingBackend, and the database host with credentials stripped via `redactedDbHost` (`main.ts:25-32`, `41-45`) — host + pathname only, never the password.
4. **HTTP server** — `createBackendServer().listen(port)` (`main.ts:47-50`).
5. **Tick loop** — a `setInterval` every `TICK_INTERVAL_MS = 10_000` (`main.ts:23`, `63-81`) that calls the imported tick handler **in-process**: `await tick(new Request("http://localhost:${port}/api/tick", { method: "POST", headers }))` (`main.ts:69-71`) — no actual HTTP hop, the `Request` URL is cosmetic. When `CRON_SECRET` is set, the synthetic request carries `authorization: Bearer ${CRON_SECRET}` (`main.ts:66-68`). Non-ok responses log the status plus the first 200 chars of the body (`main.ts:72-75`); thrown errors are caught and logged (`main.ts:76-78`).

Two guards around the loop:

- `SH_TICK_LOOP=0` disables it entirely (`main.ts:52-53`) — for deployments where an external cron POSTs `/api/tick`.
- In production (`isProductionRuntime()`, i.e. `NODE_ENV === "production"` or `VERCEL` set) **without** `CRON_SECRET`, the loop refuses to start with a loud `console.error` (`main.ts:54-61`): the tick endpoint fails closed in production, so the loop would 401 against its own server every 10 seconds.

## The node:http bridge: `server.ts`

`createBackendServer(): Server` (`packages/backend/src/server/standalone/server.ts:140-154`) wraps everything in a top-level try/catch: an unhandled error logs and returns a JSON 500 `{ error: "internal error" }` if headers haven't been sent, else destroys the socket (`server.ts:145-152`). The caller owns the port and lifecycle (main.ts and the smoke test both call `.listen()` themselves).

**Request side** — `toRequest` (`server.ts:34-51`) builds a web-standard `Request` from the node `IncomingMessage`: URL reconstructed from the `host` header, all headers copied (array values appended individually), and for non-GET/HEAD methods the body is `Readable.toWeb(req)` with `duplex: "half"` (`server.ts:46-49`) — request bodies stream rather than buffering.

**Response side** — `sendResponse` (`server.ts:54-73`) copies headers, emits multi-value `Set-Cookie` via `response.headers.getSetCookie()` (`server.ts:59-60`), and streams the body with `Readable.fromWeb(...).pipe(nodeRes)`. The load-bearing detail: `nodeRes.on("close", () => stream.destroy())` (`server.ts:71`) — `pipe()` does not destroy its source when the client disconnects, so without this an aborted SSE response (e.g. `/api/chat`) would keep streaming LLM tokens into a dead socket.

**Auth gate** — `gate` (`server.ts:79-95`) mirrors `src/proxy.ts` for the API subset:

1. `/api/tick`(`/*`) and `/api/login`(`/*`) pass through (`server.ts:82-83`) — tick runs its own cron-secret check; login must stay reachable so the operator can authenticate.
2. `OPERATOR_PASSWORD` unset: 503 `{ error: "OPERATOR_PASSWORD not configured" }` when `isProductionRuntime()`, otherwise open — local dev works with zero config (`server.ts:86-92`).
3. Otherwise `isOperatorAuthorized(req, password)` (Bearer password or `sh_operator` cookie); failure → JSON 401 (`server.ts:93-94`).

**Dispatch** — `dispatch` (`server.ts:97-137`):

| Request | Response |
|---|---|
| `GET /` | 200 `{ name: "@simple-harmonic/backend", mode: "standalone" }` — deliberately **no endpoint listing**, since `/` is reachable unauthenticated (`server.ts:101-104`) |
| any other non-`/api/` path | 404 `{ error: "not found" }` (`server.ts:106`) |
| `OPTIONS` on a matched route | 204 with an RFC 9110 `Allow` header built by `allowHeader` (`server.ts:26-31`, `118-120`) — exported methods plus `OPTIONS`, plus `HEAD` when `GET` exists |
| `HEAD` on a matched route | served through the `GET` handler, then the body is cancelled and stripped, preserving status and headers (`server.ts:122`, `130-133`) — mirroring Next |
| matched route, method not exported | 405 `{ error: "method not allowed" }` with `Allow` (`server.ts:124-126`) |
| no route matches | 404 (`server.ts:136`) |

## The route manifest: `routes.ts`

`routes` (`packages/backend/src/server/standalone/routes.ts:63-94`) is an ordered list of exactly **30** `{ pattern, module }` entries — one per Next route. The full table (methods are the handler module's exports, grep-verified):

| Pattern | Handler module (`packages/backend/src/server/api/`) | Methods |
|---|---|---|
| `/api/agent/:id` | `agent/id.ts` | PATCH |
| `/api/chat` | `chat.ts` | POST (SSE) |
| `/api/infra-report` | `infra-report.ts` | GET, POST |
| `/api/login` | `login.ts` | POST |
| `/api/seed` | `seed.ts` | POST |
| `/api/settings` | `settings/index.ts` | GET, POST |
| `/api/settings/codex` | `settings/codex.ts` | GET, POST |
| `/api/settings/codex-login` | `settings/codex-login.ts` | GET, POST |
| `/api/settings/coding` | `settings/coding.ts` | GET |
| `/api/settings/connectors` | `settings/connectors.ts` | GET, POST, DELETE |
| `/api/settings/credentials` | `settings/credentials.ts` | POST |
| `/api/settings/platform-status` | `settings/platform-status.ts` | GET, PUT |
| `/api/settings/setup-db` | `settings/setup-db.ts` | POST |
| `/api/settings/skills` | `settings/skills.ts` | GET, PATCH |
| `/api/settings/telemetry` | `settings/telemetry.ts` | GET, PUT |
| `/api/settings/test-db` | `settings/test-db.ts` | POST |
| `/api/settings/test-llm` | `settings/test-llm.ts` | POST |
| `/api/spawn` | `spawn.ts` | POST |
| `/api/team/:id` | `team/id/index.ts` | GET, PATCH |
| `/api/team/:id/agent-hub` | `team/id/agent-hub.ts` | GET |
| `/api/team/:id/approvals` | `team/id/approvals.ts` | GET, POST |
| `/api/team/:id/conversations` | `team/id/conversations.ts` | GET |
| `/api/team/:id/heartbeat` | `team/id/heartbeat.ts` | POST |
| `/api/team/:id/messages` | `team/id/messages.ts` | GET, POST |
| `/api/team/:id/narration` | `team/id/narration.ts` | GET (SSE) |
| `/api/team/:id/pause` | `team/id/pause.ts` | POST |
| `/api/team/:id/tasks` | `team/id/tasks.ts` | GET |
| `/api/team/:id/trace` | `team/id/trace.ts` | GET (SSE) |
| `/api/teams` | `teams.ts` | GET |
| `/api/tick` | `tick.ts` | GET, POST |

**Parity with the Next app surface**: there is no route present in one host but not the other — the `src/app/api/**` tree contains exactly these 30 wrappers (grep-verified, both directions), and `standalone-routes.test.ts:43-47` enforces strict sorted equality between the manifest and a walk of the real wrapper tree, so any one-sided addition fails CI. (The 30 include `/api/team/:id/trace` from PR #12's trace pipeline, not part of the standalone work itself.)

`matchPath` (`routes.ts:97-115`) does segment-wise matching: `:name` segments capture, captured values pass through `decodeURIComponent` (`routes.ts:106`), and **malformed percent-encoding returns `null`** — a 404, not a 500 (`routes.ts:107-109`; tested with `/api/team/%zz`). Segment counts must match exactly, so `/api/team/:id` never swallows `/api/team/abc/trace` and vice versa.

## Headless data-store bootstrap: `setup-db-cli.ts` (`npm run data:init`)

`packages/backend/src/server/standalone/setup-db-cli.ts` is the CLI twin of the Settings → Storage UI button — same handler, same behavior. PR #16 reduced it to a data-directory bootstrap (no database, no schema):

1. `loadApolloSecrets()` runs first so a vault-stored `dataDir` (or any config-bearing var) reaches `getConfig()` — same boot order as main.ts (`setup-db-cli.ts:17`).
2. It calls the `POST` handler of `packages/backend/src/server/api/settings/setup-db.ts` **in-process** with a synthetic JSON `Request` (`setup-db-cli.ts:22-28`). With no argument the body is `{}` (configured/default data dir); `npm run data:init -- /path/to/dir` passes `process.argv[2]` as `{ dataDir }` (`setup-db-cli.ts:19-20`), which the handler also persists to `simple-harmonic.config.json` via `setConfig`.
3. The handler calls `ensureDataDir()` to create the `teams/` + `system/` skeleton; the CLI prints each `result.steps` entry as `• step`, then `✓ Data store ready` (exit 0) or `✗ <error>` (exit 1) (`setup-db-cli.ts:32-42`).

Like main.ts, it must run from the repo root so the config file and the default `.simple-harmonic/data` dir resolve.

## npm scripts and dependencies

PR #13 added two scripts to the root `package.json`:

| Script | Command | Purpose |
|---|---|---|
| `dev:backend` | `tsx packages/backend/src/server/standalone/main.ts` (`package.json:10`) | Run the headless backend (server + tick loop) |
| `data:init` | `tsx packages/backend/src/server/standalone/setup-db-cli.ts` (`package.json:11`) | Headless data-directory bootstrap (`ensureDataDir`); renamed from `db:setup` in PR #16 |

Both ride on the devDependency `tsx ^4.19.0` (`package.json:66`) — the backend package is source-only TypeScript, so something has to execute it directly. The README documents the workflow in "Backend without the frontend", and the quick start's storage step is `npm run data:init`.

## Auth: standalone gate versus the Next proxy

The two hosts enforce the same operator model with different scopes and failure surfaces:

| Aspect | Next host (`src/proxy.ts`) | Standalone host (`server.ts:79-95`) |
|---|---|---|
| Coverage | Every request except `_next/static`, `_next/image`, `favicon.ico`, `login`, `api/login` (matcher, `src/proxy.ts:54-58`) — **pages and API alike** | **`/api/*` only**; `/` and other paths never hit the gate (comment at `server.ts:102-103`) |
| Tick exemption | `/api/tick`(`/*`) passes through; tick does its own cron check | Same (`server.ts:82`) |
| Login exemption | Excluded via the matcher | Explicit pass-through (`server.ts:83`) |
| `OPERATOR_PASSWORD` unset | Prod: 503 (JSON for API, plain text for pages); dev: open | Prod: JSON 503; dev: open — no page variant exists |
| Unauthorized | API → JSON 401; **page → redirect to `/login`** | JSON 401 always; there is no login page to redirect to |
| How the operator logs in | `/login` page → `POST /api/login` → `sh_operator` cookie | `POST /api/login` directly (JSON body), or skip cookies entirely with `Authorization: Bearer <OPERATOR_PASSWORD>` |

Both share `isOperatorAuthorized` from `packages/backend/src/server/operator-auth.ts:59-68` (Bearer password or `sh_operator` cookie equal to `sha256Hex(password)`, constant-time compares), and the login handler (`packages/backend/src/server/api/login.ts:5`) sets the same 30-day `HttpOnly; SameSite=Lax; Path=/` cookie, `Secure` in production (`login.ts:20-23`).

**Security hardening shipped with PR #13**: `isCronAuthorized` trusts the `x-vercel-cron` header **only when `process.env.VERCEL` is set** (`operator-auth.ts:76-89`, check at `:83`). Previously header presence alone sufficed — fine on Vercel, where the edge strips client-supplied copies, but trivially spoofable on the standalone host, where it would have allowed unauthenticated agent ticks (i.e. LLM spend). The rest is unchanged: Bearer `CRON_SECRET` with `constantTimeEqual` when set; unset → open in dev, fail closed in production. The file remains edge-safe (Web Crypto only) so the Next proxy can keep importing it.

## What the standalone host does NOT provide

- **No Next.js pages or UI** — no dashboard, no chat view, no settings screens, no `/login` page. `/` returns only the JSON banner; every other non-`/api` path 404s (`server.ts:100-107`).
- **No `src/proxy.ts`** — the page-gating half of the proxy has no equivalent; the standalone gate covers `/api/*` only.
- **No static assets**, no `_next/*`, no favicon.
- **No Vercel cron integration** — the in-process loop (or your external cron) is the tick driver, and `x-vercel-cron` is explicitly untrusted here.

What it *does* still provide, because the bridge streams `Response` bodies through and destroys them on client disconnect: all three SSE endpoints work — the chat planner stream (`packages/backend/src/server/api/chat.ts:130`), team narration with its `X-Accel-Buffering: no` header (`team/id/narration.ts:102-106`), and the trace stream (`team/id/trace.ts:112-116`).

## The parity tests

Two suites pin the arrangement:

**`packages/backend/tests/unit/standalone-routes.test.ts`** (109 lines) — the drift guard. It walks the **real** `src/app/api` tree across the package boundary (`APP_API_DIR`, `standalone-routes.test.ts:13`), converting `[id]` directories to `:id` patterns, and asserts:

1. Sorted manifest patterns strictly equal the patterns derived from the wrapper tree (`:43-47`) — a route added to one surface but not the other fails.
2. Every manifest module exports at least one HTTP method (`:49-53`).
3. Every Next wrapper matches a thin re-export regex — optional comment lines plus exactly one `export { METHODS } from "@simple-harmonic/backend/server/api/..."` statement (`:56-57`) — and its method list equals the manifest module's exports (`:64-67`). Re-fattening a wrapper fails.
4. No file under `packages/backend/src/server/api/` imports `next` (`:71-84`) — the handlers stay transport-agnostic.

Plus `matchPath` unit tests (`:87-109`): static exactness, `:param` capture with decoding (`a%20b` → `a b`), `%zz` → `null` instead of a throw, and sibling-route non-confusion.

**`packages/backend/tests/unit/standalone-server.test.ts`** (123 lines) — the DB-free smoke test. It boots `createBackendServer()` on port 0 with `OPERATOR_PASSWORD` set and `VERCEL` cleared (`:18-30`) and hits only DB-free endpoints with real `fetch`: the `/` banner has `mode: "standalone"` and **no** `endpoints` array (`:43-49`); `/api/settings` is 401 unauthenticated (`:51-54`); login rejects a wrong password and on success sets the `HttpOnly` `sh_operator=sha256(password)` cookie (`:56-71`); both the cookie and the Bearer password admit subsequent requests (`:73-84`); unknown API paths 404 (`:86-91`); `GET /api/login` is 405 with `Allow: POST, OPTIONS` (`:93-97`); `HEAD /api/settings` is 200 with an empty body (`:99-106`); `OPTIONS /api/settings` is 204 with `Allow: GET, POST, OPTIONS, HEAD` (`:108-115`); and `/api/team/%zz` is 404, not 500 (`:117-122`).

## Environment variables added or repurposed by this host

| Variable | Default | Purpose (standalone host) |
|---|---|---|
| `SH_BACKEND_PORT` | — | Listen port; takes precedence over `PORT` (`main.ts:34`) |
| `PORT` | `3001` fallback chain | Listen port if `SH_BACKEND_PORT` unset |
| `SH_TICK_LOOP` | loop on | `0` disables the in-process tick loop (external cron instead) |
| `CRON_SECRET` | unset | Attached as Bearer by the tick loop; **required** in production or the loop refuses to start (`main.ts:54-61`) |
| `OPERATOR_PASSWORD` | unset (dev open, prod 503) | The `/api/*` gate, identical semantics to the Next proxy |
| `NODE_ENV` / `VERCEL` | — | `isProductionRuntime()` fail-closed behavior; `VERCEL` additionally gates `x-vercel-cron` trust (`operator-auth.ts:83`) |

## Parked: the skills-directory migration (stash@{0})

A previously uncommitted skills-directory migration (directory-based `SKILL.md` skills, a sub-skill tree with progressive disclosure, and `open_skills` persistence) was discarded on 2026-06-11; its code no longer exists anywhere in the repo. Only its untracked files survive, parked in `git stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees and `packages/backend/tests/unit/skill-tree.test.ts`.

If that work is ever revived, its tick/setup-db/runner changes must be ported into the extracted handler modules — `packages/backend/src/server/api/tick.ts` and `packages/backend/src/server/api/settings/setup-db.ts` — not into the now-thin `src/app/api/**/route.ts` wrappers, which the parity test forces to stay two-line re-exports.

## Python backend (FastAPI port)

The Python port (`backend-py/`, slice 8 of [MIGRATION.md](../backend-py/MIGRATION.md); stack rationale in [ARCHITECTURE.md](../backend-py/ARCHITECTURE.md)) collapses what the TS runtime splits across three standalone files (`server.ts` + `routes.ts` + `main.ts`) into a single ASGI factory, `create_app()` in `backend-py/simple_harmonic/app.py`, plus the self-scheduling loop in `backend-py/simple_harmonic/tick.py`. There is no `node:http` bridge to write: **uvicorn is the host**. The factory builds a `FastAPI` instance, mounts the six `APIRouter`s, attaches the operator gate as middleware, and exposes a module-level `app = create_app()` so `uv run uvicorn simple_harmonic.app:app` works with no glue (`app.py:174-175`). The Next.js frontend is the *same* frontend — the cutover is purely a reverse-proxy flip (see "Env-gated cutover" below), so this host serves the identical `/api/*` surface, only over ASGI instead of `node:http`.

### TS standalone host → Python module map

| TS standalone concern (`packages/backend/src/server/standalone/`) | Python equivalent |
|---|---|
| `server.ts` `createBackendServer()` — the `node:http` request/response bridge | None needed — uvicorn (ASGI) does request decoding and response/SSE streaming; `create_app()` (`app.py:110`) is the analogue, and the ASGI server owns the socket lifecycle the TS `try/catch` + `socket.destroy()` hand-rolled |
| `server.ts` `gate` — the `/api/*` operator gate | `OperatorGateMiddleware` (`app.py:85-107`), a Starlette `BaseHTTPMiddleware` |
| `routes.ts` `routes` manifest + `matchPath` | FastAPI path-operation routing — `@router.<method>("/api/...")` decorators across `routes/` register the table declaratively; no hand-written manifest or `matchPath` |
| `main.ts` port selection + `listen()` | `main()` (`app.py:178-190`) → `uvicorn.run(...)` |
| `main.ts` `setInterval` tick loop | `run_tick_loop()` asyncio task (`tick.py:905-928`), started in the FastAPI `lifespan` |
| `main.ts` boot-order banner (Apollo → config → server → loop) | the `lifespan` async-context-manager (`app.py:125-153`) + `tick_loop_should_start()` (`tick.py:883-902`) |
| `setup-db-cli.ts` (`npm run data:init`) | folded into the lifespan: `resolved_store.ensure()` (`app.py:131`) creates the skeleton on every boot; still reachable as `POST /api/settings/setup-db` (`routes/settings.py:620`) |

### Entrypoint and startup order: `create_app()` + `lifespan`

The TS `main.ts` runs a strict five-step boot sequence (port → Apollo vault → config banner → `listen()` → tick loop). FastAPI moves the equivalent work into the **lifespan async-context-manager** (`app.py:125-153`), which uvicorn runs after binding the socket. On startup it:

1. `wire_runtime()` (`app.py:130`, defined in `backend-py/simple_harmonic/wiring.py`) — closes the slice-4 seam by pointing the decoupled app-events emitter at `appEvents.insert` and the telemetry reader at a cached `teams.byId`, so the events module never imports `store`. This has no `main.ts` analogue; it is the Python port's way of keeping the telemetry emitter store-agnostic while still persisting through the real repos.
2. `await resolved_store.ensure()` (`app.py:131`) — `RepoStore.ensure()` (`backend-py/simple_harmonic/store/repo_store.py:35-39`) calls `ensure_data_dir()` to create the `teams/` + `system/` skeleton and drops the stale location index. This is the inline equivalent of the TS `data:init` CLI: a fresh checkout serves cleanly on first boot with no separate bootstrap step.
3. The tick loop is imported **lazily** inside the lifespan (`app.py:135`) — `from simple_harmonic.tick import run_tick_loop, tick_loop_should_start` — explicitly so that importing `app` stays cheap and side-effect-light (the meta-agent/tools graph is only pulled in when a tick is actually going to run). It is started as an `asyncio.create_task` guarded by `tick_loop_should_start()` (next section), and on shutdown the lifespan sets a `stop` event, cancels the task, and awaits it (`app.py:148-153`) — clean teardown the `setInterval` never had.

Port selection lives in `main()` (`app.py:185-190`) and mirrors the TS fallback chain exactly: `int(os.environ.get("SH_BACKEND_PORT") or os.environ.get("PORT") or 3001)`, then `uvicorn.run("simple_harmonic.app:app", host="0.0.0.0", port=port)`. There is no console-script entry in `backend-py/pyproject.toml`; the process is launched either as `uv run uvicorn simple_harmonic.app:app --port 3001` (the documented path in [MIGRATION.md](../backend-py/MIGRATION.md)) or via `python -m simple_harmonic.app` through the `if __name__ == "__main__": main()` guard (`app.py:193-194`).

Note the Apollo-vault step is absent from the Python lifespan. Apollo decryption was ported in slice 4 (the GCM `[iv][tag][ct]` byte-layout fix is risk-register item 16), but the lifespan does not call it; settings are read directly from the environment + `.env` by `pydantic-settings` (next section). A vault-stored var must be exported before launch for the Python host to see it — a divergence from `main.ts`, where `loadApolloSecrets()` runs *before* `getConfig()` precisely so vault vars reach config.

### Settings: `pydantic-settings` instead of `getConfig()`

`backend-py/simple_harmonic/settings.py` replaces both `config.ts` and the env-reading scattered through `main.ts`. `Settings(BaseSettings)` reads the **same** environment variable names the Node backend reads, via explicit `alias=` on each field (`settings.py:47-67`), with `SettingsConfigDict(env_file=(".env", ".env.local"), case_sensitive=False)` (`settings.py:39-44`) — so a single repo-root `.env` drives both runtimes during cutover. The host-relevant fields:

- `sh_backend_port` / `PORT` — *not* a `Settings` field; the port is read directly with `os.environ.get` in `main()` (`app.py:189`), matching the TS `Number(...)` parse, because uvicorn owns the port before the app (and its settings) exist.
- `operator_password` (`OPERATOR_PASSWORD`, `settings.py:59`) — the gate secret.
- `cron_secret` (`CRON_SECRET`, `settings.py:60`) — the tick auth.
- `is_production()` (`settings.py:88-90`) — the `isProductionRuntime()` parity check: `NODE_ENV == "production" or bool(VERCEL)`. (`auth.is_production_runtime()` at `auth.py:29-31` is the same predicate, used from the gate and the loop guard.)

`get_settings()` is `@lru_cache(maxsize=1)` (`settings.py:93-98`), so config is read once per process exactly like the memoized `getConfig()`. `SH_TICK_LOOP` and the per-agent timeout (`SH_AGENT_TIMEOUT_MS`) are read straight from `os.environ` in `tick.py` rather than promoted to `Settings` fields, because they are loop-internal knobs the rest of the app never reads.

### The operator gate: allowlist middleware vs the broad TS gate

This is the **one deliberate behavioral divergence** in this chapter, and it is documented in `app.py:33-58`. The TS standalone `gate` is a *broad* gate: everything under `/api/*` is protected except the two explicit pass-throughs (`/api/tick`, `/api/login`). The Python `OperatorGateMiddleware` (`app.py:85-107`) inverts this to an **explicit allowlist of operator-only prefixes** (`GATED_PREFIXES` at `app.py:51-58`: `settings`, `chat`, `spawn`, `seed`, `infra-report`, `agent`), with `OPEN_PREFIXES` (`app.py:61-67`: `tick`, `login`, `health`, `teams`, `team`) always open. The reason is a wire-compatibility rule from [ARCHITECTURE.md](../backend-py/ARCHITECTURE.md): the TS `team/*` and `teams` handlers read no session, so the Python port keeps them open by listing them in `OPEN_PREFIXES` (`_is_gated`, `app.py:74-82`, returns false for any open-prefix match before testing the gated set — and `/api/teams` is itself listed open so the `/api/team` prefix can't shadow it). New operator-only routes opt in by prefix; everything else is open by default.

Within a gated route the **failure semantics match `server.ts` exactly** (`app.py:96-107`): no `OPERATOR_PASSWORD` configured → 503 `{"error": "OPERATOR_PASSWORD not configured"}` in production (`is_production_runtime()`), open in dev; password set but request unauthorized → 401 `{"error": "unauthorized"}`. Authorization itself is `is_operator_authorized(request.headers, password)` (`backend-py/simple_harmonic/auth.py:82-89`), which honors the same Bearer-`OPERATOR_PASSWORD`-or-`sh_operator`-cookie contract with constant-time compares (cookie value = hex `sha256(password)`), preserving risk-register item 21 (cookie wire-compat).

The TS host also serves an unauthenticated `GET /` JSON banner (`{ name, mode: "standalone" }`, deliberately listing no endpoints) and 404s every other non-`/api` path. The Python port has **no `/` banner**; its liveness surface is `GET /health` (`backend-py/simple_harmonic/routes/health.py:18-20`, returning `{status, version}`), which is in `OPEN_PREFIXES`. Unknown `/api/*` paths return FastAPI's standard 404 rather than the hand-rolled `{ error: "not found" }`.

### The self-scheduling tick loop: asyncio task vs `setInterval`

The TS loop self-POSTs `/api/tick` over HTTP every 10s (with a cosmetic `Request` URL and a `CRON_SECRET` bearer when set). The Python loop, `run_tick_loop(stop)` (`tick.py:905-928`), skips the HTTP hop entirely and `await run_tick()` **in-process** — there is no synthetic `Request`, because the boot-time gate already decided the loop may run. It sleeps via `asyncio.wait_for(stop.wait(), timeout=interval_ms/1000)` so a shutdown signal cancels the sleep immediately instead of waiting out the interval; `_TICK_INTERVAL_MS = 10_000` (`tick.py:880`) matches the TS `TICK_INTERVAL_MS`. A failing tick is caught and logged and the loop continues (`tick.py:925-928`) — one bad pass never tears the loop down, exactly as in `main.ts`.

The two boot guards are preserved verbatim in `tick_loop_should_start()` (`tick.py:883-902`):

- `SH_TICK_LOOP=0` → don't start (external cron POSTs `/api/tick` instead). This is risk-register item 22's dev path.
- Production (`is_production_runtime()`) **without** `CRON_SECRET` → refuse to start, with the same loud rationale message: the tick endpoint fails closed in prod, so the loop would 401 against its own server every 10s. The operator must set `CRON_SECRET` or `SH_TICK_LOOP=0` + an external cron.

`create_app()` takes an optional `start_tick_loop` override (`app.py:110`, `137-139`): tests pass `False` (or rely on the default, which under the test env never starts the loop), so the orchestration graph is never imported and no background work runs during the offline suite. When left `None`, the boot rules decide. This is the Python analogue of the TS loop living in `main.ts` (the production entrypoint) but never in the test harness.

When the in-process loop is off, the tick endpoint is still cron-gated identically: `routes/teams.py` exposes `GET|POST /api/tick` and runs `is_cron_authorized(request.headers, cron_secret)` (`routes/teams.py:38-55`) before `run_tick()`, where `is_cron_authorized` (`auth.py:92-105`) trusts `x-vercel-cron` **only when `VERCEL` is set** — the same hardening PR #13 shipped (risk-register item 22). The GET handler delegates to the same authorized path (Vercel cron sends GET), mirroring `tick.ts:761-763`.

### Load-bearing fidelity behaviors this host depends on

`run_tick()` itself (`tick.py:271-400`) is chapter 06's subject, but two register items are load-bearing for the *host* specifically:

- **`agents.claim()` race-freeness (item 1).** Node's single thread made the standalone loop's in-process tick atomic for free. asyncio does not, so every store read-modify-write holds an explicit `asyncio.Lock`; `claim` is the double-run guard so two overlapping ticks can't both run one agent. The host relies on this because the background loop and an external/Vercel cron POST can in principle tick concurrently against the shared `.simple-harmonic/data/` dir.
- **Spend cap fails OPEN (item 13).** `check_spend_allowed` (called at `tick.py:320`) returns allowed on a ledger read error, so a transient fault never wedges the self-scheduling loop into skipping forever.

### Deferred / known divergences relevant to this chapter

From [MIGRATION.md](../backend-py/MIGRATION.md)'s honest list:

- **No standalone-routes parity test.** The TS arrangement is pinned by `standalone-routes.test.ts` (drift guard between the manifest and the Next wrapper tree) and `standalone-server.test.ts` (DB-free smoke). The Python port has no manifest to drift against — routing is the FastAPI decorator table — so the equivalent guard is slice 8's contract parity tests (0 missing / 0 extra against the 43 TS method+path combos), not a manifest-equality test.
- **No `GET /` banner**, and unknown-path/method bodies use FastAPI defaults rather than the hand-rolled `{ error: ... }` JSON. The `Allow`-header / `HEAD`-via-`GET` / `OPTIONS`-204 minutiae from `server.ts`'s dispatch table are handled by Starlette's routing, not re-implemented.
- **Per-team agents run sequentially** (`await` per agent in `run_tick`) vs the TS `Promise.allSettled` per pass — a latency gap, not a behavior gap (claim is the double-run guard; each run is independently time-bounded; the store lock serializes writes).
- **No Apollo decryption in the lifespan** (see "Entrypoint and startup order" above) — a vault-stored var must be exported before launch.

### Env-gated cutover

The cutover is a reverse-proxy flip, not a host swap. [`next.config.ts`](../next.config.ts) reads `PY_BACKEND_URL`; when set, a `beforeFiles` rewrite forwards every `/api/:path*` to the Python host (e.g. `http://localhost:3001`) ahead of the filesystem API routes, so the Next routes are bypassed entirely. Unset (the default) leaves behavior unchanged and the TypeScript Next routes serve. To run them side by side against the same store:

```bash
# terminal 1 — Python backend
cd backend-py && uv run uvicorn simple_harmonic.app:app --port 3001
# terminal 2 — Next.js, forwarding /api/* to the Python host
PY_BACKEND_URL=http://localhost:3001 npm run dev
```

Because both runtimes share the `.simple-harmonic/data/` JSON tree (no schema, no migration — see [02 — Data Model](02-data-model.md)), `PY_BACKEND_URL` can be flipped on and off to compare the two backends live. This is the [MIGRATION.md](../backend-py/MIGRATION.md) slice-9 deliverable; the TS standalone host (`dev:backend`) remains the parallel run mode for the Node runtime.
