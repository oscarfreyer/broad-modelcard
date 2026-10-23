"""Decode stored metric tuples into normalized rows (CONTRACT.md §4.1).

Ported from ``decodeConditionTuple``, ``deriveEvidenceFields``, and
``normalizeIntendedUseLevel`` in src/data/tableDataset.js (v0.2.0-alpha.1).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from ..schema.contract import IN_SCOPE, NO_INTENDED_USE_LEVEL, OUT_OF_SCOPE, PARTIALLY_IN_SCOPE
from . import grading
from .jsnum import clamp, is_finite, js_round, js_truthy
from .types import Lens, MetricValues, Provenance

# A stored tuple in METRIC_ROW_FORMAT order; warnings are a sequence of codes.
RawTuple = Sequence[Any]


@dataclass(frozen=True, slots=True)
class EvidenceFields:
    evidence_grade: str | None
    validation_type: str | None
    n_studies: int | None
    peer_reviewed_studies: int | None
    evidence_signal: float | None = None


_NO_VALIDATION = EvidenceFields(None, None, None, None)


def derive_evidence_fields(
    *,
    validation_type: Any,
    n_studies: Any,
    n_sites: Any,
    peer_reviewed_studies: Any,
    n_samples: Any,
    prevalence_score: Any,
    use_case: str,
    chapter_no: str | None,
    fallback_evidence_grade: str | None,
    has_validation_data: bool,
    study_adjustment: float = 0.0,
) -> EvidenceFields:
    """The derived evidence grade (§4.2); the stored grade only when samples or studies are missing.

    ``study_adjustment`` (contract v1.13, §22) enters the derived signal only."""
    if not has_validation_data:
        return _NO_VALIDATION

    normalized_type = (
        grading.normalize_validation_type(validation_type)
        or grading.infer_validation_type_from_grade(fallback_evidence_grade)
        or "internal_test"
    )
    samples = max(24, js_round(n_samples)) if is_finite(n_samples) else None
    sites = max(1, js_round(n_sites)) if is_finite(n_sites) else None
    if is_finite(n_studies) and n_studies > 0:
        studies = js_round(n_studies)
    else:
        studies = grading.estimate_study_count(samples, normalized_type)
    if is_finite(peer_reviewed_studies) and peer_reviewed_studies >= 0:
        peer_reviewed = clamp(js_round(peer_reviewed_studies), 0, studies or 0)
    else:
        peer_reviewed = grading.estimate_peer_reviewed_count(studies, normalized_type)

    if not samples or not studies:
        return EvidenceFields(fallback_evidence_grade or None, normalized_type, studies, peer_reviewed)

    signal = grading.penalized_evidence_signal(
        validation_type=normalized_type,
        n_studies=studies,
        n_sites=sites,
        peer_reviewed_studies=peer_reviewed,
        n_samples=samples,
        prevalence_score=prevalence_score,
        use_case=use_case,
        chapter_no=chapter_no,
        study_adjustment=study_adjustment,
    )
    return EvidenceFields(
        grading.grade_for_score(signal, grading.EVIDENCE_THRESHOLDS),
        normalized_type,
        studies,
        peer_reviewed,
        signal,
    )


def intended_use_level_from_coverage(coverage: float) -> str:
    bounded = clamp(coverage, 0, 1)
    if bounded <= 0:
        return OUT_OF_SCOPE
    if bounded >= 0.9999:
        return IN_SCOPE
    return PARTIALLY_IN_SCOPE


def normalize_intended_use_level(level: Any, in_intended_use: bool, coverage: Any) -> str:
    normalized = str(level).strip().lower() if js_truthy(level) else ""
    if normalized in (OUT_OF_SCOPE, "not_covered"):
        return OUT_OF_SCOPE
    if normalized in (PARTIALLY_IN_SCOPE, "partial", "low", "middle", "large"):
        return PARTIALLY_IN_SCOPE
    if normalized in (IN_SCOPE, "full"):
        return IN_SCOPE
    if is_finite(coverage):
        return intended_use_level_from_coverage(coverage)
    return IN_SCOPE if in_intended_use else OUT_OF_SCOPE


def _nullable_number(value: Any) -> float | None:
    return value if is_finite(value) else None


def _nullable_integer(value: Any) -> int | None:
    return js_round(value) if is_finite(value) else None


def is_in_intended_use(flag: Any) -> bool:
    """True for ``1``, ``'1'``, or ``true``, exactly as the reference."""
    if isinstance(flag, str):
        return flag == "1"
    return isinstance(flag, (int, float)) and flag == 1


# A warning that states intended use; a row without an intended-use value drops it.
SCOPE_WARNING = "out_of_scope_group"


def decode_tuple(
    raw: RawTuple,
    *,
    concept_id: str,
    lens: Lens,
    use_case: str,
    prevalence_score: float | None,
    chapter_no: str | None,
    provenance: Provenance,
    intended_use_defined: bool = True,
    study_id: str | None = None,
    study_adjustment: float = 0.0,
) -> MetricValues:
    """A normalized row. Its intended-use fields are None (contract v1.11) when
    the card has no intended-use statement (``intended_use_defined`` False) or
    the stored row gives none (``NO_INTENDED_USE_LEVEL``); such a row also
    drops the ``out_of_scope_group`` warning.

    ``study_id`` names the study record the row links to (contract v1.13,
    CONTRACT.md §22), and ``study_adjustment`` is that study's change to the
    evidence signal; a row without a linked study has neither."""
    (
        perf_raw,
        ci_low_raw,
        ci_high_raw,
        grade_raw,
        samples_raw,
        sites_raw,
        studies_raw,
        peer_raw,
        validation_type_raw,
        in_intended_use_raw,
        coverage_raw,
        level_raw,
        warnings_raw,
    ) = raw

    fallback_grade = (str(grade_raw).strip() if js_truthy(grade_raw) else "") or None
    warnings = tuple(warnings_raw) if isinstance(warnings_raw, (list, tuple)) else ()
    has_validation_data = js_truthy(validation_type_raw) and "no_validation_data" not in warnings
    if intended_use_defined and level_raw != NO_INTENDED_USE_LEVEL:
        in_intended_use = is_in_intended_use(in_intended_use_raw)
        coverage = _nullable_number(coverage_raw)
        coverage = coverage if coverage is not None else (1 if in_intended_use else 0)
        level = normalize_intended_use_level(level_raw, in_intended_use, _nullable_number(coverage_raw))
    else:
        in_intended_use = coverage = level = None
        warnings = tuple(code for code in warnings if code != SCOPE_WARNING)

    samples = _nullable_integer(samples_raw)
    samples = max(24, samples) if samples is not None else None
    sites = _nullable_integer(sites_raw)
    sites = max(1, sites) if sites is not None else None

    evidence = derive_evidence_fields(
        validation_type=validation_type_raw,
        n_studies=_nullable_integer(studies_raw),
        n_sites=sites,
        peer_reviewed_studies=_nullable_integer(peer_raw),
        n_samples=samples,
        prevalence_score=prevalence_score if is_finite(prevalence_score) else None,
        use_case=use_case,
        chapter_no=chapter_no,
        fallback_evidence_grade=fallback_grade,
        has_validation_data=has_validation_data,
        study_adjustment=study_adjustment,
    )

    return MetricValues(
        concept_id=concept_id,
        lens=lens,
        perf=_nullable_number(perf_raw),
        ci_low=_nullable_number(ci_low_raw),
        ci_high=_nullable_number(ci_high_raw),
        evidence_grade=evidence.evidence_grade,
        n_samples=samples,
        n_sites=sites,
        n_studies=evidence.n_studies,
        peer_reviewed_studies=evidence.peer_reviewed_studies,
        validation_type=evidence.validation_type,
        in_intended_use=in_intended_use,
        intended_use_coverage=coverage,
        intended_use_level=level,
        warnings=warnings,
        provenance=provenance,
        evidence_signal=evidence.evidence_signal,
        study_id=study_id,
        study_adjustment=study_adjustment if study_id is not None else None,
    )
