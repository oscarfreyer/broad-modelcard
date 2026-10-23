"""The local-only guard (app/api/guard.py): non-loopback clients, foreign
Host headers, Origins other than the request's own, and cross-site
state-changing fetches get 403 ``local_only`` (CONTRACT.md §16)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.guard import is_local_host_header, is_loopback_address, is_same_origin, parse_authority
from app.main import API_PREFIX, create_app


@pytest.fixture(scope="module")
def tiny_app(tiny_db):
    return create_app(tiny_db)


def _get(app, *, client=("127.0.0.1", 50000), base_url="http://127.0.0.1", headers=None):
    with TestClient(app, client=client, base_url=base_url) as test_client:
        return test_client.get(f"{API_PREFIX}/meta", headers=headers or {})


def assert_local_only(response):
    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == "local_only" and body["status"] == 403
    assert "X-Dataset-Version" not in response.headers


@pytest.mark.parametrize("client", [("127.0.0.1", 1), ("127.5.6.7", 1), ("::1", 1), ("::ffff:127.0.0.1", 1)])
def test_loopback_clients_are_served(tiny_app, client):
    assert _get(tiny_app, client=client).status_code == 200


@pytest.mark.parametrize("client", [("192.168.1.20", 1), ("10.0.0.5", 1), ("8.8.8.8", 1), ("fe80::1", 1), ("testclient", 1)])
def test_non_loopback_clients_are_rejected(tiny_app, client):
    assert_local_only(_get(tiny_app, client=client))


def test_non_loopback_clients_cannot_reach_admin_or_unknown_routes(tiny_app):
    with TestClient(tiny_app, client=("192.168.1.20", 1), base_url="http://127.0.0.1") as remote:
        assert_local_only(remote.get(f"{API_PREFIX}/admin/datasets"))
        assert_local_only(remote.post(f"{API_PREFIX}/admin/versions/1/rollback"))
        assert_local_only(remote.get("/nowhere"))


@pytest.mark.parametrize("base_url", ["http://evil.example", "http://192.168.1.20:8000"])
def test_foreign_host_headers_are_rejected(tiny_app, base_url):
    """DNS rebinding: a loopback connection that names another host."""
    assert_local_only(_get(tiny_app, base_url=base_url))


@pytest.mark.parametrize("host", ["localhost:8000", "127.0.0.1:8000", "[::1]:8000", "LOCALHOST", "[0:0:0:0:0:0:0:1]:8000"])
def test_local_host_headers_are_served(tiny_app, host):
    assert _get(tiny_app, headers={"Host": host}).status_code == 200


@pytest.mark.parametrize(
    "host",
    [
        "evil@localhost:8000",  # userinfo
        "localhost:8000@evil.example",
        "localhost:80:80",  # a second colon
        "localhost:",  # empty port
        "localhost:99999",
        "localhost/x",
        "::1:8000",  # IPv6 without brackets
        "[::1",
        "[::2]:8000",
        "localhost.evil.example",
        "",
    ],
)
def test_malformed_or_foreign_host_headers_are_rejected(tiny_app, host):
    assert_local_only(_get(tiny_app, headers={"Host": host}))


def test_foreign_origins_are_rejected(tiny_app):
    assert_local_only(_get(tiny_app, headers={"Origin": "https://evil.example"}))
    assert_local_only(_get(tiny_app, headers={"Origin": "null"}))
    # Another page on this machine is another origin too.
    assert_local_only(_get(tiny_app, headers={"Origin": "http://localhost:5173"}))
    assert_local_only(_get(tiny_app, headers={"Origin": "http://127.0.0.1:3000"}))
    assert_local_only(_get(tiny_app, headers={"Origin": "https://127.0.0.1"}))  # another scheme


def test_the_requests_own_origin_is_served(tiny_app):
    assert _get(tiny_app, headers={"Origin": "http://127.0.0.1"}).status_code == 200
    assert _get(tiny_app, headers={"Origin": "http://127.0.0.1:80"}).status_code == 200  # default port
    # Through the Vite proxy: the browser's Host and Origin both name the dev server.
    proxied = {"Host": "localhost:5173", "Origin": "http://localhost:5173"}
    assert _get(tiny_app, headers=proxied).status_code == 200
    assert _get(tiny_app, headers={"Host": "[::1]:5173", "Origin": "http://[::1]:5173"}).status_code == 200


def test_guard_predicates():
    assert is_loopback_address("127.0.0.1") and is_loopback_address("::1")
    assert not is_loopback_address(None) and not is_loopback_address("") and not is_loopback_address("localhost")
    assert is_local_host_header(None) and is_local_host_header("localhost") and is_local_host_header("[::1]:8000")
    assert not is_local_host_header("127.0.0.1.evil.example") and not is_local_host_header("user@localhost")
    assert parse_authority("LocalHost:5173") == ("localhost", 5173)
    assert parse_authority("[::1]") == ("::1", None)
    assert parse_authority("localhost:0") is None and parse_authority("a:b") is None
    assert is_same_origin(None, "http", "127.0.0.1:8000")
    assert is_same_origin("http://localhost:5173", "http", "localhost:5173")
    assert is_same_origin("https://localhost", "https", "localhost:443")
    assert is_same_origin("http://localhost:8000", "ws", "localhost:8000")
    assert not is_same_origin("http://localhost:5173", "http", None)
    assert not is_same_origin("http://localhost:5173", "http", "localhost:5174")
    assert not is_same_origin("http://localhost:5173/", "http", "localhost:5173")
    assert not is_same_origin("http://user@localhost:5173", "http", "localhost:5173")
    assert not is_same_origin("file://", "http", "localhost") and not is_same_origin("null", "http", "localhost")


# ------------------------------------------------- cross-origin writes (§16)

FOREIGN = "http://localhost:3000"


def _tiny_lookup() -> dict:
    return {"context": {"card": {"model_version": "Tiny-1", "use_case": "CDSS"}, "conditions": [{"code": "1A00"}]}}


def _state_changing_requests(client):
    """Every kind of request a foreign page could try: reads of admin state,
    JSON, bodyless, multipart, and form writes, and the lookup."""
    upload = {"kind": (None, "metrics"), "file": ("metrics.csv", b"x\n", "text/csv")}
    return {
        "GET /admin/assist": lambda headers: client.get(f"{API_PREFIX}/admin/assist", headers=headers),
        "PUT /admin/assist": lambda headers: client.put(
            f"{API_PREFIX}/admin/assist", json={"provider": "hosted", "model": "claude-opus-5-5"}, headers=headers
        ),
        "POST rollback": lambda headers: client.post(f"{API_PREFIX}/admin/versions/1/rollback", headers=headers),
        "POST /admin/uploads": lambda headers: client.post(f"{API_PREFIX}/admin/uploads", files=upload, headers=headers),
        "POST population remove": lambda headers: client.post(
            f"{API_PREFIX}/admin/populations/x/remove", json={"note": "x"}, headers=headers
        ),
        "POST /lookup": lambda headers: client.post(f"{API_PREFIX}/lookup", json=_tiny_lookup(), headers=headers),
    }


@pytest.mark.parametrize("operation", ["GET /admin/assist", "PUT /admin/assist", "POST rollback", "POST /admin/uploads", "POST population remove", "POST /lookup"])
@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": FOREIGN},
        {"Origin": FOREIGN, "Host": "localhost:5173"},  # through a proxy on another port
        {"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_foreign_pages_cannot_read_admin_state_or_write(admin_client, operation, headers):
    before = admin_client.get(f"{API_PREFIX}/admin/versions").json()
    response = _state_changing_requests(admin_client)[operation](headers)
    assert_local_only(response)
    assert not any(name.lower().startswith("access-control-") for name in response.headers)
    assert admin_client.get(f"{API_PREFIX}/admin/versions").json() == before


@pytest.mark.parametrize("site", ["cross-site", "same-site", "CROSS-SITE"])
def test_cross_site_fetch_metadata_blocks_writes_without_origin(admin_client, site):
    """A state-changing request whose Sec-Fetch-Site says another site is refused even without Origin."""
    for operation in ("PUT /admin/assist", "POST rollback", "POST /admin/uploads", "POST /lookup"):
        assert_local_only(_state_changing_requests(admin_client)[operation]({"Sec-Fetch-Site": site}))
    # Reads are not affected: a GET is never state-changing.
    assert admin_client.get(f"{API_PREFIX}/meta", headers={"Sec-Fetch-Site": site}).status_code == 200


def test_same_origin_requests_still_work(admin_client):
    own = {"Origin": "http://127.0.0.1", "Sec-Fetch-Site": "same-origin"}
    requests = _state_changing_requests(admin_client)
    assert requests["GET /admin/assist"](own).status_code == 200
    assert requests["POST /lookup"](own).status_code == 200
    assert requests["POST /lookup"]({"Sec-Fetch-Site": "none"}).status_code == 200  # typed into the address bar
    # An incomplete upload is the route's 422, not the guard's 403.
    assert requests["POST /admin/uploads"](own).status_code == 422
    assert requests["POST population remove"](own).status_code == 404
    # Through the Vite proxy (Host and Origin both name the dev server).
    proxied = {"Origin": "http://localhost:5173", "Host": "localhost:5173", "Sec-Fetch-Site": "same-origin"}
    assert requests["POST /lookup"](proxied).status_code == 200
    preflight = admin_client.options(f"{API_PREFIX}/lookup", headers={"Origin": FOREIGN, "Access-Control-Request-Method": "POST"})
    assert_local_only(preflight)


# ----------------------------------------------------------- body limits (§16)


def test_lookup_bodies_over_64_kb_are_refused_before_they_are_read(tiny_app, caplog):
    from app.main import MAX_LOOKUP_BYTES

    padding = "Z" * MAX_LOOKUP_BYTES
    body = {**_tiny_lookup(), "hook": padding}
    with caplog.at_level("DEBUG"), TestClient(tiny_app, client=("127.0.0.1", 1), base_url="http://127.0.0.1") as client:
        sized = client.post(f"{API_PREFIX}/lookup", json=body)

        def chunks():  # no Content-Length: counted while it is read
            text = json.dumps(body).encode()
            for offset in range(0, len(text), 8192):
                yield text[offset : offset + 8192]

        chunked = client.post(f"{API_PREFIX}/lookup", content=chunks(), headers={"Content-Type": "application/json"})
        small = client.post(f"{API_PREFIX}/lookup", json=_tiny_lookup())
    for response in (sized, chunked):
        assert response.status_code == 413
        problem = response.json()
        assert problem["code"] == "upload_too_large" and problem["detail"] == "The request is larger than 64 KB, the most this tool accepts."
    assert small.status_code == 200
    assert padding[:64] not in caplog.text
