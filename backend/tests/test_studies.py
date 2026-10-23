"""Studies and appraisal (contract v1.13, CONTRACT.md §22).

A study record describes one study; a stored metric row links to it when its
row source's Study equals the Study ID exactly. A linked row's evidence signal
gains +0.05 for a followed reporting guideline and −0.10 (high) or −0.04 (some
concerns, unclear) for its risk of bias; rows without a linked study are graded
exactly as before. All data is synthetic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from admin_helpers import ADMIN, TINY_TARGET, errors_by_code, notes_by_code, read_csv, template, upload_and_wait, write_csv
from conftest import copy_store, local_client
from tiny_tables import tiny_tables, write_tables

from app import db
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app
from app.services import grading
from app.services.aggregation import aggregate_lens_rows, rollup_row
from app.services.types import ALL_POPULATIONS, Lens, MetricValues, Provenance

TINY = {"model": "Tiny-1", "use_case": "CDSS"}
SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}


def study(study_id: str, **fields) -> dict:
    """A one-study record for the records upload (template keys, readable labels)."""
    return {
        "study_id": study_id,
        "title": f"Synthetic study {study_id} (fictional)",
        "design": "Prospective",
        "setting": "Emergency department, tertiary hospital (fictional)",
        "sites": 4,
        "patients": 1800,
        "peer_reviewed": "Yes",
        "conducted_by": "Independent",
        "reporting_guideline": "TRIPOD+AI",
        "guideline_followed": "Yes",
        "risk_of_bias": "Low",
        "population": "Adults with suspected sepsis (synthetic)",
        "evaluation_conditions": "Reference standard: expert panel; 2025 (synthetic).",
        "publication_date": "2026-09-01",
        **fields,
    }


def stage_studies(client, *records: dict) -> dict:
    """Stage study records as a merge (the one-study form's way in), replacing any staged studies upload."""
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "records": list(records), "replace_staged": True})
    assert response.status_code == 202, response.text
    admin = client.app.state.api.admin
    admin.wait_for_checks()
    return client.get(f"{ADMIN}/uploads/{response.json()['upload_id']}").json()


def publish(client, upload: dict, note: str = "Test.") -> dict:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": note})
    assert response.status_code == 200, response.text
    return response.json()


def link_rows(client, study_id: str, *, codes=("1A00",), samples: int = 1800, all_lenses: bool = False) -> dict:
    """A metrics merge that gives rows of the tiny card the source of ``study_id``."""
    header, rows, comments = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    column = {name: header.index(name) for name in header}
    kept = []
    for row in rows:
        if row[column["ICD-11 code"]] not in codes:
            continue
        if not all_lenses and (row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]]) != ("All ages", "All sexes", "All ethnicities"):
            continue
        row[column["Samples"]] = str(samples)
        row[column["Source"]] = f"Synthetic study {study_id} (fictional)"
        row[column["Study"]] = study_id
        row[column["Source date"]] = "2026-09-01"
        kept.append(row)
    upload = upload_and_wait(client, "metrics", write_csv(header, kept, comments), **TINY_TARGET, mode="merge")
    assert upload["status"] == "valid", upload["report"]
    return upload


def concept(client, concept_id: str, **params) -> dict:
    response = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}", params={**TINY, **params})
    assert response.status_code == 200, response.text
    return response.json()


# ----------------------------------------------------------------- grading

SIGNAL_INPUTS = {
    "validation_type": "benchmark", "n_studies": 4, "n_sites": 3, "peer_reviewed_studies": 3, "n_samples": 1800,
    "prevalence_score": 0.45, "use_case": "CDSS", "chapter_no": "01",
}


def test_without_a_study_the_signal_is_exactly_as_before():
    base = grading.penalized_evidence_signal(**SIGNAL_INPUTS)
    assert grading.penalized_evidence_signal(**SIGNAL_INPUTS, study_adjustment=0.0) == base
    terms = grading.evidence_terms("benchmark", 4, 3, 3, 1800)
    weights = grading.EVIDENCE_SIGNAL_WEIGHTS
    assert terms.base == grading.evidence_signal("benchmark", 4, 3, 3, 1800) == base
    assert terms.base == pytest.approx(sum(weights[name] * getattr(terms, name) for name in weights))


def test_a_followed_guideline_raises_and_a_high_risk_of_bias_lowers_the_grade():
    """E2: +0.05 for a followed guideline; −0.10 high, −0.04 some concerns or unclear (D5)."""
    base = grading.penalized_evidence_signal(**SIGNAL_INPUTS)
    assert grading.grade_for_score(base, grading.EVIDENCE_THRESHOLDS) == "C"
    followed = grading.penalized_evidence_signal(**SIGNAL_INPUTS, study_adjustment=0.05)
    assert followed == pytest.approx(base + 0.05) and grading.grade_for_score(followed, grading.EVIDENCE_THRESHOLDS) == "B"
    high = grading.penalized_evidence_signal(**SIGNAL_INPUTS, study_adjustment=-0.10)
    assert high == pytest.approx(base - 0.10) and grading.grade_for_score(high, grading.EVIDENCE_THRESHOLDS) == "D"
    assert grading.penalized_evidence_signal(**SIGNAL_INPUTS, study_adjustment=-2) == 0  # clamped
    assert grading.penalized_evidence_signal(**SIGNAL_INPUTS, study_adjustment=2) == 1


def test_study_adjustments_follow_the_owner_decision():
    from app.repository import StudyRecord
    from app.services.studies import EVIDENCE_STUDY_ADJUSTMENTS, study_adjustment

    def record(guideline="tripod_ai", followed="yes", risk="low"):
        return StudyRecord("S", "t", "prospective", "s", 1, 1, True, "independent", guideline, followed, risk, None, "p", "c", None, "2026-01-01", None)

    assert study_adjustment(record()) == 0.05
    assert study_adjustment(record(followed="partly")) == 0 and study_adjustment(record(followed="no")) == 0
    assert study_adjustment(record(guideline="none", followed=None)) == 0
    assert study_adjustment(record(risk="high")) == pytest.approx(-0.05)
    assert study_adjustment(record(followed="no", risk="some_concerns")) == -0.04
    assert study_adjustment(record(followed="no", risk="unclear")) == -0.04
    assert EVIDENCE_STUDY_ADJUSTMENTS == {"guideline_followed": 0.05, "risk_of_bias": {"low": 0.0, "some_concerns": -0.04, "high": -0.10, "unclear": -0.04}}


def _row(concept_id: str, adjustment: float | None, *, fallback: bool = False) -> MetricValues:
    return MetricValues(
        concept_id=concept_id, lens=ALL_POPULATIONS, perf=0.8, ci_low=0.75, ci_high=0.85, evidence_grade="C", n_samples=1800,
        n_sites=3, n_studies=4, peer_reviewed_studies=3, validation_type="benchmark", in_intended_use=True,
        intended_use_coverage=1, intended_use_level="in_scope", warnings=(),
        provenance=Provenance("condition", lens_fallback=fallback), evidence_signal=0.76,
        study_id="S" if adjustment is not None else None, study_adjustment=adjustment,
    )


def test_rollups_add_the_prevalence_weighted_mean_adjustment():
    children = [_row("A", -0.10), _row("B", None)]
    linked = rollup_row(concept_id="BLK", chapter_no="01", lens=ALL_POPULATIONS, use_case="CDSS", child_rows=children, child_weights=[0.45, 0.12])
    plain = rollup_row(concept_id="BLK", chapter_no="01", lens=ALL_POPULATIONS, use_case="CDSS", child_rows=[_row("A", None), _row("B", None)], child_weights=[0.45, 0.12])
    expected = -0.10 * 0.45 / (0.45 + 0.12)
    assert linked.study_adjustment == pytest.approx(expected) and plain.study_adjustment is None
    assert linked.evidence_signal == pytest.approx(plain.evidence_signal + expected)
    assert linked.study_id is None


def test_a_lens_fallback_adds_the_mean_adjustment_of_its_rows():
    rows = [_row("A", 0.05, fallback=True), _row("A", None, fallback=True), _row("A", -0.04, fallback=True)]
    aggregated = aggregate_lens_rows(rows, concept_id="A", lens=Lens(), use_case="CDSS", prevalence_score=0.45, chapter_no="01", provenance=Provenance("condition", lens_fallback=True))
    plain = aggregate_lens_rows([_row("A", None, fallback=True)] * 3, concept_id="A", lens=Lens(), use_case="CDSS", prevalence_score=0.45, chapter_no="01", provenance=Provenance("condition", lens_fallback=True))
    assert aggregated.study_adjustment == pytest.approx(0.01 / 3)
    assert aggregated.evidence_signal == pytest.approx(plain.evidence_signal + 0.01 / 3)


# ------------------------------------------------------- the data set (API)

def test_studies_publish_link_and_grade_through_the_api(admin_client):
    client = admin_client
    before = concept(client, "1A00")
    assert "appraisal" not in before["metrics"]
    # A study without a guideline, then the same rows graded with it.
    publish(client, stage_studies(client, study("T-STUDY-1", reporting_guideline="None", guideline_followed=None)), "One study.")
    linked = link_rows(client, "T-STUDY-1")
    assert not notes_by_code(linked).get("unknown_study"), "the study is known"
    publish(client, linked, "Linked rows.")
    without_guideline = concept(client, "1A00")["metrics"]
    assert without_guideline["evidence_grade"] == "C"
    appraisal = without_guideline["appraisal"]
    assert appraisal["study"]["study_id"] == "T-STUDY-1" and appraisal["study"]["guideline_followed"] is None
    assert appraisal["applied"] is True and appraisal["study_adjustment"] == 0
    terms = appraisal["terms"]
    assert terms["signal"] == without_guideline["evidence_signal"] and terms["grade"] == "C"
    assert terms["base_signal"] + terms["penalties"] + terms["guideline_adjustment"] + terms["risk_of_bias_adjustment"] == pytest.approx(terms["signal"], abs=1e-4)
    weights = client.get(f"{API_PREFIX}/meta").json()["evidence_signal_weights"]
    assert sum(weights[name] * terms[name] for name in weights) == pytest.approx(terms["base_signal"], abs=1e-3)

    # The otherwise identical record with a followed guideline grades higher (E2).
    changes = stage_studies(client, study("T-STUDY-1"))
    summary = client.get(f"{ADMIN}/uploads/{changes['upload_id']}/changes").json()
    assert summary["rows"]["changed"] == 1 and summary["rows"]["samples"]["changed"][0]["key"] == "T-STUDY-1"
    shifts = {(shift["view"], shift["from"], shift["to"]): shift for shift in summary["status_shifts"]}
    assert shifts[("evidence", "moderate", "strong")]["sample_concept_ids"] == ["1A00"]
    assert shifts[("evidence", "moderate", "strong")]["targets"][0]["model_version"] == "Tiny-1"
    entry = publish(client, changes, "Guideline followed.")
    assert entry["kind"] == "studies" and entry["summary"].startswith("Studies: 1 study changed")
    followed = concept(client, "1A00")["metrics"]
    assert followed["evidence_grade"] == "B"
    assert followed["evidence_signal"] == pytest.approx(without_guideline["evidence_signal"] + 0.05)
    assert followed["appraisal"]["terms"]["guideline_adjustment"] == 0.05

    # A high risk of bias lowers it.
    publish(client, stage_studies(client, study("T-STUDY-1", risk_of_bias="High", guideline_followed="No")), "High risk of bias.")
    high = concept(client, "1A00")["metrics"]
    assert high["evidence_grade"] == "D"
    assert high["evidence_signal"] == pytest.approx(without_guideline["evidence_signal"] - 0.10)
    assert high["appraisal"]["terms"]["risk_of_bias_adjustment"] == -0.1
    assert high["appraisal"]["terms"]["guideline_adjustment"] == 0

    # Unlinked rows and other lenses are unchanged; the block carries the mean adjustment only.
    assert "appraisal" not in concept(client, "1A01")["metrics"]
    assert "appraisal" not in concept(client, "1A00", age="Age 65+")["metrics"]
    block = concept(client, "BLK-01")["metrics"]
    assert block["appraisal"]["study"] is None and block["appraisal"]["terms"] is None
    assert block["appraisal"]["study_adjustment"] == pytest.approx(-0.10 * 0.45 / (0.45 + 0.12), abs=1e-4)
    deeper = concept(client, "1A00.0")["metrics"]
    assert deeper["appraisal"]["study"]["study_id"] == "T-STUDY-1"  # through its anchor

    # The export carries the appraisal too.
    exported = client.get(f"{API_PREFIX}/export/concepts/1A00", params=TINY).json()
    assert exported["model_card"]["appraisal"]["study"]["study_id"] == "T-STUDY-1"

    # Removing the study unlinks the rows: back to the grade without any study.
    removed = stage_studies(client, {"study_id": "T-STUDY-1", "action": "Remove"})
    publish(client, removed, "Study withdrawn.")
    unlinked = concept(client, "1A00")["metrics"]
    assert "appraisal" not in unlinked and unlinked["evidence_signal"] == without_guideline["evidence_signal"]

    # History and restore work like every kind.
    versions = client.get(f"{ADMIN}/versions", params={"kind": "studies"}).json()
    assert [entry["kind"] for entry in versions][:4] == ["studies"] * 4
    restored = client.post(f"{ADMIN}/versions/{versions[1]['version_id']}/rollback", params={"kind": "studies"}, json={"note": "Restore."})
    assert restored.status_code == 200, restored.text
    assert concept(client, "1A00")["metrics"]["evidence_grade"] == "D"


def test_list_and_get_studies(admin_client):
    client = admin_client
    assert client.get(f"{API_PREFIX}/studies").json()["studies"] == []
    publish(client, stage_studies(client, study("T-A", model_version="Tiny-1"), study("T-B")))
    listed = client.get(f"{API_PREFIX}/studies").json()
    assert [entry["study_id"] for entry in listed["studies"]] == ["T-A", "T-B"]
    assert [entry["study_id"] for entry in client.get(f"{API_PREFIX}/studies", params={"model": "Tiny-1"}).json()["studies"]] == ["T-A"]
    assert client.get(f"{API_PREFIX}/studies", params={"model": "Nope-1"}).json()["studies"] == []
    one = client.get(f"{API_PREFIX}/studies/T-B")
    assert one.status_code == 200 and one.json()["study"]["design"] == "prospective"
    assert one.headers["x-dataset-version"] and one.headers["etag"]
    missing = client.get(f"{API_PREFIX}/studies/T-NOPE")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_study"
    assert client.get(f"{API_PREFIX}/studies/bad id!").status_code in (404, 422)
    datasets = {info["kind"]: info for info in client.get(f"{ADMIN}/datasets").json()}
    assert datasets["studies"]["counts"] == {"studies": 2}


def test_unknown_study_ids_stay_valid_with_a_note(admin_client):
    client = admin_client
    upload = link_rows(client, "FREE-TEXT-1")
    note = notes_by_code(upload)["unknown_study"]
    assert note["count"] == 1 and note["examples"][0]["value"] == "FREE-TEXT-1"
    assert "Studies" in note["fix"]
    publish(client, upload)
    assert "appraisal" not in concept(client, "1A00")["metrics"]


def test_study_validation_errors_have_plain_fixes(admin_client):
    client = admin_client
    upload = stage_studies(
        client,
        study("T-1", guideline_followed=None),
        study("T-2", reporting_guideline="None", guideline_followed="Yes"),
        study("T-3", design="Case report"),
        study("T-4", model_version="Nope-9"),
        study("T 5"),
        study("T-6", risk_of_bias="Moderate"),
        study("T-7", sites=0),
        study("T-8", conducted_by="Vendor"),
        study("T-9", source_url="ftp://studies.example/t9"),
        study("T-1"),
    )
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    for code in (
        "missing_guideline_followed", "guideline_followed_without_guideline", "unknown_study_design", "unknown_study_model",
        "invalid_value", "unknown_risk_of_bias", "out_of_range", "unknown_study_conductor", "invalid_url",
    ):
        assert code in errors, code
        assert errors[code]["fix"] and errors[code]["examples"][0]["record"] >= 0
    assert errors["missing_guideline_followed"]["examples"][0]["problem"].startswith("Reporting guideline is TRIPOD+AI")
    missing = stage_studies(client, {"study_id": "T-10", "title": "Only a title"})
    assert "missing_value" in errors_by_code(missing)


def test_studies_templates_round_trip(admin_client):
    client = admin_client
    header, rows, _ = read_csv(template(client, "studies"))
    assert rows == [] and header[:3] == ["Study ID", "Title", "Design"] and header[-1] == "Action"
    publish(client, stage_studies(client, study("T-A", model_version="Tiny-1", source_url="https://studies.example/t-a", risk_of_bias_notes="Analysis: some concerns.")))
    filled = template(client, "studies", filled="true")
    header, rows, _ = read_csv(filled)
    assert rows[0][:3] == ["T-A", "Synthetic study T-A (fictional)", "Prospective"]
    again = upload_and_wait(client, "studies", filled)
    assert again["status"] == "valid", again["report"]
    summary = client.get(f"{ADMIN}/uploads/{again['upload_id']}/changes").json()
    assert summary["rows"] == {**summary["rows"], "added": 0, "changed": 0, "removed": 0, "unchanged": 1}
    xlsx = template(client, "studies", "xlsx", filled="true")
    assert upload_and_wait(client, "studies", xlsx, "studies.xlsx", replace_staged=True)["status"] == "valid"


def test_a_registry_publish_rechecks_staged_studies(admin_client):
    client = admin_client
    upload = stage_studies(client, study("T-A", model_version="Tiny-1"))
    assert upload["status"] == "valid"
    header, rows, comments = read_csv(template(client, "models", filled="true"))
    rows[0][header.index("Display name")] = "Tiny one"
    registry = upload_and_wait(client, "models", write_csv(header, rows, comments))
    publish(client, registry)
    client.app.state.api.admin.wait_for_checks()
    assert client.get(f"{ADMIN}/uploads/{upload['upload_id']}").json()["status"] == "valid"


# ------------------------------------------------------------ byte identity

@pytest.fixture
def seed_admin(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "seed.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        yield client


SEED_READS = [
    ("/metrics/map", {**SYN, "scope": "atlas"}),
    ("/metrics/map", {**SYN, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/map", {**MEDICORE, "scope": "chapter", "chapter_id": "CH-11"}),
    ("/metrics/summary", {**SYN, "view": "overall"}),
    ("/metrics/summary", {**SYN, "view": "evidence"}),
    ("/metrics/concepts/CH-05", SYN),
    ("/metrics/concepts/BA00", SYN),
    ("/metrics/concepts/1A01", MEDICORE),
    ("/metrics/concepts/1A03.1", {**SYN, "sex": "Sex Male"}),
    ("/multimorbidity/combination", {**SYN, "selected": "GB61,5A11"}),
    ("/catalogue", {}),
]


def _label_free(response) -> bytes:
    label = response.headers["x-dataset-version"]
    return response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')


def _read(client, path, params):
    response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, f"{path}: {response.text[:200]}"
    return response


def test_reads_without_linked_studies_are_byte_identical(seed_admin):
    """E2: on the seed store, reads are byte for byte what they were (apart from the
    version label) when a studies set that links no row is published, and when it is restored away."""
    client = seed_admin
    before = {(path, json.dumps(params)): _label_free(_read(client, path, params)) for path, params in SEED_READS}
    meta_before = _read(client, "/meta", {}).json()
    upload = stage_studies(client, study("UNLINKED-1"), study("UNLINKED-2", risk_of_bias="High"))
    summary = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert summary["rows"]["added"] == 2 and summary["status_shifts"] == []
    entry = publish(client, upload)
    for stage in ("published", "restored"):
        for key, body in before.items():
            assert _label_free(_read(client, key[0], json.loads(key[1]))) == body, (stage, key)
        meta = _read(client, "/meta", {}).json()
        assert {**meta, "dataset_version": "*"} == {**meta_before, "dataset_version": "*"}
        if stage == "published":
            assert client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "studies"}).status_code == 200
    assert entry["kind"] == "studies"


def test_linked_rows_change_only_their_own_card(seed_admin):
    """Linking rows of one card changes no read of another card."""
    client = seed_admin
    other = [(path, params) for path, params in SEED_READS if params.get("model") == MEDICORE["model"]]
    before = {(path, json.dumps(params)): _label_free(_read(client, path, params)) for path, params in other}
    publish(client, stage_studies(client, study("SEED-LINK-1", risk_of_bias="High", guideline_followed="No", model_version="SynGPT-2.0")))
    header, rows, comments = read_csv(template(client, "metrics", filled="true", model_version=SYN["model"], use_case=SYN["use_case"]))
    column = {name: header.index(name) for name in header}
    # A seed row with evidence at the all-population lens (many seed rows have none).
    kept = [
        next(
            row for row in rows
            if (row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]]) == ("All ages", "All sexes", "All ethnicities")
            and row[column["Validation type"]] and "no_validation_data" not in row[column["Warnings"]] and row[column["Performance"]]
        )
    ]
    code = kept[0][column["ICD-11 code"]]
    syn_before = _read(client, f"/metrics/concepts/{code}", SYN).json()["metrics"]
    kept[0][column["Source"]], kept[0][column["Study"]], kept[0][column["Source date"]] = "Synthetic link (fictional)", "SEED-LINK-1", "2026-09-01"
    merge = upload_and_wait(client, "metrics", write_csv(header, kept, comments), model_version=SYN["model"], use_case=SYN["use_case"], mode="merge")
    publish(client, merge)
    for key, body in before.items():
        assert _label_free(_read(client, key[0], json.loads(key[1]))) == body, key
    after = _read(client, f"/metrics/concepts/{code}", SYN).json()["metrics"]
    assert after["evidence_signal"] == pytest.approx(max(0, syn_before["evidence_signal"] - 0.10))
    assert after["appraisal"]["study"]["study_id"] == "SEED-LINK-1"
    assert after["appraisal"]["study_adjustment"] == -0.1
    assert syn_before.get("appraisal") is None


# --------------------------------------------------------------- migration

def test_migration_0007_keeps_history_and_staged_uploads(tmp_path, monkeypatch):
    """A store at schema 6 with a local population and a staged population upload migrates in place."""
    path = tmp_path / "tiny.sqlite"
    six = [migration for migration in db.available_migrations() if migration[0] <= 6]
    with monkeypatch.context() as patch:
        patch.setattr(db, "available_migrations", lambda: six)
        import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), path)
    # A published local population and a staged replacement, written as schema-6 code wrote them
    # (since schema 9 the code itself needs the newest schema, so the app does not run at schema 6).
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    now = "2026-10-12T10:00:00Z"

    def population_set(upload_id: str, tier: str) -> int:
        set_id = conn.execute(
            "INSERT INTO content_sets (kind, source, created_at, meta_json, population_id) VALUES ('population', ?, ?, '{}', 'tiny-region')",
            (f"upload:{upload_id}", now),
        ).lastrowid
        conn.execute("INSERT INTO population_sets (set_id, name) VALUES (?, 'Tiny region (fictional)')", (set_id,))
        conn.execute("INSERT INTO prevalence_sets (set_id, min_score, max_score) VALUES (?, 0.03, 0.97)", (set_id,))
        conn.execute("INSERT INTO prevalence_tiers (set_id, code, tier) VALUES (?, '1A00', ?)", (set_id, tier))
        return set_id

    report = json.dumps({"row_count": 1, "errors": [], "notes": []})
    published = population_set("up-pop-1", "very_rare")
    conn.execute(
        "INSERT INTO dataset_versions (version_id, kind, created_at, summary, upload_id, note) "
        "VALUES (2, 'population', ?, 'Local population Tiny region (fictional) (tiny-region): 1 row added.', 'up-pop-1', 'Before 0007.')",
        (now,),
    )
    conn.execute("INSERT INTO version_content_sets SELECT 2, set_id FROM version_content_sets WHERE version_id = 1")
    conn.execute("INSERT INTO version_content_sets VALUES (2, ?)", (published,))
    for upload_id, status, set_id, version in (("up-pop-1", "published", published, 2), ("up-pop-2", "valid", population_set("up-pop-2", "rare"), None)):
        conn.execute(
            "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json, set_id, "
            "published_version, population_id, population_name) VALUES (?, 'population', 'p.csv', 'csv', ?, 1, ?, ?, ?, ?, 'tiny-region', 'Tiny region (fictional)')",
            (upload_id, status, now, report, set_id, version),
        )
    conn.commit()
    staged = {"upload_id": "up-pop-2"}
    assert db.schema_version(conn) == 6
    tables = ("dataset_versions", "content_sets", "uploads", "version_content_sets", "population_sets")
    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    conn.close()

    with local_client(create_app(path, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        conn = db.connect(path, read_only=True)
        # Migrated to the newest schema (0007 and every later migration).
        assert db.schema_version(conn) == max(number for number, *_ in db.available_migrations())
        assert {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables} == counts
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.close()
        assert client.get(f"{ADMIN}/uploads/{staged['upload_id']}").json()["target"]["population_id"] == "tiny-region"
        assert [entry["note"] for entry in client.get(f"{ADMIN}/versions").json()] == ["Before 0007.", None]
        publish(client, stage_studies(client, study("T-AFTER")))
        assert client.get(f"{API_PREFIX}/studies").json()["studies"][0]["study_id"] == "T-AFTER"
