"""Status, configuration, and the proposal pipeline of the helper (contract v1.9).

``propose`` runs: provider extraction (with the search tool) → code resolution
→ checks against the store → proposals. It never writes to the store and never
creates an upload: the maintainer accepts records by sending them to
``createRecordsUpload`` (CONTRACT.md §11.4, §20).
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from ..schema.contract import SYNTHETIC_DATA_NOTICE
from . import config as configuration
from .config import AssistConfig, ConfigError
from .inputs import MAX_INPUT_BYTES, StudyInput
from .interpret import INTERPRET_SECONDS, ask
from .prompting import KINDS, Context
from .proposals import Builder, StoreView, batches, resolve_mentions
from .providers import LOCAL_PDF_DETAIL, Provider, ProviderError, provider_for

log = logging.getLogger("broad_modelcard.assist")

HOW_TO_ENABLE = (
    "The helper is off. To turn it on, add your own API key for a hosted model (Anthropic), or point it to a local "
    "model with an OpenAI-compatible API, such as http://127.0.0.1:11434/v1. Uploads and the one-record form work "
    "without it."
)
PRIVACY = (
    "When you ask for a proposal, the study you submit, the helper's instructions, the list of cards, and the results "
    "of its condition searches are sent to the provider you configured, and nowhere else. When you use Ask with the "
    "helper in the atlas search, only the words you typed and the lists of AI systems, functions, groups, and care "
    "settings are sent. Nothing is sent at any other time. The API key stays in a file on this machine (readable only by you) and is never shown again. Submit "
    "synthetic or published study text only, never patient data."
)
ACCEPTS = {"hosted": ["pdf", "text", "csv", "xlsx"], "local": ["text", "csv", "xlsx"]}
BUSY = (
    "The helper is still reading another study. It reads one at a time, and a study you cancelled keeps it busy until "
    "the model answers or 3 minutes pass. Try again in a moment."
)


class AssistError(Exception):
    """A helper request that cannot be served (becomes a problem response)."""

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


class AssistService:
    def __init__(self, db_path: Path | str, *, view_factory: Callable[[], StoreView] | None = None, config_file: Path | None = None):
        self.config_path = config_file or configuration.config_path(db_path)
        self.view_factory = view_factory
        # Builds the provider for a configuration; tests replace it with a fake.
        self.provider_factory: Callable[[AssistConfig], Provider] = provider_for
        self._lock = threading.Lock()
        # One proposal at a time: a cancelled request keeps running until its deadline,
        # so retries must not pile up and starve the server's thread pool.
        self._running = threading.Lock()

    # ------------------------------------------------------- configuration

    def config(self) -> AssistConfig | None:
        return configuration.load(self.config_path)

    def status(self) -> dict:
        current = self.config()
        if current is None:
            return {
                "enabled": False, "provider": None, "model": None, "base_url": None, "key_set": False, "accepts": [],
                "kinds": list(KINDS), "max_input_bytes": MAX_INPUT_BYTES, "updated_at": None,
                "how_to_enable": HOW_TO_ENABLE, "privacy": PRIVACY,
            }
        return {
            "enabled": True,
            "provider": current.provider,
            "model": current.model,
            "base_url": current.base_url,
            "key_set": bool(current.api_key),
            "accepts": ACCEPTS[current.provider],
            "kinds": list(KINDS),
            "max_input_bytes": MAX_INPUT_BYTES,
            "updated_at": current.updated_at,
            "how_to_enable": None,
            "privacy": PRIVACY,
        }

    def configure(self, *, provider: str, model: str | None, base_url: str | None, api_key: str | None) -> dict:
        with self._lock:
            try:
                updated = configuration.validate(provider=provider, model=model, base_url=base_url, api_key=api_key, current=self.config())
            except ConfigError as error:
                raise AssistError(422, "invalid_parameter", str(error)) from None
            configuration.save(self.config_path, updated)
        log.info("Assisted entry configured: %s model %s.", updated.provider, updated.model)
        return self.status()

    def clear(self) -> None:
        with self._lock:
            configuration.clear(self.config_path)
        log.info("Assisted entry turned off.")

    # ------------------------------------------------------ search rewrite (v1.14)

    def rewrite(self, query: str, vocabulary) -> tuple[dict, str, str]:
        """Ask the configured provider to read a search query as chips (CONTRACT.md §31).

        Sends the query and the vocabularies only; returns (the model's JSON
        answer, provider kind, model). The caller checks the chips
        (``interpret.check``). Never logs the query."""
        current = self.config()
        if current is None:
            raise AssistError(409, "assist_not_configured", HOW_TO_ENABLE)
        provider = self.provider_factory(current)
        started = time.perf_counter()
        try:
            provider.begin(INTERPRET_SECONDS)
            answer = ask(provider, query, vocabulary)
        except ProviderError as error:
            log.warning("Search rewrite: the provider call failed (%s).", configuration.redact(error.logged, *current.secrets))
            raise AssistError(error.status, error.code, configuration.redact(error.detail, *current.secrets)) from None
        except Exception as error:  # noqa: BLE001 (never let an unexpected text carry the key or the query)
            log.error("Search rewrite failed: %s.", type(error).__name__)
            raise AssistError(502, "assist_provider_error", "The helper could not read the model's answer.") from None
        log.info("Search rewrite via %s model %s in %.1f s.", current.provider, provider.model, time.perf_counter() - started)
        return answer, current.provider, provider.model

    # ------------------------------------------------------------ proposals

    def propose(self, *, kind: str, study: StudyInput, card: tuple[str, str] | None = None) -> dict:
        if kind not in KINDS:
            raise AssistError(422, "invalid_parameter", "The helper proposes metrics or safety records.")
        current = self.config()
        if current is None:
            raise AssistError(409, "assist_not_configured", HOW_TO_ENABLE)
        provider = self.provider_factory(current)
        if study.pdf is not None and not provider.accepts_pdf:
            raise AssistError(422, "assist_unsupported_input", LOCAL_PDF_DETAIL)
        if self.view_factory is None:
            raise AssistError(503, "store_unavailable", "The helper has no store to check proposals against.")
        if not self._running.acquire(blocking=False):
            raise AssistError(409, "assist_busy", BUSY)
        try:
            view = self.view_factory()
            cards = view.cards()
            if card is not None and card not in {(c.model_version, c.use_case) for c in cards}:
                raise AssistError(422, "invalid_parameter", f"{card[0]} | {card[1]} is not a card with metrics in the store.")
            return propose_with(provider, view, kind=kind, study=study, card=card, provider_kind=current.provider, secrets=current.secrets)
        finally:
            self._running.release()


def propose_with(
    provider: Provider,
    view: StoreView,
    *,
    kind: str,
    study: StudyInput,
    card: tuple[str, str] | None,
    provider_kind: str,
    secrets: tuple[str, ...] = (),
) -> dict:
    """The proposal pipeline for one study (the API and the evaluation command)."""
    ages, sexes, ethnicities = view.lens_values()
    context = Context(kind, tuple(view.cards()), ages, sexes, ethnicities, card_hint=card)
    started = time.perf_counter()
    calls = 0
    try:
        provider.begin()  # one clock for every request of this proposal
        extraction = provider.extract(study, context, view)
        calls = extraction.calls
        builder = Builder(view, kind, card_hint=card, sha256=study.sha256, study_text=study.text)
        planned = builder.plan(extraction.records)

        def choose(mentions: list[dict]) -> dict[int, str | None]:
            nonlocal calls
            chosen, used = provider.choose(mentions)
            calls += used
            return chosen

        resolve_mentions(builder.mentions(), choose)
        proposed = builder.build(planned)
    except ProviderError as error:
        # The log gets the helper's own words; the provider's message stays in the (redacted) problem detail.
        log.warning("Assisted entry: the provider call failed (%s).", configuration.redact(error.logged, *secrets))
        raise AssistError(error.status, error.code, configuration.redact(error.detail, *secrets)) from None
    except Exception as error:  # noqa: BLE001 (never let an unexpected text carry the key or the study)
        log.error("Assisted entry failed: %s.", type(error).__name__)
        raise AssistError(502, "assist_provider_error", "The helper could not read the model's answer.") from None
    groups = batches(kind, proposed)
    dropped = [item.api() for item in builder.dropped]
    log.info(
        "Assisted entry: %s via %s model %s, input %s (%d bytes, sha256 %s…): %d records, %d dropped, %d requests in %.1f s.",
        kind, provider_kind, provider.model, study.media, study.size, study.sha256[:12],
        len(proposed), len(dropped), calls, time.perf_counter() - started,
    )
    return {
        "kind": kind,
        "provider": provider_kind,
        "model": provider.model,
        "dataset_version": view.version_id,
        "input": study.info(),
        "batches": groups,
        "dropped": dropped,
        "notes": extraction.notes,
        "requests": calls,
        "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
    }
