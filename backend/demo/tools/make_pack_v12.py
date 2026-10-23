"""Write demo pack v12's evaluation results file (contract v1.14, CONTRACT.md §32.2).

A fictional independent benchmark, the Harbourline Clinical Vignette Benchmark
3.0, run on MediCore-2.5 / Clinician Facing CDSS (its current configuration,
cfg-medicore-cdss-2025-03): top-3 diagnostic accuracy for 32 conditions at all
patients and 4 of them for patients aged 65 and over. Deterministic: every run
writes the same bytes. All values are synthetic; the benchmark, its maker, and
its address are fictional.

    python demo/tools/make_pack_v12.py
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]
TARGET = PACK / "v12" / "evaluations" / "medicore-2-5.clinician-facing-cdss.harbourline-vignettes.json"

CODES = (
    "1A00", "1B10", "1C62", "1G40", "2C25", "2C30", "2C82", "3A00", "4A84", "5A10", "2C10", "5B81",
    "6A20", "6A70", "6B00", "8B11", "8B20", "BA00", "BA40", "BA41", "BB01", "BD10", "CA20", "BD11",
    "CA23", "CA40", "DC31", "DD70", "FA00", "FA20", "GB61", "GC08",
)
# 5A11 and CA22 are left out: the study helper evaluation (assist_eval E1, HMS-2026-07) merges those rows
# with an older source date, which a newer benchmark row would keep out (CONTRACT.md §11.2).
OLDER = ("BA41", "CA40", "8B11", "BD10")
MEASURE = "Top-3 diagnostic accuracy"


def _unit(text: str) -> float:
    """A fixed number in [0, 1) from the text."""
    return int(hashlib.sha256(text.encode()).hexdigest()[:8], 16) / 0x100000000


def _result(code: str, age: str | None = None) -> dict:
    key = f"{code}|{age or 'all'}"
    value = round(0.58 + 0.32 * _unit(key), 3)
    cases = 40 + int(160 * _unit(key + "|cases"))
    half = round(1.96 * math.sqrt(value * (1 - value) / cases), 3)
    result = {
        "icd11_code": code,
        "measure": MEASURE,
        "value": value,
        "ci_low": round(max(0.0, value - half), 3),
        "ci_high": round(min(1.0, value + half), 3),
        "cases": cases,
        "sites": 1 + int(4 * _unit(key + "|sites")),
    }
    if age:
        result["age"] = age
    return result


def build() -> dict:
    results = [_result(code) for code in CODES] + [_result(code, "Age 65+") for code in OLDER]
    return {
        "format": "bmc-evaluation-results/1",
        "model_version": "MediCore-2.5",
        "use_case": "Clinician Facing CDSS",
        "configuration_id": "cfg-medicore-cdss-2025-03",
        "benchmark": {
            "name": "Harbourline Clinical Vignette Benchmark (fictional)",
            "version": "3.0",
            "description": "Synthetic written case vignettes with a reference diagnosis set by a panel of three clinicians (fictional).",
            "url": "https://studies.example/harbourline-vignette-benchmark-3",
        },
        "run_date": "2026-10-18",
        "conducted_by": "independent",
        "setting": "mixed",
        "results": results,
    }


if __name__ == "__main__":
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(build(), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {TARGET.relative_to(PACK)} ({len(build()['results'])} results)")
