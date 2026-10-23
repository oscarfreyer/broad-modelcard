"""Admin operations of contract v1.13 §26: the instance profile, developer
submissions, narrow model card uploads and their proposed records, and public
release bundles. The work happens in ``app/publishing`` (``AdminService`` and
its workspace and release mixins). There is no login: the role a request names
is the user's choice, recorded on the version. Admin responses are never cached.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Body, File, Path as PathParam, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic.json_schema import SkipJsonSchema
from starlette.background import BackgroundTask

from ...publishing.release import MAX_BUNDLE_BYTES
from ...publishing.uploads import AdminError
from ..responses import api_of
from ..schemas import (
    EvaluationProposals,
    EvaluationUploadRequest,
    InstanceProfile,
    ModelCardProposals,
    ModelCardUploadRequest,
    ReleaseImport,
    ReleasePublishRequest,
    Submission,
    SubmissionDecision,
    SubmissionRequest,
    Upload,
    VersionEntry,
)
from . import problems
from .admin import NO_STORE, UploadIdPath, admin_json, admin_of

router = APIRouter(prefix="/admin", tags=["admin"])

SubmissionIdPath = Annotated[str, PathParam(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
ImportIdPath = Annotated[str, PathParam(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
GZIP_MEDIA_TYPE = "application/gzip"


# ------------------------------------------------------------------ instance

@router.put(
    "/instance",
    operation_id="updateInstance",
    summary="Set the instance profile (v1.13): public service or hospital version, organisation, who maintains it, and (v1.14) a data-protection note. /meta serves it.",
    response_model=InstanceProfile,
    responses=problems(422),
)
def update_instance(request: Request, body: InstanceProfile) -> Response:
    profile = admin_of(request).update_instance(
        kind=body.kind,
        organisation=body.organisation,
        maintained_by=body.maintained_by,
        contact=body.contact,
        data_protection_note=body.data_protection_note,
    )
    api_of(request).store.responses.clear()  # /meta names the instance
    return admin_json(request, InstanceProfile, profile)


# --------------------------------------------------------------- submissions

@router.post(
    "/submissions",
    operation_id="createSubmission",
    summary="Open a developer submission (v1.13); its uploads join it with submission_id and wait for a custodian.",
    status_code=201,
    response_model=Submission,
    responses=problems(422),
)
def create_submission(request: Request, body: SubmissionRequest) -> Response:
    submission = admin_of(request).create_submission(
        developer_name=body.developer_name, model_version=body.model_version, note=body.note
    )
    return admin_json(request, Submission, submission, status_code=201)


@router.get(
    "/submissions",
    operation_id="listSubmissions",
    summary="Developer submissions, newest first (v1.13): the custodian's queue.",
    response_model=list[Submission],
    responses=problems(422),
)
def list_submissions(
    request: Request,
    status: Annotated[Literal["submitted", "returned", "accepted"] | SkipJsonSchema[None], Query()] = None,
) -> Response:
    return admin_json(request, list[Submission], admin_of(request).list_submissions(status))


@router.get(
    "/submissions/{submission_id}",
    operation_id="getSubmission",
    summary="One developer submission with its uploads (v1.13).",
    response_model=Submission,
    responses=problems(404),
)
def get_submission(request: Request, submission_id: SubmissionIdPath) -> Response:
    return admin_json(request, Submission, admin_of(request).get_submission(submission_id))


@router.post(
    "/submissions/{submission_id}/accept",
    operation_id="acceptSubmission",
    summary="Accept a submission (v1.13): publish its uploads, one version each, with the custodian's note and name.",
    response_model=Submission,
    responses=problems(404, 409, 422),
)
def accept_submission(
    request: Request, submission_id: SubmissionIdPath, body: Annotated[SubmissionDecision | SkipJsonSchema[None], Body()] = None
) -> Response:
    body = body or SubmissionDecision()
    result = admin_of(request).accept_submission(submission_id, note=body.note, publisher_name=body.publisher_name)
    return admin_json(request, Submission, result)


@router.post(
    "/submissions/{submission_id}/return",
    operation_id="returnSubmission",
    summary="Return a submission to its developer with a required note (v1.13); its staged uploads are discarded.",
    response_model=Submission,
    responses=problems(404, 409, 422),
)
def return_submission(request: Request, submission_id: SubmissionIdPath, body: SubmissionDecision) -> Response:
    result = admin_of(request).return_submission(submission_id, note=body.note, publisher_name=body.publisher_name)
    return admin_json(request, Submission, result)


# --------------------------------------------------------- narrow model cards

@router.post(
    "/uploads/model-card",
    operation_id="createModelCardUpload",
    summary="Stage a narrow model card (v1.13): JSON or Markdown text for one AI system, checked in the background.",
    status_code=202,
    response_model=Upload,
    responses=problems(404, 409, 413, 422),
)
def create_model_card_upload(request: Request, body: ModelCardUploadRequest) -> Response:
    upload = admin_of(request).create_model_card_upload(
        model_version=body.model_version,
        source_format=body.format,
        content=body.content,
        filename=body.filename,
        submission_id=body.submission_id,
        replace_staged=body.replace_staged,
    )
    return admin_json(request, Upload, upload, status_code=202)


@router.get(
    "/uploads/{upload_id}/proposed-records",
    operation_id="getModelCardProposals",
    summary="Metric records proposed from a staged narrow model card's results with ICD-11 codes (v1.13); nothing is staged.",
    response_model=ModelCardProposals,
    responses=problems(404, 409),
)
def get_model_card_proposals(request: Request, upload_id: UploadIdPath) -> Response:
    return admin_json(request, ModelCardProposals, admin_of(request).model_card_proposals(upload_id))


# ------------------------------------------------------- evaluation results

@router.post(
    "/uploads/evaluation-results",
    operation_id="createEvaluationUpload",
    summary="Stage an evaluation results file (v1.14): a benchmark or harness run for one card as JSON, checked in the background; it publishes nothing.",
    description=(
        "Added in v1.14 (CONTRACT.md §32.2). Format bmc-evaluation-results/1 (docs/evaluation-results.md), at most 1 MB. "
        "A valid upload offers proposed records (getEvaluationProposals); it is never published itself."
    ),
    status_code=202,
    response_model=Upload,
    responses=problems(404, 409, 413, 422),
)
def create_evaluation_upload(request: Request, body: EvaluationUploadRequest) -> Response:
    upload = admin_of(request).create_evaluation_upload(
        content=body.content, filename=body.filename, submission_id=body.submission_id, replace_staged=body.replace_staged
    )
    return admin_json(request, Upload, upload, status_code=202)


@router.get(
    "/uploads/{upload_id}/evaluation-proposals",
    operation_id="getEvaluationProposals",
    summary="Records proposed from a valid evaluation results upload (v1.14): one benchmark study and one metrics merge record per result; nothing is staged.",
    response_model=EvaluationProposals,
    responses=problems(404, 409),
)
def get_evaluation_proposals(request: Request, upload_id: UploadIdPath) -> Response:
    return admin_json(request, EvaluationProposals, admin_of(request).evaluation_proposals(upload_id))


# ------------------------------------------------------------------- release

@router.get(
    "/release/export",
    operation_id="exportPublicRelease",
    summary="Download the live public layers as a public release bundle (v1.13, public instances only): gzip SQLite with a manifest.",
    response_class=Response,
    responses={200: {"content": {GZIP_MEDIA_TYPE: {"schema": {"type": "string", "contentMediaType": GZIP_MEDIA_TYPE}}}}, **problems(409)},
)
def export_public_release(request: Request) -> Response:
    workdir = tempfile.mkdtemp(prefix="bmc-release-")
    try:
        path, filename = admin_of(request).export_release(Path(workdir))
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    return FileResponse(
        path, media_type=GZIP_MEDIA_TYPE, filename=filename, headers=NO_STORE,
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


@router.post(
    "/release/imports",
    operation_id="importPublicRelease",
    summary="Check a public release bundle on a hospital instance (v1.13) and summarize what publishing it would change.",
    status_code=201,
    response_model=ReleaseImport,
    responses=problems(409, 413, 422),
)
def import_public_release(request: Request, file: Annotated[UploadFile, File()]) -> Response:
    admin = admin_of(request)
    incoming = admin.uploads_dir / ".incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(dir=incoming, delete=False)  # noqa: SIM115 (removed below)
    source = Path(handle.name)
    try:
        with handle:
            size = 0
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > MAX_BUNDLE_BYTES:
                    raise AdminError(413, "upload_too_large", f"The bundle is larger than {MAX_BUNDLE_BYTES // (1024 * 1024)} MB.")
                handle.write(chunk)
        result = admin.import_release(source, file.filename or "release.sqlite.gz")
    finally:
        source.unlink(missing_ok=True)
    return admin_json(request, ReleaseImport, result, status_code=201)


@router.get(
    "/release/imports/{import_id}",
    operation_id="getReleaseImport",
    summary="A release import's check result and change summary (v1.13).",
    response_model=ReleaseImport,
    responses=problems(404),
)
def get_release_import(request: Request, import_id: ImportIdPath) -> Response:
    return admin_json(request, ReleaseImport, admin_of(request).get_release_import(import_id))


@router.post(
    "/release/imports/{import_id}/publish",
    operation_id="publishReleaseImport",
    summary="Publish a valid release import as one version (v1.13): public layers replaced, local layers kept.",
    response_model=VersionEntry,
    responses=problems(404, 409, 422),
)
def publish_release_import(
    request: Request, import_id: ImportIdPath, body: Annotated[ReleasePublishRequest | SkipJsonSchema[None], Body()] = None
) -> Response:
    body = body or ReleasePublishRequest()
    entry = admin_of(request).publish_release_import(import_id, note=body.note, role=body.role, publisher_name=body.publisher_name)
    return admin_json(request, VersionEntry, entry)


@router.delete(
    "/release/imports/{import_id}",
    operation_id="discardReleaseImport",
    summary="Discard a release import that was not published (v1.13). Live data is never affected.",
    status_code=204,
    response_class=Response,
    responses={204: {"description": "Discarded."}, **problems(404, 409)},
)
def discard_release_import(request: Request, import_id: ImportIdPath) -> Response:
    admin_of(request).discard_release_import(import_id)
    return Response(status_code=204, headers=NO_STORE)
