"""Safety incidents on the atlas (contract v1.7, CONTRACT.md §18).

An incident names one card (model version × use case), the conditions it
concerns (ICD-11 codes, stored with their depth-1 anchor conditions, or one
whole chapter), and a lens. This module derives what the API serves from them:

* **Severity**: ``serious`` for an open incident in
  which harm occurred or was possible, or an open developer notice or recall;
  ``caution`` for any other open incident and for a mitigated one; none for a
  closed incident (listed, not coloured).
* **Lens rule:** an incident applies to a requested lens when, on each axis,
  its value is ``All …``, equals the requested value, or the request is
  ``All …`` on that axis.
* **Marks:** a condition's mark is the worst severity of the incidents that
  apply to it at the lens; a deeper category takes its anchor's mark; a block
  or chapter the worst mark of its conditions.

Safety incidents never change grades or statuses. All data is synthetic.
"""

from __future__ import annotations

from ..repository import IncidentRecord
from ..schema.contract import AGE_ALL, ETHNICITY_ALL, SEX_ALL
from .atlas import Atlas
from .lru import LruCache
from .types import LENS_CACHE_SIZE, Concept, Lens

SERIOUS, CAUTION = "serious", "caution"
_RANK = {SERIOUS: 2, CAUTION: 1, None: 0}
SAFETY_LEVELS = ("serious", "caution", "none")  # summary counts (view=safety)


def severity(incident: IncidentRecord) -> str | None:
    if incident.status == "open":
        if incident.harm in ("occurred", "possible") or incident.incident_type == "developer_notice_or_recall":
            return SERIOUS
        return CAUTION
    if incident.status == "mitigated":
        return CAUTION
    return None


def worse(first: str | None, second: str | None) -> str | None:
    return first if _RANK[first] >= _RANK[second] else second


def applies(incident: IncidentRecord, lens: Lens) -> bool:
    """The lens rule (CONTRACT.md §18)."""
    for value, requested, all_value in (
        (incident.age, lens.age, AGE_ALL),
        (incident.sex, lens.sex, SEX_ALL),
        (incident.ethnicity, lens.ethnicity, ETHNICITY_ALL),
    ):
        if value != all_value and requested != all_value and value != requested:
            return False
    return True


def incident_payload(incident: IncidentRecord) -> dict:
    """openapi.json ``SafetyIncident``."""
    return {
        "incident_id": incident.incident_id,
        "model_version": incident.model_version,
        "use_case": incident.use_case,
        "codes": list(incident.codes),
        "condition_ids": list(incident.condition_ids),
        "chapter_id": incident.chapter_id,
        "lens": {"age": incident.age, "sex": incident.sex, "ethnicity": incident.ethnicity},
        "incident_type": incident.incident_type,
        "harm": incident.harm,
        "status": incident.status,
        "severity": severity(incident),
        "source_type": incident.source_type,
        "source_reference": incident.source_reference,
        "study_id": incident.study_id,
        "reported_date": incident.reported_date,
        "updated_date": incident.updated_date,
        "summary": incident.summary,
        # Contract v1.13 (§26): a public incident, or one a hospital recorded itself.
        "scope": incident.scope,
    }


def stored_incident_payload(incident: IncidentRecord, atlas: Atlas) -> dict:
    """openapi.json ``StoredIncident`` (contract v1.11): an incident with its codes'
    names and its chapter number, for the Data Library's incident form."""
    by_code = atlas.by_code
    chapter = atlas.by_id.get(incident.chapter_id) if incident.chapter_id else None
    return {
        **incident_payload(incident),
        "code_names": [by_code[code.upper()].pt if code.upper() in by_code else None for code in incident.codes],
        "chapter_no": chapter.chapter_no if chapter is not None else None,
    }


def list_incidents(
    atlas: Atlas, incidents: list[IncidentRecord], *, model_version: str | None = None, use_case: str | None = None
) -> list[dict]:
    """Every stored incident (open, mitigated, and closed), optionally of one AI
    system or one card, newest first (contract v1.11)."""
    chosen = [
        incident
        for incident in incidents
        if (model_version is None or incident.model_version == model_version)
        and (use_case is None or incident.use_case == use_case)
    ]
    return [stored_incident_payload(incident, atlas) for incident in _newest_first(chosen)]


def _newest_first(incidents) -> list[IncidentRecord]:
    ordered = sorted(incidents, key=lambda incident: incident.incident_id)
    return sorted(ordered, key=lambda incident: incident.last_date, reverse=True)


class CardSafety:
    """The incidents of one card, with marks cached per lens."""

    def __init__(self, atlas: Atlas, incidents: list[IncidentRecord], *, lens_cache_size: int = LENS_CACHE_SIZE):
        self.atlas = atlas
        self.incidents = incidents
        # Depth-1 condition → its incidents (chapter incidents expanded).
        self.by_condition: dict[str, list[IncidentRecord]] = {}
        for incident in incidents:
            if incident.chapter_id is not None:
                condition_ids = [condition.concept_id for condition in atlas.conditions_by_chapter.get(incident.chapter_id, ())]
            else:
                condition_ids = list(dict.fromkeys(incident.condition_ids))
            for condition_id in condition_ids:
                self.by_condition.setdefault(condition_id, []).append(incident)
        self._marks: LruCache[dict[str, str]] = LruCache(lens_cache_size)

    def counts(self) -> dict:
        """Catalogue tile counts over every lens: the open incidents by severity
        (``serious`` + ``caution`` = ``open``), and every incident by status."""
        open_severities = [severity(incident) for incident in self.incidents if incident.status == "open"]
        return {
            "serious": open_severities.count(SERIOUS),
            "caution": open_severities.count(CAUTION),
            "open": sum(1 for incident in self.incidents if incident.status == "open"),
            "mitigated": sum(1 for incident in self.incidents if incident.status == "mitigated"),
            "closed": sum(1 for incident in self.incidents if incident.status == "closed"),
        }

    def _condition_marks(self, lens: Lens) -> dict[str, str]:
        """Each depth-1 condition's worst open severity at ``lens`` (conditions without one are absent)."""
        return self._marks.get(lens, lambda: self._marks_at(lens))

    def _marks_at(self, lens: Lens) -> dict[str, str]:
        marks = {}
        for condition_id, incidents in self.by_condition.items():
            mark = None
            for incident in incidents:
                if applies(incident, lens):
                    mark = worse(mark, severity(incident))
            if mark is not None:
                marks[condition_id] = mark
        return marks

    def _conditions_of(self, concept: Concept) -> list[str]:
        """The depth-1 conditions whose incidents a concept shows."""
        if concept.level == 0:
            return [condition.concept_id for condition in self.atlas.conditions_by_chapter.get(concept.concept_id, ())]
        if concept.level == 1:
            return [condition.concept_id for condition in self.atlas.conditions_by_block.get(concept.concept_id, ())]
        if concept.depth == 1:
            return [concept.concept_id]
        anchor = self.atlas.metric_anchor(concept)
        return [anchor.concept_id] if anchor is not None else []

    def mark(self, concept: Concept, lens: Lens) -> str | None:
        """The worst open severity at ``lens`` (``serious``, ``caution``, or None)."""
        return self.mark_of(self._conditions_of(concept), lens)

    def mark_of(self, condition_ids, lens: Lens) -> str | None:
        """The worst open severity at ``lens`` over depth-1 ICD-11 conditions (also
        what another ontology's concept shows through its mapping, contract v1.13)."""
        if not self.by_condition:
            return None
        marks = self._condition_marks(lens)
        mark = None
        for condition_id in condition_ids:
            mark = worse(mark, marks.get(condition_id))
            if mark == SERIOUS:
                break
        return mark

    def concept_incidents(self, concept: Concept, lens: Lens) -> list[dict]:
        """Every incident (closed ones included) that applies to the concept at ``lens``, newest first."""
        return self.incidents_of(self._conditions_of(concept), lens)

    def incidents_of(self, condition_ids, lens: Lens) -> list[dict]:
        """Every incident that applies at ``lens`` to any of these depth-1 ICD-11 conditions, newest first."""
        found: dict[str, IncidentRecord] = {}
        for condition_id in condition_ids:
            for incident in self.by_condition.get(condition_id, ()):
                if incident.incident_id not in found and applies(incident, lens):
                    found[incident.incident_id] = incident
        return [incident_payload(incident) for incident in _newest_first(found.values())]


class SafetyIndex:
    """The incidents of one safety content set, per card."""

    def __init__(self, atlas: Atlas, incidents: list[IncidentRecord]):
        self.atlas = atlas
        self._by_card: dict[tuple[str, str], list[IncidentRecord]] = {}
        for incident in incidents:
            self._by_card.setdefault(incident.key, []).append(incident)
        self._cards: dict[tuple[str, str], CardSafety] = {}

    def card(self, model_version: str, use_case: str) -> CardSafety:
        key = (model_version, use_case)
        card = self._cards.get(key)
        if card is None:
            card = self._cards[key] = CardSafety(self.atlas, self._by_card.get(key, []))
        return card

    def card_incidents(self, model_version: str, use_case: str) -> list[IncidentRecord]:
        return self._by_card.get((model_version, use_case), [])
