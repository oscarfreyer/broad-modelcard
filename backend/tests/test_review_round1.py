"""Contract v1.11 (criteria E1, E3, E4, E7):
optional intended use and the D3 score, one missing state (D5), performance
needs evidence (D12), the catalogue snapshot, the incident list, and the
no-change rollback. Reads use the demo store (pack v4 with the demo
revision); writes use a private tiny store."""

from __future__ import annotations

import sqlite3

import pytest
from admin_helpers import ADMIN, TINY_TARGET, errors_by_code, read_csv, template, upload_and_wait, wait, write_csv
from conftest import local_client

from app.main import API_PREFIX, create_app
from app.services.grading import GRADE_SCORES, OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE

SYNGPT_1 = {"model": "SynGPT-1.0", "use_case": "Clinician Facing CDSS"}
SKINAI = {"model": "SkinAI-1.0", "use_case": "Skin lesion CDSS"}
NO_STATEMENT = {"SynGPT-1.0", "SynGPT-2.0", "MediCore-2.5", "Tallyfern-Coding-1.4"}  # pack v13 adds a coding product without one
TINY = {"model": "Tiny-1", "use_case": "CDSS"}


def rows_of(body: dict) -> list[dict]:
    return [dict(zip(body["columns"], row, strict=True)) for row in body["rows"]]


def get(client, path: str, **params) -> dict:
    response = client.get(f"{API_PREFIX}{path}", params=params)
    assert response.status_code == 200, response.text[:300]
    return response.json()


def d3_score(row: dict) -> float:
    weights = OVERALL_SCORE_WEIGHTS_WITHOUT_INTENDED_USE
    perf = min(1, max(0, row["perf"]))
    return round(
        weights["performance_grade"] * GRADE_SCORES[row["performance_grade"]]
        + weights["perf"] * perf
        + weights["evidence_grade"] * GRADE_SCORES[row["evidence_grade"]],
        3,
    )


# ----------------------------------------------------- E1: no statement, D3

def test_the_registry_says_which_cards_state_their_intended_use(demo_client):
    registry = get(demo_client, "/models")
    for model in registry["models"]:
        for configuration in model["use_cases"]:
            assert configuration["intended_use_defined"] is (model["model_version"] not in NO_STATEMENT), model["model_version"]
    weights = get(demo_client, "/meta")["overall_score_weights_without_intended_use"]
    assert weights == pytest.approx({"performance_grade": 0.35 / 0.85, "perf": 0.20 / 0.85, "evidence_grade": 0.30 / 0.85})


def test_a_card_without_a_statement_has_no_intended_use_and_the_d3_score(demo_client):
    """E1 on SynGPT-1.0: every intended-use field is null, nothing is out of scope, and
    the overall score of a sample condition equals the D3 formula."""
    rows = rows_of(get(demo_client, "/metrics/map", **SYNGPT_1, scope="atlas"))
    assert all(row["intended_use_level"] is None for row in rows)
    assert not any(row["overall_status"] == "out_of_scope" for row in rows)
    for age in ("All ages", "Age 65+"):
        for concept_id in ("1A00", "5A11", "BLK-01-BlockL1-1A0", "CH-05"):
            metrics = get(demo_client, f"/metrics/concepts/{concept_id}", **SYNGPT_1, age=age)["metrics"]
            assert (metrics["in_intended_use"], metrics["intended_use_coverage"], metrics["intended_use_level"]) == (None, None, None)
            assert metrics["overall"]["tier"] != "out_of_scope"
            assert "out_of_scope_group" not in {warning["code"] for warning in metrics["warnings"]}
            assert not {"scope-stop", "scope-partial"} & {safeguard["id"] for safeguard in metrics["safeguards"]}
    sample = get(demo_client, "/metrics/concepts/5A11", **SYNGPT_1)["metrics"]
    assert sample["overall"]["tier"] == "graded"
    assert sample["overall"]["score"] == pytest.approx(d3_score(sample), abs=0.0011)
    graded = [row for row in rows if row["overall_score"] is not None and row["concept_id"][:3] not in ("BLK", "CH-")]
    for row in graded[:200]:
        assert row["overall_score"] == pytest.approx(d3_score(row), abs=0.0011), row["concept_id"]

    summary = get(demo_client, "/metrics/summary", **SYNGPT_1, view="intended_use")
    assert summary["intended_use_counts"] is None and summary["counts"]["out_of_scope"] == 0
    tile = next(tile for tile in get(demo_client, "/catalogue")["tiles"] if tile["card_id"] == "SynGPT-1.0|Clinician Facing CDSS")
    assert tile["intended_use_defined"] is False and tile["distribution"]["intended_use"] is None
    assert tile["distribution"]["overall"]["out_of_scope"] == 0
    lookup = demo_client.post(
        f"{API_PREFIX}/lookup",
        json={"context": {"card": {"model_version": "SynGPT-1.0", "use_case": "Clinician Facing CDSS"}, "conditions": [{"code": "5A11"}]}},
    ).json()
    assert lookup["conditions"][0]["statuses"]["intended_use"] is None
    assert lookup["card"]["intended_use_defined"] is False


def test_a_card_with_a_statement_keeps_its_intended_use(demo_client):
    """SkinAI-1.0 states its intended use: out-of-scope conditions stay out of scope."""
    rows = rows_of(get(demo_client, "/metrics/map", **SKINAI, scope="atlas"))
    assert {row["intended_use_level"] for row in rows} >= {"in_scope", "out_of_scope"}
    assert any(row["overall_status"] == "out_of_scope" for row in rows)
    tile = next(tile for tile in get(demo_client, "/catalogue")["tiles"] if tile["card_id"] == "SkinAI-1.0|Skin lesion CDSS")
    assert tile["intended_use_defined"] is True and tile["distribution"]["intended_use"]["out_of_scope"] > 0
    lookup = demo_client.post(
        f"{API_PREFIX}/lookup",
        json={"context": {"card": {"model_version": "SkinAI-1.0", "use_case": "Skin lesion CDSS"}, "conditions": [{"code": "2C30"}]}},
    ).json()
    assert lookup["card"]["intended_use_defined"] is True


# ------------------------------------------------- E3: no perf without evidence

def test_after_the_demo_revision_no_card_has_performance_without_evidence(demo_db, demo_client):
    """E3: no stored row of the live version (any card, any lens, multimorbidity too) has a
    performance value and no evidence, and no served condition row has perf without a grade."""
    store, _ = demo_db
    with sqlite3.connect(f"file:{store}?mode=ro", uri=True) as conn:
        live = conn.execute("SELECT MAX(version_id) FROM dataset_versions").fetchone()[0]
        for table in ("metric_rows", "mm_rows"):
            gaps = conn.execute(
                f"SELECT COUNT(*) FROM version_content_sets v JOIN {table} m ON m.set_id = v.set_id "
                "JOIN warning_sets w ON w.warning_set_id = m.warning_set_id "
                "WHERE v.version_id = ? AND m.perf IS NOT NULL "
                "AND (m.validation_type IS NULL OR m.validation_type = '' OR w.codes_json LIKE '%no_validation_data%')",
                (live,),
            ).fetchone()[0]
            assert gaps == 0, table
        revised = conn.execute(
            "SELECT COUNT(*) FROM metric_row_provenance p JOIN provenance_sources s USING (provenance_id) "
            "WHERE s.source = 'Demo revision (synthetic)'"
        ).fetchone()[0]
    conn.close()
    assert revised > 400_000
    for model in get(demo_client, "/models")["models"]:
        for configuration in model["use_cases"]:
            card = {"model": model["model_version"], "use_case": configuration["use_case"]}
            rows = rows_of(get(demo_client, "/metrics/map", **card, scope="atlas"))
            conditions = [row for row in rows if row["child_count"] is None]
            assert not [row for row in conditions if row["perf"] is not None and row["evidence_grade"] is None], card
            # Performance and Evidence read No data for the same conditions.
            assert [row["performance_status"] == "no_data" for row in conditions] == [row["evidence_status"] == "no_data" for row in conditions], card


def test_the_revision_is_published_through_the_workflow_with_notes(demo_db, demo_client):
    versions = demo_client.get(f"{ADMIN}/versions").json()
    revision = [entry for entry in versions if "generated evidence" in (entry["note"] or "")]
    assert len(revision) == 10 and all(entry["kind"] == "metrics" for entry in revision)
    registry = next(entry for entry in versions if (entry["note"] or "").startswith("Demo pack v13, v4/registry.csv"))
    # 6 cards without a statement, 3 systems relabelled as products, Corvessa without Built on (2026-10-21).
    assert registry["kind"] == "models" and registry["summary"] == "AI systems & functions: 10 rows changed."
    with sqlite3.connect(f"file:{demo_db[0]}?mode=ro", uri=True) as conn:
        (concept_id,) = conn.execute(
            "SELECT p.concept_id FROM metric_row_provenance p JOIN provenance_sources s USING (provenance_id) "
            "JOIN version_content_sets v ON v.set_id = p.set_id JOIN content_sets c ON c.set_id = p.set_id "
            "WHERE s.source = 'Demo revision (synthetic)' AND p.combo_idx = 0 AND c.model_version = ? AND c.use_case = ? "
            "AND v.version_id = (SELECT MAX(version_id) FROM dataset_versions) ORDER BY p.concept_id LIMIT 1",
            (SYNGPT_1["model"], SYNGPT_1["use_case"]),
        ).fetchone()
    conn.close()
    sample = get(demo_client, f"/metrics/concepts/{concept_id}", **SYNGPT_1)["metrics"]
    assert sample["provenance"]["data_source"] == {"source": "Demo revision (synthetic)", "study": "DEMO-REV-2026-10", "date": "2026-10-13"}
    assert sample["validation_type"] in ("internal_test", "benchmark", "simulation_study") and 1 <= sample["n_studies"] <= 3


# ------------------------------------------------------------- D5: no_data

def test_not_validated_is_served_nowhere(demo_client):
    card = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}  # many conditions without performance
    bodies = [
        demo_client.get(f"{API_PREFIX}/meta").text,
        demo_client.get(f"{API_PREFIX}/catalogue").text,
        demo_client.get(f"{API_PREFIX}/metrics/map", params={**card, "scope": "atlas"}).text,
        demo_client.get(f"{API_PREFIX}/metrics/summary", params=card).text,
        demo_client.get(f"{API_PREFIX}/metrics/summary", params={**card, "view": "evidence"}).text,
        demo_client.get(f"{API_PREFIX}/metrics/concepts/CH-01", params=card).text,
        demo_client.get(f"{API_PREFIX}/multimorbidity/candidates", params={"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}).text,
        demo_client.post(f"{API_PREFIX}/lookup", json={"context": {"card": {"model_version": "ICU_GPT-1.0", "use_case": "CDSS"}, "conditions": [{"code": "1A00"}, {"code": "5A11"}]}}).text,
    ]
    assert not [body for body in bodies if "not_validated" in body]


def test_a_row_without_an_evidence_grade_reads_no_data(client):
    """On the seed (no revision), rows with performance and no evidence read No data, keeping the safeguard."""
    rows = rows_of(get(client, "/metrics/map", model="SynGPT-2.0", use_case="Clinician Facing CDSS", scope="atlas"))
    unvalidated = [row for row in rows if row["perf"] is not None and row["evidence_grade"] is None and row["child_count"] is None]
    assert unvalidated
    assert {(row["overall_status"], row["evidence_status"]) for row in unvalidated} == {("no_data", "no_data")}
    metrics = get(client, f"/metrics/concepts/{unvalidated[0]['concept_id']}", model="SynGPT-2.0", use_case="Clinician Facing CDSS")["metrics"]
    assert metrics["overall"]["tier"] == "no_evidence_data"
    assert {"id": "evidence-missing", "priority": "Important"} in metrics["safeguards"]
    assert "not_validated" not in get(client, "/meta")["statuses"]


# ----------------------------------------------------- E4: D12 and templates

def _tiny_metrics(admin_client) -> tuple[list[str], list[list[str]], list[str]]:
    return read_csv(template(admin_client, "metrics", filled="true", **TINY_TARGET))


def test_performance_without_evidence_is_rejected_with_a_readable_message(admin_client):
    header, rows, comments = _tiny_metrics(admin_client)
    rows[0][header.index("Validation type")] = ""
    code = rows[0][header.index("ICD-11 code")]
    upload = upload_and_wait(admin_client, "metrics", write_csv(header, rows, comments), **TINY_TARGET)
    assert upload["status"] == "invalid"
    group = errors_by_code(upload)["performance_without_evidence"]
    assert group["count"] == 1 and group["fix"]
    (example,) = group["examples"]
    assert example["row"] == len(comments) + 2 and example["column"] == "Performance"
    assert example["problem"].startswith(f"{code}: performance ") and "Validation type is empty" in example["problem"]

    # The same as a merge records upload, and through the no_validation_data warning.
    record = {"code": code, "age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities", "perf": 0.9,
              "validation_type": "Benchmark", "n_samples": 300, "in_intended_use": "Yes", "intended_use_level": "In scope",
              "warnings": "no_validation_data", "source": "Synthetic study (fictional)", "study": "T-12", "source_date": "2026-10-01"}
    response = admin_client.post(f"{ADMIN}/uploads/records", json={"kind": "metrics", **TINY_TARGET, "records": [record], "replace_staged": True})
    assert response.status_code == 202
    merged = wait(admin_client, response.json()["upload_id"])
    assert "performance_without_evidence" in errors_by_code(merged)


def test_rows_may_leave_intended_use_empty(admin_client):
    """Blank In intended use and Intended-use level: the row has no intended-use value (served
    as null, never out of scope, scored with D3), and the filled template round-trips."""
    header, rows, comments = _tiny_metrics(admin_client)
    for name in ("In intended use", "Intended-use coverage", "Intended-use level"):
        rows[0][header.index(name)] = ""
    code = rows[0][header.index("ICD-11 code")]
    upload = upload_and_wait(admin_client, "metrics", write_csv(header, rows, comments), **TINY_TARGET)
    assert upload["status"] == "valid", upload["report"]
    assert admin_client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False}).status_code == 200
    metrics = get(admin_client, f"/metrics/concepts/{code}", **TINY)["metrics"]
    assert (metrics["in_intended_use"], metrics["intended_use_coverage"], metrics["intended_use_level"]) == (None, None, None)
    assert metrics["overall"]["score"] == pytest.approx(d3_score(metrics), abs=0.0011)

    again = upload_and_wait(admin_client, "metrics", template(admin_client, "metrics", filled="true", **TINY_TARGET), **TINY_TARGET)
    assert again["status"] == "valid", again["report"]
    changes = admin_client.get(f"{ADMIN}/uploads/{again['upload_id']}/changes").json()
    assert changes["rows"]["changed"] == 0

    header, rows, comments = _tiny_metrics(admin_client)
    rows[0][header.index("In intended use")] = "Yes"  # one of the two without the other
    half = upload_and_wait(admin_client, "metrics", write_csv(header, rows, comments), replace_staged=True, **TINY_TARGET)
    assert "missing_value" in errors_by_code(half)


def test_registry_files_without_the_new_column_stay_valid(admin_client):
    header, rows, comments = read_csv(template(admin_client, "models", filled="true"))
    assert "Intended use stated" in header
    index = header.index("Intended use stated")
    older = write_csv(header[:index] + header[index + 1:], [row[:index] + row[index + 1:] for row in rows], comments)
    upload = upload_and_wait(admin_client, "models", older)
    assert upload["status"] == "valid", upload["report"]
    changes = admin_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert changes["rows"]["changed"] == 0 and changes["models"]["changed"] == []


def test_a_registry_upload_can_say_a_card_has_no_statement(admin_client):
    header, rows, comments = read_csv(template(admin_client, "models", filled="true"))
    rows[0][header.index("Intended use stated")] = "No"
    upload = upload_and_wait(admin_client, "models", write_csv(header, rows, comments))
    assert upload["status"] == "valid", upload["report"]
    assert admin_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]["changed"] == 1
    published = admin_client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False})
    assert published.status_code == 200
    (configuration,) = get(admin_client, "/models")["models"][0]["use_cases"]
    assert configuration["intended_use_defined"] is False
    metrics = get(admin_client, "/metrics/concepts/1A00", **TINY)["metrics"]
    assert metrics["intended_use_level"] is None and metrics["overall"]["score"] == pytest.approx(d3_score(metrics), abs=0.0011)
    tile = get(admin_client, "/catalogue")["tiles"][0]
    assert tile["intended_use_defined"] is False and tile["distribution"]["intended_use"] is None
    assert tile["last_updated"]["version"] == published.json()["version_id"], "the statement is part of the registry signature"
    # The filled template now says No and uploads unchanged.
    header, rows, _ = read_csv(template(admin_client, "models", filled="true"))
    assert rows[0][header.index("Intended use stated")] == "No"


# ------------------------------------------------------------ the snapshot

def test_the_catalogue_snapshot_matches_the_atlas_map(demo_client):
    body = get(demo_client, "/catalogue")
    overview = get(demo_client, "/atlas/overview")
    assert [block["id"] for block in body["snapshot_blocks"]] == [block["concept_id"] for block in overview["blocks"]]
    assert [block["chapter"] for block in body["snapshot_blocks"]] == [block["chapter_id"] for block in overview["blocks"]]
    for tile in body["tiles"][::3]:
        rows = {row["concept_id"]: row for row in rows_of(get(demo_client, "/metrics/map", model=tile["model_version"], use_case=tile["use_case"], scope="atlas"))}
        expected_overview = [
            "no_data" if rows[block["id"]]["child_count"] == 0 else rows[block["id"]]["overall_status"] for block in body["snapshot_blocks"]
        ]
        assert tile["snapshot"]["overview"] == expected_overview, tile["card_id"]
        assert tile["snapshot"]["safety"] == [rows[block["id"]]["safety"] for block in body["snapshot_blocks"]], tile["card_id"]
    marked = {tile["card_id"] for tile in body["tiles"] if any(tile["snapshot"]["safety"])}
    assert "SynGPT-2.0|Clinician Facing CDSS" in marked


# ------------------------------------------------------- the incident list

def test_the_incident_list_includes_closed_incidents(demo_client):
    listed = demo_client.get(f"{ADMIN}/safety/incidents")
    assert listed.status_code == 200 and listed.headers["cache-control"] == "no-store"
    incidents = listed.json()["incidents"]
    assert len(incidents) == 22  # pack v7 adds a hospital incident (contract v1.13, §26), pack v11 four (§30), pack v13 one
    assert {incident["status"] for incident in incidents} == {"open", "mitigated", "closed"}
    dates = [incident["updated_date"] or incident["reported_date"] for incident in incidents]
    assert dates == sorted(dates, reverse=True), "newest first"
    chapter = next(incident for incident in incidents if incident["chapter_id"])
    assert chapter["chapter_no"] in ("06", "11") and chapter["codes"] == chapter["code_names"] == []
    coded = next(incident for incident in incidents if incident["codes"])
    assert len(coded["code_names"]) == len(coded["codes"]) and all(coded["code_names"])

    card = demo_client.get(f"{ADMIN}/safety/incidents", params={"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}).json()["incidents"]
    assert card and all((incident["model_version"], incident["use_case"]) == ("SynGPT-2.0", "Clinician Facing CDSS") for incident in card)
    model = demo_client.get(f"{ADMIN}/safety/incidents", params={"model": "SynGPT-2.0"}).json()["incidents"]
    assert len(model) >= len(card) and all(incident["model_version"] == "SynGPT-2.0" for incident in model)
    assert demo_client.get(f"{ADMIN}/safety/incidents", params={"model": "Nobody-1"}).json()["incidents"] == []


# ---------------------------------------------------------- E7: rollback

def test_a_rollback_that_changes_nothing_is_refused(admin_client):
    """The case: a safety change, then "restore version 1" for the registry, which
    already equals version 1. It is refused and adds no version; restoring the safety set works."""
    incident = {
        "incident_id": "SI-R-1", "model_version": "Tiny-1", "use_case": "CDSS", "codes": "1A00", "incident_type": "Other",
        "harm": "None", "status": "Open", "source_type": "Incident report", "source_reference": "Fictional report",
        "reported_date": "2026-10-01", "summary": "Synthetic test incident.",
    }
    created = admin_client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [incident]}).json()
    upload = wait(admin_client, created["upload_id"])
    assert upload["status"] == "valid"
    published = admin_client.post(f"{ADMIN}/uploads/{created['upload_id']}/publish", json={"previewed": False}).json()
    before = admin_client.get(f"{ADMIN}/versions").json()

    for kind in ("models", "metrics", "prevalence"):
        refused = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"kind": kind})
        assert refused.status_code == 409 and refused.json()["code"] == "rollback_no_change", kind
        assert "would change nothing" in refused.json()["detail"]
    assert admin_client.get(f"{ADMIN}/versions").json() == before

    restored = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "safety"})
    assert restored.status_code == 200 and restored.json()["rollback_of"] == 1
    assert restored.json()["version_id"] == published["version_id"] + 1
    again = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "safety"})
    assert again.status_code == 409 and again.json()["code"] == "rollback_no_change"
    # Without kind, version 1 covers every kind: now equal to the live data too.
    assert admin_client.post(f"{ADMIN}/versions/1/rollback").json()["code"] == "rollback_no_change"


def test_every_kind_restores_every_data_set_in_one_version(admin_client):
    """Restore "Everything" (v1.11): one version, kind null, every later change undone."""
    incident = {
        "incident_id": "SI-R-2", "model_version": "Tiny-1", "use_case": "CDSS", "codes": "1A00", "incident_type": "Other",
        "harm": "None", "status": "Open", "source_type": "Incident report", "source_reference": "Fictional report",
        "reported_date": "2026-10-01", "summary": "Synthetic test incident.",
    }
    created = admin_client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [incident]}).json()
    assert wait(admin_client, created["upload_id"])["status"] == "valid"
    published = admin_client.post(f"{ADMIN}/uploads/{created['upload_id']}/publish", json={"previewed": False}).json()

    both = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "safety", "every_kind": "true"})
    assert both.status_code == 422 and both.json()["code"] == "invalid_rollback"

    restored = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"every_kind": "true"}, json={"note": "Back to the start."})
    assert restored.status_code == 200
    entry = restored.json()
    assert entry["version_id"] == published["version_id"] + 1
    assert entry["kind"] is None and entry["rollback_of"] == 1 and entry["note"] == "Back to the start."
    assert admin_client.get(f"{ADMIN}/safety/incidents").json()["incidents"] == []
    again = admin_client.post(f"{ADMIN}/versions/1/rollback", params={"every_kind": "true"})
    assert again.status_code == 409 and again.json()["code"] == "rollback_no_change"


def test_the_seed_store_still_round_trips_with_a_merge(tiny_store, tmp_path):
    """A new store at schema 6 serves intended_use_defined true for every seed card."""
    with local_client(create_app(tiny_store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        (configuration,) = get(client, "/models")["models"][0]["use_cases"]
        assert configuration["intended_use_defined"] is True


def test_the_seed_import_defaults_to_bmc_db(monkeypatch, tmp_path):
    """python -m app.importers.legacy_json without --db builds $BMC_DB, never the checkout's default store."""
    from app.importers import legacy_json

    target = tmp_path / "scratch.sqlite"
    seen = {}
    monkeypatch.setenv("BMC_DB", str(target))
    class Report:
        def describe(self):
            return "ok"

    def fake_import(seed_dir, db_path, **kwargs):
        seen["db"] = db_path
        return Report()

    monkeypatch.setattr(legacy_json, "import_legacy_tables", fake_import)
    assert legacy_json.main(["--quiet"]) == 0
    assert seen["db"] == target
