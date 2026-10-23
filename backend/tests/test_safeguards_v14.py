"""Warning shares and the safeguard rule of contract v1.4 (CONTRACT.md §4.6, §6, §7, §12.1).

On the whole seed, the routine "stable" safeguard appears only on
rows that are Strong or Moderate overall, and every warning on an aggregated
row says how many of the aggregated rows carry it.
"""

from __future__ import annotations

from conftest import record
from parity import lens_of

from app.main import API_PREFIX
from app.services import presentation
from app.services.catalog import is_top_level_condition

STABLE = {"strong", "moderate"}
AGGREGATE_ONLY = {"conservative_rollup_p20"}


def served_rows(dataset):
    """Every depth-1 condition, block, and chapter at the all-population lens, for every target."""
    concepts = [
        concept for concept in dataset.atlas.concepts if concept.level < 2 or is_top_level_condition(concept)
    ]
    for model in dataset.registry.models:
        for variant in model.use_cases:
            service = dataset.metrics(model.model_version, variant.use_case)
            for concept in concepts:
                row = service.row(concept.concept_id)
                if row is not None:
                    yield model.model_version, variant.use_case, row


def test_stable_safeguard_only_on_strong_or_moderate_rows(live_dataset):
    checked = 0
    for model_version, use_case, row in served_rows(live_dataset):
        served = presentation.metric_row(row, model_version=model_version, use_case=use_case)
        ids = [item["id"] for item in served["safeguards"]]
        where = f"{model_version} / {use_case} / {row.concept_id}"
        assert ids, f"{where}: no safeguard"
        if "standard-monitoring" in ids:
            assert served["status"]["overall"] in STABLE, f"{where}: stable on {served['status']['overall']}"
            assert ids == ["standard-monitoring"], where
        checked += 1
    record("v1.4 safeguard rows checked (10 targets × conditions and rollups)", checked)
    assert checked > 20_000


def test_every_rollup_warning_has_a_share(live_dataset):
    rollups = 0
    for model_version, use_case, row in served_rows(live_dataset):
        warnings = presentation.metric_row(row, model_version=model_version, use_case=use_case)["warnings"]
        if row.provenance.source == "rollup" and row.warning_total:
            rollups += 1
            for warning in warnings:
                if warning["code"] in AGGREGATE_ONLY:
                    assert "share" not in warning
                else:
                    share = warning["share"]
                    assert share["total"] == row.provenance.rollup.child_count
                    assert 0 <= share["count"] <= share["total"]
                    assert share["count"] >= 1 or warning["code"] == "out_of_scope_group"
        else:
            assert all("share" not in warning for warning in warnings), row.concept_id
    assert rollups > 2_000


def test_lens_fallback_warnings_have_a_share(reference, fallback_dataset):
    aggregated = 0
    for variant in reference["fallback_variants"]:
        service = fallback_dataset.metrics(variant["model_version"], variant["use_case"])
        for case in variant["cases"]:
            row = service.row(case["concept_id"], lens_of(case["lens"]))
            if row is None or row.provenance.source != "condition" or not row.provenance.lens_fallback:
                continue
            warnings = presentation.metric_row(row, model_version=variant["model_version"], use_case=variant["use_case"])["warnings"]
            if row.warning_total:
                aggregated += 1
                assert all(warning["share"]["total"] == row.warning_total for warning in warnings)
            else:  # a single lens row is served as stored (§7)
                assert all("share" not in warning for warning in warnings)
    assert aggregated > 50


def test_sepsis_block_no_longer_reads_stable(client):
    """The critique's example (2026-10-10): Strong performance, no evidence, one of two conditions without data."""
    body = client.get(
        f"{API_PREFIX}/metrics/concepts/BLK-01-BlockL1-1G4",
        params={"model": "SynGPT-2.0", "use_case": "Discharge letter generation"},
    ).json()["metrics"]
    assert body["status"]["overall"] == "no_data"  # not_validated before v1.11 (D5)
    assert body["safeguards"] == [{"id": "evidence-missing", "priority": "Important"}]
    warnings = {warning["code"]: warning for warning in body["warnings"]}
    assert warnings["no_performance_data"]["share"] == {"count": 1, "total": 2}
