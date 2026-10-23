"""Compare service output with rows serialized by tests/reference/generate_reference.mjs."""

from __future__ import annotations

from app.services import grading, safety
from app.services.jsnum import is_finite
from app.services.types import Lens, MetricValues

FLOAT_TOLERANCE = 1e-9
FLOAT_FIELDS = ("perf", "ci_low", "ci_high", "intended_use_coverage")
EXACT_FIELDS = (
    "concept_id",
    "evidence_grade",
    "n_samples",
    "n_sites",
    "n_studies",
    "peer_reviewed_studies",
    "validation_type",
    "in_intended_use",
    "intended_use_level",
    "combination_label",
)
_RELEVANCE_RANK = {"High": 0, "Medium": 1, "Low": 2}
_GRADE_STATUS = {"A": "strong", "B": "strong", "C": "moderate", "D": "weak", "E": "weak", "F": "weak"}
# Contract v1.11 (CONTRACT.md §12.1): a row without an evidence
# grade reads no_data, where v1 served not_validated.
_TIER_STATUS = {"no_data": "no_data", "out_of_scope": "out_of_scope", "no_evidence_data": "no_data", "no_performance_data": "no_data"}


def reference_overall_status(expected: dict) -> str:
    """CONTRACT.md §4.5 applied to a reference row's overall result."""
    tier = expected["overall"]["reason"] or "graded"
    return _GRADE_STATUS[expected["overall"]["grade"]] if tier == "graded" else _TIER_STATUS[tier]


def reference_safeguards(expected: dict) -> list[tuple[str, str]]:
    """The reference client's safeguards with the intentional deviations of
    CONTRACT.md §12.1 applied, and nothing else changed:

    1. ``evidence-missing`` (Important) follows the evidence rule when the row
       has ``perf``, no evidence grade, and is not out of scope;
    2. ``standard-monitoring`` is kept only for a Strong or Moderate overall
       status; a Weak row that has no other safeguard gets ``overall-weak``.
    """
    found = [tuple(item) for item in expected["safeguards"] if item[0] != "standard-monitoring"]
    if expected["perf"] is not None and not expected["evidence_grade"] and expected["intended_use_level"] != "out_of_scope":
        position = next((index for index, item in enumerate(found) if item[0] == "cdss-governance"), len(found))
        found.insert(position, ("evidence-missing", "Important"))
    if not found:
        overall = reference_overall_status(expected)
        if overall == "weak":
            found.append(("overall-weak", "Important"))
        elif overall in ("strong", "moderate"):
            found.append(("standard-monitoring", "Routine"))
    return found


def lens_of(payload: dict) -> Lens:
    return Lens(payload["age"], payload["sex"], payload["ethnicity"])


def floats_equal(expected, actual) -> bool:
    if expected is None or actual is None:
        return expected is None and actual is None
    return is_finite(actual) and abs(expected - actual) <= FLOAT_TOLERANCE


def exact_equal(expected, actual) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, int) and isinstance(actual, float):
        return False  # an integer field came back as a float
    return expected == actual


def row_mismatches(expected: dict | None, actual: MetricValues | None, use_case: str) -> list[str]:
    """Differences between a reference row and a service row (empty when equal)."""
    if expected is None or actual is None:
        return [] if expected is None and actual is None else [f"row: expected {expected!r:.80}, got {actual!r:.80}"]

    problems = []

    def check(name, ok, want, got):
        if not ok:
            problems.append(f"{name}: expected {want!r}, got {got!r}")

    for name in FLOAT_FIELDS:
        check(name, floats_equal(expected[name], getattr(actual, name)), expected[name], getattr(actual, name))
    for name in EXACT_FIELDS:
        check(name, exact_equal(expected[name], getattr(actual, name)), expected[name], getattr(actual, name))
    check("lens", expected["lens"] == actual.lens.label, expected["lens"], actual.lens.label)
    check("warnings", expected["warnings"] == list(actual.warnings), expected["warnings"], actual.warnings)
    condition_ids = list(actual.condition_ids) if actual.condition_ids is not None else None
    check("condition_ids", expected["condition_ids"] == condition_ids, expected["condition_ids"], condition_ids)

    performance_grade = grading.performance_grade(actual.perf)
    check("performance_grade", expected["performance_grade"] == performance_grade, expected["performance_grade"], performance_grade)

    overall = grading.overall_for(actual)
    want = expected["overall"]
    check("overall.tier", (want["reason"] or "graded") == overall.tier, want["reason"], overall.tier)
    check("overall.grade", want["grade"] == overall.grade, want["grade"], overall.grade)
    check("overall.score", floats_equal(want["score"], overall.score), want["score"], overall.score)

    from_row = grading.overall_grade(actual.perf, actual.evidence_grade, actual.intended_use_level)
    got = None if from_row is None else {"grade": from_row.grade, "score": from_row.score}
    want = expected["overall_from_row"]
    same = (want is None and got is None) or (
        want is not None and got is not None and want["grade"] == got["grade"] and floats_equal(want["score"], got["score"])
    )
    check("overall_from_row", same, want, got)

    # The reference orders equal-relevance warnings by display title; the API
    # orders them by code (CONTRACT.md §4.6). Compare in the API order.
    want_warnings = sorted(
        (tuple(item) for item in expected["ranked_warnings"]), key=lambda item: (_RELEVANCE_RANK[item[1]], item[0])
    )
    got_warnings = [(item["code"], item["relevance"]) for item in safety.ranked_warnings(actual.warnings)]
    check("ranked_warnings", want_warnings == got_warnings, want_warnings, got_warnings)

    want_safeguards = reference_safeguards(expected)
    got_safeguards = [
        (item["id"], item["priority"])
        for item in safety.safeguards(actual, use_case, grading.overall_status(grading.overall_for(actual)))
    ]
    check("safeguards", want_safeguards == got_safeguards, want_safeguards, got_safeguards)
    return problems


class MismatchLog:
    """Collects mismatches across many cases; reports the first few."""

    def __init__(self, limit: int = 15):
        self.limit = limit
        self.count = 0
        self.compared = 0
        self.examples: list[str] = []

    def add(self, where: str, problems: list[str]) -> None:
        self.compared += 1
        if problems:
            self.count += 1
            if len(self.examples) < self.limit:
                self.examples.append(f"{where}: {'; '.join(problems)}")

    def assert_clean(self) -> None:
        assert self.count == 0, f"{self.count} of {self.compared} cases differ:\n" + "\n".join(self.examples)
