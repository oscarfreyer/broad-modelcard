"""``getMeta`` and ``listModels``."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ... import repository
from ...schema.contract import ANY_SETTING, STATUSES, SYNTHETIC_DATA_NOTICE
from ...services.grading import (
    EVIDENCE_SIGNAL_WEIGHTS,
    OVERALL_SCORE_WEIGHTS,
    OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE,
    STATUS_BANDS,
)
from ...services.dataset import Dataset
from ...services.studies import EVIDENCE_STUDY_ADJUSTMENTS
from ...services.subgroups import SUBGROUP_DIFFERENCE
from ...services.comparison import COMPARISON_META
from ...services.ontology import meta_ontologies
from ...services.presentation import configuration_fields, declarations, default_use_case, entry_fields
from ..params import Version
from ..responses import api_of
from ..schemas import Meta, ModelRegistry
from . import problems

router = APIRouter(tags=["meta"])


def stored_settings(dataset: Dataset, model_version: str, use_case: str) -> dict:
    """``{"settings": [...]}`` for a card whose public metrics store a specific care setting
    (contract v1.14, CONTRACT.md §29), Any setting first; ``{}`` otherwise, so the entries of
    every other card keep their bytes."""
    set_id = dataset.state.metric_sets.get((model_version, use_case))
    if set_id is None:
        return {}
    settings = dataset.atlas.axes.settings_of(repository.set_combo_indices(dataset.connection, set_id))
    return {"settings": settings} if any(setting != ANY_SETTING for setting in settings) else {}


def default_model_version(dataset: Dataset) -> str:
    registry = dataset.registry
    return registry.default_model_version or (registry.models[0].model_version if registry.models else "")


@router.get(
    "/meta",
    operation_id="getMeta",
    summary="Axes, status vocabulary and bands, chapters, dataset version, synthetic-data notice.",
    response_model=Meta,
    responses=problems(),
)
def get_meta(request: Request, version: Version = "live") -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        axes = context.dataset.atlas.axes
        return {
            "api_version": "1",
            "dataset_version": context.label,
            "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
            "default_model_version": default_model_version(context.dataset),
            "axes": {"context": list(axes.context), "age": list(axes.age), "sex": list(axes.sex), "ethnicity": list(axes.ethnicity)},
            "statuses": list(STATUSES),
            "status_bands": STATUS_BANDS,
            "overall_score_weights": OVERALL_SCORE_WEIGHTS,
            # Contract v1.11: rows without an intended-use value.
            "overall_score_weights_without_intended_use": OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE,
            "chapters": [context.catalog.record(chapter.concept_id) for chapter in context.catalog.chapters],
            # Contract v1.10: the local populations a read can name with population=<id>.
            "populations": repository.population_summaries(context.dataset.connection, context.dataset.state),
            # Contract v1.13 (CONTRACT.md §4.2, §22): the evidence signal's weights and a linked study's adjustments.
            "evidence_signal_weights": EVIDENCE_SIGNAL_WEIGHTS,
            "evidence_study_adjustments": EVIDENCE_STUDY_ADJUSTMENTS,
            # Contract v1.13 (CONTRACT.md §24): when getConceptSubgroups flags a group; not a grade.
            "subgroup_difference": SUBGROUP_DIFFERENCE,
            # Contract v1.13: the ontologies the atlas reads accept (ICD-11 first, the default).
            "ontologies": meta_ontologies(
                context.dataset.atlas, repository.load_atlas_meta(context.dataset.connection), api.store.ontology_infos()
            ),
            # Contract v1.13 (CONTRACT.md §25): getComparison's comparability rule, a prototype heuristic.
            "comparison": COMPARISON_META,
            # Contract v1.13 (CONTRACT.md §26): who runs this copy of the tool.
            "instance": repository.load_instance(context.dataset.connection),
        }

    return api.json(request, context, Meta, build, cache_key=("meta",))


@router.get(
    "/models",
    operation_id="listModels",
    summary="Model registry with use-case variants.",
    response_model=ModelRegistry,
    responses=problems(),
)
def list_models(request: Request, version: Version = "live") -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        dataset = context.dataset
        models = []
        for model in dataset.registry.models:
            use_cases = [
                {
                    "use_case": variant.use_case,
                    "has_multimorbidity": dataset.has_multimorbidity(model.model_version, variant.use_case),
                    "function_category": variant.function_category,
                    "declarations": declarations(variant),
                    "intended_use_defined": variant.intended_use_defined,
                    **configuration_fields(variant),  # contract v1.14 (§28.1), only when given
                    # Contract v1.14 (§29): the settings the card stores rows for, only when one is specific.
                    **stored_settings(dataset, model.model_version, variant.use_case),
                }
                for variant in model.use_cases
            ]
            models.append(
                {
                    "model_version": model.model_version,
                    "model_name": model.model_name,
                    "model_release": model.model_release,
                    "display_name": model.display_name,
                    "status": model.status or "ACTIVE",
                    "default_use_case": default_use_case(model),
                    "use_cases": use_cases,
                    **entry_fields(model),
                }
            )
        return {"default_model_version": default_model_version(dataset), "models": models}

    return api.json(request, context, ModelRegistry, build, cache_key=("models",))

