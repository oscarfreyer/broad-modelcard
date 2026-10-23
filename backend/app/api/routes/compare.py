"""``getComparison``: 2 to 4 cards side by side (contract v1.13, CONTRACT.md §25)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from ...services.comparison import (
    MAX_CARDS,
    MIN_CARDS,
    CardFacts,
    CardRef,
    card_payload,
    card_reasons,
    comparison_rows,
    lens_state,
    parse_cards,
    scope_concepts,
)
from ..params import Age, ChapterIdQuery, Context, Ethnicity, Ontology, Population, Sex, Version, lens_of, require_chapter
from ..problems import ApiError
from ..responses import api_of
from ..schemas import Comparison
from ..views import atlas_view
from . import problems

router = APIRouter(tags=["compare"])

Cards = Annotated[
    str,
    Query(
        min_length=3,
        max_length=1300,
        description=(
            f"{MIN_CARDS} to {MAX_CARDS} distinct card ids, comma-separated: <model_version>|<use_case> each "
            "(URL-encoded). Otherwise 422 invalid_cards; an unknown model or use case is 404."
        ),
    ),
]


@router.get(
    "/compare",
    operation_id="getComparison",
    summary="2 to 4 cards side by side over the chapters, or a chapter's subchapters and conditions, with comparability per row.",
    description=(
        "Each cell is what the atlas map serves for that card at the lens, population, and ontology; each row says "
        "whether the cards' results are directly comparable and, if not, why (reason codes with the cards they "
        "concern; the rule is published in /meta.comparison and CONTRACT.md §25, a prototype heuristic)."
    ),
    response_model=Comparison,
    responses=problems(404, 422),
)
def get_comparison(
    request: Request,
    cards: Cards,
    scope: Annotated[Literal["atlas", "chapter"], Query()] = "atlas",
    chapter_id: ChapterIdQuery = None,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    try:
        pairs = parse_cards(cards)
    except ValueError as error:
        raise ApiError(422, "invalid_cards", str(error)) from None
    chapter_id = require_chapter(scope, chapter_id)
    api = api_of(request)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        dataset = context.dataset
        facts = []
        for model_version, use_case in pairs:
            metrics = view.metrics(model_version, use_case)  # 404 unknown_model / unknown_use_case
            model = dataset.model(model_version)
            variant = next(variant for variant in model.use_cases if variant.use_case == use_case)
            facts.append(
                CardFacts(
                    CardRef(f"{model_version}|{use_case}", model, variant),
                    metrics,
                    view.card_safety(model_version, use_case),
                    lens_state(metrics, lens),
                )
            )
        concepts = scope_concepts(view.catalog, scope, chapter_id)
        shared = card_reasons(facts, lens)
        return {
            "dataset_version": context.label,
            "filters": {
                "context": setting,
                "lens": lens.as_dict(),
                "scope": scope,
                "chapter_id": chapter_id,
                "chapter_pt": view.catalog.chapter(chapter_id).pt if chapter_id else None,
            },
            "cards": [card_payload(dataset, context.catalog.conditions, card, lens) for card in facts],
            "card_reasons": shared,
            "rows": comparison_rows(view, facts, concepts, lens, shared),
        }

    key = ("compare", tuple(pairs), lens, scope, chapter_id)
    return api.json(request, context, Comparison, build, cache_key=key, ontology=view.ref)
