"""Read-side data access: SQL lives here, derivations live in app.services."""

from __future__ import annotations

import json
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass, field

from .services.types import Axes

# Stored tuple columns in METRIC_ROW_FORMAT order; warning_set_id is resolved
# to the warning codes.
TUPLE_COLUMNS = (
    "perf, ci_low, ci_high, evidence_grade, n_samples, n_sites, n_studies, peer_reviewed_studies, "
    "validation_type, in_intended_use, intended_use_coverage, intended_use_level, warning_set_id"
)


class MissingData(LookupError):
    """The store lacks data the caller asked for (e.g. no dataset version)."""


# ----------------------------------------------------------------- versions

@dataclass(frozen=True)
class DatasetState:
    """The content sets that make up one dataset version."""

    version_id: int
    registry_set_id: int
    prevalence_set_id: int
    metric_sets: dict[tuple[str, str], int] = field(default_factory=dict)
    multimorbidity_sets: dict[tuple[str, str], int] = field(default_factory=dict)
    # The safety incidents (contract v1.7); None before the first safety publish.
    safety_set_id: int | None = None
    # Local populations (contract v1.10): population id → its set.
    population_sets: dict[str, int] = field(default_factory=dict)
    # The study records (contract v1.13); None before the first studies publish.
    studies_set_id: int | None = None
    # Local evaluation results (contract v1.13, §26): (model_version, use_case,
    # population_id) → its set.
    local_metric_sets: dict[tuple[str, str, str], int] = field(default_factory=dict)
    # The narrow model cards (contract v1.13, §26); None before the first publish.
    model_cards_set_id: int | None = None
    # The intervention effects (contract v1.13, §27); None before the first effects publish.
    effects_set_id: int | None = None


def live_version_id(conn: sqlite3.Connection) -> int:
    version = conn.execute("SELECT MAX(version_id) FROM dataset_versions").fetchone()[0]
    if version is None:
        raise MissingData("The store has no dataset version. Run the import first.")
    return version


_STATE_ROWS = (
    "SELECT vcs.version_id, cs.set_id, cs.kind, cs.model_version, cs.use_case, cs.population_id "
    "FROM version_content_sets vcs JOIN content_sets cs USING (set_id)"
)


def _state(version_id: int, rows) -> DatasetState:
    """A version's state from its ``(set_id, kind, model_version, use_case, population_id)`` rows."""
    if not rows:
        raise MissingData(f"Dataset version {version_id} does not exist.")
    singles: dict[str, int] = {}
    per_variant: dict[str, dict[tuple[str, str], int]] = {"metrics": {}, "multimorbidity": {}}
    populations: dict[str, int] = {}
    local: dict[tuple[str, str, str], int] = {}
    for set_id, kind, model_version, use_case, population_id in rows:
        if kind == "local_metrics":
            key = (model_version, use_case, population_id)
            if key in local:
                raise MissingData(f"Version {version_id} has two local results sets for {key}.")
            local[key] = set_id
        elif kind == "population":
            if population_id in populations:
                raise MissingData(f"Version {version_id} has two sets for population {population_id!r}.")
            populations[population_id] = set_id
        elif kind in per_variant:
            key = (model_version, use_case)
            if key in per_variant[kind]:
                raise MissingData(f"Version {version_id} has two {kind} sets for {key}.")
            per_variant[kind][key] = set_id
        else:
            if kind in singles:
                raise MissingData(f"Version {version_id} has two {kind} sets.")
            singles[kind] = set_id
    for kind in ("models", "prevalence"):
        if kind not in singles:
            raise MissingData(f"Version {version_id} has no {kind} set.")
    return DatasetState(
        version_id=version_id,
        registry_set_id=singles["models"],
        prevalence_set_id=singles["prevalence"],
        metric_sets=per_variant["metrics"],
        multimorbidity_sets=per_variant["multimorbidity"],
        safety_set_id=singles.get("safety"),
        population_sets=populations,
        studies_set_id=singles.get("studies"),
        local_metric_sets=local,
        model_cards_set_id=singles.get("model_cards"),
        effects_set_id=singles.get("effects"),
    )


def load_state(conn: sqlite3.Connection, version_id: int | None = None) -> DatasetState:
    if version_id is None:
        version_id = live_version_id(conn)
    rows = conn.execute(f"{_STATE_ROWS} WHERE vcs.version_id = ? ORDER BY cs.set_id", (version_id,)).fetchall()
    return _state(version_id, [row[1:] for row in rows])


@dataclass(frozen=True)
class VersionRecord:
    version_id: int
    created_at: str
    state: DatasetState


def load_history(conn: sqlite3.Connection, up_to: int, *, after: int = 0) -> list[VersionRecord]:
    """Every version after ``after`` up to and including ``up_to``, oldest first,
    with its state (two queries)."""
    created = dict(
        conn.execute(
            "SELECT version_id, created_at FROM dataset_versions WHERE version_id > ? AND version_id <= ?", (after, up_to)
        )
    )
    rows: dict[int, list[tuple]] = {}
    for version_id, *row in conn.execute(
        f"{_STATE_ROWS} WHERE vcs.version_id > ? AND vcs.version_id <= ? ORDER BY vcs.version_id, cs.set_id", (after, up_to)
    ):
        rows.setdefault(version_id, []).append(tuple(row))
    return [
        VersionRecord(version_id, created[version_id], _state(version_id, rows.get(version_id, [])))
        for version_id in sorted(created)
    ]


# -------------------------------------------------------------------- atlas

def load_axes(conn: sqlite3.Connection) -> Axes:
    values: dict[str, list[str]] = {}
    for axis, value in conn.execute("SELECT axis, value FROM axis_values ORDER BY axis, position"):
        values.setdefault(axis, []).append(value)
    return Axes(
        context=tuple(values.get("context", ())),
        age=tuple(values.get("age_lens", ())),
        sex=tuple(values.get("sex_lens", ())),
        ethnicity=tuple(values.get("ethnicity_lens", ())),
    )


CONCEPT_COLUMNS = (
    "concept_id, parent_id, level, chapter_id, chapter_no, block_id, pt, fsn, icd11_code, sort_order, "
    "depth_in_kind, metric_anchor_id, top_level_position, prevalence_score"
)


def load_concepts(conn: sqlite3.Connection) -> list[tuple]:
    """Concept rows in atlas-base.json order (CONCEPT_COLUMNS)."""
    return conn.execute(f"SELECT {CONCEPT_COLUMNS} FROM concepts ORDER BY concept_key").fetchall()


@dataclass(frozen=True)
class PrevalenceSet:
    tiers: dict[str, str]
    min_score: float
    max_score: float


def load_prevalence(conn: sqlite3.Connection, set_id: int) -> PrevalenceSet:
    bounds = conn.execute("SELECT min_score, max_score FROM prevalence_sets WHERE set_id = ?", (set_id,)).fetchone()
    if bounds is None:
        raise MissingData(f"Prevalence set {set_id} does not exist.")
    tiers = dict(conn.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ?", (set_id,)))
    return PrevalenceSet(tiers=tiers, min_score=bounds[0], max_score=bounds[1])


@dataclass(frozen=True)
class PopulationRecord:
    """A local population set (contract v1.10): its id, display name, and tiers
    by concept id. Aggregate data only."""

    population_id: str
    name: str
    set_id: int
    tiers: dict[str, str]


def load_population(conn: sqlite3.Connection, population_id: str, set_id: int) -> PopulationRecord:
    row = conn.execute("SELECT name FROM population_sets WHERE set_id = ?", (set_id,)).fetchone()
    if row is None:
        raise MissingData(f"Population set {set_id} does not exist.")
    tiers = dict(conn.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ?", (set_id,)))
    return PopulationRecord(population_id, row[0], set_id, tiers)


def population_names(conn: sqlite3.Connection, set_ids) -> dict[int, str]:
    """Display names of population sets."""
    ids = list(set_ids)
    if not ids:
        return {}
    marks = ", ".join("?" * len(ids))
    return dict(conn.execute(f"SELECT set_id, name FROM population_sets WHERE set_id IN ({marks})", ids))


def population_summaries(conn: sqlite3.Connection, state: DatasetState) -> list[dict]:
    """``/meta`` ``populations`` (contract v1.10): each local population of
    ``state`` with its name, the number of codes it lists, and the newest
    version up to ``state.version_id`` that put its current set in place (a
    publish, or a rollback that restored it); null for a staged set."""
    found = []
    for population_id, set_id in sorted(state.population_sets.items()):
        name = conn.execute("SELECT name FROM population_sets WHERE set_id = ?", (set_id,)).fetchone()
        codes = conn.execute("SELECT COUNT(*) FROM prevalence_tiers WHERE set_id = ?", (set_id,)).fetchone()[0]
        updated = conn.execute(
            "SELECT MAX(v.version_id) FROM version_content_sets v WHERE v.set_id = ? AND v.version_id <= ? "
            "AND NOT EXISTS (SELECT 1 FROM version_content_sets p WHERE p.version_id = v.version_id - 1 AND p.set_id = v.set_id)",
            (set_id, state.version_id),
        ).fetchone()[0]
        found.append({"id": population_id, "name": name[0] if name else population_id, "codes": codes, "updated_version": updated})
    return found


def load_atlas_meta(conn: sqlite3.Connection) -> dict:
    """Header fields of atlas-base.json (``meta``, ``generated_at``, ...)."""
    return {key: json.loads(value) for key, value in conn.execute("SELECT key, value_json FROM atlas_meta")}


@dataclass(frozen=True)
class ContentSetInfo:
    set_id: int
    kind: str
    source: str
    generated_at: str | None
    meta: dict


def load_content_set(conn: sqlite3.Connection, set_id: int) -> ContentSetInfo:
    row = conn.execute(
        "SELECT set_id, kind, source, generated_at, meta_json FROM content_sets WHERE set_id = ?", (set_id,)
    ).fetchone()
    if row is None:
        raise MissingData(f"Content set {set_id} does not exist.")
    return ContentSetInfo(row[0], row[1], row[2], row[3], json.loads(row[4]))


# ----------------------------------------------------------------- registry

@dataclass(frozen=True)
class UseCaseRecord:
    use_case: str
    legacy_metrics_file: str | None
    legacy_multimorbidity_metrics_file: str | None
    # Configuration fields (contract v1.5); None when not given.
    function_category: str | None = None
    declared_intended_purpose: str | None = None
    declared_regulatory_status: str | None = None
    declared_contact: str | None = None
    declared_documentation_url: str | None = None
    # Contract v1.11: False when the card has no intended-use statement. The
    # store keeps NULL for a statement (the default) and 0 for none.
    intended_use_defined: bool = True
    # Contract v1.14 (§28.1): the configuration record, what the card's
    # figures measure, and the data-protection declarations; None (tools: an
    # empty tuple) when not given.
    configuration_id: str | None = None
    configuration_date: str | None = None
    prompt_summary: str | None = None
    prompt_sha256: str | None = None
    retrieval: str | None = None
    tools: tuple[str, ...] = ()
    sampling_temperature: float | None = None
    sampling_top_p: float | None = None
    sampling_max_output_tokens: int | None = None
    fine_tuning: str | None = None
    performance_measure: str | None = None
    reference_standard: str | None = None
    declared_data_use: str | None = None
    declared_data_location: str | None = None
    declared_retention: str | None = None
    declared_privacy_contact: str | None = None


# The use_case_variants columns of contract v1.14, in UseCaseRecord field order (tools as tools_json).
_V114_VARIANT_COLUMNS = (
    "configuration_id", "configuration_date", "prompt_summary", "prompt_sha256", "retrieval", "tools_json",
    "sampling_temperature", "sampling_top_p", "sampling_max_output_tokens", "fine_tuning",
    "performance_measure", "reference_standard",
    "declared_data_use", "declared_data_location", "declared_retention", "declared_privacy_contact",
)


@dataclass(frozen=True)
class ModelRecord:
    model_version: str
    model_name: str | None
    model_release: str | None
    display_name: str
    status: str
    default_use_case: str | None
    effects: dict | None
    capabilities: dict | None
    use_cases: tuple[UseCaseRecord, ...]
    # Entry fields (contract v1.5). An entry stored without a kind is a model.
    kind: str = "model"
    ai_type: str | None = None
    developer: str | None = None
    release_date: str | None = None
    description: str | None = None
    built_on: tuple[str, ...] = ()
    # Contract v1.14 (§28.2): the model version this AI system supersedes, and
    # (derived from the other entries of the same registry) those that supersede it.
    replaces: str | None = None
    replaced_by: tuple[str, ...] = ()


@dataclass(frozen=True)
class RegistryRecord:
    default_model_version: str | None
    models: tuple[ModelRecord, ...]


def load_registry(conn: sqlite3.Connection, set_id: int) -> RegistryRecord:
    header = conn.execute("SELECT default_model_version FROM registry_sets WHERE set_id = ?", (set_id,)).fetchone()
    if header is None:
        raise MissingData(f"Registry set {set_id} does not exist.")
    variants: dict[str, list[UseCaseRecord]] = {}
    v114 = ", ".join(_V114_VARIANT_COLUMNS)
    for row in conn.execute(
        "SELECT model_version, use_case, legacy_metrics_file, legacy_multimorbidity_metrics_file, function_category, "
        "declared_intended_purpose, declared_regulatory_status, declared_contact, declared_documentation_url, "
        f"intended_use_defined, {v114} FROM use_case_variants WHERE set_id = ? ORDER BY model_version, position",
        (set_id,),
    ):
        record = dict(zip(_V114_VARIANT_COLUMNS, row[10:], strict=True))
        tools_json = record.pop("tools_json")
        variants.setdefault(row[0], []).append(
            UseCaseRecord(
                *row[1:9],
                intended_use_defined=row[9] != 0,
                tools=tuple(json.loads(tools_json)) if tools_json is not None else (),
                **record,
            )
        )
    entries = conn.execute(
        "SELECT model_version, model_name, model_release, display_name, status, default_use_case, "
        "effects_json, capabilities_json, kind, ai_type, developer, release_date, description, built_on_json, replaces "
        "FROM models WHERE set_id = ? ORDER BY position",
        (set_id,),
    ).fetchall()
    # Contract v1.14 (§28.2): replaced_by, in registry order.
    replaced_by: dict[str, list[str]] = {}
    for row in entries:
        if row[14] is not None:
            replaced_by.setdefault(row[14], []).append(row[0])
    models = tuple(
        ModelRecord(
            model_version=row[0],
            model_name=row[1],
            model_release=row[2],
            display_name=row[3],
            status=row[4],
            default_use_case=row[5],
            effects=json.loads(row[6]) if row[6] is not None else None,
            capabilities=json.loads(row[7]) if row[7] is not None else None,
            use_cases=tuple(variants.get(row[0], ())),
            kind=row[8] or "model",
            ai_type=row[9],
            developer=row[10],
            release_date=row[11],
            description=row[12],
            built_on=tuple(json.loads(row[13])) if row[13] is not None else (),
            replaces=row[14],
            replaced_by=tuple(replaced_by.get(row[0], ())),
        )
        for row in entries
    )
    return RegistryRecord(default_model_version=header[0], models=models)


# ------------------------------------------------------------ metric tuples

class WarningSets:
    """All interned warning lists, loaded once (there are only a few hundred)."""

    def __init__(self, conn: sqlite3.Connection):
        self._codes = {
            warning_set_id: tuple(json.loads(codes_json))
            for warning_set_id, codes_json in conn.execute("SELECT warning_set_id, codes_json FROM warning_sets")
        }

    def codes(self, warning_set_id: int) -> tuple[str, ...]:
        return self._codes[warning_set_id]


def set_combo_indices(conn: sqlite3.Connection, set_id: int) -> tuple[int, ...]:
    """The lens combinations a metrics set defines (its settings follow from them, contract v1.14, §29)."""
    return _combo_order(conn, set_id)


def _combo_order(conn: sqlite3.Connection, set_id: int) -> tuple[int, ...]:
    """Lens combinations a set defines, in source order."""
    return tuple(
        combo_idx
        for (combo_idx,) in conn.execute(
            "SELECT combo_idx FROM set_combos WHERE set_id = ? ORDER BY position", (set_id,)
        )
    )


class MetricSetReader:
    """Single-disease tuples of one metrics set, loaded one lens combination at a time."""

    def __init__(self, conn: sqlite3.Connection, set_id: int, warning_sets: WarningSets, *, cache_size: int = 16):
        self.set_id = set_id
        self.combo_order = _combo_order(conn, set_id)
        self.defined_combos = frozenset(self.combo_order)
        self._conn = conn
        self._warning_sets = warning_sets
        self._cache: OrderedDict[int, dict[str, tuple]] = OrderedDict()
        self._cache_size = cache_size

    def rows_for_combo(self, combo_idx: int) -> dict[str, tuple]:
        cached = self._cache.get(combo_idx)
        if cached is not None:
            self._cache.move_to_end(combo_idx)
            return cached
        codes = self._warning_sets.codes
        rows = {
            row[0]: (*row[1:13], codes(row[13]))
            for row in self._conn.execute(
                f"SELECT concept_id, {TUPLE_COLUMNS} FROM metric_rows WHERE set_id = ? AND combo_idx = ?",
                (self.set_id, combo_idx),
            )
        }
        self._cache[combo_idx] = rows
        if len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
        return rows

    def row(self, concept_id: str, combo_idx: int) -> tuple | None:
        return self.rows_for_combo(combo_idx).get(concept_id)

    def rows_for_concept(self, concept_id: str, combo_indices: list[int]) -> dict[int, tuple]:
        """One concept across several combinations (demographic fallback), in one query."""
        found = {idx: self._cache[idx].get(concept_id) for idx in combo_indices if idx in self._cache}
        missing = [idx for idx in combo_indices if idx not in self._cache]
        if missing:
            codes = self._warning_sets.codes
            placeholders = ", ".join("?" * len(missing))
            for row in self._conn.execute(
                f"SELECT combo_idx, {TUPLE_COLUMNS} FROM metric_rows "
                f"WHERE set_id = ? AND combo_idx IN ({placeholders}) AND concept_id = ?",
                (self.set_id, *missing, concept_id),
            ):
                found[row[0]] = (*row[1:13], codes(row[13]))
        return {idx: found[idx] for idx in combo_indices if found.get(idx) is not None}


@dataclass(frozen=True)
class StoredCombination:
    position: int
    condition_ids: tuple[str, ...]  # as stored, in stored order
    label: str | None


class MultimorbiditySetReader:
    """Combinations and tuples of one multimorbidity set (small; loaded eagerly)."""

    def __init__(self, conn: sqlite3.Connection, set_id: int, warning_sets: WarningSets):
        self.set_id = set_id
        self.defined_combos = frozenset(_combo_order(conn, set_id))
        members: dict[int, list[str]] = {}
        for position, concept_id in conn.execute(
            "SELECT position, concept_id FROM mm_combination_conditions WHERE set_id = ? "
            "ORDER BY position, member_index",
            (set_id,),
        ):
            members.setdefault(position, []).append(concept_id)
        self.combinations = tuple(
            StoredCombination(position, tuple(members.get(position, ())), label)
            for position, label in conn.execute(
                "SELECT position, label FROM mm_combinations WHERE set_id = ? ORDER BY position", (set_id,)
            )
        )
        codes = warning_sets.codes
        self._rows = {
            (row[0], row[1]): (*row[2:14], codes(row[14]))
            for row in conn.execute(
                f"SELECT position, combo_idx, {TUPLE_COLUMNS} FROM mm_rows WHERE set_id = ?", (set_id,)
            )
        }

    def row(self, position: int, combo_idx: int) -> tuple | None:
        return self._rows.get((position, combo_idx))


# --------------------------------------------------------------- provenance

SEED_PROVENANCE_ID = 1  # migrations/0004: the seed's source


@dataclass(frozen=True)
class RowSource:
    """Where a row's values come from (contract v1.7, CONTRACT.md §11.3)."""

    source: str
    study: str | None = None
    date: str | None = None  # ISO YYYY-MM-DD

    def as_dict(self) -> dict:
        return {"source": self.source, "study": self.study, "date": self.date}


def provenance_sources(conn: sqlite3.Connection) -> dict[int, RowSource]:
    return {
        provenance_id: RowSource(source, study, source_date)
        for provenance_id, source, study, source_date in conn.execute(
            "SELECT provenance_id, source, study, source_date FROM provenance_sources"
        )
    }


def default_provenance_id(conn: sqlite3.Connection, set_id: int) -> int:
    """A set's default source; sets without one (the seed import) read as the seed."""
    row = conn.execute("SELECT provenance_id FROM set_provenance WHERE set_id = ?", (set_id,)).fetchone()
    return row[0] if row else SEED_PROVENANCE_ID


def row_source(conn: sqlite3.Connection, table: str, set_id: int, key: tuple) -> RowSource:
    """The source of one row of a metrics (``metric_row_provenance``, key
    ``(combo_idx, concept_id)``) or prevalence set (``prevalence_provenance``,
    key ``(code,)``)."""
    columns = "combo_idx = ? AND concept_id = ?" if table == "metric_row_provenance" else "code = ?"
    explicit = conn.execute(f"SELECT provenance_id FROM {table} WHERE set_id = ? AND {columns}", (set_id, *key)).fetchone()
    provenance_id = explicit[0] if explicit else default_provenance_id(conn, set_id)
    source, study, source_date = conn.execute(
        "SELECT source, study, source_date FROM provenance_sources WHERE provenance_id = ?", (provenance_id,)
    ).fetchone()
    return RowSource(source, study, source_date)


# ------------------------------------------------------------------ safety

@dataclass(frozen=True)
class IncidentRecord:
    """One stored safety incident (contract v1.7). ``codes`` are the ICD-11
    codes as given and ``condition_ids`` their depth-1 anchor conditions, in
    the same order; an incident that covers a whole chapter has ``chapter_id``
    and no codes."""

    incident_id: str
    model_version: str
    use_case: str
    codes: tuple[str, ...]
    condition_ids: tuple[str, ...]
    chapter_id: str | None
    age: str
    sex: str
    ethnicity: str
    incident_type: str
    harm: str
    status: str
    source_type: str
    source_reference: str
    study_id: str | None
    reported_date: str
    updated_date: str | None
    summary: str
    # Contract v1.13 (§26): a public incident, or a hospital's own.
    scope: str = "public"

    @property
    def key(self) -> tuple[str, str]:
        return (self.model_version, self.use_case)

    @property
    def last_date(self) -> str:
        """The newest date the incident carries (updated, else reported)."""
        return self.updated_date or self.reported_date


INCIDENT_COLUMNS = (
    "incident_id, model_version, use_case, chapter_id, age_lens, sex_lens, ethnicity_lens, incident_type, harm, "
    "status, source_type, source_reference, study_id, reported_date, updated_date, summary, scope"
)


def load_incidents(conn: sqlite3.Connection, set_id: int | None) -> list[IncidentRecord]:
    """The incidents of a safety set in stored order (none for ``set_id`` None)."""
    if set_id is None:
        return []
    members: dict[str, list[tuple[str, str]]] = {}
    for incident_id, code, concept_id in conn.execute(
        "SELECT incident_id, code, concept_id FROM safety_incident_conditions WHERE set_id = ? "
        "ORDER BY incident_id, member_index",
        (set_id,),
    ):
        members.setdefault(incident_id, []).append((code, concept_id))
    incidents = []
    for row in conn.execute(f"SELECT {INCIDENT_COLUMNS} FROM safety_incidents WHERE set_id = ? ORDER BY position", (set_id,)):
        pairs = members.get(row[0], [])
        incidents.append(
            IncidentRecord(
                incident_id=row[0],
                model_version=row[1],
                use_case=row[2],
                codes=tuple(code for code, _ in pairs),
                condition_ids=tuple(concept_id for _, concept_id in pairs),
                chapter_id=row[3],
                age=row[4],
                sex=row[5],
                ethnicity=row[6],
                incident_type=row[7],
                harm=row[8],
                status=row[9],
                source_type=row[10],
                source_reference=row[11],
                study_id=row[12],
                reported_date=row[13],
                updated_date=row[14],
                summary=row[15],
                scope=row[16],
            )
        )
    return incidents


# ------------------------------------------------------------------ studies

@dataclass(frozen=True)
class StudyRecord:
    """One stored study record (contract v1.13, CONTRACT.md §22). Synthetic.

    ``guideline_followed`` is None exactly when ``reporting_guideline`` is
    ``none``; ``risk_of_bias_notes``, ``model_version``, and ``source_url`` are
    optional."""

    study_id: str
    title: str
    design: str
    setting: str
    sites: int
    patients: int
    peer_reviewed: bool
    conducted_by: str
    reporting_guideline: str
    guideline_followed: str | None
    risk_of_bias: str
    risk_of_bias_notes: str | None
    population: str
    evaluation_conditions: str
    model_version: str | None
    publication_date: str
    source_url: str | None
    # Contract v1.13 (§26): a public study, or a hospital's evaluation of one
    # of its local populations (``population_id``, None for a public study).
    scope: str = "public"
    population_id: str | None = None
    # Contract v1.14 (§22): optional, never graded. Each is sent only when stored,
    # so a study without them serializes exactly as in v1.13.
    applicability: str | None = None
    applicability_notes: str | None = None
    quality_tool: str | None = None
    quality_score: float | None = None
    setting_category: str | None = None
    configuration_id: str | None = None

    @property
    def served_quality_score(self) -> int | float | None:
        """The appraisal score as served: a whole number without a decimal part (72, not 72.0)."""
        score = self.quality_score
        return int(score) if score is not None and float(score).is_integer() else score

    def as_dict(self) -> dict:
        """openapi.json ``Study``. The v1.14 fields are left out when not stored."""
        optional = {
            "applicability": self.applicability,
            "applicability_notes": self.applicability_notes,
            "quality_tool": self.quality_tool,
            "quality_score": self.served_quality_score,
            "setting_category": self.setting_category,
            "configuration_id": self.configuration_id,
        }
        return {
            "study_id": self.study_id,
            "title": self.title,
            "design": self.design,
            "setting": self.setting,
            "sites": self.sites,
            "patients": self.patients,
            "peer_reviewed": self.peer_reviewed,
            "conducted_by": self.conducted_by,
            "reporting_guideline": self.reporting_guideline,
            "guideline_followed": self.guideline_followed,
            "risk_of_bias": self.risk_of_bias,
            "risk_of_bias_notes": self.risk_of_bias_notes,
            "population": self.population,
            "evaluation_conditions": self.evaluation_conditions,
            "model_version": self.model_version,
            "publication_date": self.publication_date,
            "source_url": self.source_url,
            "scope": self.scope,
            "population_id": self.population_id,
            **{key: value for key, value in optional.items() if value is not None},
        }


STUDY_COLUMNS = (
    "study_id, title, design, setting, sites, patients, peer_reviewed, conducted_by, reporting_guideline, "
    "guideline_followed, risk_of_bias, risk_of_bias_notes, population, evaluation_conditions, model_version, "
    "publication_date, source_url, scope, population_id, applicability, applicability_notes, quality_tool, "
    "quality_score, setting_category, configuration_id"
)


def load_studies(conn: sqlite3.Connection, set_id: int | None) -> list[StudyRecord]:
    """The study records of a studies set in stored order (none for ``set_id`` None)."""
    if set_id is None:
        return []
    return [
        StudyRecord(*row[:6], bool(row[6]), *row[7:])
        for row in conn.execute(f"SELECT {STUDY_COLUMNS} FROM studies WHERE set_id = ? ORDER BY position", (set_id,))
    ]


@dataclass(frozen=True)
class SetStudies:
    """Which rows of one metrics set name a study record (contract v1.13, CONTRACT.md §22).

    A row's study is its row source's study: its own source
    (``metric_row_provenance``) or else the set's default source. ``default``
    is the default source's study id when that names a record, else None.
    ``rows`` maps (combo_idx, concept_id) to the study id of each row whose
    own source decides the link (None: its source names no record although
    the default does)."""

    default: str | None
    rows: dict[tuple[int, str], str | None]

    def study_id(self, combo_idx: int, concept_id: str) -> str | None:
        key = (combo_idx, concept_id)
        return self.rows[key] if key in self.rows else self.default

    @property
    def links_any(self) -> bool:
        return self.default is not None or any(value is not None for value in self.rows.values())


def named_studies(conn: sqlite3.Connection, set_id: int) -> frozenset[str]:
    """The study ids the rows of metrics set ``set_id`` name in their row source's
    Study (their own source, or the set's default), whether or not a study record
    has them. The links of ``set_studies`` are those named ids a studies set holds."""
    studies = dict(conn.execute("SELECT provenance_id, study FROM provenance_sources WHERE study IS NOT NULL"))
    if not studies:
        return frozenset()
    named = {
        studies[provenance_id]
        for (provenance_id,) in conn.execute("SELECT DISTINCT provenance_id FROM metric_row_provenance WHERE set_id = ?", (set_id,))
        if provenance_id in studies
    }
    default = studies.get(default_provenance_id(conn, set_id))
    if default is not None:
        named.add(default)
    return frozenset(named)


def set_studies(conn: sqlite3.Connection, set_id: int, study_ids: frozenset[str]) -> SetStudies | None:
    """The rows of metrics set ``set_id`` linked to one of ``study_ids`` (the row
    source's study equals the id exactly), or None when no row is linked."""
    if not study_ids:
        return None
    linked = {
        provenance_id: study
        for provenance_id, study in conn.execute("SELECT provenance_id, study FROM provenance_sources WHERE study IS NOT NULL")
        if study in study_ids
    }
    if not linked:
        return None
    default = linked.get(default_provenance_id(conn, set_id))
    if default is not None:
        # Every row without its own source is linked; rows with their own source decide for themselves.
        rows = {
            (combo_idx, concept_id): linked.get(provenance_id)
            for combo_idx, concept_id, provenance_id in conn.execute(
                "SELECT combo_idx, concept_id, provenance_id FROM metric_row_provenance WHERE set_id = ?", (set_id,)
            )
        }
    else:
        marks = ", ".join("?" * len(linked))
        rows = {
            (combo_idx, concept_id): linked[provenance_id]
            for combo_idx, concept_id, provenance_id in conn.execute(
                "SELECT combo_idx, concept_id, provenance_id FROM metric_row_provenance "
                f"WHERE set_id = ? AND provenance_id IN ({marks})",
                (set_id, *linked),
            )
        }
    found = SetStudies(default, rows)
    return found if found.links_any else None


# ---------------------------------------------- instance and model cards (§26)

def load_instance(conn: sqlite3.Connection) -> dict:
    """The instance profile (contract v1.13, CONTRACT.md §26): ``kind``,
    ``organisation``, ``maintained_by``, ``contact``, and (contract v1.14,
    only when set) ``data_protection_note``. A store before schema 9 reads as
    the default public demonstration instance."""
    from .schema.contract import DEFAULT_INSTANCE

    try:
        row = conn.execute(
            "SELECT kind, organisation, maintained_by, contact, data_protection_note FROM instance_profile WHERE profile_id = 1"
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    if row is None:
        return dict(DEFAULT_INSTANCE)
    profile = {"kind": row[0], "organisation": row[1], "maintained_by": row[2], "contact": row[3]}
    if row[4] is not None:
        profile["data_protection_note"] = row[4]
    return profile


@dataclass(frozen=True)
class ModelCardRecord:
    """One stored narrow model card (contract v1.13, CONTRACT.md §26): the
    parsed card (``card``, openapi.json ``NarrowModelCard`` fields without the
    model version), how it was submitted, and the Markdown text when it was
    Markdown. Synthetic demonstration content."""

    model_version: str
    source_format: str
    card: dict
    markdown: str | None
    submitted_at: str


def load_model_cards(conn: sqlite3.Connection, set_id: int | None) -> list[ModelCardRecord]:
    """The narrow model cards of a set, in stored order (none for ``set_id`` None)."""
    if set_id is None:
        return []
    return [
        ModelCardRecord(row[0], row[1], json.loads(row[2]), row[3], row[4])
        for row in conn.execute(
            "SELECT model_version, source_format, card_json, markdown, submitted_at FROM model_cards WHERE set_id = ? ORDER BY position",
            (set_id,),
        )
    ]


# ------------------------------------------------------------------ effects

@dataclass(frozen=True)
class EffectRecord:
    """One stored intervention effect (contract v1.13, CONTRACT.md §27). Synthetic.

    ``codes`` are ICD-11 codes as given and ``condition_ids`` their depth-1
    anchor conditions in the same order; an effect on a whole chapter has
    ``chapter_id`` and no codes. Effects never enter a grade."""

    effect_id: str
    study_id: str
    model_version: str
    use_case: str
    codes: tuple[str, ...]
    condition_ids: tuple[str, ...]
    chapter_id: str | None
    outcome: str
    outcome_type: str
    population: str
    comparator: str
    effect_measure: str
    estimate: float
    ci_low: float
    ci_high: float
    unit: str | None
    direction: str
    follow_up: str | None
    appraisal_tool: str
    judgement: str
    notes: str | None

    @property
    def key(self) -> tuple[str, str]:
        return (self.model_version, self.use_case)

    def as_dict(self) -> dict:
        """openapi.json ``Effect`` without ``study``."""
        return {
            "effect_id": self.effect_id,
            "study_id": self.study_id,
            "model_version": self.model_version,
            "use_case": self.use_case,
            "codes": list(self.codes),
            "condition_ids": list(self.condition_ids),
            "chapter_id": self.chapter_id,
            "outcome": self.outcome,
            "outcome_type": self.outcome_type,
            "population": self.population,
            "comparator": self.comparator,
            "effect_measure": self.effect_measure,
            "estimate": self.estimate,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "unit": self.unit,
            "direction": self.direction,
            "follow_up": self.follow_up,
            "appraisal_tool": self.appraisal_tool,
            "judgement": self.judgement,
            "notes": self.notes,
        }


EFFECT_COLUMNS = (
    "effect_id, study_id, model_version, use_case, codes_json, condition_ids_json, chapter_id, outcome, outcome_type, "
    "population, comparator, effect_measure, estimate, ci_low, ci_high, unit, direction, follow_up, appraisal_tool, "
    "judgement, notes"
)


def load_effects(conn: sqlite3.Connection, set_id: int | None) -> list[EffectRecord]:
    """The effects of an effects set in stored order (none for ``set_id`` None)."""
    if set_id is None:
        return []
    return [
        EffectRecord(*row[:4], tuple(json.loads(row[4])), tuple(json.loads(row[5])), *row[6:])
        for row in conn.execute(f"SELECT {EFFECT_COLUMNS} FROM effects WHERE set_id = ? ORDER BY position", (set_id,))
    ]
