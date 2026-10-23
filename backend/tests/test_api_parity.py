"""API parity: HTTP responses equal the A1 services, which
are parity-tested against the reference client, and, where the reference
fixtures cover it, the reference client (tag v0.2.0-alpha.1) directly.
"""

from __future__ import annotations

import pytest
from conftest import record
from parity import FLOAT_TOLERANCE, MismatchLog, floats_equal, lens_of, reference_safeguards

from app.main import API_PREFIX
from app.services import presentation
from app.services.catalog import Catalog
from app.services.exports import dataset_summary
from app.services.types import Lens

ALL_LENS = Lens()
_GRADE_STATUS = {"A": "strong", "B": "strong", "C": "moderate", "D": "weak", "E": "weak", "F": "weak"}
# Contract v1.11: no evidence grade reads no_data (was not_validated).
_TIER_STATUS = {"no_data": "no_data", "out_of_scope": "out_of_scope", "no_evidence_data": "no_data", "no_performance_data": "no_data"}
_RELEVANCE_RANK = {"High": 0, "Medium": 1, "Low": 2}
VIEWS = ("overall", "performance", "evidence", "intended_use")


def lens_params(lens: dict | Lens) -> dict:
    values = lens if isinstance(lens, dict) else lens.as_dict()
    return {"age": values["age"], "sex": values["sex"], "ethnicity": values["ethnicity"]}


def variant_params(variant: dict) -> dict:
    return {"model": variant["model_version"], "use_case": variant["use_case"]}


def expected_statuses(ref: dict | None) -> dict:
    """CONTRACT.md §4.5, applied to a reference row."""
    if ref is None:
        return {"overall": "no_data", "performance": "no_data", "evidence": "no_data"}
    tier = ref["overall"]["reason"] or "graded"
    return {
        "overall": _GRADE_STATUS[ref["overall"]["grade"]] if tier == "graded" else _TIER_STATUS[tier],
        "performance": "no_data" if ref["perf"] is None else _GRADE_STATUS[ref["performance_grade"]],
        "evidence": "no_data" if ref["evidence_grade"] is None else _GRADE_STATUS[ref["evidence_grade"]],
    }


def api_row_mismatches(ref: dict | None, api: dict | None) -> list[str]:
    """Differences between a reference row and a served ``MetricRow``."""
    if ref is None or api is None:
        return [] if ref is None and api is None else [f"row: expected {ref!r:.80}, got {api!r:.80}"]
    problems = []

    def check(name, ok, want, got):
        if not ok:
            problems.append(f"{name}: expected {want!r}, got {got!r}")

    for name in ("perf", "ci_low", "ci_high", "intended_use_coverage"):
        check(name, floats_equal(ref[name], api[name]), ref[name], api[name])
    for name in (
        "concept_id", "evidence_grade", "n_samples", "n_sites", "n_studies", "peer_reviewed_studies",
        "validation_type", "in_intended_use", "intended_use_level", "performance_grade",
    ):
        same = ref[name] == api[name] and type(ref[name]) is type(api[name])
        check(name, same, ref[name], api[name])
    lens_label = " | ".join(api["lens"][axis] for axis in ("age", "sex", "ethnicity"))
    check("lens", ref["lens"] == lens_label, ref["lens"], lens_label)
    want_overall = {"tier": ref["overall"]["reason"] or "graded", "grade": ref["overall"]["grade"]}
    got_overall = {"tier": api["overall"]["tier"], "grade": api["overall"]["grade"]}
    check("overall", want_overall == got_overall, want_overall, got_overall)
    check("overall.score", floats_equal(ref["overall"]["score"], api["overall"]["score"]), ref["overall"]["score"], api["overall"]["score"])
    check("status", expected_statuses(ref) == api["status"], expected_statuses(ref), api["status"])
    # The API orders equal-relevance warnings by code (CONTRACT.md §4.6).
    want_warnings = sorted((tuple(item) for item in ref["ranked_warnings"]), key=lambda item: (_RELEVANCE_RANK[item[1]], item[0]))
    got_warnings = [(item["code"], item["relevance"]) for item in api["warnings"]]
    check("warnings", want_warnings == got_warnings, want_warnings, got_warnings)
    want_safeguards = reference_safeguards(ref)
    got_safeguards = [(item["id"], item["priority"]) for item in api["safeguards"]]
    check("safeguards", want_safeguards == got_safeguards, want_safeguards, got_safeguards)
    return problems


def get(client, path: str, **params) -> dict:
    response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, response.text[:300]
    return response.json()


# ------------------------------------------------------------- single disease

def without_data_source(metrics: dict | None) -> dict | None:
    """A served row without ``provenance.data_source`` (v1.7), which only the API adds."""
    if metrics is None:
        return None
    provenance = {key: value for key, value in metrics["provenance"].items() if key != "data_source"}
    return {**metrics, "provenance": provenance}


def test_concept_metrics_match_reference_and_services(client, reference, live_dataset):
    log = MismatchLog()
    service_log = MismatchLog()
    for variant in reference["variants"]:
        params = variant_params(variant)
        service = live_dataset.metrics(variant["model_version"], variant["use_case"])
        rollups = [case for case in variant["rollups"] if case["concept_id"].startswith("CH-")]
        rollups += [case for index, case in enumerate(variant["rollups"]) if index % 20 == 0]
        for case in variant["cases"] + rollups:
            body = get(client, f"/metrics/concepts/{case['concept_id']}", **params, **lens_params(case["lens"]))
            where = f'{variant["model_version"]}/{variant["use_case"]} {case["concept_id"]} {case["lens"]}'
            log.add(where, api_row_mismatches(case["row"], body["metrics"]))
            row = service.row(case["concept_id"], lens_of(case["lens"]))
            want = presentation.metric_row(row, model_version=params["model"], use_case=params["use_case"]) if row else None
            served = without_data_source(body["metrics"])
            service_log.add(where, [] if want == served else [f"expected {want!r:.200}, got {served!r:.200}"])
    record("API concept metrics vs reference rows", log.compared)
    log.assert_clean()
    service_log.assert_clean()


def test_metric_maps_match_services(client, reference, live_dataset):
    catalog = Catalog(live_dataset.atlas)
    log = MismatchLog()
    for variant in reference["variants"]:
        params = variant_params(variant)
        service = live_dataset.metrics(variant["model_version"], variant["use_case"])
        random_lens = lens_of(variant["cases"][0]["lens"])
        for lens, scope, chapter_id in [
            (ALL_LENS, "atlas", None),
            (random_lens, "atlas", None),
            (ALL_LENS, "chapter", "CH-05"),
            (random_lens, "chapter", "CH-22"),
        ]:
            query = {**params, **lens_params(lens), "scope": scope, **({"chapter_id": chapter_id} if chapter_id else {})}
            body = get(client, "/metrics/map", **query)
            expected = [
                presentation.map_row(concept.concept_id, service.row(concept.concept_id, lens))
                for concept in catalog.scope(scope, chapter_id)
            ]
            for got, want in zip(body["rows"], expected, strict=True):
                log.add(f"{params} {lens.label} {got[0]}", [] if got == want else [f"expected {want}, got {got}"])
    record("API metric map rows vs services", log.compared)
    log.assert_clean()


@pytest.mark.parametrize("view", ["overall", "performance", "evidence", "intended_use"])
def test_summary_matches_service_rows(client, live_dataset, view):
    catalog = Catalog(live_dataset.atlas)
    for params, lens in [
        ({"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}, Lens(age="Age 40-64")),
        ({"model": "radAIology-1", "use_case": "Radiology image analysis"}, ALL_LENS),
    ]:
        body = get(client, "/metrics/summary", **params, **lens_params(lens), view=view)
        service = live_dataset.metrics(params["model"], params["use_case"])
        counts: dict[str, int] = {}
        for condition in catalog.conditions:
            row = service.row(condition.concept_id, lens)
            if view == "intended_use":
                key = "no_data" if row is None else row.intended_use_level
            else:
                key = presentation.statuses(row)[view]
            counts[key] = counts.get(key, 0) + 1
        if view == "intended_use":
            assert body["counts"]["no_data"] == counts.get("no_data", 0)
            assert body["intended_use_counts"] == {level: counts.get(level, 0) for level in ("in_scope", "partially_in_scope", "out_of_scope")}
        else:
            assert body["counts"] == {status: counts.get(status, 0) for status in body["counts"]}


# ----------------------------------------------------------- multimorbidity

def _expected_map_columns(rows_by_view: dict[str, dict | None]) -> dict[str, object]:
    """The MetricMap columns each view contributes, from reference rows."""
    overall, performance, evidence, intended_use = (rows_by_view.get(view) for view in VIEWS)
    return {
        "overall": (expected_statuses(overall)["overall"], overall["overall"]["grade"] if overall else None),
        "performance": (
            expected_statuses(performance)["performance"],
            performance["performance_grade"] if performance else None,
            performance["perf"] if performance else None,
            performance["ci_low"] if performance else None,
            performance["ci_high"] if performance else None,
        ),
        "evidence": (expected_statuses(evidence)["evidence"], evidence["evidence_grade"] if evidence else None),
        "intended_use": intended_use["intended_use_level"] if intended_use else None,
    }


def _api_map_columns(row: list | None) -> dict[str, object]:
    if row is None:
        return {"overall": ("no_data", None), "performance": ("no_data", None, None, None, None), "evidence": ("no_data", None), "intended_use": None}
    return {"overall": (row[1], row[2]), "performance": (row[4], row[5], row[6], row[10], row[11]), "evidence": (row[7], row[8]), "intended_use": row[9]}


def test_multimorbidity_matches_reference(client, reference, live_dataset):
    catalog = Catalog(live_dataset.atlas)
    in_atlas_scope = {concept.concept_id for concept in catalog.scope("atlas", None)}
    candidates_log, rows_log, display_log = MismatchLog(), MismatchLog(), MismatchLog()
    for variant in reference["variants"]:
        params = variant_params(variant)
        if not variant["multimorbidity"]:
            body = get(client, "/multimorbidity/candidates", **params, scope="atlas")
            assert body["has_multimorbidity"] is False and body["candidate_ids"] == []
            continue
        for path in variant["multimorbidity"]["paths"]:
            selection = path["selection"]
            selected = ",".join(selection)
            where = f"{params['model']}/{params['use_case']} {selection}"
            # Candidates and display rows, per lens the reference covers.
            displays: dict[str, dict] = {}
            for case in path["display"]:
                lens_key = " | ".join(lens_params(case["lens"]).values())
                displays.setdefault(lens_key, {"lens": case["lens"], "rows": {}})
                displays[lens_key]["rows"].setdefault(case["concept_id"], {})[case["view"]] = case["row"]
            if not displays:
                displays[ALL_LENS.label] = {"lens": ALL_LENS.as_dict(), "rows": {}}
            for lens_key, display in displays.items():
                body = get(client, "/multimorbidity/candidates", **params, **lens_params(display["lens"]), scope="atlas", selected=selected)
                if lens_key == ALL_LENS.label:
                    got = body["candidate_ids"]
                    candidates_log.add(where, [] if got == path["candidates"] else [f"expected {path['candidates']}, got {got}"])
                api_rows = {row[0]: row for row in body["display"]["rows"]}
                for concept_id, by_view in display["rows"].items():
                    if concept_id not in in_atlas_scope:
                        continue  # chapters and deeper categories are not in the atlas scope
                    want = _expected_map_columns(by_view)
                    got = _api_map_columns(api_rows.get(concept_id))
                    for view in VIEWS:
                        same = want[view] == got[view] or (
                            view == "performance"
                            and want[view][:2] == got[view][:2]
                            and floats_equal(want[view][2], got[view][2])
                        )
                        display_log.add(f"{where} {concept_id} {view} {lens_key}", [] if same else [f"expected {want[view]}, got {got[view]}"])
            # Combination rows.
            canonical = {live_dataset.atlas.canonical_condition_id(live_dataset.atlas.by_id[i]) for i in selection if live_dataset.atlas.by_id[i].level == 2}
            for case in path["rows"]:
                response = client.get(f"{API_PREFIX}/multimorbidity/combination", params={**params, **lens_params(case["lens"]), "selected": selected})
                if len(canonical) < 2:
                    rows_log.add(f"{where} {case['lens']}", [] if response.status_code == 422 and case["row"] is None else [f"status {response.status_code}"])
                    continue
                body = response.json()
                problems = api_row_mismatches(case["row"], body["metrics"])
                if case["row"] is not None and body["combination_label"] != case["row"]["combination_label"]:
                    problems.append(f"label: expected {case['row']['combination_label']!r}, got {body['combination_label']!r}")
                rows_log.add(f"{where} {case['lens']}", problems)
    record("API multimorbidity candidate lists vs reference", candidates_log.compared)
    record("API multimorbidity combination rows vs reference", rows_log.compared)
    record("API multimorbidity display cells vs reference", display_log.compared)
    candidates_log.assert_clean()
    rows_log.assert_clean()
    display_log.assert_clean()


@pytest.mark.parametrize("which", ["live", "fallback"])
def test_batched_display_rows_equal_display_row(reference, live_dataset, fallback_dataset, which):
    """The batched path behind /multimorbidity/candidates equals A1's display_row()."""
    dataset = live_dataset if which == "live" else fallback_dataset
    variants = reference["variants"] if which == "live" else reference["fallback_variants"]
    catalog = Catalog(dataset.atlas)
    log = MismatchLog()
    for variant in variants:
        if not variant["multimorbidity"]:
            continue
        service = dataset.multimorbidity(variant["model_version"], variant["use_case"])
        assert service._canonical_is_stable, "the batched path must be exercised, not its fallback"
        for path in variant["multimorbidity"]["paths"][:10]:
            selection = path["selection"]
            chapters = {dataset.atlas.by_id[concept_id].chapter_id for concept_id in selection} or {"CH-05"}
            scopes = [(catalog.scope("atlas", None), ALL_LENS)]
            scopes += [(catalog.scope("chapter", chapter), Lens(age="Age 65+")) for chapter in sorted(chapters)]
            for concepts, lens in scopes:
                batched = service.display_rows(concepts, selection, lens)
                for concept in concepts:
                    for view in VIEWS:
                        want = service.display_row(concept.concept_id, selection, lens, view)
                        got = batched[concept.concept_id][view]
                        log.add(f"{selection} {concept.concept_id} {view} {lens.label}", [] if want == got else [f"expected {want!r:.80}, got {got!r:.80}"])
    record(f"batched multimorbidity display rows vs display_row ({which})", log.compared)
    log.assert_clean()


# ------------------------------------------------------------------ search

def test_search_matches_reference(client, reference):
    queries = reference["search"]
    assert len(queries) >= 6
    raw = [query["raw"] for query in queries]
    assert any(q != q.strip() for q in raw), "a query with surrounding whitespace"
    assert any(q != q.lower() and q != q.upper() for q in raw), "a mixed-case query"
    log = MismatchLog()
    for query in queries:
        # The same concepts match as in the reference; since v1.12 they are
        # ranked best first instead of by level and name (CONTRACT.md §9,
        # §12.1), so the whole match list is compared as a set.
        body = get(client, "/search", q=query["raw"], limit=200)
        got = {"query": body["query"], "total": body["total"], "concept_ids": sorted(c["concept_id"] for c in body["results"])}
        want = {"query": query["query"], "total": query["total"], "concept_ids": sorted(query["concept_ids"])}
        if query["total"] > len(query["concept_ids"]):
            # The reference kept only its first 80, in its own order: the total
            # says the same concepts match, and the API serves its full page.
            got["concept_ids"] = len(body["results"]) == min(query["total"], 200)
            want["concept_ids"] = True
        log.add(repr(query["raw"]), [] if got == want else [f"expected {want!r:.300}, got {got!r:.300}"])
    record("API search queries vs reference", log.compared)
    log.assert_clean()
    assert sum(1 for query in queries if query["total"] > 0) >= 6


# ------------------------------------------------------------------ export

@pytest.mark.parametrize("which", ["live", "fallback"])
def test_dataset_export_summary_matches_reference(reference, live_dataset, fallback_dataset, which):
    dataset = live_dataset if which == "live" else fallback_dataset
    variants = reference["variants"] if which == "live" else reference["fallback_variants"]
    for variant in variants:
        got = dataset_summary(dataset, dataset.new_metrics(variant["model_version"], variant["use_case"]))
        want = variant["summary"]
        assert got.keys() == want.keys()
        assert got["conditionCount"] == want["conditionCount"]
        for key in ("averagePerf", "averageCertainty", "averageEvidence", "averageOverall"):
            assert abs(got[key] - want[key]) <= FLOAT_TOLERANCE, (variant["model_version"], variant["use_case"], key, got, want)
