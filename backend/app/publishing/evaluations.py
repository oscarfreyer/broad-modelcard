"""Evaluation results imports (contract v1.14, CONTRACT.md §32.2).

A benchmark or evaluation harness run outside the product writes its results
as one JSON file for one card, format ``bmc-evaluation-results/1``
(docs/evaluation-results.md, example in docs/evaluation-results-example.json):

.. code-block:: json

    {"format": "bmc-evaluation-results/1",
     "model_version": "SynGPT-2.0", "use_case": "Clinician Facing CDSS",
     "configuration_id": "cfg-syn-2026-08",
     "benchmark": {"name": "…", "version": "1.0", "description": "…", "url": "https://….example/"},
     "run_date": "2026-10-16", "conducted_by": "independent", "setting": "mixed",
     "results": [{"icd11_code": "5A11", "measure": "Top-3 diagnostic accuracy", "value": 0.81,
                  "ci_low": 0.76, "ci_high": 0.85, "cases": 240, "sites": 3,
                  "age": "Age 65+", "sex": "Sex Female", "ethnicity": "All ethnicities"}]}

The file is checked in the background like a narrow model card (§26.4) and is
**not** a data set: it never has a content set and never publishes. A valid
file offers proposed records (``proposals``): one benchmark study record and
one metrics merge record per result. The maintainer or custodian ticks what to
stage and sends them to the records upload (§11.4), study first; the normal
check → review → publish flow follows. Nothing here writes to the store.

The reader is hand-written over ``json``; it treats the file as untrusted
(size, nesting, and counts are bounded). All content is synthetic
demonstration content.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable

from ..schema.contract import (
    AGE_ALL,
    CARE_SETTINGS,
    ETHNICITY_ALL,
    EVALUATION_RESULTS_FORMAT,
    MAX_EVALUATION_BYTES,
    MAX_EVALUATION_RESULTS,
    SETTING_CATEGORIES,
    SEX_ALL,
    STUDY_CONDUCTORS,
    STUDY_CONFIGURATION_ID_PATTERN,
    measure_key,
)
from ..services.types import Lens
from ..validation.issues import Issues

MAX_NAME = 120
MAX_VERSION = 40
MAX_DESCRIPTION = 280
MAX_URL = 500
MAX_MEASURE = 200
MAX_CARD_FIELD = 200
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CODE = re.compile(r"^[A-Za-z0-9.]{1,16}$")
_CONFIGURATION = re.compile(STUDY_CONFIGURATION_ID_PATTERN)
_TOP_KEYS = frozenset({"format", "model_version", "use_case", "configuration_id", "benchmark", "run_date", "conducted_by", "setting", "results"})
_BENCHMARK_KEYS = frozenset({"name", "version", "description", "url"})
_RESULT_KEYS = frozenset({"icd11_code", "measure", "value", "ci_low", "ci_high", "cases", "sites", "age", "sex", "ethnicity"})
_SETTING_LABELS = {**{label.lower(): code for code, label in CARE_SETTINGS.items()}, "mixed": "mixed"}
_FORMAT_FIX = "Start from docs/evaluation-results-example.json: one JSON object with format \"bmc-evaluation-results/1\"."

# Warning codes of a stored row that describe missing data (CONTRACT.md §4.1, §4.6); a proposed
# row has a measured value and benchmark validation, so it keeps every other warning only.
DATA_GAP_WARNINGS = frozenset({"no_performance_data", "no_validation_data"})

# Notes (never blocking) compare a result with the card in the registry.
NOTE_MEASURE = "measure_differs_from_card"
NOTE_CONFIGURATION = "configuration_not_current"


@dataclass(frozen=True)
class EvaluationResult:
    index: int  # position in the file's results list
    code: str  # as written (upper case)
    concept_id: str  # the depth-1 condition it is stored on (its anchor for a subcategory)
    measure: str
    value: float
    ci_low: float | None
    ci_high: float | None
    cases: int
    sites: int | None
    lens: Lens


@dataclass(frozen=True)
class EvaluationRun:
    model_version: str
    use_case: str
    configuration_id: str
    benchmark_name: str
    benchmark_version: str | None
    benchmark_description: str | None
    benchmark_url: str | None
    run_date: str
    conducted_by: str
    setting: str | None  # a study setting category code, or None
    results: tuple[EvaluationResult, ...] = field(default_factory=tuple)

    @property
    def benchmark_label(self) -> str:
        return f"{self.benchmark_name} {self.benchmark_version}" if self.benchmark_version else self.benchmark_name


@dataclass(frozen=True)
class CardFacts:
    """What the check needs to know about the card the file names: ``where`` is
    ``live`` (the live registry), ``staged`` (only a staged registry upload),
    or None (neither); the live card's performance measure and configuration id."""

    where: str | None
    performance_measure: str | None = None
    configuration_id: str | None = None


def target_of(text: str) -> tuple[str | None, str | None]:
    """The card a file names, read loosely before the check (the upload's target), or (None, None)."""
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None, None
    if not isinstance(data, dict):
        return None, None
    model, use_case = data.get("model_version"), data.get("use_case")
    if isinstance(model, str) and isinstance(use_case, str) and model.strip() and use_case.strip():
        model, use_case = model.strip(), use_case.strip()
        if len(model) <= 64 and len(use_case) <= MAX_CARD_FIELD:
            return model, use_case
    return None, None


def _calendar_date(text: str) -> bool:
    """YYYY-MM-DD and a real day (2026-02-30 is not), as the studies check reads it."""
    try:
        return bool(_ISO_DATE.match(text)) and date.fromisoformat(text).isoformat() == text
    except ValueError:
        return False


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


class _Reader:
    """Reads one file into an ``EvaluationRun``, collecting problems in ``issues``."""

    def __init__(self, issues: Issues, atlas, card: Callable[[str, str], CardFacts]):
        self.issues = issues
        self.atlas = atlas
        self.card = card
        axes = atlas.axes
        self.lens_values = {
            "age": {value.lower(): value for value in axes.age},
            "sex": {value.lower(): value for value in axes.sex},
            "ethnicity": {value.lower(): value for value in axes.ethnicity},
        }

    # ----------------------------------------------------------- problems

    def field(self, column: str, problem: str, *, record: int | None = None, fix: str | None = None, value: Any = None) -> None:
        row = 0 if record is None else record + 1
        self.issues.add("evaluation_field", row, problem, column=column, value=value, fix=fix, mark=False)

    def required_text(self, data: dict, key: str, limit: int, *, where: str = "") -> str | None:
        value = data.get(key)
        text = _text(value)
        if text is None:
            self.field(where + key, f"{where + key} is missing or empty.", fix=f"Give {where + key} as text.")
            return None
        if len(text) > limit or "\n" in text:
            self.field(where + key, f"{where + key} has {len(text)} characters or a line break; at most {limit} on one line.", value=text[:60])
            return None
        return text

    def optional_text(self, data: dict, key: str, limit: int, *, where: str = "") -> str | None:
        value = data.get(key)
        if value is None:
            return None
        text = _text(value)
        if text is None or len(text) > limit or "\n" in text:
            self.field(where + key, f"{where + key} must be text on one line of at most {limit} characters, or left out.")
            return None
        return text

    # -------------------------------------------------------------- file

    def read(self, text: str) -> EvaluationRun | None:
        if len(text.encode("utf-8")) > MAX_EVALUATION_BYTES:
            self.issues.add("invalid_evaluation_file", 0, f"The file is larger than {MAX_EVALUATION_BYTES // 1024} KB.", mark=False,
                            fix="Split the run into several files of at most 1 MB, one per card.")
            return None
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            self.issues.add("invalid_evaluation_file", 0, f"The JSON could not be read: {error.msg} (line {error.lineno}).", mark=False)
            return None
        except RecursionError:
            self.issues.add("invalid_evaluation_file", 0, "The JSON is nested too deeply to read.", mark=False)
            return None
        if not isinstance(data, dict):
            self.issues.add("invalid_evaluation_file", 0, "The JSON is not one object.", mark=False)
            return None
        if data.get("format") != EVALUATION_RESULTS_FORMAT:
            shown = data.get("format")
            self.issues.add(
                "invalid_evaluation_file", 0,
                f"format is {shown!r}; this reader takes {EVALUATION_RESULTS_FORMAT!r}." if shown is not None else "format is missing.",
                mark=False, fix=_FORMAT_FIX,
            )
            return None
        for key in sorted(set(data) - _TOP_KEYS):
            self.field(key, f"{key} is not a field of {EVALUATION_RESULTS_FORMAT}.", fix="Remove it; the format lists every field it reads.")

        model = self.required_text(data, "model_version", 64)
        use_case = self.required_text(data, "use_case", MAX_CARD_FIELD)
        configuration = self.required_text(data, "configuration_id", 64)
        if configuration is not None and not _CONFIGURATION.match(configuration):
            self.field("configuration_id", "configuration_id may hold letters, digits, \".\", \"_\", and \"-\" only.", value=configuration,
                       fix="Use the card's configuration label, e.g. cfg-2026-09.")
            configuration = None
        benchmark = self.benchmark(data.get("benchmark"))
        run_date = self.required_text(data, "run_date", 10)
        if run_date is not None and not _calendar_date(run_date):
            self.field("run_date", "run_date is not a date as YYYY-MM-DD.", value=run_date, fix="Write the day of the run, e.g. 2026-10-16.")
            run_date = None
        conducted_by = _text(data.get("conducted_by"))
        if conducted_by is None or conducted_by.lower() not in STUDY_CONDUCTORS:
            self.field("conducted_by", "conducted_by must be developer, independent, or hospital.", value=conducted_by,
                       fix="Say who ran the evaluation: the developer, an independent group, or a hospital.")
            conducted_by = None
        else:
            conducted_by = conducted_by.lower()
        setting = self.setting(data.get("setting"))

        facts = self.card(model, use_case) if model and use_case else CardFacts(None)
        if model and use_case:
            if facts.where is None:
                self.issues.add(
                    "unknown_target", 0, f"The registry has no card {model} / {use_case}.", column="model_version",
                    value=model, mark=False,
                    fix="Write model_version and use_case exactly as AI systems & functions lists them, or add the card there first.",
                )
            elif facts.where == "staged":
                self.issues.add("target_not_published", 0, f"{model} / {use_case} is only in a staged update of AI systems & functions.", mark=False)
        results = self.results(data.get("results"), facts)
        if configuration is not None and facts.where == "live" and configuration != facts.configuration_id:
            current = f"its current configuration is {facts.configuration_id}" if facts.configuration_id else "the card states no configuration"
            self.issues.add(
                NOTE_CONFIGURATION, 0, f"The run evaluated {configuration}; {current}.", column="configuration_id", value=configuration, mark=False,
            )
        if self.issues.has_errors or None in (model, use_case, configuration, benchmark, run_date, conducted_by) or not results:
            return None
        return EvaluationRun(
            model, use_case, configuration, benchmark[0], benchmark[1], benchmark[2], benchmark[3], run_date, conducted_by, setting, tuple(results),
        )

    def benchmark(self, value: Any) -> tuple[str, str | None, str | None, str | None] | None:
        if not isinstance(value, dict):
            self.field("benchmark", "benchmark is missing or not an object.", fix="Give benchmark as {\"name\": …, \"version\": …}.")
            return None
        for key in sorted(set(value) - _BENCHMARK_KEYS):
            self.field(f"benchmark.{key}", f"benchmark.{key} is not a field of the format.", fix="Remove it; a benchmark has name, version, description, and url.")
        name = self.required_text(value, "name", MAX_NAME, where="benchmark.")
        version = value.get("version")
        if isinstance(version, (int, float)) and not isinstance(version, bool):
            version = str(version)
        version = self.optional_text({"version": version}, "version", MAX_VERSION, where="benchmark.")
        description = self.optional_text(value, "description", MAX_DESCRIPTION, where="benchmark.")
        url = self.optional_text(value, "url", MAX_URL, where="benchmark.")
        if url is not None and not re.match(r"^https?://[^\s]+$", url):
            self.field("benchmark.url", "benchmark.url must start with https:// or http://.", value=url)
            url = None
        return (name, version, description, url) if name else None

    def setting(self, value: Any) -> str | None:
        if value is None:
            return None
        text = _text(value)
        code = None
        if text is not None:
            code = text.lower() if text.lower() in SETTING_CATEGORIES else _SETTING_LABELS.get(text.lower())
        if code is None:
            self.field("setting", "setting is not a care setting.", value=text,
                       fix="Write emergency_department, intensive_care, inpatient_ward, outpatient_clinic, primary_care, or mixed, or leave it out.")
        return code

    # ------------------------------------------------------------ results

    def results(self, value: Any, facts: CardFacts) -> list[EvaluationResult]:
        if not isinstance(value, list) or not value:
            self.field("results", "results is missing, empty, or not a list.", fix="List at least one result.")
            return []
        if len(value) > MAX_EVALUATION_RESULTS:
            self.field("results", f"The file lists {len(value):,} results; at most {MAX_EVALUATION_RESULTS:,} are read.",
                       fix="Split the run into several files.")
            return []
        found: list[EvaluationResult] = []
        seen: dict[tuple, int] = {}
        differing: list[tuple[int, str]] = []
        for index, raw in enumerate(value):
            result = self.result(index, raw)
            if result is None:
                continue
            key = (result.concept_id, result.lens)
            if key in seen:
                self.issues.add(
                    "duplicate_key", index + 1, f"Result {index + 1} repeats result {seen[key] + 1}: condition {result.concept_id} for the same group.",
                    column="icd11_code", value=result.code, mark=False,
                    fix="Keep one result per condition and group; a subcategory counts for its top-level condition.",
                )
                continue
            seen[key] = index
            found.append(result)
            if facts.where == "live" and facts.performance_measure and measure_key(result.measure or "") != measure_key(facts.performance_measure):
                differing.append((index, result.measure))
        for index, measure in differing:
            self.issues.add(
                NOTE_MEASURE, index + 1, f"Result {index + 1} measures “{measure}”; the card’s figures measure “{facts.performance_measure}”.",
                column="measure", value=measure, mark=False,
            )
        return found

    def result(self, index: int, raw: Any) -> EvaluationResult | None:
        where = f"Result {index + 1}"
        if not isinstance(raw, dict):
            self.field("results", f"{where} is not an object.", record=index)
            return None
        problems_before = sum(group.count for group in self.issues.groups.values())
        for key in sorted(set(raw) - _RESULT_KEYS):
            self.field(key, f"{where}: {key} is not a field of a result.", record=index, fix="Remove it; the format lists every field of a result.")
        code_text = _text(raw.get("icd11_code"))
        concept = None
        if code_text is None or not _CODE.match(code_text):
            self.field("icd11_code", f"{where}: icd11_code is missing or not an ICD-11 code.", record=index, value=code_text,
                       fix="Write the ICD-11 MMS code of the condition, e.g. 5A11 (codes of other classifications are not read).")
        else:
            concept = self.atlas.by_code.get(code_text.upper())
            if concept is not None and concept.depth != 1:
                concept = self.atlas.metric_anchor(concept)
            if concept is None or concept.level != 2 or not concept.is_top_level_condition:
                self.issues.add(
                    "unknown_icd_code", index + 1, f"{where}: {code_text} is not an ICD-11 condition of the atlas.", column="icd11_code",
                    value=code_text, mark=False,
                    fix="Use the ICD-11 MMS code of a condition or subcategory (e.g. 5A11 or 5A11.0); chapters, blocks, and codes of other classifications are not read.",
                )
                concept = None
        measure = _text(raw.get("measure"))
        if measure is None or len(measure) > MAX_MEASURE:
            self.field("measure", f"{where}: measure is missing or longer than {MAX_MEASURE} characters.", record=index,
                       fix="Name what the value measures, e.g. Top-3 diagnostic accuracy.")
        value = self.share(raw, "value", index, required=True)
        ci_low = self.share(raw, "ci_low", index)
        ci_high = self.share(raw, "ci_high", index)
        if ci_low is not None and ci_high is not None and ci_low > ci_high:
            self.issues.add("ci_low_above_ci_high", index + 1, f"{where}: ci_low {ci_low} is above ci_high {ci_high}.", column="ci_low", mark=False,
                            fix="Swap the two bounds or correct them so that ci_low ≤ ci_high.")
        elif value is not None and ((ci_low is not None and value < ci_low) or (ci_high is not None and value > ci_high)):
            self.issues.add("perf_outside_ci", index + 1, f"{where}: value {value} lies outside its interval.", column="value", mark=False,
                            fix="Correct value, ci_low, or ci_high so that ci_low ≤ value ≤ ci_high.")
        cases = self.count(raw, "cases", index, minimum=1, required=True)
        sites = self.count(raw, "sites", index, minimum=1)
        lens = {}
        for axis, default in (("age", AGE_ALL), ("sex", SEX_ALL), ("ethnicity", ETHNICITY_ALL)):
            given = raw.get(axis)
            if given is None:
                lens[axis] = default
                continue
            text = _text(given)
            known = self.lens_values[axis].get(text.lower()) if text else None
            if known is None:
                self.issues.add("unknown_lens_value", index + 1, f"{where}: {axis} {text!r} is not a group of the atlas.", column=axis,
                                value=text, mark=False,
                                fix=f"Write one of {', '.join(self.lens_values[axis].values())}, or leave {axis} out for {default}.")
            lens[axis] = known
        problems_after = sum(group.count for group in self.issues.groups.values())
        if problems_after != problems_before or concept is None or None in (measure, value, cases) or None in lens.values():
            return None
        return EvaluationResult(
            index, code_text.upper(), concept.concept_id, measure, value, ci_low, ci_high, cases, sites,
            Lens(lens["age"], lens["sex"], lens["ethnicity"]),
        )

    def share(self, raw: dict, key: str, index: int, *, required: bool = False) -> float | None:
        value = raw.get(key)
        if value is None:
            if required:
                self.field(key, f"Result {index + 1}: {key} is missing.", record=index, fix="Give the result as a share between 0 and 1.")
            return None
        number = _number(value)
        if number is None:
            self.issues.add("not_a_number", index + 1, f"Result {index + 1}: {key} is not a number.", column=key, value=str(value)[:40], mark=False,
                            fix="Write a number between 0 and 1 without quotes or a percent sign.")
            return None
        if not 0 <= number <= 1:
            self.issues.add("out_of_range", index + 1, f"Result {index + 1}: {key} {number} is outside 0 to 1.", column=key, value=str(number), mark=False,
                            fix="Write shares between 0 and 1 (0.84, not 84).")
            return None
        return round(number, 6)

    def count(self, raw: dict, key: str, index: int, *, minimum: int, required: bool = False) -> int | None:
        value = raw.get(key)
        if value is None:
            if required:
                self.field(key, f"Result {index + 1}: {key} is missing.", record=index, fix="Give the number of cases the result was measured on.")
            return None
        number = _number(value)
        if number is None or number != int(number):
            self.issues.add("not_a_whole_number", index + 1, f"Result {index + 1}: {key} is not a whole number.", column=key, value=str(value)[:40], mark=False)
            return None
        if number < minimum:
            self.issues.add("out_of_range", index + 1, f"Result {index + 1}: {key} is below {minimum}.", column=key, value=str(int(number)), mark=False,
                            fix=f"{key} counts at least {minimum}.")
            return None
        return int(number)


def read_evaluation(text: str, atlas, card: Callable[[str, str], CardFacts]) -> tuple[EvaluationRun | None, Issues]:
    """Check one file (CONTRACT.md §32.2). Returns the run (None unless valid) and its problems."""
    issues = Issues()
    run = _Reader(issues, atlas, card).read(text)
    return (None if issues.has_errors else run), issues


# -------------------------------------------------------------- proposals

def _slug(text: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", text.upper()).strip("-")


def study_id_of(run: EvaluationRun) -> str:
    """``EVAL-<benchmark>-<version>-<run date>``: letters, digits, and "-", at most 64 characters.
    The same run proposes the same id, so importing it again replaces the same record."""
    date = run.run_date.replace("-", "")
    # Words in parentheses ("(fictional)") are left out, so the version stays in the id.
    stem = _slug(re.sub(r"\([^)]*\)", " ", run.benchmark_label))[: 64 - len("EVAL--") - len(date)].strip("-") or "RUN"
    return f"EVAL-{stem}-{date}"


def _setting_words(code: str | None) -> str:
    if code is None:
        return "Benchmark run outside routine care"
    if code == "mixed":
        return "Benchmark cases from several care settings"
    return f"Benchmark cases from {CARE_SETTINGS[code].lower()} care" if code != "primary_care" else "Benchmark cases from primary care"


def proposals(run: EvaluationRun, *, stored_row: Callable[[str, Lens], tuple | None], display_name: str | None = None) -> dict:
    """The proposed records of a valid run (CONTRACT.md §32.2): one studies record
    (design benchmark) and one metrics merge record per result, in the records
    upload's keys. ``stored_row(concept_id, lens)`` is the card's live stored row,
    whose intended-use fields and warnings a merge row keeps (§26.4). Nothing is
    staged."""
    study_id = study_id_of(run)
    measures = sorted({result.measure for result in run.results}, key=str.casefold)
    measure_words = "; ".join(measures)
    cases = sum(result.cases for result in run.results)
    sites = max((result.sites for result in run.results if result.sites is not None), default=1)
    name = display_name or run.model_version
    conditions = (
        f"Evaluation harness run on {run.run_date} ({run.benchmark_label}); measured {measure_words} for "
        f"{len(run.results)} results against the benchmark's reference labels; configuration {run.configuration_id}."
    )
    study = {
        "study_id": study_id,
        "title": f"{run.benchmark_label}: evaluation of {name}"[:200],
        "design": "benchmark",
        "setting": _setting_words(run.setting),
        "sites": sites,
        "patients": cases,
        "peer_reviewed": "No",
        "conducted_by": run.conducted_by,
        "reporting_guideline": "none",
        "guideline_followed": None,
        "risk_of_bias": "unclear",
        "risk_of_bias_notes": "Not appraised: imported from an evaluation run; a reviewer should judge it.",
        "population": (run.benchmark_description or f"Cases of the benchmark {run.benchmark_label}")[:280],
        "evaluation_conditions": conditions[:500],
        "model_version": run.model_version,
        "publication_date": run.run_date,
        "source_url": run.benchmark_url,
        "setting_category": run.setting,
        "configuration_id": run.configuration_id,
    }
    source = f"Evaluation run: {run.benchmark_label}"[:200]
    records = []
    for result in run.results:
        stored = stored_row(result.concept_id, result.lens)
        in_use = coverage = level = None
        warnings = ""
        if stored is not None:
            in_use_value, coverage_value, level_value, codes_stored = stored[9], stored[10], stored[11], stored[12]
            if level_value:
                in_use, coverage, level = ("Yes" if in_use_value else "No"), coverage_value, level_value
            # Warnings that said the stored row lacked data do not hold for a row with a measured value.
            warnings = "; ".join(code for code in codes_stored if code not in DATA_GAP_WARNINGS)
        records.append({
            "code": result.concept_id,
            **result.lens.as_dict(),
            "perf": round(result.value, 4),
            "ci_low": None if result.ci_low is None else round(result.ci_low, 4),
            "ci_high": None if result.ci_high is None else round(result.ci_high, 4),
            "n_samples": result.cases,
            "n_sites": result.sites,
            "n_studies": 1,
            "peer_reviewed_studies": 0,
            "validation_type": "benchmark",
            "in_intended_use": in_use,
            "intended_use_coverage": coverage,
            "intended_use_level": level,
            "warnings": warnings,
            "source": source,
            "study": study_id,
            "source_date": run.run_date,
        })
    return {
        "model_version": run.model_version,
        "use_case": run.use_case,
        "study": study,
        "metrics": {"model_version": run.model_version, "use_case": run.use_case, "records": records},
        "results": [
            {"result": result.index, "code": result.code, "concept_id": result.concept_id, "measure": result.measure}
            for result in run.results
        ],
    }
