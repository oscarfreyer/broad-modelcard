"""DEMO PACK ONLY: derive the fictional local population of pack v3 from the default tiers.

Not a data generator for the atlas, and nothing here writes to a store. This
script only rebuilds the committed CSV file
``backend/demo/v3/populations/northbridge-region.csv`` so that it can be
reviewed and reproduced (contract v1.10, CONTRACT.md §21).

"Northbridge region (fictional)" is an invented, older, coastal region. Its
file lists commonness tiers for a few hundred top-level conditions only;
every other condition keeps the default tier (a population is an overlay):

* Chapters 05 (endocrine), 11 (circulatory), and 12 (respiratory): one tier
  more common than the default, for the conditions whose SHA-256 selector
  (of the population id and the ICD-11 code) falls below ``SHARE_UP``.
* Chapters 01 (infectious) and 02 (neoplasms): one tier rarer, for the
  conditions whose selector falls below ``SHARE_DOWN``.
* Conditions already at the end of the scale are skipped.

The tiers are synthetic and say nothing about any real place. The output is
deterministic; running the script twice gives byte-identical files.

Usage (from backend/, on a seed import; the store is only read):

    .venv/bin/python demo/tools/make_population.py --db <seed store> [--out demo/v3/populations/northbridge-region.csv]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from app import db  # noqa: E402
from app.schema.contract import PREVALENCE_TIERS  # noqa: E402
from app.schema.templates import PREVALENCE_TIER_LABELS  # noqa: E402
from app.services.catalog import is_top_level_condition  # noqa: E402
from app.services.dataset import Dataset  # noqa: E402

POPULATION_ID = "northbridge-region"
DEFAULT_OUT = BACKEND_DIR / "demo" / "v3" / "populations" / f"{POPULATION_ID}.csv"
MORE_COMMON = {"05", "11", "12"}
RARER = {"01", "02"}
SHARE_UP = 0.45
SHARE_DOWN = 0.35
SOURCE = "Synthetic regional prevalence estimate (fictional)"
STUDY = "NBR-POP-2026"
SOURCE_DATE = "2026-09-30"


def selector(code: str) -> float:
    digest = hashlib.sha256(f"{POPULATION_ID}|{code}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def rows(dataset: Dataset) -> list[list[str]]:
    found = []
    for concept in dataset.atlas.concepts:
        if not is_top_level_condition(concept) or concept.prevalence_tier is None:
            continue
        index = PREVALENCE_TIERS.index(concept.prevalence_tier)
        if concept.chapter_no in MORE_COMMON and selector(concept.concept_id) < SHARE_UP:
            index += 1
        elif concept.chapter_no in RARER and selector(concept.concept_id) < SHARE_DOWN:
            index -= 1
        else:
            continue
        if not 0 <= index < len(PREVALENCE_TIERS):
            continue
        tier = PREVALENCE_TIERS[index]
        found.append([concept.concept_id, concept.pt, PREVALENCE_TIER_LABELS[tier], "", SOURCE, STUDY, SOURCE_DATE])
    return sorted(found)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", required=True, type=Path, help="A seed import (read only).")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    conn = db.connect(args.db, read_only=True)
    try:
        dataset = Dataset(conn, 1)  # version 1: the seed's default tiers
        found = rows(dataset)
    finally:
        conn.close()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["ICD-11 code", "Condition", "Commonness", "Action", "Source", "Study", "Source date"])
        writer.writerows(found)
    print(f"{args.out}: {len(found)} codes")


if __name__ == "__main__":
    main()
