"""Evaluation results imports (contract v1.14, CONTRACT.md §32.2).

A benchmark or harness run's JSON (format bmc-evaluation-results/1) is checked
in the background, offers proposed records (a benchmark study and one metrics
merge record per result), and never publishes on its own.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from admin_helpers import ADMIN
from conftest import copy_store, local_client

from app import db
from app.main import API_PREFIX, create_app

EXAMPLE = Path(__file__).resolve().parents[2] / "docs" / "evaluation-results-example.json"
SYN = {"model_version": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}


def run(**changes) -> dict:
    body = {
        "format": "bmc-evaluation-results/1",
        **SYN,
        "configuration_id": "cfg-test-1",
        "benchmark": {"name": "Test Bench (fictional)", "version": "2.1", "description": "Synthetic vignettes.", "url": "https://bench.example/"},
        "run_date": "2026-10-16",
        "conducted_by": "independent",
        "setting": "emergency_department",
        "results": [
            {"icd11_code": "5A11", "measure": "Top-3 diagnostic accuracy", "value": 0.81, "ci_low": 0.76, "ci_high": 0.86, "cases": 240, "sites": 3},
            {"icd11_code": "BA41.Z", "measure": "Top-3 diagnostic accuracy", "value": 0.7, "cases": 60, "age": "Age 65+"},
            {"icd11_code": "CA40", "measure": "Top-3 diagnostic accuracy", "value": 0.66, "cases": 90, "sex": "Sex Female", "sites": 2},
        ],
    }
    body.update(changes)
    return body


@pytest.fixture
def seed_client(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "seed.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        yield client


@pytest.fixture
def demo_copy_client(demo_db, tmp_path):
    store = copy_store(demo_db[0], tmp_path / "demo.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        yield client


def send(client, body, **extra) -> dict:
    content = body if isinstance(body, str) else json.dumps(body)
    response = client.post(f"{ADMIN}/uploads/evaluation-results", json={"content": content, **extra})
    assert response.status_code == 202, response.text[:400]
    client.app.state.api.admin.wait_for_checks()
    return client.get(f"{ADMIN}/uploads/{response.json()['upload_id']}").json()


def codes(upload: dict, part: str = "errors") -> set[str]:
    return {group["code"] for group in upload["report"][part]}


def versions(client) -> int:
    return len(client.get(f"{ADMIN}/versions").json())


def test_the_documented_example_is_valid_on_the_demo_store(demo_copy_client):
    upload = send(demo_copy_client, EXAMPLE.read_text(encoding="utf-8"))
    assert upload["status"] == "valid", upload["report"]
    assert upload["kind"] == "evaluation_results" and upload["target"]["model_version"]
    assert upload["report"]["row_count"] == len(json.loads(EXAMPLE.read_text(encoding="utf-8"))["results"])


def test_a_valid_run_is_checked_in_the_background_and_publishes_nothing(seed_client):
    before = versions(seed_client)
    upload = send(seed_client, run())
    assert upload["status"] == "valid", upload["report"]
    assert upload["target"] == SYN and upload["report"]["row_count"] == 3
    # The seed's card states no configuration: a note, never an error.
    assert codes(upload, "notes") == {"configuration_not_current"}
    upload_id = upload["upload_id"]
    published = seed_client.post(f"{ADMIN}/uploads/{upload_id}/publish", json={"previewed": False})
    assert published.status_code == 409 and published.json()["code"] == "upload_not_valid"
    assert "publish nothing" in published.json()["detail"]
    assert seed_client.get(f"{ADMIN}/uploads/{upload_id}/changes").status_code == 409
    # A document upload has no checked copy (409, never a 500; review of release 0.5).
    for file_format in ("xlsx", "csv"):
        annotated = seed_client.get(f"{ADMIN}/uploads/{upload_id}/annotated.{file_format}")
        assert annotated.status_code == 409 and annotated.json()["code"] == "upload_not_valid", annotated.text
    staged = seed_client.get(f"{API_PREFIX}/meta", params={"version": f"staged:{upload_id}"})
    assert staged.status_code == 409
    seed_client.get(f"{ADMIN}/uploads/{upload_id}/evaluation-proposals")
    assert versions(seed_client) == before


@pytest.mark.parametrize(
    ("content", "code", "fix_words"),
    [
        ("{not json", "invalid_evaluation_file", "bmc-evaluation-results/1"),
        (json.dumps([1, 2]), "invalid_evaluation_file", "JSON object"),
        (json.dumps(run(format="other/1")), "invalid_evaluation_file", "evaluation-results-example.json"),
        (json.dumps({k: v for k, v in run().items() if k != "run_date"}), "evaluation_field", "run_date"),
        (json.dumps(run(run_date="2026-02-30")), "evaluation_field", "day of the run"),
        (json.dumps(run(conducted_by="vendor")), "evaluation_field", "who ran"),
        (json.dumps(run(configuration_id="cfg 1")), "evaluation_field", "configuration label"),
        (json.dumps(run(results=[])), "evaluation_field", "at least one result"),
        (json.dumps(run(model_version="Nope-9")), "unknown_target", "AI systems & functions"),
        (json.dumps(run(results=[{"icd11_code": "ZZ99", "measure": "m", "value": 0.5, "cases": 3}])), "unknown_icd_code", "codes of other classifications"),
        (json.dumps(run(results=[{"icd11_code": "5A11", "measure": "m", "value": 81, "cases": 3}])), "out_of_range", "0.84, not 84"),
        (json.dumps(run(results=[{"icd11_code": "5A11", "measure": "m", "value": 0.5, "ci_low": 0.6, "ci_high": 0.4, "cases": 3}])), "ci_low_above_ci_high", "ci_low ≤ ci_high"),
        (json.dumps(run(results=[{"icd11_code": "5A11", "measure": "m", "value": 0.9, "ci_low": 0.4, "ci_high": 0.6, "cases": 3}])), "perf_outside_ci", "ci_low ≤ value ≤ ci_high"),
        (json.dumps(run(results=[{"icd11_code": "5A11", "measure": "m", "value": 0.5, "cases": 0}])), "out_of_range", "at least 1"),
        (json.dumps(run(results=[{"icd11_code": "5A11", "measure": "m", "value": 0.5, "cases": 3, "age": "Age 99+"}])), "unknown_lens_value", "Age 65+"),
        (
            json.dumps(run(results=[
                {"icd11_code": "BA41", "measure": "m", "value": 0.5, "cases": 3},
                {"icd11_code": "BA41.Z", "measure": "m", "value": 0.6, "cases": 4},
            ])),
            "duplicate_key", "one result per condition",
        ),
    ],
)
def test_malformed_files_are_invalid_with_a_plain_fix(seed_client, content, code, fix_words):
    upload = send(seed_client, content)
    assert upload["status"] == "invalid"
    group = next(group for group in upload["report"]["errors"] if group["code"] == code)
    assert fix_words in group["fix"] or any(fix_words in example["problem"] for example in group["examples"]), group


def test_the_size_limit_is_that_of_a_narrow_model_card(seed_client):
    big = json.dumps(run()) + " " * (1024 * 1024)
    response = seed_client.post(f"{ADMIN}/uploads/evaluation-results", json={"content": big})
    assert response.status_code == 413 and response.json()["code"] == "upload_too_large"


def test_proposals_hold_one_benchmark_study_and_one_merge_record_per_result(seed_client):
    upload = send(seed_client, run())
    proposals = seed_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/evaluation-proposals").json()
    study = proposals["study"]
    assert study["study_id"] == "EVAL-TEST-BENCH-2-1-20261016"
    assert study["design"] == "benchmark" and study["conducted_by"] == "independent"
    assert study["patients"] == 240 + 60 + 90 and study["sites"] == 3
    assert study["peer_reviewed"] == "No" and study["risk_of_bias"] == "unclear" and study["reporting_guideline"] == "none"
    assert study["publication_date"] == "2026-10-16" and study["configuration_id"] == "cfg-test-1"
    assert study["setting_category"] == "emergency_department" and study["source_url"] == "https://bench.example/"
    assert study["title"].startswith("Test Bench (fictional) 2.1")
    records = proposals["metrics"]["records"]
    assert proposals["metrics"]["model_version"] == "SynGPT-2.0" and len(records) == 3
    # A subcategory is stored on its depth-1 condition; lens values default to All.
    assert [record["code"] for record in records] == ["5A11", "BA41", "CA40"]
    assert records[1]["age"] == "Age 65+" and records[1]["sex"] == "All sexes"
    first = records[0]
    assert first["validation_type"] == "benchmark" and first["n_samples"] == 240 and first["n_sites"] == 3
    assert first["ci_low"] == 0.76 and first["perf"] == 0.81 and first["n_studies"] == 1
    assert first["source"] == "Evaluation run: Test Bench (fictional) 2.1"
    assert first["study"] == study["study_id"] and first["source_date"] == "2026-10-16"
    # The stored row's intended-use fields and warnings are kept (a merge row replaces the whole row).
    stored = seed_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params={"model": SYN["model_version"], "use_case": SYN["use_case"]}).json()["metrics"]
    assert first["intended_use_level"] == stored["intended_use_level"]
    assert first["warnings"] == "; ".join(item["code"] for item in stored["warnings"]) or stored["warnings"] == []
    assert [entry["code"] for entry in proposals["results"]] == ["5A11", "BA41.Z", "CA40"]
    assert {group["code"] for group in proposals["notes"]} == {"configuration_not_current"}


def test_notes_name_another_measure_and_an_earlier_configuration(demo_copy_client):
    registry = demo_copy_client.get(f"{API_PREFIX}/models").json()
    entry = next(model for model in registry["models"] if model["model_version"] == "SynGPT-2.0")
    variant = next(item for item in entry["use_cases"] if item["use_case"] == "Clinician Facing CDSS")
    measure, configuration = variant["performance_measure"], variant["configuration"]["configuration_id"]
    current = run(configuration_id=configuration)
    for result in current["results"]:
        result["measure"] = f"  {measure.upper()} "  # case and spacing do not count
    upload = send(demo_copy_client, current)
    assert upload["status"] == "valid" and codes(upload, "notes") == set()
    other = run(configuration_id="cfg-older-0")
    other["results"][1]["measure"] = "AUROC"
    upload = send(demo_copy_client, other, replace_staged=True)
    assert codes(upload, "notes") == {"measure_differs_from_card", "configuration_not_current"}
    assert upload["status"] == "valid"


def test_staged_proposals_go_through_the_normal_workflow(seed_client):
    upload = send(seed_client, run(configuration_id="cfg-test-1"))
    proposals = seed_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/evaluation-proposals").json()
    before = versions(seed_client)
    study = seed_client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "mode": "merge", "records": [proposals["study"]]})
    assert study.status_code == 202, study.text
    seed_client.app.state.api.admin.wait_for_checks()
    assert seed_client.get(f"{ADMIN}/uploads/{study.json()['upload_id']}").json()["status"] == "valid"
    assert versions(seed_client) == before  # staging never publishes
    published = seed_client.post(f"{ADMIN}/uploads/{study.json()['upload_id']}/publish", json={"previewed": False, "note": "Benchmark study."})
    assert published.status_code == 200, published.text
    batch = proposals["metrics"]
    metrics = seed_client.post(
        f"{ADMIN}/uploads/records",
        json={"kind": "metrics", "mode": "merge", "model_version": batch["model_version"], "use_case": batch["use_case"], "records": batch["records"]},
    )
    assert metrics.status_code == 202, metrics.text
    seed_client.app.state.api.admin.wait_for_checks()
    staged = seed_client.get(f"{ADMIN}/uploads/{metrics.json()['upload_id']}").json()
    assert staged["status"] == "valid", staged["report"]
    assert "unknown_study" not in codes(staged, "notes")
    published = seed_client.post(f"{ADMIN}/uploads/{metrics.json()['upload_id']}/publish", json={"previewed": False, "note": "Benchmark results."})
    assert published.status_code == 200, published.text
    concept = seed_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params={"model": SYN["model_version"], "use_case": SYN["use_case"]}).json()
    row = concept["metrics"]
    assert row["perf"] == 0.81
    assert row["provenance"]["data_source"] == {"source": "Evaluation run: Test Bench (fictional) 2.1", "study": proposals["study"]["study_id"], "date": "2026-10-16"}
    assert row["appraisal"]["study"]["design"] == "benchmark"


def test_a_submission_part_waits_and_its_records_publish_on_accept(demo_copy_client):
    client = demo_copy_client
    submission = client.post(f"{ADMIN}/submissions", json={"developer_name": "Bench Lab (fictional)", "model_version": "SynGPT-2.0"}).json()
    submission_id = submission["submission_id"]
    upload = send(client, run(configuration_id="cfg-older-0"), submission_id=submission_id)
    assert upload["status"] == "valid" and upload["submission_id"] == submission_id
    # Evaluation results alone publish nothing: the custodian stages their records first.
    refused = client.post(f"{ADMIN}/submissions/{submission_id}/accept", json={"note": "ok"})
    assert refused.status_code == 409 and refused.json()["code"] == "submission_not_ready"
    proposals = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/evaluation-proposals").json()
    for body in (
        {"kind": "studies", "records": [proposals["study"]]},
        {"kind": "metrics", "model_version": SYN["model_version"], "use_case": SYN["use_case"], "records": proposals["metrics"]["records"]},
    ):
        response = client.post(f"{ADMIN}/uploads/records", json={**body, "mode": "merge", "submission_id": submission_id})
        assert response.status_code == 202, response.text
    client.app.state.api.admin.wait_for_checks()
    held = client.get(f"{ADMIN}/submissions/{submission_id}").json()
    assert sorted(part["kind"] for part in held["uploads"]) == ["evaluation_results", "metrics", "studies"]
    assert all(part["status"] == "valid" for part in held["uploads"]), [part["report"] for part in held["uploads"]]
    accepted = client.post(f"{ADMIN}/submissions/{submission_id}/accept", json={"note": "Checked against the benchmark."})
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["status"] == "accepted" and len(body["published_versions"]) == 2
    evaluation = next(part for part in body["uploads"] if part["kind"] == "evaluation_results")
    assert evaluation["status"] == "published"
    study = client.get(f"{API_PREFIX}/studies/{proposals['study']['study_id']}").json()["study"]
    assert study["design"] == "benchmark"


def test_returning_a_submission_discards_its_evaluation_part(demo_copy_client):
    client = demo_copy_client
    submission = client.post(f"{ADMIN}/submissions", json={"developer_name": "Bench Lab (fictional)", "model_version": "SynGPT-2.0"}).json()
    upload = send(client, run(), submission_id=submission["submission_id"])
    returned = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/return", json={"note": "Please add the study protocol."})
    assert returned.status_code == 200
    assert client.get(f"{ADMIN}/uploads/{upload['upload_id']}").json()["status"] == "discarded"


def test_a_staged_registry_card_is_a_note_and_one_staged_per_card(seed_client):
    upload = send(seed_client, run())
    second = seed_client.post(f"{ADMIN}/uploads/evaluation-results", json={"content": json.dumps(run())})
    assert second.status_code == 409 and second.json()["code"] == "staged_upload_exists"
    assert "Evaluation results for SynGPT-2.0 / Clinician Facing CDSS" in second.json()["detail"]
    replaced = send(seed_client, run(), replace_staged=True)
    assert seed_client.get(f"{ADMIN}/uploads/{upload['upload_id']}").json()["status"] == "superseded"
    assert replaced["status"] == "valid"


def test_migration_0015_keeps_every_upload(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "store.sqlite")
    conn = db.connect(store)
    try:
        assert db.schema_version(conn) == len(db.available_migrations())
        kinds = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'uploads'").fetchone()[0]
        assert "'evaluation_results'" in kinds
        indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'uploads'")}
        assert {"uploads_one_staged_per_data_set", "uploads_one_staged_per_submission_data_set", "uploads_created", "uploads_submission"} <= indexes
    finally:
        conn.close()


def test_the_check_reads_only_the_documented_fields():
    """Unknown keys are blocking, so nothing is silently dropped (a typo would lose a value)."""
    from app.publishing.evaluations import CardFacts, read_evaluation

    body = copy.deepcopy(run())
    body["results"][0]["patient_id"] = "x"
    body["notes"] = "free text"

    class Axes:
        age = ("All ages", "Age 65+")
        sex = ("All sexes", "Sex Female")
        ethnicity = ("All ethnicities",)

    class Atlas:
        axes = Axes
        by_code: dict = {}

    run_result, issues = read_evaluation(json.dumps(body), Atlas(), lambda model, use_case: CardFacts("live"))
    assert run_result is None
    problems = [example["problem"] for group in issues.report(0)["errors"] for example in group["examples"]]
    assert any("notes is not a field" in problem for problem in problems)
    assert any("patient_id is not a field" in problem for problem in problems)
