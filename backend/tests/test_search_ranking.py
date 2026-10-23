"""Search ranking (contract v1.12, CONTRACT.md §9): the best match first.

The matching itself is the reference's (test_api_parity.py); these tests pin
the order.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.main import API_PREFIX
from app.services.search import (
    RANK_CODE,
    RANK_CODE_PREFIX,
    RANK_SUBSTRING,
    RANK_TERM,
    RANK_WORD,
    RANK_WORD_PREFIX,
    SearchIndex,
    match_rank,
)


def search(client, q: str, limit: int = 80) -> dict:
    response = client.get(f"{API_PREFIX}/search", params={"q": q, "limit": limit})
    assert response.status_code == 200, response.text[:300]
    return response.json()


def codes(body: dict) -> list[str]:
    return [result.get("icd11_code") or result["concept_id"] for result in body["results"]]


def test_match_rank_orders_code_term_word_and_substring():
    assert match_rank("5a11", "5a11", "type 2 diabetes mellitus") == RANK_CODE
    assert match_rank("5a1", "5a11", "type 2 diabetes mellitus") == RANK_CODE_PREFIX
    assert match_rank("asthma", "ca23", "asthma") == RANK_TERM
    assert match_rank("diabetes", "ja63", "diabetes mellitus in pregnancy") == RANK_WORD
    assert match_rank("diab", "ja63", "diabetes mellitus in pregnancy") == RANK_WORD, "the term starts with it"
    assert match_rank("diabetes", "5a11", "type 2 diabetes mellitus") == RANK_WORD, "a whole word"
    assert match_rank("diab", "5a11", "type 2 diabetes mellitus") == RANK_WORD_PREFIX
    assert match_rank("abetes", "5a11", "type 2 diabetes mellitus") == RANK_SUBSTRING
    assert match_rank("a11", "5a11", "type 2 diabetes mellitus") == RANK_SUBSTRING


def test_a_condition_name_finds_the_general_conditions_first(client):
    body = search(client, "diabetes", limit=9)
    found = codes(body)
    # The reference led with "Hypoglycaemia in the context of diabetes mellitus".
    assert found[:2] == ["5A10", "5A11"], found
    names = [result["pt"].lower() for result in body["results"]]
    assert all("diabetes" in name for name in names)
    assert not any(name.startswith("hypoglycaemia") for name in names)
    # Shorter terms come first within a rank.
    assert [len(name) for name in names[:2]] == sorted(len(name) for name in names[:2])


def test_an_exact_term_and_an_exact_code_lead(client):
    assert search(client, "Asthma")["results"][0]["pt"] == "Asthma"
    assert codes(search(client, "5A11"))[0] == "5A11"
    assert codes(search(client, "  ca23 "))[0] == "CA23"


def test_a_code_prefix_lists_codes_in_code_order(client):
    found = codes(search(client, "1A0", limit=10))
    assert found[:3] == ["1A00", "1A01", "1A02"], found
    prefixed = [code for code in found if code.lower().startswith("1a0")]
    assert prefixed == sorted(prefixed, key=lambda code: (len(code), code.lower()))


def test_ranking_keeps_the_matches_and_the_total(client):
    whole = search(client, "diabetes", limit=200)
    assert whole["total"] == len(whole["results"])
    first = search(client, "diabetes", limit=5)
    assert first["total"] == whole["total"]
    assert [r["concept_id"] for r in first["results"]] == [r["concept_id"] for r in whole["results"][:5]]


def _concept(concept_id: str, pt: str, level: int = 2) -> SimpleNamespace:
    return SimpleNamespace(concept_id=concept_id, pt=pt, fsn=f"{pt} (ICD-11 category {concept_id})", icd11_code=concept_id, level=level)


def test_a_hyphen_counts_as_a_space():
    # Contract v1.14 review fix (§9): on both sides, in the query and in the searched text.
    index = SearchIndex(
        SimpleNamespace(concepts=[_concept("BD10", "Congestive heart failure"), _concept("RA01", "COVID-19"), _concept("CA40", "Pneumonia")]),
        {"CA40": [("covid-19 pneumonia", "fixture")]},
    )
    assert index.search("heart-failure", 80) == index.search("heart failure", 80)
    assert index.search("heart-failure", 80).concept_ids == ["BD10"]
    for query in ("COVID-19", "covid 19", "covid-"):
        hit = index.search(query, 80)
        assert hit.concept_ids == ["RA01", "CA40"], query
        assert hit.synonyms == {"CA40": "covid-19 pneumonia"}, query
    # Ranked as before: the term is the query, either way it is written.
    assert match_rank("covid 19", "ra01", "covid 19") == RANK_TERM
    assert [match.concept_id for match in index.conditions("covid 19")] == ["RA01"]
    assert [(match.concept_id, match.match) for match in index.conditions("heart-failure")] == [("BD10", "term")]
