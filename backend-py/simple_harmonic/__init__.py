"""Simple Harmonic backend — Python port (FastAPI).

Migration slice 1: settings, app factory, health + platform-status endpoints,
the a2ax core types as Pydantic models, a JSON-file store over the existing
.simple-harmonic/data/ layout, and a couple of contract-shaped domain endpoints
(GET /api/teams, GET /api/tick).
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
