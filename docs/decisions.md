# Simple Harmonic — Decisions Log

A rolling log of consequential decisions, with date, rationale, and known risks. Lightweight ADR (architecture decision record) style.

---

## 2026-05-18 — Skipped The Assignment, going straight to v0.0 build

**Decision.** Skip the week-0 Assignment (public post + landing page + waitlist + cold DMs to 30 named solo founders + 5 booked screen shares). Start v0.0 build Monday 2026-05-19.

**Rationale (founder).** Wanted to focus on building, not customer-dev. Conscious choice after being shown the failure mode in office hours.

**Counsel given (AI).** This is the riskiest move from the founder's starting position. P1 (path-B forecast persona will exist in 12-18 months) is the most fragile premise, and The Assignment was the cheapest possible test of it (~90 minutes of writing). Skipping it means P1 stays untested through the full 12-week build cycle.

**Known risks accepted.**
- v0.0 may launch to engineers-checking-out-the-demo (HN/PH/X audience) rather than real workflow users; star count without adoption signal.
- v0.1 build (8-12 weeks) may proceed without design feedback from real users.
- The 800-star month-3 failure threshold may fire mid-v0.1 build with sunk cost already significant.
- Modal outcome for path-B founders who skip pre-build validation: 3 months in with no audience-product fit. Founder accepts this is a real possibility.

**Risk mitigations adopted (despite skip).**
1. **Waitlist-on-launch.** When v0.0 ships publicly, the landing page MUST include an email capture for v0.1 alpha. Collecting waitlist signal passively during launch, even without pre-launch.
2. **Alpha-user feedback budget.** Reserve 5 hours/week starting at v0.0 launch for outreach and screen shares with anyone who stars or installs. Late customer-dev is better than no customer-dev.
3. **Hard tripwire.** If v0.0 launch (HN + PH + X) generates fewer than 100 stars in 48 hours, STOP and reassess positioning BEFORE continuing v0.1 work. Do not sleepwalk to month 3.
4. **Re-eval point.** Re-read this decision log at month 2 when the 500-star milestone is checked. If signal is weak, return to a compressed Assignment then.

---

---

## 2026-05-18 — `/plan-eng-review` architecture lockdown (10 decisions)

**Decision summary.** After a full plan-eng-review pass with outside-voice cross-model challenge, ten architecture decisions are locked for v0.0 Monday-morning start.

**D1 — Framework.** Custom meta-agent library on top of `@anthropic-ai/sdk`, library-shaped from day one in `src/lib/meta-agent/`. Extract to NPM at v0.2. NOT LangGraph, NOT Anthropic Agents SDK, NOT a popular framework. Rationale: the meta-agent IS the framework abstraction; building on another framework dilutes the thesis.

**D2 — Scheduler.** Deferred. setInterval in a long-lived Node process for local dev / YouTube recording. Vercel cron hitting `/api/tick` for production deploy. Full Inngest evaluation deferred to v0.1.

**D3 — Execution model.** HYBRID. Agents have own `next_run_at`. Before running, each agent calls `meta-agent.approve(agent_id)`. Meta-agent can preempt. Pause Team sets a flag the approval checks.

**D4 — Action log schema.** Simplified after rewind deferral. `(id, agent_id, meta_agent_approval_id, action_type, payload jsonb, executed_at)`. No `rewound_at`, no `downstream_action_ids`. Pure write-only log used for narration in v0.0.

**SCOPE CHANGE: Rewind deferred from v0.0 to v0.1.** The rewind half of the override-and-rewind thesis ships with v0.1's real integrations. v0.0 marketing copy uses "override at every layer" but NOT "rewind where reversible."

**D5 — Planner LLM contract.** Anthropic tool-use API with `spawn_team` tool. Schema: `{agents: [{name, role, archetype, tools, schedule_minutes, initial_prompt}]}`. 3 retries on malformed output with error feedback. Fallback to default 3-agent template if all retries fail.

**D6 — Error handling.** Throw + try/catch at boundaries. Idiomatic TypeScript. One top-level try/catch per API route. NOT Result<T, E> types.

**D7 — Test coverage (initial commit).** Full coverage as planned: 3-star planner, 2-star agent/approval/routes, 5 Playwright E2Es, 10-input LLM eval suite.

**D8 — Tick frequency.** 10s tick, no rate cap, WITH hibernate-on-idle (auto-pause after 5 minutes of no UI activity). Without hibernate, the 10s tick would cost ~$3,200/month at scale; hibernate brings it back to v0.0 phase budget.

**D9 (revises D7) — Test coverage cut after outside-voice tension.** Outside voice flagged D7 as 3-5 days of work in a 10-day window. Cut to: 1-star planner coverage (happy + fallback), 2 Playwright E2Es (vision-paste, Pause Team). LLM eval suite deferred to v0.1. The coverage uplift comes back in v0.1.

**D10 — Library boundary clarity (resolves D1+D3 tension).** Library is "stateless agent runner only." `src/lib/meta-agent/` contains: planner (LLM call), agent runner (executes one action), tool dispatcher. Approval/pause/action_log/narration live in `src/server/` (the app layer). Clean extract path at v0.2.

**Engineering gotchas captured in TODOs.md.**
1. Use Neon pooled connection string (`pooler.neon.tech`) with `max: 1` in Drizzle pool config from day one. Without this, the 10s tick exhausts the connection pool within hours and agents silently stop.
2. Build the planner retry loop on the non-streaming tool-use response first. Streaming + retry + schema validation interacts badly.

**Outside voice contribution.** Independent Claude subagent flagged: (a) test commitment vs deadline tension (resolved as D9), (b) library-vs-approval-gate semantic tension (resolved as D10), (c) Neon pooling gotcha (captured as critical day-one TODO), (d) Anthropic tool-use + streaming + retry gotcha (captured as TODO). Outside voice also re-litigated the Assignment skip — declined as already-decided per 2026-05-18 founder choice.

**Files produced/updated this session.**
- `TODOS.md` at repo root (new)
- `docs/decisions.md` (this file, this entry)
- `~/.gstack/projects/simple-harmonic/yc-unknown-eng-review-test-plan-20260518-112121.md` (test plan for /qa consumption)

**Next.** Code Monday 2026-05-19. Pre-code setup checklist in earlier session output.

---

---

## 2026-05-18 — `/plan-design-review` (design system + UI direction lock)

**D1.** Mockup tooling: HTML/CSS prototype written by Claude in lieu of gstack-designer AI-image mockups. User is on Codex subscription, not OpenAI API billing; adding an OpenAI API key just for design mockups was rejected as friction. The HTML prototype at `docs/mockups/v0.0.html` is the visual reference. Cost: $0. Drives the v0.0 build directly.

**D2.** Direction locked: **dark theme + amber accent** (NOT light/teal). Reference aesthetic: Raycast / Vercel Dashboard / Linear dark mode.

**D3 — SCOPE ADDITION.** Onboarding flow upgraded from single-textarea-paste to **bidirectional chat** between founder and meta-agent. Brainstorming, follow-ups, explicit pushback against bad founder ideas ("six agents is too many"). Approval card with inline edit + Spawn button is the chat's terminus. Implications:

- Eng-review D5 (planner contract) revised: planner is no longer single-shot tool-use. It's a streaming chat session ending in a `spawn_team` tool-use call when both parties align.
- v0.0 build window picks up ~1-2 days for chat UI (message list, streaming SSE, input handling, scroll/focus behavior).
- New DB tables: `chat_messages`, `chat_sessions`, team-scoped.
- Per-onboarding LLM cost rises slightly (multi-turn vs single-shot). Onboarding is once-per-user; cumulative effect small.
- Eng-review error fallback ("default 3-agent team") becomes rare because the chat clarifies ambiguity in-flight.

**D4 — DISTRIBUTION MODEL.** v0.0 = open-source web app, desktop-first. Mobile shows "best on desktop" notice + email capture for future mobile app. **v0.2 packages the same web frontend as a desktop app via Tauri.** **v0.3 packages as mobile via Capacitor or Tauri Mobile.** The Next.js web frontend is the single source of truth for all three distributions.

This clarifies original Pillar 2 framing. "Cross-device collaboration" was vague; it now concretely means desktop + mobile + cloud-hosted backend coordinating as one team through the agent-comms layer. Distributions are consumers of pillar 2 infra, not separate things.

**D5.** DESIGN.md extracted to `docs/DESIGN.md` from the approved mockup. Captures color tokens, type scale, spacing rhythm, component patterns, voice rules, anti-AI-slop list, distribution model. Authoritative reference for v0.0 build.

**Pass scores (initial → after fixes).**

| Pass | Dimension | Score |
|---|---|---|
| 1 | Information architecture | 8/10 |
| 2 | Interaction state coverage | 7/10 |
| 3 | User journey & emotional arc | 8/10 |
| 4 | AI slop risk | 9/10 |
| 5 | Design system alignment | 6/10 → 9/10 after DESIGN.md extraction |
| 6 | Responsive + a11y | 4/10 (mobile deferred per D4; a11y and touch targets as TODOs) |
| 7 | Unresolved decisions | 8 items captured as TODOs |
| **Overall** | | **3/10 → 8/10** |

**Outside voice.** Skipped. No `codex` CLI on PATH (user is on Codex subscription, separate billing path). Cross-model design challenge deferred.

**Files produced.**

- `docs/mockups/v0.0.html` — approved mockup, 6 surfaces, dark/amber, chat onboarding
- `docs/DESIGN.md` — design system extracted from mockup
- `TODOS.md` — 8 design-polish items added under "Design polish (during v0.0 build)"

**Next.** Code Monday 2026-05-19 against `docs/DESIGN.md` and `docs/mockups/v0.0.html`. No more reviews needed before build starts.

---

---

## 2026-05-18 — Brand architecture: company vs product split

**Decision.** The company name is **Simple Harmonic**. The v0.0 product is renamed **Simple Harmonic**. Future products inherit the simple-harmonic-motion theme:

| Layer | Name | Role |
|---|---|---|
| Company | **Simple Harmonic** | AI teams for founders. |
| Pillar 1 (v0.0–v0.1) | **Simple Harmonic** | Meta-agent platform. Simple Harmonics tick; matches the agent wake-up cycle. |
| Pillar 2 (later) | **Spring** | Cross-device agent comms. Springs transfer energy between systems. |
| Pillar 3 (later) | **Resonance** (or Circuit) | Marketplace where agents resonate with founder contexts. |

**Why this architecture.** The umbrella pattern (Alphabet → Google, Anthropic → Claude, OpenAI → ChatGPT) scales cleanly with the three-pillar roadmap. The metaphor sharpens: "simple harmonic motion" maps directly to the 10s tick cadence, the predictable oscillation, and the calm-authority brand voice. Simple harmonic motion is steady, self-correcting, sustainable: that's literally what the meta-agent does.

**Codename retention.** The working dir `/Users/yc/dev/projects/simple-harmonic/`, the eventual GitHub repo `simple-harmonic`, and the canonical design doc at `~/.gstack/projects/simple-harmonic/yc-unknown-design-20260513-161159.md` all keep the original name as an internal codename. This is the Mozilla pattern (codename "Bonsai" shipped as Firefox). Lower migration cost than renaming everything; preserves the existing decision audit trail.

**Migration scope (completed in this session).**

- `docs/mockups/v0.0.html`: page title, H1, all top-bar wordmarks (6), all mockup URL labels updated to `simpleharmonic.dev`, brand-architecture paragraph added near the top
- `docs/DESIGN.md`: title, brand architecture section expanded, voice section retitled
- `docs/01-problem-and-premises.md`: title, product statement, open-Q #5 (naming) resolved, open-Q #7 reference updated
- `docs/02-product.md`: title, product statement, recommended-approach branding line, "Simple Harmonic v0.0" replacing "Simple Harmonic v0.0"
- `docs/03-plan-roadmap-metrics.md`: title, "Building Simple Harmonic in public" (Assignment headline + TODO checklist), "Simple Harmonic v0.0" replacing all VisionOS/Simple-Harmonic v0.0 references, YouTube cadence line, domain dependency expanded to cover both domains
- `docs/04-review-and-concerns.md`: title
- `docs/README.md`: title, brand architecture table added, Assignment reference
- `TODOS.md`: title, new "Domain check" TODO as critical day-one item

**Pre-launch domain TODO** (now in TODOS.md as critical day-one):

- Verify and register `simpleharmonic.dev` (or fallback: simpleharmonic.app, simpleharmonic.ai)
- Verify and register `simpleharmonic.com` for company use
- 5-min trademark check on "Simple Harmonic" in dev-tools / AI-agent space (known uses: audiobook app, AI fintech firm; neither in our lane, but verify)
- If "Simple Harmonic" is blocked: pick a fallback (Resonance, Oscillator, Maestro all already considered)

**What was NOT changed.**

- Working directory name (`simple-harmonic/`) — internal codename
- GitHub repo name (when created Monday: `simple-harmonic`) — internal codename
- The canonical design doc filename at `~/.gstack/...` — historical record
- The thesis sentence itself ("An AI cofounder that turns a founder's vision into a working team...") — the subject is implicit; the sentence is now about Simple Harmonic but reads identically

**Migration time:** ~15 minutes of edits across 8 files. Confirmed Simple Harmonic branding visible in the mockup HTML's Launch preview panel.

---

---

## 2026-05-18 — Dogfooding commitment

**Decision.** Once Simple Harmonic v0.0 ships and stabilizes (~2026-06-01), the founder runs **Simple Harmonic** itself on **Simple Harmonic**. Simple Harmonic becomes Simple Harmonic's alpha user #1. The company and the product grow alongside each other.

**Strategic implications.**

- **Partially resolves the path-B persona gap.** Office-hours Q3 (2026-05-13) flagged that the founder had not named a specific human running a multi-agent OPC today. As of v0.0 ship, that specific human is the founder, running Simple Harmonic with Simple Harmonic. Not a complete resolution — one user is still one user — but it changes the persona claim from forecast-only to forecast-plus-self-evidence.

- **Informs v0.1 integration selection.** Approach B selects 2 real SaaS integrations from alpha-user demand signal. Simple Harmonic's own ops needs become the leading demand signal. Likely candidates given Simple Harmonic's actual workflow: GitHub (the repo), X (cadence content), Gmail or Notion (ops). The "ask alpha users" mechanism gets a free seed.

- **Cadence content writes itself.** YouTube weekly demos become "what Simple Harmonic's agents did this week." Real narration, real edge cases, real pushback. Demo authenticity replaces demo theater.

- **Tightens the feedback loop.** Bugs hit the founder same-day. Missing features become felt-need, not hypothetical. Reliability requirements scale with the founder's own dependency on Simple Harmonic.

**Honest caveat.** Founder-dogfooding has a known bias: founder has perfect product knowledge, typical users don't. Simple Harmonic could feel great to the founder while confusing strangers. The dogfooding commitment does NOT substitute for external alpha-user signal. The v0.0 launch DMs, the v0.1 alpha-user screen shares, and the "best on desktop" mobile waitlist all remain critical inputs.

**Precedent.** Linear built Linear. Notion built Notion. Basecamp built Basecamp. GitHub used GitHub. Vercel deploys Vercel via Vercel. The pattern has shipped some of the best dev tools of the last decade; it scales.

**Operational impact for v0.1+.**

- Simple Harmonic's ops should run through Simple Harmonic from day one of v0.1 stability (~weeks 3-12).
- Cost model: founder's own usage counts against the v0.1 budget; factor in.
- Bug triage: founder-found bugs should not be auto-prioritized just because the founder hits them. External-user-found bugs deserve equal weight even when fewer in number.

---

## (Future decisions logged below as they happen)
