"""Comparison depth (contract v1.14, CONTRACT.md §25; release 0.5 phase Q4).

The card-level reasons ``measure_differs`` and ``measure_unknown``, the
row-level reason ``setting_differs``, the cells' ``layer`` and
``setting_category``, and the card facts ``performance_measure``,
``reference_standard``, ``configuration``, ``narrow_model_card``, and
``conductors``. Through the API on the demo store (and a private copy of it
for the cases that need a publish), and through the rule's functions with
constructed facts and cells. All data is synthetic.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from admin_helpers import ADMIN, wait
from conftest import copy_store, local_client

from app.main import API_PREFIX, create_app
from app.services.comparison import CardFacts, CardRef, card_reasons, measure_reasons, row_reasons, setting_reasons
from app.services.types import ALL_POPULATIONS, Lens

SYN = "SynGPT-2.0|Clinician Facing CDSS"
SYN1 = "SynGPT-1.0|Clinician Facing CDSS"
SYN_LETTERS = "SynGPT-2.0|Discharge letter generation"
MEDICORE_DOC = "MediCore-2.5|Discharge letter generation"
ICU = "ICU_GPT-1.0|CDSS"
RAD = "radAIology-1|Radiology image analysis"
SKIN = "SkinAI-1.0|Skin lesion CDSS"
DOAI = "DoAIHaveCancer-1.0|Skin lesion CDSS"  # the one demo card without a configuration record
VANTREL = "Vantrel-Triage-2.1|Emergency department triage"
NORTHBRIDGE = "northbridge-region"


def compare(client, cards: str, **params) -> dict:
    response = client.get(f"{API_PREFIX}/compare", params={"cards": cards, **params})
    assert response.status_code == 200, response.text
    return response.json()


def reason(row: dict, code: str) -> dict | None:
    return next((item for item in row["reasons"] if item["code"] == code), None)


CASES = json.loads((Path(__file__).parent / "fixtures" / "comparison_rule_cases.json").read_text(encoding="utf-8"))
LENSES = {"all": ALL_POPULATIONS, "age": Lens(age="Age 65+")}


def _facts(card: dict) -> CardFacts:
    variant = SimpleNamespace(function_category=card["function_category"], performance_measure=card["performance_measure"])
    return CardFacts(CardRef(card["card_id"], None, variant), None, None, card.get("lens_state", "stored"))


def _cell(given: dict) -> dict:
    """A constructed cell: a result has a perf and the test-cases design group unless given."""
    result = given["status"] in ("strong", "moderate", "weak")
    return {"perf": 0.8 if result else None, "design_group": "test_cases" if result else None, "lens_fallback": False, **given}


# ------------------------------------------------------------- the rule

@pytest.mark.parametrize("case", CASES["card_reasons"], ids=lambda case: case["name"])
def test_card_reasons_shared_cases(case):
    """The same cases run through the static port in tests/compareDepth.test.js."""
    assert card_reasons([_facts(card) for card in case["cards"]], LENSES[case["lens"]]) == case["expected"]


@pytest.mark.parametrize("case", CASES["row_reasons"], ids=lambda case: case["name"])
def test_row_reasons_shared_cases(case):
    cards = [_facts({"card_id": f"{letter}|f", "function_category": "decision_support", "performance_measure": None}) for letter in "ABCD"]
    cells = [_cell(given) for given in case["cells"]]
    assert row_reasons(cards[: len(cells)], cells, None, 2) == case["expected"]


def test_measure_reasons_alone():
    top3 = {"function_category": "decision_support", "performance_measure": "Top-3 diagnostic accuracy"}
    assert measure_reasons([_facts({"card_id": "A|f", **top3}), _facts({"card_id": "B|f", **top3, "performance_measure": None})]) == [
        {"code": "measure_unknown", "cards": ["B|f"]}
    ]


def test_setting_reasons_alone():
    cards = [_facts({"card_id": f"{letter}|f", "function_category": None, "performance_measure": None}) for letter in "AB"]
    assert setting_reasons(cards, [_cell({"status": "strong", "setting_category": "mixed"}), _cell({"status": "strong", "setting_category": "primary_care"})]) == []


# ------------------------------------------------------------ the API

def test_measure_reasons_on_the_demo_store(demo_client):
    # Both SynGPT CDSS cards measure top-3 diagnostic accuracy.
    assert compare(demo_client, f"{SYN},{SYN1}")["card_reasons"] == []
    body = compare(demo_client, f"{SYN},{ICU}")
    assert body["card_reasons"] == [{"code": "measure_differs", "cards": [ICU]}]
    assert all(row["reasons"][0] == body["card_reasons"][0] for row in body["rows"])
    # Every demo card states a measure, so measure_unknown needs a constructed card (above).
    assert not any(item["code"] == "measure_unknown" for item in compare(demo_client, f"{SKIN},{DOAI}")["card_reasons"])


def test_card_facts(demo_client):
    syn, icu, doai = compare(demo_client, f"{SYN},{ICU},{DOAI}")["cards"]
    assert syn["performance_measure"] == "Top-3 diagnostic accuracy"
    assert syn["reference_standard"].startswith("Final diagnosis at discharge")
    assert syn["configuration"] == {"configuration_id": "cfg-2025-06-cdss", "configuration_date": "2025-06-02"}
    # A card without a configuration record leaves the key out; the measure is still stated.
    assert "configuration" not in doai and doai["performance_measure"]
    # No demo AI system has a published narrow model card (Tidewell's waits in a submission).
    assert syn["narrow_model_card"] == {"present": False, "submitted_at": None}
    # Conductors count the linked studies: ICU-RETRO-2025 by the developer.
    assert icu["conductors"] == {"developer": 1, "independent": 0, "hospital": 0}
    assert syn["conductors"] == {"developer": 0, "independent": 1, "hospital": 0}
    assert doai["conductors"] == {"developer": 0, "independent": 0, "hospital": 0} and doai["studies"] == []
    # With the local population the hospital's own study joins ICU_GPT-1.0's.
    local = compare(demo_client, f"{ICU},{SYN}", population=NORTHBRIDGE)["cards"][0]
    assert local["conductors"] == {"developer": 1, "independent": 0, "hospital": 1}


def test_cells_carry_the_linked_studys_setting(demo_client):
    rows = compare(demo_client, f"{ICU},{RAD}", scope="chapter", chapter_id="CH-12")["rows"]
    studies = {study["study_id"]: study for study in demo_client.get(f"{API_PREFIX}/studies").json()["studies"]}
    found = {cell.get("setting_category") for row in rows for cell in row["cells"]}
    # RAD-RCT-2026 is "mixed"; ICU-RETRO-2025 "intensive_care" (CA43). Rollups and unlinked rows carry none.
    assert {"mixed", "intensive_care"} <= found
    assert all("setting_category" not in cell for row in rows if row["level"] < 2 for cell in row["cells"])
    assert studies["RAD-RCT-2026"]["setting_category"] == "mixed"
    # mixed never counts, so no row of this pair is flagged for its setting.
    assert not any(reason(row, "setting_differs") for row in rows)


def test_cell_layer_marks_local_results(demo_client):
    # Without a population (or for a card without local results) no cell carries a layer: v1.13 bytes.
    default = compare(demo_client, f"{ICU},{SYN}")
    assert all("layer" not in cell for row in default["rows"] for cell in row["cells"])
    body = compare(demo_client, f"{ICU},{SYN}", population=NORTHBRIDGE)
    layers = {cell.get("layer") for row in body["rows"] for cell in [row["cells"][0]] if cell["status"] != "no_data"}
    assert "includes_local" in layers and "public" in layers
    assert all("layer" not in row["cells"][1] for row in body["rows"])  # SynGPT-2.0 has no local results
    assert all("layer" not in row["cells"][0] for row in body["rows"] if row["cells"][0]["status"] == "no_data")
    # In a chapter, the conditions served from local results read local; the map says the same.
    chapter = next(row["concept_id"] for row in body["rows"] if row["cells"][0].get("layer") == "includes_local")
    rows = compare(demo_client, f"{ICU},{SYN}", population=NORTHBRIDGE, scope="chapter", chapter_id=chapter)["rows"]
    served = demo_client.get(
        f"{API_PREFIX}/metrics/map",
        params={"model": "ICU_GPT-1.0", "use_case": "CDSS", "scope": "chapter", "chapter_id": chapter, "population": NORTHBRIDGE},
    ).json()
    by_id = dict(zip((row[0] for row in served["rows"]), served["layer"]))
    for row in rows:
        cell = row["cells"][0]
        if cell["status"] != "no_data":
            assert cell["layer"] == (by_id[row["concept_id"]] or "public")
    assert any(row["cells"][0].get("layer") == "local" for row in rows)


# ------------------------------------------- publishes on a private copy

@pytest.fixture(scope="module")
def demo_admin(demo_db, tmp_path_factory):
    root = tmp_path_factory.mktemp("compare-q4")
    store = copy_store(demo_db[0], root / "demo.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=root / "uploads")) as client:
        yield client


def _publish(client, response) -> None:
    assert response.status_code == 202, response.text
    upload = wait(client, response.json()["upload_id"])
    assert upload["status"] == "valid", upload["report"]
    published = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": "Test (synthetic)."})
    assert published.status_code == 200, published.text


def _as_record(study: dict, **changes) -> dict:
    """A stored study as a records-upload record (template keys; codes are accepted)."""
    record = {key: value for key, value in study.items() if value is not None}
    record["peer_reviewed"] = "Yes" if study["peer_reviewed"] else "No"
    return {**record, **changes}


def test_setting_differs_and_a_narrow_model_card(demo_admin):
    client = demo_admin
    studies = {study["study_id"]: study for study in client.get(f"{API_PREFIX}/studies").json()["studies"]}
    # CA40 (pneumonia) links NBR-2026-01 for SynGPT-2.0 and RAD-RCT-2026 for radAIology-1, both "mixed".
    records = [
        _as_record(studies["NBR-2026-01"], setting_category="emergency_department"),
        _as_record(studies["RAD-RCT-2026"], setting_category="inpatient_ward"),
    ]
    _publish(client, client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "records": records, "replace_staged": True}))
    card = {"name": "SynGPT-2.0 (fictional)", "version": "2.0", "intended_use": "Synthetic demonstration only."}
    _publish(client, client.post(f"{ADMIN}/uploads/model-card", json={"model_version": "SynGPT-2.0", "format": "json", "content": json.dumps(card)}))

    body = compare(client, f"{SYN},{RAD}", scope="chapter", chapter_id="CH-12")
    pneumonia = next(row for row in body["rows"] if row["concept_id"] == "CA40")
    assert [cell.get("setting_category") for cell in pneumonia["cells"]] == ["emergency_department", "inpatient_ward"]
    assert all(cell["status"] in ("strong", "moderate", "weak") for cell in pneumonia["cells"])
    assert reason(pneumonia, "setting_differs") == {"code": "setting_differs", "cards": [RAD]}  # a tie: the first card's setting
    assert pneumonia["reasons"][-1]["code"] == "setting_differs" and not pneumonia["comparable"]
    flagged = [row["concept_id"] for row in body["rows"] if reason(row, "setting_differs")]
    assert set(flagged) <= {"CA40"}
    syn = body["cards"][0]
    assert syn["narrow_model_card"]["present"] is True and syn["narrow_model_card"]["submitted_at"]
    assert body["cards"][1]["narrow_model_card"] == {"present": False, "submitted_at": None}
