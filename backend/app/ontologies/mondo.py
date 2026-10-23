"""MONDO (Monarch Initiative, CC BY 4.0) cut to the atlas shape.

MONDO is a graph; the atlas is a tree of chapters, blocks, and conditions.

* **Scope:** the live terms under "human disease" (MONDO:0700096).
* **Chapters** (``CHAPTERS``, hand-written, in ring order, which is also the
  priority order): the subclasses of "disease by body system or component"
  plus "cancer or benign tumor", "disease of primarily extrinsic mechanism"
  (infections and injuries), "psychiatric disorder", "sleep disorder",
  "obstetric disorder", and "metabolic disease", in an ICD-like order (cancer,
  infection, psychiatric before the body systems); then "syndromic disease"
  and, last, the two remaining groupings of human disease, "disease by
  developmental or physiological process" and "disease by etiologic
  mechanism", which collect the terms no other chapter holds (about 10 %).
  Each term's chapter is the first chapter that contains it.
* **Blocks:** the chapter's direct subclasses. A subclass without subclasses
  of its own in the chapter (a leaf, e.g. most syndromes directly under
  "syndromic disease") is not a block of its own: the chapter's leaves are
  gathered in one block "Other <chapter>" (id ``<chapter id>-other``), so a
  chapter never shows hundreds of one-condition blocks.
* **Conditions:** every other term of the chapter, under its *primary parent*:
  the first of its parents inside the chapter by label. Depth 1 are the
  primary children of a block; deeper terms have ``depth_in_kind`` 2 or 3
  (anything deeper counts as 3), the block as ``parent_id``, and their depth-1
  ancestor as ``metric_anchor_id``, as in the ICD-11 atlas.
* **Other parents** are kept (``parents``, primary first) for the condition card.
"""

from __future__ import annotations

from collections import defaultdict

from .model import OntologyConcept, ParsedOntology
from .obo import OboFile, OboTerm

ONTOLOGY_ID = "mondo"
NAME = "MONDO"
HUMAN_DISEASE = "MONDO:0700096"

# Chapter ids in ring order, which is also the priority order in which
# chapters claim terms. The frontend assigns their icons
# (frontend/src/features/atlas/layout/ontologyChapters.js).
CHAPTERS: tuple[str, ...] = (
    "MONDO:0045024",  # cancer or benign tumor
    "MONDO:7770010",  # disease of primarily extrinsic mechanism (infections, injuries)
    "MONDO:0002025",  # psychiatric disorder
    "MONDO:0100081",  # sleep disorder
    "MONDO:0700003",  # obstetric disorder
    "MONDO:0005066",  # metabolic disease
    "MONDO:0005570",  # hematologic disorder
    "MONDO:0005046",  # immune system disorder
    "MONDO:0005151",  # endocrine system disorder
    "MONDO:0005071",  # nervous system disorder
    "MONDO:0024458",  # disorder of visual system
    "MONDO:0002022",  # disorder of orbital region
    "MONDO:0002409",  # auditory system disorder
    "MONDO:0024623",  # otorhinolaryngologic disease
    "MONDO:0004995",  # cardiovascular disorder
    "MONDO:0005087",  # respiratory system disorder
    "MONDO:0004335",  # digestive system disorder
    "MONDO:0006858",  # mouth disorder
    "MONDO:0002051",  # integumentary system disorder
    "MONDO:0002081",  # musculoskeletal system disorder
    "MONDO:0003900",  # connective tissue disorder
    "MONDO:0002118",  # urinary system disorder
    "MONDO:0005039",  # reproductive system disorder
    "MONDO:0002657",  # breast disorder
    "MONDO:0002254",  # syndromic disease
    "MONDO:7770007",  # disease by developmental or physiological process
    "MONDO:7770008",  # disease by etiologic mechanism
)
MAX_DEPTH = 3


def display_name(label: str) -> str:
    """MONDO labels are lower case ("type 2 diabetes mellitus"); the atlas shows
    them with a capital first letter unless the label starts with an
    abbreviation or symbol ("pH", "IgA nephropathy", "46,XX")."""
    if len(label) >= 2 and label[0].islower() and not label[1].isupper():
        return label[0].upper() + label[1:]
    return label


def other_block_id(chapter_id: str) -> str:
    return f"{chapter_id}-other"


def live_terms(obo: OboFile) -> dict[str, OboTerm]:
    return {term_id: term for term_id, term in obo.terms.items() if term_id.startswith("MONDO:") and not term.obsolete}


def children_index(terms: dict[str, OboTerm]) -> dict[str, list[str]]:
    children: dict[str, list[str]] = defaultdict(list)
    for term in terms.values():
        for parent in term.is_a:
            if parent in terms:
                children[parent].append(term.id)
    return children


def descendants(root: str, children: dict[str, list[str]]) -> list[str]:
    """Every descendant of ``root``, breadth first, each once."""
    seen = {root}
    order = []
    frontier = [root]
    while frontier:
        following = []
        for term_id in frontier:
            for child in children.get(term_id, ()):
                if child not in seen:
                    seen.add(child)
                    order.append(child)
                    following.append(child)
        frontier = following
    return order


def build_mondo(obo: OboFile, release: str, chapters: tuple[str, ...] = CHAPTERS) -> ParsedOntology:
    terms = live_terms(obo)
    children = children_index(terms)
    human = set(descendants(HUMAN_DISEASE, children)) if HUMAN_DISEASE in terms else set()
    chapter_ids = [chapter for chapter in chapters if chapter in terms]

    chapter_of: dict[str, str] = {chapter: chapter for chapter in chapter_ids}
    for chapter in chapter_ids:
        for term_id in descendants(chapter, children):
            if term_id in human:
                chapter_of.setdefault(term_id, chapter)

    def name_key(term_id: str) -> tuple[str, str]:
        return (terms[term_id].name.casefold(), term_id)

    parsed = ParsedOntology(ONTOLOGY_ID, NAME, "MONDO", release)
    concepts = parsed.concepts
    for chapter_index, chapter in enumerate(chapter_ids, start=1):
        members = [term_id for term_id, owner in chapter_of.items() if owner == chapter and term_id != chapter]
        member_set = set(members)

        def in_chapter(term_id: str) -> bool:
            return term_id == chapter or term_id in member_set

        primary: dict[str, str] = {}
        direct = []
        for term_id in members:
            parents = [parent for parent in terms[term_id].is_a if parent in terms and in_chapter(parent)]
            if chapter in parents:
                direct.append(term_id)
            else:
                primary[term_id] = min(parents, key=name_key)
        primary_children: dict[str, list[str]] = defaultdict(list)
        for term_id, parent in primary.items():
            primary_children[parent].append(term_id)
        blocks = sorted((term_id for term_id in direct if primary_children.get(term_id)), key=name_key)
        leaves = sorted((term_id for term_id in direct if not primary_children.get(term_id)), key=name_key)

        chapter_label = terms[chapter].name
        # MONDO has no chapter numbers; the contract's two-digit chapter_no is the ring position.
        chapter_no = f"{chapter_index:02d}"
        concepts.append(
            OntologyConcept(
                concept_id=chapter,
                parent_id=None,
                level=0,
                chapter_id=chapter,
                chapter_no=chapter_no,
                block_id=None,
                code=chapter,
                pt=display_name(chapter_label),
                fsn=f"{chapter_label} ({chapter})",
                sort_order=chapter_index,
            )
        )
        groups: list[tuple[str, list[str], OntologyConcept]] = []
        for block_index, block in enumerate(blocks, start=1):
            label = terms[block].name
            groups.append(
                (
                    block,
                    sorted(primary_children[block], key=name_key),
                    OntologyConcept(
                        concept_id=block,
                        parent_id=chapter,
                        level=1,
                        chapter_id=chapter,
                        chapter_no=chapter_no,
                        block_id=block,
                        code=block,
                        pt=display_name(label),
                        fsn=f"{label} ({block})",
                        sort_order=chapter_index * 1000 + block_index,
                        parents=_parents(terms[block], terms, chapter_of, chapter),
                    ),
                )
            )
        if leaves:
            other = other_block_id(chapter)
            groups.append(
                (
                    other,
                    leaves,
                    OntologyConcept(
                        concept_id=other,
                        parent_id=chapter,
                        level=1,
                        chapter_id=chapter,
                        chapter_no=chapter_no,
                        block_id=other,
                        code=None,
                        pt=f"Other {chapter_label}",
                        fsn=f"Other {chapter_label} (subclasses of {chapter} without subclasses of their own)",
                        sort_order=chapter_index * 1000 + len(blocks) + 1,
                    ),
                )
            )
        for block, top, block_concept in groups:
            concepts.append(block_concept)
            position = 0
            # Depth first in label order: each condition, then its primary descendants.
            stack = [(term_id, 1, term_id) for term_id in reversed(top)]
            while stack:
                term_id, depth, anchor = stack.pop()
                position += 1
                label = terms[term_id].name
                concepts.append(
                    OntologyConcept(
                        concept_id=term_id,
                        parent_id=block,
                        level=2,
                        chapter_id=chapter,
                        chapter_no=chapter_no,
                        block_id=block,
                        code=term_id,
                        pt=display_name(label),
                        fsn=None,  # lean: the cancer chapter's 4,700 conditions stay within the 2 MB budget
                        sort_order=block_concept.sort_order * 100000 + position,
                        depth_in_kind=min(depth, MAX_DEPTH),
                        metric_anchor_id=anchor,
                        parents=_parents(terms[term_id], terms, chapter_of, chapter, primary.get(term_id)),
                    )
                )
                for child in sorted(primary_children.get(term_id, ()), key=name_key, reverse=True):
                    stack.append((child, depth + 1, anchor))
    parsed.notes = {
        "live_terms": len(terms),
        "human_disease_terms": len(human),
        "terms_in_chapters": sum(1 for concept in concepts if concept.code),
        "human_disease_terms_left_out": len(human - {concept.concept_id for concept in concepts}),
    }
    return parsed


def _parents(term: OboTerm, terms: dict[str, OboTerm], chapter_of: dict[str, str], chapter: str, primary: str | None = None) -> tuple[str, ...]:
    """Every parent the import holds, the primary one first (the chapter, for a block)."""
    held = [parent for parent in term.is_a if parent in terms and parent in chapter_of]
    first = primary or (chapter if chapter in held else None)
    ordered = ([first] if first else []) + sorted((parent for parent in held if parent != first), key=lambda p: (terms[p].name.casefold(), p))
    return tuple(dict.fromkeys(ordered))
