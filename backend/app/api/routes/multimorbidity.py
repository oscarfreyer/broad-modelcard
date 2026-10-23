"""``getMultimorbidityCandidates`` and ``getMultimorbidityCombination`` (CONTRACT.md §8)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ...services.catalog import Catalog
from ...services.presentation import MAP_COLUMNS, map_row_by_view, metric_row
from ..params import (
    Age,
    ChapterIdQuery,
    Context,
    Ethnicity,
    Model,
    Scope,
    Selected,
    Sex,
    Population,
    UseCase,
    Version,
    lens_of,
    parse_selected,
    require_chapter,
)
from ..problems import ApiError
from ..responses import api_of
from ..schemas import MultimorbidityCandidates, MultimorbidityCombination
from .metrics import filters
from . import problems

router = APIRouter(tags=["multimorbidity"])


def canonical_selection(catalog: Catalog, selected: tuple[str, ...]) -> list[str]:
    """Selected conditions as depth-1 anchors, deduplicated, in selection order.

    Unknown ids are a 404; chapters and blocks are ignored, as in the reference.
    """
    canonical: dict[str, None] = {}
    for concept_id in selected:
        concept = catalog.concept(concept_id)
        if concept.level == 2:
            canonical.setdefault(catalog.atlas.canonical_condition_id(concept), None)
    return list(canonical)


@router.get(
    "/multimorbidity/candidates",
    operation_id="getMultimorbidityCandidates",
    summary="Concepts that can start (no selection) or extend the selected combination, with display statuses for coloring.",
    response_model=MultimorbidityCandidates,
    responses=problems(404, 422),
)
def get_candidates(
    request: Request,
    model: Model,
    use_case: UseCase,
    scope: Scope,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    selected: Selected = None,
    chapter_id: ChapterIdQuery = None,
    version: Version = "live",
    population: Population = None,
) -> Response:
    api = api_of(request)
    selection = parse_selected(selected)
    chapter_id = require_chapter(scope, chapter_id)
    context = api.store.resolve(version, population)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        service = context.dataset.multimorbidity(model, use_case)
        canonical = canonical_selection(context.catalog, selection)
        concepts = context.catalog.scope(scope, chapter_id)
        display = service.display_rows(concepts, selection, lens)
        safety = context.dataset.card_safety(model, use_case)
        rows = [
            map_row_by_view(concept.concept_id, display[concept.concept_id], safety.mark(concept, lens))
            for concept in concepts
            if any(display[concept.concept_id].values())
        ]
        return {
            "dataset_version": context.label,
            "has_multimorbidity": service.has_data,
            "selected": canonical,
            "combination_key": service.combination_key(canonical),
            "candidate_ids": service.candidate_ids(selection, setting),
            "display": {
                "dataset_version": context.label,
                "filters": filters(model, use_case, lens),
                "columns": list(MAP_COLUMNS),
                "rows": rows,
            },
        }

    key = ("candidates", model, use_case, lens, selection, scope, chapter_id)
    return api.json(request, context, MultimorbidityCandidates, build, cache_key=key)


@router.get(
    "/multimorbidity/combination",
    operation_id="getMultimorbidityCombination",
    summary="The stored metric row for the exact selected combination (two or more conditions).",
    response_model=MultimorbidityCombination,
    responses=problems(404, 422),
)
def get_combination(
    request: Request,
    model: Model,
    use_case: UseCase,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    selected: Selected = None,
    version: Version = "live",
    population: Population = None,
) -> Response:
    api = api_of(request)
    selection = parse_selected(selected)
    context = api.store.resolve(version, population)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        service = context.dataset.multimorbidity(model, use_case)
        canonical = canonical_selection(context.catalog, selection)
        if len(canonical) < 2:
            raise ApiError(422, "invalid_selection", "Select at least two different conditions.")
        key = service.combination_key(canonical)
        combination = service.combinations.get(key)
        row = service.row(canonical, lens)
        return {
            "dataset_version": context.label,
            "selected": canonical,
            "combination_key": key,
            "combination_label": combination.label if combination else None,
            "metrics": metric_row(
                row, model_version=model, use_case=use_case, context=setting
            )
            if row is not None
            else None,
        }

    key = ("combination", model, use_case, lens, selection)
    return api.json(request, context, MultimorbidityCombination, build, cache_key=key)
