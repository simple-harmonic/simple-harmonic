# Simple Harmonic (Simple Harmonic) — TODOs

Tracked work items derived from `/office-hours`, `/plan-eng-review`, and `/plan-design-review`. Grouped by milestone. Each item has WHAT, WHY, PROS, CONS, CONTEXT, BLOCKED BY.

---

## v0.0 build (weeks 1-2, deadline 2026-06-01)

### Critical — must do day one

- **Domain check: simpleharmonic.dev + simpleharmonic.com**
  - What: Verify availability and register **simpleharmonic.dev** (primary product domain) AND **simpleharmonic.com** (company domain, footers/legal). Run a 5-min trademark check for "Simple Harmonic" in dev-tools / AI-agent space (known uses: an audiobook app, an AI fintech firm; none in our lane).
  - Why: Brand needs available domains before launch. Fallbacks: simpleharmonic.app, simpleharmonic.ai, harmonic.dev.
  - Pros: Locks the brand architecture before the launch post Friday.
  - Cons: ~$30 in registration fees; 5-10 min of trademark search.
  - Context: `/plan-design-review` D-2026-05-18 brand-architecture decision + scope addition.
  - Blocked by: Nothing; do this BEFORE the Assignment post on Friday 2026-05-16.

- **Use Neon pooled connection string**
  - What: Connection URL must be `pooler.neon.tech` not direct. Drizzle pool config `max: 1` for serverless.
  - Why: The 10s tick exhausts Neon's direct connection pool within hours; agents silently stop. Cold-read flagged this on 2026-05-18.
  - Pros: Prevents a hard-to-diagnose Wednesday-night outage.
  - Cons: None; the pooled connection is the recommended path for Vercel serverless anyway.
  - Context: See `docs/decisions.md` D-2026-05-18-eng-review for the cross-model finding.
  - Blocked by: Nothing; do this in commit #1.

- **Hibernate-on-idle for teams**
  - What: Add `last_user_active_at` timestamp on teams table. Refresh from SSE connection heartbeat. Skip ticks if older than 5 minutes.
  - Why: 10s tick + no rate cap = ~$3,200/month at scale if any user leaves a tab open. Hibernate brings public-deploy cost back into the v0.0 phase budget.
  - Pros: Cost-safe public Vercel deploy; user experience unchanged (auto-resumes on visit).
  - Cons: ~15 lines of code; small additional state to track.
  - Context: Locked as part of D8 (tick frequency) decision on 2026-05-18.
  - Blocked by: SSE narration implementation (need the connection heartbeat to feed the timestamp).

### Engineering gotchas to handle correctly

- **Repair drizzle-kit migration state (broken by monorepo restructure)**
  - What: `drizzle-kit generate` does not work cleanly. Two problems found during T2 (2026-05-30): (1) `drizzle.config.ts` `schema` path pointed at `./src/server/db/schema.ts`, which no longer exists post-restructure (now fixed to `packages/backend/src/server/db/schema.ts`). (2) The migration journal `drizzle/meta/_journal.json` is out of sync: it stops at `0002` while `0003_add_cofounder_name.sql` and now `0004_add_pending_approvals.sql` exist on disk, and `drizzle/meta/` only has snapshots `0000`/`0001`. Migrations 0002+ appear to be hand-written.
  - Why: Until the journal + snapshots are rebuilt, every new migration must be hand-written and `drizzle-kit generate` can't be trusted. That is error-prone and will eventually drift the schema from the migrations.
  - Pros: Restores `db:generate`/`db:migrate` so schema changes are mechanical and verified against the snapshot.
  - Cons: Fiddly: needs regenerating snapshots from current schema, reconciling the journal with the on-disk SQL, and verifying against a real Postgres. ~half-day human / ~30 min CC.
  - Context: Surfaced while adding `0004_add_pending_approvals.sql` for T2. The migration is hand-written and idempotent (IF NOT EXISTS / duplicate_object guards) so it applies safely regardless.
  - Blocked by: Nothing; do before the next schema change after T2.

- **Anthropic tool-use retry without streaming initially**
  - What: Build the planner's 3-retry loop on the NON-streaming tool-use API first. Add streaming polish later if at all.
  - Why: Streaming tool-use deltas can't be schema-validated until the content block closes, which makes retry logic fiddly. Cold-read identified this as the Tuesday-Wednesday gotcha.
  - Pros: Avoids the "infinite retry on malformed streaming output" trap.
  - Cons: Slightly less dramatic UX (no token-by-token graph reveal); fine for v0.0.
  - Context: D5 + cold-read week-1 risk. NOTE: the chat onboarding (per `/plan-design-review` D3 2026-05-18) means the planner is now a multi-turn chat ending in tool-use. Retry policy still applies to the final spawn step; chat messages themselves should stream tokens (see Design polish below).
  - Blocked by: Nothing.

### Design polish (during v0.0 build)

Captured from `/plan-design-review` 2026-05-18. None block ship; address before launch day. Time estimates are with AI assistance.

- **Streaming UI for chat messages**
  - What: Stream assistant messages token-by-token with a small thinking-indicator before the first token arrives. SSE response + incremental React state.
  - Why: Without streaming, the chat feels laggy on multi-turn conversations. With streaming, the meta-agent's pushback messages have built-in drama.
  - Pros: Demo lands harder; chat feels alive; standard expectation for any 2026 chat UI.
  - Cons: ~half-day of work; small additional code for cancellation if user retries mid-stream.
  - Context: Design pass 2 (interaction state coverage).
  - Blocked by: Chat surface scaffolded.

- **Spawn transition (chat → active team view)**
  - What: Visible transition between the chat's approval card and the active team view. Options: (a) hard cut, (b) fade, (c) a small "spinning up 4 agents..." pulse while the first tick fires (~3 seconds).
  - Why: A hard cut feels jarring; the moment between "I approved" and "my team is running" is the demo's payoff and deserves a beat.
  - Pros: Smoother demo recording; first-time users understand what's happening.
  - Cons: ~1 hour; trivial framer-motion or pure CSS.
  - Context: Design pass 2 + pass 3.
  - Blocked by: Spawn endpoint working.

- **Per-agent active-call loading state**
  - What: When an agent is mid-LLM-call within a tick, the status pill should signal "thinking" (a small pulse or distinct state between "running" and the next narration entry).
  - Why: Currently the running pill is static; users can't tell when an agent is actively doing something vs. idling between ticks.
  - Pros: Makes the team feel alive between narration entries; better demo.
  - Cons: ~1 hour; minor DB column (`agent.in_flight` boolean) + UI binding.
  - Context: Design pass 2.
  - Blocked by: Agent runner working.

- **Returning-user chat behavior**
  - What: When a user closes the tab during onboarding chat and returns to `/f/abc123`, do they resume the chat or start fresh?
  - Why: Default behavior of single-page React apps is to lose state on refresh. Users hate this.
  - Pros: Persisting chat per team preserves context for both the user and the meta-agent's prompt history.
  - Cons: ~1 hour; the `chat_messages` table is already in scope per D3.
  - Context: Design pass 7 unresolved decision.
  - Blocked by: `chat_messages` table created.

- **"Best on desktop" mobile notice**
  - What: Detect viewport <768px, show a tasteful notice on hero / chat with email capture for the future mobile app. Honest about v0.0 being desktop-first.
  - Why: HN / X traffic is heavily mobile. Without this, half the launch traffic sees a janky desktop layout on their phone.
  - Pros: Honest UX; doesn't pretend mobile works; collects email signal for future mobile app demand.
  - Cons: ~2 hours; small Vercel-deployed email-capture endpoint.
  - Context: Design pass 6 + D4 distribution model.
  - Blocked by: Nothing.

- **Spawn-button intermediate states**
  - What: What does the Spawn button look like during the 3-second boot? Disabled? Loading spinner? Label change to "Spawning 4 agents..."?
  - Why: Without an intermediate state, the user clicks and the button looks the same; they may click again and double-spawn.
  - Pros: Prevents double-spawn bugs; standard UX expectation.
  - Cons: ~30 min.
  - Context: Design pass 2.
  - Blocked by: Spawn endpoint working.

- **a11y baseline**
  - What: ARIA landmarks (banner, main, log, form). `aria-live="polite"` on narration feed. Focus management on chat input. Keyboard nav for agent cards (tab order, enter to edit).
  - Why: Building accessibility in from the start is meaningfully cheaper than retrofitting at v0.1. Also: screen reader users exist in the technical-OSS audience more than most.
  - Pros: Inclusive by default; meets baseline expectations; better Lighthouse score (which matters for HN comments).
  - Cons: ~half-day, mostly thinking through patterns once and applying them consistently.
  - Context: Design pass 6.
  - Blocked by: Components scaffolded.

- **Color contrast WCAG audit**
  - What: Run axe-core or similar against deployed v0.0 build. Verify amber (#ea580c) button text and all body text passes WCAG AA (4.5:1 for normal text, 3:1 for large text).
  - Why: Dark theme + amber accent should pass, but worth verifying before launch. Users with reduced contrast sensitivity must be able to read narration.
  - Pros: ~15 min check that prevents accessibility regressions.
  - Cons: Negligible.
  - Context: Design pass 6.
  - Blocked by: v0.0 deployed.

- **Touch target sizing (for v0.2 desktop / v0.3 mobile distributions)**
  - What: Agent edit/disable icons render at ~13px currently; mobile app distribution needs 44px tap area minimum. Plan: keep visual icon size, expand hit area via invisible padding.
  - Why: Touch targets <44px are functionally untappable on mobile; v0.3 mobile app launch will need this fixed.
  - Pros: Now (in CSS) is free; later (during mobile app build) is annoying.
  - Cons: ~30 min during v0.2 prep.
  - Context: Design pass 6 + D4 distribution model.
  - Blocked by: v0.2 desktop app or v0.3 mobile work begins.

---

## v0.1 build (weeks 3-12, deadline ~2026-08-10)

> **v0.1 status (2026-05-31):** Core tool-integration work SHIPPED. Plugin
> registry + 5 tools (T1), approval gate with conversation serialization (T2),
> sandbox hardening + security suite (T3/T4), per-agent timeout + parallel tick
> (T5), Codex adapter for 8 tools (T7), inline tool results (T8), tool env vars
> (T9), and the planner/tool-use eval suite (T10) are all merged. 540 tests
> passing. Remaining for the milestone: real integration selection (alpha-user
> driven), rewind (deferred to v0.1.1), Inngest-vs-cron decision, and flipping
> `SH_ENABLE_TOOLS` on a live dogfooding checkout. The items below are the
> original plan, kept for the audit trail.

### Critical — v0.1 core (tool integrations + safety)

- **Plugin registry + 5 new tools (read_file, write_file, run_command, github_api, http_fetch)**
  - What: Build ToolRegistry class with Zod schema validation. Methods: register(def, impl), get(name), listForAgent(tools[]), getOpenAIDefs(). Tool definitions (schemas, categories, risk levels) live in `packages/backend/src/lib/meta-agent/` (NPM-extractable). Tool implementations (fs, child_process, API calls) live in `packages/backend/src/server/tools/`. Zod schemas auto-convert to JSON Schema for LLM tool definitions.
  - Why: The entire v0.1 thesis: agents that can take external actions on the codebase. Unlocks dogfooding (Simple Harmonic agents working on Simple Harmonic).
  - Pros: Plugin architecture future-proofs for v0.2 NPM extraction. Clean library/app boundary per D8.
  - Cons: Largest single workstream. ~4 days human / ~2 hours CC. Must ship with sandbox + approval gate.
  - Context: D3 (build plugin registry), D5 (Zod schemas), D6 (process sandbox), D8 (split defs/impls). v0.1 eng review 2026-05-30.
  - Blocked by: Nothing. First thing to build.

- **Approval gate + pending_approvals table + conversation serialization**
  - What: Wire approveAgentAction() into runner.ts at line 118 (D11). Create pending_approvals table in schema (columns: id, agentId, teamId, toolName, toolArgs, status, requestedAt, resolvedAt, resolvedBy). Add conversation_state jsonb column on agents table. When agent hits a destructive tool, serialize LLM messages array to DB, pause agent. On approval, deserialize and resume with tool result injected. Build approval queue UI in team view with approve/reject cards.
  - Why: Without the approval gate, agents run destructive tools unchecked. D17 chose full conversation serialization for multi-tool chaining capability.
  - Pros: Safety-critical. Users trust the product because they approve destructive actions. Full conversation context preserved across approval pauses.
  - Cons: Conversation serialization is architecturally complex. Token budget management needed for long conversations. ~3 days human / ~1.5 hours CC.
  - Context: D7 (synchronous block), D11 (wire approval), D17 (serialize to DB). v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry.

- **Process-level sandbox for run_command**
  - What: cwd jail (restrict each agent to its per-agent working directory), command allowlist (git, npm, node, bun, etc.), per-command timeout (30s default), environment variable sanitization, deny pipe operators and shell metacharacters (|, ;, &&, $(), backticks).
  - Why: run_command without a sandbox means agents can rm -rf /, read /etc/passwd, or exfiltrate env vars. This is the security boundary.
  - Pros: Makes run_command safe for dogfooding. Path traversal, command injection, env exfiltration all blocked.
  - Cons: Allowlist needs curation. Some legitimate commands may be blocked initially. ~1 day human / ~30 min CC.
  - Context: D6 (process-level sandbox), D12 (security tests), D16 (local-only execution). v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry.

- **Security test suite**
  - What: Full security test suite for all 5 new tools. Test cases: path traversal (../../etc/passwd, symlinks, null bytes, encoded slashes on read_file/write_file), command injection (pipes, env variable expansion, shell metacharacters on run_command), tool argument validation (malformed JSON from LLM, missing required fields, wrong types), approval boundary tests (ensure destructive tools can't bypass approval gate).
  - Why: The sandbox is only as good as what you remembered to block. Automated tests catch the attacks you forgot about.
  - Pros: Regression safety net for every sandbox change. ~1 day human / ~20 min CC.
  - Cons: Needs creative adversarial thinking for test fixtures.
  - Context: D12 (full security suite), D6 (sandbox), test plan artifact at ~/.gstack/projects/simple-harmonic/. v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry + sandbox.

### Performance + reliability

- **Per-agent timeout budget + Promise.allSettled in tick route**
  - What: (1) Give each agent a time budget per tick (e.g. 30s). If tool execution exceeds budget, abort and log partial result. (2) Change tick route from sequential for-loop (route.ts:82) to Promise.allSettled per team so agents run concurrently within a tick.
  - Why: With real I/O tools, sequential execution makes ticks too slow. 4 agents with 5s tools = 20s sequential vs ~5s parallel. Without timeouts, one slow tool blocks all agents.
  - Pros: Performance headroom. Each agent already has its own cwd jail, providing natural filesystem isolation.
  - Cons: Concurrent DB writes need careful handling (tickCount race on action_log). ~1 day human / ~20 min CC.
  - Context: D14 (timeout), D20 (Promise.allSettled). v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry.

### Code quality + DRY fixes

- **Extract shared types module + fix runner.ts JSON parse bug**
  - What: (1) Extract OpenAIToolDef interface into packages/backend/src/lib/meta-agent/types.ts, deduplicate from anthropic-adapter.ts:10 and codex-adapter.ts:37. (2) Fix runner.ts:113 silent catch {} on JSON.parse failure: return tool error to LLM ("Invalid JSON in tool arguments") instead of swallowing to empty args.
  - Why: Three independent interface copies drift. Silent catch means the LLM never learns its JSON was malformed, repeating the same broken output.
  - Pros: Both are small, high-impact fixes. ~30 min human / ~5 min CC combined.
  - Cons: None meaningful.
  - Context: D9 (DRY types), D10 (error handling). v0.1 eng review 2026-05-30.
  - Blocked by: Nothing. Can be done immediately.

- **Codex adapter upgrade for 8+ tools**
  - What: Upgrade codex-adapter.ts to handle 8+ tool definitions reliably. Current text-encoding approach (encoding tools as prompt text, 299 lines) degrades with more tools. Options: improved structured text formatting, hybrid encoding, or wait for Codex Responses API native tool_use.
  - Why: D21 chose to keep the Codex adapter as an LLM provider fallback. With 8 tools, prompt token waste and unreliable JSON output become real problems.
  - Pros: Maintains LLM provider diversity (Codex/GPT as fallback if Anthropic is down).
  - Cons: Every new tool needs testing against text-encoded parsing. ~2 days human / ~45 min CC.
  - Context: D21 (keep and upgrade). v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry, shared types extraction.

### UI + infrastructure

- **Inline collapsible tool results in action cards**
  - What: Store tool execution results (file contents, command stdout, API responses) in action_log.payload. Render as collapsible detail section (disclosure triangle) on existing action cards in the team view UI.
  - Why: Without visible tool results, users can't verify what agents did. Trust erodes.
  - Pros: Minimal new UI: disclosure triangle on existing cards. Data already lands in action_log.
  - Cons: Raw JSON/text only for v0.1, no syntax highlighting or diff views. ~1 day human / ~15 min CC.
  - Context: D19 (inline collapsible detail). v0.1 eng review 2026-05-30.
  - Blocked by: Plugin registry.

- **Credentials via Apollo env vars**
  - What: Configure Apollo (or equivalent) for managing GITHUB_TOKEN and other API keys needed by tools. Tool implementations read from process.env. Document required env vars in .env.example.
  - Why: D18 chose env vars with Apollo management for v0.1. Per-team secrets table deferred to v0.2 multi-tenancy.
  - Pros: 5-minute setup. Sufficient for single-team dogfooding.
  - Cons: All teams share one token. ~30 min human / ~5 min CC.
  - Context: D18 (env vars via Apollo). v0.1 eng review 2026-05-30.
  - Blocked by: Nothing.

### Existing items (updated)

- **Rewind feature with real integrations** (DEFERRED to v0.1.1)
  - What: Implement the rewind half of the override-and-rewind thesis. Per-integration reversibility per the table in `docs/02-product.md`.
  - Why: Deferred from v0.0 per D4 (2026-05-18), then from v0.1 to v0.1.1 per D4 (2026-05-30 eng review). For v0.1 dogfooding, git serves as the safety net for write_file operations.
  - Pros: Closes the original product thesis; sharp differentiation against Lindy / Relevance / Stack AI.
  - Cons: Real per-integration work; each connector needs custom undo logic.
  - Context: D4 (defer to v0.1.1). v0.1 eng review 2026-05-30.
  - Blocked by: 2 real integrations selected by alpha users + v0.1 ship.

- **Real integration selection process**
  - What: During alpha-user screen shares (or, since the Assignment was skipped, during the v0.0 launch period), collect demand signal for which 2 SaaS APIs to integrate first. Likely candidates: Gmail, Notion, GitHub, Linear, Slack.
  - Why: Per Approach B, v0.1 integrations are alpha-user-driven, not founder-driven. Picking the wrong 2 = wrong wedge.
  - Pros: Real demand signal drives v0.1 scope.
  - Cons: Requires user contact in v0.0 launch window; since Assignment DMs were skipped, you'll need to capture demand signal another way (in-app survey, X polls, DM offers in YouTube demo).
  - Context: Design doc Open Q #2 (pricing) and Approach B.
  - Blocked by: v0.0 ship + initial user contact.

- **LLM eval suite: planner + tool-use (10 vision inputs + tool selection fixtures)**
  - What: Build eval harness with two tracks. (1) Planner eval: run planner against 10 hand-curated vision inputs, assert schema validity, role coherence (no duplicate agents, sensible names, schedules in reasonable ranges). (2) Tool-use eval: test agent tool selection (does it pick read_file vs write_file correctly?), argument construction (valid Zod-parseable args?), error handling (graceful response to tool errors?). D13 chose both tracks.
  - Why: Cut from v0.0 per D9. With 8 tools in v0.1, prompt regressions can break tool selection. Catches "agent calls write_file when it should call read_file" regressions.
  - Pros: Compounding velocity; prompt changes tested before deploy. Tool-use eval prevents silent quality degradation.
  - Cons: ~1.5 days of work (planner: half-day, tool-use: 1 day). Needs hand-curated tool-use fixtures.
  - Context: D9, D13 (both planner + tool-use eval). v0.1 eng review 2026-05-30.
  - Blocked by: v0.0 ship; plugin registry + tools implemented.

- **Test coverage uplift (unit + E2E + security)**
  - What: Bring planner coverage to 3-star (all retry paths), agent + approval to 2-star, add 3 more Playwright E2Es (error states, edge cases). Additionally, includes the security test suite (D26): path traversal, command injection, argument validation tests for all 5 new tools. See security test suite entry above for details.
  - Why: Cut from v0.0 per D9. Brought back at v0.1 with expanded scope to cover the new tool surface area.
  - Pros: Refactor safety net; faster v0.2 work. Security tests prevent sandbox regressions.
  - Cons: 2-3 days of test work (expanded from 1-2 to include security suite).
  - Context: D9, D12, D26. v0.1 eng review 2026-05-30.
  - Blocked by: v0.0 ship; plugin registry + sandbox.

- **Inngest vs Vercel cron decision**
  - What: Evaluate Inngest now that v0.1 has real users and durability matters more. Either migrate to Inngest or commit to Vercel cron with a robust retry wrapper.
  - Why: D2 deferred this; the v0.1 milestone is the right time to revisit.
  - Pros: Either choice is fine; the deferral is honest.
  - Cons: Migration is real work either way.
  - Context: D2.
  - Blocked by: v0.0 ship + first signal on real-load scheduling needs.

---

## v0.2 build (post-v0.1)

- **Extract `@simple-harmonic/meta-agent` as a publishable NPM package**
  - What: Pull `src/lib/meta-agent/` out into a separate package. Publish to NPM. Document the public API. Strangler-fig pattern: app continues to consume it, but external users can adopt it.
  - Why: D1 + D10 lock the library shape (stateless agent runner only) precisely so this extraction is clean. Steinberger-shaped framework is a strong acquihire asset.
  - Pros: Distribution mechanism for the meta-agent thesis as a framework; expands the open-source story; strongest acquihire signal.
  - Cons: 1-2 weeks of API design + docs + first external user testing.
  - Context: D1 + D10 + cold-read week-1 architecture tensions.
  - Blocked by: v0.1 ship; library API surface stable from real usage.

- **Self-host path: Docker Compose + GHCR container images**
  - What: Publish container images for self-host. Add `docker-compose.yml` for one-command run. CI publishes on tag.
  - Why: Per design doc Approach B, deferred from v0.1. Self-host is the open-core monetization wedge.
  - Pros: Free-tier flywheel; users who can't pay for cloud self-host.
  - Cons: Real work; first-time-Docker-package-on-GitHub-Actions has its own gotchas.
  - Context: Design doc Distribution Plan + scope decision 2026-05-13.
  - Blocked by: v0.1 ship.

---

## Open questions to resolve as milestones approach

- **"OPC workplaces" channel: define or drop** — by end of v0.0 build window (2026-06-01)
- **Pricing tiers** — by month 4 (per design doc Monetization Milestones)
- **Acquihire signal threshold** — when stars approach 5k OR first inbound recruiter contact
- **Approach C (self-evolving) trigger** — when 3+ alpha users explicitly ask, OR competitor ships it

---

## Conscious decisions made and NOT in this TODOs file

These were considered and explicitly declined (see `docs/decisions.md` for rationale):

- The Assignment (post + landing page + 5 founder DMs) — skipped on 2026-05-18
- Inflection Pi as agent framework — does not exist as a framework; declined for lack of identification
