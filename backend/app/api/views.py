"""The atlas a read sees: ICD-11, or another ontology projected over it (contract v1.13, CONTRACT.md §23).

The atlas reads (overview, chapter, metric map, summary, concept metrics,
search, concept export) take ``ontology=<id>``. ``AtlasView`` gives them one
interface for both: the catalog (records, scopes, paths), the metrics and
safety services of a card, and the search index. For ICD-11 (no parameter, or
``icd11``) these are exactly the context's own, so those reads are unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..services.ontology import Projection
from ..services.search import SearchIndex
from .store import Store, VersionContext


@dataclass(frozen=True)
class AtlasView:
    context: VersionContext
    projection: Projection | None = None
    search_index: SearchIndex | None = None

    @property
    def catalog(self):
        return self.projection.catalog if self.projection is not None else self.context.catalog

    @property
    def ref(self) -> dict | None:
        """``OntologyRef`` for the response body; None for ICD-11."""
        return self.projection.info.ref if self.projection is not None else None

    @property
    def search(self) -> SearchIndex:
        return self.search_index if self.search_index is not None else self.context.search

    def metrics(self, model: str, use_case: str):
        if self.projection is not None:
            return self.projection.metrics(model, use_case)
        return self.context.dataset.metrics(model, use_case)

    def card_safety(self, model: str, use_case: str):
        if self.projection is not None:
            return self.projection.card_safety(model, use_case)
        return self.context.dataset.card_safety(model, use_case)

    def card_effects(self, model: str, use_case: str):
        """The card's intervention effects (contract v1.13, §27), through the projection in another ontology."""
        if self.projection is not None:
            return self.projection.card_effects(model, use_case)
        return self.context.dataset.card_effects(model, use_case)


def atlas_view(store: Store, context: VersionContext, ontology: str | None) -> AtlasView:
    """The view for ``ontology`` (None or ``icd11``: ICD-11). 404 ``unknown_ontology`` for an id the store lacks."""
    tables = store.ontology_tables(ontology)
    if tables is None:
        return AtlasView(context)
    with store.lock:
        projection = context.projection(tables)
    return AtlasView(context, projection, store.ontology_search(tables))
