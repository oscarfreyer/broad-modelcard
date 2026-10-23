"""Not appraised, made visible (CONTRACT.md §22).

Rows without a linked study keep their grade. The map says, per row, whether a
result rests on a stored row linked to a study record (``appraisal``: linked,
includes_linked, or null), and the summary counts the graded conditions and
those linked (``appraisal_counts``). Both are sent only when a row is linked,
so a store or card without linked studies answers byte for byte as before; they
follow every ontology and local population. Synthetic data only.
"""

from __future__ import annotations

import pytest
from test_studies import TINY, link_rows, publish, stage_studies, study

from app.main import API_PREFIX

VIEWS = ("overall", "performance", "evidence", "intended_use", "safety")
SKINAI = {"model": "SkinAI-1.0", "use_case": "Skin lesion CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
NORTHBRIDGE = {"population": "northbridge-region"}


def read(client, path: str, **params) -> dict:
    response = client.get(f"{API_PREFIX}{path}", params=params)
    assert response.status_code == 200, response.text[:300]
    return response.json()


def map_rows(body: dict) -> dict[str, dict]:
    """concept id → row object, with the appraisal when the map carries it."""
    rows = {}
    for index, values in enumerate(body["rows"]):
        row = dict(zip(body["columns"], values))
        if "appraisal" in body:
            row["appraisal"] = body["appraisal"][index]
        rows[row["concept_id"]] = row
    return rows


def check_counts_match_the_map(client, card: dict, **params) -> dict | None:
    """The summary's appraisal_counts are the map's depth-1 conditions with an evidence grade and,
    of those, the ones whose appraisal is set; every view sends the same counts."""
    overview = read(client, "/atlas/overview", **{key: value for key, value in params.items() if key != "model"})
    body = read(client, "/metrics/map", **card, scope="atlas", **params)
    rows = map_rows(body)
    conditions = [rows[concept["concept_id"]] for concept in overview["conditions"]]
    graded = [row for row in conditions if row["evidence_grade"] is not None]
    linked = [row for row in graded if row.get("appraisal")]
    expected = {"graded": len(graded), "linked": len(linked)} if linked else None
    for view in VIEWS:
        summary = read(client, "/metrics/summary", **card, view=view, **params)
        assert summary.get("appraisal_counts") == expected, (view, params)
    # A block is includes_linked exactly when one of its conditions is linked (ICD-11 reads).
    if "ontology" not in params:
        by_block: dict[str, list] = {}
        for concept in overview["conditions"]:
            by_block.setdefault(concept["parent_id"], []).append(rows[concept["concept_id"]])
        for block in overview["blocks"]:
            children = by_block.get(block["concept_id"], [])
            assert (rows[block["concept_id"]].get("appraisal") == "includes_linked") == any(row.get("appraisal") for row in children)
    return expected


# ------------------------------------------------------------- tiny store

def test_nothing_is_sent_until_a_row_links_a_study(admin_client):
    client = admin_client

    def absent():
        assert "appraisal" not in read(client, "/metrics/map", **TINY, scope="atlas")
        assert "appraisal" not in read(client, "/metrics/map", **TINY, scope="chapter", chapter_id="CH-01")
        for view in VIEWS:
            assert "appraisal_counts" not in read(client, "/metrics/summary", **TINY, view=view)

    absent()
    # A study record that no row names links nothing.
    publish(client, stage_studies(client, study("T-OTHER-1")))
    absent()
    # Rows that name a study without a record (free text) link nothing either.
    publish(client, link_rows(client, "T-STUDY-1"))
    absent()


def test_linked_rows_are_marked_and_counted(admin_client):
    client = admin_client
    publish(client, stage_studies(client, study("T-STUDY-1")))
    publish(client, link_rows(client, "T-STUDY-1"))  # 1A00 at the all-population lens
    atlas = map_rows(read(client, "/metrics/map", **TINY, scope="atlas"))
    assert {concept_id: row["appraisal"] for concept_id, row in atlas.items()} == {"BLK-01": "includes_linked", "1A00": "linked", "1A01": None}
    # The grade is the same with and without the mark: only a study record behind it changes it (§22).
    assert atlas["1A01"]["evidence_grade"] is not None
    chapter = map_rows(read(client, "/metrics/map", **TINY, scope="chapter", chapter_id="CH-01"))
    assert chapter["1A00.0"]["appraisal"] == "linked", "a deeper category follows its anchor"
    assert chapter["1A01"]["appraisal"] is None and chapter["BLK-01"]["appraisal"] == "includes_linked"
    assert check_counts_match_the_map(client, TINY) == {"graded": 2, "linked": 1}
    # Another lens has no linked row: nothing is sent there.
    assert "appraisal" not in read(client, "/metrics/map", **TINY, scope="atlas", age="Age 65+")
    assert "appraisal_counts" not in read(client, "/metrics/summary", **TINY, view="evidence", age="Age 65+")
    # Removing the record unlinks the row: the fields go again.
    publish(client, stage_studies(client, {"study_id": "T-STUDY-1", "action": "Remove"}))
    assert "appraisal" not in read(client, "/metrics/map", **TINY, scope="atlas")


class _WithoutAllPatients:
    """A tiny card's reader without the all-population combination, so All patients falls back (§7)."""

    def __init__(self, reader):
        self.reader = reader
        self.defined_combos = reader.defined_combos - {0}

    def row(self, concept_id, combo_idx):
        return self.reader.row(concept_id, combo_idx)

    def rows_for_concept(self, concept_id, combos):
        return self.reader.rows_for_concept(concept_id, combos)


def test_a_lens_fallback_is_linked_when_one_of_its_rows_is(tiny_client):
    """A condition combined from narrower groups (§7) rests on a study when one of the rows it combines
    does, also when the study moves the signal by exactly 0 (the combined row then keeps no trace of it)."""
    from app.repository import SetStudies
    from app.services.metrics import MetricsService
    from app.services.studies import RowStudies
    from app.services.types import ALL_POPULATIONS, Lens

    stored = tiny_client.app.state.api.store.resolve("live").dataset.metrics("Tiny-1", "CDSS")
    atlas = stored.atlas
    older = atlas.axes.combo_index(Lens("Age 65+", "Sex Female", "Ethnicity Asian"))
    studies = RowStudies(SetStudies(None, {(older, "1A00"): "T-ZERO"}), {"T-ZERO": 0.0})
    service = MetricsService(atlas, _WithoutAllPatients(stored.reader), model_version="Tiny-1", use_case="CDSS", studies=studies)
    row = service.row("1A00", ALL_POPULATIONS)
    assert row.provenance.lens_fallback and row.study_id is None and not row.study_adjustment
    assert service.appraisal("1A00") == "linked" and service.appraisal("BLK-01") == "includes_linked"
    assert service.appraisal("1A01") is None
    assert service.appraisal("1A00", Lens("Age 0-17", "All sexes", "All ethnicities")) is None, "another group: a stored row, not linked"


# ------------------------------------------------------------- demo store

def test_demo_maps_and_summaries_agree(demo_client):
    """SkinAI-1.0's five linked skin conditions; a card without links sends nothing; Vantrel (a product
    whose rows name no study record) neither."""
    assert check_counts_match_the_map(demo_client, SKINAI) == {"graded": 14, "linked": 5}
    rows = map_rows(read(demo_client, "/metrics/map", **SKINAI, scope="atlas"))
    assert {concept_id for concept_id, row in rows.items() if row["appraisal"] == "linked"} == {"2C30", "2C31", "2C32", "2E63", "EK90"}
    for card in ({"model": "SynGPT-1.0", "use_case": "Clinician Facing CDSS"}, {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}):
        assert check_counts_match_the_map(demo_client, card) is None
        assert "appraisal" not in read(demo_client, "/metrics/map", **card, scope="atlas")


def test_local_results_bring_their_hospital_study(demo_client):
    """With Northbridge region chosen, ICU_GPT-1.0's local rows name the hospital study NBR-ICU-LOCAL-2026."""
    default = check_counts_match_the_map(demo_client, ICU)
    local = check_counts_match_the_map(demo_client, ICU, **NORTHBRIDGE)
    assert default and local and local["linked"] > default["linked"]
    rows = map_rows(read(demo_client, "/metrics/map", **ICU, scope="atlas", **NORTHBRIDGE))
    concept = read(demo_client, "/metrics/concepts/1C45", **ICU, **NORTHBRIDGE)["metrics"]
    assert rows["1C45"]["appraisal"] == "linked" and concept["appraisal"]["study"]["study_id"] == "NBR-ICU-LOCAL-2026"


@pytest.mark.parametrize("ontology", ["icd10cm", "mondo"])
def test_other_ontologies_follow_the_icd11_link(ontology_demo_client, ontology):
    """A concept of another classification is linked when the ICD-11 condition it serves is; the counts
    follow the classification's own conditions."""
    client = ontology_demo_client
    for card in (ICU, SKINAI):
        check_counts_match_the_map(client, card, ontology=ontology)
        icd11 = map_rows(read(client, "/metrics/map", **card, scope="atlas"))
        body = read(client, "/metrics/map", **card, scope="atlas", ontology=ontology)
        for row in map_rows(body).values():
            if row.get("appraisal") != "linked":
                continue
            concept = read(client, f"/metrics/concepts/{row['concept_id']}", **card, ontology=ontology)
            target = concept["mapping"]["icd11"]["concept_id"]
            anchor = target if target in icd11 else None
            if anchor is not None:
                assert icd11[anchor]["appraisal"] == "linked", (ontology, row["concept_id"], target)
            assert concept["metrics"]["appraisal"]["study"] is not None
