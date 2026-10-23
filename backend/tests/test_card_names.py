"""Card names (CONTRACT.md §11.1): a model version or function must not contain "|" or ",".

Card ids join a model version and a function with "|" (``card_id``), and the
comparison lists card ids with "," (§25), so a name with either character
could not be compared. Every place that accepts such a name refuses it: a
registry upload (file or records, also inside a developer submission) with the
blocking error ``separator_in_name``, and opening a submission with 422. The
names of the seed and of the demo pack are unaffected. Synthetic data only.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest
from admin_helpers import ADMIN, errors_by_code, read_csv, template, upload_and_wait, wait, write_csv
from test_admin_rules import FIRST_DATA_ROW, check_marked, check_rejected

from app.main import API_PREFIX
from app.schema.contract import CARD_NAME_RESERVED, reserved_in_name

DEMO = Path(__file__).resolve().parents[1] / "demo"
FIX = "Use a name without | or ,"


def registry_with(client, column: str, value: str) -> bytes:
    header, rows, comments = read_csv(template(client, "models", filled="true"))
    rows[0][header.index(column)] = value
    return write_csv(header, rows, comments)


@pytest.mark.parametrize(
    ("column", "value"),
    [("Model version", "Tiny|1"), ("Model version", "Tiny,1"), ("Function", "CDSS|Letters"), ("Function", "CDSS, triage"), ("Function", "A|B,C")],
)
def test_a_registry_upload_refuses_a_separator_in_a_name(admin_client, column, value):
    upload = upload_and_wait(admin_client, "models", registry_with(admin_client, column, value))
    example = check_rejected(admin_client, upload, "separator_in_name", FIRST_DATA_ROW, column, value)
    assert example["value"] == value
    group = errors_by_code(upload)["separator_in_name"]
    assert group["fix"].startswith(FIX) and "|" in group["message"] and "," in group["message"]
    check_marked(admin_client, upload["upload_id"], FIRST_DATA_ROW, column)
    if "|" in value and "," in value:
        assert "| and ," in example["problem"]


def test_a_name_without_separators_stays_valid(admin_client):
    upload = upload_and_wait(admin_client, "models", registry_with(admin_client, "Display name", "Tiny | One, a model"))
    assert upload["status"] == "valid", upload["report"]
    assert "separator_in_name" not in errors_by_code(upload), "only the model version and the function are card names"


def test_a_submission_refuses_a_separator_in_its_names(admin_client):
    client = admin_client
    for name in ("Tiny|2", "Tiny,2"):
        refused = client.post(f"{ADMIN}/submissions", json={"developer_name": "Dev", "model_version": name})
        assert refused.status_code == 422 and refused.json()["code"] == "invalid_parameter"
        assert FIX in refused.json()["detail"]
    submission = client.post(f"{ADMIN}/submissions", json={"developer_name": "Dev", "model_version": "Tiny-2"}).json()
    record = {"model_version": "Tiny-2", "display_name": "Tiny-2 (fictional)", "status": "EXPERIMENTAL", "use_case": "CDSS, triage", "kind": "Model"}
    response = client.post(f"{ADMIN}/uploads/records", json={"kind": "models", "records": [record], "submission_id": submission["submission_id"]})
    assert response.status_code == 202, response.text
    upload = wait(client, response.json()["upload_id"])
    assert upload["status"] == "invalid"
    example = errors_by_code(upload)["separator_in_name"]["examples"][0]
    assert example["column"] == "Function" and example["record"] == 0


def test_reserved_in_name():
    assert CARD_NAME_RESERVED == ("|", ",")
    assert reserved_in_name("SynGPT-2.0") == () and reserved_in_name("a|b,c") == ("|", ",") and reserved_in_name("x,y") == (",",)


# ------------------------------------------------- seed and demo pack names

def _card_names(models: list[dict]) -> set[str]:
    return {name for model in models for name in (model["model_version"], *(entry["use_case"] for entry in model["use_cases"]))}


def test_seed_names_have_no_separators(client):
    names = _card_names(client.get(f"{API_PREFIX}/models").json()["models"])
    assert names and not [name for name in names if reserved_in_name(name)]


def _registry_files() -> list[Path]:
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    files = [entry["file"] for entry in manifest["files"] if entry.get("kind") == "models"]
    files += [part["file"] for entry in manifest["files"] for part in entry.get("parts", ()) if part["kind"] == "models"]
    return [DEMO / file for file in files]


def test_demo_pack_names_have_no_separators():
    names: set[str] = set()
    files = _registry_files()
    assert len(files) == 5  # v1, v4, v8 and v13 (contract v1.14), and the Tidewell submission
    for path in files:
        with open(path, newline="", encoding="utf-8") as handle:
            rows = [row for row in csv.reader(handle) if row and not row[0].startswith("#") and not row[0].startswith('"#')]
        header = rows[0]
        function = header.index("Function") if "Function" in header else header.index("Use case")
        names |= {row[header.index("Model version")] for row in rows[1:]} | {row[function] for row in rows[1:]}
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        for target in [entry.get("target")] + [part.get("target") for part in entry.get("parts", ())]:
            if target:
                names |= {target.get("model_version") or "", target.get("use_case") or ""} - {""}
    assert "SkinAI-1.0" in names and "Skin lesion CDSS" in names
    assert not [name for name in names if reserved_in_name(name)]
