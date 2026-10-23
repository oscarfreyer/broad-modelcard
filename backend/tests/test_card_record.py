"""The card record and its JSON-LD form (contract v1.14, CONTRACT.md §32.1, §32.3)."""

from __future__ import annotations

import json

import pytest

from app.main import API_PREFIX
from app.schema.contract import CARD_RECORD_NOTICE
from app.services.card_record import MCRO_TERMS

RECORD = f"{API_PREFIX}/cards/record"
SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
MAX_RECORD_BYTES = 300 * 1024

# Every MCRO term the JSON-LD uses, with its rdfs:label in mcro.ttl of
# github.com/UTHealth-Ontology/MCRO (read 2026-10-22 with a web fetch; the
# prefix obo: is http://purl.obolibrary.org/obo/). CONTRACT.md §32.3 lists them.
EXPECTED_MCRO = {
    "MCRO_0000001": "Model Card Report",
    "MCRO_0000021": "Model Detail Section",
    "MCRO_0000040": "Version Information Section",
    "MCRO_0000038": "Use Case Information Section",
    "MCRO_0000031": "Quantative Analysis Section",
    "MCRO_0000027": "Performance Metric Information Section",
    "MCRO_0000008": "Evaluation Data Information Section",
    "MCRO_0000045": "documentation",
    "MCRO_0000049": "performance metric value",
}


def record(client, card=SYN, **params):
    response = client.get(RECORD, params={**card, **params})
    assert response.status_code == 200, response.text[:300]
    return response


def test_the_record_holds_the_card_for_operational_systems(demo_client):
    response = record(demo_client)
    body = response.json()
    assert body["format"] == "bmc-card-record/1"
    assert body["generated"]["notice"] == CARD_RECORD_NOTICE
    assert "Synthetic" in body["generated"]["notice"] and "Not a certification" in body["generated"]["notice"]
    assert body["generated"]["lens"] == {"context": "Clinical", "age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities"}
    assert body["card_id"] == "SynGPT-2.0|Clinician Facing CDSS" and body["dataset_version"] == response.headers["X-Dataset-Version"]
    system = body["system"]
    assert system["kind"] == "model" and system["replaces"] == "SynGPT-1.0" and system["developer"]
    card = body["card"]
    assert card["function_category"] == "decision_support" and card["performance_measure"] == "Top-3 diagnostic accuracy"
    assert card["configuration"]["configuration_id"] == "cfg-2025-06-cdss"
    assert card["intended_use_defined"] is False
    # The atlas link opens the figures the record reports.
    assert body["links"]["atlas"] == "atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&view=overall"
    assert body["links"]["record_jsonld"].endswith("format=jsonld")


def test_counts_and_chapters_equal_what_the_catalogue_and_atlas_serve(demo_client):
    body = record(demo_client).json()
    tile = next(tile for tile in demo_client.get(f"{API_PREFIX}/catalogue").json()["tiles"] if tile["card_id"] == body["card_id"])
    summary = body["summary"]
    for view in ("overall", "performance", "evidence", "intended_use"):
        assert summary[view] == tile["distribution"][view]
    overall = demo_client.get(f"{API_PREFIX}/metrics/summary", params=SYN).json()
    assert summary["overall"] == overall["counts"] and summary["condition_count"] == overall["total"]
    chapters = demo_client.get(f"{API_PREFIX}/atlas/overview").json()["chapters"]
    assert [chapter["chapter_id"] for chapter in body["chapters"]] == [chapter["concept_id"] for chapter in chapters]
    first = body["chapters"][0]
    concept = demo_client.get(f"{API_PREFIX}/metrics/concepts/{first['chapter_id']}", params=SYN).json()["metrics"]
    assert first["overall"] == concept["status"]["overall"] and first["perf"] == concept["perf"]
    assert first["overall_counts"] == next(chapter for chapter in tile["chapters"] if chapter["chapter_id"] == first["chapter_id"])["overall"]


def test_studies_effects_and_public_incidents_of_the_card(demo_client):
    body = record(demo_client).json()
    study_ids = {study["study_id"] for study in body["studies"]}
    assert "NBR-2026-01" in study_ids and all(study["scope"] == "public" for study in body["studies"])
    # Pack v2's three incidents and pack v11's incident history (SI-2026-017 to -020, §30).
    assert {incident["incident_id"] for incident in body["incidents"]} == {
        "SI-2026-001", "SI-2026-002", "SI-2026-003", "SI-2026-017", "SI-2026-018", "SI-2026-019", "SI-2026-020",
    }
    # Safety marks follow the listed incidents: chapter 06 has the mitigated drift notice.
    chapter_06 = next(chapter for chapter in body["chapters"] if chapter["chapter_no"] == "06")
    assert chapter_06["safety"] == "caution"
    vantrel = record(demo_client, {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}).json()
    assert vantrel["effects"] and all(effect["model_version"] == "Vantrel-Triage-2.1" for effect in vantrel["effects"])
    # A hospital's own incident is a local layer: never in the public record.
    icu = record(demo_client, ICU).json()
    assert icu["incidents"] and all(incident["scope"] == "public" for incident in icu["incidents"])


def test_every_demo_record_stays_within_its_budget(demo_client):
    for tile in demo_client.get(f"{API_PREFIX}/catalogue").json()["tiles"]:
        response = record(demo_client, {"model": tile["model_version"], "use_case": tile["use_case"]})
        assert len(response.content) < MAX_RECORD_BYTES, (tile["card_id"], len(response.content))
        jsonld = record(demo_client, {"model": tile["model_version"], "use_case": tile["use_case"]}, format="jsonld")
        assert len(jsonld.content) < MAX_RECORD_BYTES


def test_etag_dataset_version_and_not_modified(demo_client):
    response = record(demo_client)
    assert response.headers["ETag"] and response.headers["X-Dataset-Version"]
    again = demo_client.get(RECORD, params=SYN, headers={"If-None-Match": response.headers["ETag"]})
    assert again.status_code == 304 and again.headers["X-Dataset-Version"] == response.headers["X-Dataset-Version"]


def test_unknown_cards_and_formats(demo_client):
    assert demo_client.get(RECORD, params={"model": "Nope-1", "use_case": "CDSS"}).json()["code"] == "unknown_model"
    assert demo_client.get(RECORD, params={"model": "SynGPT-2.0", "use_case": "Nope"}).status_code == 404
    assert demo_client.get(RECORD, params={**SYN, "format": "xml"}).status_code == 422
    assert demo_client.get(RECORD, params={"model": "SynGPT-2.0"}).status_code == 422


def test_jsonld_parses_and_carries_the_same_content(demo_client):
    plain = record(demo_client).json()
    response = record(demo_client, format="jsonld")
    assert response.headers["content-type"].startswith("application/ld+json")
    body = json.loads(response.content)
    context = body["@context"]
    assert body["@type"] == "obo:MCRO_0000001"
    assert context["obo"] == "http://purl.obolibrary.org/obo/" and context["@vocab"].startswith("https://broad-modelcard.example/")
    assert body["@id"].startswith("https://broad-modelcard.example/cards/")
    assert body["system"]["@type"] == "obo:MCRO_0000021" and body["card"]["@type"] == "obo:MCRO_0000038"
    assert body["summary"]["@type"] == "obo:MCRO_0000031"
    assert all(chapter["@type"] == "obo:MCRO_0000027" for chapter in body["chapters"])
    assert context["perf"]["@id"] == "obo:MCRO_0000049"

    def strip(node):
        if isinstance(node, dict):
            return {key: strip(value) for key, value in node.items() if not key.startswith("@")}
        if isinstance(node, list):
            return [strip(item) for item in node]
        return node

    assert strip(body) == plain


def test_the_mcro_terms_are_pinned_and_each_is_used(demo_client):
    assert MCRO_TERMS == EXPECTED_MCRO
    text = record(demo_client, format="jsonld").text
    for term in MCRO_TERMS:
        assert f"obo:{term}" in text, term


@pytest.mark.parametrize("card", [SYN, ICU])
def test_the_seed_store_serves_records_too(client, card):
    body = record(client, card).json()
    assert body["studies"] == [] and body["links"]["narrow_model_card"] is None
