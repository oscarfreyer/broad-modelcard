"""Behavior of every read endpoint: success, unknown model or
use case (404), invalid lens (422), empty results, problem details, and the
version headers."""

from __future__ import annotations

import json

import pytest

from app.main import API_PREFIX
from app.services.grading import OVERALL_SCORE_WEIGHTS, STATUS_BANDS

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
TINY = {"model": "Tiny-1", "use_case": "CDSS"}

# Endpoints scoped to a model and use case: (operationId, path, extra query, takes a lens).
SCOPED = [
    ("getMetricMap", "/metrics/map", {"scope": "atlas"}, True),
    ("getMetricSummary", "/metrics/summary", {}, True),
    ("getConceptMetrics", "/metrics/concepts/1C43", {}, True),
    ("getMultimorbidityCandidates", "/multimorbidity/candidates", {"scope": "atlas"}, True),
    ("getMultimorbidityCombination", "/multimorbidity/combination", {"selected": "5A11,GB61"}, True),
    ("exportConcept", "/export/concepts/1C43", {}, True),
    ("exportDataset", "/export/dataset", {}, False),
]
# Every read operation with a successful request.
ALL_READS = [
    ("getMeta", "/meta", {}),
    ("listModels", "/models", {}),
    ("getAtlasOverview", "/atlas/overview", {}),
    ("getChapter", "/atlas/chapters/CH-05", {}),
    ("searchConcepts", "/search", {"q": "asthma"}),
    *[(op_id, path, {**SYN, **extra}) for op_id, path, extra, _ in SCOPED if op_id != "exportDataset"],
]


def get(client, path: str, **params):
    return client.get(API_PREFIX + path, params=params)


def assert_problem(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text[:300]
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == status and body["code"] == code
    assert body["type"] == f"urn:broad-modelcard:problem:{code}" and body["title"]
    assert "ETag" not in response.headers
    return body


# ------------------------------------------------------- shared error cases

@pytest.mark.parametrize("op_id,path,extra,_", SCOPED, ids=[s[0] for s in SCOPED])
def test_unknown_model_is_404(client, op_id, path, extra, _):
    body = assert_problem(get(client, path, model="Nope-1", use_case="CDSS", **extra), 404, "unknown_model")
    assert "Nope-1" in body["detail"]


@pytest.mark.parametrize("op_id,path,extra,_", SCOPED, ids=[s[0] for s in SCOPED])
def test_unknown_use_case_is_404(client, op_id, path, extra, _):
    body = assert_problem(get(client, path, model="SynGPT-2.0", use_case="Radiology image analysis", **extra), 404, "unknown_use_case")
    assert "Radiology image analysis" in body["detail"]


@pytest.mark.parametrize("axis,value", [("age", "Age 100+"), ("sex", "Sex Other"), ("ethnicity", "all ethnicities")])
@pytest.mark.parametrize("op_id,path,extra", [(s[0], s[1], s[2]) for s in SCOPED if s[3]], ids=[s[0] for s in SCOPED if s[3]])
def test_invalid_lens_is_422(client, op_id, path, extra, axis, value):
    body = assert_problem(get(client, path, **SYN, **extra, **{axis: value}), 422, "invalid_lens")
    assert axis in body["detail"]


@pytest.mark.parametrize("op_id,path,extra,_", SCOPED, ids=[s[0] for s in SCOPED])
def test_missing_model_is_422(client, op_id, path, extra, _):
    body = assert_problem(get(client, path, use_case="CDSS", **extra), 422, "invalid_parameter")
    assert body["detail"] == "model is required"


STAGED_READS = ALL_READS + [("exportDataset", "/export/dataset", SYN)]


@pytest.mark.parametrize("op_id,path,params", STAGED_READS, ids=[read[0] for read in STAGED_READS])
def test_unknown_staged_uploads_and_invalid_versions(client, op_id, path, params):
    body = assert_problem(get(client, path, **params, version="staged:upload_42"), 404, "unknown_upload")
    assert "upload_42" in body["detail"]
    assert_problem(get(client, path, **params, version="staged:"), 422, "invalid_version")
    assert_problem(get(client, path, **params, version="published"), 422, "invalid_version")


# ---------------------------------------------------------------- versions

@pytest.mark.parametrize("op_id,path,params", ALL_READS, ids=[read[0] for read in ALL_READS])
def test_reads_carry_version_and_strong_etag(client, op_id, path, params):
    response = get(client, path, **params)
    assert response.status_code == 200
    assert response.headers["X-Dataset-Version"] == "1"
    etag = response.headers["ETag"]
    assert etag.startswith('"') and etag.endswith('"') and not etag.startswith("W/")
    if op_id == "exportConcept":
        # The ETag covers the body, which includes a millisecond timestamp, so
        # whether a repeat matches depends on timing. Only the headers are checked.
        return
    explicit = get(client, path, **params, version="live")
    assert explicit.headers["ETag"] == etag
    assert explicit.content == response.content
    not_modified = client.get(API_PREFIX + path, params=params, headers={"If-None-Match": etag})
    assert not_modified.status_code == 304 and not_modified.content == b""
    assert not_modified.headers["ETag"] == etag and not_modified.headers["X-Dataset-Version"] == "1"


def test_if_none_match_uses_weak_comparison_and_lists(client):
    params = {**SYN, "scope": "atlas"}
    etag = get(client, "/metrics/map", **params).headers["ETag"]
    for header in (f"W/{etag}", f'"other", {etag}', "*"):
        assert client.get(f"{API_PREFIX}/metrics/map", params=params, headers={"If-None-Match": header}).status_code == 304
    assert client.get(f"{API_PREFIX}/metrics/map", params=params, headers={"If-None-Match": '"other"'}).status_code == 200


def test_etags_differ_when_the_body_differs(client):
    first = get(client, "/metrics/map", **SYN, scope="atlas")
    second = get(client, "/metrics/map", **SYN, scope="atlas", age="Age 65+")
    assert first.headers["ETag"] != second.headers["ETag"]


# -------------------------------------------------------------------- meta

def test_meta(client, live_dataset):
    body = get(client, "/meta").json()
    axes = live_dataset.atlas.axes
    assert body["api_version"] == "1" and body["dataset_version"] == "1"
    assert body["axes"] == {"context": list(axes.context), "age": list(axes.age), "sex": list(axes.sex), "ethnicity": list(axes.ethnicity)}
    assert body["statuses"] == ["strong", "moderate", "weak", "out_of_scope", "no_data"]
    assert body["status_bands"] == STATUS_BANDS
    assert body["overall_score_weights"] == OVERALL_SCORE_WEIGHTS
    assert [chapter["level"] for chapter in body["chapters"]] == [0] * 21
    assert "synthetic" in body["synthetic_data_notice"].lower()
    # Procurement is a named audience: the notice says what the data is not, not who may not read it (audit batch 3).
    assert "procurement" not in body["synthetic_data_notice"].lower()
    assert "not real evidence about any AI system" in body["synthetic_data_notice"]
    assert "Not for clinical use." in body["synthetic_data_notice"]
    assert body["default_model_version"] == "SynGPT-2.0"


def test_models(client):
    body = get(client, "/models").json()
    assert body["default_model_version"] == "SynGPT-2.0"
    assert len(body["models"]) == 7
    variants = [(model["model_version"], use_case["use_case"], use_case["has_multimorbidity"]) for model in body["models"] for use_case in model["use_cases"]]
    assert len(variants) == 10
    assert sum(has for _, _, has in variants) == 4
    for model in body["models"]:
        assert model["default_use_case"] in {use_case["use_case"] for use_case in model["use_cases"]}


# ------------------------------------------------------------------- atlas

def test_atlas_overview(client):
    body = get(client, "/atlas/overview").json()
    assert (len(body["chapters"]), len(body["blocks"]), len(body["conditions"])) == (21, 225, 2400)
    assert all(c["level"] == 2 and c["depth_in_kind"] == 1 for c in body["conditions"])
    assert all(c["prevalence_tier"] is None and c["depth_in_kind"] is None for c in body["chapters"] + body["blocks"])
    assert all(isinstance(c["prevalence_score"], float) for c in body["chapters"] + body["blocks"] + body["conditions"])


def test_chapters_partition_the_categories(client):
    chapters = get(client, "/atlas/overview").json()["chapters"]
    total = 0
    for chapter in chapters:
        body = get(client, f"/atlas/chapters/{chapter['concept_id']}").json()
        assert body["chapter"] == chapter
        assert all(block["level"] == 1 and block["parent_id"] == chapter["concept_id"] for block in body["blocks"])
        assert all(c["level"] == 2 and c["chapter_id"] == chapter["concept_id"] for c in body["concepts"])
        total += len(body["concepts"])
    assert total == 13442


@pytest.mark.parametrize("concept_id", ["BLK-01-BlockL1-1A0", "1C43", "NOPE"])
def test_chapter_must_be_a_chapter(client, concept_id):
    assert_problem(get(client, f"/atlas/chapters/{concept_id}"), 404, "unknown_concept")


# ----------------------------------------------------------------- metrics

def test_metric_map_atlas_scope(client):
    body = get(client, "/metrics/map", **SYN, scope="atlas", chapter_id="CH-05").json()  # chapter_id is ignored
    assert body["columns"][0] == "concept_id" and len(body["columns"]) == 14 and body["columns"][-4:] == ["ci_low", "ci_high", "safety", "child_count"]
    assert body["filters"] == {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS", "context": "Clinical", "lens": {"age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities"}}
    ids = [row[0] for row in body["rows"]]
    overview = get(client, "/atlas/overview").json()
    assert ids == [c["concept_id"] for c in overview["blocks"]] + [c["concept_id"] for c in overview["conditions"]]


def test_metric_map_chapter_scope(client):
    body = get(client, "/metrics/map", **ICU, scope="chapter", chapter_id="CH-05", sex="Sex Female").json()
    chapter = get(client, "/atlas/chapters/CH-05").json()
    assert [row[0] for row in body["rows"]] == [c["concept_id"] for c in chapter["blocks"] + chapter["concepts"]]
    assert body["filters"]["lens"]["sex"] == "Sex Female"


def test_metric_map_scope_errors(client):
    assert_problem(get(client, "/metrics/map", **SYN, scope="chapter"), 422, "missing_chapter_id")
    assert_problem(get(client, "/metrics/map", **SYN, scope="planet"), 422, "invalid_scope")
    assert_problem(get(client, "/metrics/map", **SYN, scope="chapter", chapter_id="BLK-01-BlockL1-1A0"), 404, "unknown_concept")


@pytest.mark.parametrize("view", ["overall", "performance", "evidence"])
def test_summary_counts_every_condition(client, view):
    body = get(client, "/metrics/summary", **SYN, view=view).json()
    assert body["view"] == view and body["total"] == 2400
    assert sum(body["counts"].values()) == 2400
    assert sum(chapter["total"] for chapter in body["chapters"]) == 2400
    assert "intended_use_counts" not in body
    for status in body["counts"]:
        assert sum(chapter["counts"][status] for chapter in body["chapters"]) == body["counts"][status]


def test_summary_intended_use_view(client):
    body = get(client, "/metrics/summary", **ICU, view="intended_use", age="Age 0-17").json()
    assert body["counts"]["strong"] == body["counts"]["moderate"] == body["counts"]["weak"] == 0
    assert sum(body["intended_use_counts"].values()) + body["counts"]["no_data"] == 2400
    assert body["counts"]["out_of_scope"] == body["intended_use_counts"]["out_of_scope"]


def test_summary_view_error(client):
    assert_problem(get(client, "/metrics/summary", **SYN, view="colour"), 422, "invalid_view")


def test_concept_metrics_for_each_level(client):
    chapter = get(client, "/metrics/concepts/CH-05", **SYN).json()
    assert [c["level"] for c in chapter["path"]] == [0]
    assert chapter["metrics"]["provenance"]["source"] == "rollup"
    assert chapter["metrics"]["provenance"]["rollup"]["aggregation"] == "p20"
    block = get(client, "/metrics/concepts/BLK-01-BlockL1-1A0", **ICU).json()
    assert [c["level"] for c in block["path"]] == [0, 1]
    condition = get(client, "/metrics/concepts/1C43", **SYN, age="Age 65+").json()
    assert [c["concept_id"] for c in condition["path"]] == ["CH-01", "BLK-01-BlockL1-1C1", "1C43"]
    assert condition["metrics"]["provenance"] == {
        "source": "condition", "anchor_concept_id": None, "rollup": None, "lens_fallback": False,
        "data_source": {"source": "Seed (synthetic, version 1)", "study": None, "date": None},
    }
    assert chapter["metrics"]["provenance"]["data_source"] is None  # aggregated rows have none
    assert condition["incidents"] == [] and chapter["incidents"] == []
    assert condition["metrics"]["lens"]["age"] == "Age 65+"
    deeper = get(client, "/metrics/concepts/1A03.1", **SYN).json()
    assert deeper["concept"]["depth_in_kind"] == 2
    assert deeper["metrics"]["concept_id"] == "1A03.1"
    assert deeper["metrics"]["provenance"]["source"] == "anchor"
    assert deeper["metrics"]["provenance"]["anchor_concept_id"] == "1A03"


def test_concept_metrics_empty_and_unknown(client, tiny_client):
    body = get(tiny_client, "/metrics/concepts/1A09.1", **TINY).json()
    assert body["metrics"] is None and body["concept"]["concept_id"] == "1A09.1"
    assert_problem(get(client, "/metrics/concepts/NOPE", **SYN), 404, "unknown_concept")


# ---------------------------------------------------------- multimorbidity

def test_candidates_without_multimorbidity_data_are_empty(client):
    body = get(client, "/multimorbidity/candidates", **ICU, scope="atlas", selected="5A11").json()
    assert body["has_multimorbidity"] is False
    assert body["candidate_ids"] == [] and body["display"]["rows"] == []
    assert body["selected"] == ["5A11"] and body["combination_key"] is None


def test_candidates_follow_the_selection(client):
    start = get(client, "/multimorbidity/candidates", **SYN, scope="atlas").json()
    assert start["has_multimorbidity"] and start["selected"] == [] and start["combination_key"] is None
    assert set(start["candidate_ids"]) <= {row[0] for row in start["display"]["rows"]}
    one = get(client, "/multimorbidity/candidates", **SYN, scope="atlas", selected="5A11").json()
    assert one["selected"] == ["5A11"] and one["candidate_ids"]
    two = get(client, "/multimorbidity/candidates", **SYN, scope="atlas", selected="GB61,5A11").json()
    assert two["selected"] == ["GB61", "5A11"] and two["combination_key"] == "5A11+GB61"


def test_selection_errors(client):
    assert_problem(get(client, "/multimorbidity/candidates", **SYN, scope="atlas", selected="5A11,NOPE"), 404, "unknown_concept")
    assert_problem(get(client, "/multimorbidity/candidates", **SYN, scope="atlas", selected="5A11,,GB61"), 422, "invalid_selection")
    many = ",".join(["5A11"] * 13)
    assert_problem(get(client, "/multimorbidity/candidates", **SYN, scope="atlas", selected=many), 422, "invalid_selection")
    assert_problem(get(client, "/multimorbidity/combination", **SYN, selected="5A11"), 422, "invalid_selection")
    assert_problem(get(client, "/multimorbidity/combination", **SYN, selected="5A11,5A11,CH-05"), 422, "invalid_selection")
    assert_problem(get(client, "/multimorbidity/combination", **SYN), 422, "invalid_selection")


def test_combination_is_order_insensitive(client):
    forward = get(client, "/multimorbidity/combination", **SYN, selected="5A11,GB61").json()
    backward = get(client, "/multimorbidity/combination", **SYN, selected="GB61,5A11").json()
    assert forward["combination_key"] == backward["combination_key"] == "5A11+GB61"
    assert backward["selected"] == ["GB61", "5A11"]
    assert forward["metrics"] == backward["metrics"] and forward["metrics"]["provenance"]["source"] == "multimorbidity"
    assert forward["combination_label"]


def test_combination_canonicalizes_deeper_concepts(client):
    body = get(client, "/multimorbidity/combination", **SYN, selected="GB61.3,5A11,GB61").json()
    assert body["selected"] == ["GB61", "5A11"] and body["combination_key"] == "5A11+GB61"
    assert body["metrics"] == get(client, "/multimorbidity/combination", **SYN, selected="5A11,GB61").json()["metrics"]


def test_combination_without_stored_row_is_empty(client):
    body = get(client, "/multimorbidity/combination", **SYN, selected="5A11,1C43").json()
    assert body["metrics"] is None and body["combination_label"] is None
    assert body["combination_key"] == "1C43+5A11"


def test_multimorbidity_lens_fallback_is_flagged(client):
    body = get(client, "/multimorbidity/combination", **SYN, selected="5A11,GB61", age="Age 65+").json()
    assert body["metrics"]["provenance"]["lens_fallback"] is True


# ------------------------------------------------------------------ search

def test_search(client):
    body = get(client, "/search", q="  Asthma  ").json()
    assert body["query"] == "Asthma" and body["total"] >= len(body["results"]) > 0
    levels = [c["level"] for c in body["results"]]
    assert levels == sorted(levels)


def test_search_limit_and_empty_result(client):
    limited = get(client, "/search", q="e", limit=5).json()
    assert len(limited["results"]) == 5 and limited["total"] > 5
    assert get(client, "/search", q="e").json()["results"][:5] == limited["results"]
    assert len(get(client, "/search", q="e").json()["results"]) == 80
    empty = get(client, "/search", q="zzqxj").json()
    assert empty == {"query": "zzqxj", "total": 0, "results": []}


def test_search_errors(client):
    assert_problem(get(client, "/search", q="   "), 422, "invalid_query")
    assert_problem(get(client, "/search", q="x" * 201), 422, "invalid_query")
    assert_problem(get(client, "/search"), 422, "invalid_query")
    for limit in (0, 201, "many"):
        assert_problem(get(client, "/search", q="asthma", limit=limit), 422, "invalid_limit")


# ------------------------------------------------------------------ export

def test_concept_export(client):
    response = get(client, "/export/concepts/1C43", **SYN, sex="Sex Male")
    assert response.headers["content-disposition"] == 'attachment; filename="1c43-model-card.json"'
    body = response.json()
    metrics = get(client, "/metrics/concepts/1C43", **SYN, sex="Sex Male").json()["metrics"]
    assert body["model_card"] == metrics
    assert body["warnings"] == metrics["warnings"] and body["safeguards"] == metrics["safeguards"]
    assert body["audience_view"] == "expert"
    assert body["concept"] == {"code": "1C43", "block": "BlockL1-1C1", "name": "Actinomycetoma", "hierarchy": [c["pt"] for c in get(client, "/metrics/concepts/1C43", **SYN).json()["path"]]}
    assert body["context"] == {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS", "population": {"age": "All ages", "sex": "Sex Male", "ethnicity": "All ethnicities"}}
    assert body["exported_at"].endswith("Z") and body["dataset_version"] == "1"


def test_concept_export_for_a_block_and_without_metrics(client, tiny_client):
    block = get(client, "/export/concepts/BLK-01-BlockL1-1A0", **ICU, audience="patient").json()
    assert block["audience_view"] == "patient" and block["concept"]["block"] == "BlockL1-1A0"  # the block_id, as in the reference
    empty = get(tiny_client, "/export/concepts/1A09.1", **TINY).json()
    assert empty["model_card"] is None and empty["warnings"] == [] and empty["safeguards"] == []
    assert_problem(get(client, "/export/concepts/1C43", **SYN, audience="doctor"), 422, "invalid_parameter")


def test_dataset_export_tiny(tiny_client):
    response = get(tiny_client, "/export/dataset", **TINY)
    assert response.headers["content-disposition"] == 'attachment; filename="broad-modelcard-tiny-1-cdss-v1.json"'
    body = json.loads(response.content)
    assert [c["concept_id"] for c in body["concepts"]] == ["CH-01", "BLK-01", "1A00", "1A01", "1A00.0", "1A09.1"]
    assert body["metric_axes"]["age"][0] == "All ages"
    assert body["meta"]["modelVersion"] == "Tiny-1" and body["meta"]["dataset_version"] == "1"
    assert body["summary"]["conditionCount"] == 2
    # 90 lenses × (chapter, block, two conditions, one anchored category); 1A09.1 has no row.
    assert len(body["metrics_by_key"]) == 90 * 5
    key = "1A00|CDSS|Clinical|Age 65+ | Sex Female | Ethnicity Asian|Tiny-1"
    row = body["metrics_by_key"][key]
    assert row["concept_id"] == "1A00" and row["lens"] == {"age": "Age 65+", "sex": "Sex Female", "ethnicity": "Ethnicity Asian"}
    direct = get(tiny_client, "/metrics/concepts/1A00", **TINY, age="Age 65+", sex="Sex Female", ethnicity="Ethnicity Asian").json()
    served = direct["metrics"]
    assert served["provenance"].pop("data_source")["source"] == "Seed (synthetic, version 1)"  # concept reads only
    assert row == served


# ----------------------------------------------------------- availability

def test_missing_store_is_503(tmp_path):
    from conftest import local_client

    from app.main import create_app

    with local_client(create_app(tmp_path / "missing.sqlite")) as missing:
        body = assert_problem(missing.get(f"{API_PREFIX}/meta"), 503, "store_unavailable")
        admin = assert_problem(missing.get(f"{API_PREFIX}/admin/datasets"), 503, "store_unavailable")
    assert "python -m app.importers.legacy_json" in body["detail"]
    for detail in (body["detail"], admin["detail"]):
        # No file-system paths in problem details (CONTRACT.md §16).
        assert str(tmp_path) not in detail and "missing.sqlite" not in detail and "/" not in detail, detail


def test_startup_logs_the_local_only_warning(tiny_db, caplog):
    from conftest import local_client

    from app.main import create_app

    with caplog.at_level("WARNING", logger="broad_modelcard.api"), local_client(create_app(tiny_db)):
        pass
    assert "LOCAL ONLY, NO AUTHENTICATION" in caplog.text
