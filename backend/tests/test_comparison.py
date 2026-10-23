"""getComparison: 2 to 4 cards side by side with comparability per row (contract v1.13, CONTRACT.md §25).

Covers every reason code (through the API where the demo store and the
fixture ontologies hold a case, and through the rule's functions with
constructed cells where they do not), 2/3/4 cards, invalid inputs, population
and ontology keying, the response cache, and the budgets.
"""

from __future__ import annotations

import random
import time

import pytest
from conftest import local_client, record_budget

from app.main import API_PREFIX, create_app
from app.services import comparison as rule
from app.services.comparison import CardFacts, CardRef, card_reasons, design_group, perf_spread, row_reasons
from app.services.types import ALL_POPULATIONS, Lens

SYN = "SynGPT-2.0|Clinician Facing CDSS"
SYN1 = "SynGPT-1.0|Clinician Facing CDSS"
ICU = "ICU_GPT-1.0|CDSS"
VANTREL = "Vantrel-Triage-2.1|Emergency department triage"  # a product: the all-population lens only
RAD = "radAIology-1|Radiology image analysis"
MEDICORE_DOC = "MediCore-2.5|Discharge letter generation"
FOUR = ",".join([SYN, VANTREL, ICU, RAD])
TARGET_MS = 300  # a warm comparison of four cards


def compare(client, cards: str, **params):
    return client.get(f"{API_PREFIX}/compare", params={"cards": cards, **params})


def codes(row: dict) -> list[str]:
    return [reason["code"] for reason in row["reasons"]]


def reason(row: dict, code: str) -> dict | None:
    return next((item for item in row["reasons"] if item["code"] == code), None)


# ------------------------------------------------------------------ shapes

@pytest.mark.parametrize("cards", [[SYN, ICU], [SYN, ICU, RAD], [SYN, ICU, RAD, VANTREL]])
def test_two_three_and_four_cards(demo_client, cards):
    response = compare(demo_client, ",".join(cards))
    assert response.status_code == 200, response.text
    body = response.json()
    assert [card["card_id"] for card in body["cards"]] == cards
    assert body["filters"] == {"context": "Clinical", "lens": ALL_POPULATIONS.as_dict(), "scope": "atlas", "chapter_id": None, "chapter_pt": None}
    chapters = demo_client.get(f"{API_PREFIX}/meta").json()["chapters"]
    assert [row["concept_id"] for row in body["rows"]] == [chapter["concept_id"] for chapter in chapters]
    assert all(len(row["cells"]) == len(cards) and row["level"] == 0 for row in body["rows"])
    assert response.headers["x-dataset-version"] == body["dataset_version"] and response.headers["etag"]
    assert "population" not in body and "ontology" not in body and "x-ontology" not in response.headers


def test_cells_are_the_atlas_map(demo_client):
    """Each cell is what /metrics/map serves for that card, concept, and lens."""
    lens = {"age": "Age 40-64"}
    body = compare(demo_client, f"{SYN},{ICU}", scope="chapter", chapter_id="CH-05", **lens).json()
    for index, card in enumerate((SYN, ICU)):
        model, use_case = card.split("|")
        served = demo_client.get(
            f"{API_PREFIX}/metrics/map", params={"model": model, "use_case": use_case, "scope": "chapter", "chapter_id": "CH-05", **lens}
        ).json()
        by_id = {row[0]: dict(zip(served["columns"], row)) for row in served["rows"]}
        for row in body["rows"]:
            cell, mapped = row["cells"][index], by_id[row["concept_id"]]
            if cell["status"] == "no_data":
                assert mapped["overall_status"] == "no_data" or mapped["child_count"] == 0
                continue
            assert cell["status"] == mapped["overall_status"]
            assert (cell["perf"], cell["ci_low"], cell["ci_high"]) == (mapped["perf"], mapped["ci_low"], mapped["ci_high"])
            assert cell["evidence_grade"] == mapped["evidence_grade"] and cell["safety"] == mapped["safety"]


def test_chapter_scope_lists_blocks_then_their_conditions(demo_client):
    body = compare(demo_client, f"{SYN},{ICU}", scope="chapter", chapter_id="CH-05").json()
    rows = body["rows"]
    assert rows[0]["level"] == 1
    block = None
    for row in rows:
        if row["level"] == 1:
            block = row["concept_id"]
            assert row["parent_id"] == "CH-05"
        else:
            assert row["level"] == 2 and row["parent_id"] == block
    chapter = demo_client.get(f"{API_PREFIX}/atlas/chapters/CH-05").json()
    depth_one = [c["concept_id"] for c in chapter["concepts"] if c["level"] == 2 and c["depth_in_kind"] == 1]
    assert sorted(row["concept_id"] for row in rows if row["level"] == 2) == sorted(depth_one)


def test_card_header_facts(demo_client):
    body = compare(demo_client, f"{SYN},{VANTREL},{ICU}").json()
    syn, vantrel, icu = body["cards"]
    assert syn["kind"] == "model" and vantrel["kind"] == "product"
    assert syn["function_category"] == "decision_support" and vantrel["function_category"] == "triage"
    assert syn["intended_use_defined"] is False and vantrel["intended_use_defined"] is True
    # Pack v10 (contract v1.14, §29): both store setting-specific rows, named in `settings`; the counts are Any setting's.
    assert syn["lenses"] == {
        "stored": 90, "total": 90, "all_patients_only": False, "requested": "stored", "settings": ["Clinical", "Emergency department", "Primary care"],
    }
    assert vantrel["lenses"] == {"stored": 1, "total": 90, "all_patients_only": True, "requested": "stored", "settings": ["Clinical", "Emergency department"]}
    # The studies linked to the card's rows (§22): the demo pack links ICU-RETRO-2025 to ICU_GPT-1.0.
    assert [study["study_id"] for study in icu["studies"]] == ["ICU-RETRO-2025"]
    assert icu["studies"][0]["design"] == "retrospective" and icu["studies"][0]["conducted_by"] == "developer"
    assert vantrel["studies"] == []
    order = list(rule.grading.VALIDATION_TYPE_SCORES)
    assert syn["validation_types"] == sorted(syn["validation_types"], key=order.index)
    assert "clinical_study" in icu["design_groups"]
    # A group lens a product has no data for.
    group = compare(demo_client, f"{SYN},{VANTREL}", age="Age 65+").json()["cards"]
    assert group[1]["lenses"]["requested"] == "none" and group[1]["validation_types"] == [] and group[1]["design_groups"] == []


# ------------------------------------------------------------ the reasons

def test_function_category_differs(demo_client):
    body = compare(demo_client, f"{SYN},{ICU},{VANTREL}").json()
    # SynGPT-2.0 and ICU_GPT-1.0 are both decision support; the triage product differs. Since v1.14 (Q4)
    # every demo card states its performance measure, and these three measure three different things.
    assert body["card_reasons"] == [
        {"code": "function_category_differs", "cards": [VANTREL]},
        {"code": "measure_differs", "cards": [ICU, VANTREL]},
    ]
    assert all(row["reasons"][:2] == body["card_reasons"] and not row["comparable"] for row in body["rows"])
    same = compare(demo_client, f"{SYN},{SYN1}").json()
    assert same["card_reasons"] == []


def test_function_category_unknown(client):
    """The seed registry states no function category."""
    body = compare(client, f"{SYN},{ICU}").json()
    assert body["card_reasons"] == [{"code": "function_category_unknown", "cards": [SYN, ICU]}]


def test_population_differs_and_no_result(demo_client):
    """A product stores the all-population lens only: at a group it has no data, while the model has."""
    body = compare(demo_client, f"{SYN1},{VANTREL}", age="Age 65+").json()
    assert {"code": "population_differs", "cards": [VANTREL]} in body["card_reasons"]
    for row in body["rows"]:
        assert row["cells"][1]["status"] == "no_data" and row["cells"][1]["perf"] is None
        assert reason(row, "no_result")["cards"][-1] == VANTREL
    # At all patients both store the lens: no population reason.
    assert not any(item["code"] == "population_differs" for item in compare(demo_client, f"{SYN1},{VANTREL}").json()["card_reasons"])


def test_out_of_scope(demo_client):
    body = compare(demo_client, f"{ICU},{RAD}").json()
    flagged = [row for row in body["rows"] if reason(row, "out_of_scope")]
    assert flagged, "radAIology-1 states an intended use outside most chapters"
    for row in flagged:
        concerned = reason(row, "out_of_scope")["cards"]
        assert all(row["cells"][[ICU, RAD].index(card)]["status"] == "out_of_scope" for card in concerned)
        assert not row["comparable"]


def test_design_differs(demo_client):
    """Neoplasms: radAIology-1's rows link an independent randomized trial (§22), the others test cases."""
    body = compare(demo_client, f"{SYN},{ICU},{RAD}").json()
    neoplasms = next(row for row in body["rows"] if row["chapter_no"] == "02")
    groups = [cell["design_group"] for cell in neoplasms["cells"]]
    assert reason(neoplasms, "design_differs") is not None
    reference = max(set(g for g in groups if g), key=lambda g: (groups.count(g), -groups.index(g)))
    expected = [card for card, cell in zip((SYN, ICU, RAD), neoplasms["cells"]) if cell["design_group"] not in (None, reference) and cell["status"] in rule.RESULT_STATUSES]
    assert reason(neoplasms, "design_differs")["cards"] == expected


def test_linked_study_design_decides_the_group(demo_client):
    """A stored row that links a study takes the study's design group (§22, §25): CA40 links RAD-RCT-2026."""
    rows = compare(demo_client, f"{ICU},{RAD}", scope="chapter", chapter_id="CH-12").json()["rows"]
    designs = {cell["study_design"] for row in rows for cell in row["cells"] if cell["study_design"]}
    assert "randomized_trial" in designs
    for row in rows:
        for cell in row["cells"]:
            if cell["study_design"]:
                assert cell["design_group"] == design_group(None, cell["study_design"])


def test_no_mapping_and_mapped_broader(ontology_demo_client):
    response = compare(ontology_demo_client, f"{SYN},{ICU}", scope="chapter", chapter_id="CM-CH-04", ontology="icd10cm")
    assert response.status_code == 200, response.text
    assert response.headers["x-ontology"] == "icd10cm"
    body = response.json()
    assert body["ontology"] == {"id": "icd10cm", "name": "ICD-10-CM"}
    by_id = {row["concept_id"]: row for row in body["rows"]}
    # E12 has no WHO ICD-10 code (none); E14 maps to an ICD-11 subchapter (block); E11 is exact.
    shared = [item["code"] for item in body["card_reasons"]]  # since v1.14 the cards' measures differ (Q4)
    assert by_id["E12"]["mapping"] == "none" and codes(by_id["E12"]) == [*shared, "no_mapping"]
    assert reason(by_id["E12"], "no_mapping")["cards"] == [SYN, ICU]
    assert all(cell["status"] == "no_data" for cell in by_id["E12"]["cells"])
    assert by_id["E14"]["mapping"] == "block" and "mapped_broader" in codes(by_id["E14"])
    assert by_id["E11"]["mapping"] == "exact" and "mapped_broader" not in codes(by_id["E11"])
    # Blocks are rollups: no mapping kind of their own unless nothing under them maps.
    assert all(row["mapping"] in (None, "none") for row in body["rows"] if row["level"] == 1)


def test_reason_rules_with_constructed_cells():
    """Every row-level reason, including lens fallback, which the demo data never produces
    (every card stores either all 90 lenses or the all-population lens only)."""
    cards = [_facts(f"M{i}|F", "decision_support") for i in range(3)]

    def cell(status="strong", perf=0.8, group="test_cases", fallback=False):
        return {"status": status, "perf": perf, "design_group": group, "lens_fallback": fallback}

    assert row_reasons(cards, [cell(), cell(), cell()], None, 2) == []
    assert row_reasons(cards, [cell(), cell(), cell()], "none", 2) == [{"code": "no_mapping", "cards": ["M0|F", "M1|F", "M2|F"]}]
    assert row_reasons(cards, [cell(), cell(), cell()], "parent", 2) == [{"code": "mapped_broader", "cards": ["M0|F", "M1|F", "M2|F"]}]
    assert row_reasons(cards, [cell(), cell(), cell()], "block", 1) == []  # a rollup is not a mapped condition
    assert row_reasons(cards, [cell(), cell(status="no_data", perf=None, group=None), cell()], None, 2) == [{"code": "no_result", "cards": ["M1|F"]}]
    assert row_reasons(cards, [cell(status="out_of_scope"), cell(), cell()], None, 2) == [{"code": "out_of_scope", "cards": ["M0|F"]}]
    assert row_reasons(cards, [cell(fallback=True), cell(), cell()], None, 2) == [{"code": "lens_fallback", "cards": ["M0|F"]}]
    # Every card fell back: they describe the group the same way.
    assert row_reasons(cards, [cell(fallback=True)] * 3, None, 2) == []
    assert row_reasons(cards, [cell(group="clinical_study"), cell(), cell()], None, 2) == [{"code": "design_differs", "cards": ["M0|F"]}]
    # Ties go to the first card's group; a result without a group takes no part.
    assert row_reasons(cards[:2], [cell(group="clinical_study"), cell()], None, 2) == [{"code": "design_differs", "cards": ["M1|F"]}]
    assert row_reasons(cards, [cell(group=None), cell(), cell()], None, 2) == []
    # Order: no_result before out_of_scope before lens_fallback before design_differs.
    mixed = [cell(status="no_data", perf=None, group=None), cell(status="out_of_scope"), cell(fallback=True, group="clinical_study"), ]
    assert [r["code"] for r in row_reasons(cards, mixed, None, 2)] == ["no_result", "out_of_scope"]
    assert perf_spread([cell(perf=0.7), cell(perf=0.9), cell(status="out_of_scope", perf=0.1)]) == 0.2
    assert perf_spread([cell(perf=0.7), cell(status="no_data", perf=None)]) is None


def test_card_reason_rules():
    lens = Lens(age="Age 65+")
    decision, triage, unknown = _facts("A|F", "decision_support"), _facts("B|F", "triage"), _facts("C|F", None)
    assert card_reasons([decision, _facts("D|F", "decision_support")], ALL_POPULATIONS) == []
    assert card_reasons([decision, triage], ALL_POPULATIONS) == [{"code": "function_category_differs", "cards": ["B|F"]}]
    assert card_reasons([decision, unknown], ALL_POPULATIONS) == [{"code": "function_category_unknown", "cards": ["C|F"]}]
    product = _facts("P|F", "decision_support", lens_state="none")
    assert card_reasons([decision, product], lens) == [{"code": "population_differs", "cards": ["P|F"]}]
    # Nobody has the group: no difference in population, only no results.
    assert card_reasons([_facts("Q|F", "triage", lens_state="none"), _facts("R|F", "triage", lens_state="none")], lens) == []
    assert card_reasons([decision, product], ALL_POPULATIONS) == []


def test_design_groups_cover_every_design_and_type():
    assert design_group("clinical_study_multisite", None) == "clinical_study"
    assert design_group("vignette_study", None) == "test_cases"
    assert design_group("internal_test", None) == "internal_test"
    assert design_group("internal_test", "randomized_trial") == "clinical_study"  # the linked study wins
    assert set(rule._GROUP_OF_TYPE) == set(rule.grading.VALIDATION_TYPE_SCORES)


def _facts(card_id: str, category: str | None, lens_state: str = "stored") -> CardFacts:
    class Variant:
        function_category = category
        performance_measure = None

    return CardFacts(CardRef(card_id, None, Variant()), None, None, lens_state)


# -------------------------------------------------------------- the inputs

@pytest.mark.parametrize(
    ("cards", "params", "status", "code"),
    [
        (SYN, {}, 422, "invalid_cards"),
        (",".join([SYN, ICU, RAD, VANTREL, MEDICORE_DOC]), {}, 422, "invalid_cards"),
        (f"{SYN},{SYN}", {}, 422, "invalid_cards"),
        (f"{SYN},SynGPT-2.0", {}, 422, "invalid_cards"),
        (f"{SYN},", {}, 422, "invalid_cards"),
        (f"{SYN},{ICU}", {"scope": "chapter"}, 422, "missing_chapter_id"),
        (f"{SYN},{ICU}", {"scope": "galaxy"}, 422, "invalid_scope"),
        (f"{SYN},{ICU}", {"age": "Age 100+"}, 422, "invalid_lens"),
        (f"{SYN},{ICU}", {"population": "Not An Id"}, 422, "invalid_parameter"),
        (f"{SYN},{ICU}", {"version": "draft"}, 422, "invalid_version"),
        (f"{SYN},Nope-1|CDSS", {}, 404, "unknown_model"),
        (f"{SYN},SynGPT-2.0|Nope", {}, 404, "unknown_use_case"),
        (f"{SYN},{ICU}", {"scope": "chapter", "chapter_id": "BLK-01-BlockL1-1A0"}, 404, "unknown_concept"),
        (f"{SYN},{ICU}", {"population": "nowhere"}, 404, "unknown_population"),
        (f"{SYN},{ICU}", {"ontology": "snomed"}, 404, "unknown_ontology"),
        (f"{SYN},{ICU}", {"version": "staged:upload-1"}, 404, "unknown_upload"),
    ],
)
def test_invalid_inputs(demo_client, cards, params, status, code):
    response = compare(demo_client, cards, **params)
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == code


# ------------------------------------------------------- keying and caching

def test_population_keys_the_answer(demo_client):
    default = compare(demo_client, f"{SYN},{ICU}")
    local = compare(demo_client, f"{SYN},{ICU}", population="northbridge-region")
    assert local.status_code == 200 and local.headers["x-population"] == "northbridge-region"
    assert local.json()["population"]["id"] == "northbridge-region" and "population" not in default.json()
    assert local.headers["etag"] != default.headers["etag"]


def test_ontology_keys_the_answer(ontology_demo_client):
    icd = compare(ontology_demo_client, f"{SYN},{ICU}")
    mondo = compare(ontology_demo_client, f"{SYN},{ICU}", ontology="mondo")
    assert mondo.headers["x-ontology"] == "mondo" and mondo.headers["etag"] != icd.headers["etag"]
    assert [row["concept_id"] for row in mondo.json()["rows"]] == ["MONDO:0005066", "MONDO:0004995"]
    # icd11 is the same as no ontology: byte for byte.
    assert compare(ontology_demo_client, f"{SYN},{ICU}", ontology="icd11").content == icd.content


def test_conditional_get_and_cache(demo_client):
    first = compare(demo_client, f"{SYN},{RAD}")
    again = demo_client.get(f"{API_PREFIX}/compare", params={"cards": f"{SYN},{RAD}"}, headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304 and again.headers["etag"] == first.headers["etag"]
    # Card order is part of the request: the columns follow it.
    swapped = compare(demo_client, f"{RAD},{SYN}").json()
    assert [card["card_id"] for card in swapped["cards"]] == [RAD, SYN]


def test_meta_publishes_the_rule(demo_client):
    meta = demo_client.get(f"{API_PREFIX}/meta").json()["comparison"]
    assert meta["min_cards"] == 2 and meta["max_cards"] == 4 and meta["heuristic"] is True
    assert meta["reasons"] == list(rule.REASONS)
    assert meta["design_groups"]["clinical_study"]["study_designs"] == ["retrospective", "prospective", "real_world_deployment", "randomized_trial"]


# ----------------------------------------------------------------- budgets

@pytest.mark.slow
def test_comparison_budgets(demo_db):
    """Four cards, warm (the store loaded, the response cache unable to answer):
    p95 below 300 ms at atlas and at chapter scope on the demo store, and every
    answer below 2 MB."""
    with local_client(create_app(demo_db[0], uploads_dir=demo_db[1].uploads_dir)) as client:
        meta = client.get(f"{API_PREFIX}/meta").json()
        chapters = [chapter["concept_id"] for chapter in meta["chapters"]]
        axes = meta["axes"]
        lenses = [{"age": a, "sex": s, "ethnicity": e} for a in axes["age"] for s in axes["sex"] for e in axes["ethnicity"]]
        cards = [f"{model['model_version']}|{use_case['use_case']}" for model in client.get(f"{API_PREFIX}/models").json()["models"] for use_case in model["use_cases"]]
        rng = random.Random(20261020)
        compare(client, FOUR)  # warm the store and the four cards' services
        results = {}
        for name, extra in (("atlas", lambda: {}), ("chapter", lambda: {"scope": "chapter", "chapter_id": rng.choice(chapters)})):
            timings, largest = [], 0
            seen = set()
            while len(timings) < 30:
                params = {"cards": ",".join(rng.sample(cards, 4)), **rng.choice(lenses), **extra()}
                key = tuple(sorted(params.items()))
                if key in seen:
                    continue
                seen.add(key)
                started = time.perf_counter()
                response = client.get(f"{API_PREFIX}/compare", params=params)
                timings.append((time.perf_counter() - started) * 1000)
                assert response.status_code == 200, response.text[:200]
                largest = max(largest, len(response.content))
            timings.sort()
            p50, p95 = timings[len(timings) // 2], timings[int(len(timings) * 0.95) - 1]
            results[name] = (p50, p95, largest)
            record_budget(f"time  compare, 4 cards ({name:<7}) p50 {p50:6.1f} ms  p95 {p95:6.1f} ms  max size {largest / 1000:.0f} KB  (demo store, n=30, uncached)")
        largest_chapter = max(
            len(compare(client, FOUR, scope="chapter", chapter_id=chapter).content) for chapter in chapters
        )
        record_budget(f"size  compare, 4 cards, largest ICD-11 chapter {largest_chapter / 1000:.0f} KB")
        assert largest_chapter <= 2_000_000
        for name, (_, p95, size) in results.items():
            assert p95 <= TARGET_MS, f"{name}: p95 {p95:.1f} ms > {TARGET_MS} ms"
            assert size <= 2_000_000
