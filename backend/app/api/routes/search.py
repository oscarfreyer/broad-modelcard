"""``searchConcepts`` (CONTRACT.md §9)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from ...assist.interpret import check
from ...assist.service import AssistError
from ...services.interpret import interpret, vocabulary_of
from ..params import Ontology, Population, Version
from ..problems import ApiError
from ..responses import api_of
from ..schemas import HelperInterpretation, InterpretRequest, Interpretation, SearchResults
from .admin import admin_json
from ..views import atlas_view
from . import problems

router = APIRouter(tags=["search"])

DEFAULT_LIMIT = 80


def result_record(record: dict, synonym: str | None) -> dict:
    """A search result: the concept record, and for a synonym match (contract v1.14, §31)
    ``match: "synonym"`` with the ``matched_term``. Other results are the record as before."""
    if synonym is None:
        return record
    return {**record, "match": "synonym", "matched_term": synonym}


@router.get(
    "/search",
    operation_id="searchConcepts",
    summary="Case-insensitive substring search over the classification's codes (ICD-11 by default), concept id, preferred and fully specified name.",
    response_model=SearchResults,
    responses=problems(404, 422),
)
def search_concepts(
    request: Request,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=200)] = DEFAULT_LIMIT,
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    query = q.strip()
    if not query:
        raise ApiError(422, "invalid_query", "Enter an ICD-11 code, a concept id, or part of a name.")
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)

    def build() -> dict:
        hit = view.search.search(query, limit)
        return {
            "query": query,
            "total": hit.total,
            "results": [result_record(view.catalog.record(concept_id), hit.synonyms.get(concept_id)) for concept_id in hit.concept_ids],
        }

    return api.json(request, context, SearchResults, build, cache_key=("search", query, limit), ontology=view.ref)


@router.get(
    "/search/interpret",
    operation_id="interpretQuery",
    summary="Read a plain-language query as chips: AI system, function, conditions, age, sex, ethnicity, care setting (ICD-11).",
    description=(
        "Deterministic rules (CONTRACT.md §31): recognized words become chips with the contract value each names; the "
        "reader sees them and applies them. Conditions are found with the ICD-11 search, synonyms included. Nothing is applied."
    ),
    response_model=Interpretation,
    responses=problems(422),
)
def interpret_query(
    request: Request,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    version: Version = "live",
) -> Response:
    api = api_of(request)
    query = " ".join(q.split())
    if not query:
        raise ApiError(422, "invalid_query", "Enter a few words, for example: heart failure in older women.")
    context = api.store.resolve(version)

    def build() -> dict:
        vocabulary = vocabulary_of(context.dataset.registry, context.dataset.atlas.axes)
        return interpret(query, vocabulary, context.search, context.catalog)

    return api.json(request, context, Interpretation, build, cache_key=("interpret", query))


@router.post(
    "/assist/interpret",
    operation_id="interpretQueryWithHelper",
    summary="Ask the configured helper to read a query as chips; every chip is checked against the vocabularies (optional, off by default).",
    description=(
        "Only when the study helper is configured (CONTRACT.md §20). Sends the query text and the chip vocabularies "
        "(AI systems, functions, lens values, care settings) to the configured provider, nothing else; conditions are "
        "looked up in the ICD-11 search. Chips outside the vocabularies are dropped with a reason (§31)."
    ),
    response_model=HelperInterpretation,
    responses=problems(409, 422, 502),
)
def interpret_query_with_helper(request: Request, body: InterpretRequest) -> Response:
    api = api_of(request)
    query = " ".join(body.q.split())
    if not query:
        raise ApiError(422, "invalid_query", "Enter a few words, for example: heart failure in older women.")
    context = api.store.resolve("live")
    with api.store.lock:
        vocabulary = vocabulary_of(context.dataset.registry, context.dataset.atlas.axes)
    try:
        answer, provider, model = request.app.state.assist.rewrite(query, vocabulary)
    except AssistError as error:
        raise ApiError(error.status, error.code, error.detail) from None
    with api.store.lock:
        chips, unrecognized, dropped = check(answer, query, vocabulary, context.search, context.catalog)
    payload = {"query": query, "chips": chips, "unrecognized": unrecognized, "provider": provider, "model": model, "dropped": dropped}
    return admin_json(request, HelperInterpretation, payload)
