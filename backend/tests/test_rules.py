"""Unit tests of the contract rules that the parity suite cannot isolate:
JavaScript numerics, the v1 status vocabulary, warning relevance, safeguards,
and lens validation."""

from __future__ import annotations

import pytest

from app.services import grading, presentation, safety
from app.services.errors import InvalidLens
from app.services.jsnum import js_round, to_fixed
from app.services.types import Axes, Lens, MetricValues, Provenance

AXES = Axes(
    context=("Clinical",),
    age=("All ages", "Age 0-17", "Age 18-39", "Age 40-64", "Age 65+"),
    sex=("All sexes", "Sex Female", "Sex Male"),
    ethnicity=("All ethnicities", "Ethnicity White", "Ethnicity Black", "Ethnicity Hispanic", "Ethnicity Asian", "Ethnicity Other"),
)


def make_row(**values) -> MetricValues:
    defaults = dict(
        concept_id="1A00",
        lens=Lens(),
        perf=0.85,
        ci_low=0.8,
        ci_high=0.9,
        evidence_grade="B",
        n_samples=500,
        n_sites=3,
        n_studies=4,
        peer_reviewed_studies=3,
        validation_type="benchmark",
        in_intended_use=True,
        intended_use_coverage=1,
        intended_use_level="in_scope",
        warnings=(),
        provenance=Provenance("condition"),
    )
    defaults.update(values)
    return MetricValues(**defaults)


# Expected values printed by Node: (0.125).toFixed(2) etc.
@pytest.mark.parametrize(
    "value, digits, expected",
    [(0.125, 2, 0.13), (1.0005, 3, 1.0), (2.675, 2, 2.67), (0.0005, 3, 0.001), (1.45, 1, 1.4), (0.3125, 3, 0.313)],
)
def test_to_fixed_matches_javascript(value, digits, expected):
    assert to_fixed(value, digits) == expected


@pytest.mark.parametrize("value, expected", [(2.5, 3), (-2.5, -2), (0.49999999999999994, 0), (-0.5, 0), (7.0, 7)])
def test_js_round_matches_math_round(value, expected):
    assert js_round(value) == expected


def test_combo_index_follows_the_contract_formula():
    assert AXES.combo_index(Lens()) == 0
    assert AXES.combo_index(Lens("Age 65+", "Sex Male", "Ethnicity Other")) == 4 * 18 + 2 * 6 + 5 == 89
    assert all(AXES.lens_for_index(AXES.combo_index(lens)) == lens for lens in AXES.all_lenses())


def test_unknown_lens_value_is_rejected():
    with pytest.raises(InvalidLens) as error:
        AXES.combo_index(Lens("Age 99+"))
    assert error.value.code == "invalid_lens"


@pytest.mark.parametrize(
    "grade, status",
    [("A", "strong"), ("B", "strong"), ("C", "moderate"), ("D", "weak"), ("E", "weak"), ("F", "weak")],
)
def test_grades_map_to_statuses(grade, status):
    assert grading.status_for_grade(grade) == status


def test_overall_tier_first_match_wins():
    assert grading.overall_for(None).tier == "no_data"
    assert grading.overall_for(make_row(intended_use_level="out_of_scope", evidence_grade=None)).tier == "out_of_scope"
    assert grading.overall_for(make_row(in_intended_use=False)).tier == "out_of_scope"
    assert grading.overall_for(make_row(evidence_grade=None, perf=None)).tier == "no_evidence_data"
    assert grading.overall_for(make_row(perf=None)).tier == "no_performance_data"
    graded = grading.overall_for(make_row())
    # 0.35*0.85 + 0.2*0.85 + 0.3*0.85 + 0.15*1 = 0.8725
    assert (graded.tier, graded.grade, graded.score) == ("graded", "B", 0.873)


def test_statuses_per_view():
    assert presentation.statuses(None) == {"overall": "no_data", "performance": "no_data", "evidence": "no_data"}
    out_of_scope = make_row(intended_use_level="out_of_scope", in_intended_use=False, perf=0.95, evidence_grade=None)
    # Performance ignores scope; missing evidence is "not validated".
    assert presentation.statuses(out_of_scope) == {
        "overall": "out_of_scope",
        "performance": "strong",
        "evidence": "no_data",  # not_validated before v1.11 (D5)
    }
    assert presentation.statuses(make_row(perf=None))["overall"] == "no_data"
    assert presentation.statuses(make_row(perf=0.65, evidence_grade="C"))["performance"] == "weak"


def test_status_bands_agree_with_grade_thresholds():
    for view, thresholds in (
        ("overall", grading.OVERALL_THRESHOLDS),
        ("performance", grading.PERFORMANCE_THRESHOLDS),
        ("evidence", grading.EVIDENCE_THRESHOLDS),
    ):
        minimum = dict((grade, low) for low, grade in thresholds)
        strong, moderate, weak = grading.STATUS_BANDS[view]
        assert strong["min"] == minimum["B"] == moderate["max"]
        assert moderate["min"] == minimum["C"] == weak["max"]


def test_overall_score_uses_the_published_weights():
    weights = grading.OVERALL_SCORE_WEIGHTS
    assert sum(weights.values()) == pytest.approx(1)
    # perf 0.84 → performance grade B (0.85); evidence C (0.70); partially in scope (0.6).
    expected = weights["performance_grade"] * 0.85 + weights["perf"] * 0.84 + weights["evidence_grade"] * 0.7 + weights["intended_use"] * 0.6
    assert grading.overall_score(0.84, "C", "partially_in_scope") == pytest.approx(expected)


def test_map_row_for_missing_metrics():
    assert presentation.map_row("1A00", None) == [
        "1A00", "no_data", None, None, "no_data", None, None, "no_data", None, None, None, None, None, None,
    ]
    safety_column = presentation.MAP_COLUMNS.index("safety")
    assert presentation.map_row("1A00", None, "serious")[safety_column] == "serious"  # the safety column (v1.7)
    assert presentation.MAP_COLUMNS[-1] == "child_count"  # appended in v1.10; null for condition rows


def test_warning_relevance_and_order():
    ranked = safety.ranked_warnings(["unknown_code", "conservative_rollup_p20", "wide_confidence_interval", "no_validation_data"])
    assert ranked == [
        {"code": "no_validation_data", "relevance": "High"},
        {"code": "unknown_code", "relevance": "Medium"},
        {"code": "wide_confidence_interval", "relevance": "Medium"},
        {"code": "conservative_rollup_p20", "relevance": "Low"},
    ]


def test_safeguard_rules():
    def ids(row, use_case="Discharge letter generation"):
        return [item["id"] for item in safety.safeguards(row, use_case, presentation.statuses(row)["overall"])]

    assert ids(make_row()) == ["standard-monitoring"]
    assert ids(make_row(), "CDSS") == ["cdss-governance"]
    assert ids(make_row(intended_use_level="out_of_scope", perf=None)) == ["scope-stop", "perf-missing"]
    assert ids(make_row(intended_use_level="partially_in_scope", perf=0.69, ci_low=0.6, ci_high=0.75, evidence_grade="E")) == [
        "scope-partial",
        "perf-low",
        "ci-wide",
        "evidence-weak",
    ]
    priorities = {
        item["id"]: item["priority"]
        for item in safety.safeguards(make_row(perf=None, intended_use_level="out_of_scope"), "x", "out_of_scope")
    }
    assert priorities == {"scope-stop": "Critical", "perf-missing": "Critical"}


def test_safeguards_since_v1_4():
    """CONTRACT.md §4.6 and §12.1: no "stable" safeguard on a row that is not Strong or Moderate overall."""

    def found(row, use_case="Discharge letter generation"):
        overall = presentation.statuses(row)["overall"]
        return overall, [(item["id"], item["priority"]) for item in safety.safeguards(row, use_case, overall)]

    # Performance without evidence: No data since v1.11 (D5), never "stable".
    assert found(make_row(evidence_grade=None)) == ("no_data", [("evidence-missing", "Important")])
    # Out of scope rows get the scope stop, not evidence-missing.
    assert found(make_row(evidence_grade=None, intended_use_level="out_of_scope", in_intended_use=False))[1] == [
        ("scope-stop", "Critical")
    ]
    # Weak overall with no other rule firing gets overall-weak.
    assert safety.safeguards(make_row(), "x", "weak") == [{"id": "overall-weak", "priority": "Important"}]
    # Strong and Moderate keep the routine safeguard.
    assert safety.safeguards(make_row(), "x", "moderate") == [{"id": "standard-monitoring", "priority": "Routine"}]
    # Any other rule wins over overall-weak.
    assert [item["id"] for item in safety.safeguards(make_row(), "CDSS", "weak")] == ["cdss-governance"]


def test_warning_share_is_serialized_only_for_counted_codes():
    ranked = safety.ranked_warnings(
        ["no_performance_data", "conservative_rollup_p20"], (("no_performance_data", 1),), 2
    )
    assert ranked == [
        {"code": "no_performance_data", "relevance": "High", "share": {"count": 1, "total": 2}},
        {"code": "conservative_rollup_p20", "relevance": "Low"},
    ]
    assert safety.ranked_warnings(["no_performance_data"]) == [{"code": "no_performance_data", "relevance": "High"}]