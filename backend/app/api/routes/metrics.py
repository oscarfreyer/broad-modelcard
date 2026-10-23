"""``getMetricMap``, ``getMetricSummary``, and ``getConceptMetrics``."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ... import repository
from ...services.dataset import Dataset
from ...services.presentation import MAP_COLUMNS, map_row, metric_row
from ...services.studies import appraisal
from ...services.ontology import ProjectedMetrics
from ...services.subgroups import PUBLIC, difference, entry, layered_difference, one_group_lenses, subgroup_summary
from ...services.summary import appraisal_counts, configuration_counts, safety_summary, status_summary, weighted_distribution
from ...services.types import Lens, MetricValues
from ..params import (
    Age,
    ChapterIdQuery,
    Context,
    ConceptIdPath,
    Ethnicity,
    Model,
    Ontology,
    Scope,
    Sex,
    SummaryViewQuery,
    SummaryWeightsQuery,
    Population,
    UseCase,
    Version,
    lens_of,
    require_chapter,
)
from ..responses import api_of
from ..schemas import ConceptMetrics, ConceptSubgroups, MetricMap, MetricSummary, SubgroupSummary
from ..views import AtlasView, atlas_view
from . import problems

router = APIRouter(tags=["metrics"])


def card_configuration_id(dataset: Dataset, model: str, use_case: str) -> str | None:
    """The card's current configuration id (contract v1.14, §28.1), or None when it states none."""
    variant = next((variant for variant in dataset.model(model).use_cases if variant.use_case == use_case), None)
    return variant.configuration_id if variant is not None else None


def filters(model: str, use_case: str, lens: Lens) -> dict:
    # The response's `context` is the lens's setting (contract v1.14, §29): Clinical (Any setting) unless one was asked for.
    return {"model": model, "use_case": use_case, "context": lens.setting, "lens": lens.as_dict()}


@router.get(
    "/metrics/map",
    operation_id="getMetricMap",
    summary="Compact per-concept statuses for all four metric views, for coloring the ring.",
    description=(
        "scope=atlas returns blocks (rollups) and top-level conditions; scope=chapter returns the chapter's blocks "
        "and level-2 concepts (deeper concepts resolve through their metric anchor). All four views are returned "
        "so switching the metric view needs no request."
    ),
    response_model=MetricMap,
    responses=problems(404, 422),
)
def get_metric_map(
    request: Request,
    model: Model,
    use_case: UseCase,
    scope: Scope,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    chapter_id: ChapterIdQuery = None,
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    chapter_id = require_chapter(scope, chapter_id)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        metrics = view.metrics(model, use_case)
        safety = view.card_safety(model, use_case)
        concepts = view.catalog.scope(scope, chapter_id)
        body = {
            "dataset_version": context.label,
            "filters": filters(model, use_case, lens),
            "columns": list(MAP_COLUMNS),
            "rows": [
                map_row(concept.concept_id, metrics.row(concept.concept_id, lens), safety.mark(concept, lens))
                for concept in concepts
            ],
        }
        if view.projection is not None:
            # Contract v1.13: each row's crosswalk kind, aligned with rows (null for rollups).
            body["mapping"] = view.projection.map_mappings(concepts)
        elif context.dataset.has_local_results(model, use_case):
            # Contract v1.13 (§26): which rows come from local results, aligned with rows.
            body["layer"] = [metrics.layer(concept.concept_id, lens) for concept in concepts]
        # 2026-10-21 (§22): which rows rest on a study record, aligned with rows; only when one does.
        appraisal = [metrics.appraisal(concept.concept_id, lens) for concept in concepts] if metrics.links_studies else []
        if any(appraisal):
            body["appraisal"] = appraisal
        return body

    key = ("map", model, use_case, lens, scope, chapter_id)
    return api.json(request, context, MetricMap, build, cache_key=key, ontology=view.ref)


@router.get(
    "/metrics/summary",
    operation_id="getMetricSummary",
    summary="Status counts over all top-level conditions and per chapter, for the ring centre and the Summary highlights.",
    response_model=MetricSummary,
    responses=problems(404, 422),
)
def get_metric_summary(
    request: Request,
    model: Model,
    use_case: UseCase,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    view: SummaryViewQuery = "overall",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
    weights: SummaryWeightsQuery = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    atlas = atlas_view(api.store, context, ontology)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        metrics = atlas.metrics(model, use_case)
        if view == "safety":
            summary = safety_summary(atlas.catalog, atlas.card_safety(model, use_case), lens)
        else:
            summary = status_summary(atlas.catalog, metrics, lens, view)
        if atlas.projection is not None:
            # Contract v1.13: the conditions by crosswalk kind; `none` ones count as no_data above.
            summary["mapping_counts"] = atlas.projection.mapping_counts(atlas.catalog.conditions)
        counts = appraisal_counts(atlas.catalog, metrics, lens)
        if counts is not None:
            # 2026-10-21 (§22): graded conditions and those with a study record behind them.
            summary["appraisal_counts"] = counts
            # Contract v1.14 (§28.5): those linked conditions by the configuration their studies evaluated.
            summary["configuration_counts"] = configuration_counts(
                atlas.catalog, metrics, lens, card_configuration_id(context.dataset, model, use_case), context.dataset.studies
            )
        if weights is not None:
            # Contract v1.14 (§30): each status's share of the prevalence weight; only when asked,
            # so every read without the parameter keeps its bytes.
            summary["weighted_distribution"] = weighted_distribution(
                atlas.catalog, metrics, atlas.card_safety(model, use_case), lens, view
            )
        return {"dataset_version": context.label, "filters": filters(model, use_case, lens), **summary}

    key = ("summary", model, use_case, lens, view) + (("weights", weights) if weights is not None else ())
    return api.json(request, context, MetricSummary, build, cache_key=key, ontology=atlas.ref)


@router.get(
    "/metrics/concepts/{concept_id}",
    operation_id="getConceptMetrics",
    summary=(
        "Full metric row with grades, statuses, warnings, safeguards, and provenance for one concept "
        "(chapter, block, or condition), and the safety incidents that apply to it."
    ),
    response_model=ConceptMetrics,
    responses=problems(404, 422),
)
def get_concept_metrics(
    request: Request,
    concept_id: ConceptIdPath,
    model: Model,
    use_case: UseCase,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    lens = lens_of(age, sex, ethnicity, setting)

    def build() -> dict:
        metrics = view.metrics(model, use_case)
        concept = view.catalog.concept(concept_id)
        body = {
            "dataset_version": context.label,
            "concept": view.catalog.record(concept.concept_id),
            "path": view.catalog.path(concept),
            "metrics": served_row(view, metrics, model, use_case, concept, lens),
            "incidents": view.card_safety(model, use_case).concept_incidents(concept, lens),
        }
        # Contract v1.13 (§27): intervention effects, only when there are any, so a
        # store or card without effects answers exactly as before. Never graded.
        effects = view.card_effects(model, use_case).concept_effects(concept)
        if effects:
            body["effects"] = effects
        if view.projection is not None:
            body.update(ontology_fields(view, concept))
        if (body["metrics"] or {}).get("provenance", {}).get("layer") == "local":
            # Contract v1.13 (§26): the public row beside a local one, so the card shows both.
            body["public_metrics"] = public_row(view, model, use_case, concept, lens)
        return body

    key = ("concept", concept_id, model, use_case, lens)
    return api.json(request, context, ConceptMetrics, build, cache_key=key, ontology=view.ref)


def served_row(view: AtlasView, metrics, model: str, use_case: str, concept, lens: Lens) -> dict | None:
    """The served ``MetricRow`` of a concept with its data source (§11.3) and
    (v1.13, §22) its appraisal. In another ontology (v1.13) a mapped
    condition's source and appraisal are its ICD-11 row's."""
    row = metrics.row(concept.concept_id, lens)
    if row is None:
        return None
    dataset = view.context.dataset
    source_row = metrics.icd11_row(concept.concept_id, lens) if view.projection is not None and concept.level == 2 else row
    served = metric_row(row, model_version=model, use_case=use_case, context=row.lens.setting)
    served["provenance"]["data_source"] = data_source(dataset, model, use_case, source_row)
    add_appraisal(served, dataset, use_case, source_row)
    return served


def public_row(view: AtlasView, model: str, use_case: str, concept, lens: Lens) -> dict | None:
    """The served public ``MetricRow`` of a concept that reads a local result
    (contract v1.13, §26): the card's public rows under the same prevalence,
    with their source and appraisal (in another ontology through the
    crosswalk, like the local row); null when there is none."""
    return served_row(view, public_metrics_of(view, model, use_case), model, use_case, concept, lens)


def ontology_fields(view: AtlasView, concept) -> dict:
    """``mapping`` and, for a condition, ``other_parents`` of a concept read in another ontology (v1.13)."""
    fields = {"mapping": view.projection.mapping_payload(concept)}
    if concept.level == 2:
        fields["other_parents"] = view.projection.other_parents(concept)
    return fields


@router.get(
    "/metrics/concepts/{concept_id}/subgroups",
    operation_id="getConceptSubgroups",
    summary=(
        "One concept's result at all patients and at every one-group lens (one specific age, sex, or ethnicity "
        "group, the other axes at All), with a difference flag per group (CONTRACT.md §24)."
    ),
    response_model=ConceptSubgroups,
    responses=problems(404, 422),
)
def get_concept_subgroups(
    request: Request,
    concept_id: ConceptIdPath,
    model: Model,
    use_case: UseCase,
    setting: Context = "Clinical",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    # Contract v1.13 (§23, §24): in another ontology the concept resolves as in getConceptMetrics.
    view = atlas_view(api.store, context, ontology)

    def build() -> dict:
        dataset = context.dataset
        metrics = view.metrics(model, use_case)
        safety = view.card_safety(model, use_case)
        concept = view.catalog.concept(concept_id)
        all_lens = Lens(setting=setting)
        projected_condition = view.projection is not None and concept.level == 2
        # Contract v1.13 (§24, §26): with local results for the chosen population every entry names
        # its layer, and a group is compared only with an all-patients result of the same layer.
        layered = dataset.has_local_results(model, use_case)

        def layer_of(source, lens, row) -> str | None:
            if row is None:
                return None
            return source.layer(concept.concept_id, lens) or PUBLIC

        def result(source, axis: str, group: str | None, lens) -> tuple[dict, object, str | None]:
            row = source.row(concept.concept_id, lens)
            data = None
            if row is not None:
                # A mapped condition's source is its ICD-11 row's, as in getConceptMetrics.
                source_row = source.icd11_row(concept.concept_id, lens) if projected_condition else row
                data = data_source(dataset, model, use_case, source_row) if source_row is not None else None
            layer = layer_of(source, lens, row) if layered else None
            served = entry(axis, group, lens, row, safety=safety.mark(concept, lens), data_source=data, **({"layer": layer} if layered else {}))
            return served, row, layer

        reference, reference_row, reference_layer = result(metrics, "all", None, all_lens)
        public_reference = public_reference_row = None
        if layered and reference_layer not in (None, PUBLIC):
            public = public_metrics_of(view, model, use_case)
            public_reference, public_reference_row, _ = result(public, "all", None, all_lens)
        groups = []
        for axis, value, lens in one_group_lenses(dataset.atlas.axes, setting):
            served, row, layer = result(metrics, axis, value, lens)
            if layered:
                served["difference"] = layered_difference(row, layer, reference_row, reference_layer, public_reference_row)
            else:
                served["difference"] = difference(row, reference_row)
            groups.append(served)
        body = {
            "dataset_version": context.label,
            "concept": view.catalog.record(concept.concept_id),
            "filters": {"model": model, "use_case": use_case, "context": setting},
            "all_patients": reference,
            **({"public_all_patients": public_reference} if public_reference is not None else {}),
            "groups": groups,
        }
        if view.projection is not None:
            body["mapping"] = view.projection.mapping_payload(concept)
        return body

    key = ("subgroups", concept_id, model, use_case, setting)
    return api.json(request, context, ConceptSubgroups, build, cache_key=key, ontology=view.ref)


@router.get(
    "/metrics/subgroups/summary",
    operation_id="getSubgroupSummary",
    summary=(
        "For every one-group lens, how many of a card's depth-1 ICD-11 conditions have a result in the group, have "
        "none, and differ from all patients by the Across groups rule (CONTRACT.md §24). A heuristic, never a grade."
    ),
    response_model=SubgroupSummary,
    responses=problems(404, 422),
)
def get_subgroup_summary(
    request: Request,
    model: Model,
    use_case: UseCase,
    setting: Context = "Clinical",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    # Contract v1.14 (§24): ontology is validated like every read, but the counts are always over the
    # ICD-11 depth-1 conditions (classification_basis), so the answer does not depend on it.
    api.store.ontology_tables(ontology)

    def build() -> dict:
        dataset = context.dataset
        metrics = dataset.metrics(model, use_case)
        layered = dataset.has_local_results(model, use_case)
        counts = subgroup_summary(
            context.catalog.conditions,
            dataset.atlas.axes,
            metrics,
            dataset.public_metrics(model, use_case) if layered else None,
            layered=layered,
            setting=setting,
        )
        return {
            "dataset_version": context.label,
            "filters": {"model": model, "use_case": use_case, "context": setting},
            "classification_basis": "icd11",
            **counts,
        }

    return api.json(request, context, SubgroupSummary, build, cache_key=("subgroup-summary", model, use_case, setting))


def public_metrics_of(view: AtlasView, model: str, use_case: str):
    """The card's public rows without local results (contract v1.13, §26), in the view's ontology."""
    public = view.context.dataset.public_metrics(model, use_case)
    return ProjectedMetrics(view.projection, public) if view.projection is not None else public


def add_appraisal(served: dict, dataset: Dataset, use_case: str, row: MetricValues) -> None:
    """Add ``appraisal`` (contract v1.13, CONTRACT.md §22) to a served row when a
    linked study entered it; a row without one keeps exactly its earlier shape."""
    provenance = row.provenance
    concept_id = provenance.anchor_concept_id if provenance.source == "anchor" else row.concept_id
    # An aggregated row of another ontology (§23) has no ICD-11 concept; its appraisal needs none.
    found = appraisal(dataset.studies, row, concept=dataset.atlas.by_id.get(concept_id), use_case=use_case)
    if found is not None:
        served["appraisal"] = found


def data_source(dataset: Dataset, model: str, use_case: str, row: MetricValues) -> dict | None:
    """Where a served row's values come from (contract v1.7, CONTRACT.md §11.3).

    Only for a stored row at the requested lens (a condition, or a deeper
    category through its anchor); aggregated rows (rollups, lens fallback)
    have none.
    """
    provenance = row.provenance
    if provenance.lens_fallback or provenance.source not in ("condition", "anchor"):
        return None
    concept_id = row.concept_id if provenance.source == "condition" else provenance.anchor_concept_id
    if provenance.layer == "local":
        set_id = dataset.local_set_id(model, use_case)  # contract v1.13 (§26): the local results set
    else:
        set_id = dataset.state.metric_sets[(model, use_case)]
    combo_idx = dataset.atlas.axes.combo_index(row.lens)
    return repository.row_source(dataset.connection, "metric_row_provenance", set_id, (combo_idx, concept_id)).as_dict()
