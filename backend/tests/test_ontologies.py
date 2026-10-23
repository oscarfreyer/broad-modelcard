"""Other ontologies as projections over ICD-11 (contract v1.13, CONTRACT.md §23).

The importer, parsers, and crosswalk rules run on hand-written fixture
sources (tests/ontology_fixtures.py); the coverage test against the pinned
real releases runs only when they are downloaded (npm run ontologies:fetch).
ICD-11 reads stay byte-identical without the parameter.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from conftest import copy_store, local_client
from ontology_fixtures import FIXTURES, import_fixture_ontologies, write_sources

from app import db
from app.main import API_PREFIX, create_app
from app.ontologies.crosswalk import Icd11Resolver
from app.ontologies.icd10cm import parse_tabular, safe_xml
from app.ontologies.importer import import_ontologies
from app.ontologies.mondo import build_mondo
from app.ontologies.obo import read_obo
from app.ontologies.sources import MANIFEST_FILE, SourceInvalid, SourcesMissing, load_manifest, sources_dir
from app.ontologies.who import read_who_mapping
from app.services.aggregation import rollup_row
from app.services.types import Lens

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
MEDICORE = {"model": "MediCore-2.5", "use_case": "Discharge letter generation"}
NORTHBRIDGE = "northbridge-region"


def get(client, path: str, params: dict | None = None, **headers):
    response = client.get(API_PREFIX + path, params=params or {}, headers=headers)
    assert response.status_code == 200, f"{path} {params}: {response.text[:400]}"
    return response


def label_free(response) -> bytes:
    label = response.headers["x-dataset-version"]
    return response.content.replace(f'"dataset_version":"{label}"'.encode(), b'"dataset_version":"*"')


# --------------------------------------------------------------- parsers

def test_icd10cm_tabular_keeps_disease_chapters_and_four_characters():
    parsed = parse_tabular(safe_xml((FIXTURES / "icd10cm-tabular.xml").read_bytes(), "fixture"), "FY2027")
    by_id = {concept.concept_id: concept for concept in parsed.concepts}
    assert [c.concept_id for c in parsed.concepts if c.level == 0] == ["CM-CH-04", "CM-CH-09"]  # chapter 18 is left out
    assert parsed.notes == {"chapters_left_out": 1, "codes_beyond_four_characters": 1}  # E11.65
    assert by_id["CM-CH-04"].pt == "Endocrine, nutritional and metabolic diseases"
    assert by_id["CM-CH-04"].chapter_no == "04"
    block = by_id["CM-BLK-E08-E13"]
    assert (block.level, block.parent_id, block.code, block.pt) == (1, "CM-CH-04", "E08-E13", "Diabetes mellitus")
    e11, e11_9 = by_id["E11"], by_id["E11.9"]
    assert (e11.level, e11.depth_in_kind, e11.metric_anchor_id, e11.parent_id) == (2, 1, "E11", "CM-BLK-E08-E13")
    assert (e11_9.depth_in_kind, e11_9.metric_anchor_id, e11_9.parent_id) == (2, "E11", "CM-BLK-E08-E13")
    assert "E11.65" not in by_id and "R00" not in by_id
    orders = [concept.sort_order for concept in parsed.concepts]
    assert len(set(orders)) == len(orders)


def test_xml_with_a_document_type_is_refused():
    with pytest.raises(SourceInvalid):
        safe_xml(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>', "evil.xml")
    # Review fix: a document type behind a long comment is refused too (it was only looked for in the first 4 KB).
    with pytest.raises(SourceInvalid):
        safe_xml(b'<?xml version="1.0"?><!--' + b"x" * 8192 + b'--><!DOCTYPE x SYSTEM "http://example.invalid/x.dtd"><x/>', "late.xml")


def test_who_tables_skip_chapter_rows_and_prefer_the_foundation_table(tmp_path):
    write_sources(tmp_path)
    who = read_who_mapping(tmp_path / "who-mapping" / "mapping.zip")
    assert "I" not in who.icd10_to_icd11  # a chapter row: "I99" must not fall back to it
    assert who.icd10_prefix("I99") is None and who.icd10_prefix("E11.65") == "E11" and who.icd10_prefix("E11.9") == "E11.9"
    # 2001 is listed by both tables; the foundation table names the entity's own code.
    assert who.foundation_to_mms["2001"] == "5A11"
    assert "2003" not in who.foundation_to_mms  # no MMS code


def test_mondo_shape():
    parsed = build_mondo(read_obo(FIXTURES / "mondo.obo"), "v2026-10-06")
    by_id = {concept.concept_id: concept for concept in parsed.concepts}
    chapters = [c for c in parsed.concepts if c.level == 0]
    # Only the chapters of the table that the file holds, in ring order; metabolic comes first.
    assert [(c.concept_id, c.chapter_no, c.pt) for c in chapters] == [
        ("MONDO:0005066", "01", "Metabolic disease"),
        ("MONDO:0004995", "02", "Cardiovascular disorder"),
    ]
    blocks = [c.concept_id for c in parsed.concepts if c.level == 1]
    # A leaf directly under the chapter goes to "Other <chapter>"; a subclass with subclasses is a block.
    assert blocks == ["MONDO:9000010", "MONDO:0005066-other", "MONDO:9000020"]
    assert by_id["MONDO:0005066-other"].pt == "Other metabolic disease" and by_id["MONDO:0005066-other"].code is None
    assert by_id["MONDO:9000019"].parent_id == "MONDO:0005066-other" and by_id["MONDO:9000019"].depth_in_kind == 1
    # Depths below the block, deeper than 3 counted as 3, anchored at the depth-1 ancestor.
    depths = {cid: (by_id[cid].depth_in_kind, by_id[cid].metric_anchor_id) for cid in ("MONDO:9000011", "MONDO:9000012", "MONDO:9000013", "MONDO:9000014")}
    assert depths == {
        "MONDO:9000011": (1, "MONDO:9000011"),
        "MONDO:9000012": (2, "MONDO:9000011"),
        "MONDO:9000013": (3, "MONDO:9000011"),
        "MONDO:9000014": (3, "MONDO:9000011"),
    }
    assert all(by_id[cid].parent_id == "MONDO:9000010" for cid in depths)
    # A term in two chapters belongs to the first in priority order; other parents are kept.
    cardiomyopathy = by_id["MONDO:9000023"]
    assert cardiomyopathy.chapter_id == "MONDO:0005066" and cardiomyopathy.parents == ("MONDO:9000010", "MONDO:0004995")
    # The primary parent is the first by label among the parents inside the chapter.
    heart = by_id["MONDO:9000022"]
    assert heart.parents == ("MONDO:9000021", "MONDO:9000020") and heart.depth_in_kind == 2
    # Obsolete terms and terms outside every chapter are not imported.
    assert "MONDO:9000018" not in by_id and "MONDO:9000030" not in by_id
    assert by_id["MONDO:9000011"].pt == "Diabetes mellitus" and by_id["MONDO:9000011"].fsn is None


# ---------------------------------------------------------- crosswalk

def _mappings(store: Path, ontology: str) -> dict[str, tuple]:
    conn = sqlite3.connect(store)
    try:
        return {
            row[0]: row[1:]
            for row in conn.execute(
                "SELECT concept_id, kind, target_concept_id, via_concept_id, steps, source, source_code, icd11_code"
                " FROM ontology_mappings WHERE ontology_id = ?",
                (ontology,),
            )
        }
    finally:
        conn.close()


def test_icd10cm_crosswalk_kinds(ontology_db):
    mappings = _mappings(ontology_db, "icd10cm")
    assert mappings == {
        "E10": ("exact", "5A10", None, None, "who-icd10-icd11", "E10", "5A10"),
        "E10.9": ("exact", "5A10", None, None, "who-icd10-icd11", "E10", "5A10"),  # longest WHO prefix
        "E11": ("exact", "5A11", None, None, "who-icd10-icd11", "E11", "5A11"),
        "E11.6": ("exact", "5A11", None, None, "who-icd10-icd11", "E11", "5A11"),
        "E11.9": ("stem", "5A11", None, None, "who-icd10-icd11", "E11.9", "5A11.Q"),
        "E12": ("none", None, None, None, None, None, None),  # no WHO ICD-10 code
        "E13": ("exact", "5A13.1", None, None, "who-icd10-icd11", "E13", "5A13.1"),  # a deeper ICD-11 category
        "E14": ("block", "BLK-05-BlockL1-5A0", None, None, "who-icd10-icd11", "E14", "5A0Q"),
        "E16": ("none", None, None, None, None, None, None),  # ICD-11 target not in the atlas
        "I10": ("exact", "BA00", None, None, "who-icd10-icd11", "I10", "BA00"),
        "I99": ("none", None, None, None, None, None, None),  # the chapter row "I" does not count
    }


def test_mondo_crosswalk_kinds(ontology_db):
    mappings = _mappings(ontology_db, "mondo")
    assert mappings["MONDO:9000011"] == ("exact", "5A11", None, None, "mondo-icd11-foundation", "2001", "5A11")
    assert mappings["MONDO:9000015"] == ("exact", "5A13.1", None, None, "mondo-icd10cm", "E13", "5A13.1")
    assert mappings["MONDO:9000017"] == ("block", "BLK-05-BlockL1-5A0", None, None, "mondo-icd10who", "E14", "5A0Q")
    assert mappings["MONDO:9000019"] == ("exact", "5A13.1", None, None, "mondo-icd11-foundation", "2002", "5A13.1")
    assert mappings["MONDO:9000021"] == ("exact", "BA00", None, None, "mondo-icd10cm", "I10", "BA00")
    # Inherited from the nearest directly mapped parent, at most two is_a steps up.
    assert mappings["MONDO:9000012"][:4] == ("parent", "5A11", "MONDO:9000011", 1)
    assert mappings["MONDO:9000013"][:4] == ("parent", "5A11", "MONDO:9000011", 2)
    assert mappings["MONDO:9000022"][:4] == ("parent", "BA00", "MONDO:9000021", 1)
    for unmapped in ("MONDO:9000014", "MONDO:9000016", "MONDO:9000023"):  # three steps; no resolving xref; no mapped parent
        assert mappings[unmapped] == ("none", None, None, None, None, None, None), unmapped


def test_resolver_rules():
    resolver = Icd11Resolver(
        [("BLK-05-BlockL1-5A0", 1, "BlockL1-5A0"), ("5A11", 2, "5A11"), ("5A13.1", 2, "5A13.1")]
    )
    assert resolver.resolve("5a11").kind == "exact"
    assert (resolver.resolve("5A11.Q").kind, resolver.resolve("5A11.Q").concept_id) == ("stem", "5A11")
    assert resolver.resolve("5A13.12").concept_id == "5A13.1"  # the longest stem first
    assert (resolver.resolve("5A0Z").kind, resolver.resolve("5A0Z").concept_id) == ("block", "BLK-05-BlockL1-5A0")
    assert resolver.resolve("9Z99") is None and resolver.resolve("") is None


# ------------------------------------------------------------- import

def test_import_is_idempotent_and_reports_counts(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "store.sqlite")
    first = import_fixture_ontologies(store, tmp_path / "sources")
    second = import_fixture_ontologies(store, tmp_path / "sources")
    assert [entry.counts for entry in first.ontologies] == [entry.counts for entry in second.ontologies]
    counts = {entry.ontology_id: entry.counts for entry in second.ontologies}
    assert counts["icd10cm"]["mapping_conditions"] == {"exact": 4, "stem": 0, "block": 1, "parent": 0, "none": 3}
    assert (counts["icd10cm"]["chapters"], counts["icd10cm"]["blocks"], counts["icd10cm"]["conditions"], counts["icd10cm"]["concepts"]) == (2, 3, 8, 11)
    assert counts["mondo"]["mapping"] == {"exact": 4, "stem": 0, "block": 1, "parent": 3, "none": 3}
    conn = sqlite3.connect(store)
    rows = conn.execute("SELECT ontology_id, COUNT(*) FROM ontology_concepts GROUP BY ontology_id ORDER BY 1").fetchall()
    conn.close()
    assert rows == [("icd10cm", 2 + 3 + 11), ("mondo", 2 + 3 + 11)]
    assert "conditions by mapping" in second.describe()


def test_import_verifies_sources_before_writing(legacy_db, tmp_path):
    store = copy_store(legacy_db, tmp_path / "store.sqlite")
    root = tmp_path / "sources"
    manifest = write_sources(root)
    (root / "mondo" / "mondo.obo").write_text("format-version: 1.2\n", encoding="utf-8")  # a changed download
    with pytest.raises(SourceInvalid):
        import_ontologies(store, sources=root, manifest=manifest)
    shutil.rmtree(root / "icd10cm")
    with pytest.raises(SourcesMissing, match="npm run ontologies:fetch"):
        import_ontologies(store, sources=root, manifest=manifest)
    conn = sqlite3.connect(store)
    assert conn.execute("SELECT COUNT(*) FROM ontologies").fetchone() == (0,)
    conn.close()


def test_import_needs_an_icd11_atlas(tmp_path):
    from app.ontologies.importer import ImportFailed

    root = tmp_path / "sources"
    manifest = write_sources(root)
    empty = tmp_path / "empty.sqlite"
    conn = db.connect(empty)
    db.migrate(conn)
    conn.close()
    with pytest.raises(ImportFailed):
        import_ontologies(empty, sources=root, manifest=manifest)


def test_demo_build_notices_missing_sources(legacy_db, tmp_path):
    """npm run demo:build imports the ontologies when they are downloaded and says
    so plainly, without failing, when they are not (the store then serves ICD-11 only)."""
    from app.demo.builder import import_demo_ontologies

    store = copy_store(legacy_db, tmp_path / "store.sqlite")
    lines = import_demo_ontologies(store, tmp_path / "nothing-here", log=lambda message: None)
    assert len(lines) == 1 and "ICD-11 only" in lines[0] and "npm run ontologies:fetch" in lines[0]
    with local_client(create_app(store)) as client:
        assert [entry["id"] for entry in get(client, "/meta").json()["ontologies"]] == ["icd11"]


def test_the_import_command_ends_with_the_restart_notice(legacy_db, tmp_path, capsys):
    """npm run ontologies:import ends with a line that a running backend must be restarted to read
    the imported classifications; the demo build's lines never say so,
    because it refuses to build a store a running backend has open."""
    from app.demo.builder import import_demo_ontologies
    from app.ontologies.importer import RESTART_NOTICE, main

    store = copy_store(legacy_db, tmp_path / "store.sqlite")
    root = tmp_path / "sources"
    manifest = write_sources(root)
    assert main(["--db", str(store), "--sources", str(root), "--manifest", str(manifest), "--quiet"]) == 0
    printed = capsys.readouterr().out.strip().splitlines()
    assert printed[-1] == RESTART_NOTICE and "Restart a backend" in RESTART_NOTICE
    assert printed[0].startswith("ontologies imported into")
    assert main(["--db", str(store), "--sources", str(tmp_path / "nothing-here"), "--manifest", str(manifest), "--quiet"]) == 2
    assert RESTART_NOTICE not in capsys.readouterr().out, "nothing was imported, so there is nothing to restart for"
    # The demo build prints each ontology's own line (the lines above the notice) or, without the
    # downloads, the ICD-11-only notice: never the restart line.
    assert not any("estart" in line for line in printed[:-1])
    lines = import_demo_ontologies(store, tmp_path / "nothing-here", log=lambda message: None)
    assert lines and not any("estart" in line for line in lines)


def test_pinned_manifest_and_default_folder():
    pinned = load_manifest(MANIFEST_FILE)
    assert set(pinned) == {"mondo", "icd10cm", "who-mapping"}
    assert all(len(source.sha256) == 64 and source.bytes > 0 for source in pinned.values())
    assert sources_dir().name == "ontology-sources"


# ----------------------------------------------------------- /meta

def test_meta_lists_icd11_alone_without_an_import(client):
    ontologies = get(client, "/meta").json()["ontologies"]
    assert [entry["id"] for entry in ontologies] == ["icd11"]
    icd11 = ontologies[0]
    assert icd11["is_default"] and icd11["counts"] == {"chapters": 21, "blocks": 225, "conditions": 2400, "concepts": 13442}
    assert icd11["mapping_counts"] is None and "World Health Organization" in icd11["attribution"]
    response = client.get(f"{API_PREFIX}/atlas/overview", params={"ontology": "mondo"})
    assert response.status_code == 404 and response.json()["code"] == "unknown_ontology"


def test_meta_lists_imported_ontologies(ontology_client):
    ontologies = get(ontology_client, "/meta").json()["ontologies"]
    assert [entry["id"] for entry in ontologies] == ["icd11", "icd10cm", "mondo"]
    cm = ontologies[1]
    assert (cm["name"], cm["release"], cm["is_default"]) == ("ICD-10-CM", "FY2027", False)
    assert cm["mapping_counts"] == {"exact": 4, "stem": 0, "block": 1, "parent": 0, "none": 3}
    assert [source["id"] for source in cm["sources"]] == ["icd10cm", "who-mapping"]


# ------------------------------------------------------- byte identity

# A fixed set of atlas reads (CONTRACT.md §23: without `ontology` every answer is unchanged).
ICD11_READS = [
    ("/atlas/overview", {}),
    ("/atlas/chapters/CH-05", {}),
    ("/metrics/map", {**SYN, "scope": "atlas"}),
    ("/metrics/map", {**MEDICORE, "scope": "chapter", "chapter_id": "CH-11", "age": "Age 65+"}),
    ("/metrics/summary", {**SYN, "view": "overall"}),
    ("/metrics/summary", {**SYN, "view": "safety"}),
    ("/metrics/concepts/CH-05", SYN),
    ("/metrics/concepts/BLK-05-BlockL1-5A0", SYN),
    ("/metrics/concepts/5A11", MEDICORE),
    ("/metrics/concepts/5A13.1", SYN),
    ("/search", {"q": "diabetes"}),
    ("/search", {"q": "E11"}),
    ("/multimorbidity/candidates", {**SYN, "scope": "atlas"}),
    ("/catalogue", {}),
    ("/models", {}),
]


def test_icd11_reads_are_byte_identical(client, ontology_client):
    """A store with ontologies answers every ICD-11 read exactly as a store without them,
    and ``ontology=icd11`` is the same read as no parameter (bytes and ETag). Since v1.14 (§31)
    a search that a synonym matches lists that match after the others; none of these queries
    hits a fixture synonym (tests/test_search_synonyms.py covers that)."""
    for path, params in ICD11_READS:
        plain = get(client, path, params)
        with_ontologies = get(ontology_client, path, params)
        assert label_free(with_ontologies) == label_free(plain), path
        assert with_ontologies.headers["etag"] == plain.headers["etag"], path
        assert "x-ontology" not in with_ontologies.headers
        if path not in ("/catalogue", "/models", "/multimorbidity/candidates"):
            explicit = get(ontology_client, path, {**params, "ontology": "icd11"})
            assert explicit.content == with_ontologies.content and "x-ontology" not in explicit.headers, path
    plain_export = get(client, "/export/concepts/5A11", SYN).json()
    export = get(ontology_client, "/export/concepts/5A11", SYN).json()
    plain_export.pop("exported_at"), export.pop("exported_at")
    assert export == plain_export and "ontology" not in export and "mapping" not in export["concept"]


def test_unknown_and_malformed_ontologies(ontology_client):
    for path, params in (("/atlas/overview", {}), ("/metrics/map", {**SYN, "scope": "atlas"}), ("/search", {"q": "x"})):
        unknown = ontology_client.get(API_PREFIX + path, params={**params, "ontology": "snomed"})
        assert unknown.status_code == 404 and unknown.json()["code"] == "unknown_ontology", path
        malformed = ontology_client.get(API_PREFIX + path, params={**params, "ontology": "Not An Id"})
        assert malformed.status_code == 422 and malformed.json()["code"] == "invalid_parameter", path
    # An ICD-11 concept is not a concept of another ontology, and vice versa.
    assert ontology_client.get(f"{API_PREFIX}/metrics/concepts/5A11", params={**SYN, "ontology": "icd10cm"}).status_code == 404
    assert ontology_client.get(f"{API_PREFIX}/metrics/concepts/E11", params=SYN).status_code == 404
    assert ontology_client.get(f"{API_PREFIX}/atlas/chapters/CH-05", params={"ontology": "mondo"}).status_code == 404


# ------------------------------------------------------------ projection

def _concept(client, concept_id: str, ontology: str | None, card=SYN, **lens) -> dict:
    params = {**card, **lens}
    if ontology:
        params["ontology"] = ontology
    return get(client, f"/metrics/concepts/{concept_id}", params).json()


def _row_without_id(metrics: dict | None) -> dict | None:
    if metrics is None:
        return None
    return {key: value for key, value in metrics.items() if key != "concept_id"}


@pytest.mark.parametrize("lens", [{}, {"age": "Age 65+", "sex": "Sex Female"}])
def test_conditions_serve_their_mapped_icd11_rows(ontology_client, lens):
    client = ontology_client
    cases = [
        ("icd10cm", "E11", "5A11", "exact"),
        ("icd10cm", "E11.9", "5A11", "stem"),
        ("icd10cm", "E13", "5A13.1", "exact"),  # a deeper ICD-11 category serves its anchor's row
        ("icd10cm", "E14", "BLK-05-BlockL1-5A0", "block"),  # the ICD-11 block's rollup
        ("mondo", "MONDO:9000011", "5A11", "exact"),
        ("mondo", "MONDO:9000013", "5A11", "parent"),
        ("mondo", "MONDO:9000022", "BA00", "parent"),
    ]
    for ontology, concept_id, target, kind in cases:
        projected = _concept(client, concept_id, ontology, **lens)
        icd11 = _concept(client, target, None, **lens)
        assert projected["mapping"]["kind"] == kind, concept_id
        assert projected["mapping"]["icd11"]["concept_id"] == target
        assert projected["metrics"]["concept_id"] == concept_id
        assert _row_without_id(projected["metrics"]) == _row_without_id(icd11["metrics"]), concept_id
        assert projected["incidents"] == icd11["incidents"]
        assert projected["ontology"]["id"] == ontology and projected["concept"]["icd11_code"] is None
        assert projected["concept"]["code"] == concept_id
    parent = _concept(client, "MONDO:9000013", "mondo")["mapping"]
    assert parent["via"] == {"concept_id": "MONDO:9000011", "pt": "Diabetes mellitus"} and parent["steps"] == 2


def test_unmapped_conditions_serve_no_row(ontology_client):
    for ontology, concept_id in (("icd10cm", "E12"), ("icd10cm", "I99"), ("mondo", "MONDO:9000014")):
        body = _concept(ontology_client, concept_id, ontology)
        assert body["metrics"] is None and body["incidents"] == []
        assert body["mapping"] == {"kind": "none", "icd11": None, "via": None, "steps": None, "source": None, "source_code": None, "icd11_code": None}
        assert body["concept"]["prevalence_tier"] == "uncommon"  # the neutral tier


def test_other_parents_and_paths(ontology_client):
    body = _concept(ontology_client, "MONDO:9000023", "mondo")
    assert body["other_parents"] == [{"concept_id": "MONDO:0004995", "pt": "Cardiovascular disorder"}]
    assert [entry["concept_id"] for entry in body["path"]] == ["MONDO:0005066", "MONDO:9000010", "MONDO:9000023"]
    assert _concept(ontology_client, "E11", "icd10cm")["other_parents"] == []
    chapter = _concept(ontology_client, "CM-CH-04", "icd10cm")
    assert chapter["mapping"] is None and "other_parents" not in chapter
    unmapped_block = _concept(ontology_client, "CM-BLK-E15-E16", "icd10cm")
    assert unmapped_block["mapping"]["kind"] == "none" and unmapped_block["metrics"]["provenance"]["rollup"]["child_count"] == 0


def test_rollups_aggregate_distinct_icd11_anchors(ontology_client, ontology_db):
    """A block or chapter of another ontology rolls up the distinct depth-1 ICD-11
    conditions its mapped concepts reach (§6 rules), each counted once."""
    client = ontology_client
    hypertension = _concept(client, "MONDO:9000020", "mondo")
    # Essential hypertension and hypertensive heart disease both reach BA00: one child, not two.
    assert hypertension["metrics"]["provenance"]["rollup"]["child_count"] == 1
    # Compare with the §6 rollup computed from the ICD-11 rows directly.
    from app.services.dataset import Dataset

    dataset = Dataset(db.connect(ontology_db, read_only=True))
    try:
        metrics = dataset.metrics(SYN["model"], SYN["use_case"])
        block_conditions = [c.concept_id for c in dataset.atlas.conditions_by_block["BLK-05-BlockL1-5A0"]]
        lens = Lens()
        anchors = list(dict.fromkeys(["5A10", "5A11", "5A13", *block_conditions]))  # E10, E10.9, E11…, E13, E14 (the block)
        expected = rollup_row(
            concept_id="CM-BLK-E08-E13",
            chapter_no="05",
            lens=lens,
            use_case=SYN["use_case"],
            child_rows=[metrics.row(a, lens) for a in anchors if metrics.row(a, lens) is not None],
            child_weights=[dataset.atlas.by_id[a].prevalence_score for a in anchors if metrics.row(a, lens) is not None],
        )
    finally:
        dataset.connection.close()
    block = _concept(client, "CM-BLK-E08-E13", "icd10cm")["metrics"]
    assert block["provenance"]["rollup"]["child_count"] == expected.provenance.rollup.child_count == len(set(anchors))
    assert (block["perf"], block["ci_low"], block["ci_high"], block["evidence_grade"]) == (
        expected.perf, expected.ci_low, expected.ci_high, expected.evidence_grade
    )


def test_map_summary_and_safety_through_the_mapping(ontology_demo_client):
    client = ontology_demo_client
    params = {**SYN, "scope": "atlas", "age": "Age 65+"}
    icd11 = {row[0]: row for row in get(client, "/metrics/map", params).json()["rows"]}
    body = get(client, "/metrics/map", {**params, "ontology": "icd10cm"}).json()
    assert body["ontology"] == {"id": "icd10cm", "name": "ICD-10-CM"}
    columns = body["columns"]
    rows = {row[0]: dict(zip(columns, row)) for row in body["rows"]}
    mapping = dict(zip((row[0] for row in body["rows"]), body["mapping"]))
    # A block none of whose conditions maps (E16 alone) is none too: No mapping, not a rollup without children.
    assert mapping == {"CM-BLK-E08-E13": None, "CM-BLK-E15-E16": "none", "CM-BLK-I10-I1A": None, "E10": "exact", "E11": "exact", "E12": "none", "E13": "exact", "E14": "block", "E16": "none", "I10": "exact", "I99": "none"}
    # SI-2026-001 (BA00, Age 65+, open, harm possible) is serious on I10 and its block.
    assert rows["I10"]["safety"] == icd11["BA00"][columns.index("safety")] == "serious"
    assert rows["CM-BLK-I10-I1A"]["safety"] == "serious"
    assert rows["E12"]["overall_status"] == "no_data" and rows["E12"]["safety"] is None
    assert rows["E11"]["overall_status"] == icd11["5A11"][columns.index("overall_status")]
    incidents = _concept(client, "I10", "icd10cm", age="Age 65+")["incidents"]
    assert [incident["incident_id"] for incident in incidents] == [i["incident_id"] for i in _concept(client, "BA00", None, age="Age 65+")["incidents"]]
    summary = get(client, "/metrics/summary", {**SYN, "ontology": "icd10cm"}).json()
    assert summary["total"] == 8 and summary["mapping_counts"] == {"exact": 4, "stem": 0, "block": 1, "parent": 0, "none": 3}
    assert summary["counts"]["no_data"] >= 3 and [chapter["chapter_id"] for chapter in summary["chapters"]] == ["CM-CH-04", "CM-CH-09"]
    safety = get(client, "/metrics/summary", {**SYN, "view": "safety", "age": "Age 65+", "ontology": "icd10cm"}).json()
    assert safety["safety_counts"]["serious"] >= 1


def test_a_mapped_local_result_keeps_its_public_result_beside_it(demo_db, tmp_path):
    """Review fix: read in another ontology, a condition served from local
    results had ``public_metrics`` null although its ICD-11 condition has a
    public result (§26.1), so the condition card said no public result exists."""
    store = copy_store(demo_db[0], tmp_path / "demo.sqlite")
    import_fixture_ontologies(store, tmp_path / "sources")
    icu = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
    record = {
        "ICD-11 code": "5A11", "Age": "All ages", "Sex": "All sexes", "Ethnicity": "All ethnicities", "Performance": 0.61,
        "CI low": 0.55, "CI high": 0.67, "Samples": 400, "Sites": 1, "Studies": 1, "Peer-reviewed studies": 0,
        "Validation type": "Clinical study (single site)", "Source": "Northbridge ICU evaluation (fictional)",
        "Study": "NBR-ICU-LOCAL-2026", "Source date": "2026-10-12",
    }
    with local_client(create_app(store, validate_responses=True, uploads_dir=tmp_path / "uploads")) as client:
        staged = client.post(
            f"{API_PREFIX}/admin/uploads/records",
            json={"kind": "local_metrics", "records": [record], **{"model_version": icu["model"], "use_case": icu["use_case"]}, "population_id": NORTHBRIDGE},
        )
        assert staged.status_code == 202, staged.text
        client.app.state.api.admin.wait_for_checks()
        upload = client.get(f"{API_PREFIX}/admin/uploads/{staged.json()['upload_id']}").json()
        assert upload["status"] == "valid", upload["report"]
        assert client.post(f"{API_PREFIX}/admin/uploads/{upload['upload_id']}/publish", json={"previewed": False}).status_code == 200
        icd11 = _concept(client, "5A11", None, card=icu, population=NORTHBRIDGE)
        mapped = _concept(client, "E11", "icd10cm", card=icu, population=NORTHBRIDGE)
    assert icd11["metrics"]["perf"] == mapped["metrics"]["perf"] == 0.61 and mapped["metrics"]["provenance"]["layer"] == "local"
    assert mapped["public_metrics"] is not None
    assert {**mapped["public_metrics"], "concept_id": None} == {**icd11["public_metrics"], "concept_id": None}


def test_population_tiers_reach_the_projection(ontology_demo_client):
    client = ontology_demo_client
    default = {c["concept_id"]: c for c in get(client, "/atlas/overview", {"ontology": "icd10cm"}).json()["conditions"]}
    local = get(client, "/atlas/overview", {"ontology": "icd10cm", "population": NORTHBRIDGE})
    assert local.headers["x-population"] == NORTHBRIDGE and local.headers["x-ontology"] == "icd10cm"
    local_body = local.json()
    assert local_body["population"]["id"] == NORTHBRIDGE and local_body["ontology"]["id"] == "icd10cm"
    by_id = {c["concept_id"]: c for c in local_body["conditions"]}
    icd11_default = {c["concept_id"]: c for c in get(client, "/atlas/overview").json()["conditions"]}
    icd11_local = {c["concept_id"]: c for c in get(client, "/atlas/overview", {"population": NORTHBRIDGE}).json()["conditions"]}
    # E10 maps to 5A10, which Northbridge lists as common.
    assert default["E10"]["prevalence_tier"] == icd11_default["5A10"]["prevalence_tier"]
    assert by_id["E10"]["prevalence_tier"] == icd11_local["5A10"]["prevalence_tier"] == "common"
    assert by_id["E10"]["prevalence_score"] == icd11_local["5A10"]["prevalence_score"]


def test_ontology_reads_key_their_caches(ontology_client):
    client = ontology_client
    params = {**SYN, "scope": "atlas"}
    icd11 = get(client, "/metrics/map", params)
    cm = get(client, "/metrics/map", {**params, "ontology": "icd10cm"})
    assert cm.headers["etag"] != icd11.headers["etag"] and cm.headers["x-ontology"] == "icd10cm"
    assert get(client, "/metrics/map", {**params, "ontology": "icd10cm"}, **{"If-None-Match": icd11.headers["etag"]}).status_code == 200
    again = client.get(f"{API_PREFIX}/metrics/map", params={**params, "ontology": "icd10cm"}, headers={"If-None-Match": cm.headers["etag"]})
    assert again.status_code == 304 and again.headers["x-ontology"] == "icd10cm"
    assert get(client, "/metrics/map", params, **{"If-None-Match": cm.headers["etag"]}).status_code == 200


def test_search_per_ontology(ontology_client):
    client = ontology_client
    cm = get(client, "/search", {"q": "E11", "ontology": "icd10cm"}).json()
    assert [r["concept_id"] for r in cm["results"]][:3] == ["E11", "E11.6", "E11.9"]  # code, then code prefix by length
    assert cm["ontology"]["id"] == "icd10cm"
    by_name = get(client, "/search", {"q": "diabetes", "ontology": "mondo"}).json()
    assert by_name["results"][0]["concept_id"] == "MONDO:9000011"
    assert get(client, "/search", {"q": "MONDO:9000021", "ontology": "mondo"}).json()["results"][0]["pt"] == "Essential hypertension"
    # A chapter's code is its number, never its made-up concept id ("CM-CH-04"), so a code search for
    # "e1" does not lead with chapters and blocks.
    assert get(client, "/search", {"q": "04", "ontology": "icd10cm"}).json()["results"][0]["concept_id"] == "CM-CH-04"
    assert get(client, "/search", {"q": "e1", "ontology": "icd10cm"}).json()["results"][0]["concept_id"] == "E10"


def test_concept_export_names_ontology_and_mapping(ontology_client):
    response = get(ontology_client, "/export/concepts/MONDO:9000013", {**SYN, "ontology": "mondo"})
    body = response.json()
    assert response.headers["x-ontology"] == "mondo" and body["ontology"] == {"id": "mondo", "name": "MONDO"}
    assert body["concept"]["code"] == "MONDO:9000013" and body["concept"]["mapping"]["kind"] == "parent"
    assert body["model_card"]["provenance"]["data_source"] is not None  # the ICD-11 row's source


def test_chapter_reads_and_overview_shapes(ontology_client):
    overview = get(ontology_client, "/atlas/overview", {"ontology": "mondo"}).json()
    assert [c["concept_id"] for c in overview["chapters"]] == ["MONDO:0005066", "MONDO:0004995"]
    assert {c["concept_id"] for c in overview["conditions"]} >= {"MONDO:9000011", "MONDO:9000019"}
    assert all(c["depth_in_kind"] == 1 for c in overview["conditions"])
    chapter = get(ontology_client, "/atlas/chapters/MONDO:0005066", {"ontology": "mondo"}).json()
    assert any(c["depth_in_kind"] == 3 for c in chapter["concepts"])
    assert chapter["chapter"]["chapter_no"] == "01"


# ------------------------------------------------------ the real sources

REAL_SOURCES = sources_dir()


@pytest.mark.slow
@pytest.mark.skipif(
    not all((REAL_SOURCES / source.id / source.file).is_file() for source in load_manifest().values()),
    reason="the pinned ontology releases are not downloaded (npm run ontologies:fetch)",
)
def test_real_sources_reach_the_r0_coverage(legacy_db, tmp_path):
    """ICD-10-CM categories 984 exact and 9 by stem, 155 to a block,
    319 without a resolving mapping; MONDO at least the R0 share mapped. Every
    response of every ontology stays within the 2 MB budget (CONTRACT.md §10)."""
    store = copy_store(legacy_db, tmp_path / "real.sqlite")
    report = import_ontologies(store)
    counts = {entry.ontology_id: entry.counts for entry in report.ontologies}
    assert counts["icd10cm"]["mapping_conditions"] == {"exact": 984, "stem": 9, "block": 155, "parent": 0, "none": 319}
    assert (counts["icd10cm"]["chapters"], counts["icd10cm"]["blocks"], counts["icd10cm"]["conditions"], counts["icd10cm"]["concepts"]) == (18, 233, 1467, 9295)
    mondo = counts["mondo"]["mapping"]
    assert (mondo["exact"] + mondo["stem"] + mondo["block"] + mondo["parent"]) / sum(mondo.values()) >= 0.52
    with local_client(create_app(store)) as client:
        for ontology in ("icd10cm", "mondo"):
            overview = get(client, "/atlas/overview", {"ontology": ontology})
            assert len(overview.content) < 2 * 1024 * 1024
            for chapter in overview.json()["chapters"]:
                chapter_id = chapter["concept_id"]
                assert len(get(client, f"/atlas/chapters/{chapter_id}", {"ontology": ontology}).content) < 2 * 1024 * 1024
                assert len(get(client, "/metrics/map", {**SYN, "scope": "chapter", "chapter_id": chapter_id, "ontology": ontology}).content) < 2 * 1024 * 1024
