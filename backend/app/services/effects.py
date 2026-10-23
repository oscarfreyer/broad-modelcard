"""Intervention effects on the atlas (contract v1.13, CONTRACT.md §27).

An effect record states what using an AI system changed for patients or for
care: an outcome, against a comparator, with an effect measure, an estimate,
and its confidence interval, from one study that compared care with and
without the system (a randomized trial, a prospective study, or a real-world
deployment), appraised with the tool its design needs (RoB 2 or ROBINS-I).

Effects attach to concepts like safety incidents (§18): an effect names ICD-11
codes (stored with their depth-1 anchor conditions) or one whole chapter; a
condition shows the effects of its card that name it, a deeper category those
of its anchor, a block or chapter those of any of its conditions, and a concept
of another ontology those of the ICD-11 conditions it maps to (§23). Effects
have no lens: their population is the study's, stated in words.

**Effects never enter a grade, status, Overview, comparison flag, or summary.**
Nothing here is read by the metrics, the map, the summary, the catalogue, or
the comparison. All data is synthetic.
"""

from __future__ import annotations

import sqlite3

from .. import repository
from ..repository import EffectRecord, StudyRecord
from .atlas import Atlas
from .types import Concept


def effect_payload(effect: EffectRecord, study: StudyRecord | None) -> dict:
    """openapi.json ``Effect``: the record and its study (null when the version's
    studies set no longer holds it)."""
    return {**effect.as_dict(), "study": study.as_dict() if study is not None else None}


class CardEffects:
    """The effects of one card, indexed by the depth-1 conditions they concern."""

    def __init__(self, atlas: Atlas, effects: list[EffectRecord], studies: dict[str, StudyRecord]):
        self.atlas = atlas
        self.effects = effects
        self.studies = studies
        self.by_condition: dict[str, list[EffectRecord]] = {}
        for effect in effects:
            if effect.chapter_id is not None:
                condition_ids = [condition.concept_id for condition in atlas.conditions_by_chapter.get(effect.chapter_id, ())]
            else:
                condition_ids = list(dict.fromkeys(effect.condition_ids))
            for condition_id in condition_ids:
                self.by_condition.setdefault(condition_id, []).append(effect)

    def _conditions_of(self, concept: Concept) -> list[str]:
        """The depth-1 ICD-11 conditions whose effects a concept shows (as for incidents)."""
        if concept.level == 0:
            return [condition.concept_id for condition in self.atlas.conditions_by_chapter.get(concept.concept_id, ())]
        if concept.level == 1:
            return [condition.concept_id for condition in self.atlas.conditions_by_block.get(concept.concept_id, ())]
        if concept.depth == 1:
            return [concept.concept_id]
        anchor = self.atlas.metric_anchor(concept)
        return [anchor.concept_id] if anchor is not None else []

    def concept_effects(self, concept: Concept) -> list[dict]:
        """The effects that concern the concept, in stored order."""
        return self.effects_of(self._conditions_of(concept))

    def effects_of(self, condition_ids) -> list[dict]:
        """The effects that concern any of these depth-1 ICD-11 conditions, in stored order."""
        if not self.by_condition:
            return []
        found: set[str] = set()
        for condition_id in condition_ids:
            for effect in self.by_condition.get(condition_id, ()):
                found.add(effect.effect_id)
        return [effect_payload(effect, self.studies.get(effect.study_id)) for effect in self.effects if effect.effect_id in found]


class EffectIndex:
    """The effects of one dataset version, per card. Loaded on first use; a
    version without effects costs nothing beyond the state it already has."""

    def __init__(self, conn: sqlite3.Connection, set_id: int | None, atlas: Atlas, studies: dict[str, StudyRecord]):
        self.atlas = atlas
        self.studies = studies
        self.records = repository.load_effects(conn, set_id)
        self._by_card: dict[tuple[str, str], list[EffectRecord]] = {}
        for effect in self.records:
            self._by_card.setdefault(effect.key, []).append(effect)
        self._cards: dict[tuple[str, str], CardEffects] = {}

    def card(self, model_version: str, use_case: str) -> CardEffects:
        key = (model_version, use_case)
        card = self._cards.get(key)
        if card is None:
            card = self._cards[key] = CardEffects(self.atlas, self._by_card.get(key, []), self.studies)
        return card

    def listed(self, *, model_version: str | None = None, use_case: str | None = None) -> list[dict]:
        """Every stored effect, optionally of one AI system or one card, in stored order."""
        return [
            effect_payload(effect, self.studies.get(effect.study_id))
            for effect in self.records
            if (model_version is None or effect.model_version == model_version)
            and (use_case is None or effect.use_case == use_case)
        ]
