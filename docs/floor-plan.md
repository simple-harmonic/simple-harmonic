# Raise the Floor — engineering remediation plan

*Status: proposed (2026-06-05). Scope: technical only. Companion to `TODOS.md`.*

## The principle

A system behaves like its **weakest** surface, not its strongest. Reliability, security, and trust are all weakest-link properties — you don't get to average a great tick loop against a broken protocol layer. This codebase has a high ceiling (`runner.ts`, `tick/route.ts`, the sandbox primitives) and a low floor (`coding_task`, a2ax fan-out, no auth, broken `tsc`). **The goal here is not better peaks. It is killing the variance** — dragging every weak surface up to "boring and correct."

## The bar each surface must clear

A surface is "at floor" when:
1. It has no known correctness bug in its primary path.
2. Untrusted input (LLM output, web content, request bodies) can't escape its intended boundary.
3. It's covered by a test that actually asserts its behavior, and that test **runs in CI**.
4. The typecheck passes over it.

## Summary

| # | Item | Cat | Effort | Phase | Deps |
|---|------|-----|--------|-------|------|
| 1 | Green `tsc` (restore the type gate) | safety-net | S | 1 | — |
| 2 | Wire a2ax suite into the runner + fix mislabeled E2Es | safety-net | M | 1 | — |
| 3 | CI pipeline (the standing guard) | safety-net | M | 1 | 1, 2 |
| 4 | Connector-key traversal + Apollo salt | security | S | 2 | — |
| 5 | Operator auth gate + cron-secret + spend cap | security | M | 2 | — |
| 6 | Sandbox `coding_task` env + de-dup the 3 adapters | security | M | 3 | — |
| 7 | One SSRF-guarded egress chokepoint (DNS resolve-then-pin) | security | M | 3 | — |
| 8 | a2ax per-recipient reads + fleet-scoped discovery | correctness | M | 4 | — |
| 9 | FKs + cascades + one schema source of truth | data-integrity | L | 5 | — |
| 10 | Delete dead components, hoist helpers, planner DI | maintainability | M | 5 | — |

Rough effort: 2×S + 7×M + 1×L ≈ **10–11 focused days** (~2–2.5 weeks solo with context-switching). Items within a phase are independent and can be reordered; only CI (3) has hard deps.

**If you do one thing first:** items 1, 5's cron-secret, and 5's spend-cap. They're a day of work and they close the live cost-runaway + public-DoS exposure and restore the compiler. Everything else can follow.

---

## Phase 1 — Restore the safety nets

Do these first. They're cheap, and they make every later change safe: without them, the fixes below can silently regress.

### 1. Green `tsc` — restore the type gate  · S
`tsc --noEmit` currently emits 278 errors, so the compiler is not a safety net and real bugs hide (e.g. `codex-auth.ts` reads `unknown` unchecked). **Verified during scoping: 3 changes take it to exactly 0.**
- `packages/backend/tsconfig.json`: add `"skipLibCheck": true` (clears ~95 node_modules errors).
- Same file, `exclude`: add `"tests/unit/api-*.test.ts"` — those 18 files integration-test the repo-root Next routes (a different package); vitest still runs them, and the routes stay type-checked by the root tsconfig. Clears ~178 `TS2307`. Do **not** add an `@/app/*` path to the backend tsconfig (verified: it raises the count to 347).
- `codex-auth.ts:165`: narrow `const data = (await res.json()) as { access_token?: string; id_token?: string; refresh_token?: string }`. Clears the 5 real `TS18046`.
- **Acceptance:** `cd packages/backend && npx tsc --noEmit` exits 0. (Retires the `backend_typecheck_broken` memory note once landed.)

### 2. Wire the orphaned a2ax suite + fix the lying E2Es  · M
The a2ax protocol suite (15 tests) never runs — it's absent from the root vitest `projects`, and standalone `npm test` walks up to the root config and crashes. Two E2E tests assert nothing real (`team-pause.spec.ts` ends on a bare `waitForTimeout`, or only checks the word "Simple Harmonic").
- Add `packages/a2ax/vitest.config.ts` (`defineProject({ test: { name: 'a2ax', root: __dirname, include: ['tests/**/*.test.ts'] } })`) and add `"packages/a2ax"` to root `vitest.config.ts`. Bump a2ax's vitest `^3.2.0 → ^4.1.6` to match.
- Add `data-testid`s (`pause-toggle`, `paused-indicator`, `narration-sidebar`), seed a team via the existing `POST /api/teams` in a Playwright fixture, and rewrite the two tests to actually click pause and assert the state flip + feed render. If seeding is out of scope this pass, **rename** the tests to match their bodies and delete the assertion-free one — never leave a green test that checks nothing.
- **Acceptance:** `cd packages/a2ax && npm test` → 15 pass; root `npm test` shows all 3 projects.

### 3. CI pipeline — the standing guard  · M · *(after 1, 2)*
There is **no CI** (`.github/workflows` is empty). This is the single biggest reason the floor can silently drop. Add `.github/workflows/ci.yml` (push + PR): `npm ci` → `biome check` → per-package `tsc --noEmit` (matrix) → `npm test` (all 3 packages) → Playwright (separate, optional job, cache browsers).
- Staged required-gate rollout via branch protection (no workflow edits to flip): **day one required** = `test`, `typecheck(a2ax)`, `typecheck(frontend)`; **advisory** = `lint`, `typecheck(backend)`, `e2e`. Flip `typecheck(backend)` to required once item 1 lands; flip `lint` once `biome.json` widens to `packages/`; flip `e2e` last.
- Add a one-line `.husky/pre-commit` running `biome check --write` (biome only — keep tsc/tests out of the hook). Add `playwright-report/` + `test-results/` to `.gitignore`.

---

## Phase 2 — Security guardrails (cheap + urgent)

### 4. Connector-key traversal + Apollo salt  · S
`saveConnector`/`saveCustomToolFile` interpolate an unvalidated `key`/`name` into a filesystem path (`join(dir, \`${key}.json\`)`); the connectors route only checks presence. A key like `../../secrets` writes outside the dir. The fix pattern **already exists** — the credentials route uses `/^[A-Z][A-Z0-9_]*$/`.
- Apply that regex at both the route boundary and inside `saveConnector`/`deleteConnectorByKey` (defense in depth). For skill *names* use `/^[A-Za-z][A-Za-z0-9_-]*$/` (skill files are lowercase, e.g. `slack_api` — don't apply the env-var regex there).
- Apollo: replace the static `SALT = 'simple-harmonic-apollo-v1'` with a per-install random 16-byte salt written to `.apollo/salt` (mode `0600`), falling back to the legacy constant when no salt file exists so **existing vaults still decrypt**.
- **Acceptance:** unit tests prove `'../../x'` / `'a/b'` are rejected and never write outside the dir; two installs sharing one `APOLLO_MASTER_KEY` produce different `vault.enc` bytes; a legacy vault still loads.

### 5. Operator gate + cron-secret + spend cap  · M
No auth on any route, `/api/tick` is publicly hittable, no spend ceiling. Minimal single-operator baseline (full multi-tenant auth stays out of scope):
- **`src/middleware.ts`** gating all `/api/*` + settings/page routes on either `Authorization: Bearer $OPERATOR_PASSWORD` or an `sh_operator` cookie (`sha256(OPERATOR_PASSWORD)`, `timingSafeEqual`). **Fails closed** if `OPERATOR_PASSWORD` is unset. Use Web Crypto (edge runtime), exclude `/login`, `/api/login`, `/api/tick`. Make the login page real (`POST /api/login`, set cookie) and delete the "auth is not enforced yet" stub.
- **Cron-secret on `/api/tick`:** accept `x-vercel-cron` (platform cron) or `Bearer $CRON_SECRET` (dev loop / manual); 401 otherwise. Thread `req` into `POST`/`GET`. Update `instrumentation.ts` to send the secret.
- **Spend cap (the `$50/day` from CLAUDE.md, finally real):** add an `llm_spend` ledger table; surface `usage` from the Anthropic adapter (`response.usage.{input,output}_tokens` already exists); add `server/spend.ts` with `checkSpendAllowed()` (fails closed on DB error) and `recordSpend()` against a small per-model rate table; gate the tick loop before the team loop and record after each agent run. Env: `OPERATOR_PASSWORD`, `CRON_SECRET`, `SH_DAILY_SPEND_CAP_CENTS=5000`.
- **Acceptance:** `/api/spawn` no header → 401; `/api/tick` no header → 401, `x-vercel-cron` → 200; seed `llm_spend` over cap → tick returns `{skipped:'spend_cap', agentsRan:0}` and fires no LLM call.
- *Sequencing:* land cron-secret + spend-cap first (urgent), operator gate second.

---

## Phase 3 — Close the remaining security holes

### 6. Sandbox `coding_task` env + de-dup the 3 adapters  · M
`coding_task` spawns claude/codex/opencode with `env: { ...process.env }` (every secret) and `--dangerously-skip-permissions` / `-s workspace-write`. The scrub pattern **already exists** (`scrubbedEnv()` in `sandbox.ts`, used by `run_command`); it's just not applied here.
- Add `codingEnv(extraKeys)` = `scrubbedEnv()` + only the named provider key(s) per backend (claude → `ANTHROPIC_API_KEY`; codex → file-based via `HOME`/`CODEX_HOME`; opencode → both). Keep `HOME` (codex/claude read credential files under it).
- Collapse the ~80 lines of identical spawn/timeout/abort/buffer/exit boilerplate (lines ~67–134 in all three) into one `runSubprocess(cmd, argv, parseEvents, opts)`; only `argv` + `parseEvents` differ. Re-assert `resolveInJail(opts.cwd)` inside it. Keep the escalated flags **only** because cwd is now jailed and env scrubbed — document why in a comment.
- Fix the mid-line JSONL truncation here too (now one place): drop whole leading lines instead of `slice(-MAX)` mid-record.
- **Acceptance:** `grep` shows `env: { ...process.env }` gone from every adapter; a test proves `coding_task`'s child can't read `DATABASE_URL`/`GITHUB_TOKEN` (mirror the existing `run_command` exfil test); an out-of-jail cwd throws `JailEscapeError`.

### 7. One SSRF-guarded egress chokepoint  · M
`http_fetch`/`github_api` validate, but `proxy-fetch.ts` and the custom-skill runtime don't — and even the validated path checks the hostname *string* then re-resolves DNS at connect (rebinding), and `isPrivateHost` returns `false` for any DNS name (so a domain A-recording to `169.254.169.254` passes).
- New `tools/url-guard.ts`: `assertPublicAndResolve(url)` parses, rejects non-https/creds/localhost, **resolves DNS first**, rejects if *any* returned address is private/loopback/link-local/metadata/ULA, and returns a **pinned public IP**.
- Add IP-pinning to `proxy-fetch.ts` (override DNS resolution only — keep the real hostname for TLS SNI/cert validation). Route `http_fetch`, `github_api`, and crucially `api-tool-runtime` (custom skills) through the guard **before** the connector bearer token is attached. Delete the now-duplicated logic from `network.ts`.
- **Acceptance:** unit tests reject every private target and a mixed public+private A-record set; a custom skill with a private-resolving `baseUrl` returns `success:false` with `proxyFetch` **never called** (token never left).

---

## Phase 4 — Fix the correctness bugs

### 8. a2ax per-recipient reads + fleet-scoped discovery  · M
The flagship coordination primitive is broken: a broadcast/group message is one row with a shared `status`; `markRead` flips it globally, so the first agent to tick hides it from the whole team. Separately, `listCards` has `|| true` and leaks agent cards across fleets.
- Add an `a2ax_message_reads` table keyed `(message_id, agent_id)` in **all three** schema copies. Change `markRead(messageIds)` → `markRead(agentId, messageIds)` (one caller: `markContextRead`). In both transports, replace the status-based unread filter with a per-recipient check (`NOT EXISTS` in drizzle; a `Set` in memory). Keep `status` for `markExpired`.
- Fix `listCards`: strict `fleetId` filter (push it into the SQL `WHERE` in drizzle).
- **Acceptance:** new tests — a 3-recipient broadcast and a multi-member group where one reader does **not** hide the message from the others; `discoverAgents` returns only same-fleet cards.
- *Note:* a background task already exists for this; this card is its precise spec.

---

## Phase 5 — Pay down the structural variance

### 9. FKs + cascades + one schema source of truth  · L
Half the data model has no referential integrity (a2ax tables + `teams.parentTeamId` are bare uuids), cascade deletes run in app code non-transactionally, and the schema is hand-maintained in **3 copies**.
- Add FKs with `ON DELETE CASCADE` (team_id → teams, channel_id → channels) / `SET NULL` (reply_to) / self-FK on `parentTeamId`. **Do NOT** FK `from_agent_id`/`requestor_id`/`assignee_id`/token agent ids — they hold cofounder/user **sentinel** UUIDs with no `agents` row (would break inserts). Add a comment so nobody "fixes" it.
- Wrap the `modify_team` / `modify_agent` cascade deletes in `db.transaction`.
- One source of truth: **keep raw SQL** (drizzle-kit was removed on purpose) but **generate** it — a `gen-schema-sql.ts` script emits `schema.generated.sql` from `schema.ts`; `setup-db` imports it; a `schema-sync.test.ts` fails CI the moment a copy drifts. For already-created prod tables, FKs need `ALTER TABLE ADD CONSTRAINT ... NOT VALID` then `VALIDATE` after an orphan cleanup.
- **Acceptance:** integration test deletes a team and asserts zero orphans across all child tables; an insert with a cofounder sentinel id still succeeds; `schema-sync.test.ts` is green.

### 10. Delete dead components, hoist helpers, planner DI  · M
~7 components are dead (zero importers): `agent-graph.tsx` (the whole React Flow graph), `meta-agent-panel`, `agent-detail-panel`, `agent-hub-view`, `user-pov-view`, `paused-banner`, `top-bar`, and the `narration-sidebar` *component* (its helpers `describeAction`/`extractDetail` are live — move them, then delete the file). Helpers (`channelBadge`, `timeAgo`/`formatTime`, `truncate`, `STATUS_STYLE`) are copy-pasted 3–5×.
- Delete the dead files; drop the now-unused `@xyflow/react` dep (grep-verify first). Hoist helpers into `packages/frontend/src/lib/format.ts` + `lib/narration.ts` and import everywhere.
- Invert `planner.ts` to DI (a `PlannerDeps` param like `runner.ts`), so the library barrel stops dragging `server/codex-auth`/`config`/`proxy-fetch` and "extracts cleanly to NPM" becomes true. Resolve deps at the call site (`chat/route.ts`, `run-eval.ts`).
- **Acceptance:** `grep '@xyflow'` empty; `grep "from .*server/" packages/backend/src/lib/meta-agent` empty; frontend + backend vitest green; `/f/[id]` still renders and narrates.
- *Follow-up (not here):* `planner.ts` has no Anthropic path (only OpenAI/Codex) despite Anthropic being the documented default — file separately.

---

## Phase 6 — Keep the floor raised (standing guard)

Raising the floor once is worthless if it silently drops again. The mechanism:
1. **CI gates (item 3) are the enforcement.** Flip each check to required-to-merge as its backing item lands (order in item 3). Once green, a regression can't merge.
2. **The `schema-sync` and security exfil tests (items 6, 8, 9)** are tripwires — they fail loudly the moment someone reintroduces the class of bug.
3. **A "new-surface checklist"** (add to `CLAUDE.md`): any new tool that runs code or touches the network routes through `runSubprocess`/`url-guard`; any new route is gated by middleware; any new table has FKs + lives in `schema.ts`; any new feature ships with a test that runs in CI. The bar above, enforced at PR time.

The point of the whole exercise: this is a one-time climb, not a treadmill. After Phase 1–5, the variance is gone (floor ≈ ceiling); Phase 6 keeps it there.
