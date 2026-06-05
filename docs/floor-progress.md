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
- 2026-06-05: Item 6 done (`d47fbfd`). 664/664. `coding_task` env scrubbed + 3 adapters de-duped into `run-subprocess.ts`. Phase 3 has one item left (item 7, SSRF).
- 2026-06-05: **PHASE 3 CLEARED.** Items 6 (`d47fbfd`), 7 (`1c36e79`) done+committed. Gate: typecheck 0; `npm test` 675/675; tree clean. (Process note: item 7's SSRF change broke 8 existing http_fetch/api-tool tests that didn't mock DNS; caught by the full suite, fixed by adding a `node:dns/promises` mock + the pin arg, and the item-7 commit was amended green. Lesson: run the FULL suite, not just targeted files, before committing a change to a shared primitive.) Beginning Phase 4.

## NEXT: Phase 4 — item 8 (a2ax per-recipient reads + fleet leak)
See `docs/floor-plan.md` Phase 4. NOTE: the checkpointed WIP already renamed `fleetId`→`teamId` across a2ax, so use `teamId` in new code. This is the bug a background-task chip was also spawned for; this is its precise spec.
Steps:
1. Add `a2ax_message_reads` table keyed `(message_id, agent_id)` (+ index on agent_id) to ALL THREE schema copies: `packages/a2ax/src/adapters/drizzle-schema.ts`, `packages/backend/src/server/db/schema.ts`, raw SQL in `src/app/api/settings/setup-db/route.ts`.
2. `packages/a2ax/src/core/transport.ts`: change `markRead(messageIds)` → `markRead(agentId, messageIds)`. `protocol.ts`: `markContextRead(agentId, messageIds)` threads agentId through; grep all callers (tick route calls `a2ax.markContextRead` — thread agentId).
3. memory transport: a `reads` Set keyed `${messageId}:${agentId}`; in queryMessages, for unreadOnly drop messages where `reads.has(${m.id}:${query.agentId})` instead of the shared-status test.
4. drizzle transport: insert reads with `onConflictDoNothing`; queryMessages unread = `NOT EXISTS (SELECT 1 FROM a2ax_message_reads r WHERE r.message_id=... AND r.agent_id=query.agentId)`. Keep status for markExpired.
5. Fix `listCards` fleet leak: memory.ts has `|| true` (remove, filter by teamId); drizzle.ts has no filter (add WHERE teamId). discoverAgents already passes the id.
6. Tests in `packages/a2ax/tests/protocol.test.ts`: 3-recipient broadcast where one reader does NOT hide it from the other two; multi-member group same; discoverAgents returns only same-team cards.
Watch: `markRead` is a breaking interface change — grep `.markRead(`/`.markContextRead(` for all callers. `npm test` green (a2ax + backend), typecheck 0.
Then **PHASE 4 GATE**, then Phase 5 (items 9, 10), then Phase 6 (standing-guard checklist in CLAUDE.md).

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
