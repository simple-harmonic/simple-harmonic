"""Tool registry — the plugin surface for agent tools.

TS source: packages/backend/src/lib/meta-agent/registry.ts

A tool has two halves, deliberately split:
  - DEFINITION (name, description, category, risk, pydantic args model) — pure
    data: the LLM tool schema + the approval gate's risk label.
  - IMPLEMENTATION — the async function that does the I/O, registered alongside.

The registry validates LLM-supplied arguments against the args model BEFORE
calling the impl, and converts the model to an OpenAI/JSON-Schema tool def for
the LLM call. Validation happens here so a malformed call becomes a structured
error result the runner can feed back to the model, never a raise.

  register(def, impl)        -> tools: dict[name, (def, impl)]
  get_openai_defs(allowed)   <- pydantic model_json_schema(), OpenAI-shaped
  list_for_agent(allowed)    <- filter to an agent's allowlist
  execute(name, raw, ctx)    -> model_validate -> impl, or structured error
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

from simple_harmonic.tools.types import (
    OpenAIToolDef,
    ToolExecResult,
    ToolImpl,
    ToolRunContext,
)

# Broad grouping used for allowlisting and risk display.
ToolCategory = Literal["internal", "filesystem", "shell", "network"]

# "safe" tools run without approval; "destructive" tools (writes, shell,
# mutating API calls) must pass the approval gate before their impl runs.
ToolRisk = Literal["safe", "destructive"]


@dataclass
class ToolDefinition:
    """The data half of a tool: everything the LLM and approval gate need.

    ``schema`` is the pydantic ``BaseModel`` subclass for the tool's arguments;
    it is both the validator and the source of the tool's JSON Schema.
    ``is_destructive`` is an optional argument-aware risk classifier for tools
    with both read and write modes (receives the parsed args model).
    """

    name: str
    description: str
    category: ToolCategory
    risk: ToolRisk
    schema: type[BaseModel]
    is_destructive: Callable[[Any], bool] | None = None


@dataclass
class _RegisteredTool:
    definition: ToolDefinition
    impl: ToolImpl


def _inline_refs(node: Any, defs: dict[str, Any]) -> Any:
    """Recursively replace ``{"$ref": "#/$defs/Name"}`` nodes with the inlined
    definition. OpenAI/Anthropic tool-parameter blocks don't carry ``$defs``, so
    nested models must be flattened in place."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            target = defs.get(ref[len("#/$defs/") :])
            if target is not None:
                return _inline_refs(target, defs)
        return {k: _inline_refs(v, defs) for k, v in node.items() if k != "$ref"}
    if isinstance(node, list):
        return [_inline_refs(item, defs) for item in node]
    return node


def schema_to_parameters(schema: type[BaseModel]) -> dict[str, Any]:
    """Convert a pydantic args model to a JSON Schema object suitable for an
    OpenAI/Anthropic tool parameter block. Strips the ``$schema`` meta key
    (which the LLM APIs reject) and inlines any ``$defs`` so the result is
    self-contained."""
    json_schema = schema.model_json_schema()
    defs = json_schema.pop("$defs", {})
    json_schema.pop("$schema", None)
    inlined = _inline_refs(json_schema, defs)
    return inlined


class ToolRegistry:
    """Name-keyed registry of (definition, impl) pairs."""

    def __init__(self) -> None:
        self._tools: dict[str, _RegisteredTool] = {}

    def register(self, definition: ToolDefinition, impl: ToolImpl) -> None:
        """Register a tool definition with its implementation. Raises on a
        duplicate name — silent overwrite would let one plugin shadow another's
        tool, a bug that's invisible until an agent calls the wrong code. Fail
        loud at registration instead."""
        if definition.name in self._tools:
            raise ValueError(f'Tool "{definition.name}" is already registered')
        self._tools[definition.name] = _RegisteredTool(definition=definition, impl=impl)

    def has(self, name: str) -> bool:
        return name in self._tools

    def get(self, name: str) -> ToolDefinition | None:
        tool = self._tools.get(name)
        return tool.definition if tool else None

    def list_for_agent(self, allowed: list[str] | None = None) -> list[ToolDefinition]:
        """Definitions for the tools an agent may use. With no allowlist,
        returns all registered tools. With an allowlist, returns only those that
        are both registered and allowed (unknown names are ignored)."""
        defs = [t.definition for t in self._tools.values()]
        if allowed is None:
            return defs
        allow = set(allowed)
        return [d for d in defs if d.name in allow]

    def get_openai_defs(self, allowed: list[str] | None = None) -> list[OpenAIToolDef]:
        """OpenAI-format tool defs for the LLM ``tools`` argument, allowlist-filtered."""
        return [
            {
                "type": "function",
                "function": {
                    "name": d.name,
                    "description": d.description,
                    "parameters": schema_to_parameters(d.schema),
                },
            }
            for d in self.list_for_agent(allowed)
        ]

    def is_destructive(self, tool_name: str, raw_args: Any = None) -> bool:
        """Whether a tool requires human approval before running: True if the
        tool is registered with risk "destructive", OR if it is unknown (fail
        safe — an unrecognized tool name is never auto-approved). For a tool
        with an argument-aware classifier, parse the args and ask it; if the
        args don't validate, fail safe (True)."""
        tool = self._tools.get(tool_name)
        if tool is None:
            return True
        if tool.definition.is_destructive is not None:
            try:
                parsed = tool.definition.schema.model_validate(raw_args)
            except ValidationError:
                return True
            return tool.definition.is_destructive(parsed)
        return tool.definition.risk == "destructive"

    async def execute(
        self, name: str, raw_args: Any, ctx: ToolRunContext
    ) -> ToolExecResult:
        """Validate raw LLM arguments against the tool's args model, then run
        its impl. Never raises: an unknown tool or a validation failure comes
        back as a ``success=False`` result whose ``result`` string explains the
        problem, so the runner can hand it to the LLM for self-correction."""
        tool = self._tools.get(name)
        if tool is None:
            return ToolExecResult(toolName=name, success=False, result=f"Unknown tool: {name}")

        try:
            parsed = tool.definition.schema.model_validate(raw_args)
        except ValidationError as exc:
            issues = "; ".join(
                f"{'.'.join(str(p) for p in err['loc']) or '(root)'}: {err['msg']}"
                for err in exc.errors()
            )
            return ToolExecResult(
                toolName=name,
                success=False,
                result=(
                    f"Invalid arguments for {name}: {issues}. "
                    "Retry with arguments matching the tool schema."
                ),
            )

        return await tool.impl(parsed, ctx)
