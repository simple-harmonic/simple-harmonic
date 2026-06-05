# CLAUDE.md — Simple Harmonic (Simple Harmonic) project context

This file auto-loads into every Claude Code session opened in this repo. Read it first.

## What this is

**Simple Harmonic** is the v0.0 product from **Simple Harmonic** (parent company). An AI cofounder and team for founders. Open-source web app first; desktop via Tauri (v0.2) and mobile via Capacitor (v0.3) wrap the same web frontend later.

Working dir / repo / codename: `simple-harmonic`. Product brand: Simple Harmonic. Don't change either.

## Status as of 2026-05-18

Design phase complete after `/office-hours`, `/plan-eng-review`, `/plan-design-review`. Code starts Monday 2026-05-19. v0.0 ship target 2026-06-01 (2 weeks).

## Read these first (in order)

1. `docs/README.md` — index + brand architecture
2. `docs/02-product.md` — what we're building (5 min read)
3. `docs/DESIGN.md` — design system, tokens, voice rules, anti-AI-slop rules
4. `docs/mockups/v0.0.html` — visual reference (open in browser)
5. `TODOS.md` — critical day-one items + design polish + v0.1 / v0.2 backlog
6. `docs/decisions.md` — full audit trail of every locked decision and why

The canonical single-file design doc is preserved at `~/.gstack/projects/simple-harmonic/yc-unknown-design-20260513-161159.md` for downstream gstack skills (`/plan-eng-review`, `/plan-design-review`, `/ship`, etc.). Don't edit it; it's a historical record.

## Critical pre-commit items (commit #1 stuff)

*Update (2026-06-06): the cost/connection items below are now IMPLEMENTED by the floor pass — pool `max:1` (`db/index.ts`), the `$50/day` cap is enforced in code (`server/spend.ts` + the tick gate, not just the console), and hibernate-on-idle (`last_user_active_at`) is live. They remain here as the rationale. Set `OPERATOR_PASSWORD`, `CRON_SECRET`, and `SH_DAILY_SPEND_CAP_CENTS` before any public deploy (`.env.example`).*

- **Neon pooled connection string**: use `pooler.neon.tech` not direct. Drizzle pool config `max: 1` for serverless. Without this, the 10s tick exhausts the connection pool within hours and agents silently stop.
- **Domain check**: verify `simpleharmonic.dev` (product) and `simpleharmonic.com` (company) availability + trademark before the Friday Assignment post. Fallbacks: simpleharmonic.app, simpleharmonic.ai, harmonic.dev.
- **Anthropic API key**: with $50/day cap. Add to `.env.local`. (Cap now also enforced in-app via `SH_DAILY_SPEND_CAP_CENTS`.)
- **Hibernate-on-idle**: needed to keep public deploy under v0.0 cost budget. Add `last_user_active_at` column on teams; skip ticks if older than 5 min.

## Stack (locked)

- Next.js (latest) + TypeScript strict
- Tailwind + shadcn/ui
- Drizzle ORM + Postgres via Neon (POOLED connection)
- Anthropic Claude Sonnet via `@anthropic-ai/sdk` direct (NOT LangGraph, NOT Anthropic Agents SDK)
- Inngest (or Vercel cron + DB-driven; deferred decision per `decisions.md` D2)
- ~~React Flow for the agent graph~~ — removed in the floor pass (the graph component was unused; the team view renders an inline activity feed)
- SSE for live narration
- Vitest unit tests + Playwright E2E + Biome lint/format
- Vercel for hosting (free tier through v0.0)

## Library boundary

`packages/backend/src/lib/meta-agent/` is the framework-shaped library. Contains: planner (LLM call), agent runner (single-action executor), tool dispatcher. **NOT** approval/pause/action_log/narration — those live in `packages/backend/src/server/`. It is dependency-injected and has **zero `server/` imports** (the planner takes `PlannerDeps`; see `server/planner-deps.ts`). The library extracts cleanly to NPM at v0.2; keep it server-free.

## Floor checklist (keep the floor raised)

The repo went through a "raise the floor" remediation pass (`docs/floor-plan.md` + `docs/floor-progress.md`). These rules keep it raised — check the ones that apply before landing a change:

- **New code-execution tool** (spawns a process): route it through `server/tools/coding/run-subprocess.ts` (scrubbed env via `codingEnv`, jailed cwd). Never spawn with `env: { ...process.env }`.
- **New network tool** (outbound fetch): route through `server/tools/url-guard.ts` `assertPublicAndResolve` BEFORE attaching any secret, and pass the pinned IP to `proxyFetch`. Never fetch an agent/LLM-supplied URL unguarded.
- **New API route**: it's gated by `src/middleware.ts` (operator auth) by default. If it must be public (like `/api/tick`), give it its own secret check and exclude it from the matcher. No unauthenticated mutating routes.
- **New DB table/column**: define it in `packages/backend/src/server/db/schema.ts` (source of truth) AND add the matching `CREATE TABLE` to the `setup-db` SQL — `schema-sync.test.ts` fails on drift. Add FKs with `ON DELETE CASCADE`/`SET NULL`, EXCEPT agent-id columns that may hold cofounder/user sentinel UUIDs (`identity.ts`), which stay un-FK'd.
- **Cost**: autonomous LLM spend is bounded by the `llm_spend` daily cap (`server/spend.ts`) + hibernate-on-idle. Don't add an LLM path that bypasses the per-agent `recordSpend`.
- **a2ax**: the backend imports a2ax from its built `dist/`. Rebuild it (`cd packages/a2ax && npm run build`) after ANY change to `packages/a2ax/src/`.
- **Testing/CI**: every change ships with a test that runs in CI (`.github/workflows/ci.yml`). Run the FULL `npm test` (not just the file you touched) before committing a change to a shared primitive. `npm run typecheck` must stay 0 across all packages.

## Brand voice rules (Simple Harmonic meta-agent)

- Calm authority. Opinionated. Pushes back on bad ideas with reasoning.
- First-person singular ("I'm your cofounder"), never "we" or "the system."
- Short sentences. No filler. No "Great question!" No apology-spam.
- Direct: "Six is more than you'll supervise effectively" not "Six might be challenging."
- One question at a time, max two.

Full voice and copy rules in `docs/DESIGN.md`. Anti-AI-slop blacklist also there (11 patterns to avoid).

## Decisions that are LOCKED and should not be re-litigated

The user has consciously decided these. New sessions should respect them:

- **Path-B forecast persona** accepted on 2026-05-13. The target user (solo founders running 2+ agents) doesn't exist in numbers today; bet is 12-18 months. North star is 1.5k GitHub stars by month 6.
- **Assignment skip** on 2026-05-18. User chose to launch into market rather than do 5 founder DMs first. Don't re-raise.
- **Bidirectional chat onboarding** on 2026-05-18, NOT single-textarea-paste. Pushback is a labeled message type.
- **Hybrid execution model**: agents have own `next_run_at`, but each one calls `meta-agent.approve(agent_id)` before running. Pause Team sets a flag the approval checks.
- **Rewind deferred from v0.0 to v0.1**. Override at every layer (Pause, edit, disable) is in v0.0; "rewind where reversible" comes back in v0.1 with real integrations.
- **Test coverage cut** on 2026-05-18 (D9): 1-star planner + 2 E2Es. NOT the full 3-star + 5 E2Es + 10-input eval. Brought back at v0.1.
- **Distribution model**: v0.0 web → v0.2 desktop (Tauri) → v0.3 mobile (Capacitor). Single web frontend as source of truth.
- **Brand**: Simple Harmonic (product), Simple Harmonic (company). Codename retained in working paths.
- **Dogfooding commitment**: once Simple Harmonic v0.0 ships and stabilizes (~2026-06-01), the founder runs Simple Harmonic itself on Simple Harmonic. Simple Harmonic becomes alpha user #1. This partially closes the path-B persona gap (founder IS now a member of the persona). v0.1 integration choices are driven by what Simple Harmonic actually needs day-to-day. YouTube cadence content writes itself: "what Simple Harmonic's agents did this week."

## North star + failure thresholds

- M0–M6 north star: **1.5k GitHub stars by month 6**
- M2 floor: 500 stars (calibrate up if founder has >1k followers at launch)
- M3 floor: 800 stars (otherwise rework positioning before continuing v0.1 build)
- M6 floor: 1.5k stars (otherwise thesis is failing; consider acquihire fallback or pivot)
- M6+ MRR begins; M9 = $5k, M12 = $15k, M18 = $50k OR acquihire OR pivot

## Voice rules for Claude (working with this user)

- Terse, builder-to-builder. No filler, no consultant tone.
- Take positions; don't hedge. Pushback when grounded is welcomed.
- No em dashes (use commas, colons, or new sentences instead).
- Use `AskUserQuestion` with concrete options + a recommended pick + one-line reason; don't dump 4 options without an opinion.
- Match the user's pace: they're decisive and don't bikeshed.
- For exploratory questions, give a 2-3 sentence opinionated response and let the user redirect.

## What's NOT in the repo yet (so you know what to build)

The directory is empty as of 2026-05-18 22:00 PT except for `CLAUDE.md`, `TODOS.md`, `docs/`, `.claude/`. Monday's first commits should bootstrap: `package.json`, `tsconfig.json`, `next.config.mjs`, `src/app/`, `src/lib/meta-agent/`, `src/server/`, `src/components/`, `drizzle/`, `tests/`.

## When in doubt

Read `docs/decisions.md`. Every decision in this project has a logged entry with the reasoning. If you find yourself confused about why something is the way it is, the answer is almost certainly in that file.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
