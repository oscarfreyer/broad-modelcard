"""Demo pack v13 (release 0.5): two fictional products for the
function categories contract v1.14 added, Parlowe Answers 1.0 (Patient communication) and Tallyfern
Coding 1.4 (Administrative), published through the normal upload, check, and publish path with their
studies, results at Any setting and at specific care settings, and an incident. The rules keyed on
function names (CONTRACT.md §4.2, §4.6) are untouched. All data is synthetic and every name fictional."""

from __future__ import annotations

import csv
import hashlib
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import local_client

from app.demo.builder import PACK_DIR
from app.main import API_PREFIX, create_app

PARLOWE = "Parlowe-Answers-1.0|Patient question answering"
TALLYFERN = "Tallyfern-Coding-1.4|Clinical coding support"
SYN_CDSS = "SynGPT-2.0|Clinician Facing CDSS"
STUDY_OF = {PARLOWE: "PARL-QA-2026", TALLYFERN: "TALLY-CODE-2026"}
FILES = {
    PARLOWE: PACK_DIR / "v13" / "metrics" / "parlowe-answers-1-0.patient-question-answering.csv",
    TALLYFERN: PACK_DIR / "v13" / "metrics" / "tallyfern-coding-1-4.clinical-coding-support.csv",
}


def get(client, path, params=None, status=200):
    response = client.get(f"{API_PREFIX}{path}", params=params or {})
    assert response.status_code == status, response.text[:400]
    return response.json()


def card_params(card: str, **extra) -> dict:
    model, use_case = card.split("|")
    return {"model": model, "use_case": use_case, **extra}


def pack_rows(card: str) -> list[dict]:
    with open(FILES[card], newline="", encoding="utf-8") as handle:
        body = [line for line in csv.reader(handle) if line and not line[0].startswith("#")]
    return [dict(zip(body[0], line, strict=True)) for line in body[1:]]


@pytest.fixture(scope="module")
def demo_client(demo_db):
    store, _ = demo_db
    with local_client(create_app(store, validate_responses=True)) as client:
        yield client


def test_the_new_products_and_their_categories(demo_client):
    entries = {model["model_version"]: model for model in get(demo_client, "/models")["models"]}
    parlowe, tallyfern = entries["Parlowe-Answers-1.0"], entries["Tallyfern-Coding-1.4"]
    assert (parlowe["kind"], parlowe["ai_type"], parlowe["built_on"]) == ("product", "llm", ["SynGPT-2.0"])
    assert (tallyfern["kind"], tallyfern["ai_type"], tallyfern["built_on"]) == ("product", "hybrid", ["MediCore-2.5"])
    (answers,) = parlowe["use_cases"]
    (coding,) = tallyfern["use_cases"]
    assert (answers["use_case"], answers["function_category"]) == ("Patient question answering", "patient_communication")
    assert (coding["use_case"], coding["function_category"]) == ("Clinical coding support", "administrative")
    # One card with an intended-use statement, one without (contract v1.11).
    assert answers["intended_use_defined"] is True and coding["intended_use_defined"] is False
    for entry, card in ((parlowe, answers), (tallyfern, coding)):
        assert entry["developer"].endswith("(fictional)") and entry["release_date"] and "product" in entry["description"]
        record = card["configuration"]
        assert record["configuration_id"].startswith("cfg-") and record["configuration_date"] and record["tools"]
        assert "fictional" in record["prompt_summary"] and len(record["prompt_sha256"]) == 64
        assert card["performance_measure"] and card["reference_standard"]
        declarations = card["declarations"]
        assert all(declarations[name] for name in ("declared_data_use", "declared_data_location", "declared_retention", "declared_privacy_contact"))
        assert declarations["declared_privacy_contact"].endswith(".example") and ".example/" in declarations["declared_documentation_url"]
        assert declarations["declared_regulatory_status"] == "Not assessed (demonstration)"
    assert answers["performance_measure"] == "Answer accuracy rated by clinicians"
    assert coding["performance_measure"] == "Agreement with coded discharge diagnoses"
    # Settings stored for each card (§29).
    assert answers["settings"] == ["Clinical", "Outpatient clinic", "Primary care"]
    assert coding["settings"] == ["Clinical", "Inpatient ward"]


def test_each_card_links_a_new_study_with_the_v114_fields(demo_client):
    studies = {study["study_id"]: study for study in get(demo_client, "/studies")["studies"]}
    expected = {
        "PARL-QA-2026": ("Parlowe-Answers-1.0", "cfg-parlowe-2026-04", "unclear", "appraise_ai"),
        "TALLY-CODE-2026": ("Tallyfern-Coding-1.4", "cfg-tallyfern-2026-06", "low", "other"),
    }
    for study_id, (model_version, configuration, applicability, tool) in expected.items():
        study = studies[study_id]
        assert (study["model_version"], study["configuration_id"], study["applicability"], study["quality_tool"]) == (
            model_version, configuration, applicability, tool,
        )
        assert study["setting_category"] == "mixed" and study["applicability_notes"]
        assert "fictional" in study["title"] and study["source_url"] == f"https://studies.example/{study_id.lower()}"
    assert studies["PARL-QA-2026"]["quality_score"] == 68 and "quality_score" not in studies["TALLY-CODE-2026"]


@pytest.mark.parametrize("card", [PARLOWE, TALLYFERN])
def test_every_row_with_performance_carries_its_studys_evidence(demo_client, card):
    """Each pack row names its card's study, so it is linked and graded, and its counts follow the study."""
    study = get(demo_client, f"/studies/{STUDY_OF[card]}")["study"]
    rows = pack_rows(card)
    assert rows and all(row["Performance"] and row["Validation type"] == "Clinical study (multisite)" for row in rows)
    for row in rows:
        assert row["Study"] == study["study_id"] and row["Studies"] == "1" and int(row["Samples"]) <= study["patients"]
        assert int(row["Sites"]) <= study["sites"] and row["Peer-reviewed studies"] == ("1" if study["peer_reviewed"] else "0")
    summary = get(demo_client, "/metrics/summary", card_params(card))
    stored = sum(row["Setting"] == "Any setting" for row in rows)
    assert summary["appraisal_counts"] == {"graded": stored, "linked": stored}
    assert summary["configuration_counts"] == {"current": stored, "earlier": 0, "not_stated": 0}
    # The served rows: evidence, the link, no setting row in Any setting.
    for row in rows[:5] + rows[-5:]:
        metrics = get(demo_client, f"/metrics/concepts/{row['ICD-11 code']}", card_params(card, context=_context(row["Setting"])))["metrics"]
        assert metrics["validation_type"] and metrics["evidence_grade"] and metrics["appraisal"]["study"]["study_id"] == study["study_id"]
        assert metrics["context"] == _context(row["Setting"])


def _context(setting: str) -> str:
    return "Clinical" if setting == "Any setting" else setting


def test_the_conditions_and_settings_are_believable(demo_client):
    parlowe = get(demo_client, "/metrics/summary", card_params(PARLOWE))["counts"]
    assert parlowe["out_of_scope"] == 3 and 2400 - parlowe["no_data"] == 51  # common conditions; three emergencies out of scope
    for code in ("BA41", "8B20", "1G40"):
        row = get(demo_client, f"/metrics/concepts/{code}", card_params(PARLOWE))["metrics"]
        assert row["intended_use_level"] == "out_of_scope" and row["status"]["overall"] == "out_of_scope"
    tallyfern = get(demo_client, "/metrics/summary", card_params(TALLYFERN))["counts"]
    assert tallyfern["out_of_scope"] == 0 and 700 <= 2400 - tallyfern["no_data"] <= 900  # a broad set
    # From every chapter (the ICD-11 code's first character names most chapters).
    assert len({row["ICD-11 code"][0] for row in pack_rows(TALLYFERN)}) >= 20
    for card, setting, low, high in ((PARLOWE, "Primary care", 30, 30), (PARLOWE, "Outpatient clinic", 16, 16), (TALLYFERN, "Inpatient ward", 90, 160)):
        counts = get(demo_client, "/metrics/summary", card_params(card, context=setting))["counts"]
        assert low <= 2400 - counts["no_data"] <= high, (card, setting, counts)
    # A setting the card stores nothing for reads No data.
    counts = get(demo_client, "/metrics/summary", card_params(TALLYFERN, context="Primary care"))["counts"]
    assert counts["no_data"] == 2400
    # Without an intended-use statement every row scores without intended use.
    coded = get(demo_client, "/metrics/concepts/5A11", card_params(TALLYFERN))["metrics"]
    assert coded is None or coded["intended_use_level"] is None


def test_the_rules_keyed_on_function_names_are_unchanged(demo_client):
    """§4.6: cdss-governance stays keyed on the CDSS function names, never on a category."""
    for card in (PARLOWE, TALLYFERN):
        code = pack_rows(card)[0]["ICD-11 code"]
        row = get(demo_client, f"/metrics/concepts/{code}", card_params(card))["metrics"]
        assert "cdss-governance" not in {safeguard["id"] for safeguard in row["safeguards"]}
    syn = get(demo_client, "/metrics/concepts/5A11", card_params(SYN_CDSS))["metrics"]
    assert "cdss-governance" in {safeguard["id"] for safeguard in syn["safeguards"]}


def test_the_coding_product_and_decision_support_are_not_directly_comparable(demo_client):
    """G11: a comparison of the coding product with SynGPT-2.0 decision support flags the different
    function category (and the different measures, Q4)."""
    body = get(demo_client, "/compare", {"cards": f"{TALLYFERN},{SYN_CDSS}"})
    reasons = {reason["code"]: reason["cards"] for reason in body["card_reasons"]}
    assert reasons["function_category_differs"] == [SYN_CDSS]
    assert reasons["measure_differs"] == [SYN_CDSS]
    facts = {card["card_id"]: card for card in body["cards"]}
    assert facts[TALLYFERN]["function_category"] == "administrative"
    assert facts[SYN_CDSS]["function_category"] == "decision_support"
    # The patient product against decision support as well.
    reasons = {reason["code"] for reason in get(demo_client, "/compare", {"cards": f"{PARLOWE},{SYN_CDSS}"})["card_reasons"]}
    assert "function_category_differs" in reasons


def test_the_catalogue_tiles_and_the_incident(demo_client):
    tiles = {tile["card_id"]: tile for tile in get(demo_client, "/catalogue")["tiles"]}
    assert tiles[PARLOWE]["function_category"] == "patient_communication"
    assert tiles[TALLYFERN]["function_category"] == "administrative"
    assert tiles[TALLYFERN]["distribution"]["intended_use"] is None
    assert tiles[PARLOWE]["safety"]["mitigated"] == 1
    incidents = get(demo_client, "/incidents", card_params(PARLOWE))["incidents"]
    assert [(incident["incident_id"], incident["status"]) for incident in incidents] == [("SI-2026-021", "mitigated")]
    assert incidents[0]["summary"].startswith("Synthetic example")
    assert get(demo_client, "/incidents", card_params(TALLYFERN))["incidents"] == []


def test_the_v13_registry_carries_every_v8_entry_unchanged():
    """A registry upload replaces the whole list, so pack v13's file repeats pack v8's lines byte for byte."""
    v8 = [line for line in (PACK_DIR / "v8" / "registry.csv").read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]
    v13 = [line for line in (PACK_DIR / "v13" / "registry.csv").read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]
    assert v13[: len(v8)] == v8 and len(v13) == len(v8) + 2


def test_the_pack_tool_is_reproducible(tmp_path):
    """make_pack_v13.py rewrites the committed files byte for byte."""
    files = sorted((PACK_DIR / "v13").rglob("*.csv"))
    before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
    result = subprocess.run([sys.executable, str(PACK_DIR / "tools" / "make_pack_v13.py")], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in files} == before
    assert sorted((PACK_DIR / "v13").rglob("*.csv")) == files


def test_function_words_say_nothing_about_decision_support():
    """The new cards' copy names their own purpose, never clinical decision support."""
    text = (PACK_DIR / "v13" / "registry.csv").read_text(encoding="utf-8").splitlines()[-2:]
    assert not any("decision support" in line.lower() or "CDSS" in line for line in text)
    assert all(Path(path).is_file() for path in FILES.values())
