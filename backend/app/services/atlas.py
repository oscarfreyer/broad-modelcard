"""Concept hierarchy, metric anchors, and prevalence (CONTRACT.md §5)."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import replace
from functools import cached_property

from .. import repository
from ..schema.contract import PREVALENCE_TIERS
from .jsnum import is_finite
from .types import Axes, Concept

PREVALENCE_TIER_SCORES = {"very_rare": 0.04, "rare": 0.12, "uncommon": 0.25, "common": 0.45, "very_common": 0.7}

_TIER_ALIASES = {
    "veryrare": "very_rare",
    "very_rare": "very_rare",
    "very_rare_disease": "very_rare",
    "rare": "rare",
    "rare_disease": "rare",
    "uncommon": "uncommon",
    "less_common": "uncommon",
    "common": "common",
    "verycommon": "very_common",
    "very_common": "very_common",
}

assert set(PREVALENCE_TIER_SCORES) == set(PREVALENCE_TIERS)


def normalize_prevalence_tier(value) -> str | None:
    """``normalizePrevalenceTier`` from src/data/prevalenceTiers.js."""
    text = re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", str(value if value is not None else "").strip().lower()))
    return _TIER_ALIASES.get(text)


def tier_score(tier: str, bounds: tuple[float, float]) -> float:
    """A prevalence tier's score, clamped to its set's bounds (CONTRACT.md §5).
    The one place both the default prevalence (``load_atlas``) and a local
    population (``Atlas.with_tiers``) turn tiers into scores."""
    low, high = bounds
    return min(high, max(low, PREVALENCE_TIER_SCORES[tier]))


def stem_code(code: str | None) -> str | None:
    """``stemCode``: drop the last ``.suffix`` of an ICD code."""
    if not code or "." not in code:
        return code or None
    return re.sub(r"\.[^.]+$", "", code)


class Atlas:
    """The concept hierarchy with prevalence applied, in atlas-base.json order."""

    def __init__(self, concepts: list[Concept], axes: Axes, *, prevalence_bounds: tuple[float, float] = (0.03, 0.97)):
        self.axes = axes
        self.concepts = concepts
        # The tier score clamp of the prevalence set the atlas was built from.
        self.prevalence_bounds = prevalence_bounds
        self.by_id = {concept.concept_id: concept for concept in concepts}
        self.chapter_ids: list[str] = []
        self.blocks_by_chapter: dict[str, list[str]] = {}
        # Top-level (depth-1) conditions per block and per chapter, in concept order.
        self.conditions_by_block: dict[str, list[Concept]] = {}
        self.conditions_by_chapter: dict[str, list[Concept]] = {}
        for concept in concepts:
            if concept.level == 0:
                self.chapter_ids.append(concept.concept_id)
            elif concept.level == 1:
                self.blocks_by_chapter.setdefault(concept.parent_id, []).append(concept.concept_id)
            elif concept.depth == 1 and concept.is_top_level_condition:
                self.conditions_by_block.setdefault(concept.parent_id, []).append(concept)
                block = self.by_id.get(concept.parent_id)
                self.conditions_by_chapter.setdefault(block.parent_id if block else None, []).append(concept)

    @cached_property
    def by_code(self) -> dict[str, Concept]:
        """Level-2 concepts by ICD-11 code, upper case (the lookup, CONTRACT.md §19).

        Codes are unique; should two concepts share one, the first in atlas order wins.
        """
        index: dict[str, Concept] = {}
        for concept in self.concepts:
            if concept.level == 2 and concept.icd11_code:
                index.setdefault(concept.icd11_code.upper(), concept)
        return index

    def with_tiers(self, tiers: dict[str, str]) -> "Atlas":
        """This atlas with ``tiers`` (concept id → tier) replacing the tiers of
        the level-2 concepts they name: a local population (contract v1.10,
        CONTRACT.md §21). Scores follow §5 exactly as ``load_atlas`` derives
        them, so the existing formulas see the local tiers."""
        concepts = []
        for concept in self.concepts:
            tier = normalize_prevalence_tier(tiers.get(concept.concept_id)) if concept.level == 2 else None
            if tier is not None:
                concept = replace(concept, prevalence_tier=tier, prevalence_score=tier_score(tier, self.prevalence_bounds))
            concepts.append(concept)
        # Built through the constructor, so no derived index or cached property of this atlas carries over.
        return Atlas(concepts, self.axes, prevalence_bounds=self.prevalence_bounds)

    def is_condition_anchor(self, concept: Concept | None) -> bool:
        return concept is not None and concept.level == 2 and concept.depth == 1

    def metric_anchor(self, concept: Concept) -> Concept | None:
        """The depth-1 condition a deeper category inherits its row from."""
        anchor = self.by_id.get(concept.metric_anchor_id or stem_code(concept.concept_id))
        return anchor if self.is_condition_anchor(anchor) else None

    def canonical_condition_id(self, concept: Concept) -> str:
        """``canonicalConditionId``: the depth-1 anchor id, else the concept's own id."""
        anchor_id = concept.metric_anchor_id or stem_code(concept.concept_id) or concept.concept_id
        anchor = self.by_id.get(anchor_id)
        return anchor.concept_id if self.is_condition_anchor(anchor) else concept.concept_id

    def display_prevalence(self) -> dict[str, float | None]:
        """Prevalence per concept as the reference atlas shows it (src/App.jsx).

        Level-2 concepts use their own score; blocks and chapters use the
        unweighted mean of their direct children's values, so a chapter is the
        mean of its block means.
        """
        children: dict[str, list[str]] = {}
        for concept in self.concepts:
            if concept.parent_id:
                children.setdefault(concept.parent_id, []).append(concept.concept_id)
        memo: dict[str, float | None] = {}

        def visit(concept_id: str) -> float | None:
            if concept_id in memo:
                return memo[concept_id]
            concept = self.by_id[concept_id]
            if concept.level == 2:
                memo[concept_id] = concept.prevalence_score
                return memo[concept_id]
            total = 0.0
            count = 0
            for child_id in children.get(concept_id, ()):
                value = visit(child_id)
                if value is None:
                    continue
                total += value
                count += 1
            memo[concept_id] = total / count if count else None
            return memo[concept_id]

        for concept in self.concepts:
            visit(concept.concept_id)
        return memo


def load_atlas(conn: sqlite3.Connection, prevalence_set_id: int) -> Atlas:
    prevalence = repository.load_prevalence(conn, prevalence_set_id)
    concepts = []
    for (
        concept_id,
        parent_id,
        level,
        chapter_id,
        chapter_no,
        block_id,
        pt,
        fsn,
        icd11_code,
        sort_order,
        depth_in_kind,
        metric_anchor_id,
        top_level_position,
        source_prevalence,
    ) in repository.load_concepts(conn):
        tier = normalize_prevalence_tier(prevalence.tiers.get(concept_id)) if level == 2 else None
        prevalence_score = source_prevalence
        if tier is not None:
            prevalence_score = tier_score(tier, (prevalence.min_score, prevalence.max_score))
        concepts.append(
            Concept(
                concept_id=concept_id,
                parent_id=parent_id,
                level=level,
                chapter_id=chapter_id,
                chapter_no=chapter_no,
                block_id=block_id,
                pt=pt,
                fsn=fsn,
                icd11_code=icd11_code,
                sort_order=sort_order,
                depth_in_kind=depth_in_kind,
                metric_anchor_id=metric_anchor_id,
                is_top_level_condition=top_level_position is not None,
                prevalence_tier=tier,
                prevalence_score=prevalence_score if is_finite(prevalence_score) else None,
            )
        )
    return Atlas(concepts, repository.load_axes(conn), prevalence_bounds=(prevalence.min_score, prevalence.max_score))
