"""Intervention effects (contract v1.13, CONTRACT.md §27).

An effect record states what using an AI system changed for patients or for
care, against a comparator, from one study that compared care with and without
it. Effects attach to a card's concepts like safety incidents (codes or a
chapter; deeper categories through their anchor; other ontologies through the
crosswalk) and **never change a grade, status, Overview, comparison flag, or
summary**. All data is synthetic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from admin_helpers import ADMIN, errors_by_code, notes_by_code, read_csv, template, upload_and_wait
from conftest import copy_store, local_client
from tiny_tables import tiny_tables, write_tables

from app import db
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app

TINY = {"model": "Tiny-1", "use_case": "CDSS"}
SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}


def study(study_id: str, **fields) -> dict:
    return {
        "study_id": study_id,
        "title": f"Synthetic study {study_id} (fictional)",
        "design": "Randomized trial",
        "setting": "Emergency departments (fictional)",
        "sites": 3,
        "patients": 900,
        "peer_reviewed": "Yes",
        "conducted_by": "Independent",
        "reporting_guideline": "CONSORT-AI",
        "guideline_followed": "Yes",
        "risk_of_bias": "Low",
        "population": "Adults (synthetic)",
        "evaluation_conditions": "Care with and without the AI system (synthetic).",
        "publication_date": "2026-09-01",
        **fields,
    }


def effect(effect_id: str, **fields) -> dict:
    """A one-effect record for the records upload (template keys, readable labels)."""
    return {
        "effect_id": effect_id,
        "study_id": "T-RCT",
        "model_version": "Tiny-1",
        "use_case": "CDSS",
        "codes": "1A00",
        "outcome": "Time to first treatment (synthetic)",
        "outcome_type": "Process",
        "population": "Adults (synthetic)",
        "comparator": "Usual care without the AI system",
        "effect_measure": "Mean difference",
        "estimate": -12,
        "ci_low": -20,
        "ci_high": -4,
        "unit": "minutes",
        "direction": "Lower is better",
        "follow_up": "Index visit",
        "appraisal_tool": "RoB 2",
        "judgement": "Low",
        **fields,
    }


def stage(client, kind: str, *records: dict) -> dict:
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": kind, "records": list(records), "replace_staged": True})
    assert response.status_code == 202, response.text
    client.app.state.api.admin.wait_for_checks()
    return client.get(f"{ADMIN}/uploads/{response.json()['upload_id']}").json()


def publish(client, upload: dict, note: str = "Test.") -> dict:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": note})
    assert response.status_code == 200, response.text
    return response.json()


def with_studies(client, *records: dict) -> None:
    publish(client, stage(client, "studies", *(records or (study("T-RCT"), study("T-PROS", design="Prospective"), study("T-VIG", design="Vignette")))))


def concept(client, concept_id: str, params=TINY, **extra) -> dict:
    response = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}", params={**params, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def ids(body: dict) -> list[str]:
    return [entry["effect_id"] for entry in body.get("effects", [])]


# --------------------------------------------------------------- validation

def test_effects_need_a_study_that_compared_care(admin_client):
    """The study must exist and be a randomized trial, a prospective study, or a real-world deployment."""
    client = admin_client
    with_studies(client)
    upload = stage(
        client,
        "effects",
        effect("E-1", study_id="T-NOPE"),
        effect("E-2", study_id="T-VIG"),
        effect("E-3", study_id="T-PROS"),  # prospective appraised with RoB 2
        effect("E-4", appraisal_tool="ROBINS-I"),  # randomized appraised with ROBINS-I
        effect("E-5", judgement="Critical"),  # RoB 2 has no Critical
    )
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    assert errors["unknown_effect_study"]["examples"][0]["value"] == "T-NOPE"
    assert "publish it first" in errors["unknown_effect_study"]["fix"]
    assert errors["effect_study_design"]["examples"][0]["problem"].startswith("T-VIG is a vignette study")
    mismatch = errors["appraisal_tool_mismatch"]
    assert mismatch["count"] == 2
    assert {example["problem"] for example in mismatch["examples"]} == {
        "T-PROS is a prospective study, so its effects are appraised with ROBINS-I.",
        "T-RCT is a randomized trial, so its effects are appraised with RoB 2.",
    }
    assert "judgement_not_in_tool" in errors
    for group in errors.values():
        assert group["fix"] and group["examples"][0]["record"] >= 0
    # A prospective study with ROBINS-I and Critical is fine.
    assert stage(client, "effects", effect("E-6", study_id="T-PROS", appraisal_tool="ROBINS-I", judgement="Critical"))["status"] == "valid"


def test_effect_numbers_and_choices_have_plain_fixes(admin_client):
    client = admin_client
    with_studies(client)
    upload = stage(
        client,
        "effects",
        effect("E-1", estimate=-25),  # below CI low
        effect("E-2", effect_measure="Risk ratio", estimate=0.8, ci_low=0, ci_high=1.2),
        effect("E-3", effect_measure="Odds ratio", estimate=-0.2, ci_low=-0.5, ci_high=0.1),
        effect("E-4", effect_measure="Number needed to treat"),
        effect("E-5", outcome_type="Cost"),
        effect("E-6", direction="Up"),
        effect("E-7", appraisal_tool="QUADAS-2"),
        effect("E-8", judgement="Moderate"),
        effect("E-9", estimate=None),
        effect("E-10", model_version="Nope-1"),
        effect("E-11", codes="ZZ99"),
        effect("E 12"),
        effect("E-1"),
    )
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    for code in (
        "effect_ci_order", "effect_ratio_not_positive", "unknown_effect_measure", "unknown_outcome_type", "unknown_effect_direction",
        "unknown_appraisal_tool", "unknown_effect_judgement", "missing_value", "unknown_configuration", "unknown_icd_code", "invalid_value",
    ):
        assert code in errors, code
        assert errors[code]["fix"], code
    assert errors["effect_ci_order"]["examples"][0]["problem"] == "Estimate -25 is not between CI low -20 and CI high -4."
    assert errors["effect_ratio_not_positive"]["count"] == 2
    assert errors["unknown_configuration"]["message"].startswith("An incident or effect names a card")


def test_ratios_above_zero_and_a_chapter_are_valid(admin_client):
    client = admin_client
    with_studies(client)
    upload = stage(
        client,
        "effects",
        effect("E-RR", effect_measure="RR", estimate=1.2, ci_low=0.9, ci_high=1.6, unit=None, outcome_type="Harm", codes="chapter 01"),
        effect("E-SMD", effect_measure="Standardized mean difference", estimate=0.3, ci_low=0.1, ci_high=0.5, direction="Higher is better", codes="1A00.0"),
    )
    assert upload["status"] == "valid", upload["report"]


# ------------------------------------------------------------ publish, read

def test_effects_publish_attach_and_restore(admin_client):
    client = admin_client
    before = {concept_id: concept(client, concept_id) for concept_id in ("1A00", "1A01", "1A00.0", "BLK-01", "CH-01")}
    assert all("effects" not in body for body in before.values())
    with_studies(client)
    upload = stage(
        client,
        "effects",
        effect("E-CODE"),
        effect("E-CH", codes="chapter 01", effect_measure="Risk ratio", estimate=0.8, ci_low=0.6, ci_high=1.05, unit=None, outcome_type="Harm"),
        effect("E-DEEP", study_id="T-PROS", codes="1A00.0", appraisal_tool="ROBINS-I", judgement="Some concerns"),
    )
    summary = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert summary["rows"]["added"] == 3 and summary["status_shifts"] == []
    assert summary["rows"]["samples"]["added"][0] == {
        "key": "E-CODE", "name": "E-CODE: Time to first treatment (synthetic)", "concept_id": "1A00", "code": "1A00", "lens": None,
    }
    entry = publish(client, upload, "Three effects.")
    assert entry["kind"] == "effects" and entry["summary"].startswith("Effects on outcomes: 3 effects added")

    # By code, by chapter, and a deeper category through its anchor (1A00.0 → 1A00).
    assert ids(concept(client, "1A00")) == ["E-CODE", "E-CH", "E-DEEP"]
    assert ids(concept(client, "1A01")) == ["E-CH"]
    assert ids(concept(client, "1A00.0")) == ["E-CODE", "E-CH", "E-DEEP"]
    assert ids(concept(client, "BLK-01")) == ["E-CODE", "E-CH", "E-DEEP"]
    assert ids(concept(client, "CH-01")) == ["E-CODE", "E-CH", "E-DEEP"]
    # No lens: the same effects at every group.
    assert ids(concept(client, "1A00", age="Age 65+")) == ["E-CODE", "E-CH", "E-DEEP"]
    served = concept(client, "1A00")["effects"][0]
    assert served["study"]["study_id"] == "T-RCT" and served["study"]["design"] == "randomized_trial"
    assert served["estimate"] == -12 and served["ci_low"] == -20 and served["effect_measure"] == "mean_difference"
    assert served["codes"] == ["1A00"] and served["condition_ids"] == ["1A00"] and served["chapter_id"] is None
    deep = concept(client, "1A00")["effects"][2]
    assert deep["codes"] == ["1A00.0"] and deep["condition_ids"] == ["1A00"]

    # Effects change nothing else in the read.
    for concept_id, body in before.items():
        after = concept(client, concept_id)
        after.pop("effects", None)
        assert {**after, "dataset_version": "*"} == {**body, "dataset_version": "*"}, concept_id

    # listEffects, with its filters.
    listed = client.get(f"{API_PREFIX}/effects").json()
    assert [entry["effect_id"] for entry in listed["effects"]] == ["E-CODE", "E-CH", "E-DEEP"]
    assert client.get(f"{API_PREFIX}/effects", params={"model": "Tiny-1", "use_case": "CDSS"}).json()["effects"] == listed["effects"]
    assert client.get(f"{API_PREFIX}/effects", params={"model": "Nope-1"}).json()["effects"] == []
    datasets = {info["kind"]: info for info in client.get(f"{ADMIN}/datasets").json()}
    assert datasets["effects"]["counts"] == {"effects": 3}

    # A merge removes one; removing the study leaves the effect with study null.
    publish(client, stage(client, "effects", {"effect_id": "E-CH", "action": "Remove"}))
    assert ids(concept(client, "1A01")) == [] and "effects" not in concept(client, "1A01")
    publish(client, stage(client, "studies", {"study_id": "T-PROS", "action": "Remove"}))
    assert concept(client, "1A00")["effects"][1]["study"] is None

    # History and restore work like every kind.
    versions = client.get(f"{ADMIN}/versions", params={"kind": "effects"}).json()
    assert [entry["kind"] for entry in versions[:2]] == ["effects", "effects"]
    restored = client.post(f"{ADMIN}/versions/{versions[1]['version_id']}/rollback", params={"kind": "effects"}, json={"note": "Restore."})
    assert restored.status_code == 200, restored.text
    assert ids(concept(client, "1A01")) == ["E-CH"]
    gone = client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "effects"}, json={"note": "No effects."})
    assert gone.status_code == 200, gone.text
    assert "effects" not in concept(client, "1A00")


def test_effects_templates_round_trip(admin_client):
    client = admin_client
    header, rows, _ = read_csv(template(client, "effects"))
    assert rows == [] and header[:5] == ["Effect ID", "Study ID", "Model version", "Function", "ICD-11 codes"] and header[-1] == "Action"
    with_studies(client)
    publish(client, stage(client, "effects", effect("E-A"), effect("E-B", codes="chapter 01", notes="Synthetic note.")))
    filled = template(client, "effects", filled="true")
    header, rows, _ = read_csv(filled)
    assert rows[1][4] == "chapter 01" and rows[0][header.index("Appraisal tool")] == "RoB 2"
    again = upload_and_wait(client, "effects", filled)
    assert again["status"] == "valid", again["report"]
    summary = client.get(f"{ADMIN}/uploads/{again['upload_id']}/changes").json()
    assert summary["rows"] == {**summary["rows"], "added": 0, "changed": 0, "removed": 0, "unchanged": 2}
    xlsx = template(client, "effects", "xlsx", filled="true")
    assert upload_and_wait(client, "effects", xlsx, "effects.xlsx", replace_staged=True)["status"] == "valid"


def test_a_studies_publish_rechecks_staged_effects(admin_client):
    """A staged effects upload is checked again when its study goes away or changes design."""
    client = admin_client
    with_studies(client)
    upload = stage(client, "effects", effect("E-A"))
    assert upload["status"] == "valid"
    publish(client, stage(client, "studies", study("T-RCT", design="Benchmark")))
    client.app.state.api.admin.wait_for_checks()
    rechecked = client.get(f"{ADMIN}/uploads/{upload['upload_id']}").json()
    assert rechecked["status"] == "invalid" and "effect_study_design" in errors_by_code(rechecked)


def test_a_staged_card_is_a_note(admin_client):
    client = admin_client
    with_studies(client)
    header, rows, comments = read_csv(template(client, "models", filled="true"))
    rows.append([*rows[0]])
    rows[-1][header.index("Function")] = "Triage"
    rows[-1][header.index("Default function")] = "No"
    from admin_helpers import write_csv

    registry = upload_and_wait(client, "models", write_csv(header, rows, comments))
    assert registry["status"] in ("valid", "invalid")  # invalid until the function has metrics; it is staged either way
    upload = stage(client, "effects", effect("E-A", use_case="Triage"))
    assert upload["status"] == "valid", upload["report"]
    assert "configuration_not_published" in notes_by_code(upload)


# ---------------------------------------------------------- grades unchanged

@pytest.fixture
def seed_admin(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "seed.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        yield client


SEED_READS = [
    ("/meta", {}),
    ("/catalogue", {}),
    ("/metrics/map", {**SYN, "scope": "atlas"}),
    ("/metrics/map", {**SYN, "scope": "chapter", "chapter_id": "CH-05"}),
    ("/metrics/map", {**MEDICORE, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/summary", {**SYN, "view": "overall"}),
    ("/metrics/summary", {**SYN, "view": "evidence"}),
    ("/metrics/summary", {**SYN, "view": "safety"}),
    ("/metrics/concepts/BA00", SYN),
    ("/metrics/concepts/1A01", MEDICORE),
    ("/metrics/concepts/CH-11", MEDICORE),
    ("/metrics/concepts/5A11/subgroups", SYN),
    ("/multimorbidity/combination", {**SYN, "selected": "GB61,5A11"}),
    ("/compare", {"cards": f"{SYN['model']}|{SYN['use_case']},{MEDICORE['model']}|{MEDICORE['use_case']}"}),
    ("/compare", {"cards": f"{SYN['model']}|{SYN['use_case']},{MEDICORE['model']}|{MEDICORE['use_case']}", "scope": "chapter", "chapter_id": "CH-05"}),
]


def _label_free(response) -> bytes:
    label = response.headers["x-dataset-version"]
    return response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')


def _read(client, path, params):
    response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, f"{path}: {response.text[:200]}"
    return response


def test_effects_change_no_grade_status_summary_or_comparison(seed_admin):
    """E10: with effects on SynGPT-2.0's diabetes (5A11) and a whole chapter, every read but the
    concept reads that list them is byte for byte what it was, also for that card; the concept reads
    differ only by `effects`. Restoring the effects away gives the same bytes again."""
    client = seed_admin
    with_studies(client, study("SEED-RCT", model_version="SynGPT-2.0"))
    before = {(path, json.dumps(params)): _label_free(_read(client, path, params)) for path, params in SEED_READS}
    concept_before = {cid: concept(client, cid, SYN) for cid in ("5A11", "CH-05", "BA00")}
    upload = stage(
        client,
        "effects",
        effect("SEED-E1", study_id="SEED-RCT", model_version=SYN["model"], use_case=SYN["use_case"], codes="5A11"),
        effect("SEED-E2", study_id="SEED-RCT", model_version=SYN["model"], use_case=SYN["use_case"], codes="chapter 05",
               effect_measure="Risk ratio", estimate=1.3, ci_low=1.05, ci_high=1.6, unit=None, outcome_type="Harm"),
    )
    assert client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["status_shifts"] == []
    publish(client, upload)
    for stage_name in ("published", "restored"):
        for key, body in before.items():
            assert _label_free(_read(client, key[0], json.loads(key[1]))) == body, (stage_name, key)
        if stage_name == "published":
            for cid, body in concept_before.items():
                after = concept(client, cid, SYN)
                listed = after.pop("effects", [])
                assert {**after, "dataset_version": "*"} == {**body, "dataset_version": "*"}, cid
                assert [entry["effect_id"] for entry in listed] == {"5A11": ["SEED-E1", "SEED-E2"], "CH-05": ["SEED-E1", "SEED-E2"], "BA00": []}[cid]
            assert client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "effects"}).status_code == 200
    # Without effects the concept read has no `effects` key at all.
    assert "effects" not in _read(client, "/metrics/concepts/5A11", SYN).json()


def test_effects_in_another_ontology_follow_the_crosswalk(ontology_db, tmp_path):
    """A condition of another ontology shows the effects of the ICD-11 condition it maps to (§23)."""
    store = copy_store(ontology_db, tmp_path / "ontology.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        mapped = concept(client, "E11", SYN, ontology="icd10cm")
        target = mapped["mapping"]["icd11"]
        assert mapped["mapping"]["kind"] == "exact" and target["concept_id"] == "5A11"
        assert "effects" not in mapped
        with_studies(client, study("ONT-RCT"))
        publish(client, stage(client, "effects", effect("ONT-E1", study_id="ONT-RCT", model_version=SYN["model"], use_case=SYN["use_case"], codes="5A11")))
        after = concept(client, "E11", SYN, ontology="icd10cm")
        assert ids(after) == ["ONT-E1"]
        after.pop("effects")
        assert {**after, "dataset_version": "*"} == {**mapped, "dataset_version": "*"}
        assert ids(concept(client, "5A11", SYN)) == ["ONT-E1"]
        assert ids(concept(client, "E11.9", SYN, ontology="icd10cm")) == ["ONT-E1"]  # mapped by stem
        assert "effects" not in concept(client, "E12", SYN, ontology="icd10cm")  # no mapping, no effects
        # The ICD-10-CM block and chapter that hold E11 list it too.
        for entry in mapped["path"][:-1]:
            assert ids(concept(client, entry["concept_id"], SYN, ontology="icd10cm")) == ["ONT-E1"], entry["concept_id"]


def test_demo_effects(demo_client):
    """The demo pack's three effects (pack v6): on the product cards, from the two effect studies."""
    vantrel = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}
    listed = demo_client.get(f"{API_PREFIX}/effects").json()["effects"]
    assert [entry["effect_id"] for entry in listed] == ["EFF-VT-01", "EFF-VT-02", "EFF-QS-01"]
    assert {entry["study"]["design"] for entry in listed} == {"randomized_trial", "prospective"}
    assert {entry["outcome_type"] for entry in listed} == {"process", "harm"}
    assert ids(concept(demo_client, "BA41", vantrel)) == ["EFF-VT-01", "EFF-VT-02"]
    assert ids(concept(demo_client, "BA00", vantrel)) == ["EFF-VT-02"]  # chapter 11
    assert "effects" not in concept(demo_client, "BA41", SYN)


# --------------------------------------------------------------- migration

def test_migration_0009_keeps_history_and_staged_uploads(tmp_path, monkeypatch):
    """A store at schema 8 with studies and a staged studies upload migrates in place (0009 effects,
    renumbered from 0010 at the R5 merge, and every later migration). The schema-8 state is written
    as schema-8 code wrote it: since schema 10 the code itself needs the newest schema."""
    path = tmp_path / "tiny.sqlite"
    eight = [migration for migration in db.available_migrations() if migration[0] <= 8]
    with monkeypatch.context() as patch:
        patch.setattr(db, "available_migrations", lambda: eight)
        import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    now = "2026-10-12T10:00:00Z"
    columns = ("study_id, title, design, setting, sites, patients, peer_reviewed, conducted_by, reporting_guideline, "
               "guideline_followed, risk_of_bias, risk_of_bias_notes, population, evaluation_conditions, model_version, "
               "publication_date, source_url")

    def studies_set(study_id: str, design: str) -> int:
        set_id = conn.execute(
            "INSERT INTO content_sets (kind, source, created_at, meta_json) VALUES ('studies', ?, ?, '{}')", (f"upload:{study_id}", now)
        ).lastrowid
        conn.execute(
            f"INSERT INTO studies (set_id, position, {columns}) VALUES (?, 0, ?, 'Synthetic (fictional)', ?, 'Ward (fictional)', 1, 100, 0, "
            "'independent', 'consort_ai', 'yes', 'low', NULL, 'Adults (synthetic)', 'Synthetic.', 'Tiny-1', '2026-10-01', NULL)",
            (set_id, study_id, design),
        )
        return set_id

    report = json.dumps({"row_count": 1, "errors": [], "notes": []})
    published = studies_set("T-RCT", "randomized_trial")
    conn.execute("INSERT INTO dataset_versions (version_id, kind, created_at, summary, note) VALUES (2, 'studies', ?, 'Studies: 1 study added.', 'Before 0009.')", (now,))
    conn.execute("INSERT INTO version_content_sets SELECT 2, set_id FROM version_content_sets WHERE version_id = 1")
    conn.execute("INSERT INTO version_content_sets VALUES (2, ?)", (published,))
    conn.execute(
        "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json, set_id) "
        "VALUES ('up-staged', 'studies', 's.csv', 'csv', 'valid', 1, ?, ?, ?)",
        (now, report, studies_set("T-PROS", "prospective")),
    )
    conn.commit()
    staged = {"upload_id": "up-staged"}
    assert db.schema_version(conn) == 8
    tables = ("dataset_versions", "content_sets", "uploads", "version_content_sets", "studies")
    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    conn.close()

    with local_client(create_app(path, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        conn = db.connect(path, read_only=True)
        assert db.schema_version(conn) == max(number for number, *_ in db.available_migrations())
        assert {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables} == counts
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.close()
        assert client.get(f"{ADMIN}/uploads/{staged['upload_id']}").json()["status"] == "valid"
        assert [entry["note"] for entry in client.get(f"{ADMIN}/versions").json()] == ["Before 0009.", None]
        publish(client, stage(client, "effects", effect("E-AFTER")))
        assert ids(concept(client, "1A00")) == ["E-AFTER"]
