"""App-side tool assembly.

TS source: packages/backend/src/server/tools/index.ts

:func:`create_app_registry` returns a :class:`ToolRegistry` loaded with the
internal message-passing tools plus the app-specific filesystem / shell /
coding / network / management / observe tools. :func:`create_app_registry_with_custom_tools`
additionally loads custom API tools from ``.simple-harmonic/skills/*.json`` and
registers them — skipping any name that would shadow a built-in.

Registration order mirrors index.ts createAppRegistry exactly.
"""

from __future__ import annotations

from simple_harmonic.custom_tools import list_custom_tool_files
from simple_harmonic.tools.action_history import action_history_def, action_history_impl
from simple_harmonic.tools.api_tool_runtime import build_api_tool_def, build_api_tool_impl
from simple_harmonic.tools.coding import coding_task_def, coding_task_impl
from simple_harmonic.tools.default_tools import create_default_registry
from simple_harmonic.tools.filesystem import (
    read_file_def,
    read_file_impl,
    write_file_def,
    write_file_impl,
)
from simple_harmonic.tools.management import (
    modify_agent_def,
    modify_agent_impl,
    modify_team_def,
    modify_team_impl,
    set_team_goal_def,
    set_team_goal_impl,
    spawn_sub_team_def,
    spawn_sub_team_impl,
)
from simple_harmonic.tools.network import (
    github_api_def,
    github_api_impl,
    http_fetch_def,
    http_fetch_impl,
)
from simple_harmonic.tools.observe import observe_app_def, observe_app_impl
from simple_harmonic.tools.registry import ToolRegistry
from simple_harmonic.tools.shell import run_command_def, run_command_impl


def create_app_registry() -> ToolRegistry:
    """Build the built-in tool registry (no custom tools from files)."""
    registry = create_default_registry()

    registry.register(read_file_def, read_file_impl)
    registry.register(write_file_def, write_file_impl)
    registry.register(run_command_def, run_command_impl)
    registry.register(coding_task_def, coding_task_impl)
    registry.register(http_fetch_def, http_fetch_impl)
    registry.register(github_api_def, github_api_impl)
    registry.register(set_team_goal_def, set_team_goal_impl)
    registry.register(spawn_sub_team_def, spawn_sub_team_impl)
    registry.register(modify_agent_def, modify_agent_impl)
    registry.register(modify_team_def, modify_team_impl)
    registry.register(action_history_def, action_history_impl)
    registry.register(observe_app_def, observe_app_impl)

    return registry


def create_app_registry_with_custom_tools() -> ToolRegistry:
    """Build the full registry including custom API tools from
    ``.simple-harmonic/skills/*.json``. Synchronous (file reads)."""
    registry = create_app_registry()

    try:
        for tool in list_custom_tool_files():
            if registry.has(tool.name):
                continue
            definition = build_api_tool_def(tool.name, tool.description, tool.config)
            impl = build_api_tool_impl(tool.name, tool.config)
            registry.register(definition, impl)
    except Exception:
        pass

    return registry
