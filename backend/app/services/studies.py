"""Study records and their appraisal (contract v1.13, CONTRACT.md §22).

A study record describes one study behind metric rows (design, setting, sites,
patients, peer review, who conducted it, reporting guideline, risk of bias,
population, evaluation conditions, model version, publication date). The
``studies`` data set is global, like the safety incidents.

* **Link.** A stored metric row links to a study when its row source's Study
  (CONTRACT.md §11.3) equals a Study ID of the version's studies set, exactly.
  Free-text studies that name no record stay allowed and link nothing.
* **Adjustment**: the linked study changes the row's
  evidence signal (§4.2) by +0.05 when its reporting guideline was followed
  (``yes``; ``partly`` and ``no`` give 0) and by −0.10 for a high, −0.04 for
  some concerns or unclear, and 0 for a low risk of bias. It is added with the
  penalties, before the clamp; grade cut-offs are unchanged. A row without a
  linked study is graded exactly as before.
* **Aggregates.** A rollup (§6) adds the prevalence-weighted mean of its
  children's adjustments (children without a link count 0), and a lens
  fallback over several rows (§7) the mean of its rows' adjustments.
* **Appraisal.** A concept read of a linked stored row carries the study
  record and the signal's terms; an aggregated row carries its adjustment only.

Multimorbidity rows have no row source and so never link. All data is
synthetic demonstration data.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from .. import repository
from ..repository import SetStudies, StudyRecord
from ..schema.contract import GUIDELINE_FOLLOWED_ADJUSTMENT, RISK_OF_BIAS_ADJUSTMENTS
from . import grading
from .jsnum import to_fixed
from .types import Concept, MetricValues

# /meta.evidence_study_adjustments (contract v1.13).
EVIDENCE_STUDY_ADJUSTMENTS = {"guideline_followed": GUIDELINE_FOLLOWED_ADJUSTMENT, "risk_of_bias": dict(RISK_OF_BIAS_ADJUSTMENTS)}


def guideline_adjustment(study: StudyRecord) -> float:
    """+0.05 when a reporting guideline was followed, else 0."""
    followed = study.reporting_guideline != "none" and study.guideline_followed == "yes"
    return GUIDELINE_FOLLOWED_ADJUSTMENT if followed else 0.0


def risk_of_bias_adjustment(study: StudyRecord) -> float:
    return RISK_OF_BIAS_ADJUSTMENTS.get(study.risk_of_bias, 0.0)


def study_adjustment(study: StudyRecord) -> float:
    """The study's whole change to a linked row's evidence signal."""
    return guideline_adjustment(study) + risk_of_bias_adjustment(study)


@dataclass(frozen=True)
class RowStudies:
    """The study links of one metrics set, for its ``MetricsService``."""

    links: SetStudies
    adjustments: dict[str, float]  # study id → its adjustment

    def link(self, combo_idx: int, concept_id: str) -> tuple[str, float] | None:
        """``(study_id, adjustment)`` of a stored row, or None when it links no study."""
        study_id = self.links.study_id(combo_idx, concept_id)
        return (study_id, self.adjustments[study_id]) if study_id is not None else None


class StudyIndex:
    """The study records of one dataset version and the links of its metrics sets.

    Loaded on first use; a store or version without studies costs one check.
    Both the studies set and every metrics set are immutable, so links are
    cached per metrics set for the life of the index (one per version)."""

    def __init__(self, conn: sqlite3.Connection, set_id: int | None):
        self._conn = conn
        self.set_id = set_id
        self._records: dict[str, StudyRecord] | None = None
        self._links: dict[int, RowStudies | None] = {}

    @property
    def records(self) -> dict[str, StudyRecord]:
        """Study id → record, in stored order."""
        if self._records is None:
            self._records = {study.study_id: study for study in repository.load_studies(self._conn, self.set_id)}
        return self._records

    def get(self, study_id: str) -> StudyRecord | None:
        return self.records.get(study_id)

    def for_set(self, metric_set_id: int) -> RowStudies | None:
        """The linked rows of a metrics set, or None when it links no study."""
        if self.set_id is None:
            return None
        if metric_set_id not in self._links:
            records = self.records
            links = repository.set_studies(self._conn, metric_set_id, frozenset(records))
            self._links[metric_set_id] = (
                RowStudies(links, {study_id: study_adjustment(study) for study_id, study in records.items()})
                if links is not None
                else None
            )
        return self._links[metric_set_id]


# ---------------------------------------------------------------- appraisal

def _rounded(value: float) -> float:
    return to_fixed(value, 4)


def is_stored_row(row: MetricValues) -> bool:
    """A condition's own row (or a deeper category's through its anchor) at the requested lens."""
    provenance = row.provenance
    return provenance.source in ("condition", "anchor") and not provenance.lens_fallback


def appraisal(index: StudyIndex, row: MetricValues, *, concept: Concept, use_case: str) -> dict | None:
    """openapi.json ``Appraisal`` of a served row, or None when no study enters it.

    ``concept`` is the concept whose prevalence and chapter the signal used:
    the row's own condition, or for a deeper category its anchor."""
    if is_stored_row(row):
        if row.study_id is None:
            return None
        study = index.get(row.study_id)
        if study is None:
            return None
        applied = row.evidence_signal is not None
        terms = None
        if applied:
            found = grading.evidence_terms(row.validation_type, row.n_studies, row.n_sites, row.peer_reviewed_studies, row.n_samples)
            terms = {
                "type": _rounded(found.type),
                "studies": _rounded(found.studies),
                "sites": _rounded(found.sites),
                "peer": _rounded(found.peer),
                "size": _rounded(found.size),
                "base_signal": _rounded(found.base),
                "penalties": _rounded(sum(grading.evidence_penalties(concept.prevalence_score, use_case, concept.chapter_no))),
                "guideline_adjustment": guideline_adjustment(study),
                "risk_of_bias_adjustment": risk_of_bias_adjustment(study),
                "signal": row.evidence_signal,
                "grade": row.evidence_grade,
            }
        return {"study": study.as_dict(), "study_adjustment": _rounded(study_adjustment(study)), "applied": applied, "terms": terms}
    if not row.study_adjustment:
        return None
    return {"study": None, "study_adjustment": _rounded(row.study_adjustment), "applied": row.evidence_signal is not None, "terms": None}
