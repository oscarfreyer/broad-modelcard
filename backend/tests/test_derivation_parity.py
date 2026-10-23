"""Derivation parity with the reference client at v0.2.0-alpha.1 (gate A1).

Expected values come from tests/reference/generate_reference.mjs, which runs
the tagged client code (tableDataset.js, grading.js, overallTier.js, and the
DetailsPanel.jsx warning and safeguard rules) on the same JSON tables.
"""

from __future__ import annotations

import pytest
from conftest import record
from parity import MismatchLog, floats_equal, lens_of, row_mismatches

from app.schema.contract import CDSS_USE_CASES
from app.services.jsnum import locale_sort_key

DATASETS = ("live", "fallback")
REFERENCE_KEYS = {"live": "variants", "fallback": "fallback_variants"}


@pytest.fixture(scope="session")
def datasets(live_dataset, fallback_dataset):
    return {"live": live_dataset, "fallback": fallback_dataset}


def test_reference_covers_the_gate_sample(reference):
    variants = reference["variants"]
    use_cases = {variant["use_case"] for variant in variants}
    assert use_cases & CDSS_USE_CASES and use_cases - CDSS_USE_CASES
    assert any(variant["multimorbidity"] for variant in variants)
    concept_cases = sum(len(variant["cases"]) for variant in variants)
    assert concept_cases >= 500
    for variant in variants:
        rollup_ids = {case["concept_id"] for case in variant["rollups"]}
        assert len(rollup_ids) == 21 + 225, "every chapter and block is checked"


def test_prevalence_matches_reference(reference, live_dataset):
    log = MismatchLog()
    for concept_id, expected in reference["prevalence"].items():
        actual = live_dataset.atlas.by_id[concept_id].prevalence_score
        log.add(concept_id, [] if floats_equal(expected, actual) else [f"expected {expected}, got {actual}"])
    record("prevalence scores", log.compared)
    log.assert_clean()


def test_display_prevalence_matches_reference(reference, live_dataset):
    actual = live_dataset.atlas.display_prevalence()
    log = MismatchLog()
    for concept_id, expected in reference["display_prevalence"].items():
        got = actual[concept_id]
        log.add(concept_id, [] if floats_equal(expected, got) else [f"expected {expected}, got {got}"])
    record("display prevalence (blocks, chapters)", log.compared)
    log.assert_clean()


@pytest.mark.parametrize("name", ["preferred_terms", "concept_ids"])
def test_collation_matches_locale_compare(reference, live_dataset, name):
    """``localeCompare`` sorts: preferred terms order candidates, ids form combination keys."""
    expected = reference["collation"][name]
    field = "pt" if name == "preferred_terms" else "concept_id"
    source_order = list(dict.fromkeys(getattr(concept, field) for concept in live_dataset.atlas.concepts))
    actual = sorted(source_order, key=locale_sort_key)
    differences = [(index, want, got) for index, (want, got) in enumerate(zip(expected, actual)) if want != got]
    record(f"collation ({name})", len(expected))
    assert not differences, f"{len(differences)} positions differ, first: {differences[:5]}"


@pytest.mark.parametrize("which", DATASETS)
def test_rollups_match_reference(reference, datasets, which):
    log = MismatchLog()
    for variant in reference[REFERENCE_KEYS[which]]:
        service = datasets[which].metrics(variant["model_version"], variant["use_case"])
        for case in variant["rollups"]:
            actual = service.row(case["concept_id"], lens_of(case["lens"]))
            where = f'{variant["model_version"]}/{variant["use_case"]} {case["concept_id"]} {case["lens"]}'
            log.add(where, row_mismatches(case["row"], actual, variant["use_case"]))
    record(f"rollups, all chapters and blocks ({which})", log.compared)
    log.assert_clean()


@pytest.mark.parametrize("which", DATASETS)
def test_concept_sample_matches_reference(reference, datasets, which):
    log = MismatchLog()
    for variant in reference[REFERENCE_KEYS[which]]:
        service = datasets[which].metrics(variant["model_version"], variant["use_case"])
        for case in variant["cases"]:
            actual = service.row(case["concept_id"], lens_of(case["lens"]))
            where = f'{variant["model_version"]}/{variant["use_case"]} {case["concept_id"]} {case["lens"]}'
            log.add(where, row_mismatches(case["row"], actual, variant["use_case"]))
    record(f"concept/filter sample ({which})", log.compared)
    log.assert_clean()


def test_fallback_paths_are_exercised(reference, fallback_dataset):
    """The reduced tables must actually trigger the §7 aggregation and empty paths."""
    aggregated = empty = 0
    for variant in reference["fallback_variants"]:
        service = fallback_dataset.metrics(variant["model_version"], variant["use_case"])
        for case in variant["cases"]:
            row = service.row(case["concept_id"], lens_of(case["lens"]))
            if row is None:
                empty += 1
            elif row.provenance.lens_fallback:
                aggregated += 1
    assert aggregated > 50 and empty > 10


@pytest.mark.parametrize("which", DATASETS)
def test_multimorbidity_matches_reference(reference, datasets, which):
    candidates_log, rows_log, display_log = MismatchLog(), MismatchLog(), MismatchLog()
    for variant in reference[REFERENCE_KEYS[which]]:
        service = datasets[which].multimorbidity(variant["model_version"], variant["use_case"])
        assert service.has_data == variant["has_multimorbidity_data"]
        if not variant["multimorbidity"]:
            assert service.candidate_ids() == []
            continue
        prefix = f'{variant["model_version"]}/{variant["use_case"]}'
        for path in variant["multimorbidity"]["paths"]:
            selection = path["selection"]
            got = service.candidate_ids(selection)
            candidates_log.add(
                f"{prefix} candidates {selection}",
                [] if got == path["candidates"] else [f'expected {path["candidates"]}, got {got}'],
            )
            for case in path["rows"]:
                actual = service.row(selection, lens_of(case["lens"]))
                rows_log.add(f"{prefix} row {selection} {case['lens']}", row_mismatches(case["row"], actual, variant["use_case"]))
            for case in path["display"]:
                actual = service.display_row(case["concept_id"], selection, lens_of(case["lens"]), case["view"])
                display_log.add(
                    f'{prefix} display {selection} {case["concept_id"]} {case["view"]} {case["lens"]}',
                    row_mismatches(case["row"], actual, variant["use_case"]),
                )
    record(f"multimorbidity candidate lists ({which})", candidates_log.compared)
    record(f"multimorbidity combination rows ({which})", rows_log.compared)
    record(f"multimorbidity display rows ({which})", display_log.compared)
    candidates_log.assert_clean()
    rows_log.assert_clean()
    display_log.assert_clean()
