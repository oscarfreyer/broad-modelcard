"""The catalogue (contract v1.6, CONTRACT.md §17).

Tile counts equal ``/metrics/summary`` for every view and configuration, on
the seed and on the demo pack (products included); every tile lists all
chapters, and the chapter counts add up; ``last_updated`` follows metrics,
registry, prevalence, and rollback publishes on a private tiny store; staged
reads show the staged change; ETags and 304 work as for every read.
"""

from __future__ import annotations

import re

import pytest
from admin_helpers import ADMIN, TINY_TARGET, read_csv, template, upload_and_wait, write_csv
from conftest import local_client

from app.demo.builder import default_uploads_dir
from app.main import API_PREFIX, create_app
from app.services.catalogue import DISTRIBUTION_KEYS, DistributionCache

CATALOGUE = f"{API_PREFIX}/catalogue"
VIEWS = ("overall", "performance", "evidence", "intended_use")


def catalogue(client, **params) -> dict:
    response = client.get(CATALOGUE, params=params)
    assert response.status_code == 200, response.text[:300]
    return response.json()


def tiles_by_card(body: dict) -> dict[str, dict]:
    return {tile["card_id"]: tile for tile in body["tiles"]}


def summary(client, tile: dict, view: str, **params) -> dict:
    response = client.get(
        f"{API_PREFIX}/metrics/summary",
        params={"model": tile["model_version"], "use_case": tile["use_case"], "view": view, **params},
    )
    assert response.status_code == 200, response.text[:300]
    return response.json()


def expected_distribution(client, tile: dict, **params) -> tuple[dict, dict]:
    """The tile's distribution and chapter counts as /metrics/summary reports them."""
    by_view = {view: summary(client, tile, view, **params) for view in VIEWS}
    distribution = {}
    for view in ("overall", "performance", "evidence"):
        counts = by_view[view]["counts"]
        assert all(counts[status] == 0 for status in counts if status not in DISTRIBUTION_KEYS[view]), (view, counts)
        distribution[view] = {status: counts[status] for status in DISTRIBUTION_KEYS[view]}
    intended_use = by_view["intended_use"]
    counts = intended_use["intended_use_counts"]  # null for a card without an intended-use statement (v1.11)
    distribution["intended_use"] = None if counts is None else {**counts, "no_data": intended_use["counts"]["no_data"]}
    chapters = {chapter["chapter_id"]: chapter for chapter in by_view["overall"]["chapters"]}
    return distribution, chapters


def check_tiles_match_summaries(client, body: dict, **params) -> None:
    meta = client.get(f"{API_PREFIX}/meta", params=params).json()
    chapter_ids = [chapter["concept_id"] for chapter in meta["chapters"]]
    for tile in body["tiles"]:
        distribution, chapters = expected_distribution(client, tile, **params)
        assert tile["distribution"] == distribution, tile["card_id"]
        for view, counts in tile["distribution"].items():
            if counts is not None:
                assert sum(counts.values()) == body["condition_count"], (tile["card_id"], view)
        assert (tile["distribution"]["intended_use"] is None) is (tile["intended_use_defined"] is False), tile["card_id"]
        # Every chapter, in chapter order; the chapter counts add up to the overall distribution.
        assert [chapter["chapter_id"] for chapter in tile["chapters"]] == chapter_ids
        assert sum(chapter["condition_count"] for chapter in tile["chapters"]) == body["condition_count"]
        for status in DISTRIBUTION_KEYS["overall"]:
            assert sum(chapter["overall"][status] for chapter in tile["chapters"]) == tile["distribution"]["overall"][status]
        for chapter in tile["chapters"]:
            assert sum(chapter["overall"].values()) == chapter["condition_count"]
            if chapter["condition_count"]:
                stated = chapters[chapter["chapter_id"]]
                assert (chapter["condition_count"], chapter["overall"]) == (stated["total"], stated["counts"])
            else:
                assert chapter["chapter_id"] not in chapters


def check_tiles_match_registry(client, body: dict, **params) -> None:
    registry = client.get(f"{API_PREFIX}/models", params=params).json()
    expected = []
    for model in registry["models"]:
        for use_case in model["use_cases"]:
            expected.append((model, use_case))
    assert [tile["card_id"] for tile in body["tiles"]] == [
        f"{model['model_version']}|{use_case['use_case']}" for model, use_case in expected
    ], "one tile per configuration, in registry order"
    for tile, (model, use_case) in zip(body["tiles"], expected):
        assert (tile["model_version"], tile["use_case"]) == (model["model_version"], use_case["use_case"])
        system = {key: model[key] for key in tile["system"]}
        assert tile["system"] == system
        assert tile["function_category"] == use_case["function_category"]
        assert tile["declarations"] == use_case["declarations"]
        assert tile["has_multimorbidity"] == use_case["has_multimorbidity"]
        assert tile["intended_use_defined"] == use_case["intended_use_defined"]
        assert tile["is_default_use_case"] == (use_case["use_case"] == model["default_use_case"])


# --------------------------------------------------------------------- seed

def test_seed_catalogue_shape(client):
    response = client.get(CATALOGUE)
    body = response.json()
    assert response.headers["X-Dataset-Version"] == body["dataset_version"] == "1"
    assert body["lens"] == {"context": "Clinical", "age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities"}
    assert body["condition_count"] == 2400
    assert "synthetic" in body["synthetic_data_notice"]
    assert len(body["tiles"]) == 10
    assert all(len(tile["chapters"]) == 21 for tile in body["tiles"])
    assert {tile["last_updated"]["version"] for tile in body["tiles"]} == {1}
    assert not any(tile["staged_change"] for tile in body["tiles"])
    assert len(response.content) < 300_000


def test_seed_tiles_match_registry(client):
    check_tiles_match_registry(client, catalogue(client))


def test_seed_tile_counts_equal_summaries(client):
    check_tiles_match_summaries(client, catalogue(client))


def test_etag_and_not_modified(client):
    first = client.get(CATALOGUE)
    etag = first.headers["ETag"]
    assert first.headers["Cache-Control"] == "no-cache"
    again = client.get(CATALOGUE, headers={"If-None-Match": etag})
    assert again.status_code == 304 and not again.content
    assert again.headers["ETag"] == etag and again.headers["X-Dataset-Version"] == "1"
    assert client.get(CATALOGUE, headers={"If-None-Match": f'W/{etag}, "other"'}).status_code == 304
    assert client.get(CATALOGUE, headers={"If-None-Match": '"other"'}).status_code == 200


def test_unknown_staged_upload_and_bad_version(client):
    assert client.get(CATALOGUE, params={"version": "staged:nope"}).json()["code"] == "unknown_upload"
    assert client.get(CATALOGUE, params={"version": "draft"}).json()["code"] == "invalid_version"


# ---------------------------------------------------------------- demo pack

@pytest.fixture(scope="module")
def demo_client(demo_db):
    store, _ = demo_db
    with local_client(create_app(store, validate_responses=True, uploads_dir=default_uploads_dir(store))) as client:
        yield client


def test_demo_catalogue_lists_products_with_their_fields(demo_client):
    body = catalogue(demo_client)
    check_tiles_match_registry(demo_client, body)
    products = [tile for tile in body["tiles"] if tile["system"]["kind"] == "product"]
    # 4 models with 7 cards and 6 products with one card each.
    # Pack v8 adds Vantrel Triage 2.0, pack v13 Parlowe Answers 1.0 and Tallyfern Coding 1.4.
    assert len(body["tiles"]) == 16 and len(products) == 9
    for product in products:
        assert product["function_category"] and product["declarations"]
    built_on = {tile["model_version"]: tile["system"]["built_on"] for tile in products if tile["system"]["built_on"]}
    assert built_on == {
        "Quillary-Scribe-1.0": ["MediCore-2.5"], "Vantrel-Triage-2.1": ["SynGPT-2.0"], "Vantrel-Triage-2.0": ["SynGPT-1.0"],
        "Parlowe-Answers-1.0": ["SynGPT-2.0"], "Tallyfern-Coding-1.4": ["MediCore-2.5"],
    }
    # Every function category of contract v1.14 has a card.
    assert {tile["function_category"] for tile in body["tiles"]} == {
        "decision_support", "documentation", "image_analysis", "triage", "patient_communication", "administrative",
    }


def test_demo_tile_counts_equal_summaries(demo_client):
    check_tiles_match_summaries(demo_client, catalogue(demo_client))


def test_demo_last_updated_follows_the_demo_revision(demo_client):
    """Pack v1's registry file (version 8) adds entry fields to every seed model and the products;
    the population publish before it (version 7, pack v3) changes no configuration (CONTRACT.md
    §17, §21). Pack v4's registry (version 9) changes the six configurations without an
    intended-use statement, the three systems it relabels as products, and Corvessa Skin Review 1.2
    (no longer built on SkinAI-1.0), and its generated evidence (versions 10-19) one card each, so a
    card's last update is its evidence version, version 9 for Corvessa, or version 8 for the other
    two products of pack v1, which needed none. Pack v5's
    studies publish (version 20, contract v1.13) adds the record NBR-2026-01 that the rows of pack
    v2's merge already name, so it changes SynGPT-2.0 / Clinician Facing CDSS (§17 item 5) and no other card (no other row names its studies yet), while its
    three study-link merges (versions 21-23) are metrics publishes of their cards. Pack v6's effect
    studies and effects (24, 25, §27) change no configuration (no row names those studies); pack
    v7's hospital study (26, named by local rows only) and local results (27, a local layer, §26) do
    not either; its hospital incident (28) is a safety change of ICU_GPT-1.0 / CDSS.

    Pack v8's registry (contract v1.14) gives every card a performance measure (§28.1), so it
    changes every card's registry signature, and it adds Vantrel Triage 2.0: every card
    reads that version. The builder publishes it before the evaluation import (37): it waits for
    Vantrel Triage 2.0's metrics (29), and pack v9's studies merge (30), pack v10's setting studies (31)
    and setting-specific results (32-35, §29), and pack v11's incident history (36, §30) come between,
    so every card reads 37. Pack v12's evaluation import then publishes its benchmark study (38, which
    no row names yet) and the metrics merge that names it (39, §32.2): only MediCore-2.5 / Clinician
    Facing CDSS reads 39.
    Pack v13's registry waits in turn for its two new products' metrics; it changes no
    earlier card's registry signature, so they keep their versions, and the two new cards read it (44):
    their studies (40), metrics (41, 42), and incident (43) come before it.
    The history up to pack v7 is checked by its v1.13 catalogue digest
    (test_registry_v113_bytes.py) and below, on the versions themselves."""
    body = catalogue(demo_client)
    versions = {entry["version_id"]: entry for entry in demo_client.get(f"{ADMIN}/versions").json()}
    assert body["dataset_version"] == "44" and versions[8]["kind"] == "models" and versions[7]["kind"] == "population"
    assert versions[20]["kind"] == "studies"
    assert versions[9]["kind"] == "models" and versions[9]["summary"] == "AI systems & functions: 10 rows changed."
    evidence = {
        re.search(r"generated evidence for (.+?): ", entry["note"]).group(1).replace(" / ", "|"): version
        for version, entry in versions.items()
        if "generated evidence" in (entry["note"] or "")
    }
    assert sorted(evidence.values()) == list(range(10, 20))
    assert [versions[version]["kind"] for version in range(29, 37)] == ["metrics", "studies", "studies", *["metrics"] * 4, "safety"]
    assert versions[37]["kind"] == "models" and versions[37]["summary"].endswith("13 rows changed, 1 AI system added.")
    assert versions[38]["kind"] == "studies" and versions[39]["kind"] == "metrics"
    assert [versions[version]["kind"] for version in range(40, 45)] == ["studies", "metrics", "metrics", "safety", "models"]
    new_cards = {"Parlowe-Answers-1.0|Patient question answering", "Tallyfern-Coding-1.4|Clinical coding support"}
    for tile in body["tiles"]:
        moved = 44 if tile["card_id"] in new_cards else 39 if tile["card_id"] == "MediCore-2.5|Clinician Facing CDSS" else 37
        assert tile["last_updated"] == {"version": moved, "at": versions[moved]["published_at"]}, tile["card_id"]


def test_demo_tiles_count_safety_incidents(demo_client):
    """Pack v2's incidents (contract v1.7): serious and caution by severity, and statuses."""
    tiles = tiles_by_card(catalogue(demo_client))
    # serious and caution count the open incidents (serious + caution = open); the mitigated one is apart.
    # Pack v11 adds its incident history: one more open (serious), one mitigated, and two closed.
    assert tiles["SynGPT-2.0|Clinician Facing CDSS"]["safety"] == {"serious": 2, "caution": 1, "open": 3, "mitigated": 2, "closed": 2}
    assert all(tile["safety"]["serious"] + tile["safety"]["caution"] == tile["safety"]["open"] for tile in tiles.values())
    assert tiles["SynGPT-1.0|Clinician Facing CDSS"]["safety"] == {"serious": 0, "caution": 0, "open": 0, "mitigated": 0, "closed": 1}
    assert tiles["DoAIHaveCancer-1.0|Skin lesion CDSS"]["safety"]["serious"] == 1, "a developer notice or recall is serious"
    total = sum(tile["safety"]["open"] + tile["safety"]["mitigated"] + tile["safety"]["closed"] for tile in tiles.values())
    assert total == 22  # pack v7 adds one hospital incident, pack v11 four of SynGPT-2.0 decision support, pack v13 one
    assert tiles["Parlowe-Answers-1.0|Patient question answering"]["safety"] == {"serious": 0, "caution": 0, "open": 0, "mitigated": 1, "closed": 0}


# ------------------------------------------------------ last update (tiny)

def publish(client, upload: dict) -> int:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False})
    assert response.status_code == 200, response.text
    return response.json()["version_id"]


def edited(client, kind: str, edit, **params) -> bytes:
    header, rows, comments = read_csv(template(client, kind, filled="true", **params))
    edit(header, rows)
    return write_csv(header, rows, comments)


def set_cells(values: dict, row: int = 0):
    def edit(header, rows):
        for column, value in values.items():
            rows[row][header.index(column)] = value

    return edit


def add_product(header, rows):
    product = [None] * len(header)
    values = {
        "Model version": "TinyCare-1", "Display name": "TinyCare 1", "Status": "EXPERIMENTAL", "Function": "Triage",
        "Default function": "Yes", "Default model": "No", "Kind": "Product", "AI type": "Hybrid",
        "Developer": "Tinyworks Labs (fictional)", "Built on": "Tiny-1", "Function category": "Triage",
    }
    for column, value in values.items():
        product[header.index(column)] = value
    rows.append(product)


def last_updated(client) -> dict[str, int]:
    return {card: tile["last_updated"]["version"] for card, tile in tiles_by_card(catalogue(client)).items()}


# The all-population row of 1A00 (the first template row), made weak on performance.
WEAKER_1A00 = {"Performance": "0.5", "CI low": "0.45", "CI high": "0.55"}


def test_last_updated_follows_the_changes_of_each_configuration(admin_client):
    client = admin_client
    tiny, care = "Tiny-1|CDSS", "TinyCare-1|Triage"
    published_at = lambda version: next(  # noqa: E731
        entry["published_at"] for entry in client.get(f"{ADMIN}/versions").json() if entry["version_id"] == version
    )
    first = tiles_by_card(catalogue(client))[tiny]
    assert first["last_updated"] == {"version": 1, "at": published_at(1)}

    # A product: its metrics first (version 2), then its registry entry (version 3).
    registry = upload_and_wait(client, "models", edited(client, "models", add_product))
    metrics = upload_and_wait(
        client, "metrics", template(client, "metrics", filled="true", **TINY_TARGET), model_version="TinyCare-1", use_case="Triage"
    )
    assert publish(client, metrics) == 2
    assert last_updated(client) == {tiny: 1}, "a configuration outside the registry has no tile"
    client.app.state.api.admin.wait_for_checks()
    assert publish(client, client.get(f"{ADMIN}/uploads/{registry['upload_id']}").json()) == 3
    assert last_updated(client) == {tiny: 1, care: 3}, "adding another entry leaves Tiny-1's entry unchanged"

    # Metrics of Tiny-1 (version 4): only its tile changes, and its counts follow.
    before = tiles_by_card(catalogue(client))[tiny]["distribution"]["performance"]
    upload = upload_and_wait(client, "metrics", edited(client, "metrics", set_cells(WEAKER_1A00), **TINY_TARGET), **TINY_TARGET)
    assert publish(client, upload) == 4
    tiles = tiles_by_card(catalogue(client))
    assert {card: tile["last_updated"]["version"] for card, tile in tiles.items()} == {tiny: 4, care: 3}
    assert tiles[tiny]["last_updated"]["at"] == published_at(4)
    assert before == {"strong": 1, "moderate": 0, "weak": 1, "no_data": 0}
    assert tiles[tiny]["distribution"]["performance"] == {"strong": 0, "moderate": 0, "weak": 2, "no_data": 0}

    # Registry: Tiny-1's developer (version 5) changes Tiny-1 only.
    upload = upload_and_wait(client, "models", edited(client, "models", set_cells({"Developer": "Tinyworks Labs (fictional)"})))
    assert publish(client, upload) == 5
    tiles = tiles_by_card(catalogue(client))
    assert {card: tile["last_updated"]["version"] for card, tile in tiles.items()} == {tiny: 5, care: 3}
    assert tiles[tiny]["system"]["developer"] == "Tinyworks Labs (fictional)"

    # Prevalence (version 6) changes no configuration's own data. It can still move evidence
    # statuses (the rare-condition penalty), so the counts follow while last_updated stays.
    evidence = tiles[tiny]["distribution"]["evidence"]
    upload = upload_and_wait(client, "prevalence", edited(client, "prevalence", set_cells({"Commonness": "Very common"}, row=2)))
    assert publish(client, upload) == 6
    assert last_updated(client) == {tiny: 5, care: 3}
    body = catalogue(client)
    assert body["dataset_version"] == "6"
    assert tiles_by_card(body)[tiny]["distribution"]["evidence"] != evidence
    check_tiles_match_summaries(client, body)

    # A rollback of the metrics to version 2 restores Tiny-1's first set (version 7).
    response = client.post(f"{ADMIN}/versions/2/rollback", params={"kind": "metrics"})
    assert response.status_code == 200, response.text
    assert last_updated(client) == {tiny: 7, care: 3}
    assert tiles_by_card(catalogue(client))[tiny]["distribution"]["performance"] == first["distribution"]["performance"]

    # A safety incident on TinyCare-1 (version 8, contract v1.7) changes that card only.
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": "safety", "records": [TINY_INCIDENT]})
    assert response.status_code == 202, response.text
    client.app.state.api.admin.wait_for_checks()
    assert publish(client, client.get(f"{ADMIN}/uploads/{response.json()['upload_id']}").json()) == 8
    tiles = tiles_by_card(catalogue(client))
    assert {card: tile["last_updated"]["version"] for card, tile in tiles.items()} == {tiny: 7, care: 8}
    assert tiles[care]["safety"] == {"serious": 1, "caution": 0, "open": 1, "mitigated": 0, "closed": 0}
    assert tiles[tiny]["safety"] == {"serious": 0, "caution": 0, "open": 0, "mitigated": 0, "closed": 0}


def test_last_updated_follows_the_study_records_a_card_links(admin_client):
    """Decision of 2026-10-21 (CONTRACT.md §17, §22): a studies publish that adds, changes,
    or removes a study record the card's stored rows name moves the card's last update, a
    restore that brings it back too; other cards, other studies, and population publishes do not."""
    from test_local_roles import REGION, population_csv
    from test_studies import link_rows, stage_studies, study

    client = admin_client
    tiny, care = "Tiny-1|CDSS", "TinyCare-1|Triage"
    registry = upload_and_wait(client, "models", edited(client, "models", add_product))
    metrics = upload_and_wait(
        client, "metrics", template(client, "metrics", filled="true", **TINY_TARGET), model_version="TinyCare-1", use_case="Triage"
    )
    assert publish(client, metrics) == 2
    client.app.state.api.admin.wait_for_checks()
    assert publish(client, client.get(f"{ADMIN}/uploads/{registry['upload_id']}").json()) == 3

    # Tiny-1's 1A00 row names T-STUDY-1 before a record exists: a metrics publish (version 4).
    assert publish(client, link_rows(client, "T-STUDY-1")) == 4
    assert last_updated(client) == {tiny: 4, care: 3}
    # The record is added (5): the row links it now.
    assert publish(client, stage_studies(client, study("T-STUDY-1"))) == 5
    assert last_updated(client) == {tiny: 5, care: 3}
    # Another study that no row names (6): nothing moves.
    assert publish(client, stage_studies(client, study("T-OTHER-1"))) == 6
    assert last_updated(client) == {tiny: 5, care: 3}
    # The linked record changes (7).
    changed = stage_studies(client, study("T-STUDY-1", risk_of_bias="High", guideline_followed="No"))
    staged = tiles_by_card(catalogue(client, version=f"staged:{changed['upload_id']}"))
    assert staged[tiny]["staged_change"] is True and staged[care]["staged_change"] is False
    assert staged[tiny]["last_updated"]["version"] == 5, "a staged change has no version yet"
    assert publish(client, changed) == 7
    assert last_updated(client) == {tiny: 7, care: 3}
    # A local population (8) changes no card's data.
    assert publish(client, upload_and_wait(client, "population", population_csv("1A00,Rare"), **REGION)) == 8
    assert last_updated(client) == {tiny: 7, care: 3}
    # The linked record is removed (9): the row unlinks.
    assert publish(client, stage_studies(client, {"study_id": "T-STUDY-1", "action": "Remove"})) == 9
    assert last_updated(client) == {tiny: 9, care: 3}
    # Removing the unrelated one (10) moves nothing.
    assert publish(client, stage_studies(client, {"study_id": "T-OTHER-1", "action": "Remove"})) == 10
    assert last_updated(client) == {tiny: 9, care: 3}
    # Restoring version 7's studies brings the linked study back (11).
    response = client.post(f"{ADMIN}/versions/7/rollback", params={"kind": "studies"}, json={"note": "Restore."})
    assert response.status_code == 200 and response.json()["version_id"] == 11, response.text
    tiles = tiles_by_card(catalogue(client))
    assert {card: tile["last_updated"]["version"] for card, tile in tiles.items()} == {tiny: 11, care: 3}
    # A fresh history (a new API on the same store) gives the same answer.
    with local_client(create_app(client.app.state.api.store.db_path, uploads_dir=default_uploads_dir(client.app.state.api.store.db_path))) as fresh:
        assert last_updated(fresh) == {tiny: 11, care: 3}


TINY_INCIDENT = {
    "incident_id": "SI-T-1", "model_version": "TinyCare-1", "use_case": "Triage", "codes": "1A00",
    "incident_type": "Harmful or incorrect recommendation", "harm": "Possible", "status": "Open",
    "source_type": "Incident report", "source_reference": "Fictional report (synthetic)",
    "reported_date": "2026-10-01", "summary": "Synthetic test incident.",
}


# ------------------------------------------------------------ staged reads

def test_staged_read_shows_the_staged_change(admin_client):
    client = admin_client
    live = client.get(CATALOGUE)
    upload = upload_and_wait(client, "metrics", edited(client, "metrics", set_cells(WEAKER_1A00), **TINY_TARGET), **TINY_TARGET)
    version = f"staged:{upload['upload_id']}"

    staged = client.get(CATALOGUE, params={"version": version})
    assert staged.status_code == 200, staged.text
    body = staged.json()
    assert staged.headers["X-Dataset-Version"] == body["dataset_version"] == version
    assert staged.headers["ETag"] != live.headers["ETag"]
    (tile,) = body["tiles"]
    assert tile["staged_change"] is True
    assert tile["distribution"]["performance"] == {"strong": 0, "moderate": 0, "weak": 2, "no_data": 0}
    assert tile["last_updated"]["version"] == 1, "a staged change has no version yet"
    check_tiles_match_summaries(client, body, version=version)

    # Live reads never see it.
    assert client.get(CATALOGUE).content == live.content
    (live_tile,) = live.json()["tiles"]
    assert live_tile["staged_change"] is False
    assert live_tile["distribution"]["performance"] == {"strong": 1, "moderate": 0, "weak": 1, "no_data": 0}


def test_a_reused_staged_set_id_never_serves_old_counts(admin_client):
    """Discarding a staged upload frees its set id, which the next upload reuses."""
    client = admin_client
    first = upload_and_wait(client, "metrics", edited(client, "metrics", set_cells(WEAKER_1A00), **TINY_TARGET), **TINY_TARGET)
    (tile,) = catalogue(client, version=f"staged:{first['upload_id']}")["tiles"]
    assert tile["distribution"]["performance"]["weak"] == 2
    assert client.delete(f"{ADMIN}/uploads/{first['upload_id']}").status_code == 204

    unchanged = template(client, "metrics", filled=True, **TINY_TARGET)
    second = upload_and_wait(client, "metrics", unchanged, **TINY_TARGET)
    body = catalogue(client, version=f"staged:{second['upload_id']}")
    (tile,) = body["tiles"]
    assert tile["distribution"]["performance"] == {"strong": 1, "moderate": 0, "weak": 1, "no_data": 0}
    check_tiles_match_summaries(client, body, version=f"staged:{second['upload_id']}")


def test_staged_registry_change_marks_its_configuration(admin_client):
    client = admin_client
    upload = upload_and_wait(client, "models", edited(client, "models", set_cells({"Developer": "Staged Labs (fictional)"})))
    (tile,) = catalogue(client, version=f"staged:{upload['upload_id']}")["tiles"]
    assert tile["staged_change"] is True and tile["system"]["developer"] == "Staged Labs (fictional)"
    (live,) = catalogue(client)["tiles"]
    assert live["staged_change"] is False and live["system"]["developer"] is None


# ------------------------------------------------------------------- cache

def test_distribution_cache_is_bounded_and_reused():
    cache = DistributionCache(max_entries=2)
    built = []

    def make(name):
        def build():
            built.append(name)
            return ({"name": name}, [])

        return build

    assert cache.get(("a",), make("a"))[0] == {"name": "a"}
    cache.get(("a",), make("a"))
    cache.get(("b",), make("b"))
    cache.get(("c",), make("c"))
    assert built == ["a", "b", "c"] and len(cache) == 2
    cache.get(("a",), make("a"))
    assert built == ["a", "b", "c", "a"], "the least recently used entry was evicted"


def test_a_publish_rebuilds_only_changed_configurations(admin_client):
    store = admin_client.app.state.api.store
    catalogue(admin_client)
    entries = len(store.distributions)
    upload = upload_and_wait(admin_client, "models", edited(admin_client, "models", set_cells({"Developer": "Other Labs (fictional)"})))
    publish(admin_client, upload)
    catalogue(admin_client)
    assert len(store.distributions) == entries, "a registry publish derives no distribution again"


# ------------------------------------------------------- history is reused

def test_a_build_after_new_publishes_reads_only_the_new_versions(admin_client, monkeypatch):
    """The Store keeps the version history behind last_updated (HistoryCache): a catalogue
    built after N more publishes reads those N versions only and never reloads the
    registry sets of earlier versions (review finding, S3)."""
    from app import repository

    client = admin_client
    store = client.app.state.api.store
    for index in range(3):
        upload = upload_and_wait(client, "models", edited(client, "models", set_cells({"Developer": f"Tinyworks {index} (fictional)"})))
        publish(client, upload)
        catalogue(client)
    history = store.history
    assert history.versions_read == 4, "versions 1 to 4, each read once"

    loaded: list[int] = []
    original = repository.load_registry

    def spy(conn, set_id):
        loaded.append(set_id)
        return original(conn, set_id)

    monkeypatch.setattr(repository, "load_registry", spy)
    upload = upload_and_wait(client, "models", edited(client, "models", set_cells({"Developer": "Tinyworks last (fictional)"})))
    version = publish(client, upload)
    loaded.clear()
    body = catalogue(client)
    assert body["dataset_version"] == str(version) == "5"
    assert history.versions_read == 5, "only the new version was read"
    live_registry = repository.load_state(store._connection()).registry_set_id
    assert set(loaded) <= {live_registry}, f"earlier registry sets were reloaded: {loaded}"
    assert tiles_by_card(body)["Tiny-1|CDSS"]["last_updated"]["version"] == 5
