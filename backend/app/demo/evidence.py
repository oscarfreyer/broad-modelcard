"""DEMO ONLY: deterministic synthetic evidence for rows that have a performance
value and no evidence (contract v1.11 D12).

Since contract v1.11 a performance value needs evidence. The seed holds rows
with performance and no validation data (they read No data, D5); the demo
revision gives each of them thin, synthetic evidence so that it is graded:
mostly an internal test or a benchmark, one to three studies, rarely peer
reviewed, few sites. The stored sample count is kept.

Every value is derived from a SHA-256 of a fixed seed and the row's key, so a
rebuild gives the same rows. Nothing here is clinical evidence; it exists only
to make the demonstration store complete.
"""

from __future__ import annotations

import hashlib

from ..schema.contract import METRIC_ROW_FORMAT

SEED = "broad-modelcard-demo-revision-v4"
NO_VALIDATION_DATA = "no_validation_data"
MIN_SAMPLES = 24

# (share of rows in percent, value); the shares add up to 100.
_VALIDATION_TYPES = ((50, "internal_test"), (40, "benchmark"), (10, "simulation_study"))
_STUDIES = ((60, 1), (30, 2), (10, 3))
_SITES = ((70, 1), (25, 2), (5, 3))
_PEER_REVIEWED_PERCENT = 20  # one peer-reviewed study in about one row in five
_DEFAULT_SAMPLES = (60, 600)  # when a row has no sample count

_INDEX = {name: index for index, name in enumerate(METRIC_ROW_FORMAT)}


def _pick(choices, roll: int):
    """The value whose cumulative share covers ``roll`` (0–99)."""
    total = 0
    for share, value in choices:
        total += share
        if roll < total:
            return value
    return choices[-1][1]


def needs_evidence(values: tuple) -> bool:
    """A stored tuple (``METRIC_ROW_FORMAT``) with a performance value and no
    validation data (CONTRACT.md §4.1): what the v1.11 upload check rejects."""
    warnings = values[_INDEX["warnings"]] or ()
    return values[_INDEX["perf"]] is not None and (
        not values[_INDEX["validation_type"]] or NO_VALIDATION_DATA in warnings
    )


def with_evidence(values: tuple, key: str) -> tuple:
    """``values`` with synthetic evidence for the row named by ``key`` (any
    stable text, e.g. card, code, and lens). The source evidence grade is left
    empty: the API derives the grade from the study details (§4.2)."""
    digest = hashlib.sha256(f"{SEED}|{key}".encode()).digest()
    validation_type = _pick(_VALIDATION_TYPES, digest[0] % 100)
    studies = _pick(_STUDIES, digest[1] % 100)
    sites = _pick(_SITES, digest[2] % 100)
    peer_reviewed = 1 if digest[3] % 100 < _PEER_REVIEWED_PERCENT else 0
    samples = values[_INDEX["n_samples"]]
    if samples is None:
        low, high = _DEFAULT_SAMPLES
        samples = low + int.from_bytes(digest[4:6], "big") % (high - low + 1)
    row = list(values)
    row[_INDEX["evidence_grade"]] = None
    row[_INDEX["n_samples"]] = max(MIN_SAMPLES, int(samples))
    row[_INDEX["n_sites"]] = sites
    row[_INDEX["n_studies"]] = studies
    row[_INDEX["peer_reviewed_studies"]] = min(peer_reviewed, studies)
    row[_INDEX["validation_type"]] = validation_type
    row[_INDEX["warnings"]] = tuple(code for code in (values[_INDEX["warnings"]] or ()) if code != NO_VALIDATION_DATA)
    return tuple(row)
