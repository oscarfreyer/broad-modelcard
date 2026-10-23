"""Synonyms of ICD-11 concepts from the pinned ontology files (contract v1.14, CONTRACT.md §31).

The plain-language search (§9, §31) also matches what people call a
condition when ICD-11 names it otherwise ("heart attack", "high blood
pressure", "Myxedema"). The synonyms come from the files the ontology import
already reads, never from a new download:

* ``mondo``: the label and the EXACT synonyms of every MONDO condition whose
  own crosswalk (§23.2) reaches an ICD-11 concept directly: kind ``exact`` or
  ``stem``. Mappings inherited from a parent (``parent``) and mappings to a
  whole block (``block``) are too broad to name a concept, so they give none.
* ``icd10cm_index``: the main terms with a code of the ICD-10-CM index to
  diseases and injuries (``icd10cm.read_index``) whose code reaches an ICD-11
  concept through the WHO ICD-10 rule (``exact`` or ``stem``). A title with
  inflected forms ("Infarct, infarction", "Diabetes, diabetic") gives each
  form; any other title is kept whole ("Pharyngotracheitis, chronic").

Each synonym belongs to the level-2 ICD-11 concept the mapping names. Kept
out: a synonym that equals the concept's preferred term, one shorter than
three characters, one without a letter (only digits and punctuation), and a
repeat of another synonym of the same concept (case-insensitively; the first
source in import order wins). The source and the code it was read under are
stored for attribution.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass

from .crosswalk import Icd11Resolver, map_icd10
from .model import Mapping
from .obo import OboTerm
from .who import WhoMapping

SOURCE_MONDO = "mondo"
SOURCE_ICD10CM_INDEX = "icd10cm_index"
SOURCES = (SOURCE_MONDO, SOURCE_ICD10CM_INDEX)
# Which ontology import writes which source.
SOURCE_OF_ONTOLOGY = {"mondo": SOURCE_MONDO, "icd10cm": SOURCE_ICD10CM_INDEX}
DIRECT_KINDS = ("exact", "stem")
MIN_LENGTH = 3
MAX_LENGTH = 200
# Forms of one word share their start: "Infarct, infarction", "Diabetes, diabetic".
_INFLECTION_PREFIX = 4
_LETTER = re.compile(r"[^\W\d_]")


@dataclass(frozen=True)
class Synonym:
    concept_id: str  # the ICD-11 level-2 concept (concepts.concept_id)
    text: str
    source: str
    source_code: str  # the MONDO id or the ICD-10-CM code it was read under


def clean(text: str) -> str | None:
    """The synonym with its spacing tidied, or None when it is too short, too long, or has no letter."""
    tidy = " ".join(str(text or "").split())
    if len(tidy) < MIN_LENGTH or len(tidy) > MAX_LENGTH or not _LETTER.search(tidy):
        return None
    return tidy


def key_of(text: str) -> str:
    """The comparison key: case-insensitive, spacing collapsed, a leading "- " ignored (as search does)."""
    return " ".join(text.split()).lstrip("- ").strip().casefold()


def index_forms(title: str) -> list[str]:
    """An ICD-10-CM index title's forms: each comma-separated inflection, else the title whole."""
    parts = [part.strip() for part in title.split(",") if part.strip()]
    if len(parts) < 2:
        return [title]
    stem = parts[0].casefold()[:_INFLECTION_PREFIX]
    if all(" " not in part and part.casefold()[:_INFLECTION_PREFIX] == stem for part in parts[1:]):
        return parts
    return [title]


def mondo_candidates(mappings: Iterable[Mapping], terms: dict[str, OboTerm]) -> list[Synonym]:
    found = []
    for mapping in mappings:
        if mapping.kind not in DIRECT_KINDS or mapping.target_concept_id is None:
            continue
        term = terms.get(mapping.concept_id)
        if term is None:
            continue
        for text in (term.name, *term.synonyms):
            found.append(Synonym(mapping.target_concept_id, text, SOURCE_MONDO, term.id))
    return found


def icd10cm_index_candidates(entries: Iterable[tuple[str, str]], who: WhoMapping, resolver: Icd11Resolver) -> list[Synonym]:
    found = []
    for title, code in entries:
        mapping = map_icd10(code, who, resolver, source=SOURCE_ICD10CM_INDEX, concept_id=code)
        if mapping is None or mapping.kind not in DIRECT_KINDS:
            continue
        for form in index_forms(title):
            found.append(Synonym(mapping.target_concept_id, form, SOURCE_ICD10CM_INDEX, code))
    return found


def finalize(candidates: Iterable[Synonym], preferred_terms: dict[str, str]) -> list[Synonym]:
    """Clean, drop the preferred term itself, and drop repeats per concept (first wins).

    ``preferred_terms`` maps each ICD-11 level-2 concept to its preferred term;
    a candidate for any other concept is dropped."""
    kept: list[Synonym] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        preferred = preferred_terms.get(candidate.concept_id)
        if preferred is None:
            continue
        text = clean(candidate.text)
        if text is None:
            continue
        key = key_of(text)
        if key == key_of(preferred) or (candidate.concept_id, key) in seen:
            continue
        seen.add((candidate.concept_id, key))
        kept.append(Synonym(candidate.concept_id, text, candidate.source, candidate.source_code))
    return kept


def preferred_terms(conn: sqlite3.Connection) -> dict[str, str]:
    """The ICD-11 level-2 concepts of the store's atlas and their preferred terms."""
    return dict(conn.execute("SELECT concept_id, pt FROM concepts WHERE level = 2"))


def replace_synonyms(conn: sqlite3.Connection, source: str, synonyms: list[Synonym]) -> None:
    """Replace one source's synonyms (call inside the import's transaction)."""
    conn.execute("DELETE FROM concept_synonyms WHERE source = ?", (source,))
    conn.executemany(
        "INSERT INTO concept_synonyms (source, concept_id, synonym_key, synonym, source_code, position) VALUES (?, ?, ?, ?, ?, ?)",
        [(source, item.concept_id, key_of(item.text), item.text, item.source_code, position) for position, item in enumerate(synonyms)],
    )


def load_synonyms(conn: sqlite3.Connection) -> dict[str, list[tuple[str, str]]]:
    """Each ICD-11 concept's synonyms as ``(text, source)``, MONDO first, each once (case-insensitively).

    A store without the table (older schema) or without an import has none."""
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'concept_synonyms'").fetchone()
    if not exists:
        return {}
    order = {source: rank for rank, source in enumerate(SOURCES)}
    rows = conn.execute("SELECT concept_id, synonym_key, synonym, source, position FROM concept_synonyms").fetchall()
    rows.sort(key=lambda row: (order.get(row[3], len(order)), row[4]))
    found: dict[str, list[tuple[str, str]]] = {}
    seen: set[tuple[str, str]] = set()
    for concept_id, key, text, source, _ in rows:
        if (concept_id, key) in seen:
            continue
        seen.add((concept_id, key))
        found.setdefault(concept_id, []).append((text, source))
    return found
