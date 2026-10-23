"""Nested narrow model cards (contract v1.13, CONTRACT.md §26).

A narrow model card is a developer's own model card for one AI system,
attached to its registry entry and shown in "About this AI system". Two
formats are accepted:

* **JSON**, the prototype's own schema mirroring the Hugging Face model-card
  metadata: ``name``, ``version``, ``license`` (or ``licence``),
  ``intended_use``, ``limitations``, ``training_data``, and results either as
  a Hugging Face ``model-index`` (``[{name, results: [{task, dataset,
  metrics: [{type, value, name}]}]}]``) or as a flat ``results`` list
  (``[{task, dataset, metric, value}]``). Any result may carry
  ``icd11_codes`` (and ``use_case``, ``samples``, ``sites``).
* **Markdown**, stored as text. Optional YAML front matter is read with a
  small hand-written parser that accepts only flat ``key: value`` lines and
  simple ``- item`` lists; anything else (nested maps such as
  ``model-index``, flow collections, anchors, multi-line strings) is
  reported as "convert this part to JSON" and skipped. No YAML library is
  used. ``## Intended use``, ``## Limitations``, and ``## Training data``
  sections fill those fields when the front matter does not.

Results with ICD-11 codes are **proposed** as metric records (``proposals``)
for the custodian or a maintainer to stage as a merge upload; they are never published directly.
All content is synthetic demonstration content.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

from ..schema.contract import MAX_MODEL_CARD_BYTES

MAX_NAME = 200
MAX_SHORT = 120
MAX_LONG = 2_000
MAX_RESULTS = 100
MAX_CODES = 12
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CODE = re.compile(r"^[A-Za-z0-9.]{1,16}$")
_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$")
_LIST_ITEM = re.compile(r"^\s{0,4}-\s+(.*)$")
_HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")
_SECTIONS = {"intended use": "intended_use", "intended uses": "intended_use", "limitations": "limitations", "training data": "training_data"}


@dataclass
class CardProblems:
    """Problems found while reading a card: blocking ``errors`` and non-blocking ``notes``,
    each ``(code, problem)``; ``line`` is the line number for Markdown (0: the whole file)."""

    errors: list[tuple[str, str, int]] = field(default_factory=list)
    notes: list[tuple[str, str, int]] = field(default_factory=list)

    def error(self, code: str, problem: str, line: int = 0) -> None:
        self.errors.append((code, problem, line))

    def note(self, code: str, problem: str, line: int = 0) -> None:
        self.notes.append((code, problem, line))


# ------------------------------------------------------------- text fields

def _text(problems: CardProblems, card: dict, key: str, value: Any, limit: int, *, required: bool = False) -> None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            problems.error("model_card_field", f"{key} is missing.")
        card[key] = None
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        problems.error("model_card_field", f"{key} must be text.")
        card[key] = None
        return
    text = value.strip()
    if len(text) > limit:
        problems.error("model_card_field", f"{key} has {len(text)} characters; at most {limit} are allowed.")
    card[key] = text[:limit]


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _named(value: Any) -> str | None:
    """A task or dataset given as text or as ``{name, type}`` (Hugging Face)."""
    if isinstance(value, dict):
        value = value.get("name") or value.get("type")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _codes(problems: CardProblems, value: Any, where: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [part for part in re.split(r"[;,\s]+", value) if part]
    if not isinstance(value, list):
        problems.error("model_card_field", f"{where}: icd11_codes must be a list of ICD-11 codes.")
        return []
    codes = []
    for code in value:
        text = str(code).strip() if isinstance(code, (str, int, float)) and not isinstance(code, bool) else ""
        if not _CODE.match(text):
            problems.error("model_card_field", f"{where}: {text or 'a code'!s} is not an ICD-11 code (letters, digits, and dots).")
            continue
        codes.append(text.upper())
    if len(codes) > MAX_CODES:
        problems.error("model_card_field", f"{where}: at most {MAX_CODES} ICD-11 codes per result.")
    return codes[:MAX_CODES]


def _result(problems: CardProblems, raw: Any, index: int, *, task: Any = None, dataset: Any = None) -> dict | None:
    where = f"Result {index + 1}"
    if not isinstance(raw, dict):
        problems.error("model_card_field", f"{where} is not an object.")
        return None
    value = _number(raw.get("value"))
    if value is None:
        problems.error("model_card_field", f"{where}: value must be a number.")
        return None
    metric = _named(raw.get("metric") if "metric" in raw else raw.get("type") or raw.get("name"))
    result = {
        "task": _named(raw.get("task", task)),
        "dataset": _named(raw.get("dataset", dataset)),
        "metric": metric,
        "value": value,
        "icd11_codes": _codes(problems, raw.get("icd11_codes"), where),
        "use_case": _named(raw.get("use_case")),
        "samples": None,
        "sites": None,
    }
    for key in ("samples", "sites"):
        number = _number(raw.get(key))
        if raw.get(key) is not None and (number is None or number < 0 or number != int(number)):
            problems.error("model_card_field", f"{where}: {key} must be a whole number.")
        elif number is not None:
            result[key] = int(number)
    if not result["metric"]:
        problems.error("model_card_field", f"{where}: name the metric (e.g. accuracy, AUROC).")
    for key, limit in (("task", MAX_SHORT), ("dataset", MAX_NAME), ("metric", 64), ("use_case", MAX_SHORT)):
        if result[key] and len(result[key]) > limit:
            problems.error("model_card_field", f"{where}: {key} has more than {limit} characters.")
            result[key] = result[key][:limit]
    return result


def _results(problems: CardProblems, data: dict) -> list[dict]:
    """``model-index`` (Hugging Face) or ``results`` (flat), as flat results."""
    found: list[dict] = []
    index_entries = data.get("model-index", data.get("model_index"))
    if index_entries is not None:
        if not isinstance(index_entries, list):
            problems.error("model_card_field", "model-index must be a list.")
        else:
            for entry in index_entries:
                for result in (entry or {}).get("results", []) if isinstance(entry, dict) else []:
                    if not isinstance(result, dict):
                        problems.error("model_card_field", "A model-index result is not an object.")
                        continue
                    metrics = result.get("metrics") or []
                    for metric in metrics if isinstance(metrics, list) else []:
                        if isinstance(metric, dict):
                            merged = {**metric, "icd11_codes": metric.get("icd11_codes", result.get("icd11_codes")),
                                      "use_case": metric.get("use_case", result.get("use_case"))}
                            parsed = _result(problems, merged, len(found), task=result.get("task"), dataset=result.get("dataset"))
                            if parsed:
                                found.append(parsed)
    flat = data.get("results")
    if flat is not None:
        if not isinstance(flat, list):
            problems.error("model_card_field", "results must be a list.")
        else:
            for raw in flat:
                parsed = _result(problems, raw, len(found))
                if parsed:
                    found.append(parsed)
    if len(found) > MAX_RESULTS:
        problems.error("model_card_field", f"The card lists {len(found)} results; at most {MAX_RESULTS} are read.")
    return found[:MAX_RESULTS]


def _card_fields(problems: CardProblems, data: dict, *, model_version: str, default_name: str | None = None) -> dict:
    card: dict = {}
    given_version = data.get("model_version")
    if given_version is not None and str(given_version).strip() != model_version:
        problems.error("model_card_field", f"model_version is {given_version!s}, but this card is for {model_version}.")
    _text(problems, card, "name", data.get("name", data.get("model_name", default_name)), MAX_NAME, required=True)
    _text(problems, card, "version", data.get("version"), 64)
    _text(problems, card, "licence", data.get("license", data.get("licence")), MAX_SHORT)
    _text(problems, card, "intended_use", data.get("intended_use"), MAX_LONG)
    _text(problems, card, "limitations", data.get("limitations"), MAX_LONG)
    _text(problems, card, "training_data", data.get("training_data"), MAX_LONG)
    date = data.get("date")
    if date is not None and not (isinstance(date, str) and _ISO_DATE.match(date.strip())):
        problems.error("model_card_field", "date must be YYYY-MM-DD.")
        date = None
    card["date"] = date.strip() if isinstance(date, str) else None
    card["results"] = _results(problems, data)
    return card


# --------------------------------------------------------------- formats

def parse_json(text: str, model_version: str) -> tuple[dict | None, CardProblems]:
    problems = CardProblems()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        problems.error("invalid_model_card", f"The JSON could not be read: {error.msg} (line {error.lineno}).")
        return None, problems
    except RecursionError:
        # Thousands of nested brackets: refused like any unreadable card, never an internal error.
        problems.error("invalid_model_card", "The JSON is nested too deeply to read; a card is a flat object with lists of results.")
        return None, problems
    if not isinstance(data, dict):
        problems.error("invalid_model_card", "The JSON must be one object with the card's fields.")
        return None, problems
    card = _card_fields(problems, data, model_version=model_version)
    return (None if problems.errors else card), problems


def _scalar(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def front_matter(lines: list[str], problems: CardProblems) -> tuple[dict, int]:
    """The flat keys and simple lists of a ``---`` front matter block, and the
    line after it. Every other construct is a note to convert it to JSON."""
    data: dict[str, Any] = {}
    if not lines or lines[0].strip() != "---":
        return data, 0
    end = next((index for index in range(1, len(lines)) if lines[index].strip() in ("---", "...")), None)
    if end is None:
        problems.error("invalid_model_card", "The front matter starts with --- but never ends with ---.", 1)
        return data, len(lines)
    current: str | None = None
    skipping: str | None = None
    for number in range(1, end):
        line = lines[number]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        item = _LIST_ITEM.match(line)
        if item and current is not None and isinstance(data.get(current), list):
            value = item.group(1).strip()
            if value.startswith(("{", "[", "&", "*", "|", ">")) or _KEY.match(value):
                problems.note("unsupported_front_matter", f"Line {number + 1}: the list {current} holds more than simple values.", number + 1)
                data.pop(current, None)
                current, skipping = None, current
                continue
            data[current].append(_scalar(value))
            continue
        if line[:1].isspace():
            if skipping is None:
                problems.note("unsupported_front_matter", f"Line {number + 1}: indented or nested content.", number + 1)
            continue
        match = _KEY.match(line)
        if not match:
            problems.note("unsupported_front_matter", f"Line {number + 1}: not a key: value line.", number + 1)
            current = skipping = None
            continue
        key, rest = match.group(1), match.group(2).strip()
        skipping = None
        if not rest:
            # A simple list follows, or a nested map (unsupported, reported on its first line).
            following = lines[number + 1] if number + 1 < end else ""
            if _LIST_ITEM.match(following):
                data[key] = []
                current = key
            else:
                problems.note("unsupported_front_matter", f"Line {number + 1}: {key} holds a nested structure; convert this part to JSON.", number + 1)
                current, skipping = None, key
            continue
        if rest.startswith(("{", "[", "&", "*", "|", ">", "!")):
            problems.note("unsupported_front_matter", f"Line {number + 1}: {key} uses a YAML form this reader does not take; convert this part to JSON.", number + 1)
            current, skipping = None, key  # a block scalar's lines belong to it
            continue
        data[key] = _scalar(rest)
        current = None
    return data, end + 1


def _sections(lines: list[str]) -> dict[str, str]:
    """The bodies of ``## Intended use``, ``## Limitations``, ``## Training data``."""
    found: dict[str, list[str]] = {}
    current: str | None = None
    first_title: str | None = None
    for line in lines:
        heading = _HEADING.match(line)
        if heading:
            title = heading.group(1).strip()
            if first_title is None and line.startswith("# "):
                first_title = title
            current = _SECTIONS.get(title.lower().rstrip(":"))
            if current:
                found.setdefault(current, [])
            continue
        if current:
            found[current].append(line)
    texts = {key: "\n".join(body).strip() for key, body in found.items() if "\n".join(body).strip()}
    if first_title:
        texts["_title"] = first_title
    return texts


def parse_markdown(text: str, model_version: str) -> tuple[dict | None, CardProblems]:
    problems = CardProblems()
    lines = text.splitlines()
    data, start = front_matter(lines, problems)
    if problems.errors:
        return None, problems
    body = _sections(lines[start:])
    for key in ("intended_use", "limitations", "training_data"):
        if not data.get(key) and body.get(key):
            data[key] = body[key]
    for key in ("model-index", "model_index", "results"):
        data.pop(key, None)  # results come from JSON only (they never pass the flat reader)
    card = _card_fields(problems, data, model_version=model_version, default_name=body.get("_title") or model_version)
    return (None if problems.errors else card), problems


def parse_card(text: str, source_format: str, model_version: str) -> tuple[dict | None, CardProblems]:
    """Parse a submitted card; ``source_format`` is ``json`` or ``markdown``."""
    if len(text.encode("utf-8")) > MAX_MODEL_CARD_BYTES:
        problems = CardProblems()
        problems.error("invalid_model_card", f"The card is larger than {MAX_MODEL_CARD_BYTES // 1024} KB.")
        return None, problems
    if source_format == "json":
        return parse_json(text, model_version)
    return parse_markdown(text, model_version)


# -------------------------------------------------------------- proposals

def proposed_records(card: dict, *, model_version: str, use_cases: list[str], default_use_case: str | None, atlas, stored_row, source_date: str) -> tuple[list[dict], list[dict]]:
    """Metric records proposed from a card's results with ICD-11 codes, grouped
    by card, and what was skipped with a reason. ``stored_row(use_case,
    concept_id)`` returns the live stored tuple (or None) whose intended-use
    fields and warnings a proposal keeps, since a merge row replaces the
    whole row (CONTRACT.md §11.2, as the study helper does, §20)."""
    batches: dict[str, list[dict]] = {}
    skipped: list[dict] = []
    name = card.get("name") or model_version
    label = f"{name} {card['version']}" if card.get("version") else name
    for index, result in enumerate(card.get("results") or []):
        codes = result.get("icd11_codes") or []
        if not codes:
            continue
        use_case = result.get("use_case") if result.get("use_case") in use_cases else default_use_case
        if use_case is None:
            skipped.append({"result": index, "code": None, "reason": "no_function"})
            continue
        value = result.get("value")
        if value is None or not 0 <= value <= 1:
            skipped.append({"result": index, "code": None, "reason": "value_out_of_range"})
            continue
        for code in codes:
            concept = atlas.by_id.get(code)
            if concept is not None and concept.level == 2 and concept.depth != 1:
                concept = atlas.metric_anchor(concept)
            if concept is None or concept.level != 2 or not concept.is_top_level_condition:
                skipped.append({"result": index, "code": code, "reason": "unknown_code"})
                continue
            stored = stored_row(use_case, concept.concept_id)
            in_use = coverage = level = None
            warnings = ""
            if stored is not None:
                in_use_value, coverage, level_value, codes_stored = stored[9], stored[10], stored[11], stored[12]
                if level_value:
                    in_use, level = ("Yes" if in_use_value else "No"), level_value
                else:
                    coverage = None
                warnings = "; ".join(codes_stored)
            batches.setdefault(use_case, []).append({
                "code": concept.concept_id,
                "age": "All ages",
                "sex": "All sexes",
                "ethnicity": "All ethnicities",
                "perf": round(value, 4),
                "n_samples": result.get("samples"),
                "n_sites": result.get("sites"),
                "validation_type": "benchmark",
                "in_intended_use": in_use,
                "intended_use_coverage": coverage,
                "intended_use_level": level,
                "warnings": warnings,
                "source": f"Narrow model card: {label}"[:200],
                "study": (result.get("dataset") or "Narrow model card")[:64],
                "source_date": source_date,
            })
    return [{"model_version": model_version, "use_case": use_case, "records": records} for use_case, records in batches.items()], skipped
