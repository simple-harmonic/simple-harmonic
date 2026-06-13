# Simple Harmonic

An AI cofounder and team for founders. Describe your company, get a team of agents that works while you sleep.

Simple Harmonic turns a founder's vision into a working team of AI agents, supervises them, and gives you override at every layer. The meta-agent (Harmon) manages the team autonomously: reviewing performance, adjusting prompts and tools, restructuring teams, and escalating when something needs human judgment.

## How it works

1. **Chat with Harmon.** Describe your company and what eats your week.
2. **Harmon proposes a team.** Agents are sized to the work, not a preset template.
3. **Agents run on ticks.** Each agent wakes up on a schedule, does its job, reports back.
4. **Harmon reviews hourly.** Reads action history, checks output contracts, adjusts prompts/tools/structure.
5. **You approve destructive actions.** File writes, code changes, API mutations, and team restructuring all require human approval.

## Features

**14 tools** in the agent registry:

| Tool | What it does |
|---|---|
| `read_file` | Read project files + browse `.simple-harmonic/` for skills/connectors |
| `write_file` | Write files (approval required) |
| `run_command` | Allowlisted CLI programs (git, npm, vitest, etc.) |
| `coding_task` | Autonomous coding via Codex, Claude Code, or OpenCode |
| `http_fetch` | GET any public URL |
| `github_api` | GitHub REST API |
| `action_history` | Query action logs and validation results |
| `spawn_sub_team` | Create a sub-team with agents |
| `modify_agent` | Update, delete, or move agents |
| `modify_team` | Rename, set goals, pause, or delete teams |
| `set_team_goal` | Set objectives for a team |
| `send_message` | DM another agent |
| `broadcast` | Message all agents in the team |
| `report_action` | Log to the narration feed |

**Recursive teams.** Teams nest arbitrarily. Promote any agent to a team lead by giving it `spawn_sub_team` and `modify_agent`. Demote by removing them. Mix flat, hierarchical, and delegated management in the same tree.

**Output contracts.** Each agent can have a JSON Schema contract defining what its tick should produce. The runner validates structurally (Tier 1) and feeds pass/fail results back into the next tick prompt. Agents self-correct.

**Autonomous Harmon.** Auto-created on every root team. Runs hourly. Reviews action history across the team tree, identifies persistent failures, adjusts prompts/tools/contracts/structure. Can modify any agent except its own prompt (that requires founder approval) and can never self-delete.

**Dynamic configuration.** Connectors (credentials) and custom API tools live as flat JSON files in `.simple-harmonic/`. Version controlled, human-editable, discoverable via `read_file`. Secrets resolve from `.simple-harmonic/secrets.json` (gitignored) or env vars.

**Three coding backends.** `coding_task` delegates to Codex, Claude Code, or OpenCode. Selectable from Settings > Coding Agent with per-backend model and timeout config.

## Quick start

```bash
git clone https://github.com/simple-harmonic/simple-harmonic.git
cd simple-harmonic
npm install
cp .env.example .env.local
# Set ANTHROPIC_API_KEY or OPENAI_API_KEY (no database required)
npm run dev
```

State is a plain folder of JSON files — no database server. Initialize the data
directory (defaults to `.simple-harmonic/data`, override with `SH_DATA_DIR`):
```bash
npm run data:init                 # creates the data dir skeleton
npm run data:init -- /path/to/dir # or point it elsewhere (persisted to simple-harmonic.config.json)
```

> **Single-writer, single-machine.** The file store assumes one process owns the
> data directory at a time (run *either* `npm run dev` *or* `npm run dev:backend`,
> not both against the same dir). It is not compatible with serverless platforms
> that have an ephemeral, non-shared filesystem (e.g. Vercel) — run the standalone
> backend host on a persistent box instead.

Seed a demo team:
```bash
npx tsx scripts/seed-demo.ts
```

### Backend without the frontend

The whole agent platform (API + tick loop) also runs headless — no Next.js:

```bash
npm run dev:backend
```

This serves the same `/api/*` surface on port 3001 (`SH_BACKEND_PORT` overrides), loads Apollo
secrets, enforces the same operator gate (`OPERATOR_PASSWORD`), and ticks agents every 10s
(`SH_TICK_LOOP=0` to disable, e.g. when an external cron POSTs `/api/tick` with `CRON_SECRET`).
Run it from the repo root so `simple-harmonic.config.json` and `.apollo/` resolve. The Next.js
routes under `src/app/api/` are thin re-exports of the same handlers in
`packages/backend/src/server/api/` — a parity test keeps the two surfaces in sync.

Enable agent tools for dogfooding:
```bash
# In .env.local
SH_ENABLE_TOOLS=1
SH_TOOLS_CWD=/path/to/your/project
```

## Architecture

```
simple-harmonic/
  src/app/                    # Next.js app (pages; API routes re-export backend handlers)
  packages/
    backend/
      src/lib/meta-agent/     # Framework-shaped library (planner, runner, registry, contracts)
      src/server/             # App-specific (DB, tools, connectors, team-tree)
      src/server/api/         # Transport-agnostic HTTP handlers (Request → Response)
      src/server/standalone/  # node:http host: run the backend without Next.js
    frontend/
      src/components/         # React components (sidebar, team dashboard, narration)
    a2ax/                     # Agent-to-agent communication protocol
  .simple-harmonic/
    connectors/               # Credential metadata (JSON)
    skills/                   # Custom API tool definitions (JSON)
    secrets.json              # Secret values (gitignored)
  drizzle/                    # SQL migrations
  scripts/                    # Seed scripts
```

**Library boundary.** `packages/backend/src/lib/meta-agent/` is framework-shaped and extracts cleanly to NPM. It contains the planner, runner, tool registry, and contract validator. No I/O, no DB. The app-specific tools (filesystem, shell, network, management) live in `packages/backend/src/server/tools/`.

**State split.** Everything is files. Runtime state (teams, agents, action log, approvals, a2ax messages, traces, spend) is a domain-aggregate tree of JSON/JSONL under `.simple-harmonic/data/` — a team folder *contains* its agents and sub-teams, so the path encodes the hierarchy. Configuration (connectors, skills, coding backend, app config) lives alongside it as flat files. No database.

## Stack

- Next.js + TypeScript strict
- Tailwind + shadcn/ui
- JSON file store (no database) — domain-aggregate tree under `.simple-harmonic/data/`
- Anthropic Claude / OpenAI via `@anthropic-ai/sdk` and `openai`
- Codex CLI / Claude Code CLI / OpenCode CLI for `coding_task`
- Vitest + Playwright + Biome

## Status

v0.0. Ship target 2026-06-01. Dogfooding infrastructure complete. 582 tests passing.

## License

See LICENSE.
