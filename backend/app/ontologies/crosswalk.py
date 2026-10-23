"""Crosswalk rules from ICD-10-CM and MONDO to the ICD-11 atlas (CONTRACT.md §23).

**Resolving an ICD-11 MMS code** to the atlas (``Icd11Resolver``): the level-2
concept with that code (``exact``); else the code with its last character
after the dot dropped, repeatedly (5A13.12 → 5A13.1 → 5A13), until a level-2
concept has it (``stem``; R0 took the four-character stem only, which reaches
the same depth-1 condition and so the same result); else the
atlas block whose ICD-11 block id ends in the code's first three characters
(``block``, e.g. 5A1 → BlockL1-5A1); else nothing.

**ICD-10-CM** (and MONDO's ICD-10 cross-references): the longest prefix of
the code, at least a three-character category, that WHO's
``10To11MapToOneCategory`` table maps; its ICD-11 code is resolved as above.
A code without such a prefix, or whose ICD-11 code does not resolve, is
``none``.

**MONDO:** the first cross-reference that resolves, in this order: every
``icd11.foundation`` reference (the Foundation entity's MMS code from the
WHO tables), every ``ICD10CM`` reference, every ``ICD10WHO`` reference (both
through the ICD-10 rule). A term without one inherits the mapping of its
nearest directly mapped parent at most ``MAX_PARENT_STEPS`` ``is_a`` steps up
(kind ``parent``, with the parent as ``via`` and the number of steps; among
parents at the same distance, the first by label). Inheriting from any
ancestor would reach far more terms, but through very broad parents, so it is
not done (R0). Otherwise ``none``: the condition shows **No mapping**, never a
guessed result.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass

from .model import Mapping, OntologyConcept
from .obo import OboTerm
from .who import WhoMapping

MAX_PARENT_STEPS = 2
_BLOCK_PREFIX = re.compile(r"BlockL1-([0-9A-Z]{3})$")

SOURCE_WHO_ICD10 = "who-icd10-icd11"  # WHO 10To11MapToOneCategory
SOURCE_MONDO_FOUNDATION = "mondo-icd11-foundation"  # MONDO xref icd11.foundation + WHO foundation tables
SOURCE_MONDO_ICD10CM = "mondo-icd10cm"  # MONDO xref ICD10CM + WHO 10 → 11
SOURCE_MONDO_ICD10WHO = "mondo-icd10who"  # MONDO xref ICD10WHO + WHO 10 → 11


@dataclass(frozen=True)
class Resolved:
    kind: str  # exact | stem | block
    concept_id: str


class Icd11Resolver:
    """ICD-11 MMS codes → concepts of the store's ICD-11 atlas (the ``concepts`` table)."""

    def __init__(self, rows: list[tuple[str, int, str | None]]):
        self.by_code: dict[str, str] = {}
        self.block_by_prefix: dict[str, str] = {}
        for concept_id, level, code in rows:
            if level == 2 and code:
                self.by_code.setdefault(code.upper(), concept_id)
            elif level == 1:
                match = _BLOCK_PREFIX.search(concept_id)
                if match:
                    self.block_by_prefix.setdefault(match.group(1), concept_id)

    @classmethod
    def from_store(cls, conn: sqlite3.Connection) -> "Icd11Resolver":
        return cls(conn.execute("SELECT concept_id, level, icd11_code FROM concepts ORDER BY concept_key").fetchall())

    def resolve(self, code: str | None) -> Resolved | None:
        code = (code or "").strip().upper()
        if not code:
            return None
        if code in self.by_code:
            return Resolved("exact", self.by_code[code])
        # ICD-11 adds one character per level after the dot (1A03 → 1A03.1 → 1A03.10).
        stem = code
        while "." in stem:
            stem = stem[:-1].rstrip(".")
            if stem in self.by_code:
                return Resolved("stem", self.by_code[stem])
        block = self.block_by_prefix.get(code[:3])
        return Resolved("block", block) if block else None


def map_icd10(code: str, who: WhoMapping, resolver: Icd11Resolver, *, source: str, concept_id: str) -> Mapping | None:
    """The ICD-10 rule: longest WHO ICD-10 prefix → ICD-11 code → atlas, or None."""
    prefix = who.icd10_prefix(code)
    if prefix is None:
        return None
    icd11 = who.icd10_to_icd11[prefix]
    resolved = resolver.resolve(icd11)
    if resolved is None:
        return None
    return Mapping(concept_id, resolved.kind, resolved.concept_id, source=source, source_code=prefix, icd11_code=icd11)


def icd10cm_crosswalk(concepts: list[OntologyConcept], who: WhoMapping, resolver: Icd11Resolver) -> list[Mapping]:
    mappings = []
    for concept in concepts:
        if concept.level != 2:
            continue
        mapping = map_icd10(concept.code or concept.concept_id, who, resolver, source=SOURCE_WHO_ICD10, concept_id=concept.concept_id)
        mappings.append(mapping or Mapping(concept.concept_id, "none"))
    return mappings


def mondo_direct(term: OboTerm, who: WhoMapping, resolver: Icd11Resolver) -> Mapping | None:
    """A MONDO term's own mapping through its cross-references, or None."""
    for xref in term.xrefs:
        if xref.startswith("icd11.foundation:"):
            entity = xref.split(":", 1)[1].strip()
            icd11 = who.foundation_to_mms.get(entity)
            resolved = resolver.resolve(icd11) if icd11 else None
            if resolved is not None:
                return Mapping(term.id, resolved.kind, resolved.concept_id, source=SOURCE_MONDO_FOUNDATION, source_code=entity, icd11_code=icd11)
    for prefix, source in (("ICD10CM:", SOURCE_MONDO_ICD10CM), ("ICD10WHO:", SOURCE_MONDO_ICD10WHO)):
        for xref in term.xrefs:
            if xref.startswith(prefix):
                mapping = map_icd10(xref[len(prefix):], who, resolver, source=source, concept_id=term.id)
                if mapping is not None:
                    return mapping
    return None


def mondo_crosswalk(
    concepts: list[OntologyConcept], terms: dict[str, OboTerm], who: WhoMapping, resolver: Icd11Resolver
) -> list[Mapping]:
    """Mappings of the level-2 concepts. Parents count only when the import
    holds them (any chapter, block, or condition), so every ``via`` is a
    concept a reader can open."""
    held = {concept.concept_id for concept in concepts}
    direct: dict[str, Mapping | None] = {}

    def direct_of(term_id: str) -> Mapping | None:
        if term_id not in direct:
            direct[term_id] = mondo_direct(terms[term_id], who, resolver) if term_id in terms else None
        return direct[term_id]

    def name_key(term_id: str) -> tuple[str, str]:
        return (terms[term_id].name.casefold(), term_id)

    mappings = []
    for concept in concepts:
        if concept.level != 2:
            continue
        own = direct_of(concept.concept_id)
        if own is not None:
            mappings.append(own)
            continue
        inherited = None
        frontier = [concept.concept_id]
        seen = {concept.concept_id}
        for steps in range(1, MAX_PARENT_STEPS + 1):
            parents = []
            for term_id in frontier:
                for parent in terms[term_id].is_a if term_id in terms else ():
                    if parent in held and parent not in seen:
                        seen.add(parent)
                        parents.append(parent)
            mapped = sorted((parent for parent in parents if direct_of(parent) is not None), key=name_key)
            if mapped:
                via = direct_of(mapped[0])
                inherited = Mapping(
                    concept.concept_id,
                    "parent",
                    via.target_concept_id,
                    via_concept_id=mapped[0],
                    steps=steps,
                    source=via.source,
                    source_code=via.source_code,
                    icd11_code=via.icd11_code,
                )
                break
            frontier = parents
        mappings.append(inherited or Mapping(concept.concept_id, "none"))
    return mappings
