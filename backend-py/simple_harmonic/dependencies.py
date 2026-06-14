"""FastAPI dependency providers.

The store is created once and stashed on app.state by the app factory; this
provider hands it to route handlers. Overriding it in tests is a one-liner via
`app.dependency_overrides`.
"""

from __future__ import annotations

from fastapi import Request

from simple_harmonic.store.base import Store


def get_store(request: Request) -> Store:
    store: Store = request.app.state.store
    return store
