"""``getNarrowModelCard`` and ``listDatasetVersions`` (contract v1.13, CONTRACT.md §26), and
``listSafetyIncidents`` (contract v1.14, §18, §30).

Read operations like every other: ``version``, ``X-Dataset-Version``, a strong
ETag, and 304s. ``listDatasetVersions`` lets operational systems ask what
changed since a version they know, and since v1.14 what changed one card; the
admin History (``listVersions``) stays. ``listSafetyIncidents`` is the public
read of the incident list the Data Library edits (``listIncidents``).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import Response
from pydantic.json_schema import SkipJsonSchema

from ... import repository
from ...services.catalogue import HistoryCache
from ...services.errors import UnknownModel
from ...services.incidents import list_incidents as stored_incidents
from ..params import Version
from ..problems import ApiError
from ..responses import api_of
from ..schemas import IncidentList, NarrowModelCardRead, VersionFeed
from . import problems

router = APIRouter(tags=["meta"])


@router.get(
    "/models/{model_version}/narrow-model-card",
    operation_id="getNarrowModelCard",
    summary="The developer's narrow model card of one AI system (v1.13), or null when it has none. Never verified.",
    response_model=NarrowModelCardRead,
    responses=problems(404, 422),
)
def get_narrow_model_card(
    request: Request,
    model_version: Annotated[str, Path(min_length=1, max_length=64)],
    version: Version = "live",
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        dataset = context.dataset
        try:
            dataset.model(model_version)
        except UnknownModel as error:
            raise ApiError(404, "unknown_model", "Unknown AI system.") from error
        card = next(
            (stored for stored in repository.load_model_cards(dataset.connection, dataset.state.model_cards_set_id) if stored.model_version == model_version),
            None,
        )
        payload = None
        if card is not None:
            payload = {
                "model_version": card.model_version,
                "source_format": card.source_format,
                **{key: card.card.get(key) for key in ("name", "version", "licence", "intended_use", "limitations", "training_data", "date")},
                "results": card.card.get("results") or [],
                "markdown": card.markdown,
                "submitted_at": card.submitted_at,
            }
        return {"dataset_version": context.label, "model_version": model_version, "narrow_model_card": payload}

    return api.json(request, context, NarrowModelCardRead, build, cache_key=("narrow-model-card", model_version))


@router.get(
    "/versions",
    operation_id="listDatasetVersions",
    summary="Published dataset versions, newest first (v1.13): what changed, when, why, and in which role; for operational systems.",
    response_model=VersionFeed,
    responses=problems(422),
)
def list_dataset_versions(
    request: Request,
    after: Annotated[
        int | SkipJsonSchema[None], Query(ge=0, description="Only versions newer than this one (e.g. the last version a system saw).")
    ] = None,
    version: Version = "live",
    card: Annotated[
        str | SkipJsonSchema[None],
        Query(
            min_length=3,
            max_length=300,
            description=(
                "v1.14 (CONTRACT.md §26.6): only the versions that changed this card, <model_version>|<use_case> "
                "(URL-encoded), by the rule of the catalogue's last_updated (§17). A card no version holds gives an "
                "empty list; a value that is not a card id is 422 invalid_parameter."
            ),
        ),
    ] = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)
    key = card_key(card) if card is not None else None

    def build() -> dict:
        connection = context.dataset.connection
        rows = connection.execute(
            "SELECT version_id, created_at, kind, summary, note, publisher_role FROM dataset_versions "
            "WHERE version_id <= ? AND version_id > ? ORDER BY version_id DESC",
            (context.version_id, after or 0),
        )
        if key is not None:
            # Contract v1.14 (§26.6): the versions that changed the card (§17's rule), newest first.
            history = context.history if context.history is not None else HistoryCache()
            changed = set(history.changed_versions(connection, context.version_id, key))
            rows = [row for row in rows if row[0] in changed]
        return {
            "dataset_version": context.label,
            "versions": [
                {"version_id": row[0], "published_at": row[1], "kind": row[2], "summary": row[3], "note": row[4], "publisher_role": row[5]}
                for row in rows
            ],
        }

    cache_key = ("versions", after) if key is None else ("versions", after, "card", *key)
    return api.json(request, context, VersionFeed, build, cache_key=cache_key)


@router.get(
    "/incidents",
    operation_id="listSafetyIncidents",
    summary=(
        "The safety incidents of the version (open, mitigated, and closed), newest first; optionally of one AI system "
        "or one card (v1.14). The public read of what the Data Library's incident list serves."
    ),
    response_model=IncidentList,
    responses=problems(422),
)
def list_safety_incidents(
    request: Request,
    model: Annotated[str | SkipJsonSchema[None], Query(min_length=1, description="Only the incidents of this AI system (model_version).")] = None,
    use_case: Annotated[str | SkipJsonSchema[None], Query(min_length=1, description="Only the incidents of this function (use case).")] = None,
    version: Version = "live",
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        dataset = context.dataset
        incidents = repository.load_incidents(dataset.connection, dataset.state.safety_set_id)
        return {
            "dataset_version": context.label,
            "incidents": stored_incidents(dataset.atlas, incidents, model_version=model, use_case=use_case),
        }

    return api.json(request, context, IncidentList, build, cache_key=("incidents", model, use_case))


def card_key(card: str) -> tuple[str, str]:
    """``<model_version>|<use_case>`` as a configuration key; 422 for anything else."""
    model, separator, use_case = card.partition("|")
    if not separator or not model.strip() or not use_case.strip() or "|" in use_case:
        raise ApiError(422, "invalid_parameter", f"card: expected <model_version>|<use_case>, got {card!r}.")
    return model, use_case
