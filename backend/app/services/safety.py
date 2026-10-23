"""Warning relevance and recommended safeguards (CONTRACT.md §4.6).

Ported from ``WARNING_CATALOG``/``rankWarnings`` and ``buildSafeguards`` in
src/components/DetailsPanel.jsx (v0.2.0-alpha.1). Only codes, relevance, and
priority live here; all user-facing copy stays in the frontend.
"""

from __future__ import annotations

from ..schema.contract import CDSS_USE_CASES, OUT_OF_SCOPE, PARTIALLY_IN_SCOPE
from .grading import WEAK_EVIDENCE_GRADES
from .jsnum import is_finite
from .types import MetricValues

WARNING_RELEVANCE = {
    "out_of_scope_group": "High",
    "clinician_review_required": "High",
    "performance_below_target": "High",
    "no_performance_data": "High",
    "no_validation_data": "High",
    "wide_confidence_interval": "Medium",
    "limited_validation_depth": "Medium",
    "rare_condition_low_support": "Medium",
    "mental_disorders_high_variance": "Medium",
    "conservative_rollup_p20": "Low",
    "multimorbidity_synthetic_demo": "Medium",
    "limited_multimorbidity_evidence": "Medium",
    "multimorbidity_validation_gap": "Medium",
}
DEFAULT_RELEVANCE = "Medium"
_RELEVANCE_RANK = {"High": 0, "Medium": 1, "Low": 2}


def warning_relevance(code: str) -> str:
    return WARNING_RELEVANCE.get(code, DEFAULT_RELEVANCE)


def ranked_warnings(codes, counts=None, total: int | None = None) -> list[dict]:
    """Warnings ordered by relevance, then code.

    The reference ordered ties by display title; titles are frontend copy, so
    the API orders ties by code (CONTRACT.md §4.6). ``counts`` and ``total``
    come from an aggregated row and add ``share`` (contract v1.4).
    """
    ordered = sorted(codes, key=lambda code: (_RELEVANCE_RANK[warning_relevance(code)], code))
    shares = dict(counts) if counts is not None and total else {}
    warnings = []
    for code in ordered:
        warning = {"code": code, "relevance": warning_relevance(code)}
        if code in shares:
            warning["share"] = {"count": shares[code], "total": total}
        warnings.append(warning)
    return warnings


# Overall statuses that may get the routine "stable" safeguard (§4.6, v1.4).
_STABLE_STATUSES = frozenset({"strong", "moderate"})


def safeguards(row: MetricValues, use_case: str, overall_status: str) -> list[dict]:
    """``buildSafeguards``: rules on the served row, in the reference order.

    Two deviations from the reference since contract v1.4 (CONTRACT.md §12.1,
    approved 2026-10-10): ``evidence-missing`` and ``overall-weak`` were added,
    and ``standard-monitoring`` requires a Strong or Moderate overall status.
    """
    found: list[tuple[str, str]] = []
    if row.intended_use_level == OUT_OF_SCOPE:
        found.append(("scope-stop", "Critical"))
    elif row.intended_use_level == PARTIALLY_IN_SCOPE:
        found.append(("scope-partial", "Important"))

    if not is_finite(row.perf):
        found.append(("perf-missing", "Critical"))
    elif row.perf < 0.7:
        found.append(("perf-low", "Important"))

    if is_finite(row.ci_low) and is_finite(row.ci_high) and max(0, row.ci_high - row.ci_low) > 0.14:
        found.append(("ci-wide", "Important"))

    if row.evidence_grade in WEAK_EVIDENCE_GRADES:
        found.append(("evidence-weak", "Important"))
    elif is_finite(row.perf) and not row.evidence_grade and row.intended_use_level != OUT_OF_SCOPE:
        found.append(("evidence-missing", "Important"))

    if use_case in CDSS_USE_CASES:
        found.append(("cdss-governance", "Important"))

    if not found:
        if overall_status == "weak":
            found.append(("overall-weak", "Important"))
        elif overall_status in _STABLE_STATUSES:
            found.append(("standard-monitoring", "Routine"))
    return [{"id": safeguard_id, "priority": priority} for safeguard_id, priority in found]
