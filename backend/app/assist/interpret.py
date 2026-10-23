"""Ask with the helper: the optional rewrite of a search query into chips (contract v1.14, CONTRACT.md §20, §31).

Only when the helper is configured (§20). **What leaves the machine:** the
query text and the vocabularies the chips may use (AI system names and model
versions, function names, the lens values, the care settings), and nothing
else: no results, no store content, no study. The model answers with chips in
the interpreter's schema; the backend then checks every chip:

* ``system``, ``function``, ``age``, ``sex``, ``ethnicity``, ``setting``: the
  value must be one of the vocabulary's (a system also by its display name; a
  function, when a system is named, one of that system's); otherwise it is
  dropped as ``unknown_value``.
* ``condition``: the value is looked up as the interpreter looks up words
  (``SearchIndex.conditions``: a code, a preferred term or synonym, or whole
  words of a preferred term); a value it does not find is dropped as
  ``not_found``. A model never adds a concept the atlas lacks.
* Unknown kinds are ``unknown_kind``; a second value for a single-valued kind
  is ``conflict``; conditions after the third are ``limit``.

``matched_text`` is kept only when those words are in the query (else empty).
"""

from __future__ import annotations

import json

from ..services.interpret import KIND_ORDER, MAX_CONDITIONS, SEX_LABELS, Vocabulary, condition_concept, named_conditions
from ..services.search import SearchIndex, words_of
from .prompting import AnswerError, parse_json

# One rewrite may take this long in all; a search helper should answer quickly.
INTERPRET_SECONDS = 30.0
MAX_CHIPS = 20


def system_prompt(vocabulary: Vocabulary) -> str:
    lists = vocabulary.prompt_lists()
    return (
        "You read a search query typed into a model card atlas and turn it into filter chips. "
        "Answer with one JSON object only, no prose: "
        '{"chips": [{"kind": ..., "value": ..., "matched_text": ...}], "unrecognized": [...]}. '
        "Allowed kinds and values (use the values exactly as listed):\n"
        f"- system (an AI system; value: one model_version): {json.dumps(lists['system'], ensure_ascii=False)}\n"
        f"- function (what the system is used for; value: one of): {json.dumps(lists['function'], ensure_ascii=False)}\n"
        f"- age: {json.dumps(lists['age'])}\n"
        f"- sex: {json.dumps(lists['sex'])}\n"
        f"- ethnicity: {json.dumps(lists['ethnicity'])}\n"
        f"- setting (care setting): {json.dumps(lists['setting'])}\n"
        "- condition (value: the disease or condition in plain words, or an ICD-11 code; at most 3).\n"
        "matched_text: the words of the query the chip comes from, copied exactly. "
        "Leave out what the query does not say. Put words you cannot place in unrecognized."
    )


def ask(provider, query: str, vocabulary: Vocabulary) -> dict:
    """The provider's answer as a JSON object (raises ProviderError)."""
    from .providers import ProviderError

    text = provider.interpret(system_prompt(vocabulary), query)
    try:
        return parse_json(text)
    except AnswerError as error:
        raise ProviderError(str(error)) from None


def check(answer: dict, query: str, vocabulary: Vocabulary, index: SearchIndex, catalog) -> tuple[list[dict], list[str], list[dict]]:
    """(chips, unrecognized, dropped): the helper's chips checked against the vocabularies and the search."""
    raw = answer.get("chips")
    proposed = [chip for chip in raw if isinstance(chip, dict)][:MAX_CHIPS] if isinstance(raw, list) else []
    lowered = query.lower()
    chips: list[dict] = []
    dropped: list[dict] = []
    by_name = {}
    for system in vocabulary.systems:
        by_name[system.model_version.lower()] = system
        by_name.setdefault(system.label.lower(), system)
    systems = {by_name.get(str(chip.get("value", "")).strip().lower()) for chip in proposed if chip.get("kind") == "system"}
    named_system = next(iter(systems)) if len(systems) == 1 else None

    def drop(chip: dict, reason: str) -> None:
        dropped.append({"kind": str(chip.get("kind", ""))[:40], "value": str(chip.get("value", ""))[:200], "reason": reason})

    for chip in proposed:
        kind, value = chip.get("kind"), str(chip.get("value") or "").strip()[:200]
        matched = str(chip.get("matched_text") or "").strip()[:200]
        matched = matched if matched and matched.lower() in lowered else ""
        if kind not in KIND_ORDER:
            drop(chip, "unknown_kind")
            continue
        body = None
        if kind == "system":
            system = by_name.get(value.lower())
            body = {"value": system.model_version, "label": system.label} if system else None
        elif kind == "function":
            names = named_system.use_cases if named_system else vocabulary.use_case_names()
            name = next((item for item in names if item.lower() == value.lower()), None)
            body = {"value": name, "label": name} if name else None
        elif kind in ("age", "sex", "ethnicity", "setting"):
            allowed = {"age": vocabulary.ages, "sex": vocabulary.sexes, "ethnicity": vocabulary.ethnicities, "setting": vocabulary.settings}[kind]
            name = next((item for item in allowed if item.lower() == value.lower()), None)
            if name:
                body = {"value": name, "label": SEX_LABELS.get(name) or name.removeprefix("Ethnicity ")}
        else:
            # By step 5's rules, so "disease" or "of" is no condition here either.
            matches = named_conditions(index, words_of(value.lower()), value)
            if not matches:
                drop(chip, "not_found")
                continue
            record = catalog.record(condition_concept(matches[0], catalog))
            body = {
                "value": record["concept_id"],
                "label": record["pt"].lstrip("- ").strip(),
                "code": record.get("icd11_code") or record["concept_id"],
                "pt": record["pt"],
                "match": matches[0].match,
            }
            if matches[0].match == "synonym" and matches[0].matched_term:
                body["matched_term"] = matches[0].matched_term
            body["concept"] = record
        if body is None:
            drop(chip, "unknown_value")
            continue
        chips.append({"kind": kind, **body, "matched_text": matched})

    final: list[dict] = []
    for kind in KIND_ORDER:
        of_kind = [chip for chip in chips if chip["kind"] == kind]
        if kind == "condition":
            unique = []
            for chip in of_kind:
                if chip["value"] not in {item["value"] for item in unique}:
                    unique.append(chip)
            final.extend(unique[:MAX_CONDITIONS])
            dropped.extend({"kind": kind, "value": chip["value"], "reason": "limit"} for chip in unique[MAX_CONDITIONS:])
            continue
        values = {chip["value"] for chip in of_kind}
        if len(values) > 1:
            dropped.extend({"kind": kind, "value": chip["value"], "reason": "conflict"} for chip in of_kind)
        elif of_kind:
            final.append(of_kind[0])
    order = ("kind", "value", "label", "matched_text", "code", "pt", "match", "matched_term", "concept")
    final = [{key: chip[key] for key in order if key in chip} for chip in final]
    raw_unrecognized = answer.get("unrecognized")
    unrecognized = [str(item)[:200] for item in raw_unrecognized if isinstance(item, str) and item.strip()][:20] if isinstance(raw_unrecognized, list) else []
    return final, unrecognized, dropped
