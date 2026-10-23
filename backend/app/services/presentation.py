"""Shape derived rows for the API (openapi.json ``MetricRow`` and ``MetricMap``)."""

from __future__ import annotations

from ..repository import ModelRecord, UseCaseRecord
from ..schema.contract import (
    CONFIGURATION_RECORD_FIELDS,
    DATA_PROTECTION_FIELDS,
    DECLARATION_FIELDS,
    DEFAULT_CONTEXT,
    MEASURE_FIELDS,
)
from . import grading, safety
from .types import MetricValues

MAP_COLUMNS = (
    "concept_id",
    "overall_status",
    "overall_grade",
    "overall_score",
    "performance_status",
    "performance_grade",
    "perf",
    "evidence_status",
    "evidence_grade",
    "intended_use_level",
    "ci_low",
    "ci_high",
    "safety",
    "child_count",
)


def statuses(row: MetricValues | None) -> dict[str, str]:
    return {
        "overall": grading.overall_status(grading.overall_for(row)),
        "performance": grading.performance_status(row),
        "evidence": grading.evidence_status(row),
    }


def map_row(concept_id: str, row: MetricValues | None, safety: str | None = None) -> list:
    """One ``MetricMap`` row carrying all four views (CONTRACT.md §4.5) and the safety mark."""
    return map_row_by_view(concept_id, {"overall": row, "performance": row, "evidence": row, "intended_use": row}, safety)


def map_row_by_view(concept_id: str, rows: dict[str, MetricValues | None], safety: str | None = None) -> list:
    """A ``MetricMap`` row whose columns for each view come from that view's row.

    ``ci_low``/``ci_high`` (contract v1.1) come from the performance row;
    ``safety`` (contract v1.7) is the concept's safety mark, ``serious``,
    ``caution``, or None (CONTRACT.md §18). ``child_count`` (contract v1.10)
    is the rollup's ``provenance.rollup.child_count`` for a block or chapter
    row, else None: 0 marks a rollup without children at the lens, which
    clients present as No data (CONTRACT.md §6, V1).

    Multimorbidity display rows pick the weakest row separately per view
    (CONTRACT.md §8), so one map row can combine several rows.
    """
    overall_row, performance_row, evidence_row = rows["overall"], rows["performance"], rows["evidence"]
    intended_use_row = rows["intended_use"]
    overall = grading.overall_for(overall_row)
    return [
        concept_id,
        grading.overall_status(overall),
        overall.grade,
        overall.score,
        grading.performance_status(performance_row),
        grading.performance_grade(performance_row.perf) if performance_row else None,
        performance_row.perf if performance_row else None,
        grading.evidence_status(evidence_row),
        evidence_row.evidence_grade if evidence_row else None,
        intended_use_row.intended_use_level if intended_use_row else None,
        performance_row.ci_low if performance_row else None,
        performance_row.ci_high if performance_row else None,
        safety,
        rollup_child_count(overall_row),
    ]


def rollup_child_count(row: MetricValues | None) -> int | None:
    """How many conditions a rollup row aggregates at its lens (CONTRACT.md §6); None for other rows."""
    rollup = row.provenance.rollup if row is not None else None
    return rollup.child_count if rollup is not None else None


def _provenance(row: MetricValues) -> dict:
    provenance = row.provenance
    rollup = provenance.rollup
    return {
        "source": provenance.source,
        "anchor_concept_id": provenance.anchor_concept_id,
        "rollup": {"child_count": rollup.child_count, "aggregation": rollup.aggregation} if rollup else None,
        "lens_fallback": provenance.lens_fallback,
        # Contract v1.13 (§26): only a local result says so; public rows keep their shape.
        **({"layer": provenance.layer} if provenance.layer else {}),
    }


def metric_row(
    row: MetricValues, *, model_version: str, use_case: str, context: str = DEFAULT_CONTEXT
) -> dict:
    """The full ``MetricRow`` for the details panel and exports."""
    overall = grading.overall_for(row)
    shown = statuses(row)
    return {
        "concept_id": row.concept_id,
        "model_version": model_version,
        "use_case": use_case,
        "context": context,
        "lens": row.lens.as_dict(),
        "perf": row.perf,
        "ci_low": row.ci_low,
        "ci_high": row.ci_high,
        "performance_grade": grading.performance_grade(row.perf),
        "evidence_grade": row.evidence_grade,
        "evidence_signal": row.evidence_signal,
        "n_samples": row.n_samples,
        "n_sites": row.n_sites,
        "n_studies": row.n_studies,
        "peer_reviewed_studies": row.peer_reviewed_studies,
        "validation_type": row.validation_type,
        "in_intended_use": row.in_intended_use,
        "intended_use_coverage": row.intended_use_coverage,
        "intended_use_level": row.intended_use_level,
        "overall": {"tier": overall.tier, "score": overall.score, "grade": overall.grade},
        "status": shown,
        "warnings": safety.ranked_warnings(row.warnings, row.warning_counts, row.warning_total),
        "safeguards": safety.safeguards(row, use_case, shown["overall"]),
        "provenance": _provenance(row),
    }


# ----------------------------------------------------------------- registry

def entry_fields(model: ModelRecord) -> dict:
    """The entry fields of a registry entry (contract v1.5, CONTRACT.md §11.1),
    and since v1.14 its lineage (§28.2): ``replaces`` when given and
    ``replaced_by`` when not empty, so an entry without lineage reads as before."""
    fields = {
        "kind": model.kind,
        "ai_type": model.ai_type,
        "developer": model.developer,
        "release_date": model.release_date,
        "description": model.description,
        "built_on": list(model.built_on),
    }
    if model.replaces is not None:
        fields["replaces"] = model.replaces
    if model.replaced_by:
        fields["replaced_by"] = list(model.replaced_by)
    return fields


def declarations(variant: UseCaseRecord) -> dict | None:
    """The developer declarations of a configuration, or None when none is given (v1.5).

    The four data-protection declarations (v1.14, §28) follow, all four, only
    when one of them is given: a configuration without them reads as before."""
    declared = {name: getattr(variant, name) for name in DECLARATION_FIELDS}
    protection = {name: getattr(variant, name) for name in DATA_PROTECTION_FIELDS}
    if any(value is not None for value in protection.values()):
        declared.update(protection)
    return declared if any(value is not None for value in declared.values()) else None


def configuration_fields(variant: UseCaseRecord) -> dict:
    """The card's contract v1.14 fields (§28.1) as listModels and the catalogue
    serve them: ``configuration`` (every field of the record) when one of its
    fields is given, and ``performance_measure`` and ``reference_standard``
    when given. Empty for a card without them, so it reads as before."""
    fields: dict = {}
    record = {name: getattr(variant, name) for name in CONFIGURATION_RECORD_FIELDS}
    record["tools"] = list(variant.tools)
    if any(value not in (None, []) for value in record.values()):
        fields["configuration"] = record
    for name in MEASURE_FIELDS:
        value = getattr(variant, name)
        if value is not None:
            fields[name] = value
    return fields


def default_use_case(model: ModelRecord) -> str:
    """The entry's default use case: the stored one, else its first."""
    return model.default_use_case or (model.use_cases[0].use_case if model.use_cases else "")
