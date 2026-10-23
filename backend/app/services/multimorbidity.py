"""Multimorbidity combinations, candidates, and display rows (CONTRACT.md §8).

Ported from the ``getMultimorbidity*`` functions in src/data/tableDataset.js
(v0.2.0-alpha.1).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Sequence

from ..repository import MultimorbiditySetReader
from ..schema.contract import ANY_SETTING
from .aggregation import aggregate_lens_rows, weakest
from .atlas import Atlas
from .decode import decode_tuple
from .errors import UnknownConcept
from .jsnum import is_finite, locale_sort_key, mean
from .metrics import defined_expansion
from .types import ALL_POPULATIONS, Concept, Lens, MetricValues, Provenance

VIEWS = ("overall", "performance", "evidence", "intended_use")

_STORED = Provenance(source="multimorbidity")
_FALLBACK = Provenance(source="multimorbidity", lens_fallback=True)


@dataclass(frozen=True)
class Combination:
    key: str
    condition_ids: tuple[str, ...]  # canonical, sorted
    label: str
    position: int
    prevalence_score: float | None


class MultimorbidityService:
    def __init__(
        self,
        atlas: Atlas,
        reader: MultimorbiditySetReader | None,
        *,
        model_version: str,
        use_case: str,
        intended_use_defined: bool = True,
    ):
        self.atlas = atlas
        self.reader = reader
        self.model_version = model_version
        self.use_case = use_case
        # False for a card without an intended-use statement (contract v1.11).
        self.intended_use_defined = intended_use_defined
        self.combinations: dict[str, Combination] = {}
        for stored in reader.combinations if reader else ():
            condition_ids = self.canonical_ids(stored.condition_ids)
            if len(condition_ids) < 2:
                continue
            key = "+".join(condition_ids)
            if key in self.combinations:
                continue  # the first stored duplicate wins
            prevalences = [
                self.atlas.by_id[condition_id].prevalence_score
                for condition_id in condition_ids
                if is_finite(self.atlas.by_id[condition_id].prevalence_score)
            ]
            self.combinations[key] = Combination(
                key=key,
                condition_ids=condition_ids,
                label=self._label(condition_ids, stored.label),
                position=stored.position,
                prevalence_score=mean(prevalences) if prevalences else None,
            )
        self._cache: dict[tuple[str, Lens], MetricValues | None] = {}
        # Conditions that occur in a stored combination. Only these, and the
        # selected conditions, can have a display row (see display_rows()).
        self._involved = frozenset(
            condition_id for combination in self.combinations.values() for condition_id in combination.condition_ids
        )
        # True when every depth-1 condition is its own anchor, so canonical ids
        # map to themselves (true for the current atlas).
        self._canonical_is_stable = all(
            self.atlas.canonical_condition_id(concept) == concept.concept_id
            for concept in self.atlas.concepts
            if self.atlas.is_condition_anchor(concept)
        )

    @property
    def has_data(self) -> bool:
        return bool(self.combinations)

    # ------------------------------------------------------------ selection

    def canonical_ids(self, concept_ids: Iterable[str]) -> tuple[str, ...]:
        """Depth-1 anchors of the level-2 concepts, deduplicated and sorted."""
        canonical: dict[str, None] = {}
        for concept_id in concept_ids:
            concept = self.atlas.by_id.get(concept_id)
            if concept is None or concept.level != 2:
                continue
            canonical.setdefault(self.atlas.canonical_condition_id(concept), None)
        return tuple(sorted(canonical, key=locale_sort_key))

    def combination_key(self, concept_ids: Iterable[str]) -> str | None:
        canonical = self.canonical_ids(concept_ids)
        return "+".join(canonical) if len(canonical) >= 2 else None

    def _label(self, condition_ids: tuple[str, ...], stored_label: str | None) -> str:
        label = (stored_label or "").strip()
        if label:
            return label
        return " + ".join(
            (self.atlas.by_id[condition_id].pt if condition_id in self.atlas.by_id else None) or condition_id
            for condition_id in condition_ids
        )

    # ------------------------------------------------------------------ rows

    def row(self, concept_ids: Iterable[str], lens: Lens = ALL_POPULATIONS) -> MetricValues | None:
        """The stored row for a disease set, with demographic fallback."""
        self.atlas.axes.validate(lens)
        key = self.combination_key(concept_ids)
        combination = self.combinations.get(key) if key else None
        if combination is None:
            return None
        cache_key = (key, lens)
        if cache_key not in self._cache:
            self._cache[cache_key] = self._row(combination, lens)
        return self._cache[cache_key]

    def _row(self, combination: Combination, lens: Lens) -> MetricValues | None:
        axes = self.atlas.axes
        defined = self.reader.defined_combos
        combo_idx = axes.combo_index(lens)
        if combo_idx in defined:
            return self._decode(combination, combo_idx, lens, _STORED)

        expanded = defined_expansion(lens, axes, defined)
        if not expanded:
            # The all-population row of the same setting (contract v1.14, §29): never another setting's.
            all_idx = axes.combo_index(lens.all_patients())
            if all_idx in defined:
                # Substitute the all-population row; flagged since contract v1.
                return self._decode(combination, all_idx, lens, _FALLBACK)
            return None

        rows = [
            row
            for expanded_lens, expanded_idx in expanded
            if (row := self._decode(combination, expanded_idx, expanded_lens, _FALLBACK)) is not None
        ]
        aggregated = aggregate_lens_rows(
            rows,
            concept_id=combination.key,
            lens=lens,
            use_case=self.use_case,
            prevalence_score=combination.prevalence_score,
            chapter_no=None,
            provenance=_FALLBACK,
        )
        return self._attach(aggregated, combination)

    def _decode(self, combination: Combination, combo_idx: int, lens: Lens, provenance: Provenance):
        raw = self.reader.row(combination.position, combo_idx)
        if raw is None:
            return None
        row = decode_tuple(
            raw,
            concept_id=combination.key,
            lens=lens,
            use_case=self.use_case,
            prevalence_score=combination.prevalence_score,
            chapter_no=None,
            provenance=provenance,
            intended_use_defined=self.intended_use_defined,
        )
        return self._attach(row, combination)

    @staticmethod
    def _attach(row: MetricValues | None, combination: Combination) -> MetricValues | None:
        if row is None:
            return None
        return replace(
            row,
            concept_id=combination.key,
            condition_ids=combination.condition_ids,
            combination_label=combination.label,
        )

    # ------------------------------------------------------------ candidates

    def stores_setting(self, setting: str) -> bool:
        """Whether the set stores any row at the setting (contract v1.14, §29); Any setting always counts."""
        if setting == ANY_SETTING:
            return True
        return self.reader is not None and bool(self.atlas.axes.setting_combos(self.reader.defined_combos, setting))

    def candidate_ids(self, selected: Iterable[str] = (), setting: str = ANY_SETTING) -> list[str]:
        """Conditions that start (no selection) or extend the selection by one. At a
        specific setting the set stores no row for (§29), none: nothing there can have a row."""
        if not self.stores_setting(setting):
            return []
        selected_ids = self.canonical_ids(selected)
        selected_set = set(selected_ids)
        candidates: dict[str, None] = {}
        for combination in self.combinations.values():
            if not selected_ids:
                candidates.update(dict.fromkeys(combination.condition_ids))
                continue
            if len(combination.condition_ids) != len(selected_ids) + 1:
                continue
            if not selected_set.issubset(combination.condition_ids):
                continue
            for condition_id in combination.condition_ids:
                if condition_id not in selected_set:
                    candidates.setdefault(condition_id, None)

        def sort_key(condition_id: str):
            concept = self.atlas.by_id.get(condition_id)
            return locale_sort_key((concept.pt if concept else None) or condition_id)

        return sorted(candidates, key=sort_key)

    def display_row(
        self, concept_id: str, selected: Iterable[str], lens: Lens = ALL_POPULATIONS, view: str = "overall"
    ) -> MetricValues | None:
        """The row that colors a concept on the multimorbidity atlas."""
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            raise UnknownConcept(f"Unknown concept {concept_id!r}.")
        if not self.combinations:
            return None
        selected = tuple(selected)
        if concept.level == 2:
            return self._condition_display_row(concept_id, selected, lens, view)
        if concept.level == 1:
            condition_ids = [c.concept_id for c in self.atlas.conditions_by_block.get(concept_id, ())]
        else:
            condition_ids = [c.concept_id for c in self.atlas.conditions_by_chapter.get(concept_id, ())]
        return weakest(
            [self._condition_display_row(condition_id, selected, lens, view) for condition_id in condition_ids],
            view,
        )

    def display_rows(
        self, concepts: Sequence[Concept], selected: Iterable[str], lens: Lens = ALL_POPULATIONS
    ) -> dict[str, dict[str, MetricValues | None]]:
        """Display rows of many concepts for all four views at once.

        Equal to ``display_row(concept_id, selected, lens, view)`` for every
        concept and view, but each condition is derived once and only
        conditions that can have a row are derived at all: a condition's row
        always comes from a stored combination containing it or from the
        selection itself.
        """
        self.atlas.axes.validate(lens)
        if not self.combinations:
            return {concept.concept_id: dict.fromkeys(VIEWS) for concept in concepts}
        selected = tuple(selected)
        if not self._canonical_is_stable:
            # A condition anchored to another condition breaks the shortcut.
            return {
                concept.concept_id: {view: self.display_row(concept.concept_id, selected, lens, view) for view in VIEWS}
                for concept in concepts
            }
        relevant = self._involved.union(self.canonical_ids(selected))
        by_condition: dict[str, dict[str, MetricValues | None]] = {}

        def condition_rows(condition_id: str) -> dict[str, MetricValues | None] | None:
            if condition_id not in relevant:
                return None
            if condition_id not in by_condition:
                by_condition[condition_id] = {
                    view: self._condition_display_row(condition_id, selected, lens, view) for view in VIEWS
                }
            return by_condition[condition_id]

        result = {}
        for concept in concepts:
            if concept.level == 2:
                canonical = self.canonical_ids([concept.concept_id])
                rows = condition_rows(canonical[0]) if canonical else None
                result[concept.concept_id] = dict(rows) if rows else dict.fromkeys(VIEWS)
                continue
            members = (
                self.atlas.conditions_by_block.get(concept.concept_id, ())
                if concept.level == 1
                else self.atlas.conditions_by_chapter.get(concept.concept_id, ())
            )
            member_rows = [rows for member in members if (rows := condition_rows(member.concept_id))]
            result[concept.concept_id] = {view: weakest([rows[view] for rows in member_rows], view) for view in VIEWS}
        return result

    def _condition_display_row(self, concept_id: str, selected: tuple[str, ...], lens: Lens, view: str):
        canonical = self.canonical_ids([concept_id])
        if not canonical:
            return None
        candidate_id = canonical[0]
        selected_ids = self.canonical_ids(selected)
        if candidate_id in selected_ids:
            return self.row(selected_ids, lens) if len(selected_ids) >= 2 else None
        if selected_ids:
            return self.row((*selected_ids, candidate_id), lens)
        return weakest(
            [
                self.row(combination.condition_ids, lens)
                for combination in self.combinations.values()
                if candidate_id in combination.condition_ids
            ],
            view,
        )
