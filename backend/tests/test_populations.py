"""Local populations (contract v1.10, CONTRACT.md §21).

A local population is a named local prevalence set: its tiers replace the
default tiers of the codes it lists, for the reads that name it, through the
existing formulas (the evidence penalty §4.2, rollup weights §6, concept tiers
§5). Without ``population`` every read answers exactly as before. All data is
synthetic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from admin_helpers import ADMIN, admin_service, post_upload, read_csv, template, upload_and_wait
from conftest import copy_store, local_client
from tiny_tables import tiny_tables, write_tables

from app import db
from app.demo.builder import PACK_DIR
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}
TINY = {"model": "Tiny-1", "use_case": "CDSS"}
NORTHBRIDGE = "northbridge-region"
NORTHBRIDGE_FILE = PACK_DIR / "v3" / "populations" / "northbridge-region.csv"
TINY_REGION = {"population_id": "tiny-region", "population_name": "Tiny region (fictional)"}


def population_csv(*rows: str, header: str = "ICD-11 code,Commonness") -> bytes:
    return ("\n".join((header, *rows)) + "\n").encode()


def normalized(body: bytes) -> dict:
    """A read body without the fields a publish changes by itself (the version label)."""
    value = json.loads(body)
    value.pop("dataset_version", None)
    if isinstance(value.get("display"), dict):
        value["display"].pop("dataset_version", None)
    value.pop("exported_at", None)
    return value


def label_free_bytes(body: bytes, label: str) -> bytes:
    return body.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')


def label_free(response) -> bytes:
    return label_free_bytes(response.content, response.headers["x-dataset-version"])


# A fixed set of reads that depend on prevalence (CONTRACT.md §21: default answers are unchanged).
DEFAULT_READS = [
    ("/metrics/map", {**SYN, "scope": "atlas"}),
    ("/metrics/map", {**SYN, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/map", {**MEDICORE, "scope": "chapter", "chapter_id": "CH-11"}),
    ("/metrics/summary", {**SYN, "view": "overall"}),
    ("/metrics/summary", {**SYN, "view": "evidence"}),
    ("/metrics/summary", {**MEDICORE, "view": "intended_use"}),
    ("/metrics/concepts/CH-05", SYN),
    ("/metrics/concepts/BA00", SYN),
    ("/metrics/concepts/1A01", MEDICORE),
    ("/multimorbidity/candidates", {**SYN, "scope": "atlas"}),
    ("/multimorbidity/combination", {**SYN, "selected": "GB61,5A11"}),
    ("/atlas/overview", {}),
    ("/atlas/chapters/CH-11", {}),
    ("/search", {"q": "diabetes"}),
    ("/catalogue", {}),
    ("/export/concepts/BA00", SYN),
]


@pytest.fixture
def demo_store(demo_db, tmp_path):
    """A private copy of the demo store (pack v4, with Northbridge region), for tests that publish."""
    return copy_store(demo_db[0], tmp_path / "demo.sqlite")


@pytest.fixture
def demo_admin(demo_store, tmp_path):
    with local_client(create_app(demo_store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        yield client


def get(client, path: str, params: dict, **headers):
    response = client.get(API_PREFIX + path, params=params, headers=headers)
    assert response.status_code == 200, f"{path} {params}: {response.text[:300]}"
    return response


# ----------------------------------------------------------- the data set

def test_demo_pack_publishes_northbridge(demo_client):
    meta = get(demo_client, "/meta", {}).json()
    assert meta["populations"] == [
        {"id": NORTHBRIDGE, "name": "Northbridge region (fictional)", "codes": 310, "updated_version": meta["populations"][0]["updated_version"]}
    ]
    versions = demo_client.get(f"{ADMIN}/versions", params={"kind": "population"}).json()
    assert versions[0]["version_id"] == meta["populations"][0]["updated_version"]
    assert versions[0]["note"].startswith("Demo pack v13, v3/populations/northbridge-region.csv:")
    datasets = {info["kind"]: info for info in demo_client.get(f"{ADMIN}/datasets").json()}
    assert datasets["population"]["counts"] == {"populations": 1, "codes": 310}


def test_population_upload_checks_names_and_aggregate_data(admin_client):
    client = admin_client
    # The population is named at upload; a new one needs a display name.
    for form, expected in (
        ({}, "population_id"),
        ({"population_id": "Tiny Region"}, "population_id"),
        ({"population_id": "tiny-region"}, "population_name"),
        ({**TINY_REGION, "population_name": "x" * 81}, "population_name"),
    ):
        response = post_upload(client, "population", population_csv("1A00,Rare"), **form)
        assert response.status_code == 422 and expected in response.json()["detail"], response.text
    response = post_upload(client, "population", population_csv("1A00,Rare"), mode="merge", **TINY_REGION)
    assert response.status_code == 422 and response.json()["code"] == "invalid_parameter"

    # Anything that looks patient-level is refused with a plain fix.
    report = upload_and_wait(client, "population", population_csv("1A00,Rare,P-001,1980-01-01", header="ICD-11 code,Commonness,Patient ID,Date of birth"), **TINY_REGION)["report"]
    group = next(group for group in report["errors"] if group["code"] == "patient_level_data")
    assert group["count"] == 2 and "one commonness tier per condition" in group["fix"]
    report = upload_and_wait(client, "population", population_csv("1A00,Rare", "1A00,Common"), replace_staged=True, **TINY_REGION)["report"]
    assert [group["code"] for group in report["errors"]] == ["patient_level_data"]
    report = upload_and_wait(client, "population", population_csv("1A00,Rare,Remove", header="ICD-11 code,Commonness,Action"), replace_staged=True, **TINY_REGION)["report"]
    assert [group["code"] for group in report["errors"]] == ["remove_in_replace"]
    # An ordinary extra column is the usual extra_column error.
    report = upload_and_wait(client, "population", population_csv("1A00,Rare,x", header="ICD-11 code,Commonness,Comment"), replace_staged=True, **TINY_REGION)["report"]
    assert [group["code"] for group in report["errors"]] == ["extra_column"]

    valid = upload_and_wait(client, "population", population_csv("1A00,Very rare"), replace_staged=True, **TINY_REGION)
    assert valid["status"] == "valid" and valid["kind"] == "population" and valid["target"] == TINY_REGION
    datasets = {info["kind"]: info for info in client.get(f"{ADMIN}/datasets").json()}
    assert datasets["population"]["staged_upload_ids"] == [valid["upload_id"]]


def test_a_patient_level_file_is_deleted_after_its_check(admin_client):
    """CONTRACT.md §21: a file that looks patient-level is not kept, nor is a marked copy offered."""
    client = admin_client
    service = admin_service(client)
    # A patient-level column, plus an unknown code whose example would quote a cell of the file.
    rows = population_csv("1A00,Rare,P-001", "ZZ99,Rare,P-002", header="ICD-11 code,Commonness,Patient ID")
    upload = upload_and_wait(client, "population", rows, **TINY_REGION)
    assert upload["status"] == "invalid", "the upload stays visible as invalid"
    codes = {group["code"]: group for group in upload["report"]["errors"]}
    assert "patient_level_data" in codes and codes["patient_level_data"]["examples"], "the problem is shown"
    assert codes["unknown_icd_code"]["count"] == 1, "other problems are still counted"
    assert all(not group["examples"] for code, group in codes.items() if code != "patient_level_data"), (
        "other problems keep their counts and fixes, but no cell of the file"
    )
    assert "P-002" not in json.dumps(upload) and "ZZ99" not in json.dumps(upload)
    assert not service.upload_dir(upload["upload_id"]).exists(), "the file and everything beside it are deleted"
    for file_format in ("csv", "xlsx"):
        response = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/annotated.{file_format}")
        assert response.status_code == 409 and response.json()["code"] == "upload_not_staged"
        assert "patient-level" in response.json()["detail"] and "deleted" in response.json()["detail"]
    # Duplicate codes (a list of cases) are patient-level too.
    duplicate = upload_and_wait(client, "population", population_csv("1A00,Rare", "1A00,Common"), replace_staged=True, **TINY_REGION)
    assert [group["code"] for group in duplicate["report"]["errors"]] == ["patient_level_data"]
    assert not service.upload_dir(duplicate["upload_id"]).exists()
    # Any other invalid file is kept with its marked copy, as before.
    extra = upload_and_wait(client, "population", population_csv("1A00,Rare,x", header="ICD-11 code,Commonness,Comment"), replace_staged=True, **TINY_REGION)
    assert extra["status"] == "invalid" and service.upload_dir(extra["upload_id"]).is_dir()
    assert client.get(f"{ADMIN}/uploads/{extra['upload_id']}/annotated.csv").status_code == 200


def test_a_prevalence_replace_that_drops_most_codes_is_blocked(admin_client, demo_admin):
    """CONTRACT.md §11: a local list uploaded as Prevalence (replace) would wipe the default tiers."""
    client = admin_client  # the tiny store's default prevalence lists 3 codes
    blocked = upload_and_wait(client, "prevalence", population_csv("1A00,Rare"))
    assert blocked["status"] == "invalid"
    assert [group["code"] for group in blocked["report"]["errors"]] == ["prevalence_incomplete"]
    assert blocked["report"]["errors"][0]["fix"] == (
        "This file lists only 1 of 3 codes. To add a local population, use Local populations; "
        "to change some codes, use Add or change rows."
    )
    # Half or more of the codes kept is an ordinary replace; a merge never removes codes it does not list.
    assert upload_and_wait(client, "prevalence", population_csv("1A00,Rare", "1A01,Rare"), replace_staged=True)["status"] == "valid"
    merge = population_csv("1A00,Rare,Fictional registry (synthetic),FR-1,2026-01-01", header="ICD-11 code,Commonness,Source,Study,Source date")
    merged = upload_and_wait(client, "prevalence", merge, replace_staged=True, mode="merge")
    assert merged["status"] == "valid", merged["report"]
    # The same list as a local population is fine.
    assert upload_and_wait(client, "population", population_csv("1A00,Rare"), **TINY_REGION)["status"] == "valid"

    # The demo's Northbridge list uploaded under Prevalence by mistake.
    northbridge = upload_and_wait(demo_admin, "prevalence", NORTHBRIDGE_FILE.read_bytes(), filename="northbridge-region.csv")
    group = next(group for group in northbridge["report"]["errors"] if group["code"] == "prevalence_incomplete")
    assert group["fix"].startswith("This file lists only 310 of ") and "Local populations" in group["fix"]


def test_population_lifecycle(admin_client):
    """Check, change summary, staged preview, publish, read, replace, remove, roll back."""
    client = admin_client
    default = get(client, "/metrics/concepts/1A00", TINY).json()
    assert default["concept"]["prevalence_tier"] != "very_rare"

    upload = upload_and_wait(client, "population", population_csv("1A00,Very rare"), **TINY_REGION)
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert changes["kind"] == "population"
    assert {name: changes["rows"][name] for name in ("added", "changed", "removed")} == {"added": 1, "changed": 0, "removed": 0}
    assert changes["rows"]["samples"]["added"][0]["code"] == "1A00"

    # Preview: the staged upload adds the population to its staged version only.
    staged = f"staged:{upload['upload_id']}"
    assert client.get(f"{API_PREFIX}/metrics/concepts/1A00", params={**TINY, "population": "tiny-region"}).json()["code"] == "unknown_population"
    preview = get(client, "/metrics/concepts/1A00", {**TINY, "version": staged, "population": "tiny-region"})
    assert preview.headers["x-population"] == "tiny-region" and preview.headers["x-dataset-version"] == staged
    assert preview.json()["concept"]["prevalence_tier"] == "very_rare"
    assert preview.json()["population"] == {"id": "tiny-region", "name": "Tiny region (fictional)"}
    # Without population a staged population upload reads like the default.
    plain = get(client, "/metrics/concepts/1A00", {**TINY, "version": staged})
    assert "x-population" not in plain.headers and normalized(plain.content) == normalized(json.dumps(default).encode())

    entry = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "note": "Tiny region."}).json()
    assert entry["kind"] == "population" and entry["previewed"] is True
    assert entry["summary"].startswith("Local population Tiny region (fictional) (tiny-region): 1 row added")
    meta = get(client, "/meta", {}).json()
    assert meta["populations"] == [{"id": "tiny-region", "name": "Tiny region (fictional)", "codes": 1, "updated_version": entry["version_id"]}]
    local = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
    assert local["concept"]["prevalence_tier"] == "very_rare" and local["concept"]["prevalence_score"] == 0.04
    assert get(client, "/metrics/concepts/1A00", TINY).json()["concept"] == default["concept"]

    # The filled template gives the population's own rows back; uploading it unchanged keeps the name.
    header, rows, _ = read_csv(template(client, "population", filled="true", population_id="tiny-region"))
    assert [row[:3] for row in rows] == [["1A00", rows[0][1], "Very rare"]]
    same = upload_and_wait(client, "population", template(client, "population", filled="true", population_id="tiny-region"), population_id="tiny-region")
    assert same["status"] == "valid" and same["target"]["population_name"] == "Tiny region (fictional)"
    unchanged = client.get(f"{ADMIN}/uploads/{same['upload_id']}/changes").json()
    assert unchanged["rows"]["unchanged"] == 1 and unchanged["rows"]["added"] == 0
    assert client.delete(f"{ADMIN}/uploads/{same['upload_id']}").status_code == 204
    # A filled population template without an id holds the default tiers to edit.
    _, defaults, _ = read_csv(template(client, "population", filled="true"))
    assert len(defaults) == 3

    removed = client.post(f"{ADMIN}/populations/tiny-region/remove", json={"note": "Gone."}).json()
    assert removed["kind"] == "population" and removed["summary"] == "Removed the local population Tiny region (fictional) (tiny-region)."
    assert get(client, "/meta", {}).json()["populations"] == []
    assert client.get(f"{API_PREFIX}/metrics/map", params={**TINY, "scope": "atlas", "population": "tiny-region"}).status_code == 404
    assert client.post(f"{ADMIN}/populations/tiny-region/remove").json()["code"] == "unknown_population"

    restored = client.post(f"{ADMIN}/versions/{entry['version_id']}/rollback", params={"kind": "population"}).json()
    assert restored["kind"] == "population" and restored["rollback_of"] == entry["version_id"]
    assert get(client, "/meta", {}).json()["populations"][0]["updated_version"] == restored["version_id"]
    assert get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()["concept"]["prevalence_tier"] == "very_rare"


# --------------------------------------------------------------- the reads

def test_population_feeds_the_existing_formulas(demo_admin):
    """Reading with Northbridge equals the default answers once the same tiers are
    published as the default prevalence (a prevalence merge of the same file):
    the population only swaps the tiers the existing formulas read (D14). Pack v6's
    local results (contract v1.13, §26) are a population's second layer, not tiers:
    they are restored away first, so this compares the tiers alone."""
    client = demo_admin
    versions = client.get(f"{ADMIN}/versions", params={"kind": "local_metrics"}).json()
    before_local = min(entry["version_id"] for entry in versions if entry["kind"] == "local_metrics") - 1
    restored = client.post(f"{ADMIN}/versions/{before_local}/rollback", params={"kind": "local_metrics"}, json={"note": "Tiers only."})
    assert restored.status_code == 200, restored.text
    reads = [read for read in DEFAULT_READS if read[0] != "/search"] + [("/search", {"q": "pneumonia"})]
    local = {(path, json.dumps(params)): get(client, path, {**params, "population": NORTHBRIDGE}) for path, params in reads}
    default = {key: get(client, key[0], json.loads(key[1])) for key in local}
    shifted = [key for key in local if normalized(local[key].content) != {**normalized(default[key].content), "population": local[key].json()["population"]}]
    assert len(shifted) >= 8, "the population changes most of these reads"

    merge = upload_and_wait(client, "prevalence", NORTHBRIDGE_FILE.read_bytes(), "northbridge.csv", mode="merge")
    assert merge["status"] == "valid", merge["report"]
    assert client.post(f"{ADMIN}/uploads/{merge['upload_id']}/publish", json={"previewed": False}).status_code == 200
    for key, response in local.items():
        expected = normalized(response.content)
        assert expected.pop("population") == {"id": NORTHBRIDGE, "name": "Northbridge region (fictional)"}
        assert normalized(get(client, key[0], json.loads(key[1])).content) == expected, key


def test_default_answers_unchanged_when_a_population_is_published(demo_admin):
    """CONTRACT.md §21: without ``population`` every read returns exactly what it
    returned before (bytes, with the version label normalized), across a publish
    and a removal of a population."""
    client = demo_admin
    before = {(path, json.dumps(params)): get(client, path, params).content for path, params in DEFAULT_READS}
    lookup_body = {"context": {"card": {"model_version": SYN["model"], "use_case": SYN["use_case"]}, "conditions": [{"code": "BA00"}, {"code": "5A11"}]}}
    lookup_before = client.post(f"{API_PREFIX}/lookup", json=lookup_body).content
    before_label = get(client, "/meta", {}).headers["x-dataset-version"]

    rows = [line for line in NORTHBRIDGE_FILE.read_text(encoding="utf-8").splitlines()[1:]]
    flipped = "\n".join(["ICD-11 code,Condition,Commonness", *(",".join([row.split(",")[0], "", "Very rare"]) for row in rows[:200])]) + "\n"
    upload = upload_and_wait(client, "population", flipped.encode(), population_id="southmere-coast", population_name="Southmere coast (fictional)")
    assert upload["status"] == "valid", upload["report"]
    published = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False}).json()
    for stage in ("published", "removed"):
        for key, body in before.items():
            after = get(client, key[0], json.loads(key[1]))
            assert "x-population" not in after.headers
            if key[0].startswith("/export/"):  # carries its own export time
                assert normalized(after.content) == normalized(body), (stage, key)
            else:  # byte-identical apart from the version label
                assert label_free(after) == label_free_bytes(body, before_label), (stage, key)
        lookup_after = client.post(f"{API_PREFIX}/lookup", json=lookup_body)
        assert "population" not in lookup_after.json() and normalized(lookup_after.content) == normalized(lookup_before)
        if stage == "published":
            assert client.post(f"{ADMIN}/populations/southmere-coast/remove").status_code == 200


def test_population_reads_name_the_population_and_key_their_caches(demo_client):
    client = demo_client
    params = {**SYN, "scope": "atlas"}
    default = get(client, "/metrics/map", params)
    local = get(client, "/metrics/map", {**params, "population": NORTHBRIDGE})
    assert "x-population" not in default.headers and "population" not in default.json()
    assert local.headers["x-population"] == NORTHBRIDGE
    assert local.json()["population"] == {"id": NORTHBRIDGE, "name": "Northbridge region (fictional)"}
    assert local.headers["etag"] != default.headers["etag"]
    assert local.headers["x-dataset-version"] == default.headers["x-dataset-version"]
    # The default ETag never validates a population read, and vice versa.
    assert get(client, "/metrics/map", {**params, "population": NORTHBRIDGE}, **{"If-None-Match": default.headers["etag"]}).status_code == 200
    cached = client.get(f"{API_PREFIX}/metrics/map", params={**params, "population": NORTHBRIDGE}, headers={"If-None-Match": local.headers["etag"]})
    assert cached.status_code == 304 and cached.headers["x-population"] == NORTHBRIDGE
    assert get(client, "/metrics/map", params, **{"If-None-Match": local.headers["etag"]}).status_code == 200

    # Every prevalence-dependent read names the population; /meta and /models never take one.
    for path, query in DEFAULT_READS:
        response = get(client, path, {**query, "population": NORTHBRIDGE})
        assert response.headers["x-population"] == NORTHBRIDGE, path
        assert response.json()["population"]["id"] == NORTHBRIDGE, path
    dataset = get(client, "/export/dataset", {"model": "Quillary-Scribe-1.0", "use_case": "Discharge letter generation", "population": NORTHBRIDGE})
    assert dataset.headers["x-population"] == NORTHBRIDGE
    plain = get(client, "/export/dataset", {"model": "Quillary-Scribe-1.0", "use_case": "Discharge letter generation"})
    assert plain.headers["etag"] != dataset.headers["etag"]
    assert json.loads(dataset.content)["population"]["id"] == NORTHBRIDGE and "population" not in json.loads(plain.content)

    # Unknown and malformed ids.
    unknown = client.get(f"{API_PREFIX}/atlas/overview", params={"population": "nowhere"})
    assert unknown.status_code == 404 and unknown.json()["code"] == "unknown_population"
    assert client.get(f"{API_PREFIX}/catalogue", params={"population": "../x"}).status_code == 422


def test_population_tiers_shift_statuses_through_the_penalty_and_weights(demo_client):
    client = demo_client
    rows = {line.split(",")[0]: line for line in NORTHBRIDGE_FILE.read_text(encoding="utf-8").splitlines()[1:]}
    overview = get(client, "/atlas/overview", {}).json()["conditions"]
    local = {concept["concept_id"]: concept for concept in get(client, "/atlas/overview", {"population": NORTHBRIDGE}).json()["conditions"]}
    changed = [concept["concept_id"] for concept in overview if concept["prevalence_tier"] != local[concept["concept_id"]]["prevalence_tier"]]
    assert sorted(changed) == sorted(rows), "exactly the listed codes change tier"
    # Crossing the rare boundary moves the evidence penalty (§4.2) and so some evidence statuses.
    default_summary = get(client, "/metrics/summary", {**SYN, "view": "evidence"}).json()["counts"]
    local_summary = get(client, "/metrics/summary", {**SYN, "view": "evidence", "population": NORTHBRIDGE}).json()["counts"]
    assert default_summary != local_summary and sum(default_summary.values()) == sum(local_summary.values())
    # Rollups weight children by prevalence (§6): a chapter with shifted tiers changes its rollup row.
    chapter = get(client, "/metrics/concepts/CH-11", MEDICORE).json()["metrics"]
    local_chapter = get(client, "/metrics/concepts/CH-11", {**MEDICORE, "population": NORTHBRIDGE}).json()["metrics"]
    assert chapter["perf"] != local_chapter["perf"] or chapter["n_samples"] != local_chapter["n_samples"]


def test_staged_reads_combine_with_a_population(demo_admin):
    """A staged upload of another kind is read for a live population; the population over staged data."""
    client = demo_admin
    upload = upload_and_wait(client, "prevalence", NORTHBRIDGE_FILE.read_bytes(), "northbridge.csv", mode="merge")
    staged = {"version": f"staged:{upload['upload_id']}"}
    both = get(client, "/metrics/summary", {**SYN, **staged, "population": NORTHBRIDGE, "view": "evidence"})
    assert both.headers["x-dataset-version"] == staged["version"] and both.headers["x-population"] == NORTHBRIDGE
    # The staged default already has Northbridge's tiers, so the population adds nothing on top.
    assert both.json()["counts"] == get(client, "/metrics/summary", {**SYN, **staged, "view": "evidence"}).json()["counts"]
    assert client.get(f"{API_PREFIX}/metrics/summary", params={**SYN, **staged, "population": "nowhere"}).json()["code"] == "unknown_population"


def test_forget_staged_keeps_live_population_contexts(demo_admin):
    """A publish, rollback, or discard drops staged contexts only; a live population's context stays cached."""
    client = demo_admin
    store = client.app.state.api.store
    live = store.resolve("live", NORTHBRIDGE)
    upload = upload_and_wait(client, "population", population_csv("5A11,Very rare"), population_id="test-coast", population_name="Test coast (fictional)")
    staged = store.resolve(f"staged:{upload['upload_id']}", "test-coast")
    staged_northbridge = store.resolve(f"staged:{upload['upload_id']}", NORTHBRIDGE)
    assert client.delete(f"{ADMIN}/uploads/{upload['upload_id']}").status_code == 204  # notifies forget_staged
    contexts = list(store._populations.values())
    assert live in contexts and store.resolve("live", NORTHBRIDGE) is live, "the live population context is kept"
    assert staged not in contexts and staged_northbridge not in contexts, "contexts on a staged base are dropped"


def test_a_population_view_shares_no_prevalence_derived_state(demo_db):
    """Every attribute of a population view is either a version input shared on
    purpose or its own; no cache of the default dataset or atlas leaks into it,
    even when the default caches are warm (CONTRACT.md §21)."""
    from app.services.atlas import PREVALENCE_TIER_SCORES, tier_score
    from app.services.dataset import Dataset

    conn = db.connect(demo_db[0], read_only=True)
    try:
        default = Dataset(conn)
        # Warm every cache the default dataset and its atlas have.
        default.metrics(SYN["model"], SYN["use_case"])
        default.multimorbidity(SYN["model"], SYN["use_case"])
        default.safety  # noqa: B018
        default.atlas.by_code  # noqa: B018
        view = default.with_population(NORTHBRIDGE)

        assert set(vars(view)) == set(vars(default)), "the view sets exactly the attributes the constructor sets"
        for name, value in vars(view).items():
            if name in Dataset.SHARED_ATTRIBUTES:
                assert value is getattr(default, name), name
            elif value is not None and not isinstance(value, (int, str)):
                assert value is not getattr(default, name), f"Dataset.{name} is shared with the default dataset"
        assert set(vars(view.atlas)) <= set(vars(default.atlas)) | {"by_code"}
        for name, value in vars(view.atlas).items():
            if name not in ("axes", "prevalence_bounds"):
                assert value is not getattr(default.atlas, name, None), f"Atlas.{name} is shared with the default atlas"

        # Every cached answer uses the population's tiers, scored as load_atlas scores them.
        tiers = view.population.tiers
        changed = [code for code, tier in tiers.items() if default.atlas.by_id[code].prevalence_tier != tier]
        assert changed, "Northbridge changes some tiers"
        for code in changed:
            concept = view.atlas.by_id[code]
            assert concept.prevalence_tier == tiers[code]
            assert concept.prevalence_score == tier_score(tiers[code], view.atlas.prevalence_bounds)
            assert view.atlas.by_code[concept.icd11_code.upper()] is concept, "by_code is the view's own index"
        assert view.metrics(SYN["model"], SYN["use_case"]).atlas is view.atlas
        assert view.multimorbidity(SYN["model"], SYN["use_case"]).atlas is view.atlas
        assert view.safety is not default.safety
        assert set(PREVALENCE_TIER_SCORES) >= set(tiers.values())
    finally:
        conn.close()


def test_lookup_with_a_population(demo_client):
    client = demo_client
    body = {"context": {"card": {"model_version": SYN["model"], "use_case": SYN["use_case"]}, "conditions": [{"code": code} for code in ("1A01", "BA00")], "population_id": NORTHBRIDGE}}
    response = client.post(f"{API_PREFIX}/lookup", json=body)
    assert response.status_code == 200 and response.headers["x-population"] == NORTHBRIDGE
    lookup = response.json()
    assert lookup["population"] == {"id": NORTHBRIDGE, "name": "Northbridge region (fictional)"}
    assert lookup["card"]["card_url"].endswith("&population=northbridge-region")
    for condition in lookup["conditions"]:
        concept = get(client, f"/metrics/concepts/{condition['concept_id']}", {**SYN, "population": NORTHBRIDGE}).json()
        assert condition["statuses"]["evidence"] == concept["metrics"]["status"]["evidence"]
        assert condition["card_url"].endswith("&population=northbridge-region")
    # Unknown or malformed ids: the problem names the field, never the value.
    for value, status in (("nowhere-to-be-found", 404), ("Secret Name", 422)):
        problem = client.post(f"{API_PREFIX}/lookup", json={**body, "context": {**body["context"], "population_id": value}})
        assert problem.status_code == status and value not in problem.text and "population_id" in problem.json()["detail"]


# --------------------------------------------------------------- migration

def _schema_four_store(path, tmp_path, monkeypatch) -> None:
    """The tiny import at schema 4 with history (a prevalence publish) and two staged
    uploads (one valid with its staged set, one invalid), written as schema 4 code wrote them."""
    four = [migration for migration in db.available_migrations() if migration[0] <= 4]
    with monkeypatch.context() as patch:
        patch.setattr(db, "available_migrations", lambda: four)
        import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    now = "2026-10-12T10:00:00Z"
    (prevalence,) = conn.execute("SELECT set_id FROM content_sets WHERE kind = 'prevalence'").fetchone()

    def prevalence_copy(upload_id: str, tier: str) -> int:
        set_id = conn.execute(
            "INSERT INTO content_sets (kind, source, created_at, meta_json) VALUES ('prevalence', ?, ?, '{}')", (f"upload:{upload_id}", now)
        ).lastrowid
        conn.execute("INSERT INTO prevalence_sets SELECT ?, min_score, max_score FROM prevalence_sets WHERE set_id = ?", (set_id, prevalence))
        conn.execute("INSERT INTO prevalence_tiers SELECT ?, code, tier FROM prevalence_tiers WHERE set_id = ?", (set_id, prevalence))
        conn.execute("UPDATE prevalence_tiers SET tier = ? WHERE set_id = ? AND code = '1A00'", (tier, set_id))
        return set_id

    report = json.dumps({"row_count": 1, "errors": [], "notes": []})
    published = prevalence_copy("up-old-1", "rare")
    conn.execute("INSERT INTO dataset_versions (version_id, kind, created_at, summary, upload_id, note) VALUES (2, 'prevalence', ?, 'Prevalence: 1 row changed.', 'up-old-1', 'Before 0005.')", (now,))
    conn.execute("INSERT INTO version_content_sets SELECT 2, set_id FROM version_content_sets WHERE version_id = 1 AND set_id != ?", (prevalence,))
    conn.execute("INSERT INTO version_content_sets VALUES (2, ?)", (published,))
    conn.execute(
        "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json, set_id, published_version) "
        "VALUES ('up-old-1', 'prevalence', 'p.csv', 'csv', 'published', 1, ?, ?, ?, 2)", (now, report, published)
    )
    staged = prevalence_copy("up-old-2", "common")
    conn.execute(
        "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json, set_id) "
        "VALUES ('up-old-2', 'prevalence', 'p.csv', 'csv', 'valid', 1, ?, ?, ?)", (now, report, staged)
    )
    conn.execute(
        "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json, mode) "
        "VALUES ('up-old-3', 'safety', 's.csv', 'csv', 'invalid', 1, ?, ?, 'merge')", (now, report)
    )
    conn.commit()
    assert db.schema_version(conn) == 4
    conn.close()


def test_migration_0005_keeps_history_and_staged_uploads(tmp_path, monkeypatch):
    """A store at schema 4 with published versions and staged uploads migrates in place."""
    path = tmp_path / "tiny.sqlite"
    _schema_four_store(path, tmp_path, monkeypatch)
    conn = sqlite3.connect(path)
    tables = ("dataset_versions", "content_sets", "uploads", "version_content_sets", "prevalence_tiers")
    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    conn.close()

    with local_client(create_app(path, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        conn = db.connect(path, read_only=True)
        assert db.schema_version(conn) == max(number for number, *_ in db.available_migrations())
        assert {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables} == counts
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT COUNT(*) FROM content_sets WHERE population_id IS NOT NULL").fetchone()[0] == 0
        conn.close()
        history = client.get(f"{ADMIN}/versions").json()
        assert [(entry["version_id"], entry["note"]) for entry in history] == [(2, "Before 0005."), (1, None)]
        assert get(client, "/metrics/concepts/1A00", TINY).json()["concept"]["prevalence_tier"] == "rare"
        assert client.get(f"{ADMIN}/uploads/up-old-2").json()["status"] == "valid"
        assert client.get(f"{ADMIN}/uploads/up-old-3").json()["mode"] == "merge"
        assert get(client, "/metrics/concepts/1A00", {**TINY, "version": "staged:up-old-2"}).json()["concept"]["prevalence_tier"] == "common"
        assert client.post(f"{ADMIN}/uploads/up-old-2/publish", json={"previewed": True}).status_code == 200
        local = upload_and_wait(client, "population", population_csv("1A00,Very rare"), **TINY_REGION)
        assert client.post(f"{ADMIN}/uploads/{local['upload_id']}/publish", json={"previewed": False}).status_code == 200
        assert get(client, "/meta", {}).json()["populations"][0]["id"] == "tiny-region"
        assert client.post(f"{ADMIN}/versions/2/rollback", params={"kind": "prevalence"}).status_code == 200
        assert get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()["concept"]["prevalence_tier"] == "very_rare"
