"""The running app against the frozen contract, backend/openapi.json.

Fails when the app's generated OpenAPI document diverges from the contract
(operations, paths, methods, operation ids, parameter names and required
flags, request bodies, declared response statuses, success response content
types and schemas) or when a response body does not validate against the
committed schemas. Every operation, read and admin, is covered.
"""

from __future__ import annotations

import json

import pytest
from admin_helpers import ADMIN, TINY_TARGET, post_upload, read_csv, template, wait, write_csv
from contract_schema import Validator, load_contract, resolve, shape, shape_differences

from app.assist.inputs import from_text
from app.assist.providers import FakeProvider
from app.main import API_PREFIX, create_app


def _field(value, quote):
    return {"value": value, "quote": quote, "location": "line 1", "confidence": 0.9, "uncertain": False}


TINY_ANSWER = {
    "records": [{
        "model_version": _field("Tiny-1", "Tiny-1 as CDSS"), "use_case": _field("CDSS", "as CDSS"),
        "code": _field("1A00", "condition 1A00"), "perf": _field(0.9, "an accuracy of 0.9"),
        "source": _field("Synthetic study T-9 (fictional)", "Synthetic study T-9"), "study": _field("T-9", "T-9"),
        "source_date": _field("2026-10-01", "2026-10-01"),
    }],
    "notes": [],
}

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}  # has multimorbidity data
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}  # no multimorbidity data
TINY = {"model": "Tiny-1", "use_case": "CDSS"}
VANTREL = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}  # a demo product (all-population lens only)
NORTHBRIDGE = {"population": "northbridge-region"}  # the demo pack's local population (v1.10)
SPECIFIC_LENS = {"age": "Age 65+", "sex": "Sex Female", "ethnicity": "Ethnicity Asian"}


@pytest.fixture(scope="module")
def contract() -> dict:
    return load_contract()


@pytest.fixture(scope="module")
def generated() -> dict:
    return create_app().openapi()


def operations(document: dict, prefix: str = "") -> dict[str, tuple[str, str, dict]]:
    found = {}
    for path, item in document["paths"].items():
        for method, operation in item.items():
            found[operation["operationId"]] = (path.removeprefix(prefix), method, operation)
    return found


def test_operations_match_contract(contract, generated):
    expected = {(op_id, path, method) for op_id, (path, method, _) in operations(contract).items()}
    actual = {(op_id, path, method) for op_id, (path, method, _) in operations(generated, API_PREFIX).items()}
    assert len(expected) == 60  # listStudies, getStudy, getComparison (R4), getConceptSubgroups (R3), listEffects (R6), and the 15 operations of §26 (R5) since v1.13; getSubgroupSummary, listSafetyIncidents, interpretQuery, interpretQueryWithHelper (v1.14); getCardRecord, getCdsServices, callCdsService, createEvaluationUpload, getEvaluationProposals (v1.14 Q7)
    assert actual == expected, f"missing: {sorted(expected - actual)}; extra: {sorted(actual - expected)}"
    assert all(path.startswith(API_PREFIX) for path in generated["paths"])


def test_parameters_match_contract(contract, generated):
    served = operations(generated, API_PREFIX)
    differences = []
    for op_id, (_, _, operation) in operations(contract).items():
        want = {
            (param["name"], param["in"]): bool(param.get("required", False))
            for param in (resolve(contract, item) for item in operation.get("parameters", ()))
        }
        got = {
            (param["name"], param["in"]): bool(param.get("required", False))
            for param in served[op_id][2].get("parameters", ())
        }
        if want != got:
            differences.append(f"{op_id}: contract {sorted(want.items())} != app {sorted(got.items())}")
    assert not differences, "\n".join(differences)


def _contract_json_schema(contract: dict, operation: dict, status: str) -> dict:
    response = resolve(contract, operation["responses"].get(status) or operation["responses"]["default"])
    content = response["content"]
    return next(iter(content.values()))["schema"]


def _success_status(operation: dict) -> str:
    statuses = [status for status in operation["responses"] if status.startswith("2")]
    assert len(statuses) == 1, statuses
    return statuses[0]


def test_response_statuses_match_contract(contract, generated):
    """Each operation declares the same response statuses (success and problems)."""
    served = operations(generated, API_PREFIX)
    differences = []
    for op_id, (_, _, operation) in operations(contract).items():
        want, got = sorted(operation["responses"]), sorted(served[op_id][2]["responses"])
        if want != got:
            differences.append(f"{op_id}: contract {want} != app {got}")
    assert not differences, "\n".join(differences)


def test_response_schemas_match_contract(contract, generated):
    """Each operation's success content types and schemas, generated from the code, equal the contract's."""
    served = operations(generated, API_PREFIX)
    differences = []
    for op_id, (_, _, operation) in operations(contract).items():
        status = _success_status(operation)
        want_content = resolve(contract, operation["responses"][status]).get("content", {})
        got_content = served[op_id][2]["responses"][status].get("content", {})
        if sorted(want_content) != sorted(got_content):
            differences.append(f"{op_id} {status}: content types {sorted(want_content)} != {sorted(got_content)}")
            continue
        for media_type, entry in want_content.items():
            want = shape(contract, entry["schema"])
            got = shape(generated, got_content[media_type]["schema"])
            differences += [f"{op_id} {media_type} {line}" for line in shape_differences(want, got)]
    assert not differences, "\n".join(differences)


def test_request_bodies_match_contract(contract, generated):
    served = operations(generated, API_PREFIX)
    differences = []
    for op_id, (_, _, operation) in operations(contract).items():
        want, got = operation.get("requestBody"), served[op_id][2].get("requestBody")
        if (want is None) != (got is None):
            differences.append(f"{op_id}: request body {'missing' if got is None else 'unexpected'}")
            continue
        if want is None:
            continue
        if bool(want.get("required")) != bool(got.get("required")):
            differences.append(f"{op_id}: requestBody.required differs")
        if sorted(want["content"]) != sorted(got["content"]):
            differences.append(f"{op_id}: request content types {sorted(want['content'])} != {sorted(got['content'])}")
            continue
        for media_type, entry in want["content"].items():
            differences += [
                f"{op_id} request {media_type} {line}"
                for line in shape_differences(shape(contract, entry["schema"]), shape(generated, got["content"][media_type]["schema"]))
            ]
    assert not differences, "\n".join(differences)


def test_problem_schema_matches_contract(contract, generated):
    want = shape(contract, contract["components"]["schemas"]["Problem"])
    got = shape(generated, generated["components"]["schemas"]["Problem"])
    assert not shape_differences(want, got)


# ------------------------------------------------------------ response bodies

# (operationId, client fixture, path, query, status). Every read operation has
# successful samples; errors are validated against the Problem schema.
SAMPLES = [
    ("getMeta", "client", "/meta", {}, 200),
    ("listModels", "client", "/models", {}, 200),
    ("getCatalogue", "client", "/catalogue", {}, 200),
    ("getCatalogue", "tiny_client", "/catalogue", {}, 200),
    ("getAtlasOverview", "client", "/atlas/overview", {}, 200),
    ("getChapter", "client", "/atlas/chapters/CH-01", {}, 200),
    ("getChapter", "client", "/atlas/chapters/CH-22", {}, 200),
    ("getMetricMap", "client", "/metrics/map", {**SYN, "scope": "atlas"}, 200),
    ("getMetricMap", "client", "/metrics/map", {**ICU, **SPECIFIC_LENS, "scope": "atlas"}, 200),
    ("getMetricMap", "client", "/metrics/map", {**MEDICORE, "scope": "chapter", "chapter_id": "CH-05"}, 200),
    ("getMetricSummary", "client", "/metrics/summary", SYN, 200),
    ("getMetricSummary", "client", "/metrics/summary", {**ICU, "view": "intended_use"}, 200),
    ("getMetricSummary", "client", "/metrics/summary", {**MEDICORE, "view": "evidence", "age": "Age 0-17"}, 200),
    ("getConceptMetrics", "client", "/metrics/concepts/CH-05", SYN, 200),
    ("getConceptMetrics", "client", "/metrics/concepts/BLK-01-BlockL1-1A0", {**ICU, **SPECIFIC_LENS}, 200),
    ("getConceptMetrics", "client", "/metrics/concepts/1C43", MEDICORE, 200),
    ("getConceptMetrics", "client", "/metrics/concepts/1A03.1", {**SYN, "sex": "Sex Male"}, 200),
    ("getConceptMetrics", "tiny_client", "/metrics/concepts/1A09.1", TINY, 200),
    ("getMultimorbidityCandidates", "client", "/multimorbidity/candidates", {**SYN, "scope": "atlas"}, 200),
    ("getMultimorbidityCandidates", "client", "/multimorbidity/candidates", {**SYN, "scope": "atlas", "selected": "5A11"}, 200),
    (
        "getMultimorbidityCandidates", "client", "/multimorbidity/candidates",
        {**SYN, "scope": "chapter", "chapter_id": "CH-05", "selected": "5A11,GB61", "age": "Age 65+"}, 200,
    ),
    ("getMultimorbidityCandidates", "client", "/multimorbidity/candidates", {**ICU, "scope": "atlas"}, 200),
    ("getMultimorbidityCombination", "client", "/multimorbidity/combination", {**SYN, "selected": "GB61,5A11"}, 200),
    ("getMultimorbidityCombination", "client", "/multimorbidity/combination", {**SYN, "selected": "5A11,1C43"}, 200),
    ("searchConcepts", "client", "/search", {"q": "diabetes"}, 200),
    ("searchConcepts", "client", "/search", {"q": "zzqxj"}, 200),
    ("searchConcepts", "tiny_client", "/search", {"q": "1A0", "limit": 2}, 200),
    ("interpretQuery", "client", "/search/interpret", {"q": "SynGPT-2.0 heart failure in older women in the emergency department"}, 200),
    ("interpretQuery", "tiny_client", "/search/interpret", {"q": "Tiny-1 1A00 for men aged 30, xyz"}, 200),
    ("interpretQuery", "client", "/search/interpret", {"q": "   "}, 422),
    ("exportConcept", "client", "/export/concepts/1C43", SYN, 200),
    ("exportConcept", "client", "/export/concepts/CH-05", {**ICU, "audience": "patient"}, 200),
    ("exportConcept", "tiny_client", "/export/concepts/1A09.1", TINY, 200),
    ("exportDataset", "tiny_client", "/export/dataset", TINY, 200),
    ("getMeta", "client", "/meta", {"version": "staged:upload-1"}, 404),
    ("listModels", "client", "/models", {"version": "draft"}, 422),
    ("getCatalogue", "client", "/catalogue", {"version": "staged:upload-1"}, 404),
    ("getChapter", "client", "/atlas/chapters/BLK-01-BlockL1-1A0", {}, 404),
    ("getMetricMap", "client", "/metrics/map", {"model": "Nope-1", "use_case": "CDSS", "scope": "atlas"}, 404),
    ("getMetricSummary", "client", "/metrics/summary", {**SYN, "use_case": "Nope"}, 404),
    ("getConceptMetrics", "client", "/metrics/concepts/1C43", {**SYN, "age": "Age 100+"}, 422),
    ("getMultimorbidityCombination", "client", "/multimorbidity/combination", {**SYN, "selected": "5A11"}, 422),
    ("searchConcepts", "client", "/search", {"q": " "}, 422),
    ("exportDataset", "client", "/export/dataset", {"model": "Nope-1", "use_case": "CDSS"}, 404),
    # Contract v1.10: reads for the demo pack's local population (CONTRACT.md §21).
    ("getMeta", "demo_client", "/meta", {}, 200),
    ("getCatalogue", "demo_client", "/catalogue", NORTHBRIDGE, 200),
    ("getAtlasOverview", "demo_client", "/atlas/overview", NORTHBRIDGE, 200),
    ("getChapter", "demo_client", "/atlas/chapters/CH-05", NORTHBRIDGE, 200),
    ("getMetricMap", "demo_client", "/metrics/map", {**SYN, **NORTHBRIDGE, "scope": "atlas"}, 200),
    # A product read at a specific group: every block is a rollup without children (child_count 0, v1.10, §6).
    ("getMetricMap", "demo_client", "/metrics/map", {**VANTREL, "age": "Age 65+", "scope": "atlas"}, 200),
    ("getMetricSummary", "demo_client", "/metrics/summary", {**SYN, **NORTHBRIDGE, "view": "evidence"}, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/CH-11", {**SYN, **NORTHBRIDGE}, 200),
    ("getMultimorbidityCandidates", "demo_client", "/multimorbidity/candidates", {**SYN, **NORTHBRIDGE, "scope": "atlas", "selected": "5A11"}, 200),
    ("getMultimorbidityCombination", "demo_client", "/multimorbidity/combination", {**SYN, **NORTHBRIDGE, "selected": "GB61,5A11"}, 200),
    ("searchConcepts", "demo_client", "/search", {"q": "diabetes", **NORTHBRIDGE}, 200),
    ("exportConcept", "demo_client", "/export/concepts/5A11", {**SYN, **NORTHBRIDGE}, 200),
    ("getMetricMap", "demo_client", "/metrics/map", {**SYN, "population": "nowhere", "scope": "atlas"}, 404),
    ("getCatalogue", "demo_client", "/catalogue", {"population": "Not An Id"}, 422),
    # Contract v1.13: the demo pack's study records and the appraisal of linked rows (CONTRACT.md §22).
    ("listStudies", "demo_client", "/studies", {}, 200),
    ("listStudies", "demo_client", "/studies", {"model": "ICU_GPT-1.0"}, 200),
    ("listStudies", "client", "/studies", {}, 200),
    ("getStudy", "demo_client", "/studies/NBR-2026-01", {}, 200),
    ("listEffects", "demo_client", "/effects", {}, 200),
    ("listEffects", "demo_client", "/effects", {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}, 200),
    ("listEffects", "client", "/effects", {}, 200),
    ("listEffects", "demo_client", "/effects", {"model": ""}, 422),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/BA41", VANTREL, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/CH-11", VANTREL, 200),
    ("getStudy", "demo_client", "/studies/NOPE-1", {}, 404),
    ("getStudy", "demo_client", "/studies/bad id", {}, 422),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/1G40", ICU, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/CH-01", ICU, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/5A11", {**SYN, **NORTHBRIDGE}, 200),
    ("exportConcept", "demo_client", "/export/concepts/1G40", ICU, 200),
    # Contract v1.13 (R3): Across groups (CONTRACT.md §24).
    ("getConceptSubgroups", "client", "/metrics/concepts/5A11/subgroups", SYN, 200),
    ("getConceptSubgroups", "client", "/metrics/concepts/CH-05/subgroups", MEDICORE, 200),
    ("getConceptSubgroups", "client", "/metrics/concepts/1A03.1/subgroups", ICU, 200),
    ("getConceptSubgroups", "tiny_client", "/metrics/concepts/1A09.1/subgroups", TINY, 200),
    ("getConceptSubgroups", "demo_client", "/metrics/concepts/5A11/subgroups", {**SYN, **NORTHBRIDGE}, 200),
    ("getConceptSubgroups", "demo_client", "/metrics/concepts/BLK-01-BlockL1-1A0/subgroups", VANTREL, 200),
    ("getConceptSubgroups", "client", "/metrics/concepts/NOPE/subgroups", SYN, 404),
    ("getConceptSubgroups", "client", "/metrics/concepts/5A11/subgroups", {"model": "SynGPT-2.0"}, 422),
    ("getConceptSubgroups", "ontology_client", "/metrics/concepts/MONDO:9000011/subgroups", {**SYN, "ontology": "mondo"}, 200),
    ("getConceptSubgroups", "ontology_client", "/metrics/concepts/E12/subgroups", {**SYN, "ontology": "icd10cm"}, 200),
    ("getConceptSubgroups", "ontology_client", "/metrics/concepts/CM-CH-04/subgroups", {**MEDICORE, "ontology": "icd10cm"}, 200),
    ("getConceptSubgroups", "ontology_client", "/metrics/concepts/5A11/subgroups", {**SYN, "ontology": "snomed"}, 404),
    # Contract v1.14: the group summary (CONTRACT.md §24).
    ("getSubgroupSummary", "client", "/metrics/subgroups/summary", SYN, 200),
    ("getSubgroupSummary", "tiny_client", "/metrics/subgroups/summary", TINY, 200),
    ("getSubgroupSummary", "demo_client", "/metrics/subgroups/summary", {**ICU, **NORTHBRIDGE}, 200),
    ("getSubgroupSummary", "demo_client", "/metrics/subgroups/summary", VANTREL, 200),
    ("getSubgroupSummary", "ontology_client", "/metrics/subgroups/summary", {**SYN, "ontology": "mondo"}, 200),
    ("getSubgroupSummary", "ontology_client", "/metrics/subgroups/summary", {**SYN, "ontology": "snomed"}, 404),
    ("getSubgroupSummary", "client", "/metrics/subgroups/summary", {**SYN, "use_case": "Nope"}, 404),
    ("getSubgroupSummary", "client", "/metrics/subgroups/summary", {"model": "SynGPT-2.0"}, 422),
    # Contract v1.13: reads in another ontology, projected over ICD-11 (CONTRACT.md §23; fixture ontologies).
    ("getMeta", "ontology_client", "/meta", {}, 200),
    ("getAtlasOverview", "ontology_client", "/atlas/overview", {"ontology": "mondo"}, 200),
    ("getChapter", "ontology_client", "/atlas/chapters/CM-CH-04", {"ontology": "icd10cm"}, 200),
    ("getMetricMap", "ontology_client", "/metrics/map", {**SYN, "scope": "atlas", "ontology": "icd10cm"}, 200),
    ("getMetricMap", "ontology_client", "/metrics/map", {**SYN, "scope": "chapter", "chapter_id": "MONDO:0005066", "ontology": "mondo"}, 200),
    ("getMetricSummary", "ontology_client", "/metrics/summary", {**SYN, "view": "intended_use", "ontology": "mondo"}, 200),
    ("getConceptMetrics", "ontology_client", "/metrics/concepts/E14", {**SYN, "ontology": "icd10cm"}, 200),
    ("getConceptMetrics", "ontology_client", "/metrics/concepts/E12", {**MEDICORE, "ontology": "icd10cm"}, 200),
    ("getConceptMetrics", "ontology_client", "/metrics/concepts/MONDO:9000022", {**SYN, **SPECIFIC_LENS, "ontology": "mondo"}, 200),
    ("getConceptMetrics", "ontology_client", "/metrics/concepts/MONDO:0005066", {**SYN, "ontology": "mondo"}, 200),
    ("searchConcepts", "ontology_client", "/search", {"q": "diabetes", "ontology": "icd10cm"}, 200),
    ("exportConcept", "ontology_client", "/export/concepts/MONDO:9000013", {**SYN, "ontology": "mondo"}, 200),
    ("getAtlasOverview", "ontology_client", "/atlas/overview", {"ontology": "snomed"}, 404),
    ("getMetricMap", "ontology_client", "/metrics/map", {**SYN, "scope": "atlas", "ontology": "Not An Id"}, 422),
    # Contract v1.13: the comparison of 2–4 cards (CONTRACT.md §25).
    ("getComparison", "client", "/compare", {"cards": "SynGPT-2.0|Clinician Facing CDSS,ICU_GPT-1.0|CDSS"}, 200),
    ("getComparison", "demo_client", "/compare", {"cards": f"{SYN['model']}|{SYN['use_case']},{VANTREL['model']}|{VANTREL['use_case']},ICU_GPT-1.0|CDSS,radAIology-1|Radiology image analysis", "age": "Age 65+"}, 200),
    ("getComparison", "demo_client", "/compare", {"cards": "ICU_GPT-1.0|CDSS,radAIology-1|Radiology image analysis", "scope": "chapter", "chapter_id": "CH-12", **NORTHBRIDGE}, 200),
    ("getComparison", "ontology_client", "/compare", {"cards": "SynGPT-2.0|Clinician Facing CDSS,MediCore-2.5|Discharge letter generation", "scope": "chapter", "chapter_id": "CM-CH-04", "ontology": "icd10cm"}, 200),
    ("getComparison", "ontology_client", "/compare", {"cards": "SynGPT-2.0|Clinician Facing CDSS,ICU_GPT-1.0|CDSS", "ontology": "mondo"}, 200),
    ("getComparison", "client", "/compare", {"cards": "SynGPT-2.0|Clinician Facing CDSS"}, 422),
    ("getComparison", "client", "/compare", {"cards": "SynGPT-2.0|Clinician Facing CDSS,Nope-1|CDSS"}, 404),
    # Contract v1.13 (CONTRACT.md §26): narrow model cards and the version feed.
    ("getNarrowModelCard", "client", "/models/SynGPT-2.0/narrow-model-card", {}, 200),
    ("getNarrowModelCard", "client", "/models/Nope-1/narrow-model-card", {}, 404),
    ("listDatasetVersions", "client", "/versions", {}, 200),
    ("listDatasetVersions", "demo_client", "/versions", {"after": 3}, 200),
    ("listDatasetVersions", "client", "/versions", {"after": -1}, 422),
    # Contract v1.14 (CONTRACT.md §30): audience reads.
    ("listDatasetVersions", "demo_client", "/versions", {"card": "SynGPT-2.0|Clinician Facing CDSS"}, 200),
    ("listDatasetVersions", "demo_client", "/versions", {"card": "SynGPT-2.0"}, 422),
    ("listSafetyIncidents", "demo_client", "/incidents", {}, 200),
    ("listSafetyIncidents", "demo_client", "/incidents", {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}, 200),
    ("listSafetyIncidents", "client", "/incidents", {}, 200),
    ("listSafetyIncidents", "client", "/incidents", {"model": ""}, 422),
    ("getMetricSummary", "demo_client", "/metrics/summary", {**SYN, **NORTHBRIDGE, "weights": "prevalence"}, 200),
    ("getMetricSummary", "demo_client", "/metrics/summary", {**SYN, "view": "safety", "weights": "prevalence"}, 200),
    ("getMetricSummary", "client", "/metrics/summary", {**SYN, "weights": "people"}, 422),
    # Pack v6's local results of ICU_GPT-1.0 for Northbridge (§26): the map's layer, and the public row beside a local one.
    ("getMetricMap", "demo_client", "/metrics/map", {**ICU, **NORTHBRIDGE, "scope": "atlas"}, 200),
    ("getMetricMap", "demo_client", "/metrics/map", {**ICU, **NORTHBRIDGE, "scope": "chapter", "chapter_id": "CH-11"}, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/1C45", {**ICU, **NORTHBRIDGE}, 200),
    ("getConceptMetrics", "demo_client", "/metrics/concepts/CH-01", {**ICU, **NORTHBRIDGE}, 200),
    ("getNarrowModelCard", "demo_client", "/models/ICU_GPT-1.0/narrow-model-card", {}, 200),
    # Contract v1.14 (Q7): the card record (§32.1) and CDS Hooks discovery (§33).
    ("getCardRecord", "client", "/cards/record", {"model": SYN["model"], "use_case": SYN["use_case"]}, 200),
    ("getCardRecord", "demo_client", "/cards/record", {"model": VANTREL["model"], "use_case": VANTREL["use_case"]}, 200),
    ("getCardRecord", "demo_client", "/cards/record", {"model": "ICU_GPT-1.0", "use_case": "CDSS"}, 200),
    ("getCardRecord", "tiny_client", "/cards/record", {"model": "Tiny-1", "use_case": "CDSS"}, 200),
    ("getCardRecord", "client", "/cards/record", {"model": "Nope-1", "use_case": "CDSS"}, 404),
    ("getCardRecord", "client", "/cards/record", {"model": "SynGPT-2.0"}, 422),
    ("getCdsServices", "client", "/cds-services", {}, 200),
    ("getCdsServices", "demo_client", "/cds-services", {}, 200),
]


def lookup_body(card: dict, codes: list[str], population: dict | None = None, population_id: str | None = None) -> dict:
    """A ``lookup`` request body (contract v1.8; ``population_id`` v1.10) for a card given as ``{"model", "use_case"}``."""
    context = {"card": {"model_version": card["model"], "use_case": card["use_case"]}, "conditions": [{"code": code} for code in codes]}
    if population is not None:
        context["population"] = population
    if population_id is not None:
        context["population_id"] = population_id
    return {"hook": "broad-modelcard-lookup", "context": context}


def cds_body(codes: list[str], card: str = "SynGPT-2.0|Clinician Facing CDSS") -> dict:
    """A CDS Hooks request (v1.14, §33) with ICD-11 codings for a synthetic patient."""
    entries = [{"resource": {"resourceType": "Condition", "code": {"coding": [{"system": "http://id.who.int/icd/release/11/mms", "code": code}]}}} for code in codes]
    return {
        "hook": "patient-view", "hookInstance": "drift-1", "context": {"patientId": "synthetic-1"},
        "prefetch": {"patient": {"resourceType": "Patient", "birthDate": "1958-04", "gender": "male"}, "conditions": {"resourceType": "Bundle", "entry": entries}},
        "extension": {"broad-modelcard": {"card_id": card}},
    }


# lookup (POST, v1.8): (operationId, client fixture, path, query, body, status).
POST_SAMPLES = [
    ("lookup", "client", "/lookup", {}, lookup_body(SYN, ["5A11", "GB61"]), 200),
    ("lookup", "client", "/lookup", {}, lookup_body(SYN, ["1A03.0", "ZZ99", "CA40"], {"age_group": "65+", "sex": "female"}), 200),
    ("lookup", "client", "/lookup", {}, lookup_body(ICU, ["1G40"], {"ethnicity": "asian"}), 200),
    ("lookup", "tiny_client", "/lookup", {}, lookup_body(TINY, ["1A09.1", "1A00"]), 200),
    ("lookup", "client", "/lookup", {}, lookup_body({"model": "Nope-1", "use_case": "CDSS"}, ["5A11"]), 404),
    ("lookup", "client", "/lookup", {}, lookup_body(SYN, []), 422),
    ("lookup", "client", "/lookup", {"version": "staged:upload-1"}, lookup_body(SYN, ["5A11"]), 404),
    ("lookup", "demo_client", "/lookup", {}, lookup_body(SYN, ["5A11", "BA00"], population_id="northbridge-region"), 200),
    ("lookup", "demo_client", "/lookup", {}, lookup_body(SYN, ["5A11"], population_id="nowhere"), 404),
    # Contract v1.14 (Q7, §33): the CDS Hooks service.
    ("callCdsService", "demo_client", "/cds-services/bmc-condition-status", {}, cds_body(["5A11", "BA00", "ZZ99"]), 200),
    ("callCdsService", "tiny_client", "/cds-services/bmc-condition-status", {}, cds_body(["1A00"], card="Tiny-1|CDSS"), 200),
    ("callCdsService", "client", "/cds-services/bmc-condition-status", {}, cds_body(["5A11"], card="Nope-1|CDSS"), 404),
    ("callCdsService", "client", "/cds-services/bmc-condition-status", {}, {**cds_body(["5A11"]), "hook": "order-sign"}, 400),
]


def _sample_id(sample) -> str:
    op_id, _, path, query, status = sample
    return f"{op_id}-{status}-{path}-{json.dumps(query, sort_keys=True)[:60]}"


@pytest.mark.parametrize("sample", SAMPLES, ids=[_sample_id(sample) for sample in SAMPLES])
def test_sample_responses_validate(request, contract, sample):
    op_id, client_name, path, query, status = sample
    response = request.getfixturevalue(client_name).get(API_PREFIX + path, params=query)
    _check_sample(contract, op_id, response, status)


@pytest.mark.parametrize(
    "sample", POST_SAMPLES, ids=[f"{s[0]}-{s[5]}-{json.dumps(s[4]['context'], sort_keys=True)[:60]}" for s in POST_SAMPLES]
)
def test_post_sample_responses_validate(request, contract, sample):
    op_id, client_name, path, query, body, status = sample
    response = request.getfixturevalue(client_name).post(API_PREFIX + path, params=query, json=body)
    _check_sample(contract, op_id, response, status)


def _check_sample(contract: dict, op_id: str, response, status: int) -> None:
    assert response.status_code == status, response.text[:300]
    operation = operations(contract)[op_id][2]
    schema = _contract_json_schema(contract, operation, str(status))
    expected_type = "application/json" if status == 200 else "application/problem+json"
    assert response.headers["content-type"].split(";")[0] == expected_type
    errors = Validator(contract).errors(response.json(), schema)
    assert not errors, "\n".join(errors[:20])


def test_every_read_operation_has_a_successful_sample(contract):
    sampled = {op_id for op_id, _, _, _, status in SAMPLES if status == 200}
    sampled |= {sample[0] for sample in POST_SAMPLES if sample[-1] == 200}
    # The search rewrite (v1.14) needs the helper configured; test_admin_responses_validate samples it.
    sampled |= {"interpretQueryWithHelper"}
    reads = {op_id for op_id, (_, _, operation) in operations(contract).items() if "admin" not in operation["tags"]}
    assert sampled == reads


# ------------------------------------------------------------- admin bodies

class _Checked:
    """Validates admin responses against the contract and records which operations were seen."""

    def __init__(self, contract: dict):
        self.contract = contract
        self.validator = Validator(contract)
        self.seen: set[tuple[str, int]] = set()

    def __call__(self, op_id: str, response, status: int):
        assert response.status_code == status, f"{op_id}: {response.status_code} {response.text[:300]}"
        operation = operations(self.contract)[op_id][2]
        declared = operation["responses"].get(str(status))
        assert declared is not None or status >= 400, f"{op_id} does not declare {status}"
        self.seen.add((op_id, status))
        content_type = response.headers.get("content-type", "").split(";")[0]
        if status >= 400:
            assert content_type == "application/problem+json"
            schema = {"$ref": "#/components/schemas/Problem"}
        else:
            content = resolve(self.contract, declared).get("content", {})
            if not content:
                assert not response.content
                return response
            assert content_type in content, f"{op_id}: {content_type} not in {sorted(content)}"
            if content_type != "application/json":
                return response
            schema = content[content_type]["schema"]
        errors = self.validator.errors(response.json(), schema)
        assert not errors, f"{op_id}: " + "\n".join(errors[:20])
        return response


def test_admin_responses_validate(contract, admin_client):
    """One pass through the update workflow; every response validates against the contract."""
    check = _Checked(contract)
    client = admin_client
    check("listDatasets", client.get(f"{ADMIN}/datasets"), 200)
    for file_format in ("csv", "xlsx"):
        check("downloadTemplate", client.get(f"{ADMIN}/templates/prevalence.{file_format}"), 200)
    check("downloadTemplate", client.get(f"{ADMIN}/templates/metrics.csv", params={"filled": "true"}), 422)
    check("downloadTemplate", client.get(f"{ADMIN}/templates/metrics.csv", params={"filled": "true", "model_version": "Nope", "use_case": "CDSS"}), 404)

    header, rows, _ = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    rows[0][header.index("Performance")] = "0.93"
    rows[0][header.index("CI low")] = "0.9"
    rows[0][header.index("CI high")] = "0.95"
    created = check("createUpload", post_upload(client, "metrics", write_csv(header, rows), **TINY_TARGET), 202).json()
    upload_id = created["upload_id"]
    wait(client, upload_id)
    check("getUpload", client.get(f"{ADMIN}/uploads/{upload_id}"), 200)
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{upload_id}/changes"), 200)
    for file_format in ("csv", "xlsx"):
        check("downloadAnnotatedUpload", client.get(f"{ADMIN}/uploads/{upload_id}/annotated.{file_format}"), 200)
    check("createUpload", post_upload(client, "metrics", write_csv(header, rows), **TINY_TARGET), 409)
    check("getMeta", client.get(f"{API_PREFIX}/meta", params={"version": f"staged:{upload_id}"}), 200)
    check("getCatalogue", client.get(f"{API_PREFIX}/catalogue", params={"version": f"staged:{upload_id}"}), 200)
    published = check("publishUpload", client.post(f"{ADMIN}/uploads/{upload_id}/publish", json={"previewed": True}), 200).json()
    check("publishUpload", client.post(f"{ADMIN}/uploads/{upload_id}/publish", json={"previewed": False}), 409)
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{upload_id}/changes"), 409)
    check("listVersions", client.get(f"{ADMIN}/versions"), 200)
    check("listVersions", client.get(f"{ADMIN}/versions", params={"kind": "metrics"}), 200)
    check("rollbackVersion", client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"}), 200)
    no_change = check("rollbackVersion", client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"}), 409).json()
    assert no_change["code"] == "rollback_no_change"  # contract v1.11
    check("rollbackVersion", client.post(f"{ADMIN}/versions/{published['version_id'] + 5}/rollback"), 404)

    invalid = check("createUpload", post_upload(client, "prevalence", b"ICD-11 code,Commonness\nXX99,Rare\n"), 202).json()
    wait(client, invalid["upload_id"])
    check("getUpload", client.get(f"{ADMIN}/uploads/{invalid['upload_id']}"), 200)
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{invalid['upload_id']}/changes"), 409)
    check("discardUpload", client.delete(f"{ADMIN}/uploads/{invalid['upload_id']}"), 204)
    check("discardUpload", client.delete(f"{ADMIN}/uploads/{invalid['upload_id']}"), 409)
    check("downloadAnnotatedUpload", client.get(f"{ADMIN}/uploads/{invalid['upload_id']}/annotated.csv"), 409)
    check("getUpload", client.get(f"{ADMIN}/uploads/up-missing"), 404)
    check("createUpload", post_upload(client, "prevalence", b"%PDF-1.7", "data.pdf"), 415)
    check("createUpload", post_upload(client, "metrics", b"x"), 422)
    check("listDatasets", client.get(f"{ADMIN}/datasets"), 200)

    # Contract v1.7: a safety incident as a records upload (a merge), published with a note,
    # read back on the atlas reads, and rolled back with a note.
    incident = {
        "incident_id": "SI-T-1", "model_version": "Tiny-1", "use_case": "CDSS", "codes": "1A00.0", "age": "Age 65+",
        "incident_type": "Subgroup bias", "harm": "Possible", "status": "Open", "source_type": "Study",
        "source_reference": "Fictional study (synthetic)", "study_id": "T-1", "reported_date": "2026-10-01",
        "summary": "Synthetic test incident.",
    }
    records = check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [incident]}), 202).json()
    assert records["mode"] == "merge" and records["origin"] == "records"
    wait(client, records["upload_id"])
    check("getUpload", client.get(f"{ADMIN}/uploads/{records['upload_id']}"), 200)
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{records['upload_id']}/changes"), 200)
    check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/1A00", params={**TINY, "version": f"staged:{records['upload_id']}"}), 200)
    entry = check("publishUpload", client.post(f"{ADMIN}/uploads/{records['upload_id']}/publish", json={"previewed": True, "note": "One incident."}), 200).json()
    assert entry["note"] == "One incident."
    concept = check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/1A00", params=TINY), 200).json()
    assert [incident["severity"] for incident in concept["incidents"]] == ["serious"]
    # Contract v1.11: the Data Library's incident list.
    listed = check("listIncidents", client.get(f"{ADMIN}/safety/incidents"), 200).json()
    assert [incident["incident_id"] for incident in listed["incidents"]] == ["SI-T-1"]
    check("listIncidents", client.get(f"{ADMIN}/safety/incidents", params={"model": "Tiny-1", "use_case": "CDSS"}), 200)
    check("listIncidents", client.get(f"{ADMIN}/safety/incidents", params={"version": "staged:nope"}), 404)
    check("listIncidents", client.get(f"{ADMIN}/safety/incidents", params={"version": "bad"}), 422)
    check("getMetricMap", client.get(f"{API_PREFIX}/metrics/map", params={**TINY, "scope": "atlas"}), 200)
    check("getMetricSummary", client.get(f"{API_PREFIX}/metrics/summary", params={**TINY, "view": "safety"}), 200)
    check("getCatalogue", client.get(f"{API_PREFIX}/catalogue"), 200)
    invalid = check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [{**incident, "codes": "XX99"}]}), 202).json()
    errors = wait(client, invalid["upload_id"])["report"]["errors"]
    assert errors[0]["examples"][0]["record"] == 0
    check("getUpload", client.get(f"{ADMIN}/uploads/{invalid['upload_id']}"), 200)
    check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json={"kind": "models", "records": [{}]}), 422)
    check("publishUpload", client.post(f"{ADMIN}/uploads/{invalid['upload_id']}/publish", json={"previewed": False, "note": "x" * 501}), 422)
    rolled = check("rollbackVersion", client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "safety"}, json={"note": "Undo."}), 200).json()
    assert rolled["note"] == "Undo."

    # Contract v1.9: assisted data entry with a fake provider (no network).
    study = "Synthetic study T-9 (fictional), 2026-10-01: Tiny-1 as CDSS had an accuracy of 0.9 for condition 1A00."
    assist = client.app.state.assist
    assert assist.config_path.name == "tiny.assist.json"  # next to the private tiny store, never the live one
    off = check("getAssistStatus", client.get(f"{ADMIN}/assist"), 200).json()
    assert off["enabled"] is False and off["how_to_enable"]
    check("proposeRecords", client.post(f"{ADMIN}/assist/proposals", data={"kind": "metrics", "text": study}), 409)
    check("configureAssist", client.put(f"{ADMIN}/assist", json={"provider": "hosted"}), 422)
    on = check("configureAssist", client.put(f"{ADMIN}/assist", json={"provider": "local", "model": "fake-local", "base_url": "http://127.0.0.1:9/v1"}), 200).json()
    assert on["enabled"] and on["key_set"] is False and "pdf" not in on["accepts"]
    check("getAssistStatus", client.get(f"{ADMIN}/assist"), 200)
    assist.provider_factory = lambda config: FakeProvider.for_study_set({from_text(study).sha256: TINY_ANSWER}, kind=config.provider)
    proposals = check("proposeRecords", client.post(f"{ADMIN}/assist/proposals", data={"kind": "metrics", "text": study}), 200).json()
    assert [batch["model_version"] for batch in proposals["batches"]] == ["Tiny-1"]
    # Contract v1.14 (§31): the search rewrite, with the same fake provider.
    helper = FakeProvider.for_study_set({}, kind="local")
    helper.interpretations = {"tiny cdss for 1A00 in women": {"chips": [
        {"kind": "system", "value": "Tiny-1", "matched_text": "tiny"}, {"kind": "condition", "value": "1A00", "matched_text": "1A00"},
        {"kind": "sex", "value": "Sex Female", "matched_text": "women"}, {"kind": "age", "value": "Age 200+", "matched_text": "x"},
    ], "unrecognized": ["cdss"]}}
    assist.provider_factory = lambda config: helper
    rewritten = check("interpretQueryWithHelper", client.post(f"{API_PREFIX}/assist/interpret", json={"q": "tiny cdss for 1A00 in women"}), 200).json()
    assert [chip["kind"] for chip in rewritten["chips"]] == ["system", "condition", "sex"]
    assert rewritten["dropped"] == [{"kind": "age", "value": "Age 200+", "reason": "unknown_value"}]
    check("interpretQueryWithHelper", client.post(f"{API_PREFIX}/assist/interpret", json={"q": ""}), 422)
    check("proposeRecords", client.post(f"{ADMIN}/assist/proposals", data={"kind": "metrics"}), 422)
    check("proposeRecords", client.post(f"{ADMIN}/assist/proposals", data={"kind": "metrics"}, files={"file": ("s.pdf", b"%PDF-1.4 x", "application/pdf")}), 422)
    check("proposeRecords", client.post(f"{ADMIN}/assist/proposals", data={"kind": "metrics"}, files={"file": ("s.docx", b"PK\x03\x04", "application/octet-stream")}), 415)
    check("clearAssist", client.delete(f"{ADMIN}/assist"), 204)
    check("interpretQueryWithHelper", client.post(f"{API_PREFIX}/assist/interpret", json={"q": "tiny"}), 409)

    # Contract v1.10: a local population, previewed, published, read, and removed (CONTRACT.md §21).
    population = {"population_id": "tiny-region", "population_name": "Tiny region (fictional)"}
    check("createUpload", post_upload(client, "population", b"ICD-11 code,Commonness\n1A00,Very rare\n"), 422)
    local = check("createUpload", post_upload(client, "population", b"ICD-11 code,Commonness\n1A00,Very rare\n", **population), 202).json()
    assert local["target"] == population
    wait(client, local["upload_id"])
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{local['upload_id']}/changes"), 200)
    staged = {"version": f"staged:{local['upload_id']}", "population": "tiny-region"}
    check("getMetricMap", client.get(f"{API_PREFIX}/metrics/map", params={**TINY, **staged, "scope": "atlas"}), 200)
    check("getMetricMap", client.get(f"{API_PREFIX}/metrics/map", params={**TINY, "population": "tiny-region", "scope": "atlas"}), 404)
    check("publishUpload", client.post(f"{ADMIN}/uploads/{local['upload_id']}/publish", json={"previewed": True, "note": "Tiny region."}), 200)
    meta = check("getMeta", client.get(f"{API_PREFIX}/meta"), 200).json()
    assert [entry["id"] for entry in meta["populations"]] == ["tiny-region"]
    check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/1A00", params={**TINY, "population": "tiny-region"}), 200)
    check("exportDataset", client.get(f"{API_PREFIX}/export/dataset", params={**TINY, "population": "tiny-region"}), 200)
    check("downloadTemplate", client.get(f"{ADMIN}/templates/population.csv", params={"filled": "true", "population_id": "tiny-region"}), 200)
    check("downloadTemplate", client.get(f"{ADMIN}/templates/population.csv", params={"filled": "true", "population_id": "nowhere"}), 404)
    check("listVersions", client.get(f"{ADMIN}/versions", params={"kind": "population"}), 200)
    removed = check("removePopulation", client.post(f"{ADMIN}/populations/tiny-region/remove", json={"note": "Not needed."}), 200).json()
    assert removed["kind"] == "population" and removed["note"] == "Not needed."
    check("removePopulation", client.post(f"{ADMIN}/populations/tiny-region/remove"), 404)

    # Contract v1.13: a study as a records upload, a metrics merge that links to it, and the appraisal (CONTRACT.md §22).
    for file_format in ("csv", "xlsx"):
        check("downloadTemplate", client.get(f"{ADMIN}/templates/studies.{file_format}"), 200)
    record = {
        "study_id": "T-S-1", "title": "Synthetic study (fictional)", "design": "Prospective", "setting": "Tiny ward (fictional)",
        "sites": 2, "patients": 300, "peer_reviewed": True, "conducted_by": "Hospital", "reporting_guideline": "TRIPOD+AI",
        "guideline_followed": "Partly", "risk_of_bias": "Some concerns", "population": "Adults (synthetic)",
        "evaluation_conditions": "Synthetic.", "model_version": "Tiny-1", "publication_date": "2026-10-01",
    }
    studies = check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "records": [record]}), 202).json()
    wait(client, studies["upload_id"])
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{studies['upload_id']}/changes"), 200)
    check("listStudies", client.get(f"{API_PREFIX}/studies", params={"version": f"staged:{studies['upload_id']}"}), 200)
    check("publishUpload", client.post(f"{ADMIN}/uploads/{studies['upload_id']}/publish", json={"previewed": False, "note": "One study."}), 200)
    check("getStudy", client.get(f"{API_PREFIX}/studies/T-S-1"), 200)
    check("listVersions", client.get(f"{ADMIN}/versions", params={"kind": "studies"}), 200)
    header, rows, _ = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    first = rows[0]
    first[header.index("Source")], first[header.index("Study")], first[header.index("Source date")] = "Synthetic study (fictional)", "T-S-1", "2026-10-02"
    linked = check("createUpload", post_upload(client, "metrics", write_csv(header, [first]), **TINY_TARGET, mode="merge"), 202).json()
    wait(client, linked["upload_id"])
    check("publishUpload", client.post(f"{ADMIN}/uploads/{linked['upload_id']}/publish", json={"previewed": False, "note": "Linked."}), 200)
    appraised = check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/{first[0]}", params=TINY), 200).json()
    assert appraised["metrics"]["appraisal"]["study"]["study_id"] == "T-S-1"
    check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/CH-01", params=TINY), 200)

    _check_local_roles(check, client)

    admin = {op_id for op_id, (_, _, operation) in operations(contract).items() if "admin" in operation["tags"]}
    assert admin <= {op_id for op_id, status in check.seen if status < 300}


def _check_local_roles(check, client) -> None:
    """Contract v1.13 (CONTRACT.md §26): the release export (public instance), the
    instance profile, local results with role and name, a developer submission
    with a narrow model card and its proposals, and a release import."""
    bundle = check("exportPublicRelease", client.get(f"{ADMIN}/release/export"), 200).content
    check("importPublicRelease", client.post(f"{ADMIN}/release/imports", files={"file": ("r.sqlite.gz", bundle, "application/gzip")}), 409)
    profile = {"kind": "hospital", "organisation": "Tiny Hospital (fictional)", "maintained_by": "AI office (fictional)", "contact": None}
    check("updateInstance", client.put(f"{ADMIN}/instance", json=profile), 200)
    check("updateInstance", client.put(f"{ADMIN}/instance", json={**profile, "kind": "clinic"}), 422)
    assert check("getMeta", client.get(f"{API_PREFIX}/meta"), 200).json()["instance"] == profile
    check("exportPublicRelease", client.get(f"{ADMIN}/release/export"), 409)

    region = {"population_id": "tiny-local", "population_name": "Tiny local (fictional)"}
    population = check("createUpload", post_upload(client, "population", b"ICD-11 code,Commonness\n1A00,Rare\n", **region), 202).json()
    wait(client, population["upload_id"])
    published = {"previewed": False, "role": "hospital", "publisher_name": "H"}
    check("publishUpload", client.post(f"{ADMIN}/uploads/{population['upload_id']}/publish", json=published), 200)
    evaluation = {
        "study_id": "TL-1", "title": "Local evaluation (fictional)", "design": "Retrospective", "setting": "Tiny ward (fictional)",
        "sites": 1, "patients": 120, "peer_reviewed": False, "conducted_by": "Hospital", "reporting_guideline": "None",
        "risk_of_bias": "Low", "population": "Adults (synthetic)", "evaluation_conditions": "Synthetic.", "publication_date": "2026-10-10",
        "scope": "Hospital", "population_id": "tiny-local",
    }
    studies = check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "records": [evaluation]}), 202).json()
    wait(client, studies["upload_id"])
    check("publishUpload", client.post(f"{ADMIN}/uploads/{studies['upload_id']}/publish", json=published), 200)
    header, _, _ = read_csv(template(client, "local_metrics"))
    values = {
        "ICD-11 code": "1A00", "Age": "All ages", "Sex": "All sexes", "Ethnicity": "All ethnicities", "Performance": "0.5",
        "CI low": "0.45", "CI high": "0.55", "Samples": "300", "Sites": "1", "Validation type": "Clinical study (single site)",
        "In intended use": "Yes", "Intended-use coverage": "1", "Intended-use level": "In scope", "Source": "Ward (fictional)",
        "Study": "TL-1", "Source date": "2026-10-11",
    }
    rows = write_csv(header, [[values.get(column, "") for column in header]])
    local = check("createUpload", post_upload(client, "local_metrics", rows, **TINY_TARGET, population_id="tiny-local"), 202).json()
    wait(client, local["upload_id"])
    check("getUploadChanges", client.get(f"{ADMIN}/uploads/{local['upload_id']}/changes"), 200)
    entry = check("publishUpload", client.post(f"{ADMIN}/uploads/{local['upload_id']}/publish", json=published), 200).json()
    assert (entry["kind"], entry["publisher_role"], entry["publisher_name"]) == ("local_metrics", "hospital", "H")
    mapped = check("getMetricMap", client.get(f"{API_PREFIX}/metrics/map", params={**TINY, "scope": "atlas", "population": "tiny-local"}), 200).json()
    assert "includes_local" in mapped["layer"]
    concept = check("getConceptMetrics", client.get(f"{API_PREFIX}/metrics/concepts/1A00", params={**TINY, "population": "tiny-local"}), 200).json()
    assert concept["metrics"]["provenance"]["layer"] == "local" and concept["public_metrics"] is not None
    check("listVersions", client.get(f"{ADMIN}/versions", params={"kind": "local_metrics"}), 200)
    check("listDatasetVersions", client.get(f"{API_PREFIX}/versions"), 200)

    submission = check("createSubmission", client.post(f"{ADMIN}/submissions", json={"developer_name": "Dev", "model_version": "Tiny-1"}), 201).json()
    sid = submission["submission_id"]
    check("createSubmission", client.post(f"{ADMIN}/submissions", json={"developer_name": "", "model_version": "Tiny-1"}), 422)
    card = {"name": "Tiny-1", "results": [{"task": "triage", "dataset": "Bench (fictional)", "metric": "accuracy", "value": 0.8, "icd11_codes": ["1A01"]}]}
    body = {"model_version": "Tiny-1", "format": "json", "content": json.dumps(card), "submission_id": sid}
    staged = check("createModelCardUpload", client.post(f"{ADMIN}/uploads/model-card", json=body), 202).json()
    check("createModelCardUpload", client.post(f"{ADMIN}/uploads/model-card", json={**body, "format": "yaml"}), 422)
    wait(client, staged["upload_id"])
    proposals = check("getModelCardProposals", client.get(f"{ADMIN}/uploads/{staged['upload_id']}/proposed-records"), 200).json()
    check("getModelCardProposals", client.get(f"{ADMIN}/uploads/{local['upload_id']}/proposed-records"), 409)
    # Contract v1.14 (Q7, §32.2): an evaluation results file and its proposed records.
    run = {
        "format": "bmc-evaluation-results/1", "model_version": "Tiny-1", "use_case": "CDSS", "configuration_id": "cfg-tiny-1",
        "benchmark": {"name": "Tiny bench (fictional)", "version": "1"}, "run_date": "2026-10-12", "conducted_by": "independent",
        "results": [{"icd11_code": "1A00", "measure": "Accuracy", "value": 0.7, "ci_low": 0.6, "ci_high": 0.8, "cases": 50, "sites": 1}],
    }
    imported = check("createEvaluationUpload", client.post(f"{ADMIN}/uploads/evaluation-results", json={"content": json.dumps(run)}), 202).json()
    check("createEvaluationUpload", client.post(f"{ADMIN}/uploads/evaluation-results", json={"content": ""}), 422)
    wait(client, imported["upload_id"])
    proposed = check("getEvaluationProposals", client.get(f"{ADMIN}/uploads/{imported['upload_id']}/evaluation-proposals"), 200).json()
    assert proposed["study"]["design"] == "benchmark" and len(proposed["metrics"]["records"]) == 1
    check("getEvaluationProposals", client.get(f"{ADMIN}/uploads/{local['upload_id']}/evaluation-proposals"), 409)
    check("getEvaluationProposals", client.get(f"{ADMIN}/uploads/up-nope/evaluation-proposals"), 404)
    check("getUpload", client.get(f"{ADMIN}/uploads/{imported['upload_id']}"), 200)
    check("discardUpload", client.delete(f"{ADMIN}/uploads/{imported['upload_id']}"), 204)
    batch = proposals["batches"][0]
    request = {"kind": "metrics", "model_version": batch["model_version"], "use_case": batch["use_case"], "records": batch["records"], "submission_id": sid}
    check("createRecordsUpload", client.post(f"{ADMIN}/uploads/records", json=request), 202)
    check("publishUpload", client.post(f"{ADMIN}/uploads/{staged['upload_id']}/publish", json={"previewed": False}), 409)
    check("listSubmissions", client.get(f"{ADMIN}/submissions"), 200)
    check("getSubmission", client.get(f"{ADMIN}/submissions/{sid}"), 200)
    check("getSubmission", client.get(f"{ADMIN}/submissions/nope"), 404)
    client.app.state.api.admin.wait_for_checks()
    accepted = check("acceptSubmission", client.post(f"{ADMIN}/submissions/{sid}/accept", json={"note": "Fine.", "publisher_name": "C"}), 200).json()
    assert accepted["status"] == "accepted"
    check("acceptSubmission", client.post(f"{ADMIN}/submissions/{sid}/accept"), 409)
    other = check("createSubmission", client.post(f"{ADMIN}/submissions", json={"developer_name": "Dev", "model_version": "Tiny-1"}), 201).json()
    check("returnSubmission", client.post(f"{ADMIN}/submissions/{other['submission_id']}/return", json={"note": "Nothing in it."}), 200)
    check("returnSubmission", client.post(f"{ADMIN}/submissions/{other['submission_id']}/return", json={"note": "Again."}), 409)

    files = {"file": ("r.sqlite.gz", bundle, "application/gzip")}
    imported = check("importPublicRelease", client.post(f"{ADMIN}/release/imports", files=files), 201).json()
    assert imported["status"] == "valid", imported["problems"]
    check("getReleaseImport", client.get(f"{ADMIN}/release/imports/{imported['import_id']}"), 200)
    check("getReleaseImport", client.get(f"{ADMIN}/release/imports/nope"), 404)
    second = check("importPublicRelease", client.post(f"{ADMIN}/release/imports", files=files), 201).json()
    check("discardReleaseImport", client.delete(f"{ADMIN}/release/imports/{second['import_id']}"), 204)
    check("discardReleaseImport", client.delete(f"{ADMIN}/release/imports/{second['import_id']}"), 409)
    check("publishReleaseImport", client.post(f"{ADMIN}/release/imports/{imported['import_id']}/publish", json={"note": "Release.", "role": "hospital"}), 200)
    check("publishReleaseImport", client.post(f"{ADMIN}/release/imports/{imported['import_id']}/publish"), 409)


def test_unknown_route_is_a_problem(client, contract):
    response = client.get(f"{API_PREFIX}/no-such-thing")
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"
    assert not Validator(contract).errors(response.json(), {"$ref": "#/components/schemas/Problem"})


def test_registry_entry_fields_validate(contract, admin_client):
    """listModels with every v1.5 entry and configuration field set (a model and a product) validates."""
    client = admin_client
    header, rows, comments = read_csv(template(client, "models", filled="true"))
    values = {
        "Kind": "Model", "AI type": "Tabular risk model", "Developer": "Tinyworks Labs (fictional)",
        "Release date": "2025-11-03", "Description": "A tiny fictional model.", "Function category": "Decision support",
        "Declared intended purpose": "Fictional.", "Declared regulatory status": "Not assessed (demonstration)",
        "Declared contact": "tests@tinyworks.example", "Declared documentation URL": "https://tinyworks.example/docs",
    }
    for column, value in values.items():
        rows[0][header.index(column)] = value
    product = list(rows[0])
    for column, value in {"Model version": "TinyCare-1", "Display name": "TinyCare 1", "Default model": "No",
                          "Kind": "Product", "Built on": "Tiny-1", "Release date": ""}.items():
        product[header.index(column)] = value
    rows.append(product)
    registry = post_upload(client, "models", write_csv(header, rows, comments)).json()
    metrics = post_upload(client, "metrics", template(client, "metrics", filled="true", **TINY_TARGET),
                          model_version="TinyCare-1", use_case="CDSS").json()
    wait(client, metrics["upload_id"])
    assert client.post(f"{ADMIN}/uploads/{metrics['upload_id']}/publish", json={"previewed": False}).status_code == 200
    assert wait(client, registry["upload_id"])["status"] == "valid"
    assert client.post(f"{ADMIN}/uploads/{registry['upload_id']}/publish", json={"previewed": False}).status_code == 200

    response = client.get(f"{API_PREFIX}/models")
    body = response.json()
    assert [model["kind"] for model in body["models"]] == ["model", "product"]
    assert body["models"][1]["release_date"] is None and body["models"][1]["built_on"] == ["Tiny-1"]
    schema = _contract_json_schema(contract, operations(contract)["listModels"][2], "200")
    errors = Validator(contract).errors(body, schema)
    assert not errors, "\n".join(errors[:20])
