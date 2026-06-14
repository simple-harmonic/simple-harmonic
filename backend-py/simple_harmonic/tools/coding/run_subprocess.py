"""Shared subprocess lifecycle for the coding CLIs (claude-code/codex/opencode).

TS source: packages/backend/src/server/tools/coding/run-subprocess.ts

Each adapter previously copy-pasted spawn/timeout/buffer/exit handling. They now
all delegate here, which single-sources the security posture:
  - env is :func:`coding_env(env_keys)`: scrubbed base + only the named provider keys
  - cwd is re-asserted inside the tools jail (:func:`resolve_in_jail`) before spawn
  - stdout truncation drops whole leading lines, never a mid-JSONL-record cut

Only the command, argv, and ``parse_events`` differ per backend.

SHELL-FREE: the program is spawned via ``asyncio.create_subprocess_exec`` with a
literal argv — never a shell string — exactly like the rest of the tool sandbox.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from simple_harmonic.tools.coding.types import CodingResult
from simple_harmonic.tools.sandbox import coding_env, resolve_in_jail

STDERR_CAP = 8_192


async def run_subprocess(
    cmd: str,
    argv: list[str],
    parse_events: Callable[[str], CodingResult],
    *,
    cwd: str,
    timeout_ms: int,
    max_output_bytes: int,
    env_keys: list[str],
    label: str,
) -> CodingResult:
    """Spawn a coding CLI, stream its stdout/stderr under caps, and parse the
    collected JSONL via ``parse_events``.

    Behavior mirrors the TS implementation:
      - cwd is re-validated in the jail; an escape raises before spawn.
      - timeout kills the child and returns the PARTIAL parse plus a
        "Timed out after Ns" error (never raises).
      - a spawn failure returns a result whose ``errors`` explains it.
      - on a non-zero exit with no parsed messages, stderr (or an exit-code
        message) is appended to ``errors``.
    """
    # Re-assert containment: never hand an unvalidated cwd to the child, even
    # though the caller passes tools_root() today.
    real_cwd = resolve_in_jail(cwd)

    try:
        proc = await asyncio.create_subprocess_exec(
            cmd,
            *argv,
            cwd=str(real_cwd),
            env=coding_env(env_keys),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, OSError) as err:
        return CodingResult(
            messages=[], commands=[], errors=[f"Failed to spawn {label}: {err}"]
        )

    stdout_box: dict[str, str] = {"stdout": "", "stderr": ""}

    async def pump_stdout() -> None:
        assert proc.stdout is not None
        # Newline-delimited JSON: keep only the last ~max_output_bytes, trimmed
        # to a line boundary so a mid-record cut never corrupts the next parse.
        async for raw in proc.stdout:
            stdout_box["stdout"] += raw.decode("utf-8", errors="replace")
            buf = stdout_box["stdout"]
            if len(buf) > max_output_bytes:
                cut_from = len(buf) - max_output_bytes
                nl = buf.find("\n", cut_from)
                stdout_box["stdout"] = buf[nl + 1 :] if nl >= 0 else buf[cut_from:]

    async def pump_stderr() -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            if len(stdout_box["stderr"]) < STDERR_CAP:
                room = STDERR_CAP - len(stdout_box["stderr"])
                stdout_box["stderr"] += raw.decode("utf-8", errors="replace")[:room]

    pumps = asyncio.gather(pump_stdout(), pump_stderr())

    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout_ms / 1000)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        await pumps
        partial = parse_events(stdout_box["stdout"])
        partial.errors.append(f"Timed out after {timeout_ms / 1000}s")
        return partial

    await pumps

    result = parse_events(stdout_box["stdout"])
    if proc.returncode != 0 and not result.messages:
        result.errors.append(
            stdout_box["stderr"] or f"{label} exited with code {proc.returncode}"
        )
    return result
