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
| 5 | Auth gate + cron-secret + spend cap | 2 | ✅ done | 5a `dcdeb10` · 5b `2d33523` | 656 tests; cron 401/x-vercel-cron 200; spend-cap skip; operator gate + real login |
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
- 2026-06-05: **PHASE 2 CLEARED.** Items 4, 5a (`dcdeb10`), 5b (`2d33523`) done+committed. Gate: `npm run typecheck` exit 0; `npm test` 656/656; tree clean. One deliberate plan deviation: the spend cap **fails OPEN** on a ledger read error (not closed) so a missing `llm_spend` migration / DB hiccup can't silently halt every agent — documented in `spend.ts`. Beginning Phase 3.

## NEXT: Phase 3 (security holes) — items 6 + 7
See `docs/floor-plan.md` Phase 3 for full specs.
- **Item 6 — sandbox `coding_task` + de-dup adapters (M):** add `codingEnv(extraKeys)` in `sandbox.ts` (scrubbedEnv + only the per-backend provider key; keep HOME); collapse the ~80 identical lines in `coding/{claude-code,codex,opencode}.ts` into one `runSubprocess(cmd, argv, parseEvents, opts)` that uses `codingEnv` + re-asserts `resolveInJail(cwd)`; fix the mid-line JSONL truncation there (drop whole leading lines, not `slice(-MAX)`). Tests: child can't read `DATABASE_URL`/`GITHUB_TOKEN`; out-of-jail cwd throws; truncation keeps a parseable record.
- **Item 7 — one SSRF egress chokepoint (M):** new `tools/url-guard.ts` `assertPublicAndResolve(url)` (resolve DNS first, reject any private/loopback/link-local/metadata IP, return a PINNED public IP); add IP-pin to `proxy-fetch.ts` (override DNS resolution only, keep hostname for TLS); route `http_fetch`/`github_api`/`api-tool-runtime` through it BEFORE the connector bearer is attached; delete the duplicated logic from `network.ts`. Tests: private targets + mixed A-record rejected; custom skill with private baseUrl → success:false, proxyFetch never called.
Phase 3 gate: `npm run typecheck` 0 + `npm test` green + new security tests.
