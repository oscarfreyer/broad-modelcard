"""The card record: one card as a compact JSON for operational systems (contract v1.14, CONTRACT.md §32.1 and §32.3).

``build_card_record`` gathers what the catalogue, the atlas map, the studies,
the effects, and the safety incidents already serve for one card, at all
patients, Any setting, the default population, in ICD-11:

* the AI system (the catalogue tile's ``system``) and the card (function
  category, intended-use statement, measure, reference standard,
  configuration, declarations, last update);
* the study records its stored rows link, its effects on outcomes, and its
  **public** safety incidents (a hospital's own incidents are a local layer,
  left out like a public release bundle leaves them out, §26.5); the safety
  marks of the record follow those incidents;
* per chapter, the status of every view, the performance value of the
  chapter's rollup, and its safety mark; and the Overview counts of the whole
  card (the catalogue tile's distributions, which equal ``/metrics/summary``);
* links into the atlas and to the narrow model card.

``card_record_jsonld`` returns the same content as JSON-LD, written by hand:
an ``@context`` maps model details, intended use, and quantitative analysis to
Model Card Report Ontology (MCRO) terms and every other key to the product
vocabulary ``bmc:``. Nothing here changes a grade. All data is synthetic
demonstration data.
"""

from __future__ import annotations

import copy
from urllib.parse import quote

from ..schema.contract import CARD_RECORD_NOTICE, SYNTHETIC_DATA_NOTICE
from .. import repository
from .catalog import Catalog
from .dataset import Dataset
from .incidents import CardSafety, _newest_first, incident_payload
from .links import atlas_url
from .presentation import rollup_child_count, statuses
from .summary import safety_summary
from .types import ALL_POPULATIONS

CARD_RECORD_FORMAT = "bmc-card-record/1"
API_ROOT = "/api/v1"

# JSON-LD (§32.3). The product vocabulary has a stable base IRI under an
# .example domain (documented, never dereferenced by the product).
BMC_VOCABULARY = "https://broad-modelcard.example/vocab#"
BMC_CARDS = "https://broad-modelcard.example/cards/"
OBO = "http://purl.obolibrary.org/obo/"
# Every MCRO term the record uses, with its rdfs:label in mcro.ttl
# (github.com/UTHealth-Ontology/MCRO, read 2026-10-22), and BFO's "has part"
# for the sections. A test pins this list.
MCRO_TERMS: dict[str, str] = {
    "MCRO_0000001": "Model Card Report",
    "MCRO_0000021": "Model Detail Section",
    "MCRO_0000040": "Version Information Section",
    "MCRO_0000038": "Use Case Information Section",
    "MCRO_0000031": "Quantative Analysis Section",
    "MCRO_0000027": "Performance Metric Information Section",
    "MCRO_0000008": "Evaluation Data Information Section",
    "MCRO_0000045": "documentation",
    "MCRO_0000049": "performance metric value",
}
HAS_PART = "obo:BFO_0000051"


def _public_safety(dataset: Dataset, model: str, use_case: str) -> tuple[list, CardSafety]:
    incidents = [incident for incident in dataset.safety.card_incidents(model, use_case) if incident.scope == "public"]
    return incidents, CardSafety(dataset.atlas, incidents)


def _linked_studies(dataset: Dataset, model: str, use_case: str) -> list[dict]:
    """The public study records the card's stored rows name (§22's link), in stored order."""
    set_id = dataset.state.metric_sets.get((model, use_case))
    if set_id is None:
        return []
    named = repository.named_studies(dataset.connection, set_id)
    return [
        study.as_dict() for study_id, study in dataset.studies.records.items()
        if study_id in named and study.scope == "public"
    ]


def _chapter(metrics, safety: CardSafety, chapter, counts: dict | None, intended_use_defined: bool) -> dict:
    row = metrics.row(chapter.concept_id, ALL_POPULATIONS)
    empty = row is None or rollup_child_count(row) == 0  # a rollup without children reads No data (§6, V1)
    shown = statuses(None if empty else row)
    level = None if empty else row.intended_use_level
    return {
        "chapter_id": chapter.concept_id,
        "chapter_no": chapter.chapter_no,
        "name": chapter.pt,
        "condition_count": counts["condition_count"] if counts else 0,
        "overall": shown["overall"],
        "performance": shown["performance"],
        "evidence": shown["evidence"],
        "intended_use": (level or "no_data") if intended_use_defined else None,
        "perf": None if empty else row.perf,
        "ci_low": None if empty else row.ci_low,
        "ci_high": None if empty else row.ci_high,
        "safety": safety.mark(chapter, ALL_POPULATIONS),
        "overall_counts": counts["overall"] if counts else None,
    }


def _query(model: str, use_case: str) -> str:
    return f"model={quote(model, safe='')}&use_case={quote(use_case, safe='')}"


def build_card_record(dataset: Dataset, catalog: Catalog, catalogue: dict, *, model: str, use_case: str, label: str) -> dict:
    """The ``CardRecord`` body (call under ``Store.lock``). Raises the services'
    ``UnknownModel`` / ``UnknownUseCase`` for a card the version lacks."""
    entry = dataset.model(model)  # 404 unknown_model
    metrics = dataset.metrics(model, use_case)  # 404 unknown_use_case
    tile = next(tile for tile in catalogue["tiles"] if tile["model_version"] == model and tile["use_case"] == use_case)
    incidents, safety = _public_safety(dataset, model, use_case)
    intended_use_defined = tile.get("intended_use_defined", True)
    by_chapter = {chapter["chapter_id"]: chapter for chapter in tile["chapters"]}
    marks = safety_summary(catalog, safety, ALL_POPULATIONS)["safety_counts"]
    card = {
        "function_category": tile["function_category"],
        "is_default_use_case": tile["is_default_use_case"],
        "intended_use_defined": intended_use_defined,
        "declarations": tile["declarations"],
        "has_multimorbidity": tile["has_multimorbidity"],
        "last_updated": tile["last_updated"],
    }
    for key in ("configuration", "performance_measure", "reference_standard"):
        if key in tile:
            card[key] = tile[key]
    query = _query(model, use_case)
    has_narrow_card = dataset.state.model_cards_set_id is not None and any(
        stored.model_version == model for stored in repository.load_model_cards(dataset.connection, dataset.state.model_cards_set_id)
    )
    return {
        "format": CARD_RECORD_FORMAT,
        "dataset_version": label,
        "generated": {
            "notice": CARD_RECORD_NOTICE,
            "synthetic_data_notice": SYNTHETIC_DATA_NOTICE,
            "classification": "ICD-11 MMS",
            "lens": {"context": dataset.atlas.axes.context[0], **ALL_POPULATIONS.as_dict()},
            "prevalence": "default",
        },
        "card_id": tile["card_id"],
        "model_version": model,
        "use_case": use_case,
        "system": {**tile["system"], "display_name": entry.display_name},
        "card": card,
        "summary": {
            "condition_count": catalogue["condition_count"],
            **tile["distribution"],
            "safety": marks,
        },
        "chapters": [
            _chapter(metrics, safety, chapter, by_chapter.get(chapter.concept_id), intended_use_defined)
            for chapter in catalog.chapters
        ],
        "studies": _linked_studies(dataset, model, use_case),
        "effects": dataset.effects.listed(model_version=model, use_case=use_case),
        "incidents": [incident_payload(incident) for incident in _newest_first(incidents)],
        "links": {
            "atlas": atlas_url(model=model, use_case=use_case, view="overall"),
            "record": f"{API_ROOT}/cards/record?{query}",
            "record_jsonld": f"{API_ROOT}/cards/record?{query}&format=jsonld",
            "narrow_model_card": f"{API_ROOT}/models/{quote(model, safe='')}/narrow-model-card" if has_narrow_card else None,
        },
    }


# ------------------------------------------------------------------ JSON-LD

def jsonld_context() -> dict:
    """The record's ``@context`` (§32.3): MCRO for model details, intended use, and
    quantitative analysis; ``bmc:`` (``@vocab``) for everything else."""
    return {
        "@version": 1.1,
        "@vocab": BMC_VOCABULARY,
        "bmc": BMC_VOCABULARY,
        "obo": OBO,
        "xsd": "http://www.w3.org/2001/XMLSchema#",
        # Sections of the report: BFO "has part".
        "system": {"@id": HAS_PART},
        "card": {"@id": HAS_PART},
        "summary": {"@id": HAS_PART},
        "chapters": {"@id": HAS_PART, "@container": "@list"},
        "studies": {"@id": HAS_PART, "@container": "@list"},
        # Quantitative analysis: the performance value of a chapter's rollup.
        "perf": {"@id": "obo:MCRO_0000049", "@type": "xsd:decimal"},
        # Intended use: the developer's statement of the intended purpose.
        "declared_intended_purpose": {"@id": "obo:MCRO_0000045"},
    }


def card_record_jsonld(record: dict) -> dict:
    """The same content as JSON-LD (contract v1.14, §32.3), without changing ``record``."""
    body = copy.deepcopy(record)
    body["system"]["@type"] = "obo:MCRO_0000021"  # Model Detail Section
    card = body["card"]
    card["@type"] = "obo:MCRO_0000038"  # Use Case Information Section (intended use)
    if "configuration" in card and card["configuration"] is not None:
        card["configuration"]["@type"] = "obo:MCRO_0000040"  # Version Information Section
    body["summary"]["@type"] = "obo:MCRO_0000031"  # Quantative Analysis Section
    for chapter in body["chapters"]:
        chapter["@type"] = "obo:MCRO_0000027"  # Performance Metric Information Section
    for study in body["studies"]:
        study["@type"] = "obo:MCRO_0000008"  # Evaluation Data Information Section
    return {
        "@context": jsonld_context(),
        "@id": f"{BMC_CARDS}{quote(record['card_id'], safe='')}/v{record['dataset_version']}",
        "@type": "obo:MCRO_0000001",  # Model Card Report
        **body,
    }
