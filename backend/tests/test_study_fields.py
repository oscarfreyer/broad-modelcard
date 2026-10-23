"""Optional study fields (contract v1.14, CONTRACT.md §22).

Applicability concerns (with notes), the appraisal tool and its score, the
setting category, and the configuration evaluated. They are stored, checked,
served, and shown, and they change no grade, signal, status, warning, or
score. A study without them serializes exactly as in v1.13. All data is
synthetic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from admin_helpers import ADMIN, errors_by_code, read_csv, template, upload_and_wait
from test_studies import TINY, link_rows, publish, stage_studies, study
from tiny_tables import tiny_tables, write_tables

from app import db, repository
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX

# The Study keys of contract v1.13, in their serialized order.
V113_STUDY_KEYS = [
    "study_id", "title", "design", "setting", "sites", "patients", "peer_reviewed", "conducted_by", "reporting_guideline",
    "guideline_followed", "risk_of_bias", "risk_of_bias_notes", "population", "evaluation_conditions", "model_version",
    "publication_date", "source_url", "scope", "population_id",
]
NEW_FIELDS = {
    "applicability": "High",
    "applicability_notes": "One unit's patients only (synthetic notes).",
    "quality_tool": "APPRAISE-AI",
    "quality_score": 72,
    "setting_category": "Intensive care",
    "configuration_id": "cfg-2026-03",
}


def test_new_fields_are_stored_and_served_with_labels_or_codes(admin_client):
    client = admin_client
    upload = stage_studies(
        client,
        study("T-NEW", **NEW_FIELDS),
        study("T-CODES", applicability="unclear", quality_tool="probast_ai", setting_category="primary_care", configuration_id="cfg.2026_01"),
        study("T-PLAIN"),
        study("T-DECIMAL", quality_tool="Other", quality_score="61.5"),
    )
    assert upload["status"] == "valid", upload["report"]
    publish(client, upload)
    by_id = {entry["study_id"]: entry for entry in client.get(f"{API_PREFIX}/studies").json()["studies"]}
    assert {key: by_id["T-NEW"][key] for key in NEW_FIELDS} == {
        "applicability": "high",
        "applicability_notes": "One unit's patients only (synthetic notes).",
        "quality_tool": "appraise_ai",
        "quality_score": 72,
        "setting_category": "intensive_care",
        "configuration_id": "cfg-2026-03",
    }
    assert isinstance(by_id["T-NEW"]["quality_score"], int)  # a whole score is served without a decimal part
    assert by_id["T-DECIMAL"]["quality_score"] == 61.5
    codes = by_id["T-CODES"]
    assert (codes["applicability"], codes["quality_tool"], codes["setting_category"], codes["configuration_id"]) == (
        "unclear", "probast_ai", "primary_care", "cfg.2026_01",
    )
    assert "quality_score" not in codes and "applicability_notes" not in codes
    # A study without the fields keeps exactly the v1.13 keys, in order (never sent as null).
    assert list(by_id["T-PLAIN"]) == V113_STUDY_KEYS
    assert list(by_id["T-NEW"])[: len(V113_STUDY_KEYS)] == V113_STUDY_KEYS
    assert client.get(f"{API_PREFIX}/studies/T-NEW").json()["study"] == by_id["T-NEW"]


def test_templates_carry_the_new_columns_and_round_trip(admin_client):
    client = admin_client
    header, rows, _ = read_csv(template(client, "studies"))
    assert header[-7:] == [
        "Applicability concerns", "Applicability notes", "Appraisal tool", "Appraisal score", "Setting category",
        "Configuration evaluated", "Action",
    ]
    publish(client, stage_studies(client, study("T-NEW", **NEW_FIELDS), study("T-PLAIN")))
    filled = template(client, "studies", filled="true")
    header, rows, _ = read_csv(filled)
    row = dict(zip(header, rows[0]))
    assert (row["Applicability concerns"], row["Appraisal tool"], row["Appraisal score"], row["Setting category"], row["Configuration evaluated"]) == (
        "High", "APPRAISE-AI", "72", "Intensive care", "cfg-2026-03",
    )
    plain = dict(zip(header, rows[1]))
    assert all(plain[column] == "" for column in ("Applicability concerns", "Appraisal tool", "Appraisal score", "Setting category"))
    again = upload_and_wait(client, "studies", filled)
    assert again["status"] == "valid", again["report"]
    summary = client.get(f"{ADMIN}/uploads/{again['upload_id']}/changes").json()
    assert (summary["rows"]["added"], summary["rows"]["changed"], summary["rows"]["removed"]) == (0, 0, 0)
    xlsx = template(client, "studies", "xlsx", filled="true")
    assert upload_and_wait(client, "studies", xlsx, "studies.xlsx", replace_staged=True)["status"] == "valid"


def test_files_without_the_new_columns_stay_valid(admin_client):
    client = admin_client
    header, _, comments = read_csv(template(client, "studies"))
    old = header[: header.index("Applicability concerns")]
    from admin_helpers import write_csv

    record = study("T-OLD")
    labels = {"Study ID": "study_id", "Title": "title", "Design": "design", "Setting": "setting", "Sites": "sites", "Patients": "patients",
              "Peer reviewed": "peer_reviewed", "Conducted by": "conducted_by", "Reporting guideline": "reporting_guideline",
              "Guideline followed": "guideline_followed", "Risk of bias": "risk_of_bias", "Population": "population",
              "Evaluation conditions": "evaluation_conditions", "Publication date": "publication_date"}
    row = [record.get(labels.get(column, ""), "") for column in old]
    upload = upload_and_wait(client, "studies", write_csv(old, [row], comments))
    assert upload["status"] == "valid", upload["report"]


def test_validation_errors_have_plain_fixes(admin_client):
    client = admin_client
    upload = stage_studies(
        client,
        study("T-1", applicability="Moderate"),
        study("T-2", quality_tool="CASP"),
        study("T-3", quality_score=72),
        study("T-4", quality_tool="APPRAISE-AI", quality_score=140),
        study("T-5", quality_tool="APPRAISE-AI", quality_score="high"),
        study("T-6", setting_category="Hospital"),
        study("T-7", configuration_id="cfg 2026/03"),
        study("T-8", applicability_notes="x" * 501),
    )
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    for code in (
        "unknown_applicability", "unknown_quality_tool", "quality_score_without_tool", "out_of_range", "not_a_number",
        "unknown_setting_category", "invalid_study_configuration", "invalid_value",
    ):
        assert code in errors, code
        assert errors[code]["fix"] and errors[code]["examples"][0]["record"] >= 0
    assert errors["quality_score_without_tool"]["examples"][0]["problem"].startswith("Appraisal score is given without an Appraisal tool")
    assert "Primary care" in errors["unknown_setting_category"]["fix"]


# ------------------------------------------------------------------ not graded

def _label_free(response) -> bytes:
    label = response.headers["x-dataset-version"]
    return response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')


GRADED_READS = [
    ("/metrics/map", {**TINY, "scope": "atlas"}),
    ("/metrics/map", {**TINY, "scope": "chapter", "chapter_id": "CH-01"}),
    ("/metrics/map", {**TINY, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/summary", {**TINY, "view": "overall"}),
    ("/metrics/summary", {**TINY, "view": "evidence"}),
    ("/metrics/concepts/1A00/subgroups", TINY),
    ("/metrics/concepts/BLK-01/subgroups", TINY),
    ("/metrics/subgroups/summary", TINY),
]


def _tiles_without_dates(client) -> list[dict]:
    tiles = client.get(f"{API_PREFIX}/catalogue").json()["tiles"]
    return [{key: value for key, value in tile.items() if key not in ("last_updated", "staged_change")} for tile in tiles]


def _without_study(body: dict) -> dict:
    """A concept read with the embedded study record left out (it carries the new fields)."""
    metrics = body["metrics"]
    if metrics and metrics.get("appraisal") and metrics["appraisal"].get("study"):
        metrics["appraisal"]["study"] = "*"
    body["dataset_version"] = "*"
    return body


def test_the_new_fields_change_no_grade(admin_client):
    """F4, G3: publishing the new fields on a linked study leaves every grade, signal, status,
    warning, score, flag, and comparison byte for byte as it was; only the study record changes."""
    client = admin_client
    publish(client, stage_studies(client, study("T-LINK", risk_of_bias="Some concerns", guideline_followed="Partly")))
    publish(client, link_rows(client, "T-LINK", codes=("1A00", "1A01"), all_lenses=True))
    before = {(path, json.dumps(params)): _label_free(client.get(API_PREFIX + path, params=params)) for path, params in GRADED_READS}
    tiles = _tiles_without_dates(client)
    concepts = {concept_id: _without_study(client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}", params=TINY).json()) for concept_id in ("1A00", "1A01", "BLK-01", "CH-01", "1A00.0")}

    upload = stage_studies(client, study("T-LINK", risk_of_bias="Some concerns", guideline_followed="Partly", **NEW_FIELDS))
    summary = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert summary["rows"]["changed"] == 1 and summary["status_shifts"] == []
    entry = publish(client, upload)
    assert "status change" not in entry["summary"]

    for key, body in before.items():
        response = client.get(API_PREFIX + key[0], params=json.loads(key[1]))
        assert response.status_code == 200, (key, response.text[:200])
        assert _label_free(response) == body, key
    for concept_id, body in concepts.items():
        after = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}", params=TINY).json()
        if concept_id == "1A00":
            assert after["metrics"]["appraisal"]["study"]["applicability"] == "high"
        assert _without_study(after) == body, concept_id
    # The catalogue's distributions and snapshot are unchanged; only "Updated" moves (a study record changed).
    assert _tiles_without_dates(client) == tiles


def test_record_level_grading_ignores_the_new_fields():
    from app.repository import StudyRecord
    from app.services.studies import study_adjustment

    base = StudyRecord("S", "t", "prospective", "s", 1, 1, True, "independent", "tripod_ai", "yes", "some_concerns", None, "p", "c", None, "2026-01-01", None)
    for applicability in ("low", "high", "unclear"):
        for tool, score in (("appraise_ai", 0.0), ("appraise_ai", 100.0), ("probast_ai", None), ("other", 50.0)):
            other = StudyRecord(*[getattr(base, name) for name in base.__dataclass_fields__ if name not in ("applicability", "applicability_notes", "quality_tool", "quality_score", "setting_category", "configuration_id")],
                                applicability=applicability, quality_tool=tool, quality_score=score, setting_category="mixed", configuration_id="cfg-1")
            assert study_adjustment(other) == study_adjustment(base)


# ------------------------------------------------------------------ migration

def test_migration_0012_keeps_studies_and_adds_empty_fields(tmp_path, monkeypatch):
    """A store one schema below the study fields keeps its study records; the new fields are empty."""
    number = next(version for version, name, _ in db.available_migrations() if name == "study_fields")
    path = tmp_path / "tiny.sqlite"
    earlier = [migration for migration in db.available_migrations() if migration[0] < number]
    with monkeypatch.context() as patch:
        patch.setattr(db, "available_migrations", lambda: earlier)
        import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    set_id = conn.execute(
        "INSERT INTO content_sets (kind, source, created_at, meta_json) VALUES ('studies', 'upload:up-s-1', '2026-10-20T10:00:00Z', '{}')"
    ).lastrowid
    conn.execute(
        "INSERT INTO studies (set_id, study_id, position, title, design, setting, sites, patients, peer_reviewed, conducted_by, "
        "reporting_guideline, guideline_followed, risk_of_bias, population, evaluation_conditions, publication_date) "
        "VALUES (?, 'OLD-1', 0, 'Old study (fictional)', 'benchmark', 'Lab', 1, 100, 0, 'developer', 'none', NULL, 'low', 'p', 'c', '2026-01-01')",
        (set_id,),
    )
    conn.commit()
    assert db.schema_version(conn) == number - 1
    db.migrate(conn)
    assert db.schema_version(conn) == len(db.available_migrations())
    (record,) = repository.load_studies(conn, set_id)
    assert (record.applicability, record.quality_tool, record.quality_score, record.setting_category, record.configuration_id) == (None,) * 5
    assert list(record.as_dict()) == V113_STUDY_KEYS
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE studies SET quality_score = 50 WHERE study_id = 'OLD-1'")  # a score needs a tool
    conn.close()
