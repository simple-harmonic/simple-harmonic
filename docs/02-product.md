# Simple Harmonic — Product

*Simple Harmonic is the v0.0 product from Simple Harmonic.*

Status: APPROVED (2026-05-13)
Source: split from `yc-design.md`
Related: [01-problem-and-premises.md](./01-problem-and-premises.md) · [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md) · [04-review-and-concerns.md](./04-review-and-concerns.md)

---

## What we're building (one paragraph)

Simple Harmonic is a meta-agent that turns a founder's vision into a working team, supervises it, reports back, and gives the founder override at every layer plus rewind where reversible (with explicit preview-and-approve for actions that aren't). Open-source first, cloud-paid for hosted. "AI cofounder" is the marketing framing; the product reality is a magical scaffold plus a live supervisor that always honors founder control.

## The wedge that makes this not-another-agent-platform

**Onboarding-as-orchestration.** The act of getting started IS configuring your first running team. The vision-paste textbox IS the onboarding flow; submitting it spawns the live team. No separate "configuration" step. No agent-builder UI. The meta-agent is the builder. This is the slice against Lindy / Relevance / Gumloop, which all treat build mode and run mode as separate surfaces.

> *"Onboarding and orchestration, they have to go hand in hand."* — founder, 2026-05-13

## Approaches Considered

### Approach A: VisionOS v0.0 (demo-first minimal viable)

1-2 week ship. Single-page Next.js app deployed to Vercel. Vision-paste textbox → planner generates 3-5 named agents → live graph + plain-English narration feed + working rewind on at least one action type. Mostly mocked integrations. Optimized for 30-second YouTube demo plus HN, Product Hunt, and X launch. MIT, public repo from day one.

Stack: Next.js + Vercel + Postgres (Neon) + Anthropic Claude Sonnet + Inngest for scheduling + shadcn/ui.

**Mocked agent archetypes for v0.0** (the planner picks 3-5 from this set based on the founder's vision):
- support-responder (operates against a mock inbox)
- content-scheduler (writes to an in-memory post queue)
- sales-followup (against a mock CRM)
- ops-monitor (against synthetic metrics)
- research-summarizer (real read-only: X public timeline + Hacker News RSS)

Only the research-summarizer touches the real world (read-only). Every other action is faux. The **rewind** button works because all faux side effects route through a reversible in-memory action log (Postgres-backed); rewinding deletes the log entry and emits a narration event saying "rewound: [action]."

**Graph and narration UI**: graph nodes are the 3-5 spawned agents; edges show parent-child supervision (meta-agent → agents); narration feed is a chronological log of agent actions and meta-agent decisions, plain English, one line each.

**Onboarding-as-orchestration UX in concrete terms**: the vision-paste textbox IS the onboarding flow. The moment the founder submits, the meta-agent spawns the team and starts running it; there is no separate "configuration" step, no agent-builder UI. The meta-agent is the builder. Every spawned agent has an "edit" and "disable" button on its graph node from second zero (the override-at-every-layer commitment from P2-revised).

**Meta-agent override surface (concrete v0.0 capabilities)**: beyond per-agent edit/disable, the founder can (a) cancel any planned action in-flight before it executes, (b) "Pause Team" with one button (halts all agent scheduling), (c) edit the meta-agent's current plan in a text view and re-submit to regenerate the team. These three buttons are first-class UI, not buried in settings.

### Approach B: Production v0.1 (real integrations)

8-12 week ship. Real (not mocked) integrations to **2 SaaS APIs selected by alpha users** during The Assignment screen shares (likely candidates: Gmail/IMAP, Notion, GitHub, Linear, Slack). Reversible action log writes to those services. Persistent state across sessions. Cloud preview deploys for alpha users. **Self-host (Docker Compose, GHCR) deferred to v0.2** unless explicit alpha-user demand surfaces.

Why narrowed to 2 integrations: solo founder + 8-12 weeks + the OAuth verification process for Google alone can consume 4-6 weeks. Three OAuth dances is the scope ceiling, two is the realistic floor. Alpha-user signal dictates which two.

Same stack as A plus real OAuth flows, queueing (Inngest, consistent with v0.0).

**Caveat on integration choice**: if Gmail (Google) is one of the two integrations, start OAuth verification in week 1 in parallel to coding, because Google's verification process can consume 4-6 weeks of calendar time. If verification can't be parallelized to fit, pick 2 non-Google integrations (Notion + GitHub is a likely default for a developer-leaning alpha cohort).

**Rewind in v0.1, scoped honestly**: API-level undo where the integration's API actually supports it. Realistic per-integration map:

| Service | Reversible operations | Irreversible operations (preview-and-approve gated) |
|---|---|---|
| Gmail | Draft creation, draft edits | Sending email; replying |
| Notion | Page edits (via version history fetch + restore where API permits); soft-delete of created pages within retention window | Hard-deleted content past retention; @-mentions firing notifications |
| GitHub | Branch creation, branch deletion, draft PR open/close | Comments, merged PRs, sent webhooks, public issue creation |
| Linear | Ticket creation (delete), ticket-field edits (version restore) | Sent notifications, comment posting |
| Slack | Scheduled message cancel | Already-delivered DMs, channel posts |

Irreversible actions are gated behind explicit preview-and-approve with a clear in-UI warning ("this action cannot be undone"). Reversibility per integration is published as part of the v0.1 deliverable so the "rewind where reversible" claim is honest.

### Approach C: Self-evolving meta-agent demo (the lateral bet, deferred)

Estimated 4-6 weeks of incremental work ON TOP OF v0.1 (not standalone). A's shape plus self-improvement: the meta-agent proposes team adjustments over time and the user approves. Reintroduces the "self-evolving" dimension from the founder's original four-feature list. Deferred but kept as a lateral option; trigger conditions in Open Question #7 of [01-problem-and-premises.md](./01-problem-and-premises.md).

## Recommended Approach

**Sequenced A → B**, launched as **Simple Harmonic** (from Simple Harmonic):

- **Weeks 0 (this week):** Execute The Assignment (see [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md)). Build the public commitment, collect signal.
- **Weeks 1-2:** Ship Approach A as **Simple Harmonic v0.0** (the launch demo). Mostly mocked. Optimized for a 30-second YouTube demo and HN / PH / X launch. **Week 1 begins on 2026-05-19, conditional on the Assignment threshold being met. If the threshold is missed, do NOT start week 1; revisit positioning per the Assignment failure-mode instruction.**
- **Weeks 3-12:** Iterate to Approach B's Production v0.1. 2 real integrations chosen by alpha users; reversible action log writes to real SaaS APIs for those two; cloud preview deploys. Self-host deferred to v0.2. Each milestone becomes a weekly YouTube update plus X thread, sustaining the cadence.
- **Beyond v0.1:** Approach C (self-evolving) is the lateral bet available if A's signal demands it.

**Why this sequencing.** Founder's locked cadence (weekly visible artifact) and north-star metric (1.5k GitHub stars by month 6) require an artifact in market within 2-3 weeks, not 8-12. A is the smallest shippable thing that tests revised P2 in front of real humans. B is downstream of A's signal so the 8-week build is informed by what the audience actually pulls on.
