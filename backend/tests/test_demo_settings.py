"""Demo pack v10 (contract v1.14, CONTRACT.md §29): setting-specific results of
Vantrel Triage 2.1, ICU_GPT-1.0, and SynGPT-2.0, published through the normal merge path with
fictional study records of the same setting category, and the reads that name settings on the
demo store. All data is synthetic."""

from __future__ import annotations

import pytest
from conftest import local_client

from app.main import API_PREFIX, create_app

ED = "Emergency department"
ICU = "Intensive care"
SYN = "SynGPT-2.0|Clinician Facing CDSS"
VANTREL = "Vantrel-Triage-2.1|Emergency department triage"
SYN1 = "SynGPT-1.0|Clinician Facing CDSS"


def get(client, path, params=None, status=200):
    response = client.get(f"{API_PREFIX}{path}", params=params or {})
    assert response.status_code == status, response.text[:400]
    return response


@pytest.fixture(scope="module")
def demo_client(demo_db):
    store, _ = demo_db
    with local_client(create_app(store, validate_responses=True)) as client:
        yield client


def test_list_models_names_the_stored_settings(demo_client):
    entries = {
        f"{model['model_version']}|{entry['use_case']}": entry
        for model in get(demo_client, "/models").json()["models"]
        for entry in model["use_cases"]
    }
    assert entries[SYN]["settings"] == ["Clinical", ED, "Primary care"]
    assert entries[VANTREL]["settings"] == ["Clinical", ED]
    assert entries["ICU_GPT-1.0|CDSS"]["settings"] == ["Clinical", ICU]
    assert "settings" not in entries[SYN1]


def test_setting_rows_link_studies_of_the_same_setting(demo_client):
    """Every setting-specific row names a fictional study whose setting category is that setting."""
    studies = {study["study_id"]: study for study in get(demo_client, "/studies").json()["studies"]}
    for card, setting, code, study_id in (
        (VANTREL, ED, "NA00", "VANTREL-RCT-2026"),
        ("ICU_GPT-1.0|CDSS", ICU, "1G40", "ICU-RETRO-2025"),
        (SYN, ED, "BA00", "SYN-ED-2026"),
        (SYN, "Primary care", "5A11", "SYN-PC-2026"),
    ):
        model, use_case = card.split("|")
        row = get(demo_client, f"/metrics/concepts/{code}", {"model": model, "use_case": use_case, "context": setting}).json()["metrics"]
        assert row is not None and row["context"] == setting, (card, setting, code)
        assert row["provenance"]["data_source"]["study"] == study_id
        assert row["validation_type"] and row["evidence_grade"], "every row with performance has evidence"
        assert studies[study_id]["setting_category"] == {ED: "emergency_department", ICU: "intensive_care", "Primary care": "primary_care"}[setting]


def test_comparison_at_a_setting(demo_client):
    """§25 with §29: the setting applies to every column; a card without rows at the setting is
    treated like a card without the requested group (population_differs)."""
    body = get(demo_client, "/compare", {"cards": f"{VANTREL},{SYN1}", "context": ED}).json()
    assert body["filters"]["context"] == ED
    vantrel, syn1 = body["cards"]
    assert vantrel["lenses"]["settings"] == ["Clinical", ED] and vantrel["lenses"]["requested"] == "stored"
    assert vantrel["lenses"]["stored"] == 5
    assert "settings" not in syn1["lenses"] and syn1["lenses"]["requested"] == "none" and syn1["lenses"]["stored"] == 0
    reasons = {reason["code"]: reason["cards"] for reason in body["card_reasons"]}
    assert reasons["population_differs"] == [SYN1]
    assert all(row["cells"][1]["status"] == "no_data" for row in body["rows"])
    # Studies at the setting only: Vantrel's emergency department rows link its trial.
    assert [study["study_id"] for study in vantrel["studies"]] == ["TRIAGE-SIM-2026", "VANTREL-RCT-2026"]
    any_setting = get(demo_client, "/compare", {"cards": f"{VANTREL},{SYN1}"}).json()
    assert "settings" in any_setting["cards"][0]["lenses"]
    assert "population_differs" not in {reason["code"] for reason in any_setting["card_reasons"]}
    assert all(study["study_id"] != "VANTREL-RCT-2026" for study in any_setting["cards"][0]["studies"])


def test_demo_setting_rows_are_believable_subsets(demo_client):
    for card, setting, low, high in ((VANTREL, ED, 100, 130), (SYN, ED, 140, 160), (SYN, "Primary care", 190, 210), ("ICU_GPT-1.0|CDSS", ICU, 70, 90)):
        model, use_case = card.split("|")
        summary = get(demo_client, "/metrics/summary", {"model": model, "use_case": use_case, "context": setting}).json()
        counts = summary["counts"]
        stored = sum(counts.values()) - counts["no_data"]  # a result, or out of the card's intended use
        assert low <= stored <= high, (card, setting, counts)
        assert counts["strong"] + counts["moderate"] + counts["weak"] > 0
    # A setting a card stores nothing for reads No data everywhere.
    model, use_case = SYN.split("|")
    summary = get(demo_client, "/metrics/summary", {"model": model, "use_case": use_case, "context": ICU}).json()
    assert summary["counts"]["no_data"] == sum(summary["counts"].values())


def test_setting_reads_stay_within_budget(demo_client):
    """§10: setting reads keep the budgets; a setting switch is one map and one summary read."""
    model, use_case = SYN.split("|")
    params = {"model": model, "use_case": use_case, "context": ED}
    response = get(demo_client, "/metrics/map", {**params, "scope": "atlas"})
    assert len(response.content) < 2_000_000
    assert response.headers["etag"] != get(demo_client, "/metrics/map", {"model": model, "use_case": use_case, "scope": "atlas"}).headers["etag"]
    assert len(get(demo_client, "/compare", {"cards": f"{SYN},{VANTREL}", "context": ED, "scope": "chapter", "chapter_id": "CH-11"}).content) < 2_000_000
