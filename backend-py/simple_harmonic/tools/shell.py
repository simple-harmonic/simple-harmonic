"""Shell tool: run_command (destructive).

TS source: packages/backend/src/server/tools/shell.ts

The v0.1 floor for shell execution, intentionally conservative:
  - gated behind the destructive kill switch (:func:`tools_enabled`)
  - runs via ``asyncio.create_subprocess_exec`` with a parsed argv (NO shell),
    so metacharacters like ``|``, ``;``, ``&&``, ``$()``, backticks are inert —
    they become literal argv tokens
  - the program must be on a small allowlist
  - cwd is pinned to the jail root
  - hard timeout + output cap + scrubbed env (no secrets reach the child)

The argv/no-shell design is the key safety property: shelling out through
``sh -c`` would reopen command injection that no allowlist can fully close.
"""

from __future__ import annotations

import asyncio
import re

from pydantic import BaseModel, Field

from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.sandbox import scrubbed_env, tools_enabled, tools_root
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext

TIMEOUT_S = 30.0
MAX_OUTPUT_BYTES = 64 * 1024

# Allowlisted programs. Read-mostly dev tooling. Interpreters/package runners
# that can execute arbitrary code (and bypass the allowlist) are excluded.
ALLOWED_PROGRAMS = frozenset(
    {
        "git", "ls", "cat", "rg", "grep", "find", "diff", "tsc", "vitest", "npm",
        "npx", "biome", "echo", "pwd", "wc", "head", "tail", "mkdir", "cp", "mv",
        "sort", "uniq", "tr",
    }
)

# Git subcommand allowlist. Read-only always allowed; write subcommands allowed
# here because run_command itself is destructive and goes through the approval
# gate, so a human approves before any write-capable git op runs.
ALLOWED_GIT_SUBCOMMANDS = frozenset(
    {
        "status", "log", "diff", "show", "rev-parse", "ls-files", "grep", "blame",
        "branch", "stash", "add", "commit", "push", "pull", "fetch", "checkout",
        "switch", "merge", "rebase", "cherry-pick", "restore", "reset", "tag",
    }
)

_ESCAPING_FLAG_RE = re.compile(r"^--(?:git-dir|work-tree|output|exec-path)=")


class RunCommandArgs(BaseModel):
    command: str = Field(
        description=(
            "Program to run (must be on the allowlist, e.g. git, ls, rg, vitest, "
            "npm, biome). No shell features."
        )
    )
    args: list[str] | None = Field(
        default=None,
        description="Arguments passed to the program as a literal argv (not a shell string).",
    )


run_command_def = ToolDefinition(
    name="run_command",
    description=(
        "Run an allowlisted program in the project working directory and return its "
        "output. Arguments are passed as a literal argv — there is no shell, so "
        "pipes/redirection/variable expansion do not work. Allowed: git (read and "
        "write subcommands), ls, cat, rg, grep, find, diff, tsc, vitest, npm, npx, "
        "biome, echo, pwd, wc, head, tail, mkdir, cp, mv, sort, uniq, tr."
    ),
    category="shell",
    risk="destructive",
    schema=RunCommandArgs,
)


def _is_escaping_arg(arg: str) -> bool:
    if "\0" in arg:
        return True
    if arg.startswith("/") or arg == "~" or arg.startswith("~/"):
        return True
    if arg == ".." or arg.startswith("../") or "/../" in arg:
        return True
    return _ESCAPING_FLAG_RE.match(arg) is not None


async def run_command_impl(args: RunCommandArgs, _ctx: ToolRunContext) -> ToolExecResult:
    if not tools_enabled():
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=(
                "run_command is disabled. Destructive tools require SH_ENABLE_TOOLS to "
                "be set; they remain gated until the approval flow is enabled."
            ),
        )

    program = args.command.strip()
    argv = args.args or []

    if program not in ALLOWED_PROGRAMS:
        allowed = ", ".join(sorted(ALLOWED_PROGRAMS))
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=f'Program "{program}" is not allowed. Allowed: {allowed}',
        )

    bad_arg = next((a for a in argv if _is_escaping_arg(a)), None)
    if bad_arg is not None:
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=(
                f'Argument "{bad_arg}" is not allowed because it can access paths '
                "outside the working directory"
            ),
        )

    if program == "git":
        subcommand = argv[0] if argv else None
        if not subcommand or subcommand not in ALLOWED_GIT_SUBCOMMANDS:
            shown = subcommand or "(missing subcommand)"
            return ToolExecResult(
                toolName="run_command",
                success=False,
                result=(
                    f"git {shown} is not allowed. Use read-only git subcommands like "
                    "status, log, diff, show, ls-files, grep, or blame."
                ),
            )

    try:
        proc = await asyncio.create_subprocess_exec(
            program,
            *argv,
            cwd=str(tools_root()),
            env=scrubbed_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=f"Command failed: {program} {' '.join(argv)}\nprogram not found",
        )
    except OSError as err:
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=f"Command failed: {program} {' '.join(argv)}\n{err}",
        )

    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=f"Command timed out after {int(TIMEOUT_S * 1000)}ms: {program} {' '.join(argv)}",
        )

    out = stdout_b.decode("utf-8", errors="replace")
    err_out = stderr_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        return ToolExecResult(
            toolName="run_command",
            success=False,
            result=(
                f"Command failed: {program} {' '.join(argv)}\n{err_out or out}"
            )[:MAX_OUTPUT_BYTES],
        )

    combined = f"{out}\n[stderr]\n{err_out}" if err_out else out
    text = combined[:MAX_OUTPUT_BYTES] or "(no output)"
    return ToolExecResult(
        toolName="run_command",
        success=True,
        result=text,
        action=ToolResult(
            actionType="command_run",
            payload={"command": program, "args": argv, "output": text[:2_000]},
        ),
    )
