"""The synonym import (contract v1.14, CONTRACT.md §23, §31).

The import reads MONDO labels and EXACT synonyms and the ICD-10-CM index's
main terms (the hand-written fixtures in ``tests/fixtures/ontologies``) and
keeps those that reach an ICD-11 concept directly (``exact`` or ``stem``).
"""

from __future__ import annotations

import sqlite3

import pytest
from conftest import copy_store
from ontology_fixtures import import_fixture_ontologies

from app.ontologies.icd10cm import parse_index, safe_xml
from app.ontologies.obo import parse_obo_lines
from app.ontologies.synonyms import Synonym, clean, finalize, index_forms, key_of, load_synonyms


@pytest.fixture(scope="module")
def synonym_store(legacy_db, tmp_path_factory):
    root = tmp_path_factory.mktemp("synonyms")
    store = copy_store(legacy_db, root / "synonyms.sqlite")
    report = import_fixture_ontologies(store, root / "sources")
    return store, report


# ------------------------------------------------------------------ parsing

def test_obo_reads_exact_synonyms_only():
    obo = parse_obo_lines(
        [
            "format-version: 1.2\n",
            "[Term]\n",
            "id: MONDO:1\n",
            "name: thing\n",
            'synonym: "plain words" EXACT [X:1]\n',
            'synonym: "with \\"quotes\\" inside" EXACT []\n',
            'synonym: "broader" BROAD []\n',
            'synonym: "related" RELATED []\n',
            'synonym: "no scope"\n',
        ]
    )
    assert obo.terms["MONDO:1"].synonyms == ["plain words", 'with "quotes" inside']


def test_index_main_terms_without_modifiers_or_subterms():
    root = safe_xml(
        b"<ICD10CM.index><letter><mainTerm><title>Stroke<nemod>(apoplectic)</nemod></title><code>I63.9</code>"
        b"<term level='1'><title>perinatal</title><code>P91.82-</code></term></mainTerm>"
        b"<mainTerm><title>Abasia</title><see>Gait</see></mainTerm>"
        b"<mainTerm><title>Mastoiditis</title><code>H70.9-</code></mainTerm></letter></ICD10CM.index>",
        "index",
    )
    assert parse_index(root) == [("Stroke", "I63.9"), ("Mastoiditis", "H70.9")]


def test_index_titles_split_into_inflections_only():
    assert index_forms("Infarct, infarction") == ["Infarct", "infarction"]
    assert index_forms("Diabetes, diabetic") == ["Diabetes", "diabetic"]
    assert index_forms("Pharyngotracheitis, chronic") == ["Pharyngotracheitis, chronic"]
    assert index_forms("Myxedema") == ["Myxedema"]


def test_cleaning_rules():
    assert clean("  heart   attack ") == "heart attack"
    assert clean("DM") is None and clean("2024") is None and clean("12-34") is None
    assert key_of("- Sugar  Disease") == key_of("sugar disease")
    kept = finalize(
        [
            Synonym("5A11", "Type 2 diabetes mellitus", "mondo", "M:1"),  # the preferred term itself
            Synonym("5A11", "sugar disease", "mondo", "M:1"),
            Synonym("5A11", "Sugar Disease", "mondo", "M:2"),  # a repeat, case-insensitively
            Synonym("ZZ99", "unknown concept", "mondo", "M:3"),  # not an ICD-11 level-2 concept
        ],
        {"5A11": "Type 2 diabetes mellitus"},
    )
    assert kept == [Synonym("5A11", "sugar disease", "mondo", "M:1")]


# ------------------------------------------------------------------- import

def test_import_writes_synonyms_by_source(synonym_store):
    store, report = synonym_store
    assert {entry.ontology_id: entry.synonyms for entry in report.ontologies} == {"icd10cm": 7, "mondo": 6}
    assert "synonyms of ICD-11 concepts" in report.describe()
    conn = sqlite3.connect(store)
    rows = conn.execute("SELECT source, concept_id, synonym, source_code FROM concept_synonyms ORDER BY source, position").fetchall()
    conn.close()
    assert rows == [
        ("icd10cm_index", "5A11", "Diabetes", "E11.9"),
        ("icd10cm_index", "5A11", "diabetic", "E11.9"),
        ("icd10cm_index", "BA00", "High blood pressure", "I10"),
        ("icd10cm_index", "BA00", "Hypertension", "I10"),
        ("icd10cm_index", "BA00", "hypertensive", "I10"),
        ("icd10cm_index", "BA00", "Pressure, high, chronic", "I10"),
        ("icd10cm_index", "5A11", "Sweet blood disease", "E11"),
        # MONDO: the label and EXACT synonyms of directly mapped terms; "DM" (short), "2024" (no letter),
        # the preferred term, a repeat, a RELATED synonym, and a term mapped through its parent give none.
        ("mondo", "5A11", "diabetes mellitus", "MONDO:9000011"),
        ("mondo", "5A11", "sugar disease", "MONDO:9000011"),
        ("mondo", "5A11", 'glycaemic "sweet" illness', "MONDO:9000011"),
        ("mondo", "5A13.1", "diabetes due to a genetic defect", "MONDO:9000015"),
        ("mondo", "5A13.1", "leaf metabolic condition", "MONDO:9000019"),
        ("mondo", "BA00", "high blood pressure", "MONDO:9000021"),
    ]


def test_import_is_idempotent_and_per_source(synonym_store, tmp_path):
    store = copy_store(synonym_store[0], tmp_path / "again.sqlite")
    import_fixture_ontologies(store, tmp_path / "sources")
    from app.ontologies.importer import import_ontologies
    from ontology_fixtures import write_sources

    manifest = write_sources(tmp_path / "only")
    import_ontologies(store, sources=tmp_path / "only", manifest=manifest, only=("mondo",))
    conn = sqlite3.connect(store)
    counts = dict(conn.execute("SELECT source, COUNT(*) FROM concept_synonyms GROUP BY source"))
    conn.close()
    assert counts == {"icd10cm_index": 7, "mondo": 6}


def test_loaded_synonyms_are_unique_per_concept_mondo_first(synonym_store):
    conn = sqlite3.connect(synonym_store[0])
    synonyms = load_synonyms(conn)
    conn.close()
    assert synonyms["BA00"] == [
        ("high blood pressure", "mondo"),
        ("Hypertension", "icd10cm_index"),
        ("hypertensive", "icd10cm_index"),
        ("Pressure, high, chronic", "icd10cm_index"),
    ]
    assert load_synonyms(sqlite3.connect(":memory:")) == {}  # no table: no synonyms
