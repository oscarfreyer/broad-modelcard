"""What the helper asks the model, and how it reads the answer.

The model answers with strict JSON: ``{"records": [...], "notes": [...]}``.
Each record maps a field to ``{"value", "quote", "location", "confidence",
"uncertain", "reason"}``: the value, the exact words of the study it comes
from, where they stand (page, paragraph, or table row and column), how sure
the model is, and whether the mapping is uncertain. Fields the study does not
state are null; the backend keeps the stored value for them or leaves them
empty (proposals.py), and never lets the model invent ICD-11 codes or cards.

ICD-11 codes come from the store: a hosted model calls the backend search as
the tool ``search_conditions``; a local model names the condition and the
backend resolves it afterwards (``proposals.resolve_codes``).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from ..schema.templates import (
    HARM_LABELS,
    INCIDENT_STATUS_LABELS,
    INCIDENT_TYPE_LABELS,
    SOURCE_TYPE_LABELS,
    VALIDATION_TYPE_LABELS,
)

KINDS = ("metrics", "safety")
SEARCH_TOOL = "search_conditions"
MAX_SEARCH_HITS = 10


class AnswerError(ValueError):
    """The model's answer is not the JSON the helper asked for."""


@dataclass(frozen=True)
class Card:
    model_version: str
    use_case: str
    display_name: str


@dataclass(frozen=True)
class Context:
    """What the prompt states about the store."""

    kind: str
    cards: tuple[Card, ...]
    ages: tuple[str, ...]
    sexes: tuple[str, ...]
    ethnicities: tuple[str, ...]
    card_hint: tuple[str, str] | None = None


def _labels(labels: dict[str, str]) -> str:
    return ", ".join(f'"{label}"' for label in labels.values())


def field_guide(context: Context) -> list[tuple[str, str]]:
    """(field, what to put there) for the requested kind."""
    lens = [
        ("age", f"Age group the result or incident concerns, one of {', '.join(map(repr, context.ages))}; null for all ages."),
        ("sex", f"One of {', '.join(map(repr, context.sexes))}; null for all sexes."),
        ("ethnicity", f"One of {', '.join(map(repr, context.ethnicities))}; null for all ethnicities."),
    ]
    card = [
        ("model_version", "The AI system's model version, exactly as listed under Cards."),
        ("use_case", "Its function, exactly as listed under Cards for that model version."),
    ]
    if context.kind == "metrics":
        return [
            *card,
            ("code", "ICD-11 code of the top-level condition (found with the search; never invented)."),
            ("condition", "The condition as the study names it."),
            *lens,
            ("perf", "The study's main performance measure for this condition and group, as a number between 0 and 1 (82% is 0.82)."),
            ("ci_low", "Lower bound of its 95% confidence interval, 0 to 1."),
            ("ci_high", "Upper bound of its 95% confidence interval, 0 to 1."),
            ("n_samples", "Number of samples or cases (whole number)."),
            ("n_sites", "Number of sites (whole number)."),
            ("n_studies", "Number of studies behind the value (1 for a single study)."),
            ("peer_reviewed_studies", "How many of them are peer reviewed (whole number); null if the study does not say."),
            ("validation_type", f"One of {_labels(VALIDATION_TYPE_LABELS)}."),
            ("source", "Title of the study or report."),
            ("study", "The study's identifier, e.g. a registration or report number."),
            ("source_date", "Date of the study or report as YYYY-MM-DD."),
        ]
    return [
        *card,
        ("codes", 'ICD-11 codes of the affected conditions as a list (found with the search; never invented), or "chapter NN" for a whole chapter.'),
        ("conditions", "The affected conditions as the study names them, as a list."),
        *lens,
        ("incident_type", f"One of {_labels(INCIDENT_TYPE_LABELS)}."),
        ("harm", f"One of {_labels(HARM_LABELS)}: whether a patient was harmed or could have been."),
        ("status", f"One of {_labels(INCIDENT_STATUS_LABELS)}."),
        ("source_type", f"One of {_labels(SOURCE_TYPE_LABELS)}."),
        ("source_reference", "Where the incident is reported: report number or study title."),
        ("study_id", "The study's identifier; required when the source type is Study."),
        ("reported_date", "When the incident was reported, YYYY-MM-DD."),
        ("updated_date", "When its status last changed, YYYY-MM-DD; null if not stated."),
        ("summary", "What happened, in at most 280 characters, without any patient details."),
    ]


def system_prompt(context: Context, *, tool: bool) -> str:
    what = "performance metrics (one record per condition and demographic group)" if context.kind == "metrics" else "safety incidents (one record per incident)"
    cards = "\n".join(f"- {card.model_version} | {card.use_case} ({card.display_name})" for card in context.cards)
    fields = "\n".join(f"- {name}: {text}" for name, text in field_guide(context))
    code_rule = (
        f"Find every ICD-11 code with the {SEARCH_TOOL} tool; propose only codes it returned. "
        "Metrics belong on top-level conditions (kind \"condition\" in the results)."
        if tool
        else "Give the ICD-11 code only when the study states it; otherwise leave code null and name the condition. The backend looks the codes up."
    )
    return f"""You help the maintainer of Broad Modelcard, a demonstration tool with synthetic data, turn one study into proposed records for the data set "{context.kind}": {what}. A person reviews every proposal before anything is checked or published.

Rules:
- Use only what the study says. Never guess or fill in values the study does not state; leave them null.
- For every value give "quote" (the exact words or cells it comes from) and "location" (page, paragraph, or "row N, column X" of a table).
- Set "uncertain": true with a short "reason" whenever the mapping is not clear-cut (an unclear group, a measure that is not obviously the main one, a rounded or derived number). "confidence" is your confidence from 0 to 1.
- {code_rule}
- Propose records only for the cards listed below. If the study concerns another AI system, say so in "notes" instead of proposing records for it.
- Never include patient details.

Cards (model version | function):
{cards}

Fields of each record:
{fields}

Answer with JSON only, no prose and no code fences:
{{"records": [{{"<field>": {{"value": ..., "quote": "...", "location": "...", "confidence": 0.9, "uncertain": false, "reason": null}}, ...}}], "notes": ["..."]}}"""


def user_instruction(context: Context) -> str:
    hint = ""
    if context.card_hint is not None:
        hint = f" The maintainer chose the card {context.card_hint[0]} | {context.card_hint[1]}; use it when the study does not name another."
    return f"Propose {context.kind} records from the study above.{hint} Answer with the JSON only."


def search_tool_definition() -> dict:
    return {
        "name": SEARCH_TOOL,
        "description": (
            "Search the ICD-11 conditions of the Broad Modelcard atlas by code or by name (case-insensitive substring). "
            f"Returns up to {MAX_SEARCH_HITS} concepts with code, name, and kind (chapter, block, condition, or subcategory). "
            "Use short queries such as a code (5A11) or a key word (diabetes)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "An ICD-11 code or part of a condition name."}},
            "required": ["query"],
            "additionalProperties": False,
        },
    }


def chooser_prompt(mentions: list[dict]) -> str:
    """Second pass for a local model: pick a code for each mention from the store's candidates."""
    body = json.dumps(mentions, ensure_ascii=False, indent=1)
    return (
        "For each condition mention below, choose the ICD-11 code from its candidates that names the same condition, "
        "or null when none does. Do not choose a code that is not listed.\n"
        f"{body}\n"
        'Answer with JSON only: {"choices": [{"id": 0, "code": "5A11"}, ...]}'
    )


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_json(text: str) -> dict:
    """The JSON object in a model's answer (code fences and stray prose around it are tolerated)."""
    body = _FENCE.sub("", (text or "").strip())
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise AnswerError("The model's answer contains no JSON object.")
    try:
        value = json.loads(body[start : end + 1])
    except json.JSONDecodeError as error:
        raise AnswerError(f"The model's answer is not valid JSON ({error.msg} at character {error.pos}).") from None
    except RecursionError:
        raise AnswerError("The model's answer is not valid JSON (it is nested too deeply to read).") from None
    if not isinstance(value, dict):
        raise AnswerError("The model's answer is not a JSON object.")
    return value


def parse_answer(text: str) -> tuple[list[dict], list[str]]:
    """(records, notes) from the model's final answer."""
    value = parse_json(text)
    records = value.get("records")
    if not isinstance(records, list):
        raise AnswerError('The model\'s answer has no "records" list.')
    notes = [str(note)[:500] for note in value.get("notes") or [] if note]
    return [record for record in records if isinstance(record, dict)], notes[:20]
