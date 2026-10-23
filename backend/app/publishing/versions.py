"""Dataset versions: publishing, rollback, history, and data set summaries.

A version lists its content sets (``version_content_sets``); the live version
is the highest ``version_id``. Publishing and rolling back add a version that
lists the live sets with some swapped, inside one transaction, so a version is
complete or absent. Nothing is overwritten and history is never deleted.
"""

from __future__ import annotations

import sqlite3
from dataclasses import replace

from .. import repository
from ..repository import DatasetState
from ..schema.contract import DATASET_KINDS


class PublishConflict(Exception):
    """The new version would be inconsistent (``detail`` says why)."""


def swap(state: DatasetState, kind: str, target: tuple | str | None, set_id: int) -> DatasetState:
    """``state`` with the set of ``kind`` (and target) replaced by ``set_id``.

    A population's target is its population id; swapping in a population that
    the state lacks adds it. Local results (contract v1.13) are keyed by
    (model_version, use_case, population_id)."""
    if kind == "local_metrics":
        return replace(state, local_metric_sets={**state.local_metric_sets, target: set_id})
    if kind == "model_cards":
        return replace(state, model_cards_set_id=set_id)
    if kind == "population":
        return replace(state, population_sets={**state.population_sets, target: set_id})
    if kind == "models":
        return replace(state, registry_set_id=set_id)
    if kind == "prevalence":
        return replace(state, prevalence_set_id=set_id)
    if kind == "safety":
        return replace(state, safety_set_id=set_id)
    if kind == "studies":
        return replace(state, studies_set_id=set_id)
    if kind == "effects":
        return replace(state, effects_set_id=set_id)
    if kind == "metrics":
        return replace(state, metric_sets={**state.metric_sets, target: set_id})
    return replace(state, multimorbidity_sets={**state.multimorbidity_sets, target: set_id})


def restore(live: DatasetState, past: DatasetState, kinds: tuple[str, ...]) -> DatasetState:
    """``live`` with every set of ``kinds`` taken from ``past``."""
    state = live
    for kind in kinds:
        if kind == "models":
            state = replace(state, registry_set_id=past.registry_set_id)
        elif kind == "prevalence":
            state = replace(state, prevalence_set_id=past.prevalence_set_id)
        elif kind == "safety":
            state = replace(state, safety_set_id=past.safety_set_id)
        elif kind == "studies":
            state = replace(state, studies_set_id=past.studies_set_id)
        elif kind == "effects":
            state = replace(state, effects_set_id=past.effects_set_id)
        elif kind == "population":
            state = replace(state, population_sets=dict(past.population_sets))
        elif kind == "local_metrics":
            state = replace(state, local_metric_sets=dict(past.local_metric_sets))
        elif kind == "model_cards":
            state = replace(state, model_cards_set_id=past.model_cards_set_id)
        elif kind == "metrics":
            state = replace(state, metric_sets=dict(past.metric_sets))
        else:
            state = replace(state, multimorbidity_sets=dict(past.multimorbidity_sets))
    return state


def set_ids(state: DatasetState) -> list[int]:
    singles = {state.registry_set_id, state.prevalence_set_id}
    if state.safety_set_id is not None:
        singles.add(state.safety_set_id)
    if state.studies_set_id is not None:
        singles.add(state.studies_set_id)
    if state.model_cards_set_id is not None:
        singles.add(state.model_cards_set_id)
    if state.effects_set_id is not None:
        singles.add(state.effects_set_id)
    return sorted({
        *singles, *state.metric_sets.values(), *state.multimorbidity_sets.values(), *state.population_sets.values(),
        *state.local_metric_sets.values(),
    })


def without_population(state: DatasetState, population_id: str) -> DatasetState:
    """``state`` without the population ``population_id`` (contract v1.10)."""
    return replace(
        state,
        population_sets={key: value for key, value in state.population_sets.items() if key != population_id},
        # Its local results (contract v1.13) go with it; a rollback brings both back.
        local_metric_sets={key: value for key, value in state.local_metric_sets.items() if key[2] != population_id},
    )


def variants_without_metrics(conn: sqlite3.Connection, state: DatasetState) -> list[tuple[str, str]]:
    """Registry functions (cards) that would have no performance metrics."""
    registry = repository.load_registry(conn, state.registry_set_id)
    return [
        (model.model_version, variant.use_case)
        for model in registry.models
        for variant in model.use_cases
        if (model.model_version, variant.use_case) not in state.metric_sets
    ]


def check_consistent(conn: sqlite3.Connection, state: DatasetState) -> None:
    missing = variants_without_metrics(conn, state)
    if missing:
        shown = ", ".join(f"{model} / {use_case}" for model, use_case in missing[:5])
        raise PublishConflict(f"The registry would list functions without performance metrics: {shown}.")


def _link_content_sets(conn: sqlite3.Connection, version_id: int, state: DatasetState) -> None:
    conn.executemany(
        "INSERT INTO version_content_sets (version_id, set_id) VALUES (?, ?)",
        [(version_id, set_id) for set_id in set_ids(state)],
    )


def insert_version(
    conn: sqlite3.Connection,
    *,
    state: DatasetState,
    kind: str | None,
    summary: str,
    created_at: str,
    upload_id: str | None = None,
    rollback_of: int | None = None,
    previewed: bool = False,
    note: str | None = None,
    publisher_role: str | None = None,
    publisher_name: str | None = None,
) -> int:
    """Add the next version listing ``state``'s sets (inside the caller's
    transaction), with who published it (contract v1.13, §26: the chosen
    workspace role and an entered name; no login)."""
    version_id = repository.live_version_id(conn) + 1
    conn.execute(
        "INSERT INTO dataset_versions (version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note, "
        "publisher_role, publisher_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (version_id, kind, created_at, summary, upload_id, rollback_of, int(previewed), note, publisher_role, publisher_name),
    )
    _link_content_sets(conn, version_id, state)
    return version_id


# ------------------------------------------------------------------ history

_VERSION_COLUMNS = "version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note, publisher_role, publisher_name"


def _entry(row: tuple) -> dict:
    """openapi.json ``VersionEntry``."""
    return {
        "version_id": row[0],
        "kind": row[1],
        "published_at": row[2],
        "summary": row[3],
        "upload_id": row[4],
        "rollback_of": row[5],
        "previewed": bool(row[6]),
        "note": row[7],
        # Contract v1.13 (§26): the workspace role and name given at publish; null before schema 9.
        "publisher_role": row[8],
        "publisher_name": row[9],
    }


def version_entry(conn: sqlite3.Connection, version_id: int) -> dict | None:
    row = conn.execute(f"SELECT {_VERSION_COLUMNS} FROM dataset_versions WHERE version_id = ?", (version_id,)).fetchone()
    return _entry(row) if row else None


def list_versions(conn: sqlite3.Connection, kind: str | None = None) -> list[dict]:
    """Newest first. With ``kind``, the versions that changed it plus those
    that cover every kind (the initial import)."""
    if kind is None:
        rows = conn.execute(f"SELECT {_VERSION_COLUMNS} FROM dataset_versions ORDER BY version_id DESC")
    else:
        rows = conn.execute(
            f"SELECT {_VERSION_COLUMNS} FROM dataset_versions WHERE kind = ? OR kind IS NULL ORDER BY version_id DESC",
            (kind,),
        )
    return [_entry(row) for row in rows]


# ---------------------------------------------------------------- data sets

class SetCounts:
    """Row counts per content set; sets never change, so counts are cached."""

    def __init__(self) -> None:
        self._counts: dict[tuple[str, int], int] = {}

    def count(self, conn: sqlite3.Connection, table: str, set_id: int) -> int:
        key = (table, set_id)
        if key not in self._counts:
            self._counts[key] = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE set_id = ?", (set_id,)).fetchone()[0]
        return self._counts[key]


def dataset_infos(conn: sqlite3.Connection, counts: SetCounts, staged: dict[str, list[str]]) -> list[dict]:
    """openapi.json ``DatasetInfo`` for every kind. ``staged`` maps each kind to
    its staged upload ids, newest first."""
    state = repository.load_state(conn)
    registry = repository.load_registry(conn, state.registry_set_id)
    listed = {(model.model_version, variant.use_case) for model in registry.models for variant in model.use_cases}
    infos = []
    for kind in DATASET_KINDS:
        version_id, updated_at = conn.execute(
            "SELECT version_id, created_at FROM dataset_versions WHERE kind = ? OR kind IS NULL "
            "ORDER BY version_id DESC LIMIT 1",
            (kind,),
        ).fetchone()
        if kind == "models":
            values = {"models": len(registry.models), "use_cases": len(listed)}
        elif kind == "prevalence":
            values = {"codes": counts.count(conn, "prevalence_tiers", state.prevalence_set_id)}
        elif kind == "population":
            sets = list(state.population_sets.values())
            values = {"populations": len(sets), "codes": sum(counts.count(conn, "prevalence_tiers", s) for s in sets)}
        elif kind == "safety":
            incidents = repository.load_incidents(conn, state.safety_set_id) if state.safety_set_id is not None else []
            values = {"incidents": len(incidents), "open": sum(1 for incident in incidents if incident.status == "open")}
        elif kind == "studies":
            values = {"studies": counts.count(conn, "studies", state.studies_set_id) if state.studies_set_id is not None else 0}
        elif kind == "effects":
            values = {"effects": counts.count(conn, "effects", state.effects_set_id) if state.effects_set_id is not None else 0}
        elif kind == "local_metrics":
            sets = list(state.local_metric_sets.values())
            values = {
                "use_cases": len({key[:2] for key in state.local_metric_sets}),
                "populations": len({key[2] for key in state.local_metric_sets}),
                "metric_rows": sum(counts.count(conn, "metric_rows", s) for s in sets),
            }
        elif kind == "model_cards":
            values = {"model_cards": counts.count(conn, "model_cards", state.model_cards_set_id) if state.model_cards_set_id is not None else 0}
        elif kind == "metrics":
            sets = [set_id for target, set_id in state.metric_sets.items() if target in listed]
            values = {"use_cases": len(sets), "metric_rows": sum(counts.count(conn, "metric_rows", s) for s in sets)}
        else:
            sets = [set_id for target, set_id in state.multimorbidity_sets.items() if target in listed]
            values = {
                "use_cases": len(sets),
                "combinations": sum(counts.count(conn, "mm_combinations", s) for s in sets),
                "metric_rows": sum(counts.count(conn, "mm_rows", s) for s in sets),
            }
        ids = staged.get(kind, [])
        infos.append(
            {
                "kind": kind,
                "version": version_id,
                "updated_at": updated_at,
                "counts": values,
                "staged_upload_id": ids[0] if ids else None,
                "staged_upload_ids": ids,
            }
        )
    return infos
