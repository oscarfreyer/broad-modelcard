"""Reads in another ontology: the projection over the ICD-11 atlas (contract v1.13, CONTRACT.md §23).

ICD-11 (``icd11``, the ``concepts`` table) is the default and the storage key
of every result. An imported ontology (``ontologies``, ``ontology_concepts``,
``ontology_mappings``; ``app/ontologies``) is read through a ``Projection``
over one dataset context (a version, and a local population if any):

* a condition mapped ``exact`` or ``stem`` serves the row of its ICD-11
  concept (a deeper ICD-11 category serves its anchor's row, §5), with its
  own concept id; ``block`` serves the ICD-11 block's rollup; ``parent``
  serves what its ``via`` concept's own mapping names; ``none`` serves no
  row and is shown as **No mapping**;
* the ontology's blocks and chapters are rollups (§6 rules) over the
  **distinct** depth-1 ICD-11 conditions (anchors) their mapped level-2
  concepts reach, weighted by those conditions' prevalence scores;
* a level-2 concept's prevalence tier (bubble size) is its ICD-11 target's:
  the concept's own tier for ``exact`` and ``stem``, the median tier of the
  block's conditions for ``block``, and ``NEUTRAL_TIER`` for ``none``. The
  served rows keep the ICD-11 evidence derivation, penalty included;
* safety marks and incidents are those of the anchors (§18).

Everything is derived from the context's ICD-11 atlas, so a local
population's tiers reach the projection through its ICD-11 concepts.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, replace
from functools import cached_property

from .aggregation import rollup_row
from .atlas import Atlas, tier_score
from .catalog import Catalog
from .errors import UnknownConcept
from .effects import CardEffects
from .incidents import CardSafety
from .lru import LruCache
from .metrics import INCLUDES_LINKED, INCLUDES_LOCAL, LINKED, LOCAL, MetricsService
from .types import LENS_CACHE_SIZE, Concept, Lens, MetricValues

ICD11 = "icd11"
ICD11_NAME = "ICD-11"
# The tier of a concept without an ICD-11 mapping: the middle of the five
# tiers, so an unmapped condition is drawn at a neutral size.
NEUTRAL_TIER = "uncommon"
MAPPING_KINDS = ("exact", "stem", "block", "parent", "none")


@dataclass(frozen=True)
class OntologyInfo:
    ontology_id: str
    position: int
    name: str
    release: str
    licence: str
    attribution: str
    sources: tuple[dict, ...]
    counts: dict

    @property
    def ref(self) -> dict:
        """``OntologyRef``: what a read for this ontology names in its body."""
        return {"id": self.ontology_id, "name": self.name}


@dataclass(frozen=True)
class MappingRecord:
    kind: str
    target_concept_id: str | None
    via_concept_id: str | None
    steps: int | None
    source: str | None
    source_code: str | None
    icd11_code: str | None


_CONCEPT_COLUMNS = (
    "concept_id, parent_id, level, chapter_id, chapter_no, block_id, code, pt, fsn, sort_order, depth_in_kind, "
    "metric_anchor_id, parents_json"
)


ICD11_LICENCE = "CC BY-ND 3.0 IGO"
ICD11_ATTRIBUTION = "ICD-11 for Mortality and Morbidity Statistics (MMS), World Health Organization"


def meta_ontologies(icd11_atlas: Atlas, atlas_meta: dict, infos: list[OntologyInfo]) -> list[dict]:
    """``/meta`` ``ontologies`` (contract v1.13): ICD-11 first (the default), then
    the imported ontologies in toolbar order, each with its release, licence,
    attribution, sizes, and (not ICD-11) its conditions by crosswalk kind."""
    meta = atlas_meta.get("meta") or {}
    # "Version:2026 Jan 17 - 05:30 UTC" → "2026 Jan 17"
    release = str(meta.get("ontologyRelease") or "").removeprefix("Version:").split(" - ")[0].strip() or None
    levels = [0, 0, 0, 0]
    for concept in icd11_atlas.concepts:
        levels[concept.level] += 1
        if concept.level == 2 and concept.depth == 1 and concept.is_top_level_condition:
            levels[3] += 1
    entries = [
        {
            "id": ICD11,
            "name": ICD11_NAME,
            "release": release,
            "licence": ICD11_LICENCE,
            "attribution": ICD11_ATTRIBUTION,
            "is_default": True,
            "counts": {"chapters": levels[0], "blocks": levels[1], "conditions": levels[3], "concepts": levels[2]},
            "mapping_counts": None,
            "sources": [],
        }
    ]
    for info in infos:
        counts = info.counts
        entries.append(
            {
                "id": info.ontology_id,
                "name": info.name,
                "release": info.release,
                "licence": info.licence,
                "attribution": info.attribution,
                "is_default": False,
                "counts": {name: counts[name] for name in ("chapters", "blocks", "conditions", "concepts")},
                "mapping_counts": {kind: counts["mapping_conditions"].get(kind, 0) for kind in MAPPING_KINDS},
                "sources": [
                    {name: source[name] for name in ("id", "release", "licence", "attribution")} for source in info.sources
                ],
            }
        )
    return entries


def has_ontology_tables(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ontologies'").fetchone() is not None


def load_infos(conn: sqlite3.Connection) -> list[OntologyInfo]:
    """The imported ontologies in toolbar order (none for a store without them)."""
    if not has_ontology_tables(conn):
        return []
    infos = []
    for ontology_id, position, name, release, licence, attribution, sources_json, counts_json in conn.execute(
        "SELECT ontology_id, position, name, release, licence, attribution, sources_json, counts_json"
        " FROM ontologies ORDER BY position"
    ):
        infos.append(
            OntologyInfo(ontology_id, position, name, release, licence, attribution, tuple(json.loads(sources_json)), json.loads(counts_json))
        )
    return infos


class OntologyTables:
    """One imported ontology's concepts and crosswalk, as stored (static reference data)."""

    def __init__(self, conn: sqlite3.Connection, info: OntologyInfo):
        self.info = info
        self.rows = conn.execute(
            f"SELECT {_CONCEPT_COLUMNS} FROM ontology_concepts WHERE ontology_id = ? ORDER BY concept_key",
            (info.ontology_id,),
        ).fetchall()
        self.mappings: dict[str, MappingRecord] = {
            concept_id: MappingRecord(*rest)
            for concept_id, *rest in conn.execute(
                "SELECT concept_id, kind, target_concept_id, via_concept_id, steps, source, source_code, icd11_code"
                " FROM ontology_mappings WHERE ontology_id = ?",
                (info.ontology_id,),
            )
        }
        self.codes = {row[0]: row[6] for row in self.rows}
        self.names = {row[0]: row[7] for row in self.rows}
        self.parents = {row[0]: tuple(json.loads(row[12])) for row in self.rows if row[12]}
        self._structure: tuple[dict, dict] | None = None

    def structure(self, icd: Atlas) -> tuple[dict[str, tuple[str, ...]], dict[str, str | None]]:
        """Each concept's distinct depth-1 ICD-11 conditions (in first-reached
        order), and each rollup's shared ICD-11 chapter (§4.2), or None.

        Built once: they follow from the crosswalk and the ICD-11 hierarchy
        alone, which no version or local population changes (only tiers
        differ between the atlases of different contexts)."""
        if self._structure is None:
            anchors = _anchors(self, icd)
            chapter_of = {concept.concept_id: concept.chapter_no for concept in icd.concepts}
            rollup_chapter_no = {}
            for row in self.rows:
                if row[2] < 2:
                    chapters = {chapter_of[anchor] for anchor in anchors[row[0]]}
                    rollup_chapter_no[row[0]] = chapters.pop() if len(chapters) == 1 else None
            self._structure = (anchors, rollup_chapter_no)
        return self._structure

    @cached_property
    def search_atlas(self) -> Atlas:
        """The concepts for the search index (§9 reads ids, codes, names, and levels only):
        each with the ontology's own code where the index looks for a code
        (a chapter without one by its number), never a made-up concept id."""
        concepts = []
        for row in self.rows:
            concept = _concept(row, None, None)
            code = row[6] or (row[4] if row[2] == 0 else None)
            concepts.append(replace(concept, icd11_code=code) if code else concept)
        return Atlas(concepts, None)


def _concept(row: tuple, tier: str | None, score: float | None) -> Concept:
    concept_id, parent_id, level, chapter_id, chapter_no, block_id, _code, pt, fsn, sort_order, depth, anchor, _parents = row
    return Concept(
        concept_id=concept_id,
        parent_id=parent_id,
        level=level,
        chapter_id=chapter_id,
        chapter_no=chapter_no,
        block_id=block_id,
        pt=pt,
        fsn=fsn,
        icd11_code=None,
        sort_order=sort_order,
        depth_in_kind=depth,
        metric_anchor_id=anchor,
        is_top_level_condition=level == 2 and (depth or 1) == 1,
        prevalence_tier=tier,
        prevalence_score=score,
    )


def _target_anchors(icd: Atlas, target: Concept | None) -> tuple[str, ...]:
    """The depth-1 ICD-11 conditions a mapped concept reaches: a block's conditions, else the target's anchor."""
    if target is None:
        return ()
    if target.level == 1:
        return tuple(condition.concept_id for condition in icd.conditions_by_block.get(target.concept_id, ()))
    anchor = target if icd.is_condition_anchor(target) else icd.metric_anchor(target)
    return (anchor.concept_id,) if anchor is not None else ()


def _anchors(tables: OntologyTables, icd: Atlas) -> dict[str, tuple[str, ...]]:
    """Each concept's distinct depth-1 ICD-11 conditions, in first-reached order:
    a level-2 concept's through its mapping, a block's and a chapter's those of their level-2 concepts."""
    anchors: dict[str, tuple[str, ...]] = {}
    by_block: dict[str, dict[str, None]] = {}
    by_chapter: dict[str, dict[str, None]] = {}
    for concept_id, parent_id, level, chapter_id, *_ in tables.rows:
        if level != 2:
            continue
        mapping = tables.mappings.get(concept_id)
        target = icd.by_id.get(mapping.target_concept_id) if mapping is not None and mapping.target_concept_id else None
        own = anchors[concept_id] = _target_anchors(icd, target)
        for anchor in own:
            by_block.setdefault(parent_id, {})[anchor] = None
            by_chapter.setdefault(chapter_id, {})[anchor] = None
    for concept_id, _parent, level, *_ in tables.rows:
        if level == 1:
            anchors[concept_id] = tuple(by_block.get(concept_id, ()))
        elif level == 0:
            anchors[concept_id] = tuple(by_chapter.get(concept_id, ()))
    return anchors


class OntologyCatalog(Catalog):
    """``Catalog`` records of another ontology: ``icd11_code`` null and the ontology's own ``code``."""

    def __init__(self, atlas: Atlas, codes: dict[str, str | None]):
        super().__init__(atlas)
        for concept_id, record in self.records.items():
            record["code"] = codes.get(concept_id)


class Projection:
    """One ontology read over one dataset context (CONTRACT.md §23)."""

    def __init__(self, tables: OntologyTables, dataset, *, metrics_cache_size: int = 4):
        self.tables = tables
        self.info = tables.info
        self.dataset = dataset
        icd = dataset.atlas
        self.icd_atlas = icd
        concepts = []
        for row in tables.rows:
            tier = score = None
            if row[2] == 2:
                tier, score = self._prevalence(tables.mappings.get(row[0]))
            concepts.append(_concept(row, tier, score))
        self.atlas = Atlas(concepts, icd.axes, prevalence_bounds=icd.prevalence_bounds)
        self.catalog = OntologyCatalog(self.atlas, tables.codes)
        self.anchors, self.rollup_chapter_no = tables.structure(icd)
        self._metrics: LruCache[ProjectedMetrics] = LruCache(metrics_cache_size)

    # ------------------------------------------------------------ structure

    def mapping(self, concept_id: str) -> MappingRecord | None:
        return self.tables.mappings.get(concept_id)

    def target(self, concept_id: str) -> Concept | None:
        """The ICD-11 concept whose result a level-2 concept serves, or None."""
        mapping = self.tables.mappings.get(concept_id)
        if mapping is None or mapping.target_concept_id is None:
            return None
        return self.icd_atlas.by_id.get(mapping.target_concept_id)

    def _prevalence(self, mapping: MappingRecord | None) -> tuple[str | None, float | None]:
        target = self.icd_atlas.by_id.get(mapping.target_concept_id) if mapping and mapping.target_concept_id else None
        if target is not None and target.level == 2:
            return target.prevalence_tier, target.prevalence_score
        if target is not None and target.level == 1:
            conditions = [c for c in self.icd_atlas.conditions_by_block.get(target.concept_id, ()) if c.prevalence_score is not None]
            if conditions:
                ordered = sorted(conditions, key=lambda condition: condition.prevalence_score)
                median = ordered[(len(ordered) - 1) // 2]
                return median.prevalence_tier, median.prevalence_score
        return NEUTRAL_TIER, tier_score(NEUTRAL_TIER, self.icd_atlas.prevalence_bounds)

    def concept(self, concept_id: str) -> Concept:
        return self.catalog.concept(concept_id)

    # ------------------------------------------------------------ payloads

    _NONE = {"kind": "none", "icd11": None, "via": None, "steps": None, "source": None, "source_code": None, "icd11_code": None}

    def mapping_payload(self, concept: Concept) -> dict | None:
        """``ConceptMapping`` of a level-2 concept. A chapter or block is a
        rollup: None, unless none of its conditions maps at all (``none``)."""
        if concept.level != 2:
            return None if self.anchors.get(concept.concept_id) else dict(self._NONE)
        mapping = self.tables.mappings.get(concept.concept_id)
        if mapping is None:
            return dict(self._NONE)
        target = self.icd_atlas.by_id.get(mapping.target_concept_id) if mapping.target_concept_id else None
        via = mapping.via_concept_id
        return {
            "kind": mapping.kind,
            "icd11": (
                {"concept_id": target.concept_id, "code": target.icd11_code if target.level == 2 else None, "pt": target.pt, "level": target.level}
                if target is not None
                else None
            ),
            "via": {"concept_id": via, "pt": self.tables.names.get(via, via)} if via else None,
            "steps": mapping.steps,
            "source": mapping.source,
            "source_code": mapping.source_code,
            "icd11_code": mapping.icd11_code,
        }

    def other_parents(self, concept: Concept) -> list[dict]:
        """The parents besides the primary one (MONDO is a graph), for the condition card."""
        parents = self.tables.parents.get(concept.concept_id, ())
        return [{"concept_id": parent, "pt": self.tables.names.get(parent, parent)} for parent in parents[1:]]

    def mapping_counts(self, concepts) -> dict[str, int]:
        counts = dict.fromkeys(MAPPING_KINDS, 0)
        for concept in concepts:
            mapping = self.tables.mappings.get(concept.concept_id)
            counts[mapping.kind if mapping else "none"] += 1
        return counts

    def map_mappings(self, concepts) -> list[str | None]:
        """The ``mapping`` array of a ``MetricMap``: each level-2 row's kind; null for
        a block or chapter row (a rollup), ``none`` for one none of whose conditions maps."""
        out = []
        for concept in concepts:
            if concept.level != 2:
                out.append(None if self.anchors.get(concept.concept_id) else "none")
                continue
            mapping = self.tables.mappings.get(concept.concept_id)
            out.append(mapping.kind if mapping else "none")
        return out

    # ------------------------------------------------------------- services

    def metrics(self, model_version: str, use_case: str) -> "ProjectedMetrics":
        # Asked every time, so the card's ICD-11 service stays in the dataset's cache and is
        # the one the projection reads (its rows are the same if it was built again).
        icd = self.dataset.metrics(model_version, use_case)
        service = self._metrics.get((model_version, use_case), lambda: ProjectedMetrics(self, icd))
        service.icd = icd
        return service

    def card_safety(self, model_version: str, use_case: str) -> "ProjectedSafety":
        return ProjectedSafety(self, self.dataset.card_safety(model_version, use_case))

    def card_effects(self, model_version: str, use_case: str) -> "ProjectedEffects":
        return ProjectedEffects(self, self.dataset.card_effects(model_version, use_case))


class ProjectedMetrics:
    """``MetricsService`` in another ontology: rows served through the crosswalk."""

    def __init__(self, projection: Projection, icd: MetricsService, *, lens_cache_size: int = LENS_CACHE_SIZE):
        self.projection = projection
        self.icd = icd
        self.atlas = projection.atlas
        self.use_case = icd.use_case
        self.model_version = icd.model_version
        self.intended_use_defined = icd.intended_use_defined
        self._cache: LruCache[dict[str, MetricValues | None]] = LruCache(lens_cache_size)

    def _rows_for_lens(self, lens: Lens) -> dict[str, MetricValues | None]:
        return self._cache.get(lens, dict)

    def icd11_row(self, concept_id: str, lens: Lens) -> MetricValues | None:
        """The ICD-11 row a level-2 concept serves (before its concept id is replaced)."""
        target = self.projection.target(concept_id)
        return self.icd.row(target.concept_id, lens) if target is not None else None

    def row(self, concept_id: str, lens: Lens) -> MetricValues | None:
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            raise UnknownConcept(f"Unknown concept {concept_id!r}.")
        self.atlas.axes.validate(lens)
        cached = self._rows_for_lens(lens)
        if concept_id in cached:
            return cached[concept_id]
        if concept.level == 2:
            served = self.icd11_row(concept_id, lens)
            row = replace(served, concept_id=concept_id) if served is not None else None
        else:
            child_rows, child_weights = [], []
            for anchor in self.projection.anchors.get(concept_id, ()):
                child = self.icd.row(anchor, lens)
                if child is not None:
                    child_rows.append(child)
                    child_weights.append(self.projection.icd_atlas.by_id[anchor].prevalence_score)
            row = rollup_row(
                concept_id=concept_id,
                chapter_no=self.projection.rollup_chapter_no.get(concept_id),
                lens=lens,
                use_case=self.use_case,
                child_rows=child_rows,
                child_weights=child_weights,
                intended_use_defined=self.intended_use_defined,
            )
        cached[concept_id] = row
        return row

    @property
    def links_studies(self) -> bool:
        return self.icd.links_studies

    def appraisal(self, concept_id: str, lens: Lens) -> str | None:
        """``MetricsService.appraisal`` through the crosswalk (2026-10-21, §22): ``linked`` for a
        condition that serves one ICD-11 condition's result resting on a linked row,
        ``includes_linked`` for one that serves an ICD-11 block (``block``, or ``parent`` to a
        block) and for a block or chapter, when at least one ICD-11 anchor they reach is linked."""
        if not self.icd.links_studies:
            return None
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            return None
        if concept.level == 2:
            target = self.projection.target(concept_id)
            if target is None:
                return None
            if target.level != 1:
                return LINKED if self.icd.appraisal(target.concept_id, lens) == LINKED else None
        anchors = self.projection.anchors.get(concept_id, ())
        return INCLUDES_LINKED if any(self.icd.condition_linked(anchor, lens) for anchor in anchors) else None

    def layer(self, concept_id: str, lens: Lens) -> str | None:
        """``MetricsService.layer`` through the crosswalk (contract v1.13, §26):
        ``local`` for a condition that serves a local ICD-11 row,
        ``includes_local`` for a block or chapter one of whose ICD-11 anchors
        reads a local result, else None."""
        if self.icd.local is None:
            return None
        concept = self.atlas.by_id.get(concept_id)
        if concept is None:
            return None
        if concept.level == 2:
            served = self.icd11_row(concept_id, lens)
            return LOCAL if served is not None and served.provenance.layer == LOCAL else None
        for anchor in self.projection.anchors.get(concept_id, ()):
            child = self.icd.row(anchor, lens)
            if child is not None and child.provenance.layer == LOCAL:
                return INCLUDES_LOCAL
        return None


class ProjectedSafety:
    """``CardSafety`` in another ontology: the marks and incidents of each concept's ICD-11 anchors."""

    def __init__(self, projection: Projection, card: CardSafety):
        self.projection = projection
        self.card = card

    def mark(self, concept: Concept, lens: Lens) -> str | None:
        return self.card.mark_of(self.projection.anchors.get(concept.concept_id, ()), lens)

    def concept_incidents(self, concept: Concept, lens: Lens) -> list[dict]:
        return self.card.incidents_of(self.projection.anchors.get(concept.concept_id, ()), lens)


class ProjectedEffects:
    """``CardEffects`` in another ontology: the effects of each concept's ICD-11 anchors (contract v1.13, §27)."""

    def __init__(self, projection: Projection, card: CardEffects):
        self.projection = projection
        self.card = card

    def concept_effects(self, concept: Concept) -> list[dict]:
        return self.card.effects_of(self.projection.anchors.get(concept.concept_id, ()))
