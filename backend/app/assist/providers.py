"""The two model providers, over standard-library HTTP (no SDK).

* ``HostedProvider``: the Anthropic Messages API (``POST /v1/messages`` with
  ``x-api-key`` and ``anthropic-version: 2023-06-01``). A PDF goes as a base64
  ``document`` block. The backend search is the tool ``search_conditions``;
  the provider runs the tool loop (at most ``MAX_TOOL_TURNS`` requests, and
  ``TOTAL_SECONDS`` in total for the whole proposal).
* ``LocalProvider``: an OpenAI-compatible endpoint
  (``POST <base_url>/chat/completions``), text and tables only. Codes are
  resolved after the answer (``proposals.resolve_codes``); for ambiguous
  mentions ``choose`` asks the model a second time to pick among the store's
  candidates.
* ``FakeProvider``: canned answers for the fixed synthetic study set, keyed by
  the input's sha256; used by the tests and the offline evaluation.

Security: requests go only to the configured endpoint; redirects are refused
(a redirect would carry the key to another host); every error text is
redacted, and no request or response body is logged.
"""

from __future__ import annotations

import base64
import http.client
import json
import logging
import socket
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .config import AssistConfig, is_loopback_url, redact
from .inputs import StudyInput
from .prompting import (
    SEARCH_TOOL,
    AnswerError,
    Context,
    chooser_prompt,
    parse_answer,
    parse_json,
    search_tool_definition,
    system_prompt,
    user_instruction,
)

log = logging.getLogger("broad_modelcard.assist")

ANTHROPIC_VERSION = "2023-06-01"
MAX_TOKENS = 16_000
# The search rewrite (contract v1.14, §31) answers with a few chips.
INTERPRET_MAX_TOKENS = 1_000
MAX_TOOL_TURNS = 8
# One proposal has this long in total, across every request it makes (the tool
# loop, the local chooser); each request also waits at most this long.
TOTAL_SECONDS = 180.0
TIMEOUT_SECONDS = TOTAL_SECONDS
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
LOCAL_PDF_DETAIL = "Local models take text or tables; paste the text of the PDF (or upload its tables as CSV) instead."


class ProviderError(Exception):
    """A provider call that failed. ``detail`` is already redacted; ``logged`` is
    the helper's own words only (never the provider's message), for the log."""

    def __init__(self, detail: str, *, status: int = 502, code: str = "assist_provider_error", logged: str | None = None):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.logged = logged if logged is not None else detail


class ToolBox(Protocol):
    def search(self, query: str) -> list[dict]: ...


@dataclass
class Extraction:
    records: list[dict]
    notes: list[str]
    calls: int
    searches: int = 0


def deadline_detail() -> str:
    return f"The model did not finish within {int(TOTAL_SECONDS)} seconds, the most one proposal may take; submit a shorter excerpt or try again."


@dataclass
class Provider:
    kind: str  # "hosted" or "local" (the configured kind)
    model: str
    accepts_pdf: bool
    uses_search_tool: bool

    def begin(self, seconds: float | None = None) -> None:
        """Start the proposal's clock: every request after this shares ``seconds`` (TOTAL_SECONDS by default)."""
        self._deadline = time.monotonic() + (TOTAL_SECONDS if seconds is None else seconds)

    def _timeout(self) -> float:
        """Seconds the next request may take; ProviderError once the proposal's time is up."""
        deadline = getattr(self, "_deadline", None)
        if deadline is None:
            return TIMEOUT_SECONDS
        left = deadline - time.monotonic()
        if left <= 0:
            raise ProviderError(deadline_detail())
        return min(TIMEOUT_SECONDS, left)

    def _send(self, url: str, payload: dict, headers: dict[str, str], secrets: tuple[str, ...]) -> dict:
        timeout = self._timeout()
        try:
            return post_json(url, payload, headers, secrets=secrets, timeout=timeout)
        except ProviderError:
            deadline = getattr(self, "_deadline", None)
            if deadline is not None and time.monotonic() >= deadline:
                raise ProviderError(deadline_detail()) from None
            raise

    def extract(self, study: StudyInput, context: Context, tools: ToolBox) -> Extraction:
        raise NotImplementedError

    def choose(self, mentions: list[dict]) -> tuple[dict[int, str | None], int]:
        """({mention id: chosen code or None}, calls made). Only the local provider asks the model."""
        return {}, 0

    def interpret(self, system: str, query: str) -> str:
        """One request (contract v1.14, §31): the model's answer to a search query, as text.
        The request holds ``system`` (the instructions with the vocabularies) and the query, nothing else."""
        raise NotImplementedError


# ------------------------------------------------------------------- HTTP

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 (urllib signature)
        return None  # urllib then raises HTTPError for the 3xx


def _opener(url: str) -> urllib.request.OpenerDirector:
    handlers: list = [_NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context())]
    if is_loopback_url(url):
        handlers.append(urllib.request.ProxyHandler({}))  # never send a loopback request through a proxy
    return urllib.request.build_opener(*handlers)


def _error_message(body: bytes) -> str:
    try:
        value = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return ""
    error = value.get("error") if isinstance(value, dict) else None
    if isinstance(error, dict):
        kind, message = error.get("type"), error.get("message")
        return f"{kind}: {message}" if kind and message else str(message or kind or "")
    if isinstance(error, str):
        return error
    return ""


def post_json(url: str, payload: dict, headers: dict[str, str], *, secrets: tuple[str, ...], timeout: float = TIMEOUT_SECONDS) -> dict:
    """POST JSON, return the JSON answer. Raises ProviderError with a redacted text."""
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json", **headers},
        method="POST",
    )
    try:
        with _opener(url).open(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        try:
            message = _error_message(error.read(64 * 1024))
        except Exception:  # noqa: BLE001
            message = ""
        if error.code in (401, 403):
            text = f"The provider rejected the API key or the request (HTTP {error.code})."
        elif error.code == 429:
            text = "The provider is rate limiting requests (HTTP 429); try again in a minute."
        elif 300 <= error.code < 400:
            text = f"The provider answered with a redirect (HTTP {error.code}), which the helper does not follow; check the base URL."
        else:
            text = f"The provider answered HTTP {error.code}."
        # The provider's own message goes to the maintainer (redacted), never to the log.
        detail = f"{text} {message[:300]}" if message else text
        raise ProviderError(redact(detail, *secrets), logged=text) from None
    except (TimeoutError, socket.timeout):
        raise ProviderError(f"The provider did not answer within {int(timeout)} seconds.") from None
    except (urllib.error.URLError, ssl.SSLError, http.client.HTTPException, OSError, ValueError) as error:
        reason = getattr(error, "reason", None) or error.__class__.__name__
        raise ProviderError(redact(f"Could not reach the provider: {reason}.", *secrets)) from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise ProviderError("The provider's answer is too large.")
    try:
        value = json.loads(body.decode("utf-8"))
    except (ValueError, RecursionError):  # RecursionError: nested too deeply to read
        raise ProviderError("The provider's answer is not JSON.") from None
    if not isinstance(value, dict):
        raise ProviderError("The provider's answer is not a JSON object.")
    return value


def _answer(text: str) -> tuple[list[dict], list[str]]:
    try:
        return parse_answer(text)
    except AnswerError as error:
        raise ProviderError(str(error)) from None


# ----------------------------------------------------------------- hosted

@dataclass
class HostedProvider(Provider):
    config: AssistConfig = field(default=None, repr=False)  # type: ignore[assignment]

    @classmethod
    def from_config(cls, config: AssistConfig) -> "HostedProvider":
        return cls(kind="hosted", model=config.model, accepts_pdf=True, uses_search_tool=True, config=config)

    def _post(self, payload: dict) -> dict:
        headers = {"x-api-key": self.config.api_key or "", "anthropic-version": ANTHROPIC_VERSION}
        return self._send(self.config.endpoint, payload, headers, self.config.secrets)

    def extract(self, study: StudyInput, context: Context, tools: ToolBox) -> Extraction:
        content: list[dict] = []
        if study.pdf is not None:
            data = base64.b64encode(study.pdf).decode("ascii")
            content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}})
        else:
            content.append({"type": "text", "text": f"<study>\n{study.text}\n</study>"})
        content.append({"type": "text", "text": user_instruction(context)})
        messages: list[dict] = [{"role": "user", "content": content}]
        system = system_prompt(context, tool=True)
        calls = searches = 0
        for _ in range(MAX_TOOL_TURNS):
            reply = self._post(
                {"model": self.model, "max_tokens": MAX_TOKENS, "system": system, "tools": [search_tool_definition()], "messages": messages}
            )
            calls += 1
            blocks = reply.get("content") if isinstance(reply.get("content"), list) else []
            stop = reply.get("stop_reason")
            if stop == "tool_use":
                messages.append({"role": "assistant", "content": blocks})
                results = []
                for block in blocks:
                    if not isinstance(block, dict) or block.get("type") != "tool_use":
                        continue
                    query = (block.get("input") or {}).get("query") if isinstance(block.get("input"), dict) else None
                    if block.get("name") != SEARCH_TOOL or not isinstance(query, str) or not query.strip():
                        results.append({"type": "tool_result", "tool_use_id": block.get("id"), "is_error": True,
                                        "content": f"Use {SEARCH_TOOL} with a non-empty query."})
                        continue
                    searches += 1
                    hits = tools.search(query.strip()[:200])
                    results.append({"type": "tool_result", "tool_use_id": block.get("id"), "content": json.dumps(hits, ensure_ascii=False)})
                messages.append({"role": "user", "content": results})
                continue
            if stop == "refusal":
                raise ProviderError("The model declined to answer this request.")
            if stop == "max_tokens":
                raise ProviderError("The model's answer was cut off at its length limit; submit a shorter excerpt.")
            text = "".join(block.get("text", "") for block in blocks if isinstance(block, dict) and block.get("type") == "text")
            records, notes = _answer(text)
            return Extraction(records, notes, calls, searches)
        raise ProviderError(f"The model kept searching without answering after {MAX_TOOL_TURNS} requests.")

    def interpret(self, system: str, query: str) -> str:
        reply = self._post(
            {"model": self.model, "max_tokens": INTERPRET_MAX_TOKENS, "system": system, "messages": [{"role": "user", "content": query}]}
        )
        stop = reply.get("stop_reason")
        if stop == "refusal":
            raise ProviderError("The model declined to answer this request.")
        if stop == "max_tokens":
            raise ProviderError("The model's answer was cut off at its length limit.")
        blocks = reply.get("content") if isinstance(reply.get("content"), list) else []
        return "".join(block.get("text", "") for block in blocks if isinstance(block, dict) and block.get("type") == "text")


# ------------------------------------------------------------------ local

@dataclass
class LocalProvider(Provider):
    config: AssistConfig = field(default=None, repr=False)  # type: ignore[assignment]

    @classmethod
    def from_config(cls, config: AssistConfig) -> "LocalProvider":
        return cls(kind="local", model=config.model, accepts_pdf=False, uses_search_tool=False, config=config)

    def _chat(self, system: str | None, user: str) -> str:
        headers = {"Authorization": f"Bearer {self.config.api_key}"} if self.config.api_key else {}
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        reply = self._send(
            self.config.endpoint,
            {"model": self.model, "messages": messages, "temperature": 0, "stream": False},
            headers,
            self.config.secrets,
        )
        try:
            return str(reply["choices"][0]["message"]["content"] or "")
        except (KeyError, IndexError, TypeError):
            raise ProviderError("The local model's answer has no message.") from None

    def extract(self, study: StudyInput, context: Context, tools: ToolBox) -> Extraction:
        if study.pdf is not None:
            raise ProviderError(LOCAL_PDF_DETAIL, status=422, code="assist_unsupported_input")
        text = self._chat(system_prompt(context, tool=False), f"<study>\n{study.text}\n</study>\n\n{user_instruction(context)}")
        records, notes = _answer(text)
        return Extraction(records, notes, 1)

    def interpret(self, system: str, query: str) -> str:
        return self._chat(system, query)

    def choose(self, mentions: list[dict]) -> tuple[dict[int, str | None], int]:
        if not mentions:
            return {}, 0
        text = self._chat(None, chooser_prompt(mentions))
        try:
            value = parse_json(text)
        except AnswerError as error:
            raise ProviderError(str(error)) from None
        chosen: dict[int, str | None] = {}
        for choice in value.get("choices") or []:
            if isinstance(choice, dict) and isinstance(choice.get("id"), int):
                code = choice.get("code")
                chosen[choice["id"]] = code if isinstance(code, str) else None
        return chosen, 1


# ------------------------------------------------------------------- fake

@dataclass
class FakeProvider(Provider):
    """Deterministic canned answers by input sha256 (the fixed study set)."""

    answers: dict[str, dict] = field(default_factory=dict, repr=False)
    choices: Callable[[list[dict]], dict[int, str | None]] | None = field(default=None, repr=False)
    # Contract v1.14 (§31): canned answers to search queries, by query; the requests it was sent.
    interpretations: dict[str, dict] = field(default_factory=dict, repr=False)
    sent: list[tuple[str, str]] = field(default_factory=list, repr=False)

    def interpret(self, system: str, query: str) -> str:
        self.sent.append((system, query))
        return json.dumps(self.interpretations.get(query, {"chips": [], "unrecognized": [query]}))

    @classmethod
    def for_study_set(cls, answers: dict[str, dict], *, kind: str = "hosted", model: str = "fake-canned") -> "FakeProvider":
        # Behaves like the configured kind: only a hosted model reads PDFs.
        return cls(kind=kind, model=model, accepts_pdf=kind == "hosted", uses_search_tool=True, answers=answers)

    def extract(self, study: StudyInput, context: Context, tools: ToolBox) -> Extraction:
        answer = self.answers.get(study.sha256)
        if answer is None:
            return Extraction([], ["The fake provider knows only the fixed synthetic study set."], 1)
        searches = 0
        for record in answer.get("records", []):  # look codes up like a hosted model would
            for name in ("code", "codes"):
                value = (record.get(name) or {}).get("value") if isinstance(record.get(name), dict) else None
                for code in value if isinstance(value, list) else [value]:
                    if isinstance(code, str) and code:
                        tools.search(code)
                        searches += 1
        records, notes = _answer(json.dumps(answer))
        return Extraction(records, notes, 1, searches)

    def choose(self, mentions: list[dict]) -> tuple[dict[int, str | None], int]:
        return (self.choices(mentions), 1) if self.choices and mentions else ({}, 0)


def provider_for(config: AssistConfig) -> Provider:
    return HostedProvider.from_config(config) if config.provider == "hosted" else LocalProvider.from_config(config)
