"""The live interaction plugin's lookup (contract v1.8, CONTRACT.md §19).

* **Consistency:** for synthetic cases across several cards and lenses (one
  with incidents, a product with No data at a specific group), single codes, a
  deeper category code, and a stored combination, the lookup serves exactly the
  statuses, warnings, safeguards, incidents, provenance, and safety mark that
  ``/metrics/concepts`` (and ``/multimorbidity/combination``, ``/metrics/map``)
  serve at the same lens and version, live and staged.
* **Inputs:** coarse population values map to the lens; unknown keys anywhere
  are rejected; codes are letters, digits, and dots; 1 to 12 conditions.
* **Privacy:** nothing of the request body appears in the log output or in a
  problem response.
* **Budget:** 12 codes stay under 50 KB and answer within 50 ms warm.
"""

from __future__ import annotations

import logging
import statistics
import time
from urllib.parse import parse_qsl, urlsplit

import pytest
from admin_helpers import ADMIN, wait
from conftest import copy_store, local_client, record_budget

from app.demo.builder import default_uploads_dir
from app.main import API_PREFIX, create_app

LOOKUP = f"{API_PREFIX}/lookup"
ICD11 = "http://id.who.int/icd/release/11/mms"
SYN = ("SynGPT-2.0", "Clinician Facing CDSS")
SYN1 = ("SynGPT-1.0", "Clinician Facing CDSS")
ICU = ("ICU_GPT-1.0", "CDSS")
VANTREL = ("Vantrel-Triage-2.1", "Emergency department triage")  # product: all-population rows only
ALL = {"age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities"}
# The atlas URL parameters frontend/src/app/startupParams.js reads and writes.
ATLAS_PARAMS = {"version", "model", "use_case", "view", "age", "sex", "ethnicity", "mode", "depth", "chapter", "concept", "selected"}
PERF_MS = 50
MAX_BYTES = 50 * 1024


def body(card: tuple[str, str], codes: list[str], population: dict | None = None, **extra) -> dict:
    context = {
        "card": {"model_version": card[0], "use_case": card[1]},
        "conditions": [{"system": ICD11, "code": code} for code in codes],
    }
    if population is not None:
        context["population"] = population
    return {"hook": "broad-modelcard-lookup", "context": context, **extra}


def lookup(client, request: dict, **params) -> dict:
    response = client.post(LOOKUP, json=request, params=params)
    assert response.status_code == 200, response.text[:500]
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert response.headers["x-dataset-version"] == payload["dataset_version"]
    return payload


def lens_params(lens: dict) -> dict:
    return {axis: lens[axis] for axis in ("age", "sex", "ethnicity")}


@pytest.fixture(scope="module")
def demo_client(demo_db):
    store, _ = demo_db
    with local_client(create_app(store, validate_responses=True, uploads_dir=default_uploads_dir(store))) as client:
        yield client


def stored_partner(client, card, condition_id: str) -> str:
    """A condition that forms a stored two-condition combination with ``condition_id``."""
    response = client.get(
        f"{API_PREFIX}/multimorbidity/candidates",
        params={"model": card[0], "use_case": card[1], "scope": "atlas", "selected": condition_id},
    )
    assert response.status_code == 200, response.text[:300]
    candidates = response.json()["candidate_ids"]
    assert candidates, f"no stored combination with {condition_id}"
    return candidates[0]


# ------------------------------------------------------------ consistency

def check_against_atlas(client, card, payload: dict, **params) -> int:
    """Every matched condition equals what the atlas reads serve at the same lens and version."""
    lens = lens_params(payload["lens"])
    checked = 0
    for condition in payload["conditions"]:
        if not condition["matched"]:
            continue
        query = {"model": card[0], "use_case": card[1], **lens, **params}
        concept = client.get(f"{API_PREFIX}/metrics/concepts/{condition['concept_id']}", params=query).json()
        metrics = concept["metrics"]
        if metrics is None:
            assert condition["statuses"] == {"overall": "no_data", "performance": "no_data", "evidence": "no_data", "intended_use": None}
            assert condition["warnings"] == [] and condition["safeguards"] == [] and condition["provenance"] is None
        else:
            assert condition["statuses"] == {**metrics["status"], "intended_use": metrics["intended_use_level"]}
            assert condition["warnings"] == metrics["warnings"]
            assert condition["safeguards"] == metrics["safeguards"]
            assert condition["provenance"] == metrics["provenance"]
        assert condition["incidents"] == concept["incidents"]
        assert condition["icd11_code"] == concept["concept"]["icd11_code"] and condition["pt"] == concept["concept"]["pt"]

        chapter = concept["concept"]["chapter_id"]
        rows = client.get(f"{API_PREFIX}/metrics/map", params={**query, "scope": "chapter", "chapter_id": chapter}).json()
        marks = {row[0]: row[rows["columns"].index("safety")] for row in rows["rows"]}
        assert condition["safety"] == marks[condition["concept_id"]]
        checked += 1
    return checked


CASES = [
    # (card, codes, population): a lens with incidents (serious, caution, a chapter incident)
    (SYN, ["BA00", "5A11", "6A70", "ZZ99"], {"age_group": "65+", "sex": "female"}),
    (SYN, ["5A11", "BA00"], {"ethnicity": "black"}),
    # the one-study merge: its row carries the study as data source
    (SYN, ["5A11", "CA40"], None),
    # a product: data for the whole population, No data for one age group
    (VANTREL, ["BA41", "8B20", "1A00"], None),
    (VANTREL, ["BA41", "8B20", "1A00"], {"age_group": "65+"}),
    # deeper category codes, a closed incident given as subcategories, lower case
    (SYN1, ["CA40.0", "ca40.1", "1A03.0"], {"age_group": "0-17"}),
    (ICU, ["1G40", "2C25"], {"age_group": "65+", "sex": "male", "ethnicity": "asian"}),
]


@pytest.mark.parametrize("card, codes, population", CASES, ids=[f"{c[0]}-{'+'.join(k)}-{p}" for c, k, p in CASES])
def test_lookup_equals_the_atlas_card(demo_client, card, codes, population):
    payload = lookup(demo_client, body(card, codes, population))
    assert [condition["code"] for condition in payload["conditions"]] == codes, "one entry per code, in request order"
    assert check_against_atlas(demo_client, card, payload) == sum(1 for code in codes if code != "ZZ99")


def test_the_cases_cover_incidents_no_data_and_deeper_codes(demo_client):
    """The fixed cases above really contain what they are meant to test."""
    older = lookup(demo_client, body(SYN, ["BA00", "6A70"], {"age_group": "65+", "sex": "female"}))
    by_code = {condition["code"]: condition for condition in older["conditions"]}
    assert by_code["BA00"]["safety"] == "serious" and by_code["BA00"]["incidents"][0]["incident_id"] == "SI-2026-001"
    assert by_code["6A70"]["safety"] == "caution", "a chapter incident (chapter 06) applies to its conditions"
    assert older["lens"] == {"context": "Clinical", "age": "Age 65+", "sex": "Sex Female", "ethnicity": "All ethnicities"}

    product = lookup(demo_client, body(VANTREL, ["BA41"], {"age_group": "65+"}))
    (condition,) = product["conditions"]
    assert condition["statuses"]["overall"] == "no_data" and condition["provenance"] is None
    assert condition["safety"] == "serious", "No data does not hide an incident"
    assert product["card"]["kind"] == "product" and product["card"]["display_name"] != VANTREL[0]

    deeper = lookup(demo_client, body(SYN1, ["ca40.1"], {"age_group": "0-17"}))
    (condition,) = deeper["conditions"]
    assert condition["code"] == "ca40.1" and condition["concept_id"] == "CA40.1" and condition["anchor_id"] == "CA40"
    assert condition["provenance"]["source"] == "anchor"
    assert [incident["status"] for incident in condition["incidents"]] == ["closed"] and condition["safety"] is None

    merged = lookup(demo_client, body(SYN, ["5A11"]))
    assert merged["conditions"][0]["provenance"]["data_source"]["study"] == "NBR-2026-01"


def test_unmatched_codes_are_not_errors(demo_client):
    """Only codes of level-2 concepts match; a chapter number or an unknown code is listed as unmatched."""
    payload = lookup(demo_client, body(SYN, ["ZZ99", "XN6G5", "01", "5A11"]))
    assert payload["conditions"][:3] == [
        {"code": "ZZ99", "matched": False}, {"code": "XN6G5", "matched": False}, {"code": "01", "matched": False},
    ]
    assert payload["conditions"][3]["matched"] is True
    assert payload["combination"] is None


def test_a_stored_combination_equals_the_multimorbidity_read(demo_client):
    partner = stored_partner(demo_client, SYN, "5A11")
    for population, lens in ((None, ALL), ({"age_group": "65+"}, {**ALL, "age": "Age 65+"})):
        payload = lookup(demo_client, body(SYN, [partner, "5A11", "5A11", "ZZ99"], population))
        combination = payload["combination"]
        assert combination is not None and combination["concept_ids"] == [partner, "5A11"]
        stored = demo_client.get(
            f"{API_PREFIX}/multimorbidity/combination",
            params={"model": SYN[0], "use_case": SYN[1], "selected": f"{partner},5A11", **lens},
        ).json()
        assert combination["combination_key"] == stored["combination_key"]
        assert combination["label"] == stored["combination_label"]
        metrics = stored["metrics"]
        assert combination["statuses"] == {**metrics["status"], "intended_use": metrics["intended_use_level"]}
        assert combination["warnings"] == metrics["warnings"] and combination["safeguards"] == metrics["safeguards"]
        assert combination["provenance"] == metrics["provenance"]
        marks = [condition["safety"] for condition in payload["conditions"] if condition["matched"]]
        assert combination["safety"] == ("serious" if "serious" in marks else "caution" if "caution" in marks else None)
        url = dict(parse_qsl(urlsplit(combination["card_url"]).query))
        assert url["mode"] == "multimorbidity" and url["selected"] == f"{partner},5A11"
        assert check_against_atlas(demo_client, SYN, payload) == 3


def test_a_combination_is_never_inferred(demo_client):
    partner = stored_partner(demo_client, SYN, "5A11")
    one = lookup(demo_client, body(SYN, ["5A11"]))
    assert one["combination"] is None, "one condition is no combination"
    same = lookup(demo_client, body(SYN, ["1A03.0", "1A03.1"]))
    assert same["combination"] is None, "two codes of one condition are one condition"
    wider = lookup(demo_client, body(SYN, ["5A11", partner, "1A00"]))
    assert wider["combination"] is None, "a stored pair inside three conditions is not their combination"
    none = lookup(demo_client, body(ICU, ["5A11", "BA00"]))
    assert none["combination"] is None, "a card without multimorbidity data has none"


def test_card_urls_use_the_atlas_parameters(demo_client):
    payload = lookup(demo_client, body(VANTREL, ["BA41", "1A03.0"], {"age_group": "65+", "ethnicity": "hispanic"}))
    card = urlsplit(payload["card"]["card_url"])
    assert card.path == "atlas.html" and not card.netloc and not card.scheme
    assert dict(parse_qsl(card.query)) == {
        "model": VANTREL[0], "use_case": VANTREL[1], "view": "overall", "age": "Age 65+", "ethnicity": "Ethnicity Hispanic",
    }, "All … lens values are left out; the view of the figures is named"
    assert "use_case=Emergency+department+triage" in card.query, "encoded like URLSearchParams"
    top, deeper = payload["conditions"]
    assert dict(parse_qsl(urlsplit(top["card_url"]).query))["concept"] == "BA41"
    deeper_query = dict(parse_qsl(urlsplit(deeper["card_url"]).query))
    assert deeper_query["concept"] == "1A03.0" and deeper_query["chapter"] == "CH-01", "a subtype opens its chapter"
    for url in [payload["card"]["card_url"], *(condition["card_url"] for condition in payload["conditions"])]:
        assert {name for name, _ in parse_qsl(urlsplit(url).query)} <= ATLAS_PARAMS
        # A link that reports figures names their view, so it opens them for every reader (CONTRACT.md §19).
        assert dict(parse_qsl(urlsplit(url).query))["view"] == "overall"


# ----------------------------------------------------------------- staged

def test_staged_lookup_equals_the_staged_card(demo_db, tmp_path):
    """version=staged:<id> reads the staged upload like every read, and the links keep the version."""
    store = copy_store(demo_db[0], tmp_path / "demo.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        incident = {
            "incident_id": "SI-LOOKUP-1", "model_version": SYN[0], "use_case": SYN[1], "codes": "GB61", "age": "Age 65+",
            "incident_type": "Performance drift", "harm": "None", "status": "Open", "source_type": "Study",
            "source_reference": "Fictional lookup test study (synthetic)", "study_id": "LKP-1", "reported_date": "2026-10-01",
            "summary": "Synthetic example for the lookup test.",
        }
        created = client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [incident]})
        assert created.status_code == 202, created.text[:300]
        upload_id = created.json()["upload_id"]
        assert wait(client, upload_id)["status"] == "valid"
        version = f"staged:{upload_id}"

        request = body(SYN, ["GB61", "5A11"], {"age_group": "65+"})
        live = lookup(client, request)
        staged = lookup(client, request, version=version)
        assert staged["dataset_version"] == version
        assert [incident["incident_id"] for incident in staged["conditions"][0]["incidents"]] == ["SI-LOOKUP-1"]
        assert live["conditions"][0]["incidents"] == [] and live["conditions"][0]["safety"] is None
        assert check_against_atlas(client, SYN, staged, version=version) == 2
        for url in [staged["card"]["card_url"], *(condition["card_url"] for condition in staged["conditions"])]:
            assert dict(parse_qsl(urlsplit(url).query))["version"] == version
        assert "version" not in dict(parse_qsl(urlsplit(live["card"]["card_url"]).query))


# ------------------------------------------------------------------ inputs

@pytest.mark.parametrize(
    "population, lens",
    [
        (None, ALL),
        ({}, ALL),
        ({"age_group": None, "sex": None, "ethnicity": None}, ALL),
        ({"age_group": "0-17"}, {**ALL, "age": "Age 0-17"}),
        ({"age_group": "18-39", "sex": "male"}, {**ALL, "age": "Age 18-39", "sex": "Sex Male"}),
        ({"age_group": "40-64", "ethnicity": "white"}, {**ALL, "age": "Age 40-64", "ethnicity": "Ethnicity White"}),
        ({"ethnicity": "other"}, {**ALL, "ethnicity": "Ethnicity Other"}),
    ],
)
def test_coarse_population_maps_to_the_lens(client, population, lens):
    payload = lookup(client, body(SYN, ["5A11"], population))
    assert payload["lens"] == {"context": "Clinical", **lens}


def test_hook_and_system_are_optional(client):
    request = {"context": {"card": {"model_version": SYN[0], "use_case": SYN[1]}, "conditions": [{"code": "5A11"}]}}
    assert lookup(client, request)["conditions"][0]["matched"] is True


def _problem(client, request, status=422, **params) -> dict:
    response = client.post(LOOKUP, json=request, params=params)
    assert response.status_code == status, response.text[:300]
    assert response.headers["content-type"].startswith("application/problem+json")
    return response.json()


@pytest.mark.parametrize(
    "where",
    ["top", "context", "card", "condition", "population"],
)
def test_unknown_keys_are_rejected_anywhere(client, where):
    request = body(SYN, ["5A11"], {"age_group": "65+"})
    target = {
        "top": request,
        "context": request["context"],
        "card": request["context"]["card"],
        "condition": request["context"]["conditions"][0],
        "population": request["context"]["population"],
    }[where]
    target["patient_name"] = "Synthetic Person"
    problem = _problem(client, request)
    assert problem["code"] == "invalid_parameter"
    assert "patient_name" not in problem["detail"] and "Synthetic Person" not in problem["detail"]


@pytest.mark.parametrize(
    "change, code",
    [
        (lambda r: r["context"].update(conditions=[]), "invalid_selection"),
        (lambda r: r["context"].update(conditions=[{"code": "5A11"}] * 13), "invalid_selection"),
        (lambda r: r["context"]["conditions"][0].update(code="type 2 diabetes"), "invalid_selection"),
        (lambda r: r["context"]["conditions"][0].update(code=""), "invalid_selection"),
        (lambda r: r["context"]["conditions"][0].update(system="http://snomed.info/sct"), "invalid_selection"),
        (lambda r: r["context"].update(population={"age_group": "70"}), "invalid_lens"),
        (lambda r: r["context"].update(population={"sex": "Sex Female"}), "invalid_lens"),
        (lambda r: r["context"].update(population="65+"), "invalid_lens"),
        (lambda r: r.update(hook="patient-view"), "invalid_parameter"),
        (lambda r: r["context"].pop("card"), "invalid_parameter"),
        (lambda r: r.pop("context"), "invalid_parameter"),
    ],
)
def test_invalid_inputs_are_422(client, change, code):
    request = body(SYN, ["5A11"])
    change(request)
    assert _problem(client, request)["code"] == code


def test_invalid_json_and_unknown_cards(client):
    response = client.post(LOOKUP, content=b"{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422 and "not json" not in response.text
    unknown_model = _problem(client, body(("Nope-1", "CDSS"), ["5A11"]), 404)
    assert (unknown_model["code"], unknown_model["detail"]) == ("unknown_model", "Unknown AI system.")
    unknown_use_case = _problem(client, body((SYN[0], "Nope"), ["5A11"]), 404)
    assert (unknown_use_case["code"], unknown_use_case["detail"]) == ("unknown_use_case", "Unknown function for this AI system.")
    assert _problem(client, body(SYN, ["5A11"]), 422, version="draft")["code"] == "invalid_version"
    assert _problem(client, body(SYN, ["5A11"]), 404, version="staged:up-missing")["code"] == "unknown_upload"
    assert client.get(LOOKUP).status_code == 405


# ----------------------------------------------------------------- privacy

def test_the_request_body_is_never_logged_or_echoed(demo_client, caplog):
    marker = "QX7Z9"  # a valid code that matches nothing, a value only this request carries
    secret = "Synthetic-Case-4711"
    caplog.set_level(logging.DEBUG)
    responses = [
        demo_client.post(LOOKUP, json=body(SYN, [marker, "5A11"], {"age_group": "65+"})),
        demo_client.post(LOOKUP, json={**body(SYN, [marker]), "fhirAuthorization": {"access_token": secret}}),
        demo_client.post(LOOKUP, json=body(SYN, [f"{marker} {secret}"])),
        demo_client.post(LOOKUP, json={"context": {**body(SYN, [marker])["context"], "note": secret}}),
        demo_client.post(LOOKUP, json=body(SYN, [marker], {"age_group": secret})),
        demo_client.post(LOOKUP, json=body(("Nope-1", "CDSS"), [marker])),
        demo_client.post(LOOKUP, json=body((secret, "CDSS"), [marker])),
        demo_client.post(LOOKUP, json=body((SYN[0], secret), [marker])),
    ]
    assert [response.status_code for response in responses] == [200, 422, 422, 422, 422, 404, 404, 404]
    for response in responses[1:]:
        assert secret not in response.text and marker not in response.text
    logged = caplog.text + "".join(record.getMessage() for record in caplog.records)
    assert marker not in logged and secret not in logged
    assert "65+" not in logged


# ------------------------------------------------------------------ budget

@pytest.mark.slow
def test_lookup_budget(demo_db):
    """12 codes (one deeper, one unmatched, two with incidents) at a specific lens: < 50 KB, warm < 50 ms."""
    store, _ = demo_db
    codes = ["5A11", "BA00", "GB61", "1A00", "1A03.0", "CA40", "6A70", "BA41", "8B20", "2C30", "1G40", "ZZ99"]
    request = body(SYN, codes, {"age_group": "65+", "sex": "female"})
    with local_client(create_app(store)) as client:
        response = client.post(LOOKUP, json=request)
        assert response.status_code == 200, response.text[:300]
        size = len(response.content)
        timings = []
        for _ in range(30):
            started = time.perf_counter()
            assert client.post(LOOKUP, json=request).status_code == 200
            timings.append((time.perf_counter() - started) * 1000)
    p50, worst = statistics.median(timings), max(timings)
    record_budget(f"time  lookup (12 codes, {size / 1000:.1f} KB)  warm p50 {p50:5.1f} ms  max {worst:5.1f} ms  target warm < {PERF_MS} ms, < 50 KB")
    assert size < MAX_BYTES, f"{size:,} bytes"
    assert p50 < PERF_MS, f"warm p50 {p50:.1f} ms"
