# Simple Harmonic — Technical Report

A full technical description of the Simple Harmonic codebase **as it exists at `main @ 0ff84520` (2026-06-13**, PRs #10–#16 merged). It was produced by reading the code; comments, the repo README, and other prose were treated as claims to verify, not as sources. Where a comment or document contradicts the code, these docs describe what the code does and note the discrepancy.

The headline change in this revision is PR #16, which **removed PostgreSQL and Drizzle entirely** and replaced them with a single-process JSON file store on local disk (`packages/backend/src/server/store/`, state under `.simple-harmonic/data/`). There is no longer a database, ORM, SQL schema, or migration mechanism anywhere in the system; [02 — Data Model](02-data-model.md) documents the file store in full, and the persistence-touching chapters (04, 06, 08) were rewritten accordingly.

> **Dual runtime — Python (FastAPI) port.** The body of every chapter describes the TypeScript backend, which remains the documented source of truth. In addition, **each of the 10 chapters now ends with a `## Python backend (FastAPI port)` section** documenting the idiomatic Python/FastAPI re-implementation that lives in this repo's [`backend-py/`](../backend-py/) (raw-SDK + asyncio + Pydantic v2, 834 tests, full 43-endpoint wire parity with the TS host; cut over via the env-gated `next.config.ts` rewrite). Those sections map TS modules to their Python counterparts, call out idiomatic-Python choices (Pydantic vs Zod, asyncio + ASGI vs the Node loop + `node:http`, the store `asyncio.Lock`), and track the fidelity register and the handful of deferred divergences. Start with [`backend-py/ARCHITECTURE.md`](../backend-py/ARCHITECTURE.md) (stack decision, layered design, wire-compatibility rules, fidelity risk register) and [`backend-py/MIGRATION.md`](../backend-py/MIGRATION.md) (slice-by-slice status and the honest list of known divergences).

Conventions used throughout:

- Code references are inline paths with line numbers, e.g. `packages/backend/src/server/api/tick.ts:187`, valid for the tree state above.
- Everything is present tense. There is no roadmap content; "currently unused" marks code that exists but has no caller (grep-verified).
- A previously documented uncommitted work line — the **skills-directory migration** (SKILL.md skill trees with progressive disclosure) — was discarded from the working tree on 2026-06-11; only its untracked files survive in `git stash@{0}`. It is covered by short "Parked" notes in the affected chapters, not by the main narrative (see [01 — Overview, "Repo state and parked work"](01-overview.md)).

## Reading order

Start with the overview, then dive per subsystem:

| # | Document | One-liner |
|---|---|---|
| 01 | [System Overview and Architecture](01-overview.md) | What the system is, runtime topology, the life of a tick, the LLM cascade, security model, env vars, repo state, known gaps |
| 02 | [Data Model and the JSON File Store](02-data-model.md) | The on-disk domain-aggregate layout, the 8 store repos + row types, the location index, the synchronous single-writer durability model, data-dir resolution |
| 03 | [Meta-Agent Engine](03-meta-agent-engine.md) | `lib/meta-agent/`: the resumable runner loop, approval suspension, tool registry, the codex app-server engine mode, the trace contract, the provider cascade, the Harmon planner, adapters, eval harness |
| 04 | [Backend Server Layer](04-server-layer.md) | `server/`: config resolution (`dataDir`), the Apollo secret vault, Codex OAuth reuse, connectors, the custom-tool loader, operator/cron auth, the file-backed spend ledger / app events / trace sink, the JsonFileTransport wiring, team tree |
| 05 | [Tool System](05-tool-system.md) | All 15 built-in tools, filesystem jail, shell allowlist, SSRF guard, the three coding engines, JSON-defined API tools |
| 06 | [HTTP API](06-http-api.md) | All 30 routes and their extracted handlers (`packages/backend/src/server/api/**`); the tick scheduler in depth; chat SSE; the proxy auth gate; deployment config |
| 07 | [Frontend](07-frontend.md) | Pages, the chat/team-view/trace components, polling/SSE cadences, theming, workspace wiring |
| 08 | [A2AX Protocol](08-a2ax-protocol.md) | The agent-messaging library: protocol class, transports (memory + the new JsonFileTransport), task state machine, used vs. dormant surface |
| 09 | [Testing and Tooling](09-testing-and-tooling.md) | Monorepo/package graph, the vitest suite (incl. in-package route-handler tests and host-parity tests), Playwright, Biome, CI, seeds, deploy, README drift, repo state |
| 10 | [Standalone Host](10-standalone-host.md) | The Next-free `node:http` backend host: startup, request bridge, route manifest, auth gate, the `data:init` CLI, parity tests |

## Symbol-level reference

[reference/](reference/README.md) catalogs **every interface, class, function, component, and constant**: signature, exact behavior, what it calls, and grep-verified callers with `path:line`. Its [README](reference/README.md) doubles as the collaboration map — the boundary rules between layers and the runtime flows (tick, chat, approval, messaging, trace, UI loops, startup) traced symbol by symbol.

| File | Scope |
|---|---|
| [reference/meta-agent.md](reference/meta-agent.md) | The engine: runner, planner, registry, adapters, codex app-server + harness, trace contract, cascade, approval, contract, identity, eval |
| [reference/server.md](reference/server.md) | Server layer: config, vault, codex-auth, connectors, custom-tool loader, auth, the JSON file store (repos, fs primitives, location index), spend, LLM resolution, trace sink, events |
| [reference/server-tools.md](reference/server-tools.md) | The 12 I/O tools, sandbox, SSRF guard, coding engines, API-tool runtime |
| [reference/a2ax.md](reference/a2ax.md) | Protocol types, Transport interface, the memory + JsonFileTransport adapters, the A2AX class |
| [reference/http-routes.md](reference/http-routes.md) | Every route handler + helper, the Next wrappers, the standalone host, proxy, instrumentation, seed script |
| [reference/frontend-components.md](reference/frontend-components.md) | Every component/hook/helper in packages/frontend |
| [reference/app-pages.md](reference/app-pages.md) | Every page/layout component in src/app |

## The system in three sentences

A founder logs into a single-password app (Next.js, or the same handlers on a standalone `node:http` host), describes their company to a streaming planner chat ("Harmon"), and approves a proposed team of LLM agents that then run autonomously: a once-a-minute tick wakes each due agent — through a multi-provider LLM cascade (Codex subscription → Anthropic → OpenRouter → OpenAI) or, on the Codex path, an engine-mode turn where a persistent `codex app-server` drives the loop against Simple Harmonic's dynamic tools — feeds it its unread teammate messages and recent history, lets it act through sandboxed tools, and records a play-by-play trace of every step. Any destructive action freezes the agent mid-run into a human approval queue and resumes exactly where it stopped once the founder decides. All state lives in plain JSON/JSONL files on local disk under `.simple-harmonic/data/` (no database — one folder per team, sub-teams nesting recursively inside it); safety comes from a filesystem jail, an SSRF guard with DNS pinning, scrubbed subprocess environments, an isolated agent `CODEX_HOME`, a global daily spend cap, and the default-off `SH_ENABLE_TOOLS` kill switch.
