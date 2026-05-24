# Simple Harmonic — Design System

Source: `docs/mockups/v0.0.html` (approved 2026-05-18 via /plan-design-review)
Direction: Dark theme + amber accent, dev-tool aesthetic
Reference points: Linear, Vercel Dashboard, Raycast, Cursor

---

## Brand architecture

**Simple Harmonic** is the parent company. Story: "Built by agents. Run by agents. Managed by agents. (With you.)"

**Simple Harmonic** is the v0.0 product — your AI cofounder and team. It's the meta-agent platform.

Future products inherit the simple-harmonic-motion theme:

| Layer | Name | Role |
|---|---|---|
| Company | **Simple Harmonic** | Umbrella; AI teams for founders. |
| Pillar 1 (v0.0–v0.1) | **Simple Harmonic** | Meta-agent platform. Simple Harmonics tick; the metaphor maps cleanly to the agent wake-up cycle. |
| Pillar 2 (later) | **Spring** | Cross-device agent-comms layer. Springs connect systems and transfer energy. |
| Pillar 3 (later) | **Resonance** (or Circuit) | Marketplace where agents resonate with founder contexts. |

This doc focuses on Simple Harmonic (v0.0). Spring and Resonance get their own design sub-pages when they enter scope.

## Voice and metaphor (for Simple Harmonic)

**Voice**: calm authority. Opinionated. Dev-tool serious. Pushes back against bad ideas with reasoning, not agreement.
**Metaphor**: simple harmonic motion is the physics of steady oscillation: predictable, sustainable, self-correcting. That's the meta-agent's tick cycle and the founder's daily ops rhythm. The physics is honest about what the product does.

The meta-agent IS the brand voice. Every assistant message in the chat is Simple Harmonic speaking on behalf of Simple Harmonic.

---

## Color tokens (CSS variables)

```css
:root, .dark {
  /* Text */
  --fg: #fafafa;          /* primary text */
  --fg-muted: #a3a3a3;    /* secondary text, descriptions */
  --fg-faint: #525252;    /* tertiary text, timestamps, metadata */

  /* Backgrounds */
  --bg: #0a0a0a;          /* page background */
  --bg-elev: #171717;     /* cards, sidebars, top bar */
  --bg-input: #1f1f1f;    /* input fields, chat input bar */

  /* Borders */
  --border: #262626;        /* default border */
  --border-strong: #404040; /* emphasized border (input focus, active states) */

  /* Brand */
  --accent: #ea580c;        /* primary accent — Tailwind orange-600 */
  --accent-soft: #431407;   /* accent background (badges, hover) */

  /* Semantic / status */
  --running: #4ade80;       /* agent running, success */
  --paused: #525252;        /* agent paused */
  --error: #f87171;         /* error, connection failure */
}
```

**Rules:**

- One accent color only. Never introduce a second brand color.
- Status colors are functional, never decorative.
- No purple, violet, or indigo anywhere — they're the AI-slop tells.
- Light theme deferred. Dark is the only mode in v0.0.

---

## Typography

**Display + body**: Inter (Google Fonts)
**Monospace**: JetBrains Mono (Google Fonts)

```css
font-family: 'Inter', system-ui, sans-serif;
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
```

### Scale

| Use | Size | Weight | Tracking | Line height |
|---|---|---|---|---|
| Display hero | 56px | 600 | -0.025em | 1.05 |
| Surface title (H2 in-app) | 32px | 600 | -0.02em | 1.15 |
| Section label (uppercase) | 14px | 500 | 0.05em | 1.2 |
| Body large (chat) | 15-16px | 400 | 0 | 1.6 |
| Body default | 14-15px | 400 | 0 | 1.6 |
| Body small (descriptions) | 13px | 400 | 0 | 1.5 |
| Mono uppercase label | 11px | 500 | 0.05em | 1.2 |
| Mono timestamp | 11-12px | 400 | 0 | 1.4 |

**Rules:**

- Mono treatment is what makes Simple Harmonic feel like a dev tool. Use mono for timestamps, status labels, file paths, agent counts, anything system-y.
- Never use `system-ui` as the primary display font. Inter is required.
- No serifs. No script fonts.

---

## Spacing

4px base scale. Common values:

| Value | Use |
|---|---|
| 4px | Tightly grouped icon + label |
| 8px | Within a card row |
| 12px | Between related items in a card |
| 16px | Between cards in a grid |
| 24px | Section padding |
| 32px | Major content padding |
| 48-64px | Page-level padding |
| 80px | Vertical rhythm in hero |

**Rules:**

- Cards have 12-14px internal padding, not 20+.
- Top bar always 14px vertical padding.
- Chat message rhythm: 24-32px between messages.

---

## Component patterns

### Chat message — meta-agent

Header row: M-badge (22px square, `--accent-soft` bg, `--accent` border + text, "M" character) + `meta-agent` in `--accent` + timestamp in `--fg-faint` mono.
Body: 15-16px Inter, max 64ch width, color `--fg`.
**Pushback variant**: header gains a `· pushback` mono tag. Used when meta-agent disagrees with user reasoning.

### Chat message — user

Right-aligned. Max 60ch. `--bg-input` background. 1px `--border`. 8px border-radius. 12-16px padding. 15px Inter.

### Chat message — error (inline)

Header row: error-badge (22px square, red-soft bg, `--error` border + text, "!" character) + `connection error` in `--error` + timestamp.
Body: 14px Inter, color `--fg-muted`. Inline Retry button + edit-message link.

### Chat input bar

Anchored bottom of chat view. Container: `--bg-input`, `--border-strong`, 10px border-radius, 4px padding.
Textarea: transparent bg, no border, 12-14px padding, 15px Inter, `resize: none`.
Footer row: 11px mono hint left ("cmd+enter to send"), small accent Send button right.

### Agent card (active team)

12-14px padding. 6px border-radius. 1px `--border`. `--bg-elev`.
Top row: status pill (left) + edit/disable icons (right).
Below: agent name (semibold 13px), description (11px mono `--fg-muted`).

### Status pill

Inline-flex, 6px gap. Color-coded dot (6-8px circle) + mono label (11px).
Colors: running = `--running`, paused = `--paused`, errored = `--error`.

### Narration entry

11px mono timestamp + 13px Inter body. Agent name in semibold (`--fg` for workers, `--accent` for meta-agent). Action description in `--fg-muted`. 14px margin between entries.

### Top bar

14px vertical padding, 24px horizontal. 1px `--border` bottom. `--bg-elev`.
Layout: flex justify-between.
Left: wordmark (14px semibold -0.01em) + path crumb (12px mono `--fg-faint`).
Right: status pill + primary action button.

### Primary button

`--accent` background. White text. 11-12px vertical padding (large) or 7px (top-bar size). 14-22px horizontal. 5-6px border-radius. 13-15px font. 500 weight. No shadow.

### Approval card (chat terminus)

1.5px `--accent` border. `--bg-elev`. 10px border-radius. 20-22px padding.
Top row: eyebrow (accent uppercase mono) + title (17px semibold) left, "click any field to edit" mono right.
Body: vertical agent rows. Each row: 1px `--border`, 10px padding, grid `200px name / 1fr description / 90px schedule`.
Bottom: Spawn button + "keep discussing" link + boot-time mono hint.

---

## Voice and copy

### Meta-agent voice rules

- Calm authority. Never sycophantic. Never apologetic.
- First-person singular ("I'm your cofounder"), never "we" or "the system."
- Pushes back on bad ideas with reasoning, not "I'd reconsider that."
- Short sentences. Lists when listing. Paragraph breaks between thoughts.
- No filler. No "Great question!" No "I'd be happy to."
- Direct: "Six is more than you'll supervise effectively" not "Six might be challenging."
- One question at a time, max two.
- Quotes user-facing terms with single quotes ('shipping question').

### System copy rules

- No "Welcome to..." anywhere.
- No emoji.
- No exclamation marks unless someone is genuinely warning a user.
- "Spawn 4 agents" beats "Get started!" or "Let's go!"
- "Spin up my team" beats "Submit" for primary CTAs.
- Status pills lowercase: `running`, `paused`, `errored`.
- Mono labels UPPERCASE for chrome: `NARRATION`, `META-AGENT`.

---

## Anti-AI-slop rules

Do not use, ever:

1. Purple, violet, or indigo gradients or accents.
2. 3-column feature grids on any landing page or marketing surface.
3. Icons inside colored circles.
4. Centered everything (centered headlines, centered hero copy, centered card grids).
5. Bubbly border-radius on every element (24px+ rounded everywhere).
6. Decorative blobs, floating circles, wavy SVG dividers.
7. Emoji as design elements.
8. Colored left-border on cards.
9. Generic hero copy ("Welcome to...", "Unlock the power of...", "Your all-in-one...").
10. Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA).
11. `system-ui` or `-apple-system` as the primary display font.

If a design instinct lands you on one of these, stop and reconsider.

---

## Layout principles

- **Left-align body text and headlines.** Centered text is the AI-slop signal.
- **One job per view.** Active team view shows the team. Chat view shows the chat. No mixed-mode screens in v0.0.
- **Fixed sidebars over modals.** Narration is always visible, not behind a tab or button.
- **Primary action always top-right** on app surfaces (Pause Team, Resume, Send).
- **Top bar is real estate.** Wordmark, path crumb, status, primary action. Nothing else.

---

## Distribution model

| Version | Surface | Audience | Notes |
|---|---|---|---|
| v0.0 | Web app, OSS | HN / X / Indie Hackers tech audience | Best on desktop. Mobile shows "best on desktop" notice with email capture for future mobile app. |
| v0.2 | Desktop app | Anyone who wants Simple Harmonic without self-hosting | Tauri (Rust shell + the same Next.js web frontend). ~10MB binary. |
| v0.3 | Mobile app | Same audience plus on-the-go users | Capacitor or Tauri Mobile. Same web frontend wrapped. |

The Next.js web frontend is the canonical source of truth for all three distributions. Pillar 2 (agent comms layer) is what keeps desktop + mobile + cloud-hosted backend in sync as one team.

---

## Files that consume this system

- `src/app/globals.css` (v0.0+) — defines the CSS variables above
- `src/app/layout.tsx` — loads Inter + JetBrains Mono fonts
- `src/components/*` — built against these tokens via Tailwind classes
- `docs/mockups/v0.0.html` — the original visual reference

---

## Open polish items (during v0.0 build)

Captured in `TODOS.md` under "Design polish (during v0.0 build)":

- Mobile responsive treatment for v0.1
- Streaming UI for chat messages (token-by-token vs full-message-at-once)
- Spawn transition animation (chat → team view)
- Returning-user chat behavior (resume vs new chat)
- Per-agent active-call loading state
- Touch target sizing for future mobile-app distribution
- Color contrast WCAG audit
- a11y baseline (ARIA landmarks, aria-live narration, keyboard nav)
