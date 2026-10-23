"""DEMO ONLY: the generated part of the demo revision (demo pack v4).

Since contract v1.11 a performance value needs evidence (D12), and the seed
holds rows with performance and no validation data. The demo revision gives
every such row synthetic evidence (``evidence.with_evidence``) and publishes
the result **through the normal update workflow**, one upload per card:

* metrics: a merge upload of the changed rows only, each with the source
  named in the manifest ("Demo revision (synthetic)", a study, a date), so
  every other row keeps its source;
* multimorbidity (replace only): the card's whole set with the gaps filled,
  if it has any (the seed has none).

The rows are generated at build time from the store, never committed. Nothing
here is clinical evidence.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Collection, Iterator

from ..publishing import content as contents
from ..publishing.files import data_rows, write_template_csv
from ..repository import RowSource
from ..services.atlas import Atlas
from ..services.dataset import Dataset
from .evidence import needs_evidence, with_evidence


@dataclass(frozen=True)
class EvidenceUpload:
    """One generated upload: a card's rows with synthetic evidence, as a template CSV."""

    kind: str  # metrics or multimorbidity
    mode: str  # merge (metrics) or replace (multimorbidity)
    model_version: str
    use_case: str
    path: Path
    rows: int  # rows given evidence


def _row_key(model_version: str, use_case: str, concept_id: str, atlas: Atlas, combo_idx: int) -> str:
    lens = atlas.axes.lens_for_index(combo_idx)
    # A specific care setting (contract v1.14, §29) adds its name; Any-setting keys are unchanged.
    setting = () if lens.is_any_setting else (lens.setting,)
    return "|".join((model_version, use_case, concept_id, lens.age, lens.sex, lens.ethnicity, *setting))


def evidence_uploads(
    conn: sqlite3.Connection, out_dir: Path, source: RowSource, cards: Collection[tuple[str, str]] | None = None
) -> Iterator[EvidenceUpload]:
    """For every card of the live version (or of ``cards``), in registry order,
    the upload that fills its evidence gaps (cards without gaps are left out).
    Files are written into ``out_dir`` as they are yielded; each card's sets
    are read before its upload, and a publish changes only its own card's sets."""
    dataset = Dataset(conn)
    atlas = dataset.atlas
    registered = [(model.model_version, variant.use_case) for model in dataset.registry.models for variant in model.use_cases]
    chosen = [key for key in registered if cards is None or key in cards]
    for index, key in enumerate(chosen, start=1):
        set_id = dataset.state.metric_sets.get(key)
        if set_id is not None:
            stored = contents.load_metrics(conn, set_id, *key)
            fixed = {
                row: with_evidence(values, _row_key(*key, row[1], atlas, row[0]))
                for row, values in stored.rows.items()
                if needs_evidence(values)
            }
            if fixed:
                path = out_dir / f"{index:02d}-metrics-evidence.csv"
                subset = contents.MetricsContent(*key, stored.combos, fixed)
                write_template_csv(path, "metrics", data_rows(subset, atlas, (source, {})))
                yield EvidenceUpload("metrics", "merge", *key, path, len(fixed))
        set_id = dataset.state.multimorbidity_sets.get(key)
        if set_id is not None:
            stored = contents.load_multimorbidity(conn, set_id, *key)
            count = 0
            for combination in stored.combinations:
                for combo_idx, values in list(combination.rows.items()):
                    if needs_evidence(values):
                        combination.rows[combo_idx] = with_evidence(values, _row_key(*key, combination.key, atlas, combo_idx))
                        count += 1
            if count:
                path = out_dir / f"{index:02d}-multimorbidity-evidence.csv"
                write_template_csv(path, "multimorbidity", data_rows(stored, atlas))
                yield EvidenceUpload("multimorbidity", "replace", *key, path, count)
