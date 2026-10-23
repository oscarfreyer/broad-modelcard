"""The comparison of 2 to 4 cards (contract v1.13, CONTRACT.md §25).

``getComparison`` puts cards side by side over the same rows: at atlas scope
one row per chapter of the chosen ontology, at chapter scope the chapter's
subchapters (blocks), each followed by its depth-1 conditions. Every cell is
what the atlas map serves for that card and concept at the requested lens,
population, and ontology. On top of the cells the backend decides, per row,
whether the cards' results are **directly comparable**, and if not, why: a
list of reason codes, each with the cards it concerns.

The rule is a deterministic prototype heuristic, published in
``/meta.comparison`` and documented in CONTRACT.md §25. It never changes a
grade or a status; it only says where a side-by-side reading needs care.

Reasons, in the order they are listed:

* card level (they hold on every row): ``function_category_differs`` (the
  cards' functions are in different categories), ``function_category_unknown``
  (a card states no category), ``population_differs`` (the lens is a group or,
  since v1.14 (§29), a specific care setting, and a card stores no data for it
  while another card does: a card without rows at the setting is treated like
  a card without the group);
* row level: ``no_mapping`` (the concept has no ICD-11 mapping), ``mapped_broader``
  (a condition mapped through its ICD-11 subchapter or a parent, so the result
  describes more than the concept), ``no_result`` (a card shows No data),
  ``out_of_scope`` (a card's result is out of its intended use),
  ``lens_fallback`` (a card's result was combined from narrower groups while
  another card's was stored for the group), ``design_differs`` (the results
  come from evidence of different design groups).

Since contract v1.14 (release 0.5): the card-level
reasons ``measure_differs`` (the cards state different performance measures)
and ``measure_unknown`` (a card states none while another states one), and the
row-level reason ``setting_differs`` (the linked studies of the cards with a
result name different care settings). Cells add ``layer`` (§26.1) and
``setting_category`` and card facts add what the figures measure, the
configuration, the narrow model card, and who conducted the linked studies,
each only where it applies (see ``q4_card_facts`` and ``q4_cell_fields``).

All data is synthetic demonstration data.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .. import repository
from ..repository import ModelRecord, StudyRecord, UseCaseRecord
from ..schema.contract import ANY_SETTING, STUDY_CONDUCTORS, STUDY_DESIGNS, measure_key
from . import grading
from .metrics import defined_expansion
from .presentation import rollup_child_count
from .types import ALL_POPULATIONS, Concept, Lens, MetricValues

MIN_CARDS = 2
MAX_CARDS = 4

# Design groups (CONTRACT.md §25): the kind of evidence behind a result. A
# result's group is its linked study's design when a stored row links one
# (§22), else its validation type (§4.1). Results in different groups are not
# directly comparable: a clinical study measures a system in care, a test-case
# evaluation on cases built or chosen for testing, an internal test on the
# developer's own data.
DESIGN_GROUPS: dict[str, dict[str, tuple[str, ...]]] = {
    "clinical_study": {
        "validation_types": ("clinical_study_multisite", "clinical_study_single_site"),
        "study_designs": ("retrospective", "prospective", "real_world_deployment", "randomized_trial"),
    },
    "test_cases": {
        "validation_types": ("benchmark", "vignette_study", "simulation_study"),
        "study_designs": ("benchmark", "vignette", "simulation"),
    },
    "internal_test": {"validation_types": ("internal_test",), "study_designs": ()},
}
_GROUP_OF_TYPE = {vt: group for group, members in DESIGN_GROUPS.items() for vt in members["validation_types"]}
_GROUP_OF_DESIGN = {design: group for group, members in DESIGN_GROUPS.items() for design in members["study_designs"]}
assert set(_GROUP_OF_DESIGN) == set(STUDY_DESIGNS), "every study design belongs to a design group"

# Contract v1.14 (Q4) appends measure_differs and measure_unknown to the card-level
# reasons and setting_differs to the row-level ones; the earlier codes keep their order.
CARD_REASONS = ("function_category_differs", "function_category_unknown", "population_differs", "measure_differs", "measure_unknown")
ROW_REASONS = ("no_mapping", "mapped_broader", "no_result", "out_of_scope", "lens_fallback", "design_differs", "setting_differs")
# A study's setting category that names no one setting (§22): it never makes settings differ.
MIXED_SETTING = "mixed"
# A cell's layer (§26.1) when the card has local results for the population but the result is public.
PUBLIC_LAYER = "public"
REASONS = (*CARD_REASONS, *ROW_REASONS)
RESULT_STATUSES = ("strong", "moderate", "weak")
BROADER_MAPPINGS = ("block", "parent")

# /meta.comparison (contract v1.13, CONTRACT.md §25).
COMPARISON_META = {
    "min_cards": MIN_CARDS,
    "max_cards": MAX_CARDS,
    "reasons": list(REASONS),
    "design_groups": {
        group: {"validation_types": list(members["validation_types"]), "study_designs": list(members["study_designs"])}
        for group, members in DESIGN_GROUPS.items()
    },
    "heuristic": True,
}


def design_group(validation_type: str | None, study_design: str | None) -> str | None:
    """The design group of a result: its linked study's design first, else its validation type."""
    if study_design is not None:
        return _GROUP_OF_DESIGN.get(study_design)
    return _GROUP_OF_TYPE.get(validation_type) if validation_type else None


def reference_group(values: list) -> object:
    """The most common value, the first of equally common ones (the card order decides ties)."""
    counts = Counter(values)
    best = max(counts.values())
    return next(value for value in values if counts[value] == best)


@dataclass(frozen=True)
class CardRef:
    """One requested card: its registry entry, its function, and its id."""

    card_id: str
    model: ModelRecord
    variant: UseCaseRecord


@dataclass
class CardFacts:
    """What the comparison needs to know about a card, besides its cells."""

    ref: CardRef
    metrics: object  # MetricsService or ProjectedMetrics
    safety: object  # CardSafety or ProjectedSafety
    lens_state: str  # 'stored' | 'fallback' | 'none'


def parse_cards(value: str) -> list[tuple[str, str]]:
    """``cards=<model_version>|<use_case>,…``: 2 to 4 distinct card ids.

    Raises ``ValueError`` with a plain message; the route turns it into 422 ``invalid_cards``."""
    ids = [part.strip() for part in value.split(",")] if value else []
    if not MIN_CARDS <= len(ids) <= MAX_CARDS:
        raise ValueError(f"Compare {MIN_CARDS} to {MAX_CARDS} cards; got {len(ids)}.")
    pairs = []
    for card_id in ids:
        model, sep, use_case = card_id.partition("|")
        if not sep or not model or not use_case or "|" in use_case or len(card_id) > 300:
            raise ValueError(f"Invalid card id {card_id!r}; expected <model_version>|<use_case>.")
        pairs.append((model, use_case))
    if len(set(pairs)) != len(pairs):
        raise ValueError("A card is named twice; name each card once.")
    return pairs


def _stored_combos(icd) -> frozenset[int]:
    """The lens combinations a card's rows are stored for: its public set's and,
    for a local population (§26.1), its local results' (served there as well)."""
    defined = icd.reader.defined_combos
    return defined | icd.local.reader.defined_combos if icd.local is not None else defined


def lens_state(metrics, lens: Lens) -> str:
    """Whether a card stores the lens (``stored``), only narrower groups under it
    (``fallback``, §7, over the public rows), or nothing for it (``none``)."""
    icd = getattr(metrics, "icd", metrics)  # a projected service reads through its ICD-11 one
    axes = icd.atlas.axes
    if axes.combo_index(lens) in _stored_combos(icd):
        return "stored"
    return "fallback" if defined_expansion(lens, axes, icd.reader.defined_combos) else "none"


def _stored_lenses(metrics, setting: str = ANY_SETTING) -> tuple[int, int, bool, list[str]]:
    """``(stored, total, all_patients_only)`` within the requested setting (contract v1.14, §29), so
    Any-setting facts never count a specific setting's rows, and the settings the card stores."""
    icd = getattr(metrics, "icd", metrics)
    axes = icd.atlas.axes
    stored = _stored_combos(icd)
    defined = axes.setting_combos(stored, setting)
    all_patients = axes.combo_index(Lens(setting=setting))
    return len(defined), axes.per_setting, defined == frozenset({all_patients}), axes.settings_of(stored)


def _card_studies(
    dataset, model: ModelRecord, variant: UseCaseRecord, setting: str = ANY_SETTING, *, stores_setting: bool = True
) -> list[StudyRecord]:
    """The study records linked to any stored row of the card (§22) at the requested
    setting (v1.14, §29; a set's default source counts at every setting the card
    stores): its public rows and, for a local population, its local results
    (§26.1), in stored order."""
    key = (model.model_version, variant.use_case)
    axes = dataset.atlas.axes
    linked = set()
    for set_id in (dataset.state.metric_sets.get(key), dataset.local_set_id(*key)):
        row_studies = dataset.studies.for_set(set_id) if set_id is not None else None
        if row_studies is not None:
            links = row_studies.links
            linked.update(
                study_id
                for (combo_idx, _), study_id in links.rows.items()
                if study_id is not None and axes.setting_of_index(combo_idx) == setting
            )
            if links.default is not None and stores_setting:
                linked.add(links.default)
    return [study for study_id, study in dataset.studies.records.items() if study_id in linked]


def _validation_types(dataset, conditions, model: ModelRecord, variant: UseCaseRecord, lens: Lens) -> list[str]:
    """The validation types of the card's depth-1 ICD-11 conditions at the lens, in §4.2 order."""
    metrics = dataset.metrics(model.model_version, variant.use_case)
    found = set()
    for condition in conditions:
        row = metrics.row(condition.concept_id, lens)
        if row is not None and row.validation_type:
            found.add(row.validation_type)
    return [vt for vt in grading.VALIDATION_TYPE_SCORES if vt in found]


def card_payload(dataset, conditions, facts: CardFacts, lens: Lens) -> dict:
    """openapi.json ``ComparisonCard``: the header facts of one card. ``conditions``
    are the ICD-11 depth-1 conditions (a card's facts do not depend on the ontology)."""
    model, variant = facts.ref.model, facts.ref.variant
    stored, total, all_patients_only, settings = _stored_lenses(facts.metrics, lens.setting)
    studies = _card_studies(dataset, model, variant, lens.setting, stores_setting=lens.is_any_setting or lens.setting in settings)
    validation_types = _validation_types(dataset, conditions, model, variant, lens)
    groups = {design_group(vt, None) for vt in validation_types} | {design_group(None, s.design) for s in studies}
    return {
        "card_id": facts.ref.card_id,
        "model_version": model.model_version,
        "use_case": variant.use_case,
        "display_name": model.display_name,
        "kind": model.kind,
        "developer": model.developer,
        "status": model.status or "ACTIVE",
        "function_category": variant.function_category,
        "intended_use_defined": variant.intended_use_defined,
        "lenses": {
            "stored": stored,
            "total": total,
            "all_patients_only": all_patients_only,
            "requested": facts.lens_state,
            # Contract v1.14 (§29): the settings the card stores rows for, Any setting first; sent only
            # when it stores a specific one, so every other card's facts keep their bytes.
            **({"settings": settings} if any(setting != ANY_SETTING for setting in settings) else {}),
        },
        "studies": [study.as_dict() for study in studies],
        "validation_types": validation_types,
        "design_groups": [group for group in DESIGN_GROUPS if group in groups],
        **q4_card_facts(dataset, model, variant, studies),
    }


def q4_card_facts(dataset, model: ModelRecord, variant: UseCaseRecord, studies: list[StudyRecord]) -> dict:
    """The card facts of contract v1.14 (CONTRACT.md §25), after the v1.13 ones.

    ``performance_measure`` and ``reference_standard`` (§28.1) each when given, and
    ``configuration`` (its id and date) when the card states either, so a card without
    them keeps those keys out; ``narrow_model_card`` (whether the AI system has one, §26.4,
    and when it was submitted) and ``conductors`` (the linked studies by who conducted
    them) are always sent."""
    facts: dict = {}
    for name in ("performance_measure", "reference_standard"):
        value = getattr(variant, name)
        if value is not None:
            facts[name] = value
    if variant.configuration_id is not None or variant.configuration_date is not None:
        facts["configuration"] = {"configuration_id": variant.configuration_id, "configuration_date": variant.configuration_date}
    submitted = narrow_model_card_dates(dataset).get(model.model_version)
    facts["narrow_model_card"] = {"present": submitted is not None, "submitted_at": submitted}
    counts = Counter(study.conducted_by for study in studies)
    facts["conductors"] = {conductor: counts.get(conductor, 0) for conductor in STUDY_CONDUCTORS}
    return facts


def narrow_model_card_dates(dataset) -> dict[str, str]:
    """AI system → when its narrow model card (§26.4) was submitted, for the version read."""
    set_id = dataset.state.model_cards_set_id
    return {card.model_version: card.submitted_at for card in repository.load_model_cards(dataset.connection, set_id)}


def measure_reasons(cards: list[CardFacts]) -> list[dict]:
    """``measure_differs`` and ``measure_unknown`` (contract v1.14, CONTRACT.md §25).

    Both need at least one card that states its performance measure (§28.1): when none
    does, the cards predate the field and nothing is flagged, so such a comparison reads
    as it did under v1.13. ``measure_differs`` concerns the cards outside the most common
    measure (the first card's on a tie), ``measure_unknown`` the cards that state none."""
    measures = [facts.ref.variant.performance_measure for facts in cards]
    keys = [measure_key(measure) if measure else None for measure in measures]
    stated = [key for key in keys if key]
    if not stated:
        return []
    reasons = []
    if len(set(stated)) > 1:
        reference = reference_group(stated)
        reasons.append(_reason("measure_differs", [f for f, key in zip(cards, keys) if key and key != reference]))
    if len(stated) < len(keys):
        reasons.append(_reason("measure_unknown", [f for f, key in zip(cards, keys) if not key]))
    return reasons


def card_reasons(cards: list[CardFacts], lens: Lens) -> list[dict]:
    """The reasons that hold on every row (CONTRACT.md §25), in REASONS order."""
    reasons = []
    categories = [facts.ref.variant.function_category for facts in cards]
    stated = [category for category in categories if category]
    if len(set(stated)) > 1:
        reference = reference_group(stated)
        reasons.append(_reason("function_category_differs", [f for f, c in zip(cards, categories) if c and c != reference]))
    if len(stated) < len(categories):
        reasons.append(_reason("function_category_unknown", [f for f, c in zip(cards, categories) if not c]))
    if lens != ALL_POPULATIONS:
        lacking = [facts for facts in cards if facts.lens_state == "none"]
        if lacking and len(lacking) < len(cards):
            reasons.append(_reason("population_differs", lacking))
    reasons.extend(measure_reasons(cards))  # contract v1.14 (Q4)
    return reasons


def _reason(code: str, cards: list[CardFacts]) -> dict:
    return {"code": code, "cards": [facts.ref.card_id for facts in cards]}


_EMPTY_CELL = {
    "status": "no_data",
    "performance_status": "no_data",
    "evidence_status": "no_data",
    "perf": None,
    "ci_low": None,
    "ci_high": None,
    "evidence_grade": None,
    "validation_type": None,
    "study_design": None,
    "design_group": None,
    "lens_fallback": False,
}


def cell(row: MetricValues | None, safety_mark: str | None, mapping: str | None, studies, layer: str | None = None) -> dict:
    """openapi.json ``ComparisonCell``: what the atlas shows for one card and concept.

    ``status`` is the Overview status as clients present it: a rollup without
    children and a concept without an ICD-11 mapping read ``no_data`` (§6, §13),
    and a ``no_data`` cell carries no values. ``studies`` is the version's
    ``StudyIndex``, for the design of a linked study (§22). ``layer`` is the
    result's §26.1 layer when the card has local results for the population
    (``cell_layer``), else None (contract v1.14)."""
    status = grading.overall_status(grading.overall_for(row))
    if row is None or mapping == "none" or rollup_child_count(row) == 0 or status == "no_data":
        return {**_EMPTY_CELL, "safety": safety_mark}
    study = studies.get(row.study_id) if row.study_id is not None else None
    study_design = study.design if study is not None else None
    return {
        "status": status,
        "performance_status": grading.performance_status(row),
        "evidence_status": grading.evidence_status(row),
        "perf": row.perf,
        "ci_low": row.ci_low,
        "ci_high": row.ci_high,
        "evidence_grade": row.evidence_grade,
        "validation_type": row.validation_type,
        "study_design": study_design,
        "design_group": design_group(row.validation_type, study_design),
        "lens_fallback": row.provenance.lens_fallback,
        "safety": safety_mark,
        **q4_cell_fields(study, layer),
    }


def q4_cell_fields(study: StudyRecord | None, layer: str | None) -> dict:
    """The cell fields of contract v1.14 (CONTRACT.md §25), on a cell with values only:
    ``layer`` (local, includes_local, or public) when the card has local results for the
    population (§26.1), and ``setting_category``, the linked study's (§22), when it states
    one. Both are left out otherwise, so every other cell reads as under v1.13."""
    fields = {}
    if layer is not None:
        fields["layer"] = layer
    if study is not None and study.setting_category is not None:
        fields["setting_category"] = study.setting_category
    return fields


def cell_layer(metrics, concept_id: str, lens: Lens) -> str | None:
    """A cell's §26.1 layer (contract v1.14): ``local`` or ``includes_local`` as the atlas map's
    ``layer`` says, else ``public``; None for a card without local results for the population."""
    icd = getattr(metrics, "icd", metrics)  # a projected service reads through its ICD-11 one
    if icd.local is None:
        return None
    return metrics.layer(concept_id, lens) or PUBLIC_LAYER


def setting_reasons(cards: list[CardFacts], cells: list[dict]) -> list[dict]:
    """``setting_differs`` (contract v1.14, CONTRACT.md §25): among the cards with a result
    whose linked study states a setting category (§22), the categories span at least two.
    ``mixed`` names no one setting and does not count, nor does a study that states none.
    Concerns the cards outside the most common category (the first card's on a tie)."""
    settled = [
        (facts, c["setting_category"])
        for facts, c in zip(cards, cells)
        if c["status"] in RESULT_STATUSES and c.get("setting_category") not in (None, MIXED_SETTING)
    ]
    if len({setting for _, setting in settled}) < 2:
        return []
    reference = reference_group([setting for _, setting in settled])
    return [_reason("setting_differs", [facts for facts, setting in settled if setting != reference])]


def row_reasons(cards: list[CardFacts], cells: list[dict], mapping: str | None, level: int) -> list[dict]:
    """The row-level reasons (CONTRACT.md §25), in REASONS order."""
    reasons = []
    if mapping == "none":
        return [_reason("no_mapping", cards)]
    if level == 2 and mapping in BROADER_MAPPINGS:
        reasons.append(_reason("mapped_broader", cards))
    with_result = [(facts, c) for facts, c in zip(cards, cells) if c["status"] in RESULT_STATUSES]
    no_result = [facts for facts, c in zip(cards, cells) if c["status"] == "no_data"]
    out_of_scope = [facts for facts, c in zip(cards, cells) if c["status"] == "out_of_scope"]
    if no_result:
        reasons.append(_reason("no_result", no_result))
    if out_of_scope:
        reasons.append(_reason("out_of_scope", out_of_scope))
    fell_back = [facts for facts, c in with_result if c["lens_fallback"]]
    if fell_back and len(fell_back) < len(with_result):
        reasons.append(_reason("lens_fallback", fell_back))
    grouped = [(facts, c["design_group"]) for facts, c in with_result if c["design_group"] is not None]
    if len({group for _, group in grouped}) > 1:
        reference = reference_group([group for _, group in grouped])
        reasons.append(_reason("design_differs", [facts for facts, group in grouped if group != reference]))
    reasons.extend(setting_reasons(cards, cells))  # contract v1.14 (Q4)
    return reasons


def perf_spread(cells: list[dict]) -> float | None:
    """The largest difference in performance between cards with a result, or None for fewer than two."""
    values = [c["perf"] for c in cells if c["status"] in RESULT_STATUSES and c["perf"] is not None]
    if len(values) < 2:
        return None
    return round(max(values) - min(values), 3)


def scope_concepts(catalog, scope: str, chapter_id: str | None) -> list[Concept]:
    """The rows' concepts: every chapter (atlas), or a chapter's blocks, each followed by its depth-1 conditions."""
    if scope == "atlas":
        return list(catalog.chapters)
    chapter = catalog.chapter(chapter_id)
    concepts = []
    for block in catalog.blocks_of(chapter.concept_id):
        concepts.append(block)
        concepts.extend(catalog.atlas.conditions_by_block.get(block.concept_id, ()))
    return concepts


def comparison_rows(view, cards: list[CardFacts], concepts: list[Concept], lens: Lens, shared: list[dict]) -> list[dict]:
    """openapi.json ``ComparisonRow`` for every concept; ``shared`` are the card-level reasons."""
    studies = view.context.dataset.studies
    mappings = view.projection.map_mappings(concepts) if view.projection is not None else [None] * len(concepts)
    rows = []
    for concept, mapping in zip(concepts, mappings):
        cells = [
            cell(
                facts.metrics.row(concept.concept_id, lens),
                facts.safety.mark(concept, lens),
                mapping,
                studies,
                cell_layer(facts.metrics, concept.concept_id, lens),
            )
            for facts in cards
        ]
        reasons = [*shared, *row_reasons(cards, cells, mapping, concept.level)]
        record = view.catalog.record(concept.concept_id)
        rows.append(
            {
                "concept_id": concept.concept_id,
                "code": record.get("code") or record.get("icd11_code"),
                "pt": concept.pt,
                "level": concept.level,
                "parent_id": concept.parent_id,
                "chapter_no": concept.chapter_no,
                "mapping": mapping,
                "cells": cells,
                "comparable": not reasons,
                "reasons": reasons,
                "perf_spread": perf_spread(cells),
            }
        )
    return rows
