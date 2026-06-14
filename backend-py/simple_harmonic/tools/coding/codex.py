"""Codex CLI backend: ``codex exec --json -s workspace-write``.

TS source: packages/backend/src/server/tools/coding/codex.ts
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from simple_harmonic.tools.coding.run_subprocess import run_subprocess
from simple_harmonic.tools.coding.types import CodingCommand, CodingResult, CodingRunOpts

DEFAULT_TIMEOUT_MS = 5 * 60_000
MAX_OUTPUT_BYTES = 256 * 1024


def parse_events(jsonl: str) -> CodingResult:
    messages: list[str] = []
    commands: list[CodingCommand] = []
    errors: list[str] = []

    for line in jsonl.split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue

        item = event.get("item")
        if event.get("type") == "item.completed" and isinstance(item, dict):
            if item.get("type") == "agent_message" and item.get("text"):
                messages.append(item["text"])
            if (
                item.get("type") == "tool_call"
                and item.get("command")
                and item.get("status") == "completed"
            ):
                commands.append(
                    CodingCommand(
                        command=item["command"],
                        output=(item.get("aggregated_output") or "")[:2_000],
                        exitCode=item.get("exit_code", -1),
                    )
                )
        err = event.get("error")
        if event.get("type") == "error" and isinstance(err, dict) and err.get("message"):
            errors.append(err["message"])

    return CodingResult(messages=messages, commands=commands, errors=errors)


@dataclass
class _CodexBackend:
    name: str = "codex"

    async def run(self, opts: CodingRunOpts) -> CodingResult:
        argv = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            # workspace-write keeps codex's writes inside the (jailed) cwd; never
            # danger-full-access. cwd is re-asserted in the jail by run_subprocess.
            "-s",
            "workspace-write",
            "-C",
            opts.cwd,
        ]
        if opts.model:
            argv += ["-m", opts.model]
        argv.append(opts.task)

        return await run_subprocess(
            "codex",
            argv,
            parse_events,
            cwd=opts.cwd,
            timeout_ms=opts.timeout or DEFAULT_TIMEOUT_MS,
            max_output_bytes=MAX_OUTPUT_BYTES,
            # Codex auth is file-based (~/.codex/auth.json under HOME, kept by the
            # scrubbed env); forward CODEX_HOME/OPENAI_API_KEY only if set.
            env_keys=["CODEX_HOME", "OPENAI_API_KEY"],
            label="codex",
        )


def create_codex_backend() -> _CodexBackend:
    return _CodexBackend()
