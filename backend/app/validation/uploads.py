"""Check an uploaded CSV/XLSX file against the data contract (Track A3).

``check_upload`` reads a ``Table`` row by row, records every problem in an
``Issues`` collector (errors block publishing, notes do not), and returns the
parsed content when there are no errors. The rules follow the data contract
(CONTRACT.md §4.1, §5, §8, §11) and the legacy validator
(``legacy_tables.py``), and are stricter where an upload can be wrong in ways
the generated JSON never was: values must be in range and use the known
vocabularies. backend/README.md lists the rules.

Merge uploads (contract v1.7, CONTRACT.md §11.2) of metrics, prevalence, and
safety incidents are checked row by row like replace uploads, then applied to
the live set the ``UploadContext`` names: rows from an older study than the
stored row are kept out, and removals of missing keys are ignored (both are
notes).

Row numbers in problems are spreadsheet row numbers; 0 means the whole file.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any, Callable
from urllib.parse import urlsplit

from ..importers.spreadsheets import Table, looks_like_formula
from ..publishing.content import (
    NO_CONFIGURATION_FIELDS,
    Combination,
    ConfigurationFields,
    Content,
    LocalMetricsContent,
    MergeContent,
    MergeInfo,
    MetricsContent,
    ModelEntry,
    MultimorbidityContent,
    PopulationContent,
    PrevalenceContent,
    RegistryContent,
    EffectsContent,
    SafetyContent,
    StudiesContent,
)
from ..repository import EffectRecord, IncidentRecord, RowSource, StudyRecord
from ..schema.contract import (
    AGE_ALL,
    CONFIGURATION_ID_PATTERN,
    ANY_SETTING,
    CARE_SETTING_CODES,
    DEFAULT_ENTRY_KIND,
    MAX_CONFIGURATION_TEXT,
    MAX_DATA_PROTECTION_TEXT,
    MAX_DATA_USE,
    MAX_MEASURE_TEXT,
    MAX_PROMPT_SUMMARY,
    MAX_TOOL_NAME,
    MAX_TOOLS,
    PROMPT_SHA256_PATTERN,
    SAMPLING_TEMPERATURE_RANGE,
    SAMPLING_TOP_P_RANGE,
    TOOL_SEPARATOR,
    ETHNICITY_ALL,
    GRADES,
    NO_INTENDED_USE_LEVEL,
    OUT_OF_SCOPE,
    EFFECT_ID_PATTERN,
    reserved_in_name,
    EFFECT_RATIO_MEASURES,
    EFFECT_STUDY_DESIGNS,
    SEX_ALL,
    STUDY_ID_PATTERN,
    QUALITY_SCORE_RANGE,
    STUDY_CONFIGURATION_ID_PATTERN,
)
from ..schema.templates import (
    ACTION_LABELS,
    ACTION_REMOVE,
    ACTION_UPSERT,
    AI_TYPE_LABELS,
    ANY_SETTING_LABEL,
    APPRAISAL_TOOL_LABELS,
    APPLICABILITY_LABELS,
    QUALITY_TOOL_LABELS,
    SETTING_CATEGORY_LABELS,
    BUILT_ON_SEPARATOR,
    CHAPTER_PREFIX,
    CONDITION_SEPARATOR,
    DATASET_TITLES,
    EFFECT_DIRECTION_LABELS,
    EFFECT_JUDGEMENT_LABELS,
    EFFECT_MEASURE_LABELS,
    ENTRY_KIND_LABELS,
    FUNCTION_CATEGORY_LABELS,
    GUIDELINE_FOLLOWED_LABELS,
    HARM_LABELS,
    INCIDENT_STATUS_LABELS,
    INCIDENT_TYPE_LABELS,
    INTENDED_USE_LEVEL_LABELS,
    MAX_DECLARATION,
    MAX_DESCRIPTION,
    MAX_EFFECT_NOTES,
    MAX_EFFECT_TEXT,
    MAX_EFFECT_UNIT,
    MAX_FOLLOW_UP,
    MAX_OUTCOME,
    MAX_STUDY_NOTES,
    MAX_STUDY_TEXT,
    MAX_STUDY_TITLE,
    MAX_SUMMARY,
    MODEL_STATUSES,
    OUTCOME_TYPE_LABELS,
    PREVALENCE_TIER_LABELS,
    REPORTING_GUIDELINE_LABELS,
    RISK_OF_BIAS_LABELS,
    SCOPE_LABELS,
    SOURCE_TYPE_LABELS,
    STUDY_CONDUCTOR_LABELS,
    STUDY_DESIGN_LABELS,
    TEMPLATES,
    VALIDATION_TYPE_LABELS,
    WARNING_SEPARATOR,
    column_lookup,
    normalize_header,
)
from ..services.atlas import Atlas, normalize_prevalence_tier
from ..services.grading import normalize_validation_type
from ..services.jsnum import locale_sort_key
from ..services.types import Lens
from .issues import Issues

MAX_TEXT = 64
MAX_LABEL = 200
MAX_CONDITIONS = 12  # CONTRACT.md §3: at most 12 selected conditions
VERY_WIDE_CI = 0.25
PROGRESS_EVERY = 2_000

_WARNING_CODE = re.compile(r"^[a-z][a-z0-9_]*$")
_ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[T ]00:00(?::00)?)?$")
_INCIDENT_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_STUDY_ID = re.compile(STUDY_ID_PATTERN)
_STUDY_CONFIGURATION_ID = re.compile(STUDY_CONFIGURATION_ID_PATTERN)
_EFFECT_ID = re.compile(EFFECT_ID_PATTERN)
_CHAPTER = re.compile(r"^(?:chapter|ch)[\s_-]*(\d{1,2})$", re.IGNORECASE)
MAX_INCIDENT_CODES = 50
_NUMBER_LIKE_CODE = re.compile(r"^\d+(\.\d+)?E[+-]?\d+$", re.IGNORECASE)
_YES = frozenset({"yes", "y", "true", "1", "ja", "x"})
_NO = frozenset({"no", "n", "false", "0", "nein"})
_LEVELS = {
    normalize_header(name): level
    for level, label in INTENDED_USE_LEVEL_LABELS.items()
    for name in (level, label)
}
_STATUSES = {status.lower(): status for status in MODEL_STATUSES}

# Header words that suggest patient-level data in a local population file
# (contract v1.10): identifiers, names, contact and birth details, per-person
# values, and per-encounter dates. Matched as whole words of the normalized
# header, so "Condition" or "Source date" never match.
_PATIENT_LEVEL_WORDS = re.compile(
    r"\b(patients?|persons?|people|subjects?|participants?|individuals?|mrn|nhs|ssn|insurance|"
    r"ids?|identifiers?|names?|surname|forename|initials|birth|dob|born|address|street|postcode|zip|"
    r"phone|email|admission|discharge|encounters?|visits?|per patient|per person|age at)\b"
)


def looks_patient_level(header: Any) -> bool:
    """Whether an extra column's header suggests patient-level data (population uploads)."""
    return bool(_PATIENT_LEVEL_WORDS.search(normalize_header(header)))


def _choices(labels: dict[str, str], *extra: tuple[str, str]) -> dict[str, str]:
    """Normalized label or code → code."""
    found = {normalize_header(name): code for code, label in labels.items() for name in (code, label)}
    found.update((normalize_header(name), code) for name, code in extra)
    return found


@dataclass
class MergeBase:
    """The live set a merge upload applies to (contract v1.7).

    ``stored_dates(keys)`` returns, for each key the set has, the source date
    of its stored row (None when the source has no date, e.g. the seed); keys
    the set lacks are left out. ``incidents`` are the live safety incidents.
    """

    set_id: int | None
    stored_dates: Callable[[list], dict] = lambda keys: {}
    combos: tuple[int, ...] = ()
    incidents: tuple[IncidentRecord, ...] = ()
    # The live study records (contract v1.13).
    studies: tuple[StudyRecord, ...] = ()
    # The live intervention effects (contract v1.13, §27).
    effects: tuple[EffectRecord, ...] = ()


@dataclass
class UploadContext:
    """What a check needs from the live data."""

    atlas: Atlas  # concepts and lens axes
    registry_variants: frozenset[tuple[str, str]]  # live model × use case
    staged_registry_variants: frozenset[tuple[str, str]]  # in a staged models upload
    metric_targets: frozenset[tuple[str, str]]  # model × use case with live metrics
    known_warning_codes: frozenset[str]
    live_registry: RegistryContent | None = None  # for generator parameters
    prevalence_bounds: tuple[float, float] = (0.03, 0.97)
    # Contract v1.7: the upload mode, the live set a merge applies to, and the
    # source of replace-upload rows that give none (the upload itself).
    mode: str = "replace"
    merge_base: MergeBase | None = None
    upload_source: RowSource | None = None
    # Contract v1.10: a population upload's (population id, display name).
    population: tuple[str, str] | None = None
    # The codes with a tier in the live default prevalence (a prevalence
    # replace upload may not drop most of them, CONTRACT.md §11).
    live_prevalence_codes: frozenset[str] = frozenset()
    # Contract v1.13: the Study IDs of the live studies set. A metrics row
    # whose Study names none of them stays valid; the check notes it.
    study_ids: frozenset[str] = frozenset()
    # Contract v1.13 (§26): each live study's (scope, population_id), the
    # local population of a local results upload, and the live local
    # populations (a hospital study names one).
    study_scopes: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    local_population: str | None = None
    live_population_ids: frozenset[str] = frozenset()
    # Contract v1.13 (§27): the design of each live study; an effect must name
    # one whose design can show an effect on outcomes.
    study_designs: dict[str, str] = field(default_factory=dict)
    # Contract v1.14 (§22, §28.5): the configuration ids of each AI system's cards in the
    # live registry and any staged registry upload; a study naming another one is noted.
    model_configurations: dict[str, frozenset[str]] = field(default_factory=dict)

    @property
    def model_versions(self) -> frozenset[str]:
        """The AI systems of the live registry."""
        return frozenset(model for model, _ in self.registry_variants)

    @property
    def staged_model_versions(self) -> frozenset[str]:
        """The AI systems of a staged registry upload."""
        return frozenset(model for model, _ in self.staged_registry_variants)

    @property
    def merging(self) -> bool:
        return self.mode == "merge"


@dataclass
class CheckResult:
    issues: Issues
    row_count: int
    content: Content | None
    target: tuple[str, str] | None = None
    extra: dict = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return self.content is not None and not self.issues.has_errors

    def report(self) -> dict:
        return self.issues.report(self.row_count)


class Cancelled(Exception):
    """The upload was discarded or replaced while it was being checked."""


# ------------------------------------------------------------- cell parsing

class _Bad:
    """A cell value that could not be parsed (the issue is already recorded)."""


BAD = _Bad()


class Cells:
    """Typed access to the cells of one row, recording problems as it goes."""

    def __init__(self, issues: Issues, positions: dict[str, int], headers: dict[str, str], decimal_comma: bool):
        self.issues = issues
        self.positions = positions
        self.headers = headers
        self.decimal_comma = decimal_comma
        self.row = 0
        self.cells: list[Any] = []
        self.ok = True

    def start(self, row: int, cells: list[Any]) -> None:
        self.row = row
        self.cells = cells
        self.ok = True

    def raw(self, key: str) -> Any:
        index = self.positions.get(key)
        if index is None or index >= len(self.cells):
            return None
        return self.cells[index]

    def fail(self, code: str, key: str, problem: str, value: Any = None, **extra) -> _Bad:
        self.ok = False
        self.issues.add(code, self.row, problem, column=self.headers.get(key, key), value=value, **extra)
        return BAD

    def note(self, code: str, key: str | None, problem: str, value: Any = None) -> None:
        self.issues.add(code, self.row, problem, column=self.headers.get(key, key) if key else None, value=value)

    def text(self, key: str, *, required: bool, max_length: int = MAX_TEXT) -> str | None | _Bad:
        value = self.raw(key)
        if value is None:
            if required:
                return self.fail("missing_value", key, f"{self.headers[key]} is empty.")
            return None
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool):
            return self.fail("invalid_value", key, f"{self.headers[key]} must be text.", value)
        text = str(value).strip()
        if len(text) > max_length or "\n" in text or "\r" in text:
            return self.fail("invalid_value", key, f"{self.headers[key]} is longer than {max_length} characters or has a line break.", text)
        if looks_like_formula(text):
            self.note("formula_like_text", key, f"{self.headers[key]} starts with {text[0]}, which a spreadsheet program may run as a formula.", text)
        return text

    def number(self, key: str, *, low: float = 0.0, high: float | None = 1.0) -> float | None | _Bad:
        value = self.raw(key)
        if value is None:
            return None
        kind = type(value)
        if kind is float or kind is int:
            number = float(value)
        elif kind is str:
            try:
                if "_" in value:
                    raise ValueError
                number = float(value)
            except ValueError:
                if self.decimal_comma and value.count(",") == 1:
                    try:
                        number = float(value.replace(",", "."))
                    except ValueError:
                        return self.fail("not_a_number", key, f"{self.headers[key]} is not a number.", value)
                else:
                    return self.fail("not_a_number", key, f"{self.headers[key]} is not a number.", value)
        else:
            return self.fail("not_a_number", key, f"{self.headers[key]} is not a number.", value)
        if not math.isfinite(number):
            return self.fail("not_a_number", key, f"{self.headers[key]} is not a finite number.", value)
        if number < low or (high is not None and number > high):
            bounds = f"between {low:g} and {high:g}" if high is not None else f"at least {low:g}"
            return self.fail("out_of_range", key, f"{self.headers[key]} must be {bounds}.", value)
        return number

    def count(self, key: str) -> int | None | _Bad:
        number = self.number(key, low=0, high=None)
        if number is None or number is BAD:
            return number
        if not number.is_integer():
            return self.fail("not_a_whole_number", key, f"{self.headers[key]} must be a whole number.", self.raw(key))
        return int(number)

    def date(self, key: str, *, required: bool = False) -> str | None | _Bad:
        """An ISO date ``YYYY-MM-DD`` (XLSX date cells accepted)."""
        raw = self.raw(key)
        if raw is None:
            if required:
                return self.fail("missing_value", key, f"{self.headers[key]} is empty; write the date as YYYY-MM-DD.")
            return None
        if isinstance(raw, datetime):
            if raw.time() != time():
                return self.fail("invalid_date", key, f"{self.headers[key]} must be a date without a time.", raw)
            return raw.date().isoformat()
        if isinstance(raw, date):
            return raw.isoformat()
        text = str(raw).strip()
        match = _ISO_DATE.match(text)
        try:
            if match is None:
                raise ValueError
            return date.fromisoformat(match.group(1)).isoformat()
        except ValueError:
            return self.fail("invalid_date", key, f"{self.headers[key]} must be a date written YYYY-MM-DD, e.g. 2026-03-01.", raw)

    def choice(self, key: str, choices: dict[str, str], code: str, problem: str, *, required: bool) -> str | None | _Bad:
        """A value from a label/code list (``choices``: normalized name → code)."""
        raw = self.text(key, required=required)
        if raw is None or raw is BAD:
            return raw
        value = choices.get(normalize_header(raw))
        if value is None:
            return self.fail(code, key, problem, raw)
        return value

    def yes_no(self, key: str, *, required: bool) -> bool | None | _Bad:
        value = self.raw(key)
        if value is None:
            if required:
                return self.fail("missing_value", key, f"{self.headers[key]} is empty; enter Yes or No.")
            return None
        if isinstance(value, bool):
            return value
        text = (str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)).strip().lower()
        if text in _YES:
            return True
        if text in _NO:
            return False
        return self.fail("invalid_yes_no", key, f"{self.headers[key]} must be Yes or No.", value)


def _code_text(value: Any) -> str:
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return str(value).strip()


def _number_hint(value: Any) -> str | None:
    """Why a code that is not in the atlas may have been mangled by a spreadsheet
    program, which turns codes like 1E30 into numbers."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{value!r} is a number, not a code. Format the column as text (codes like 1E30 turn into numbers) or use the XLSX template."
    if isinstance(value, str) and _NUMBER_LIKE_CODE.match(value) and "." in value:
        return f"{value} looks like a number in scientific notation. Format the column as text and type the code again (e.g. 1E30)."
    return None


# ---------------------------------------------------------- header checks

def _expected_headers(kind: str) -> set[str]:
    return {normalize_header(column.header) for column in TEMPLATES[kind] if column.required}


def check_header(table: Table, kind: str, issues: Issues) -> tuple[dict[str, int], dict[str, str]] | None:
    """Column positions and headers by key, or None when rows cannot be read."""
    header = table.header
    if not header:
        issues.add("empty_file", 0, "The file has no header row and no data.")
        return None
    lookup = column_lookup(kind)
    positions: dict[str, int] = {}
    headers: dict[str, str] = {}
    extra: list[tuple[int, Any]] = []
    for index, name in enumerate(header):
        column = lookup.get(normalize_header(name)) if name is not None else None
        if column is None:
            extra.append((index, name))
        elif column.key in positions:
            issues.add("duplicate_column", table.header_row, f"The column {column.header} appears twice.", column=str(name), value=name)
        else:
            positions[column.key] = index
            headers[column.key] = str(name)
    missing = [column for column in TEMPLATES[kind] if column.required and column.key not in positions]
    if missing:
        names = {normalize_header(name) for name in header if name is not None}
        for other in TEMPLATES:
            if other != kind and _expected_headers(other) <= names and not _expected_headers(kind) <= names:
                issues.add(
                    "wrong_template",
                    0,
                    f"These columns belong to the {DATASET_TITLES[other]} template, not {DATASET_TITLES[kind]}.",
                    fix=f"Upload this file under {DATASET_TITLES[other]}, or download the {DATASET_TITLES[kind]} template.",
                    mark=False,
                )
                return None
        for column in missing:
            issues.add("missing_column", table.header_row, f"The column {column.header} is missing.", column=column.header, mark=False)
    for index, name in extra:
        label = f"column {_column_letter(index)}" if name is None else f"the column {name}"
        if kind == "population" and name is not None and looks_patient_level(name):
            issues.add(
                "patient_level_data",
                table.header_row,
                f"The column {name} looks like patient-level data; a local population holds one tier per condition.",
                column=str(name),
                value=name,
            )
            continue
        issues.add(
            "extra_column",
            table.header_row,
            f"The template has no {label}." if name is not None else f"The {label} has data but no header.",
            column=None if name is None else str(name),
            value=name,
        )
    if missing:
        return None
    for column in TEMPLATES[kind]:
        headers.setdefault(column.key, column.header)
    return positions, headers


def _column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


# ------------------------------------------------------------ metric fields

class MetricFields:
    """The 13 metric columns of a row → a stored tuple (CONTRACT.md §4.1).

    Contract v1.11: In intended use and Intended-use level may both be empty
    (the row states no intended use; stored with ``NO_INTENDED_USE_LEVEL``),
    and a row with Performance needs evidence.
    """

    def __init__(self, cells: Cells, known_warning_codes: frozenset[str]):
        self.cells = cells
        self.known_warning_codes = known_warning_codes
        self._validation_types: dict[str, str | None] = {}

    def _validation_type(self, value: Any) -> str | None | _Bad:
        if value is None:
            return None
        key = str(value)
        if key not in self._validation_types:
            self._validation_types[key] = normalize_validation_type(key)
        normalized = self._validation_types[key]
        if normalized is None:
            return self.cells.fail(
                "unknown_validation_type",
                "validation_type",
                f"Unknown validation type; use one of: {', '.join(VALIDATION_TYPE_LABELS.values())}.",
                value,
            )
        return normalized

    def parse(self) -> tuple | None:
        c = self.cells
        perf = c.number("perf")
        ci_low = c.number("ci_low")
        ci_high = c.number("ci_high")
        grade_raw = c.raw("evidence_grade")
        grade: Any = None
        if grade_raw is not None:
            grade = str(grade_raw).strip().upper()
            if grade not in GRADES:
                grade = c.fail("unknown_evidence_grade", "evidence_grade", "The evidence grade must be A, B, C, D, E, or F.", grade_raw)
        n_samples = c.count("n_samples")
        n_sites = c.count("n_sites")
        n_studies = c.count("n_studies")
        peer = c.count("peer_reviewed_studies")
        validation_type = self._validation_type(c.raw("validation_type"))
        coverage = c.number("intended_use_coverage")
        level_raw = c.raw("intended_use_level")
        # Both intended-use cells empty: the row states no intended use (v1.11).
        not_stated = level_raw is None and c.raw("in_intended_use") is None
        in_intended_use = None if not_stated else c.yes_no("in_intended_use", required=True)
        if not_stated:
            level: Any = NO_INTENDED_USE_LEVEL
            if coverage is not None and coverage is not BAD:
                c.fail(
                    "missing_value",
                    "intended_use_level",
                    "Intended-use coverage is given, but In intended use and Intended-use level are empty; fill both, or leave all three empty.",
                )
        elif level_raw is None:
            level = c.fail("missing_value", "intended_use_level", "Intended-use level is empty; fill it, or leave In intended use empty too.")
        else:
            level = _LEVELS.get(normalize_header(level_raw))
            if level is None:
                level = c.fail(
                    "unknown_intended_use_level",
                    "intended_use_level",
                    'Use "In scope", "Partially in scope", or "Out of scope".',
                    level_raw,
                )
        warnings = self._warnings(c.raw("warnings"))

        if isinstance(ci_low, float) and isinstance(ci_high, float):
            if ci_low > ci_high:
                c.fail("ci_low_above_ci_high", "ci_low", f"CI low ({ci_low:g}) is above CI high ({ci_high:g}).", c.raw("ci_low"))
            else:
                if isinstance(perf, float) and not ci_low <= perf <= ci_high:
                    c.fail(
                        "perf_outside_ci",
                        "perf",
                        f"Performance {perf:g} is outside its confidence interval {ci_low:g}–{ci_high:g}.",
                        c.raw("perf"),
                    )
                if ci_high - ci_low > VERY_WIDE_CI:
                    c.note(
                        "very_wide_confidence_interval",
                        "ci_high",
                        f"The interval {ci_low:g}–{ci_high:g} is wider than {VERY_WIDE_CI:g}.",
                        c.raw("ci_high"),
                    )
        if isinstance(peer, int) and isinstance(n_studies, int) and peer > n_studies:
            c.fail(
                "out_of_range",
                "peer_reviewed_studies",
                f"Peer-reviewed studies ({peer}) cannot exceed Studies ({n_studies}).",
                c.raw("peer_reviewed_studies"),
            )
        if c.ok and perf is not None and (validation_type is None or "no_validation_data" in warnings):
            condition = c.raw("code") if c.raw("code") is not None else c.raw("codes")
            named = f"{_code_text(condition)}: p" if condition is not None else "P"
            c.fail(
                "performance_without_evidence",
                "perf",
                f"{named}erformance {perf:g} is given without evidence ("
                + ("Validation type is empty)." if validation_type is None else "the warnings say no_validation_data)."),
                c.raw("perf"),
            )
        if not c.ok:
            return None
        if grade is not None and validation_type is None:
            c.note("grade_without_validation_type", "evidence_grade", "Evidence grade given without a validation type.", grade_raw)
        if in_intended_use is False and level not in (OUT_OF_SCOPE, NO_INTENDED_USE_LEVEL):
            c.note("scope_mismatch", "in_intended_use", f"In intended use is No but the level is {INTENDED_USE_LEVEL_LABELS[level]}.")
        return (
            perf,
            ci_low,
            ci_high,
            grade,
            n_samples,
            n_sites,
            n_studies,
            peer,
            validation_type,
            1 if in_intended_use else 0,
            coverage,
            level,
            warnings,
        )

    def _warnings(self, value: Any) -> tuple[str, ...] | _Bad:
        if value is None:
            return ()
        if not isinstance(value, str):
            return self.cells.fail("invalid_warning_code", "warnings", "Warnings must be codes separated by \";\".", value)
        codes = []
        for part in value.split(WARNING_SEPARATOR):
            code = part.strip().lower()
            if not code:
                continue
            if not _WARNING_CODE.match(code):
                return self.cells.fail("invalid_warning_code", "warnings", f"{part.strip()!r} is not a warning code.", value)
            if code not in self.known_warning_codes:
                self.cells.note("unfamiliar_warning_code", "warnings", f"{code} is not a known warning code.", code)
            codes.append(code)
        return tuple(codes)


# ------------------------------------------------------------------- lenses

class LensColumns:
    """Age, Sex, Ethnicity and, for metrics and local results (contract v1.14, §29),
    the optional Setting of a row: its lens combination."""

    def __init__(self, cells: Cells, atlas: Atlas, *, with_setting: bool = False):
        self.cells = cells
        axes = atlas.axes
        self.axes = axes
        self.values = {
            "age": {normalize_header(value): value for value in axes.age},
            "sex": {normalize_header(value): value for value in axes.sex},
            "ethnicity": {normalize_header(value): value for value in axes.ethnicity},
        }
        self.labels = {"age": axes.age, "sex": axes.sex, "ethnicity": axes.ethnicity}
        self.with_setting = with_setting
        # "Any setting", "Clinical" (the axis value), and the setting codes are accepted too.
        self.settings = {normalize_header(ANY_SETTING_LABEL): ANY_SETTING}
        for value in axes.context:
            self.settings[normalize_header(value)] = value
            code = CARE_SETTING_CODES.get(value)
            if code is not None:
                self.settings[normalize_header(code)] = value

    def setting(self) -> str | None:
        """The row's setting (an axis value); empty or no column: Any setting. None after a problem."""
        raw = self.cells.raw("setting") if self.with_setting else None
        if raw is None:
            return ANY_SETTING
        value = self.settings.get(normalize_header(raw))
        if value is None:
            choices = ", ".join([ANY_SETTING_LABEL, *self.axes.context[1:]])
            self.cells.fail(
                "unknown_setting",
                "setting",
                f"Unknown setting; use one of: {choices}. Leave it empty for a result that holds across settings.",
                raw,
            )
        return value

    def combo(self) -> int | None:
        found = []
        for axis in ("age", "sex", "ethnicity"):
            raw = self.cells.raw(axis)
            if raw is None:
                self.cells.fail("missing_value", axis, f"{self.cells.headers[axis]} is empty.")
                continue
            value = self.values[axis].get(normalize_header(raw))
            if value is None:
                self.cells.fail(
                    "unknown_lens_value",
                    axis,
                    f"Unknown {axis} group; use one of: {', '.join(self.labels[axis])}.",
                    raw,
                )
                continue
            found.append(value)
        setting = self.setting()
        if len(found) != 3 or setting is None:
            return None
        return self.axes.combo_index(Lens(*found, setting))


def lens_label(atlas: Atlas, combo_idx: int) -> str:
    lens = atlas.axes.lens_for_index(combo_idx)
    setting = "" if lens.is_any_setting else f", {lens.setting}"  # contract v1.14 (§29)
    return f"{lens.age}, {lens.sex}, {lens.ethnicity}{setting}"


# ------------------------------------------------- merge rows and sources

_ACTIONS = _choices(ACTION_LABELS, ("add", ACTION_UPSERT), ("replace", ACTION_UPSERT), ("update", ACTION_UPSERT), ("delete", ACTION_REMOVE))
MAX_SOURCE = 200


class RowExtras:
    """The Action and source columns of a metrics or prevalence row (contract v1.7)."""

    def __init__(self, cells: Cells, context: UploadContext):
        self.cells = cells
        self.context = context

    def action(self) -> str | _Bad:
        """``upsert`` or ``remove``; Remove in a replace upload is an error."""
        action = self.cells.choice("action", _ACTIONS, "unknown_action", 'Write "Remove", or leave the cell empty.', required=False)
        if action == ACTION_REMOVE and not self.context.merging:
            return self.cells.fail(
                "remove_in_replace", "action", "Remove only works in a merge upload; leave the record out of a replace upload instead.", "Remove"
            )
        return ACTION_UPSERT if action is None else action

    def source(self) -> RowSource | None | _Bad:
        """The row's source. A merge row needs all three columns; a replace row
        may leave them empty, but Study or Source date need a Source."""
        c = self.cells
        source = c.text("source", required=False, max_length=MAX_SOURCE)
        study = c.text("study", required=False)
        source_date = c.date("source_date")
        if BAD in (source, study, source_date):
            return BAD
        if self.context.merging:
            missing = [key for key, value in (("source", source), ("study", study), ("source_date", source_date)) if value is None]
            if missing:
                names = ", ".join(c.headers[key] for key in missing)
                return c.fail("missing_provenance", missing[0], f"A merge row needs Source, Study, and Source date; {names} {'is' if len(missing) == 1 else 'are'} empty.")
        elif source is None:
            if study is not None or source_date is not None:
                return c.fail("missing_provenance", "source", "Source is empty although Study or Source date is given.")
            return None
        return RowSource(source, study, source_date)


def _apply_older_study_rule(checker: "_Checker", upserts: dict, sources: dict, rows_at: dict, describe: Callable[[Any], str]) -> None:
    """Keep out merge rows whose source date is older than the stored row's (the newer study stays)."""
    stored = checker.context.merge_base.stored_dates(list(upserts)) if checker.context.merge_base else {}
    for key, stored_date in stored.items():
        new_date = sources[key].date if key in sources else None
        if stored_date and new_date and new_date < stored_date:
            checker.issues.add(
                "newer_study_kept",
                rows_at[key],
                f"{describe(key)}: this row's source date {new_date} is older than the stored row's ({stored_date}); the stored row stays.",
                column=checker.headers.get("source_date"),
                value=new_date,
            )
            del upserts[key]
            sources.pop(key, None)


def _drop_missing_removals(checker: "_Checker", removals: list, rows_at: dict, describe: Callable[[Any], str]) -> list:
    stored = checker.context.merge_base.stored_dates(removals) if checker.context.merge_base else {}
    kept = []
    for key in removals:
        if key in stored:
            kept.append(key)
        else:
            checker.issues.add("nothing_to_remove", rows_at[key], f"{describe(key)} is not in the stored data; nothing is removed.", column=checker.headers.get("action"), value="Remove")
    return kept


# ------------------------------------------------------------------ checker

class _Checker:
    def __init__(self, table: Table, kind: str, context: UploadContext, issues: Issues, *, progress, cancelled):
        self.table = table
        self.kind = kind
        self.context = context
        self.issues = issues
        self._progress = progress
        self._cancelled = cancelled
        self.row_count = 0
        self.extra: dict = {}
        self.headers: dict[str, str] = {}
        self._unnamed_reported: set[int] = set()

    def rows(self, cells: Cells, max_rows: int, *, expected_rows: int):
        """Data rows; progress comes from the file position, or from the row
        count against ``expected_rows`` when the file does not say its size."""
        for number, values in self.table.rows():
            self.row_count += 1
            if self.row_count % PROGRESS_EVERY == 0:
                if self._cancelled():
                    raise Cancelled()
                if self.table.knows_size:
                    self._progress(self.table.progress())
                else:
                    self._progress(min(0.95, self.row_count / max(expected_rows, 1)))
            if self.row_count > max_rows:
                self.issues.add(
                    "too_many_rows",
                    number,
                    f"The file has more than {max_rows:,} data rows; checking stopped here.",
                    mark=False,
                )
                return
            if len(values) > len(self.table.header):
                self._unnamed_columns(number, values)
            cells.start(number, values)
            yield number

    def _unnamed_columns(self, number: int, values: list) -> None:
        """Data to the right of the last header is an error, reported once per column."""
        for index in range(len(self.table.header), len(values)):
            if values[index] is not None and index not in self._unnamed_reported:
                self._unnamed_reported.add(index)
                self.issues.add(
                    "extra_column",
                    number,
                    f"Column {_column_letter(index)} has data but no header.",
                    value=values[index],
                    mark=False,
                )

    # The ICD-11 code of a top-level condition → its concept id.
    def condition_id(self, cells: Cells, key: str, raw: Any) -> str | None:
        code = _code_text(raw)
        concept = self.context.atlas.by_id.get(code)
        if concept is not None and concept.level == 2 and concept.depth == 1 and concept.is_top_level_condition:
            return concept.concept_id
        if concept is None:
            cells.fail("unknown_icd_code", key, _number_hint(raw) or f"{code} is not an ICD-11 code in the atlas.", raw)
        elif concept.level < 2:
            cells.fail("unknown_icd_code", key, f"{code} is a chapter or block; give metrics per top-level condition.", raw)
        else:
            anchor = self.context.atlas.metric_anchor(concept)
            hint = f" Give them on its top-level condition {anchor.concept_id}." if anchor else ""
            cells.fail("unknown_icd_code", key, f"{code} is a subcategory; it shows the data of its top-level condition.{hint}", raw)
        return None


def _coverage_check(
    checker: _Checker,
    first_rows: dict[Any, int],
    combos_by_key: dict[Any, set[int]],
    describe: Callable[[Any], str],
) -> tuple[int, ...]:
    """Every record needs the same lens combinations; returns them in axis order."""
    union: set[int] = set().union(*combos_by_key.values()) if combos_by_key else set()
    atlas = checker.context.atlas
    for key, combos in combos_by_key.items():
        missing = sorted(union - combos)
        if missing:
            shown = "; ".join(lens_label(atlas, combo) for combo in missing[:3])
            more = f" and {len(missing) - 3} more" if len(missing) > 3 else ""
            checker.issues.add(
                "incomplete_lens_coverage",
                first_rows[key],
                f"{describe(key)} has {len(combos)} of the {len(union)} demographic groups in the file; missing {shown}{more}.",
                column=None,
            )
    return tuple(sorted(union))


def _check_metrics(checker: _Checker, cells: Cells, target: tuple[str, str]) -> MetricsContent | MergeContent | None:
    context = checker.context
    lenses = LensColumns(cells, context.atlas, with_setting=True)
    fields = MetricFields(cells, context.known_warning_codes)
    extras = RowExtras(cells, context)
    rows: dict[tuple[int, str], tuple] = {}
    sources: dict[tuple[int, str], RowSource] = {}
    removals: list[tuple[int, str]] = []
    first_rows: dict[str, int] = {}
    seen_rows: dict[tuple[int, str], int] = {}
    combos_by_condition: dict[str, set[int]] = {}
    # Study (contract v1.13) → the rows whose Study names no study record.
    unknown_studies: dict[str, list[int]] = {}
    conditions = sum(1 for concept in context.atlas.concepts if concept.is_top_level_condition)
    axes = context.atlas.axes
    expected_rows = conditions * axes.per_setting + 1
    # Since v1.14 (§29) a row may name a care setting: every lens of every setting at most.
    max_rows = conditions * axes.per_setting * len(axes.context) + 1
    for number in checker.rows(cells, max_rows, expected_rows=expected_rows):
        raw_code = cells.raw("code")
        concept_id = (
            checker.condition_id(cells, "code", raw_code)
            if raw_code is not None
            else cells.fail("missing_value", "code", "ICD-11 code is empty.")
        )
        combo_idx = lenses.combo()
        action = extras.action()
        if action == ACTION_REMOVE:
            values, source = None, None
        else:
            values = fields.parse()
            source = extras.source()
        if not isinstance(concept_id, str) or combo_idx is None or action is BAD:
            continue
        key = (combo_idx, concept_id)
        if key in seen_rows:
            cells.fail(
                "duplicate_key",
                "code",
                f"{concept_id} for {lens_label(context.atlas, combo_idx)} also appears in row {seen_rows[key]}.",
                raw_code,
            )
            continue
        seen_rows[key] = number
        if action == ACTION_REMOVE:
            removals.append(key)
            continue
        if combo_idx < axes.per_setting:
            # Any setting needs common lens coverage; a specific setting (v1.14, §29) is stored
            # only where evidence exists, for any conditions and groups.
            first_rows.setdefault(concept_id, number)
            combos_by_condition.setdefault(concept_id, set()).add(combo_idx)
        if values is not None and source is not BAD:
            if checker.kind == "local_metrics" and not _local_study_ok(checker, cells, source):
                continue
            rows[key] = values
            if source is not None:
                sources[key] = source
                if source.study is not None and source.study not in context.study_ids:
                    unknown_studies.setdefault(source.study, []).append(number)
    if checker.row_count == 0:
        return None
    if checker.kind != "local_metrics":
        _note_unknown_studies(checker, unknown_studies)
    if context.merging:
        return _metrics_merge(checker, target, rows, sources, removals, seen_rows)
    if checker.kind == "local_metrics":
        # Local results (contract v1.13, §26) replace public rows one by one, so
        # conditions may cover different demographic groups.
        combos = tuple(sorted({combo for combo, _ in rows}))
        return LocalMetricsContent(
            target[0], target[1], combos, rows, sources=sources, fallback_source=context.upload_source,
            population_id=context.local_population,
        )
    combos = _coverage_check(checker, first_rows, combos_by_condition, lambda concept_id: concept_id)
    setting_combos = sorted({combo for combo, _ in rows if combo >= axes.per_setting})
    return MetricsContent(target[0], target[1], (*combos, *setting_combos), rows, sources=sources, fallback_source=context.upload_source)


def _local_study_ok(checker: _Checker, cells: Cells, source: RowSource | None) -> bool:
    """A local result (contract v1.13, §26) names a hospital evaluation of the
    upload's local population in its Study column; otherwise a blocking error."""
    context = checker.context
    population = context.local_population
    study = source.study if source is not None else None
    if study is None:
        cells.fail("local_study_missing", "study", f"Study is empty; name the hospital evaluation of {population} behind this row.")
        return False
    scope = context.study_scopes.get(study)
    if scope is None:
        problem = f"{study} is not in Studies; add it there with Scope Hospital and Local population {population}."
    elif scope[0] != "hospital":
        problem = f"{study} is a public study; a local result needs a hospital evaluation of {population}."
    elif scope[1] != population:
        problem = f"{study} evaluated the local population {scope[1]}, not {population}."
    else:
        return True
    cells.fail("local_study_mismatch", "study", problem, study)
    return False


def _note_unknown_studies(checker: _Checker, unknown: dict[str, list[int]]) -> None:
    """One note per Study value that names no study record (contract v1.13, CONTRACT.md §22):
    such rows stay valid as free text and are graded without a study."""
    for study, rows in unknown.items():
        count = len(rows)
        checker.issues.add(
            "unknown_study",
            rows[0],
            f"Study {study} is not in Studies ({count:,} {'row' if count == 1 else 'rows'}, first in row {rows[0]}); "
            "these rows are graded without a study record.",
            column=checker.headers.get("study"),
            value=study,
        )


def _metrics_merge(checker: _Checker, target, upserts: dict, sources: dict, removals: list, rows_at: dict) -> MergeContent:
    atlas = checker.context.atlas
    base = checker.context.merge_base or MergeBase(None)

    def describe(key) -> str:
        return f"{key[1]} for {lens_label(atlas, key[0])}"

    _apply_older_study_rule(checker, upserts, sources, rows_at, describe)
    kept = _drop_missing_removals(checker, removals, rows_at, describe)
    new_combos = sorted({combo for combo, _ in upserts} - set(base.combos))
    for combo in new_combos if checker.kind != "local_metrics" else ():
        first = min(rows_at[key] for key in upserts if key[0] == combo)
        checker.issues.add(
            "new_lens_group",
            first,
            f"The stored data has no rows for {lens_label(atlas, combo)}; other conditions read No data for that group.",
            mark=False,
        )
    if checker.kind == "local_metrics":
        # Local rows replace public rows one by one (§26): a new group is no news.
        return MergeContent(
            "local_metrics", base.set_id, upserts, kept, sources, model_version=target[0], use_case=target[1],
            new_combos=tuple(new_combos), population_id=checker.context.local_population,
        )
    return MergeContent(
        "metrics", base.set_id, upserts, kept, sources, model_version=target[0], use_case=target[1], new_combos=tuple(new_combos)
    )


def _check_multimorbidity(checker: _Checker, cells: Cells, target: tuple[str, str]) -> MultimorbidityContent | None:
    context = checker.context
    lenses = LensColumns(cells, context.atlas)
    fields = MetricFields(cells, context.known_warning_codes)
    combinations: dict[str, Combination] = {}
    labels: dict[str, tuple[str | None, int]] = {}
    first_rows: dict[str, int] = {}
    seen_rows: dict[tuple[str, int], int] = {}
    combos_by_key: dict[str, set[int]] = {}
    max_rows = 100_000
    for number in checker.rows(cells, max_rows, expected_rows=1_000):
        condition_ids = _condition_set(checker, cells)
        label = cells.text("label", required=False, max_length=MAX_LABEL)
        combo_idx = lenses.combo()
        values = fields.parse()
        if condition_ids is None or combo_idx is None or label is BAD:
            continue
        key = CONDITION_SEPARATOR.join(sorted(set(condition_ids), key=locale_sort_key))
        if (key, combo_idx) in seen_rows:
            cells.fail(
                "duplicate_key",
                "codes",
                f"This combination for {lens_label(context.atlas, combo_idx)} also appears in row {seen_rows[(key, combo_idx)]}.",
                cells.raw("codes"),
            )
            continue
        seen_rows[(key, combo_idx)] = number
        if key in labels and labels[key][0] != label:
            cells.fail(
                "inconsistent_value",
                "label",
                f"The label differs from row {labels[key][1]} of the same combination.",
                label,
            )
            continue
        labels.setdefault(key, (label, number))
        first_rows.setdefault(key, number)
        combos_by_key.setdefault(key, set()).add(combo_idx)
        combination = combinations.get(key)
        if combination is None:
            combination = combinations[key] = Combination(condition_ids, key, label, {})
        if values is not None:
            combination.rows[combo_idx] = values
    combos = _coverage_check(checker, first_rows, combos_by_key, lambda key: key.replace(CONDITION_SEPARATOR, " + "))
    if checker.row_count == 0:
        return None
    return MultimorbidityContent(target[0], target[1], combos, list(combinations.values()))


def _condition_set(checker: _Checker, cells: Cells) -> tuple[str, ...] | None:
    raw = cells.raw("codes")
    if raw is None:
        cells.fail("missing_value", "codes", "Condition codes is empty.")
        return None
    parts = [part.strip() for part in re.split(r"[+,;]", _code_text(raw)) if part.strip()]
    ids = []
    for part in parts:
        concept_id = checker.condition_id(cells, "codes", part)
        if concept_id is None:
            return None
        ids.append(concept_id)
    if len(set(ids)) != len(ids):
        cells.fail("invalid_condition_set", "codes", "A condition appears twice in the combination.", raw)
        return None
    if not 2 <= len(ids) <= MAX_CONDITIONS:
        cells.fail(
            "invalid_condition_set",
            "codes",
            f"A combination needs 2 to {MAX_CONDITIONS} conditions; this one has {len(ids)}.",
            raw,
        )
        return None
    return tuple(ids)


def url_cell(cells: Cells, key: str) -> str | None | _Bad:
    """An optional http(s) link of at most ``MAX_DECLARATION`` characters."""
    text = cells.text(key, required=False, max_length=MAX_DECLARATION)
    if text is None or text is BAD:
        return text
    try:
        parts = urlsplit(text)
    except ValueError:  # e.g. an unbalanced bracket in the host
        parts = None
    if parts is None or parts.scheme.lower() not in ("http", "https") or not parts.netloc or " " in text:
        return cells.fail("invalid_url", key, f"{cells.headers[key]} must start with https:// or http:// and name a site.", text)
    return text


class RegistryFields:
    """The entry and configuration columns of a registry row (contract v1.5).

    Every column is optional; a file without them parses to None (and an empty
    ``built_on``), and a missing Kind means Model."""

    def __init__(self, cells: Cells):
        self.cells = cells

    def _choice(self, key: str, code: str, problem: str) -> str | None | _Bad:
        raw = self.cells.text(key, required=False)
        if raw is None or raw is BAD:
            return raw
        value = _CHOICES[key].get(normalize_header(raw))
        if value is None:
            return self.cells.fail(code, key, problem, raw)
        return value

    def _url(self, key: str) -> str | None | _Bad:
        return url_cell(self.cells, key)

    def entry(self) -> dict:
        """The entry fields; ``kind`` is Model when the cell is empty."""
        c = self.cells
        kind = self._choice("kind", "unknown_kind", "Kind must be Model or Product.")
        built_on_raw = c.text("built_on", required=False, max_length=MAX_DECLARATION)
        built_on: Any = built_on_raw
        if isinstance(built_on_raw, str):
            names = [part.strip() for part in built_on_raw.split(BUILT_ON_SEPARATOR) if part.strip()]
            built_on = tuple(dict.fromkeys(names))
        return {
            "kind": DEFAULT_ENTRY_KIND if kind is None else kind,
            "ai_type": self._choice("ai_type", "unknown_ai_type", f"Use one of: {', '.join(AI_TYPE_LABELS.values())}."),
            "developer": c.text("developer", required=False, max_length=MAX_LABEL),
            "release_date": c.date("release_date"),
            "description": c.text("description", required=False, max_length=MAX_DESCRIPTION),
            "built_on": () if built_on is None else built_on,
            # Contract v1.14 (§28.2): the model version this AI system supersedes.
            "replaces": c.text("replaces", required=False),
        }

    def configuration(self) -> ConfigurationFields | _Bad:
        c = self.cells
        values = (
            self._choice(
                "function_category",
                "unknown_function_category",
                f"Use one of: {', '.join(FUNCTION_CATEGORY_LABELS.values())}.",
            ),
            c.text("declared_intended_purpose", required=False, max_length=MAX_DECLARATION),
            c.text("declared_regulatory_status", required=False, max_length=MAX_LABEL),
            c.text("declared_contact", required=False, max_length=MAX_LABEL),
            self._url("declared_documentation_url"),
        )
        # Contract v1.11: "No" says the card has no intended-use statement;
        # "Yes" or an empty cell (or no column) say it has one.
        stated = c.yes_no("intended_use_defined", required=False)
        record = self.record()
        if any(value is BAD for value in values) or stated is BAD or record is BAD:
            return BAD
        return ConfigurationFields(*values, intended_use_defined=stated is not False, **record)

    def record(self) -> dict | _Bad:
        """The contract v1.14 configuration fields (§28.1): the configuration
        record, what the figures measure, and the data-protection declarations."""
        c = self.cells
        fields = {
            "configuration_id": self._pattern(
                "configuration_id", CONFIGURATION_ID_PATTERN, "invalid_configuration_id",
                'is not a label of at most 64 letters, digits, ".", "_", or "-".',
            ),
            "configuration_date": c.date("configuration_date"),
            "prompt_summary": c.text("prompt_summary", required=False, max_length=MAX_PROMPT_SUMMARY),
            "prompt_sha256": self._pattern(
                "prompt_sha256", PROMPT_SHA256_PATTERN, "invalid_sha256", "is not 64 characters 0-9 and a-f.", lower=True
            ),
            "retrieval": c.text("retrieval", required=False, max_length=MAX_CONFIGURATION_TEXT),
            "tools": self._tools(),
            "sampling_temperature": c.number("sampling_temperature", low=SAMPLING_TEMPERATURE_RANGE[0], high=SAMPLING_TEMPERATURE_RANGE[1]),
            "sampling_top_p": c.number("sampling_top_p", low=SAMPLING_TOP_P_RANGE[0], high=SAMPLING_TOP_P_RANGE[1]),
            "sampling_max_output_tokens": self._tokens(),
            "fine_tuning": c.text("fine_tuning", required=False, max_length=MAX_CONFIGURATION_TEXT),
            "performance_measure": c.text("performance_measure", required=False, max_length=MAX_MEASURE_TEXT),
            "reference_standard": c.text("reference_standard", required=False, max_length=MAX_MEASURE_TEXT),
            "declared_data_use": c.text("declared_data_use", required=False, max_length=MAX_DATA_USE),
            "declared_data_location": c.text("declared_data_location", required=False, max_length=MAX_DATA_PROTECTION_TEXT),
            "declared_retention": c.text("declared_retention", required=False, max_length=MAX_DATA_PROTECTION_TEXT),
            "declared_privacy_contact": c.text("declared_privacy_contact", required=False, max_length=MAX_DATA_PROTECTION_TEXT),
        }
        return BAD if any(value is BAD for value in fields.values()) else fields

    def _pattern(self, key: str, pattern: str, code: str, problem: str, *, lower: bool = False) -> str | None | _Bad:
        text = self.cells.text(key, required=False, max_length=MAX_LABEL)
        if text is None or text is BAD:
            return text
        value = text.lower() if lower else text
        if not re.match(pattern, value):
            return self.cells.fail(code, key, f"{self.cells.headers[key]} {problem}", text)
        return value

    def _tools(self) -> tuple[str, ...] | _Bad:
        c = self.cells
        raw = c.text("tools", required=False, max_length=(MAX_TOOL_NAME + 2) * MAX_TOOLS)
        if raw is None:
            return ()
        if raw is BAD:
            return BAD
        names = tuple(dict.fromkeys(part.strip() for part in raw.split(TOOL_SEPARATOR) if part.strip()))
        if len(names) > MAX_TOOLS:
            return c.fail("too_many_tools", "tools", f"{c.headers['tools']} lists {len(names)} tools; at most {MAX_TOOLS} are allowed.", raw)
        long = [name for name in names if len(name) > MAX_TOOL_NAME]
        if long:
            return c.fail("invalid_value", "tools", f"The tool name “{long[0][:40]}…” is longer than {MAX_TOOL_NAME} characters.", raw)
        return names

    def _tokens(self) -> int | None | _Bad:
        c = self.cells
        number = c.number("sampling_max_output_tokens", low=1, high=None)
        if number is None or number is BAD:
            return number
        if not number.is_integer():
            return c.fail(
                "not_a_whole_number", "sampling_max_output_tokens",
                f"{c.headers['sampling_max_output_tokens']} must be a whole number.", c.raw("sampling_max_output_tokens"),
            )
        return int(number)


_CHOICES = {
    key: _choices(labels)
    for key, labels in (("kind", ENTRY_KIND_LABELS), ("ai_type", AI_TYPE_LABELS), ("function_category", FUNCTION_CATEGORY_LABELS))
}

# Columns of the model, not of one use case: every row of a model repeats them.
_ENTRY_COLUMNS = (
    "display_name", "model_name", "model_release", "status",
    "kind", "ai_type", "developer", "release_date", "description", "built_on", "replaces",
)


def _check_registry(checker: _Checker, cells: Cells) -> RegistryContent | None:
    context = checker.context
    models: dict[str, dict] = {}
    seen: dict[tuple[str, str], int] = {}
    default_models: dict[str, int] = {}
    fields = RegistryFields(cells)
    for number in checker.rows(cells, 10_000, expected_rows=50):
        model_version = cells.text("model_version", required=True)
        display_name = cells.text("display_name", required=True, max_length=MAX_LABEL)
        model_name = cells.text("model_name", required=False, max_length=MAX_LABEL)
        model_release = cells.text("model_release", required=False)
        status_raw = cells.text("status", required=True)
        status: Any = status_raw
        if isinstance(status_raw, str):
            status = _STATUSES.get(status_raw.lower())
            if status is None:
                status = cells.fail("unknown_status", "status", f"Use {' or '.join(MODEL_STATUSES)}.", status_raw)
        use_case = cells.text("use_case", required=True)
        default_use_case = cells.yes_no("default_use_case", required=False)
        default_model = cells.yes_no("default_model", required=False)
        entry = fields.entry()
        configuration = fields.configuration()
        # Card ids join the two with "|" and the comparison lists them with "," (§11.1).
        for key, name in (("model_version", model_version), ("use_case", use_case)):
            reserved = reserved_in_name(name) if isinstance(name, str) else ()
            if reserved:
                cells.fail("separator_in_name", key, f"{cells.headers[key]} “{name}” contains {' and '.join(reserved)}.", name)
        if not cells.ok:
            continue
        variant = (model_version, use_case)
        if variant in seen:
            cells.fail("duplicate_key", "use_case", f"{model_version} / {use_case} also appears in row {seen[variant]}.", use_case)
            continue
        seen[variant] = number
        values = {"display_name": display_name, "model_name": model_name, "model_release": model_release, "status": status, **entry}
        model = models.get(model_version)
        if model is None:
            model = models[model_version] = {**values, "row": number, "use_cases": [], "configurations": {}, "default_use_cases": []}
        else:
            for key in _ENTRY_COLUMNS:
                if model[key] != values[key]:
                    cells.fail(
                        "inconsistent_value",
                        key,
                        f"{cells.headers[key]} differs from row {model['row']} of the same AI system ({_shown_value(model[key])}).",
                        _shown_value(values[key]) if values[key] not in (None, ()) else None,
                    )
            if not cells.ok:
                continue
        model["use_cases"].append(use_case)
        if configuration != NO_CONFIGURATION_FIELDS:
            model["configurations"][use_case] = configuration
        if default_use_case:
            model["default_use_cases"].append((use_case, number))
        if default_model:
            default_models.setdefault(model_version, number)
        if variant not in context.metric_targets:
            cells.fail(
                "use_case_without_metrics",
                "use_case",
                f"{model_version} / {use_case} has no performance metrics yet.",
                use_case,
            )
    for model_version, model in models.items():
        for use_case, number in model["default_use_cases"][1:]:
            checker.issues.add(
                "invalid_default",
                number,
                f"{model_version} already has {model['default_use_cases'][0][0]} as its default function.",
                column=cells.headers["default_use_case"],
                value="Yes",
            )
    for model_version, number in list(default_models.items())[1:]:
        checker.issues.add(
            "invalid_default",
            number,
            f"{next(iter(default_models))} is already marked as the default AI system.",
            column=cells.headers["default_model"],
            value="Yes",
        )
    _check_built_on(checker, cells, models)
    _check_replaces(checker, cells, models)
    checker.extra["variants"] = list(seen)
    if checker.row_count == 0:
        return None
    live = {model.model_version: model for model in context.live_registry.models} if context.live_registry else {}
    content = RegistryContent(
        default_model_version=next(iter(default_models), None),
        models=[
            ModelEntry(
                model_version=model_version,
                display_name=model["display_name"],
                model_name=model["model_name"],
                model_release=model["model_release"],
                status=model["status"],
                default_use_case=model["default_use_cases"][0][0] if model["default_use_cases"] else None,
                use_cases=tuple(model["use_cases"]),
                effects=live[model_version].effects if model_version in live else None,
                capabilities=live[model_version].capabilities if model_version in live else None,
                kind=model["kind"],
                ai_type=model["ai_type"],
                developer=model["developer"],
                release_date=model["release_date"],
                description=model["description"],
                built_on=model["built_on"],
                replaces=model["replaces"],
                configurations=model["configurations"],
            )
            for model_version, model in models.items()
        ],
    )
    if not context.merging:
        return content
    # A developer submission (contract v1.13, §26) merges its AI system's entry
    # into the live registry: the entry is replaced in place, or appended.
    base = context.live_registry or RegistryContent(None, [])
    merged = {model.model_version: model for model in base.models}
    for model in content.models:
        merged[model.model_version] = model
    return RegistryContent(
        default_model_version=base.default_model_version or content.default_model_version,
        models=list(merged.values()),
        merge=MergeInfo(context.merge_base.set_id if context.merge_base else None, len(content.models)),
    )


def _shown_value(value: Any) -> str:
    if value in (None, ()):
        return "empty"
    if isinstance(value, tuple):
        return f"{BUILT_ON_SEPARATOR} ".join(value)
    return ENTRY_KIND_LABELS.get(value, value) if isinstance(value, str) else str(value)


def _check_built_on(checker: _Checker, cells: Cells, models: dict[str, dict]) -> None:
    """Only products are built on models, and only on other models of the same file."""
    column = cells.headers["built_on"]
    for model_version, model in models.items():
        if not model["built_on"]:
            continue
        shown = f"{BUILT_ON_SEPARATOR} ".join(model["built_on"])
        if model["kind"] != "product":
            checker.issues.add(
                "built_on_for_model",
                model["row"],
                f"{model_version} is a model, so it cannot be built on {shown}.",
                column=column,
                value=shown,
            )
            continue
        for base in model["built_on"]:
            if base == model_version:
                problem = f"{model_version} cannot be built on itself."
            elif base not in models and not (checker.context.merging and base in checker.context.model_versions):
                problem = f"{base} is not a model version in this file."
            elif base in models and models[base]["kind"] != "model":
                problem = f"{base} is a product; products are built on models."
            else:
                continue
            checker.issues.add("unknown_built_on", model["row"], problem, column=column, value=base)


def _check_replaces(checker: _Checker, cells: Cells, models: dict[str, dict]) -> None:
    """Version lineage (contract v1.14, §28.2): Replaces names another AI system
    of the same file (or, for a submission's merge, of the live registry), never
    the entry itself, and the versions form no loop."""
    context = checker.context
    column = cells.headers["replaces"]
    live = (
        {model.model_version: model.replaces for model in context.live_registry.models}
        if context.merging and context.live_registry
        else {}
    )
    graph = {**live, **{model_version: model["replaces"] for model_version, model in models.items()}}
    for model_version, model in models.items():
        previous = model["replaces"]
        if previous is None:
            continue
        if previous == model_version:
            checker.issues.add("replaces_self", model["row"], f"{model_version} cannot replace itself.", column=column, value=previous)
        elif previous not in models and previous not in live:
            where = "this file or the published AI systems" if context.merging else "this file"
            checker.issues.add(
                "unknown_replaces", model["row"], f"{previous} is not an AI system in {where}.", column=column, value=previous
            )
    reported: set[str] = set()
    for start in models:
        chain = [start]
        current = graph.get(start)
        while current is not None and current in graph and current not in chain:
            chain.append(current)
            current = graph.get(current)
        if current != start or len(chain) < 2:
            continue  # no loop through this entry (a self-reference is replaces_self)
        loop = " → ".join([*chain, start])
        for member in chain:
            if member in models and member not in reported:
                reported.add(member)
                checker.issues.add(
                    "replaces_cycle",
                    models[member]["row"],
                    f"The versions replace each other in a loop: {loop}.",
                    column=column,
                    value=models[member]["replaces"],
                )


def _drops_most_prevalence(checker: _Checker, tiers: dict[str, str]) -> bool:
    """A prevalence replace upload that would remove more than half of the live
    default tiers is blocked (``prevalence_incomplete``, CONTRACT.md §11): a
    local list belongs in Local populations, a few changes in a merge upload."""
    live = checker.context.live_prevalence_codes
    kept = len(live & tiers.keys())
    if not live or (len(live) - kept) * 2 <= len(live):
        return False
    checker.issues.add(
        "prevalence_incomplete",
        0,
        f"The file keeps {kept:,} of the {len(live):,} codes with a tier; the other {len(live) - kept:,} would lose it.",
        fix=(
            f"This file lists only {kept:,} of {len(live):,} codes. To add a local population, use Local populations; "
            "to change some codes, use Add or change rows."
        ),
        mark=False,
    )
    return True


def _check_prevalence(checker: _Checker, cells: Cells) -> PrevalenceContent | MergeContent | None:
    context = checker.context
    atlas = context.atlas
    extras = RowExtras(cells, context)
    tiers: dict[str, str] = {}
    sources: dict[str, RowSource] = {}
    removals: list[str] = []
    seen: dict[str, int] = {}
    level_two = sum(1 for concept in atlas.concepts if concept.level == 2)
    for number in checker.rows(cells, len(atlas.concepts) + 1, expected_rows=level_two):
        raw_code = cells.raw("code")
        concept_id = None
        if raw_code is None:
            cells.fail("missing_value", "code", "ICD-11 code is empty.")
        else:
            code = _code_text(raw_code)
            concept = atlas.by_id.get(code)
            if concept is None:
                cells.fail("unknown_icd_code", "code", _number_hint(raw_code) or f"{code} is not an ICD-11 code in the atlas.", raw_code)
            elif concept.level != 2:
                cells.fail("unknown_icd_code", "code", f"{code} is a chapter or block; tiers belong to conditions.", raw_code)
            else:
                concept_id = concept.concept_id
        action = extras.action()
        tier = None
        source = None
        if action != ACTION_REMOVE:
            raw_tier = cells.raw("tier")
            if raw_tier is None:
                cells.fail("missing_value", "tier", "Commonness is empty.")
            else:
                tier = normalize_prevalence_tier(raw_tier) if isinstance(raw_tier, str) else None
                if tier is None:
                    cells.fail("unknown_tier", "tier", f"Use one of: {', '.join(PREVALENCE_TIER_LABELS.values())}.", raw_tier)
            source = extras.source()
        if concept_id is None or action is BAD or (action != ACTION_REMOVE and (tier is None or source is BAD)):
            continue
        if concept_id in seen:
            if checker.kind == "population":
                # Several rows per code are what a list of patients or cases looks like.
                cells.fail(
                    "patient_level_data", "code",
                    f"{concept_id} also appears in row {seen[concept_id]}; a population gives each code one tier.", raw_code,
                )
            else:
                cells.fail("duplicate_key", "code", f"{concept_id} also appears in row {seen[concept_id]}.", raw_code)
            continue
        seen[concept_id] = number
        if action == ACTION_REMOVE:
            removals.append(concept_id)
            continue
        tiers[concept_id] = tier
        if source is not None:
            sources[concept_id] = source
    if checker.row_count == 0:
        return None
    if checker.kind == "prevalence" and not context.merging and _drops_most_prevalence(checker, tiers):
        return None
    low, high = context.prevalence_bounds
    if context.merging:
        base = context.merge_base or MergeBase(None)
        _apply_older_study_rule(checker, tiers, sources, seen, str)
        kept = _drop_missing_removals(checker, removals, seen, str)
        return MergeContent("prevalence", base.set_id, tiers, kept, sources, bounds=(low, high))
    if checker.kind == "population":
        population_id, name = context.population or ("", "")
        return PopulationContent(
            tiers, low, high, sources=sources, fallback_source=context.upload_source, population_id=population_id, name=name
        )
    return PrevalenceContent(tiers, low, high, sources=sources, fallback_source=context.upload_source)


# ----------------------------------------------------------- safety incidents

_INCIDENT_TYPES = _choices(INCIDENT_TYPE_LABELS, ("harmful recommendation", "harmful_recommendation"), ("incorrect recommendation", "harmful_recommendation"), ("recall", "developer_notice_or_recall"), ("developer notice", "developer_notice_or_recall"))
_HARMS = _choices(HARM_LABELS, ("no harm", "none"))
_INCIDENT_STATUSES = _choices(INCIDENT_STATUS_LABELS)
_SOURCE_TYPES = _choices(SOURCE_TYPE_LABELS, ("report", "incident_report"), ("notice", "developer_notice"))
MAX_SAFETY_ROWS = 10_000


class _OptionalLens:
    """Age, Sex, and Ethnicity of an incident; an empty cell means all groups."""

    def __init__(self, cells: Cells, atlas: Atlas):
        self.cells = cells
        axes = atlas.axes
        self.values = {
            "age": ({normalize_header(value): value for value in axes.age}, AGE_ALL, axes.age),
            "sex": ({normalize_header(value): value for value in axes.sex}, SEX_ALL, axes.sex),
            "ethnicity": ({normalize_header(value): value for value in axes.ethnicity}, ETHNICITY_ALL, axes.ethnicity),
        }

    def values_of_row(self) -> tuple[str, str, str] | None:
        found = []
        for axis, (lookup, all_value, labels) in self.values.items():
            raw = self.cells.raw(axis)
            if raw is None:
                found.append(all_value)
                continue
            value = lookup.get(normalize_header(raw))
            if value is None:
                self.cells.fail("unknown_lens_value", axis, f"Unknown {axis} group; use one of: {', '.join(labels)}.", raw)
                continue
            found.append(value)
        return tuple(found) if len(found) == 3 else None


def _incident_conditions(
    checker: _Checker, cells: Cells, noun: str = "An incident"
) -> tuple[tuple[str, ...], tuple[str, ...], str | None] | None:
    """(codes, anchor condition ids, chapter id) of an incident's (or an effect's) ICD-11 codes cell."""
    raw = cells.raw("codes")
    if raw is None:
        cells.fail("missing_value", "codes", 'ICD-11 codes is empty; give codes separated by ";" or a chapter such as "chapter 06".')
        return None
    text = _code_text(raw)
    atlas = checker.context.atlas
    chapter = _CHAPTER.match(text) or re.match(r"^CH-(\d{1,2})$", text, re.IGNORECASE)
    if chapter:
        number = f"{int(chapter.group(1)):02d}"
        found = next((concept for concept in atlas.concepts if concept.level == 0 and concept.chapter_no == number), None)
        if found is None:
            cells.fail("unknown_icd_code", "codes", f"The atlas has no chapter {number}.", raw)
            return None
        return (), (), found.concept_id
    parts = [part.strip() for part in re.split(r"[;,]", text) if part.strip()]
    if not parts:
        cells.fail("missing_value", "codes", "ICD-11 codes is empty.")
        return None
    if len(parts) > MAX_INCIDENT_CODES:
        cells.fail("invalid_value", "codes", f"{noun} names at most {MAX_INCIDENT_CODES} codes; this one has {len(parts)}. Use a chapter instead.", raw)
        return None
    codes, anchors = [], []
    for part in dict.fromkeys(parts):
        concept = atlas.by_id.get(part)
        anchor = None
        if concept is None:
            cells.fail("unknown_icd_code", "codes", _number_hint(part) or f"{part} is not an ICD-11 code in the atlas.", part)
            return None
        if concept.level < 2:
            cells.fail("unknown_icd_code", "codes", f'{part} is a chapter or block; name its conditions, or the whole chapter as "{CHAPTER_PREFIX} {concept.chapter_no}".', part)
            return None
        if concept.depth == 1 and concept.is_top_level_condition:
            anchor = concept
        elif concept.depth > 1:
            anchor = atlas.metric_anchor(concept)
        if anchor is None or not anchor.is_top_level_condition:
            cells.fail("unknown_icd_code", "codes", f"{part} has no top-level condition in the atlas to mark.", part)
            return None
        codes.append(concept.concept_id)
        anchors.append(anchor.concept_id)
    return tuple(codes), tuple(anchors), None


def _check_card(cells: Cells, context: UploadContext, model_version, use_case) -> None:
    """The card (AI system × function) a safety incident or an effect names must be in
    the live registry; one only in a staged registry upload is a note."""
    if not (isinstance(model_version, str) and isinstance(use_case, str)):
        return
    card = (model_version, use_case)
    if card in context.registry_variants:
        return
    if card in context.staged_registry_variants:
        cells.note("configuration_not_published", "use_case", f"{model_version} / {use_case} is only in the staged update of AI systems & functions.", use_case)
        return
    known = any(model == model_version for model, _ in context.registry_variants | context.staged_registry_variants)
    cells.fail(
        "unknown_configuration",
        "use_case" if known else "model_version",
        f"{model_version} has no function {use_case!r}." if known else f"The registry has no AI system {model_version!r}.",
        use_case if known else model_version,
    )


def _check_safety(checker: _Checker, cells: Cells) -> SafetyContent | None:
    context = checker.context
    extras = RowExtras(cells, context)
    lenses = _OptionalLens(cells, context.atlas)
    incidents: dict[str, IncidentRecord] = {}
    removals: list[str] = []
    seen: dict[str, int] = {}
    for number in checker.rows(cells, MAX_SAFETY_ROWS, expected_rows=50):
        incident_id = cells.text("incident_id", required=True)
        if isinstance(incident_id, str) and not _INCIDENT_ID.match(incident_id):
            incident_id = cells.fail("invalid_value", "incident_id", 'Incident ID may use letters, digits, ".", "_", and "-" only (at most 64).', incident_id)
        action = extras.action()
        if action == ACTION_REMOVE:
            if isinstance(incident_id, str):
                if incident_id in seen:
                    cells.fail("duplicate_key", "incident_id", f"{incident_id} also appears in row {seen[incident_id]}.", incident_id)
                else:
                    seen[incident_id] = number
                    removals.append(incident_id)
            continue
        model_version = cells.text("model_version", required=True)
        use_case = cells.text("use_case", required=True)
        conditions = _incident_conditions(checker, cells)
        lens = lenses.values_of_row()
        incident_type = cells.choice("incident_type", _INCIDENT_TYPES, "unknown_incident_type", f"Use one of: {', '.join(INCIDENT_TYPE_LABELS.values())}.", required=True)
        harm = cells.choice("harm", _HARMS, "unknown_harm", "Use Occurred, Possible, or None.", required=True)
        status = cells.choice("status", _INCIDENT_STATUSES, "unknown_incident_status", "Use Open, Mitigated, or Closed.", required=True)
        source_type = cells.choice("source_type", _SOURCE_TYPES, "unknown_source_type", f"Use one of: {', '.join(SOURCE_TYPE_LABELS.values())}.", required=True)
        source_reference = cells.text("source_reference", required=True, max_length=MAX_SOURCE)
        study_id = cells.text("study_id", required=False)
        reported = cells.date("reported_date", required=True)
        updated = cells.date("updated_date")
        summary = cells.text("summary", required=True, max_length=MAX_SUMMARY)
        scope = _scope(cells)
        if source_type == "study" and study_id is None:
            cells.fail("missing_study_id", "study_id", "Source type is Study, so Study ID is needed.")
        if isinstance(reported, str) and isinstance(updated, str) and updated < reported:
            cells.fail("invalid_date", "updated_date", f"Updated date {updated} is before Reported date {reported}.", updated)
        _check_card(cells, context, model_version, use_case)
        if not cells.ok or not isinstance(incident_id, str):
            continue
        if incident_id in seen:
            cells.fail("duplicate_key", "incident_id", f"{incident_id} also appears in row {seen[incident_id]}.", incident_id)
            continue
        seen[incident_id] = number
        codes, condition_ids, chapter_id = conditions
        incidents[incident_id] = IncidentRecord(
            incident_id=incident_id,
            model_version=model_version,
            use_case=use_case,
            codes=codes,
            condition_ids=condition_ids,
            chapter_id=chapter_id,
            age=lens[0],
            sex=lens[1],
            ethnicity=lens[2],
            incident_type=incident_type,
            harm=harm,
            status=status,
            source_type=source_type,
            source_reference=source_reference,
            study_id=study_id,
            reported_date=reported,
            updated_date=updated,
            summary=summary,
            scope=scope,
        )
    if checker.row_count == 0:
        return None
    if not context.merging:
        return SafetyContent(list(incidents.values()))
    return _safety_merge(checker, incidents, removals, seen)


def _safety_merge(checker: _Checker, upserts: dict[str, IncidentRecord], removals: list[str], rows_at: dict[str, int]) -> SafetyContent:
    base = checker.context.merge_base or MergeBase(None)
    stored = {incident.incident_id: incident for incident in base.incidents}
    touched = 0
    for incident_id, incident in list(upserts.items()):
        current = stored.get(incident_id)
        if current is not None and incident.last_date < current.last_date:
            checker.issues.add(
                "newer_study_kept",
                rows_at[incident_id],
                f"{incident_id}: this row's date {incident.last_date} is older than the stored incident's ({current.last_date}); the stored incident stays.",
                column=checker.headers.get("updated_date"),
                value=incident.last_date,
            )
            del upserts[incident_id]
    merged = dict(stored)
    for incident_id in removals:
        if incident_id in merged:
            del merged[incident_id]
            touched += 1
        else:
            checker.issues.add("nothing_to_remove", rows_at[incident_id], f"{incident_id} is not a stored incident; nothing is removed.", column=checker.headers.get("action"), value="Remove")
    for incident_id, incident in upserts.items():
        merged[incident_id] = incident  # replaced in place, or appended
        touched += 1
    return SafetyContent(list(merged.values()), merge=MergeInfo(base.set_id, touched))


# ----------------------------------------------------------------- studies

_STUDY_DESIGNS = _choices(STUDY_DESIGN_LABELS, ("real world deployment", "real_world_deployment"), ("rct", "randomized_trial"), ("randomised trial", "randomized_trial"))
_STUDY_CONDUCTORS = _choices(STUDY_CONDUCTOR_LABELS, ("developer study", "developer"), ("independent study", "independent"), ("hospital evaluation", "hospital"))
_REPORTING_GUIDELINES = _choices(REPORTING_GUIDELINE_LABELS, ("tripod ai", "tripod_ai"), ("stard ai", "stard_ai"), ("consort ai", "consort_ai"), ("decide ai", "decide_ai"))
_GUIDELINE_FOLLOWED = _choices(GUIDELINE_FOLLOWED_LABELS, ("partially", "partly"))
_RISK_OF_BIAS = _choices(RISK_OF_BIAS_LABELS)
MAX_STUDY_ROWS = 10_000


_SCOPES = _choices(SCOPE_LABELS, ("hospital evaluation", "hospital"), ("local", "hospital"))
# Contract v1.14 (§22): optional study fields, never graded.
_APPLICABILITY = _choices(APPLICABILITY_LABELS, ("low concern", "low"), ("low concerns", "low"), ("high concern", "high"), ("high concerns", "high"))
_QUALITY_TOOLS = _choices(QUALITY_TOOL_LABELS, ("probast ai", "probast_ai"), ("appraise ai", "appraise_ai"), ("quadas ai", "quadas_ai"))
_SETTING_CATEGORIES = _choices(
    SETTING_CATEGORY_LABELS, ("emergency", "emergency_department"), ("ed", "emergency_department"), ("icu", "intensive_care"),
    ("intensive care unit", "intensive_care"), ("ward", "inpatient_ward"), ("inpatient", "inpatient_ward"),
    ("outpatient", "outpatient_clinic"), ("outpatient clinics", "outpatient_clinic"), ("general practice", "primary_care"),
)


def _scope(cells: Cells) -> str:
    """A record's scope (contract v1.13, §26): an empty cell, or a file without the column, is public."""
    scope = cells.choice("scope", _SCOPES, "unknown_scope", "Use Public or Hospital.", required=False)
    return scope if isinstance(scope, str) else "public"


def _study_appraisal_fields(cells: Cells) -> dict:
    """The optional study fields of contract v1.14 (CONTRACT.md §22): applicability concerns with
    notes, the appraisal tool and its score, the setting category, and the configuration evaluated.
    Never graded. A file without the columns, or with empty cells, gives None for each."""
    applicability = cells.choice("applicability", _APPLICABILITY, "unknown_applicability", "Use Low, High, or Unclear.", required=False)
    notes = cells.text("applicability_notes", required=False, max_length=MAX_STUDY_NOTES)
    tool = cells.choice(
        "quality_tool", _QUALITY_TOOLS, "unknown_quality_tool", f"Use one of: {', '.join(QUALITY_TOOL_LABELS.values())}.", required=False
    )
    score = cells.number("quality_score", low=QUALITY_SCORE_RANGE[0], high=QUALITY_SCORE_RANGE[1])
    if tool is None and score is not None and score is not BAD:
        score = cells.fail(
            "quality_score_without_tool", "quality_score",
            "Appraisal score is given without an Appraisal tool; name the tool that gave the score, or leave the score empty.",
            cells.raw("quality_score"),
        )
    setting = cells.choice(
        "setting_category", _SETTING_CATEGORIES, "unknown_setting_category",
        f"Use one of: {', '.join(SETTING_CATEGORY_LABELS.values())}.", required=False,
    )
    configuration = cells.text("configuration_id", required=False)
    if isinstance(configuration, str) and not _STUDY_CONFIGURATION_ID.match(configuration):
        configuration = cells.fail(
            "invalid_study_configuration", "configuration_id",
            'Configuration evaluated may use letters, digits, ".", "_", and "-" only (at most 64), e.g. cfg-2026-03.', configuration,
        )
    return {
        "applicability": applicability,
        "applicability_notes": notes,
        "quality_tool": tool,
        "quality_score": score,
        "setting_category": setting,
        "configuration_id": configuration,
    }


def _note_unlisted_configuration(cells: Cells, context: UploadContext, model_version, configuration_id) -> None:
    """Contract v1.14 (§22, §28.5): a non-blocking note when a study that names its AI system
    names a configuration none of that system's cards lists, live or staged. It may be an
    earlier configuration, which the condition card then reads as such."""
    if not isinstance(model_version, str) or not isinstance(configuration_id, str):
        return
    if model_version not in context.model_versions | context.staged_model_versions:
        return  # unknown_study_model (or model_not_published) says what is wrong
    if configuration_id not in context.model_configurations.get(model_version, frozenset()):
        cells.note(
            "configuration_not_in_registry", "configuration_id",
            f"{configuration_id} is not a configuration of {model_version} in AI systems & functions.", configuration_id,
        )


def _check_studies(checker: _Checker, cells: Cells) -> StudiesContent | None:
    """Study records (contract v1.13, CONTRACT.md §22): one row per Study ID."""
    context = checker.context
    extras = RowExtras(cells, context)
    studies: dict[str, StudyRecord] = {}
    removals: list[str] = []
    seen: dict[str, int] = {}
    for number in checker.rows(cells, MAX_STUDY_ROWS, expected_rows=50):
        study_id = cells.text("study_id", required=True)
        if isinstance(study_id, str) and not _STUDY_ID.match(study_id):
            study_id = cells.fail("invalid_value", "study_id", 'Study ID may use letters, digits, ".", "_", and "-" only (at most 64).', study_id)
        action = extras.action()
        if action == ACTION_REMOVE:
            if isinstance(study_id, str):
                if study_id in seen:
                    cells.fail("duplicate_key", "study_id", f"{study_id} also appears in row {seen[study_id]}.", study_id)
                else:
                    seen[study_id] = number
                    removals.append(study_id)
            continue
        title = cells.text("title", required=True, max_length=MAX_STUDY_TITLE)
        design = cells.choice("design", _STUDY_DESIGNS, "unknown_study_design", f"Use one of: {', '.join(STUDY_DESIGN_LABELS.values())}.", required=True)
        setting = cells.text("setting", required=True, max_length=MAX_STUDY_TEXT)
        sites = cells.count("sites")
        if sites is None:
            sites = cells.fail("missing_value", "sites", "Sites is empty; give the number of sites.")
        elif sites is not BAD and sites < 1:
            sites = cells.fail("out_of_range", "sites", "Sites must be at least 1.", cells.raw("sites"))
        patients = cells.count("patients")
        if patients is None:
            patients = cells.fail("missing_value", "patients", "Patients is empty; give the number of patients or cases.")
        peer_reviewed = cells.yes_no("peer_reviewed", required=True)
        conducted_by = cells.choice("conducted_by", _STUDY_CONDUCTORS, "unknown_study_conductor", "Use Developer, Independent, or Hospital.", required=True)
        guideline = cells.choice(
            "reporting_guideline", _REPORTING_GUIDELINES, "unknown_reporting_guideline",
            f"Use one of: {', '.join(REPORTING_GUIDELINE_LABELS.values())}.", required=True,
        )
        followed = cells.choice("guideline_followed", _GUIDELINE_FOLLOWED, "unknown_guideline_followed", "Use Yes, Partly, or No.", required=False)
        if guideline == "none" and isinstance(followed, str):
            followed = cells.fail(
                "guideline_followed_without_guideline", "guideline_followed",
                "Reporting guideline is None, so Guideline followed must be empty.", GUIDELINE_FOLLOWED_LABELS[followed],
            )
        elif isinstance(guideline, str) and guideline != "none" and followed is None:
            followed = cells.fail(
                "missing_guideline_followed", "guideline_followed",
                f"Reporting guideline is {REPORTING_GUIDELINE_LABELS[guideline]}, so Guideline followed needs Yes, Partly, or No.",
            )
        risk = cells.choice("risk_of_bias", _RISK_OF_BIAS, "unknown_risk_of_bias", "Use Low, Some concerns, High, or Unclear.", required=True)
        risk_notes = cells.text("risk_of_bias_notes", required=False, max_length=MAX_STUDY_NOTES)
        population = cells.text("population", required=True, max_length=MAX_STUDY_TEXT)
        conditions = cells.text("evaluation_conditions", required=True, max_length=MAX_STUDY_NOTES)
        model_version = cells.text("model_version", required=False)
        published = cells.date("publication_date", required=True)
        source_url = url_cell(cells, "source_url")
        scope = _scope(cells)
        study_population = cells.text("population_id", required=False)
        if scope == "hospital" and study_population is None:
            study_population = cells.fail("missing_value", "population_id", "Scope is Hospital, so Local population needs the id of the local population evaluated.")
        elif scope == "public" and isinstance(study_population, str):
            study_population = cells.fail("population_without_hospital_scope", "population_id", "Scope is Public, so leave Local population empty.", study_population)
        elif isinstance(study_population, str) and study_population not in context.live_population_ids:
            study_population = cells.fail("unknown_population", "population_id", f"There is no published local population {study_population!r}.", study_population)
        if isinstance(model_version, str) and model_version not in context.model_versions:
            if model_version in context.staged_model_versions:
                cells.note("model_not_published", "model_version", f"{model_version} is only in the staged update of AI systems & functions.", model_version)
            else:
                cells.fail("unknown_study_model", "model_version", f"The registry has no AI system {model_version!r}.", model_version)
        appraisal_fields = _study_appraisal_fields(cells)
        _note_unlisted_configuration(cells, context, model_version, appraisal_fields["configuration_id"])
        if not cells.ok or not isinstance(study_id, str):
            continue
        if study_id in seen:
            cells.fail("duplicate_key", "study_id", f"{study_id} also appears in row {seen[study_id]}.", study_id)
            continue
        seen[study_id] = number
        studies[study_id] = StudyRecord(
            study_id=study_id,
            title=title,
            design=design,
            setting=setting,
            sites=sites,
            patients=patients,
            peer_reviewed=peer_reviewed,
            conducted_by=conducted_by,
            reporting_guideline=guideline,
            guideline_followed=followed,
            risk_of_bias=risk,
            risk_of_bias_notes=risk_notes,
            population=population,
            evaluation_conditions=conditions,
            model_version=model_version,
            publication_date=published,
            source_url=source_url,
            scope=scope,
            population_id=study_population,
            **appraisal_fields,
        )
    if checker.row_count == 0:
        return None
    if not context.merging:
        return StudiesContent(list(studies.values()))
    base = context.merge_base or MergeBase(None)
    merged = {study.study_id: study for study in base.studies}
    touched = 0
    for study_id in removals:
        if study_id in merged:
            del merged[study_id]
            touched += 1
        else:
            checker.issues.add("nothing_to_remove", seen[study_id], f"{study_id} is not a stored study; nothing is removed.", column=checker.headers.get("action"), value="Remove")
    for study_id, study in studies.items():
        merged[study_id] = study  # replaced in place, or appended
        touched += 1
    return StudiesContent(list(merged.values()), merge=MergeInfo(base.set_id, touched))


# ----------------------------------------------------------------- effects

_OUTCOME_TYPES = _choices(OUTCOME_TYPE_LABELS)
_EFFECT_MEASURES = _choices(
    EFFECT_MEASURE_LABELS, ("rr", "risk_ratio"), ("relative risk", "risk_ratio"), ("or", "odds_ratio"), ("hr", "hazard_ratio"),
    ("rd", "risk_difference"), ("md", "mean_difference"), ("smd", "standardized_mean_difference"),
    ("standardised mean difference", "standardized_mean_difference"),
)
_EFFECT_DIRECTIONS = _choices(EFFECT_DIRECTION_LABELS, ("higher", "higher_is_better"), ("lower", "lower_is_better"))
_APPRAISAL_TOOLS = _choices(APPRAISAL_TOOL_LABELS, ("rob 2", "rob2"), ("robins i", "robins_i"), ("robins", "robins_i"))
_EFFECT_JUDGEMENTS = _choices(EFFECT_JUDGEMENT_LABELS)
MAX_EFFECT_ROWS = 10_000
_ANY_NUMBER = float("-inf")
_DESIGN_WORDS = {"randomized_trial": "a randomized trial", "prospective": "a prospective study", "real_world_deployment": "a real-world deployment"}


def _effect_numbers(cells: Cells, measure) -> tuple:
    """Estimate, CI low, and CI high: required, in order, and above 0 for a ratio."""
    numbers = []
    for key in ("estimate", "ci_low", "ci_high"):
        value = cells.number(key, low=_ANY_NUMBER, high=None)
        if value is None:
            value = cells.fail("missing_value", key, f"{cells.headers[key]} is empty; give the effect estimate and its 95% confidence interval.")
        numbers.append(value)
    estimate, low, high = numbers
    if any(value is BAD for value in numbers):
        return tuple(numbers)
    if measure in EFFECT_RATIO_MEASURES:
        for key, value in zip(("estimate", "ci_low", "ci_high"), numbers):
            if value <= 0:
                cells.fail("effect_ratio_not_positive", key, f"{cells.headers[key]} is {value:g}, but a {EFFECT_MEASURE_LABELS[measure].lower()} is above 0.", cells.raw(key))
                return (BAD, BAD, BAD)
    if not low <= estimate <= high:
        key = "ci_low" if low > estimate else "ci_high"
        cells.fail("effect_ci_order", key, f"Estimate {estimate:g} is not between CI low {low:g} and CI high {high:g}.", cells.raw(key))
        return (BAD, BAD, BAD)
    return estimate, low, high


def _effect_appraisal(cells: Cells, context: UploadContext, study_id) -> tuple:
    """The study (it must exist and have a design that can show an effect), the
    appraisal tool (the one its design needs), and the judgement."""
    tool = cells.choice("appraisal_tool", _APPRAISAL_TOOLS, "unknown_appraisal_tool", "Use RoB 2 or ROBINS-I.", required=True)
    judgement = cells.choice(
        "judgement", _EFFECT_JUDGEMENTS, "unknown_effect_judgement", "Use Low, Some concerns, High, Critical, or Unclear.", required=True
    )
    if isinstance(study_id, str):
        design = context.study_designs.get(study_id)
        if design is None:
            study_id = cells.fail("unknown_effect_study", "study_id", f"Studies has no study {study_id!r}.", study_id)
        elif design not in EFFECT_STUDY_DESIGNS:
            study_id = cells.fail(
                "effect_study_design",
                "study_id",
                f"{study_id} is a {STUDY_DESIGN_LABELS.get(design, design).lower()} study; an effect needs a randomized trial, a prospective study, or a real-world deployment.",
                study_id,
            )
        elif isinstance(tool, str) and tool != EFFECT_STUDY_DESIGNS[design]:
            needed = EFFECT_STUDY_DESIGNS[design]
            tool = cells.fail(
                "appraisal_tool_mismatch",
                "appraisal_tool",
                f"{study_id} is {_DESIGN_WORDS[design]}, so its effects are appraised with {APPRAISAL_TOOL_LABELS[needed]}.",
                APPRAISAL_TOOL_LABELS[tool],
            )
    if tool == "rob2" and judgement == "critical":
        judgement = cells.fail("judgement_not_in_tool", "judgement", "RoB 2 has no Critical judgement; its worst is High.", "Critical")
    return study_id, tool, judgement


def _check_effects(checker: _Checker, cells: Cells) -> EffectsContent | None:
    """Intervention effects (contract v1.13, CONTRACT.md §27): one row per Effect ID."""
    context = checker.context
    extras = RowExtras(cells, context)
    effects: dict[str, EffectRecord] = {}
    removals: list[str] = []
    seen: dict[str, int] = {}
    for number in checker.rows(cells, MAX_EFFECT_ROWS, expected_rows=50):
        effect_id = cells.text("effect_id", required=True)
        if isinstance(effect_id, str) and not _EFFECT_ID.match(effect_id):
            effect_id = cells.fail("invalid_value", "effect_id", 'Effect ID may use letters, digits, ".", "_", and "-" only (at most 64).', effect_id)
        action = extras.action()
        if action == ACTION_REMOVE:
            if isinstance(effect_id, str):
                if effect_id in seen:
                    cells.fail("duplicate_key", "effect_id", f"{effect_id} also appears in row {seen[effect_id]}.", effect_id)
                else:
                    seen[effect_id] = number
                    removals.append(effect_id)
            continue
        study_id = cells.text("study_id", required=True)
        model_version = cells.text("model_version", required=True)
        use_case = cells.text("use_case", required=True)
        conditions = _incident_conditions(checker, cells, "An effect")
        outcome = cells.text("outcome", required=True, max_length=MAX_OUTCOME)
        outcome_type = cells.choice("outcome_type", _OUTCOME_TYPES, "unknown_outcome_type", "Use Benefit, Harm, or Process.", required=True)
        population = cells.text("population", required=True, max_length=MAX_EFFECT_TEXT)
        comparator = cells.text("comparator", required=True, max_length=MAX_EFFECT_TEXT)
        measure = cells.choice(
            "effect_measure", _EFFECT_MEASURES, "unknown_effect_measure", f"Use one of: {', '.join(EFFECT_MEASURE_LABELS.values())}.", required=True
        )
        estimate, ci_low, ci_high = _effect_numbers(cells, measure)
        unit = cells.text("unit", required=False, max_length=MAX_EFFECT_UNIT)
        direction = cells.choice("direction", _EFFECT_DIRECTIONS, "unknown_effect_direction", "Use Higher is better or Lower is better.", required=True)
        follow_up = cells.text("follow_up", required=False, max_length=MAX_FOLLOW_UP)
        study_id, tool, judgement = _effect_appraisal(cells, context, study_id)
        notes = cells.text("notes", required=False, max_length=MAX_EFFECT_NOTES)
        _check_card(cells, context, model_version, use_case)
        if not cells.ok or not isinstance(effect_id, str) or conditions is None:
            continue
        if effect_id in seen:
            cells.fail("duplicate_key", "effect_id", f"{effect_id} also appears in row {seen[effect_id]}.", effect_id)
            continue
        seen[effect_id] = number
        codes, condition_ids, chapter_id = conditions
        effects[effect_id] = EffectRecord(
            effect_id=effect_id,
            study_id=study_id,
            model_version=model_version,
            use_case=use_case,
            codes=codes,
            condition_ids=condition_ids,
            chapter_id=chapter_id,
            outcome=outcome,
            outcome_type=outcome_type,
            population=population,
            comparator=comparator,
            effect_measure=measure,
            estimate=estimate,
            ci_low=ci_low,
            ci_high=ci_high,
            unit=unit,
            direction=direction,
            follow_up=follow_up,
            appraisal_tool=tool,
            judgement=judgement,
            notes=notes,
        )
    if checker.row_count == 0:
        return None
    if not context.merging:
        return EffectsContent(list(effects.values()))
    base = context.merge_base or MergeBase(None)
    merged = {effect.effect_id: effect for effect in base.effects}
    touched = 0
    for effect_id in removals:
        if effect_id in merged:
            del merged[effect_id]
            touched += 1
        else:
            checker.issues.add("nothing_to_remove", seen[effect_id], f"{effect_id} is not a stored effect; nothing is removed.", column=checker.headers.get("action"), value="Remove")
    for effect_id, effect in effects.items():
        merged[effect_id] = effect  # replaced in place, or appended
        touched += 1
    return EffectsContent(list(merged.values()), merge=MergeInfo(base.set_id, touched))


def check_upload(
    table: Table,
    kind: str,
    context: UploadContext,
    *,
    target: tuple[str, str] | None = None,
    progress: Callable[[float], None] = lambda share: None,
    cancelled: Callable[[], bool] = lambda: False,
) -> CheckResult:
    """Check one upload. ``target`` is the (model_version, use_case) of metrics
    and multimorbidity uploads. Raises ``Cancelled`` when ``cancelled()``."""
    issues = Issues()
    if kind == "local_metrics" and context.local_population not in context.live_population_ids:
        issues.add(
            "unknown_population", 0, f"There is no published local population {context.local_population!r}.",
            column="population_id", value=context.local_population, mark=False,
        )
    if target is not None:
        if target not in context.registry_variants:
            if target in context.staged_registry_variants:
                issues.add("target_not_published", 0, f"{target[0]} / {target[1]} is only in the staged update of AI systems & functions.", mark=False)
            else:
                known_model = any(model == target[0] for model, _ in context.registry_variants)
                issues.add(
                    "unknown_target",
                    0,
                    f"The registry has no function {target[1]!r} for {target[0]!r}."
                    if known_model
                    else f"The registry has no AI system {target[0]!r}.",
                    column="use_case" if known_model else "model_version",
                    value=target[1] if known_model else target[0],
                    mark=False,
                )
    header = check_header(table, kind, issues)
    if header is None:
        return CheckResult(issues, 0, None, target)
    positions, headers = header
    cells = Cells(issues, positions, headers, table.decimal_comma)
    checker = _Checker(table, kind, context, issues, progress=progress, cancelled=cancelled)
    checker.headers = headers
    if kind in ("metrics", "local_metrics"):
        content = _check_metrics(checker, cells, target)
    elif kind == "multimorbidity":
        content = _check_multimorbidity(checker, cells, target)
    elif kind == "models":
        content = _check_registry(checker, cells)
    elif kind == "safety":
        content = _check_safety(checker, cells)
    elif kind == "studies":
        content = _check_studies(checker, cells)
    elif kind == "effects":
        content = _check_effects(checker, cells)
    else:
        content = _check_prevalence(checker, cells)
    if checker.row_count == 0:
        issues.add("empty_file", 0, "There are no rows below the header row.", mark=False)
    return CheckResult(issues, checker.row_count, None if issues.has_errors else content, target, checker.extra)
