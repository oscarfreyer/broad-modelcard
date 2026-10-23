"""Concept search (CONTRACT.md §9).

Matching is ported from ``searchableConcepts`` and ``handleSearchSubmit`` in
src/App.jsx (v0.2.0-alpha.1): a case-insensitive substring match of the
trimmed query against the code (``icd11_code``, else ``concept_id``) or
against ``pt + ' ' + fsn + ' ' + concept_id``. Which concepts match and
``total`` are unchanged.

The order changed in contract v1.12 (CONTRACT.md §9, §12.1): the reference
sorted every match by level, then preferred term, so "diabetes" led with
"Hypoglycaemia in the context of diabetes mellitus". Matches are now ranked
by how well they match, best first:

0. the code is the query;
1. the code starts with the query;
2. the preferred term is the query;
3. the preferred term starts with the query, or holds it as a whole word (or
   words): "Type 2 diabetes mellitus" and "Diabetes mellitus in pregnancy"
   share this rank, so the shorter, more general term leads;
4. a word of the preferred term starts with the query ("diab" in "Type 2
   diabetes mellitus");
5. any other match (inside a word, the fully specified name, the concept id).

Within a code rank, shorter codes come first, then the code ("1A0" lists
1A00, 1A01, … before 1A00.0). Within a term rank, shorter preferred terms come
first, then the lower level, then the preferred term (``localeCompare``).
Ties keep concept order.

**Synonyms (contract v1.14, CONTRACT.md §9, §31).** With synonyms (imported
with the ontologies, ``app/ontologies/synonyms.py``), a concept that no rank
above matches but one of whose synonyms holds the query is a further match,
ranked after every match above: by how its best synonym matches (the synonym
is the query; starts with it or holds it as whole words; a word starts with
it; any other match), then shorter synonyms, the lower level, the preferred
term, and concept order. ``SearchHit.synonyms`` names the synonym each such
match was found by. Without synonyms the search is exactly what it was.

**Hyphens (contract v1.14 review fix, CONTRACT.md §9, §31).** A hyphen
counts as a space on both sides: in the query, the code, the searched text,
the preferred term, and the synonyms, so "heart-failure" finds Heart failure
and "covid 19" finds COVID-19. A query without a hyphen or a space is
matched and ranked exactly as before.

``conditions`` serves the plain-language interpreter (§31): the concept
whose code is a phrase, those whose preferred term or a synonym is the
phrase, and those whose preferred term holds it as whole words, in that
order (see the method). It compares words, so punctuation between words
(a hyphen, a comma) never decides a match.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from .atlas import Atlas
from .jsnum import locale_sort_key

RANK_CODE = 0
RANK_CODE_PREFIX = 1
RANK_TERM = 2
RANK_WORD = 3
RANK_WORD_PREFIX = 4
RANK_SUBSTRING = 5

_BEFORE = r"(?<![0-9a-z])"
_AFTER = r"(?![0-9a-z])"
_WORD = re.compile(r"[0-9a-z]+")
# A code no concept has: synonyms rank as preferred terms do, never by code.
_NO_CODE = "\0"


@dataclass(frozen=True)
class SearchHit:
    total: int
    concept_ids: list[str]
    # Contract v1.14 (§31): the synonym each synonym match was found by, by concept id.
    synonyms: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ConditionMatch:
    """A concept the interpreter (§31) found for a phrase: how (``code``, ``term``, ``synonym``) and by what text."""

    concept_id: str
    match: str
    matched_term: str | None = None


@dataclass(frozen=True)
class _Entry:
    concept_id: str
    code: str
    term: str
    # The preferred term as written.
    pt: str
    haystack: str
    # The order within a code rank: (length of the code, code).
    code_order: tuple
    # The order within a term rank: (length of the preferred term, level, preferred term).
    term_order: tuple

    def order(self, rank: int) -> tuple:
        return (rank, self.code_order if rank <= RANK_CODE_PREFIX else self.term_order)


def match_rank(query: str, code: str, term: str) -> int:
    """The rank of a match (lowercase query, code, and preferred term); see the module notes."""
    if code == query:
        return RANK_CODE
    if code.startswith(query):
        return RANK_CODE_PREFIX
    if term == query:
        return RANK_TERM
    escaped = re.escape(query)
    if term.startswith(query) or re.search(f"{_BEFORE}{escaped}{_AFTER}", term):
        return RANK_WORD
    if re.search(f"{_BEFORE}{escaped}", term):
        return RANK_WORD_PREFIX
    return RANK_SUBSTRING


def words_of(text: str) -> list[str]:
    """The words of a lowercase text: runs of letters and digits, as the ranks count them."""
    return _WORD.findall(text)


def _lower(text: str) -> str:
    return " ".join(text.split()).lower()


def unhyphen(text: str) -> str:
    """A lowercase text with its hyphens as spaces (v1.14 review fix): what the search matches and ranks."""
    return text.replace("-", " ")


def _holds_words(words: Sequence[str], run: Sequence[str]) -> bool:
    """Whether ``run`` is a run of consecutive words of ``words``."""
    size = len(run)
    return any(words[start : start + size] == run for start in range(len(words) - size + 1))


class SearchIndex:
    def __init__(self, atlas: Atlas, synonyms: Mapping[str, Sequence[tuple[str, str]]] | None = None):
        # Kept in the reference's order (level, then preferred term), so the
        # final stable sort keeps concept order for equal keys as the
        # reference's Array.prototype.sort does.
        ordered = sorted(atlas.concepts, key=lambda concept: (concept.level, locale_sort_key(concept.pt)))
        self._entries = []
        for concept in ordered:
            # Some preferred terms carry a leading "- " (ICD-11 residual categories).
            # Hyphens count as spaces (contract v1.14 review fix); lengths and so the orders are unchanged.
            term = unhyphen(concept.pt.lstrip("- ").strip().lower())
            code = unhyphen((concept.icd11_code or concept.concept_id).lower())
            self._entries.append(
                _Entry(
                    concept_id=concept.concept_id,
                    code=code,
                    term=term,
                    pt=concept.pt,
                    # A null fsn contributes an empty string. The reference would
                    # render it as the text "null"; no current concept lacks an fsn.
                    haystack=unhyphen(f"{concept.pt} {concept.fsn or ''} {concept.concept_id}".lower()),
                    code_order=(len(code), code),
                    term_order=(len(term), concept.level, locale_sort_key(concept.pt)),
                )
            )
        # Contract v1.14 (§31): per entry position, its synonyms as stored and in lower case
        # (hyphens as spaces since the v1.14 review fix).
        self._synonyms: dict[int, tuple[tuple[str, ...], tuple[str, ...]]] = {}
        if synonyms:
            for position, entry in enumerate(self._entries):
                texts = tuple(text for text, _ in synonyms.get(entry.concept_id, ()))
                if texts:
                    self._synonyms[position] = (texts, tuple(unhyphen(_lower(text)) for text in texts))
        self._by_code: dict[str, int] = {}
        for position, entry in enumerate(self._entries):
            self._by_code.setdefault(entry.code, position)
        self._postings: dict[str, set[tuple[int, int]]] | None = None

    @property
    def has_synonyms(self) -> bool:
        return bool(self._synonyms)

    def search(self, query: str, limit: int) -> SearchHit:
        """Matches for an already trimmed, non-empty query, best match first."""
        needle = unhyphen(query.lower())
        matched: set[int] = set()
        matches = []
        for position, entry in enumerate(self._entries):
            if needle in entry.code or needle in entry.haystack:
                matches.append(entry)
                matched.add(position)
        matches.sort(key=lambda entry: entry.order(match_rank(needle, entry.code, entry.term)))
        concept_ids = [entry.concept_id for entry in matches[:limit]]
        if not self._synonyms:
            return SearchHit(total=len(matches), concept_ids=concept_ids)
        found = self._synonym_matches(needle, matched)
        chosen = found[: max(0, limit - len(concept_ids))]
        return SearchHit(
            total=len(matches) + len(found),
            concept_ids=concept_ids + [self._entries[position].concept_id for _, position, _ in chosen],
            synonyms={self._entries[position].concept_id: text for _, position, text in chosen},
        )

    def _best_synonym(self, needle: str, position: int) -> tuple[tuple, str] | None:
        """The best synonym of an entry holding ``needle``: ((rank, length), text), or None."""
        texts, lowered = self._synonyms[position]
        best = None
        for text, lower in zip(texts, lowered):
            if needle not in lower:
                continue
            order = (match_rank(needle, _NO_CODE, lower), len(lower))
            if best is None or order < best[0]:
                best = (order, text)
        return best

    def _synonym_matches(self, needle: str, matched: set[int]) -> list[tuple[tuple, int, str]]:
        """Synonym matches of the entries not matched otherwise, best first: (order, position, synonym)."""
        found = []
        for position in self._synonyms:
            if position in matched:
                continue
            best = self._best_synonym(needle, position)
            if best is not None:
                entry = self._entries[position]
                found.append(((*best[0], *entry.term_order[1:]), position, best[1]))
        found.sort(key=lambda item: (item[0], item[1]))
        return found

    # ------------------------------------------------------------ interpreter (§31)

    def _words(self) -> dict[str, set[tuple[int, int]]]:
        """Word → {(entry position, -1 for the preferred term or the synonym's index)}, built on first use."""
        if self._postings is None:
            postings: dict[str, set[tuple[int, int]]] = {}
            for position, entry in enumerate(self._entries):
                for word in set(words_of(entry.term)):
                    postings.setdefault(word, set()).add((position, -1))
            for position, (_, lowered) in self._synonyms.items():
                for index, lower in enumerate(lowered):
                    for word in set(words_of(lower)):
                        postings.setdefault(word, set()).add((position, index))
            self._postings = postings
        return self._postings

    def code_match(self, code: str) -> str | None:
        """The concept whose code (ICD-11 code, else concept id) is ``code``, ignoring case."""
        position = self._by_code.get(unhyphen(code.strip().lower()))
        return self._entries[position].concept_id if position is not None else None

    def conditions(self, phrase: str, limit: int = 3, *, exact_only: bool = False) -> list[ConditionMatch]:
        """Concepts the phrase names, best first (a concept once, by its best way):

        1. the concept whose code is the phrase;
        2. concepts whose preferred term is the phrase;
        3. concepts with a synonym that is the phrase (shorter synonym, lower level, preferred term);
        4. concepts whose preferred term holds the phrase as whole words, in search order.

        A phrase inside a longer synonym does not count: a synonym names the
        whole concept, so "chest pain" is not "anginal chest pain at rest". With ``exact_only``,
        4 counts only for a chapter or block named "<phrase> or …": the
        interpreter reads a single word so ("epilepsy" is "Epilepsy or seizures"; "pain" is no condition)."""
        needle = _lower(phrase)
        words = words_of(needle)
        if not words:
            return []
        found: list[ConditionMatch] = []
        seen: set[str] = set()

        def add(position: int, match: str, text: str | None) -> None:
            concept_id = self._entries[position].concept_id
            if concept_id not in seen:
                seen.add(concept_id)
                found.append(ConditionMatch(concept_id, match, text))

        code = self.code_match(needle)
        if code is not None:
            seen.add(code)
            found.append(ConditionMatch(code, "code", None))
        postings = self._words()
        lists = sorted((postings.get(word, set()) for word in set(words)), key=len)
        candidates = set(lists[0])
        for other in lists[1:]:
            if not candidates:
                break
            candidates &= other
        # Words are compared, not the text (contract v1.14 review fix): "heart-failure" is Heart failure,
        # and "covid 19" and "covid-19" are both COVID-19.
        code_needle = unhyphen(needle)
        terms: list[tuple[int, int]] = []
        synonyms: list[tuple[tuple, int, str]] = []
        for position, index in sorted(candidates):
            entry = self._entries[position]
            if index < 0:
                term_words = words_of(entry.term)
                if _holds_words(term_words, words):
                    terms.append((position, RANK_TERM if term_words == words else RANK_WORD))
                continue
            texts, lowered = self._synonyms[position]
            if words_of(lowered[index]) == words:
                synonyms.append(((len(lowered[index]), *entry.term_order[1:]), position, texts[index]))

        def term_rank(position: int, rank: int) -> int:
            # As ``match_rank`` ranks a term that holds the phrase: by code first, then exact or whole words.
            code = self._entries[position].code
            if code == code_needle:
                return RANK_CODE
            return RANK_CODE_PREFIX if code.startswith(code_needle) else rank

        terms.sort(key=lambda item: (self._entries[item[0]].order(term_rank(*item)), item[0]))
        for position, rank in terms:
            if rank == RANK_TERM:
                add(position, "term", self._entries[position].pt)
        for _, position, text in sorted(synonyms, key=lambda item: (item[0], item[1])):
            add(position, "synonym", text)
        for position, _ in terms:
            entry = self._entries[position]
            # Read strictly, only a chapter or block named "<phrase> or …" counts ("Epilepsy or seizures").
            if not exact_only or (entry.term_order[1] <= 1 and words_of(entry.term)[: len(words) + 1] == [*words, "or"]):
                add(position, "term", entry.pt)
        return found[:limit]
