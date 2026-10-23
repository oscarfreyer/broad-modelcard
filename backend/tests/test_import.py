"""Import command behavior on a tiny synthetic table set: idempotency, refusal
to discard published versions, and rejection of contract violations."""

from __future__ import annotations

import copy
import sqlite3
from pathlib import Path

import pytest

from app import db
from app.importers.legacy_json import (
    DEFAULT_SEED_DIR,
    ImportRefused,
    check_seed,
    import_legacy_tables,
    main,
    source_files,
)
from app.services.dataset import Dataset
from app.services.types import Lens
from app.validation.legacy_tables import ContractViolation
from tiny_tables import ROW_FORMAT, _tuple, tiny_tables, write_tables


@pytest.fixture
def tables(tmp_path) -> Path:
    return write_tables(tmp_path / "tables", tiny_tables())


@pytest.fixture
def store(tmp_path) -> Path:
    return tmp_path / "store" / "broad_modelcard.sqlite"


def test_import_builds_version_one(tables, store):
    report = import_legacy_tables(tables, store)
    assert report.status == "imported"
    assert report.counts["metric_rows"] == 180
    assert report.counts["multimorbidity_rows"] == 1

    dataset = Dataset(db.connect(store, read_only=True))
    assert dataset.version_id == 1
    metrics = dataset.metrics("Tiny-1", "CDSS")
    deeper = metrics.row("1A00.0", Lens("Age 65+"))
    assert deeper.provenance.source == "anchor" and deeper.provenance.anchor_concept_id == "1A00"
    assert deeper.perf == metrics.row("1A00", Lens("Age 65+")).perf
    assert metrics.row("1A09.1") is None  # its anchor is not a depth-1 condition
    chapter = metrics.row("CH-01")
    assert chapter.provenance.rollup.aggregation == "p20" and chapter.provenance.rollup.child_count == 2

    multimorbidity = dataset.multimorbidity("Tiny-1", "CDSS")
    assert list(multimorbidity.combinations) == ["1A00+1A01"]
    assert multimorbidity.row(["1A00.0", "1A01"], Lens("Age 65+")).provenance.lens_fallback is True


def test_registry_paths_resolve_against_the_seed_root(tmp_path, store):
    """The registry names files as 'data/tables/models/...'; they are read from <seed>/models/."""
    seed = write_tables(tmp_path / "anywhere" / "seed", tiny_tables())
    assert not (seed / "data").exists()
    assert source_files(seed) == [
        "atlas-base.json",
        "prevalence_by_code.json",
        "model-registry.json",
        "models/tiny-1.cdss.metrics.json",
        "models/tiny-1.cdss.multimorbidity.metrics.json",
    ]
    assert import_legacy_tables(seed, store).status == "imported"
    conn = db.connect(store, read_only=True)
    sources = {row[0] for row in conn.execute("SELECT source FROM content_sets")}
    assert "legacy_json:models/tiny-1.cdss.metrics.json" in sources


def test_the_default_seed_is_backend_seed_and_complete():
    assert DEFAULT_SEED_DIR == db.BACKEND_DIR / "seed"
    files = source_files(DEFAULT_SEED_DIR)
    assert len(files) == 3 + 10 + 4  # atlas, prevalence, registry; 10 metrics and 4 multimorbidity files
    assert all((DEFAULT_SEED_DIR / relative).is_file() for relative in files)


def test_second_import_is_a_no_op(tables, store):
    import_legacy_tables(tables, store)
    modified = store.stat().st_mtime_ns
    report = import_legacy_tables(tables, store)
    assert report.status == "up_to_date"
    assert store.stat().st_mtime_ns == modified


def test_changed_source_is_reimported(tables, store):
    import_legacy_tables(tables, store)
    changed = tiny_tables()
    changed["model-registry.json"]["models"][0]["display_name"] = "Tiny one"
    write_tables(tables, changed)
    assert import_legacy_tables(tables, store).status == "imported"
    dataset = Dataset(db.connect(store, read_only=True))
    assert dataset.model("Tiny-1").display_name == "Tiny one"


def test_store_with_published_versions_needs_rebuild(tables, store):
    import_legacy_tables(tables, store)
    conn = db.connect(store)
    with conn:
        conn.execute(
            "INSERT INTO dataset_versions (version_id, kind, created_at, summary) VALUES (2, 'models', ?, 'test')",
            (db.utc_now(),),
        )
    conn.close()
    with pytest.raises(ImportRefused, match="2 dataset versions"):
        import_legacy_tables(tables, store)
    assert import_legacy_tables(tables, store, rebuild=True).status == "imported"
    conn = db.connect(store, read_only=True)
    assert conn.execute("SELECT COUNT(*) FROM dataset_versions").fetchone()[0] == 1


def _break(tables: dict, mutate) -> dict:
    broken = copy.deepcopy(tables)
    mutate(broken)
    return broken


METRICS = "models/tiny-1.cdss.metrics.json"
MULTIMORBIDITY = "models/tiny-1.cdss.multimorbidity.metrics.json"
ATLAS, PREVALENCE, REGISTRY = "atlas-base.json", "prevalence_by_code.json", "model-registry.json"
INVALID_SOURCES = {
    "unknown evidence grade": (
        lambda t: t[METRICS]["rows_by_condition_id"]["1A00"][0].__setitem__(3, "Z"),
        "evidence_grade is invalid",
    ),
    "string perf": (
        lambda t: t[METRICS]["rows_by_condition_id"]["1A00"][5].__setitem__(0, "0.8"),
        "perf must be a finite number",
    ),
    "short row list": (
        lambda t: t[METRICS]["rows_by_condition_id"]["1A01"].pop(),
        "row count does not match",
    ),
    "unknown condition": (
        lambda t: t[METRICS]["rows_by_condition_id"].__setitem__("9Z99", t[METRICS]["rows_by_condition_id"]["1A00"]),
        "outside top_level_condition_ids",
    ),
    "unknown lens value": (
        lambda t: t[METRICS]["combo_definitions"][3].__setitem__("age_lens", "Age 99+"),
        "is not an atlas axis value",
    ),
    "numeric prevalence": (
        lambda t: t["prevalence_by_code.json"]["scores_by_code"].__setitem__("1A00", 0.4),
        "expected a commonness tier",
    ),
    "row format": (
        lambda t: t[METRICS].__setitem__("row_format", ROW_FORMAT[::-1]),
        "row_format does not match",
    ),
    "duplicate disease set": (
        lambda t: t[MULTIMORBIDITY]["combinations"].append(
            {"condition_ids": ["1A00", "1A01"], "label": "again", "rows": [_tuple(0.7)]}
        ),
        "repeats the disease set",
    ),
    # Rules ported from the retired JavaScript validator (Phase D), one case each.
    "metrics for another model": (
        lambda t: t[METRICS].__setitem__("model_version", "Tiny-2"),
        'model_version "Tiny-2" does not match registry',
    ),
    "multimorbidity unknown condition": (
        lambda t: t[MULTIMORBIDITY]["combinations"][0]["condition_ids"].__setitem__(1, "9Z99"),
        'references unknown condition "9Z99"',
    ),
    "duplicate concept id": (
        lambda t: t[ATLAS]["concepts"].append(dict(t[ATLAS]["concepts"][2])),
        'Runtime atlas concept_id contains duplicate "1A00"',
    ),
    "missing parent": (
        lambda t: t[ATLAS]["concepts"][3].__setitem__("parent_id", "BLK-99"),
        'references missing parent "BLK-99"',
    ),
    "concept without a name": (
        lambda t: t[ATLAS]["concepts"][3].__setitem__("pt", " "),
        'concept "1A01" is missing pt',
    ),
    "top-level condition not in the atlas": (
        lambda t: t[ATLAS]["top_level_condition_ids"].append("9Z99"),
        'top_level_condition_id "9Z99" is not present',
    ),
    "duplicate model": (
        lambda t: t[REGISTRY]["models"].append(copy.deepcopy(t[REGISTRY]["models"][0])),
        'model_version contains duplicate "Tiny-1"',
    ),
    "default use case not a variant": (
        lambda t: t[REGISTRY]["models"][0].__setitem__("default_use_case", "Triage"),
        'default_use_case "Triage" is not a variant',
    ),
    "unknown default model": (
        lambda t: t[REGISTRY].__setitem__("default_model_version", "Tiny-9"),
        'default_model_version "Tiny-9" is not present',
    ),
    "metrics file outside the seed models": (
        lambda t: t[REGISTRY]["models"][0]["use_case_variants"][0].__setitem__("metrics_file", "models/tiny.metrics.json"),
        "must live under data/tables/models/",
    ),
    "metrics file path traversal": (
        lambda t: t[REGISTRY]["models"][0]["use_case_variants"][0].__setitem__(
            "metrics_file", "data/tables/models/../../tiny-1.cdss.metrics.json"
        ),
        "must not contain path traversal",
    ),
    "prevalence without a dataset id": (
        lambda t: t[PREVALENCE].pop("dataset_id"),
        "dataset_id is required",
    ),
    "prevalence bounds reversed": (
        lambda t: t[PREVALENCE].update(min_score=0.97, max_score=0.03),
        "min_score must be less than max_score",
    ),
    "prevalence bound not a number": (
        lambda t: t[PREVALENCE].__setitem__("max_score", "high"),
        "must be finite numbers when present",
    ),
    "prevalence code count": (
        lambda t: t[PREVALENCE].__setitem__("code_count", 99),
        "code_count does not match scores_by_code size",
    ),
    "prevalence empty code": (
        lambda t: t[PREVALENCE]["scores_by_code"].__setitem__(" ", "rare"),
        "contains an empty code key",
    ),
}


@pytest.mark.parametrize("case", INVALID_SOURCES, ids=list(INVALID_SOURCES))
def test_invalid_source_is_rejected_and_store_kept(tables, store, case):
    import_legacy_tables(tables, store)
    before = store.read_bytes()
    mutate, message = INVALID_SOURCES[case]
    write_tables(tables, _break(tiny_tables(), mutate))
    with pytest.raises(ContractViolation, match=message):
        import_legacy_tables(tables, store)
    assert store.read_bytes() == before
    assert not list(store.parent.glob("*.importing*"))


@pytest.mark.parametrize("missing", [METRICS, MULTIMORBIDITY])
def test_a_file_the_registry_names_must_exist(tables, store, missing):
    (tables / missing).unlink()
    with pytest.raises(ContractViolation, match="Missing source file"):
        import_legacy_tables(tables, store)


def test_every_metrics_file_must_be_in_the_registry(tables, store):
    write_tables(tables, {"models/stray.metrics.json": tiny_tables()[METRICS]})
    with pytest.raises(ContractViolation, match='"models/stray.metrics.json" is not referenced by model-registry.json'):
        import_legacy_tables(tables, store)


def test_check_validates_without_touching_the_store(tables, store, capsys):
    """npm run validate-seed: the import's checks, no store written."""
    assert check_seed(tables).counts["metric_rows"] == 180
    assert main(["--check", "--seed", str(tables), "--db", str(store), "--quiet"]) == 0
    assert capsys.readouterr().out.startswith(f"valid: {tables}")
    assert not store.parent.exists()

    write_tables(tables, _break(tiny_tables(), INVALID_SOURCES["prevalence code count"][0]))
    assert main(["--check", "--seed", str(tables), "--db", str(store), "--quiet"]) == 1
    assert "seed check failed: prevalence_by_code.json code_count" in capsys.readouterr().err
    assert not store.parent.exists()


def test_cli_reports_failures(tables, store, capsys):
    assert main(["--seed", str(tables), "--db", str(store), "--quiet"]) == 0
    assert "imported" in capsys.readouterr().out
    write_tables(tables, _break(tiny_tables(), INVALID_SOURCES["unknown evidence grade"][0]))
    assert main(["--seed", str(tables), "--db", str(store), "--quiet"]) == 1
    assert "evidence_grade is invalid" in capsys.readouterr().err


def test_migrations_apply_once(tmp_path):
    conn = sqlite3.connect(tmp_path / "empty.sqlite", isolation_level=None)
    newest = len(db.available_migrations())
    assert db.migrate(conn) == list(range(1, newest + 1))
    assert db.migrate(conn) == []
    assert db.schema_version(conn) == newest


def test_a_version_1_store_is_migrated_in_place(tmp_path):
    """A store built before uploads existed gains the uploads table (Track A3) without a re-import."""
    conn = sqlite3.connect(tmp_path / "old.sqlite", isolation_level=None)
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
    first = db.available_migrations()[0][2].read_text(encoding="utf-8")
    conn.executescript(f"BEGIN; {first}; INSERT INTO schema_migrations VALUES (1, 'initial', 'x'); COMMIT;")
    assert db.migrate(conn) == list(range(2, len(db.available_migrations()) + 1))
    assert conn.execute("SELECT COUNT(*) FROM uploads").fetchone() == (0,)
