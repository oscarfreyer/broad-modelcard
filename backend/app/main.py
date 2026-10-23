"""FastAPI application: contract v1 under ``/api/v1`` (read and admin operations).

Start it with ``python -m app.serve`` (see app/serve.py), which binds
127.0.0.1 only. The API has no authentication and must never be
reachable from another machine; ``api/guard.py`` also rejects non-loopback
clients if the app is started some other way.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from . import db
from .api import problems
from .api.guard import LocalOnlyGuard
from .api.limits import FORM_OVERHEAD, MAX_OTHER_BODY_BYTES, UploadSizeLimit
from .api.responses import Api
from .api.routes import (
    admin, assist, atlas, cards, catalogue, cds_hooks, compare, export, feeds, lookup, meta, metrics, multimorbidity, search,
    studies, workspaces,
)
from .publishing.release import MAX_BUNDLE_BYTES
from .schema.contract import MAX_EVALUATION_BYTES, MAX_MODEL_CARD_BYTES
from .assist.inputs import MAX_INPUT_BYTES as MAX_ASSIST_INPUT_BYTES
from .assist.proposals import DatasetView
from .assist.service import AssistService
from .api.store import Store
from .publishing.uploads import DEFAULT_MAX_UPLOAD_BYTES, AdminService
from .repository import MissingData

API_PREFIX = "/api/v1"
MAX_RECORDS_BYTES = 8 * 1024 * 1024  # createRecordsUpload bodies (contract v1.7)
MAX_LOOKUP_BYTES = 64 * 1024  # lookup bodies (contract v1.8; 12 short codes fit in well under 2 KB)
# Responses of 1 KB and more are gzipped for clients that accept it (contract v1.12, transport only):
# the atlas overview shrinks from about 1 MB to well under 200 KB. Level 6 keeps a 1 MB body
# under a few milliseconds. Archives, media, spreadsheets, and PDFs are compressed already, and
# event streams must not be buffered.
GZIP_MINIMUM_BYTES = 1024
GZIP_LEVEL = 6
GZIP_EXCLUDED_TYPES = (
    "application/gzip",
    "application/x-gzip",
    "application/zip",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "audio/*",
    "font/woff",
    "font/woff2",
    "image/*",
    "text/event-stream",
    "video/*",
)

LOCAL_ONLY_WARNING = (
    "Broad Modelcard API: LOCAL ONLY, NO AUTHENTICATION. It serves synthetic demonstration data and "
    "must only listen on 127.0.0.1. Never expose it to a network."
)

log = logging.getLogger("broad_modelcard.api")


def default_db_path() -> Path:
    return Path(os.environ.get("BMC_DB", db.DEFAULT_DB_PATH))


def default_uploads_dir() -> Path | None:
    """``BMC_UPLOADS_DIR``, or None for ``uploads/`` next to the store.

    A second store next to the live one (the demo store) sets it, so its
    uploads never mix with the live store's in ``backend/data/uploads``."""
    value = os.environ.get("BMC_UPLOADS_DIR")
    return Path(value) if value else None


def create_app(
    db_path: Path | str | None = None,
    *,
    validate_responses: bool = False,
    uploads_dir: Path | str | None = None,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
) -> FastAPI:
    """Build the app. ``validate_responses`` checks every JSON body against the
    response models (slower; the tests turn it on). Uploads are kept in
    ``uploads_dir`` (default: ``$BMC_UPLOADS_DIR``, else ``uploads/`` next to
    the store)."""
    path = Path(db_path or default_db_path())
    uploads_dir = uploads_dir or default_uploads_dir()
    admin_service = AdminService(path, uploads_dir=uploads_dir, max_upload_bytes=max_upload_bytes)
    store = Store(path, admin=admin_service)
    admin_service.listeners.append(store.forget_staged)

    def assist_view() -> DatasetView:
        """The live version as the helper's view of the store (contract v1.9)."""
        context = store.resolve("live")
        with store.lock:
            search_index = context.search
        return DatasetView(context.dataset, search_index, lock=store.lock)

    assist_service = AssistService(path, view_factory=assist_view)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        log.warning(LOCAL_ONLY_WARNING)
        log.info("Store: %s (uploads in %s)", store.db_path, admin_service.uploads_dir)
        try:
            admin_service.open()  # applies pending migrations before the read connection opens
            store.warm()
        except MissingData as error:
            # The path is logged here only; problem details never carry file-system paths (CONTRACT.md §16).
            log.error("%s (%s) Requests will fail with 503 store_unavailable until it exists.", error, store.db_path)
        yield
        store.close()
        admin_service.close()

    app = FastAPI(
        title="Broad Modelcard API",
        version="1.0.0",
        summary="Frontend–backend contract v1 for the Broad Modelcard pilot (backend/openapi.json).",
        description=(
            "All data served by this API is synthetic demonstration data. Normative derivation rules are defined "
            "in backend/CONTRACT.md. The API binds to 127.0.0.1 and has no authentication; it must not be exposed "
            "beyond the local machine."
        ),
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.api = Api(store, admin_service, validate_responses=validate_responses)
    app.state.assist = assist_service
    # Request body limits (CONTRACT.md §16): (path, limit, noun, multipart overhead).
    # Contract v1.13 (§26): a narrow model card's text (JSON-escaped, so twice its size at most) and release bundles.
    limited = (
        ("/admin/uploads", lambda: admin_service.max_upload_bytes, "The file is", FORM_OVERHEAD),
        ("/admin/uploads/records", lambda: MAX_RECORDS_BYTES, "The records are", FORM_OVERHEAD),
        ("/admin/assist/proposals", lambda: MAX_ASSIST_INPUT_BYTES, "The study is", FORM_OVERHEAD),
        ("/lookup", lambda: MAX_LOOKUP_BYTES, "The request is", 0),
        ("/admin/uploads/model-card", lambda: 2 * MAX_MODEL_CARD_BYTES, "The card is", FORM_OVERHEAD),
        # Contract v1.14 (§32.2, §33): evaluation results files (JSON-escaped text) and CDS Hooks requests.
        ("/admin/uploads/evaluation-results", lambda: 2 * MAX_EVALUATION_BYTES, "The file is", FORM_OVERHEAD),
        ("/cds-services/bmc-condition-status", lambda: MAX_LOOKUP_BYTES, "The request is", 0),
        ("/admin/release/imports", lambda: MAX_BUNDLE_BYTES, "The bundle is", FORM_OVERHEAD),
    )
    for path, limit, noun, overhead in limited:
        app.add_middleware(UploadSizeLimit, path_suffix=f"{API_PREFIX}{path}", limit=limit, noun=noun, overhead=overhead)
    # Every other body (publish, rollback, submissions, the instance, ...) is small.
    app.add_middleware(
        UploadSizeLimit,
        path_suffix=None,
        limit=lambda: MAX_OTHER_BODY_BYTES,
        noun="The request is",
        overhead=0,
        except_suffixes=tuple(f"{API_PREFIX}{path}" for path, *_ in limited),
    )
    app.add_middleware(
        GZipMiddleware,
        minimum_size=GZIP_MINIMUM_BYTES,
        compresslevel=GZIP_LEVEL,
        exclude_content_types=GZIP_EXCLUDED_TYPES,
    )
    app.add_middleware(LocalOnlyGuard)  # outermost
    problems.install(app)
    for module in (
        meta, feeds, catalogue, atlas, metrics, studies, compare, multimorbidity, search, export, lookup, cards, cds_hooks, admin, workspaces,
        assist,
    ):
        app.include_router(module.router, prefix=API_PREFIX)
    return app


app = create_app()
