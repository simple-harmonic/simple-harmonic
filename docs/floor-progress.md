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
| 6 | Sandbox coding_task + adapter de-dup | 3 | ✅ done | `d47fbfd` | child env scrubbed (DATABASE_URL→ABSENT); jail re-asserted; adapters de-duped; 664 tests |
| 7 | SSRF egress chokepoint | 3 | ✅ done | `1c36e79` | DNS resolve-then-pin; token never sent to internal host; 675 tests |
| 8 | a2ax per-recipient reads + fleet leak | 4 | ✅ done | `5b7189c` | broadcast/group fan-out fixed (per-recipient reads); fleet-scoped discovery; 678 tests; dist rebuilt |
| 9 | FKs + one schema source | 5 | ✅ done | `c27fbb9` | FK cascades VERIFIED vs real PG18 (sentinel inserts ok, zero orphans); transactional deletes; schema drift-guard test; 680 tests |
| 10 | Dead code + planner DI | 5 | 🟡 next | — | last Phase 5 item; see NEXT |
| — | Standing guard (checklist in CLAUDE.md) | 6 | ⬜ todo | — | — |

Legend: ⬜ todo · 🟡 in progress · ✅ done+verified · ⛔ blocked

## Log
- 2026-06-05: Branched `raise-the-floor`, checkpointed pre-existing WIP (`82f65cc`). Beginning Phase 1.
- 2026-06-05: **PHASE 1 CLEARED.** Items 1-3 done+committed. Gate: `npm run typecheck` exit 0 (all 3 pkgs, 0 errors); `npm test` 622/622; CI YAML valid; husky hook fires. Beginning Phase 2.
- 2026-06-05: Item 4 done (`dbe9ba9`). Backend 633/633. Phase 2 has one item left (item 5).
- 2026-06-05: **PHASE 2 CLEARED.** Items 4, 5a (`dcdeb10`), 5b (`2d33523`) done+committed. Gate: `npm run typecheck` exit 0; `npm test` 656/656; tree clean. One deliberate plan deviation: the spend cap **fails OPEN** on a ledger read error (not closed) so a missing `llm_spend` migration / DB hiccup can't silently halt every agent — documented in `spend.ts`. Beginning Phase 3.
- 2026-06-05: Item 6 done (`d47fbfd`). 664/664. `coding_task` env scrubbed + 3 adapters de-duped into `run-subprocess.ts`. Phase 3 has one item left (item 7, SSRF).
- 2026-06-05: **PHASE 3 CLEARED.** Items 6 (`d47fbfd`), 7 (`1c36e79`) done+committed. Gate: typecheck 0; `npm test` 675/675; tree clean. (Process note: item 7's SSRF change broke 8 existing http_fetch/api-tool tests that didn't mock DNS; caught by the full suite, fixed + amended green. Lesson: run the FULL suite before committing a change to a shared primitive.) Beginning Phase 4.
- 2026-06-05: **PHASE 4 CLEARED.** Item 8 done (`5b7189c`). Gate: typecheck 0; `npm test` 678/678; tree clean. The original-review broadcast bug is fixed + regression-tested. a2ax `dist` rebuilt (backend imports the built package — remember to rebuild dist after any a2ax src change). Beginning Phase 5.
- 2026-06-05: Item 9 done (`c27fbb9`). 680/680. FK cascades + transactional deletes + schema drift-guard test. **Verified against a real throwaway Postgres 18** (initdb/pg_ctl available locally, set `LC_ALL=C` to avoid the PG18 macOS "multithreaded postmaster" start error): fresh+idempotent apply, sentinel-id inserts succeed (agent columns correctly NOT FK'd), root-team delete cascades child team + all a2ax rows to zero orphans. Phase 5 has one item left (item 10).

## NEXT: item 10 (Phase 5 final) — dead code + helper hoist + planner DI
See `docs/floor-plan.md` Phase 5 item 10. This is mostly deletion + import-repointing (compiler-checked, low risk). Run the FULL `npm test` before committing (item-7 lesson). Steps:
1. **Delete the zero-importer components** (grep-verify each has no importer first): `packages/frontend/src/components/team/{agent-graph,meta-agent-panel,agent-detail-panel,agent-hub-view,user-pov-view,paused-banner}.tsx` and `components/top-bar.tsx`. Then drop `@xyflow/react` from root package.json deps (grep `@xyflow` across src+packages returns empty first) + `npm install`.
2. **narration-sidebar.tsx is split**: the NarrationSidebar component is dead but its exports `describeAction`/`extractDetail`/`NarrationEntry` are LIVE (used by use-team.ts + team-dashboard + narration.test). Move those live helpers into a new `packages/frontend/src/lib/narration.ts`, repoint the 3 consumers, then delete narration-sidebar.tsx.
3. **Hoist duplicated helpers** into `packages/frontend/src/lib/format.ts`: channelBadge, timeAgo/formatTime, truncate, fmt, STATUS_STYLE (pick the most complete variant — agent-pov-view's STATUS_STYLE has dot+text+label). Replace the local copies in the LIVE files (agent-pov-view, agent-messages-view, message.tsx, team-dashboard, team-view) with imports.
4. **Planner DI**: invert `packages/backend/src/lib/meta-agent/planner.ts` to take a `PlannerDeps` param (config/apiKeySource/codexAccessToken/codexAccountId/fetchImpl) like runner.ts; delete its 3 `../../server/*` imports; resolve deps at the call sites (`src/app/api/chat/route.ts`, `eval/run-eval.ts`); update planner.test.ts to inject deps instead of vi.mock-ing server modules.
Verify: grep `@xyflow` empty; grep `from .*server/` in `packages/backend/src/lib/meta-agent` empty; frontend + backend vitest green; `/f/[id]` still renders/narrates (manual or trust compiler). FOLLOW-UP (do NOT fix): planner has no Anthropic path (only OpenAI/Codex) despite Anthropic being the default — file separately.
Then **PHASE 5 GATE** (`npm run typecheck` 0 + FULL `npm test` green), then Phase 6 (standing-guard checklist into CLAUDE.md).

## (done) item 7 — one SSRF egress chokepoint
See `docs/floor-plan.md` Phase 3 item 7 for the full spec. Read first: `tools/network.ts` (validatePublicHttpsUrl, isPrivateHost — note it returns false for any DNS name), `proxy-fetch.ts` (fetchViaHttps, the proxy CONNECT path, the hardcoded family:4), `tools/api-tool-runtime.ts` (:82-115 builds URL from baseUrl + LLM path, proxyFetches with the connector bearer, NO validation).
Steps:
1. New `tools/url-guard.ts`: `assertPublicAndResolve(rawUrl): Promise<{url: URL; pinnedIp: string; family: 4|6}>` — parse; reject non-https / creds-in-URL / localhost; if hostname is a literal IP run isPrivateIp; else `dns.lookup(host, {all:true})`, reject if EMPTY or if ANY result is private (covers a mixed public+private rebind set); return the first PUBLIC IP as pinnedIp. Move isPrivateIpv4/6/isPrivateIp here from network.ts.
2. `proxy-fetch.ts`: add optional `pin?: {ip,family}`; in fetchViaHttps pass `lookup: (_h,_o,cb)=>cb(null, pin.ip, pin.family)` and `family: pin.family` — override DNS ONLY, keep the real hostname for TLS SNI + cert validation (do NOT swap hostname; keep rejectUnauthorized). Proxy-tunnel branch: proxy resolves, pin N/A.
3. Route through the guard + feed the pin to proxyFetch: network.ts http_fetch (replace validatePublicHttpsUrl); api-tool-runtime BEFORE building auth headers (the key fix — token never sent to an internal host); github_api for consistency.
4. Delete the now-duplicated validate/isPrivate* from network.ts; import from url-guard.
5. Tests: url-guard rejects 169.254.169.254/127/10/172.16/192.168/::1/fc00 + a mixed A-record set + http + creds; resolves a public IP returning a pin; tools-security: a skill with a private-resolving baseUrl → success:false AND mockProxyFetch NOT called.
Watch: DNS override must not change hostname (TLS breaks otherwise); keep AbortController timeout covering the resolve; mock `node:dns/promises` lookup in tests.
Then **PHASE 3 GATE**: `npm run typecheck` 0 + `npm test` green + new security tests. Then Phase 4 (item 8: a2ax per-recipient reads).
