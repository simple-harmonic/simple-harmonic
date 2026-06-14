"""Claude Code CLI backend: ``claude -p --output-format stream-json --verbose``.

TS source: packages/backend/src/server/tools/coding/claude-code.ts
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

        # Assistant message:
        #   { type: "assistant", message: { content: [{ type: "text", text }] } }
        if event.get("type") == "assistant":
            msg = event.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and block.get("text"):
                        messages.append(block["text"])
                    if block.get("type") == "tool_use":
                        inp = block.get("input")
                        inp = inp if isinstance(inp, dict) else {}
                        name = block.get("name") or ""
                        cmd = inp.get("command") or name
                        if cmd:
                            commands.append(
                                CodingCommand(
                                    command=cmd,
                                    output=inp.get("description") or "",
                                    exitCode=0,
                                )
                            )

        # Result: { type: "result", result: "..." }
        if event.get("type") == "result":
            text = event.get("result") or ""
            if text and text not in messages:
                messages.append(text)

        if event.get("type") == "error":
            errors.append(event.get("message") or "Unknown error")

    return CodingResult(messages=messages, commands=commands, errors=errors)


@dataclass
class _ClaudeCodeBackend:
    name: str = "claude-code"

    async def run(self, opts: CodingRunOpts) -> CodingResult:
        argv = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            # Acceptable only because run_subprocess pins cwd inside the tools
            # jail and scrubs the env (coding_env): the agent gets no secrets and
            # cannot escape the jail. coding_task is already gated behind
            # SH_ENABLE_TOOLS.
            "--dangerously-skip-permissions",
            "--no-session-persistence",
        ]
        if opts.model:
            argv += ["--model", opts.model]
        argv.append(opts.task)

        return await run_subprocess(
            "claude",
            argv,
            parse_events,
            cwd=opts.cwd,
            timeout_ms=opts.timeout or DEFAULT_TIMEOUT_MS,
            max_output_bytes=MAX_OUTPUT_BYTES,
            env_keys=["ANTHROPIC_API_KEY"],
            label="claude",
        )


def create_claude_code_backend() -> _ClaudeCodeBackend:
    return _ClaudeCodeBackend()
