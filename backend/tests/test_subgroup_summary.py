"""The group summary, getSubgroupSummary (contract v1.14, CONTRACT.md §24).

Per one-group lens, over a card's depth-1 ICD-11 conditions: results in the
group, results at all patients missing in the group, comparisons, flags
higher and lower (the Across groups rule), and the five largest flags. A
prototype heuristic, never a grade. All data is synthetic.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import pytest
from conftest import record_budget

from app.main import API_PREFIX
from app.services.subgroups import SUMMARY_FLAGGED_LIMIT, one_group_lenses, subgroup_summary
from app.services.types import ALL_POPULATIONS, Axes, Lens

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
TINY = {"model": "Tiny-1", "use_case": "CDSS"}
VANTREL = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}
NORTHBRIDGE = "northbridge-region"
SUMMARY = f"{API_PREFIX}/metrics/subgroups/summary"
PERF_FACTOR = float(os.environ.get("BMC_PERF_FACTOR", "1"))


# ------------------------------------------------------- a hand-checked fixture

@dataclass(frozen=True)
class _Condition:
    concept_id: str
    icd11_code: str
    pt: str
    chapter_id: str = "CH-01"


@dataclass(frozen=True)
class _Row:
    perf: float | None
    ci_low: float | None = None
    ci_high: float | None = None


class _Metrics:
    """Rows by (concept, lens value) for a two-axis toy: age has one group, sex two."""

    def __init__(self, rows: dict):
        self.rows = rows

    def row(self, concept_id: str, lens: Lens):
        group = next((value for value in (lens.age, lens.sex, lens.ethnicity) if not value.startswith("All ")), "all")
        return self.rows.get((concept_id, group))

    def layer(self, concept_id, lens):
        return None


AXES = Axes(context=("Clinical",), age=("All ages", "Age 65+"), sex=("All sexes", "Sex Female", "Sex Male"), ethnicity=("All ethnicities",))
CONDITIONS = [_Condition(f"C{index}", f"C{index}", f"Condition {index}") for index in range(1, 8)]
ROWS = {
    # C1: Age 65+ clearly higher (flagged), Female clearly lower (flagged), Male no result.
    ("C1", "all"): _Row(0.70, 0.66, 0.74),
    ("C1", "Age 65+"): _Row(0.85, 0.80, 0.90),
    ("C1", "Sex Female"): _Row(0.55, 0.50, 0.60),
    # C2: Age 65+ lower by 0.06 but the intervals overlap (compared, not flagged); Female missing CI.
    ("C2", "all"): _Row(0.80, 0.70, 0.90),
    ("C2", "Age 65+"): _Row(0.74, 0.65, 0.83),
    ("C2", "Sex Female"): _Row(0.60),
    # C3: Age 65+ much lower (flagged, the largest |delta|); Male below the minimum difference.
    ("C3", "all"): _Row(0.90, 0.88, 0.92),
    ("C3", "Age 65+"): _Row(0.50, 0.45, 0.55),
    ("C3", "Sex Male"): _Row(0.88, 0.86, 0.90),
    # C4: a group result without an all-patients result (a result, not compared).
    ("C4", "Age 65+"): _Row(0.60, 0.55, 0.65),
    # C5: a row without a performance value at all patients and in the group: no result anywhere.
    ("C5", "all"): _Row(None),
    ("C5", "Age 65+"): _Row(None),
    # C6: all patients only (no result in any group).
    ("C6", "all"): _Row(0.65, 0.60, 0.70),
    # C7: no rows at all.
}


def test_summary_counts_on_a_hand_checked_fixture():
    summary = subgroup_summary(CONDITIONS, AXES, _Metrics(ROWS))
    assert (summary["total"], summary["all_patients_with_result"], summary["layered"]) == (7, 4, False)
    by_group = {group["group"]: group for group in summary["groups"]}
    assert list(by_group) == ["Age 65+", "Sex Female", "Sex Male"]
    age = by_group["Age 65+"]
    # Results in the group: C1, C2, C3, C4. All patients without the group: C6. Compared: C1, C2, C3.
    assert {key: age[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")} == {
        "with_result": 4, "no_result": 1, "compared": 3, "flagged_higher": 1, "flagged_lower": 1,
    }
    assert [(entry["concept_id"], entry["delta"], entry["direction"]) for entry in age["flagged"]] == [("C3", -0.4, "lower"), ("C1", 0.15, "higher")]
    assert age["lens"] == {"age": "Age 65+", "sex": "All sexes", "ethnicity": "All ethnicities"}
    female = by_group["Sex Female"]
    # C1 flagged lower (0.55 vs 0.70, intervals apart); C2 has no CI (compared, not flagged); C3 and C6 have none.
    assert {key: female[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")} == {
        "with_result": 2, "no_result": 2, "compared": 2, "flagged_higher": 0, "flagged_lower": 1,
    }
    male = by_group["Sex Male"]
    assert {key: male[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")} == {
        "with_result": 1, "no_result": 3, "compared": 1, "flagged_higher": 0, "flagged_lower": 0,
    }
    assert male["flagged"] == []


def test_at_most_five_flags_largest_first_then_condition_order():
    conditions = [_Condition(f"D{index}", f"D{index}", f"D {index}") for index in range(8)]
    rows = {}
    for index, condition in enumerate(conditions):
        rows[(condition.concept_id, "all")] = _Row(0.5, 0.49, 0.51)
        delta = 0.1 + (0.05 if index in (2, 5) else 0)
        rows[(condition.concept_id, "Age 65+")] = _Row(round(0.5 + delta, 3), 0.5 + delta - 0.01, 0.5 + delta + 0.01)
    axes = Axes(context=("Clinical",), age=("All ages", "Age 65+"), sex=("All sexes",), ethnicity=("All ethnicities",))
    (group,) = subgroup_summary(conditions, axes, _Metrics(rows))["groups"]
    assert group["flagged_higher"] == 8 and len(group["flagged"]) == SUMMARY_FLAGGED_LIMIT == 5
    assert [entry["concept_id"] for entry in group["flagged"]] == ["D2", "D5", "D0", "D1", "D3"]


# ------------------------------------------------------------- through the API

def _summary(client, **params):
    response = client.get(SUMMARY, params=params)
    assert response.status_code == 200, response.text[:300]
    return response


def _per_condition_tally(client, card: dict, concept_ids, **params) -> dict:
    """The summary's counts rebuilt from getConceptSubgroups, one condition at a time."""
    tally = {}
    for concept_id in concept_ids:
        body = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}/subgroups", params={**card, **params}).json()
        reference_perf = body["all_patients"]["perf"]
        for entry in body["groups"]:
            counts = tally.setdefault(entry["group"], {"with_result": 0, "no_result": 0, "compared": 0, "flagged_higher": 0, "flagged_lower": 0, "flags": []})
            if entry["perf"] is None:
                counts["no_result"] += reference_perf is not None
                continue
            counts["with_result"] += 1
            difference = entry["difference"]
            if difference["delta"] is None:
                continue
            counts["compared"] += 1
            if difference["flagged"]:
                counts[f"flagged_{difference['direction']}"] += 1
                counts["flags"].append((concept_id, difference["delta"]))
    return tally


def test_the_summary_equals_the_condition_reads_on_the_tiny_store(admin_client):
    client = admin_client
    body = _summary(client, **TINY).json()
    conditions = [concept["concept_id"] for concept in client.get(f"{API_PREFIX}/atlas/overview").json()["conditions"]]
    assert body["total"] == len(conditions) and body["classification_basis"] == "icd11" and body["layered"] is False
    tally = _per_condition_tally(client, TINY, conditions)
    for group in body["groups"]:
        expected = tally[group["group"]]
        assert {key: group[key] for key in expected if key != "flags"} == {key: value for key, value in expected.items() if key != "flags"}, group["group"]
        largest = sorted(expected["flags"], key=lambda item: -abs(item[1]))[:5]
        assert [abs(entry["delta"]) for entry in group["flagged"]] == [abs(delta) for _, delta in largest]


def test_the_summary_equals_the_condition_reads_on_a_chapter_of_the_seed(client):
    """The service over one chapter's conditions agrees with getConceptSubgroups for each of them."""
    store = client.app.state.api.store
    context = store.resolve("live")
    chapter = [condition for condition in context.catalog.conditions if condition.chapter_id == "CH-05"]
    with store.lock:
        summary = subgroup_summary(chapter, context.dataset.atlas.axes, context.dataset.metrics(SYN["model"], SYN["use_case"]))
    tally = _per_condition_tally(client, SYN, [condition.concept_id for condition in chapter])
    assert summary["total"] == len(chapter) > 50
    for group in summary["groups"]:
        expected = tally[group["group"]]
        assert {key: group[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")} == {
            key: expected[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")
        }, group["group"]
        largest = sorted(expected["flags"], key=lambda item: -abs(item[1]))[:5]
        assert [abs(entry["delta"]) for entry in group["flagged"]] == [abs(delta) for _, delta in largest]
    assert any(group["flagged_higher"] + group["flagged_lower"] for group in summary["groups"])


def test_layers_with_a_local_population_follow_the_condition_reads(demo_client):
    """With local results for the population, groups compare within their layer, as on the condition card."""
    client = demo_client
    store = client.app.state.api.store
    context = store.resolve("live", NORTHBRIDGE)
    dataset = context.dataset
    assert dataset.has_local_results(ICU["model"], ICU["use_case"])
    metrics = dataset.metrics(ICU["model"], ICU["use_case"])
    local = [condition for condition in context.catalog.conditions if metrics.layer(condition.concept_id, ALL_POPULATIONS) == "local"]
    others = [condition for condition in context.catalog.conditions if condition.chapter_id == local[0].chapter_id][:40]
    subset = list({condition.concept_id: condition for condition in [*local, *others]}.values())
    with store.lock:
        summary = subgroup_summary(subset, dataset.atlas.axes, metrics, dataset.public_metrics(ICU["model"], ICU["use_case"]), layered=True)
    tally = _per_condition_tally(client, ICU, [condition.concept_id for condition in subset], population=NORTHBRIDGE)
    for group in summary["groups"]:
        expected = tally[group["group"]]
        assert {key: group[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")} == {
            key: expected[key] for key in ("with_result", "no_result", "compared", "flagged_higher", "flagged_lower")
        }, group["group"]
    response = _summary(client, **ICU, population=NORTHBRIDGE)
    body = response.json()
    assert body["layered"] is True and body["population"]["id"] == NORTHBRIDGE
    assert response.headers["x-population"] == NORTHBRIDGE
    default = _summary(client, **ICU)
    assert default.json()["layered"] is False and "population" not in default.json()
    assert default.headers["etag"] != response.headers["etag"]


def test_a_product_with_all_patient_rows_only_has_no_group_data(demo_client):
    body = _summary(demo_client, **VANTREL).json()
    assert body["all_patients_with_result"] > 0
    for group in body["groups"]:
        assert (group["with_result"], group["compared"], group["flagged"]) == (0, 0, [])
        assert group["no_result"] == body["all_patients_with_result"]


def test_versions_etags_and_ontology(ontology_client):
    client = ontology_client
    icd11 = _summary(client, **SYN)
    assert icd11.headers["x-dataset-version"] and icd11.headers["etag"]
    assert client.get(SUMMARY, params=SYN, headers={"If-None-Match": icd11.headers["etag"]}).status_code == 304
    mondo = _summary(client, **SYN, ontology="mondo")
    assert mondo.content == icd11.content and "x-ontology" not in mondo.headers  # always counted over ICD-11
    assert mondo.json()["classification_basis"] == "icd11"
    assert client.get(SUMMARY, params={**SYN, "ontology": "snomed"}).json()["code"] == "unknown_ontology"
    assert client.get(SUMMARY, params={**SYN, "ontology": "Not An Id"}).status_code == 422
    assert client.get(SUMMARY, params={**SYN, "use_case": "Nope"}).json()["code"] == "unknown_use_case"
    assert client.get(SUMMARY, params={**SYN, "version": "staged:nope"}).status_code == 404


def test_groups_follow_the_one_group_lenses(client):
    body = _summary(client, **SYN).json()
    axes = client.app.state.api.store.resolve("live").dataset.atlas.axes
    assert [(group["axis"], group["group"]) for group in body["groups"]] == [(axis, value) for axis, value, _ in one_group_lenses(axes)]
    for group in body["groups"]:
        assert group["with_result"] + group["no_result"] <= body["total"]
        assert group["compared"] <= group["with_result"]
        assert group["flagged_higher"] + group["flagged_lower"] <= group["compared"]
        assert all(abs(entry["delta"]) >= 0.05 - 1e-9 for entry in group["flagged"])


@pytest.mark.slow
def test_budget(demo_client):
    """G4: under 50 KB and within 150 ms warm (demo store); the uncached build is recorded."""
    client = demo_client
    store = client.app.state.api.store
    sizes, cold, warm = [], [], []
    for card in (SYN, ICU, VANTREL, {**ICU, "population": NORTHBRIDGE}):
        store.responses.clear()  # the first read builds the answer; the metric rows may be cached
        started = time.perf_counter()
        response = _summary(client, **card)
        cold.append((time.perf_counter() - started) * 1000)
        sizes.append(len(response.content))
        for _ in range(5):
            started = time.perf_counter()
            _summary(client, **card)
            warm.append((time.perf_counter() - started) * 1000)
    warm.sort()
    p95 = warm[int(0.95 * (len(warm) - 1))]
    record_budget(
        f"time  metrics/subgroups/summary    first {max(cold):6.1f} ms  warm p95 {p95:5.1f} ms  max {max(sizes) / 1000:.1f} KB  "
        f"target warm ≤ {150 * PERF_FACTOR:.0f} ms, < 50 KB (demo store)"
    )
    assert max(sizes) < 50_000, sizes
    assert p95 <= 150 * PERF_FACTOR, f"warm p95 {p95:.1f} ms"
