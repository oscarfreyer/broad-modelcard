"""The plain-language interpreter and the helper's rewrite (contract v1.14, CONTRACT.md §20, §31).

* The shared rule cases (``fixtures/interpret_rule_cases.json``) run here
  through ``app/services/interpret.py`` and in ``tests/plainSearch.test.js``
  through the static port, so both answer alike.
* The quality set (``fixtures/interpret_queries.json``, 30 synthetic queries)
  runs on the demo store with the pinned ontology files imported: at least 27
  must be read exactly right (G8). Skipped when the files are not downloaded.
* ``GET /search/interpret``: headers, caching, problems, and the budget
  (< 150 ms warm, a small answer).
* ``POST /assist/interpret``: off by default; only the query and the
  vocabularies reach the provider; every chip is checked.
"""

from __future__ import annotations

import json
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from assist_stub import StubProvider
from conftest import copy_store, local_client

from app.assist import config as configuration
from app.assist.providers import FakeProvider
from app.main import API_PREFIX, create_app
from app.ontologies.importer import import_ontologies
from app.ontologies.sources import MANIFEST_FILE, load_manifest, missing, sources_dir
from app.services.interpret import interpret, vocabulary_of
from app.services.search import SearchIndex

FIXTURES = Path(__file__).parent / "fixtures"
RULES = json.loads((FIXTURES / "interpret_rule_cases.json").read_text(encoding="utf-8"))
QUALITY = json.loads((FIXTURES / "interpret_queries.json").read_text(encoding="utf-8"))
CONCEPT_DEFAULTS = {"block_id": None, "depth_in_kind": None, "metric_anchor_id": None, "fsn": None, "icd11_code": None}


def registry_of(vocabulary: dict):
    models = tuple(
        SimpleNamespace(
            model_version=model["model_version"],
            display_name=model["display_name"],
            replaced_by=tuple(model.get("replaced_by", ())),
            use_cases=tuple(SimpleNamespace(use_case=entry["use_case"], function_category=entry["function_category"]) for entry in model["use_cases"]),
        )
        for model in vocabulary["models"]
    )
    return SimpleNamespace(default_model_version=vocabulary["default_model_version"], models=models)


def axes_of(vocabulary: dict):
    return SimpleNamespace(**vocabulary["axes"])


class RuleCatalog:
    def __init__(self, concepts: list[dict]):
        self.records = {row["concept_id"]: {**CONCEPT_DEFAULTS, **row} for row in concepts}

    def record(self, concept_id: str) -> dict:
        return self.records[concept_id]


def rule_setup(with_synonyms: bool):
    catalog = RuleCatalog(RULES["concepts"])
    atlas = SimpleNamespace(concepts=[SimpleNamespace(**record) for record in catalog.records.values()])
    synonyms = {concept_id: [(text, "fixture") for text in texts] for concept_id, texts in RULES["synonyms"].items()} if with_synonyms else None
    vocabulary = vocabulary_of(registry_of(RULES["vocabulary"]), axes_of(RULES["vocabulary"]))
    return vocabulary, SearchIndex(atlas, synonyms), catalog


RULE_SETUPS = {flag: rule_setup(flag) for flag in (True, False)}


@pytest.mark.parametrize("case", RULES["cases"], ids=[case["name"] for case in RULES["cases"]])
def test_shared_rule_cases(case):
    vocabulary, index, catalog = RULE_SETUPS[case.get("synonyms", True)]
    answer = interpret(case["query"], vocabulary, index, catalog)
    assert [[chip["kind"], chip["value"], chip["matched_text"]] for chip in answer["chips"]] == case["chips"]
    assert answer["unrecognized"] == case["unrecognized"]


def test_condition_chips_carry_the_concept_and_how_it_was_found():
    vocabulary, index, catalog = RULE_SETUPS[True]
    chips = interpret("heart attack and 2C30", vocabulary, index, catalog)["chips"]
    attack, melanoma = chips
    assert attack == {
        "kind": "condition", "value": "BA41", "label": "Acute myocardial infarction", "matched_text": "heart attack",
        "code": "BA41", "pt": "Acute myocardial infarction", "match": "synonym", "matched_term": "heart attack",
        "concept": catalog.record("BA41"),
    }
    # A residual category's label leaves out its leading "- "; a code match has no matched_term.
    assert (melanoma["label"], melanoma["pt"], melanoma["match"]) == ("Melanoma of skin", "- Melanoma of skin", "code")
    assert "matched_term" not in melanoma


def test_queries_are_tidied_and_capped():
    vocabulary, index, catalog = RULE_SETUPS[True]
    answer = interpret("  asthma \n  in   MEN  " + "x" * 300, vocabulary, index, catalog)
    assert answer["query"].startswith("asthma in MEN x") and len(answer["query"]) == 200
    assert [chip["matched_text"] for chip in answer["chips"]] == ["asthma", "MEN"]


# ------------------------------------------------------------ quality (G8)

def _real_sources_missing() -> bool:
    return bool(missing(sources_dir(), load_manifest(MANIFEST_FILE)))


@pytest.fixture(scope="module")
def quality_client(demo_db, tmp_path_factory):
    if _real_sources_missing():
        pytest.skip("the pinned ontology files are not downloaded (npm run ontologies:fetch)")
    store = copy_store(demo_db[0], tmp_path_factory.mktemp("quality") / "quality.sqlite")
    report = import_ontologies(store)
    with local_client(create_app(store, validate_responses=True)) as client:
        client.import_report = report
        yield client


def test_the_quality_set_is_read_right(quality_client):
    """At least 27 of the 30 synthetic queries give exactly the expected chips."""
    assert len(QUALITY["queries"]) == 30
    wrong = []
    for case in QUALITY["queries"]:
        answer = quality_client.get(f"{API_PREFIX}/search/interpret", params={"q": case["query"]}).json()
        got = ([[chip["kind"], chip["value"]] for chip in answer["chips"]], answer["unrecognized"])
        if got != (case["chips"], case["unrecognized"]):
            wrong.append((case["query"], got))
    assert len(wrong) <= 3, wrong
    print(f"quality set: {30 - len(wrong)} of 30 exactly right")


def test_the_quality_vocabulary_is_the_demo_registry(quality_client):
    models = quality_client.get(f"{API_PREFIX}/models").json()
    axes = quality_client.get(f"{API_PREFIX}/meta").json()["axes"]
    snapshot = QUALITY["vocabulary"]
    assert snapshot["default_model_version"] == models["default_model_version"]
    assert [model["model_version"] for model in snapshot["models"]] == [model["model_version"] for model in models["models"]]
    for want, got in zip(snapshot["models"], models["models"]):
        assert want["display_name"] == (got.get("display_name") or got["model_version"])
        assert want.get("replaced_by", []) == got.get("replaced_by", [])
        assert want["use_cases"] == [{"use_case": entry["use_case"], "function_category": entry.get("function_category")} for entry in got["use_cases"]]
    assert snapshot["axes"] == {axis: axes[axis] for axis in ("context", "age", "sex", "ethnicity")}


def test_real_synonyms_are_imported_from_both_sources(quality_client):
    counts = {entry.ontology_id: entry.synonyms for entry in quality_client.import_report.ontologies}
    assert counts["icd10cm"] > 2000 and counts["mondo"] > 8000, counts
    found = quality_client.get(f"{API_PREFIX}/search", params={"q": "heart attack"}).json()["results"]
    assert found and found[0]["match"] == "synonym" and found[0]["matched_term"] == "heart attack"


def test_interpretation_budget(quality_client):
    """G13: an interpretation answers within 150 ms warm and stays small (CONTRACT.md §10)."""
    queries = [case["query"] for case in QUALITY["queries"]]
    for query in queries:  # warm: the response cache, the word index
        quality_client.get(f"{API_PREFIX}/search/interpret", params={"q": query})
    timings, sizes = [], []
    for query in queries:
        started = time.perf_counter()
        response = quality_client.get(f"{API_PREFIX}/search/interpret", params={"q": query, "version": "live"})
        timings.append(time.perf_counter() - started)
        sizes.append(len(response.content))
    timings.sort()
    assert timings[int(len(timings) * 0.95) - 1] < 0.150, timings
    assert max(sizes) < 20 * 1024, max(sizes)
    # Uncached (a query not asked before) stays within the budget too.
    started = time.perf_counter()
    quality_client.get(f"{API_PREFIX}/search/interpret", params={"q": "asthma and copd in older men in the icu, not seen before"})
    assert time.perf_counter() - started < 0.150


# ------------------------------------------------------------------ the read

def test_interpret_read_headers_and_caching(client):
    response = client.get(f"{API_PREFIX}/search/interpret", params={"q": "  SynGPT-2.0   heart failure in women "})
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "SynGPT-2.0 heart failure in women"
    assert [chip["kind"] for chip in body["chips"]] == ["system", "condition", "sex"]
    assert response.headers["x-dataset-version"] == "1" and response.headers["etag"]
    again = client.get(f"{API_PREFIX}/search/interpret", params={"q": "SynGPT-2.0 heart failure in women"}, headers={"If-None-Match": response.headers["etag"]})
    assert again.status_code == 304 and again.headers["etag"] == response.headers["etag"]


@pytest.mark.parametrize("params, code", [({"q": "   "}, "invalid_query"), ({}, "invalid_query"), ({"q": "x" * 201}, "invalid_query"), ({"q": "a", "version": "draft"}, "invalid_version")])
def test_interpret_read_problems(client, params, code):
    response = client.get(f"{API_PREFIX}/search/interpret", params=params)
    assert response.status_code == 422
    assert response.json()["code"] == code


def test_settings_come_from_the_context_axis(client):
    """A care setting chip names a value of the Context axis (§29), never Any setting."""
    body = client.get(f"{API_PREFIX}/search/interpret", params={"q": "asthma in the ICU"}).json()
    assert ["setting", "Intensive care"] in [[chip["kind"], chip["value"]] for chip in body["chips"]]
    vocabulary, index, catalog = RULE_SETUPS[True]
    without = replace(vocabulary, settings=())
    answer = interpret("asthma in the ICU", without, index, catalog)
    assert [chip["kind"] for chip in answer["chips"]] == ["condition"] and answer["unrecognized"] == ["ICU"]


# ----------------------------------------------------------------- the helper

@pytest.fixture(scope="module")
def helper_client(demo_db, tmp_path_factory):
    store = copy_store(demo_db[0], tmp_path_factory.mktemp("helper") / "helper.sqlite")
    with local_client(create_app(store, validate_responses=True)) as client:
        yield client


@pytest.fixture
def helper(helper_client):
    service = helper_client.app.state.assist
    service.clear()
    yield service
    service.clear()


def ask(client, q):
    return client.post(f"{API_PREFIX}/assist/interpret", json={"q": q})


def test_helper_is_off_by_default(helper_client, helper):
    response = ask(helper_client, "heart failure in older women")
    assert response.status_code == 409 and response.json()["code"] == "assist_not_configured"


def test_helper_chips_are_checked_against_the_vocabularies(helper_client, helper):
    helper_client.put(f"{API_PREFIX}/admin/assist", json={"provider": "local", "model": "fake-local", "base_url": "http://127.0.0.1:9/v1"})
    fake = FakeProvider.for_study_set({}, kind="local", model="fake-local")
    query = "how does syngpt do with heart failure in older ladies at the ER"
    fake.interpretations = {query: {
        "chips": [
            {"kind": "system", "value": "SynGPT-2.0", "matched_text": "syngpt"},
            {"kind": "function", "value": "Clinician Facing CDSS", "matched_text": "nowhere in the query"},
            {"kind": "condition", "value": "Heart failure", "matched_text": "heart failure"},
            {"kind": "condition", "value": "a disease the atlas lacks", "matched_text": ""},
            # By step 5's rules, a generic word or a stopword is no condition (review of release 0.5).
            {"kind": "condition", "value": "disease", "matched_text": ""},
            {"kind": "condition", "value": "of", "matched_text": ""},
            {"kind": "age", "value": "Age 65+", "matched_text": "older"},
            {"kind": "sex", "value": "sex female", "matched_text": "ladies"},
            {"kind": "setting", "value": "Emergency department", "matched_text": "ER"},
            {"kind": "ethnicity", "value": "Ethnicity Martian", "matched_text": ""},
            {"kind": "mood", "value": "curious", "matched_text": "how"},
            {"kind": "system", "value": "MediCore-2.5", "matched_text": ""},
        ],
        "unrecognized": ["how does", 7],
    }}
    helper.provider_factory = lambda config: fake
    response = ask(helper_client, query)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["provider"], body["model"]) == ("local", "fake-local")
    assert [[chip["kind"], chip["value"], chip["matched_text"]] for chip in body["chips"]] == [
        ["function", "Clinician Facing CDSS", ""],
        ["condition", "BLK-11-BlockL1-BD1", "heart failure"],
        ["sex", "Sex Female", "ladies"],
        ["age", "Age 65+", "older"],
        ["setting", "Emergency department", "ER"],
    ]
    assert sorted((item["kind"], item["reason"]) for item in body["dropped"]) == sorted([
        ("condition", "not_found"), ("condition", "not_found"), ("condition", "not_found"), ("ethnicity", "unknown_value"), ("mood", "unknown_kind"),
        ("system", "conflict"), ("system", "conflict"),
    ])
    assert body["unrecognized"] == ["how does"]
    # Only the query and the vocabularies were sent: no results, no store content.
    (system, sent_query), = fake.sent
    assert sent_query == query
    assert "SynGPT-2.0" in system and "Clinician Facing CDSS" in system and "Age 65+" in system and "Intensive care" in system
    for absent in ("perf", "evidence", "prevalence", "5A11", "synthetic"):
        assert absent not in system.lower(), absent


def test_helper_requests_carry_only_the_query_and_vocabularies(helper_client, helper):
    """A hosted model over HTTP (a stub on 127.0.0.1): one request, the system prompt and the query, no tools."""
    with StubProvider() as stub:
        key = "sk-test-canary-0000"
        helper_client.put(f"{API_PREFIX}/admin/assist", json={"provider": "hosted", "api_key": key, "base_url": stub.url, "model": "stub-model"})
        answer = {"chips": [{"kind": "condition", "value": "BA00", "matched_text": "high blood pressure"}], "unrecognized": []}
        stub.respond = lambda path, headers, body: (200, {"content": [{"type": "text", "text": json.dumps(answer)}], "stop_reason": "end_turn"}, {})
        helper.provider_factory = lambda config: _offline(config)
        response = ask(helper_client, "high blood pressure")
        assert response.status_code == 200, response.text
        assert [chip["value"] for chip in response.json()["chips"]] == ["BA00"]
        (request,) = stub.requests
        body = request["body"]
        assert set(body) == {"model", "max_tokens", "system", "messages"}
        assert body["messages"] == [{"role": "user", "content": "high blood pressure"}]
        assert key not in json.dumps(body) and key not in response.text
        # A provider error is a problem without the key.
        stub.respond = lambda path, headers, body: (500, {"error": {"type": "api_error", "message": f"boom {key}"}}, {})
        failed = ask(helper_client, "high blood pressure")
        assert failed.status_code == 502 and key not in failed.text


def _offline(config):
    from app.assist.providers import provider_for

    assert configuration.is_loopback_url(config.endpoint)
    return provider_for(config)


def test_helper_status_privacy_names_the_search_rewrite(helper_client, helper):
    privacy = helper_client.get(f"{API_PREFIX}/admin/assist").json()["privacy"]
    assert "Ask with the helper" in privacy and "only the words you typed" in privacy
