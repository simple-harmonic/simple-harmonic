"""Unified coding_task tool.

TS source: packages/backend/src/server/tools/coding/index.ts

One tool surface for all coding backends. The running agent sees ``coding_task``
regardless of whether Codex, Claude Code, or OpenCode executes the work. Backend
selection: the resolved app config's ``codingBackend`` (file > SH_CODING_BACKEND
env > default codex), overridable per call.

coding_task is destructive and gated behind the SH_ENABLE_TOOLS kill switch. The
chosen CLI runs via :func:`run_subprocess` with the scrubbed :func:`coding_env`,
cwd pinned to the tools jail.
"""

from __future__ import annotations

from collections.abc import Callable

from pydantic import BaseModel, Field

from simple_harmonic.config import get_config
from simple_harmonic.tools.coding.claude_code import create_claude_code_backend
from simple_harmonic.tools.coding.codex import create_codex_backend
from simple_harmonic.tools.coding.opencode import create_opencode_backend
from simple_harmonic.tools.coding.types import CodingBackend, CodingResult, CodingRunOpts
from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.sandbox import tools_enabled, tools_root
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext

BACKENDS: dict[str, Callable[[], CodingBackend]] = {
    "codex": create_codex_backend,
    "claude-code": create_claude_code_backend,
    "opencode": create_opencode_backend,
}


def create_coding_backend(name: str | None = None) -> CodingBackend:
    """Select a coding backend by name, defaulting to the resolved config's
    ``codingBackend``. Raises on an unknown name (fail loud)."""
    key = name or get_config().codingBackend
    factory = BACKENDS.get(key)
    if factory is None:
        raise ValueError(
            f'Unknown coding backend "{key}". Available: {", ".join(BACKENDS)}'
        )
    return factory()


def build_summary(result: CodingResult) -> str:
    parts: list[str] = []

    if result.errors:
        parts.append("Errors:\n" + "\n".join(result.errors))

    if result.commands:
        cmd_lines = []
        for c in result.commands:
            line = f"  $ {c.command} → exit {c.exitCode}"
            if c.output:
                indented = "\n    ".join(c.output.split("\n")[:5])
                line += f"\n    {indented}"
            cmd_lines.append(line)
        parts.append(f"Commands run ({len(result.commands)}):\n" + "\n".join(cmd_lines))

    last_message = result.messages[-1] if result.messages else None
    if last_message:
        parts.append(f"Agent conclusion:\n{last_message[:4_000]}")

    return "\n\n".join(parts) or "No output from coding agent."


# ---------------------------------------------------------------------------
# Tool definition + implementation
# ---------------------------------------------------------------------------


class CodingTaskArgs(BaseModel):
    task: str = Field(
        description=(
            "A clear, specific description of what to accomplish. Can be coding "
            "(implement X, fix Y), research (investigate why Z happens), testing (run "
            "the test suite and report failures), or any development task."
        )
    )
    scope: str | None = Field(
        default=None,
        description=(
            "Optional file or directory scope to focus the work (e.g. 'src/lib/meta-agent', "
            "'tests/'). Helps the agent focus on the right area of the codebase."
        ),
    )
    model: str | None = Field(
        default=None, description="Model override. Defaults to the backend's default model."
    )


coding_task_def = ToolDefinition(
    name="coding_task",
    description=(
        "Run an end-to-end coding, research, or testing task using an autonomous coding "
        "agent. The agent can read and write files, run commands, and iterate until the "
        "task is complete. Use for tasks that require multi-file changes, investigation, "
        "test runs, or anything beyond what read_file/write_file/run_command can do "
        "individually. The task prompt should be specific and self-contained."
    ),
    category="shell",
    risk="destructive",
    schema=CodingTaskArgs,
)


async def coding_task_impl(args: CodingTaskArgs, _ctx: ToolRunContext) -> ToolExecResult:
    if not tools_enabled():
        return ToolExecResult(
            toolName="coding_task",
            success=False,
            result="coding_task is disabled. Set SH_ENABLE_TOOLS=1 to enable destructive tools.",
        )

    cfg = get_config()
    cwd = str(tools_root())
    backend = create_coding_backend()
    backend_cfg = cfg.codingConfig.get(cfg.codingBackend)

    task = args.task
    if args.scope:
        task = f"Focus on: {args.scope}\n\n{task}"

    model = args.model or (backend_cfg.model if backend_cfg else None)
    timeout = backend_cfg.timeout * 1000 if backend_cfg and backend_cfg.timeout else None

    try:
        result = await backend.run(
            CodingRunOpts(task=task, cwd=cwd, model=model, timeout=timeout)
        )
        summary = build_summary(result)

        if result.errors and not result.messages:
            return ToolExecResult(toolName="coding_task", success=False, result=summary)

        conclusion = (result.messages[-1] if result.messages else "")[:2_000]
        return ToolExecResult(
            toolName="coding_task",
            success=True,
            result=summary,
            action=ToolResult(
                actionType="coding_task_completed",
                payload={
                    "backend": backend.name,
                    "task": args.task[:500],
                    "scope": args.scope,
                    "commandsRun": len(result.commands),
                    "conclusion": conclusion,
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="coding_task",
            success=False,
            result=f"coding_task failed ({backend.name}): {err}",
        )
