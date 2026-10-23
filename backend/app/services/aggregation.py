"""Row aggregation: rollups (CONTRACT.md §6), demographic fallback (§7), and the
"weakest row" rule used by multimorbidity display (§8).

Ported from ``generateRollupMetricRow``, ``aggregateWarnings``,
``aggregateConditionRows``, ``nearestByScore``, and ``weakestMetricRow`` in
src/data/tableDataset.js (v0.2.0-alpha.1). Loop order is kept because float
sums depend on it.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Sequence

from ..schema.contract import CDSS_USE_CASES, IN_SCOPE, OUT_OF_SCOPE, PARTIALLY_IN_SCOPE
from . import grading
from .decode import derive_evidence_fields, intended_use_level_from_coverage
from .jsnum import clamp, is_finite, js_round, mean, percentile, to_fixed, weighted_mean
from .types import Lens, MetricValues, Provenance, Rollup

GRADE_ORDER = {"A": 6, "B": 5, "C": 4, "D": 3, "E": 2, "F": 1}


def nearest_validation_type(score: float | None) -> str | None:
    if not is_finite(score):
        return None
    selected = None
    min_delta = math.inf
    for option, option_score in grading.VALIDATION_TYPE_SCORES.items():
        delta = abs(option_score - score)
        if delta < min_delta:
            min_delta = delta
            selected = option
    return selected


def aggregate_warnings(child_rows: Sequence[MetricValues], in_intended_use: bool | None, use_case: str) -> tuple[str, ...]:
    counts: dict[str, int] = {}
    for row in child_rows:
        for warning in row.warnings:
            counts[warning] = counts.get(warning, 0) + 1
    threshold = max(1, math.ceil(len(child_rows) * 0.3))
    warnings = [warning for warning, count in counts.items() if count >= threshold]
    if in_intended_use is False and "out_of_scope_group" not in warnings:
        warnings.append("out_of_scope_group")
    if use_case in CDSS_USE_CASES:
        warnings.append("conservative_rollup_p20")
    return tuple(sorted(set(warnings)))


_NOT_FULLY_IN_SCOPE = frozenset({PARTIALLY_IN_SCOPE, OUT_OF_SCOPE})

# Warnings that describe the aggregate itself, not its rows: no share.
_AGGREGATE_WARNINGS = frozenset({"conservative_rollup_p20"})


def warning_counts(rows: Sequence[MetricValues], codes: Sequence[str]) -> tuple[tuple[str, int], ...]:
    """How many of ``rows`` carry each of ``codes`` (contract v1.4, ``Warning.share``).

    ``out_of_scope_group`` also counts rows that are not fully in scope, since
    an aggregate adds it for them (§6, §7) even when they do not carry the code;
    rows without an intended-use value (contract v1.11) are not counted for it.
    """
    counted = []
    for code in codes:
        if code in _AGGREGATE_WARNINGS:
            continue
        if code == "out_of_scope_group":
            count = sum(1 for row in rows if code in row.warnings or row.intended_use_level in _NOT_FULLY_IN_SCOPE)
        else:
            count = sum(1 for row in rows if code in row.warnings)
        counted.append((code, count))
    return tuple(counted)


def study_adjustment(rows: Sequence[MetricValues], weights: Sequence[float] | None = None) -> float:
    """The mean study adjustment of aggregated rows (contract v1.13, CONTRACT.md §22):
    prevalence-weighted for a rollup, unweighted for a lens fallback; rows
    without a linked study count 0. Exactly 0 when no row is linked."""
    values = [row.study_adjustment or 0.0 for row in rows]
    if not any(values):
        return 0.0
    return weighted_mean(values, weights) if weights is not None else mean(values)


def rollup_row(
    *,
    concept_id: str,
    chapter_no: str | None,
    lens: Lens,
    use_case: str,
    child_rows: Sequence[MetricValues],
    child_weights: Sequence[float | None],
    intended_use_defined: bool = True,
) -> MetricValues:
    """``generateRollupMetricRow`` for a block or chapter.

    Intended use (contract v1.11) is aggregated over the children that have an
    intended-use value; it is None when none has one, and always None on a
    card without an intended-use statement (``intended_use_defined`` False),
    also for a rollup without children.
    """
    is_cdss = use_case in CDSS_USE_CASES
    prevalence_values = [weight if is_finite(weight) else 0 for weight in child_weights]
    weights = [value if value > 0 else 1 for value in prevalence_values]

    stated = [row for row in child_rows if row.intended_use_level is not None]
    if intended_use_defined and (stated or not child_rows):
        in_scope = sum(1 for row in stated if row.intended_use_level == IN_SCOPE)
        partial = sum(1 for row in stated if row.intended_use_level == PARTIALLY_IN_SCOPE)
        coverage = to_fixed(clamp((in_scope + 0.5 * partial) / max(1, len(stated)), 0, 1), 4)
        level = intended_use_level_from_coverage(coverage)
        in_intended_use = level != OUT_OF_SCOPE
    else:
        coverage = level = in_intended_use = None

    child_perf, perf_weights = [], []
    half_widths, ci_weights = [], []
    sample_counts, site_counts, sample_weights = [], [], []
    study_counts, peer_counts, type_scores = [], [], []
    for row, weight in zip(child_rows, weights):
        if is_finite(row.perf):
            child_perf.append(row.perf)
            perf_weights.append(weight)
        if is_finite(row.ci_low) and is_finite(row.ci_high):
            half_widths.append((row.ci_high - row.ci_low) / 2)
            ci_weights.append(weight)
        if is_finite(row.n_samples) and is_finite(row.n_sites):
            sample_counts.append(row.n_samples)
            site_counts.append(row.n_sites)
            sample_weights.append(weight)
        if is_finite(row.n_studies):
            study_counts.append(row.n_studies)
        elif is_finite(row.n_samples):
            inferred = grading.estimate_study_count(row.n_samples, row.validation_type or "benchmark")
            if is_finite(inferred):
                study_counts.append(inferred)
        if is_finite(row.peer_reviewed_studies):
            peer_counts.append(row.peer_reviewed_studies)
        type_score = grading.VALIDATION_TYPE_SCORES.get(grading.normalize_validation_type(row.validation_type))
        if is_finite(type_score):
            type_scores.append(type_score)

    if not child_perf:
        perf = None
    elif is_cdss:
        perf = to_fixed(percentile(child_perf, 0.2))
    else:
        perf = to_fixed(weighted_mean(child_perf, perf_weights))

    weighted_prevalence = weighted_mean(prevalence_values, weights)

    ci_low = ci_high = None
    if perf is not None and half_widths:
        half_width = weighted_mean(half_widths, ci_weights)
        if is_cdss:
            half_width += 0.006
        ci_low = to_fixed(clamp(perf - half_width, 0, perf))
        ci_high = to_fixed(clamp(perf + half_width, perf, 1))

    n_samples = max(24, js_round(weighted_mean(sample_counts, sample_weights))) if sample_counts else None
    n_sites = max(1, js_round(weighted_mean(site_counts, sample_weights))) if site_counts else None
    validation_type = nearest_validation_type(mean(type_scores) if type_scores else None)
    if study_counts:
        n_studies = max(1, js_round(mean(study_counts)))
    else:
        n_studies = grading.estimate_study_count(n_samples, validation_type or "benchmark")
    if peer_counts:
        peer_reviewed = clamp(js_round(mean(peer_counts)), 0, n_studies or 0)
    else:
        peer_reviewed = grading.estimate_peer_reviewed_count(n_studies, validation_type or "benchmark")

    evidence = derive_evidence_fields(
        validation_type=validation_type,
        n_studies=n_studies,
        n_sites=n_sites,
        peer_reviewed_studies=peer_reviewed,
        n_samples=n_samples,
        prevalence_score=weighted_prevalence,
        use_case=use_case,
        chapter_no=chapter_no,
        fallback_evidence_grade=None,
        has_validation_data=perf is not None
        and n_samples is not None
        and n_sites is not None
        and bool(validation_type),
        study_adjustment=(adjustment := study_adjustment(child_rows, weights)),
    )

    warnings = aggregate_warnings(child_rows, in_intended_use, use_case)
    return MetricValues(
        concept_id=concept_id,
        lens=lens,
        perf=perf,
        ci_low=ci_low,
        ci_high=ci_high,
        evidence_grade=evidence.evidence_grade,
        n_samples=n_samples,
        n_sites=n_sites,
        n_studies=evidence.n_studies,
        peer_reviewed_studies=evidence.peer_reviewed_studies,
        validation_type=evidence.validation_type,
        in_intended_use=in_intended_use,
        intended_use_coverage=coverage,
        intended_use_level=level,
        warnings=warnings,
        # A rollup without children has nothing to count (§6, "No children").
        warning_counts=warning_counts(child_rows, warnings) if child_rows else None,
        warning_total=len(child_rows) or None,
        provenance=Provenance(
            source="rollup",
            lens_fallback=any(row.provenance.lens_fallback for row in child_rows),
            rollup=Rollup(child_count=len(child_rows), aggregation="p20" if is_cdss else "weighted_mean"),
        ),
        evidence_signal=evidence.evidence_signal,
        study_adjustment=adjustment or None,
    )


def aggregate_lens_rows(
    rows: Sequence[MetricValues],
    *,
    concept_id: str,
    lens: Lens,
    use_case: str,
    prevalence_score: float | None,
    chapter_no: str | None,
    provenance: Provenance,
) -> MetricValues | None:
    """``aggregateConditionRows``: unweighted mean over the expanded lens rows (§7)."""
    if not rows:
        return None
    if len(rows) == 1:
        return replace(rows[0], lens=lens, provenance=provenance)

    in_count = out_count = 0
    perf_sum = ci_low_sum = ci_high_sum = sample_sum = site_sum = study_sum = peer_sum = type_score_sum = 0.0
    perf_n = ci_low_n = ci_high_n = sample_n = site_n = study_n = peer_n = type_score_n = 0
    warnings: dict[str, None] = {}
    for row in rows:
        if row.intended_use_level == IN_SCOPE:
            in_count += 1
        elif row.intended_use_level == OUT_OF_SCOPE:
            out_count += 1
        if is_finite(row.perf):
            perf_sum += row.perf
            perf_n += 1
        if is_finite(row.ci_low):
            ci_low_sum += row.ci_low
            ci_low_n += 1
        if is_finite(row.ci_high):
            ci_high_sum += row.ci_high
            ci_high_n += 1
        if is_finite(row.n_samples):
            sample_sum += row.n_samples
            sample_n += 1
        if is_finite(row.n_sites):
            site_sum += row.n_sites
            site_n += 1
        if is_finite(row.n_studies):
            study_sum += row.n_studies
            study_n += 1
        if is_finite(row.peer_reviewed_studies):
            peer_sum += row.peer_reviewed_studies
            peer_n += 1
        type_score = grading.VALIDATION_TYPE_SCORES.get(grading.normalize_validation_type(row.validation_type))
        if is_finite(type_score):
            type_score_sum += type_score
            type_score_n += 1
        for warning in row.warnings:
            warnings.setdefault(warning, None)

    # Intended use over the rows that have a value (contract v1.11); None when none has.
    total = sum(1 for row in rows if row.intended_use_level is not None)
    if not total:
        level = coverage = None
    elif in_count == total:
        level = IN_SCOPE
    elif out_count == total:
        level = OUT_OF_SCOPE
    else:
        level = PARTIALLY_IN_SCOPE
    if total:
        coverage = (in_count + 0.5 * (total - in_count - out_count)) / total
    if level is not None and level != IN_SCOPE:
        warnings.setdefault("out_of_scope_group", None)
    else:
        warnings.pop("out_of_scope_group", None)

    perf = to_fixed(perf_sum / perf_n) if perf_n else None
    n_samples = max(24, js_round(sample_sum / sample_n)) if sample_n else None
    n_sites = max(1, js_round(site_sum / site_n)) if site_n else None
    validation_type = nearest_validation_type(type_score_sum / type_score_n if type_score_n else None)
    if study_n:
        n_studies = max(1, js_round(study_sum / study_n))
    else:
        n_studies = grading.estimate_study_count(n_samples, validation_type or "benchmark")
    if peer_n:
        peer_reviewed = clamp(js_round(peer_sum / peer_n), 0, n_studies or 0)
    else:
        peer_reviewed = grading.estimate_peer_reviewed_count(n_studies, validation_type or "benchmark")

    evidence = derive_evidence_fields(
        validation_type=validation_type,
        n_studies=n_studies,
        n_sites=n_sites,
        peer_reviewed_studies=peer_reviewed,
        n_samples=n_samples,
        prevalence_score=prevalence_score if is_finite(prevalence_score) else None,
        use_case=use_case,
        chapter_no=chapter_no,
        fallback_evidence_grade=None,
        has_validation_data=perf is not None and bool(validation_type),
        study_adjustment=(adjustment := study_adjustment(rows)),
    )

    return MetricValues(
        concept_id=concept_id,
        lens=lens,
        perf=perf,
        ci_low=to_fixed(ci_low_sum / ci_low_n) if ci_low_n else None,
        ci_high=to_fixed(ci_high_sum / ci_high_n) if ci_high_n else None,
        evidence_grade=evidence.evidence_grade,
        n_samples=n_samples,
        n_sites=n_sites,
        n_studies=evidence.n_studies,
        peer_reviewed_studies=evidence.peer_reviewed_studies,
        validation_type=evidence.validation_type,
        in_intended_use=level != OUT_OF_SCOPE if level is not None else None,
        intended_use_coverage=to_fixed(clamp(coverage, 0, 1), 4) if coverage is not None else None,
        intended_use_level=level,
        warnings=tuple(sorted(warnings)),
        warning_counts=warning_counts(rows, sorted(warnings)),
        warning_total=len(rows),
        provenance=provenance,
        evidence_signal=evidence.evidence_signal,
        study_adjustment=adjustment or None,
    )


# ------------------------------------------------------------------ weakest

def strength(row: MetricValues | None, view: str) -> float:
    """``metricStrengthScore``: lower is weaker; missing values never count as weakest."""
    if row is None:
        return math.inf
    if view == "performance":
        return row.perf if is_finite(row.perf) else math.inf
    if view == "evidence":
        return GRADE_ORDER.get(row.evidence_grade, math.inf)
    if view == "intended_use":
        if row.intended_use_level is None:
            return math.inf  # no intended-use value (v1.11): never the weakest
        if row.intended_use_level == IN_SCOPE:
            return 3
        if row.intended_use_level == PARTIALLY_IN_SCOPE:
            return 2
        return 1
    overall = grading.overall_grade(row.perf, row.evidence_grade, row.intended_use_level)
    return overall.score if overall is not None else math.inf


def weakest(rows: Sequence[MetricValues | None], view: str) -> MetricValues | None:
    available = [row for row in rows if row is not None]
    if not available:
        return None
    chosen = available[0]
    for row in available:
        if strength(row, view) < strength(chosen, view):
            chosen = row
    return chosen
