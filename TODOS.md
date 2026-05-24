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

- **Rewind feature with real integrations**
  - What: Implement the rewind half of the override-and-rewind thesis. Per-integration reversibility per the table in `docs/02-product.md`.
  - Why: Deferred from v0.0 per founder decision 2026-05-18. The "rewind where reversible" tagline returns at v0.1.
  - Pros: Closes the original product thesis; sharp differentiation against Lindy / Relevance / Stack AI.
  - Cons: Real per-integration work; each connector needs custom undo logic (and irreversibility documentation).
  - Context: Per design doc Approach B, the reversibility table is a v0.1 deliverable that needs API-level confirmation.
  - Blocked by: 2 real integrations being selected by alpha users.

- **Real integration selection process**
  - What: During alpha-user screen shares (or, since the Assignment was skipped, during the v0.0 launch period), collect demand signal for which 2 SaaS APIs to integrate first. Likely candidates: Gmail, Notion, GitHub, Linear, Slack.
  - Why: Per Approach B, v0.1 integrations are alpha-user-driven, not founder-driven. Picking the wrong 2 = wrong wedge.
  - Pros: Real demand signal drives v0.1 scope.
  - Cons: Requires user contact in v0.0 launch window; since Assignment DMs were skipped, you'll need to capture demand signal another way (in-app survey, X polls, DM offers in YouTube demo).
  - Context: Design doc Open Q #2 (pricing) and Approach B.
  - Blocked by: v0.0 ship + initial user contact.

- **LLM eval suite (10 diverse vision inputs)**
  - What: Build a small eval harness that runs the planner against 10 hand-curated vision inputs, asserts schema validity, asserts role coherence (no duplicate agents, sensible names, schedules in reasonable ranges).
  - Why: Cut from v0.0 per D9 to fit the 10-day window. Catches prompt regressions early once you have real users and iterate on prompts.
  - Pros: Compounding velocity; prompt changes can be tested before deploy.
  - Cons: ~half-day of work; mostly fixture creation.
  - Context: D9 cross-model tension resolution.
  - Blocked by: v0.0 ship; existing planner code stable.

- **Test coverage uplift**
  - What: Bring planner coverage to 3-star (all retry paths), agent + approval to 2-star, add 3 more Playwright E2Es (error states, edge cases).
  - Why: Cut from v0.0 per D9. Brought back at v0.1 when the surface is stable enough to invest in regression coverage.
  - Pros: Refactor safety net; faster v0.2 work.
  - Cons: 1-2 days of test work.
  - Context: D9.
  - Blocked by: v0.0 ship.

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
