"""JSON responses with ``X-Dataset-Version``, strong ETags, and conditional GETs.

A read for a local population (contract v1.10) also carries ``X-Population``
and, in the body, ``population: {id, name}``; default reads carry neither, so
their bodies and ETags are exactly what they were before populations existed.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import Response
from pydantic import BaseModel

from ..publishing.uploads import AdminService
from .store import CachedBody, Store, VersionContext

DATASET_VERSION_HEADER = "X-Dataset-Version"
POPULATION_HEADER = "X-Population"
ONTOLOGY_HEADER = "X-Ontology"


def population_ref(context: VersionContext) -> dict | None:
    """``PopulationRef`` of a context's local population, or None for the default."""
    population = context.population
    return None if population is None else {"id": population.population_id, "name": population.name}


def population_headers(context: VersionContext) -> dict[str, str]:
    population = context.population
    return {} if population is None else {POPULATION_HEADER: population.population_id}


def with_population(context: VersionContext, payload: Any) -> Any:
    """``payload`` with ``population`` added for a local population (default reads unchanged)."""
    ref = population_ref(context)
    return payload if ref is None else {**payload, "population": ref}


def encode(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def strong_etag(body: bytes) -> str:
    return f'"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """``If-None-Match`` uses the weak comparison (RFC 9110 §13.1.2)."""
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    candidates = (candidate.strip() for candidate in if_none_match.split(","))
    return any(candidate.removeprefix("W/") == etag for candidate in candidates)


def read_headers(version_label: str, etag: str) -> dict[str, str]:
    return {DATASET_VERSION_HEADER: version_label, "ETag": etag, "Cache-Control": "no-cache"}


def not_modified(headers: dict[str, str]) -> Response:
    return Response(status_code=304, headers=headers)


class Api:
    """Per-app state: the store, the admin service, and whether responses are
    validated against the models."""

    def __init__(self, store: Store, admin: AdminService | None = None, *, validate_responses: bool = False):
        self.store = store
        self.admin = admin
        self.validate_responses = validate_responses

    def json(
        self,
        request: Request,
        context: VersionContext,
        model: type[BaseModel],
        build: Callable[[], Any],
        *,
        cache_key: tuple | None = None,
        headers: dict[str, str] | None = None,
        ontology: dict | None = None,
        media_type: str = "application/json",
    ) -> Response:
        """Serve ``build()`` as JSON. ``build`` runs under the store lock.

        With a ``cache_key`` the encoded body is reused for the same dataset
        version (or staged upload over it), so a repeated request costs a
        dictionary lookup. ``ontology`` (contract v1.13) is the ``OntologyRef``
        of a read in another ontology than ICD-11: it is named in the body
        (after ``population``) and in ``X-Ontology``, and keys the cache; an
        ICD-11 read passes None and is exactly what it was before.
        """
        key = (*context.cache_key, *cache_key) if cache_key is not None else None
        if key is not None and ontology is not None:
            key = (*key, "ontology", ontology["id"])
        cached = self.store.responses.get(key) if key is not None else None
        if cached is None:
            with self.store.lock:
                payload = with_population(context, build())
                if ontology is not None:
                    payload = {**payload, "ontology": ontology}
            body = encode(payload)
            if self.validate_responses and model is not None:
                model.model_validate_json(body)
            cached = CachedBody(body, strong_etag(body))
            if key is not None:
                self.store.responses.put(key, cached)
        response_headers = {**read_headers(context.label, cached.etag), **population_headers(context), **(headers or {})}
        if ontology is not None:
            response_headers[ONTOLOGY_HEADER] = ontology["id"]
        if etag_matches(request.headers.get("if-none-match"), cached.etag):
            return not_modified(response_headers)
        return Response(cached.body, media_type=media_type, headers=response_headers)


def api_of(request: Request) -> Api:
    return request.app.state.api
