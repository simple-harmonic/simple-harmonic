"""OpenCode CLI backend: ``opencode run --format json -q``.

TS source: packages/backend/src/server/tools/coding/opencode.ts
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

        etype = event.get("type")
        if etype == "text" and event.get("text"):
            messages.append(event["text"])

        if etype == "tool_use":
            inp = event.get("input")
            inp = inp if isinstance(inp, dict) else {}
            cmd = inp.get("command") or event.get("tool") or ""
            if cmd:
                commands.append(
                    CodingCommand(
                        command=cmd,
                        output=(event.get("output") or "")[:2_000],
                        exitCode=event.get("exit_code", 0),
                    )
                )

        if etype == "step_finish" and event.get("reason") == "stop" and event.get("content"):
            messages.append(event["content"])

        if etype == "error":
            errors.append(event.get("message") or event.get("text") or "Unknown error")

    return CodingResult(messages=messages, commands=commands, errors=errors)


@dataclass
class _OpenCodeBackend:
    name: str = "opencode"

    async def run(self, opts: CodingRunOpts) -> CodingResult:
        argv = ["run", "--format", "json", "-q", "--working-dir", opts.cwd]
        if opts.model:
            argv += ["--model", opts.model]
        argv.append(opts.task)

        return await run_subprocess(
            "opencode",
            argv,
            parse_events,
            cwd=opts.cwd,
            timeout_ms=opts.timeout or DEFAULT_TIMEOUT_MS,
            max_output_bytes=MAX_OUTPUT_BYTES,
            env_keys=["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
            label="opencode",
        )


def create_opencode_backend() -> _OpenCodeBackend:
    return _OpenCodeBackend()
