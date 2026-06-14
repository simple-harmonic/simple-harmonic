# 09 — Testing, Developer Tooling, CI, and Repo Configuration

Simple Harmonic is an npm-workspaces monorepo with a Next.js app at the repo root and three workspace packages under `packages/` (`a2ax`, `backend`, `frontend`). The backend and frontend packages are *source-only slices* of the root app — they export raw TypeScript (`"./*": "./src/*"`) and declare no runtime dependencies of their own — while `a2ax` is a conventionally built library shipping a committed `dist/`. Testing is Vitest (three projects, 60 test files) plus a two-spec Playwright suite; since PR #13 the HTTP handlers live *inside* the backend package (`packages/backend/src/server/api/**`, with the Next.js routes under root `src/app/api/` reduced to thin re-exports), so the `api-*.test.ts` suite imports them as ordinary in-package modules and a dedicated parity test keeps the two surfaces identical. PR #16 replaced PostgreSQL/Drizzle with a synchronous on-disk JSON file store, which reshapes the test architecture: route-handler tests now seed and assert against a *real* file store in a per-test temp dir (via the new `tests/helpers/store.ts`) instead of a hand-rolled drizzle mock, and the schema-drift machinery (`schema-sync.test.ts`, `db.test.ts`, `scripts/db-code-diff.py`) is gone. Linting/formatting is Biome (scoped to root `src/` only) wired into a husky pre-commit hook via lint-staged. CI is a single GitHub Actions workflow with four jobs (lint, typecheck×3, test, opt-in e2e) on Node 22. Deployment is zero-config Vercel (`vercel.json` is only a once-a-minute cron hitting `/api/tick`) — though the file store now assumes a single-writer persistent disk, so the standalone backend host (`npm run dev:backend`, Next-free since PR #13) is the production-shaped run mode. The live system is main (`0ff84520`, PR #16 merged); the local checkout is still behind at `9f301cc` (the Postgres world) with uncommitted edits and untracked `docs/` — see the repo-state snapshot at the end of this chapter.

## Monorepo layout and package graph

Workspaces are declared at `package.json:5-7` as `packages/*`. The root package (`simple-harmonic`, v0.1.0, private) is the Next.js app; it depends on all three workspace packages with version `"*"` (`package.json:33-35`).

| Package | Exports | Runtime deps | Role |
|---|---|---|---|
| `simple-harmonic` (root) | n/a (app) | next, react, @anthropic-ai/sdk, openai, zod, ws, … (`package.json:29-47`) | Next.js app: pages + API routes in `src/app/` |
| `@simple-harmonic/backend` | `"./*": "./src/*"` (`packages/backend/package.json:6-8`) | **none** (devDeps: vitest only) | meta-agent library (`src/lib/meta-agent/`) + server modules (`src/server/`: JSON file store, tools, connectors) |
| `@simple-harmonic/frontend` | `"./*": "./src/*"` (`packages/frontend/package.json:6-8`) | **none** (devDeps: vitest, jsdom, @vitejs/plugin-react) | React components consumed by root pages |
| `@simple-harmonic/a2ax` | built `dist/` with subpath exports `./types`, `./transport/memory`, `./adapters/json-file` (`packages/a2ax/package.json:8-25`) | **none** (devDeps: biome, typescript, vitest) | agent-to-agent protocol library; MIT licensed; `dist/` is committed to git |

PR #16 removed the database stack entirely: `drizzle-orm`, `pg`, `@neondatabase/serverless`, and `@types/pg` are no longer in the root `package.json` (`dependencies` are `next`, `react`/`react-dom`, the three workspaces, the UI libs, `@anthropic-ai/sdk`, `openai`, `ws`, `zod`; `package.json:29-47`), and the a2ax package dropped its optional `drizzle-orm` peer dependency — its `devDependencies` are now just `@biomejs/biome`, `typescript`, and `vitest` (`packages/a2ax/package.json`). Persistence is the in-repo synchronous JSON file store (`packages/backend/src/server/store/`), so no third-party persistence dep survives anywhere in the graph.

Dependency edges:

- **root → backend, frontend, a2ax** — declared (`package.json:32-34`). Because backend/frontend export source, the root Next.js build compiles their TypeScript directly through the workspace symlinks in `node_modules/@simple-harmonic/*`; there is no build step for either. Only `a2ax` is consumed from `dist/` (built by `tsc`, `packages/a2ax/package.json`, and checked in).
- **backend → a2ax** — real import in `packages/backend/src/server/a2ax.ts` (now `new JsonFileTransport(teamsRoot())` from `@simple-harmonic/a2ax/adapters/json-file`, `a2ax.ts:6,15`), but *not declared* in `packages/backend/package.json`; it resolves via the hoisted root `node_modules`.
- **frontend → backend** — real imports (value imports of identity constants from `@simple-harmonic/backend/lib/meta-agent/identity` and type imports from `@simple-harmonic/backend/lib/meta-agent`), also *not declared*; resolves the same way at runtime and via tsconfig paths at typecheck time (`packages/frontend/tsconfig.json:16`).

Because backend and frontend declare no dependencies, neither is installable outside this monorepo; all shared third-party deps (react, next, openai, …) live in the root `package.json` and are hoisted.

## TypeScript configuration

Four `tsconfig.json` files, no project references:

- **Root** (`tsconfig.json`): Next.js plugin, `strict`, `noEmit`, `moduleResolution: "bundler"`. Paths at `tsconfig.json:21-25`: `@/*` → `./src/*`, `@simple-harmonic/backend/*` → `./packages/backend/src/*`, `@simple-harmonic/frontend/*` → `./packages/frontend/src/*` — i.e. the root app type-checks against package **source**, not dist. `include` is still the sweeping `**/*.ts`/`**/*.tsx` (`tsconfig.json:27-34`), but PR #13 changed `exclude` from `["node_modules"]` to `["node_modules", "packages", ".claude"]` (`tsconfig.json:35`), so a bare root `tsc --noEmit` now covers only the root app instead of re-sweeping every package (the PR #13 commit message records 356 errors eliminated by this scoping).
- **Backend** (`packages/backend/tsconfig.json`): `@/*` → `./src/*`; `include` is `src/**/*.ts` + `tests/**/*.ts` and `exclude` is just `["node_modules"]` (`packages/backend/tsconfig.json:18-19`). The pre-PR-#13 carve-out that excluded `tests/unit/api-*.test.ts` from the package typecheck (those tests used to exercise repo-root `src/app` routes and were type-checked by the root tsconfig instead) is gone: the handlers now live in this package, so the api tests — including the previously collateral-damage `api-tool-runtime.test.ts`/`api-tool-ssrf.test.ts` — are typechecked by the backend workspace itself.
- **Frontend** (`packages/frontend/tsconfig.json`): `@/*` → `./src/*` plus `@simple-harmonic/backend/*` → `../backend/src/*`; includes its `tests/`.
- **a2ax** (`packages/a2ax/tsconfig.json`): the only emitting config — `outDir: dist`, `declaration` + `declarationMap` + `sourceMap`, ES2022; excludes `tests/`.

## npm scripts

### Root (`package.json:8-25`)

| Script | Command | Notes |
|---|---|---|
| `dev` | `NODE_OPTIONS='--disable-warning=DEP0205' next dev` | dev server on :3000; suppresses one deprecation warning |
| `dev:backend` | `tsx packages/backend/src/server/standalone/main.ts` | **new in PR #13**: Next-free backend host (node:http) on :3001 (`SH_BACKEND_PORT`/`PORT` override); loads Apollo secrets and runs an in-process 10s tick loop (`SH_TICK_LOOP=0` disables); must run from the repo root |
| `data:init` | `tsx packages/backend/src/server/standalone/setup-db-cli.ts` | **renamed from `db:setup` in PR #16** (same `setup-db-cli.ts` entry, `package.json:11`): headless file-store bootstrap — calls the same idempotent setup-db handler as the Settings → Database button, which now just `ensureDataDir()`s the `teams/` + `system/` skeleton; `npm run data:init -- /path/to/dir` also persists a custom `dataDir` to `simple-harmonic.config.json` |
| `build` | `next build` | |
| `start` | `next start` | |
| `lint` | `biome check --write .` | **fixing** run (despite the name) |
| `format` | `biome format --write .` | |
| `check` | `biome check .` | read-only lint+format check; what CI runs |
| `test` | `vitest run` | all three projects via root `vitest.config.ts` |
| `test:watch` | `vitest` | |
| `test:backend` | `cd packages/backend && npx vitest run` | single project |
| `test:frontend` | `cd packages/frontend && npx vitest run` | single project |
| `test:e2e` | `playwright test` | |
| `typecheck` | `npm run typecheck --workspaces --if-present` | runs the three package typechecks; does **not** typecheck the root app |
| `typecheck:app` | `tsc --noEmit` | root app only since PR #13 (root `exclude` now skips `packages/` and `.claude/`); not run in CI |
| `prepare` | `husky` | installs git hooks on `npm install` |

Both the standalone-host scripts (`dev:backend`, `data:init`) run through `tsx` (root devDependency `tsx ^4.19.0`, `package.json:62`). On main `package.json` is clean.

### Packages

| Package | Scripts |
|---|---|
| backend (`packages/backend/package.json:9-13`) | `test` = `vitest run`, `test:watch`, `typecheck` = `tsc --noEmit` |
| frontend (`packages/frontend/package.json:9-13`) | same trio |
| a2ax (`packages/a2ax/package.json:26-32`) | `build` = `tsc`, `test`/`test:watch`, `lint` = `biome check src/` (declares its own `@biomejs/biome ^1.9.0` devDep — older major than the root's ^2.4.15; this lint script is not run in CI), `typecheck` = `tsc --noEmit` |

No `engines` field anywhere; CI pins Node 22 (see below) while root devDeps declare `@types/node ^20`.

## Test architecture

### Vitest workspace

The root `vitest.config.ts:4-10` declares three projects by directory: `packages/a2ax`, `packages/backend`, `packages/frontend`. `npm test` at the root runs all three. There is no global setup file and **no coverage configuration** in any of the four vitest configs — `@vitest/coverage-v8` is installed at the root (`package.json:56`) but nothing invokes it. (Test-store isolation is registered per file via the `useTempStore()` helper's `beforeEach`/`afterEach`, not a shared setup file — see "How route handlers are tested" below.)

| Project | Config | Environment | Include | Aliases |
|---|---|---|---|---|
| a2ax | `packages/a2ax/vitest.config.ts` | node | `tests/**/*.test.ts` | none (tests import `../src` directly, so they run against source, not the committed dist) |
| backend | `packages/backend/vitest.config.ts` | node (`:15`) | `tests/**/*.test.ts` | `@/` → backend `src`, plus `@simple-harmonic/backend/` and `@simple-harmonic/frontend/` → respective `src` dirs (`packages/backend/vitest.config.ts:5-11`). PR #13 **removed** the `@/app/` → repo-root `src/app` alias the route tests used to need |
| frontend | `packages/frontend/vitest.config.ts` | jsdom (`:17`), with `@vitejs/plugin-react` | `tests/**/*.test.ts` + `.test.tsx` | `@/` → frontend `src`, `@simple-harmonic/backend/` → backend `src` |

### Test inventory (60 vitest files + 2 Playwright specs)

PR #16 deleted two backend tests along with the Postgres stack — `db.test.ts` (the `db()` pg.Pool singleton) and `schema-sync.test.ts` (the drizzle↔SQL parity guard) — dropping the backend `tests/unit/` count from 59 to 57 and the vitest total from 62 to 60. The `tests/helpers/store.ts` helper added by PR #16 is shared infrastructure, not a test file, so it is not counted.

| Area | Files | What it covers |
|---|---|---|
| backend `tests/unit/` — route handlers | 19 (`api-agent`, `api-agent-hub`, `api-approvals`, `api-chat`, `api-codex-login`, `api-conversations`, `api-login`, `api-messages`, `api-narration`, `api-seed`, `api-settings`, `api-setup-db`, `api-spawn`, `api-tasks`, `api-team`, `api-test-db`, `api-test-llm`, `api-tick`, `api-trace` (new, PR #12)) | the extracted HTTP handlers in `packages/backend/src/server/api/**`, imported in-package via `@/server/api/...` (the Next routes are thin re-exports of the same functions); 14 of the 19 now seed/assert against a real temp file store via `useTempStore()` |
| backend `tests/unit/` — library + server modules | 36 (incl. `runner`, `runner-resume`, `registry`, `planner`, `tools`, `contract`, `custom-tools`, `connectors`, `spend`, `team-tree`, `operator-auth`, `proxy-fetch`, `run-subprocess`, `coding-config`, `coding-env`, `codex-adapter`, `codex-auth`, `anthropic-adapter`, `apollo`, `approval`, `a2ax`, `api-tool-runtime`, `api-tool-ssrf`, the 8 new from PR #12–#14 — see below — and `config` (now asserts `dataDir`/`hasDataDir`)) | the meta-agent library in `src/lib/meta-agent/` and server modules in `src/server/`. `db.test.ts` and `schema-sync.test.ts` were removed by PR #16 |
| backend `tests/unit/security/` | 2 (`tools-security`, `url-guard`) | tool sandboxing and URL/SSRF guards |
| frontend `tests/unit/` | 2 (`narration`, `utils`) | pure-TS lib code; no component (`.test.tsx`) tests exist yet despite jsdom + react plugin being configured |
| a2ax `tests/` | 1 (`protocol.test.ts`) | the A2AX protocol over `MemoryTransport` (direct messages, broadcast, groups, tasks) |
| `tests/e2e/` (Playwright) | 2 specs, 4 tests (1 skipped) | see below |

The eight test files new since PR #11 and still present, all in `packages/backend/tests/unit/`:

| File | Lines | PR | Covers |
|---|---|---|---|
| `runner-trace.test.ts` | 351 | #12 | exact trace-step sequences emitted by the runner (suspend/resume, malformed tool args, a throwing sink never breaks a tick) |
| `trace-sink.test.ts` | 217 | #12 | `createTraceSink` ordering/seq/tickId reuse, swallowed insert failures, PII scrub + truncation, prune throttling |
| `api-trace.test.ts` | 177 | #12 | the `GET /api/team/[id]/trace` SSE handler: headers, chronological history, `agentId`/`tickId` filters |
| `codex-app-server.test.ts` | 199 | #12 | the JSON-RPC transport to `codex app-server` (in-memory transport, no subprocess): correlation, per-thread routing, fail-closed declines, timeouts |
| `codex-harness.test.ts` | 365 | #12 | engine-mode ticks against a fake client: dynamicTools registration, destructive park/interrupt/suspension, resume approve/reject, token-usage summation |
| `standalone-routes.test.ts` | 109 | #13 | the route-manifest parity guard (see below) |
| `standalone-server.test.ts` | 123 | #13 | store-free smoke of the node:http host: operator gate, login cookie, 404/405/`Allow`, HEAD/OPTIONS, malformed-percent-encoding → 404 (its header comment still reads "DB-free"/"without PostgreSQL", `standalone-server.test.ts:8-9` — a stale pre-#16 wording for "no persistence touched") |
| `llm-cascade.test.ts` | 284 | #14 | `createCascadeLLM` fall-through/abort/observer behavior and `resolveLLMCandidates` provider ordering + OpenRouter model expansion |

Significantly changed: `api-tick.test.ts` is now 900 lines (down from the Postgres-era 1072 once the hand-rolled `mockDb` was dropped — see below), still carrying the play-by-play trace describe block (`api-tick.test.ts:676`, now asserting against the real `traceEvents` repo) and the codex app-server harness incl. legacy-suspension fallback (`:756`, `:877`); `spend.test.ts` adds vendor-namespace rate-strip and serving-model attribution tests (PR #14); `api-test-llm.test.ts` now asserts the cascade's primary-candidate probe and the new `provider` response field (PR #14). `config.test.ts` was reworked by PR #16 to assert `dataDir`/`hasDataDir` resolution (config-file > `SH_DATA_DIR` env > `<cwd>/.simple-harmonic/data` default) in place of the old `databaseUrl`/`hasDatabase` checks (`config.test.ts:48-50,113-121,252`).

(A would-be extra file, `packages/backend/tests/unit/skill-tree.test.ts`, exists only inside `stash@{0}` — see "Parked: the skills-directory migration" at the end of this chapter. The code it tests is not in the repo, so it is not part of the runnable inventory.)

### How route handlers are tested from the backend package

Two refactors shaped this. PR #13 moved route logic from root `src/app/api/**/route.ts` into the backend package (`packages/backend/src/server/api/**`), dissolving the old cross-package `@/app/` vitest alias and the typecheck split it forced. PR #16 then replaced the database with the synchronous JSON file store and, with it, the way the data layer is faked: there is **no more `mockDb`**. The store is fast local IO, so tests run against a *real* store in a throwaway temp directory — seed via repos, call the handler, assert on the response (and sometimes on the resulting files). Mechanism now, using `api-tick.test.ts` as the exemplar:

1. **Import path**: handlers are ordinary backend modules in `packages/backend/src/server/api/**` exporting Next-App-Router-signature functions (`GET`/`POST`/…, taking a web `Request` and returning a `Response`). Each test dynamically imports them through the standard in-package alias — `const { POST } = await import("@/server/api/tick")` (`packages/backend/tests/unit/api-tick.test.ts:176`) — then invokes them directly with a constructed `Request` and asserts on the `Response` (`res.status`, `await res.json()`). All 19 `api-*` route test files use `@/server/api/...` imports; zero `@/app/` imports remain. The Next routes under root `src/app/api/` are one-line re-exports and have no logic of their own to test.
2. **Real file store in a temp dir (the PR #16 change)**: the test calls `useTempStore()` inside the `describe` (`api-tick.test.ts:173`). That helper (`packages/backend/tests/helpers/store.ts`) registers a `beforeEach` that `mkdtempSync`es a fresh `sh-store-*` dir under the OS tmpdir, points the store at it with `setDataDir(dir)`, then `resetStore()` + `resetA2AXForTests()` to drop any cached state; its `afterEach` `rmSync`es the dir and resets back to defaults. So each case gets an isolated, empty data directory. Tests then **seed real rows through the repos** — `teams.insert({...})`, `agents.insert(teamId, {...})` (`api-tick.test.ts:113,118`), imported straight from `@/server/store` (`:2`) — and read them back the same way (e.g. the play-by-play tests assert on `traceEvents.query({ teamId, ... })`). No drizzle fluent-API stub, no `drizzle-orm` mock, no column sentinels, no `{ _sql: "? + 1" }` increment-shape assertions; the handler exercises the genuine read-modify-write path against disk.
3. **Only the LLM-driven core is still mocked**: the data layer is real, but the expensive/non-deterministic boundary above it is stubbed — the meta-agent (`runAgent`, `approveAgentTick`, `vi.mock("@/lib/meta-agent")` at `api-tick.test.ts:15`), the codex harness (`runCodexAgentTick` + a *real* `isCodexThreadSuspension` discriminator, `:22`), the Anthropic/Codex/OpenAI adapter clients (`:36,43,47`), the tool registry's `isDestructive` classifier (`:58`), the a2ax singleton (`:72`), and `@/server/config` (whose `mockGetConfig` default return is `{ ..., model, databaseUrl: "" }` — a vestigial empty field the handler ignores, `:85-90`, with the `databaseUrl: ""` literal at `:89` — wired into the `vi.mock("@/server/config")` block at `:94`). Because handler and test resolve `@/...` and the relative spellings to the same absolute files, vitest's module-graph mock intercepts the handler's imports.
4. **Reset discipline**: a top-level `beforeEach` does `vi.clearAllMocks()` then `mockReset()` on each runner/harness mock to drain leftover `mockResolvedValueOnce` queues so test order can't matter (`api-tick.test.ts:150-154`); the store-level reset is the helper's responsibility (`useTempStore` re-creates the temp dir per case).

Most `api-*` route tests follow this shape: 14 of the 19 call `useTempStore()` and seed real data (`api-agent`, `api-agent-hub`, `api-approvals`, `api-conversations`, `api-messages`, `api-narration`, `api-seed`, `api-setup-db`, `api-spawn`, `api-tasks`, `api-team`, `api-test-db`, `api-tick`, `api-trace`). The conversations/tasks/agent-hub tests, which used to assert against the duplicate Drizzle a2ax schema, now drive the *real* `JsonFileTransport` via `getA2AX()` over the temp store (`api-conversations.test.ts:3-5`, `api-tasks.test.ts:3-5`, `api-agent-hub.test.ts:3-5`). The remaining five (`api-chat`, `api-codex-login`, `api-login`, `api-settings`, `api-test-llm`) don't touch the store and mock only their own collaborators. All these files are typechecked by the backend workspace (see TypeScript configuration above).

### The wrapper parity guard

What keeps the thin Next wrappers honest is `standalone-routes.test.ts` (PR #13): it walks the **real** `src/app/api` tree from inside the backend package, converts `[id]` segments to `:id` patterns, and asserts the sorted result is strictly equal to the standalone host's route manifest (30 entries, `packages/backend/src/server/standalone/routes.ts:63-94`). It further checks that every wrapper file matches the exact re-export shape, that each wrapper's exported method list equals its backend module's, and that no backend handler imports `"next"`. A route added to one surface but not the other — or a wrapper that grows logic — fails the suite. `standalone-server.test.ts` complements it by booting the actual node:http host on a random port and exercising the paths that don't touch persistence (operator gate, login cookie flow, 404/405 + `Allow`, HEAD/OPTIONS handling) — its header comment's "DB-free"/"without PostgreSQL" wording (`standalone-server.test.ts:8-9`) is pre-#16 phrasing that now just means "no store access required."

### Playwright e2e

`playwright.config.ts`: `testDir: tests/e2e`, fully parallel, `forbidOnly` and 2 retries in CI (`:6-7`), HTML reporter, `baseURL: http://localhost:3000` (`:10`), trace on first retry, single `chromium` / Desktop Chrome project (`:13-18`). The `webServer` block (`:19-23`) launches `npm run dev` and reuses an already-running server outside CI — so e2e needs a working dev environment (and a seeded data dir for anything beyond the current assertions).

- `tests/e2e/onboarding.spec.ts` — 2 tests against `/new`: (1) greeting text ("meta-agent", "chief of staff") is visible, the textarea accepts input, a submitted message appears, and the UI transitions to either "thinking..." or "connection error" (deliberately tolerant of a missing API key, `onboarding.spec.ts:26-29`); (2) page chrome: "Simple Harmonic" wordmark, "new team" label, and the exact textarea placeholder.
- `tests/e2e/team-pause.spec.ts` — 1 runnable test: an unknown team UUID at `/f/<uuid>` stays in the "loading team" state without crashing (the only truthful no-state assertion, per the in-file comment at `:2-11`); plus 1 `test.skip` contract test (`:25-46`) spelling out the full pause/resume flow against `data-testid="pause-toggle"` / `"paused-indicator"` / `"narration-feed"`, to be enabled once a seeded team exists (the in-file comment still says this "requires a database" — pre-#16 wording; with the file store it means a seeded data dir + a `/api/spawn` planner call or mocked-planner path).

## Lint and format

`biome.json` (schema 2.4.15):

- Linter: `recommended: true`; `correctness.noUnusedImports` and `noUnusedVariables` downgraded to `warn` (`biome.json:7-10`); `style.noNonNullAssertion` off (`:11-13`).
- Formatter: spaces, indent 2, line width 100 (`:16-21`); JS: double quotes, semicolons always (`:22-27`).
- CSS: linter and formatter disabled, cssModules off (`:28-38`).
- Assist: `organizeImports: on` (`:39-45`).
- **Scope**: `files.includes` is `["src/**/*.ts", "src/**/*.tsx"]` (`:46-48`) — Biome only ever checks the root app's `src/`. The `packages/` tree, `scripts/`, and `tests/e2e/` are entirely outside Biome's coverage. (`packages/a2ax` carries its own un-CI'd `lint` script with an older Biome major.)
- Local gotcha: gitignored worktree checkouts under `.claude/worktrees/*` each carry their own `biome.json`; when present, a root `biome check .` can fail with a "nested root configuration" error even though the repo config is fine. Currently moot — the five worktrees that used to trigger it were swept into `stash@{0}` on 2026-06-11, and no `biome.json` remains anywhere under `.claude/`.

**Hooks**: `.husky/pre-commit:1` runs `npx lint-staged`; the lint-staged config (`package.json:26-28`) runs `biome check --write --no-errors-on-unmatched` on staged `*.{ts,tsx,js,mjs,cjs,json,jsonc,css}`. Combined with `files.includes`, staged files outside root `src/` are "unmatched" and silently pass — the hook effectively only lints/fixes root app source. Hooks are installed by the `prepare` script (`package.json:24`). Note that the handler modules extracted by PR #13 moved route logic *out* of Biome's scope entirely: it used to be linted as root `src/app/api/**`, and `packages/` is outside `files.includes`.

## CI — GitHub Actions

One workflow: `.github/workflows/ci.yml` (the only file under `.github/`). Triggers: push to `main` and every pull request (`ci.yml:12-15`). Concurrency group `ci-${{ github.ref }}` with cancel-in-progress (`ci.yml:17-19`). All jobs run on `ubuntu-latest` with `actions/setup-node@v4`, **Node 22**, npm cache, and `npm ci`.

| Job | Gate | Steps (after checkout/node/`npm ci`) |
|---|---|---|
| `lint (biome) — advisory` (`ci.yml:22-32`) | advisory | `npm run check` |
| `typecheck` (`ci.yml:34-48`) | required | matrix over `[a2ax, backend, frontend]`, `fail-fast: false`; `npm run typecheck -w @simple-harmonic/<pkg>` (3 parallel jobs; root app typecheck is not in CI) |
| `test (vitest x3)` (`ci.yml:50-60`) | required | `npm test` (all three vitest projects) |
| `e2e (playwright) — advisory` (`ci.yml:62-91`) | opt-in, skipped | gated on repo variable `ENABLE_E2E == 'true'` (`:67`); env `DATABASE_URL` + `ANTHROPIC_API_KEY` from secrets (`:70-71`) — the `DATABASE_URL` secret is now vestigial, a leftover the PR #16 rewrite did not strip from the workflow, since the app reads no database (the file store needs only a writable dir); caches `~/.cache/ms-playwright` keyed on `package-lock.json`; `npx playwright install --with-deps chromium`; `CI=true npx playwright test`; always uploads `playwright-report/` artifact, 7-day retention |

Required-vs-advisory is enforced in GitHub branch protection, not in the workflow — the header comment (`ci.yml:1-9`) documents the rollout: `test` + `typecheck` required from day one, `lint` and `e2e` advisory. That comment's parenthetical "~55 biome errors" predates commit `4701811` ("Clear biome lint debt so `npm run check` is green"), so the lint job is now green even while still labeled advisory.

The workflow file is byte-identical from `4701811` through `0ff84520` (PR #16 touched code, not CI), but PRs #12–#16 changed what the required jobs *cover*: the backend `typecheck` matrix job now also typechecks `api-*.test.ts` (the old tsconfig exclude is gone), and the `test` job runs the file-store-backed route tests plus the 8 new backend test files while no longer running the two PR #16-deleted DB tests. The root app typecheck (`typecheck:app`) is still not in CI, though it is now cheap and green since it stopped sweeping `packages/`.

## Seed system

### `scripts/seed-demo.ts` (run: `npx tsx scripts/seed-demo.ts`, `scripts/seed-demo.ts:11`)

Writes through the backend's JSON file store repos directly: it imports `agents`, `clearStore`, `teams` from `packages/backend/src/server/store/index.js` (`seed-demo.ts:14`), so it seeds whatever data dir the store resolves (default `.simple-harmonic/data`, or `SH_DATA_DIR`/config). PR #16 rewrote it from the old ten-table delete + drizzle inserts into store-repo calls; it is **destructive**, wiping the data dir with a single `clearStore()` (`seed-demo.ts:19-22`) instead of row-by-row table deletes. Then it creates:

- **Teams** (`seed-demo.ts:24-34`): root team "Harmonic Labs" (cofounder "Harmon") via `teams.insert`, with two sub-teams, "Engineering" and "Growth" (`parentTeamId` → root) — exercising recursive teams (each becomes a nested `teams/<id>/teams/<subId>/` directory on disk).
- **Engineering agents** (`seed-demo.ts:38-154`): `eng-lead` (a lead agent: tools include `spawn_sub_team` + `modify_agent`, 300s schedule), `bug-hunter` (600s), `test-runner` (600s), `docs-writer` (1800s), batched in via `agents.insertMany(engTeam.id, …)` (`:139`). Every agent has a JSON Schema `outputContract` and a staggered `nextRunAt` (`now + schedule + i*2s`, `:149`).
- **Growth agents** (`seed-demo.ts:156-227`): `content-scheduler` (600s) and `research-scout` (1800s), both with contracts, also via `agents.insertMany` (`:212`). Total: 6 agents, all contracted, 1 lead.
- **Custom skill** (`seed-demo.ts:229-241`): `saveCustomToolFile` writes a flat-JSON API tool to `.simple-harmonic/skills/httpbin_api.json` (baseUrl, `connectorKey: HTTPBIN_TOKEN`, allowed methods, custom auth header) — the flat-file skill format documented at `packages/backend/src/server/custom-tools.ts:1-19`, which is the live (and only) skill format. (This config tree under `.simple-harmonic/` is separate from the runtime store under `.simple-harmonic/data/`.)
- **Connector** (`seed-demo.ts:243-248`): `saveConnector` writes `.simple-harmonic/connectors/GITHUB_TOKEN.json` metadata and stores the secret value (`process.env.GITHUB_TOKEN` or a placeholder) — secrets resolve from gitignored `.simple-harmonic/secrets.json`, then env (`packages/backend/src/server/connectors.ts:4-8`).
- Finally it reads everything back through `teams.all()`/`agents.all()` and prints a summary tree of teams/agents/contracts/leads (`seed-demo.ts:250-275`), then exits.

### The seed endpoint (related but distinct)

`POST /api/seed` — since PR #13 the logic lives in `packages/backend/src/server/api/seed.ts` (513 lines) and `src/app/api/seed/route.ts` is a thin re-export. It seeds a *different*, presentation-oriented mock: a single paused team "Simple Harmonic v0.0 Launch" with four agents (Scout/Relay/Chisel/Pulse), 32 scripted a2ax messages (agent↔agent, cofounder↔agent via sentinel `COFOUNDER_AGENT_ID`, and human-in-the-loop via `USER_AGENT_ID`; the response still reports a stale hard-coded `messageCount: 27`, `seed.ts:510`) routed through the `JsonFileTransport`, and 9 a2ax tasks in various states. Unlike the script it is non-destructive — it returns 409 if the team already exists (`seed.ts:57-58`) — and it creates no skills/connectors. It is itself unit-tested by `packages/backend/tests/unit/api-seed.test.ts` (which now drives the real store + transport via `useTempStore()`).

## Schema and drift guards (removed in PR #16)

There is no schema to keep in sync. PR #16 deleted the database entirely, and with it the whole drift-guard apparatus: there is no drizzle schema, no `SCHEMA_SQL` DDL in the setup-db handler, and no live catalog to diff against. The single source of truth for row shapes is now `packages/backend/src/server/store/types.ts` — plain TypeScript interfaces (`Team`, `Agent`, `PendingApproval`, `ActionLogEntry`, `AppEvent`, `PlatformStatus`, `AgentTraceEvent`, `LlmSpendEntry`) plus the status unions and `ApiToolConfig`, all moved here from the deleted `schema.ts`. Field names, optionality, and `Date`-vs-`string` typing match the old Postgres rows exactly, which is why API responses and call sites were unchanged by the cutover. JSON objects are written/parsed with `serialize.ts`'s `reviveDates` turning declared top-level ISO-string keys back into `Date` (`serialize.ts:13`) — there is no DDL anywhere for a guard to compare against.

PR #16 therefore **removed both guards** that PR #12/#15 had built:

- **`schema-sync.test.ts`** (the 270-line bidirectional drizzle↔SQL parity guard) is gone — there are no longer two copies of a schema to reconcile.
- **`scripts/db-code-diff.py`** (the live-Postgres-catalog vs setup-db-SQL diff tool, repointed by PR #15) is **deleted**; `scripts/` now contains only `seed-demo.ts`.

The historical context: through PR #15 the project ran no migrations and instead kept a drizzle schema and an idempotent `SCHEMA_SQL` hand-synced by `schema-sync.test.ts`, with `db-code-diff.py` as a manual live-DB drift check. The JSON file store removes the entire problem — adding a field now means editing one interface in `types.ts` (and the repo that reads/writes it).

## Build and deploy chain

- `npm run build` → `next build` compiles the root app, including backend/frontend package source through the tsconfig paths/workspace symlinks; `a2ax` is consumed prebuilt from its committed `dist/`.
- `vercel.json` contains **only** a cron: `/api/tick` on `* * * * *` (every minute) (`vercel.json:2-7`). No build overrides, regions, or rewrites. The tick handler authenticates platform cron via the `x-vercel-cron` header — trusted **only when `process.env.VERCEL` is set** (`packages/backend/src/server/operator-auth.ts:83`; on the standalone host the header would be client-spoofable) — or a `CRON_SECRET` bearer token (documented in `.env.example:40-44`). **Caveat (PR #16):** the JSON file store is single-writer and needs a persistent, shared filesystem, which Vercel's ephemeral serverless functions do not provide; the rewritten README spells this out (`README.md:64-68`) and points production at the standalone backend host on a persistent box instead. The `vercel.json` cron remains in the tree but is no longer the recommended production path.
- `next.config.ts` is tooling-trivial: it only sets `devIndicators: false` (`next.config.ts:7`) to hide the dev-tools floating button.
- The Next-free run mode (PR #13) is now the production-shaped one: `npm run dev:backend` boots a node:http host (`packages/backend/src/server/standalone/`) serving the identical `/api/*` surface on :3001 with its own in-process 10s tick loop. Because it is a single long-lived process owning one data dir, it satisfies the file store's single-writer requirement directly. See `06-http-api.md` for the route surface.

## Local/dev configuration files

- `.claude/launch.json` (tracked): one launch configuration named `dev` running `npm run dev`, port 3000, `autoPort: false` — used by Claude Code's app-launch tooling.
- `.vscode/launch.json` (**untracked**, part of the current working-tree deltas): one VS Code debug configuration, "Backend: debug standalone" — `node --import tsx` on `packages/backend/src/server/standalone/main.ts` with `SH_TICK_LOOP=0` and `envFile: .env`.
- `simple-harmonic.config.json` (repo root, gitignored — `.gitignore:43`): optional runtime app config read by `getConfig()` when it exists (`packages/backend/src/server/config.ts:41-42`, path at `config.ts:22`). It now carries `model` and (since PR #16) `dataDir` instead of `databaseUrl`; config-file values win over env (`SH_DATA_DIR`) which win over the `<cwd>/.simple-harmonic/data` default (`config.ts:76-77`). Resolution precedence on the live tree: the model is `file.model || OPENAI_MODEL || DEFAULTS.model`, whose committed default is `o4-mini` (`config.ts:33`). `npm run data:init -- <dir>` recreates/updates the file by persisting `dataDir` to it (the setup-db handler calls `setConfig`, which `writeFileSync`s the merged config, `config.ts:95`).
- `.env.example` (tracked, **rewritten by PR #16**): no longer documents `DATABASE_URL` — it now opens with the optional `SH_DATA_DIR` (default `.simple-harmonic/data`) and states explicitly "no database server required" (`.env.example:5-7`). Otherwise it documents the LLM **cascade order Codex CLI > Anthropic > OpenRouter > OpenAI** (`:9-10`) with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODELS`, and `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` labeled "final fallback"; `OPERATOR_PASSWORD` (operator gate, fails closed in prod); `CRON_SECRET`; `SH_DAILY_SPEND_CAP_CENTS` (default 5000 = $50/day); and the agent-tools switches `SH_ENABLE_TOOLS`, `SH_TOOLS_CWD`, `SH_AGENT_TIMEOUT_MS` (default 120000ms, exercised by `api-tick.test.ts:505,627`), `GITHUB_TOKEN`.
- Env vars the code reads but `.env.example` does **not** document: `OPENROUTER_BASE_URL` (endpoint override, `packages/backend/src/server/llm.ts:71`), the standalone-host trio `SH_BACKEND_PORT`/`PORT`/`SH_TICK_LOOP` (`packages/backend/src/server/standalone/main.ts:25,43`), `SH_CODEX_RUNTIME=exec` (engine-mode opt-out, `packages/backend/src/server/api/tick.ts:164`), `SH_TRACE_RETENTION_DAYS` (trace retention, default 14 days, `packages/backend/src/server/trace.ts:157`), and `CODEX_HOME`/`RUST_LOG` for the codex app-server subprocess.
- `.gitignore` now ignores the runtime file store at `**/.simple-harmonic/data/` (`.gitignore:47`, added by PR #16 — runtime team/agent/message state, including a2ax tokens) alongside `.simple-harmonic/secrets.json` (`:44`) and `.simple-harmonic/codex-home/` (`:49`, the isolated `CODEX_HOME` for app-server agents, which holds a copy of the user's codex OAuth tokens).

## README drift

PR #16 rewrote `README.md` (138 lines) to describe the JSON file store; this section re-checks it against the code at `0ff84520`.

**Fixed by PR #16 (the database is gone from the README too):**

1. **No more Postgres bootstrap.** The quick start now says "no database required" (`README.md:53`) and the data-dir init block uses `npm run data:init` / `npm run data:init -- /path/to/dir` (`README.md:59-62`), matching the renamed script (`package.json:11`) and the persist-`dataDir`-to-config behavior of `setup-db-cli.ts`. The old `npm run db:setup -- postgresql://...` lines are gone.
2. **Single-writer caveat is documented.** A callout (`README.md:64-68`) states the file store assumes one process owns the data dir, that running `npm run dev` and `npm run dev:backend` against the same dir simultaneously is unsupported, and that it is not Vercel-compatible (ephemeral filesystem) — run the standalone host on a persistent box. This matches the store's concurrency model and the deploy caveat above.
3. **Stack + state split rewritten.** The Stack section now lists "JSON file store (no database) — domain-aggregate tree under `.simple-harmonic/data/`" (`README.md:127`), and the new "State split" paragraph (`README.md:121`) correctly describes the team-folder-contains-its-agents-and-sub-teams layout and "No database." The Architecture tree's "State split" prose matches `store/data-dir.ts`'s on-disk layout.

**Still stale or wrong:**

4. **`drizzle/` "SQL migrations" directory is still listed but does not exist** (`README.md:115`). The architecture tree's `drizzle/  # SQL migrations` line is a leftover the rewrite missed — there are no migrations and no `drizzle/` directory; persistence is the file store.
5. **"14 tools" is undercounted** (`README.md:17`). The registry holds 12 app tools, registered in `packages/backend/src/server/tools/index.ts:48-59` (`read_file`, `write_file`, `run_command`, `coding_task`, `http_fetch`, `github_api`, `set_team_goal`, `spawn_sub_team`, `modify_agent`, `modify_team`, `action_history`, `observe_app`), and 3 internal tools in `src/lib/meta-agent/default-tools.ts:51,84,107` (`send_message`, `broadcast`, `report_action`) — 15 built-ins, a count pinned by `packages/backend/tests/unit/server-tools.test.ts:400` (`toHaveLength(15)`); the README's table lists 14, omitting `observe_app`. Unchanged by PR #16.
6. **Status section is stale** (`README.md:134`): "v0.0. Ship target 2026-06-01. … 582 tests passing" — the date has passed and `package.json:3` says `0.1.0`. The "582 tests" count is unverifiable from config (tests were not run for this doc); the current inventory is 60 vitest files + 2 Playwright specs. Unchanged by PR #16.

**Accurate:**

7. "Custom API tools live as flat JSON files in `.simple-harmonic/`" (`README.md:42`) and `skills/  # Custom API tool definitions (JSON)` (`README.md:113`) correctly describe `custom-tools.ts:1-19` — flat JSON is the live (and only) skill format. (Note these config files sit beside, not inside, the runtime `.simple-harmonic/data/` store.)
8. The "Backend without the frontend" section (`README.md:75-88`) still checks out: `npm run dev:backend` on port 3001 (`SH_BACKEND_PORT`), Apollo secrets, the operator gate, the 10s tick loop with `SH_TICK_LOOP=0` opt-out + `CRON_SECRET`, the repo-root cwd requirement, and "a parity test keeps the two surfaces in sync" (`standalone-routes.test.ts`).
9. Other accurate claims: the quick start (`npm install`, `cp .env.example .env.local`, `npm run dev`) matches existing scripts and files; `npx tsx scripts/seed-demo.ts` is correct (`README.md:72`); "Vitest + Playwright + Biome" matches the configs.

## Repo state (factual snapshot, 2026-06-13)

Main is now at `0ff84520`, with 8 commits. The local checkout this doc lives in is **behind** main at `9f301cc` (the Postgres world, pre-#16) and has not yet pulled PR #16:

| Commit | What |
|---|---|
| `61eaf9e` | initial commit |
| `aa9e03b` | PR #10 — sidebar team-tree fixes + Next 16 middleware→proxy rename |
| `4701811` | PR #11 — biome lint debt cleared so `npm run check` is green |
| `1848b6c` | PR #12 — engine-mode codex runtime, play-by-play agent traces, schema parity guard |
| `a035e7e` | PR #13 — standalone backend host: route handlers extracted to `packages/backend/src/server/api/**`, node:http host, `dev:backend`/`db:setup` scripts, README rewrite |
| `bff4b16` | PR #14 — OpenRouter provider and cascade fallback across LLM providers |
| `9f301cc` | PR #15 — `db-code-diff.py` repointed at the relocated setup-db SQL, empty parse made fatal *(← the stale local checkout sits here)* |
| `0ff84520` | PR #16 — **replace PostgreSQL/Drizzle with a JSON file store** (`packages/backend/src/server/store/`); deletes `db/`, `SCHEMA_SQL`, `db.test.ts`, `schema-sync.test.ts`, `scripts/db-code-diff.py`; renames `db:setup`→`data:init`; a2ax `JsonFileTransport`; README + `.env.example` rewrite *(← main)* |

**The stale local checkout (where `docs/` lives):** it is at `9f301cc`, two facts behind main — it still has the Postgres tree on disk and has *not* pulled PR #16. Its working-tree deltas vs `9f301cc`: two modified tracked files — `packages/backend/src/server/config.ts` (`DEFAULTS.model` changed `"o4-mini"`→`"gpt-5.5"`, plus formatting-only rewraps) and `packages/frontend/src/components/chat/use-chat.ts` — plus untracked `docs/` (this documentation set), `TODO.md`, and `.vscode/` (a standalone-backend debug launch config). **Once this checkout pulls main, Postgres is gone** and everything this chapter describes (the file store, `data:init`, no schema guards) becomes the on-disk reality; the local `config.ts` model edit (`gpt-5.5`) would then need re-applying on top of `0ff84520` (whose committed default is `o4-mini`, `config.ts:33`).

**`stash@{0}`** ("WIP on main: 9f301cc", created 2026-06-11 ~14:29) holds **only untracked and gitignored files** swept off the working tree — no tracked-file changes. Its notable contents: the `docs/` tree (since restored to disk), the `.simple-harmonic/skills/create-skill/` and `.simple-harmonic/skills/create_agent/` SKILL.md trees — the only repo-root `.simple-harmonic/` paths in the stash — plus `packages/backend/tests/unit/skill-tree.test.ts` and `simple-harmonic.config.json` (those last three still absent from disk; on-disk `.simple-harmonic/` holds only `connectors/` and `skills/httpbin_api.json`). The gitignored artifacts in the stash vary in disk status: `.next/`, `next-env.d.ts`, and `tsconfig.tsbuildinfo` are gone from disk; `.husky/_/` was swept too but is back on disk — regenerated at 15:02 the same day (after the stash) by husky's `prepare` script on a later `npm install`; and of the five `.claude/worktrees/*` checkouts, four are fully gone while a residue of `musing-buck-84f5b6` remains — its gitignored `.simple-harmonic/codex-home/.tmp/plugins/` directory holds a nested git repository, which `git stash` skips. That worktree copy is also the only `codex-home` anywhere in the stash; no repo-root `.simple-harmonic/codex-home/` exists in the stash or on disk. The residue carries no `biome.json`, so the nested-root gotcha stays moot as noted under "Lint and format".

### Parked: the skills-directory migration (stash@{0})

Through 2026-06-10 the local working tree carried an uncommitted "skills directory" migration: directory-based skills (`.simple-harmonic/skills/<name>/SKILL.md` with YAML frontmatter and markdown playbooks) replacing the flat JSON files, a sub-skill tree in the registry, progressive disclosure in the runner (per-tick `openSkills` plus a 16th built-in tool, `close_skills`), and (in its Postgres-era form) an `agents.open_skills` column. On 2026-06-11 the user updated main and discarded that code — it exists **nowhere in the repo**: not at `9f301cc`, not at `0ff84520`, not in any working tree, not on any branch. Only its untracked data files survive, parked in the local checkout's `stash@{0}`: the `create-skill/` and `create_agent/` SKILL.md trees and the never-committed `skill-tree.test.ts`.

This is independent of PR #16 (the file-store cutover did not touch the registry, runner, or tool set). On main the live behavior is still the pre-migration one this chapter describes: `custom-tools.ts` loads flat `.simple-harmonic/skills/<name>.json` files (`packages/backend/src/server/custom-tools.ts:1-19`), the registry has no skill tree, the runner has no progressive disclosure, and the built-in tool count is 15 (`server-tools.test.ts:400`).

## Python backend (FastAPI port)

The parallel Python re-implementation under `backend-py/` (an idiomatic FastAPI port of `packages/backend` + `packages/a2ax`, completed 2026-06-14) has its own self-contained tooling and test surface that *contrasts* sharply with the vitest/biome/npm-workspaces apparatus above while reaching the same coverage shape. It speaks the identical HTTP/WS contract, so it is a peer runtime, not a replacement — both share the on-disk `.simple-harmonic/data/` store. The port's stack decision, the load-bearing-behavior risk register, and the deferred items are recorded in `backend-py/ARCHITECTURE.md` and `backend-py/MIGRATION.md`; this section maps **this chapter's subsystem — testing, lint, project config — to the Python equivalent** and is the testing-and-tooling counterpart to the per-chapter "Python backend" sections elsewhere in the report.

### Project & tooling config — `pyproject.toml` (vs `package.json` + four `tsconfig.json` + `biome.json` + `vitest.config.ts`)

Where the TS side spreads its toolchain across a root `package.json`, three workspace manifests, four `tsconfig.json` files, a `biome.json`, and four vitest configs, the Python port collapses **everything into one `backend-py/pyproject.toml`** plus a one-line `backend-py/.python-version` (`3.14`) and a committed `backend-py/uv.lock` (the analogue of `package-lock.json`).

- **Package manager: `uv`** (replaces npm). `requires-python = ">=3.14"` (`pyproject.toml:6`). Runtime deps are a single `[project].dependencies` array (`pyproject.toml:7-18`): `fastapi`, `uvicorn[standard]`, `pydantic` + `pydantic-settings`, `httpx`, the `anthropic` and `openai` async SDKs, `websockets`, `anyio`, and `cryptography`. Dev tooling is a **PEP 735 dependency group** `[dependency-groups].dev` (`pyproject.toml:21-26`) holding exactly three tools — `pytest>=8.3`, `pytest-asyncio>=0.25`, `ruff>=0.8` — which `uv sync` installs by default. There is no `engines`-style version sprawl and no `devDependencies`/`dependencies` split across packages: it is a flat single project, not a workspace graph, because the port is one package (`simple_harmonic`, the wheel target at `pyproject.toml:32-33`) rather than the root-app + three-slice monorepo the TS side maintains.
- **Test runner: pytest + pytest-asyncio** (replaces vitest's three-project workspace). Config is `[tool.pytest.ini_options]` (`pyproject.toml:35-38`): `testpaths = ["tests"]`, `addopts = "-q"`, and crucially **`asyncio_mode = "auto"`** — so a bare `async def test_*` runs as a coroutine test with no `@pytest.mark.asyncio` decorator (the comment at `tests/test_runner.py:38` notes this). This is the idiomatic counterpart to vitest awaiting async test bodies natively. Like the TS side (which installs `@vitest/coverage-v8` but invokes nothing), the Python config declares **no coverage tooling** — coverage is uninstrumented on both runtimes.
- **Lint/format: ruff** (replaces Biome). `[tool.ruff]` (`pyproject.toml:40-43`) pins `line-length = 100` (matching `biome.json`'s width-100) and, notably, **`target-version = "py314"`** — ruff lints against 3.14 syntax. `[tool.ruff.lint]` selects `E,F,I,UP,B,SIM,RUF` (`pyproject.toml:47`) — pycodestyle/pyflakes, import-sorting (the `organizeImports`-on analogue), pyupgrade, bugbear, simplify, ruff-native — and ignores exactly one rule, `N815` (`pyproject.toml:48-51`), so the Pydantic models may keep **camelCase field names** to match the TS JSON wire shape (the same wire-compat rule the port enforces everywhere). Unlike Biome — which is scoped to root `src/` only and silently skips `packages/` — ruff's `src = ["simple_harmonic", "tests"]` (`pyproject.toml:43`) covers *both* the package and its tests; there is no out-of-scope blind spot.

The day-to-day commands are correspondingly two-line, run from `backend-py/` (per `backend-py/README.md` and `backend-py/MIGRATION.md:74-82`):

| Concern | TS (this chapter) | Python port |
|---|---|---|
| Install deps | `npm ci` | `uv sync` |
| Run tests | `npm test` (vitest ×3) | **`uv run --no-sync pytest`** (834 tests, fully offline) |
| Lint/format check | `npm run check` (`biome check .`) | **`uv run ruff check`** |
| Boot the service | `npm run dev:backend` (tsx → node:http :3001) | `uv run uvicorn simple_harmonic.app:app --port 3001` |

The `--no-sync` flag tells `uv run` to use the already-resolved environment instead of re-resolving `uv.lock` on every invocation — the fast inner-loop form. As of the port's completion the suite is **834 passing, ruff clean** (`backend-py/MIGRATION.md:26`), verified here.

### Test architecture — 37 files, fully offline, ASGITransport + scripted doubles

The port keeps the TS test inventory's *coverage map* but reorganizes it. Instead of 60 vitest files split across three project directories, there are **37 `tests/test_*.py` files in a single flat `backend-py/tests/` directory** (no per-package vitest projects, because there is no package graph). Most carry a header docstring naming the exact TS test they port — e.g. `backend-py/tests/test_proxy_fetch.py:3` cites `packages/backend/tests/unit/proxy-fetch.test.ts`, `backend-py/tests/test_runner.py:3-6` cites `runner.test.ts` + `runner-resume.test.ts` + `runner-trace.test.ts`, and `backend-py/tests/test_tools_security.py:3` cites `security/tools-security.test.ts` — making the parity with this chapter's inventory auditable file-by-file.

The same discipline this chapter describes for the vitest route tests applies, translated to Python idiom:

- **In-process ASGI, no sockets** (the `useTempStore()` + constructed-`Request` analogue). `backend-py/tests/conftest.py` builds the app over an isolated store and drives it through **httpx `ASGITransport`** (`conftest.py:69-77`): the `client` fixture wraps the FastAPI app in `ASGITransport`, enters the app's lifespan (`app.router.lifespan_context(app)`) so `store.ensure()` runs, and yields an `AsyncClient` — "no sockets, fully offline" (`conftest.py:70`). This is the structural twin of the TS tests importing the handler and invoking it with a web `Request`: both exercise the real handler stack without a live server.
- **Real file store in a temp dir** (the PR #16 "no more `mockDb`" change, preserved). The `data_dir` fixture (`conftest.py:29-43`) points the store at `tmp_path/"data"` via `dd.set_data_dir(root)` and brackets each test with `invalidate_index()` — the exact analogue of `useTempStore()`'s `mkdtempSync` + `setDataDir` + `resetStore` + per-case teardown. The `app` fixture (`conftest.py:58-65`) builds `create_app(store=RepoStore(), start_tick_loop=False)` over that dir and calls `reset_a2ax_for_tests()` (`backend-py/simple_harmonic/a2ax_singleton.py`) — the same "drop cached a2ax singleton state per test" move as the TS `resetA2AXForTests()`. Tests then seed *real* rows through the repos and assert against genuine read-modify-write, never a mocked data layer. **Crucially, `start_tick_loop=False`** keeps the background self-scheduling asyncio tick loop from self-driving `run_tick` during a test (`conftest.py:61,65`).
- **Only the LLM/codex/network boundary is faked** (data real, expensive/non-deterministic edge stubbed — identical philosophy to the TS `vi.mock("@/lib/meta-agent")` line). The mechanisms are Python-native:
  - **LLM:** a fake implementing the `LLMClient` Protocol replays scripted responses — `_RecordingLLM` in `backend-py/tests/test_runner.py:54-75` ("Mirrors the vitest `makeLLM` helper") and the fake-client doubles in `backend-py/tests/test_llm.py:30-34`. No `anthropic`/`openai` SDK call leaves the process.
  - **Codex:** `backend-py/tests/test_codex_adapter.py:8-12` documents three offline strategies — the exec one-shot path mocks `asyncio.create_subprocess_exec` (no real `codex` binary), the app-server path is driven by a **fake in-memory JSON-RPC transport** (scripted lines, the analogue of `codex-app-server.test.ts`'s in-memory transport), and the harness is fed a fake `CodexAppServerClient`.
  - **Anthropic SDK:** `backend-py/tests/test_anthropic_adapter.py:6-9` mocks `AsyncAnthropic` and returns a scripted `Message`-shaped object to assert the OpenAI↔Anthropic translation both directions.
  - **Network:** `backend-py/tests/test_proxy_fetch.py:5-8` replaces the httpx transport with `httpx.MockTransport` (no socket) and monkeypatches the macOS `scutil`/proxy-env lookup, asserting the pure `build_plan` directly.

  The TS side reaches for `vi.mock` module-graph interception and `vi.clearAllMocks()`; the Python side reaches for **dependency-injected Protocol doubles, `monkeypatch`, in-memory transports, and `pytest` fixtures** — the same isolation goal via idiomatic-Python means rather than a module mocker.

### Load-bearing fidelity behaviors this subsystem's tests pin

Because the port shares the wire contract and on-disk format, several risk-register items from `backend-py/ARCHITECTURE.md` are *proven by the test suite itself* — the tests are the regression guard for the traps:

- **Store-lock race-freeness** (risk #1). Node's single thread makes read-check-write atomic for free; asyncio does not, so every store read-modify-write holds an explicit `asyncio.Lock`. `backend-py/MIGRATION.md:15` records that the lock "is proven by a peak-concurrency==1 test that fails without it" — i.e. `backend-py/tests/test_store.py` includes a concurrency assertion that is the load-bearing replacement for Node's implicit atomicity. This is the single most important behavioral test in the port.
- **Apollo AES-256-GCM Node interop** (risk #16). Node lays out `[iv][tag][ciphertext]` with the tag fetched separately via `getAuthTag()`, while Python's `AESGCM` appends the tag to the ciphertext; the port re-lays the bytes. `backend-py/tests/test_apollo.py` (and `MIGRATION.md:17`'s "Node v26 interop proven … Node-interop golden vector") is the cross-runtime golden-vector guard — a vitest suite cannot prove this because it never decrypts Node-encrypted bytes from Python.
- **SSRF / private-IP ranges** (risks #8, #9). The test-pinned private ranges (0/8, 127/8, 10/8, CGNAT 100.64/10, link-local/metadata 169.254, 172.16-31, 192.168, 198.18/15, multicast/reserved) are replicated and asserted in `backend-py/tests/test_url_guard.py` and `backend-py/tests/test_tools_security.py`, porting `url-guard.test.ts` and `security/tools-security.test.ts`.
- **Shell-free `run_command` and the tool kill-switch** (risks #10, #11). `backend-py/tests/test_tools_shell.py` asserts `;`, `&&`, `|`, `$(...)`, backticks, `>` stay inert literal argv tokens (never `shell=True`), and `backend-py/tests/test_killswitch.py` asserts `write_file`/`run_command`/`coding_task`/mutating calls are blocked unless `SH_ENABLE_TOOLS ∈ {1,true,yes}` — the same sandbox guarantees the TS `tests/unit/security/` pair covers.
- **Cookie + cron wire-compat** (risks #21, #22). `backend-py/tests/test_gate.py` (porting the standalone host's `gate` fn + `operator-auth.ts`) and `backend-py/tests/test_settings_endpoints.py` assert the `sh_operator = sha256(OPERATOR_PASSWORD)` cookie round-trip and the `x-vercel-cron`/`CRON_SECRET` rules. The `operator_password` fixture (`conftest.py:46-55`) sets `OPERATOR_PASSWORD` and clears the cached `Settings` so the gate activates — the test-harness counterpart to the gate being live middleware.
- **Selective date revival, mixed-type id, JSON-string `toolArguments`** (risks #2, #3, #4). `backend-py/tests/test_store.py` and the endpoint tests (`backend-py/tests/test_core_endpoints.py`, `backend-py/tests/test_team_endpoints.py`) assert the byte-compatible row shapes — trailing-`Z` datetimes, `PlatformStatus.id == 1` as a literal int, and `toolArguments` staying a string — that keep the frontend unaffected when it points at either runtime.

### Known divergences relevant to testing

The deferred items in `backend-py/MIGRATION.md:31-49` that touch this chapter's concerns:

- **No e2e / Playwright equivalent.** The port has no browser-level suite — the TS `tests/e2e/` Playwright specs have no Python counterpart, since the frontend is shared and unchanged and is exercised against whichever backend is booted. All 37 Python test files are offline unit/integration tests.
- **No CI wiring in this chapter's GitHub Actions workflow.** The single `.github/workflows/ci.yml` (lint/typecheck×3/test/e2e on Node 22) does **not** run `uv run pytest` or `uv run ruff check`; the Python suite is run locally per `backend-py/MIGRATION.md`. The port is "an experiment and a slice-by-slice migration, not an in-place edit" (`backend-py/ARCHITECTURE.md:7-8`), so it is not yet a CI gate.
- **SSE teardown tested against finite sources.** `MIGRATION.md:48-49` notes the streaming endpoints (`chat`, `narration`, `trace`) use Python async-generator teardown (`GeneratorExit`) rather than the TS `ReadableStream.cancel()` callback; tests drive a *finite* source rather than asserting prod-style run-until-disconnect. Behavior is equivalent for the asserted cases.
- **Codex harness *resume* path unported.** A parked `codex-thread` tick resumes through the legacy runner via `AgentSuspension`; the load-bearing HOLD/resume/deny trichotomy IS fully ported and tested (`backend-py/tests/test_runner.py`, `backend-py/tests/test_tick.py`), but the harness-specific resume is deferred. This is a behavioral gap noted for follow-up, not a test-infrastructure one.

For the full stack-decision rationale, the complete fidelity risk register (23 items), and the slice-by-slice migration status (all 9 slices done), see `backend-py/ARCHITECTURE.md` and `backend-py/MIGRATION.md`.
