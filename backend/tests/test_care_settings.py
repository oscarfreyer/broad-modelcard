"""Care settings as a lens axis (contract v1.14, CONTRACT.md §29).

The Context axis lists Any setting (``Clinical``) and five specific care
settings. A read names one with ``context``; a specific setting reads only the
rows stored for it (No data where there are none), with rollups, the
demographic fallback, grading, and local results working within the setting.
Every read without the parameter, or with ``context=Clinical``, is byte for
byte what it was before. All data is synthetic.
"""

from __future__ import annotations

import json
import sqlite3

from admin_helpers import ADMIN, TINY_TARGET, errors_by_code, notes_by_code, read_csv, template, upload_and_wait, wait, write_csv
from conftest import copy_store, local_client

from app import db
from app.main import API_PREFIX, create_app
from app.schema.contract import CARE_SETTINGS, CONTEXTS, SETTING_CATEGORIES
from app.schema.templates import INSTRUCTIONS
from app.services.types import Axes, Lens

TINY = {"model": "Tiny-1", "use_case": "CDSS"}
ED = "Emergency department"
ICU = "Intensive care"
REGION = {"population_id": "tiny-region", "population_name": "Tiny region (fictional)"}


def get(client, path, params=None, status=200):
    response = client.get(f"{API_PREFIX}{path}", params=params or {})
    assert response.status_code == status, response.text[:400]
    return response


def publish(client, upload) -> dict:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": "Test."})
    assert response.status_code == 200, response.text[:400]
    return response.json()


def stage_records(client, kind, records, **extra) -> dict:
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": kind, "records": records, **extra})
    assert response.status_code == 202, response.text[:400]
    return wait(client, response.json()["upload_id"])


def metric(code, perf, *, setting=ED, age="All ages", sex="All sexes", ethnicity="All ethnicities", study="SET-1", **fields) -> dict:
    record = {
        "code": code, "age": age, "sex": sex, "ethnicity": ethnicity, "perf": perf, "ci_low": round(perf - 0.03, 3),
        "ci_high": round(perf + 0.03, 3), "n_samples": 900, "n_sites": 3, "n_studies": 1, "peer_reviewed_studies": 1,
        "validation_type": "Clinical study (multisite)", "in_intended_use": "Yes", "intended_use_level": "In scope",
        "warnings": "", "source": "Synthetic setting study (fictional)", "study": study, "source_date": "2026-10-20", **fields,
    }
    if setting is not None:
        record["setting"] = setting
    return record


def stage_metrics(client, records) -> dict:
    return stage_records(client, "metrics", records, model_version="Tiny-1", use_case="CDSS")


def normalized(response) -> bytes:
    label = response.headers["x-dataset-version"]
    body = response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')
    if b'"exported_at"' in body:
        value = json.loads(body)
        value.pop("exported_at")
        body = json.dumps(value).encode()
    return body


# Every read that takes a lens, plus the reads around it.
READS = [
    ("/metrics/map", {**TINY, "scope": "atlas"}),
    ("/metrics/map", {**TINY, "scope": "chapter", "chapter_id": "CH-01"}),
    ("/metrics/map", {**TINY, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/summary", {**TINY, "view": "overall"}),
    ("/metrics/summary", {**TINY, "view": "evidence", "sex": "Sex Female"}),
    ("/metrics/concepts/1A00", TINY),
    ("/metrics/concepts/1A00.0", TINY),
    ("/metrics/concepts/BLK-01", {**TINY, "age": "Age 65+"}),
    ("/metrics/concepts/CH-01", TINY),
    ("/metrics/concepts/1A00/subgroups", TINY),
    ("/metrics/subgroups/summary", TINY),
    ("/multimorbidity/candidates", {**TINY, "scope": "atlas"}),
    ("/multimorbidity/combination", {**TINY, "selected": "1A00,1A01"}),
    ("/export/concepts/1A00", TINY),
    ("/catalogue", {}),
    ("/atlas/overview", {}),
    ("/search", {"q": "1A0"}),
]


def snapshot(client, *, context=None) -> dict:
    found = {}
    for path, params in READS:
        found[(path, json.dumps(params))] = normalized(get(client, path, {**params, **({"context": context} if context else {})}))
    return found


# ---------------------------------------------------------------- the axis

def test_the_axes_list_any_setting_then_the_five_settings(admin_client):
    meta = get(admin_client, "/meta").json()
    assert meta["axes"]["context"] == list(CONTEXTS)
    assert list(CONTEXTS) == ["Clinical", ED, ICU, "Inpatient ward", "Outpatient clinic", "Primary care"]
    # One vocabulary with the studies' setting category (§22, §29).
    assert tuple(CARE_SETTINGS) == SETTING_CATEGORIES[:5]


def test_combination_index_keeps_any_setting_and_adds_ninety_per_setting():
    axes = Axes(CONTEXTS, ("All ages", "Age 65+"), ("All sexes", "Sex Female", "Sex Male"), ("All ethnicities",))
    assert axes.per_setting == 6
    assert axes.combo_index(Lens("Age 65+", "Sex Male")) == 5
    assert axes.combo_index(Lens("Age 65+", "Sex Male", setting=ED)) == 11
    assert axes.lens_for_index(11) == Lens("Age 65+", "Sex Male", "All ethnicities", ED)
    assert axes.settings_of([0, 7, 30]) == ["Clinical", ED, "Primary care"]
    assert axes.setting_combos([0, 7, 30], ED) == frozenset({7})


def test_migration_and_seed_import_give_the_same_axes(tiny_db, tmp_path):
    """A store imported before migration 0013 gets exactly what a new import holds."""
    store = copy_store(tiny_db, tmp_path / "old.sqlite")
    fresh = sqlite3.connect(store)
    expected = (
        fresh.execute("SELECT * FROM axis_values ORDER BY axis, position").fetchall(),
        fresh.execute("SELECT * FROM lens_combos ORDER BY combo_idx").fetchall(),
    )
    assert len(expected[1]) == 6 * 90
    # Undo 0013: the store as it was at schema version 12.
    fresh.execute("DELETE FROM lens_combos WHERE combo_idx >= 90")
    fresh.execute("DELETE FROM axis_values WHERE axis = 'context' AND position > 0")
    # Later migrations go too (0014 synonyms, contract v1.14 §31), so 0013 runs again with them.
    fresh.execute("DROP TABLE IF EXISTS concept_synonyms")
    fresh.execute("DELETE FROM schema_migrations WHERE version >= 13")
    fresh.commit()
    fresh.close()
    conn = db.connect(store)
    assert db.migrate(conn) == list(range(13, len(db.available_migrations()) + 1))
    assert (
        conn.execute("SELECT * FROM axis_values ORDER BY axis, position").fetchall(),
        conn.execute("SELECT * FROM lens_combos ORDER BY combo_idx").fetchall(),
    ) == expected
    conn.close()


def test_an_unknown_setting_is_invalid_lens(admin_client):
    for path, params in READS[:13]:
        response = get(admin_client, path, {**params, "context": "Ward"}, status=422)
        assert response.json()["code"] == "invalid_lens"
    response = get(admin_client, "/compare", {"cards": "Tiny-1|CDSS,Tiny-1|CDSS", "context": "Any setting"}, status=422)
    assert response.json()["code"] in ("invalid_lens", "invalid_cards")


# ------------------------------------------------- byte identity and semantics

def test_any_setting_reads_are_unchanged_by_the_parameter_and_by_setting_rows(admin_client):
    """G2: without the parameter, with context=Clinical, and after a card gains rows at a
    specific setting, every Any-setting read is byte for byte the same."""
    client = admin_client
    before = snapshot(client)
    assert snapshot(client, context="Clinical") == before
    publish(client, stage_metrics(client, [metric("1A00", 0.61), metric("1A00", 0.55, age="Age 65+")]))
    after = snapshot(client)
    changed = [key for key in before if before[key] != after[key]]
    # Only the catalogue tile moves: a publish of the card's metrics updates its tile (§17).
    assert changed == [("/catalogue", "{}")], changed
    assert snapshot(client, context="Clinical") == after


def test_a_setting_reads_only_its_own_rows(admin_client):
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61), metric("1A00", 0.55, age="Age 65+")]))
    row = get(client, "/metrics/concepts/1A00", {**TINY, "context": ED}).json()["metrics"]
    assert (row["perf"], row["context"], row["provenance"]["lens_fallback"]) == (0.61, ED, False)
    assert row["provenance"]["data_source"]["study"] == "SET-1"
    # The deeper category serves its anchor's row at the setting (§5).
    assert get(client, "/metrics/concepts/1A00.0", {**TINY, "context": ED}).json()["metrics"]["perf"] == 0.61
    # 1A01 has Any-setting rows but none at the setting: No data, never the Any-setting row.
    assert get(client, "/metrics/concepts/1A01", {**TINY, "context": ED}).json()["metrics"] is None
    assert get(client, "/metrics/concepts/1A01", TINY).json()["metrics"] is not None
    # Rollups: the block at the setting aggregates the one condition stored there (§6).
    block = get(client, "/metrics/concepts/BLK-01", {**TINY, "context": ED}).json()["metrics"]
    assert block["provenance"]["rollup"]["child_count"] == 1 and block["perf"] == 0.61
    # The map and the summary say the same.
    mapped = get(client, "/metrics/map", {**TINY, "scope": "atlas", "context": ED}).json()
    assert mapped["filters"]["context"] == ED
    columns = mapped["columns"]
    statuses = {row[0]: row[columns.index("overall_status")] for row in mapped["rows"]}
    assert statuses["1A01"] == "no_data" and statuses["1A00"] != "no_data"
    summary = get(client, "/metrics/summary", {**TINY, "context": ED}).json()
    assert summary["counts"]["no_data"] == 1


def test_a_setting_the_card_does_not_store_is_no_data_everywhere(admin_client):
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61)]))
    params = {**TINY, "context": ICU}
    assert get(client, "/metrics/concepts/1A00", params).json()["metrics"] is None
    summary = get(client, "/metrics/summary", params).json()
    assert summary["counts"]["no_data"] == 2 and summary["filters"]["context"] == ICU
    block = get(client, "/metrics/concepts/BLK-01", params).json()["metrics"]
    assert block["provenance"]["rollup"]["child_count"] == 0  # presented as No data (§6, §13)
    subgroups = get(client, "/metrics/concepts/1A00/subgroups", params).json()
    assert subgroups["filters"]["context"] == ICU
    assert not subgroups["all_patients"]["has_result"] and not any(group["has_result"] for group in subgroups["groups"])
    summary = get(client, "/metrics/subgroups/summary", params).json()
    assert summary["all_patients_with_result"] == 0
    candidates = get(client, "/multimorbidity/candidates", {**params, "scope": "atlas"}).json()
    assert candidates["candidate_ids"] == [] and candidates["display"]["rows"] == []
    combination = get(client, "/multimorbidity/combination", {**params, "selected": "1A00,1A01"}).json()
    assert combination["metrics"] is None and combination["combination_key"] == "1A00+1A01"


def test_the_fallback_stays_within_the_setting(admin_client):
    """§7 within a setting: a group the setting does not define is combined from its narrower
    groups at the same setting only, never from Any setting."""
    client = admin_client
    publish(client, stage_metrics(client, [
        metric("1A00", 0.60),
        metric("1A00", 0.70, age="Age 65+", sex="Sex Female", ethnicity="Ethnicity White"),
        metric("1A00", 0.50, age="Age 65+", sex="Sex Female", ethnicity="Ethnicity Black"),
    ]))
    params = {**TINY, "context": ED, "age": "Age 65+", "sex": "Sex Female"}
    row = get(client, "/metrics/concepts/1A00", params).json()["metrics"]
    assert row["provenance"]["lens_fallback"] is True
    assert row["perf"] == 0.6  # the mean of 0.70 and 0.50, not the Any-setting row
    assert row["context"] == ED and row["provenance"].get("data_source") is None
    # Any setting at the same group still reads its own stored row.
    assert get(client, "/metrics/concepts/1A00", {**params, "context": "Clinical"}).json()["metrics"]["provenance"]["lens_fallback"] is False
    # No narrower group stored at the setting for Age 18-39: No data.
    assert get(client, "/metrics/concepts/1A00", {**TINY, "context": ED, "age": "Age 18-39"}).json()["metrics"] is None
    # Across groups compares the groups with the setting's all-patients result.
    subgroups = get(client, "/metrics/concepts/1A00/subgroups", {**TINY, "context": ED}).json()
    assert subgroups["all_patients"]["perf"] == 0.6
    groups = {group["group"]: group for group in subgroups["groups"]}
    assert groups["Ethnicity White"]["perf"] == 0.7 and groups["Ethnicity White"]["provenance"]["lens_fallback"] is True
    assert not groups["Age 18-39"]["has_result"] and not groups["Sex Male"]["has_result"]


def test_grading_at_a_setting_equals_the_same_row_in_any_setting(admin_client, tiny_store, tmp_path):
    """No grading change (hard stop): a row stored at a setting grades exactly like the
    same row stored for Any setting on another copy of the store."""
    client = admin_client
    record = metric("1A01", 0.66, n_samples=420, n_sites=1, validation_type="Benchmark", peer_reviewed_studies=0)
    publish(client, stage_metrics(client, [record]))
    at_setting = get(client, "/metrics/concepts/1A01", {**TINY, "context": ED}).json()["metrics"]
    other = copy_store(tiny_store, tmp_path / "other.sqlite")
    with local_client(create_app(other, uploads_dir=tmp_path / "other-uploads", validate_responses=True)) as copy:
        publish(copy, stage_metrics(copy, [{**record, "setting": ""}]))
        any_setting = get(copy, "/metrics/concepts/1A01", TINY).json()["metrics"]
    for key in ("perf", "evidence_grade", "evidence_signal", "performance_grade", "overall", "status", "safeguards", "warnings"):
        assert at_setting[key] == any_setting[key], key


def test_local_results_at_a_setting(admin_client):
    """§26.1 within a setting: a local row at a setting replaces the public row of that
    setting, condition, and lens for the population; Any setting keeps its public rows."""
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61)]))
    publish(client, upload_and_wait(client, "population", b"ICD-11 code,Commonness\n1A00,Rare\n", **REGION))
    publish(client, stage_records(client, "studies", [{
        "study_id": "TW-ED-1", "title": "Tiny emergency evaluation (fictional)", "design": "Retrospective",
        "setting": "Tiny emergency department (fictional)", "sites": 1, "patients": 300, "peer_reviewed": False,
        "conducted_by": "Hospital", "reporting_guideline": "None", "risk_of_bias": "Low", "population": "Adults (synthetic)",
        "evaluation_conditions": "Synthetic local evaluation.", "publication_date": "2026-10-10", "scope": "Hospital",
        "population_id": "tiny-region", "setting_category": "Emergency department",
    }]))
    any_before = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
    publish(client, stage_records(
        client, "local_metrics", [metric("1A00", 0.52, study="TW-ED-1", validation_type="Clinical study (single site)", n_sites=1)],
        model_version="Tiny-1", use_case="CDSS", population_id="tiny-region",
    ))
    local = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region", "context": ED}).json()
    assert local["metrics"]["perf"] == 0.52 and local["metrics"]["provenance"]["layer"] == "local"
    assert local["public_metrics"]["perf"] == 0.61
    any_after = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
    any_before.pop("dataset_version"), any_after.pop("dataset_version")
    assert any_after == any_before
    mapped = get(client, "/metrics/map", {**TINY, "scope": "atlas", "population": "tiny-region", "context": ED}).json()
    assert mapped["layer"][[row[0] for row in mapped["rows"]].index("1A00")] == "local"


# ------------------------------------------------------------------ uploads

def test_template_has_the_optional_setting_column(admin_client):
    header, _, _ = read_csv(template(admin_client, "metrics"))
    assert header.index("Setting") == header.index("Ethnicity") + 1
    assert any("Setting is optional" in line for line in INSTRUCTIONS["metrics"])
    assert any("Setting is optional" in line for line in INSTRUCTIONS["local_metrics"])
    local_header, _, _ = read_csv(template(admin_client, "local_metrics"))
    assert "Setting" in local_header
    multimorbidity_header, _, _ = read_csv(template(admin_client, "multimorbidity"))
    assert "Setting" not in multimorbidity_header


def test_unknown_settings_are_refused_with_a_fix(admin_client):
    upload = stage_metrics(admin_client, [metric("1A00", 0.6, setting="Ward 7"), metric("1A01", 0.6, setting="emergency_department")])
    assert upload["status"] == "invalid"
    group = errors_by_code(upload)["unknown_setting"]
    assert group["count"] == 1 and "Emergency department" in group["fix"]


def test_filled_template_round_trips_with_settings(admin_client):
    """A filled template names each row's setting ("Any setting" for the rest) and uploads
    back with no changes."""
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61), metric("1A00", 0.55, setting="Primary care")]))
    filled = template(client, "metrics", filled="true", model_version="Tiny-1", use_case="CDSS")
    header, rows, _ = read_csv(filled)
    settings = [row[header.index("Setting")] for row in rows]
    assert settings.count(ED) == 1 and settings.count("Primary care") == 1 and settings.count("Any setting") == len(rows) - 2
    upload = upload_and_wait(client, "metrics", filled, **TINY_TARGET)
    assert upload["status"] == "valid", upload["report"]
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert (changes["added"], changes["changed"], changes["removed"]) == (0, 0, 0)
    assert "settings" not in changes


def test_replace_upload_needs_common_coverage_in_any_setting_only(admin_client):
    client = admin_client
    header, rows, _ = read_csv(template(client, "metrics", filled="true", model_version="Tiny-1", use_case="CDSS"))
    column = {name: index for index, name in enumerate(header)}
    extra = list(rows[0])
    extra[column["Setting"]] = ED
    extra[column["Age"]] = "Age 65+"
    upload = upload_and_wait(client, "metrics", write_csv(header, [*rows, extra]), **TINY_TARGET)
    assert upload["status"] == "valid", upload["report"]
    assert "incomplete_lens_coverage" not in errors_by_code(upload)


def test_change_summary_counts_and_names_each_setting(admin_client):
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61)]))
    upload = stage_metrics(client, [
        metric("1A00", 0.63, source_date="2026-10-21"),
        metric("1A01", 0.58, setting="Primary care"),
        metric("1A01", 0.70, setting=None),
    ])
    assert "new_lens_group" in notes_by_code(upload)
    rows = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()["rows"]
    assert rows["settings"] == [
        {"setting": ED, "added": 0, "changed": 1, "removed": 0},
        {"setting": "Primary care", "added": 1, "changed": 0, "removed": 0},
    ]
    samples = rows["samples"]
    assert {sample.get("setting") for sample in samples["added"]} == {"Primary care"}
    assert [sample.get("setting") for sample in samples["changed"]].count(ED) == 1
    assert any("setting" not in sample for sample in samples["changed"])  # the Any-setting row


# ---------------------------------------------------- exports, lookup, links

def test_exports_name_the_setting(admin_client):
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61)]))
    exported = get(client, "/export/concepts/1A00", {**TINY, "context": ED}).json()
    assert exported["context"]["setting"] == ED and exported["model_card"]["context"] == ED
    assert "setting" not in get(client, "/export/concepts/1A00", TINY).json()["context"]
    dataset = json.loads(get(client, "/export/dataset", TINY).content)
    assert dataset["metric_axes"]["context"] == ["Clinical", ED]
    assert dataset["metrics_by_key"][f"1A00|CDSS|{ED}|All ages | All sexes | All ethnicities|Tiny-1"]["perf"] == 0.61


def test_lookup_takes_a_setting(admin_client):
    client = admin_client
    publish(client, stage_metrics(client, [metric("1A00", 0.61)]))
    body = {"context": {"card": {"model_version": "Tiny-1", "use_case": "CDSS"}, "conditions": [{"code": "1A00"}, {"code": "1A01"}]}}
    plain = client.post(f"{API_PREFIX}/lookup", json=body).json()
    assert plain["lens"]["context"] == "Clinical" and "setting=" not in plain["card"]["card_url"]
    at_ed = client.post(f"{API_PREFIX}/lookup", json={"context": {**body["context"], "setting": "emergency_department"}}).json()
    assert at_ed["lens"]["context"] == ED
    first, second = at_ed["conditions"]
    assert first["provenance"]["data_source"]["study"] == "SET-1" and second["statuses"]["overall"] == "no_data"
    assert "setting=emergency_department" in first["card_url"] and "setting=emergency_department" in at_ed["card"]["card_url"]
    assert client.post(f"{API_PREFIX}/lookup", json={"context": {**body["context"], "setting": None}}).json()["lens"]["context"] == "Clinical"
    refused = client.post(f"{API_PREFIX}/lookup", json={"context": {**body["context"], "setting": "Emergency department"}})
    assert refused.status_code == 422 and refused.json()["code"] == "invalid_lens"
    assert "Emergency department" not in refused.json().get("detail", "")

