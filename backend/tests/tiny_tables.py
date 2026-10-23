"""A tiny synthetic table set in the legacy JSON format (one chapter, one block,
two conditions, two deeper categories, one model with one multimorbidity pair).

All values are synthetic.
"""

from __future__ import annotations

import json
from pathlib import Path

AXES = {
    "task_mode": ["CDSS"],
    "context": ["Clinical"],
    "age_lens": ["All ages", "Age 0-17", "Age 18-39", "Age 40-64", "Age 65+"],
    "sex_lens": ["All sexes", "Sex Female", "Sex Male"],
    "ethnicity_lens": [
        "All ethnicities",
        "Ethnicity White",
        "Ethnicity Black",
        "Ethnicity Hispanic",
        "Ethnicity Asian",
        "Ethnicity Other",
    ],
    "model_version": ["Tiny-1"],
}
COMBOS = [
    {"task_mode": "CDSS", "context": "Clinical", "age_lens": age, "sex_lens": sex, "ethnicity_lens": eth}
    for age in AXES["age_lens"]
    for sex in AXES["sex_lens"]
    for eth in AXES["ethnicity_lens"]
]
ROW_FORMAT = [
    "perf", "ci_low", "ci_high", "evidence_grade", "n_samples", "n_sites", "n_studies", "peer_reviewed_studies",
    "validation_type", "in_intended_use", "intended_use_coverage", "intended_use_level", "warnings",
]


def _concept(concept_id, parent_id, level, **extra):
    return {
        "concept_id": concept_id,
        "parent_id": parent_id,
        "level": level,
        "chapter_no": "01",
        "pt": f"Synthetic {concept_id}",
        "fsn": None,
        "icd11_code": concept_id,
        "prevalence_score": None,
        "sort_order": 0,
        **extra,
    }


def _tuple(perf):
    return [perf, perf - 0.05, perf + 0.05, "B", 500, 3, 4, 3, "benchmark", 1, 1, "in_scope", ["clinician_review_required"]]


def tiny_tables() -> dict[str, object]:
    atlas = {
        "schema_version": 1,
        "generated_at": "2026-10-08T00:00:00Z",
        "meta": {"note": "synthetic test atlas"},
        "concepts": [
            _concept("CH-01", None, 0),
            _concept("BLK-01", "CH-01", 1),
            _concept("1A00", "BLK-01", 2, depth_in_kind=1, metric_anchor_id="1A00"),
            _concept("1A01", "BLK-01", 2, depth_in_kind=1, metric_anchor_id="1A01"),
            _concept("1A00.0", "BLK-01", 2, depth_in_kind=2, metric_anchor_id="1A00"),
            _concept("1A09.1", "BLK-01", 2, depth_in_kind=2, metric_anchor_id="1A09"),
        ],
        "metric_axes": AXES,
        "combo_definitions": [],
        "top_level_condition_ids": ["1A00", "1A01"],
    }
    prevalence = {
        "dataset_id": "tiny",
        "min_score": 0.03,
        "max_score": 0.97,
        "generated_at": "2026-10-08T00:00:00Z",
        "scores_by_code": {"1A00": "common", "1A01": "rare", "1A00.0": "rare"},
    }
    registry = {
        "schema_version": 1,
        "generated_at": "2026-10-08T00:00:00Z",
        "default_model_version": "Tiny-1",
        "models": [
            {
                "model_version": "Tiny-1",
                "model_name": "Tiny",
                "model_release": "1",
                "display_name": "Tiny-1",
                "default_use_case": "CDSS",
                "status": "ACTIVE",
                "effects": None,
                "capabilities": None,
                "use_case_variants": [
                    {
                        "use_case": "CDSS",
                        "metrics_file": "data/tables/models/tiny-1.cdss.metrics.json",
                        "multimorbidity_metrics_file": "data/tables/models/tiny-1.cdss.multimorbidity.metrics.json",
                    }
                ],
            }
        ],
    }
    header = {
        "schema_version": 1,
        "model_version": "Tiny-1",
        "display_name": "Tiny-1",
        "use_case": "CDSS",
        "metric_axes": {key: AXES[key] for key in ("context", "age_lens", "sex_lens", "ethnicity_lens")},
        "row_format": ROW_FORMAT,
    }
    metrics = {
        **header,
        "combo_count": len(COMBOS),
        "combo_definitions": COMBOS,
        "rows_by_condition_id": {
            "1A00": [_tuple(0.8 + index / 1000) for index in range(len(COMBOS))],
            "1A01": [_tuple(0.6) for _ in COMBOS],
        },
    }
    multimorbidity = {
        **header,
        "combo_count": 1,
        "combo_definitions": COMBOS[:1],
        "combinations": [{"condition_ids": ["1A01", "1A00"], "label": "Synthetic pair", "rows": [_tuple(0.7)]}],
    }
    return {
        "atlas-base.json": atlas,
        "prevalence_by_code.json": prevalence,
        "model-registry.json": registry,
        "models/tiny-1.cdss.metrics.json": metrics,
        "models/tiny-1.cdss.multimorbidity.metrics.json": multimorbidity,
    }


def write_tables(root: Path, tables: dict) -> Path:
    for name, payload in tables.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
    return root
