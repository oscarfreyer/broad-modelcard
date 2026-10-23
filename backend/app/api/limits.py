"""Request body size limits: 413 ``upload_too_large`` before a large body is read.

A request to ``createUpload`` (or, since v1.7, ``createRecordsUpload``,
``proposeRecords``, and ``lookup``) whose ``Content-Length`` exceeds the limit
is answered at once; a body without a length (chunked) is counted while it is
read and stops at the limit. Every other request with a body (publish,
rollback, submissions, the instance, ...) is held to ``MAX_OTHER_BODY_BYTES``:
its valid bodies are a few hundred bytes.
"""

from __future__ import annotations

from typing import Callable

from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .problems import ApiError, problem_response

# Multipart framing and the form fields around the file.
FORM_OVERHEAD = 64 * 1024
KB = 1024
MB = 1024 * KB
MAX_OTHER_BODY_BYTES = 1 * MB
BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _size(limit: int) -> str:
    return f"{limit // MB} MB" if limit >= MB else f"{limit // KB} KB"


class UploadSizeLimit:
    """``path_suffix`` names the POST requests it limits; without one it limits
    every request with a body whose path ends in none of ``except_suffixes``
    (those have their own, larger limits)."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        path_suffix: str | None,
        limit: Callable[[], int],
        noun: str = "The file is",
        overhead: int = FORM_OVERHEAD,
        except_suffixes: tuple[str, ...] = (),
    ):
        self.app = app
        self.path_suffix = path_suffix
        self.limit = limit
        self.noun = noun
        self.overhead = overhead
        self.except_suffixes = except_suffixes

    def applies(self, scope: Scope) -> bool:
        if scope["type"] != "http":
            return False
        if self.path_suffix is not None:
            return scope["method"] == "POST" and scope["path"].endswith(self.path_suffix)
        return scope["method"] in BODY_METHODS and not scope["path"].endswith(self.except_suffixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.applies(scope):
            await self.app(scope, receive, send)
            return
        limit = self.limit() + self.overhead
        detail = f"{self.noun} larger than {_size(self.limit())}, the most this tool accepts."
        for name, value in scope.get("headers", ()):
            if name == b"content-length" and value.isdigit() and int(value) > limit:
                await problem_response(ApiError(413, "upload_too_large", detail))(scope, receive, send)
                return
        received = 0

        async def counted() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # FastAPI passes HTTPExceptions raised while reading the form through.
                    raise HTTPException(413, detail)
            return message

        await self.app(scope, counted, send)
