"""The update workflow without HTTP (app/publishing): staging, publishing,
rollback, atomicity, and serialization, on a private copy of the tiny store."""

from __future__ import annotations

import shutil
import threading

import pytest

from app import db, repository
from app.publishing import content as contents
from app.publishing import versions
from app.publishing.uploads import AdminError, AdminService

TARGET = ("Tiny-1", "CDSS")


@pytest.fixture
def admin(tiny_store, tmp_path):
    service = AdminService(tiny_store, uploads_dir=tmp_path / "uploads")
    service.open()
    yield service
    service.close()


def stage(admin, tmp_path, kind, file_format="csv", *, edit=None, target=None, name=None, replace=False):
    """Download the filled template, optionally edit its rows, upload it, and wait."""
    out = tmp_path / f"out-{kind}-{file_format}"
    out.mkdir(exist_ok=True)
    path, filename = admin.template(kind, file_format, out, filled=True, model_version=target and target[0], use_case=target and target[1])
    if edit:
        edit(path)
    source = tmp_path / (name or filename)
    shutil.copy(path, source)
    upload = admin.create_upload(
        kind=kind, filename=source.name, source=source, model_version=target and target[0],
        use_case=target and target[1], replace_staged=replace,
    )
    admin.wait_for_checks()
    return admin.get_upload(upload["upload_id"])


def live_state(admin):
    conn = db.connect(admin.db_path, read_only=True)
    try:
        return repository.load_state(conn)
    finally:
        conn.close()


@pytest.mark.parametrize("file_format", ["csv", "xlsx"])
@pytest.mark.parametrize(("kind", "target"), [("models", None), ("prevalence", None), ("metrics", TARGET), ("multimorbidity", TARGET)])
def test_filled_templates_round_trip_without_changes(admin, tmp_path, kind, target, file_format):
    upload = stage(admin, tmp_path, kind, file_format, target=target)
    assert upload["status"] == "valid", upload["report"]
    assert upload["report"]["errors"] == []
    summary = admin.changes(upload["upload_id"])
    assert summary["rows"]["added"] == summary["rows"]["changed"] == summary["rows"]["removed"] == 0
    assert summary["rows"]["unchanged"] == upload["report"]["row_count"] > 0
    assert summary["status_shifts"] == [] and summary["base_version"] == 1


def _replace_in_csv(old: str, new: str, count: int = 1):
    def edit(path):
        text = path.read_text(encoding="utf-8")
        assert old in text
        path.write_text(text.replace(old, new, count), encoding="utf-8")

    return edit


def test_publish_swaps_one_set_and_rollback_restores_it(admin, tmp_path):
    before = live_state(admin)
    upload = stage(admin, tmp_path, "prevalence", edit=_replace_in_csv(",Common,", ",Very rare,"))
    assert upload["status"] == "valid"
    entry = admin.publish(upload["upload_id"], previewed=False)
    assert entry["version_id"] == 2 and entry["kind"] == "prevalence" and entry["upload_id"] == upload["upload_id"]
    after = live_state(admin)
    assert after.prevalence_set_id != before.prevalence_set_id
    assert (after.registry_set_id, after.metric_sets, after.multimorbidity_sets) == (
        before.registry_set_id, before.metric_sets, before.multimorbidity_sets,
    )
    rolled = admin.rollback(1, "prevalence")
    assert rolled["version_id"] == 3 and rolled["rollback_of"] == 1 and rolled["kind"] == "prevalence"
    restored = live_state(admin)
    assert versions.set_ids(restored) == versions.set_ids(before)
    assert [entry["version_id"] for entry in admin.list_versions()] == [3, 2, 1]
    assert [entry["version_id"] for entry in admin.list_versions("models")] == [1]


def test_publish_is_atomic_when_it_fails_midway(admin, tmp_path, monkeypatch):
    upload = stage(admin, tmp_path, "prevalence", edit=_replace_in_csv(",Common,", ",Rare,"))
    before = live_state(admin)

    def fail(*args, **kwargs):
        raise RuntimeError("injected failure after the version row was written")

    monkeypatch.setattr(versions, "_link_content_sets", fail)
    with pytest.raises(RuntimeError, match="injected"):
        admin.publish(upload["upload_id"], previewed=False)
    assert live_state(admin) == before
    assert [entry["version_id"] for entry in admin.list_versions()] == [1]
    assert admin.get_upload(upload["upload_id"])["status"] == "valid"
    monkeypatch.undo()
    assert admin.publish(upload["upload_id"], previewed=False)["version_id"] == 2


def test_concurrent_publishes_are_serialized(admin, tmp_path, monkeypatch):
    first = stage(admin, tmp_path, "prevalence", edit=_replace_in_csv(",Common,", ",Rare,"))
    second = stage(admin, tmp_path, "metrics", target=TARGET, edit=_replace_in_csv(",Yes,", ",No,"))
    entered, release = threading.Event(), threading.Event()
    original = versions.insert_version

    def slow_insert(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)

    monkeypatch.setattr(versions, "insert_version", slow_insert)
    results = {}
    worker = threading.Thread(target=lambda: results.setdefault("first", admin.publish(first["upload_id"], previewed=False)))
    worker.start()
    assert entered.wait(10)
    with pytest.raises(AdminError) as busy:
        admin.publish(second["upload_id"], previewed=False)
    assert (busy.value.status, busy.value.code) == (409, "publish_in_progress")
    with pytest.raises(AdminError) as busy_rollback:
        admin.rollback(1)
    assert busy_rollback.value.code == "publish_in_progress"
    release.set()
    worker.join(10)
    assert results["first"]["version_id"] == 2
    monkeypatch.setattr(versions, "insert_version", original)
    assert admin.publish(second["upload_id"], previewed=False)["version_id"] == 3


def test_one_staged_upload_per_data_set(admin, tmp_path):
    first = stage(admin, tmp_path, "prevalence")
    with pytest.raises(AdminError) as exists:
        stage(admin, tmp_path, "prevalence")
    assert (exists.value.status, exists.value.code) == (409, "staged_upload_exists")
    other_kind = stage(admin, tmp_path, "metrics", target=TARGET)  # another data set may stage
    assert other_kind["status"] == "valid"
    replacement = stage(admin, tmp_path, "prevalence", replace=True)
    assert admin.get_upload(first["upload_id"])["status"] == "superseded"
    assert replacement["status"] == "valid"
    staged = {info["kind"]: info for info in admin.datasets()}
    assert staged["prevalence"]["staged_upload_id"] == replacement["upload_id"]
    assert staged["metrics"]["staged_upload_ids"] == [other_kind["upload_id"]]


def test_discard_removes_the_staged_set_and_files(admin, tmp_path):
    upload = stage(admin, tmp_path, "metrics", target=TARGET)
    conn = db.connect(admin.db_path, read_only=True)
    set_id = conn.execute("SELECT set_id FROM uploads WHERE upload_id = ?", (upload["upload_id"],)).fetchone()[0]
    assert conn.execute("SELECT COUNT(*) FROM metric_rows WHERE set_id = ?", (set_id,)).fetchone()[0] == 180
    admin.discard(upload["upload_id"])
    assert conn.execute("SELECT COUNT(*) FROM metric_rows WHERE set_id = ?", (set_id,)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM content_sets WHERE set_id = ?", (set_id,)).fetchone()[0] == 0
    conn.close()
    assert not admin.upload_dir(upload["upload_id"]).exists()
    assert admin.get_upload(upload["upload_id"])["status"] == "discarded"
    with pytest.raises(AdminError) as again:
        admin.discard(upload["upload_id"])
    assert again.value.code == "upload_not_staged"


def test_published_sets_are_never_deleted(admin, tmp_path):
    upload = stage(admin, tmp_path, "prevalence")
    admin.publish(upload["upload_id"], previewed=True)
    conn = db.connect(admin.db_path, check_same_thread=False)
    try:
        set_id = live_state(admin).prevalence_set_id
        with pytest.raises(RuntimeError, match="never deleted"):
            contents.delete_content_set(conn, set_id)
    finally:
        conn.close()
    assert admin.list_versions()[0]["previewed"] is True


def test_checks_left_running_resume_after_a_restart(tiny_store, tmp_path):
    first = AdminService(tiny_store, uploads_dir=tmp_path / "uploads")
    first.open()
    out = tmp_path / "out"
    out.mkdir()
    path, name = first.template("prevalence", "csv", out, filled=True)
    source = tmp_path / name
    shutil.copy(path, source)
    upload = first.create_upload(kind="prevalence", filename=name, source=source)
    first.wait_for_checks()
    first.close()
    # Simulate a stop in the middle of the check.
    conn = db.connect(tiny_store)
    conn.execute("UPDATE uploads SET status = 'checking', progress = 0.4, set_id = NULL, report_json = NULL")
    conn.commit()
    conn.close()
    second = AdminService(tiny_store, uploads_dir=tmp_path / "uploads")
    second.open()
    second.wait_for_checks()
    assert second.get_upload(upload["upload_id"])["status"] == "valid"
    second.close()
