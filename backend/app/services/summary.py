"""Status counts over the top-level conditions (openapi.json ``MetricSummary``)."""

from __future__ import annotations

from ..schema.contract import STATUSES
from .catalog import Catalog
from .incidents import SAFETY_LEVELS, CardSafety
from .jsnum import is_finite, to_fixed
from .metrics import MetricsService
from .presentation import statuses
from .types import Lens

INTENDED_USE_LEVELS = ("in_scope", "partially_in_scope", "out_of_scope")


def _empty_counts() -> dict[str, int]:
    return dict.fromkeys(STATUSES, 0)


def appraisal_counts(catalog: Catalog, metrics, lens: Lens) -> dict | None:
    """``MetricSummary.appraisal_counts`` (2026-10-21, CONTRACT.md §22): of the depth-1
    conditions with an evidence grade at the lens (``graded``), how many rest on a stored row
    linked to a study record (``linked``, the map's ``appraisal`` not null). None when none is
    linked, so a card or store without linked studies answers exactly as before."""
    if not metrics.links_studies:
        return None
    graded = linked = 0
    for condition in catalog.conditions:
        row = metrics.row(condition.concept_id, lens)
        if row is None or row.evidence_grade is None:
            continue
        graded += 1
        if metrics.appraisal(condition.concept_id, lens) is not None:
            linked += 1
    return {"graded": graded, "linked": linked} if linked else None


# Contract v1.14 (CONTRACT.md §28.5): the configuration a linked study evaluated, against the card's.
CONFIGURATION_STATES = ("current", "earlier", "not_stated")


def configuration_state(studies: list, card_configuration_id: str | None) -> str:
    """Evidence age of one result (§28.5): ``current`` when every study behind it evaluated the
    card's current configuration, ``earlier`` when one evaluated another configuration, else
    ``not_stated`` (a study states none, or the card states no configuration id, so no
    study's configuration can be placed). Information only: never a grade."""
    if card_configuration_id is None or not studies:
        return "not_stated"
    states = {
        "not_stated" if study is None or study.configuration_id is None else "current" if study.configuration_id == card_configuration_id else "earlier"
        for study in studies
    }
    return "earlier" if "earlier" in states else "not_stated" if "not_stated" in states else "current"


def configuration_counts(catalog: Catalog, metrics, lens: Lens, card_configuration_id: str | None, studies) -> dict | None:
    """``MetricSummary.configuration_counts`` (contract v1.14, CONTRACT.md §28.5): of the depth-1
    conditions ``appraisal_counts`` counts as ``linked``, how many rest on studies of the card's
    current configuration, of an earlier one, or of one not stated. Sent with ``appraisal_counts``
    and only then, so every other read is unchanged. In another ontology a condition reads the
    studies of the ICD-11 conditions it serves. ``studies`` is the version's ``StudyIndex``."""
    if not metrics.links_studies:
        return None
    icd = getattr(metrics, "icd", metrics)
    projection = getattr(metrics, "projection", None)
    counts = dict.fromkeys(CONFIGURATION_STATES, 0)
    linked = 0
    for condition in catalog.conditions:
        row = metrics.row(condition.concept_id, lens)
        if row is None or row.evidence_grade is None or metrics.appraisal(condition.concept_id, lens) is None:
            continue
        linked += 1
        anchors = projection.anchors.get(condition.concept_id, ()) if projection is not None else (condition.concept_id,)
        study_ids = [study_id for anchor in anchors for study_id in icd.condition_study_ids(anchor, lens)]
        counts[configuration_state([studies.get(study_id) for study_id in study_ids], card_configuration_id)] += 1
    return counts if linked else None


def status_summary(catalog: Catalog, metrics: MetricsService, lens: Lens, view: str) -> dict:
    """Counts per status over the depth-1 conditions, overall and per chapter.

    For ``intended_use``, which has no grades, a condition counts as
    ``no_data`` (no row, or no intended-use value, contract v1.11) or
    ``out_of_scope``; strong, moderate, and weak stay zero, and every
    condition with an intended-use level is counted by level in
    ``intended_use_counts``, which is null for a card without an
    intended-use statement.
    """
    counts = _empty_counts()
    intended_use_counts = dict.fromkeys(INTENDED_USE_LEVELS, 0)
    chapters: dict[str, dict] = {}
    for condition in catalog.conditions:
        row = metrics.row(condition.concept_id, lens)
        if view == "intended_use":
            if row is None or row.intended_use_level is None:
                status = "no_data"
            else:
                intended_use_counts[row.intended_use_level] += 1
                status = "out_of_scope" if row.intended_use_level == "out_of_scope" else None
        else:
            status = statuses(row)[view]
        chapter = chapters.get(condition.chapter_id)
        if chapter is None:
            chapter = chapters[condition.chapter_id] = {
                "chapter_id": condition.chapter_id,
                "total": 0,
                "counts": _empty_counts(),
            }
        chapter["total"] += 1
        if status is not None:
            counts[status] += 1
            chapter["counts"][status] += 1

    summary = {"view": view, "total": len(catalog.conditions), "counts": counts}
    if view == "intended_use":
        summary["intended_use_counts"] = intended_use_counts if metrics.intended_use_defined else None
    summary["chapters"] = [chapters[chapter.concept_id] for chapter in catalog.chapters if chapter.concept_id in chapters]
    return summary



def prevalence_weight(condition) -> float:
    """§6's rollup weight of one condition: its prevalence score (the local population's
    for a population read, §21), and 1 when the score is missing, not finite, or not positive."""
    score = condition.prevalence_score
    return score if is_finite(score) and score > 0 else 1


def weighted_distribution(catalog: Catalog, metrics: MetricsService, card: CardSafety, lens: Lens, view: str) -> dict[str, float]:
    """``MetricSummary.weighted_distribution`` (contract v1.14, CONTRACT.md §30): each status's
    share of the prevalence weight of the depth-1 conditions (§6's weights), so common
    conditions count for more. The keys follow the view's own counts: the five statuses of
    ``counts`` for overall, performance, and evidence; the intended-use levels and ``no_data``
    for intended use; the safety marks of ``safety_counts`` for safety. Shares are rounded to
    4 decimals (they sum to 1 up to that rounding). Information only, never a grade."""
    if view == "intended_use":
        weights = dict.fromkeys((*INTENDED_USE_LEVELS, "no_data"), 0.0)
    elif view == "safety":
        weights = dict.fromkeys(SAFETY_LEVELS, 0.0)
    else:
        weights = dict.fromkeys(STATUSES, 0.0)
    for condition in catalog.conditions:
        if view == "safety":
            key = card.mark(condition, lens) or "none"
        else:
            row = metrics.row(condition.concept_id, lens)
            if view == "intended_use":
                key = "no_data" if row is None or row.intended_use_level is None else row.intended_use_level
            else:
                key = statuses(row)[view]
        weights[key] += prevalence_weight(condition)
    total = sum(weights.values())
    return {key: to_fixed(value / total, 4) if total > 0 else 0.0 for key, value in weights.items()}


def safety_summary(catalog: Catalog, card: CardSafety, lens: Lens) -> dict:
    """``view=safety`` (contract v1.7): conditions by safety mark at ``lens``.

    ``safety_counts`` counts ``serious``, ``caution``, and ``none`` (no open or
    mitigated incident applies) over the depth-1 conditions, overall and per
    chapter. ``counts`` stays all zero: safety marks are not statuses.
    """
    counts = dict.fromkeys(SAFETY_LEVELS, 0)
    chapters: dict[str, dict] = {}
    for condition in catalog.conditions:
        level = card.mark(condition, lens) or "none"
        counts[level] += 1
        chapter = chapters.get(condition.chapter_id)
        if chapter is None:
            chapter = chapters[condition.chapter_id] = {
                "chapter_id": condition.chapter_id,
                "total": 0,
                "counts": _empty_counts(),
                "safety_counts": dict.fromkeys(SAFETY_LEVELS, 0),
            }
        chapter["total"] += 1
        chapter["safety_counts"][level] += 1
    return {
        "view": "safety",
        "total": len(catalog.conditions),
        "counts": _empty_counts(),
        "safety_counts": counts,
        "chapters": [chapters[chapter.concept_id] for chapter in catalog.chapters if chapter.concept_id in chapters],
    }
