# Simple Harmonic Backend — Python port

An idiomatic **FastAPI** re-implementation of the Simple Harmonic backend
(`packages/backend` + `packages/a2ax`), sharing the same `.simple-harmonic/data/`
JSON store layout as the TypeScript runtime so the Next.js frontend can talk to
either one. Built as a parallel service — the TS backend is left intact.

**Status: complete.** All 9 migration slices done — **834 tests pass, ruff clean,
~30.6K LOC across 91 modules** — serving the **full contract: all 43 method+path
combos** (incl. the operator gate, `chat`/`narration`/`trace` SSE, the agent tick
orchestrator, and the a2ax protocol). See [MIGRATION.md](MIGRATION.md) for the
per-slice status + the deferred/known divergences, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the stack decision and the 23-item
fidelity risk register.

The whole surface is exercised by an offline pytest suite (the LLM/codex/network
boundaries are mocked) and the app boots under uvicorn.

## TS → Python map

| TypeScript (Node) | Python (FastAPI) |
| --- | --- |
| `packages/backend/src/server/config.ts` | `simple_harmonic/settings.py` (pydantic-settings, same env vars) |
| `packages/backend/src/server/server.ts` / `routes.ts` | `simple_harmonic/app.py` (`create_app`) |
| `packages/backend/src/server/api/teams.ts` | `simple_harmonic/routes/teams.py` |
| `packages/backend/src/server/api/tick.ts` | `simple_harmonic/routes/teams.py` (`tick_*`) |
| `packages/backend/src/server/api/settings/platform-status.ts` | `simple_harmonic/routes/settings.py` |
| `packages/backend/src/server/store/types.ts` | `simple_harmonic/store/types.py` |
| `packages/backend/src/server/store/data-dir.ts` | `simple_harmonic/store/data_dir.py` |
| `packages/backend/src/server/store/fs-store.ts` | `simple_harmonic/store/fs.py` |
| `packages/backend/src/server/store/repos/{teams,platform-status}.ts` + `index-cache.ts` | `simple_harmonic/store/json_store.py` |
| `packages/a2ax/src/types/message.ts` | `simple_harmonic/a2ax/message.py` |
| `packages/a2ax/src/types/task.ts` | `simple_harmonic/a2ax/task.py` |
| `packages/a2ax/src/types/channel.ts` | `simple_harmonic/a2ax/channel.py` |
| `packages/a2ax/src/types/auth.ts` | `simple_harmonic/a2ax/token.py` |
| `packages/a2ax/src/types/agent-card.ts` | `simple_harmonic/a2ax/types.py` |

Field names stay **camelCase** to match the TS JSON wire shape exactly, so the
Next.js frontend can talk to either runtime unchanged. Datetimes serialize to
ISO-8601 strings (same as `JSON.stringify(Date)`).

## Requirements

- Python 3.14
- [uv](https://docs.astral.sh/uv/)

## Setup

```bash
cd backend-py
uv sync
```

## Run the server

```bash
cd backend-py
uv run uvicorn simple_harmonic.app:app --reload --port 8000
```

The store defaults to `<cwd>/.simple-harmonic/data` (override with `SH_DATA_DIR`).
Run it from the repo root, or set `SH_DATA_DIR` to the repo's data dir:

```bash
SH_DATA_DIR=/absolute/path/to/simple-harmonic/.simple-harmonic/data \
  uv run uvicorn simple_harmonic.app:app --port 8000
```

Then:

```bash
curl localhost:8000/health
curl localhost:8000/api/settings/platform-status
curl localhost:8000/api/teams
```

OpenAPI docs: <http://localhost:8000/docs>.

## Tests

```bash
cd backend-py
uv run pytest        # offline — drives the app via httpx ASGITransport, no network
uv run ruff check    # lint
```

## Pointing the Next.js frontend at the Python backend

The Python app serves the same `/api/*` paths the Next.js wrappers re-export.
Two options:

1. **Proxy via `next.config.ts` rewrites** — forward `/api/*` to the Python host:

   ```ts
   // next.config.ts
   const PY_BACKEND = process.env.PY_BACKEND_URL ?? "http://localhost:8000";
   export default {
     async rewrites() {
       return [{ source: "/api/:path*", destination: `${PY_BACKEND}/api/:path*` }];
     },
   };
   ```

   Start the Python backend on `:8000` and run `next dev` as usual; the browser
   keeps calling `/api/*` and Next forwards to FastAPI.

2. **Point the client base URL directly** — if the frontend reads an API base
   URL from env, set it to `http://localhost:8000` (enable CORS first; CORS is
   intentionally not configured in slice 1 to match the TS contract).

As endpoints are ported slice by slice, migrate paths incrementally by routing
only the implemented `/api/*` paths to FastAPI and leaving the rest on Node.
