"""Concept records, paths, and atlas scopes in the shapes of openapi.json.

A ``Catalog`` is built once per dataset version (prevalence can change between
versions) and is read-only afterwards.
"""

from __future__ import annotations

from .atlas import Atlas
from .errors import UnknownConcept
from .types import Concept


class Catalog:
    def __init__(self, atlas: Atlas):
        self.atlas = atlas
        display_prevalence = atlas.display_prevalence()
        self.records: dict[str, dict] = {
            concept.concept_id: _record(concept, display_prevalence.get(concept.concept_id))
            for concept in atlas.concepts
        }
        self.chapters = [concept for concept in atlas.concepts if concept.level == 0]
        self.blocks = [concept for concept in atlas.concepts if concept.level == 1]
        # The 2,400 depth-1 top-level conditions, in concept order.
        self.conditions = [concept for concept in atlas.concepts if is_top_level_condition(concept)]
        self.level_two_by_chapter: dict[str, list[Concept]] = {}
        for concept in atlas.concepts:
            if concept.level == 2:
                self.level_two_by_chapter.setdefault(concept.chapter_id, []).append(concept)

    def concept(self, concept_id: str) -> Concept:
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            raise UnknownConcept(f"Unknown concept {concept_id!r}.")
        return concept

    def chapter(self, chapter_id: str) -> Concept:
        concept = self.atlas.by_id.get(chapter_id)
        if concept is None or concept.level != 0:
            raise UnknownConcept(f"Unknown chapter {chapter_id!r}.")
        return concept

    def record(self, concept_id: str) -> dict:
        return self.records[concept_id]

    def path(self, concept: Concept) -> list[dict]:
        """Chapter → block → concept, following ``parent_id``."""
        path = []
        cursor: Concept | None = concept
        while cursor is not None:
            path.append(self.records[cursor.concept_id])
            cursor = self.atlas.by_id.get(cursor.parent_id) if cursor.parent_id else None
        path.reverse()
        return path

    def blocks_of(self, chapter_id: str) -> list[Concept]:
        return [self.atlas.by_id[block_id] for block_id in self.atlas.blocks_by_chapter.get(chapter_id, ())]

    def scope(self, scope: str, chapter_id: str | None) -> list[Concept]:
        """Concepts a map covers (openapi.json ``getMetricMap``).

        ``atlas``: every block, then every top-level condition. ``chapter``: the
        chapter's blocks, then all its level-2 concepts, deeper ones included.
        """
        if scope == "atlas":
            return [*self.blocks, *self.conditions]
        chapter = self.chapter(chapter_id)
        return [*self.blocks_of(chapter.concept_id), *self.level_two_by_chapter.get(chapter.concept_id, ())]


def is_top_level_condition(concept: Concept) -> bool:
    return concept.level == 2 and concept.depth == 1 and concept.is_top_level_condition


def _record(concept: Concept, display_prevalence: float | None) -> dict:
    """The contract ``Concept``. Level-2 fields are null for chapters and blocks."""
    level_two = concept.level == 2
    return {
        "concept_id": concept.concept_id,
        "icd11_code": concept.icd11_code,
        "pt": concept.pt,
        "fsn": concept.fsn,
        "level": concept.level,
        "parent_id": concept.parent_id,
        "chapter_id": concept.chapter_id,
        "chapter_no": concept.chapter_no,
        "block_id": concept.block_id,
        "sort_order": concept.sort_order,
        "depth_in_kind": concept.depth if level_two else None,
        "metric_anchor_id": concept.metric_anchor_id if level_two else None,
        "prevalence_tier": concept.prevalence_tier if level_two else None,
        "prevalence_score": concept.prevalence_score if level_two else display_prevalence,
    }
