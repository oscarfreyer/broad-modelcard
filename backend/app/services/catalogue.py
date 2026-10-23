"""The catalogue: one tile per configuration (openapi.json ``Catalogue``, CONTRACT.md §17).

A tile summarizes one card (registry entry × use case) at the all-population
lens: its registry fields, the status distribution of the 2,400 depth-1
conditions for each view, a per-chapter overall distribution, the snapshot
(contract v1.11: each subchapter's Overview status and safety mark, aligned
with the body's ``snapshot_blocks``), its safety incident counts (contract
v1.7, over every lens), and the last dataset version that changed the
configuration.

The statuses are exactly those ``/metrics/map`` and ``/metrics/summary`` serve
at that lens (CONTRACT.md §4.5); a condition without a row is ``no_data`` in
every view.
"""

from __future__ import annotations

from collections.abc import Callable

from .. import repository
from ..repository import DatasetState, IncidentRecord, ModelRecord, RegistryRecord, StudyRecord, UseCaseRecord, VersionRecord
from ..schema.contract import STATUSES, SYNTHETIC_DATA_NOTICE
from .catalog import Catalog
from .dataset import Dataset
from .errors import UnknownUseCase
from .lru import LruCache
from .metrics import MetricsService
from .presentation import configuration_fields, declarations, default_use_case, entry_fields, rollup_child_count, statuses
from .types import ALL_POPULATIONS

TILE_LENS = ALL_POPULATIONS

# The statuses each view can produce (CONTRACT.md §4.5), in contract order.
DISTRIBUTION_KEYS: dict[str, tuple[str, ...]] = {
    "overall": STATUSES,
    "performance": ("strong", "moderate", "weak", "no_data"),
    "evidence": ("strong", "moderate", "weak", "no_data"),  # not_validated merged into no_data (v1.11, D5)
    "intended_use": ("in_scope", "partially_in_scope", "out_of_scope", "no_data"),
}

Key = tuple[str, str]  # (model_version, use_case)


# ------------------------------------------------------------ distributions

def distributions(catalog: Catalog, metrics: MetricsService | None) -> tuple[dict, list[dict], list[str]]:
    """Status counts per view over the depth-1 conditions, per chapter
    (overall), and each subchapter's Overview status (the snapshot).

    ``metrics`` None means the configuration has no metrics set: every
    condition is ``no_data``. Chapters are all chapters in chapter order,
    including those without conditions. A condition without an intended-use
    value counts as ``no_data`` for intended use (contract v1.11); a card
    without an intended-use statement has no intended-use distribution (None).
    The snapshot lists the blocks in atlas order with the overall status the
    atlas map serves for each, except that a rollup without children reads
    ``no_data``, as clients present it (CONTRACT.md §6, V1).
    """
    counts = {view: dict.fromkeys(keys, 0) for view, keys in DISTRIBUTION_KEYS.items()}
    chapters = {
        chapter.concept_id: {
            "chapter_id": chapter.concept_id,
            "chapter_no": chapter.chapter_no,
            "condition_count": 0,
            "overall": dict.fromkeys(STATUSES, 0),
        }
        for chapter in catalog.chapters
    }
    overall, performance, evidence, intended_use = (
        counts["overall"], counts["performance"], counts["evidence"], counts["intended_use"]
    )
    for condition in catalog.conditions:
        row = metrics.row(condition.concept_id, TILE_LENS) if metrics is not None else None
        shown = statuses(row)
        overall[shown["overall"]] += 1
        performance[shown["performance"]] += 1
        evidence[shown["evidence"]] += 1
        intended_use[(row.intended_use_level if row is not None else None) or "no_data"] += 1
        chapter = chapters.get(condition.chapter_id)
        if chapter is not None:
            chapter["condition_count"] += 1
            chapter["overall"][shown["overall"]] += 1
    if metrics is not None and not metrics.intended_use_defined:
        counts["intended_use"] = None
    snapshot = [_block_overview(metrics, block) for block in catalog.blocks]
    return counts, list(chapters.values()), snapshot


def _block_overview(metrics: MetricsService | None, block) -> str:
    row = metrics.row(block.concept_id, TILE_LENS) if metrics is not None else None
    if row is None or rollup_child_count(row) == 0:
        return "no_data"
    return statuses(row)["overall"]


# ------------------------------------------------------------- last update

def configuration_signature(registry: RegistryRecord, model: ModelRecord, variant: UseCaseRecord) -> tuple:
    """Everything the registry says about one configuration.

    The same fields as the registry change summary (CONTRACT.md §11.1): the
    entry's fields, whether this is the entry's default use case and the
    registry's default entry, and the configuration's own fields (since
    contract v1.11 also its intended-use statement, since v1.14 the entry's
    ``replaces`` and the card's configuration record, measure, and
    data-protection declarations). ``replaced_by`` is derived from other
    entries and is not part of it.
    """
    return (
        model.display_name,
        model.model_name,
        model.model_release,
        model.status,
        default_use_case(model) == variant.use_case,
        registry.default_model_version == model.model_version,
        model.kind,
        model.ai_type,
        model.developer,
        model.release_date,
        model.description,
        model.built_on,
        variant.function_category,
        tuple(sorted((declarations(variant) or {}).items())),
        variant.intended_use_defined,  # contract v1.11
        # Contract v1.14 (§28): the entry's lineage and the card's configuration
        # record and measure (the data-protection declarations are in declarations).
        model.replaces,
        repr(sorted(configuration_fields(variant).items())),
    )


class Fingerprints:
    """What defines each configuration in a state: its metrics set, its
    multimorbidity set, its registry signature, its safety incidents
    (contract v1.7), and the study records its stored rows link (2026-10-21,
    §17; None or empty when absent)."""

    def __init__(
        self,
        registry: Callable[[int], RegistryRecord],
        incidents: Callable[[int | None], list[IncidentRecord]] = lambda set_id: [],
        studies: Callable[[int | None], list[StudyRecord]] = lambda set_id: [],
        named_studies: Callable[[int], frozenset[str]] = lambda set_id: frozenset(),
    ):
        self._registry = registry
        self._incidents = incidents
        self._studies = studies
        self._named_studies = named_studies
        self._signatures: dict[int, dict[Key, tuple]] = {}
        self._safety: dict[int | None, dict[Key, tuple]] = {}
        self._study_records: dict[int | None, dict[str, StudyRecord]] = {}
        self._named: dict[int, frozenset[str]] = {}

    def _records(self, set_id: int | None) -> dict[str, StudyRecord]:
        records = self._study_records.get(set_id)
        if records is None:
            records = self._study_records[set_id] = {study.study_id: study for study in self._studies(set_id)} if set_id else {}
        return records

    def _linked(self, records: dict[str, StudyRecord], metric_set: int | None) -> tuple:
        """The study records a metrics set's rows link, by study id (contract §22's link)."""
        if not records or metric_set is None:
            return ()
        named = self._named.get(metric_set)
        if named is None:
            named = self._named[metric_set] = self._named_studies(metric_set)
        return tuple((study_id, records[study_id]) for study_id in sorted(named) if study_id in records)

    def _safety_signatures(self, set_id: int | None) -> dict[Key, tuple]:
        signatures = self._safety.get(set_id)
        if signatures is None:
            grouped: dict[Key, list[IncidentRecord]] = {}
            for incident in self._incidents(set_id):
                grouped.setdefault(incident.key, []).append(incident)
            signatures = self._safety[set_id] = {key: tuple(found) for key, found in grouped.items()}
        return signatures

    def _registry_signatures(self, set_id: int) -> dict[Key, tuple]:
        signatures = self._signatures.get(set_id)
        if signatures is None:
            registry = self._registry(set_id)
            signatures = self._signatures[set_id] = {
                (model.model_version, variant.use_case): configuration_signature(registry, model, variant)
                for model in registry.models
                for variant in model.use_cases
            }
        return signatures

    def of(self, state: DatasetState) -> dict[Key, tuple]:
        signatures = self._registry_signatures(state.registry_set_id)
        safety = self._safety_signatures(state.safety_set_id)
        records = self._records(state.studies_set_id)
        keys = {*signatures, *state.metric_sets, *state.multimorbidity_sets, *safety}
        return {
            key: (
                state.metric_sets.get(key),
                state.multimorbidity_sets.get(key),
                signatures.get(key),
                safety.get(key, ()),
                self._linked(records, state.metric_sets.get(key)),
            )
            for key in keys
        }


def store_fingerprints(conn: Callable[[], object]) -> Fingerprints:
    """``Fingerprints`` read from the store connection ``conn()`` gives."""
    return Fingerprints(
        lambda set_id: repository.load_registry(conn(), set_id),
        lambda set_id: repository.load_incidents(conn(), set_id),
        lambda set_id: repository.load_studies(conn(), set_id),
        lambda set_id: repository.named_studies(conn(), set_id),
    )


def last_updates(history: list[VersionRecord], fingerprints: Fingerprints) -> dict[Key, VersionRecord]:
    """For each configuration, the newest version in ``history`` that changed it.

    A version changes a configuration when the configuration's metrics set,
    multimorbidity set, registry signature, safety incidents, or linked study
    records (a study its stored rows name was added, changed, or removed)
    differ from the previous version's (a configuration that appears counts
    as changed). The first version (the initial import) changes every
    configuration it holds.
    """
    updated: dict[Key, VersionRecord] = {}
    for key, records in card_changes(history, fingerprints).items():
        updated[key] = records[-1]
    return updated


def card_changes(history: list[VersionRecord], fingerprints: Fingerprints) -> dict[Key, list[VersionRecord]]:
    """For each configuration, every version in ``history`` that changed it, oldest first, by the
    rule of ``last_updates`` (CONTRACT.md §17). The version feed's ``card`` filter (contract v1.14,
    §26.6) serves them; the newest is the configuration's ``last_updated``."""
    changes: dict[Key, list[VersionRecord]] = {}
    previous: dict[Key, tuple] = {}
    for record in history:
        current = fingerprints.of(record.state)
        for key, fingerprint in current.items():
            if previous.get(key) != fingerprint:
                changes.setdefault(key, []).append(record)
        previous = current
    return changes


class HistoryCache:
    """``last_updates`` over the version history, kept from one build to the next.

    Versions are only ever added and a published content set never changes, so
    a build reads only the versions published since the previous build and
    loads only the registry and safety sets those versions bring; the
    fingerprints of earlier sets stay cached. Built for the live versions the
    API serves, which only grow; a build for an older version is computed
    apart (with the shared set cache). Staged sets are never cached here:
    their ids can be reused after a discard. Not thread-safe: the API calls it
    under ``Store.lock``.
    """

    def __init__(self) -> None:
        self._conn = None
        self.fingerprints = store_fingerprints(lambda: self._conn)
        self._up_to = 0
        self._updated: dict[Key, VersionRecord] = {}
        # Every version that changed each configuration, oldest first (the version feed's card filter).
        self._changes: dict[Key, list[int]] = {}
        self._previous: dict[Key, tuple] = {}
        self._latest: VersionRecord | None = None
        self.versions_read = 0  # versions loaded from the store so far (tests, measurements)

    def updates(self, conn, up_to: int) -> tuple[dict[Key, VersionRecord], VersionRecord]:
        """The newest version up to ``up_to`` that changed each configuration, and version ``up_to``."""
        self._conn = conn
        if up_to < self._up_to:
            history = repository.load_history(conn, up_to)
            self.versions_read += len(history)
            return last_updates(history, self.fingerprints), history[-1]
        self._extend(conn, up_to)
        return dict(self._updated), self._latest

    def changed_versions(self, conn, up_to: int, key: Key) -> list[int]:
        """Every version up to ``up_to`` that changed the configuration ``key`` (CONTRACT.md §17's
        rule), newest first; empty for a configuration no version holds (contract v1.14, §26.6)."""
        self._conn = conn
        if up_to < self._up_to:
            history = repository.load_history(conn, up_to)
            self.versions_read += len(history)
            found = [record.version_id for record in card_changes(history, self.fingerprints).get(key, [])]
        else:
            self._extend(conn, up_to)
            found = list(self._changes.get(key, []))
        return found[::-1]

    def _extend(self, conn, up_to: int) -> None:
        if up_to <= self._up_to:
            return
        records = repository.load_history(conn, up_to, after=self._up_to)
        self.versions_read += len(records)
        for record in records:
            current = self.fingerprints.of(record.state)
            for key, fingerprint in current.items():
                if self._previous.get(key) != fingerprint:
                    self._updated[key] = record
                    self._changes.setdefault(key, []).append(record.version_id)
            self._previous = current
            self._latest = record
        self._up_to = up_to


# ---------------------------------------------------------------- catalogue

class DistributionCache(LruCache[tuple]):
    """Tile distributions keyed by the content they derive from.

    A configuration's statuses depend only on its metrics set, the prevalence
    set (the evidence penalty), its use case (the chapter-06 quirk), and
    whether it has an intended-use statement (contract v1.11); content sets
    never change. So after a publish only the configurations
    whose sets changed are derived again (about 20 ms each on the seed), not
    all of them. Least recently used entries go first. Not thread-safe: the
    API calls it under ``Store.lock``.
    """

    def __init__(self, max_entries: int = 128):
        super().__init__(max_entries)


def _metrics(dataset: Dataset, key: Key) -> MetricsService | None:
    try:
        return dataset.scan_metrics(*key)
    except UnknownUseCase:
        return None


def build_catalogue(
    dataset: Dataset,
    catalog: Catalog,
    *,
    label: str,
    staged: bool = False,
    cache: DistributionCache | None = None,
    history: HistoryCache | None = None,
) -> dict:
    """The ``Catalogue`` body for one dataset version (or staged read).

    A staged read's ``last_updated`` covers published versions only (up to
    the live version it is based on); ``staged_change`` marks the
    configurations the staged upload changes. Distributions come from
    ``cache`` and the version history from ``history`` when given (shared
    across versions; the bodies are read-only).
    """
    cache = cache if cache is not None else DistributionCache()
    history = history if history is not None else HistoryCache()
    conn = dataset.connection
    updated, latest = history.updates(conn, dataset.version_id)
    published = history.fingerprints.of(latest.state)
    if staged:
        # A fresh cache: a staged set's id can be reused once it is discarded.
        served = store_fingerprints(lambda: conn).of(dataset.state)
    else:
        served = published

    source_by_set: dict[int | None, str | None] = {}

    def sources(set_id: int | None) -> str | None:
        if set_id not in source_by_set:
            row = conn.execute("SELECT source FROM content_sets WHERE set_id = ?", (set_id,)).fetchone() if set_id else None
            source_by_set[set_id] = row[0] if row else None
        return source_by_set[set_id]

    tiles = []
    registry = dataset.registry
    for model in registry.models:
        system = {
            "display_name": model.display_name,
            "model_name": model.model_name,
            "model_release": model.model_release,
            "status": model.status or "ACTIVE",
            **entry_fields(model),
        }
        default = default_use_case(model)
        for variant in model.use_cases:
            key = (model.model_version, variant.use_case)
            metric_set = dataset.state.metric_sets.get(key)
            # Set ids of discarded staged sets are reused (INTEGER PRIMARY KEY), so the
            # key also carries each set's source, which names its upload and never repeats.
            content = (
                metric_set,
                sources(metric_set),
                dataset.state.prevalence_set_id,
                sources(dataset.state.prevalence_set_id),
                *key,
                dataset.intended_use_defined(*key),
            )
            if dataset.population is not None:
                # A local population's tiers (contract v1.10) change the distributions too.
                content += (dataset.population.set_id, sources(dataset.population.set_id))
                local_set = dataset.local_set_id(*key)
                if local_set is not None:
                    # Local results (contract v1.13, §26) replace public rows for the population;
                    # their study links follow the studies set.
                    content += ("local", local_set, sources(local_set), dataset.state.studies_set_id, sources(dataset.state.studies_set_id))
            if metric_set is not None and dataset.studies.for_set(metric_set) is not None:
                # Study records (contract v1.13) change the grades of the rows that link to them.
                content += ("studies", dataset.state.studies_set_id, sources(dataset.state.studies_set_id))
            distribution, chapters, overview = cache.get(content, lambda: distributions(catalog, _metrics(dataset, key)))
            card_safety = dataset.safety.card(*key)
            record = updated.get(key) or latest
            tiles.append(
                {
                    "card_id": f"{model.model_version}|{variant.use_case}",
                    "model_version": model.model_version,
                    "use_case": variant.use_case,
                    "system": system,
                    "function_category": variant.function_category,
                    "declarations": declarations(variant),
                    "intended_use_defined": variant.intended_use_defined,
                    **configuration_fields(variant),  # contract v1.14 (§28.1), only when given
                    "has_multimorbidity": dataset.has_multimorbidity(*key),
                    "is_default_use_case": variant.use_case == default,
                    "distribution": distribution,
                    "chapters": chapters,
                    "snapshot": {
                        "overview": overview,
                        "safety": [card_safety.mark(block, TILE_LENS) for block in catalog.blocks],
                    },
                    "safety": card_safety.counts(),
                    "last_updated": {"version": record.version_id, "at": record.created_at},
                    "staged_change": staged and served.get(key) != published.get(key),
                }
            )
    return {
        "dataset_version": label,
        "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
        "lens": {"context": dataset.atlas.axes.context[0], **TILE_LENS.as_dict()},
        "condition_count": len(catalog.conditions),
        # The subchapters every tile snapshot is aligned with, in atlas order (v1.11).
        "snapshot_blocks": [{"id": block.concept_id, "chapter": block.chapter_id} for block in catalog.blocks],
        "tiles": tiles,
    }
