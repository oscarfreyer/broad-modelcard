"""The drift checks in contract_schema.py detect the differences they exist for."""

from __future__ import annotations

import copy

import pytest
from contract_schema import Validator, load_contract, shape, shape_differences


@pytest.fixture(scope="module")
def contract() -> dict:
    return load_contract()


def metric_row(contract: dict) -> dict:
    return copy.deepcopy(contract["components"]["schemas"]["MetricRow"])


def differs(contract: dict, original: dict, mutated: dict) -> bool:
    return bool(shape_differences(shape(contract, original), shape(contract, mutated)))


def test_shape_ignores_annotations_and_union_order(contract):
    original = metric_row(contract)
    mutated = metric_row(contract)
    mutated["description"] = "changed"
    mutated["properties"]["perf"] = {"anyOf": [{"type": "null"}, {"type": "number", "description": "x"}]}
    mutated["properties"]["evidence_grade"] = {"anyOf": [{"type": "null"}, {"type": "string", "enum": list("FEDCBA")}]}
    assert not differs(contract, original, mutated)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda s: s["required"].remove("perf"), id="field no longer required"),
        pytest.param(lambda s: s["properties"].__setitem__("perf", {"type": "number"}), id="nullable became non-null"),
        pytest.param(lambda s: s["properties"].pop("ci_low"), id="field removed"),
        pytest.param(lambda s: s["properties"].__setitem__("extra", {"type": "string"}), id="field added"),
        pytest.param(lambda s: s["properties"].__setitem__("n_sites", {"type": ["number", "null"]}), id="integer became number"),
        pytest.param(
            lambda s: s["properties"]["provenance"].__setitem__("$ref", "#/components/schemas/Lens"), id="reference retargeted"
        ),
    ],
)
def test_shape_detects_changes(contract, mutate):
    original = metric_row(contract)
    mutated = metric_row(contract)
    mutate(mutated)
    assert differs(contract, original, mutated)


def test_shape_detects_enum_and_tuple_changes(contract):
    original = copy.deepcopy(contract["components"]["schemas"]["MetricMap"])
    open_tuple = copy.deepcopy(original)
    del open_tuple["properties"]["rows"]["items"]["items"]
    assert differs(contract, original, open_tuple)
    reordered = copy.deepcopy(original)
    prefix = reordered["properties"]["rows"]["items"]["prefixItems"]
    prefix[1], prefix[2] = prefix[2], prefix[1]
    assert differs(contract, original, reordered)
    status = copy.deepcopy(contract["components"]["schemas"]["Status"])
    status["enum"].append("unknown")
    assert differs(contract, contract["components"]["schemas"]["Status"], status)


def test_validator_accepts_a_valid_problem(contract):
    problem = {"type": "urn:x", "title": "Unknown model", "status": 404, "code": "unknown_model"}
    assert not Validator(contract).errors(problem, {"$ref": "#/components/schemas/Problem"})


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"type": "urn:x", "title": "t", "status": 404}, id="missing required"),
        pytest.param({"type": "urn:x", "title": "t", "status": "404", "code": "c"}, id="wrong type"),
        pytest.param({"type": "urn:x", "title": "t", "status": 404.0, "code": "c"}, id="integer as float"),
        pytest.param({"type": "urn:x", "title": "t", "status": 404, "code": "c", "detail": None}, id="null not allowed"),
        pytest.param({"type": "urn:x", "title": "t", "status": 404, "code": "c", "extra": 1}, id="unexpected property"),
    ],
)
def test_validator_rejects_invalid_problems(contract, body):
    assert Validator(contract).errors(body, {"$ref": "#/components/schemas/Problem"})


def test_validator_checks_tuples_enums_patterns_and_formats(contract):
    validator = Validator(contract)
    row = ["1C43", "strong", "A", 0.9, "strong", "A", 0.95, "moderate", "C", "in_scope", 0.91, 0.98, None, None]
    rows_schema = contract["components"]["schemas"]["MetricMap"]["properties"]["rows"]
    assert not validator.errors([row], rows_schema)
    assert validator.errors([row + ["extra"]], rows_schema)
    assert validator.errors([[*row[:1], "great", *row[2:]]], rows_schema)
    assert validator.errors([row[:9]], rows_schema)
    assert validator.errors([row[:10]], rows_schema)  # v1.1 requires the CI columns
    assert validator.errors([[*row[:10], "low", *row[11:]]], rows_schema)
    assert validator.errors([row[:12]], rows_schema)  # v1.7 requires the safety column
    assert not validator.errors([[*row[:12], "caution", None]], rows_schema)
    assert validator.errors([[*row[:12], "safe", None]], rows_schema)  # never "safe"
    assert validator.errors([row[:13]], rows_schema)  # v1.10 requires the child_count column
    assert not validator.errors([[*row[:13], 0]], rows_schema)  # a rollup without children
    assert not validator.errors([[*row[:13], 27]], rows_schema)
    assert validator.errors([[*row[:13], -1]], rows_schema)
    assert validator.errors([[*row[:13], 1.5]], rows_schema)
    concept = {"$ref": "#/components/schemas/Concept"}
    base = {"concept_id": "CH-01", "level": 0, "pt": "x", "parent_id": None, "chapter_id": "CH-01", "sort_order": 1}
    assert not validator.errors({**base, "chapter_no": "01"}, concept)
    assert validator.errors({**base, "chapter_no": "1"}, concept)
    export = contract["components"]["schemas"]["ConceptExport"]["properties"]["exported_at"]
    assert not validator.errors("2026-10-08T12:00:00.000Z", export)
    assert validator.errors("2026-10-08", export)


def test_validator_requires_exactly_one_one_of_match(contract):
    ambiguous = {"oneOf": [{"type": "number"}, {"type": "integer"}]}
    assert Validator(contract).errors(3, ambiguous)
    assert not Validator(contract).errors(3.5, ambiguous)


def test_validator_refuses_unknown_keywords(contract):
    with pytest.raises(ValueError, match="unsupported"):
        Validator(contract).errors("x", {"type": "string", "multipleOf": 2})
