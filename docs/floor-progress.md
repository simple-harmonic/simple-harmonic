# Floor-plan execution progress

*Live tracker for `docs/floor-plan.md`. Updated as each item is completed AND verified. Ralph-loop reads this to resume.*

**Branch:** `raise-the-floor` · **Started:** 2026-06-05
**Baseline before work:** backend `tsc` = 278 errors · a2ax 15 tests green · backend 594 tests green · no CI
**Pre-existing WIP checkpointed in:** `82f65cc` (a2ax fleetId→teamId rename + biome format — not authored this session)

## Rule
Verify a phase is fully green (tests + typecheck + stated acceptance) before starting the next. One commit per item.

## Status

| # | Item | Phase | Status | Commit | Verified |
|---|------|-------|--------|--------|----------|
| 1 | Green `tsc` | 1 | ✅ done | `b481fb7` | tsc 0/exit0; backend 594/594; excluded test still runs in vitest |
| 2 | a2ax suite in runner + fix E2Es | 1 | ✅ done | `52dc304` | root 622/622; a2ax 15/15 standalone; e2e honest + parses |
| 3 | CI pipeline | 1 | ✅ done | `3ad5d4b` | typecheck 0 across all 3 pkgs; CI YAML valid; husky+lint-staged live |
| 4 | Connector-key + Apollo salt | 2 | ✅ done | `dbe9ba9` | 633 tests; traversal rejected; legacy vault still decrypts |
| 5 | Auth gate + cron-secret + spend cap | 2 | 🟡 next | — | heaviest item; see NEXT note below |
| 6 | Sandbox coding_task + adapter de-dup | 3 | ⬜ todo | — | — |
| 7 | SSRF egress chokepoint | 3 | ⬜ todo | — | — |
| 8 | a2ax per-recipient reads + fleet leak | 4 | ⬜ todo | — | — |
| 9 | FKs + one schema source | 5 | ⬜ todo | — | — |
| 10 | Dead code + planner DI | 5 | ⬜ todo | — | — |
| — | Standing guard (checklist in CLAUDE.md) | 6 | ⬜ todo | — | — |

Legend: ⬜ todo · 🟡 in progress · ✅ done+verified · ⛔ blocked

## Log
- 2026-06-05: Branched `raise-the-floor`, checkpointed pre-existing WIP (`82f65cc`). Beginning Phase 1.
- 2026-06-05: **PHASE 1 CLEARED.** Items 1-3 done+committed. Gate: `npm run typecheck` exit 0 (all 3 pkgs, 0 errors); `npm test` 622/622; CI YAML valid; husky hook fires. Beginning Phase 2.
- 2026-06-05: Item 4 done (`dbe9ba9`). Backend 633/633. Phase 2 has one item left (item 5).

## NEXT: item 5 (Phase 2 final) — auth gate + cron-secret + spend cap
Heaviest item; see `docs/floor-plan.md` Phase 2 item 5 for the full spec. Sub-parts (land cron-secret + spend-cap first, they're the urgent ones):
1. `src/middleware.ts` — operator gate (Bearer `OPERATOR_PASSWORD` or `sh_operator` cookie), Web Crypto (edge), fail-closed if unset, exclude `/login`,`/api/login`,`/api/tick`. Real `/api/login` route + rewire login page.
2. Cron-secret on `/api/tick` — accept `x-vercel-cron` or `Bearer CRON_SECRET`; thread `req` into POST/GET; update `instrumentation.ts`.
3. Spend cap — `llm_spend` table (3 schema copies!), surface `usage` from `anthropic-adapter.ts`, `server/spend.ts` (checkSpendAllowed fail-closed + recordSpend w/ per-model rates), gate tick before the team loop. Env: `OPERATOR_PASSWORD`,`CRON_SECRET`,`SH_DAILY_SPEND_CAP_CENTS=5000` in `.env.example`.
Verify: new vitest for middleware (401/200), tick auth (401/x-vercel-cron 200), spend (over-cap → skipped, no LLM call), adapter usage. Then Phase 2 gate: `npm run typecheck` 0 + `npm test` green. Watch: middleware must be EDGE-safe (Web Crypto, no DB import); don't FK-break; keep `npm test` green.
