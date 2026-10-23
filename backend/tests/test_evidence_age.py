"""Evidence age (contract v1.14, CONTRACT.md §28.5; release 0.5 phase Q4).

``getMetricSummary`` counts the linked graded conditions by the configuration
their studies evaluated: the card's current one, an earlier one, or one not
stated. Sent exactly when ``appraisal_counts`` is, so every other read keeps
its bytes; never a grade. All data is synthetic.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from admin_helpers import ADMIN, notes_by_code, upload_and_wait, wait
from conftest import copy_store, local_client

from app.main import API_PREFIX, create_app
from app.services.summary import configuration_state

ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
SKIN = {"model": "SkinAI-1.0", "use_case": "Skin lesion CDSS"}
SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
VIEWS = ("overall", "performance", "evidence", "intended_use", "safety")


def summary(client, card: dict, **params) -> dict:
    response = client.get(f"{API_PREFIX}/metrics/summary", params={**card, **params})
    assert response.status_code == 200, response.text
    return response.json()


def study(configuration_id: str | None):
    return SimpleNamespace(configuration_id=configuration_id)


def test_configuration_state():
    assert configuration_state([study("cfg-2")], "cfg-2") == "current"
    assert configuration_state([study("cfg-1")], "cfg-2") == "earlier"
    assert configuration_state([study(None)], "cfg-2") == "not_stated"
    # A card without a configuration id: no study's configuration can be placed.
    assert configuration_state([study("cfg-1")], None) == "not_stated"
    # Several studies (a lens fallback): earlier wins, then not stated.
    assert configuration_state([study("cfg-2"), study("cfg-1"), study(None)], "cfg-2") == "earlier"
    assert configuration_state([study("cfg-2"), study(None)], "cfg-2") == "not_stated"
    assert configuration_state([None], "cfg-2") == "not_stated"
    assert configuration_state([], "cfg-2") == "not_stated"


def test_demo_counts(demo_client):
    # ICU-RETRO-2025 evaluated cfg-icu-2025-09, the card's current configuration.
    body = summary(demo_client, ICU, view="evidence")
    assert body["configuration_counts"] == {"current": body["appraisal_counts"]["linked"], "earlier": 0, "not_stated": 0}
    # DERM-VIG-2025 states no configuration.
    body = summary(demo_client, SKIN)
    assert body["configuration_counts"] == {"current": 0, "earlier": 0, "not_stated": body["appraisal_counts"]["linked"]}
    # The hospital's local study names the current configuration too.
    local = summary(demo_client, ICU, population="northbridge-region")
    assert sum(local["configuration_counts"].values()) == local["appraisal_counts"]["linked"] == local["configuration_counts"]["current"]


def test_sent_exactly_with_appraisal_counts(demo_client, client):
    models = demo_client.get(f"{API_PREFIX}/models").json()["models"]
    for model in models:
        for use_case in model["use_cases"]:
            card = {"model": model["model_version"], "use_case": use_case["use_case"]}
            for view in VIEWS:
                body = summary(demo_client, card, view=view)
                assert ("configuration_counts" in body) == ("appraisal_counts" in body), (card, view)
                if "configuration_counts" in body:
                    assert sum(body["configuration_counts"].values()) == body["appraisal_counts"]["linked"]
    # The seed store has no studies: no read carries either (its bytes are what v1.13 served).
    for view in VIEWS:
        assert "configuration_counts" not in summary(client, SYN, view=view)


def test_another_classification_counts_its_own_conditions(ontology_demo_client):
    body = summary(ontology_demo_client, ICU, ontology="mondo")
    if "appraisal_counts" in body:
        assert sum(body["configuration_counts"].values()) == body["appraisal_counts"]["linked"]
        assert body["configuration_counts"]["earlier"] == 0


@pytest.fixture(scope="module")
def demo_admin(demo_db, tmp_path_factory):
    root = tmp_path_factory.mktemp("evidence-age")
    store = copy_store(demo_db[0], root / "demo.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=root / "uploads")) as client:
        yield client


def atlas_map(client) -> dict:
    body = client.get(f"{API_PREFIX}/metrics/map", params={**ICU, "scope": "atlas"}).json()
    body.pop("dataset_version")
    return body


def _as_record(stored: dict, **changes) -> dict:
    record = {key: value for key, value in stored.items() if value is not None}
    record["peer_reviewed"] = "Yes" if stored["peer_reviewed"] else "No"
    return {**record, **changes}


def test_an_earlier_configuration_is_counted_and_grades_stay(demo_admin):
    client = demo_admin
    before_map = atlas_map(client)
    before = summary(client, ICU, view="evidence")
    stored = client.get(f"{API_PREFIX}/studies/ICU-RETRO-2025").json()["study"]
    response = client.post(
        f"{ADMIN}/uploads/records",
        json={"kind": "studies", "records": [_as_record(stored, configuration_id="cfg-icu-2025-01")], "replace_staged": True},
    )
    assert response.status_code == 202, response.text
    upload = wait(client, response.json()["upload_id"])
    assert upload["status"] == "valid", upload["report"]
    # The configuration is not one of ICU_GPT-1.0's: a note, never a block (CONTRACT.md §22).
    assert "configuration_not_in_registry" in notes_by_code(upload)
    published = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": "Test (synthetic)."})
    assert published.status_code == 200, published.text

    after = summary(client, ICU, view="evidence")
    linked = after["appraisal_counts"]["linked"]
    assert after["configuration_counts"] == {"current": 0, "earlier": linked, "not_stated": 0}
    # Information only: the counts, statuses, and the map are what they were.
    assert {key: after[key] for key in ("counts", "chapters", "appraisal_counts")} == {
        key: before[key] for key in ("counts", "chapters", "appraisal_counts")
    }
    assert atlas_map(client) == before_map


def test_the_upload_note_reads_the_live_and_staged_registry(admin_client):
    """configuration_not_in_registry (CONTRACT.md §22): a note only when the study names its AI system
    and a configuration none of that system's cards lists, live or in a staged registry upload."""
    from test_registry_fields import registry_csv, set_fields
    from test_studies import stage_studies
    from test_studies import study as study_record

    client = admin_client

    def notes(*records):
        upload = stage_studies(client, *records)
        assert upload["status"] == "valid", upload["report"]
        return notes_by_code(upload)

    # Tiny-1's card lists no configuration yet.
    found = notes(study_record("T-CFG", model_version="Tiny-1", configuration_id="cfg-t1"))
    assert found["configuration_not_in_registry"]["count"] == 1
    # No AI system named, or no configuration named: nothing to compare, no note.
    assert "configuration_not_in_registry" not in notes(
        study_record("T-FREE", configuration_id="cfg-t1"), study_record("T-PLAIN", model_version="Tiny-1")
    )
    # A staged registry upload that gives Tiny-1 the configuration: no note.
    staged = upload_and_wait(client, "models", registry_csv(client, set_fields({"Configuration ID": "cfg-t1"})))
    assert staged["status"] == "valid", staged["report"]
    assert "configuration_not_in_registry" not in notes(study_record("T-CFG", model_version="Tiny-1", configuration_id="cfg-t1"))
    assert "configuration_not_in_registry" in notes(study_record("T-CFG", model_version="Tiny-1", configuration_id="cfg-t0"))
