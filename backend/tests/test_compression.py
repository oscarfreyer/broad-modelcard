"""Gzip for JSON responses (contract v1.12, transport only; audit finding B6).

Large reads go over the wire compressed when the client accepts gzip; the
body after decompression, the ETag, 304 answers, and the streamed export are
unchanged, and files that are compressed already are left alone.
"""

from __future__ import annotations

from app.main import API_PREFIX

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
GZIP = {"Accept-Encoding": "gzip"}
PLAIN = {"Accept-Encoding": "identity"}


def test_large_reads_are_gzipped_with_the_same_body_and_etag(client):
    for path, params in (("/atlas/overview", {}), ("/metrics/map", {**SYN, "scope": "atlas"})):
        zipped = client.get(API_PREFIX + path, params=params, headers=GZIP)
        plain = client.get(API_PREFIX + path, params=params, headers=PLAIN)
        assert zipped.status_code == plain.status_code == 200
        assert zipped.headers["Content-Encoding"] == "gzip", path
        assert "content-encoding" not in plain.headers
        assert "Accept-Encoding" in zipped.headers.get("Vary", "")
        # httpx decompresses: the body the client reads is the same.
        assert zipped.content == plain.content
        assert zipped.headers["ETag"] == plain.headers["ETag"]
        assert zipped.headers["X-Dataset-Version"] == plain.headers["X-Dataset-Version"]
        assert int(zipped.headers.get("Content-Length", len(zipped.content))) < len(plain.content) / 3


def test_a_304_stays_empty_and_keeps_its_headers(client):
    params = {**SYN, "scope": "atlas"}
    etag = client.get(f"{API_PREFIX}/metrics/map", params=params, headers=GZIP).headers["ETag"]
    again = client.get(f"{API_PREFIX}/metrics/map", params=params, headers={**GZIP, "If-None-Match": etag})
    assert again.status_code == 304 and again.content == b""
    assert again.headers["ETag"] == etag and "content-encoding" not in again.headers


def test_small_bodies_and_spreadsheets_are_not_gzipped(client, admin_client):
    small = client.get(f"{API_PREFIX}/search", params={"q": "5A11", "limit": 1}, headers=GZIP)
    assert small.status_code == 200 and "content-encoding" not in small.headers
    template = admin_client.get(f"{API_PREFIX}/admin/templates/metrics.xlsx", headers=GZIP)
    assert template.status_code == 200, template.text[:200]
    assert "content-encoding" not in template.headers
    assert template.content[:2] == b"PK"


def test_the_streamed_export_is_gzipped_whole(client):
    zipped = client.get(f"{API_PREFIX}/export/dataset", params=SYN, headers=GZIP)
    plain = client.get(f"{API_PREFIX}/export/dataset", params=SYN, headers=PLAIN)
    assert zipped.status_code == plain.status_code == 200
    assert zipped.headers["Content-Encoding"] == "gzip"
    assert zipped.content == plain.content
    assert zipped.json()["meta"]["categoryCount"] == 2400
