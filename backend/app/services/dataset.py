"""Entry point to the derivations for one dataset version."""

from __future__ import annotations

import sqlite3

from .. import repository
from .atlas import Atlas, load_atlas
from .effects import CardEffects, EffectIndex
from .errors import UnknownModel, UnknownUseCase
from .incidents import CardSafety, SafetyIndex
from .lru import LruCache
from .metrics import LocalLayer, MetricsService
from .multimorbidity import MultimorbidityService
from .studies import StudyIndex
from .types import LENS_CACHE_SIZE


class Dataset:
    """Read-side view of one dataset version (the live one by default).

    ``state`` gives the content sets directly instead of a stored version; a
    staged read (Track A3) is the live version with one set swapped.

    Services are created lazily per model/use case and cached, so keep one
    instance per version rather than per request. Metric services are kept for
    the ``metrics_cache_size`` most recently used model/use cases only; the
    small multimorbidity services are kept for all.
    """

    # What a population view shares with the dataset it is made from: the
    # version's inputs, none of which depends on prevalence. Everything else is
    # set by ``_use_prevalence`` (tests enumerate the attributes to keep it so).
    SHARED_ATTRIBUTES = ("_conn", "state", "registry", "_warning_sets", "_metrics_cache_size", "studies")

    def __init__(
        self,
        conn: sqlite3.Connection,
        version_id: int | None = None,
        *,
        state: repository.DatasetState | None = None,
        metrics_cache_size: int = 4,
    ):
        self._conn = conn
        self.state = state if state is not None else repository.load_state(conn, version_id)
        self.registry = repository.load_registry(conn, self.state.registry_set_id)
        self._warning_sets = repository.WarningSets(conn)
        self._metrics_cache_size = metrics_cache_size
        # The study records and the rows that link to them (contract v1.13);
        # they do not depend on prevalence, so a population view shares them.
        self.studies = StudyIndex(conn, self.state.studies_set_id)
        self._use_prevalence(load_atlas(conn, self.state.prevalence_set_id), None)

    def _use_prevalence(self, atlas: Atlas, population: repository.PopulationRecord | None) -> None:
        """Everything derived from the prevalence in use: the atlas (its tiers)
        and every cache built from it, all empty."""
        self.atlas: Atlas = atlas
        # The local population whose tiers this view uses (contract v1.10), or None.
        self.population = population
        self._metrics: LruCache[MetricsService] = LruCache(self._metrics_cache_size)
        # The public rows of cards with local results (contract v1.13), for the condition card.
        self._public_metrics: LruCache[MetricsService] = LruCache(self._metrics_cache_size)
        self._multimorbidity: dict[tuple[str, str], MultimorbidityService] = {}
        self._safety: SafetyIndex | None = None
        self._effects: EffectIndex | None = None

    def with_population(self, population_id: str) -> "Dataset":
        """The same version read for the local population ``population_id``
        (contract v1.10, CONTRACT.md §21): its tiers replace the default tiers
        of the codes it lists, so the evidence penalty (§4.2), rollup weights
        (§6), and concept tiers (§5) follow them through the existing formulas.
        Raises ``KeyError`` when the version has no such population.

        Shares SHARED_ATTRIBUTES only; its atlas and every cache are its own."""
        set_id = self.state.population_sets[population_id]
        population = repository.load_population(self._conn, population_id, set_id)
        view = Dataset.__new__(Dataset)
        for name in self.SHARED_ATTRIBUTES:
            setattr(view, name, getattr(self, name))
        view._use_prevalence(self.atlas.with_tiers(population.tiers), population)
        return view

    @property
    def version_id(self) -> int:
        return self.state.version_id

    @property
    def connection(self) -> sqlite3.Connection:
        return self._conn

    def model(self, model_version: str) -> repository.ModelRecord:
        for model in self.registry.models:
            if model.model_version == model_version:
                return model
        raise UnknownModel(f"Unknown model {model_version!r}.")

    def _variant_key(self, model_version: str, use_case: str) -> tuple[str, str]:
        model = self.model(model_version)
        if use_case not in {variant.use_case for variant in model.use_cases}:
            raise UnknownUseCase(f"Model {model_version!r} has no use case {use_case!r}.")
        key = (model_version, use_case)
        if key not in self.state.metric_sets:
            raise UnknownUseCase(f"No metrics are stored for {model_version!r} / {use_case!r}.")
        return key

    def intended_use_defined(self, model_version: str, use_case: str) -> bool:
        """Whether the card has an intended-use statement (contract v1.11; true
        for a card the registry does not list, e.g. a staged target)."""
        for model in self.registry.models:
            if model.model_version == model_version:
                for variant in model.use_cases:
                    if variant.use_case == use_case:
                        return variant.intended_use_defined
        return True

    def has_multimorbidity(self, model_version: str, use_case: str) -> bool:
        return (model_version, use_case) in self.state.multimorbidity_sets

    def metrics(self, model_version: str, use_case: str) -> MetricsService:
        key = self._variant_key(model_version, use_case)
        return self._metrics.get(key, lambda: self.new_metrics(model_version, use_case))

    def scan_metrics(self, model_version: str, use_case: str) -> MetricsService:
        """Metrics for a one-off pass over many configurations (the catalogue).

        Reuses a cached service but does not add one, so a pass over every
        configuration does not evict the services the atlas is using.
        """
        service = self._metrics.peek(self._variant_key(model_version, use_case))
        return service if service is not None else self.new_metrics(model_version, use_case, lens_cache_size=1)

    def new_metrics(self, model_version: str, use_case: str, *, lens_cache_size: int = LENS_CACHE_SIZE) -> MetricsService:
        """A metrics service outside the shared cache (e.g. for a full export)."""
        key = self._variant_key(model_version, use_case)
        return self.metrics_of_set(key, self.state.metric_sets[key], lens_cache_size=lens_cache_size)

    def local_set_id(self, model_version: str, use_case: str) -> int | None:
        """The local results set of a card for this view's local population
        (contract v1.13, CONTRACT.md §26), or None (the default population, or
        no local results for the card)."""
        if self.population is None:
            return None
        return self.state.local_metric_sets.get((model_version, use_case, self.population.population_id))

    def has_local_results(self, model_version: str, use_case: str) -> bool:
        return self.local_set_id(model_version, use_case) is not None

    def public_metrics(self, model_version: str, use_case: str) -> MetricsService:
        """The card's public rows under this view's prevalence, without local
        results: what the card showed before (the condition card's Public
        result beside a Local one). Equal to ``metrics`` for a card without
        local results."""
        key = self._variant_key(model_version, use_case)
        if self.local_set_id(*key) is None:
            return self.metrics(*key)
        return self._public_metrics.get(key, lambda: self.metrics_of_set(key, self.state.metric_sets[key], local=False))

    def metrics_of_set(
        self,
        target: tuple[str, str],
        set_id: int,
        *,
        lens_cache_size: int = LENS_CACHE_SIZE,
        reader_cache_size: int = 16,
        local: bool = True,
        local_set_id: int | None = None,
    ) -> MetricsService:
        """The metrics service of one card's set, also for a card the registry
        does not list yet (change summaries), with its study links (v1.13).
        For a local population with local results for the card (v1.13, §26)
        the local rows replace the public ones (``local=False`` reads the
        public rows alone; ``local_set_id`` names another local set, e.g. a
        staged one)."""
        reader = repository.MetricSetReader(self._conn, set_id, self._warning_sets, cache_size=reader_cache_size)
        layer = None
        if local and self.population is not None:
            found = local_set_id if local_set_id is not None else self.local_set_id(*target)
            if found is not None:
                layer = LocalLayer(
                    repository.MetricSetReader(self._conn, found, self._warning_sets, cache_size=reader_cache_size),
                    self.population.population_id,
                    self.studies.for_set(found),
                )
        return MetricsService(
            self.atlas,
            reader,
            model_version=target[0],
            use_case=target[1],
            lens_cache_size=lens_cache_size,
            intended_use_defined=self.intended_use_defined(*target),
            studies=self.studies.for_set(set_id),
            local=layer,
        )

    @property
    def safety(self) -> SafetyIndex:
        """The safety incidents of this version (contract v1.7), loaded on first use."""
        if self._safety is None:
            self._safety = SafetyIndex(self.atlas, repository.load_incidents(self._conn, self.state.safety_set_id))
        return self._safety

    def card_safety(self, model_version: str, use_case: str) -> CardSafety:
        """The incidents of one card (404s like ``metrics`` for an unknown card)."""
        self._variant_key(model_version, use_case)
        return self.safety.card(model_version, use_case)

    @property
    def effects(self) -> EffectIndex:
        """The intervention effects of this version (contract v1.13, §27), loaded on first use."""
        if self._effects is None:
            self._effects = EffectIndex(self._conn, self.state.effects_set_id, self.atlas, self.studies.records)
        return self._effects

    def card_effects(self, model_version: str, use_case: str) -> CardEffects:
        """The effects of one card (404s like ``metrics`` for an unknown card)."""
        self._variant_key(model_version, use_case)
        return self.effects.card(model_version, use_case)

    def multimorbidity(self, model_version: str, use_case: str) -> MultimorbidityService:
        key = self._variant_key(model_version, use_case)
        if key not in self._multimorbidity:
            set_id = self.state.multimorbidity_sets.get(key)
            reader = (
                repository.MultimorbiditySetReader(self._conn, set_id, self._warning_sets)
                if set_id is not None
                else None
            )
            self._multimorbidity[key] = MultimorbidityService(
                self.atlas,
                reader,
                model_version=model_version,
                use_case=use_case,
                intended_use_defined=self.intended_use_defined(model_version, use_case),
            )
        return self._multimorbidity[key]
