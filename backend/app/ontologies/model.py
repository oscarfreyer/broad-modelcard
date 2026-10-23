"""The shapes the parsers produce and the importer stores (CONTRACT.md §23)."""

from __future__ import annotations

from dataclasses import dataclass, field

# Crosswalk kinds (CONTRACT.md §23). ``parent``: inherited from the nearest
# directly mapped parent (MONDO, at most two is_a steps up).
MAPPING_KINDS = ("exact", "stem", "block", "parent", "none")


@dataclass
class OntologyConcept:
    """One concept in the atlas shape: level 0 chapter, 1 block, 2 condition.

    Level-2 concepts have the block as ``parent_id`` (as in the ICD-11 atlas);
    deeper ones (``depth_in_kind`` 2–3) name their depth-1 ancestor as
    ``metric_anchor_id``. ``parents`` lists every parent in the source
    hierarchy that the import holds (MONDO is a graph; the first is the
    primary parent, the others are shown on the condition card)."""

    concept_id: str
    parent_id: str | None
    level: int
    chapter_id: str
    chapter_no: str | None
    block_id: str | None
    code: str | None
    pt: str
    fsn: str | None
    sort_order: int
    depth_in_kind: int | None = None
    metric_anchor_id: str | None = None
    parents: tuple[str, ...] = ()


@dataclass(frozen=True)
class Mapping:
    """A level-2 concept's crosswalk to an ICD-11 atlas concept.

    ``target_concept_id``: the ICD-11 concept that serves the result: a
    level-2 concept for ``exact`` and ``stem``, a block for ``block``, and for
    ``parent`` whatever the ``via`` concept's own mapping names. ``source``
    names the table or cross-reference the mapping came from, ``source_code``
    the code it was read under (the ICD-10 code of the WHO table, MONDO's
    foundation id or ICD-10 code), and ``icd11_code`` the ICD-11 MMS code the
    source named, before it was resolved to the atlas."""

    concept_id: str
    kind: str
    target_concept_id: str | None = None
    via_concept_id: str | None = None
    steps: int | None = None
    source: str | None = None
    source_code: str | None = None
    icd11_code: str | None = None


@dataclass
class ParsedOntology:
    ontology_id: str
    name: str
    short_name: str
    release: str
    concepts: list[OntologyConcept] = field(default_factory=list)
    # Facts about the source for the import report (counts, what was left out).
    notes: dict[str, int] = field(default_factory=dict)
