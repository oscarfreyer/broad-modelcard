"""Local-only guard: the API answers this computer's own pages and tools only.

``python -m app.serve`` binds 127.0.0.1, but an app started another way (for
example ``uvicorn app.main:app --host 0.0.0.0``) could listen on every
interface. The API has no authentication, so the app itself
rejects, with 403 ``local_only`` (CONTRACT.md §16):

* any client whose address is not a loopback address (or is unknown);
* any ``Host`` header that is not exactly ``host[:port]`` naming this machine
  (``localhost``, ``127.0.0.1``, ``[::1]``), which blocks DNS rebinding (a web
  page whose domain resolves to 127.0.0.1);
* any ``Origin`` header that is not the request's own origin
  (``scheme://Host``). A browser sends ``Origin`` on cross-origin requests and
  on every non-GET request, so another web page, even one served from
  localhost on another port, cannot publish, roll back, or configure anything
  behind the maintainer's back. The Vite dev and preview servers keep the
  browser's ``Host`` when they proxy ``/api`` (no ``changeOrigin``), so the
  app's own pages match;
* any state-changing request (not GET, HEAD, or OPTIONS) whose
  ``Sec-Fetch-Site`` is present and neither ``same-origin`` nor ``none``.

Requests without ``Origin`` (curl, scripts, tests, Node's fetch) keep the
address and ``Host`` rules only.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from .problems import ApiError, problem_response

LOCAL_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})
DEFAULT_PORTS = {"http": 80, "https": 443}
WEB_SCHEMES = {"ws": "http", "wss": "https"}
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
SAME_ORIGIN_FETCH_SITES = frozenset({"same-origin", "none"})

# host[:port]: a DNS-style name or IPv4 address, or a bracketed IPv6 address;
# no userinfo, path, or second colon.
_AUTHORITY = re.compile(r"(?:\[(?P<ipv6>[0-9A-Fa-f:.]+)\]|(?P<name>[A-Za-z0-9.-]+))(?::(?P<port>[0-9]{1,5}))?")


def is_loopback_address(host: str | None) -> bool:
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return (mapped or address).is_loopback


def parse_authority(value: str | None) -> tuple[str, int | None] | None:
    """``localhost:5173`` → ``("localhost", 5173)``; ``[::1]:80`` → ``("::1", 80)``.
    None for anything that is not exactly ``host[:port]``."""
    if not value:
        return None
    match = _AUTHORITY.fullmatch(value)
    if match is None:
        return None
    if match["ipv6"] is not None:
        try:
            host = ipaddress.IPv6Address(match["ipv6"]).compressed
        except ValueError:
            return None
    else:
        host = match["name"].lower()
    port = match["port"]
    if port is not None:
        number = int(port)
        if not 0 < number < 65536:
            return None
        return host, number
    return host, None


def is_local_host_header(value: str | None) -> bool:
    if value is None:
        return True
    authority = parse_authority(value)
    return authority is not None and authority[0] in LOCAL_HOSTNAMES


def _origin_parts(scheme: str, host: str, port: int | None) -> tuple[str, str, int]:
    return scheme, host, port if port is not None else DEFAULT_PORTS[scheme]


def is_same_origin(origin: str | None, scheme: str, host_header: str | None) -> bool:
    """True when ``origin`` is absent or names exactly ``scheme://Host`` (default ports normalised)."""
    if origin is None:
        return True
    scheme = WEB_SCHEMES.get(scheme, scheme)
    own = parse_authority(host_header)
    if own is None or scheme not in DEFAULT_PORTS:
        return False
    parts = urlsplit(origin)
    if parts.scheme not in DEFAULT_PORTS or parts.path or parts.query or parts.fragment or "@" in parts.netloc:
        return False
    theirs = parse_authority(parts.netloc)
    if theirs is None:
        return False
    return _origin_parts(parts.scheme, *theirs) == _origin_parts(scheme, *own)


class LocalOnlyGuard:
    """Pure ASGI middleware; lifespan and other scopes pass through."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            problem = self.problem(scope)
            if problem is not None:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await problem_response(problem)(scope, receive, send)
                return
        await self.app(scope, receive, send)

    @staticmethod
    def problem(scope: Scope) -> ApiError | None:
        client = scope.get("client")
        if not is_loopback_address(client[0] if client else None):
            return ApiError(403, "local_only", "This API only answers requests from this computer (127.0.0.1).")
        headers: dict[str, str] = {}
        for name, value in scope.get("headers", ()):
            key = name.decode("latin-1").lower()
            if key in headers:  # a repeated Host, Origin, or Sec-Fetch-Site is never legitimate
                if key in ("host", "origin", "sec-fetch-site"):
                    return ApiError(403, "local_only", "Requests from other web sites are not allowed.")
                continue
            headers[key] = value.decode("latin-1")
        host = headers.get("host")
        if not is_local_host_header(host):
            return ApiError(403, "local_only", "Use http://127.0.0.1 or http://localhost to reach this API.")
        if not is_same_origin(headers.get("origin"), scope.get("scheme", "http"), host):
            return ApiError(403, "local_only", "Requests from other web sites are not allowed.")
        site = headers.get("sec-fetch-site")
        method = scope.get("method", "GET").upper()
        if site is not None and method not in SAFE_METHODS and site.strip().lower() not in SAME_ORIGIN_FETCH_SITES:
            return ApiError(403, "local_only", "Requests from other web sites are not allowed.")
        return None
