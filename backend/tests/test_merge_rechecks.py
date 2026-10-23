"""Merge uploads checked again (S3 code review): the catalogue never serves a
re-checked staged set's old counts, and a merge whose base moves while it is
being checked is checked again instead of ending stuck as outdated."""

from __future__ import annotations

import threading

from admin_helpers import ADMIN, TINY_TARGET, admin_service, post_upload, upload_and_wait, wait
from conftest import local_client
from test_safety_merge import SOURCE, merge_file, publish

from app.main import create_app

CATALOGUE = "/api/v1/catalogue"
GOOD_1A01 = {"ICD-11 code": "1A01", "Performance": "0.97", "CI low": "0.96", "CI high": "0.98", **SOURCE}
GOOD_1A00 = {"ICD-11 code": "1A00", "Performance": "0.91", "CI low": "0.88", "CI high": "0.94", **SOURCE}


def tile(client, version: str = "live") -> dict:
    body = client.get(CATALOGUE, params={"version": version}).json()
    (match,) = [t for t in body["tiles"] if (t["model_version"], t["use_case"]) == (TINY_TARGET["model_version"], TINY_TARGET["use_case"])]
    return match["distribution"]


def test_a_rechecked_merge_never_serves_old_tile_counts(admin_client, tiny_store):
    client = admin_client
    publish(client, upload_and_wait(client, "metrics", merge_file(client, [GOOD_1A01]), mode="merge", **TINY_TARGET))
    staged = upload_and_wait(client, "metrics", merge_file(client, [GOOD_1A00]), mode="merge", **TINY_TARGET)
    version = f"staged:{staged['upload_id']}"
    tile(client, version)  # fills any cache with the first check's counts

    assert client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"}).status_code == 200
    rechecked = wait(client, staged["upload_id"])
    assert rechecked["status"] == "valid"
    after_recheck = tile(client, version)
    publish(client, rechecked)
    live = tile(client)

    with local_client(create_app(tiny_store)) as fresh:
        assert live == tile(fresh), "the live catalogue serves counts of the set's first check"
    assert after_recheck == live


def test_a_merge_whose_base_moves_during_its_check_is_checked_again(admin_client):
    client = admin_client
    publish(client, upload_and_wait(client, "metrics", merge_file(client, [GOOD_1A01]), mode="merge", **TINY_TARGET))
    admin = admin_service(client)
    reached, release = threading.Event(), threading.Event()
    original = admin._set_progress

    def gated(upload_id, share):
        if share == 0.02 and not release.is_set():
            reached.set()
            release.wait(10)
        original(upload_id, share)

    admin._set_progress = gated
    try:
        response = post_upload(client, "metrics", merge_file(client, [GOOD_1A00]), mode="merge", **TINY_TARGET)
        upload_id = response.json()["upload_id"]
        assert reached.wait(10)
        assert client.post(f"{ADMIN}/versions/1/rollback", params={"kind": "metrics"}).status_code == 200
        release.set()
        admin.wait_for_checks()
        assert wait(client, upload_id)["status"] == "valid"
        admin.wait_for_checks()
        assert client.get(f"{ADMIN}/uploads/{upload_id}/changes").status_code == 200
    finally:
        admin._set_progress = original
