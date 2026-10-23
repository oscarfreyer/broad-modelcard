"""Grades, scores, and statuses (CONTRACT.md §4.2–§4.5).

Ported from src/utils/grading.js and src/utils/overallTier.js at tag
v0.2.0-alpha.1. Formulas, thresholds, and evaluation order are kept exactly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..schema.contract import CHAPTER_06_PENALTY_USE_CASE, IN_SCOPE, OUT_OF_SCOPE, PARTIALLY_IN_SCOPE
from .jsnum import clamp, is_finite, js_round, js_truthy, to_fixed

GRADE_SCORES = {"A": 1, "B": 0.85, "C": 0.7, "D": 0.55, "E": 0.4, "F": 0.25}

# Overall score terms (CONTRACT.md §4.4), published in /meta.overall_score_weights.
OVERALL_SCORE_WEIGHTS = {"performance_grade": 0.35, "perf": 0.2, "evidence_grade": 0.3, "intended_use": 0.15}

# The score of a row without an intended-use value (contract v1.11): a card without an intended-use statement, or a row whose intended use
# is not given. The intended-use term is dropped and the other three are
# scaled back to 100 %; published in /meta.overall_score_weights_without_intended_use.
_WITHOUT_INTENDED_USE_TOTAL = 1 - OVERALL_SCORE_WEIGHTS["intended_use"]
OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE = {
    term: OVERALL_SCORE_WEIGHTS[term] / _WITHOUT_INTENDED_USE_TOTAL
    for term in ("performance_grade", "perf", "evidence_grade")
}

# Insertion order matters: nearest-score lookups keep the first of equal deltas.
VALIDATION_TYPE_SCORES = {
    "clinical_study_multisite": 1,
    "clinical_study_single_site": 0.85,
    "benchmark": 0.72,
    "vignette_study": 0.6,
    "simulation_study": 0.5,
    "internal_test": 0.4,
}

_VALIDATION_TYPE_ALIASES = {
    "clinical_study_multisite": "clinical_study_multisite",
    "clinicalstudymultisite": "clinical_study_multisite",
    "clinical study multisite": "clinical_study_multisite",
    "clinical study (multisite)": "clinical_study_multisite",
    "prospective_clinical_study": "clinical_study_multisite",
    "prospective_clinical": "clinical_study_multisite",
    "external_prospective": "clinical_study_multisite",
    "clinical_study_single_site": "clinical_study_single_site",
    "clinicalstudysinglesite": "clinical_study_single_site",
    "clinical study single site": "clinical_study_single_site",
    "clinical study (single site)": "clinical_study_single_site",
    "retrospective_clinical_study": "clinical_study_single_site",
    "retrospective_clinical": "clinical_study_single_site",
    "external_retrospective": "clinical_study_single_site",
    "benchmark": "benchmark",
    "benchmark_study": "benchmark",
    "internal_multisite": "benchmark",
    "vignette_study": "vignette_study",
    "vignette": "vignette_study",
    "internal_single_site": "vignette_study",
    "simulation_study": "simulation_study",
    "simulation": "simulation_study",
    "limited_pilot": "simulation_study",
    "internal_test": "internal_test",
    "internal": "internal_test",
}

_GRADE_TO_VALIDATION_TYPE = {
    "A": "clinical_study_multisite",
    "B": "clinical_study_single_site",
    "C": "benchmark",
    "D": "vignette_study",
    "E": "simulation_study",
    "F": "internal_test",
}

_PEER_REVIEW_RATIO = {
    "clinical_study_multisite": 0.88,
    "clinical_study_single_site": 0.8,
    "benchmark": 0.68,
    "vignette_study": 0.56,
    "simulation_study": 0.44,
    "internal_test": 0.32,
}

PERFORMANCE_THRESHOLDS = ((0.9, "A"), (0.8, "B"), (0.7, "C"), (0.6, "D"), (0.5, "E"), (0, "F"))
EVIDENCE_THRESHOLDS = ((0.9, "A"), (0.8, "B"), (0.68, "C"), (0.56, "D"), (0.44, "E"), (0, "F"))
OVERALL_THRESHOLDS = ((0.88, "A"), (0.76, "B"), (0.64, "C"), (0.52, "D"), (0.4, "E"), (0, "F"))

WEAK_EVIDENCE_GRADES = frozenset({"D", "E", "F"})


def grade_for_score(score: Any, thresholds) -> str | None:
    if not is_finite(score):
        return None
    bounded = clamp(score, 0, 1)
    for minimum, grade in thresholds:
        if bounded >= minimum:
            return grade
    return "F"


def normalize_validation_type(value: Any) -> str | None:
    if not js_truthy(value):
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw in VALIDATION_TYPE_SCORES:
        return raw
    spaced = re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", raw.lower()))
    underscored = re.sub(r"\s+", "_", spaced)
    compact = re.sub(r"\s+", "", spaced)
    return (
        _VALIDATION_TYPE_ALIASES.get(raw)
        or _VALIDATION_TYPE_ALIASES.get(underscored)
        or _VALIDATION_TYPE_ALIASES.get(spaced)
        or _VALIDATION_TYPE_ALIASES.get(compact)
    )


def validation_type_uses_sites(validation_type: str | None) -> bool:
    return validation_type in ("clinical_study_multisite", "clinical_study_single_site")


def infer_validation_type_from_grade(grade: str | None) -> str | None:
    return _GRADE_TO_VALIDATION_TYPE.get(grade)


def estimate_study_count(n_samples: Any, validation_type: str | None = "benchmark") -> int | None:
    if not is_finite(n_samples) or n_samples <= 0:
        return None
    divisor = 260 if validation_type_uses_sites(validation_type) else 360
    return max(1, min(18, js_round(n_samples / divisor)))


def estimate_peer_reviewed_count(n_studies: Any, validation_type: str | None) -> int | None:
    if not is_finite(n_studies) or n_studies <= 0:
        return None
    ratio = _PEER_REVIEW_RATIO.get(validation_type, 0.5)
    return max(0, min(js_round(n_studies), js_round(n_studies * ratio)))


def _study_count_score(n_studies: Any) -> float:
    if not is_finite(n_studies) or n_studies <= 0:
        return 0.3
    if n_studies >= 12:
        return 1
    if n_studies >= 8:
        return 0.9
    if n_studies >= 5:
        return 0.78
    if n_studies >= 3:
        return 0.64
    return 0.5


def _site_count_score(n_sites: Any, validation_type: str) -> float:
    if not validation_type_uses_sites(validation_type):
        return 0.65
    if not is_finite(n_sites) or n_sites <= 0:
        return 0.35
    if n_sites >= 20:
        return 1
    if n_sites >= 10:
        return 0.86
    if n_sites >= 5:
        return 0.72
    if n_sites >= 2:
        return 0.58
    return 0.45


def _peer_reviewed_score(peer_reviewed: Any, n_studies: Any) -> float:
    if not is_finite(n_studies) or n_studies <= 0:
        return 0.35
    bounded = clamp(peer_reviewed if is_finite(peer_reviewed) else 0, 0, n_studies)
    ratio = bounded / n_studies
    volume_bonus = 0.08 if n_studies >= 8 else 0.04 if n_studies >= 4 else 0
    return clamp(0.4 + 0.6 * ratio + volume_bonus, 0, 1)


def _study_size_score(n_samples: Any) -> float:
    if not is_finite(n_samples) or n_samples <= 0:
        return 0.28
    if n_samples >= 3000:
        return 1
    if n_samples >= 1800:
        return 0.9
    if n_samples >= 900:
        return 0.78
    if n_samples >= 400:
        return 0.64
    if n_samples >= 150:
        return 0.5
    if n_samples >= 50:
        return 0.38
    return 0.26


# The terms of the evidence signal (CONTRACT.md §4.2), published in
# /meta.evidence_signal_weights (contract v1.13) so the condition card can
# explain a signal without restating them.
EVIDENCE_SIGNAL_WEIGHTS = {"type": 0.33, "studies": 0.17, "sites": 0.12, "peer": 0.18, "size": 0.2}


@dataclass(frozen=True, slots=True)
class EvidenceTerms:
    """The five term scores of the signal (each 0–1) and their weighted sum,
    clamped to 0–1 (``base``), before penalties (contract v1.13 appraisal)."""

    type: float
    studies: float
    sites: float
    peer: float
    size: float
    base: float


def evidence_terms(validation_type, n_studies, n_sites, peer_reviewed_studies, n_samples) -> EvidenceTerms:
    """``evidenceSignalFromInputs``: the term scores and the signal before penalties."""
    normalized_type = normalize_validation_type(validation_type) or "internal_test"
    normalized_studies = max(1, js_round(n_studies)) if is_finite(n_studies) else None
    studies = normalized_studies
    if studies is None:
        studies = estimate_study_count(n_samples, normalized_type)
    if studies is None:
        studies = 1
    if is_finite(peer_reviewed_studies):
        peer_reviewed = clamp(js_round(peer_reviewed_studies), 0, studies)
    else:
        peer_reviewed = estimate_peer_reviewed_count(studies, normalized_type)
        if peer_reviewed is None:
            peer_reviewed = 0

    type_score = VALIDATION_TYPE_SCORES.get(normalized_type, 0.4)
    study_score = _study_count_score(studies)
    site_score = _site_count_score(n_sites, normalized_type)
    peer_score = _peer_reviewed_score(peer_reviewed, studies)
    size_score = _study_size_score(n_samples)
    weights = EVIDENCE_SIGNAL_WEIGHTS
    # Same terms, weights, and summation order as the reference: the float result is unchanged.
    base = clamp(
        weights["type"] * type_score
        + weights["studies"] * study_score
        + weights["sites"] * site_score
        + weights["peer"] * peer_score
        + weights["size"] * size_score,
        0,
        1,
    )
    return EvidenceTerms(type_score, study_score, site_score, peer_score, size_score, base)


def evidence_signal(validation_type, n_studies, n_sites, peer_reviewed_studies, n_samples) -> float:
    """``evidenceSignalFromInputs(...).score`` before prevalence/chapter penalties."""
    return evidence_terms(validation_type, n_studies, n_sites, peer_reviewed_studies, n_samples).base


def evidence_penalties(prevalence_score, use_case, chapter_no) -> tuple[float, ...]:
    """The §4.2 penalties that apply, each as a negative number, in formula order."""
    found = []
    if is_finite(prevalence_score) and prevalence_score < 0.15:
        found.append(-0.05)
    if chapter_no == "06" and use_case == CHAPTER_06_PENALTY_USE_CASE:
        found.append(-0.04)
    return tuple(found)


def penalized_evidence_signal(
    *,
    validation_type,
    n_studies,
    n_sites,
    peer_reviewed_studies,
    n_samples,
    prevalence_score,
    use_case,
    chapter_no,
    study_adjustment: float = 0.0,
) -> float:
    """The signal ``deriveEvidenceGrade`` grades: penalties applied, clamped to 0–1.

    The reference's "rare island" exemption is always false (CONTRACT.md §12).
    ``study_adjustment`` (contract v1.13, CONTRACT.md §22) is the linked
    study's guideline and risk-of-bias adjustment, added with the penalties
    before the clamp; 0 for a row without a linked study, which therefore
    grades exactly as before.
    """
    score = evidence_signal(validation_type, n_studies, n_sites, peer_reviewed_studies, n_samples)
    if is_finite(prevalence_score) and prevalence_score < 0.15:
        score -= 0.05
    if chapter_no == "06" and use_case == CHAPTER_06_PENALTY_USE_CASE:
        score -= 0.04
    if study_adjustment:
        score += study_adjustment
    return clamp(score, 0, 1)


def performance_grade(perf: Any) -> str | None:
    return grade_for_score(perf, PERFORMANCE_THRESHOLDS)


def intended_use_score(intended_use_level: str | None) -> float:
    if intended_use_level == IN_SCOPE:
        return 1
    if intended_use_level == PARTIALLY_IN_SCOPE:
        return 0.6
    return 0


def overall_score(perf: Any, evidence_grade: str | None, intended_use_level: str | None) -> float | None:
    """``overallScoreFromRow``: unrounded; ignores scope (the tier handles it).

    A row without an intended-use level (None, contract v1.11) is scored with
    the re-weighted terms of D3; every other row exactly as before.
    """
    if not is_finite(perf) or not evidence_grade:
        return None
    bounded_perf = clamp(perf, 0, 1)
    performance_score = GRADE_SCORES.get(performance_grade(bounded_perf), 0.25)
    evidence_score = GRADE_SCORES.get(evidence_grade, 0.25)
    if intended_use_level is None:
        weights = OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE
        return clamp(
            weights["performance_grade"] * performance_score
            + weights["perf"] * bounded_perf
            + weights["evidence_grade"] * evidence_score,
            0,
            1,
        )
    weights = OVERALL_SCORE_WEIGHTS
    return clamp(
        weights["performance_grade"] * performance_score
        + weights["perf"] * bounded_perf
        + weights["evidence_grade"] * evidence_score
        + weights["intended_use"] * intended_use_score(intended_use_level),
        0,
        1,
    )


@dataclass(frozen=True, slots=True)
class OverallGrade:
    grade: str
    score: float  # rounded to 3 decimals, as served


def overall_grade(perf: Any, evidence_grade: str | None, intended_use_level: str | None) -> OverallGrade | None:
    """``overallGradeFromRow``."""
    score = overall_score(perf, evidence_grade, intended_use_level)
    if score is None:
        return None
    return OverallGrade(grade=grade_for_score(score, OVERALL_THRESHOLDS), score=to_fixed(score, 3))


@dataclass(frozen=True, slots=True)
class Overall:
    tier: str  # graded | no_data | out_of_scope | no_evidence_data | no_performance_data
    grade: str | None = None
    score: float | None = None


def overall_for(row) -> Overall:
    """``getOverallTier``: first match wins.

    A row without an intended-use value (contract v1.11) is never out of scope.
    """
    if row is None:
        return Overall("no_data")
    if row.intended_use_level == OUT_OF_SCOPE or row.in_intended_use is False:
        return Overall("out_of_scope")
    if not row.evidence_grade:
        return Overall("no_evidence_data")
    if not is_finite(row.perf):
        return Overall("no_performance_data")
    graded = overall_grade(row.perf, row.evidence_grade, row.intended_use_level)
    if graded is None:
        return Overall("no_data")
    return Overall("graded", graded.grade, graded.score)


# ------------------------------------------------------------- statuses (v1)

_GRADE_STATUS = {"A": "strong", "B": "strong", "C": "moderate", "D": "weak", "E": "weak", "F": "weak"}


def status_for_grade(grade: str | None) -> str | None:
    return _GRADE_STATUS.get(grade)


# Since contract v1.11 a row without an evidence grade reads
# ``no_data``, like a row without performance: one missing state.
_OVERALL_TIER_STATUS = {
    "no_data": "no_data",
    "out_of_scope": "out_of_scope",
    "no_evidence_data": "no_data",
    "no_performance_data": "no_data",
}


def overall_status(overall: Overall) -> str:
    if overall.tier == "graded":
        return status_for_grade(overall.grade)
    return _OVERALL_TIER_STATUS[overall.tier]


def performance_status(row) -> str:
    """Scope is ignored, as in the reference coloring (CONTRACT.md §12)."""
    if row is None or not is_finite(row.perf):
        return "no_data"
    return status_for_grade(performance_grade(row.perf))


def evidence_status(row) -> str:
    """No row or no evidence grade: ``no_data`` (``not_validated`` before v1.11, D5)."""
    if row is None or not row.evidence_grade:
        return "no_data"
    return status_for_grade(row.evidence_grade)


def _band(status: str, grades: list[str], low: float | None, high: float | None) -> dict:
    return {"status": status, "grades": grades, "min": low, "max": high}


# Published in /meta.status_bands. Prototype heuristics, not clinical standards.
STATUS_BANDS = {
    "overall": [
        _band("strong", ["A", "B"], 0.76, None),
        _band("moderate", ["C"], 0.64, 0.76),
        _band("weak", ["D", "E", "F"], None, 0.64),
    ],
    "performance": [
        _band("strong", ["A", "B"], 0.8, None),
        _band("moderate", ["C"], 0.7, 0.8),
        _band("weak", ["D", "E", "F"], None, 0.7),
    ],
    "evidence": [
        _band("strong", ["A", "B"], 0.8, None),
        _band("moderate", ["C"], 0.68, 0.8),
        _band("weak", ["D", "E", "F"], None, 0.68),
    ],
}
