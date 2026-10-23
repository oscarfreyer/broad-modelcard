"""``exportConcept`` and ``exportDataset``."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Annotated, Iterator, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response, StreamingResponse

from ...services.catalog import Catalog
from ...services.exports import (
    concept_export,
    concept_export_filename,
    dataset_export_chunks,
    dataset_export_filename,
)
from ..params import Age, ConceptIdPath, Context, Ethnicity, Model, Ontology, Population, Sex, UseCase, Version, lens_of
from ..responses import api_of, etag_matches, not_modified, population_headers, read_headers
from ..schemas import ConceptExport, DatasetExport
from ..views import atlas_view
from . import problems
from .metrics import served_row

router = APIRouter(tags=["export"])

# Part of the dataset export's ETag; bump it when the export format changes.
DATASET_EXPORT_FORMAT = "1"


def attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


def iso_now() -> str:
    """``Date.prototype.toISOString``: UTC with milliseconds and ``Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@router.get(
    "/export/concepts/{concept_id}",
    operation_id="exportConcept",
    summary="Condition model card as JSON (the PDF is rendered client-side from this payload).",
    response_model=ConceptExport,
    responses=problems(404),
)
def export_concept(
    request: Request,
    concept_id: ConceptIdPath,
    model: Model,
    use_case: UseCase,
    age: Age = "All ages",
    sex: Sex = "All sexes",
    ethnicity: Ethnicity = "All ethnicities",
    setting: Context = "Clinical",
    audience: Annotated[Literal["patient", "expert"], Query()] = "expert",
    version: Version = "live",
    population: Population = None,
    ontology: Ontology = None,
) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    view = atlas_view(api.store, context, ontology)
    lens = lens_of(age, sex, ethnicity, setting)
    concept = view.catalog.concept(concept_id)  # the catalog is read-only, no lock needed

    def build() -> dict:
        metrics = view.metrics(model, use_case)
        exported = concept_export(
            view.catalog,
            concept,
            served_row(view, metrics, model, use_case, concept, lens),
            model_version=model,
            use_case=use_case,
            lens=lens,
            audience=audience,
            dataset_version=context.label,
            exported_at=iso_now(),
        )
        if view.projection is not None:
            # Contract v1.13: the export names the ontology (top level), the concept's own code, and its mapping.
            exported["concept"]["code"] = view.projection.tables.codes.get(concept.concept_id) or concept.concept_id
            exported["concept"]["mapping"] = view.projection.mapping_payload(concept)
        return exported

    # Not cached: every export carries its own timestamp.
    return api.json(
        request, context, ConceptExport, build, headers=attachment(concept_export_filename(concept)), ontology=view.ref
    )


@router.get(
    "/export/dataset",
    operation_id="exportDataset",
    summary=(
        "Full assembled dataset for one model and use case, streamed as a download "
        "(exempt from the 2 MB response budget)."
    ),
    response_model=DatasetExport,
    responses=problems(404),
)
def export_dataset(request: Request, model: Model, use_case: UseCase, version: Version = "live", population: Population = None) -> Response:
    api = api_of(request)
    context = api.store.resolve(version, population)
    with api.store.lock:
        context.dataset.metrics(model, use_case)  # 404 for an unknown model or use case
    # The export is deterministic for a dataset version, so its ETag is known
    # before the body is produced.
    identity = f"{DATASET_EXPORT_FORMAT}|{context.version_id}|{model}|{use_case}"
    if context.staged_upload_id is not None:
        # A re-checked upload keeps its id but stages a new set.
        identity += f"|{context.label}|{context.staged_set_id}"
    if context.population is not None:
        # Contract v1.10: a local population's export has its own ETag.
        identity += f"|population:{context.population.population_id}:{context.population.set_id}"
    digest = hashlib.blake2b(identity.encode(), digest_size=16).hexdigest()
    headers = {
        **read_headers(context.label, f'"{digest}"'),
        **population_headers(context),
        **attachment(dataset_export_filename(model, use_case, context.label.replace(":", "-"))),
    }
    if etag_matches(request.headers.get("if-none-match"), headers["ETag"]):
        return not_modified(headers)

    def stream() -> Iterator[bytes]:
        # Its own connection and caches, so the export neither holds the lock
        # nor evicts the rows interactive requests are using.
        dataset = api.store.open_dataset(context)
        try:
            yield from dataset_export_chunks(
                dataset, Catalog(dataset.atlas), model, use_case, dataset_version=context.label
            )
        finally:
            dataset.connection.close()

    return StreamingResponse(stream(), media_type="application/json", headers=headers)
