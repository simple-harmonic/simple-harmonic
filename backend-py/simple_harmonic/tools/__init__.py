"""Agent tool sandbox + registry — the security core.

TS source: packages/backend/src/server/tools/ + lib/meta-agent/registry.ts.

This package holds the containment primitives every agent-driven side effect
flows through: the filesystem/shell jail (:mod:`sandbox`), the single SSRF
egress policy (:mod:`url_guard`), and the tool registry that validates
LLM-supplied arguments before any impl runs (:mod:`registry`). The actual I/O
tools (filesystem, shell, network, ...) register against that registry.
"""
