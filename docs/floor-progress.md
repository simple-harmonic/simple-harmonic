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
| 3 | CI pipeline | 1 | ✅ done | (this commit) | typecheck 0 across all 3 pkgs; CI YAML valid; husky+lint-staged live |
| 4 | Connector-key + Apollo salt | 2 | ⬜ todo | — | — |
| 5 | Auth gate + cron-secret + spend cap | 2 | ⬜ todo | — | — |
| 6 | Sandbox coding_task + adapter de-dup | 3 | ⬜ todo | — | — |
| 7 | SSRF egress chokepoint | 3 | ⬜ todo | — | — |
| 8 | a2ax per-recipient reads + fleet leak | 4 | ⬜ todo | — | — |
| 9 | FKs + one schema source | 5 | ⬜ todo | — | — |
| 10 | Dead code + planner DI | 5 | ⬜ todo | — | — |
| — | Standing guard (checklist in CLAUDE.md) | 6 | ⬜ todo | — | — |

Legend: ⬜ todo · 🟡 in progress · ✅ done+verified · ⛔ blocked

## Log
- 2026-06-05: Branched `raise-the-floor`, checkpointed pre-existing WIP (`82f65cc`). Beginning Phase 1.
