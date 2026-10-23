"""Helpers for the admin API tests: templates, uploads, and waiting for checks."""

from __future__ import annotations

import csv
import io

from app.main import API_PREFIX

ADMIN = f"{API_PREFIX}/admin"
TINY_TARGET = {"model_version": "Tiny-1", "use_case": "CDSS"}


def admin_service(client):
    return client.app.state.api.admin


def template(client, kind: str, file_format: str = "csv", **params) -> bytes:
    response = client.get(f"{ADMIN}/templates/{kind}.{file_format}", params=params)
    assert response.status_code == 200, response.text[:300]
    return response.content


def post_upload(client, kind: str, content: bytes, filename: str = "upload.csv", **form):
    data = {"kind": kind, **{key: str(value).lower() if isinstance(value, bool) else value for key, value in form.items()}}
    return client.post(f"{ADMIN}/uploads", data=data, files={"file": (filename, content, "application/octet-stream")})


def wait(client, upload_id: str) -> dict:
    admin_service(client).wait_for_checks()
    response = client.get(f"{ADMIN}/uploads/{upload_id}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] != "checking"
    return body


def upload_and_wait(client, kind: str, content: bytes, filename: str = "upload.csv", **form) -> dict:
    response = post_upload(client, kind, content, filename, **form)
    assert response.status_code == 202, response.text[:500]
    return wait(client, response.json()["upload_id"])


def read_csv(content: bytes) -> tuple[list[str], list[list[str]], list[str]]:
    """(header, rows, comment lines) of a template or annotated CSV."""
    lines = list(csv.reader(io.StringIO(content.decode("utf-8-sig"))))
    comments = [line[0] for line in lines if line and line[0].startswith("#")]
    body = [line for line in lines if line and not line[0].startswith("#")]
    return body[0], body[1:], comments


def write_csv(header: list[str], rows: list[list], comments: list[str] = ()) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerows([[line] for line in comments])
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue().encode("utf-8")


def errors_by_code(upload: dict) -> dict[str, dict]:
    return {group["code"]: group for group in (upload["report"] or {}).get("errors", [])}


def notes_by_code(upload: dict) -> dict[str, dict]:
    return {group["code"]: group for group in (upload["report"] or {}).get("notes", [])}
