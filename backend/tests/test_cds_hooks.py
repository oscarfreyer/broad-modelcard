"""The local CDS Hooks–shaped service (contract v1.14, CONTRACT.md §33).

Runs on the demo store with the fixture ontologies (tests/ontology_fixtures.py:
E11 → 5A11, I10 → BA00, E14 → the block of 5A0Q, E16 → no ICD-11 concept of
the atlas). Every request is synthetic.
"""

from __future__ import annotations

import logging
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.api.routes.cds_hooks import CdsError, parse_request
from app.main import API_PREFIX, create_app
from app.schema.contract import CDS_SYNTHETIC_LINE

DISCOVERY = f"{API_PREFIX}/cds-services"
SERVICE = f"{API_PREFIX}/cds-services/bmc-condition-status"
ICD11 = "http://id.who.int/icd/release/11/mms"
ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm"
SYN_CARD = "SynGPT-2.0|Clinician Facing CDSS"


def condition(system: str, code: str, display: str | None = None) -> dict:
    coding = {"system": system, "code": code, **({"display": display} if display else {})}
    return {"resource": {"resourceType": "Condition", "id": "c1", "code": {"coding": [coding]}, "subject": {"reference": "Patient/p1"}}}


def hook_request(conditions: list[dict], *, birth_date="1950-03-02", gender="female", card=SYN_CARD, **extension) -> dict:
    body = {
        "hook": "patient-view",
        "hookInstance": "d1577c69-dfbe-44ad-ba6d-3e05e953b2ea",
        "context": {"patientId": "synthetic-1", "userId": "Practitioner/demo"},
        "prefetch": {
            "patient": {"resourceType": "Patient", "id": "synthetic-1", "birthDate": birth_date, "gender": gender, "name": [{"text": "Synthetic"}]},
            "conditions": {"resourceType": "Bundle", "type": "searchset", "entry": conditions},
        },
    }
    if card or extension:
        body["extension"] = {"broad-modelcard": {**({"card_id": card} if card else {}), **extension}}
    return body


def test_discovery_lists_the_service(ontology_demo_client):
    response = ontology_demo_client.get(DISCOVERY)
    assert response.status_code == 200 and response.headers["X-Dataset-Version"]
    (service,) = response.json()["services"]
    assert service["id"] == "bmc-condition-status" and service["hook"] == "patient-view"
    assert set(service["prefetch"]) == {"patient", "conditions"}
    assert service["prefetch"]["conditions"].startswith("Condition?patient=")
    extension = service["extension"]["broad-modelcard"]
    assert extension["default_card"]["model_version"] and "synthetic" in extension["notice"]
    assert "access-control-allow-origin" not in {name.lower() for name in response.headers}


def test_three_icd10cm_conditions_give_one_card_each(ontology_demo_client):
    body = hook_request([condition(ICD10CM, "E11.65"), condition(ICD10CM, "I10"), condition(ICD10CM, "E14")])
    response = ontology_demo_client.post(SERVICE, json=body)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store" and response.headers["X-Dataset-Version"]
    cards = response.json()["cards"]
    assert len(cards) == 3
    for card in cards:
        assert len(card["summary"]) <= 140
        assert card["source"]["label"] == "Broad Modelcard (synthetic demonstration)"
        assert CDS_SYNTHETIC_LINE in card["detail"]
        (link,) = card["links"]
        assert link["type"] == "absolute" and link["url"].startswith("http://127.0.0.1/atlas.html?")
        assert "**Overall:" in card["detail"]
    diabetes, hypertension, block = cards
    ext = diabetes["extension"]["broad-modelcard"]
    assert ext["concept_id"] == "5A11" and ext["mapping"]["icd10cm"] == "E11.6" and ext["mapping"]["kind"] == "exact"
    assert "Mapped from ICD-10-CM E11.6 to ICD-11 5A11" in diabetes["detail"]
    # 65+ female: the open incident on hypertension for Age 65+ is Serious (harm possible).
    assert hypertension["indicator"] == "critical" and "Open incidents" in hypertension["detail"]
    assert "serious safety incident open" in hypertension["summary"]
    assert "SI-2026-001" not in hypertension["detail"]  # incidents are named by their summary, not their id
    assert "age=Age+65%2B" in hypertension["links"][0]["url"] and "sex=Sex+Female" in hypertension["links"][0]["url"]
    # The diabetes incident (ethnicity Black, open, no harm) applies at all ethnicities: Caution.
    assert diabetes["indicator"] in ("warning", "critical") and diabetes["extension"]["broad-modelcard"]["safety"] == "caution"
    assert "Top warnings" in diabetes["detail"] or "Safeguards" in diabetes["detail"]
    assert block["extension"]["broad-modelcard"]["mapping"]["kind"] == "block"


def test_statuses_equal_the_lookup(ontology_demo_client):
    body = hook_request([condition(ICD11, "5A11")], birth_date=None, gender=None)
    del body["prefetch"]["patient"]["birthDate"], body["prefetch"]["patient"]["gender"]
    (card,) = ontology_demo_client.post(SERVICE, json=body).json()["cards"]
    lookup = ontology_demo_client.post(
        f"{API_PREFIX}/lookup",
        json={"context": {"card": {"model_version": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}, "conditions": [{"code": "5A11"}]}},
    ).json()
    assert card["extension"]["broad-modelcard"]["statuses"] == lookup["conditions"][0]["statuses"]
    assert "For: All patients, Any setting." in card["detail"]
    assert "·" not in card["summary"] + card["detail"], "no dot separators"


def test_unmapped_codes_give_one_info_card(ontology_demo_client):
    body = hook_request([condition(ICD10CM, "E16"), condition(ICD11, "ZZ99"), condition("http://snomed.info/sct", "44054006")])
    cards = ontology_demo_client.post(SERVICE, json=body).json()["cards"]
    assert [card["indicator"] for card in cards] == ["info", "info", "info"]
    assert cards[0]["summary"] == "E16 (ICD-10-CM): no mapping to the atlas"
    assert "no ICD-11 mapping" in cards[0]["detail"]
    assert "not an ICD-11 condition" in cards[1]["detail"]
    assert "no ICD-11 MMS or ICD-10-CM coding" in cards[2]["detail"]
    assert all(CDS_SYNTHETIC_LINE in card["detail"] for card in cards)
    assert all(card["extension"]["broad-modelcard"]["matched"] is False for card in cards)


def test_a_store_without_icd10cm_says_so(demo_client):
    cards = demo_client.post(SERVICE, json=hook_request([condition(ICD10CM, "E11.9")])).json()["cards"]
    assert "not imported ICD-10-CM" in cards[0]["detail"]


def test_the_default_card_setting_and_population(ontology_demo_client):
    default = ontology_demo_client.post(SERVICE, json=hook_request([condition(ICD11, "5A11")], card=None)).json()["cards"][0]
    discovered = ontology_demo_client.get(DISCOVERY).json()["services"][0]["extension"]["broad-modelcard"]["default_card"]
    assert f"model={discovered['model_version']}" in default["links"][0]["url"]
    vantrel = hook_request([condition(ICD11, "8B20")], card="Vantrel-Triage-2.1|Emergency department triage", setting="emergency_department")
    card = ontology_demo_client.post(SERVICE, json=vantrel).json()["cards"][0]
    assert "setting=emergency_department" in card["links"][0]["url"] and "Emergency department" in card["detail"]
    local = hook_request([condition(ICD11, "5A11")], population="northbridge-region")
    response = ontology_demo_client.post(SERVICE, json=local)
    assert response.status_code == 200 and response.headers["X-Population"] == "northbridge-region"
    assert ontology_demo_client.post(SERVICE, json=hook_request([condition(ICD11, "5A11")], population="nowhere")).status_code == 404
    unknown = ontology_demo_client.post(SERVICE, json=hook_request([condition(ICD11, "5A11")], card="Nope-1|CDSS"))
    assert unknown.status_code == 404 and unknown.json()["code"] == "unknown_model"


@pytest.mark.parametrize(
    ("mutate", "words"),
    [
        (lambda body: body.update(hook="order-select"), "hook must be"),
        (lambda body: body.pop("hookInstance"), "hookInstance"),
        (lambda body: body.update(context=[]), "context must be"),
        (lambda body: body["context"].pop("patientId"), "patientId"),
        (lambda body: body.pop("prefetch"), "prefetch must be"),
        (lambda body: body["prefetch"].pop("conditions"), "prefetch.conditions"),
        (lambda body: body["prefetch"]["conditions"].update(resourceType="Condition"), "Bundle"),
        (lambda body: body["prefetch"]["conditions"].update(entry=[]), "1 to 12"),
        (lambda body: body["prefetch"]["conditions"].update(entry=[condition(ICD11, "5A11")] * 13), "1 to 12"),
        (lambda body: body["prefetch"]["patient"].update(birthDate="02.03.1950"), "birthDate"),
        (lambda body: body["prefetch"]["patient"].update(birthDate="2999-01-01"), "future"),
        (lambda body: body["prefetch"]["patient"].update(gender="f"), "gender"),
        # Not a string: still 400, never a 500 (review of release 0.5).
        (lambda body: body["prefetch"]["patient"].update(gender=["female"]), "gender"),
        (lambda body: body["extension"]["broad-modelcard"].update(setting=["Emergency department"]), "setting"),
        (lambda body: body["prefetch"]["patient"].update(resourceType="Practitioner"), "Patient"),
        (lambda body: body["prefetch"]["conditions"]["entry"][0]["resource"]["code"].update(coding=[]), "code.coding"),
        (lambda body: body["prefetch"]["conditions"]["entry"][0]["resource"]["code"]["coding"][0].update(code="5A11 drop"), "code.coding.code"),
        (lambda body: body["extension"]["broad-modelcard"].update(card_id="no-separator"), "card_id"),
        (lambda body: body["extension"]["broad-modelcard"].update(setting="Emergency"), "setting"),
    ],
)
def test_malformed_requests_are_400_with_a_plain_message(ontology_demo_client, mutate, words):
    body = hook_request([condition(ICD11, "5A11")])
    mutate(body)
    response = ontology_demo_client.post(SERVICE, json=body)
    assert response.status_code == 400, response.text
    problem = response.json()
    assert problem["code"] == "invalid_cds_request" and words in problem["detail"]
    assert "5A11 drop" not in problem["detail"] and "1950" not in problem["detail"]


def test_not_json_and_too_large(ontology_demo_client):
    response = ontology_demo_client.post(SERVICE, content=b"{nope", headers={"content-type": "application/json"})
    assert response.status_code == 400 and response.json()["detail"] == "The body is not valid JSON."
    big = ontology_demo_client.post(SERVICE, content=b" " * (65 * 1024), headers={"content-type": "application/json"})
    assert big.status_code == 413 and big.json()["code"] == "upload_too_large"


def test_nothing_of_the_request_is_logged(ontology_demo_client, caplog):
    caplog.set_level(logging.DEBUG)
    body = hook_request([condition(ICD10CM, "E11.65", display="Canary-display-9137")])
    ontology_demo_client.post(SERVICE, json=body)
    assert "Canary-display-9137" not in caplog.text and "synthetic-1" not in caplog.text


def test_the_guard_refuses_a_client_on_another_machine(demo_db):
    app = create_app(demo_db[0], uploads_dir=demo_db[1].uploads_dir)
    with TestClient(app, base_url="http://127.0.0.1", client=("192.0.2.10", 50000)) as remote:
        for response in (remote.get(DISCOVERY), remote.post(SERVICE, json=hook_request([condition(ICD11, "5A11")]))):
            assert response.status_code == 403 and response.json()["code"] == "local_only"
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as local:
        other_site = local.post(SERVICE, json=hook_request([condition(ICD11, "5A11")]), headers={"Origin": "http://ehr.example"})
        assert other_site.status_code == 403
        assert "access-control-allow-origin" not in {name.lower() for name in local.get(DISCOVERY).headers}


def test_age_groups_from_birth_dates():
    def group(birth: str) -> str | None:
        body = hook_request([condition(ICD11, "5A11")], birth_date=birth)
        import json

        return parse_request(json.dumps(body).encode(), today=date(2026, 10, 22)).patient_age_group

    assert group("2010-01-01") == "0-17"
    assert group("2008-10-22") == "18-39"  # 18 today
    assert group("1987-01") == "18-39"
    assert group("1980") == "40-64"
    assert group("1961-10-23") == "40-64"  # 64 until tomorrow
    assert group("1961-10-22") == "65+"
    with pytest.raises(CdsError):
        group("2026-02-30")
