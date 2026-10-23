"""Concept and dataset exports (openapi.json ``exportConcept``, ``exportDataset``).

The concept export follows ``exportPayload`` in src/components/DetailsPanel.jsx
(v0.2.0-alpha.1) with copy replaced by codes, as the contract defines it. The
dataset export follows ``exportTableDatasetJson`` in src/data/tableDataset.js
and is produced as a stream of JSON chunks, because it is about 1 GB.
"""

from __future__ import annotations

import json
import re
from typing import Iterator

from .. import repository
from ..schema.contract import SYNTHETIC_DATA_NOTICE
from .catalog import Catalog
from .dataset import Dataset
from .grading import GRADE_SCORES
from .jsnum import clamp, is_finite, to_fixed
from .metrics import MetricsService
from .presentation import metric_row
from .types import Concept, Lens


def slugify(value: str | None, fallback: str = "model-card") -> str:
    """``slugify`` from DetailsPanel.jsx."""
    slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", str(value or fallback).lower()))
    return slug or fallback


def concept_export(
    catalog: Catalog,
    concept: Concept,
    row: dict | None,
    *,
    model_version: str,
    use_case: str,
    lens: Lens,
    audience: str,
    dataset_version: str,
    exported_at: str,
) -> dict:
    """The condition model card as JSON. ``row`` is the served ``MetricRow``."""
    return {
        "exported_at": exported_at,
        "audience_view": audience,
        "dataset_version": dataset_version,
        "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
        "concept": {
            "code": concept.icd11_code or concept.concept_id or None,
            "block": concept.block_id or (concept.concept_id if concept.level == 1 else None),
            "name": concept.pt,
            "hierarchy": [entry["pt"] for entry in catalog.path(concept)],
        },
        "context": {
            "model": model_version,
            "use_case": use_case,
            "population": lens.as_dict(),
            # Contract v1.14 (§29): the care setting, only when a specific one was read.
            **({} if lens.is_any_setting else {"setting": lens.setting}),
        },
        "model_card": row,
        "warnings": row["warnings"] if row else [],
        "safeguards": row["safeguards"] if row else [],
    }


def concept_export_filename(concept: Concept) -> str:
    return f"{slugify(concept.icd11_code or concept.concept_id)}-model-card.json"


def dataset_export_filename(model_version: str, use_case: str, dataset_version: str) -> str:
    return f"broad-modelcard-{slugify(model_version)}-{slugify(use_case)}-v{dataset_version}.json"


def metric_key(concept_id: str, use_case: str, context: str, lens: Lens, model_version: str) -> str:
    """``makeMetricKey``: ``concept|use case|context|age | sex | ethnicity|model``."""
    return f"{concept_id}|{use_case}|{context}|{lens.label}|{model_version}"


def dataset_summary(dataset: Dataset, metrics: MetricsService) -> dict:
    """``summarizeDataset`` at the all-population lens.

    Uses its own overall formula, ``0.5·perf + 0.35·evidence + 0.15·iu`` with
    partial scope 0.5, unlike CONTRACT.md §4.4 (§12 quirk); a row without an
    intended-use value (v1.11) uses ``(0.5·perf + 0.35·evidence) / 0.85``.
    """
    axes = dataset.atlas.axes
    lens = Lens(axes.age[0], axes.sex[0], axes.ethnicity[0])
    conditions = [concept for concept in dataset.atlas.concepts if concept.level == 2 and concept.depth == 1]
    perf_total = certainty_total = evidence_total = overall_total = 0.0
    count = 0
    for condition in conditions:
        row = metrics.row(condition.concept_id, lens)
        if row is None or not is_finite(row.perf):
            continue
        ci_width = clamp(row.ci_high - row.ci_low, 0, 1) if is_finite(row.ci_low) and is_finite(row.ci_high) else 0
        evidence = GRADE_SCORES.get(row.evidence_grade, 0.25)
        perf_total += row.perf
        certainty_total += clamp(1 - ci_width, 0, 1)
        evidence_total += evidence
        if row.intended_use_level is None:
            # No intended-use value (contract v1.11): the other terms scaled to 100 %, as in D3.
            overall_total += clamp((0.5 * row.perf + 0.35 * evidence) / 0.85, 0, 1)
        else:
            intended_use = {"in_scope": 1, "partially_in_scope": 0.5}.get(row.intended_use_level, 0)
            overall_total += clamp(0.5 * row.perf + 0.35 * evidence + 0.15 * intended_use, 0, 1)
        count += 1
    divisor = max(1, count)
    return {
        "conditionCount": len(conditions),
        "averagePerf": to_fixed(perf_total / divisor, 3),
        "averageCertainty": to_fixed(certainty_total / divisor, 3),
        "averageEvidence": to_fixed(evidence_total / divisor, 3),
        "averageOverall": to_fixed(overall_total / divisor, 3),
    }


def _dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def dataset_export_chunks(
    dataset: Dataset,
    catalog: Catalog,
    model_version: str,
    use_case: str,
    *,
    dataset_version: str,
    rows_per_chunk: int = 2000,
) -> Iterator[bytes]:
    """The full dataset for one model and use case as JSON, in chunks.

    ``metrics_by_key`` holds every concept × lens combination the metrics set
    defines that has a row. Keys are written lens by lens, so only one lens's
    rows are held in memory; JSON object key order carries no meaning.
    """
    conn = dataset.connection
    state = dataset.state
    metrics = dataset.new_metrics(model_version, use_case, lens_cache_size=1)
    atlas_meta = repository.load_atlas_meta(conn)
    prevalence = repository.load_content_set(conn, state.prevalence_set_id)
    metric_set = repository.load_content_set(conn, state.metric_sets[(model_version, use_case)])
    axes = dataset.atlas.axes
    combos = list(metrics.reader.combo_order)
    if metrics.local is not None:
        # Contract v1.13 (§26.1): local results can store groups the public set lacks; they are served there too.
        public = set(combos)
        combos += [combo_idx for combo_idx in metrics.local.reader.combo_order if combo_idx not in public]
    head = {
        "meta": {
            **(atlas_meta.get("meta") or {}),
            "source": "sqlite",
            "tableGeneratedAt": atlas_meta.get("generated_at"),
            "prevalenceDatasetId": prevalence.meta.get("dataset_id"),
            "prevalenceGeneratedAt": prevalence.generated_at,
            "metricsGeneratedAt": metric_set.generated_at,
            "modelVersion": model_version,
            "modelUseCase": use_case,
            "dataset_version": dataset_version,
            "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
        },
        "concepts": [catalog.record(concept.concept_id) for concept in dataset.atlas.concepts],
        "metric_axes": {
            # Contract v1.14 (§29): Any setting and the specific care settings the card stores rows for.
            "context": [axes.context[0], *(setting for setting in axes.settings_of(combos) if setting != axes.context[0])],
            "age": list(axes.age),
            "sex": list(axes.sex),
            "ethnicity": list(axes.ethnicity),
        },
        "summary": dataset_summary(dataset, metrics),
    }
    if dataset.population is not None:
        # Contract v1.10: the local population whose tiers the export uses.
        head["population"] = {"id": dataset.population.population_id, "name": dataset.population.name}
    metrics.clear_cache()
    yield (_dumps(head)[:-1] + ',"metrics_by_key":{').encode()

    first = True
    chunk: list[str] = []
    for combo_idx in combos:
        # Since v1.14 (§29) a combination of a specific setting is keyed and served with its setting.
        lens = axes.lens_for_index(combo_idx)
        for concept in dataset.atlas.concepts:
            row = metrics.row(concept.concept_id, lens)
            if row is None:
                continue
            served = metric_row(row, model_version=model_version, use_case=use_case, context=lens.setting)
            key = metric_key(concept.concept_id, use_case, lens.setting, lens, model_version)
            chunk.append(f"{_dumps(key)}:{_dumps(served)}")
            if len(chunk) >= rows_per_chunk:
                yield (("" if first else ",") + ",".join(chunk)).encode()
                first = False
                chunk = []
        metrics.clear_cache()
    if chunk:
        yield (("" if first else ",") + ",".join(chunk)).encode()
    yield b"}}\n"
