"""Assisted data entry (contract v1.9, CONTRACT.md §20): status, configuration, proposals.

The helper proposes, never publishes: ``proposeRecords`` returns proposals
only; the maintainer accepts records by sending them to
``createRecordsUpload`` (a staged merge upload), and the normal check →
change summary → preview → publish flow follows. Responses are never cached,
never contain the API key, and problem details never repeat what was sent.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import Response
from pydantic.json_schema import SkipJsonSchema

from ...assist.inputs import MAX_INPUT_BYTES, InputError, from_file, from_text
from ...assist.service import AssistError, AssistService
from ..assist_schemas import AssistConfigRequest, AssistKind, AssistProposals, AssistStatus
from ..problems import ApiError
from .admin import NO_STORE, admin_json
from . import problems

router = APIRouter(prefix="/admin/assist", tags=["admin"])


def assist_of(request: Request) -> AssistService:
    return request.app.state.assist


# Titles of the helper's own codes that api/problems.py does not list.
_TITLES = {"assist_busy": "The helper is reading another study"}


def _api_error(error: AssistError | InputError) -> ApiError:
    return ApiError(error.status, error.code, error.detail, title=_TITLES.get(error.code))


@router.get(
    "",
    operation_id="getAssistStatus",
    summary="Whether the assisted data entry helper is on, with which provider and model. Never returns the API key.",
    response_model=AssistStatus,
    responses=problems(),
)
def get_assist_status(request: Request) -> Response:
    return admin_json(request, AssistStatus, assist_of(request).status())


@router.put(
    "",
    operation_id="configureAssist",
    summary="Turn the helper on: a hosted model with your own API key, or a local OpenAI-compatible model. The key is write-only.",
    response_model=AssistStatus,
    responses=problems(422),
)
def configure_assist(request: Request, body: AssistConfigRequest) -> Response:
    try:
        status = assist_of(request).configure(provider=body.provider, model=body.model, base_url=body.base_url, api_key=body.api_key)
    except AssistError as error:
        raise _api_error(error) from None
    return admin_json(request, AssistStatus, status)


@router.delete(
    "",
    operation_id="clearAssist",
    summary="Turn the helper off and delete its configuration, including the API key.",
    status_code=204,
    response_class=Response,
    responses={204: {"description": "The helper is off."}, **problems()},
)
def clear_assist(request: Request) -> Response:
    assist_of(request).clear()
    return Response(status_code=204, headers=NO_STORE)


@router.post(
    "/proposals",
    operation_id="proposeRecords",
    summary="Propose metrics or safety records from one study (PDF, text, CSV, XLSX, or pasted text). Proposes only; nothing is staged or published.",
    description=(
        "Sends the study to the configured provider and checks its answer against the store: only cards and ICD-11 codes "
        "that exist are proposed; the rest are listed in dropped with a reason. Each field carries its source quote, "
        "location, and uncertainty. Accept records by sending them to createRecordsUpload (CONTRACT.md §20)."
    ),
    response_model=AssistProposals,
    responses=problems(409, 413, 415, 422, 502),
)
def propose_records(
    request: Request,
    kind: Annotated[AssistKind, Form(description="The data set to propose records for.")],
    file: Annotated[UploadFile | SkipJsonSchema[None], File(description="The study: PDF (hosted model only), .txt, .md, .csv, or .xlsx, at most 10 MB.")] = None,
    text: Annotated[str | SkipJsonSchema[None], Form(description="Pasted study text, instead of a file (at most 200,000 characters).")] = None,
    model_version: Annotated[str | SkipJsonSchema[None], Form(description="Optional card: used when the study names none; records for other cards are dropped.")] = None,
    use_case: Annotated[str | SkipJsonSchema[None], Form(description="Optional card, with model_version.")] = None,
) -> Response:
    try:
        if (file is None) == (text is None or not text.strip()):
            raise AssistError(422, "invalid_parameter", "Send the study as a file or as pasted text (one of them).")
        if (model_version is None) != (use_case is None):
            raise AssistError(422, "invalid_parameter", "A card needs both model_version and use_case.")
        if file is not None:
            chunks, size = [], 0
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > MAX_INPUT_BYTES:
                    raise InputError(413, "upload_too_large", f"The study file is larger than {MAX_INPUT_BYTES // (1024 * 1024)} MB, the most the helper accepts.")
                chunks.append(chunk)
            study = from_file(file.filename, b"".join(chunks))
        else:
            study = from_text(text or "")
        card = (model_version, use_case) if model_version is not None and use_case is not None else None
        proposals = assist_of(request).propose(kind=kind, study=study, card=card)
    except (AssistError, InputError) as error:
        raise _api_error(error) from None
    return admin_json(request, AssistProposals, proposals)
