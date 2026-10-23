"""The helper's provider configuration (contract v1.9, CONTRACT.md §20).

One JSON file next to the store, readable and writable by its owner only
(mode 600) and ignored by git:

* the live store ``backend/data/broad_modelcard.sqlite`` uses
  ``backend/data/assist.json``;
* any other store ``<dir>/<name>.sqlite`` uses ``<dir>/<name>.assist.json``,
  so the demo store and scratch stores never share the live store's key;
* ``BMC_ASSIST_CONFIG`` overrides both.

The API key is **write-only**: the API reports whether one is set, never its
value. It is never logged, never written to the store, uploads, templates, or
exports, and is removed from every error text (``redact``).
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .. import db

log = logging.getLogger("broad_modelcard.assist")

CONFIG_ENV = "BMC_ASSIST_CONFIG"
LIVE_CONFIG_NAME = "assist.json"
PROVIDERS = ("hosted", "local")
HOSTED_BASE_URL = "https://api.anthropic.com"
DEFAULT_HOSTED_MODEL = "claude-sonnet-5-5"
REDACTED = "[redacted]"

_KEY = re.compile(r"^[\x21-\x7e]{8,512}$")  # printable ASCII, no spaces or line breaks
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$")
MAX_URL = 500
LOCAL_ONLY = (
    "A local model runs on this computer: its base URL must name 127.0.0.1, ::1, or localhost. "
    "For a model elsewhere, use the hosted provider."
)


class ConfigError(ValueError):
    """A configuration the API refuses (422). Its text never contains the key."""


@dataclass(frozen=True)
class AssistConfig:
    provider: str  # "hosted" or "local"
    model: str
    # Hosted: None means the Anthropic API; local: the OpenAI-compatible base URL.
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)
    updated_at: str | None = None

    @property
    def endpoint(self) -> str:
        if self.provider == "hosted":
            return (self.base_url or HOSTED_BASE_URL).rstrip("/") + "/v1/messages"
        return (self.base_url or "").rstrip("/") + "/chat/completions"

    @property
    def secrets(self) -> tuple[str, ...]:
        return (self.api_key,) if self.api_key else ()


def config_path(db_path: Path | str) -> Path:
    """Where the configuration of the store at ``db_path`` lives."""
    override = os.environ.get(CONFIG_ENV)
    if override:
        return Path(override)
    store = Path(db_path).resolve()
    if store == db.DEFAULT_DB_PATH.resolve():
        return store.parent / LIVE_CONFIG_NAME
    return store.parent / f"{store.stem}.assist.json"


def redact(text: object, *secrets: str | None) -> str:
    """``text`` with every secret replaced by ``[redacted]``."""
    result = str(text)
    for secret in secrets:
        if secret:
            result = result.replace(secret, REDACTED)
    return result


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_loopback_url(url: str) -> bool:
    return _is_loopback(urlsplit(url).hostname)


def endpoint_origin(provider: str, base_url: str | None) -> str:
    """The origin (scheme, host, port) the provider's requests go to, normalized."""
    parts = urlsplit(base_url or (HOSTED_BASE_URL if provider == "hosted" else ""))
    scheme = (parts.scheme or "").lower()
    try:
        port = parts.port or {"http": 80, "https": 443}.get(scheme)
    except ValueError:
        port = None
    return f"{scheme}://{(parts.hostname or '').lower()}:{port}"


def _clean_url(value: str, *, hosted: bool) -> str:
    url = value.strip().rstrip("/")
    if len(url) > MAX_URL:
        raise ConfigError(f"The base URL is longer than {MAX_URL} characters.")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError("The base URL must start with http:// or https:// and name a host.")
    if parts.username or parts.password:
        raise ConfigError("Put credentials in the API key field, not in the base URL.")
    if parts.query or parts.fragment:
        raise ConfigError("The base URL must not have a query or fragment.")
    if hosted and parts.scheme != "https" and not _is_loopback(parts.hostname):
        raise ConfigError("A hosted model is reached over https (http only for a gateway on this machine).")
    if not hosted and not _is_loopback(parts.hostname):
        # Keeps studies and keys on this machine unless the maintainer chooses the hosted provider.
        raise ConfigError(LOCAL_ONLY)
    return url


def validate(
    *,
    provider: str,
    model: str | None,
    base_url: str | None,
    api_key: str | None,
    current: AssistConfig | None,
) -> AssistConfig:
    """A new configuration from a request. Without ``api_key`` the current key
    is kept only when the provider and the endpoint's origin stay the same, so a
    stored key is never sent to an address it was not saved for."""
    if provider not in PROVIDERS:
        raise ConfigError("provider must be hosted or local.")
    model = (model or "").strip() or (DEFAULT_HOSTED_MODEL if provider == "hosted" else "")
    if not model:
        raise ConfigError("A local model needs its model name, e.g. llama3.1:8b.")
    if not _MODEL.fullmatch(model):
        raise ConfigError("The model name may use letters, digits, and . _ : / @ + - (at most 128 characters).")
    base = (base_url or "").strip()
    if provider == "local" and not base:
        raise ConfigError("A local model needs the base URL of its OpenAI-compatible API, e.g. http://127.0.0.1:11434/v1.")
    cleaned_url = _clean_url(base, hosted=provider == "hosted") if base else None
    if cleaned_url == HOSTED_BASE_URL:
        cleaned_url = None
    if api_key is not None and api_key != "":
        if not _KEY.fullmatch(api_key):
            # Never repeat the value: it may be a real key with a typo.
            raise ConfigError("The API key must be 8 to 512 printable characters without spaces or line breaks.")
        key = api_key
    else:
        same_place = (
            current is not None
            and current.provider == provider
            and endpoint_origin(current.provider, current.base_url) == endpoint_origin(provider, cleaned_url)
        )
        key = current.api_key if same_place else None
        if provider == "hosted" and not key and current is not None and current.provider == provider and current.api_key:
            raise ConfigError(
                "The address changed, so enter the API key again: a stored key is only sent to the address it was saved for."
            )
    if provider == "hosted" and not key:
        raise ConfigError("A hosted model needs your own API key.")
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return AssistConfig(provider=provider, model=model, base_url=cleaned_url, api_key=key, updated_at=stamp)


def load(path: Path) -> AssistConfig | None:
    """The stored configuration, or None (no file, or a file that is not a valid configuration)."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("Ignoring the unreadable helper configuration at %s.", path)
        return None
    try:
        provider = raw["provider"]
        config = AssistConfig(
            provider=provider,
            model=str(raw["model"]),
            base_url=raw.get("base_url") or None,
            api_key=raw.get("api_key") or None,
            updated_at=raw.get("updated_at"),
        )
        if provider not in PROVIDERS or (provider == "hosted" and not config.api_key) or (provider == "local" and not config.base_url):
            raise ValueError
        if provider == "local" and not is_loopback_url(config.base_url):
            raise ValueError  # a file from before the local-only rule (or edited by hand)
    except (KeyError, TypeError, ValueError):
        log.warning("Ignoring the incomplete helper configuration at %s.", path)
        return None
    return config


def save(path: Path, config: AssistConfig) -> None:
    """Write the configuration atomically with mode 600."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(
        {
            "provider": config.provider,
            "model": config.model,
            "base_url": config.base_url,
            "api_key": config.api_key,
            "updated_at": config.updated_at,
        },
        indent=2,
    )
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".assist-", suffix=".tmp")
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(body)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def clear(path: Path) -> None:
    path.unlink(missing_ok=True)
