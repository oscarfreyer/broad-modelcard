"""Access to the SQLite store for the API: dataset versions and cached responses.

``version=live`` reads the highest dataset version. ``version=staged:<id>``
reads the live version with a valid staged upload's content set swapped in
(CONTRACT.md §2); ``AdminService.staged_state`` resolves it and marks the
upload previewed. Live reads never see staged data.

``population=<id>`` (contract v1.10, CONTRACT.md §21) reads that version for
one local population: a separate context whose atlas carries the
population's tiers. Its cache key, and so every response cache key and ETag,
includes the population and its set, so default and local answers never mix.

One read-only connection serves every request. FastAPI runs the handlers in a
thread pool, so all service calls go through ``Store.lock``; the derivation
services keep their own caches and are not thread-safe. Derivations take
milliseconds, so serializing them costs little in a single-user local tool.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from .. import db, repository
from ..repository import MissingData
from ..services.atlas import Atlas
from ..services.catalog import Catalog
from ..services.catalogue import DistributionCache, HistoryCache, build_catalogue
from ..services.dataset import Dataset
from ..services.lru import LruCache
from ..services.ontology import ICD11, OntologyInfo, OntologyTables, Projection, load_infos
from ..publishing.uploads import AdminError, AdminService
from ..services.search import SearchIndex
from ..ontologies.synonyms import load_synonyms
from .problems import ApiError

log = logging.getLogger("broad_modelcard.api")

VERSION_PATTERN = r"^(live|staged:[A-Za-z0-9_-]{1,64})$"
_STAGED = re.compile(r"^staged:([A-Za-z0-9_-]{1,64})$")


@dataclass(eq=False)
class VersionContext:
    """Everything derived from one dataset version, built once and reused.

    A staged context is the live version with one upload's set swapped in.
    """

    dataset: Dataset
    staged_upload_id: str | None = None
    # The staged upload's content set: a check run again writes a new one under the same upload id.
    staged_set_id: int | None = None
    # Builds or returns the search index for an atlas; the Store shares one
    # index across versions (search reads only static concept fields).
    search_index: Callable[[Atlas], SearchIndex] | None = field(default=None, repr=False)
    # Tile distributions shared across versions (content sets never change).
    distributions: DistributionCache | None = field(default=None, repr=False)
    # The version history behind last_updated, extended as versions are published.
    history: HistoryCache | None = field(default=None, repr=False)
    catalog: Catalog = field(init=False)
    # Other ontologies read over this context (contract v1.13), built on first use.
    projections: dict[str, Projection] = field(init=False, default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.catalog = Catalog(self.dataset.atlas)

    def projection(self, tables: OntologyTables) -> Projection:
        """The ontology of ``tables`` over this context (call under ``Store.lock``)."""
        projection = self.projections.get(tables.info.ontology_id)
        if projection is None or projection.tables is not tables:
            projection = self.projections[tables.info.ontology_id] = Projection(tables, self.dataset)
        return projection

    @property
    def version_id(self) -> int:
        """The live version (the base of a staged context)."""
        return self.dataset.version_id

    @property
    def label(self) -> str:
        """``X-Dataset-Version`` and ``dataset_version``: ``<n>`` or ``staged:<upload_id>``."""
        if self.staged_upload_id is not None:
            return f"staged:{self.staged_upload_id}"
        return str(self.dataset.version_id)

    @property
    def population(self):
        """The local population of this context (contract v1.10), or None."""
        return self.dataset.population

    @property
    def cache_key(self) -> tuple:
        """Identifies the content; the response cache is keyed by it."""
        key: tuple = (self.version_id, self.staged_upload_id)
        if self.staged_upload_id is not None:
            key += (self.staged_set_id,)
        population = self.dataset.population
        if population is not None:
            key += (population.population_id, population.set_id)
        return key

    @cached_property
    def catalogue(self) -> dict:
        """The ``getCatalogue`` body, built once per context (call under ``Store.lock``).

        Kept on the context rather than only in the response cache, which
        atlas responses can evict, so the catalogue stays cheap for as long
        as its version is cached.
        """
        return build_catalogue(
            self.dataset,
            self.catalog,
            label=self.label,
            staged=self.staged_upload_id is not None,
            cache=self.distributions,
            history=self.history,
        )

    @cached_property
    def search(self) -> SearchIndex:
        if self.search_index is not None:
            return self.search_index(self.dataset.atlas)
        return SearchIndex(self.dataset.atlas)


@dataclass(frozen=True)
class CachedBody:
    body: bytes
    etag: str


class ResponseCache:
    """Encoded response bodies, least recently used first out.

    Keys include the dataset version, so a publish never serves stale bodies.
    """

    def __init__(self, *, max_entries: int, max_bytes: int):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._entries: OrderedDict[tuple, CachedBody] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key: tuple) -> CachedBody | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def put(self, key: tuple, entry: CachedBody) -> None:
        if len(entry.body) > self.max_bytes:
            return
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= len(previous.body)
            self._entries[key] = entry
            self._bytes += len(entry.body)
            while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= len(evicted.body)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def __len__(self) -> int:
        return len(self._entries)


class Store:
    def __init__(
        self,
        db_path: Path | str,
        *,
        admin: AdminService | None = None,
        cached_versions: int = 2,
        cached_populations: int = 4,
        response_cache_entries: int = 256,
        response_cache_bytes: int = 128 * 1024 * 1024,
    ):
        self.db_path = Path(db_path)
        self.admin = admin
        self.lock = threading.RLock()
        self.responses = ResponseCache(max_entries=response_cache_entries, max_bytes=response_cache_bytes)
        self._versions: LruCache[VersionContext] = LruCache(cached_versions)
        self._staged: LruCache[VersionContext] = LruCache(cached_versions)
        self._populations: LruCache[VersionContext] = LruCache(cached_populations)
        self._search: SearchIndex | None = None
        self.distributions = DistributionCache()
        self.history = HistoryCache()
        self._conn: sqlite3.Connection | None = None
        # Imported ontologies (contract v1.13): static reference data, loaded once.
        self._ontology_infos: list[OntologyInfo] | None = None
        self._ontology_tables: dict[str, OntologyTables] = {}
        self._ontology_search: dict[str, SearchIndex] = {}

    def ontology_infos(self) -> list[OntologyInfo]:
        """The ontologies the store imported, in toolbar order (ICD-11 is not listed here)."""
        with self.lock:
            if self._ontology_infos is None:
                self._ontology_infos = load_infos(self._connection())
            return self._ontology_infos

    def ontology_tables(self, ontology_id: str | None) -> OntologyTables | None:
        """An imported ontology's tables; None for ICD-11 (absent or ``icd11``).
        404 ``unknown_ontology`` for an id the store has not imported."""
        if ontology_id is None or ontology_id == ICD11:
            return None
        with self.lock:
            tables = self._ontology_tables.get(ontology_id)
            if tables is None:
                info = next((entry for entry in self.ontology_infos() if entry.ontology_id == ontology_id), None)
                if info is None:
                    raise ApiError(404, "unknown_ontology", f"This store has no ontology {ontology_id!r}; /meta lists the ontologies it has.")
                tables = self._ontology_tables[ontology_id] = OntologyTables(self._connection(), info)
            return tables

    def ontology_search(self, tables: OntologyTables) -> SearchIndex:
        """One search index per ontology, shared by every version (it reads static fields only)."""
        with self.lock:
            index = self._ontology_search.get(tables.info.ontology_id)
            if index is None:
                index = self._ontology_search[tables.info.ontology_id] = SearchIndex(tables.search_atlas)
            return index

    def shared_search(self, atlas: Atlas) -> SearchIndex:
        """One search index for every version and staged read.

        Search reads only concept ids, codes, names, and levels (CONTRACT.md
        §9). They come from the static atlas tables, which no publish,
        rollback, or upload changes, so the index built for one version
        serves all of them. Rebuilding it per version cost about 150 ms on
        the first search after each publish.

        Since contract v1.14 (§31) it also holds the synonyms the ontology
        import wrote (reference data as well, loaded once like the
        ontologies); a store without them searches as before.
        """
        if self._search is None:
            self._search = SearchIndex(atlas, load_synonyms(self._connection()))
        return self._search

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            if not self.db_path.is_file():
                raise MissingData(
                    "The data store does not exist yet. Build it with: python -m app.importers.legacy_json"
                )
            self._conn = db.connect(self.db_path, read_only=True, check_same_thread=False)
        return self._conn

    def resolve(self, version: str | None, population: str | None = None) -> VersionContext:
        """The context for ``version=live`` (default) or ``version=staged:<upload_id>``,
        for the default population or (contract v1.10) a local one.

        A local population must be in that version (a staged population upload
        adds or replaces its own); otherwise 404 ``unknown_population``."""
        base = self._resolve_version(version)
        if population is None:
            return base
        with self.lock:
            set_id = base.dataset.state.population_sets.get(population)
            if set_id is None:
                raise ApiError(
                    404,
                    "unknown_population",
                    f"There is no local population {population!r} in dataset version {base.label}.",
                )
            return self._populations.get(
                (*base.cache_key, population, set_id),
                lambda: VersionContext(
                    base.dataset.with_population(population),
                    staged_upload_id=base.staged_upload_id,
                    staged_set_id=base.staged_set_id,
                    search_index=self.shared_search,
                    # Staged bases have their own cache (see _staged_context); the content key carries the population set.
                    distributions=base.distributions,
                    history=self.history,
                ),
            )

    def _resolve_version(self, version: str | None) -> VersionContext:
        version = version or "live"
        staged = _STAGED.match(version)
        if not staged and version != "live":
            raise ApiError(422, "invalid_version", f"version must be live or staged:<upload_id>, got {version!r}.")
        with self.lock:
            conn = self._connection()
            if staged:
                return self._staged_context(conn, staged.group(1))
            version_id = repository.live_version_id(conn)
            return self._versions.get(
                version_id,
                lambda: VersionContext(
                    Dataset(conn, version_id), search_index=self.shared_search, distributions=self.distributions, history=self.history
                ),
            )

    def _staged_context(self, conn: sqlite3.Connection, upload_id: str) -> VersionContext:
        if self.admin is None:
            raise ApiError(404, "unknown_upload", f"There is no staged upload {upload_id!r}.")
        try:
            staged = self.admin.staged_state(upload_id)
        except AdminError as error:
            raise ApiError(error.status, error.code, error.detail) from error
        return self._staged.get(
            (upload_id, staged.state.version_id, staged.set_id),
            lambda: VersionContext(
                Dataset(conn, state=staged.state),
                staged_upload_id=upload_id,
                staged_set_id=staged.set_id,
                search_index=self.shared_search,
                # A staged set can be deleted and written again under the same id and
                # source when it is checked again, so staged tiles never enter the
                # shared cache, which therefore only ever holds published sets.
                distributions=DistributionCache(),
                history=self.history,
            ),
        )

    def forget_staged(self) -> None:
        """Drop staged contexts (after a publish, rollback, or discard), with the
        population contexts built on them. Population contexts of a published
        version stay: their key names the version and the population's set, so
        a publish never serves them stale, and they are costly to rebuild."""
        with self.lock:
            self._staged.clear()
            self._populations.discard(keep=lambda context: context.staged_upload_id is None)

    def warm(self) -> None:
        """Load the live version, its search index, and its catalogue, so the first request is fast."""
        context = self.resolve("live")
        with self.lock:
            context.search  # noqa: B018 (builds the cached index)
            try:
                context.catalogue  # noqa: B018 (builds the catalogue body)
            except Exception:  # a broken catalogue must not keep the atlas from starting
                log.exception("Could not build the catalogue at startup; /catalogue will retry on request.")

    def open_dataset(self, context: VersionContext) -> Dataset:
        """A dataset on its own connection, for long work outside the lock (exports)."""
        conn = db.connect(self.db_path, read_only=True, check_same_thread=False)
        try:
            dataset = Dataset(conn, state=context.dataset.state)
            if context.population is not None:
                dataset = dataset.with_population(context.population.population_id)
            return dataset
        except Exception:
            conn.close()
            raise

    def close(self) -> None:
        with self.lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
            self._versions.clear()
            self._staged.clear()
            self._populations.clear()
            self._search = None
            self._ontology_infos = None
            self._ontology_tables.clear()
            self._ontology_search.clear()
            self.distributions = DistributionCache()
            self.history = HistoryCache()
            self.responses.clear()
