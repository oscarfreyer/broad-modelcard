"""``getAtlasOverview`` and ``getChapter``: the concept skeleton the frontend lays out."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ..params import ConceptIdPath, Ontology, Population, Version
from ..responses import api_of
from ..schemas import AtlasOverview, ChapterDetail
from ..views import atlas_view
from . import problems

router = APIRouter(tags=["atlas"])


@router.get(
    "/atlas/overview",
    operation_id="getAtlasOverview",
    summary="Chapters, blocks, and the top-level conditions needed to lay out the atlas ring (2,400 in ICD-11).",
    response_model=AtlasOverview,
    responses=problems(404),
)
def get_atlas_overview(
    request: Request, version: Version = "live", population: Population = None, ontology: Ontology = None
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    catalog = view.catalog

    def build() -> dict:
        return {
            "dataset_version": context.label,
            "chapters": [catalog.record(concept.concept_id) for concept in catalog.chapters],
            "blocks": [catalog.record(concept.concept_id) for concept in catalog.blocks],
            "conditions": [catalog.record(concept.concept_id) for concept in catalog.conditions],
        }

    return api.json(request, context, AtlasOverview, build, cache_key=("overview",), ontology=view.ref)


@router.get(
    "/atlas/chapters/{chapter_id}",
    operation_id="getChapter",
    summary="One chapter's blocks and every level-2 concept inside it, including deeper categories.",
    response_model=ChapterDetail,
    responses=problems(404),
)
def get_chapter(
    request: Request,
    chapter_id: ConceptIdPath,
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    catalog = view.catalog

    def build() -> dict:
        chapter = catalog.chapter(chapter_id)
        return {
            "dataset_version": context.label,
            "chapter": catalog.record(chapter.concept_id),
            "blocks": [catalog.record(block.concept_id) for block in catalog.blocks_of(chapter.concept_id)],
            "concepts": [
                catalog.record(concept.concept_id)
                for concept in catalog.level_two_by_chapter.get(chapter.concept_id, ())
            ],
        }

    return api.json(request, context, ChapterDetail, build, cache_key=("chapter", chapter_id), ontology=view.ref)
