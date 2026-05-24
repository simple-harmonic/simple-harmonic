# Simple Harmonic — Problem & Premises

*Simple Harmonic is the v0.0 product from Simple Harmonic.*

Status: APPROVED (2026-05-13, after 2 adversarial review rounds)
Source: split from `yc-design.md` (canonical: `~/.gstack/projects/simple-harmonic/yc-unknown-design-20260513-161159.md`)
Related: [02-product.md](./02-product.md) · [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md) · [04-review-and-concerns.md](./04-review-and-concerns.md)

---

## Problem Statement

Solo founders increasingly attempt to operate a "one-person company" (OPC) using AI agents: orchestrating customer support, content production, sales follow-up, ops automation, and product work through teams of LLM-driven agents. As the agent count grows past three or four, the founder hits three compounding problems:

1. **Fragility.** Each agent is built with a different framework, prompt, or model, and breaks differently when APIs or providers change.
2. **Opacity.** The founder loses visibility into what their agents are doing in real time; failures are discovered hours or days late.
3. **Damage with limited undo.** When an agent does the wrong thing (sends the wrong email, posts the wrong content, writes bad data to a SaaS tool), reversing the damage is manual, slow, and sometimes impossible. Some actions (sent email, posted tweet, paid invoice) are irreversibly external; the goal is to make them rare via preview-and-approve, and to make reversible ones one-click.

There is no native manager layer over a team of heterogeneous agents, so the founder is forced to BE the manager, which defeats the OPC promise.

**Simple Harmonic** is a meta-agent that turns a founder's vision into a working team, supervises it, reports back, and gives the founder override at every layer plus rewind where reversible (with explicit preview-and-approve for actions that aren't). Open-source first, cloud-paid for hosted. "AI cofounder" is the marketing framing; the product reality is a magical scaffold plus a live supervisor that always honors founder control.

## Demand Evidence

Founder's honest answer to Q1 (Demand Reality): **"Hypothesis only."** No paying customers, no behavioral pull, no captured panic-when-it-breaks signal yet.

Adjacent evidence the founder cited:

- **Cleanlab 2025 survey of 95 engineering leaders.** 70% of regulated enterprises and 41% of unregulated organizations rebuild their agent stack every three months due to framework/API churn. Fewer than 30% are satisfied with observability and guardrail tools. 63% plan to invest in better monitoring.
- **Maor Shlomo / Base44.** Solo founder reached $189k/mo profit alone, sold the company for ~$80M to Wix six months after launch because solo bandwidth was the binding constraint.

Honest read (acknowledged by founder): Cleanlab's respondents are enterprise engineering leaders, NOT solo founders. Base44's solo bottleneck was support/sales/dev volume, not agent stack churn. **Neither cited example is a current member of the target persona.** Founder explicitly chose path B (forecast persona): the target user (solo founder running 2+ agents in production) is bet to exist in meaningful numbers within 12-18 months.

## Status Quo

Today's solo founders running early agent setups use fragmented tooling: Lindy or Relevance AI for some workflows, custom Python scripts for others, n8n for glue work, ChatGPT/Claude conversations for ad-hoc tasks. There is no unifying management layer. Observability, when present, is fragmented across Langfuse, Helicone, AgentOps, or vendor-specific dashboards. Damage from agent mistakes is recovered manually.

The implicit cost of the status quo for the path-B persona is **founder time spent as the manager**, which defeats the OPC promise of leverage without overhead.

## Target User & Narrowest Wedge

**Target user (Q3 answer):** "A type, with one example in mind." On pushback: a forecast persona, not someone the founder has talked to about this specific pain in current life.

**Working profile:** technically-capable solo founder, indie SaaS or content business operator, who has already strung together 2-3 agents in scrappy ways and is starting to feel the fragility/opacity problem. Demographic: indie hackers, X solo-builder cluster, Reddit r/SaaS, niche Discords (BuildSpace alumni, Reflect, Levels.io's circle).

**Wedge (Q4 answer):** Single-pillar minimum from the original three-pillar vision. The slice is **onboarding-as-orchestration**, where the act of getting started IS configuring your first running team. Founder's exact words: *"Onboarding and orchestration, they have to go hand in hand."*

## Constraints

- **Solo founder, no fund pressure.** 12-18 months of runway without revenue is workable. Attention budget and opportunity cost still bind.
- **Open source from day one.** MIT or Apache 2.0.
- **Cadence.** Weekly visible artifact (release notes, demo video, X thread with metrics).
- **YouTube demo as primary distribution vehicle.**
- **Cross-device collaboration is deferred to phase 2** (pillar 2 of original three-pillar roadmap), but v1 design must keep agents portable and addressable so the future cross-device layer can wire them up.
- **Override at every layer.** Meta-agent actions must always be inspectable, editable, and disable-able by the founder. No autopilot.

## Premises

Locked premises after Phase 3 challenge and cold-read revision:

- **P1.** The target persona (solo founders running 2+ agents to operate their business) will exist in meaningful numbers (1000+ globally) within 12-18 months. Path-B forecast bet; founder explicitly accepted the bet shape.
- **P2 (REVISED).** Solo founders want a meta-agent that **builds, supervises, and reports on their team AND lets them override at every layer.** The cofounder framing is marketing; the product UX honors control. Revised after cold-read challenge.
- **P3.** Damage reversal for meaningful agent actions (sent emails, posted content, DB writes) is technically achievable via sandbox + preview + approve + connector-level undo hooks for common SaaS APIs. Some actions remain irreversibly external; honest scoping required.
- **P4.** Open-core (self-host free + cloud paid) will convert at 10-20% for this audience because the meta-agent must run continuously, making self-hosting a real DevOps burden.

## Cross-Model Perspective

An independent Claude subagent reviewed a structured cold-read summary and returned four sections:

**Steelman.** "An AI chief of staff for solo founders: you describe your company in plain English, it spawns and supervises a team of specialized agents to execute, reports back like a real ops lead, and can undo their mistakes. It is the orchestration plus accountability layer that makes 'one-person company' go from meme to operating model, and it ships open-source to ride the same distribution wave that made n8n, LangChain, and Supabase defaults."

**Most revealing.** Quote: *"Onboarding and orchestration, they have to go hand in hand."* The only answer in the session that was a product insight rather than a vision statement. The actual wedge against Lindy / Relevance / Gumloop, which all treat build mode and run mode as separate surfaces.

**Challenged premise.** P2 pre-revision. Subagent's position: "It's codegen-with-extra-steps. Build for that reality. The 'cofounder' framing is marketing; the product is a vision-to-team compiler with a live supervisor pane." Founder accepted partial revision: keep the framing for marketing, honor override in the UX. This produced revised P2 above.

**48-hour prototype suggestion.** "VisionOS v0.0": single-page open-source app, vision-paste → planner LLM proposes 3-5 named agents → live graph + plain-English narration feed + working "rewind last action" button on at least one action type. Mostly mocked integrations, optimized for a 30-second YouTube demo. This shape was adopted directly as Approach A (see [02-product.md](./02-product.md)).

## Open Questions

1. **Path-B validation pre-build.** Operationalized by The Assignment (see [03-plan-roadmap-metrics.md](./03-plan-roadmap-metrics.md)): landing page + waitlist signup BEFORE A's code, count emails as proxy demand signal. Threshold calibrated to founder's starting audience.
2. **Pricing structure deadline.** Resolved by month 4 (see Monetization Milestones in 03). Specific tier values come from alpha-user willingness-to-pay signal during The Assignment screen shares; not a separate research project.
3. **Acquihire signal threshold.** What specific signal would tell the founder they're notable enough to consider an acquihire conversation? Proposal: stars > 5k AND at least 2 inbound recruiter/M&A contacts from named companies.
4. **Reversibility scope, published list.** Which external actions are in-scope for v0.1 rewind, and which are documented-as-irreversible? Founder needs to publish this list with v0.1 release so the "rewind where reversible" framing is honest. Draft scope: in (Notion writes, GitHub branches, Linear ticket edits, draft-but-unsent emails); out (sent emails, posted tweets, paid invoices, Slack DMs already delivered).
5. **Naming for launch artifact.** "VisionOS" was the cold-read subagent's working name for v0.0. Resolved 2026-05-18: launch artifact is **Simple Harmonic v0.0**, the first product from Simple Harmonic. VisionOS codename dropped.
6. **"OPC workplaces" channel: define or drop.** Founder used this term during distribution planning. Needs a concrete operational definition (coworking spaces? founder houses? a specific event series?) within 2 weeks of design-doc approval, or drop from the plan. Currently NOT in the Distribution Plan; pending definition.
7. **Self-evolving (Approach C) trigger.** When does this come back into scope? Proposed trigger: 3+ alpha users explicitly ask for a "suggest changes to my agent team" feature; OR a competitor ships it and Simple Harmonic needs the differentiator back.
8. **Founder's starting audience.** Single most important calibration variable for star targets and Assignment thresholds. **Document this number (X followers count, GitHub followers, newsletter list size if any) by EOD Thursday 2026-05-14**, 24 hours before The Assignment publishes on Friday 2026-05-16.
