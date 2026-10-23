"""Across groups: ``getConceptSubgroups`` and the difference rule (contract v1.13, CONTRACT.md §24). All data is synthetic."""

from __future__ import annotations

import pytest
from conftest import local_client
from tiny_tables import AXES, ROW_FORMAT, tiny_tables, write_tables

from app.importers.legacy_json import import_legacy_tables
from app.main import API_PREFIX, create_app
from app.services.subgroups import SUBGROUP_DIFFERENCE, difference, one_group_lenses
from app.services.types import ALL_POPULATIONS, Axes, Lens, MetricValues, Provenance

SYN = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
ICU = {"model": "ICU_GPT-1.0", "use_case": "CDSS"}
VANTREL = {"model": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"}  # a demo product: all-patients rows only
GROUPS = [
    "Age 0-17", "Age 18-39", "Age 40-64", "Age 65+",
    "Sex Female", "Sex Male",
    "Ethnicity White", "Ethnicity Black", "Ethnicity Hispanic", "Ethnicity Asian", "Ethnicity Other",
]


def _row(perf, ci_low=None, ci_high=None) -> MetricValues:
    return MetricValues(
        concept_id="X", lens=ALL_POPULATIONS, perf=perf, ci_low=ci_low, ci_high=ci_high, evidence_grade=None, n_samples=None,
        n_sites=None, n_studies=None, peer_reviewed_studies=None, validation_type=None, in_intended_use=None,
        intended_use_coverage=None, intended_use_level=None, warnings=(), provenance=Provenance("condition"),
    )


# ------------------------------------------------------------------ the rule

def test_the_rule_is_published_as_a_heuristic(client):
    meta = client.get(f"{API_PREFIX}/meta").json()
    assert meta["subgroup_difference"] == SUBGROUP_DIFFERENCE
    assert meta["subgroup_difference"]["min_delta"] == 0.05
    assert meta["subgroup_difference"]["requires_ci_separation"] is True
    assert "not a grade" in meta["subgroup_difference"]["note"].lower()


@pytest.mark.parametrize(
    ("group", "reference", "expected"),
    [
        # Clearly lower, intervals apart: flagged.
        (_row(0.70, 0.66, 0.74), _row(0.80, 0.77, 0.83), {"delta": -0.1, "direction": "lower", "flagged": True, "reason": "separated"}),
        # Higher, intervals apart: flagged.
        (_row(0.90, 0.88, 0.92), _row(0.80, 0.78, 0.82), {"delta": 0.1, "direction": "higher", "flagged": True, "reason": "separated"}),
        # Exactly the threshold (0.85 − 0.80 is 0.04999… in floating point): flagged.
        (_row(0.85, 0.83, 0.87), _row(0.80, 0.78, 0.82), {"delta": 0.05, "direction": "higher", "flagged": True, "reason": "separated"}),
        # Just below the threshold, intervals apart: not flagged.
        (_row(0.849, 0.84, 0.86), _row(0.80, 0.79, 0.81), {"delta": 0.049, "direction": "higher", "flagged": False, "reason": "below_delta"}),
        # Large difference, intervals overlap: not flagged.
        (_row(0.70, 0.60, 0.80), _row(0.80, 0.75, 0.85), {"delta": -0.1, "direction": "lower", "flagged": False, "reason": "ci_overlap"}),
        # Touching bounds count as overlapping.
        (_row(0.70, 0.65, 0.75), _row(0.80, 0.75, 0.85), {"delta": -0.1, "direction": "lower", "flagged": False, "reason": "ci_overlap"}),
        # A missing interval on either side: never flagged.
        (_row(0.70), _row(0.80, 0.78, 0.82), {"delta": -0.1, "direction": "lower", "flagged": False, "reason": "missing_ci"}),
        (_row(0.70, 0.68, 0.72), _row(0.80, None, 0.82), {"delta": -0.1, "direction": "lower", "flagged": False, "reason": "missing_ci"}),
        # No value on either side.
        (_row(None), _row(0.80, 0.78, 0.82), {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}),
        (_row(0.80, 0.78, 0.82), _row(None), {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}),
        (None, _row(0.80, 0.78, 0.82), {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}),
        (_row(0.80, 0.78, 0.82), None, {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}),
        # Equal values: no direction.
        (_row(0.80, 0.78, 0.82), _row(0.80, 0.70, 0.90), {"delta": 0.0, "direction": None, "flagged": False, "reason": "below_delta"}),
    ],
)
def test_difference_rule(group, reference, expected):
    assert difference(group, reference) == expected


def test_without_ci_separation_the_delta_alone_flags():
    rule = {**SUBGROUP_DIFFERENCE, "requires_ci_separation": False}
    assert difference(_row(0.70), _row(0.80), rule)["flagged"] is True


def test_one_group_lenses_name_each_specific_value_once():
    axes = Axes(context=("Clinical",), age=tuple(AXES["age_lens"]), sex=tuple(AXES["sex_lens"]), ethnicity=tuple(AXES["ethnicity_lens"]))
    lenses = one_group_lenses(axes)
    assert [value for _, value, _ in lenses] == GROUPS
    assert lenses[0] == ("age", "Age 0-17", Lens(age="Age 0-17"))
    assert lenses[4] == ("sex", "Sex Female", Lens(sex="Sex Female"))
    assert lenses[-1] == ("ethnicity", "Ethnicity Other", Lens(ethnicity="Ethnicity Other"))


# ------------------------------------------------------------------- the read

def _subgroups(client, concept_id: str, **params):
    response = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}/subgroups", params=params)
    assert response.status_code == 200, response.text[:300]
    return response


def _concept(client, concept_id: str, **params) -> dict:
    response = client.get(f"{API_PREFIX}/metrics/concepts/{concept_id}", params=params)
    assert response.status_code == 200, response.text[:300]
    return response.json()


@pytest.mark.parametrize("concept_id", ["5A11", "1A03.1", "BLK-01-BlockL1-1A0", "CH-05"])
def test_each_entry_is_what_the_concept_read_serves_at_its_lens(client, concept_id):
    body = _subgroups(client, concept_id, **SYN).json()
    assert body["concept"]["concept_id"] == concept_id
    assert body["filters"] == {**SYN, "context": "Clinical"}
    assert [entry["group"] for entry in body["groups"]] == GROUPS
    assert body["all_patients"]["axis"] == "all" and body["all_patients"]["group"] is None
    assert "difference" not in body["all_patients"]
    for entry in [body["all_patients"], *body["groups"]]:
        lens = entry["lens"]
        served = _concept(client, concept_id, **SYN, **lens)
        row = served["metrics"]
        assert entry["has_result"] is (row is not None)
        if row is None:
            assert entry["n_samples"] is None and entry["n_sites"] is None  # v1.14: no row, no size
            continue
        # v1.14 (§24): the group's size is the served row's.
        for key in ("perf", "ci_low", "ci_high", "performance_grade", "evidence_grade", "overall", "status", "intended_use_level", "provenance", "n_samples", "n_sites"):
            assert entry[key] == row[key], (concept_id, lens, key)
        if entry["axis"] != "all":
            assert lens[entry["axis"]] == entry["group"]
            assert sum(value.startswith("All ") for value in lens.values()) == 2


def test_flags_follow_the_published_rule(client):
    body = _subgroups(client, "5A11", **SYN).json()
    reference = body["all_patients"]
    for entry in body["groups"]:
        delta = round(entry["perf"] - reference["perf"], 3)
        separated = entry["ci_low"] > reference["ci_high"] or entry["ci_high"] < reference["ci_low"]
        assert entry["difference"]["delta"] == delta
        assert entry["difference"]["flagged"] is (abs(delta) + 1e-9 >= 0.05 and separated)


def test_one_request_carries_etag_and_version(client):
    response = _subgroups(client, "5A11", **SYN)
    assert response.headers["X-Dataset-Version"] == "1"
    etag = response.headers["ETag"]
    again = client.get(f"{API_PREFIX}/metrics/concepts/5A11/subgroups", params=SYN, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert len(response.content) < 20_000  # far below the §10 budget


def test_safety_marks_follow_each_lens(demo_client):
    body = _subgroups(demo_client, "5A11", **SYN).json()
    for entry in [body["all_patients"], *body["groups"]]:
        served = _concept(demo_client, "5A11", **SYN, **entry["lens"])
        worst = {incident["severity"] for incident in served["incidents"]}
        expected = "serious" if "serious" in worst else "caution" if "caution" in worst else None
        assert entry["safety"] == expected


def test_a_product_with_only_all_patient_rows_has_no_group_results(demo_client):
    """A product stores only the all-patients lens: no group has a result, none is flagged."""
    body = _subgroups(demo_client, "1A00", **VANTREL).json()
    assert body["all_patients"]["has_result"] is True and body["all_patients"]["perf"] is not None
    for entry in body["groups"]:
        assert entry["has_result"] is False
        assert entry["status"] == {"overall": "no_data", "performance": "no_data", "evidence": "no_data"}
        assert entry["provenance"] is None
        assert entry["difference"] == {"delta": None, "direction": None, "flagged": False, "reason": "no_result"}
    # A subchapter of the product: rollups without children at every group.
    block = _subgroups(demo_client, "BLK-01-BlockL1-1A0", **VANTREL).json()
    for entry in block["groups"]:
        assert entry["perf"] is None and entry["provenance"]["rollup"]["child_count"] == 0
        assert entry["difference"]["reason"] == "no_result"


def test_a_local_population_is_named_and_keyed(demo_client):
    default = _subgroups(demo_client, "CH-05", **SYN)
    local = _subgroups(demo_client, "CH-05", **SYN, population="northbridge-region")
    assert "population" not in default.json()
    assert local.json()["population"] == {"id": "northbridge-region", "name": "Northbridge region (fictional)"}
    assert local.headers["X-Population"] == "northbridge-region"
    assert local.headers["ETag"] != default.headers["ETag"]
    served = _concept(demo_client, "CH-05", **SYN, population="northbridge-region")
    assert local.json()["all_patients"]["perf"] == served["metrics"]["perf"]


def test_local_results_compare_like_with_like(demo_client):
    """§24: with Northbridge's local results (pack v7) a public group is compared with the public
    all-patients result, never with the local one; the local Age 65+ result with the local one."""
    default = _subgroups(demo_client, "1C45", **ICU).json()
    local = _subgroups(demo_client, "1C45", **ICU, population="northbridge-region").json()
    assert local["all_patients"]["layer"] == "local" and local["all_patients"]["provenance"]["layer"] == "local"
    public = local["public_all_patients"]
    assert public["layer"] == "public" and public["perf"] == default["all_patients"]["perf"]
    assert local["all_patients"]["perf"] != public["perf"]
    plain = {group["group"]: group for group in default["groups"]}
    local_groups = 0
    for group in local["groups"]:
        if group["layer"] == "local":
            local_groups += 1
            assert group["difference"]["compared_with"] == "local"
            assert group["difference"]["delta"] == round(group["perf"] - local["all_patients"]["perf"], 3)
        else:
            assert group["difference"]["compared_with"] == "public"
            assert {k: v for k, v in group["difference"].items() if k != "compared_with"} == plain[group["group"]]["difference"]
    assert local_groups == 1
    # A chapter with local conditions: both sides include local results, so they are compared as served.
    chapter = _subgroups(demo_client, "CH-01", **ICU, population="northbridge-region").json()
    assert chapter["all_patients"]["layer"] == "includes_local" and "public_all_patients" in chapter
    # Without the population, and for a card without local results, the answer has no layer fields.
    for body in (default, _subgroups(demo_client, "1C45", **SYN, population="northbridge-region").json()):
        assert "public_all_patients" not in body and "layer" not in body["all_patients"]
        assert all("layer" not in group and "compared_with" not in group["difference"] for group in body["groups"])


def test_errors(client):
    assert client.get(f"{API_PREFIX}/metrics/concepts/NOPE/subgroups", params=SYN).json()["code"] == "unknown_concept"
    assert client.get(f"{API_PREFIX}/metrics/concepts/5A11/subgroups", params={"model": "Nope", "use_case": "CDSS"}).json()["code"] == "unknown_model"
    missing = client.get(f"{API_PREFIX}/metrics/concepts/5A11/subgroups", params={"model": "SynGPT-2.0"})
    assert missing.status_code == 422
    staged = client.get(f"{API_PREFIX}/metrics/concepts/5A11/subgroups", params={**SYN, "version": "staged:nope"})
    assert staged.status_code == 404 and staged.json()["code"] == "unknown_upload"


# ------------------------------------------------------------ lens fallback

def _specific_only_tables() -> dict:
    """The tiny tables with only fully specific combinations (no "All …" on any axis), so
    every one-group lens and all patients are worked out by lens fallback (CONTRACT.md §7)."""
    tables = tiny_tables()
    metrics = tables["models/tiny-1.cdss.metrics.json"]
    combos = [combo for combo in metrics["combo_definitions"] if not any(value.startswith("All ") for value in combo.values() if value not in ("CDSS", "Clinical"))]

    def tuple_for(perf, ci):
        return [perf, None if ci is None else perf - ci, None if ci is None else perf + ci, "B", 500, 3, 4, 3, "benchmark", 1, 1, "in_scope", []]

    # 1A00: older patients do much better (narrow intervals); 1A01: no confidence intervals at all.
    metrics["combo_count"] = len(combos)
    metrics["combo_definitions"] = combos
    metrics["rows_by_condition_id"] = {
        "1A00": [tuple_for(0.95 if combo["age_lens"] == "Age 65+" else 0.75, 0.01) for combo in combos],
        "1A01": [tuple_for(0.95 if combo["age_lens"] == "Age 65+" else 0.75, None) for combo in combos],
    }
    assert len(ROW_FORMAT) == 13
    return tables


@pytest.fixture(scope="module")
def fallback_client(tmp_path_factory):
    root = tmp_path_factory.mktemp("subgroups")
    store = root / "fallback.sqlite"
    import_legacy_tables(write_tables(root / "tables", _specific_only_tables()), store)
    with local_client(create_app(store, validate_responses=True)) as test_client:
        yield test_client


def test_fallback_rows_are_marked_and_compared(fallback_client):
    tiny = {"model": "Tiny-1", "use_case": "CDSS"}
    body = _subgroups(fallback_client, "1A00", **tiny).json()
    assert body["all_patients"]["provenance"]["lens_fallback"] is True
    by_group = {entry["group"]: entry for entry in body["groups"]}
    assert all(entry["provenance"]["lens_fallback"] is True for entry in body["groups"])
    assert by_group["Age 65+"]["perf"] == 0.95
    assert by_group["Age 65+"]["difference"]["flagged"] is True
    assert by_group["Age 65+"]["difference"]["direction"] == "higher"
    assert by_group["Age 0-17"]["difference"]["direction"] == "lower"
    # Without confidence intervals nothing is flagged, however large the difference.
    no_ci = _subgroups(fallback_client, "1A01", **tiny).json()
    older = next(entry for entry in no_ci["groups"] if entry["group"] == "Age 65+")
    assert older["ci_low"] is None and older["difference"] == {"delta": older["difference"]["delta"], "direction": "higher", "flagged": False, "reason": "missing_ci"}
    assert abs(older["difference"]["delta"]) >= 0.05


# ------------------------------------------------------------ ontologies (§23)

def test_another_ontology_resolves_like_the_concept_read(ontology_client):
    """A mapped condition compares the groups of its ICD-11 row; the body names the ontology and the mapping."""
    for ontology, concept_id, target in (("mondo", "MONDO:9000011", "5A11"), ("icd10cm", "E11.9", "5A11"), ("mondo", "MONDO:9000022", "BA00")):
        response = _subgroups(ontology_client, concept_id, **SYN, ontology=ontology)
        body = response.json()
        assert response.headers["X-Ontology"] == ontology
        assert body["ontology"]["id"] == ontology
        assert body["mapping"]["icd11"]["concept_id"] == target
        assert body["concept"]["concept_id"] == concept_id
        icd11 = _subgroups(ontology_client, target, **SYN).json()
        assert "ontology" not in icd11 and "mapping" not in icd11
        for projected, plain in zip([body["all_patients"], *body["groups"]], [icd11["all_patients"], *icd11["groups"]]):
            for key in ("perf", "ci_low", "ci_high", "status", "overall", "safety", "difference"):
                assert projected.get(key) == plain.get(key), (concept_id, key)
            assert projected["provenance"]["data_source"] == plain["provenance"]["data_source"]
        served = _concept(ontology_client, concept_id, **SYN, ontology=ontology)
        assert served["mapping"] == body["mapping"]


def test_an_unmapped_concept_has_no_results_and_its_mapping(ontology_client):
    body = _subgroups(ontology_client, "E12", **SYN, ontology="icd10cm").json()
    assert body["mapping"]["kind"] == "none"
    assert body["all_patients"]["has_result"] is False
    assert all(entry["has_result"] is False and entry["difference"]["reason"] == "no_result" for entry in body["groups"])


def test_ontology_keys_the_cache_and_icd11_is_unchanged(ontology_client, client):
    plain = _subgroups(client, "5A11", **SYN)
    explicit = _subgroups(ontology_client, "5A11", **SYN, ontology="icd11")
    assert explicit.content == plain.content and "X-Ontology" not in explicit.headers
    mondo = _subgroups(ontology_client, "MONDO:9000011", **SYN, ontology="mondo")
    assert mondo.headers["ETag"] != plain.headers["ETag"]
    bad = ontology_client.get(f"{API_PREFIX}/metrics/concepts/5A11/subgroups", params={**SYN, "ontology": "Not An Id"})
    assert bad.status_code == 422


def test_one_read_keeps_every_lens_it_visits(demo_client):
    """Review fix: the per-card caches keep more lenses than one Across groups
    read visits (all patients and the 11 one-group lenses). With 8 they evicted
    every lens of a read before the next read needed it again, so chapter
    reads recomputed every rollup each time."""
    from app.services.types import LENS_CACHE_SIZE

    client = demo_client  # SynGPT-2.0 has safety incidents there, so its marks are cached too
    store = client.app.state.api.store
    chapter = client.get(f"{API_PREFIX}/meta").json()["chapters"][0]["concept_id"]
    assert client.get(f"{API_PREFIX}/metrics/concepts/{chapter}/subgroups", params=SYN).status_code == 200
    with store.lock:
        dataset = store.resolve("live").dataset
        service = dataset.metrics(*SYN.values())
        safety = dataset.card_safety(*SYN.values())
    lenses = [lens for _, _, lens in one_group_lenses(dataset.atlas.axes)] + [ALL_POPULATIONS]
    assert len(lenses) == 12 < LENS_CACHE_SIZE
    assert all(service._cache.peek(lens) for lens in lenses)  # every lens's rows are still there
    assert all(safety._marks.peek(lens) is not None for lens in lenses)
