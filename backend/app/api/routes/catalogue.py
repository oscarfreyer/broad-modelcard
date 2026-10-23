"""``getCatalogue``: one tile per configuration (contract v1.6, CONTRACT.md §17)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ..params import Population, Version
from ..responses import api_of
from ..schemas import Catalogue
from . import problems

router = APIRouter(tags=["catalogue"])


@router.get(
    "/catalogue",
    operation_id="getCatalogue",
    summary="Every configuration as one catalogue tile: registry fields, status distributions, chapter snapshot, last update.",
    description=(
        "One tile per registry model and use case, in registry order, at the all-population lens (context Clinical). "
        "Counts cover the depth-1 top-level conditions with the statuses /metrics/map and /metrics/summary serve. "
        "Cached per dataset version (and staged upload)."
    ),
    response_model=Catalogue,
    responses=problems(404),
)
def get_catalogue(request: Request, version: Version = "live", population: Population = None) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    return api.json(request, context, Catalogue, lambda: context.catalogue, cache_key=("catalogue",))
