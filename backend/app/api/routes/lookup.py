"""``lookup``: the live interaction plugin's one request (contract v1.8, CONTRACT.md §19).

A host application sends a card, ICD-11 codes, and coarse population values
(shaped like a CDS Hooks context) and gets, per code, what the atlas card
shows for that condition at that lens: statuses, warnings, safeguards, safety
incidents, and provenance, plus the stored combination row when the codes form
one, and links to the card.

Privacy: the case arrives in a POST body, so it
never appears in a URL or an access log. Nothing of it is stored, cached, or
logged: the response is built from the per-concept derivations the atlas
already caches (keyed by concept and lens, never by case) and sent with
``Cache-Control: no-store``. Validation problems name the field, never the
value sent. Demonstration on synthetic data; not for clinical use.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ...repository import MissingData
from ...schema.contract import AGE_ALL, ANY_SETTING, CARE_SETTINGS, ETHNICITY_ALL, SEX_ALL, SYNTHETIC_DATA_NOTICE
from ...services.errors import ServiceError, UnknownModel, UnknownUseCase
from ...services.incidents import CardSafety, worse
from ...services.links import atlas_url
from ...services.metrics import MetricsService
from ...services.presentation import metric_row, statuses
from ...services.types import Concept, Lens, MetricValues
from ..params import Version
from ..problems import ApiError
from ..responses import DATASET_VERSION_HEADER, api_of, encode, population_headers, population_ref
from ..schemas import Lookup, LookupPopulation, LookupRequest
from ..store import VersionContext
from .metrics import data_source
from . import problems

router = APIRouter(tags=["lookup"])
log = logging.getLogger("broad_modelcard.api")

LOOKUP_DISCLAIMER = "Demonstration on synthetic data. Not for clinical use."

# An unknown card names the field, never the value sent (CONTRACT.md §19).
_UNKNOWN_CARD = {
    "unknown_model": "Unknown AI system.",
    "unknown_use_case": "Unknown function for this AI system.",
}

# Coarse request values → the contract's lens values (CONTRACT.md §3).
_AGE = {"0-17": "Age 0-17", "18-39": "Age 18-39", "40-64": "Age 40-64", "65+": "Age 65+"}
_SEX = {"female": "Sex Female", "male": "Sex Male"}
_ETHNICITY = {
    "white": "Ethnicity White",
    "black": "Ethnicity Black",
    "hispanic": "Ethnicity Hispanic",
    "asian": "Ethnicity Asian",
    "other": "Ethnicity Other",
}


def lens_from_population(population: LookupPopulation | None, setting: str | None = None) -> Lens:
    population = population or LookupPopulation()
    return Lens(
        age=_AGE[population.age_group] if population.age_group else AGE_ALL,
        sex=_SEX[population.sex] if population.sex else SEX_ALL,
        ethnicity=_ETHNICITY[population.ethnicity] if population.ethnicity else ETHNICITY_ALL,
        # Contract v1.14 (§29): a care setting's code → its axis value; absent: Any setting.
        setting=CARE_SETTINGS[setting] if setting else ANY_SETTING,
    )


def _lookup_statuses(row: MetricValues | None) -> dict:
    return {**statuses(row), "intended_use": row.intended_use_level if row is not None else None}


class _Card:
    """One card at one lens and version: everything a lookup derives from."""

    def __init__(self, context: VersionContext, model: str, use_case: str, lens: Lens):
        self.context = context
        self.model = model
        self.use_case = use_case
        self.lens = lens
        self.metrics: MetricsService = context.dataset.metrics(model, use_case)
        self.safety: CardSafety = context.dataset.card_safety(model, use_case)
        self.version = context.label if context.staged_upload_id is not None else None

    def url(self, view: str = "overall", **navigation) -> str:
        """A card link; it names the view of the figures it reports, so it opens
        them for every reader, whatever their own defaults (CONTRACT.md §19)."""
        population = self.context.population.population_id if self.context.population is not None else None
        return atlas_url(
            version=self.version, model=self.model, use_case=self.use_case, view=view, lens=self.lens,
            population=population, **navigation,
        )

    def served_row(self, row: MetricValues) -> dict:
        return metric_row(
            row, model_version=self.model, use_case=self.use_case, context=self.lens.setting
        )

    def condition(self, code: str, concept: Concept) -> dict:
        """What ``getConceptMetrics`` serves for the concept, in the lookup's shape."""
        atlas = self.context.dataset.atlas
        anchor_id = atlas.canonical_condition_id(concept)
        row = self.metrics.row(concept.concept_id, self.lens)
        served = None
        if row is not None:
            served = self.served_row(row)
            served["provenance"]["data_source"] = data_source(self.context.dataset, self.model, self.use_case, row)
        # A deeper category is only known to the atlas once its chapter is open.
        chapter_id = concept.chapter_id if concept.depth > 1 else None
        return {
            "code": code,
            "matched": True,
            "concept_id": concept.concept_id,
            "pt": concept.pt,
            "icd11_code": concept.icd11_code,
            "anchor_id": anchor_id,
            "statuses": _lookup_statuses(row),
            "safety": self.safety.mark(concept, self.lens),
            "warnings": served["warnings"] if served else [],
            "safeguards": served["safeguards"] if served else [],
            "incidents": self.safety.concept_incidents(concept, self.lens),
            "provenance": served["provenance"] if served else None,
            "card_url": self.url(chapter_id=chapter_id, concept_id=concept.concept_id),
        }

    def combination(self, condition_ids: list[str]) -> dict | None:
        """The stored combination of exactly these conditions, or None (never inferred, CONTRACT.md §8)."""
        if len(condition_ids) < 2:
            return None
        service = self.context.dataset.multimorbidity(self.model, self.use_case)
        key = service.combination_key(condition_ids)
        stored = service.combinations.get(key) if key else None
        if stored is None:
            return None
        row = service.row(condition_ids, self.lens)
        served = self.served_row(row) if row is not None else None
        atlas = self.context.dataset.atlas
        mark = None
        for condition_id in condition_ids:
            mark = worse(mark, self.safety.mark(atlas.by_id[condition_id], self.lens))
        return {
            "combination_key": key,
            "label": stored.label,
            "concept_ids": condition_ids,
            "statuses": _lookup_statuses(row),
            "safety": mark,
            "warnings": served["warnings"] if served else [],
            "safeguards": served["safeguards"] if served else [],
            "provenance": served["provenance"] if served else None,
            "card_url": self.url(mode="multimorbidity", selected=condition_ids),
        }


def build_lookup(context: VersionContext, request: LookupRequest) -> dict:
    """The ``Lookup`` body (call under ``Store.lock``)."""
    case = request.context
    model, use_case = case.card.model_version, case.card.use_case
    lens = lens_from_population(case.population, case.setting)
    entry = context.dataset.model(model)  # 404 unknown_model
    card = _Card(context, model, use_case, lens)  # 404 unknown_use_case
    atlas = context.dataset.atlas

    conditions, matched_ids = [], {}
    for coding in case.conditions:
        concept = atlas.by_code.get(coding.code.upper())
        if concept is None:
            conditions.append({"code": coding.code, "matched": False})
            continue
        condition = card.condition(coding.code, concept)
        conditions.append(condition)
        matched_ids.setdefault(condition["anchor_id"], None)

    return {
        "dataset_version": context.label,
        "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
        "disclaimer": LOOKUP_DISCLAIMER,
        "card": {
            "model_version": model,
            "use_case": use_case,
            "display_name": entry.display_name,
            "kind": entry.kind,
            "card_url": card.url(),
            # Contract v1.11: whether the card has an intended-use statement.
            "intended_use_defined": context.dataset.intended_use_defined(model, use_case),
        },
        "lens": {"context": lens.setting, **lens.as_dict()},
        "conditions": conditions,
        "combination": card.combination(list(matched_ids)),
        # Contract v1.10: the local population named by context.population_id (absent for the default).
        **({"population": population_ref(context)} if context.population is not None else {}),
    }


@router.post(
    "/lookup",
    operation_id="lookup",
    summary=(
        "Statuses, warnings, safeguards, and safety incidents on one card for ICD-11 codes and a coarse population "
        "(the live interaction plugin)."
    ),
    description=(
        "Added in v1.8 (CONTRACT.md §19). The body is shaped like a CDS Hooks context; unknown keys anywhere are "
        "rejected. POST, so case inputs never appear in URLs or access logs; nothing is stored or logged. "
        "Demonstration on synthetic data, not for clinical use."
    ),
    response_model=Lookup,
    responses=problems(404, 422),
)
def lookup(request: Request, body: LookupRequest, version: Version = "live") -> Response:
    api = api_of(request)
    # Every error is handled here, so none escapes to the server's own error
    # logging (which would print a traceback with its messages).
    try:
        try:
            context = api.store.resolve(version, body.context.population_id)
        except ApiError as error:
            if error.code != "unknown_population":
                raise
            # Name the field, never the value sent (CONTRACT.md §19).
            raise ApiError(404, error.code, "Unknown population_id.") from None
        with api.store.lock:
            payload = build_lookup(context, body)
        encoded = encode(payload)
        if api.validate_responses:
            Lookup.model_validate_json(encoded)
    except (UnknownModel, UnknownUseCase) as error:
        # The service's message repeats the name sent; the problem names the field only.
        raise ApiError(404, error.code, _UNKNOWN_CARD[error.code]) from None
    except (ApiError, ServiceError, MissingData):
        raise  # problem details that name no case input
    except Exception as error:  # noqa: BLE001
        # Never log a traceback here: its messages could carry case inputs.
        log.error("Unhandled %s in lookup; details withheld.", type(error).__name__)
        raise ApiError(500, "internal_error", "The server failed to answer this request.") from None
    return Response(
        encoded,
        media_type="application/json",
        headers={DATASET_VERSION_HEADER: context.label, **population_headers(context), "Cache-Control": "no-store"},
    )

