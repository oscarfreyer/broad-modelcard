"""Single-disease metric rows for one model and use case.

Ported from ``getMetricRow`` and its helpers in src/data/tableDataset.js
(v0.2.0-alpha.1): condition rows (§4.1), deeper categories through their anchor
(§5), block and chapter rollups (§6), and demographic fallback (§7).
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from ..repository import MetricSetReader
from ..schema.contract import AGE_ALL, ETHNICITY_ALL, SEX_ALL
from .aggregation import aggregate_lens_rows, rollup_row
from .atlas import Atlas
from .decode import decode_tuple
from .errors import UnknownConcept
from .lru import LruCache
from .studies import RowStudies
from .types import ALL_POPULATIONS, LENS_CACHE_SIZE, Axes, Concept, Lens, MetricValues, Provenance

_CONDITION = Provenance(source="condition")
_CONDITION_FALLBACK = Provenance(source="condition", lens_fallback=True)
_LOCAL = Provenance(source="condition", layer="local")
LOCAL = "local"
# A block or chapter row at least one of whose conditions is a local result (the map's ``layer``).
INCLUDES_LOCAL = "includes_local"
# The map's ``appraisal`` (2026-10-21, CONTRACT.md §22): a condition whose result rests on a stored
# row linked to a study record, and a result that aggregates several conditions or rows, at least one linked.
LINKED = "linked"
INCLUDES_LINKED = "includes_linked"


@dataclass(frozen=True)
class LocalLayer:
    """A hospital's local evaluation results for one card and local population
    (contract v1.13, CONTRACT.md §26). A local row replaces the public row of
    exactly its condition and lens; local rows are never combined by the
    demographic fallback (§7), which uses the public rows only."""

    reader: MetricSetReader
    population_id: str
    studies: RowStudies | None = None


def _specific(values: tuple[str, ...], all_value: str) -> tuple[str, ...]:
    specific = tuple(value for value in values if value != all_value)
    return specific or values


def expand_lens(lens: Lens, axes: Axes) -> list[Lens]:
    """``expandComboOptions``: each ``All …`` axis becomes its specific values.
    The setting is kept (contract v1.14, §29): the fallback never crosses settings."""
    ages = _specific(axes.age, AGE_ALL) if lens.age == AGE_ALL else (lens.age,)
    sexes = _specific(axes.sex, SEX_ALL) if lens.sex == SEX_ALL else (lens.sex,)
    ethnicities = _specific(axes.ethnicity, ETHNICITY_ALL) if lens.ethnicity == ETHNICITY_ALL else (lens.ethnicity,)
    return [Lens(age, sex, ethnicity, lens.setting) for age in ages for sex in sexes for ethnicity in ethnicities]


def defined_expansion(lens: Lens, axes: Axes, defined_combos: frozenset[int]) -> list[tuple[Lens, int]]:
    expanded = []
    for candidate in expand_lens(lens, axes):
        combo_idx = axes.combo_index(candidate)
        if combo_idx in defined_combos:
            expanded.append((candidate, combo_idx))
    return expanded


class MetricsService:
    """Derived rows of one model and use case.

    Rows are cached per lens. Only the ``lens_cache_size`` most recently used
    lenses are kept, which bounds memory in a long-running server; evicting a
    lens only means its rows are derived again on the next request.
    """

    def __init__(
        self,
        atlas: Atlas,
        reader: MetricSetReader,
        *,
        model_version: str,
        use_case: str,
        lens_cache_size: int = LENS_CACHE_SIZE,
        intended_use_defined: bool = True,
        studies: RowStudies | None = None,
        local: LocalLayer | None = None,
    ):
        self.atlas = atlas
        self.reader = reader
        self.model_version = model_version
        self.use_case = use_case
        # False for a card without an intended-use statement (contract v1.11):
        # every intended-use field of its rows is then None.
        self.intended_use_defined = intended_use_defined
        # The rows of this set linked to a study record (contract v1.13,
        # CONTRACT.md §22); None when none is, and then every row grades as before.
        self.studies = studies
        # Local results over the public rows (contract v1.13), or None.
        self.local = local
        self._cache: LruCache[dict[str, MetricValues | None]] = LruCache(lens_cache_size)

    def clear_cache(self) -> None:
        self._cache.clear()

    def _rows_for_lens(self, lens: Lens) -> dict[str, MetricValues | None]:
        return self._cache.get(lens, dict)

    def row(self, concept_id: str, lens: Lens = ALL_POPULATIONS) -> MetricValues | None:
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            raise UnknownConcept(f"Unknown concept {concept_id!r}.")
        self.atlas.axes.validate(lens)
        cached = self._rows_for_lens(lens)
        if concept_id in cached:
            return cached[concept_id]
        if concept.level == 2:
            row = self._condition_row(concept, lens) if concept.depth == 1 else self._anchor_row(concept, lens)
        elif concept.level == 1:
            row = self._rollup(concept, self.atlas.conditions_by_block.get(concept.concept_id, ()), lens)
        else:
            row = self._rollup(concept, self.atlas.conditions_by_chapter.get(concept.concept_id, ()), lens)
        cached[concept_id] = row
        return row

    def _decode(self, raw, concept: Concept, lens: Lens, provenance: Provenance, combo_idx: int, studies: RowStudies | None = None) -> MetricValues:
        studies = studies if provenance.layer == LOCAL else self.studies
        link = studies.link(combo_idx, concept.concept_id) if studies is not None else None
        return decode_tuple(
            raw,
            concept_id=concept.concept_id,
            lens=lens,
            use_case=self.use_case,
            prevalence_score=concept.prevalence_score,
            chapter_no=concept.chapter_no,
            provenance=provenance,
            intended_use_defined=self.intended_use_defined,
            **({"study_id": link[0], "study_adjustment": link[1]} if link is not None else {}),
        )

    def _condition_row(self, concept: Concept, lens: Lens) -> MetricValues | None:
        axes = self.atlas.axes
        combo_idx = axes.combo_index(lens)
        if self.local is not None and combo_idx in self.local.reader.defined_combos:
            raw = self.local.reader.row(concept.concept_id, combo_idx)
            if raw is not None:
                return self._decode(raw, concept, lens, _LOCAL, combo_idx, self.local.studies)
        if combo_idx in self.reader.defined_combos:
            raw = self.reader.row(concept.concept_id, combo_idx)
            return self._decode(raw, concept, lens, _CONDITION, combo_idx) if raw is not None else None

        expanded = defined_expansion(lens, axes, self.reader.defined_combos)
        stored = self.reader.rows_for_concept(concept.concept_id, [idx for _, idx in expanded])
        rows = [
            self._decode(stored[idx], concept, expanded_lens, _CONDITION_FALLBACK, idx)
            for expanded_lens, idx in expanded
            if idx in stored
        ]
        return aggregate_lens_rows(
            rows,
            concept_id=concept.concept_id,
            lens=lens,
            use_case=self.use_case,
            prevalence_score=concept.prevalence_score,
            chapter_no=concept.chapter_no,
            provenance=_CONDITION_FALLBACK,
        )

    def _anchor_row(self, concept: Concept, lens: Lens) -> MetricValues | None:
        anchor = self.atlas.metric_anchor(concept)
        if anchor is None:
            return None
        anchor_row = self.row(anchor.concept_id, lens)
        if anchor_row is None:
            return None
        return replace(
            anchor_row,
            concept_id=concept.concept_id,
            provenance=Provenance(
                source="anchor",
                lens_fallback=anchor_row.provenance.lens_fallback,
                anchor_concept_id=anchor.concept_id,
                layer=anchor_row.provenance.layer,
            ),
        )

    def _rollup(self, concept: Concept, conditions, lens: Lens) -> MetricValues:
        child_rows, child_weights = [], []
        for condition in conditions:
            row = self.row(condition.concept_id, lens)
            if row is not None:
                child_rows.append(row)
                child_weights.append(condition.prevalence_score)
        return rollup_row(
            concept_id=concept.concept_id,
            chapter_no=concept.chapter_no,
            lens=lens,
            use_case=self.use_case,
            child_rows=child_rows,
            child_weights=child_weights,
            intended_use_defined=self.intended_use_defined,
        )

    @property
    def links_studies(self) -> bool:
        """Whether any stored row of the card (public, or local for the population) links a study record."""
        return self.studies is not None or (self.local is not None and self.local.studies is not None)

    def condition_linked(self, concept_id: str, lens: Lens = ALL_POPULATIONS) -> bool:
        """Whether a depth-1 condition's result at the lens rests on a stored row linked to a study
        record (2026-10-21, CONTRACT.md §22): its own row (public or local), or, for a lens
        fallback over several rows (§7), at least one of them."""
        if not self.links_studies:
            return False
        row = self.row(concept_id, lens)
        if row is None:
            return False
        if row.study_id is not None:
            return True
        if not row.provenance.lens_fallback or self.studies is None:
            return False
        # A fallback over several rows keeps no study id: look at the rows it combined (public only, §26.1).
        expanded = defined_expansion(lens, self.atlas.axes, self.reader.defined_combos)
        stored = self.reader.rows_for_concept(concept_id, [idx for _, idx in expanded])
        return any(idx in stored and self.studies.link(idx, concept_id) is not None for _, idx in expanded)

    def condition_study_ids(self, concept_id: str, lens: Lens = ALL_POPULATIONS) -> list[str]:
        """The study records behind a depth-1 condition's result at the lens (contract v1.14,
        CONTRACT.md §28.5): its own row's (public or local), or for a lens fallback over several
        rows (§7) those of the rows it combined (public only, §26.1). Empty when none links one,
        exactly when ``condition_linked`` is False."""
        if not self.links_studies:
            return []
        row = self.row(concept_id, lens)
        if row is None:
            return []
        if row.study_id is not None:
            return [row.study_id]
        if not row.provenance.lens_fallback or self.studies is None:
            return []
        expanded = defined_expansion(lens, self.atlas.axes, self.reader.defined_combos)
        stored = self.reader.rows_for_concept(concept_id, [idx for _, idx in expanded])
        links = (self.studies.link(idx, concept_id) for _, idx in expanded if idx in stored)
        return [link[0] for link in links if link is not None]

    def appraisal(self, concept_id: str, lens: Lens = ALL_POPULATIONS) -> str | None:
        """The map's ``appraisal`` of a concept (2026-10-21, CONTRACT.md §22): ``linked`` for a
        condition (or a deeper category, through its anchor) whose result rests on a stored row
        linked to a study record, ``includes_linked`` for a block or chapter with at least one such
        condition, else None (also for every concept of a card whose rows link no study)."""
        if not self.links_studies:
            return None
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            return None
        if concept.level == 2:
            anchor = concept if concept.depth == 1 else self.atlas.metric_anchor(concept)
            return LINKED if anchor is not None and self.condition_linked(anchor.concept_id, lens) else None
        children = (
            self.atlas.conditions_by_block.get(concept_id, ()) if concept.level == 1 else self.atlas.conditions_by_chapter.get(concept_id, ())
        )
        return INCLUDES_LINKED if any(self.condition_linked(condition.concept_id, lens) for condition in children) else None

    def layer(self, concept_id: str, lens: Lens = ALL_POPULATIONS) -> str | None:
        """The map's ``layer`` of a concept (contract v1.13, §26): ``local`` for a
        condition (or a deeper category) served from local results,
        ``includes_local`` for a block or chapter with at least one such
        condition, else None."""
        if self.local is None:
            return None
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            return None
        if concept.level == 2:
            row = self.row(concept_id, lens)
            return LOCAL if row is not None and row.provenance.layer == LOCAL else None
        children = (
            self.atlas.conditions_by_block.get(concept_id, ()) if concept.level == 1 else self.atlas.conditions_by_chapter.get(concept_id, ())
        )
        for condition in children:
            row = self.row(condition.concept_id, lens)
            if row is not None and row.provenance.layer == LOCAL:
                return INCLUDES_LOCAL
        return None
