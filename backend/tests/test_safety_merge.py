"""Contract v1.7: safety incidents,
merge uploads, row provenance, change notes, the records upload, and the
schema migration that adds them. Runs on private copies of the tiny store
(Tiny-1 / CDSS; conditions 1A00 and 1A01, 90 lenses each)."""

from __future__ import annotations

import sqlite3

import pytest
from admin_helpers import (
    ADMIN,
    TINY_TARGET,
    errors_by_code,
    notes_by_code,
    post_upload,
    read_csv,
    template,
    upload_and_wait,
    wait,
    write_csv,
)
from conftest import local_client
from tiny_tables import tiny_tables, write_tables

from app import db, repository
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app
from app.publishing.uploads import AdminService
from app.repository import IncidentRecord
from app.services import incidents
from app.services.types import Lens

TINY = {"model": "Tiny-1", "use_case": "CDSS"}
SOURCE = {"Source": "Fictional study A (synthetic)", "Study": "A-1", "Source date": "2026-09-01"}
INCIDENT = {
    "incident_id": "SI-1", "model_version": "Tiny-1", "use_case": "CDSS", "codes": "1A00",
    "incident_type": "Harmful or incorrect recommendation", "harm": "Possible", "status": "Open",
    "source_type": "Incident report", "source_reference": "Fictional report R-1 (synthetic)",
    "reported_date": "2026-09-01", "summary": "Synthetic test incident.",
}


def records(client, kind: str, rows: list[dict], **extra) -> dict:
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": kind, "records": rows, **extra})
    assert response.status_code == 202, response.text
    return wait(client, response.json()["upload_id"])


def publish(client, upload: dict, note: str | None = None) -> dict:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": note})
    assert response.status_code == 200, response.text
    return response.json()


def get(client, path: str, **params) -> dict:
    response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def safety_marks(map_body: dict) -> dict:
    """Concept id → the map's safety column, read by name (CONTRACT.md §10)."""
    column = map_body["columns"].index("safety")
    return {row[0]: row[column] for row in map_body["rows"]}


def metric_rows(store, set_id: int) -> dict:
    with sqlite3.connect(f"file:{store}?mode=ro", uri=True) as conn:
        return {(row[1], row[2]): row[3:] for row in conn.execute("SELECT * FROM metric_rows WHERE set_id = ?", (set_id,)).fetchall()}


def live_state(store):
    conn = db.connect(store, read_only=True)
    try:
        return repository.load_state(conn)
    finally:
        conn.close()


def merge_file(client, rows: list[dict]) -> bytes:
    """A metrics file in template form holding only ``rows`` (column → value), unset cells empty."""
    header, filled, comments = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    by_key = {(row[0], row[2], row[3], row[4]): row for row in filled}
    out = []
    for values in rows:
        key = (values["ICD-11 code"], values.get("Age", "All ages"), values.get("Sex", "All sexes"), values.get("Ethnicity", "All ethnicities"))
        row = list(by_key[key]) if key in by_key else [""] * len(header)
        row[header.index("Source")] = row[header.index("Study")] = row[header.index("Source date")] = ""
        for column, value in {"Age": key[1], "Sex": key[2], "Ethnicity": key[3], **values}.items():
            row[header.index(column)] = value
        out.append(row)
    return write_csv(header, out, comments)


# ------------------------------------------------------------- derivations

def _incident(**fields) -> IncidentRecord:
    base = dict(
        incident_id="I", model_version="M", use_case="U", codes=("1A00",), condition_ids=("1A00",), chapter_id=None,
        age="All ages", sex="All sexes", ethnicity="All ethnicities", incident_type="other", harm="none", status="open",
        source_type="incident_report", source_reference="r", study_id=None, reported_date="2026-01-01",
        updated_date=None, summary="s",
    )
    return IncidentRecord(**{**base, **fields})


@pytest.mark.parametrize(
    ("fields", "severity"),
    [
        ({"status": "open", "harm": "occurred"}, "serious"),
        ({"status": "open", "harm": "possible"}, "serious"),
        ({"status": "open", "harm": "none", "incident_type": "developer_notice_or_recall"}, "serious"),
        ({"status": "open", "harm": "none"}, "caution"),
        ({"status": "mitigated", "harm": "occurred"}, "caution"),
        ({"status": "mitigated", "harm": "none", "incident_type": "developer_notice_or_recall"}, "caution"),
        ({"status": "closed", "harm": "occurred"}, None),
    ],
)
def test_severity_is_derived(fields, severity):
    assert incidents.severity(_incident(**fields)) == severity


def test_the_lens_rule():
    older_women = _incident(age="Age 65+", sex="Sex Female")
    assert incidents.applies(older_women, Lens())  # an All … request covers every group
    assert incidents.applies(older_women, Lens(age="Age 65+"))
    assert incidents.applies(older_women, Lens(age="Age 65+", sex="Sex Female", ethnicity="Ethnicity Asian"))
    assert not incidents.applies(older_women, Lens(age="Age 18-39"))
    assert not incidents.applies(older_women, Lens(sex="Sex Male"))
    assert incidents.applies(_incident(), Lens(age="Age 0-17", sex="Sex Male", ethnicity="Ethnicity Other"))


# --------------------------------------------------------------- incidents

def test_one_incident_is_entered_checked_previewed_and_published(admin_client):
    """The S3 flow: a one-record merge upload, its check, change summary, preview, and publish with a note."""
    client = admin_client
    upload = records(client, "safety", [INCIDENT])
    assert upload["mode"] == "merge" and upload["origin"] == "records" and upload["filename"] == "safety-records.csv"
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert {name: changes["rows"][name] for name in ("added", "changed", "removed", "unchanged")} == {"added": 1, "changed": 0, "removed": 0, "unchanged": 0}
    assert changes["rows"]["samples"]["added"][0]["key"] == "SI-1" and changes["status_shifts"] == []
    staged = get(client, "/metrics/concepts/1A00", **TINY, version=f"staged:{upload['upload_id']}")
    assert [incident["incident_id"] for incident in staged["incidents"]] == ["SI-1"]
    assert get(client, "/metrics/concepts/1A00", **TINY)["incidents"] == [], "live reads never see a staged upload"
    entry = publish(client, upload, note="  One incident  from the form. ")
    assert entry["kind"] == "safety" and entry["note"] == "One incident from the form."
    assert entry["summary"] == "Safety incidents: 1 incident added."

    concept = get(client, "/metrics/concepts/1A00", **TINY)
    (served,) = concept["incidents"]
    assert served["severity"] == "serious" and served["codes"] == ["1A00"] and served["chapter_id"] is None
    assert served["lens"] == {"age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities"}
    assert get(client, "/metrics/concepts/1A00.0", **TINY)["incidents"] == concept["incidents"], "a deeper category shows its anchor's"
    assert get(client, "/metrics/concepts/BLK-01", **TINY)["incidents"] == concept["incidents"], "a block lists its conditions'"
    rows = safety_marks(get(client, "/metrics/map", **TINY, scope="atlas"))
    assert rows == {"BLK-01": "serious", "1A00": "serious", "1A01": None}
    summary = get(client, "/metrics/summary", **TINY, view="safety")
    assert summary["safety_counts"] == {"serious": 1, "caution": 0, "none": 1}
    assert summary["counts"] == dict.fromkeys(summary["counts"], 0), "safety marks are not statuses"
    (tile,) = get(client, "/catalogue")["tiles"]
    assert tile["safety"] == {"serious": 1, "caution": 0, "open": 1, "mitigated": 0, "closed": 0}


def test_safety_never_changes_grades(admin_client):
    def without_safety(body: dict) -> list[list]:
        column = body["columns"].index("safety")
        return [row[:column] + row[column + 1:] for row in body["rows"]]

    before = get(admin_client, "/metrics/map", **TINY, scope="atlas")
    publish(admin_client, records(admin_client, "safety", [INCIDENT, {**INCIDENT, "incident_id": "SI-2", "codes": "chapter 01"}]))
    after = get(admin_client, "/metrics/map", **TINY, scope="atlas")
    assert safety_marks(after) != safety_marks(before)
    assert without_safety(after) == without_safety(before)


def test_incident_rules(admin_client):
    bad = [
        {**INCIDENT, "incident_id": "has space"},
        {**INCIDENT, "incident_id": "SI-2", "model_version": "Nope-1"},
        {**INCIDENT, "incident_id": "SI-3", "use_case": "Triage"},
        {**INCIDENT, "incident_id": "SI-4", "codes": "BLK-01"},
        {**INCIDENT, "incident_id": "SI-5", "codes": "chapter 99"},
        {**INCIDENT, "incident_id": "SI-6", "harm": "Severe"},
        {**INCIDENT, "incident_id": "SI-7", "source_type": "Study"},
        {**INCIDENT, "incident_id": "SI-8", "updated_date": "2026-08-01"},
        {**INCIDENT, "incident_id": "SI-9", "summary": "x" * 281},
        {**INCIDENT, "incident_id": "SI-10", "age": "Age 100+"},
        {**INCIDENT, "incident_id": "SI-11", "status": "Resolved"},
        {**INCIDENT, "incident_id": "SI-12", "incident_type": "Bug"},
    ]
    upload = records(admin_client, "safety", bad)
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    expected = {
        "invalid_value": 0, "unknown_configuration": 1, "unknown_icd_code": 3, "unknown_harm": 5, "missing_study_id": 6,
        "invalid_date": 7, "unknown_lens_value": 9, "unknown_incident_status": 10, "unknown_incident_type": 11,
    }
    for code, record in expected.items():
        assert code in errors, code
        assert record in {example["record"] for example in errors[code]["examples"]}, code
    assert {example["record"] for example in errors["unknown_configuration"]["examples"]} == {1, 2}
    assert [entry["version_id"] for entry in admin_client.get(f"{ADMIN}/versions").json()] == [1]


def test_codes_map_to_their_conditions_and_a_chapter_covers_it(admin_client):
    upload = records(admin_client, "safety", [
        {**INCIDENT, "codes": "1A00.0; 1A01", "age": "Age 65+"},
        {**INCIDENT, "incident_id": "SI-2", "codes": "Chapter 1", "status": "Mitigated"},
    ])
    publish(admin_client, upload)
    (tile,) = get(admin_client, "/catalogue")["tiles"]
    assert tile["safety"] == {"serious": 1, "caution": 0, "open": 1, "mitigated": 1, "closed": 0}, "a mitigated incident is not open"
    (first,) = [incident for incident in get(admin_client, "/metrics/concepts/1A01", **TINY)["incidents"] if incident["incident_id"] == "SI-1"]
    assert first["codes"] == ["1A00.0", "1A01"] and first["condition_ids"] == ["1A00", "1A01"]
    chapter = get(admin_client, "/metrics/concepts/CH-01", **TINY, age="Age 18-39")
    assert [incident["incident_id"] for incident in chapter["incidents"]] == ["SI-2"], "SI-1 concerns Age 65+ only"
    rows = safety_marks(get(admin_client, "/metrics/map", **TINY, scope="atlas", age="Age 18-39"))
    assert rows == {"BLK-01": "caution", "1A00": "caution", "1A01": "caution"}
    header, rows, _ = read_csv(template(admin_client, "safety", filled="true"))
    assert [row[header.index("ICD-11 codes")] for row in rows] == ["1A00.0; 1A01", "chapter 01"]


def test_safety_merge_replaces_removes_and_keeps_the_newer_report(admin_client):
    client = admin_client
    publish(client, records(client, "safety", [INCIDENT, {**INCIDENT, "incident_id": "SI-2", "codes": "1A01", "updated_date": "2026-09-20"}]))
    update = records(client, "safety", [
        {**INCIDENT, "status": "Closed", "updated_date": "2026-09-30"},  # replaces SI-1
        {**INCIDENT, "incident_id": "SI-2", "codes": "1A01", "status": "Closed", "updated_date": "2026-09-10"},  # older: kept out
        {"incident_id": "SI-9", "action": "Remove"},  # nothing to remove
        {**INCIDENT, "incident_id": "SI-3", "codes": "1A01"},
    ])
    notes = notes_by_code(update)
    assert notes["newer_study_kept"]["examples"][0]["record"] == 1
    assert notes["nothing_to_remove"]["examples"][0]["record"] == 2
    changes = client.get(f"{ADMIN}/uploads/{update['upload_id']}/changes").json()["rows"]
    assert (changes["added"], changes["changed"], changes["removed"], changes["unchanged"]) == (1, 1, 0, 0)
    publish(client, update)
    by_id = {incident["incident_id"]: incident for incident in get(client, "/metrics/concepts/BLK-01", **TINY)["incidents"]}
    assert by_id["SI-1"]["status"] == "closed" and by_id["SI-1"]["severity"] is None
    assert by_id["SI-2"]["status"] == "open" and "SI-3" in by_id
    # Newest first: SI-1 (updated 2026-09-30), SI-2 (2026-09-20), SI-3 (2026-09-01).
    assert list(by_id) == ["SI-1", "SI-2", "SI-3"]
    removal = records(client, "safety", [{"incident_id": "SI-3", "action": "Remove"}])
    publish(client, removal)
    assert "SI-3" not in {incident["incident_id"] for incident in get(client, "/metrics/concepts/BLK-01", **TINY)["incidents"]}


def test_a_replace_upload_of_incidents_removes_those_left_out(admin_client):
    publish(admin_client, records(admin_client, "safety", [INCIDENT, {**INCIDENT, "incident_id": "SI-2"}]))
    header, rows, comments = read_csv(template(admin_client, "safety", filled="true"))
    upload = upload_and_wait(admin_client, "safety", write_csv(header, rows[:1], comments))
    changes = admin_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert (changes["removed"], changes["unchanged"]) == (1, 1)
    unchanged = upload_and_wait(admin_client, "safety", write_csv(header, rows, comments), replace_staged=True)
    changes = admin_client.get(f"{ADMIN}/uploads/{unchanged['upload_id']}/changes").json()["rows"]
    assert (changes["added"], changes["changed"], changes["removed"], changes["unchanged"]) == (0, 0, 0, 2), "a filled template is no change"


def test_rollback_restores_the_incidents(admin_client):
    entry = publish(admin_client, records(admin_client, "safety", [INCIDENT]))
    response = admin_client.post(f"{ADMIN}/versions/{entry['version_id'] - 1}/rollback", params={"kind": "safety"}, json={"note": "Entered by mistake."})
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "safety" and response.json()["note"] == "Entered by mistake."
    assert response.json()["summary"] == f"Rolled back safety incidents to version {entry['version_id'] - 1}."
    assert get(admin_client, "/metrics/concepts/1A00", **TINY)["incidents"] == []
    datasets = {info["kind"]: info for info in admin_client.get(f"{ADMIN}/datasets").json()}
    assert datasets["safety"]["counts"] == {"incidents": 0, "open": 0}


# ------------------------------------------------------------ merge uploads

def test_a_metrics_merge_changes_only_its_rows(admin_client, tiny_store):
    client = admin_client
    before_set = live_state(tiny_store).metric_sets[("Tiny-1", "CDSS")]
    content = merge_file(client, [
        {"ICD-11 code": "1A00", "Performance": "0.91", "CI low": "0.88", "CI high": "0.94", **SOURCE},
        {"ICD-11 code": "1A01", "Age": "Age 65+", "Performance": "0.71", "CI low": "0.65", "CI high": "0.77", **SOURCE},
    ])
    upload = upload_and_wait(client, "metrics", content, mode="merge", **TINY_TARGET)
    assert upload["status"] == "valid" and upload["mode"] == "merge", upload["report"]
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert {name: changes["rows"][name] for name in ("added", "changed", "removed", "unchanged")} == {"added": 0, "changed": 2, "removed": 0, "unchanged": 0}
    publish(client, upload)
    after_set = live_state(tiny_store).metric_sets[("Tiny-1", "CDSS")]
    before, after = metric_rows(tiny_store, before_set), metric_rows(tiny_store, after_set)
    assert before.keys() == after.keys() and len(after) == 180
    changed = {key for key in before if before[key] != after[key]}
    assert changed == {(0, "1A00"), (72, "1A01")}, "every other row is byte-identical"
    served = get(client, "/metrics/concepts/1A00", **TINY)["metrics"]
    assert served["perf"] == 0.91
    assert served["provenance"]["data_source"] == {"source": "Fictional study A (synthetic)", "study": "A-1", "date": "2026-09-01"}
    other = get(client, "/metrics/concepts/1A00", **TINY, sex="Sex Male")["metrics"]
    assert other["provenance"]["data_source"] == {"source": "Seed (synthetic, version 1)", "study": None, "date": None}
    header, rows, _ = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    first = rows[0]
    assert first[header.index("Source")] == "Fictional study A (synthetic)" and first[header.index("Source date")] == "2026-09-01"


def test_removal_needs_the_marker(admin_client, tiny_store):
    client = admin_client
    leaving_out = upload_and_wait(client, "metrics", merge_file(client, [{"ICD-11 code": "1A00", **SOURCE}]), mode="merge", **TINY_TARGET)
    changes = client.get(f"{ADMIN}/uploads/{leaving_out['upload_id']}/changes").json()["rows"]
    assert changes["removed"] == 0, "a merge never removes rows it leaves out"
    marked = merge_file(client, [{"ICD-11 code": "1A01", "Action": "Remove", "In intended use": "", "Intended-use level": ""}])
    upload = upload_and_wait(client, "metrics", marked, mode="merge", replace_staged=True, **TINY_TARGET)
    assert upload["status"] == "valid", upload["report"]
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert (changes["removed"], changes["changed"], changes["added"]) == (1, 0, 0)
    publish(client, upload)
    assert get(client, "/metrics/concepts/1A01", **TINY)["metrics"] is None
    assert get(client, "/metrics/concepts/1A01", **TINY, age="Age 65+")["metrics"] is not None
    in_replace = upload_and_wait(client, "metrics", marked, **TINY_TARGET)
    assert "remove_in_replace" in errors_by_code(in_replace)


def test_merge_rows_need_their_source(admin_client):
    content = merge_file(admin_client, [{"ICD-11 code": "1A00", "Source": "Fictional study A", "Study": "", "Source date": "2026-09-01"}])
    upload = upload_and_wait(admin_client, "metrics", content, mode="merge", **TINY_TARGET)
    group = errors_by_code(upload)["missing_provenance"]
    assert group["examples"][0]["column"] == "Study" and "Study is empty" in group["examples"][0]["problem"]
    # A replace upload may leave the source out, but not give a study without one.
    header, rows, comments = read_csv(template(admin_client, "metrics", filled="true", **TINY_TARGET))
    rows[0][header.index("Source")] = ""
    rows[0][header.index("Study")] = "A-1"
    upload = upload_and_wait(admin_client, "metrics", write_csv(header, rows, comments), replace_staged=True, **TINY_TARGET)
    assert "missing_provenance" in errors_by_code(upload)


def test_the_newer_study_stays(admin_client):
    client = admin_client
    publish(client, upload_and_wait(client, "metrics", merge_file(client, [{"ICD-11 code": "1A00", "Performance": "0.91", "CI low": "0.88", "CI high": "0.94", **SOURCE}]), mode="merge", **TINY_TARGET))
    older = {**SOURCE, "Study": "B-1", "Source date": "2026-01-15"}
    upload = upload_and_wait(client, "metrics", merge_file(client, [{"ICD-11 code": "1A00", "Performance": "0.5", "CI low": "0.4", "CI high": "0.6", **older}]), mode="merge", **TINY_TARGET)
    assert upload["status"] == "valid"
    assert "the stored row stays" in notes_by_code(upload)["newer_study_kept"]["examples"][0]["problem"]
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert (changes["added"], changes["changed"], changes["removed"], changes["unchanged"]) == (0, 0, 0, 0)
    publish(client, upload)
    assert get(client, "/metrics/concepts/1A00", **TINY)["metrics"]["perf"] == 0.91


def test_a_merge_adding_a_lens_group_says_so(admin_client, tmp_path):
    """A set without a group gains it: other conditions read No data for that group (a note)."""
    header, rows, comments = read_csv(template(admin_client, "metrics", filled="true", **TINY_TARGET))
    all_population = [row for row in rows if row[2:5] == ["All ages", "All sexes", "All ethnicities"]]
    publish(admin_client, upload_and_wait(admin_client, "metrics", write_csv(header, all_population, comments), **TINY_TARGET))
    content = merge_file(admin_client, [{
        "ICD-11 code": "1A00", "Age": "Age 65+", "Performance": "0.8", "CI low": "0.7", "CI high": "0.9",
        "Validation type": "Benchmark", "Samples": "300",  # performance needs evidence (v1.11)
        "In intended use": "Yes", "Intended-use level": "In scope", **SOURCE,
    }])
    upload = upload_and_wait(admin_client, "metrics", content, mode="merge", **TINY_TARGET)
    assert upload["status"] == "valid", upload["report"]
    assert "new_lens_group" in notes_by_code(upload)
    publish(admin_client, upload)
    assert get(admin_client, "/metrics/concepts/1A00", **TINY, age="Age 65+")["metrics"]["perf"] == 0.8
    assert get(admin_client, "/metrics/concepts/1A01", **TINY, age="Age 65+")["metrics"] is None


def test_a_prevalence_merge(admin_client):
    upload = records(admin_client, "prevalence", [{"code": "1A01", "tier": "Very common", "source": "Fictional registry (synthetic)", "study": "REG-1", "source_date": "2026-05-01"}])
    changes = admin_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert (changes["added"], changes["changed"], changes["removed"], changes["unchanged"]) == (0, 1, 0, 0)
    publish(admin_client, upload)
    header, rows, _ = read_csv(template(admin_client, "prevalence", filled="true"))
    by_code = {row[0]: row for row in rows}
    assert by_code["1A01"][header.index("Commonness")] == "Very common" and by_code["1A01"][header.index("Study")] == "REG-1"
    assert by_code["1A00"][header.index("Source")] == "Seed (synthetic, version 1)"
    assert len(rows) == 3


def test_a_staged_merge_is_checked_again_when_its_base_changes(admin_client):
    client = admin_client
    # A first merge (version 2) gives the card a new metrics set, so that restoring version 1
    # changes it (a rollback that changes nothing is refused since v1.11).
    publish(client, upload_and_wait(client, "metrics", merge_file(client, [{"ICD-11 code": "1A01", "Performance": "0.72", "CI low": "0.65", "CI high": "0.8", **SOURCE}]), mode="merge", **TINY_TARGET))
    merge = upload_and_wait(client, "metrics", merge_file(client, [{"ICD-11 code": "1A00", "Performance": "0.91", "CI low": "0.88", "CI high": "0.94", **SOURCE}]), mode="merge", **TINY_TARGET)
    assert merge["status"] == "valid"
    # Another card's data set changes nothing; the same set does. A replace upload of the same
    # card needs replace_staged, so publish a prevalence merge, then roll the metrics back.
    publish(client, records(client, "prevalence", [{"code": "1A01", "tier": "Rare", "source": "S", "study": "T", "source_date": "2026-01-01"}]))
    assert client.get(f"{ADMIN}/uploads/{merge['upload_id']}").json()["status"] == "valid"
    response = client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"})
    assert response.status_code == 200
    rechecked = wait(client, merge["upload_id"])
    assert rechecked["status"] == "valid"
    changes = client.get(f"{ADMIN}/uploads/{merge['upload_id']}/changes").json()
    assert changes["base_version"] == response.json()["version_id"] and changes["rows"]["changed"] == 1
    assert client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"}).json()["code"] == "rollback_no_change"
    publish(client, rechecked)


def test_merge_is_refused_where_it_is_not_supported(admin_client):
    response = post_upload(admin_client, "models", template(admin_client, "models", filled="true"), mode="merge")
    assert response.status_code == 422 and response.json()["code"] == "invalid_parameter"


# ---------------------------------------------------------- records upload

def test_records_upload_rules(admin_client):
    def post(body):
        return admin_client.post(f"{ADMIN}/uploads/records", json=body)

    assert post({"kind": "models", "records": [{}]}).status_code == 422
    assert post({"kind": "safety", "records": []}).status_code == 422
    assert post({"kind": "safety", "mode": "replace", "records": [INCIDENT]}).status_code == 422
    response = post({"kind": "safety", "records": [{**INCIDENT, "colour": "red"}]})
    assert response.status_code == 422 and "unknown field 'colour'" in response.json()["detail"]
    response = post({"kind": "safety", "records": [{**INCIDENT, "Incident ID": "SI-9"}]})
    assert response.status_code == 422 and "twice" in response.json()["detail"]
    assert post({"kind": "metrics", "records": [{"code": "1A00"}]}).status_code == 422, "metrics need a card"
    headers = records(admin_client, "safety", [{"Incident ID": "SI-H", **{key: value for key, value in INCIDENT.items() if key != "incident_id"}}])
    assert headers["status"] == "valid", "headers work as field names too"
    assert post({"kind": "safety", "records": [INCIDENT]}).status_code == 409, "one staged upload per data set"


# ------------------------------------------------------------------- notes

def test_change_notes(admin_client):
    upload = records(admin_client, "safety", [INCIDENT])
    response = admin_client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": "x" * 501})
    assert response.status_code == 422
    entry = publish(admin_client, upload)
    assert entry["note"] is None
    history = admin_client.get(f"{ADMIN}/versions").json()
    assert [version["note"] for version in history] == [None, None]
    assert history[0]["summary"] == "Safety incidents: 1 incident added."


# --------------------------------------------------------------- migration

def test_migration_0004_keeps_versions_uploads_and_staged_sets(tmp_path, monkeypatch):
    """A schema-3 store with published versions and staged uploads migrates in place."""
    every = db.available_migrations()
    monkeypatch.setattr(db, "available_migrations", lambda: every[:3])
    store = tmp_path / "v3.sqlite"
    import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), store)
    conn = sqlite3.connect(store, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    assert db.schema_version(conn) == 3
    # Version 2 republishes the seed's prevalence set as an upload's set; a staged upload has its own set.
    conn.execute("BEGIN")
    prevalence = conn.execute("SELECT set_id FROM content_sets WHERE kind = 'prevalence'").fetchone()[0]
    for set_id, source in ((90, "upload:up-published"), (91, "upload:up-staged")):
        conn.execute(
            "INSERT INTO content_sets (set_id, kind, source, meta_json, created_at) VALUES (?, 'prevalence', ?, '{}', '2026-10-01T00:00:00Z')",
            (set_id, source),
        )
        conn.execute("INSERT INTO prevalence_sets SELECT ?, min_score, max_score FROM prevalence_sets WHERE set_id = ?", (set_id, prevalence))
        conn.execute("INSERT INTO prevalence_tiers SELECT ?, code, tier FROM prevalence_tiers WHERE set_id = ?", (set_id, prevalence))
    conn.execute("INSERT INTO dataset_versions (version_id, kind, created_at, summary, upload_id, previewed) VALUES (2, 'prevalence', '2026-10-01T00:00:00Z', 'Prevalence: no changes.', 'up-published', 1)")
    conn.execute("INSERT INTO version_content_sets SELECT 2, set_id FROM version_content_sets WHERE version_id = 1 AND set_id != ?", (prevalence,))
    conn.execute("INSERT INTO version_content_sets VALUES (2, 90)")
    for upload_id, status, set_id, version in (("up-published", "published", 90, 2), ("up-staged", "valid", 91, None), ("up-checking", "checking", None, None)):
        conn.execute(
            "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, set_id, published_version) "
            "VALUES (?, 'prevalence', ?, 'csv', ?, 1, '2026-10-01T00:00:00Z', ?, ?)",
            (upload_id, f"{upload_id}.csv", status if upload_id != "up-checking" else "superseded", set_id, version),
        )
    conn.execute("COMMIT")
    tables = ("dataset_versions", "content_sets", "uploads", "version_content_sets")
    before = {table: conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() for table in tables}

    monkeypatch.setattr(db, "available_migrations", lambda: every[:4])
    assert db.migrate(conn) == [4]
    assert conn.execute("PRAGMA foreign_keys").fetchone() == (1,), "the connection's setting is restored"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    after = {table: conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() for table in tables}
    assert [row[:7] for row in after["dataset_versions"]] == before["dataset_versions"]
    assert all(row[7] is None for row in after["dataset_versions"]), "no notes before v1.7"
    assert after["content_sets"] == before["content_sets"] and after["version_content_sets"] == before["version_content_sets"]
    assert [row[:15] for row in after["uploads"]] == before["uploads"]
    assert {row[15:] for row in after["uploads"]} == {("replace", "file")}
    sources = dict(conn.execute("SELECT s.set_id, p.source FROM set_provenance s JOIN provenance_sources p USING (provenance_id)"))
    assert sources == {90: "Upload up-published.csv", 91: "Upload up-staged.csv"}
    conn.execute("INSERT INTO dataset_versions (version_id, kind, created_at, summary) VALUES (3, 'safety', 'x', 'y')")  # the new kind
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO uploads (upload_id, kind, filename, file_format, status, created_at) VALUES ('up-2', 'prevalence', 'a', 'csv', 'valid', 'x')")
    conn.execute("DELETE FROM dataset_versions WHERE version_id = 3")
    conn.close()

    # The staged upload still publishes after the migration (and the later ones, from 0005 on).
    monkeypatch.setattr(db, "available_migrations", lambda: every)
    admin = AdminService(store, uploads_dir=tmp_path / "uploads")
    admin.open()
    try:
        entry = admin.publish("up-staged", previewed=False, note="After the migration.")
        assert entry["version_id"] == 3 and entry["note"] == "After the migration."
    finally:
        admin.close()
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        assert get(client, "/meta")["dataset_version"] == "3"
        assert get(client, "/metrics/concepts/1A00", **TINY)["metrics"]["provenance"]["data_source"]["source"] == "Seed (synthetic, version 1)"
