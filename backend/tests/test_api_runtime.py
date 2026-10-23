"""Serving: loopback-only startup, concurrent requests over real HTTP, and bounded caches."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import uvicorn

from app import db, serve
from app.api.store import CachedBody, ResponseCache
from app.main import API_PREFIX, create_app
from app.services.dataset import Dataset

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}


# ------------------------------------------------------------------- serve

def test_serve_binds_loopback_only(monkeypatch, tiny_db):
    calls = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **options: calls.update(options, app=app))
    assert serve.main(["--db", str(tiny_db), "--port", "8123"]) == 0
    assert calls["host"] == "127.0.0.1" and calls["port"] == 8123
    assert calls["app"].state.api.store.db_path == tiny_db.resolve()


def test_serve_has_no_host_option(capsys):
    with pytest.raises(SystemExit):
        serve.main(["--host", "0.0.0.0"])
    assert "unrecognized arguments: --host" in capsys.readouterr().err


def test_serve_refuses_a_missing_store(tmp_path, capsys):
    assert serve.main(["--db", str(tmp_path / "missing.sqlite")]) == 2
    assert "python -m app.importers.legacy_json" in capsys.readouterr().err


# ------------------------------------------------------------ concurrency

@pytest.fixture(scope="module")
def http_server(legacy_db):
    """The app under uvicorn on 127.0.0.1 and a free port."""
    server = uvicorn.Server(uvicorn.Config(create_app(legacy_db), host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while not server.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.05)
    host, port = server.servers[0].sockets[0].getsockname()[:2]
    assert host == "127.0.0.1"
    yield f"http://127.0.0.1:{port}{API_PREFIX}"
    server.should_exit = True
    thread.join(timeout=10)


def test_concurrent_requests_match_sequential_ones(http_server, client, live_dataset):
    """Requests from many threads (thread pool, shared store, one lock) return what they return alone."""
    lenses = [lens.as_dict() for lens in live_dataset.atlas.axes.all_lenses()[::9]]
    requests = []
    for index, lens in enumerate(lenses):
        requests += [
            ("/metrics/map", {**SYN, **lens, "scope": "atlas"}),
            ("/metrics/map", {**SYN, **lens, "scope": "chapter", "chapter_id": f"CH-{index + 1:02d}"}),
            ("/metrics/concepts/CH-05", {**SYN, **lens}),
            ("/metrics/summary", {**SYN, **lens, "view": "evidence"}),
            ("/multimorbidity/candidates", {**SYN, **lens, "scope": "atlas", "selected": "5A11"}),
            ("/search", {"q": ["asthma", "diabetes", "1A0", "CH-1"][index % 4]}),
        ]

    def fetch(request):
        path, params = request
        with httpx.Client(timeout=60) as http:
            response = http.get(http_server + path, params=params)
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=8) as pool:
        concurrent = list(pool.map(fetch, requests))
    for (path, params), (status, body) in zip(requests, concurrent):
        assert status == 200
        assert body == client.get(API_PREFIX + path, params=params).json(), (path, params)


def test_dataset_export_streams_and_stops_when_the_client_leaves(http_server):
    """Over real HTTP (the TestClient buffers whole bodies): the first chunk
    arrives at once, and closing the connection ends the export."""
    started = time.perf_counter()
    with httpx.Client(timeout=60) as http, http.stream("GET", f"{http_server}/export/dataset", params=SYN) as response:
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        assert response.headers["X-Dataset-Version"] == "1"
        assert response.headers["content-disposition"] == (
            'attachment; filename="broad-modelcard-syngpt-2-0-clinician-facing-cdss-v1.json"'
        )
        assert "content-length" not in response.headers
        first = next(response.iter_bytes())
        etag = response.headers["ETag"]
    assert time.perf_counter() - started < 5
    assert first.startswith(b'{"meta":{')
    with httpx.Client(timeout=60) as http:
        again = http.get(f"{http_server}/export/dataset", params=SYN, headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b"" and again.headers["ETag"] == etag


# ------------------------------------------------------------------ caches

def test_metrics_service_keeps_a_bounded_number_of_lenses(live_dataset):
    service = live_dataset.new_metrics("SynGPT-2.0", "Clinician Facing CDSS", lens_cache_size=3)
    lenses = live_dataset.atlas.axes.all_lenses()[:6]
    first = [service.row(concept_id, lens) for lens in lenses for concept_id in ("1C43", "CH-01")]
    assert len(service._cache) == 3
    assert [service.row(concept_id, lens) for lens in lenses for concept_id in ("1C43", "CH-01")] == first
    service.clear_cache()
    assert len(service._cache) == 0


def test_dataset_keeps_a_bounded_number_of_metric_services(legacy_db):
    dataset = Dataset(db.connect(legacy_db, read_only=True), metrics_cache_size=2)
    variants = [("SynGPT-1.0", "Clinician Facing CDSS"), ("SynGPT-2.0", "Clinician Facing CDSS"), ("ICU_GPT-1.0", "CDSS")]
    services = [dataset.metrics(*variant) for variant in variants]
    assert len(dataset._metrics) == 2
    assert dataset.metrics(*variants[2]) is services[2]
    assert dataset.metrics(*variants[0]) is not services[0]  # evicted and rebuilt


def test_response_cache_evicts_by_entries_and_bytes():
    cache = ResponseCache(max_entries=3, max_bytes=10)
    for key in "abc":
        cache.put((key,), CachedBody(b"12", '"x"'))
    cache.get(("a",))
    cache.put(("d",), CachedBody(b"12", '"x"'))
    assert cache.get(("b",)) is None and cache.get(("a",)) is not None and len(cache) == 3
    cache.put(("e",), CachedBody(b"1234567", '"x"'))
    assert len(cache) == 2 and cache.get(("e",)) is not None  # 2 + 7 bytes fit, 11 would not
    cache.put(("huge",), CachedBody(b"x" * 11, '"x"'))
    assert cache.get(("huge",)) is None


def test_one_search_index_serves_every_version(admin_client):
    """Search reads only static concept fields, so a publish or rollback must not rebuild the index."""
    store = admin_client.app.state.api.store
    term = admin_client.get(f"{API_PREFIX}/atlas/overview").json()["conditions"][0]["pt"]
    before = admin_client.get(f"{API_PREFIX}/search", params={"q": term})
    index = store.resolve("live").search
    # A prevalence change (version 2), then its rollback (version 3): a rollback that changes
    # nothing is refused since v1.11.
    changed = admin_client.post(
        f"{API_PREFIX}/admin/uploads/records",
        json={"kind": "prevalence", "records": [{"code": "1A01", "tier": "Very common", "source": "S", "study": "T", "source_date": "2026-01-01"}]},
    ).json()
    admin_client.app.state.api.admin.wait_for_checks()
    assert admin_client.post(f"{API_PREFIX}/admin/uploads/{changed['upload_id']}/publish", json={"previewed": False}).status_code == 200
    assert store.resolve("live").search is index
    rolled = admin_client.post(f"{API_PREFIX}/admin/versions/1/rollback", params={"kind": "prevalence"})
    assert rolled.status_code == 200
    context = store.resolve("live")
    assert context.version_id == rolled.json()["version_id"] == 3
    assert context.search is index
    after = admin_client.get(f"{API_PREFIX}/search", params={"q": term})
    assert after.json() == before.json() and after.json()["total"] >= 1
