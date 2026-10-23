"""The dashboard demo pack: every pack file publishes through the
normal workflow, the products appear in /models with their fields, and the
publishes appear in the history. Builds into a copy of the session's seed
import (``--no-import``), so it costs about a second."""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest
from conftest import copy_store, local_client

from app import db
from app.demo.__main__ import main as demo_main
from app.demo.builder import (
    PACK_DIR,
    DemoBuildError,
    EvaluationStep,
    GeneratedStep,
    PackFile,
    _refuse_open_store,
    build,
    default_uploads_dir,
    load_manifest,
    running_backends,
)
from app.main import API_PREFIX, create_app

# Real vendors or model families must never appear in the pack (fictional names only).
FORBIDDEN_NAMES = re.compile(
    r"\b(openai|chatgpt|gpt-4|anthropic|claude|gemini|google|microsoft|nuance|epic|cerner|oracle|philips|siemens|"
    r"ge healthcare|ibm|watson|llama|meta|mistral|deepmind|med-palm|aidoc|babylon|ada health)\b",
    re.IGNORECASE,
)


@pytest.fixture(scope="module")
def demo_store(demo_db) -> tuple[Path, object]:
    return demo_db  # conftest.py: the pack built into a copy of the seed import


@pytest.fixture(scope="module")
def demo_client(demo_store):
    store, _ = demo_store
    with local_client(create_app(store, validate_responses=True, uploads_dir=default_uploads_dir(store))) as client:
        yield client


def test_every_pack_file_publishes_in_a_working_order(demo_store):
    store, report = demo_store
    manifest = load_manifest()
    assert manifest.version == 13
    notes = [entry["note"] for entry in report.published]
    published = [re.match(r"Demo pack v13, (\S+):", note).group(1) for note in notes if "generated evidence" not in note and "evaluations/" not in note]
    files = [pack_file.path for pack_file in manifest.files if isinstance(pack_file, PackFile)]
    assert sorted(published) == sorted(files)
    assert sum("Demo pack v13, generated evidence for " in note for note in notes) == 10
    # Pack v12 (contract v1.14, §32.2): one evaluation results import, published as its study, then its metrics merge.
    (evaluation,) = [step for step in manifest.files if isinstance(step, EvaluationStep)]
    assert [note.split(": ")[0] for note in notes if "evaluations/" in note] == [
        f"Demo pack v13, {evaluation.file} (study)", f"Demo pack v13, {evaluation.file} (metrics)",
    ]
    # The v1 registry names configurations without metrics yet, so it waits until the v4 registry needs it published.
    assert [entry["kind"] for entry in report.published] == [
        "metrics", "metrics", "metrics", "safety", "metrics", "population", "models", "models", *["metrics"] * 10, "studies", *["metrics"] * 3,
        "studies", "effects", "studies", "local_metrics", "safety",
        # Packs v8 to v11 (contract v1.14): Vantrel Triage 2.0's metrics, the study fields, the setting
        # studies and four setting-specific merges, pack v11's incident history, then the v8 registry,
        # which waits for the metrics it names and is published before the evaluation import.
        "metrics", "studies", "studies", *["metrics"] * 4, "safety", "models",
        # Pack v12: the evaluation import publishes its study and then its merge.
        "studies", "metrics",
        # Pack v13: its registry waits for the two new products' metrics in turn: their
        # studies, the two metrics files, an incident, then the registry, before the submissions.
        "studies", "metrics", "metrics", "safety", "models",
    ]
    assert [entry["version_id"] for entry in report.published] == list(range(2, 45))
    # Since contract v1.7 the note is stored on the version; the summary describes the change.
    assert not any("Demo pack" in entry["summary"] for entry in report.published)
    assert [pack_file.mode for pack_file in manifest.files if isinstance(pack_file, PackFile)].count("merge") == 16  # pack v10 adds 5, v11 one, v13 two
    (generated,) = [step for step in manifest.files if isinstance(step, GeneratedStep)]
    assert generated.source.source == "Demo revision (synthetic)" and generated.source.date == "2026-10-13"
    assert report.uploads_dir == store.with_name("dashboard-demo-uploads")


def test_products_and_entry_fields_are_served(demo_client):
    registry = demo_client.get(f"{API_PREFIX}/models").json()
    by_version = {model["model_version"]: model for model in registry["models"]}
    assert registry["default_model_version"] == "SynGPT-2.0"
    products = [model for model in registry["models"] if model["kind"] == "product"]
    # Decision of 2026-10-21: the task-specific radAIology-1, SkinAI-1.0, and DoAIHaveCancer-1.0
    # are products too (pack v4), so 4 models and 6 products; pack v8 adds Vantrel Triage 2.0, built on SynGPT-1.0,
    # and pack v13 Parlowe Answers 1.0 and Tallyfern Coding 1.4.
    assert len(products) == 9 and len(by_version) == 13
    assert sorted(model["model_version"] for model in registry["models"] if model["kind"] == "model") == [
        "ICU_GPT-1.0", "MediCore-2.5", "SynGPT-1.0", "SynGPT-2.0"
    ]
    assert {product["model_version"]: product["built_on"] for product in products if product["built_on"]} == {
        "Quillary-Scribe-1.0": ["MediCore-2.5"], "Vantrel-Triage-2.1": ["SynGPT-2.0"], "Vantrel-Triage-2.0": ["SynGPT-1.0"],
        "Parlowe-Answers-1.0": ["SynGPT-2.0"], "Tallyfern-Coding-1.4": ["MediCore-2.5"],
    }
    for product in products:
        assert all(by_version[base]["kind"] == "model" for base in product["built_on"])
        assert "product" in product["description"] and "model that" not in product["description"]
        assert product["developer"].endswith("(fictional)") and product["release_date"] and product["ai_type"]
        (configuration,) = product["use_cases"]
        assert configuration["function_category"] and configuration["declarations"]["declared_regulatory_status"]
    for model in registry["models"]:
        assert model["developer"] and model["description"] and len(model["description"]) <= 280
        for configuration in model["use_cases"]:
            declarations = configuration["declarations"]
            assert declarations["declared_documentation_url"].startswith("https://")
            assert ".example/" in declarations["declared_documentation_url"]
            assert not re.search(r"certified|approved", json.dumps(declarations), re.IGNORECASE)
    # The seed models keep their names, statuses, and defaults.
    assert by_version["ICU_GPT-1.0"]["status"] == "EXPERIMENTAL"
    assert by_version["MediCore-2.5"]["default_use_case"] == "Discharge letter generation"


def test_product_metrics_define_the_all_population_lens_only(demo_client):
    """A product has data for the whole population; a specific group has none (CONTRACT.md §7:
    only "All …" axes expand, so an all-population file has no rows for "Age 65+")."""
    params = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}
    overall = demo_client.get(f"{API_PREFIX}/metrics/concepts/1A00", params=params).json()["metrics"]
    assert overall["perf"] is not None and overall["provenance"]["lens_fallback"] is False
    summary = demo_client.get(f"{API_PREFIX}/metrics/summary", params=params).json()
    assert summary["counts"]["no_data"] < 2400
    specific = demo_client.get(f"{API_PREFIX}/metrics/concepts/1A00", params={**params, "age": "Age 65+"}).json()
    assert specific["metrics"] is None


def _map(client, **params) -> list[dict]:
    body = client.get(f"{API_PREFIX}/metrics/map", params=params).json()
    return [dict(zip(body["columns"], row, strict=True)) for row in body["rows"]]


def test_a_rollup_without_children_is_marked_in_the_map(demo_client):
    """CONTRACT.md §6, §10, §13 (v1.10): a product read at a specific group has no condition rows, so
    every block is a rollup without children. It is served as before (out of scope, out_of_scope_group,
    scope-stop) and the map's child_count column (0) lets clients present it as No data."""
    product = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}
    older = _map(demo_client, **product, scope="atlas", age="Age 65+")
    blocks = [row for row in older if row["child_count"] is not None]
    conditions = [row for row in older if row["child_count"] is None]
    assert len(blocks) == 225 and len(conditions) == 2400
    assert all(row["child_count"] == 0 and row["overall_status"] == "out_of_scope" for row in blocks)
    assert all(row["overall_status"] == "no_data" for row in conditions)
    chapter = _map(demo_client, **product, scope="chapter", chapter_id="CH-01", age="Age 65+")
    assert {row["child_count"] for row in chapter} == {0, None}

    # Served as before: the concept read keeps the out-of-scope rollup and reports no children.
    read = demo_client.get(f"{API_PREFIX}/metrics/concepts/{blocks[0]['concept_id']}", params={**product, "age": "Age 65+"}).json()
    metrics = read["metrics"]
    assert metrics["provenance"]["rollup"]["child_count"] == 0 and metrics["perf"] is None
    assert metrics["status"]["overall"] == "out_of_scope" and metrics["intended_use_level"] == "out_of_scope"
    assert [warning["code"] for warning in metrics["warnings"]] == ["out_of_scope_group"]
    assert {"id": "scope-stop", "priority": "Critical"} in metrics["safeguards"]
    chapter_read = demo_client.get(f"{API_PREFIX}/metrics/concepts/CH-01", params={**product, "age": "Age 65+"}).json()
    assert chapter_read["metrics"]["provenance"]["rollup"]["child_count"] == 0
    # The summary counts conditions, never rollups.
    summary = demo_client.get(f"{API_PREFIX}/metrics/summary", params={**product, "age": "Age 65+"}).json()
    assert summary["total"] == 2400 and summary["counts"]["no_data"] == 2400

    # For the whole population every block has children.
    everyone = _map(demo_client, **product, scope="atlas")
    assert all(row["child_count"] > 0 for row in everyone if row["child_count"] is not None)
    assert sum(row["child_count"] is not None for row in everyone) == 225

    # A block whose conditions are genuinely out of scope keeps its children: Out of scope, not No data.
    narrow = _map(demo_client, model="ICU_GPT-1.0", use_case="CDSS", scope="atlas")
    out_of_scope = [row for row in narrow if row["child_count"] is not None and row["overall_status"] == "out_of_scope"]
    assert out_of_scope and all(row["child_count"] > 0 for row in out_of_scope)


def test_the_publishes_appear_in_the_history(demo_client):
    versions = demo_client.get(f"{API_PREFIX}/admin/versions").json()
    assert [entry["version_id"] for entry in versions] == list(range(44, 0, -1))
    assert all(entry["note"].startswith("Demo pack v13, ") for entry in versions[:-1])
    assert versions[-1]["note"] is None
    by_id = {entry["version_id"]: entry for entry in versions}
    assert by_id[8]["kind"] == "models" and "3 AI systems added" in by_id[8]["summary"]
    assert by_id[7]["kind"] == "population" and by_id[7]["summary"].startswith(
        "Local population Northbridge region (fictional) (northbridge-region): 310 rows added"
    )
    assert by_id[5]["kind"] == "safety" and by_id[5]["summary"] == "Safety incidents: 16 incidents added."
    assert by_id[9]["note"].startswith("Demo pack v13, v4/registry.csv: Demo revision")
    assert all(by_id[version]["note"].startswith("Demo pack v13, generated evidence for ") for version in range(10, 20))
    assert by_id[29]["kind"] == "metrics" and by_id[30]["kind"] == "studies" and by_id[37]["kind"] == "models"
    assert by_id[37]["summary"] == "AI systems & functions: 1 row added, 13 rows changed, 1 AI system added."
    # Pack v11 (contract v1.14, §30): SynGPT-2.0 decision support's incident history.
    assert by_id[36]["kind"] == "safety" and by_id[36]["summary"] == "Safety incidents: 4 incidents added."
    # Pack v10 (contract v1.14, §29): two setting studies, then four setting-specific merges.
    assert by_id[31]["kind"] == "studies" and by_id[31]["summary"] == "Studies: 2 studies added."
    assert [by_id[version]["summary"].split(": ")[1] for version in range(32, 36)] == [
        "600 rows added.", "240 rows added.", "600 rows added.", "800 rows added.",
    ]
    # Pack v12 (contract v1.14, §32.2): the benchmark study, then the 36 results that name it.
    assert by_id[38]["kind"] == "studies" and by_id[38]["summary"].startswith("Studies: 1 study added")
    assert by_id[39]["kind"] == "metrics" and by_id[39]["summary"].startswith("Performance metrics for MediCore-2.5 / Clinician Facing CDSS: ")
    # Pack v13: the two function-category products, their studies, and an incident.
    assert [by_id[version]["kind"] for version in range(40, 45)] == ["studies", "metrics", "metrics", "safety", "models"]
    assert by_id[40]["summary"] == "Studies: 2 studies added."
    assert by_id[43]["summary"] == "Safety incidents: 1 incident added."
    assert by_id[44]["summary"] == "AI systems & functions: 2 rows added, 2 AI systems added."


def test_the_safety_incidents_are_served(demo_client):
    """Pack v2's incidents: severity, the lens rule, a chapter incident, and the map's safety column."""
    params = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
    older = demo_client.get(f"{API_PREFIX}/metrics/concepts/BA00", params={**params, "age": "Age 65+"}).json()
    assert [(incident["incident_id"], incident["severity"]) for incident in older["incidents"]] == [("SI-2026-001", "serious")]
    younger = demo_client.get(f"{API_PREFIX}/metrics/concepts/BA00", params={**params, "age": "Age 18-39"}).json()
    assert younger["incidents"] == [], "an incident for Age 65+ does not apply to another age group"
    chapter = demo_client.get(f"{API_PREFIX}/metrics/concepts/CH-06", params=params).json()
    assert [incident["incident_id"] for incident in chapter["incidents"]] == ["SI-2026-003"]
    rows = demo_client.get(f"{API_PREFIX}/metrics/map", params={**params, "scope": "atlas"}).json()
    safety_column = rows["columns"].index("safety")
    marks = {row[0]: row[safety_column] for row in rows["rows"]}
    assert marks["BA00"] == "serious" and marks["6A70"] == "caution" and marks["1A00"] is None
    assert set(marks.values()) <= {"serious", "caution", None}


def test_the_one_study_merge_changed_only_its_rows(demo_client):
    params = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
    merged = demo_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params=params).json()["metrics"]
    assert merged["perf"] == 0.792
    assert merged["provenance"]["data_source"] == {
        "source": "Northbridge multisite validation (fictional)", "study": "NBR-2026-01", "date": "2026-09-15",
    }
    kept = demo_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params={**params, "sex": "Sex Female"}).json()["metrics"]
    # Not in the study: the seed's row, or (pack v4) the demo revision's when it had no evidence.
    assert kept["provenance"]["data_source"]["source"] in ("Seed (synthetic, version 1)", "Demo revision (synthetic)")
    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{API_PREFIX}/admin/versions").json()}
    assert versions[6]["summary"].startswith("Performance metrics for SynGPT-2.0 / Clinician Facing CDSS: 5 rows changed")


def test_the_studies_link_rows_and_change_grades(demo_client):
    """Pack v5 (contract v1.13): seven study records covering every design, conductor, guideline
    answer, and risk-of-bias level; linked rows carry the appraisal, and the change summaries name grade shifts."""
    studies = [study for study in demo_client.get(f"{API_PREFIX}/studies").json()["studies"] if study["scope"] == "public"]
    assert len(studies) == 14  # pack v5, the two effect studies of pack v6, pack v10's two setting studies, pack v12's benchmark study, and pack v13's two; pack v7 adds a hospital study (§26), tested below
    assert {study["design"] for study in studies} == {
        "vignette", "simulation", "benchmark", "retrospective", "prospective", "real_world_deployment", "randomized_trial"
    }
    assert {study["conducted_by"] for study in studies} == {"developer", "independent", "hospital"}
    assert {study["risk_of_bias"] for study in studies} == {"low", "some_concerns", "high", "unclear"}
    assert {study["guideline_followed"] for study in studies} == {"yes", "partly", "no", None}
    assert {study["reporting_guideline"] for study in studies} == {"none", "tripod_ai", "stard_ai", "consort_ai", "decide_ai", "other"}
    assert all("fictional" in study["title"] and study["source_url"].startswith("https://studies.example/") for study in studies)

    # The one-study merge of pack v2 now links to its record (TRIPOD+AI followed, low risk: +0.05).
    northbridge = demo_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params={"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}).json()
    appraisal = northbridge["metrics"]["appraisal"]
    assert appraisal["study"]["study_id"] == "NBR-2026-01" and appraisal["study_adjustment"] == 0.05
    icu = demo_client.get(f"{API_PREFIX}/metrics/concepts/1G40", params={"model": "ICU_GPT-1.0", "use_case": "CDSS"}).json()["metrics"]
    assert icu["appraisal"]["study"]["study_id"] == "ICU-RETRO-2025" and icu["appraisal"]["terms"]["risk_of_bias_adjustment"] == -0.1
    radiology = demo_client.get(f"{API_PREFIX}/metrics/concepts/CA40", params={"model": "radAIology-1", "use_case": "Radiology image analysis"}).json()["metrics"]
    assert radiology["appraisal"]["terms"]["guideline_adjustment"] == 0.05
    assert [study["study_id"] for study in demo_client.get(f"{API_PREFIX}/studies", params={"model": "SkinAI-1.0"}).json()["studies"]] == ["DERM-VIG-2025"]

    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{API_PREFIX}/admin/versions").json()}
    assert versions[20]["kind"] == "studies" and versions[20]["summary"].startswith("Studies: 7 studies added")
    assert all(versions[version]["kind"] == "metrics" for version in (21, 22, 23))
    assert any("status changes" in versions[version]["summary"] for version in (21, 22, 23))


def test_linked_rows_count_what_their_study_says(demo_client):
    """A row linked to one study says so: 1 study, peer reviewed as the study is, the study's sites,
    and never more samples than the study's patients (pack v2 and v5 links)."""
    studies = {study["study_id"]: study for study in demo_client.get(f"{API_PREFIX}/studies").json()["studies"]}
    files = {
        "v2/metrics/syngpt-2-0.clinician-facing-cdss.northbridge-study.csv": ("SynGPT-2.0", "Clinician Facing CDSS"),
        "v5/metrics/icu-gpt-1-0.cdss.study-links.csv": ("ICU_GPT-1.0", "CDSS"),
        "v5/metrics/radaiology-1.radiology-image-analysis.study-links.csv": ("radAIology-1", "Radiology image analysis"),
        "v5/metrics/skinai-1-0.skin-lesion-cdss.study-links.csv": ("SkinAI-1.0", "Skin lesion CDSS"),
    }
    for name, (model, use_case) in files.items():
        with open(PACK_DIR / name, newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(line for line in handle if not line.lstrip("\"").startswith("#")))
        for row in rows:
            study = studies[row["Study"]]
            assert (row["Studies"], row["Peer-reviewed studies"], int(row["Sites"])) == ("1", "1" if study["peer_reviewed"] else "0", study["sites"]), (name, row["ICD-11 code"])
            assert int(row["Samples"]) <= study["patients"], (name, row["ICD-11 code"])
        first = rows[0]
        served = demo_client.get(
            f"{API_PREFIX}/metrics/concepts/{first['ICD-11 code']}",
            params={"model": model, "use_case": use_case, "age": first["Age"], "sex": first["Sex"], "ethnicity": first["Ethnicity"]},
        ).json()["metrics"]
        assert (served["n_studies"], served["n_sites"], served["n_samples"]) == (1, int(first["Sites"]), int(first["Samples"]))
    # The Northbridge study's 6,595 patients are the all-patients samples of its three conditions.
    northbridge = list(csv.DictReader(line for line in open(PACK_DIR / next(iter(files)), encoding="utf-8") if not line.lstrip("\"").startswith("#")))
    assert sum(int(row["Samples"]) for row in northbridge if row["Age"] == "All ages") == studies["NBR-2026-01"]["patients"]


def test_skinai_vignette_study_lowers_its_grades_moderately(demo_client):
    """Decision of 2026-10-21: DERM-VIG-2025 keeps its design (vignette), guideline answer (other,
    not followed), and risk of bias (some concerns), with 4,800 cases from 4 clinics and peer review, so
    SkinAI-1.0's linked rows drop to C or D (a handful of rare-condition rows to E), not all to E."""
    study = demo_client.get(f"{API_PREFIX}/studies/DERM-VIG-2025").json()["study"]
    assert (study["design"], study["reporting_guideline"], study["guideline_followed"], study["risk_of_bias"]) == ("vignette", "other", "no", "some_concerns")
    assert (study["patients"], study["sites"], study["peer_reviewed"]) == (4800, 4, True)
    with open(PACK_DIR / "v5/metrics/skinai-1-0.skin-lesion-cdss.study-links.csv", newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(line for line in handle if not line.lstrip("\"").startswith("#")))
    grades = Counter()
    for row in rows:
        params = {"model": "SkinAI-1.0", "use_case": "Skin lesion CDSS", "age": row["Age"], "sex": row["Sex"], "ethnicity": row["Ethnicity"]}
        metrics = demo_client.get(f"{API_PREFIX}/metrics/concepts/{row['ICD-11 code']}", params=params).json()["metrics"]
        assert metrics["appraisal"]["study"]["study_id"] == "DERM-VIG-2025"
        grades[metrics["evidence_grade"]] += 1
    assert len(rows) == 450 and set(grades) <= {"C", "D", "E"} and grades["E"] <= 5, grades


def test_the_pack_uses_fictional_names_only():
    for path in sorted(PACK_DIR.rglob("*")):
        if path.suffix in (".csv", ".json", ".md"):
            text = path.read_text(encoding="utf-8")
            if path.suffix == ".csv":
                # The ICD-11 condition names and warning codes come from the atlas; check the registry columns only.
                if "metrics" in path.parts:
                    continue
                rows = list(csv.reader(line for line in text.splitlines() if not line.startswith("#")))
                text = "\n".join(",".join(row) for row in rows)
            found = FORBIDDEN_NAMES.findall(text)
            assert not found, f"{path.relative_to(PACK_DIR)} names {sorted(set(found))}"


def test_the_live_store_and_its_uploads_are_refused(tmp_path):
    with pytest.raises(DemoBuildError, match="live store"):
        build(db.DEFAULT_DB_PATH, import_seed=False)
    with pytest.raises(DemoBuildError, match="separate folder"):
        build(tmp_path / "demo.sqlite", uploads_dir=db.DEFAULT_DB_PATH.parent / "uploads", import_seed=False)


def _pack(tmp_path: Path, files: list[dict], contents: dict[str, str]) -> Path:
    pack = tmp_path / "pack"
    pack.mkdir()
    for name, text in contents.items():
        (pack / name).write_text(text, encoding="utf-8")
    (pack / "manifest.json").write_text(json.dumps({"version": 1, "files": files}), encoding="utf-8")
    return pack


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        ({"file": "a.csv", "kind": "prevalence", "mode": "upsert", "note": "x"}, "mode must be"),
        ({"file": "a.csv", "kind": "models", "mode": "merge", "note": "x"}, "merge works for"),
        ({"file": "a.csv", "kind": "prevalence", "note": "x" * 500}, "too long"),
        ({"file": "a.csv", "kind": "prevalence", "note": " "}, "change note"),
        ({"file": "a.csv", "kind": "metrics", "note": "x"}, "needs a target"),
        ({"file": "../a.csv", "kind": "prevalence", "note": "x"}, "inside the pack"),
        ({"file": "missing.csv", "kind": "prevalence", "note": "x"}, "does not exist"),
    ],
)
def test_a_broken_manifest_fails_loudly(tmp_path, entry, message):
    with pytest.raises(DemoBuildError, match=message):
        load_manifest(_pack(tmp_path, [entry], {"a.csv": "ICD-11 code,Commonness\n1A00,Rare\n"}))


def test_an_invalid_pack_file_stops_the_build(tiny_store: Path, tmp_path):
    pack = _pack(
        tmp_path,
        [{"file": "a.csv", "kind": "prevalence", "note": "Broken on purpose."}],
        {"a.csv": "ICD-11 code,Commonness\n1A00,Frequent\n"},
    )
    with pytest.raises(DemoBuildError, match="unknown_tier"):
        build(tiny_store, pack_dir=pack, import_seed=False)
    conn = db.connect(tiny_store, read_only=True)
    try:
        assert conn.execute("SELECT COUNT(*) FROM dataset_versions").fetchone() == (1,)
    finally:
        conn.close()


def test_without_an_import_the_store_must_be_a_fresh_seed_import(demo_store, tmp_path):
    store, _ = demo_store
    with pytest.raises(DemoBuildError, match="not a fresh seed import"):
        build(copy_store(store, tmp_path / "again.sqlite"), import_seed=False)


def test_the_uploads_folder_follows_bmc_uploads_dir(tiny_store: Path, tmp_path, monkeypatch):
    """A second store keeps its uploads apart (npm run demo sets BMC_UPLOADS_DIR); the default stays uploads/ next to the store."""
    assert create_app(tiny_store).state.api.admin.uploads_dir == tiny_store.parent / "uploads"
    monkeypatch.setenv("BMC_UPLOADS_DIR", str(tmp_path / "demo-uploads"))
    assert create_app(tiny_store).state.api.admin.uploads_dir == tmp_path / "demo-uploads"
    assert create_app(tiny_store, uploads_dir=tmp_path / "explicit").state.api.admin.uploads_dir == tmp_path / "explicit"


def test_the_builder_refuses_uploads_folders_that_hold_stores(tmp_path):
    from app.demo.builder import DemoBuildError, _guard

    store = tmp_path / "demo" / "store.sqlite"
    for unsafe in (tmp_path / "demo", tmp_path, store, db.DEFAULT_DB_PATH.parent, db.DEFAULT_DB_PATH.parent.parent):
        with pytest.raises(DemoBuildError):
            _guard(store, unsafe)
    _guard(store, tmp_path / "demo-uploads")


def test_the_builder_only_clears_its_own_uploads_folder(tmp_path):
    from app.demo.builder import UPLOADS_MARKER, DemoBuildError, _clear_uploads

    foreign = tmp_path / "foreign"
    foreign.mkdir()
    (foreign / "keep.txt").write_text("x")
    with pytest.raises(DemoBuildError):
        _clear_uploads(foreign)
    assert (foreign / "keep.txt").exists()
    ours = tmp_path / "ours"
    _clear_uploads(ours)
    (ours / "up-1").mkdir()
    _clear_uploads(ours)
    assert sorted(p.name for p in ours.iterdir()) == [UPLOADS_MARKER]


def _versions(store: Path) -> int:
    conn = db.connect(store, read_only=True)
    try:
        return conn.execute("SELECT COUNT(*) FROM dataset_versions").fetchone()[0]
    finally:
        conn.close()


def _marker(marker_dir: Path, store: Path, pid: int, port: int = 8227) -> Path:
    """A dev marker as scripts/backendServer.mjs writeDevMarker writes it."""
    marker_dir.mkdir(exist_ok=True)
    path = marker_dir / f"dev-api-{port}.json"
    path.write_text(json.dumps({"port": port, "pid": pid, "store": str(store), "started_at": "2026-10-13T08:00:00.000Z"}))
    return path


def _ended_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def test_the_builder_refuses_a_store_a_running_backend_has_open(tiny_store: Path, tmp_path):
    """npm run demo (or dev) records its backend in backend/data/dev-api-<port>.json; a live one on
    this store stops the build before anything changes."""
    markers = tmp_path / "markers"
    marker = _marker(markers, tiny_store, os.getpid())
    with pytest.raises(DemoBuildError, match=r"open in a running backend \(pid \d+, port 8227\)\. Stop `npm run demo`") as refused:
        build(tiny_store, import_seed=False, marker_dir=markers)
    assert str(marker) in str(refused.value), "names the marker, in case it is stale"
    assert _versions(tiny_store) == 1
    assert not default_uploads_dir(tiny_store).exists(), "the uploads folder is left alone too"

    # A marker of an ended process, or of a backend on another store, does not count.
    _marker(markers, tiny_store, _ended_pid())
    _marker(markers, tmp_path / "other.sqlite", os.getpid(), port=8228)
    (markers / "dev-api-8229.json").write_text("not json")
    assert running_backends(tiny_store, markers) == []
    _refuse_open_store(tiny_store, markers)


def test_the_builder_refuses_a_store_that_another_connection_holds(tiny_store: Path, tmp_path, capsys):
    """A backend started without a marker still holds its WAL store open; the exclusive lock fails."""
    holder = db.connect(tiny_store, check_same_thread=False)
    try:
        holder.execute("SELECT COUNT(*) FROM concepts").fetchone()
        with pytest.raises(DemoBuildError, match="open in another process"):
            build(tiny_store, import_seed=False, marker_dir=tmp_path)
        assert demo_main(["build", "--db", str(tiny_store), "--no-import", "--quiet"]) == 1
        assert "Stop `npm run demo`" in capsys.readouterr().err
    finally:
        holder.close()
    assert _versions(tiny_store) == 1
    _refuse_open_store(tiny_store, tmp_path)  # free again once the connection closes


def test_study_links_follow_the_study_designs(demo_client):
    """Pack v7 fix: a row linked to a study carries the validation type of the study's design."""
    for code, params, expected in (
        ("1G40", {"model": "ICU_GPT-1.0", "use_case": "CDSS"}, "clinical_study_single_site"),  # retrospective, 1 site
        ("CA40", {"model": "radAIology-1", "use_case": "Radiology image analysis"}, "clinical_study_multisite"),  # randomized, 6 sites
        ("2C30", {"model": "SkinAI-1.0", "use_case": "Skin lesion CDSS"}, "vignette_study"),
    ):
        for lens in ({}, {"ethnicity": "Ethnicity White"}):
            row = demo_client.get(f"{API_PREFIX}/metrics/concepts/{code}", params={**params, **lens}).json()["metrics"]
            assert row["validation_type"] == expected and row["appraisal"]["study"]["study_id"], (code, lens)


def test_pack_v9_study_fields_change_no_grade(demo_client):
    """Pack v9 (contract v1.14, §22): applicability, appraisal tools and scores, setting categories, and the
    configuration evaluated on every published study; a studies merge with no status change."""
    studies = {study["study_id"]: study for study in demo_client.get(f"{API_PREFIX}/studies").json()["studies"]}
    assert len(studies) == 15  # and pack v10's two setting studies, pack v12's benchmark study, and pack v13's two
    # Pack v12's benchmark study states no applicability (an imported run is not appraised yet).
    assert {study.get("applicability") for study in studies.values()} == {"low", "high", "unclear", None}
    assert {study.get("setting_category") for study in studies.values()} >= {
        "emergency_department", "intensive_care", "outpatient_clinic", "primary_care", "mixed",
    }
    assert (studies["VANTREL-RCT-2026"]["quality_tool"], studies["VANTREL-RCT-2026"]["quality_score"]) == ("appraise_ai", 72)
    assert studies["NBR-2026-01"]["quality_tool"] == "probast_ai" and "quality_score" not in studies["NBR-2026-01"]
    assert "configuration_id" not in studies["DERM-VIG-2025"]
    assert all(study["configuration_id"].startswith("cfg-") for study in studies.values() if "configuration_id" in study)
    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{API_PREFIX}/admin/versions").json()}
    assert versions[30]["kind"] == "studies" and versions[30]["summary"] == "Studies: 10 studies changed."
    appraisal = demo_client.get(f"{API_PREFIX}/metrics/concepts/1G40", params={"model": "ICU_GPT-1.0", "use_case": "CDSS"}).json()["metrics"]["appraisal"]
    assert appraisal["study"]["applicability"] == "high" and appraisal["terms"]["risk_of_bias_adjustment"] == -0.1


def test_pack_v7_local_results_and_waiting_submissions(demo_client):
    """Pack v7 (contract v1.13, §26): a hospital study of Northbridge, local results of ICU_GPT-1.0 that
    change marks for that population only, a hospital incident, and two submissions in the queue."""
    icu = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
    population = {"population": "northbridge-region"}
    study = demo_client.get(f"{API_PREFIX}/studies/NBR-ICU-LOCAL-2026").json()["study"]
    assert (study["scope"], study["population_id"], study["conducted_by"]) == ("hospital", "northbridge-region", "hospital")
    local = demo_client.get(f"{API_PREFIX}/metrics/concepts/1C45", params={**icu, **population}).json()
    assert local["metrics"]["provenance"]["layer"] == "local" and local["metrics"]["perf"] == 0.63
    assert local["public_metrics"]["perf"] == 0.88 and local["metrics"]["status"]["overall"] != local["public_metrics"]["status"]["overall"]
    assert local["metrics"]["provenance"]["data_source"]["study"] == "NBR-ICU-LOCAL-2026"
    public = demo_client.get(f"{API_PREFIX}/metrics/concepts/1C45", params=icu).json()
    assert public["metrics"]["perf"] == 0.88 and "public_metrics" not in public
    mapped = demo_client.get(f"{API_PREFIX}/metrics/map", params={**icu, **population, "scope": "atlas"}).json()
    assert mapped["layer"].count("includes_local") >= 5 and "layer" not in demo_client.get(f"{API_PREFIX}/metrics/map", params={**icu, "scope": "atlas"}).json()
    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{API_PREFIX}/admin/versions").json()}
    assert (versions[27]["kind"], versions[27]["publisher_role"], versions[27]["publisher_name"]) == ("local_metrics", "hospital", "Demo pack")
    assert "overall status changes for readers of the local population" in versions[27]["summary"]
    incidents = demo_client.get(f"{API_PREFIX}/admin/safety/incidents", params={"model": "ICU_GPT-1.0"}).json()["incidents"]
    assert [(entry["incident_id"], entry["scope"]) for entry in incidents if entry["scope"] == "hospital"] == [("NBR-SI-2026-001", "hospital")]
    queue = demo_client.get(f"{API_PREFIX}/admin/submissions", params={"status": "submitted"}).json()
    assert sorted(entry["model_version"] for entry in queue) == ["Corvessa-Skin-Review-1.2", "Tidewell-Sepsis-1.0"]
    tidewell = next(entry for entry in queue if entry["model_version"] == "Tidewell-Sepsis-1.0")
    assert sorted(upload["kind"] for upload in tidewell["uploads"]) == ["metrics", "model_cards", "models", "studies"]
    assert all(upload["status"] == "valid" for entry in queue for upload in entry["uploads"])
    assert demo_client.get(f"{API_PREFIX}/meta").json()["instance"]["kind"] == "public"
    assert "Tidewell-Sepsis-1.0" not in [model["model_version"] for model in demo_client.get(f"{API_PREFIX}/models").json()["models"]]


def test_local_results_feed_the_comparison(demo_client):
    """R4's getComparison reads the overlaid rows for the population (§25, §26): ICU_GPT-1.0's local
    result for toxic shock syndrome (1C45) replaces its public one only for Northbridge readers."""
    params = {"cards": "ICU_GPT-1.0|CDSS,radAIology-1|Radiology image analysis", "scope": "chapter", "chapter_id": "CH-01"}

    def icu_cell(extra):
        body = demo_client.get(f"{API_PREFIX}/compare", params={**params, **extra}).json()
        row = next(row for row in body["rows"] if row["concept_id"] == "1C45")
        return row["cells"][0]

    assert icu_cell({"population": "northbridge-region"})["perf"] == 0.63
    assert icu_cell({})["perf"] == 0.88


def test_the_corvessa_submission_changes_rows_once_accepted(demo_store, tmp_path):
    """The waiting Corvessa merge (source date 2026-10-17) must be newer than the stored product rows on
    every build day: the pack v1 product rows carry a fixed source date (2026-09-01), never the build date."""
    store, _ = demo_store
    copy = copy_store(store, tmp_path / "demo.sqlite")
    uploads = tmp_path / "uploads"
    shutil.copytree(default_uploads_dir(store), uploads)
    card = {"model": "Corvessa-Skin-Review-1.2", "use_case": "Skin lesion CDSS"}
    with local_client(create_app(copy, validate_responses=True, uploads_dir=uploads)) as client:
        before = client.get(f"{API_PREFIX}/metrics/concepts/2C30", params=card).json()["metrics"]
        assert before["provenance"]["data_source"] == {
            "source": "Demo pack product metrics (synthetic, derived from SkinAI-1.0)", "study": "DEMO-PRODUCT-2026-09", "date": "2026-09-01",
        }
        queue = client.get(f"{API_PREFIX}/admin/submissions", params={"status": "submitted"}).json()
        corvessa = next(entry for entry in queue if entry["model_version"] == "Corvessa-Skin-Review-1.2")
        merge = next(upload for upload in corvessa["uploads"] if upload["kind"] == "metrics")
        assert "newer_study_kept" not in {note["code"] for note in merge["report"]["notes"]}
        changes = client.get(f"{API_PREFIX}/admin/uploads/{merge['upload_id']}/changes").json()
        assert changes["rows"]["changed"] == 4, changes["rows"]
        accepted = client.post(f"{API_PREFIX}/admin/submissions/{corvessa['submission_id']}/accept", json={"note": "Reviewed.", "publisher_name": "Demo custodian"})
        assert accepted.status_code == 200, accepted.text
        after = client.get(f"{API_PREFIX}/metrics/concepts/2C30", params=card).json()["metrics"]
        assert after["perf"] == 0.918 and after["perf"] != before["perf"]
        assert after["provenance"]["data_source"]["study"] == "CORV-PROSP-2026"


def test_pack_v8_configurations_lineage_and_declarations(demo_client):
    """Pack v8 (contract v1.14, §28): a configuration record on 13 of 14 cards (DoAIHaveCancer-1.0 keeps
    none), a performance measure and reference standard on every card, data-protection declarations on 5,
    and lineage (SynGPT-2.0 replaces SynGPT-1.0; the new Vantrel Triage 2.0 is replaced by 2.1). Grades
    are untouched: a registry publish has no status shifts, and Vantrel Triage 2.0's rows all carry evidence."""
    registry = demo_client.get(f"{API_PREFIX}/models").json()["models"]
    by_version = {entry["model_version"]: entry for entry in registry}
    # Pack v13 adds two products with their own declarations (tests/test_demo_functions.py); these are pack v8's.
    v13 = {"Parlowe-Answers-1.0", "Tallyfern-Coding-1.4"}
    assert v13 <= set(by_version)
    cards = [(entry, card) for entry in registry for card in entry["use_cases"] if entry["model_version"] not in v13]
    assert len(cards) == 14
    without = [entry["model_version"] for entry, card in cards if "configuration" not in card]
    assert without == ["DoAIHaveCancer-1.0"]
    assert all(card.get("performance_measure") and card.get("reference_standard") for _, card in cards)
    protected = sorted(f"{entry['model_version']}|{card['use_case']}" for entry, card in cards if (card["declarations"] or {}).get("declared_data_use"))
    assert protected == [
        "Corvessa-Skin-Review-1.2|Skin lesion CDSS", "Quillary-Scribe-1.0|Discharge letter generation",
        "SynGPT-2.0|Clinician Facing CDSS", "Vantrel-Triage-2.1|Emergency department triage", "radAIology-1|Radiology image analysis",
    ]
    for entry, card in cards:
        assert ".example" in (card["declarations"].get("declared_privacy_contact") or ".example"), entry["model_version"]
        record = card.get("configuration")
        if record and record["prompt_summary"]:
            assert entry["ai_type"] in ("llm", "hybrid") and re.fullmatch(r"[0-9a-f]{64}", record["prompt_sha256"])
            assert "fictional" in record["prompt_summary"]
        if record and entry["ai_type"] == "imaging":
            assert record["fine_tuning"] and record["prompt_summary"] is None
    assert by_version["SynGPT-2.0"]["replaces"] == "SynGPT-1.0" and by_version["SynGPT-1.0"]["replaced_by"] == ["SynGPT-2.0"]
    assert by_version["Vantrel-Triage-2.1"]["replaces"] == "Vantrel-Triage-2.0"
    assert by_version["Vantrel-Triage-2.0"]["replaced_by"] == ["Vantrel-Triage-2.1"]
    assert sum("replaces" in entry for entry in registry) == 2

    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{API_PREFIX}/admin/versions").json()}
    assert versions[37]["kind"] == "models" and "status changes" not in versions[37]["summary"]
    older = {"model": "Vantrel-Triage-2.0", "use_case": "Emergency department triage"}
    summary = demo_client.get(f"{API_PREFIX}/metrics/summary", params=older).json()
    assert summary["total"] == 2400 and 2400 - summary["counts"]["no_data"] <= 255
    concept = demo_client.get(f"{API_PREFIX}/metrics/concepts/BA00", params=older).json()["metrics"]
    newer = demo_client.get(f"{API_PREFIX}/metrics/concepts/BA00", params={**older, "model": "Vantrel-Triage-2.1"}).json()["metrics"]
    assert concept["validation_type"] and concept["perf"] < newer["perf"], "the earlier release measured lower"
    assert concept["provenance"]["data_source"]["study"] == "DEMO-VANTREL-2-0-2025"
