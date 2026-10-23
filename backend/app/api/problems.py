"""Errors as RFC 9457 problem details (``application/problem+json``) with a stable ``code``."""

from __future__ import annotations

import json
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..publishing.uploads import AdminError
from ..repository import MissingData
from ..services.errors import ServiceError

PROBLEM_MEDIA_TYPE = "application/problem+json"

log = logging.getLogger("broad_modelcard.api")

_TITLES = {
    "unknown_model": "Unknown model",
    "unknown_use_case": "Unknown use case",
    "unknown_concept": "Unknown concept",
    "unknown_upload": "Unknown upload",
    "unknown_population": "Unknown local population",
    "unknown_study": "Unknown study",
    "unknown_ontology": "Unknown ontology",
    "invalid_lens": "Invalid demographic lens",
    "invalid_version": "Invalid dataset version",
    "invalid_scope": "Invalid scope",
    "missing_chapter_id": "chapter_id is required when scope=chapter",
    "invalid_view": "Invalid metric view",
    "invalid_selection": "Invalid condition selection",
    "invalid_cards": "Invalid cards to compare",
    "invalid_query": "Invalid search query",
    "invalid_limit": "Invalid search limit",
    "invalid_parameter": "Invalid parameter",
    "not_found": "Not found",
    "method_not_allowed": "Method not allowed",
    "store_unavailable": "Data store unavailable",
    "internal_error": "Internal server error",
    "local_only": "Local requests only",
    "unknown_version": "Unknown dataset version",
    "staged_upload_exists": "An upload is already staged for this data set",
    "upload_not_valid": "The upload is not valid",
    "upload_not_staged": "The upload is no longer staged",
    "upload_outdated": "The upload no longer fits the live data",
    "upload_too_large": "File too large",
    "unsupported_file_type": "Unsupported file type",
    "publish_in_progress": "A publish is in progress",
    "rollback_conflict": "Rollback would make the data inconsistent",
    "rollback_no_change": "Rollback would change nothing",
    "assist_not_configured": "The assisted data entry helper is off",
    "assist_provider_error": "The model provider failed",
    "assist_unsupported_input": "The helper cannot read this study",
    # Contract v1.13 (CONTRACT.md §26).
    "unknown_submission": "Unknown submission",
    "submission_closed": "The submission is closed",
    "submission_not_ready": "The submission is not ready",
    "submission_upload": "The upload belongs to a submission",
    "not_public_instance": "Not a public instance",
    "not_hospital_instance": "Not a hospital instance",
    "unknown_import": "Unknown release import",
    "import_not_valid": "The release import is not valid",
    "import_not_staged": "The release import is no longer waiting",
    "invalid_bundle": "Invalid release bundle",
    "bundle_checksum": "The release bundle is damaged",
    "bundle_atlas_mismatch": "The release bundle has another atlas",
    "unknown_model_card": "No narrow model card",
    # Contract v1.14 (CONTRACT.md §33).
    "invalid_cds_request": "Invalid CDS Hooks request",
}

_SERVICE_STATUS = {"unknown_model": 404, "unknown_use_case": 404, "unknown_concept": 404, "invalid_lens": 422}

# Query parameters whose validation errors have their own code.
_PARAMETER_CODES = {
    "age": "invalid_lens",
    "sex": "invalid_lens",
    "ethnicity": "invalid_lens",
    # Contract v1.14 (§29): the care setting is a lens axis too.
    "context": "invalid_lens",
    "version": "invalid_version",
    "scope": "invalid_scope",
    "view": "invalid_view",
    "selected": "invalid_selection",
    "cards": "invalid_cards",
    "q": "invalid_query",
    "limit": "invalid_limit",
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, detail: str | None = None, *, title: str | None = None):
        super().__init__(detail or code)
        self.status = status
        self.code = code
        self.detail = detail
        self.title = title or _TITLES.get(code, code.replace("_", " ").capitalize())


def problem_response(error: ApiError) -> Response:
    body = {"type": f"urn:broad-modelcard:problem:{error.code}", "title": error.title, "status": error.status}
    if error.detail:
        body["detail"] = error.detail
    body["code"] = error.code
    return Response(
        json.dumps(body, ensure_ascii=False).encode(), status_code=error.status, media_type=PROBLEM_MEDIA_TYPE
    )


def from_service_error(error: ServiceError) -> ApiError:
    return ApiError(_SERVICE_STATUS.get(error.code, 422), error.code, str(error))


def _validation_error(error: RequestValidationError) -> ApiError:
    """The first invalid parameter decides the code; all are named in the detail."""
    messages, code = [], None
    for item in error.errors():
        location = [str(part) for part in item.get("loc", ())]
        name = location[-1] if location else "request"
        code = code or _PARAMETER_CODES.get(name, "invalid_parameter")
        if item.get("type") == "missing":
            messages.append(f"{name} is required")
        else:
            value = item.get("input")
            shown = f" (got {value!r})" if isinstance(value, (str, int, float)) else ""
            messages.append(f"{name}: {item.get('msg', 'invalid value')}{shown}")
    return ApiError(422, code or "invalid_parameter", "; ".join(messages))


def _lookup_body_code(location: tuple, error_type: str | None) -> str:
    """``lookup`` (v1.8, CONTRACT.md §19): conditions → invalid_selection, population → invalid_lens,
    an unknown key anywhere → invalid_parameter."""
    if error_type == "extra_forbidden":
        return "invalid_parameter"
    if location[1:3] == ("context", "conditions"):
        return "invalid_selection"
    if location[1:3] in (("context", "population"), ("context", "setting")):
        return "invalid_lens"  # the setting since v1.14 (§29)
    if location[-1:] == ("context",):
        return "invalid_parameter"  # the body's context object, not the read parameter
    return _PARAMETER_CODES.get(location[-1] if location else "", "invalid_parameter")


def _lookup_validation_error(error: RequestValidationError) -> ApiError:
    """Like ``_validation_error``, but never repeats what was sent (CONTRACT.md §19: case inputs
    are not echoed or logged). Problems name the field; an unknown key is named by its parent."""
    messages, code = [], None
    for item in error.errors():
        location = tuple(str(part) for part in item.get("loc", ()))
        error_type = item.get("type")
        code = code or _lookup_body_code(location, error_type)
        if location and location[0] == "body":
            if error_type == "extra_forbidden":
                parent = ".".join(location[1:-1]) or "body"
                messages.append(f"{parent}: unknown field (only the documented fields are accepted)")
                continue
            if error_type == "json_invalid":
                messages.append("body: not valid JSON")
                continue
            field = ".".join(location[1:]) or "body"
        else:
            field = location[-1] if location else "request"
        if error_type == "missing":
            messages.append(f"{field} is required")
        else:
            messages.append(f"{field}: {item.get('msg', 'invalid value')}")
    return ApiError(422, code or "invalid_parameter", "; ".join(messages))


def _is_lookup(request: Request) -> bool:
    return request.url.path.endswith("/lookup")


def _is_assist(request: Request) -> bool:
    """Assisted entry (v1.9, CONTRACT.md §20): bodies may carry an API key or study text, never echoed or logged."""
    return "/admin/assist" in request.url.path


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, error: ApiError) -> Response:
        return problem_response(error)

    @app.exception_handler(AdminError)
    async def _admin_error(_request: Request, error: AdminError) -> Response:
        return problem_response(ApiError(error.status, error.code, error.detail))

    @app.exception_handler(ServiceError)
    async def _service_error(_request: Request, error: ServiceError) -> Response:
        return problem_response(from_service_error(error))

    @app.exception_handler(RequestValidationError)
    async def _request_validation(request: Request, error: RequestValidationError) -> Response:
        if _is_lookup(request) or _is_assist(request):
            return problem_response(_lookup_validation_error(error))
        return problem_response(_validation_error(error))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, error: StarletteHTTPException) -> Response:
        code = {404: "not_found", 405: "method_not_allowed", 413: "upload_too_large"}.get(
            error.status_code, "invalid_parameter"
        )
        detail = error.detail if isinstance(error.detail, str) else None
        response = problem_response(ApiError(error.status_code, code, detail))
        for name, value in (error.headers or {}).items():
            response.headers[name] = value
        return response

    @app.exception_handler(MissingData)
    async def _missing_data(_request: Request, error: MissingData) -> Response:
        return problem_response(ApiError(503, "store_unavailable", str(error)))

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, error: Exception) -> Response:
        if _is_lookup(request) or _is_assist(request):
            # Case inputs (§19), API keys and study text (§20) are never logged: name the error type only.
            log.error("Unhandled %s in %s; details withheld.", type(error).__name__, "lookup" if _is_lookup(request) else "assisted entry")
        else:
            log.exception("Unhandled error", exc_info=error)
        return problem_response(ApiError(500, "internal_error", "The server failed to answer this request."))
