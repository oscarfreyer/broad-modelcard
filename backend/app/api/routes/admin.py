"""The admin operations: data sets, templates, uploads, changes, publish, history, rollback.

The work happens in ``app/publishing/uploads.py`` (``AdminService``); these
handlers translate HTTP. Admin responses are never cached (``no-store``).
All data is synthetic demonstration data. Never upload patient data.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, File, Form, Path as PathParam, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from pydantic.json_schema import SkipJsonSchema
from starlette.background import BackgroundTask

from ... import repository
from ...publishing.files import CSV_MEDIA_TYPE, XLSX_MEDIA_TYPE
from ...services.incidents import list_incidents as stored_incidents
from ...schema.contract import MAX_POPULATION_NAME, POPULATION_ID_PATTERN
from ...publishing.uploads import AdminError, AdminService
from ..responses import api_of, encode
from ..params import Version
from ..schemas import (
    ChangeSummary,
    DatasetInfo,
    DatasetKind,
    IncidentList,
    PublishRequest,
    RecordsUploadRequest,
    RollbackRequest,
    Upload,
    UploadMode,
    VersionEntry,
)
from . import problems

router = APIRouter(prefix="/admin", tags=["admin"])

UPLOAD_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
UploadIdPath = Annotated[str, PathParam(pattern=UPLOAD_ID_PATTERN)]
FileFormat = Literal["csv", "xlsx"]
NO_STORE = {"Cache-Control": "no-store"}


def file_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """A 200 that is a CSV or XLSX download, plus problem responses."""
    return {
        200: {
            "content": {
                "text/csv": {"schema": {"type": "string"}},
                XLSX_MEDIA_TYPE: {"schema": {"type": "string", "contentMediaType": XLSX_MEDIA_TYPE}},
            },
        },
        **problems(*statuses),
    }


def admin_of(request: Request) -> AdminService:
    return api_of(request).admin


def admin_json(request: Request, model: Any, payload: Any, status_code: int = 200) -> Response:
    body = encode(payload)
    if api_of(request).validate_responses:
        if isinstance(model, type) and issubclass(model, BaseModel):
            model.model_validate_json(body)
        else:
            from pydantic import TypeAdapter

            TypeAdapter(model).validate_json(body)
    return Response(body, status_code=status_code, media_type="application/json", headers=NO_STORE)


def download(path: Path, filename: str, file_format: str, workdir: str) -> FileResponse:
    return FileResponse(
        path,
        media_type=XLSX_MEDIA_TYPE if file_format == "xlsx" else CSV_MEDIA_TYPE,
        filename=filename,
        headers=NO_STORE,
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


# --------------------------------------------------------------- data sets

@router.get(
    "/datasets",
    operation_id="listDatasets",
    summary="The maintainable data sets with current version, last update, counts, and any staged upload (outside submissions).",
    response_model=list[DatasetInfo],
    responses=problems(),
)
def list_datasets(request: Request) -> Response:
    return admin_json(request, list[DatasetInfo], admin_of(request).datasets())


@router.get(
    "/templates/{kind}.{format}",
    operation_id="downloadTemplate",
    summary="Upload template. XLSX templates include an instructions sheet and dropdowns for allowed values.",
    response_class=Response,
    responses=file_responses(404, 422),
)
def download_template(
    request: Request,
    kind: Annotated[DatasetKind, PathParam()],
    format: Annotated[FileFormat, PathParam()],
    filled: Annotated[bool, Query(description="Include the current live data.")] = False,
    model_version: Annotated[
        str | SkipJsonSchema[None], Query(min_length=1, description="Required with filled=true for metrics and multimorbidity.")
    ] = None,
    use_case: Annotated[
        str | SkipJsonSchema[None], Query(min_length=1, description="Required with filled=true for metrics and multimorbidity.")
    ] = None,
    population_id: Annotated[
        str | SkipJsonSchema[None],
        Query(
            pattern=POPULATION_ID_PATTERN,
            description=(
                "With kind=population and filled=true (v1.10): that local population's tiers. "
                "Without it, a filled population template holds the default tiers to edit. "
                "With kind=local_metrics and filled=true (v1.13): required, the population of the local results."
            ),
        ),
    ] = None,
) -> Response:
    workdir = tempfile.mkdtemp(prefix="bmc-template-")
    try:
        path, filename = admin_of(request).template(
            kind, format, Path(workdir), filled=filled, model_version=model_version, use_case=use_case, population_id=population_id
        )
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    return download(path, filename, format, workdir)


# ----------------------------------------------------------------- uploads

@router.post(
    "/uploads",
    operation_id="createUpload",
    summary="Stage a CSV/XLSX upload and start validation. Only one staged upload per data set.",
    status_code=202,
    response_model=Upload,
    responses=problems(409, 413, 415, 422),
)
def create_upload(
    request: Request,
    kind: Annotated[DatasetKind, Form()],
    file: Annotated[UploadFile, File()],
    model_version: Annotated[
        str | SkipJsonSchema[None], Form(description="Required for kind=metrics and kind=multimorbidity.")
    ] = None,
    use_case: Annotated[
        str | SkipJsonSchema[None], Form(description="Required for kind=metrics and kind=multimorbidity.")
    ] = None,
    replace_staged: Annotated[
        bool, Form(description="Discard an existing staged upload for this data set instead of failing with 409.")
    ] = False,
    mode: Annotated[
        UploadMode,
        Form(description="replace (default) swaps the data set; merge (metrics, prevalence, safety) changes only the file's rows (v1.7)."),
    ] = "replace",
    population_id: Annotated[
        str | SkipJsonSchema[None],
        Form(
            description=(
                "Required for kind=population (v1.10): the local population's id, e.g. northbridge-region; and for "
                "kind=local_metrics (v1.13): the published local population the results are for."
            )
        ),
    ] = None,
    population_name: Annotated[
        str | SkipJsonSchema[None],
        Form(
            max_length=MAX_POPULATION_NAME,
            description="kind=population (v1.10): the name shown on every view; required for a new population.",
        ),
    ] = None,
    submission_id: Annotated[
        str | SkipJsonSchema[None],
        Form(min_length=1, max_length=64, description="v1.13: join this developer submission; it never publishes on its own."),
    ] = None,
) -> Response:
    admin = admin_of(request)
    incoming = admin.uploads_dir / ".incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(dir=incoming, delete=False)  # noqa: SIM115 (moved or removed below)
    source = Path(handle.name)
    try:
        with handle:
            size = 0
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > admin.max_upload_bytes:
                    raise AdminError(413, "upload_too_large", admin.too_large_detail())
                handle.write(chunk)
        upload = admin.create_upload(
            kind=kind,
            filename=file.filename or "upload",
            source=source,
            model_version=model_version,
            use_case=use_case,
            replace_staged=replace_staged,
            mode=mode,
            population_id=population_id,
            population_name=population_name,
            submission_id=submission_id,
        )
    finally:
        source.unlink(missing_ok=True)
    return admin_json(request, Upload, upload, status_code=202)


@router.post(
    "/uploads/records",
    operation_id="createRecordsUpload",
    summary="Stage JSON records as a merge upload in template form and start validation (the one-record form, the helper).",
    description=(
        "The records become a template-form CSV (header row 1, record i in row i + 2) that is checked like an uploaded "
        "file; report examples carry the record index. Only one staged upload per data set."
    ),
    status_code=202,
    response_model=Upload,
    responses=problems(409, 413, 422),
)
def create_records_upload(request: Request, body: RecordsUploadRequest) -> Response:
    upload = admin_of(request).create_records_upload(
        kind=body.kind,
        records=body.records,
        model_version=body.model_version,
        use_case=body.use_case,
        mode=body.mode,
        replace_staged=body.replace_staged,
        population_id=body.population_id,
        submission_id=body.submission_id,
    )
    return admin_json(request, Upload, upload, status_code=202)


@router.get(
    "/uploads/{upload_id}",
    operation_id="getUpload",
    summary="Upload status, validation progress, and validation report.",
    response_model=Upload,
    responses=problems(404),
)
def get_upload(request: Request, upload_id: UploadIdPath) -> Response:
    return admin_json(request, Upload, admin_of(request).get_upload(upload_id))


@router.delete(
    "/uploads/{upload_id}",
    operation_id="discardUpload",
    summary="Discard a staged upload. Live data is never affected.",
    status_code=204,
    response_class=Response,
    responses={204: {"description": "Discarded."}, **problems(404, 409)},
)
def discard_upload(request: Request, upload_id: UploadIdPath) -> Response:
    admin_of(request).discard(upload_id)
    return Response(status_code=204, headers=NO_STORE)


@router.get(
    "/uploads/{upload_id}/annotated.{format}",
    operation_id="downloadAnnotatedUpload",
    summary="The uploaded file with errors marked (highlighted cells in XLSX, an error column in CSV).",
    response_class=Response,
    responses=file_responses(404, 409),
)
def download_annotated(request: Request, upload_id: UploadIdPath, format: Annotated[FileFormat, PathParam()]) -> Response:
    workdir = tempfile.mkdtemp(prefix="bmc-annotated-")
    try:
        path, filename = admin_of(request).annotated(upload_id, format, Path(workdir))
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    return download(path, filename, format, workdir)


@router.get(
    "/uploads/{upload_id}/changes",
    operation_id="getUploadChanges",
    summary="What publishing this valid upload would change, in rows, AI systems, functions, and status shifts.",
    response_model=ChangeSummary,
    responses=problems(404, 409),
)
def get_upload_changes(request: Request, upload_id: UploadIdPath) -> Response:
    return admin_json(request, ChangeSummary, admin_of(request).changes(upload_id))


@router.post(
    "/uploads/{upload_id}/publish",
    operation_id="publishUpload",
    summary="Atomically publish a valid staged upload as a new dataset version. Publishes are serialized.",
    response_model=VersionEntry,
    responses=problems(404, 409),
)
def publish_upload(request: Request, upload_id: UploadIdPath, body: PublishRequest) -> Response:
    entry = admin_of(request).publish(upload_id, body.previewed, note=body.note, role=body.role, publisher_name=body.publisher_name)
    return admin_json(request, VersionEntry, entry)


# -------------------------------------------------------------- populations

@router.post(
    "/populations/{population_id}/remove",
    operation_id="removePopulation",
    summary="Publish a new version without this local population (v1.10); history keeps it, so a rollback restores it.",
    response_model=VersionEntry,
    responses=problems(404, 409),
)
def remove_population(
    request: Request,
    population_id: Annotated[str, PathParam(pattern=POPULATION_ID_PATTERN)],
    body: Annotated[RollbackRequest | SkipJsonSchema[None], Body()] = None,
) -> Response:
    body = body or RollbackRequest()
    entry = admin_of(request).remove_population(population_id, note=body.note, role=body.role, publisher_name=body.publisher_name)
    return admin_json(request, VersionEntry, entry)


# ------------------------------------------------------------------ safety

@router.get(
    "/safety/incidents",
    operation_id="listIncidents",
    summary="Stored safety incidents (open, mitigated, and closed), newest first, for editing in the Data Library.",
    response_model=IncidentList,
    responses=problems(404, 409, 422),
)
def list_incidents(
    request: Request,
    model: Annotated[str | SkipJsonSchema[None], Query(min_length=1, description="Only the incidents of this AI system (model_version).")] = None,
    use_case: Annotated[str | SkipJsonSchema[None], Query(min_length=1, description="Only the incidents of this function (use case).")] = None,
    version: Version = "live",
) -> Response:
    store = api_of(request).store
    context = store.resolve(version)
    dataset = context.dataset
    with store.lock:  # the store's connection and caches are shared (app/api/store.py)
        incidents = repository.load_incidents(dataset.connection, dataset.state.safety_set_id)
        listed = stored_incidents(dataset.atlas, incidents, model_version=model, use_case=use_case)
    return admin_json(request, IncidentList, {"dataset_version": context.label, "incidents": listed})


# ------------------------------------------------------------------ history

@router.get(
    "/versions",
    operation_id="listVersions",
    summary="Published dataset versions, newest first.",
    response_model=list[VersionEntry],
    responses=problems(),
)
def list_versions(request: Request, kind: Annotated[DatasetKind | SkipJsonSchema[None], Query()] = None) -> Response:
    return admin_json(request, list[VersionEntry], admin_of(request).list_versions(kind))


@router.post(
    "/versions/{version_id}/rollback",
    operation_id="rollbackVersion",
    summary="Restore the data set as of this version by publishing a new version; history is never deleted.",
    response_model=VersionEntry,
    responses=problems(404, 409, 422),
)
def rollback_version(
    request: Request,
    version_id: Annotated[int, PathParam(ge=1)],
    kind: Annotated[
        DatasetKind | SkipJsonSchema[None],
        Query(description="The data set to restore. Default: the one this version changed (every data set for the initial import)."),
    ] = None,
    every_kind: Annotated[
        bool,
        Query(description="Restore every data set to this version in one new version (v1.11). Cannot be combined with kind."),
    ] = False,
    body: Annotated[RollbackRequest | SkipJsonSchema[None], Body()] = None,
) -> Response:
    body = body or RollbackRequest()
    entry = admin_of(request).rollback(
        version_id, kind, note=body.note, every_kind=every_kind, role=body.role, publisher_name=body.publisher_name
    )
    return admin_json(request, VersionEntry, entry)
