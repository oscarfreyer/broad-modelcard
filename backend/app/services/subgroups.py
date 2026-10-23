"""Across groups: one concept at all patients and at every one-group lens
(contract v1.13, CONTRACT.md §24).

A one-group lens names one specific value on one axis (``Age 65+``, ``Sex
Female``, ``Ethnicity Asian``) and leaves the other two at ``All …``. Each
entry is the row ``getConceptMetrics`` serves for that lens (stored, lens
fallback, anchor, or rollup), reduced to what a comparison needs.

The **difference flag** is a prototype heuristic, not a grade: it changes no
status, score, warning, or safeguard. A group is flagged when its performance
differs from all patients' by at least ``min_delta`` and the two confidence
intervals do not overlap. Both values and both intervals must be present;
touching interval bounds count as overlapping.

**Layers** (contract v1.13, §24 and §26). With a local population whose
local results the card has, a group is compared only with an all-patients
result of the same evidence layer: a public group with the public
all-patients result, a local group with the local one. Every entry then
names its layer and every difference the layer it was compared with.
"""

from __future__ import annotations

from ..schema.contract import AGE_ALL, ANY_SETTING, ETHNICITY_ALL, SEX_ALL
from . import grading
from .presentation import statuses
from .types import Axes, Lens, MetricValues

# Published in /meta as `subgroup_difference` (CONTRACT.md §24).
SUBGROUP_DIFFERENCE = {
    "min_delta": 0.05,
    "requires_ci_separation": True,
    "note": "Prototype heuristic for flagging a group whose result differs from all patients. Not a grade; it changes no status.",
}

_AXES = (("age", AGE_ALL), ("sex", SEX_ALL), ("ethnicity", ETHNICITY_ALL))
# perf values are served with 3 decimals; compare the rounded difference with a small tolerance.
_EPSILON = 1e-9

# Entry layers (contract v1.13, §24): a local result, a rollup that includes one, or a public result.
LOCAL = "local"
INCLUDES_LOCAL = "includes_local"
PUBLIC = "public"


def one_group_lenses(axes: Axes, setting: str = ANY_SETTING) -> list[tuple[str, str, Lens]]:
    """``(axis, value, lens)`` for every specific value of each axis, in axis and value order,
    at one setting (contract v1.14, §29: groups are compared within a setting)."""
    base = Lens(setting=setting)
    found = []
    for axis, all_value in _AXES:
        for value in getattr(axes, axis):
            if value != all_value:
                found.append((axis, value, base.group(axis, value)))
    return found


def difference(group: MetricValues | None, reference: MetricValues | None, rule: dict = SUBGROUP_DIFFERENCE) -> dict:
    """The difference of a group's performance from all patients' (CONTRACT.md §24).

    ``reason`` says why a group is or is not flagged: ``separated`` (flagged),
    ``below_delta``, ``ci_overlap``, ``missing_ci``, or ``no_result`` (a
    performance value is missing on either side).
    """
    group_perf = group.perf if group is not None else None
    reference_perf = reference.perf if reference is not None else None
    if group_perf is None or reference_perf is None:
        return {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}
    delta = round(group_perf - reference_perf, 3)
    direction = "higher" if delta > 0 else "lower" if delta < 0 else None
    outcome = {"delta": delta, "direction": direction, "flagged": False}
    if abs(delta) + _EPSILON < rule["min_delta"]:
        return {**outcome, "reason": "below_delta"}
    if not rule["requires_ci_separation"]:
        return {**outcome, "flagged": True, "reason": "separated"}
    bounds = (group.ci_low, group.ci_high, reference.ci_low, reference.ci_high)
    if any(bound is None for bound in bounds):
        return {**outcome, "reason": "missing_ci"}
    group_low, group_high, reference_low, reference_high = bounds
    separated = group_low > reference_high or group_high < reference_low
    return {**outcome, "flagged": separated, "reason": "separated" if separated else "ci_overlap"}


def layered_difference(
    group: MetricValues | None,
    group_layer: str | None,
    reference: MetricValues | None,
    reference_layer: str | None,
    public_reference: MetricValues | None,
    rule: dict = SUBGROUP_DIFFERENCE,
) -> dict:
    """``difference`` for a card with local results for the chosen population
    (CONTRACT.md §24): a group is compared only with an all-patients result
    of its own layer. A public group whose all-patients result is local (or
    includes local results) is compared with the public all-patients result;
    a local group without a local all-patients result is not compared
    (``layer_differs``). ``compared_with`` names the layer compared with
    (null when nothing was)."""
    if group is None:
        return {**difference(None, None, rule), "compared_with": None}
    if group_layer == reference_layer:
        return {**difference(group, reference, rule), "compared_with": reference_layer}
    if group_layer == PUBLIC:
        return {**difference(group, public_reference, rule), "compared_with": PUBLIC}
    return {"delta": None, "direction": None, "flagged": False, "reason": "layer_differs", "compared_with": None}


def _provenance(row: MetricValues, data_source: dict | None) -> dict:
    provenance = row.provenance
    rollup = provenance.rollup
    return {
        "source": provenance.source,
        "anchor_concept_id": provenance.anchor_concept_id,
        "rollup": {"child_count": rollup.child_count, "aggregation": rollup.aggregation} if rollup else None,
        "lens_fallback": provenance.lens_fallback,
        "data_source": data_source,
        # Contract v1.13 (§26): a local result for the chosen population says so.
        **({"layer": provenance.layer} if provenance.layer else {}),
    }


def entry(
    axis: str,
    group: str | None,
    lens: Lens,
    row: MetricValues | None,
    *,
    safety: str | None,
    data_source=None,
    layer: str | None | bool = False,
) -> dict:
    """One ``SubgroupResult``: the row's comparable facts, or the empty entry
    when there is no row. ``layer`` (a card with local results only, §24) is
    added when given; the default ``False`` leaves the entry without it."""
    served = _entry(axis, group, lens, row, safety=safety, data_source=data_source)
    if layer is not False:
        served["layer"] = layer
    return served


def _entry(axis: str, group: str | None, lens: Lens, row: MetricValues | None, *, safety: str | None, data_source=None) -> dict:
    if row is None:
        return {
            "axis": axis,
            "group": group,
            "lens": lens.as_dict(),
            "has_result": False,
            "perf": None,
            "ci_low": None,
            "ci_high": None,
            "performance_grade": None,
            "evidence_grade": None,
            "overall": {"tier": "no_data", "score": None, "grade": None},
            "status": {"overall": "no_data", "performance": "no_data", "evidence": "no_data"},
            "intended_use_level": None,
            "safety": safety,
            "provenance": None,
            "n_samples": None,
            "n_sites": None,
        }
    overall = grading.overall_for(row)
    return {
        "axis": axis,
        "group": group,
        "lens": lens.as_dict(),
        "has_result": True,
        "perf": row.perf,
        "ci_low": row.ci_low,
        "ci_high": row.ci_high,
        "performance_grade": grading.performance_grade(row.perf),
        "evidence_grade": row.evidence_grade,
        "overall": {"tier": overall.tier, "score": overall.score, "grade": overall.grade},
        "status": statuses(row),
        "intended_use_level": row.intended_use_level,
        "safety": safety,
        "provenance": _provenance(row, data_source),
        # Contract v1.14 (§24): the group's size, as getConceptMetrics serves it.
        "n_samples": row.n_samples,
        "n_sites": row.n_sites,
    }


# ------------------------------------------------------------ group summary

# getSubgroupSummary lists at most this many flagged conditions per group (contract v1.14, §24).
SUMMARY_FLAGGED_LIMIT = 5


def subgroup_summary(conditions, axes: Axes, metrics, public_metrics=None, *, layered: bool = False, setting: str = ANY_SETTING) -> dict:
    """``getSubgroupSummary``'s counts (contract v1.14, CONTRACT.md §24): for every one-group lens,
    over the depth-1 conditions given (ICD-11), how many have a performance value in the group,
    how many have one at all patients but none in the group, how many were compared, how many the
    §24 rule flags higher and lower, and the flagged conditions with the largest |delta|.

    The rule is ``difference``, and with local results for the chosen population (``layered``)
    ``layered_difference`` with ``public_metrics`` as the public all-patients result, exactly as
    getConceptSubgroups compares a single condition. A prototype heuristic, never a grade."""

    def layer_of(row, concept_id: str, lens: Lens) -> str | None:
        if row is None:
            return None
        return metrics.layer(concept_id, lens) or PUBLIC

    all_patients = Lens(setting=setting)
    references = []
    with_reference = 0
    for condition in conditions:
        row = metrics.row(condition.concept_id, all_patients)
        reference_layer = layer_of(row, condition.concept_id, all_patients) if layered else None
        public_row = None
        if layered and reference_layer not in (None, PUBLIC) and public_metrics is not None:
            public_row = public_metrics.row(condition.concept_id, all_patients)
        if row is not None and row.perf is not None:
            with_reference += 1
        references.append((condition, row, reference_layer, public_row))

    groups = []
    for axis, value, lens in one_group_lenses(axes, setting):
        counts = {"with_result": 0, "no_result": 0, "compared": 0, "flagged_higher": 0, "flagged_lower": 0}
        flagged = []
        for order, (condition, reference, reference_layer, public_row) in enumerate(references):
            row = metrics.row(condition.concept_id, lens)
            if row is None or row.perf is None:
                if reference is not None and reference.perf is not None:
                    counts["no_result"] += 1
                continue
            counts["with_result"] += 1
            if layered:
                found = layered_difference(row, layer_of(row, condition.concept_id, lens), reference, reference_layer, public_row)
            else:
                found = difference(row, reference)
            if found["delta"] is None:
                continue
            counts["compared"] += 1
            if found["flagged"]:
                counts["flagged_" + found["direction"]] += 1
                flagged.append((-abs(found["delta"]), order, condition, found))
        flagged.sort(key=lambda item: (item[0], item[1]))
        groups.append({
            "axis": axis,
            "group": value,
            "lens": lens.as_dict(),
            **counts,
            "flagged": [
                {
                    "concept_id": condition.concept_id,
                    "code": condition.icd11_code,
                    "pt": condition.pt,
                    "chapter_id": condition.chapter_id,
                    "delta": found["delta"],
                    "direction": found["direction"],
                }
                for _, _, condition, found in flagged[:SUMMARY_FLAGGED_LIMIT]
            ],
        })
    return {"total": len(references), "all_patients_with_result": with_reference, "layered": layered, "groups": groups}
