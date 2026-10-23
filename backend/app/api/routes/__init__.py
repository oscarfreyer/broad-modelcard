"""Routers for the read operations of contract v1, one module per contract tag."""

from __future__ import annotations

from typing import Any

from ..schemas import Problem


def problems(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """Declared error responses: the given statuses plus ``default``, all problem details."""
    described = {"description": "Problem details (application/problem+json).", "model": Problem}
    return {**{status: described for status in statuses}, "default": described}
