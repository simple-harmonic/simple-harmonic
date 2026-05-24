# Simple Harmonic — Plan, Roadmap, Metrics, TODOs

*Simple Harmonic is the v0.0 product from Simple Harmonic.*

Status: APPROVED (2026-05-13)
Source: split from `yc-design.md`
Related: [01-problem-and-premises.md](./01-problem-and-premises.md) · [02-product.md](./02-product.md) · [04-review-and-concerns.md](./04-review-and-concerns.md)

---

## THE ASSIGNMENT (week-0, immediate)

**Before writing the first line of code: publish a "Building Simple Harmonic in public" announcement post by EOD Friday 2026-05-16.** Post to X, Indie Hackers, and any newsletter or community you have access to. Include:

1. The thesis sentence: "An AI cofounder that turns a founder's vision into a working team, supervises it, reports back, and gives you override and rewind at every layer."
2. The GitHub repo URL (empty repo is fine; proof of commit).
3. A landing page with a "Get notified for the alpha" email capture. Simplest possible page; ConvertKit, Beehiiv, or a Vercel-deployed form works.
4. An invitation: "If you're a solo founder already running 2+ agents, reply or DM me. I want to watch you work for 30 minutes before I build anything."

**Goal by EOD Sunday 2026-05-18 (calibrated to founder's existing audience):**
- 25 emails on the waitlist (if founder enters with 0-100 X followers)
- 75 emails on the waitlist (if 100-1000 followers)
- 200 emails on the waitlist (if >1000 followers)
- AND in every case: 5 specific replies from solo founders willing to do a 30-minute screen share

If founder enters with effectively zero audience: also add **30 cold DMs to named solo founders running 2+ agents** to the assignment, scraped from Indie Hackers + X + r/SaaS.

**Why this assignment.** Tests P1 cheaply. Forces customer development BEFORE the build, not after. Creates accountability for shipping the demo. If you can't hit the waitlist number with the thesis sentence alone, the positioning needs another pass before you write any code. This is the lowest-cost validation step available, and it directly addresses the highest-risk premise (the forecast persona).

If you hit the numbers: ship Simple Harmonic v0.0 over the following two weeks.
If you miss the numbers: revisit positioning before building.

## Success Criteria (wedge validation phase)

These are the metrics that validate the wedge bet (path-B forecast persona + meta-agent thesis). Monetization-phase numbers live in a separate section below to keep this list focused.

**Months 0-2, v0.0 demo phase:**
- Simple Harmonic v0.0 shipped, public repo MIT or Apache 2.0 licensed, deployed on Vercel
- 30-second YouTube demo published; cross-posted to HN, PH, X
- 500 GitHub stars by end of month 2 (calibrate up if founder enters with existing audience >1k followers)

**Months 3-6, v0.1 production phase:**
- 2 real integrations live, chosen by alpha users
- Cloud preview deploys functioning
- **1.5k GitHub stars by month 6 (NORTH STAR)** (calibration note above applies)
- 50+ named alpha users who installed and ran the meta-agent on real workflows
- 10+ unprompted DMs from solo founders saying "I rebuilt my X workflow with this"

**Failure signals (trigger pivot or reset):**
- Fewer than 250 GitHub stars at month 2: launch failed; rework positioning before continuing
- Fewer than 800 GitHub stars at month 3: positioning is failing; rework before B build continues
- Fewer than 1.5k GitHub stars at month 6: thesis is failing; consider acquihire fallback or pivot
- No real users running the meta-agent on production workflows by month 6: P1 forecast is wrong; revisit persona

## Monetization Milestones (post-wedge)

These targets are downstream of wedge validation and should not pollute the wedge metrics above. Pricing structure must be locked by month 4 to hit these.

- **Month 4**: lock pricing tiers ($X self-host paid? $Y cloud individual? $Z cloud team?) based on alpha-user willingness-to-pay signal
- **Month 6+**: cloud-hosted tier live; pricing in the $50-200/mo working range
- **Month 9**: $5k MRR, conversion at 10% of installed-user base toward cloud-paid (premise P4)
- **Month 12**: $15k MRR
- **Month 18**: $50k MRR OR a credible acquihire conversation OR pivot decision

## Distribution Plan

- **Open source** with MIT or Apache 2.0 license. Public GitHub repo from day one.
- **Launch channels (one-shot events):** Hacker News, Product Hunt, X/Twitter. Headline: the thesis sentence, not the category.
- **Sustained channels:**
  - **Primary (weekly, non-negotiable):** YouTube demo. One short video per week showing what Simple Harmonic did this week. This is the cadence anchor.
  - **Secondary (every release, demoted if cadence slips):** X thread with metrics + release notes.
  - **Tertiary (as content allows, monthly minimum):** community DMs, issue triage, blog post.
  - The rule: if anything slips, the YouTube demo still ships. Everything else is downstream of the video.
- **Solo-founder communities (parallel work):** Indie Hackers, X solo-builder cluster, niche Discords (BuildSpace alumni, Reflect, Levels.io's circle). Ongoing presence, not one-shot.
- **Offline:** one small OPC gathering per month in year 1. No conferences in year 1.
- **CI/CD:** GitHub Actions for tests + build + Vercel deploy on merge to main. Container images published to GHCR for the self-host path; added in v0.2 (NOT v0.1, deferred per Approach B).

## Dependencies

- **Anthropic Claude API** (Sonnet for planner and agents). Requires API key and budget allocation.
- **Vercel** (web hosting, preview deploys). Free tier likely sufficient for v0.0; paid tier needed at scale.
- **Postgres via Neon** (managed). Free tier sufficient for v0.0.
- **Inngest** (scheduling and queueing). Free tier likely sufficient.
- **OAuth integrations (B phase).** Requires app registration with Google, GitHub, Notion, Linear, Slack. Each ~1-2 hours setup; OAuth verification for Google may take 4-6 weeks of process. Plan early.
- **Domains.** Register **simpleharmonic.dev** (product domain, primary public face) AND **simpleharmonic.com** (company domain, used in footers and legal). Check trademark + .com availability before the Assignment publishes Friday 2026-05-16. Fallback if simpleharmonic.dev is taken: simpleharmonic.app, simpleharmonic.ai, harmonic.dev.
- **Founder identity.** Twitter/X presence and GitHub profile. Personal brand matters for the acquihire fallback (Steinberger pattern). **Founder's existing audience size at start = TBD; this is the single most important calibration variable for the star-count milestones and Assignment thresholds. Document this number before launch and adjust targets accordingly.**

### Cost model (working estimate)

- v0.0 phase (months 0-2): Claude API ~$20-50/mo (light usage, manual testing), Vercel free, Neon free, Inngest free, domain $15/yr. Total: <$100/mo.
- v0.1 phase (months 3-6): With 50 alpha users running a team of 3-5 agents continuously, sustained narration + planning + agent reasoning is non-trivial. Realistic Claude API spend $1k-2k/mo (back-of-envelope: 50 users × 4 agents × 1k tokens/action × 30 actions/day × $15/M output ≈ $900/mo for output alone, plus input tokens, plus planner calls). Vercel paid ~$20-50/mo, Neon paid ~$20-50/mo, Inngest paid ~$50/mo, OAuth verifications free-but-time-costly. Realistic total: ~$1.5k-2.5k/mo.
- Plan a **$2k/mo floor budget** for the v0.1 build period. Free tiers shrink; don't bet on them surviving. If the cost model proves too aggressive in practice, throttle action frequency or cap alpha-user count.

### Security posture (cloud preview deploy in v0.1, full paid tier at Month 6+)

- OAuth tokens stored encrypted at rest, never logged (v0.1 baseline)
- Per-user blast-radius limits: rate caps per integration, daily action quotas, kill-switch per agent (v0.1 baseline)
- Internal security audit before opening the alpha to outside users in v0.1
- Public security write-up + SOC-2-style attestation: deferred to Month 6+ paid-tier launch
- v0.1's cloud-preview is alpha-only (named users), not a public paid tier

## TODO checklist (extracted from Open Questions and The Assignment)

- [ ] **By EOD Thursday 2026-05-14**: Document founder's starting audience size (X followers, GitHub followers, newsletter list). This calibrates Assignment thresholds and star milestones.
- [ ] **By EOD Friday 2026-05-16**: Publish "Building Simple Harmonic in public" post on X + Indie Hackers + any newsletter. Empty GitHub repo exists. Landing page with email capture live.
- [ ] **By EOD Sunday 2026-05-18**: Hit the calibrated waitlist threshold + 5 founder DMs. Decide: ship v0.0 or revisit positioning.
- [ ] **By 2026-05-19 (if Assignment passes)**: Start Week 1 of v0.0 build.
- [ ] **Week 1-2**: Ship Simple Harmonic v0.0. 30-second YouTube demo. HN + PH + X launch.
- [ ] **End of Month 2**: 500 GitHub stars target. If <250, rework positioning.
- [ ] **Weeks 3-12**: v0.1 production with 2 real integrations chosen by alpha users.
- [ ] **Month 3**: 800-star checkpoint. If <800, rework before continuing B.
- [ ] **Month 4**: Lock pricing tiers.
- [ ] **Month 6**: 1.5k GitHub stars (NORTH STAR). Cloud-hosted tier live.
- [ ] **Month 9**: $5k MRR target.
- [ ] **Month 12**: $15k MRR target.
- [ ] **Open Q #6**: Define or drop "OPC workplaces" as a channel within 2 weeks of doc approval.
- [ ] **Open Q #4**: Publish reversibility scope list with v0.1 release.
