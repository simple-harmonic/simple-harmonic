"""Tool sandbox primitives (app side) — T3 hardened.

TS source: packages/backend/src/server/tools/sandbox.ts

Containment for the filesystem + shell tools:
  tools_root()           the jail root (SH_TOOLS_CWD or process cwd)
  tools_enabled()        master switch for DESTRUCTIVE tools (default OFF)
  resolve_in_jail(p)     synchronous LOGICAL containment (no fs); rejects
                         ``..``, absolute paths, null bytes.
  resolve_in_jail_real() async SYMLINK-AWARE containment: realpaths the
                         deepest existing ancestor so a symlink inside the jail
                         can't point out. Use this in the fs tools.
  scrubbed_env()         minimal child-process env with secrets stripped.
  coding_env(extra)      scrubbed_env() + only named, uppercase-validated keys.

Env is read at call time (``os.environ`` / ``os.getcwd()``), NOT through the
cached :class:`~simple_harmonic.settings.Settings`. This mirrors the TS source
(``process.env.SH_TOOLS_CWD || process.cwd()``) and lets a test flip
``SH_TOOLS_CWD`` between calls without clearing a settings cache — the jail must
track the env exactly, since a stale root would be a containment bug.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# Uppercase env-var identifier, e.g. ANTHROPIC_API_KEY. Used to gate the extra
# keys coding_env() is allowed to leak into a coder subprocess.
_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

# The ONLY env vars a scrubbed child process inherits. Everything else
# (every *_API_KEY, *_TOKEN, DATABASE_URL, ...) is withheld.
_SCRUB_ALLOW = ("PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TZ")


def tools_root() -> Path:
    """Root of the filesystem/shell jail. Defaults to the process cwd (the repo
    root in dev). Override with SH_TOOLS_CWD to point agents at a specific
    checkout. All read_file/write_file/run_command paths resolve against this.
    """
    return Path(os.environ.get("SH_TOOLS_CWD") or os.getcwd()).resolve()


def tools_enabled() -> bool:
    """Master kill switch for DESTRUCTIVE tools (write_file, run_command, and
    mutating github_api calls). Default OFF. Set SH_ENABLE_TOOLS=1/true/yes to
    allow them. Read tools are not gated by this."""
    v = (os.environ.get("SH_ENABLE_TOOLS") or "").lower()
    return v in ("1", "true", "yes")


class JailEscapeError(Exception):
    """Thrown when a tool path resolves outside the jail root."""

    def __init__(self, requested: str) -> None:
        super().__init__(
            f'Path "{requested}" resolves outside the allowed working directory'
        )
        self.requested = requested


def _is_contained(root: Path, target: Path) -> bool:
    """True if ``target`` is ``root`` or strictly inside it (textual, no fs)."""
    if target == root:
        return True
    return root in target.parents


def resolve_in_jail(requested_path: str) -> Path:
    """Synchronous LOGICAL containment check. Resolves a user/LLM-supplied path
    against the jail root and guarantees the textual result stays inside it.
    Rejects null bytes, absolute paths, and ``..`` traversal.

    Does NOT follow symlinks — use :func:`resolve_in_jail_real` for the
    symlink-aware check; this is the fast first gate.
    """
    root = tools_root()

    if "\0" in requested_path:
        raise JailEscapeError(requested_path)

    candidate = Path(requested_path)
    # An absolute input is resolved as-is; a relative one against the root.
    # ``Path.resolve`` collapses ``..`` so the containment check below still
    # catches escapes either way.
    abs_path = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()

    if not _is_contained(root, abs_path):
        raise JailEscapeError(requested_path)
    return abs_path


async def resolve_in_jail_real(requested_path: str) -> Path:
    """Symlink-aware containment check. Does the logical check first, then
    realpaths the deepest EXISTING ancestor of the target and re-verifies
    containment. This closes the symlink hole: if any existing path component is
    a symlink that points outside the jail, the realpath'd location fails.

    The non-existent tail (e.g. a write_file target that doesn't exist yet)
    can't be a symlink, so it's safe to append after the realpath'd prefix.

    Returns the logical absolute path; callers read/write through it and the OS
    resolves the now-verified symlinks.
    """
    abs_path = resolve_in_jail(requested_path)
    root = tools_root()

    # Realpath the jail root itself (it may live under a symlink, e.g. /tmp on
    # macOS is a symlink to /private/tmp). Compare real-to-real.
    root_real = _realpath_safe(root)

    effective_real = _realpath_deepest_existing(abs_path)
    if not _is_contained(root_real, effective_real):
        raise JailEscapeError(requested_path)
    return abs_path


def scrubbed_env() -> dict[str, str]:
    """Minimal environment for a child process. Strips known secret-bearing
    vars so a shelled-out command (or anything it execs) can't read credentials
    out of the agent process's environment. Keeps only a small allowlist."""
    out: dict[str, str] = {}
    for key in _SCRUB_ALLOW:
        v = os.environ.get(key)
        if v is not None:
            out[key] = v
    return out


def coding_env(extra_keys: list[str] | None = None) -> dict[str, str]:
    """Environment for a coding-agent subprocess (claude-code/codex/opencode):
    the :func:`scrubbed_env` base allowlist plus ONLY the named provider keys
    the chosen backend needs (e.g. ANTHROPIC_API_KEY). Keeps GITHUB_TOKEN,
    APOLLO_MASTER_KEY, and every other secret OUT of the autonomous coder's
    environment. Keys must be uppercase env-var identifiers; anything else is
    ignored."""
    out = scrubbed_env()
    for key in extra_keys or []:
        if not _ENV_KEY_RE.match(key):
            continue
        v = os.environ.get(key)
        if v is not None:
            out[key] = v
    return out


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _realpath_safe(p: Path) -> Path:
    """``os.path.realpath`` that never raises (mirrors the TS ``.catch(() => root)``)."""
    try:
        return Path(os.path.realpath(p))
    except OSError:
        return p


def _realpath_deepest_existing(abs_path: Path) -> Path:
    """Walk up from ``abs_path`` to the deepest path component that exists on
    disk, realpath that, then re-append the non-existent tail. The result is the
    effective real location the OS would resolve ``abs_path`` to."""
    tail: list[str] = []
    cur = abs_path

    while True:
        if _path_exists(cur):
            real = Path(os.path.realpath(cur))
            for part in reversed(tail):
                real = real / part
            return real
        parent = cur.parent
        if parent == cur:
            # Reached the fs root without finding an existing component
            # (shouldn't happen since "/" exists; guards infinite loops).
            return abs_path
        tail.append(cur.name)
        cur = parent


def _path_exists(p: Path) -> bool:
    """``lstat``-based existence check (does not follow a final symlink)."""
    try:
        os.lstat(p)
        return True
    except OSError:
        return False
