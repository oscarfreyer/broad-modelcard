"""Gate A3 on the full store: round trips of every template,
the 216,000-row metrics check (time, memory, progress), a change summary with
status shifts and removals, staged reads, and publish/rollback exactness.

Each test works on its own copy of the imported store, in which the two cards
uploaded whole have synthetic evidence for every row with performance
(``evidence_db``, versions 2 and 3): since contract v1.11 an upload rejects
performance without evidence. Marked slow.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from admin_helpers import ADMIN, read_csv, template, upload_and_wait, write_csv
from conftest import copy_store, local_client, record_budget

from app.main import API_PREFIX, create_app

pytestmark = pytest.mark.slow

TARGET = {"model_version": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
QUERY = {"model": TARGET["model_version"], "use_case": TARGET["use_case"]}
OTHER = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}
CHECK_BUDGET_S = 30.0


@pytest.fixture
def full_store(evidence_db, tmp_path) -> Path:
    return copy_store(evidence_db, tmp_path / "store.sqlite")


@pytest.fixture
def full_client(full_store):
    with local_client(create_app(full_store)) as client:
        yield client


def get(client, path, **params):
    response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, response.text[:300]
    return response


@pytest.mark.parametrize("file_format", ["csv", "xlsx"])
@pytest.mark.parametrize(("kind", "params"), [("models", {}), ("prevalence", {}), ("multimorbidity", TARGET)])
def test_templates_round_trip_on_the_full_store(full_client, kind, params, file_format):
    content = template(full_client, kind, file_format, filled="true", **params)
    upload = upload_and_wait(full_client, kind, content, f"{kind}.{file_format}", **params)
    assert upload["status"] == "valid", upload["report"]
    summary = full_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert summary["rows"]["changed"] == summary["rows"]["added"] == summary["rows"]["removed"] == 0
    assert summary["rows"]["unchanged"] == upload["report"]["row_count"]
    assert summary["status_shifts"] == []


@pytest.mark.parametrize("file_format", ["csv", "xlsx"])
def test_full_metrics_file_is_checked_within_budget(full_client, full_store, tmp_path, file_format):
    """Round trip of 216,000 rows, measured in a fresh process (time, peak memory, progress)."""
    content = template(full_client, "metrics", file_format, filled="true", **TARGET)
    file = tmp_path / f"metrics.{file_format}"
    file.write_bytes(content)
    measured_store = copy_store(full_store, tmp_path / "measured.sqlite")
    result = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("measure_upload_check.py")), str(measured_store), str(file), *TARGET.values()],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    measured = json.loads(result.stdout.strip().splitlines()[-1])
    record_budget(
        f"check  metrics upload {file_format.upper():4}  216,000 rows  {measured['check_s']:5.1f} s "
        f"(target < {CHECK_BUDGET_S:.0f} s)  peak RSS {measured['peak_rss_mb']:.0f} MB "
        f"(baseline {measured['baseline_rss_mb']:.0f} MB)  {len(content) / 1e6:.1f} MB file  "
        f"{len(measured['progress'])} progress steps"
    )
    assert measured["status"] == "valid", measured
    assert measured["row_count"] == 216_000
    assert {name: count for name, count in measured["rows"].items() if name != "samples"} == {
        "added": 0, "changed": 0, "removed": 0, "unchanged": 216_000,
    }
    assert measured["check_s"] < CHECK_BUDGET_S
    steps = measured["progress"]
    assert len(steps) >= 3 and steps == sorted(steps) and any(0 < step < 1 for step in steps)


def edit_metrics(client, edit) -> bytes:
    header, rows, comments = read_csv(template(client, "metrics", "csv", filled="true", **TARGET))
    edit(header, rows)
    return write_csv(header, rows, comments)


def _all_population_rows(header, rows):
    lens = (header.index("Age"), header.index("Sex"), header.index("Ethnicity"))
    return [row for row in rows if tuple(row[i] for i in lens) == ("All ages", "All sexes", "All ethnicities")]


def test_change_summary_on_the_full_store(full_client):
    """Lift 50 weak conditions to strong performance and remove one condition entirely."""
    lifted, removed = [], None

    def edit(header, rows):
        nonlocal removed
        code, perf = header.index("ICD-11 code"), header.index("Performance")
        weak = [row for row in _all_population_rows(header, rows) if row[perf] and float(row[perf]) < 0.7][:50]
        for row in weak:
            row[perf], row[header.index("CI low")], row[header.index("CI high")] = "0.95", "0.93", "0.97"
            lifted.append(row[code])
        removed = next(row[code] for row in rows if row[code] not in lifted)
        rows[:] = [row for row in rows if row[code] != removed]

    upload = upload_and_wait(full_client, "metrics", edit_metrics(full_client, edit), **TARGET)
    assert upload["status"] == "valid", upload["report"]
    summary = full_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    rows = {name: count for name, count in summary["rows"].items() if name != "samples"}
    assert rows == {"added": 0, "changed": 50, "removed": 90, "unchanged": 216_000 - 50 - 90}
    assert {sample["concept_id"] for sample in summary["rows"]["samples"]["changed"]} == set(lifted)
    assert {sample["concept_id"] for sample in summary["rows"]["samples"]["removed"]} == {removed}
    shifts = {(shift["view"], shift["from"], shift["to"]): shift for shift in summary["status_shifts"]}
    assert shifts[("performance", "weak", "strong")]["count"] == 50
    assert set(shifts[("performance", "weak", "strong")]["sample_concept_ids"]) == set(lifted)
    removed_shifts = [shift for key, shift in shifts.items() if key[2] == "no_data" and removed in shift["sample_concept_ids"]]
    assert {shift["view"] for shift in removed_shifts} >= {"performance", "intended_use"}


def served_rows(client, query) -> dict:
    out = {}
    for lens in ({}, {"age": "Age 65+"}, {"sex": "Sex Female", "ethnicity": "Ethnicity Black"}):
        out[("atlas", tuple(lens.items()))] = get(client, "/metrics/map", scope="atlas", **query, **lens).json()["rows"]
        out[("chapter", tuple(lens.items()))] = get(client, "/metrics/map", scope="chapter", chapter_id="CH-05", **query, **lens).json()["rows"]
        for view in ("overall", "performance", "evidence", "intended_use"):
            body = get(client, "/metrics/summary", view=view, **query, **lens).json()
            out[("summary", view, tuple(lens.items()))] = (body["counts"], body["chapters"])
    for concept in ("CH-05", "1C43", "5A11", "1A03.1"):
        out[("concept", concept)] = get(client, f"/metrics/concepts/{concept}", **query).json()["metrics"]
    return out


def test_publish_and_rollback_on_the_full_store(full_client):
    before, other_before = served_rows(full_client, QUERY), served_rows(full_client, OTHER)

    def edit(header, rows):
        perf = header.index("Performance")
        for row in _all_population_rows(header, rows)[:200]:
            if row[perf]:
                row[perf], row[header.index("CI low")], row[header.index("CI high")] = "0.95", "0.93", "0.97"

    upload = upload_and_wait(full_client, "metrics", edit_metrics(full_client, edit), **TARGET)
    staged = served_rows(full_client, {**QUERY, "version": f"staged:{upload['upload_id']}"})
    assert staged != before
    assert served_rows(full_client, QUERY) == before  # live reads are unaffected
    assert full_client.get(f"{ADMIN}/uploads/{upload['upload_id']}").json()["previewed"] is True

    base = full_client.get(f"{ADMIN}/versions").json()[0]["version_id"]  # 3: the evidence_db versions
    entry = full_client.post(f"{ADMIN}/uploads/{upload['upload_id']}/publish", json={"previewed": True}).json()
    assert entry["version_id"] == base + 1
    assert served_rows(full_client, QUERY) == staged
    assert served_rows(full_client, OTHER) == other_before

    rolled = full_client.post(f"{ADMIN}/versions/{base}/rollback", params={"kind": "metrics"}).json()
    assert rolled["version_id"] == base + 2
    assert served_rows(full_client, QUERY) == before
    assert served_rows(full_client, OTHER) == other_before


def test_prevalence_shifts_name_each_model_and_use_case(full_client):
    """A prevalence change shifts statuses for several models; each shift lists them (contract v1.4)."""
    header, rows, comments = read_csv(template(full_client, "prevalence", "csv", filled="true"))
    tier = header.index("Commonness")
    for row in rows:
        row[tier] = "Very rare"
    upload = upload_and_wait(full_client, "prevalence", write_csv(header, rows, comments))
    assert upload["status"] == "valid", upload["report"]
    summary = full_client.get(f"{ADMIN}/uploads/{upload['upload_id']}/changes").json()
    assert summary["status_shifts"]
    models = set()
    for shift in summary["status_shifts"]:
        targets = shift["targets"]
        assert targets and all(target["count"] >= 1 for target in targets)
        assert [target["count"] for target in targets] == sorted((target["count"] for target in targets), reverse=True)
        pooled = {concept for target in targets for concept in target["sample_concept_ids"]}
        assert set(shift["sample_concept_ids"]) <= pooled or max(target["count"] for target in targets) >= 50
        assert max(target["count"] for target in targets) <= shift["count"] <= sum(target["count"] for target in targets)
        models.update((target["model_version"], target["use_case"]) for target in targets)
    assert len(models) >= 2
