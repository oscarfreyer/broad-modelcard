"""From the model's answer to proposed template records, checked against the store.

The model proposes; this module decides what may be shown as a proposal:

* **Cards** must exist in the live registry (with metrics). A record for an
  unknown card, or for another card than the one the maintainer chose, is
  dropped with its reason.
* **ICD-11 codes** must exist in the atlas. A code the model gave that the
  atlas does not know is dropped, never replaced by a guess. A record without
  a code is resolved by the condition's name: an exact name match in the
  store, or, for a local model, the model's choice among the store's search
  candidates (``choose``); nothing else.
* **Values** are mapped to the template's readable labels; anything that does
  not fit is kept but marked uncertain, so the check (CONTRACT.md §11) reports
  it after the maintainer accepts.
* **Metrics fields the study does not state** keep the stored row's value
  (origin ``store``), because a merge row replaces the whole stored row
  (CONTRACT.md §11.2). Without a stored row they stay empty and are marked.
  A field the model gave but that does not parse stays empty and flagged; it
  is never filled from the stored row. A record that keeps stored values under
  this study's Source, Study, and Source date has its Source flagged: staging
  credits the whole row to this study, so the maintainer decides.

Each proposed record carries ``record`` (exactly what ``createRecordsUpload``
takes) and, per field, its origin, source quote and location, confidence, and
uncertainty.
"""

from __future__ import annotations

import contextlib
import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Protocol

from .. import repository
from ..publishing.files import _metric_cells
from ..schema.contract import AGE_ALL, ETHNICITY_ALL, METRIC_ROW_FORMAT, SEX_ALL
from ..schema.templates import (
    HARM_LABELS,
    INCIDENT_STATUS_LABELS,
    INCIDENT_TYPE_LABELS,
    MAX_SUMMARY,
    SOURCE_TYPE_LABELS,
    TEMPLATES,
    VALIDATION_TYPE_LABELS,
    normalize_header,
)
from ..services.search import SearchIndex
from ..services.types import Concept, Lens
from .prompting import MAX_SEARCH_HITS, Card

MAX_CANDIDATES = 8
_CHAPTER = re.compile(r"^\s*(?:chapter|ch)[\s-]*(\d{1,2})\s*$", re.IGNORECASE)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

RECORD_KEYS = {
    kind: tuple(column.key for column in TEMPLATES[kind] if not column.info and column.key != "action")
    for kind in ("metrics", "safety")
}
# Fields the model is asked for (prompting.field_guide); the rest of a metrics
# record comes from the stored row.
STUDY_METRIC_FIELDS = (
    "perf", "ci_low", "ci_high", "n_samples", "n_sites", "n_studies", "peer_reviewed_studies", "validation_type",
)
ROW_SOURCE_FIELDS = ("source", "study", "source_date")
# The metric fields a study reports; intended use and warnings describe the
# card, not a study, so keeping them from the stored row credits nothing new.
STUDY_REPORTED_FIELDS = (
    "perf", "ci_low", "ci_high", "evidence_grade", "n_samples", "n_sites",
    "n_studies", "peer_reviewed_studies", "validation_type",
)
MIXED_SOURCES = "Some values come from the stored row, not this study; the whole row will be credited to this study."
REQUIRED_SAFETY = ("incident_type", "harm", "status", "source_type", "source_reference", "reported_date", "summary")


# ------------------------------------------------------------- store view

class StoreView(Protocol):
    version_id: int

    def cards(self) -> list[Card]: ...
    def lens_values(self) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]: ...
    def concept(self, code: str) -> Concept | None: ...
    def anchor(self, concept: Concept) -> Concept | None: ...
    def chapter(self, number: str) -> Concept | None: ...
    def search(self, query: str, limit: int = MAX_SEARCH_HITS) -> list[dict]: ...
    def stored_metrics(self, model_version: str, use_case: str, code: str, lens: Lens) -> dict[str, Any] | None: ...


def concept_kind(concept: Concept) -> str:
    if concept.level == 0:
        return "chapter"
    if concept.level == 1:
        return "block"
    return "condition" if concept.depth == 1 and concept.is_top_level_condition else "subcategory"


class DatasetView:
    """A ``StoreView`` over one dataset version. ``lock`` guards the shared
    connection (the API's ``Store.lock``); the CLI passes none."""

    def __init__(self, dataset, search_index: SearchIndex, lock=None):
        self.dataset = dataset
        self.atlas = dataset.atlas
        self.version_id = dataset.version_id
        self._search = search_index
        self._lock = lock if lock is not None else contextlib.nullcontext()
        self._warnings: repository.WarningSets | None = None
        self._readers: dict[tuple[str, str], repository.MetricSetReader] = {}

    def cards(self) -> list[Card]:
        return [
            Card(model.model_version, variant.use_case, model.display_name)
            for model in self.dataset.registry.models
            for variant in model.use_cases
            if (model.model_version, variant.use_case) in self.dataset.state.metric_sets
        ]

    def lens_values(self):
        axes = self.atlas.axes
        return axes.age, axes.sex, axes.ethnicity

    def concept(self, code: str) -> Concept | None:
        return self.atlas.by_id.get(code.strip())

    def anchor(self, concept: Concept) -> Concept | None:
        if concept.level == 2 and concept.depth == 1 and concept.is_top_level_condition:
            return concept
        if concept.level == 2 and concept.depth > 1:
            anchor = self.atlas.metric_anchor(concept)
            return anchor if anchor is not None and anchor.is_top_level_condition else None
        return None

    def chapter(self, number: str) -> Concept | None:
        return next((c for c in self.atlas.concepts if c.level == 0 and c.chapter_no == number), None)

    def search(self, query: str, limit: int = MAX_SEARCH_HITS) -> list[dict]:
        query = query.strip()
        if not query:
            return []
        with self._lock:
            hit = self._search.search(query, limit)
        hits = []
        for concept_id in hit.concept_ids:
            concept = self.atlas.by_id[concept_id]
            kind = concept_kind(concept)
            code = f"chapter {concept.chapter_no}" if kind == "chapter" else concept.concept_id
            hits.append({"code": code, "name": concept.pt.lstrip("- ").strip(), "kind": kind, "chapter": concept.chapter_no})
        return hits

    def stored_metrics(self, model_version: str, use_case: str, code: str, lens: Lens) -> dict[str, Any] | None:
        key = (model_version, use_case)
        set_id = self.dataset.state.metric_sets.get(key)
        if set_id is None:
            return None
        axes = self.atlas.axes
        if lens.age not in axes.age or lens.sex not in axes.sex or lens.ethnicity not in axes.ethnicity:
            return None
        with self._lock:
            conn = self.dataset.connection
            if self._warnings is None:
                self._warnings = repository.WarningSets(conn)
            reader = self._readers.get(key)
            if reader is None:
                reader = self._readers[key] = repository.MetricSetReader(conn, set_id, self._warnings, cache_size=2)
            values = reader.row(code, axes.combo_index(lens))
        if values is None:
            return None
        return dict(zip(METRIC_ROW_FORMAT, _metric_cells(values)))


# ---------------------------------------------------------------- quotes

QUOTE_NOT_FOUND = "This quote is not in the study as read; check the value against the study."
_NOT_WORD = re.compile(r"[^0-9a-z]+")


def _words(text: str) -> str:
    """Lower-case letters and digits with single spaces between, padded: what a quote is compared on."""
    return f" {_NOT_WORD.sub(' ', str(text).lower()).strip()} "


def quote_in(quote: str, study_words: str) -> bool:
    """Whether a source quote appears in the study, ignoring case, punctuation, and spacing.

    A quote the model gives as its source must be words of the study; one that
    is not (a paraphrase, or an invented sentence) is flagged so the maintainer
    checks the value instead of trusting a quote shown as evidence (S8).
    """
    words = _words(quote)
    return words.strip() == "" or words in study_words


# ---------------------------------------------------------------- fields

@dataclass
class Field:
    value: Any
    origin: str
    quote: str | None = None
    location: str | None = None
    confidence: float | None = None
    uncertain: bool = False
    reason: str | None = None

    def flag(self, reason: str) -> "Field":
        self.uncertain = True
        if not self.reason:
            self.reason = reason
        elif reason not in self.reason:
            self.reason = f"{self.reason} {reason}"
        return self

    def api(self) -> dict:
        source = {"quote": self.quote, "location": self.location} if (self.quote or self.location) else None
        return {"origin": self.origin, "source": source, "confidence": self.confidence, "uncertain": self.uncertain, "reason": self.reason}


def _finite(value: Any) -> bool:
    """A real number JSON can carry: not NaN, not infinite, not too large for a float."""
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _text(value: Any, limit: int = 1000) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def read_field(raw: dict, name: str) -> Field | None:
    """The model's field, or None when it gave no value."""
    if name not in raw:
        return None
    item = raw[name]
    if isinstance(item, dict):
        value = item.get("value")
        if value is None or value == "" or value == []:
            return None
        confidence = item.get("confidence")
        # NaN, infinity, or a number too large for a float: no confidence rather than a broken answer.
        number = isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and _finite(confidence)
        confidence = float(confidence) if number else None
        if confidence is not None:
            confidence = min(max(confidence, 0.0), 1.0)
        found = Field(
            value=value,
            origin="study",
            quote=_text(item.get("quote")),
            location=_text(item.get("location"), 200),
            confidence=confidence,
            uncertain=bool(item.get("uncertain")),
            reason=_text(item.get("reason"), 300),
        )
        if found.uncertain and not found.reason:
            found.reason = "The model marked this value as uncertain."
    else:
        if item is None or item == "" or item == []:
            return None
        found = Field(value=item, origin="study")
    if not found.quote:
        found.flag("No source quote was given.")
    return found


def _choice(found: Field, labels: dict[str, str]) -> Field:
    """Map a code or label (any case) to the template label; flag anything else."""
    wanted = normalize_header(found.value)
    for code, label in labels.items():
        if wanted in (normalize_header(code), normalize_header(label)):
            found.value = label
            return found
    found.value = _text(found.value, 200)
    return found.flag(f"Not one of: {', '.join(labels.values())}.")


def _number(found: Field, *, fraction: bool) -> Field:
    value = found.value
    if isinstance(value, str):
        cleaned = value.strip().rstrip("%").replace(",", "").strip()
        percent = value.strip().endswith("%")
        try:
            value = float(cleaned)
        except ValueError:
            found.value = None
            return found.flag("Not a number.")
        if percent:
            value /= 100
            found.flag("Converted from a percentage.")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _finite(value):
        # NaN and infinity (as text or as JSON numbers) are no numbers either.
        found.value = None
        return found.flag("Not a number.")
    if fraction:
        if 1 < value <= 100:
            value = value / 100
            found.flag("Converted from a percentage.")
        if not 0 <= value <= 1:
            found.value = round(float(value), 6)
            return found.flag("Outside 0 to 1.")
        found.value = round(float(value), 6)
    else:
        if value < 0 or value != int(value):
            found.value = value
            return found.flag("Not a whole number of at least 0.")
        found.value = int(value)
    return found


def _date(found: Field) -> Field:
    text = _text(found.value, 40) or ""
    found.value = text
    try:
        if _DATE.match(text):
            date.fromisoformat(text)
            return found
    except ValueError:
        pass
    return found.flag("Not a date written YYYY-MM-DD.")


def _lens(raw: dict, name: str, allowed: tuple[str, ...], everyone: str) -> Field | str:
    """The lens field, or an error text."""
    found = read_field(raw, name)
    if found is None:
        return Field(value=everyone, origin="default")
    wanted = normalize_header(found.value)
    for value in allowed:
        short = normalize_header(value.split(" ", 1)[1]) if " " in value else None
        if wanted in (normalize_header(value), short):
            found.value = value
            return found
    if wanted in ("all", "everyone", "overall", "total", "any", normalize_header(everyone)):
        found.value = everyone
        return found
    return f"{found.value!s} is not a {name} group of the atlas (one of {', '.join(allowed)})."


# ------------------------------------------------------------------ codes

@dataclass
class Mention:
    id: int
    text: str
    candidates: list[dict]
    chosen: str | None = None
    exact: bool = False


def _bare(name: str) -> str:
    return normalize_header(name.lstrip("- "))


def find_candidates(view: StoreView, mention: str, kinds: tuple[str, ...]) -> tuple[list[dict], str | None]:
    """(candidates, exact match code) for a condition name.

    The store's search is a substring match, so a name worded differently
    ("osteoarthritis of the hip") also searches its longest words; every
    candidate still comes from the store."""
    words = sorted({word for word in re.findall(r"[A-Za-z0-9]+", mention) if len(word) >= 4}, key=len, reverse=True)[:3]
    hits: list[dict] = []
    for query in (mention, *words):
        for hit in view.search(query, MAX_SEARCH_HITS * 2):
            if hit["kind"] in kinds and hit["code"] not in {h["code"] for h in hits}:
                hits.append(hit)
        if query == mention and hits:
            break
    hits = hits[:MAX_CANDIDATES]
    exact = [hit for hit in hits if _bare(hit["name"]) == _bare(mention)]
    return hits, exact[0]["code"] if len(exact) == 1 else None


def resolve_mentions(mentions: list[Mention], choose: Callable[[list[dict]], dict[int, str | None]] | None) -> None:
    """Fill ``chosen`` from exact matches, then from the model's choice among the candidates."""
    open_ = [m for m in mentions if m.chosen is None and m.candidates]
    if not open_ or choose is None:
        return
    chosen = choose([{"id": m.id, "mention": m.text, "candidates": [{"code": c["code"], "name": c["name"]} for c in m.candidates]} for m in open_])
    for mention in open_:
        code = chosen.get(mention.id)
        if code in {candidate["code"] for candidate in mention.candidates}:
            mention.chosen = code  # only a code the store offered


# -------------------------------------------------------------- the build

@dataclass
class Dropped:
    reason: str
    detail: str
    raw: dict
    source: Field | None = None

    def api(self) -> dict:
        values = {}
        for name, item in self.raw.items():
            value = item.get("value") if isinstance(item, dict) else item
            if isinstance(value, list):
                value = "; ".join(str(part) for part in value)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and not _finite(value):
                value = None  # JSON has no NaN or infinity
            if value is None or isinstance(value, (str, int, float, bool)):
                values[str(name)[:64]] = value if not isinstance(value, str) else value[:300]
        source = None
        if self.source is not None and (self.source.quote or self.source.location):
            source = {"quote": self.source.quote, "location": self.source.location}
        return {"reason": self.reason, "detail": self.detail, "values": values, "source": source}


class Builder:
    def __init__(self, view: StoreView, kind: str, *, card_hint: tuple[str, str] | None, sha256: str, study_text: str | None = None):
        self.view = view
        self.kind = kind
        self.card_hint = card_hint
        self.sha256 = sha256
        # The study as the helper read it (pasted text, CSV, XLSX); None for a PDF,
        # whose text the backend cannot read, so its quotes cannot be checked.
        self._study_words = _words(study_text) if study_text else None
        self.cards = {(card.model_version, card.use_case): card for card in view.cards()}
        self.ages, self.sexes, self.ethnicities = view.lens_values()
        self.dropped: list[Dropped] = []
        self._mentions: list[Mention] = []

    # -- pass 1: cards and code mentions
    def _card(self, raw: dict) -> tuple[dict[str, Field], None] | tuple[None, Dropped]:
        version, use_case = read_field(raw, "model_version"), read_field(raw, "use_case")
        if version is None and use_case is None and self.card_hint is not None:
            version = Field(self.card_hint[0], "request")
            use_case = Field(self.card_hint[1], "request")
        if version is None or use_case is None:
            return None, Dropped("unknown_card", "The study does not name the AI system and function; choose a card and ask again.", raw)
        key = (str(version.value).strip(), str(use_case.value).strip())
        version.value, use_case.value = key
        if self.card_hint is not None and key != self.card_hint:
            return None, Dropped("other_card", f"{key[0]} | {key[1]} is not the chosen card {self.card_hint[0]} | {self.card_hint[1]}.", raw, version)
        if key not in self.cards:
            return None, Dropped("unknown_card", f"{key[0]} | {key[1]} is not a card in the store.", raw, version)
        return {"model_version": version, "use_case": use_case}, None

    def _mention(self, text: str, kinds: tuple[str, ...]) -> Mention:
        candidates, exact = find_candidates(self.view, text, kinds)
        mention = Mention(len(self._mentions), text, candidates, chosen=exact, exact=exact is not None)
        self._mentions.append(mention)
        return mention

    def plan(self, raws: list[dict]) -> list[tuple[dict, dict[str, Field], list]]:
        """Records that name a known card, each with its code entries (code text, Field) or mentions."""
        planned = []
        kinds = ("condition",) if self.kind == "metrics" else ("condition", "subcategory")
        for raw in raws:
            fields, dropped = self._card(raw)
            if dropped is not None:
                self.dropped.append(dropped)
                continue
            entries: list = []
            if self.kind == "metrics":
                code = read_field(raw, "code")
                if code is not None:
                    entries.append(code)
                else:
                    mention = read_field(raw, "condition")
                    entries.append(self._mention(str(mention.value), kinds) if mention is not None else None)
            else:
                codes = read_field(raw, "codes")
                if codes is not None:
                    values = codes.value if isinstance(codes.value, list) else re.split(r"[;,]", str(codes.value))
                    for value in values:
                        if str(value).strip():
                            entries.append(Field(str(value).strip(), "study", codes.quote, codes.location, codes.confidence, codes.uncertain, codes.reason))
                else:
                    names = read_field(raw, "conditions")
                    values = names.value if names is not None and isinstance(names.value, list) else ([names.value] if names is not None else [])
                    entries.extend(self._mention(str(value), kinds) for value in values if str(value).strip())
                if not entries:
                    entries.append(None)
            planned.append((raw, fields, entries))
        return planned

    def mentions(self) -> list[Mention]:
        return self._mentions

    # -- pass 2: codes, lens, values
    def _codes(self, raw: dict, entries: list) -> tuple[list[tuple[Concept, Field]], Dropped | None]:
        found: list[tuple[Concept, Field]] = []
        for entry in entries:
            if entry is None:
                return [], Dropped("unknown_code", "The study names no condition the helper could look up.", raw)
            if isinstance(entry, Mention):
                if entry.chosen is None:
                    names = ", ".join(f"{c['code']} {c['name']}" for c in entry.candidates[:4])
                    hint = f" Candidates in the atlas: {names}." if names else " No condition in the atlas matches."
                    return [], Dropped("unknown_code", f"No ICD-11 code was found for {entry.text!r}.{hint}", raw)
                field = Field(entry.chosen, "search", quote=entry.text, location=None)
                if not entry.exact:
                    field.flag(f"Matched {entry.text!r} by name among the atlas's candidates; check the code.")
                concept = self.view.concept(entry.chosen)
                found.append((concept, field))
                continue
            text = str(entry.value).strip()
            chapter = _CHAPTER.match(text)
            if chapter and self.kind == "safety":
                concept = self.view.chapter(f"{int(chapter.group(1)):02d}")
                if concept is None:
                    return [], Dropped("unknown_code", f"The atlas has no chapter {chapter.group(1)}.", raw, entry)
                entry.value = f"chapter {concept.chapter_no}"
                found.append((concept, entry))
                continue
            concept = self.view.concept(text)
            if concept is None:
                return [], Dropped("unknown_code", f"{text} is not an ICD-11 code in the atlas; the helper does not guess another.", raw, entry)
            if self.kind == "metrics" and concept_kind(concept) != "condition":
                anchor = self.view.anchor(concept)
                hint = f" Its top-level condition is {anchor.concept_id} ({anchor.pt}); metrics go there." if anchor else ""
                return [], Dropped("not_a_condition", f"{text} is a {concept_kind(concept)}, not a top-level condition.{hint}", raw, entry)
            if self.kind == "safety" and self.view.anchor(concept) is None:
                return [], Dropped("not_a_condition", f"{text} is a {concept_kind(concept)}; name conditions or a whole chapter.", raw, entry)
            entry.value = concept.concept_id
            found.append((concept, entry))
        return found, None

    def _lens(self, raw: dict) -> tuple[dict[str, Field] | None, Dropped | None]:
        lens = {}
        for name, allowed, everyone in (("age", self.ages, AGE_ALL), ("sex", self.sexes, SEX_ALL), ("ethnicity", self.ethnicities, ETHNICITY_ALL)):
            value = _lens(raw, name, allowed, everyone)
            if isinstance(value, str):
                return None, Dropped("invalid_value", value, raw, read_field(raw, name))
            lens[name] = value
        return lens, None

    def build(self, planned) -> list[tuple[tuple[str, str], dict]]:
        """((model version, use case), proposed record) in answer order."""
        records: list[tuple[tuple[str, str], dict]] = []
        seen: set = set()
        for index, (raw, card, entries) in enumerate(planned):
            codes, dropped = self._codes(raw, entries)
            if dropped is None:
                lens, dropped = self._lens(raw)
            if dropped is not None:
                self.dropped.append(dropped)
                continue
            fields = {**card, **lens}
            if self.kind == "metrics":
                concept, fields["code"] = codes[0]
                key = (fields["model_version"].value, fields["use_case"].value, concept.concept_id, lens["age"].value, lens["sex"].value, lens["ethnicity"].value)
                self._metrics_values(raw, fields, key)
                conditions = [{"code": concept.concept_id, "name": concept.pt.lstrip("- ").strip()}]
            else:
                self._safety_values(raw, fields, codes, index)
                key = (fields["model_version"].value, fields["use_case"].value, fields["codes"].value, lens["age"].value, lens["sex"].value, lens["ethnicity"].value, fields["incident_type"].value, fields["reported_date"].value)
                conditions = [{"code": concept.concept_id if concept.level else f"chapter {concept.chapter_no}", "name": concept.pt.lstrip("- ").strip()} for concept, _ in codes]
            if key in seen:
                self.dropped.append(Dropped("duplicate", "The answer proposes this record twice; the first one is kept.", raw))
                continue
            seen.add(key)
            records.append(((key[0], key[1]), self._record(fields, conditions)))
        return records

    def _metrics_values(self, raw: dict, fields: dict[str, Field], key: tuple) -> None:
        for name in STUDY_METRIC_FIELDS:
            found = read_field(raw, name)
            if found is None:
                continue
            if name == "validation_type":
                fields[name] = _choice(found, VALIDATION_TYPE_LABELS)
            else:
                fields[name] = _number(found, fraction=name in ("perf", "ci_low", "ci_high"))
        lens = Lens(key[3], key[4], key[5])
        stored = self.view.stored_metrics(key[0], key[1], key[2], lens)
        for name in METRIC_ROW_FORMAT:
            if name in fields:
                # The model gave this field. A value that did not parse stays empty and
                # flagged; the stored value is named, never put in silently.
                if fields[name].value is None and stored is not None and stored[name] not in (None, ""):
                    fields[name].flag(f"The stored row has {stored[name]}.")
                continue
            if stored is not None:
                fields[name] = Field(stored[name], "store")
            elif name in ("in_intended_use", "intended_use_level"):
                fields[name] = Field(None, "default").flag("Not in the study, and the card has no stored row for this condition and group: fill it in.")
            elif name == "warnings":
                fields[name] = Field("", "default")
            else:
                fields[name] = Field(None, "default")
        for name in ("source", "study"):
            found = read_field(raw, name)
            if found is not None:
                found.value = _text(found.value, 300)
            fields[name] = found or Field(None, "default").flag("A merge row needs Source, Study, and Source date; the study does not state it.")
        found = read_field(raw, "source_date")
        fields["source_date"] = _date(found) if found is not None else Field(None, "default").flag(
            "A merge row needs Source, Study, and Source date; the study does not state it."
        )
        # A merge row has one source: staging credits every value of the row to this
        # study, including those kept from the stored row. The maintainer decides.
        kept = any(fields[name].origin == "store" for name in STUDY_REPORTED_FIELDS)
        credited = any(fields[name].origin == "study" for name in ROW_SOURCE_FIELDS)
        if kept and credited:
            fields["source"].flag(MIXED_SOURCES)

    def _safety_values(self, raw: dict, fields: dict[str, Field], codes: list[tuple[Concept, Field]], index: int) -> None:
        fields["incident_id"] = Field(f"AST-{self.sha256[:8]}-{index + 1}", "generated", reason="Generated by the helper; rename it if you keep your own incident ids.")
        chapters = [field for concept, field in codes if concept.level == 0]
        if chapters:
            fields["codes"] = chapters[0]
            if len(codes) > 1:
                fields["codes"].flag("A whole chapter and single codes were named; the chapter is kept.")
        else:
            first = codes[0][1]
            joined = "; ".join(dict.fromkeys(str(field.value) for _, field in codes))
            fields["codes"] = Field(joined, first.origin, first.quote, first.location, first.confidence,
                                    any(f.uncertain for _, f in codes), " ".join(dict.fromkeys(f.reason for _, f in codes if f.reason)) or None)
        for name, labels in (("incident_type", INCIDENT_TYPE_LABELS), ("harm", HARM_LABELS), ("status", INCIDENT_STATUS_LABELS), ("source_type", SOURCE_TYPE_LABELS)):
            found = read_field(raw, name)
            fields[name] = _choice(found, labels) if found is not None else Field(None, "default")
        for name in ("source_reference", "study_id"):
            found = read_field(raw, name)
            if found is not None:
                found.value = _text(found.value, 300)
            fields[name] = found or Field(None, "default")
        for name in ("reported_date", "updated_date"):
            found = read_field(raw, name)
            fields[name] = _date(found) if found is not None else Field(None, "default")
        summary = read_field(raw, "summary")
        if summary is not None:
            text = _text(summary.value, 10_000) or ""
            if len(text) > MAX_SUMMARY:
                summary.flag(f"Shortened to {MAX_SUMMARY} characters.")
                text = text[: MAX_SUMMARY - 1].rstrip() + "…"
            summary.value = text
        fields["summary"] = summary or Field(None, "default")
        for name in REQUIRED_SAFETY:
            if fields[name].value is None:
                fields[name].flag("Required, and the study does not state it: fill it in.")
        if normalize_header(fields["source_type"].value) == "study" and fields["study_id"].value is None:
            fields["study_id"].flag("Required when the source is a study.")

    def _record(self, fields: dict[str, Field], conditions: list[dict]) -> dict:
        keys = RECORD_KEYS[self.kind]
        if self._study_words is not None:
            for found in fields.values():
                if found.origin == "study" and found.quote and not quote_in(found.quote, self._study_words):
                    found.flag(QUOTE_NOT_FOUND)
        record = {key: fields[key].value if key in fields else None for key in keys}
        per_field = {key: (fields[key] if key in fields else Field(None, "default")).api() for key in keys}
        return {
            "record": record,
            "fields": per_field,
            "uncertain": any(item["uncertain"] for item in per_field.values()),
            "conditions": conditions,
        }


def batches(kind: str, records: list[tuple[tuple[str, str], dict]]) -> list[dict]:
    """Proposed records grouped as ``createRecordsUpload`` takes them: per card for
    metrics (the metrics template names the card at upload, not per row), one
    batch for safety (each incident names its card)."""
    if kind == "safety":
        return [{"kind": "safety", "model_version": None, "use_case": None, "records": [r for _, r in records]}] if records else []
    grouped: dict[tuple[str, str], list[dict]] = {}
    for card, record in records:
        grouped.setdefault(card, []).append(record)
    return [{"kind": "metrics", "model_version": card[0], "use_case": card[1], "records": items} for card, items in grouped.items()]
