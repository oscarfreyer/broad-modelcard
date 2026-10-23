"""``listStudies`` and ``getStudy``: the study records (contract v1.13, CONTRACT.md §22);
``listEffects``: the intervention effects measured by studies (§27)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import Response
from pydantic.json_schema import SkipJsonSchema

from ...schema.contract import STUDY_ID_PATTERN
from ..params import Version
from ..problems import ApiError
from ..responses import api_of
from ..schemas import EffectList, StudyDetail, StudyList
from . import problems

router = APIRouter(tags=["studies"])


@router.get(
    "/studies",
    operation_id="listStudies",
    summary="The study records of the version, in stored order; optionally those that evaluated one model version.",
    response_model=StudyList,
    responses=problems(404, 422),
)
def list_studies(
    request: Request,
    model: Annotated[
        str | SkipJsonSchema[None],
        Query(min_length=1, description="Only the studies that evaluated this model version (model_version)."),
    ] = None,
    version: Version = "live",
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        studies = context.dataset.studies.records.values()
        return {
            "dataset_version": context.label,
            "studies": [study.as_dict() for study in studies if model is None or study.model_version == model],
        }

    return api.json(request, context, StudyList, build, cache_key=("studies", model))


@router.get(
    "/studies/{study_id}",
    operation_id="getStudy",
    summary="One study record.",
    response_model=StudyDetail,
    responses=problems(404, 422),
)
def get_study(
    request: Request,
    study_id: Annotated[str, Path(pattern=STUDY_ID_PATTERN)],
    version: Version = "live",
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        study = context.dataset.studies.get(study_id)
        if study is None:
            raise ApiError(404, "unknown_study", f"There is no study {study_id!r} in dataset version {context.label}.")
        return {"dataset_version": context.label, "study": study.as_dict()}

    return api.json(request, context, StudyDetail, build, cache_key=("study", study_id))


@router.get(
    "/effects",
    operation_id="listEffects",
    summary=(
        "The intervention effects of the version (what using an AI system changed for patients or care, from a study "
        "that compared care with and without it), in stored order; optionally of one AI system or one card. Never graded."
    ),
    response_model=EffectList,
    responses=problems(404, 422),
)
def list_effects(
    request: Request,
    model: Annotated[
        str | SkipJsonSchema[None],
        Query(min_length=1, description="Only the effects of this AI system (model_version)."),
    ] = None,
    use_case: Annotated[
        str | SkipJsonSchema[None],
        Query(min_length=1, description="Only the effects of this function (use case)."),
    ] = None,
    version: Version = "live",
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        return {
            "dataset_version": context.label,
            "effects": context.dataset.effects.listed(model_version=model, use_case=use_case),
        }

    return api.json(request, context, EffectList, build, cache_key=("effects", model, use_case))
