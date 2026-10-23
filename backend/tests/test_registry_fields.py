"""Configurations and lineage (contract v1.14, CONTRACT.md §28).

Every new registry field is optional: a card's configuration record, what its
figures measure, the developer's data-protection declarations, an entry's
``replaces``, and the instance's data-protection note. Files without the
columns stay valid (test_registry_entries.py), reads without the values are
byte for byte as before (test_registry_v113_bytes.py), and every new rule
rejects with row, column, and a plain fix. A changed configuration moves the
card's last update (§17). Runs on private copies of the tiny store; synthetic
data only, fictional names.
"""

from __future__ import annotations

import pytest
from admin_helpers import ADMIN, TINY_TARGET, errors_by_code, read_csv, template, upload_and_wait, write_csv
from test_admin_rules import FIRST_DATA_ROW, check_marked, check_rejected
from test_local_roles import NEW_SYSTEM, open_submission, stage_records

from app.main import API_PREFIX

SHA = "3f" * 32
CONFIGURATION = {
    "Configuration ID": "cfg-2026-09",
    "Configuration date": "2026-09-15",
    "Prompt summary": "Answers clinician questions with sources; refuses dosing advice (fictional).",
    "Prompt SHA-256": SHA.upper(),  # stored and served in lower case
    "Retrieval": "Local guidelines (fictional)",
    "Tools": "guideline_search; drug_lookup; guideline_search",
    "Sampling temperature": "0.2",
    "Sampling top-p": "0.9",
    "Max output tokens": "800",
    "Fine-tuning": "None",
    "Performance measure": "Top-3 diagnostic accuracy",
    "Reference standard": "Final diagnosis at discharge (fictional)",
    "Declared data use": "Processes the question and the visible record extract; nothing is used for training (fictional).",
    "Declared data location": "EU data centre (fictional)",
    "Declared retention": "30 days (fictional)",
    "Declared privacy contact": "privacy@tinyworks.example",
}
SERVED_CONFIGURATION = {
    "configuration_id": "cfg-2026-09",
    "configuration_date": "2026-09-15",
    "prompt_summary": "Answers clinician questions with sources; refuses dosing advice (fictional).",
    "prompt_sha256": SHA,
    "retrieval": "Local guidelines (fictional)",
    "tools": ["guideline_search", "drug_lookup"],
    "sampling_temperature": 0.2,
    "sampling_top_p": 0.9,
    "sampling_max_output_tokens": 800,
    "fine_tuning": "None",
}
TINY = "Tiny-1|CDSS"
CARE = "TinyCare-1|Triage"


def models(client) -> dict:
    response = client.get(f"{API_PREFIX}/models")
    assert response.status_code == 200, response.text
    return response.json()


def catalogue(client, **params) -> dict:
    response = client.get(f"{API_PREFIX}/catalogue", params=params)
    assert response.status_code == 200, response.text
    return {tile["card_id"]: tile for tile in response.json()["tiles"]}


def registry_csv(client, edit) -> bytes:
    header, rows, comments = read_csv(template(client, "models", filled="true"))
    edit(header, rows)
    return write_csv(header, rows, comments)


def set_fields(values: dict, row: int = 0):
    def edit(header, rows):
        for column, value in values.items():
            rows[row][header.index(column)] = value

    return edit


def publish(client, upload: dict) -> int:
    assert upload["status"] == "valid", upload["report"]
    response = client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": False})
    assert response.status_code == 200, response.text
    return response.json()["version_id"]


def add_entry(model_version: str, use_case: str = "Triage", **cells):
    """An edit that appends one AI system (one function) to the filled registry template."""

    def edit(header, rows):
        row = [None] * len(header)
        values = {
            "Model version": model_version, "Display name": model_version, "Status": "ACTIVE", "Function": use_case,
            "Default function": "Yes", "Default model": "No", **cells,
        }
        for column, value in values.items():
            row[header.index(column)] = value
        rows.append(row)

    return edit


def both(*edits):
    def edit(header, rows):
        for one in edits:
            one(header, rows)

    return edit


def add_with_metrics(client, edit, *cards) -> dict:
    """Stage a registry upload that names new cards, publish their metrics, and return the re-checked upload."""
    registry = upload_and_wait(client, "models", registry_csv(client, edit))
    for model_version, use_case in cards:
        metrics = upload_and_wait(
            client, "metrics", template(client, "metrics", filled="true", **TINY_TARGET), model_version=model_version, use_case=use_case
        )
        publish(client, metrics)
    client.app.state.api.admin.wait_for_checks()
    return client.get(f"{ADMIN}/uploads/{registry['upload_id']}").json()


# ------------------------------------------------------------ configuration

def test_configuration_fields_publish_and_are_served(admin_client):
    client = admin_client
    upload = upload_and_wait(client, "models", registry_csv(client, set_fields({**CONFIGURATION, "Function category": "Patient communication"})))
    changes = client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert changes["rows"]["changed"] == 1 and changes["rows"]["samples"]["changed"][0]["name"] == "Tiny-1 / CDSS"
    publish(client, upload)

    use_case = models(client)["models"][0]["use_cases"][0]
    assert use_case["function_category"] == "patient_communication"
    assert use_case["configuration"] == SERVED_CONFIGURATION
    assert use_case["performance_measure"] == "Top-3 diagnostic accuracy"
    assert use_case["reference_standard"] == "Final diagnosis at discharge (fictional)"
    # The data-protection declarations join the four of v1.5 (shown as declared, never verified).
    assert use_case["declarations"] == {
        "declared_intended_purpose": None,
        "declared_regulatory_status": None,
        "declared_contact": None,
        "declared_documentation_url": None,
        "declared_data_use": CONFIGURATION["Declared data use"],
        "declared_data_location": "EU data centre (fictional)",
        "declared_retention": "30 days (fictional)",
        "declared_privacy_contact": "privacy@tinyworks.example",
    }
    tile = catalogue(client)[TINY]
    assert tile["configuration"] == SERVED_CONFIGURATION and tile["performance_measure"] == use_case["performance_measure"]
    assert tile["declarations"] == use_case["declarations"] and tile["function_category"] == "patient_communication"

    # The filled template carries every field, and uploading it unchanged changes nothing, in both formats.
    header, rows, _ = read_csv(template(client, "models", filled="true"))
    assert rows[0][header.index("Tools")] == "guideline_search; drug_lookup"
    assert rows[0][header.index("Prompt SHA-256")] == SHA
    for file_format in ("csv", "xlsx"):
        filled = template(client, "models", file_format, filled="true")
        again = upload_and_wait(client, "models", filled, f"registry.{file_format}", replace_staged=True)
        assert again["status"] == "valid", again["report"]
        summary = client.get(f"{ADMIN}/uploads/{again['upload_id']}/changes").json()
        assert summary["rows"]["changed"] == 0 and summary["rows"]["unchanged"] == 1, file_format


def test_a_configuration_with_only_some_fields_sends_every_field(admin_client):
    client = admin_client
    publish(client, upload_and_wait(client, "models", registry_csv(client, set_fields({"Configuration ID": "cfg-1", "Function category": "Administrative"}))))
    use_case = models(client)["models"][0]["use_cases"][0]
    assert use_case["configuration"] == {**{key: None for key in SERVED_CONFIGURATION}, "tools": [], "configuration_id": "cfg-1"}
    assert use_case["function_category"] == "administrative"
    # Without a measure or data-protection declaration, those keys stay out.
    assert "performance_measure" not in use_case and "reference_standard" not in use_case and use_case["declarations"] is None


CELL_CASES = [
    ("invalid_configuration_id", "Configuration ID", "cfg 2026/09", "is not a label"),
    ("invalid_configuration_id", "Configuration ID", "x" * 65, "is not a label"),
    ("invalid_date", "Configuration date", "2026-09-31", "YYYY-MM-DD"),
    ("invalid_value", "Prompt summary", "x" * 501, "longer than 500"),
    ("invalid_sha256", "Prompt SHA-256", "abc123", "64 characters"),
    ("invalid_value", "Retrieval", "x" * 281, "longer than 280"),
    ("too_many_tools", "Tools", "; ".join(f"tool_{n}" for n in range(11)), "11 tools"),
    ("invalid_value", "Tools", "x" * 61, "longer than 60"),
    ("out_of_range", "Sampling temperature", "2.5", "between 0 and 2"),
    ("out_of_range", "Sampling top-p", "1.2", "between 0 and 1"),
    ("not_a_number", "Sampling top-p", "high", "not a number"),
    ("out_of_range", "Max output tokens", "0", "at least 1"),
    ("not_a_whole_number", "Max output tokens", "12.5", "whole number"),
    ("invalid_value", "Fine-tuning", "x" * 281, "longer than 280"),
    ("invalid_value", "Performance measure", "x" * 201, "longer than 200"),
    ("invalid_value", "Reference standard", "x" * 201, "longer than 200"),
    ("invalid_value", "Declared data use", "x" * 501, "longer than 500"),
    ("invalid_value", "Declared retention", "x" * 201, "longer than 200"),
    ("unknown_function_category", "Function category", "Billing", "Patient communication"),
]


@pytest.mark.parametrize(("code", "column", "value", "problem"), CELL_CASES, ids=[f"{case[0]}-{case[1]}-{case[2][:8]}" for case in CELL_CASES])
def test_invalid_configuration_cells_are_rejected(admin_client, code, column, value, problem):
    upload = upload_and_wait(admin_client, "models", registry_csv(admin_client, set_fields({column: value})))
    check_rejected(admin_client, upload, code, FIRST_DATA_ROW, column, problem)
    check_marked(admin_client, upload["upload_id"], FIRST_DATA_ROW, column)
    assert errors_by_code(upload)[code]["fix"]


def test_a_changed_configuration_id_moves_only_its_cards_last_update(admin_client):
    """§17: the configuration record, the measure, the data-protection declarations, and
    `replaces` are part of the registry signature, so a change moves last_updated."""
    client = admin_client
    registry = add_with_metrics(client, add_entry("TinyCare-1", Kind="Product", **{"Built on": "Tiny-1"}), ("TinyCare-1", "Triage"))
    assert publish(client, registry) == 3
    assert {card: tile["last_updated"]["version"] for card, tile in catalogue(client).items()} == {TINY: 1, CARE: 3}

    staged = upload_and_wait(client, "models", registry_csv(client, set_fields({"Configuration ID": "cfg-2026-10"})))
    tiles = catalogue(client, version=f"staged:{staged['upload_id']}")
    assert tiles[TINY]["staged_change"] is True and tiles[CARE]["staged_change"] is False
    assert publish(client, staged) == 4
    assert {card: tile["last_updated"]["version"] for card, tile in catalogue(client).items()} == {TINY: 4, CARE: 3}

    for version, cells in enumerate(
        ({"Performance measure": "AUROC"}, {"Declared retention": "90 days (fictional)"}, {"Max output tokens": "512"}), start=5
    ):
        assert publish(client, upload_and_wait(client, "models", registry_csv(client, set_fields(cells)))) == version
        assert {card: tile["last_updated"]["version"] for card, tile in catalogue(client).items()} == {TINY: version, CARE: 3}, cells


# ----------------------------------------------------------------- lineage

def test_replaces_is_served_with_the_derived_replaced_by(admin_client):
    client = admin_client
    edit = both(add_entry("Tiny-0", use_case="CDSS"), set_fields({"Replaces": "Tiny-0"}))
    registry = add_with_metrics(client, edit, ("Tiny-0", "CDSS"))
    changes = client.get(f"{ADMIN}/uploads/{registry['upload_id']}/changes").json()
    assert changes["models"]["added"] == ["Tiny-0"] and changes["models"]["changed"] == ["Tiny-1"]
    version = publish(client, registry)

    by_version = {model["model_version"]: model for model in models(client)["models"]}
    assert by_version["Tiny-1"]["replaces"] == "Tiny-0" and "replaced_by" not in by_version["Tiny-1"]
    assert by_version["Tiny-0"]["replaced_by"] == ["Tiny-1"] and "replaces" not in by_version["Tiny-0"]
    tiles = catalogue(client)
    assert tiles[TINY]["system"]["replaces"] == "Tiny-0" and tiles["Tiny-0|CDSS"]["system"]["replaced_by"] == ["Tiny-1"]
    # Gaining a successor is not a change of the predecessor's own entry.
    assert tiles[TINY]["last_updated"]["version"] == version
    header, rows, _ = read_csv(template(client, "models", filled="true"))
    assert [row[header.index("Replaces")] for row in rows] == ["Tiny-0", ""]


@pytest.mark.parametrize(
    ("cells", "code", "problem"),
    [
        ({"Replaces": "Tiny-1"}, "replaces_self", "cannot replace itself"),
        ({"Replaces": "Tiny-9"}, "unknown_replaces", "Tiny-9 is not an AI system in this file"),
    ],
)
def test_replaces_names_another_entry_of_the_file(admin_client, cells, code, problem):
    upload = upload_and_wait(admin_client, "models", registry_csv(admin_client, set_fields(cells)))
    example = check_rejected(admin_client, upload, code, FIRST_DATA_ROW, "Replaces", problem)
    assert example["value"] == cells["Replaces"]
    assert "Replaces" in errors_by_code(upload)[code]["fix"] or "file" in errors_by_code(upload)[code]["fix"]


def test_replaces_must_not_form_a_loop(admin_client):
    edit = both(
        set_fields({"Replaces": "Tiny-0"}),
        add_entry("Tiny-0", use_case="CDSS", Replaces="Tiny-00"),
        add_entry("Tiny-00", use_case="CDSS", Replaces="Tiny-1"),
    )
    upload = upload_and_wait(admin_client, "models", registry_csv(admin_client, edit))
    group = errors_by_code(upload)["replaces_cycle"]
    assert group["count"] == 3 and [example["row"] for example in group["examples"]] == [FIRST_DATA_ROW, FIRST_DATA_ROW + 1, FIRST_DATA_ROW + 2]
    assert "Tiny-1 → Tiny-0 → Tiny-00 → Tiny-1" in group["examples"][0]["problem"]
    assert "oldest" in group["fix"]
    # A chain without a loop is fine (only the missing metrics remain).
    chain = both(set_fields({"Replaces": "Tiny-0"}), add_entry("Tiny-0", use_case="CDSS", Replaces="Tiny-00"), add_entry("Tiny-00", use_case="CDSS"))
    upload = upload_and_wait(admin_client, "models", registry_csv(admin_client, chain), replace_staged=True)
    assert list(errors_by_code(upload)) == ["use_case_without_metrics"]


def test_replaces_is_the_same_on_every_row_of_an_entry(admin_client):
    def second_function(header, rows):
        row = list(rows[0])
        row[header.index("Function")] = "Triage"
        row[header.index("Default function")] = "No"
        row[header.index("Replaces")] = ""
        rows.append(row)

    edit = both(add_entry("Tiny-0", use_case="CDSS"), set_fields({"Replaces": "Tiny-0"}), second_function)
    upload = upload_and_wait(admin_client, "models", registry_csv(admin_client, edit))
    group = errors_by_code(upload)["inconsistent_value"]
    assert any(example["column"] == "Replaces" for example in group["examples"]) and "Replaces" in group["fix"]


def test_a_submission_may_replace_a_published_ai_system(admin_client):
    """A developer submission merges its entry into the live registry (§26.3), so `replaces`
    may name a published AI system; an unknown one is refused with a plain fix."""
    client = admin_client
    sid = open_submission(client)["submission_id"]
    good = stage_records(client, "models", [{**NEW_SYSTEM, "replaces": "Tiny-1", "configuration_id": "cfg-dev-1"}], submission_id=sid)
    assert list(errors_by_code(good)) == ["use_case_without_metrics"]  # its metrics join the submission later
    bad = stage_records(client, "models", [{**NEW_SYSTEM, "replaces": "Tiny-7"}], submission_id=sid, replace_staged=True)
    problem = errors_by_code(bad)["unknown_replaces"]["examples"][0]["problem"]
    assert problem == "Tiny-7 is not an AI system in this file or the published AI systems."


# ---------------------------------------------------------------- instance

def test_the_instance_data_protection_note(admin_client):
    client = admin_client
    profile = {"kind": "hospital", "organisation": "Tiny Hospital (fictional)", "maintained_by": "AI office (fictional)", "contact": None}
    assert "data_protection_note" not in client.get(f"{API_PREFIX}/meta").json()["instance"]
    note = "Patient data stays on hospital servers; ask the data protection office (fictional)."
    response = client.put(f"{ADMIN}/instance", json={**profile, "data_protection_note": f"  {note} "})
    assert response.status_code == 200 and response.json()["data_protection_note"] == note
    assert client.get(f"{API_PREFIX}/meta").json()["instance"] == {**profile, "data_protection_note": note}
    assert client.put(f"{ADMIN}/instance", json={**profile, "data_protection_note": "x" * 501}).status_code == 422
    # Leaving it out clears it (the PUT sets the whole profile).
    assert client.put(f"{ADMIN}/instance", json=profile).status_code == 200
    assert client.get(f"{API_PREFIX}/meta").json()["instance"] == profile
