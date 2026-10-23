"""Storage parity: the store holds exactly the seed JSON (gate A1).

Strings and integers must be equal, floats within 1e-9. Every metric tuple of
every model/use case, every multimorbidity tuple, every prevalence tier, the
registry, and every concept is compared.
"""

from __future__ import annotations

import json
import math

import pytest
from conftest import SEED_DIR, record

from app import db
from app.importers.legacy_json import CONCEPT_FIELDS
from app.repository import TUPLE_COLUMNS
from app.services.atlas import normalize_prevalence_tier
from app.validation.legacy_tables import seed_relative

FLOAT_POSITIONS = (0, 1, 2, 10)


def _load(name: str):
    return json.loads((SEED_DIR / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def conn(legacy_db):
    connection = db.connect(legacy_db, read_only=True)
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def warning_codes(conn):
    return {set_id: json.loads(codes) for set_id, codes in conn.execute("SELECT warning_set_id, codes_json FROM warning_sets")}


@pytest.fixture(scope="module")
def registry():
    return _load("model-registry.json")


def _set_id(conn, kind: str, source: str) -> int:
    row = conn.execute(
        "SELECT set_id FROM content_sets JOIN version_content_sets USING (set_id) "
        "WHERE version_id = 1 AND kind = ? AND source = ?",
        (kind, f"legacy_json:{source}"),
    ).fetchone()
    assert row is not None, f"no {kind} set for {source}"
    return row[0]


def _tuple_differences(expected: list, stored: tuple, warning_codes: dict) -> list[str]:
    problems = []
    for position, want in enumerate(expected[:12]):
        got = stored[position]
        if position in FLOAT_POSITIONS:
            same = (want is None and got is None) or (
                want is not None and got is not None and math.isfinite(got) and abs(want - got) <= 1e-9
            )
        elif position == 9:  # in_intended_use: JSON 0/1/bool, stored 0/1
            same = got == (1 if want else 0)
        else:
            same = want == got and type(want) is type(got)
        if not same:
            problems.append(f"field {position}: {want!r} != {got!r}")
    if expected[12] != warning_codes[stored[12]]:
        problems.append(f"warnings: {expected[12]!r} != {warning_codes[stored[12]]!r}")
    return problems


def _assert_no_problems(problems: list[str], compared: int) -> None:
    assert not problems, f"{len(problems)} of {compared} differ; first: {problems[:10]}"


def test_version_one_contains_every_source(conn, registry):
    kinds = dict(
        conn.execute(
            "SELECT kind, COUNT(*) FROM content_sets JOIN version_content_sets USING (set_id) "
            "WHERE version_id = 1 GROUP BY kind"
        ).fetchall()
    )
    variants = [variant for model in registry["models"] for variant in model["use_case_variants"]]
    assert kinds == {
        "models": 1,
        "prevalence": 1,
        "metrics": len(variants),
        "multimorbidity": sum(1 for variant in variants if variant.get("multimorbidity_metrics_file")),
    }
    assert conn.execute("SELECT version_id, kind FROM dataset_versions").fetchall() == [(1, None)]


def test_concepts_match(conn):
    atlas = _load("atlas-base.json")
    columns = [column if column != "group" else '"group"' for column in CONCEPT_FIELDS.values()]
    stored = {
        row[0]: dict(zip(CONCEPT_FIELDS, row))
        for row in conn.execute(f"SELECT {', '.join(columns)} FROM concepts ORDER BY concept_key")
    }
    problems = []
    for position, concept in enumerate(atlas["concepts"]):
        row = stored.get(concept["concept_id"])
        if row is None:
            problems.append(f"missing {concept['concept_id']}")
            continue
        for field in CONCEPT_FIELDS:
            want = concept.get(field)
            got = row[field]
            if field == "is_high_depth" and want is not None:
                want = int(want)
            if want != got:
                problems.append(f"{concept['concept_id']}.{field}: {want!r} != {got!r}")
    assert len(stored) == len(atlas["concepts"])
    order = [row[0] for row in conn.execute("SELECT concept_id FROM concepts ORDER BY concept_key")]
    assert order == [concept["concept_id"] for concept in atlas["concepts"]]
    top_level = [
        row[0]
        for row in conn.execute(
            "SELECT concept_id FROM concepts WHERE top_level_position IS NOT NULL ORDER BY top_level_position"
        )
    ]
    assert top_level == atlas["top_level_condition_ids"]
    for key, value_json in conn.execute("SELECT key, value_json FROM atlas_meta"):
        assert json.loads(value_json) == atlas[key], key
    record("concepts", len(stored))
    _assert_no_problems(problems, len(stored))


def test_prevalence_tiers_match(conn):
    payload = _load("prevalence_by_code.json")
    set_id = _set_id(conn, "prevalence", "prevalence_by_code.json")
    stored = dict(conn.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ?", (set_id,)))
    expected = {code: normalize_prevalence_tier(value) for code, value in payload["scores_by_code"].items()}
    assert stored == expected
    assert conn.execute("SELECT min_score, max_score FROM prevalence_sets WHERE set_id = ?", (set_id,)).fetchone() == (
        payload["min_score"],
        payload["max_score"],
    )
    record("prevalence tiers", len(stored))


def test_registry_matches(conn, registry):
    set_id = _set_id(conn, "models", "model-registry.json")
    assert conn.execute("SELECT default_model_version FROM registry_sets WHERE set_id = ?", (set_id,)).fetchone()[0] == (
        registry["default_model_version"]
    )
    models = conn.execute(
        "SELECT model_version, model_name, model_release, display_name, status, default_use_case, effects_json, "
        "capabilities_json FROM models WHERE set_id = ? ORDER BY position",
        (set_id,),
    ).fetchall()
    assert len(models) == len(registry["models"])
    for model, row in zip(registry["models"], models):
        assert row[:6] == (
            model["model_version"],
            model.get("model_name"),
            model.get("model_release"),
            model["display_name"],
            model["status"],
            model.get("default_use_case"),
        )
        assert (json.loads(row[6]) if row[6] else None) == model.get("effects")
        assert (json.loads(row[7]) if row[7] else None) == model.get("capabilities")
        variants = conn.execute(
            "SELECT use_case, legacy_metrics_file, legacy_multimorbidity_metrics_file FROM use_case_variants "
            "WHERE set_id = ? AND model_version = ? ORDER BY position",
            (set_id, model["model_version"]),
        ).fetchall()
        assert variants == [
            (variant["use_case"], variant["metrics_file"], variant.get("multimorbidity_metrics_file"))
            for variant in model["use_case_variants"]
        ]


def _combo_index_by_position(conn, set_id: int) -> list[int]:
    return [row[0] for row in conn.execute("SELECT combo_idx FROM set_combos WHERE set_id = ? ORDER BY position", (set_id,))]


def _assert_combos_match(conn, set_id: int, combo_definitions: list[dict]) -> list[int]:
    combos = _combo_index_by_position(conn, set_id)
    lenses = dict(
        (idx, (context, age, sex, eth))
        for idx, context, age, sex, eth in conn.execute(
            "SELECT combo_idx, context, age_lens, sex_lens, ethnicity_lens FROM lens_combos"
        )
    )
    assert [lenses[idx] for idx in combos] == [
        (combo["context"], combo["age_lens"], combo["sex_lens"], combo["ethnicity_lens"]) for combo in combo_definitions
    ]
    return combos


def _metric_variants(registry):
    return [
        (model["model_version"], variant["use_case"], variant["metrics_file"], variant.get("multimorbidity_metrics_file"))
        for model in registry["models"]
        for variant in model["use_case_variants"]
    ]


def test_metric_tuples_match(conn, registry, warning_codes):
    total = 0
    for model_version, use_case, metrics_file, _ in _metric_variants(registry):
        relative = seed_relative(metrics_file)
        payload = _load(relative)
        set_id = _set_id(conn, "metrics", relative)
        assert conn.execute(
            "SELECT model_version, use_case FROM content_sets WHERE set_id = ?", (set_id,)
        ).fetchone() == (model_version, use_case)
        combos = _assert_combos_match(conn, set_id, payload["combo_definitions"])
        stored = {
            (row[0], row[1]): row[2:]
            for row in conn.execute(
                f"SELECT concept_id, combo_idx, {TUPLE_COLUMNS} FROM metric_rows WHERE set_id = ?", (set_id,)
            )
        }
        problems = []
        compared = 0
        for concept_id, tuples in payload["rows_by_condition_id"].items():
            for position, values in enumerate(tuples):
                compared += 1
                row = stored.get((concept_id, combos[position]))
                if row is None:
                    problems.append(f"{relative} {concept_id}#{position}: missing")
                    continue
                differences = _tuple_differences(values, row, warning_codes)
                if differences:
                    problems.append(f"{relative} {concept_id}#{position}: {differences}")
        assert len(stored) == compared, f"{relative}: {len(stored)} stored rows for {compared} JSON rows"
        _assert_no_problems(problems, compared)
        total += compared
    record("metric tuples", total)


def test_multimorbidity_tuples_match(conn, registry, warning_codes):
    total = combinations_total = 0
    for _, _, _, mm_file in _metric_variants(registry):
        if not mm_file:
            continue
        relative = seed_relative(mm_file)
        payload = _load(relative)
        set_id = _set_id(conn, "multimorbidity", relative)
        combos = _assert_combos_match(conn, set_id, payload["combo_definitions"])
        stored_combinations = conn.execute(
            "SELECT position, label FROM mm_combinations WHERE set_id = ? ORDER BY position", (set_id,)
        ).fetchall()
        assert stored_combinations == [
            (position, combination.get("label")) for position, combination in enumerate(payload["combinations"])
        ]
        members: dict[int, list[str]] = {}
        for position, concept_id in conn.execute(
            "SELECT position, concept_id FROM mm_combination_conditions WHERE set_id = ? ORDER BY position, member_index",
            (set_id,),
        ):
            members.setdefault(position, []).append(concept_id)
        stored = {
            (row[0], row[1]): row[2:]
            for row in conn.execute(f"SELECT position, combo_idx, {TUPLE_COLUMNS} FROM mm_rows WHERE set_id = ?", (set_id,))
        }
        problems = []
        for position, combination in enumerate(payload["combinations"]):
            assert members[position] == combination["condition_ids"]
            for row_position, values in enumerate(combination["rows"]):
                total += 1
                row = stored.get((position, combos[row_position]))
                differences = ["missing"] if row is None else _tuple_differences(values, row, warning_codes)
                if differences:
                    problems.append(f"{relative} combination {position}#{row_position}: {differences}")
        assert len(stored) == sum(len(combination["rows"]) for combination in payload["combinations"])
        _assert_no_problems(problems, len(stored))
        combinations_total += len(payload["combinations"])
    record("multimorbidity combinations", combinations_total)
    record("multimorbidity tuples", total)
