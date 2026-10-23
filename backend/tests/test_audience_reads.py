"""Audience reads (contract v1.14, CONTRACT.md §30): the summary's
``weighted_distribution`` (``weights=prevalence``), the version feed's ``card`` filter (§26.6),
and the public incident list ``listSafetyIncidents`` (§18). All additive: every read without the
new parameters is byte for byte what it was. Synthetic data only.

The digests below were recorded with the code before phase Q5 (commit 05e928b) on the seed
import (the ``client`` fixture). Publication times differ per import, so they are blanked before
hashing; nothing else is.
"""

from __future__ import annotations

import hashlib
import json
import math
import re

import pytest

from app.main import API_PREFIX
from app.services.catalogue import HistoryCache

TIMESTAMP = re.compile(rb'"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?"')
SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}
VANTREL = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}
NORTHBRIDGE = {"population": "northbridge-region"}
ED = {"context": "Emergency department"}

# (path, params) → sha256 of the body with times blanked, recorded with the pre-Q5 code.
PRE_Q5_DIGESTS = [
    ("/metrics/summary", {**SYN}, "fd232e223d4c565e27d762d5afde10502bb04c4ec53614bd80ecad303fd0cdc3"),
    ("/metrics/summary", {**SYN, "view": "performance"}, "e97f75ec551a802d98ff9b86a4e2689be4aaca25ed587683dc9645c658ccf837"),
    ("/metrics/summary", {**SYN, "view": "evidence", "age": "Age 65+"}, "b2faef7b2de02e088a7441fe09da2d67619967f06c6a61258a140321af524d0d"),
    ("/metrics/summary", {**SYN, "view": "intended_use"}, "cd93d5d50d1f3b92c402e6f06a192ab256a9f6eb8ca83b07da65c4d8ecb650cc"),
    ("/metrics/summary", {**SYN, "view": "safety"}, "5947ed048454f092deb5a648641246e9d918fc3ad5c33d7f6624370f0e11aad5"),
    ("/metrics/summary", {**ICU, "view": "intended_use", "sex": "Sex Female"}, "6e52326cd6306b338f432e0bdd0118c0108b038f662d4deae23dfd68306915d7"),
    ("/metrics/summary", {**MEDICORE, "view": "evidence", "age": "Age 0-17"}, "e83e85bd703db33dac6cde5a5b2d3d7538445965afd1fbfecf64952158a8b86d"),
    ("/versions", {}, "89909f4108338a4d9ed3bd98977bc3095493d0971b9fdbd2852f48ae229f359a"),
    ("/versions", {"after": 0}, "89909f4108338a4d9ed3bd98977bc3095493d0971b9fdbd2852f48ae229f359a"),
]


def digest(body: bytes) -> str:
    return hashlib.sha256(TIMESTAMP.sub(b'"<time>"', body)).hexdigest()


def get(client, path: str, **params):
    response = client.get(f"{API_PREFIX}{path}", params=params)
    assert response.status_code == 200, response.text
    return response


# ------------------------------------------------------------- byte identity

@pytest.mark.parametrize("weighted_first", [False, True])
def test_reads_without_the_new_parameters_are_unchanged(client, weighted_first):
    """Every pinned read is byte for byte what the pre-Q5 code served, also after the same read
    with the new parameters has been made (the response cache keys them apart)."""
    for path, params, expected in PRE_Q5_DIGESTS:
        if weighted_first:
            extra = {"weights": "prevalence"} if path == "/metrics/summary" else {"card": "SynGPT-2.0|Clinician Facing CDSS"}
            get(client, path, **params, **extra)
        body = get(client, path, **params).content
        assert digest(body) == expected, (path, params)
        assert b"weighted_distribution" not in body


def test_the_weighted_summary_is_the_summary_plus_one_field(demo_client):
    for params in ({**SYN}, {**SYN, **NORTHBRIDGE, "view": "evidence"}, {**VANTREL, **ED}, {**SYN, "view": "safety"}):
        plain = get(demo_client, "/metrics/summary", **params)
        weighted = get(demo_client, "/metrics/summary", **params, weights="prevalence")
        body = weighted.json()
        assert set(body["weighted_distribution"]) and plain.headers["etag"] != weighted.headers["etag"]
        del body["weighted_distribution"]
        assert body == plain.json(), params
        assert list(body) == list(plain.json()), "the other fields keep their order"


def test_unknown_weights_are_refused(client):
    response = client.get(f"{API_PREFIX}/metrics/summary", params={**SYN, "weights": "patients"})
    assert response.status_code == 422 and response.json()["code"] == "invalid_parameter"


# --------------------------------------------------------- weighted shares

def test_the_weighted_distribution_is_hand_checked(tiny_client):
    """The tiny store's two conditions: 1A00 is common (score 0.45), 1A01 rare (0.12), so they
    weigh 0.45 / 0.57 = 0.7895 and 0.12 / 0.57 = 0.2105 of the card (CONTRACT.md §5, §6)."""
    tiny = {"model": "Tiny-1", "use_case": "CDSS"}
    shares = {view: get(tiny_client, "/metrics/summary", **tiny, view=view, weights="prevalence").json() for view in (
        "overall", "evidence", "intended_use", "safety"
    )}
    assert shares["overall"]["counts"] == {"strong": 1, "moderate": 0, "weak": 1, "out_of_scope": 0, "no_data": 0}
    assert shares["overall"]["weighted_distribution"] == {"strong": 0.7895, "moderate": 0.0, "weak": 0.2105, "out_of_scope": 0.0, "no_data": 0.0}
    assert shares["evidence"]["weighted_distribution"] == {"strong": 0.0, "moderate": 0.7895, "weak": 0.2105, "out_of_scope": 0.0, "no_data": 0.0}
    assert shares["intended_use"]["weighted_distribution"] == {"in_scope": 1.0, "partially_in_scope": 0.0, "out_of_scope": 0.0, "no_data": 0.0}
    assert shares["safety"]["weighted_distribution"] == {"serious": 0.0, "caution": 0.0, "none": 1.0}


def expected_shares(client, card: dict, view: str = "overall", **params) -> dict[str, float]:
    """The shares rebuilt from other public reads: the statuses the atlas map serves for the
    top-level conditions and the prevalence scores the atlas overview serves for them."""
    overview = get(client, "/atlas/overview", **{key: value for key, value in params.items() if key == "population"}).json()
    scores = {concept["concept_id"]: concept.get("prevalence_score") for concept in overview["conditions"]}
    rows = get(client, "/metrics/map", **card, **params, scope="atlas").json()
    column = rows["columns"].index(f"{view}_status")
    weights: dict[str, float] = {}
    for row in rows["rows"]:
        if row[rows["columns"].index("child_count")] is not None:
            continue  # a block
        score = scores[row[0]]
        weight = score if isinstance(score, (int, float)) and math.isfinite(score) and score > 0 else 1
        weights[row[column]] = weights.get(row[column], 0) + weight
    total = sum(weights.values())
    return {status: value / total for status, value in weights.items()}


@pytest.mark.parametrize(
    ("card", "view", "params"),
    [
        (SYN, "overall", {}),
        (SYN, "overall", NORTHBRIDGE),
        (SYN, "evidence", {"age": "Age 65+"}),
        (VANTREL, "overall", ED),
        (ICU, "performance", NORTHBRIDGE),
    ],
)
def test_the_weighted_distribution_follows_the_map_and_the_prevalence(demo_client, card, view, params):
    served = get(demo_client, "/metrics/summary", **card, **params, view=view, weights="prevalence").json()
    shares = served["weighted_distribution"]
    assert set(shares) == {"strong", "moderate", "weak", "out_of_scope", "no_data"}
    assert abs(sum(shares.values()) - 1) < 0.001
    for status, share in expected_shares(demo_client, card, view, **params).items():
        assert shares[status] == pytest.approx(share, abs=0.00006), status
    # A status with conditions has weight; one without has none.
    assert all((shares[status] > 0) == (served["counts"][status] > 0) for status in shares)


def test_population_and_setting_change_the_weights(demo_client):
    default = get(demo_client, "/metrics/summary", **SYN, weights="prevalence").json()
    local = get(demo_client, "/metrics/summary", **SYN, **NORTHBRIDGE, weights="prevalence").json()
    assert local["population"]["id"] == "northbridge-region"
    assert local["weighted_distribution"] != default["weighted_distribution"]
    anywhere = get(demo_client, "/metrics/summary", **VANTREL, weights="prevalence").json()["weighted_distribution"]
    emergency = get(demo_client, "/metrics/summary", **VANTREL, **ED, weights="prevalence").json()["weighted_distribution"]
    assert emergency["no_data"] > 0.9 > anywhere["no_data"], "the setting reads only its own rows (§29)"


# ------------------------------------------------------- the card's versions

def test_the_card_filter_lists_the_versions_that_changed_the_card(demo_client):
    feed = {entry["version_id"]: entry for entry in get(demo_client, "/versions").json()["versions"]}
    tiles = get(demo_client, "/catalogue").json()["tiles"]
    for tile in tiles:
        versions = get(demo_client, "/versions", card=tile["card_id"]).json()["versions"]
        ids = [entry["version_id"] for entry in versions]
        assert ids == sorted(ids, reverse=True) and ids, tile["card_id"]
        # The newest is the catalogue's last update (§17), and each entry is the feed's own.
        assert ids[0] == tile["last_updated"]["version"], tile["card_id"]
        assert all(entry == feed[entry["version_id"]] for entry in versions)
    # SynGPT-2.0 decision support (demo pack): the seed import, pack v2's incidents (5) and study
    # merge (6), both registries (8, 9), its generated evidence (12), the studies its rows name (20,
    # 30), its setting results (34, 35), pack v11's incident history (36), and the v8 registry (37).
    syn = get(demo_client, "/versions", card="SynGPT-2.0|Clinician Facing CDSS").json()["versions"]
    assert [entry["version_id"] for entry in syn] == [37, 36, 35, 34, 30, 20, 12, 9, 8, 6, 5, 1]
    newer = get(demo_client, "/versions", card="SynGPT-2.0|Clinician Facing CDSS", after=30).json()["versions"]
    assert [entry["version_id"] for entry in newer] == [37, 36, 35, 34]
    # Never a population, an effects, or a local results version (§17).
    assert {feed[version]["kind"] for version in (7, 25, 27)} == {"population", "effects", "local_metrics"}
    assert not {7, 25, 27} & {version for tile in tiles for version in (
        entry["version_id"] for entry in get(demo_client, "/versions", card=tile["card_id"]).json()["versions"]
    )}


def test_the_card_filter_refuses_what_is_not_a_card(demo_client):
    assert get(demo_client, "/versions", card="Nope-1|CDSS").json()["versions"] == []
    for value in ("SynGPT-2.0", "|CDSS", "SynGPT-2.0|", "a|b|c"):
        response = demo_client.get(f"{API_PREFIX}/versions", params={"card": value})
        assert response.status_code == 422 and response.json()["code"] == "invalid_parameter", value


def test_the_history_answers_an_older_version_too(demo_db):
    """``HistoryCache.changed_versions`` for a version older than the newest it has read."""
    import sqlite3

    connection = sqlite3.connect(demo_db[0])
    try:
        history = HistoryCache()
        assert history.changed_versions(connection, 37, ("SynGPT-2.0", "Clinician Facing CDSS"))[:2] == [37, 36]
        assert history.changed_versions(connection, 35, ("SynGPT-2.0", "Clinician Facing CDSS")) == [35, 34, 30, 20, 12, 9, 8, 6, 5, 1]
        assert history.changed_versions(connection, 37, ("Nope-1", "CDSS")) == []
    finally:
        connection.close()


# ------------------------------------------------------ the public incidents

def test_the_public_incident_list_equals_the_data_librarys(demo_client):
    for params in ({}, {"model": "SynGPT-2.0"}, SYN, {"model": "Nope-1"}):
        public = get(demo_client, "/incidents", **params)
        admin = demo_client.get(f"{API_PREFIX}/admin/safety/incidents", params=params)
        assert public.json() == admin.json(), params
        assert public.headers["etag"] and public.headers["x-dataset-version"] == "44"  # demo pack v13
        again = demo_client.get(f"{API_PREFIX}/incidents", params=params, headers={"If-None-Match": public.headers["etag"]})
        assert again.status_code == 304
    syn = get(demo_client, "/incidents", **SYN).json()["incidents"]
    assert [(entry["incident_id"], entry["status"]) for entry in syn] == [
        ("SI-2026-020", "open"), ("SI-2026-001", "open"), ("SI-2026-002", "open"), ("SI-2026-003", "mitigated"),
        ("SI-2026-019", "mitigated"), ("SI-2026-018", "closed"), ("SI-2026-017", "closed"),
    ]
    tile = next(tile for tile in get(demo_client, "/catalogue").json()["tiles"] if tile["card_id"] == "SynGPT-2.0|Clinician Facing CDSS")
    counts = {status: sum(entry["status"] == status for entry in syn) for status in ("open", "mitigated", "closed")}
    assert {key: tile["safety"][key] for key in counts} == counts
    assert sum(entry["severity"] == "serious" for entry in syn if entry["status"] == "open") == tile["safety"]["serious"]


def test_the_public_incident_list_without_incidents(client):
    body = get(client, "/incidents").json()
    assert body == {"dataset_version": "1", "incidents": []}
    assert json.loads(get(client, "/incidents", **SYN).content) == body
