"""Synonym matches in the ICD-11 search (contract v1.14, CONTRACT.md §9, §31).

The ICD-11 search lists concepts found by a synonym only after every other
match, with ``match: "synonym"`` and the ``matched_term``. A store without
synonyms searches exactly as v1.13 did (pinned digests).
"""

from __future__ import annotations

import hashlib

import pytest
from conftest import copy_store, local_client
from ontology_fixtures import import_fixture_ontologies

from app.api.store import Store
from app.main import API_PREFIX, create_app


@pytest.fixture(scope="module")
def synonym_store(legacy_db, tmp_path_factory):
    root = tmp_path_factory.mktemp("search-synonyms")
    store = copy_store(legacy_db, root / "synonyms.sqlite")
    import_fixture_ontologies(store, root / "sources")
    return store


@pytest.fixture(scope="module")
def synonym_client(synonym_store):
    with local_client(create_app(synonym_store, validate_responses=True)) as client:
        yield client


def search(client, q, limit=80):
    response = client.get(f"{API_PREFIX}/search", params={"q": q, "limit": limit})
    assert response.status_code == 200, response.text
    return response.json()


# /search answers of the seed store (no synonyms) as contract v1.13 served them:
# computed with the v1.13 code before any v1.14 change (sha256 of the body, total).
V113_SEARCH = {
    ("diabetes", 80): ("0b73235bc186386abfde3b8bef9bcee3a278a5744a90415ef6cfbed0891406e5", 34),
    ("heart attack", 80): ("8814044b397807b14cfdbe8d7560bd223d4076fcc4c9c1056463565f23d138e8", 0),
    ("high blood pressure", 80): ("68ebd4c7e47b0aae123400d48960f6a8e14da98de4b3a93a90924254ec6666a8", 0),
    ("stroke", 20): ("5a68ffc4a55e4170670dfd1996f12e9bcc8fc81d0cf3660be723020fb7159dd0", 29),
    ("heart", 200): ("759a1d847b031be22868cab52cf28386036fca4f991dfef74500f6b7628fbd0b", 61),
    ("5A1", 80): ("1173b6686f30e49692788454c2a912230fe7a80e6b878099a2dc1fdb03840116", 14),
    ("BA00", 80): ("29411e30140b759d6415316931d65d0e69e4595d84af15604669f537709ed986", 6),
    ("zzqxj", 80): ("bc2e6429d4dfee3ebe29b5eca9713cd58dd811200c0239eb1a992d2142f6dfc0", 0),
    ("infarction", 40): ("305919bdc6baa3b14382c740b1e8a8a27ed4e9e7359e02e4b8f0a11041ebd963", 35),
    ("a", 200): ("707dced8dc4d2bd73a5aedcc3069f757c8f2f7ef432cc9d5fbff64253a753148", 13688),
}


def test_search_without_synonyms_is_byte_identical_to_v113(client):
    for (q, limit), (digest, total) in V113_SEARCH.items():
        response = client.get(f"{API_PREFIX}/search", params={"q": q, "limit": limit})
        assert response.json()["total"] == total, q
        assert hashlib.sha256(response.content).hexdigest() == digest, q


def test_synonym_matches_follow_every_other_match(synonym_client):
    body = search(synonym_client, "sweet")
    synonym_at = [index for index, result in enumerate(body["results"]) if result.get("match") == "synonym"]
    assert synonym_at, body
    others = [result for result in body["results"] if "match" not in result]
    assert synonym_at == list(range(len(others), len(body["results"])))
    found = body["results"][synonym_at[0]]
    # Of 5A11's two synonyms holding "sweet", the one starting with it ranks first.
    assert (found["concept_id"], found["matched_term"]) == ("5A11", "Sweet blood disease")
    assert body["total"] == len(body["results"])
    assert all("matched_term" not in result for result in others)


def test_synonym_only_queries_and_limits(synonym_client):
    body = search(synonym_client, "high blood pressure")
    assert [(result["concept_id"], result["match"], result["matched_term"]) for result in body["results"]] == [("BA00", "synonym", "high blood pressure")]
    # A concept its preferred term already matches is listed once, without synonym fields.
    hypertension = search(synonym_client, "hypertensi")
    assert all("match" not in result for result in hypertension["results"] if result["concept_id"] == "BA00")
    # The limit cuts the synonym matches too, and the total counts them all.
    limited = search(synonym_client, "diabet", limit=1)
    full = search(synonym_client, "diabet", limit=200)
    assert limited["total"] == full["total"] and len(limited["results"]) == 1


def test_other_classifications_search_without_synonyms(synonym_client):
    body = synonym_client.get(f"{API_PREFIX}/search", params={"q": "sweet", "ontology": "mondo"}).json()
    assert all("match" not in result for result in body["results"])


def test_store_loads_synonyms_once(synonym_store):
    store = Store(synonym_store)
    context = store.resolve("live")
    with store.lock:
        assert context.search.has_synonyms
        assert context.search is store.resolve("live").search
