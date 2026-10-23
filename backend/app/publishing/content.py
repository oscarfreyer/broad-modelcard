"""The content of one data set: parsed from an upload, or read from the store.

A content object is what a content set holds (see migrations/0001_initial.sql
and 0004_safety_merge_provenance.sql): the registry, the prevalence tiers, the
metrics or multimorbidity tuples of one model and use case, or the safety
incidents. Metric tuples are kept as stored: the 13 ``METRIC_ROW_FORMAT``
fields, ``in_intended_use`` as 0/1, and the warnings as a tuple of codes.

Metrics and prevalence rows carry a source (contract v1.7, ``RowSource``):
each set stores a default source and, in a sparse side table, the rows whose
source differs from it.

A ``MergeContent`` (a merge upload of metrics or prevalence, contract v1.7) is
written as a copy of its base set with the merged rows removed, replaced, or
added; the copy runs in SQL, so a one-row merge never loads the 216,000 rows
of a metrics set into Python. Safety sets are small and always written whole.
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from dataclasses import dataclass, field

from ..repository import (
    EFFECT_COLUMNS,
    INCIDENT_COLUMNS,
    ModelCardRecord,
    SEED_PROVENANCE_ID,
    STUDY_COLUMNS,
    TUPLE_COLUMNS,
    DatasetState,
    EffectRecord,
    IncidentRecord,
    RowSource,
    StudyRecord,
    default_provenance_id,
    load_effects,
    load_incidents,
    load_model_cards,
    load_studies,
    provenance_sources,
)
from ..schema.contract import DEFAULT_ENTRY_KIND

StoredTuple = tuple  # METRIC_ROW_FORMAT order; warnings as a tuple of codes


@dataclass
class MetricsContent:
    model_version: str
    use_case: str
    # Lens combinations the set defines, in order.
    combos: tuple[int, ...]
    # (combo_idx, concept_id) → stored tuple.
    rows: dict[tuple[int, str], StoredTuple]
    kind: str = field(default="metrics", init=False)
    # Sources given in the file (contract v1.7); rows without one get
    # ``fallback_source`` (the upload), or the seed's when None.
    sources: dict[tuple[int, str], RowSource] = field(default_factory=dict)
    fallback_source: RowSource | None = None


@dataclass
class LocalMetricsContent(MetricsContent):
    """Local evaluation results (contract v1.13, CONTRACT.md §26): metric rows
    of one card for one local population, stored like a metrics set. A read
    for the population serves each local row in place of the public row of
    the same condition and lens."""

    population_id: str = ""

    def __post_init__(self) -> None:
        self.kind = "local_metrics"


def row_kind(kind: str) -> str:
    """How a kind's rows are stored: local results are stored like metrics."""
    return "metrics" if kind == "local_metrics" else kind


@dataclass
class Combination:
    condition_ids: tuple[str, ...]  # as given, in the given order
    key: str  # canonical unordered key (CONTRACT.md §8)
    label: str | None
    rows: dict[int, StoredTuple]  # combo_idx → stored tuple


@dataclass
class MultimorbidityContent:
    model_version: str
    use_case: str
    combos: tuple[int, ...]
    combinations: list[Combination]
    kind: str = field(default="multimorbidity", init=False)


@dataclass(frozen=True)
class ConfigurationFields:
    """Fields of one configuration (model × use case) since contract v1.5.

    The declarations are the developer's own statements; Broad Modelcard does
    not verify them. Since contract v1.14 (§28) also the configuration record,
    what the card's figures measure, and the data-protection declarations."""

    function_category: str | None = None
    declared_intended_purpose: str | None = None
    declared_regulatory_status: str | None = None
    declared_contact: str | None = None
    declared_documentation_url: str | None = None
    # Contract v1.11: False when the card has no intended-use statement.
    intended_use_defined: bool = True
    # Contract v1.14 (§28.1): the configuration record (a summary of the
    # prompt, never the prompt itself).
    configuration_id: str | None = None
    configuration_date: str | None = None  # ISO YYYY-MM-DD
    prompt_summary: str | None = None
    prompt_sha256: str | None = None
    retrieval: str | None = None
    tools: tuple[str, ...] = ()
    sampling_temperature: float | None = None
    sampling_top_p: float | None = None
    sampling_max_output_tokens: int | None = None
    fine_tuning: str | None = None
    # Contract v1.14 (§28.1, F6): what the card's figures measure.
    performance_measure: str | None = None
    reference_standard: str | None = None
    # Contract v1.14 (§28, F8): data-protection declarations.
    declared_data_use: str | None = None
    declared_data_location: str | None = None
    declared_retention: str | None = None
    declared_privacy_contact: str | None = None

    def values(self) -> tuple:
        """The stored values, in ``_CONFIGURATION_COLUMNS`` order (a statement is stored as NULL)."""
        return (
            self.function_category,
            self.declared_intended_purpose,
            self.declared_regulatory_status,
            self.declared_contact,
            self.declared_documentation_url,
            None if self.intended_use_defined else 0,
            self.configuration_id,
            self.configuration_date,
            self.prompt_summary,
            self.prompt_sha256,
            self.retrieval,
            json.dumps(list(self.tools)) if self.tools else None,
            self.sampling_temperature,
            self.sampling_top_p,
            self.sampling_max_output_tokens,
            self.fine_tuning,
            self.performance_measure,
            self.reference_standard,
            self.declared_data_use,
            self.declared_data_location,
            self.declared_retention,
            self.declared_privacy_contact,
        )

    @classmethod
    def stored(cls, *values) -> "ConfigurationFields":
        """From stored values in ``_CONFIGURATION_COLUMNS`` order."""
        declared, (intended_use_defined, *record) = values[:5], values[5:]
        fields = dict(zip(_V114_CONFIGURATION_FIELDS, record, strict=True))
        fields["tools"] = tuple(json.loads(fields["tools"])) if fields["tools"] is not None else ()
        return cls(*declared, intended_use_defined=intended_use_defined != 0, **fields)


# The configuration fields of contract v1.14, in stored order (``tools`` is stored as tools_json).
_V114_CONFIGURATION_FIELDS = (
    "configuration_id", "configuration_date", "prompt_summary", "prompt_sha256", "retrieval", "tools",
    "sampling_temperature", "sampling_top_p", "sampling_max_output_tokens", "fine_tuning",
    "performance_measure", "reference_standard",
    "declared_data_use", "declared_data_location", "declared_retention", "declared_privacy_contact",
)


NO_CONFIGURATION_FIELDS = ConfigurationFields()


@dataclass
class ModelEntry:
    """One registry entry ("AI system" in the UI): a model or a product."""

    model_version: str
    display_name: str
    model_name: str | None
    model_release: str | None
    status: str
    default_use_case: str | None
    use_cases: tuple[str, ...]
    # Generator parameters of the legacy import; kept, not part of the templates.
    effects: dict | None = None
    capabilities: dict | None = None
    # Entry fields (contract v1.5). ``kind`` is never None here: an entry
    # stored without a kind is a model.
    kind: str = DEFAULT_ENTRY_KIND
    ai_type: str | None = None
    developer: str | None = None
    release_date: str | None = None  # ISO YYYY-MM-DD
    description: str | None = None
    built_on: tuple[str, ...] = ()
    # Contract v1.14 (§28.2): the model version this AI system supersedes.
    replaces: str | None = None
    # use case → its configuration fields; a missing use case has none.
    configurations: dict[str, ConfigurationFields] = field(default_factory=dict)

    def configuration(self, use_case: str) -> ConfigurationFields:
        return self.configurations.get(use_case, NO_CONFIGURATION_FIELDS)

    def entry_values(self) -> tuple:
        """The entry fields, for comparisons (change summaries)."""
        return (self.kind, self.ai_type, self.developer, self.release_date, self.description, self.built_on, self.replaces)


@dataclass
class RegistryContent:
    default_model_version: str | None
    models: list[ModelEntry]
    kind: str = field(default="models", init=False)
    # A developer submission's registry entry (contract v1.13, §26) is merged
    # into the live registry: ``merge`` names that base. None for a replace.
    merge: "MergeInfo | None" = None

    def variants(self) -> list[tuple[str, str]]:
        return [(model.model_version, use_case) for model in self.models for use_case in model.use_cases]


@dataclass
class PrevalenceContent:
    tiers: dict[str, str]  # concept id → tier, in order
    min_score: float
    max_score: float
    kind: str = field(default="prevalence", init=False)
    sources: dict[str, RowSource] = field(default_factory=dict)
    fallback_source: RowSource | None = None


@dataclass
class PopulationContent(PrevalenceContent):
    """A local population (contract v1.10): a prevalence set for some codes,
    with the population's id and display name. Stored like a prevalence set,
    keyed by its own set id, plus its name in ``population_sets``."""

    population_id: str = ""
    name: str = ""

    def __post_init__(self) -> None:
        self.kind = "population"


@dataclass
class SafetyContent:
    """The safety incidents (contract v1.7), in order. ``merge`` describes a
    merge upload's effect (``MergeInfo``), None for a replace upload."""

    incidents: list[IncidentRecord]
    kind: str = field(default="safety", init=False)
    merge: "MergeInfo | None" = None


@dataclass
class StudiesContent:
    """The study records (contract v1.13, CONTRACT.md §22), in order. ``merge``
    describes a merge upload's effect (``MergeInfo``), None for a replace upload."""

    studies: list[StudyRecord]
    kind: str = field(default="studies", init=False)
    merge: "MergeInfo | None" = None


@dataclass
class EffectsContent:
    """The intervention effects (contract v1.13, CONTRACT.md §27), in order. ``merge``
    describes a merge upload's effect (``MergeInfo``), None for a replace upload."""

    effects: list[EffectRecord]
    kind: str = field(default="effects", init=False)
    merge: "MergeInfo | None" = None


@dataclass
class ModelCardsContent:
    """The narrow model cards (contract v1.13, CONTRACT.md §26), at most one per
    AI system, in order. An upload names one AI system's card and is merged
    into the live set (``merge``)."""

    cards: list[ModelCardRecord]
    kind: str = field(default="model_cards", init=False)
    merge: "MergeInfo | None" = None


@dataclass(frozen=True)
class MergeInfo:
    """What a merge upload did, kept in the content set's ``meta_json``.

    ``base_set_id`` is the live set it was applied to (None: there was none);
    ``touched`` counts the keys it added, replaced, or removed (rows kept out
    by the older-study rule and removals of missing keys excluded)."""

    base_set_id: int | None
    touched: int

    def as_meta(self) -> dict:
        return {"mode": "merge", "base_set_id": self.base_set_id, "touched": self.touched}


@dataclass
class MergeContent:
    """A merge upload of metrics or prevalence (contract v1.7, CONTRACT.md §11.2).

    Written as its base set with ``removals`` and the keys of ``upserts``
    taken out and ``upserts`` put in. Metrics keys are ``(combo_idx,
    concept_id)`` with stored tuples as values; prevalence keys are codes with
    tiers as values. ``sources`` gives every upsert's source.
    """

    kind: str  # "metrics", "local_metrics", or "prevalence"
    base_set_id: int | None
    upserts: dict
    removals: list
    sources: dict
    model_version: str | None = None
    use_case: str | None = None
    # Local results (contract v1.13): the local population.
    population_id: str | None = None
    # Metrics: lens combinations the merge adds to the base set's.
    new_combos: tuple[int, ...] = ()
    # Prevalence without a base set: the tier score bounds.
    bounds: tuple[float, float] = (0.03, 0.97)

    @property
    def merge(self) -> MergeInfo:
        return MergeInfo(self.base_set_id, len(self.upserts) + len(self.removals))


Content = (
    MetricsContent | MultimorbidityContent | RegistryContent | PrevalenceContent | PopulationContent | SafetyContent
    | StudiesContent | EffectsContent | MergeContent | LocalMetricsContent | ModelCardsContent
)


# --------------------------------------------------------------- the store

def _warning_codes(conn: sqlite3.Connection) -> dict[int, tuple[str, ...]]:
    return {
        warning_set_id: tuple(json.loads(codes_json))
        for warning_set_id, codes_json in conn.execute("SELECT warning_set_id, codes_json FROM warning_sets")
    }


def _combos(conn: sqlite3.Connection, set_id: int) -> tuple[int, ...]:
    return tuple(
        combo_idx
        for (combo_idx,) in conn.execute("SELECT combo_idx FROM set_combos WHERE set_id = ? ORDER BY position", (set_id,))
    )


def load_metrics(conn: sqlite3.Connection, set_id: int, model_version: str, use_case: str) -> MetricsContent:
    codes = _warning_codes(conn)
    rows = {
        (row[0], row[1]): (*row[2:14], codes[row[14]])
        for row in conn.execute(
            f"SELECT combo_idx, concept_id, {TUPLE_COLUMNS} FROM metric_rows WHERE set_id = ?", (set_id,)
        )
    }
    return MetricsContent(model_version, use_case, _combos(conn, set_id), rows)


def load_multimorbidity(conn: sqlite3.Connection, set_id: int, model_version: str, use_case: str) -> MultimorbidityContent:
    codes = _warning_codes(conn)
    members: dict[int, list[str]] = {}
    for position, concept_id in conn.execute(
        "SELECT position, concept_id FROM mm_combination_conditions WHERE set_id = ? ORDER BY position, member_index",
        (set_id,),
    ):
        members.setdefault(position, []).append(concept_id)
    rows: dict[int, dict[int, StoredTuple]] = {}
    for row in conn.execute(f"SELECT position, combo_idx, {TUPLE_COLUMNS} FROM mm_rows WHERE set_id = ?", (set_id,)):
        rows.setdefault(row[0], {})[row[1]] = (*row[2:14], codes[row[14]])
    combinations = [
        Combination(tuple(members.get(position, ())), key, label, rows.get(position, {}))
        for position, key, label in conn.execute(
            "SELECT position, combination_key, label FROM mm_combinations WHERE set_id = ? ORDER BY position", (set_id,)
        )
    ]
    return MultimorbidityContent(model_version, use_case, _combos(conn, set_id), combinations)


_ENTRY_COLUMNS = "kind, ai_type, developer, release_date, description, built_on_json, replaces"
_CONFIGURATION_COLUMNS = (
    "function_category, declared_intended_purpose, declared_regulatory_status, declared_contact, declared_documentation_url, "
    "intended_use_defined, configuration_id, configuration_date, prompt_summary, prompt_sha256, retrieval, tools_json, "
    "sampling_temperature, sampling_top_p, sampling_max_output_tokens, fine_tuning, performance_measure, reference_standard, "
    "declared_data_use, declared_data_location, declared_retention, declared_privacy_contact"
)
_CONFIGURATION_MARKS = ", ".join("?" * (4 + _CONFIGURATION_COLUMNS.count(",") + 1))


def load_registry(conn: sqlite3.Connection, set_id: int) -> RegistryContent:
    default_model = conn.execute("SELECT default_model_version FROM registry_sets WHERE set_id = ?", (set_id,)).fetchone()
    use_cases: dict[str, list[str]] = {}
    configurations: dict[str, dict[str, ConfigurationFields]] = {}
    for model_version, use_case, *fields in conn.execute(
        f"SELECT model_version, use_case, {_CONFIGURATION_COLUMNS} FROM use_case_variants "
        "WHERE set_id = ? ORDER BY model_version, position",
        (set_id,),
    ):
        use_cases.setdefault(model_version, []).append(use_case)
        if any(value is not None for value in fields):
            configurations.setdefault(model_version, {})[use_case] = ConfigurationFields.stored(*fields)
    models = [
        ModelEntry(
            model_version=row[0],
            display_name=row[1],
            model_name=row[2],
            model_release=row[3],
            status=row[4],
            default_use_case=row[5],
            use_cases=tuple(use_cases.get(row[0], ())),
            effects=json.loads(row[6]) if row[6] is not None else None,
            capabilities=json.loads(row[7]) if row[7] is not None else None,
            kind=row[8] or DEFAULT_ENTRY_KIND,
            ai_type=row[9],
            developer=row[10],
            release_date=row[11],
            description=row[12],
            built_on=tuple(json.loads(row[13])) if row[13] is not None else (),
            replaces=row[14],
            configurations=configurations.get(row[0], {}),
        )
        for row in conn.execute(
            "SELECT model_version, display_name, model_name, model_release, status, default_use_case, effects_json, "
            f"capabilities_json, {_ENTRY_COLUMNS} FROM models WHERE set_id = ? ORDER BY position",
            (set_id,),
        )
    ]
    return RegistryContent(default_model[0] if default_model else None, models)


def load_prevalence(conn: sqlite3.Connection, set_id: int) -> PrevalenceContent:
    bounds = conn.execute("SELECT min_score, max_score FROM prevalence_sets WHERE set_id = ?", (set_id,)).fetchone()
    tiers = dict(conn.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ? ORDER BY code", (set_id,)))
    return PrevalenceContent(tiers, bounds[0], bounds[1])


def load_population(conn: sqlite3.Connection, set_id: int, population_id: str) -> PopulationContent:
    prevalence = load_prevalence(conn, set_id)
    name = conn.execute("SELECT name FROM population_sets WHERE set_id = ?", (set_id,)).fetchone()[0]
    return PopulationContent(prevalence.tiers, prevalence.min_score, prevalence.max_score, population_id=population_id, name=name)


def load_safety(conn: sqlite3.Connection, set_id: int | None) -> SafetyContent:
    return SafetyContent(load_incidents(conn, set_id))


def load_studies_content(conn: sqlite3.Connection, set_id: int | None) -> StudiesContent:
    return StudiesContent(load_studies(conn, set_id))


def load_model_cards_content(conn: sqlite3.Connection, set_id: int | None) -> ModelCardsContent:
    return ModelCardsContent(load_model_cards(conn, set_id))


def load_local_metrics(conn: sqlite3.Connection, set_id: int, target: tuple[str, str, str]) -> LocalMetricsContent:
    metrics = load_metrics(conn, set_id, target[0], target[1])
    return LocalMetricsContent(metrics.model_version, metrics.use_case, metrics.combos, metrics.rows, population_id=target[2])


def load_effects_content(conn: sqlite3.Connection, set_id: int | None) -> EffectsContent:
    return EffectsContent(load_effects(conn, set_id))


def load_sources(conn: sqlite3.Connection, kind: str, set_id: int) -> tuple[RowSource, dict]:
    """A metrics (or local results) or prevalence set's default source and its rows with another
    source (keys as in the content: ``(combo_idx, concept_id)`` or code)."""
    sources = provenance_sources(conn)
    default = sources[default_provenance_id(conn, set_id)]
    if row_kind(kind) == "metrics":
        explicit = {
            (combo_idx, concept_id): sources[provenance_id]
            for combo_idx, concept_id, provenance_id in conn.execute(
                "SELECT combo_idx, concept_id, provenance_id FROM metric_row_provenance WHERE set_id = ?", (set_id,)
            )
        }
    else:
        explicit = {
            code: sources[provenance_id]
            for code, provenance_id in conn.execute(
                "SELECT code, provenance_id FROM prevalence_provenance WHERE set_id = ?", (set_id,)
            )
        }
    return default, explicit


def set_id_of(state: DatasetState, kind: str, target: tuple | str | None = None) -> int | None:
    """The content set of ``kind`` (and target: a card, a population id, or for
    local results a card and population) in a version, or None."""
    if kind == "population":
        return state.population_sets.get(target)
    if kind == "local_metrics":
        return state.local_metric_sets.get(target)
    if kind == "model_cards":
        return state.model_cards_set_id
    if kind == "models":
        return state.registry_set_id
    if kind == "prevalence":
        return state.prevalence_set_id
    if kind == "safety":
        return state.safety_set_id
    if kind == "studies":
        return state.studies_set_id
    if kind == "effects":
        return state.effects_set_id
    sets = state.metric_sets if kind == "metrics" else state.multimorbidity_sets
    return sets.get(target)


def load_content(conn: sqlite3.Connection, kind: str, set_id: int, target: tuple | str | None = None) -> Content:
    if kind == "population":
        return load_population(conn, set_id, target)
    if kind == "local_metrics":
        return load_local_metrics(conn, set_id, target)
    if kind == "model_cards":
        return load_model_cards_content(conn, set_id)
    if kind == "models":
        return load_registry(conn, set_id)
    if kind == "prevalence":
        return load_prevalence(conn, set_id)
    if kind == "safety":
        return load_safety(conn, set_id)
    if kind == "studies":
        return load_studies_content(conn, set_id)
    if kind == "effects":
        return load_effects_content(conn, set_id)
    if kind == "metrics":
        return load_metrics(conn, set_id, *target)
    return load_multimorbidity(conn, set_id, *target)


# ---------------------------------------------------------------- writing

class WarningSetIds:
    """Interns warning lists in ``warning_sets`` (shared by all sets)."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.ids = {codes_json: warning_set_id for warning_set_id, codes_json in conn.execute(
            "SELECT warning_set_id, codes_json FROM warning_sets"
        )}

    def __call__(self, codes: tuple[str, ...]) -> int:
        key = json.dumps(list(codes), separators=(",", ":"))
        warning_set_id = self.ids.get(key)
        if warning_set_id is None:
            warning_set_id = self.conn.execute("INSERT INTO warning_sets (codes_json) VALUES (?)", (key,)).lastrowid
            self.ids[key] = warning_set_id
        return warning_set_id


_ROW_COLUMNS = (
    "perf, ci_low, ci_high, evidence_grade, n_samples, n_sites, n_studies, peer_reviewed_studies, "
    "validation_type, in_intended_use, intended_use_coverage, intended_use_level, warning_set_id"
)


class ProvenanceIds:
    """Interns sources in ``provenance_sources`` (shared by all sets)."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.ids = {source: provenance_id for provenance_id, source in provenance_sources(conn).items()}

    def __call__(self, source: RowSource) -> int:
        provenance_id = self.ids.get(source)
        if provenance_id is None:
            provenance_id = self.conn.execute(
                "INSERT INTO provenance_sources (source, study, source_date) VALUES (?, ?, ?)",
                (source.source, source.study, source.date),
            ).lastrowid
            self.ids[source] = provenance_id
        return provenance_id


_PROVENANCE_TABLES = {"metrics": "metric_row_provenance", "prevalence": "prevalence_provenance"}
_KEY_COLUMNS = {"metrics": ("combo_idx", "concept_id"), "prevalence": ("code",)}


def _key(kind: str, key) -> tuple:
    return tuple(key) if row_kind(kind) == "metrics" else (key,)


def _write_sources(conn: sqlite3.Connection, set_id: int, kind: str, keys, sources: dict, default: int | None, ids: ProvenanceIds) -> None:
    """Store a set's default source (the most common one when ``default`` is
    None) and every row whose source differs from it."""
    row_ids = {key: ids(source) for key, source in sources.items()}
    if default is None:
        counts = Counter(row_ids[key] for key in keys if key in row_ids)
        default = counts.most_common(1)[0][0] if counts else SEED_PROVENANCE_ID
    conn.execute("INSERT INTO set_provenance (set_id, provenance_id) VALUES (?, ?)", (set_id, default))
    kind = row_kind(kind)
    columns = ", ".join(_KEY_COLUMNS[kind])
    marks = ", ".join("?" * len(_KEY_COLUMNS[kind]))
    conn.executemany(
        f"INSERT INTO {_PROVENANCE_TABLES[kind]} (set_id, {columns}, provenance_id) VALUES (?, {marks}, ?)",
        [(set_id, *_key(kind, key), row_ids[key]) for key in keys if key in row_ids and row_ids[key] != default],
    )


def _effective_sources(content) -> dict:
    """Every row's source: the one given, else the content's fallback."""
    keys = content.rows if row_kind(content.kind) == "metrics" else content.tiers
    if content.fallback_source is None:
        return dict(content.sources)
    return {key: content.sources.get(key, content.fallback_source) for key in keys}


def insert_content_set(conn: sqlite3.Connection, content: Content, *, source: str, created_at: str, meta: dict | None = None) -> int:
    """Write ``content`` as a new content set (inside the caller's transaction)."""
    target = (content.model_version, content.use_case) if content.kind in ("metrics", "multimorbidity", "local_metrics") else (None, None)
    population_id = content.population_id if content.kind in ("population", "local_metrics") else None
    merge = getattr(content, "merge", None)
    meta = {**(meta or {}), **(merge.as_meta() if merge else {})}
    set_id = conn.execute(
        "INSERT INTO content_sets (kind, model_version, use_case, source, source_sha256, generated_at, meta_json, "
        "created_at, population_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
        (content.kind, *target, source, created_at, json.dumps(meta, sort_keys=True), created_at, population_id),
    ).lastrowid
    if content.kind == "population":
        conn.execute("INSERT INTO population_sets (set_id, name) VALUES (?, ?)", (set_id, content.name))
    if isinstance(content, MergeContent):
        _insert_merge(conn, set_id, content)
    elif content.kind == "models":
        _insert_registry(conn, set_id, content)
    elif content.kind == "safety":
        _insert_incidents(conn, set_id, content.incidents)
    elif content.kind == "studies":
        _insert_studies(conn, set_id, content.studies)
    elif content.kind == "model_cards":
        _insert_model_cards(conn, set_id, content.cards)
    elif content.kind == "effects":
        _insert_effects(conn, set_id, content.effects)
    elif content.kind in ("prevalence", "population"):
        conn.execute(
            "INSERT INTO prevalence_sets (set_id, min_score, max_score) VALUES (?, ?, ?)",
            (set_id, content.min_score, content.max_score),
        )
        conn.executemany(
            "INSERT INTO prevalence_tiers (set_id, code, tier) VALUES (?, ?, ?)",
            [(set_id, code, tier) for code, tier in content.tiers.items()],
        )
        _write_sources(conn, set_id, "prevalence", list(content.tiers), _effective_sources(content), None, ProvenanceIds(conn))
    else:
        warning_set_id = WarningSetIds(conn)
        conn.executemany(
            "INSERT INTO set_combos (set_id, position, combo_idx) VALUES (?, ?, ?)",
            [(set_id, position, combo_idx) for position, combo_idx in enumerate(content.combos)],
        )
        if row_kind(content.kind) == "metrics":
            keys = sorted(content.rows)
            conn.executemany(
                f"INSERT INTO metric_rows (set_id, combo_idx, concept_id, {_ROW_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (set_id, combo_idx, concept_id, *content.rows[(combo_idx, concept_id)][:12],
                     warning_set_id(content.rows[(combo_idx, concept_id)][12]))
                    for combo_idx, concept_id in keys
                ),
            )
            _write_sources(conn, set_id, "metrics", keys, _effective_sources(content), None, ProvenanceIds(conn))
        else:
            _insert_multimorbidity(conn, set_id, content, warning_set_id)
    return set_id


def _insert_merge(conn: sqlite3.Connection, set_id: int, merge: MergeContent) -> None:
    """The base set's rows (copied in SQL) with the merge applied."""
    base = merge.base_set_id
    kind = row_kind(merge.kind)
    table = "metric_rows" if kind == "metrics" else "prevalence_tiers"
    provenance = _PROVENANCE_TABLES[kind]
    key_columns = _KEY_COLUMNS[kind]
    match = " AND ".join(f"{column} = ?" for column in key_columns)
    if kind == "metrics":
        combos = [combo for (combo,) in conn.execute(
            "SELECT combo_idx FROM set_combos WHERE set_id = ? ORDER BY position", (base,)
        )] if base is not None else []
        combos += [combo for combo in merge.new_combos if combo not in combos]
        conn.executemany(
            "INSERT INTO set_combos (set_id, position, combo_idx) VALUES (?, ?, ?)",
            [(set_id, position, combo_idx) for position, combo_idx in enumerate(combos)],
        )
        value_columns = f"combo_idx, concept_id, {_ROW_COLUMNS}"
    else:
        bounds = conn.execute("SELECT min_score, max_score FROM prevalence_sets WHERE set_id = ?", (base,)).fetchone() if base is not None else None
        conn.execute(
            "INSERT INTO prevalence_sets (set_id, min_score, max_score) VALUES (?, ?, ?)",
            (set_id, *(bounds or merge.bounds)),
        )
        value_columns = "code, tier"
    if base is not None:
        conn.execute(f"INSERT INTO {table} (set_id, {value_columns}) SELECT ?, {value_columns} FROM {table} WHERE set_id = ?", (set_id, base))
        columns = ", ".join(key_columns)
        conn.execute(
            f"INSERT INTO {provenance} (set_id, {columns}, provenance_id) SELECT ?, {columns}, provenance_id FROM {provenance} WHERE set_id = ?",
            (set_id, base),
        )
    touched = [_key(kind, key) for key in (*merge.removals, *merge.upserts)]
    conn.executemany(f"DELETE FROM {provenance} WHERE set_id = ? AND {match}", [(set_id, *key) for key in touched])
    conn.executemany(f"DELETE FROM {table} WHERE set_id = ? AND {match}", [(set_id, *key) for key in touched])
    if kind == "metrics":
        warning_set_id = WarningSetIds(conn)
        conn.executemany(
            f"INSERT INTO metric_rows (set_id, combo_idx, concept_id, {_ROW_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(set_id, *key, *values[:12], warning_set_id(values[12])) for key, values in merge.upserts.items()],
        )
    else:
        conn.executemany(
            "INSERT INTO prevalence_tiers (set_id, code, tier) VALUES (?, ?, ?)",
            [(set_id, code, tier) for code, tier in merge.upserts.items()],
        )
    default = default_provenance_id(conn, base) if base is not None else None
    _write_sources(conn, set_id, kind, list(merge.upserts), merge.sources, default, ProvenanceIds(conn))


def _insert_incidents(conn: sqlite3.Connection, set_id: int, incidents: list[IncidentRecord]) -> None:
    marks = ", ".join("?" * (len(INCIDENT_COLUMNS.split(",")) + 2))
    conn.executemany(
        f"INSERT INTO safety_incidents (set_id, position, {INCIDENT_COLUMNS}) VALUES ({marks})",
        [
            (
                set_id, position, incident.incident_id, incident.model_version, incident.use_case, incident.chapter_id,
                incident.age, incident.sex, incident.ethnicity, incident.incident_type, incident.harm, incident.status,
                incident.source_type, incident.source_reference, incident.study_id, incident.reported_date,
                incident.updated_date, incident.summary, incident.scope,
            )
            for position, incident in enumerate(incidents)
        ],
    )
    conn.executemany(
        "INSERT INTO safety_incident_conditions (set_id, incident_id, member_index, code, concept_id) VALUES (?, ?, ?, ?, ?)",
        [
            (set_id, incident.incident_id, index, code, concept_id)
            for incident in incidents
            for index, (code, concept_id) in enumerate(zip(incident.codes, incident.condition_ids))
        ],
    )


def _insert_studies(conn: sqlite3.Connection, set_id: int, studies: list[StudyRecord]) -> None:
    marks = ", ".join("?" * (len(STUDY_COLUMNS.split(",")) + 2))
    conn.executemany(
        f"INSERT INTO studies (set_id, position, {STUDY_COLUMNS}) VALUES ({marks})",
        [
            (
                set_id, position, study.study_id, study.title, study.design, study.setting, study.sites, study.patients,
                int(study.peer_reviewed), study.conducted_by, study.reporting_guideline, study.guideline_followed,
                study.risk_of_bias, study.risk_of_bias_notes, study.population, study.evaluation_conditions,
                study.model_version, study.publication_date, study.source_url, study.scope, study.population_id,
                study.applicability, study.applicability_notes, study.quality_tool, study.quality_score,
                study.setting_category, study.configuration_id,
            )
            for position, study in enumerate(studies)
        ],
    )


def _insert_effects(conn: sqlite3.Connection, set_id: int, effects: list[EffectRecord]) -> None:
    marks = ", ".join("?" * (len(EFFECT_COLUMNS.split(",")) + 2))
    conn.executemany(
        f"INSERT INTO effects (set_id, position, {EFFECT_COLUMNS}) VALUES ({marks})",
        [
            (
                set_id, position, effect.effect_id, effect.study_id, effect.model_version, effect.use_case,
                json.dumps(list(effect.codes)), json.dumps(list(effect.condition_ids)), effect.chapter_id, effect.outcome,
                effect.outcome_type, effect.population, effect.comparator, effect.effect_measure, effect.estimate,
                effect.ci_low, effect.ci_high, effect.unit, effect.direction, effect.follow_up, effect.appraisal_tool,
                effect.judgement, effect.notes,
            )
            for position, effect in enumerate(effects)
        ],
    )


def _insert_model_cards(conn: sqlite3.Connection, set_id: int, cards: list[ModelCardRecord]) -> None:
    conn.executemany(
        "INSERT INTO model_cards (set_id, model_version, position, source_format, card_json, markdown, submitted_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (set_id, card.model_version, position, card.source_format, json.dumps(card.card, sort_keys=True), card.markdown, card.submitted_at)
            for position, card in enumerate(cards)
        ],
    )


def _insert_registry(conn: sqlite3.Connection, set_id: int, content: RegistryContent) -> None:
    conn.execute(
        "INSERT INTO registry_sets (set_id, default_model_version) VALUES (?, ?)", (set_id, content.default_model_version)
    )
    for position, model in enumerate(content.models):
        conn.execute(
            "INSERT INTO models (set_id, model_version, position, model_name, model_release, display_name, status, "
            f"default_use_case, effects_json, capabilities_json, {_ENTRY_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                set_id,
                model.model_version,
                position,
                model.model_name,
                model.model_release,
                model.display_name,
                model.status,
                model.default_use_case,
                None if model.effects is None else json.dumps(model.effects),
                None if model.capabilities is None else json.dumps(model.capabilities),
                model.kind,
                model.ai_type,
                model.developer,
                model.release_date,
                model.description,
                json.dumps(list(model.built_on)) if model.built_on else None,
                model.replaces,
            ),
        )
        conn.executemany(
            f"INSERT INTO use_case_variants (set_id, model_version, use_case, position, {_CONFIGURATION_COLUMNS}) "
            f"VALUES ({_CONFIGURATION_MARKS})",
            [
                (set_id, model.model_version, use_case, index, *model.configuration(use_case).values())
                for index, use_case in enumerate(model.use_cases)
            ],
        )


def _insert_multimorbidity(conn: sqlite3.Connection, set_id: int, content: MultimorbidityContent, warning_set_id) -> None:
    for position, combination in enumerate(content.combinations):
        conn.execute(
            "INSERT INTO mm_combinations (set_id, position, combination_key, label) VALUES (?, ?, ?, ?)",
            (set_id, position, combination.key, combination.label),
        )
        conn.executemany(
            "INSERT INTO mm_combination_conditions (set_id, position, member_index, concept_id) VALUES (?, ?, ?, ?)",
            [(set_id, position, index, concept_id) for index, concept_id in enumerate(combination.condition_ids)],
        )
        conn.executemany(
            f"INSERT INTO mm_rows (set_id, position, combo_idx, {_ROW_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (set_id, position, combo_idx, *values[:12], warning_set_id(values[12]))
                for combo_idx, values in sorted(combination.rows.items())
            ],
        )


_SET_TABLES = (
    "metric_row_provenance", "metric_rows", "set_combos", "mm_rows", "mm_combination_conditions", "mm_combinations",
    "prevalence_provenance", "prevalence_tiers", "prevalence_sets", "use_case_variants", "models", "registry_sets",
    "safety_incident_conditions", "safety_incidents", "set_provenance", "population_sets", "studies", "model_cards",
    "effects",
)


def delete_content_set(conn: sqlite3.Connection, set_id: int) -> None:
    """Remove a set no version lists (a discarded or superseded upload's)."""
    listed = conn.execute("SELECT 1 FROM version_content_sets WHERE set_id = ? LIMIT 1", (set_id,)).fetchone()
    if listed:
        raise RuntimeError(f"Content set {set_id} belongs to a published version and is never deleted.")
    for table in _SET_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE set_id = ?", (set_id,))
    conn.execute("DELETE FROM content_sets WHERE set_id = ?", (set_id,))
