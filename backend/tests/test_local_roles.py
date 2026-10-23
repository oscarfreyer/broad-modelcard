"""Contract v1.13 §26 (E7, E8, E9): local evaluation
results, the instance profile, role workspaces with developer submissions,
nested narrow model cards, public release bundles, and the version feed.

All data is synthetic demonstration data.
"""

from __future__ import annotations

import gzip
import json
import sqlite3

import pytest
from admin_helpers import ADMIN, TINY_TARGET, errors_by_code, notes_by_code, read_csv, template, upload_and_wait, wait, write_csv
from conftest import copy_store, local_client
from tiny_tables import tiny_tables, write_tables

from app import db
from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app
from app.publishing import model_cards

TINY = {"model": "Tiny-1", "use_case": "CDSS"}
REGION = {"population_id": "tiny-region", "population_name": "Tiny region (fictional)"}
OTHER = {"population_id": "other-region", "population_name": "Other region (fictional)"}


def get(client, path, params=None):
    response = client.get(f"{API_PREFIX}{path}", params=params or {})
    assert response.status_code == 200, response.text[:400]
    return response


def publish(client, upload, note="Test.", role="maintainer", name="Test maintainer") -> dict:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(
        f"{ADMIN}/uploads/{upload['upload_id']}/publish",
        json={"previewed": False, "note": note, "role": role, "publisher_name": name},
    )
    assert response.status_code == 200, response.text[:400]
    return response.json()


def stage_records(client, kind, records, **extra) -> dict:
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": kind, "records": records, **extra})
    assert response.status_code == 202, response.text[:400]
    return wait(client, response.json()["upload_id"])


def study(study_id, *, scope="hospital", population_id="tiny-region", **fields) -> dict:
    record = {
        "study_id": study_id, "title": f"Synthetic evaluation {study_id} (fictional)", "design": "Retrospective",
        "setting": "Tiny ward (fictional)", "sites": 1, "patients": 240, "peer_reviewed": False, "conducted_by": "Hospital",
        "reporting_guideline": "None", "risk_of_bias": "Low", "population": "Adults (synthetic)",
        "evaluation_conditions": "Synthetic local evaluation.", "publication_date": "2026-10-10", "scope": scope.title(),
        **({"population_id": population_id} if population_id else {}), **fields,
    }
    return record


def local_rows(client, rows) -> bytes:
    """A local results file: rows of (code, perf, study, age)."""
    header, _, _ = read_csv(template(client, "local_metrics"))
    lines = []
    for code, perf, study_id, age in rows:
        values = {
            "ICD-11 code": code, "Age": age, "Sex": "All sexes", "Ethnicity": "All ethnicities", "Performance": perf,
            "CI low": round(perf - 0.04, 3), "CI high": round(min(1, perf + 0.04), 3), "Samples": 800, "Sites": 2, "Studies": 1,
            "Peer-reviewed studies": 0, "Validation type": "Clinical study (single site)", "In intended use": "Yes",
            "Intended-use coverage": 1, "Intended-use level": "In scope", "Warnings": "", "Source": "Tiny ward evaluation (fictional)",
            "Study": study_id, "Source date": "2026-10-12",
        }
        lines.append([values.get(column, "") for column in header])
    return write_csv(header, lines)


def stage_local(client, rows, population="tiny-region", **form) -> dict:
    return upload_and_wait(client, "local_metrics", local_rows(client, rows), **TINY_TARGET, population_id=population, **form)


def population_csv(*rows):
    return ("\n".join(("ICD-11 code,Commonness", *rows)) + "\n").encode()


def setup_region(client, *, with_other=False):
    publish(client, upload_and_wait(client, "population", population_csv("1A00,Rare"), **REGION))
    if with_other:
        publish(client, upload_and_wait(client, "population", population_csv("1A01,Common"), **OTHER))
    publish(client, stage_records(client, "studies", [study("TW-EVAL-1")]))


def normalized(response) -> bytes:
    label = response.headers["x-dataset-version"]
    body = response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')
    if b'"exported_at"' in body:  # an export carries its own time
        value = json.loads(body)
        value.pop("exported_at")
        body = json.dumps(value).encode()
    return body


READS = [
    ("/metrics/map", {**TINY, "scope": "atlas"}),
    ("/metrics/map", {**TINY, "scope": "chapter", "chapter_id": "CH-01"}),
    ("/metrics/map", {**TINY, "scope": "atlas", "age": "Age 65+"}),
    ("/metrics/summary", {**TINY, "view": "overall"}),
    ("/metrics/concepts/1A00", TINY),
    ("/metrics/concepts/1A00.0", TINY),
    ("/metrics/concepts/BLK-01", TINY),
    ("/metrics/concepts/1A00/subgroups", TINY),
    ("/metrics/concepts/BLK-01/subgroups", TINY),
    ("/catalogue", {}),
    ("/atlas/overview", {}),
    ("/export/concepts/1A00", TINY),
]


# ------------------------------------------------------------ local results

def test_local_results_replace_public_rows_only_for_their_population(admin_client):
    """E7: a local row replaces the public row of its condition and lens for the
    population; without the population, or for another population, every read
    is byte-identical (apart from the version label)."""
    client = admin_client
    setup_region(client, with_other=True)
    reads = READS
    before = {
        (path, json.dumps(params), population): normalized(get(client, path, {**params, **({"population": population} if population else {})}))
        for path, params in reads
        for population in (None, "other-region")
    }
    local_before = json.loads(get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).content)

    upload = stage_local(client, [("1A00", 0.55, "TW-EVAL-1", "All ages")])
    assert upload["status"] == "valid", upload["report"]
    assert upload["target"] == {**TINY_TARGET, "population_id": "tiny-region"}
    entry = publish(client, upload, "Local evaluation.", role="hospital", name="Tiny ward admin")
    assert entry["kind"] == "local_metrics" and entry["publisher_role"] == "hospital"

    for (path, params, population), body in before.items():
        after = get(client, path, {**json.loads(params), **({"population": population} if population else {})})
        assert normalized(after) == body, (path, params, population)

    concept = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
    assert concept["metrics"]["perf"] == 0.55
    assert concept["metrics"]["provenance"]["layer"] == "local"
    assert concept["metrics"]["provenance"]["data_source"]["study"] == "TW-EVAL-1"
    assert concept["metrics"]["appraisal"]["study"]["scope"] == "hospital"
    assert concept["public_metrics"]["perf"] == local_before["metrics"]["perf"]
    assert "layer" not in concept["public_metrics"]["provenance"]
    subtype = get(client, "/metrics/concepts/1A00.0", {**TINY, "population": "tiny-region"}).json()
    assert subtype["metrics"]["provenance"]["layer"] == "local" and subtype["public_metrics"]["perf"] == local_before["metrics"]["perf"]
    # Other lenses and conditions stay public.
    other_lens = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region", "age": "Age 65+"}).json()
    assert "layer" not in other_lens["metrics"]["provenance"] and "public_metrics" not in other_lens
    assert "public_metrics" not in get(client, "/metrics/concepts/1A01", {**TINY, "population": "tiny-region"}).json()

    local_map = get(client, "/metrics/map", {**TINY, "scope": "chapter", "chapter_id": "CH-01", "population": "tiny-region"}).json()
    layers = dict(zip((row[0] for row in local_map["rows"]), local_map["layer"]))
    assert layers == {"BLK-01": "includes_local", "1A00": "local", "1A01": None, "1A00.0": "local", "1A09.1": None}
    perf = dict((row[0], row[local_map["columns"].index("perf")]) for row in local_map["rows"])
    assert perf["1A00"] == 0.55
    # Derivations use the overlaid rows: the block's rollup and the catalogue follow the local row.
    block = get(client, "/metrics/concepts/BLK-01", {**TINY, "population": "tiny-region"}).json()["metrics"]
    block_public = get(client, "/metrics/concepts/BLK-01", {**TINY, "population": "other-region"}).json()["metrics"]
    assert block["perf"] != block_public["perf"]
    assert "layer" not in get(client, "/metrics/map", {**TINY, "scope": "atlas", "population": "other-region"}).json()


def test_dataset_export_holds_local_rows_at_groups_the_public_set_lacks(admin_client):
    """Review fix: the dataset export walked the public set's groups only, so a
    local result at a group the public rows do not store (a product that
    stores all patients only) was served by every read but left out of the
    export (§26.1: exports use the overlaid rows)."""
    client = admin_client
    header, rows, _ = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    age, sex, ethnicity = (header.index(name) for name in ("Age", "Sex", "Ethnicity"))
    all_patients = [row for row in rows if (row[age], row[sex], row[ethnicity]) == ("All ages", "All sexes", "All ethnicities")]
    publish(client, upload_and_wait(client, "metrics", write_csv(header, all_patients), **TINY_TARGET))
    setup_region(client)
    publish(client, stage_local(client, [("1A00", 0.55, "TW-EVAL-1", "Age 65+")]), role="hospital")
    local = {**TINY, "population": "tiny-region"}
    served = get(client, "/metrics/concepts/1A00", {**local, "age": "Age 65+"}).json()["metrics"]
    assert served["perf"] == 0.55 and served["provenance"]["layer"] == "local"
    exported = get(client, "/export/dataset", local).json()["metrics_by_key"]
    layered = [(row["concept_id"], row["lens"]["age"]) for row in exported.values() if row["provenance"].get("layer") == "local"]
    assert layered == [("1A00", "Age 65+"), ("1A00.0", "Age 65+")]  # the condition, and its subcategory through it
    # Without the population the export is what it was: the public groups only.
    public = get(client, "/export/dataset", TINY).json()["metrics_by_key"]
    assert {row["lens"]["age"] for row in public.values()} == {"All ages"}
    # Review fix: the comparison's card facts count the local groups as stored too, so a card
    # with a local result at the group is not "population_differs" (it was "none").
    from app.services.comparison import _stored_lenses, lens_state
    from app.services.types import Lens

    store = client.app.state.api.store
    with store.lock:
        with_local = store.resolve("live", "tiny-region").dataset.metrics("Tiny-1", "CDSS")
        default = store.resolve("live").dataset.metrics("Tiny-1", "CDSS")
    assert lens_state(with_local, Lens(age="Age 65+")) == "stored" and lens_state(default, Lens(age="Age 65+")) == "none"
    assert _stored_lenses(with_local)[::2] == (2, False) and _stored_lenses(default)[::2] == (1, True)
    # ... and list the hospital study the local rows link, as the cells' designs do.
    from app.services.comparison import _card_studies

    with store.lock:
        local_dataset = store.resolve("live", "tiny-region").dataset
        model = local_dataset.model("Tiny-1")
        studies = [study.study_id for study in _card_studies(local_dataset, model, model.use_cases[0])]
        public_studies = _card_studies(store.resolve("live").dataset, model, model.use_cases[0])
    assert studies == ["TW-EVAL-1"] and public_studies == []


def test_local_results_feed_the_subgroup_read(admin_client):
    """R3's getConceptSubgroups reads the overlaid rows for the population (§24, §26)."""
    client = admin_client
    setup_region(client)
    publish(client, stage_local(client, [("1A00", 0.55, "TW-EVAL-1", "All ages"), ("1A00", 0.41, "TW-EVAL-1", "Age 65+")]))
    local = get(client, "/metrics/concepts/1A00/subgroups", {**TINY, "population": "tiny-region"}).json()
    assert local["all_patients"]["perf"] == 0.55 and local["all_patients"]["provenance"]["layer"] == "local"
    older = next(group for group in local["groups"] if group["group"] == "Age 65+")
    assert older["perf"] == 0.41 and older["provenance"]["layer"] == "local"
    public = get(client, "/metrics/concepts/1A00/subgroups", TINY).json()
    assert public["all_patients"]["perf"] != 0.55 and "layer" not in public["all_patients"]["provenance"]
    # Same layer only (§24): the local group against local all patients, public groups against public all patients.
    assert local["all_patients"]["layer"] == "local"
    assert local["public_all_patients"]["layer"] == "public"
    assert local["public_all_patients"]["perf"] == public["all_patients"]["perf"]
    assert older["layer"] == "local" and older["difference"]["compared_with"] == "local"
    assert older["difference"]["delta"] == round(0.41 - 0.55, 3)
    plain = {group["group"]: group for group in public["groups"]}
    for group in local["groups"]:
        if group["group"] == "Age 65+":
            continue
        assert group["layer"] in ("public", None) and group["difference"]["compared_with"] in ("public", None)
        expected = {**plain[group["group"]]["difference"], "compared_with": group["difference"]["compared_with"]}
        assert group["difference"] == expected, group["group"]
    # Without local results for the population nothing new is served.
    for body in (public, get(client, "/metrics/concepts/1A01/subgroups", TINY).json()):
        assert "public_all_patients" not in body
        assert all("layer" not in entry and "compared_with" not in entry.get("difference", {}) for entry in [body["all_patients"], *body["groups"]])


def test_a_local_group_without_local_all_patients_is_not_compared(admin_client):
    """§24: a local group is compared only with a local all-patients result; a block mixes layers."""
    client = admin_client
    setup_region(client)
    publish(client, stage_local(client, [("1A00", 0.41, "TW-EVAL-1", "Age 65+")]))
    local = get(client, "/metrics/concepts/1A00/subgroups", {**TINY, "population": "tiny-region"}).json()
    assert local["all_patients"]["layer"] == "public" and "public_all_patients" not in local
    older = next(group for group in local["groups"] if group["group"] == "Age 65+")
    assert older["layer"] == "local"
    assert older["difference"] == {"delta": None, "direction": None, "flagged": False, "reason": "layer_differs", "compared_with": None}
    others = [group for group in local["groups"] if group["group"] != "Age 65+" and group["has_result"]]
    assert others and all(group["difference"]["compared_with"] == "public" for group in others)
    block = get(client, "/metrics/concepts/BLK-01/subgroups", {**TINY, "population": "tiny-region"}).json()
    assert block["all_patients"]["layer"] == "public"
    block_older = next(group for group in block["groups"] if group["group"] == "Age 65+")
    assert block_older["layer"] == "includes_local" and block_older["difference"]["reason"] == "layer_differs"


def test_local_rows_need_a_hospital_study_of_their_population(admin_client):
    client = admin_client
    setup_region(client, with_other=True)
    publish(client, stage_records(client, "studies", [study("PUB-1", scope="public", population_id=None), study("OTHER-1", population_id="other-region")]))
    upload = stage_local(
        client,
        [("1A00", 0.5, "", "All ages"), ("1A01", 0.5, "PUB-1", "All ages"), ("1A00", 0.5, "OTHER-1", "Age 65+"), ("1A01", 0.5, "NOPE-9", "Age 65+")],
    )
    assert upload["status"] == "invalid"
    errors = errors_by_code(upload)
    assert errors["local_study_missing"]["count"] == 1
    problems = [example["problem"] for example in errors["local_study_mismatch"]["examples"]]
    assert len(problems) == 3
    assert any("public study" in problem for problem in problems)
    assert any("other-region" in problem for problem in problems)
    assert any("not in Studies" in problem for problem in problems)
    unknown = stage_local(client, [("1A00", 0.5, "TW-EVAL-1", "All ages")], population="nowhere", replace_staged=True)
    assert "unknown_population" in errors_by_code(unknown)


def test_hospital_study_needs_a_published_population(admin_client):
    client = admin_client
    upload = stage_records(client, "studies", [study("TW-1", population_id="nowhere"), study("TW-2", population_id=None), study("PUB-2", scope="public", population_id="tiny-region")])
    assert upload["status"] == "invalid"
    assert set(errors_by_code(upload)) == {"unknown_population", "missing_value", "population_without_hospital_scope"}


def test_staged_hospital_studies_are_checked_again_when_their_population_goes(admin_client):
    """Review fix: a staged hospital study names a published population; when
    that population is removed, the study is checked again (it stayed valid,
    so publishing it stored a study of a population no version has)."""
    client = admin_client
    publish(client, upload_and_wait(client, "population", population_csv("1A00,Rare"), **REGION))
    staged = stage_records(client, "studies", [study("TW-LATER")])
    assert staged["status"] == "valid", staged["report"]
    removed = client.post(f"{ADMIN}/populations/tiny-region/remove", json={"note": "Gone."})
    assert removed.status_code == 200, removed.text
    again = wait(client, staged["upload_id"])
    assert again["status"] == "invalid" and "unknown_population" in errors_by_code(again)


def test_staged_local_results_preview_and_summary(admin_client):
    client = admin_client
    setup_region(client)
    upload = stage_local(client, [("1A00", 0.4, "TW-EVAL-1", "All ages")])
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert changes["kind"] == "local_metrics" and changes["rows"]["added"] == 1
    assert any(shift["view"] == "performance" for shift in changes["status_shifts"])
    staged = get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region", "version": f"staged:{upload['upload_id']}"}).json()
    assert staged["metrics"]["perf"] == 0.4 and staged["dataset_version"] == f"staged:{upload['upload_id']}"
    assert "public_metrics" not in get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
    filled = read_csv(template(client, "local_metrics", filled="true", **TINY_TARGET, population_id="tiny-region"))[1]
    assert filled == []
    publish(client, upload)
    header, rows, _ = read_csv(template(client, "local_metrics", filled="true", **TINY_TARGET, population_id="tiny-region"))
    assert [row[header.index("Study")] for row in rows] == ["TW-EVAL-1"]
    datasets = {info["kind"]: info for info in client.get(f"{ADMIN}/datasets").json()}
    assert datasets["local_metrics"]["counts"] == {"use_cases": 1, "populations": 1, "metric_rows": 1}
    # Removing the population takes its local results with it; a restore brings both back.
    removed = client.post(f"{ADMIN}/populations/tiny-region/remove", json={"note": "Gone."}).json()
    assert {info["kind"]: info for info in client.get(f"{ADMIN}/datasets").json()}["local_metrics"]["counts"]["use_cases"] == 0
    restored = client.post(f"{ADMIN}/versions/{removed['version_id'] - 1}/rollback", params={"every_kind": "true"}, json={"note": "Back."})
    assert restored.status_code == 200
    assert get(client, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()["metrics"]["perf"] == 0.4


# ------------------------------------------------------ roles and the feed

def test_publisher_role_and_name_in_history_and_feed(admin_client):
    client = admin_client
    publish(client, upload_and_wait(client, "population", population_csv("1A00,Rare"), **REGION), "Region.", role="hospital", name="H. Admin")
    history = client.get(f"{ADMIN}/versions").json()
    assert (history[0]["publisher_role"], history[0]["publisher_name"]) == ("hospital", "H. Admin")
    assert (history[-1]["publisher_role"], history[-1]["publisher_name"]) == (None, None)
    feed = get(client, "/versions").json()
    assert [entry["version_id"] for entry in feed["versions"]] == [2, 1]
    assert feed["versions"][0] == {
        "version_id": 2, "published_at": history[0]["published_at"], "kind": "population", "summary": history[0]["summary"],
        "note": "Region.", "publisher_role": "hospital",
    }
    assert [entry["version_id"] for entry in get(client, "/versions", {"after": 1}).json()["versions"]] == [2]
    cached = get(client, "/versions")
    assert client.get(f"{API_PREFIX}/versions", headers={"If-None-Match": cached.headers["etag"]}).status_code == 304
    upload = upload_and_wait(client, "population", population_csv("1A00,Common"), **REGION)
    refused = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "role": "developer"})
    assert refused.status_code == 422
    assert client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False, "role": "nobody"}).status_code == 422


def test_instance_profile(admin_client):
    client = admin_client
    assert get(client, "/meta").json()["instance"] == {
        "kind": "public", "organisation": "Broad Modelcard (demonstration)", "maintained_by": "the Broad Modelcard project", "contact": None,
    }
    profile = {"kind": "hospital", "organisation": "Tiny Hospital (fictional)", "maintained_by": "Clinical AI office (fictional)", "contact": "ai-office@tiny.example"}
    response = client.put(f"{ADMIN}/instance", json=profile)
    assert response.status_code == 200 and response.json() == profile
    assert get(client, "/meta").json()["instance"] == profile
    assert client.put(f"{ADMIN}/instance", json={**profile, "kind": "clinic"}).status_code == 422
    assert client.put(f"{ADMIN}/instance", json={**profile, "organisation": ""}).status_code == 422


# ------------------------------------------------------------- submissions

NEW_SYSTEM = {
    "model_version": "Tiny-2", "display_name": "Tiny-2 (fictional)", "status": "EXPERIMENTAL", "use_case": "CDSS",
    "kind": "Model", "ai_type": "Tabular risk model", "developer": "Tiny Labs (fictional)", "release_date": "2026-09-01",
}
CARD_JSON = {
    "name": "Tiny-2", "version": "2.0", "license": "CC BY 4.0", "intended_use": "Synthetic decision support.",
    "limitations": "Synthetic only.", "training_data": "Synthetic cases.", "date": "2026-10-01",
    "model-index": [{"name": "Tiny-2", "results": [
        {"task": {"type": "classification", "name": "Triage"}, "dataset": {"name": "Tiny bench (fictional)"},
         "metrics": [{"type": "accuracy", "value": 0.83, "icd11_codes": ["1A00", "1A00.0", "ZZ99"]}]},
        {"task": "Summarisation", "dataset": "Notes (fictional)", "metrics": [{"type": "rouge", "value": 0.4}]},
    ]}],
}


def open_submission(client, model_version="Tiny-2", name="Dev Tester") -> dict:
    response = client.post(f"{ADMIN}/submissions", json={"developer_name": name, "model_version": model_version, "note": "Please review."})
    assert response.status_code == 201, response.text
    return response.json()


def stage_submission(client) -> dict:
    submission = open_submission(client)
    sid = submission["submission_id"]
    header, rows, _ = read_csv(template(client, "metrics", filled="true", **TINY_TARGET))
    # A new card's metrics name a function the registry does not list yet: invalid until the
    # submission's registry entry joins, then checked again (the parts check each other).
    metrics = upload_and_wait(client, "metrics", write_csv(header, rows), model_version="Tiny-2", use_case="CDSS", submission_id=sid)
    assert "unknown_target" in errors_by_code(metrics)
    registry = stage_records(client, "models", [NEW_SYSTEM], submission_id=sid)
    assert registry["status"] == "valid", registry["report"]
    assert wait(client, metrics["upload_id"])["status"] == "valid"
    studies = stage_records(client, "studies", [study("DEV-1", scope="public", population_id=None, conducted_by="Developer", model_version="Tiny-2")], submission_id=sid)
    assert studies["status"] == "valid", studies["report"]
    card = client.post(f"{ADMIN}/uploads/model-card", json={"model_version": "Tiny-2", "format": "json", "content": json.dumps(CARD_JSON), "submission_id": sid})
    assert card.status_code == 202, card.text
    card = wait(client, card.json()["upload_id"])
    assert card["status"] == "valid", card["report"]
    return client.get(f"{ADMIN}/submissions/{sid}").json()


def test_submission_waits_for_the_custodian_and_publishes_in_order(admin_client):
    """E8: a developer submission (with a narrow model card) appears in the queue,
    can be previewed, never publishes on its own, and the custodian's
    acceptance publishes it with role and name in History."""
    client = admin_client
    submission = stage_submission(client)
    assert submission["status"] == "submitted" and len(submission["uploads"]) == 4
    assert all(upload["submission_id"] == submission["submission_id"] for upload in submission["uploads"])
    queue = client.get(f"{ADMIN}/submissions", params={"status": "submitted"}).json()
    assert [entry["submission_id"] for entry in queue] == [submission["submission_id"]]
    # Submission uploads are not the data sets' staged uploads, and never publish on their own.
    assert all(info["staged_upload_id"] is None for info in client.get(f"{ADMIN}/datasets").json())
    for upload in submission["uploads"]:
        refused = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": True})
        assert refused.status_code == 409 and refused.json()["code"] == "submission_upload"
    assert get(client, "/meta").json()["dataset_version"] == "1"
    # A maintainer can still stage the same data sets meanwhile.
    own = stage_records(client, "studies", [study("MAINT-1", scope="public", population_id=None)])
    assert own["status"] == "valid"
    # Preview: the staged registry entry and the card read on the atlas.
    registry = next(upload for upload in submission["uploads"] if upload["kind"] == "models")
    staged_models = get(client, "/models", {"version": f"staged:{registry['upload_id']}"}).json()
    assert "Tiny-2" in [model["model_version"] for model in staged_models["models"]]

    accepted = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/accept", json={"note": "Reviewed.", "publisher_name": "C. Ustodian"})
    assert accepted.status_code == 200, accepted.text
    accepted = accepted.json()
    assert accepted["status"] == "accepted" and accepted["decided_by"] == "C. Ustodian" and len(accepted["published_versions"]) == 4
    history = {entry["version_id"]: entry for entry in client.get(f"{ADMIN}/versions").json()}
    kinds = [history[version]["kind"] for version in accepted["published_versions"]]
    assert kinds == ["metrics", "models", "studies", "model_cards"]
    assert {(history[version]["publisher_role"], history[version]["publisher_name"], history[version]["note"]) for version in accepted["published_versions"]} == {
        ("custodian", "C. Ustodian", "Reviewed.")
    }
    assert "Tiny-2" in [model["model_version"] for model in get(client, "/models").json()["models"]]
    card = get(client, "/models/Tiny-2/narrow-model-card").json()["narrow_model_card"]
    assert card["name"] == "Tiny-2" and card["licence"] == "CC BY 4.0" and card["source_format"] == "json"
    assert [result["metric"] for result in card["results"]] == ["accuracy", "rouge"]
    assert get(client, "/models/Tiny-1/narrow-model-card").json()["narrow_model_card"] is None
    assert client.get(f"{API_PREFIX}/models/Nope/narrow-model-card").status_code == 404
    again = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/accept", json={})
    assert again.status_code == 409 and again.json()["code"] == "submission_closed"


def test_a_failed_publish_keeps_the_versions_already_published(admin_client, monkeypatch):
    """Code review: when a later part fails to publish, the versions this accept
    already published stay recorded on the submission, which stays submitted."""
    from app.publishing.uploads import AdminError

    client = admin_client
    submission = stage_submission(client)
    admin = client.app.state.api.admin
    original = type(admin).publish
    calls = {"n": 0}

    def flaky(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise AdminError(409, "publish_in_progress", "Another publish is running.")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(admin), "publish", flaky)
    refused = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/accept", json={"note": "Reviewed."})
    assert refused.status_code == 409 and refused.json()["code"] == "publish_in_progress"
    after = client.get(f"{ADMIN}/submissions/{submission['submission_id']}").json()
    assert after["status"] == "submitted" and len(after["published_versions"]) == 2
    monkeypatch.setattr(type(admin), "publish", original)
    accepted = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/accept", json={"note": "Reviewed."}).json()
    assert accepted["status"] == "accepted" and len(accepted["published_versions"]) == 4


def test_no_second_decision_while_a_submission_is_being_accepted(admin_client, monkeypatch):
    """Review fix: a return (or a second accept) sent while an accept publishes
    is refused with 409 publish_in_progress; before, a return midway discarded
    the remaining parts and the accept then wrote the submission back to
    submitted, losing the return."""
    from app.publishing.uploads import AdminError

    client = admin_client
    submission = stage_submission(client)
    sid = submission["submission_id"]
    admin = client.app.state.api.admin
    original = type(admin).publish
    refusals = []

    def meanwhile(self, *args, **kwargs):
        for decide in (lambda: admin.return_submission(sid, note="Changed my mind."), lambda: admin.accept_submission(sid)):
            try:
                decide()
            except AdminError as error:
                refusals.append(error.code)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(admin), "publish", meanwhile)
    accepted = client.post(f"{ADMIN}/submissions/{sid}/accept", json={"note": "Reviewed."}).json()
    assert accepted["status"] == "accepted" and len(accepted["published_versions"]) == 4
    assert set(refusals) == {"publish_in_progress"} and len(refusals) == 8


def test_submission_returned_with_a_note(admin_client):
    client = admin_client
    submission = stage_submission(client)
    assert client.post(f"{ADMIN}/submissions/{submission['submission_id']}/return", json={}).status_code == 422
    returned = client.post(f"{ADMIN}/submissions/{submission['submission_id']}/return", json={"note": "Add the evaluation.", "publisher_name": "C"}).json()
    assert returned["status"] == "returned" and returned["custodian_note"] == "Add the evaluation."
    assert {upload["status"] for upload in returned["uploads"]} == {"discarded"}
    assert get(client, "/meta").json()["dataset_version"] == "1"
    refused = client.post(f"{ADMIN}/uploads/records", json={"kind": "studies", "records": [study("X", scope="public", population_id=None)], "submission_id": submission["submission_id"]})
    assert refused.status_code == 409 and refused.json()["code"] == "submission_closed"


def test_submission_with_a_failing_part_is_not_accepted(admin_client):
    client = admin_client
    submission = open_submission(client, "Tiny-1")
    sid = submission["submission_id"]
    bad = stage_records(client, "studies", [study("BAD-1", scope="public", population_id=None, sites=0)], submission_id=sid)
    assert bad["status"] == "invalid"
    refused = client.post(f"{ADMIN}/submissions/{sid}/accept", json={})
    assert refused.status_code == 409 and refused.json()["code"] == "submission_not_ready"
    assert get(client, "/meta").json()["dataset_version"] == "1"
    assert client.get(f"{ADMIN}/submissions/nope").status_code == 404
    assert client.post(f"{ADMIN}/uploads/records", json={"kind": "models", "records": [NEW_SYSTEM]}).status_code == 422


# -------------------------------------------------------- narrow model cards

def test_json_card_reads_hugging_face_model_index():
    card, problems = model_cards.parse_card(json.dumps(CARD_JSON), "json", "Tiny-2")
    assert not problems.errors and card["licence"] == "CC BY 4.0"
    assert [(result["task"], result["dataset"], result["metric"], result["value"]) for result in card["results"]] == [
        ("Triage", "Tiny bench (fictional)", "accuracy", 0.83), ("Summarisation", "Notes (fictional)", "rouge", 0.4)
    ]
    assert card["results"][0]["icd11_codes"] == ["1A00", "1A00.0", "ZZ99"]
    flat, problems = model_cards.parse_card(json.dumps({"name": "X", "results": [{"metric": "auroc", "value": "0.9", "icd11_codes": "1A00; 1A01"}]}), "json", "X")
    assert not problems.errors and flat["results"][0]["icd11_codes"] == ["1A00", "1A01"]
    for broken, code in (("{", "invalid_model_card"), ("[]", "invalid_model_card"), (json.dumps({"results": []}), "model_card_field"),
                         (json.dumps({"name": "X", "results": [{"metric": "a", "value": "high"}]}), "model_card_field"),
                         (json.dumps({"name": "X", "model_version": "Other"}), "model_card_field"),
                         # Review fix: deep nesting is an unreadable card, not an internal error of the check.
                         ("[" * 200_000 + "]" * 200_000, "invalid_model_card")):
        card, problems = model_cards.parse_card(broken, "json", "X")
        assert card is None and problems.errors[0][0] == code, broken


def test_markdown_front_matter_reads_a_safe_subset_and_refuses_the_rest():
    text = "\n".join([
        "---",
        "model_name: Tiny-3",
        "version: '3.1'",
        "license: apache-2.0",
        "# a comment",
        "tags:",
        "  - clinical",
        "  - synthetic",
        "model-index:",
        "  - name: Tiny-3",
        "    results:",
        "      - task: {type: classification}",
        "datasets: [a, b]",
        "intended_use: |",
        "  multi-line",
        "---",
        "# Tiny-3",
        "## Limitations",
        "Synthetic only.",
        "## Training data",
        "Synthetic notes.",
    ])
    card, problems = model_cards.parse_card(text, "markdown", "Tiny-3")
    assert not problems.errors
    assert (card["name"], card["version"], card["licence"]) == ("Tiny-3", "3.1", "apache-2.0")
    assert card["limitations"] == "Synthetic only." and card["training_data"] == "Synthetic notes."
    assert card["results"] == []
    refused = {code for code, _, _ in problems.notes}
    assert refused == {"unsupported_front_matter"}
    lines = sorted(line for _, _, line in problems.notes)
    assert lines == [10, 13, 14], problems.notes  # model-index's first item, a flow list, a block scalar
    unterminated, problems = model_cards.parse_card("---\nname: x\n", "markdown", "x")
    assert unterminated is None and problems.errors[0][0] == "invalid_model_card"
    plain, problems = model_cards.parse_card("# Plain card\n\nNo front matter.", "markdown", "Plain-1")
    assert plain["name"] == "Plain card" and not problems.errors and not problems.notes


def test_markdown_card_upload_keeps_the_text_and_notes_unsupported_parts(admin_client):
    client = admin_client
    text = "---\nname: Tiny-1 card\nmodel-index:\n  - name: x\n---\n# Tiny-1\n## Intended use\nSynthetic.\n"
    response = client.post(f"{ADMIN}/uploads/model-card", json={"model_version": "Tiny-1", "format": "markdown", "content": text})
    upload = wait(client, response.json()["upload_id"])
    assert upload["status"] == "valid" and "unsupported_front_matter" in notes_by_code(upload)
    publish(client, upload)
    card = get(client, "/models/Tiny-1/narrow-model-card").json()["narrow_model_card"]
    assert card["source_format"] == "markdown" and card["markdown"] == text and card["intended_use"] == "Synthetic."
    unknown = client.post(f"{ADMIN}/uploads/model-card", json={"model_version": "Nope-1", "format": "json", "content": json.dumps({"name": "x"})})
    assert errors_by_code(wait(client, unknown.json()["upload_id"])).keys() == {"unknown_target"}
    assert client.get(f"{ADMIN}/templates/model_cards.csv").status_code == 422


def test_card_results_are_proposed_and_staged_never_published(admin_client):
    client = admin_client
    response = client.post(f"{ADMIN}/uploads/model-card", json={"model_version": "Tiny-1", "format": "json", "content": json.dumps({**CARD_JSON, "name": "Tiny-1"})})
    upload = wait(client, response.json()["upload_id"])
    assert upload["status"] == "valid" and "unknown_result_code" in notes_by_code(upload)
    proposals = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/proposed-records").json()
    [batch] = proposals["batches"]
    assert (batch["model_version"], batch["use_case"]) == ("Tiny-1", "CDSS")
    assert [record["code"] for record in batch["records"]] == ["1A00", "1A00"]  # 1A00.0 proposes its condition
    assert batch["records"][0]["perf"] == 0.83 and batch["records"][0]["intended_use_level"] == "in_scope"
    assert [skip["code"] for skip in proposals["skipped"]] == ["ZZ99"]
    staged = stage_records(client, "metrics", batch["records"][:1], **TINY_TARGET)
    assert staged["status"] == "valid", staged["report"]
    assert get(client, "/meta").json()["dataset_version"] == "1"
    assert get(client, "/metrics/concepts/1A00", TINY).json()["metrics"]["perf"] != 0.83
    assert client.get(f"{ADMIN}/uploads/{staged['upload_id']}/proposed-records").status_code == 409


# --------------------------------------------------------------- releases

def _hospital(client):
    client.put(f"{ADMIN}/instance", json={"kind": "hospital", "organisation": "Tiny Hospital (fictional)", "maintained_by": "AI office (fictional)"})


def test_release_bundle_import_keeps_local_layers(tiny_db, tmp_path):
    """E9: a hospital instance imports a public release and keeps its local
    layers across a second import."""
    public_store = copy_store(tiny_db, tmp_path / "public.sqlite")
    hospital_store = copy_store(tiny_db, tmp_path / "hospital.sqlite")
    with local_client(create_app(public_store, validate_responses=True, uploads_dir=tmp_path / "public-uploads")) as public:
        publish(public, stage_records(public, "studies", [study("PUB-1", scope="public", population_id=None)]))
        response = public.post(f"{ADMIN}/uploads/model-card", json={"model_version": "Tiny-1", "format": "json", "content": json.dumps({**CARD_JSON, "name": "Tiny-1"})})
        publish(public, wait(public, response.json()["upload_id"]))
        exported = public.get(f"{ADMIN}/release/export")
        assert exported.status_code == 200 and exported.headers["content-type"] == "application/gzip"
        first_bundle = exported.content
        header, rows, _ = read_csv(template(public, "metrics", filled="true", **TINY_TARGET))
        rows[0][header.index("Performance")] = "0.71"
        rows[0][header.index("CI low")] = "0.68"
        rows[0][header.index("CI high")] = "0.74"
        publish(public, upload_and_wait(public, "metrics", write_csv(header, rows), **TINY_TARGET))
        second_bundle = public.get(f"{ADMIN}/release/export").content
        _hospital(public)
        assert public.get(f"{ADMIN}/release/export").json()["code"] == "not_public_instance"

    with local_client(create_app(hospital_store, validate_responses=True, uploads_dir=tmp_path / "hospital-uploads")) as hospital:
        refused = hospital.post(f"{ADMIN}/release/imports", files={"file": ("r.sqlite.gz", first_bundle, "application/gzip")})
        assert refused.status_code == 409 and refused.json()["code"] == "not_hospital_instance"
        _hospital(hospital)
        setup_region(hospital)
        publish(hospital, stage_local(hospital, [("1A00", 0.5, "TW-EVAL-1", "All ages")]), role="hospital")
        incident = {
            "incident_id": "H-1", "model_version": "Tiny-1", "use_case": "CDSS", "codes": "1A01", "incident_type": "Other",
            "harm": "None", "status": "Open", "source_type": "Incident report", "source_reference": "Ward report (fictional)",
            "reported_date": "2026-10-11", "summary": "Synthetic local incident.", "scope": "Hospital",
        }
        publish(hospital, stage_records(hospital, "safety", [incident]))

        def import_and_publish(bundle: bytes) -> dict:
            checked = hospital.post(f"{ADMIN}/release/imports", files={"file": ("release.sqlite.gz", bundle, "application/gzip")})
            assert checked.status_code == 201, checked.text
            checked = checked.json()
            assert checked["status"] == "valid", checked["problems"]
            assert checked["keeps"] == {"populations": 1, "local_results": 1, "hospital_studies": 1, "hospital_incidents": 1}
            assert hospital.get(f"{ADMIN}/release/imports/{checked['import_id']}").json()["status"] == "valid"
            entry = hospital.post(f"{ADMIN}/release/imports/{checked['import_id']}/publish", json={"note": "Public release.", "role": "hospital", "publisher_name": "H"})
            assert entry.status_code == 200, entry.text
            return checked | {"entry": entry.json()}

        first = import_and_publish(first_bundle)
        assert first["changes"]["studies"]["added"] == 1 and first["changes"]["model_cards"]["added"] == 1
        assert first["changes"]["metrics"] == {"added": 0, "changed": 0, "removed": 0, "unchanged": 1}
        assert first["entry"]["kind"] is None and first["entry"]["publisher_role"] == "hospital"
        second = import_and_publish(second_bundle)
        assert second["changes"]["metrics"]["changed"] == 1
        # The local layers stay: population, local results, hospital study, hospital incident.
        local = get(hospital, "/metrics/concepts/1A00", {**TINY, "population": "tiny-region"}).json()
        assert local["metrics"]["perf"] == 0.5 and local["metrics"]["provenance"]["layer"] == "local"
        studies = {entry["study_id"]: entry["scope"] for entry in get(hospital, "/studies").json()["studies"]}
        assert studies == {"PUB-1": "public", "TW-EVAL-1": "hospital"}
        incidents = hospital.get(f"{ADMIN}/safety/incidents").json()["incidents"]
        assert [(entry["incident_id"], entry["scope"]) for entry in incidents] == [("H-1", "hospital")]
        assert get(hospital, "/models/Tiny-1/narrow-model-card").json()["narrow_model_card"]["name"] == "Tiny-1"
        public_perf = get(hospital, "/metrics/concepts/1A00", TINY).json()["metrics"]["perf"]
        assert public_perf == 0.71
        # A damaged or foreign bundle is refused before anything is published.
        broken = hospital.post(f"{ADMIN}/release/imports", files={"file": ("x.sqlite.gz", gzip.compress(b"not sqlite"), "application/gzip")}).json()
        assert broken["status"] == "invalid" and broken["problems"][0]["code"] == "invalid_bundle"
        assert hospital.post(f"{ADMIN}/release/imports/{broken['import_id']}/publish", json={}).json()["code"] == "import_not_valid"
        plain = hospital.post(f"{ADMIN}/release/imports", files={"file": ("x.sqlite", b"SQLite", "application/octet-stream")}).json()
        assert plain["status"] == "invalid"
        third = hospital.post(f"{ADMIN}/release/imports", files={"file": ("release.sqlite.gz", second_bundle, "application/gzip")}).json()
        assert hospital.delete(f"{ADMIN}/release/imports/{third['import_id']}").status_code == 204
        assert hospital.delete(f"{ADMIN}/release/imports/{third['import_id']}").status_code == 409


def test_tampered_bundle_fails_its_checksum(tiny_db, tmp_path):
    store = copy_store(tiny_db, tmp_path / "public.sqlite")
    with local_client(create_app(store, uploads_dir=tmp_path / "uploads")) as client:
        bundle = client.get(f"{ADMIN}/release/export").content
        raw = tmp_path / "bundle.sqlite"
        raw.write_bytes(gzip.decompress(bundle))
        conn = sqlite3.connect(raw)
        conn.execute("UPDATE metric_rows SET perf = 0.01 WHERE rowid = 1")
        conn.commit()
        conn.close()
        _hospital(client)
        checked = client.post(f"{ADMIN}/release/imports", files={"file": ("t.sqlite.gz", gzip.compress(raw.read_bytes()), "application/gzip")}).json()
        assert checked["status"] == "invalid" and checked["problems"][0]["code"] == "bundle_checksum"


def _edited_bundle(bundle: bytes, tmp_path, edit, *, name: str, reseal: bool = False) -> bytes:
    """``bundle`` with ``edit(conn, manifest)`` applied; ``reseal`` recomputes the
    manifest's checksums afterwards (as a hand-made bundle would)."""
    from app.publishing import release

    raw = tmp_path / f"{name}.sqlite"
    raw.write_bytes(gzip.decompress(bundle))
    conn = sqlite3.connect(raw)
    manifest = json.loads(conn.execute("SELECT value_json FROM bundle_manifest").fetchone()[0])
    edit(conn, manifest)
    if reseal:
        for table in release.BUNDLE_TABLES:
            rows, digest = release._table_digest(conn, table)
            manifest["tables"][table] = {"rows": rows, "sha256": digest}
    conn.execute("UPDATE bundle_manifest SET value_json = ?", (json.dumps(manifest),))
    conn.commit()
    conn.close()
    return gzip.compress(raw.read_bytes())


def test_malformed_bundles_are_invalid_not_server_errors(tiny_db, tmp_path):
    """Review fix: a bundle is untrusted input. A manifest with a missing or foreign
    table, an odd set, unreadable JSON, or a table of another schema is an
    invalid import (no 500, no SQL built from its names), and leaves no files behind."""
    store = copy_store(tiny_db, tmp_path / "store.sqlite")
    uploads = tmp_path / "uploads"
    with local_client(create_app(store, validate_responses=True, uploads_dir=uploads)) as client:
        bundle = client.get(f"{ADMIN}/release/export").content
        _hospital(client)

        def drop_key(key):
            return lambda conn, manifest: manifest.pop(key)

        def foreign_table(conn, manifest):
            manifest["tables"]["sqlite_master WHERE 1=1 --"] = manifest["tables"].pop("studies")

        def odd_set(conn, manifest):
            manifest["sets"][0]["kind"] = "local_metrics"

        def not_json(conn, manifest):
            conn.execute("UPDATE bundle_manifest SET value_json = '{not json'")

        def other_schema(conn, manifest):
            conn.execute("ALTER TABLE studies ADD COLUMN extra TEXT")

        def broken_warnings(conn, manifest):
            conn.execute("UPDATE warning_sets SET codes_json = '[[[' WHERE rowid = 1")

        cases = {
            "tables": drop_key("tables"),
            "sets": drop_key("sets"),
            "foreign": foreign_table,
            "odd-set": odd_set,
            "other-schema": other_schema,
            "broken-warnings": broken_warnings,  # resealed: it passes the checksums, but a publish could not read it
        }
        for name, edit in cases.items():
            edited = _edited_bundle(bundle, tmp_path, edit, name=name, reseal=name == "broken-warnings")
            response = client.post(f"{ADMIN}/release/imports", files={"file": (f"{name}.sqlite.gz", edited, "application/gzip")})
            assert response.status_code == 201, (name, response.text)
            checked = response.json()
            assert checked["status"] == "invalid" and checked["problems"][0]["code"] == "invalid_bundle", (name, checked)
        # A manifest that is not JSON (written last, so the edit is not overwritten).
        raw = tmp_path / "raw.sqlite"
        raw.write_bytes(gzip.decompress(bundle))
        conn = sqlite3.connect(raw)
        not_json(conn, None)
        conn.commit()
        conn.close()
        checked = client.post(f"{ADMIN}/release/imports", files={"file": ("j.sqlite.gz", gzip.compress(raw.read_bytes()), "application/gzip")}).json()
        assert checked["status"] == "invalid" and checked["problems"][0]["code"] == "invalid_bundle"
        assert not any((uploads / "releases").iterdir())


def test_bundle_rows_the_store_refuses_are_a_problem_not_a_server_error(tiny_db, tmp_path):
    """Review fix: a resealed bundle whose rows break the store's constraints
    passes the check but cannot be copied; publishing answers 409
    ``invalid_bundle`` and writes nothing (it used to answer 500)."""
    store = copy_store(tiny_db, tmp_path / "store.sqlite")
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        bundle = client.get(f"{ADMIN}/release/export").content
        _hospital(client)

        def unknown_concept(conn, manifest):
            conn.execute("UPDATE metric_rows SET concept_id = 'NOT-A-CONCEPT' WHERE rowid = 1")

        edited = _edited_bundle(bundle, tmp_path, unknown_concept, name="fk", reseal=True)
        checked = client.post(f"{ADMIN}/release/imports", files={"file": ("fk.sqlite.gz", edited, "application/gzip")}).json()
        assert checked["status"] == "valid", checked["problems"]
        before = get(client, "/meta").json()["dataset_version"]
        refused = client.post(f"{ADMIN}/release/imports/{checked['import_id']}/publish", json={})
        assert refused.status_code == 409 and refused.json()["code"] == "invalid_bundle"
        assert get(client, "/meta").json()["dataset_version"] == before
        # A discarded import is never published, however the requests interleave.
        assert client.delete(f"{ADMIN}/release/imports/{checked['import_id']}").status_code == 204
        assert client.post(f"{ADMIN}/release/imports/{checked['import_id']}/publish", json={}).json()["code"] == "import_not_valid"


# --------------------------------------------------------------- migration

def test_migration_0010_from_a_schema_9_store(tmp_path, monkeypatch):
    """A store at schema 9 (after R6's effects) with history and a staged upload migrates in place."""
    path = tmp_path / "tiny.sqlite"
    nine = [migration for migration in db.available_migrations() if migration[0] <= 9]
    with monkeypatch.context() as patch:
        patch.setattr(db, "available_migrations", lambda: nine)
        import_legacy_tables(write_tables(tmp_path / "tables", tiny_tables()), path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    now = "2026-10-12T10:00:00Z"
    conn.execute("INSERT INTO dataset_versions (version_id, kind, created_at, summary, note) VALUES (2, 'models', ?, 'AI systems & functions: no changes.', 'Before 0010.')", (now,))
    conn.execute("INSERT INTO version_content_sets SELECT 2, set_id FROM version_content_sets WHERE version_id = 1")
    conn.execute(
        "INSERT INTO uploads (upload_id, kind, filename, file_format, status, progress, created_at, report_json) "
        "VALUES ('up-old', 'prevalence', 'p.csv', 'csv', 'invalid', 1, ?, '{\"row_count\": 0, \"errors\": [], \"notes\": []}')",
        (now,),
    )
    conn.commit()
    assert db.schema_version(conn) == 9
    tables = ("dataset_versions", "content_sets", "uploads", "version_content_sets")
    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    conn.close()
    with local_client(create_app(path, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        conn = db.connect(path, read_only=True)
        assert db.schema_version(conn) == max(number for number, *_ in db.available_migrations())
        assert {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables} == counts
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.close()
        history = client.get(f"{ADMIN}/versions").json()
        assert [(entry["version_id"], entry["note"], entry["publisher_role"]) for entry in history] == [(2, "Before 0010.", None), (1, None, None)]
        assert client.get(f"{ADMIN}/uploads/up-old").json()["submission_id"] is None
        assert get(client, "/meta").json()["instance"]["kind"] == "public"
        assert get(client, "/versions").json()["versions"][0]["note"] == "Before 0010."
        setup_region(client)
        assert stage_local(client, [("1A00", 0.6, "TW-EVAL-1", "All ages")])["status"] == "valid"
