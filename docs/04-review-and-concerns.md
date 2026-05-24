# Simple Harmonic — Review Suggestions & Concerns

*Simple Harmonic is the v0.0 product from Simple Harmonic.*

Status: APPROVED (2026-05-13). This file collects AI-agent review output and observational reflections, not strategic decisions. The strategic content lives in [01](./01-problem-and-premises.md), [02](./02-product.md), and [03](./03-plan-roadmap-metrics.md).
Source: split from `yc-design.md`
Related: [01-problem-and-premises.md](./01-problem-and-premises.md) · [02-product.md](./02-product.md) · [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md)

---

## Review history summary

- **Adversarial review rounds**: 2
- **Issues raised across rounds**: ~29
- **Critical issues fixed in the doc**: 12 (consistency, contradictions, scope creep)
- **Implementation-level concerns deferred**: 8 (listed below as Reviewer Concerns)
- **Quality score**: 7/10 stable across both rounds; converged via convergence guard rather than 3rd pass
- **Reviewer model**: independent Claude subagent, cold-read (no conversation context)

## Reviewer Concerns (deferred to implementation phase)

The adversarial review surfaced several implementation-level questions that are real but appropriate for a v0.0 / v0.1 build spec rather than this strategic design doc. Captured here so the founder doesn't lose them. The right time to address these is when `/plan-eng-review` runs against the design doc, or during the v0.0 build itself.

- **Rewind contract.** v0.0 rewind is single-step undo only (no cascade). Define what happens to downstream agents that consumed the rewound action; recommendation is "emit orphan narration event, don't auto-cascade."

- **Planner LLM output contract.** Specify the JSON schema (e.g., `{agents: [{name, role, tools, schedule}]}`), retry policy on malformed output (3 retries with error feedback), and fallback (default 3-agent template). Add a worked example: input vision text → planner prompt → expected JSON → rendered graph.

- **Narration feed bounds.** Event rate cap, persistence across reload (Postgres-backed, retention window), max in-memory feed length, UI virtualization for high-volume periods. Not yet specified.

- **Mock fidelity for v0.0.** Persistence (do mock inboxes survive reload, or reset?), scoping (per-user or global mock state?), reset UX. Not yet specified.

- **Graph vs tree terminology.** Current spec describes a star topology (meta-agent → agents) with no agent-to-agent edges. Either commit to additional edge types (data flow, dependency, supervision) or rename to "Supervision tree" for accuracy.

- **Weekly cadence attention budget.** Build a single-table allocation of hours/week across the cadence (YouTube ~6-8h, X/threads, community, alpha screen shares, issue triage) AND the build, so the build budget per week is explicit and the cadence isn't quietly devouring engineering time.

- **Star calibration formula.** The audience calibration note on month-2 (500 stars) should explicitly scale to the month-6 north-star (1.5k stars) and beyond. Recommendation: express as a proportional multiplier on the entry follower count rather than fixed numbers.

- **Per-integration reversibility map (v0.1).** Published table in [02-product.md](./02-product.md) under Approach B is a draft; verify each row against current API docs at build time. Notion's "soft-delete" claim, GitHub's "branch + revert" claim, and Linear's restore semantics all need API-level confirmation before the public reversibility list ships.

These are the known gaps. None block design approval; all need resolution during implementation.

## What I noticed about how you think

Four observations from the session, in your own words where possible. These are reflections, not action items.

- **You answered Q1 with "Hypothesis only" without dressing it up.** Most pre-product founders inflate their evidence: they call signups "demand," they call interest "pull." You didn't. That's one of the rarest signals in early-stage office hours. Honest founders are easier to course-correct than founders who can't see their own blind spots.

- *"Onboarding and orchestration, they have to go hand in hand."* This is the only sentence in our entire conversation that was a product insight rather than a vision statement. An independent reader landed on the same quote without seeing our chat. When two independent reads converge on the same line, that's the line. Put it somewhere visible: landing page, slide one, your own desktop.

- **You compressed four features into the meta-agent without me handing you the answer.** When pushed to write one thesis sentence, you didn't fight the constraint; you found the unifying abstraction yourself (the "meta-agent" idea where vibe-founding, self-evolving, and transparency all fold into the chief-of-staff role). That's product thinking, not feature thinking. It will serve you again the next time scope tries to creep.

- *"Acquihire is the second last resort, before putting this in resume and looking for a job."* Clean risk staircase, articulated without bravado. You've thought about the downside without flinching, which is why the upside is worth swinging for. Founders who can name their soft landing without shame are the ones who tend to actually swing hard.

One thing that didn't land cleanly: you have not yet named a specific real human who lives this problem today. Your evidence is published surveys and famous solo exits. The Assignment (see [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md)) is designed to fix this. Find five people before you build.
