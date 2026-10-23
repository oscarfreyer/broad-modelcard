"""``getCardRecord``: one card as a compact record for operational systems
(contract v1.14, CONTRACT.md §32.1), or as JSON-LD (§32.3).

A read like every other: ``version`` (live or staged), ``ETag``,
``X-Dataset-Version``, and 304. It takes no population, setting, or ontology:
the record is the public ICD-11 card at all patients and the default
prevalence. The JSON-LD form is built from the same body.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from ...services.card_record import build_card_record, card_record_jsonld
from ...services.errors import UnknownModel, UnknownUseCase
from ..params import Model, UseCase, Version
from ..problems import ApiError
from ..responses import api_of
from ..schemas import CARD_RECORD_JSONLD_SCHEMA, CardRecord
from . import problems

router = APIRouter(tags=["cards"])

JSONLD_MEDIA_TYPE = "application/ld+json"
RecordFormat = Annotated[
    Literal["json", "jsonld"],
    Query(description="json (the default) or jsonld: the same content as JSON-LD with MCRO terms (CONTRACT.md §32.3)."),
]


@router.get(
    "/cards/record",
    operation_id="getCardRecord",
    summary="One card as a compact record for operational systems: AI system, card, studies, effects, incidents, chapter statuses, Overview counts.",
    description=(
        "Added in v1.14 (CONTRACT.md §32.1). ICD-11, all patients, Any setting, the default prevalence; public safety incidents "
        "only. Under 300 KB. format=jsonld serves the same content as JSON-LD (application/ld+json, §32.3). "
        "Synthetic demonstration data; never a certification or an approval."
    ),
    response_model=CardRecord,
    responses={
        200: {"content": {JSONLD_MEDIA_TYPE: {"schema": CARD_RECORD_JSONLD_SCHEMA}}},
        **problems(404, 422),
    },
)
def get_card_record(
    request: Request, model: Model, use_case: UseCase, version: Version = "live", format: RecordFormat = "json"
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def record() -> dict:
        try:
            return build_card_record(
                context.dataset, context.catalog, context.catalogue, model=model, use_case=use_case, label=context.label
            )
        except (UnknownModel, UnknownUseCase) as error:
            raise ApiError(404, error.code, str(error)) from None

    if format == "jsonld":
        return api.json(
            request, context, None, lambda: card_record_jsonld(record()),
            cache_key=("card-record", model, use_case, "jsonld"), media_type=JSONLD_MEDIA_TYPE,
        )
    return api.json(request, context, CardRecord, record, cache_key=("card-record", model, use_case))
