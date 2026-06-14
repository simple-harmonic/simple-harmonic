"""Filesystem tools: read_file (safe) and write_file (destructive).

TS source: packages/backend/src/server/tools/filesystem.ts

Both are jailed via :func:`resolve_in_jail_real`, which is symlink-aware (T3): a
symlink inside the jail that points outside is rejected, not followed.
write_file additionally requires the destructive-tools kill switch
(:func:`tools_enabled`).
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from pydantic import BaseModel, Field

from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.sandbox import (
    JailEscapeError,
    resolve_in_jail_real,
    tools_enabled,
    tools_root,
)
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext

MAX_READ_BYTES = 256 * 1024
UI_SNIPPET_BYTES = 2_000


class ReadFileArgs(BaseModel):
    path: str = Field(
        description=(
            "Path to read, relative to the project working directory. "
            "Use .simple-harmonic/skills/ to browse custom tools, "
            ".simple-harmonic/connectors/ to see configured credentials."
        )
    )


class WriteFileArgs(BaseModel):
    path: str = Field(description="Path to write, relative to the project working directory")
    content: str = Field(description="Full file contents to write")


read_file_def = ToolDefinition(
    name="read_file",
    description=(
        "Read a UTF-8 text file from the project working directory. Returns the file "
        "contents. Paths are relative to the project root; paths escaping it are "
        "rejected. Browse .simple-harmonic/skills/ for custom API tools and "
        ".simple-harmonic/connectors/ for credentials."
    ),
    category="filesystem",
    risk="safe",
    schema=ReadFileArgs,
)


def _rel(abs_path: Path) -> str:
    return os.path.relpath(abs_path, tools_root())


def _err_to_message(tool: str, path: str, err: Exception) -> str:
    if isinstance(err, JailEscapeError):
        return str(err)
    if isinstance(err, FileNotFoundError):
        return f"File not found: {path}"
    if isinstance(err, PermissionError):
        return f"Permission denied: {path}"
    if isinstance(err, IsADirectoryError):
        return f"Path is a directory, not a file: {path}"
    return f"{tool} failed for {path}: {err}"


def _is_sensitive_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    base = os.path.basename(normalized)
    if ".simple-harmonic/secrets.json" in normalized:
        return True
    if normalized.startswith(".apollo/") or normalized == ".apollo":
        return True
    if base.startswith(".env") and not base.endswith((".example", ".sample", ".template")):
        return True
    if base in (".npmrc", ".pypirc", ".netrc"):
        return True
    if base in ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"):
        return True
    if base.endswith(".pem") or base.endswith(".key"):
        return True
    return normalized == ".ssh" or normalized.startswith(".ssh/") or "/.ssh/" in normalized


async def read_file_impl(args: ReadFileArgs, _ctx: ToolRunContext) -> ToolExecResult:
    try:
        abs_path = await resolve_in_jail_real(args.path)
        rel = _rel(abs_path)
        if _is_sensitive_path(rel):
            return ToolExecResult(
                toolName="read_file",
                success=False,
                result=f"Refusing to read sensitive path: {args.path}",
            )
        info = await asyncio.to_thread(os.stat, abs_path)
        if not os.path.isfile(abs_path):
            return ToolExecResult(
                toolName="read_file", success=False, result=f"Not a file: {args.path}"
            )
        if info.st_size > MAX_READ_BYTES:
            return ToolExecResult(
                toolName="read_file",
                success=False,
                result=(
                    f"File too large ({info.st_size} bytes, max {MAX_READ_BYTES}). "
                    "Read a smaller file or a subset."
                ),
            )
        content = await asyncio.to_thread(abs_path.read_text, "utf-8")
        return ToolExecResult(
            toolName="read_file",
            success=True,
            result=content,
            action=ToolResult(
                actionType="file_read",
                payload={
                    "path": _rel(abs_path),
                    "bytes": info.st_size,
                    "output": content[:UI_SNIPPET_BYTES],
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="read_file",
            success=False,
            result=_err_to_message("read_file", args.path, err),
        )


write_file_def = ToolDefinition(
    name="write_file",
    description=(
        "Write a UTF-8 text file in the project working directory, creating parent "
        "directories as needed. Overwrites existing files. Paths are relative to the "
        "project root; paths escaping it are rejected."
    ),
    category="filesystem",
    risk="destructive",
    schema=WriteFileArgs,
)


async def write_file_impl(args: WriteFileArgs, _ctx: ToolRunContext) -> ToolExecResult:
    if not tools_enabled():
        return ToolExecResult(
            toolName="write_file",
            success=False,
            result=(
                "write_file is disabled. Destructive tools require SH_ENABLE_TOOLS to "
                "be set; they remain gated until the approval flow is enabled."
            ),
        )
    try:
        abs_path = await resolve_in_jail_real(args.path)
        await asyncio.to_thread(lambda: abs_path.parent.mkdir(parents=True, exist_ok=True))
        await asyncio.to_thread(abs_path.write_text, args.content, "utf-8")
        return ToolExecResult(
            toolName="write_file",
            success=True,
            result=f"Wrote {len(args.content)} chars to {_rel(abs_path)}",
            action=ToolResult(
                actionType="file_written",
                payload={"path": _rel(abs_path), "chars": len(args.content)},
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="write_file",
            success=False,
            result=_err_to_message("write_file", args.path, err),
        )
