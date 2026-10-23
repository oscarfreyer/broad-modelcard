"""Constants of the data and API contract (backend/CONTRACT.md, backend/openapi.json).

The Pydantic response models of the API are in app/api/schemas.py.
"""

from __future__ import annotations

# The 13-field metric tuple of the legacy JSON tables and of the store.
METRIC_ROW_FORMAT: tuple[str, ...] = (
    "perf",
    "ci_low",
    "ci_high",
    "evidence_grade",
    "n_samples",
    "n_sites",
    "n_studies",
    "peer_reviewed_studies",
    "validation_type",
    "in_intended_use",
    "intended_use_coverage",
    "intended_use_level",
    "warnings",
)

GRADES: tuple[str, ...] = ("A", "B", "C", "D", "E", "F")

PREVALENCE_TIERS: tuple[str, ...] = ("very_rare", "rare", "uncommon", "common", "very_common")

DATASET_KINDS: tuple[str, ...] = (
    "models", "metrics", "multimorbidity", "prevalence", "safety", "population", "studies", "effects", "local_metrics",
    "model_cards",
)
# Contract v1.13 (CONTRACT.md §26): the kinds a public release bundle carries
# (the public layers); a hospital instance keeps its local layers (population,
# local_metrics) when it imports one. Studies and safety incidents are split by
# their scope (public or hospital).
PUBLIC_LAYER_KINDS: tuple[str, ...] = (
    "models", "metrics", "multimorbidity", "prevalence", "safety", "studies", "effects", "model_cards"
)

# The instance profile (D15): a public service or a hospital version.
INSTANCE_KINDS: tuple[str, ...] = ("public", "hospital")
DEFAULT_INSTANCE = {
    "kind": "public",
    "organisation": "Broad Modelcard (demonstration)",
    "maintained_by": "the Broad Modelcard project",
    "contact": None,
}
MAX_INSTANCE_TEXT = 120
MAX_INSTANCE_CONTACT = 200
# Contract v1.14 (§26.2): the hospital's data-protection note.
MAX_INSTANCE_DATA_PROTECTION_NOTE = 500
# Role workspaces without login (D7): the role a publish is made in, and the
# name entered with it. A developer submits; only the other roles publish.
PUBLISHER_ROLES: tuple[str, ...] = ("developer", "custodian", "hospital", "maintainer")
MAX_PUBLISHER_NAME = 80
# Card ids join a model version and a function with "|" (``card_id``), and the
# comparison lists card ids with "," (CONTRACT.md §11.1, §25), so neither may
# appear in an AI system's model version or a function's name.
CARD_NAME_RESERVED: tuple[str, ...] = ("|", ",")


def reserved_in_name(name: str) -> tuple[str, ...]:
    """The card-id separators a model version or function name contains, in order."""
    return tuple(char for char in CARD_NAME_RESERVED if char in name)


# A narrow model card (D14) as submitted: JSON or Markdown text, at most 1 MB.
MODEL_CARD_FORMATS: tuple[str, ...] = ("json", "markdown")
MAX_MODEL_CARD_BYTES = 1024 * 1024

# Contract v1.14 (CONTRACT.md §32.2): the output of a benchmark or
# evaluation harness run outside the product, as one JSON file for one card. It
# is an upload kind, not a data set: it is checked and offers proposed records,
# and never publishes. At most 1 MB, like a narrow model card.
EVALUATION_RESULTS_KIND = "evaluation_results"
EVALUATION_RESULTS_FORMAT = "bmc-evaluation-results/1"
MAX_EVALUATION_BYTES = 1024 * 1024
MAX_EVALUATION_RESULTS = 5_000
UPLOAD_KINDS: tuple[str, ...] = (*DATASET_KINDS, EVALUATION_RESULTS_KIND)

# Local populations (contract v1.10, CONTRACT.md §21): named local prevalence
# sets that replace the default tiers of the codes they list, for the reads
# that name them. Ids are short slugs; names are shown on every view that uses
# a population.
POPULATION_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,39}$"
MAX_POPULATION_NAME = 80

# Upload modes (contract v1.7, CONTRACT.md §11.2): ``replace`` swaps the whole
# data set (or the target's data); ``merge`` adds, replaces, or removes single
# records and keeps every other record as it is.
UPLOAD_MODES: tuple[str, ...] = ("replace", "merge")
MERGE_KINDS: tuple[str, ...] = ("metrics", "prevalence", "safety", "studies", "effects", "local_metrics")
MAX_NOTE = 500  # change notes on publish and rollback (contract v1.7)

# Studies and appraisal (contract v1.13, CONTRACT.md §22): one
# global data set of study records. A stored metric row links to a study when
# its row source's Study equals a Study ID of the live set (exact match).
STUDY_ID_PATTERN = r"^[A-Za-z0-9._-]{1,64}$"
STUDY_DESIGNS: tuple[str, ...] = (
    "vignette",
    "simulation",
    "benchmark",
    "retrospective",
    "prospective",
    "real_world_deployment",
    "randomized_trial",
)
STUDY_CONDUCTORS: tuple[str, ...] = ("developer", "independent", "hospital")
REPORTING_GUIDELINES: tuple[str, ...] = ("none", "tripod_ai", "stard_ai", "consort_ai", "decide_ai", "other")
GUIDELINE_FOLLOWED: tuple[str, ...] = ("yes", "partly", "no")
RISK_OF_BIAS: tuple[str, ...] = ("low", "some_concerns", "high", "unclear")
# The change to the evidence signal of a linked row (D5): added
# with the §4.2 penalties, before the final clamp. Published in
# /meta.evidence_study_adjustments. Only a followed guideline ("yes") counts.
GUIDELINE_FOLLOWED_ADJUSTMENT = 0.05
RISK_OF_BIAS_ADJUSTMENTS: dict[str, float] = {"low": 0.0, "some_concerns": -0.04, "high": -0.10, "unclear": -0.04}
# Contract v1.14 (CONTRACT.md §22): optional study fields
# that are shown in Study quality and **never graded**: applicability concerns
# (PROBAST+AI style overall judgement), the appraisal tool and its score, the
# setting category, and the configuration evaluated (a label, not checked
# against the registry).
APPLICABILITY: tuple[str, ...] = ("low", "high", "unclear")
QUALITY_TOOLS: tuple[str, ...] = ("probast_ai", "appraise_ai", "quadas_ai", "other")
QUALITY_SCORE_RANGE: tuple[float, float] = (0.0, 100.0)
# The first five are the specific care settings of the setting lens.
SETTING_CATEGORIES: tuple[str, ...] = (
    "emergency_department", "intensive_care", "inpatient_ward", "outpatient_clinic", "primary_care", "mixed",
)
STUDY_CONFIGURATION_ID_PATTERN = STUDY_ID_PATTERN

# Intervention effects (contract v1.13, CONTRACT.md §27): what
# using an AI system changed for patients or care, against a comparator, from a
# study that compared care with and without it. Global data set keyed by
# effect_id, like safety. **Effects never enter a grade, status, Overview,
# comparison flag, or summary**; the grades cover predictive performance only.
EFFECT_ID_PATTERN = STUDY_ID_PATTERN
EFFECT_OUTCOME_TYPES: tuple[str, ...] = ("benefit", "harm", "process")
# Ratio measures (null value 1, drawn on a log scale) and difference measures (null value 0).
EFFECT_RATIO_MEASURES: tuple[str, ...] = ("risk_ratio", "odds_ratio", "hazard_ratio")
EFFECT_DIFFERENCE_MEASURES: tuple[str, ...] = ("risk_difference", "mean_difference", "standardized_mean_difference")
EFFECT_MEASURES: tuple[str, ...] = EFFECT_RATIO_MEASURES + EFFECT_DIFFERENCE_MEASURES
EFFECT_DIRECTIONS: tuple[str, ...] = ("higher_is_better", "lower_is_better")
# Design-specific appraisal: RoB 2 for randomized trials, ROBINS-I for
# non-randomized studies of interventions. Critical exists in ROBINS-I only.
EFFECT_APPRAISAL_TOOLS: tuple[str, ...] = ("rob2", "robins_i")
EFFECT_JUDGEMENTS: tuple[str, ...] = ("low", "some_concerns", "high", "critical", "unclear")
# Study designs that can carry an effect on outcomes (care with and without the
# AI system compared); the tool each needs.
EFFECT_STUDY_DESIGNS: dict[str, str] = {
    "randomized_trial": "rob2",
    "prospective": "robins_i",
    "real_world_deployment": "robins_i",
}

# Safety incidents (contract v1.7, CONTRACT.md §18). Safety never changes grades.
INCIDENT_TYPES: tuple[str, ...] = (
    "harmful_recommendation",
    "fabricated_content",
    "subgroup_bias",
    "performance_drift",
    "developer_notice_or_recall",
    "other",
)
INCIDENT_HARMS: tuple[str, ...] = ("occurred", "possible", "none")
INCIDENT_STATUSES: tuple[str, ...] = ("open", "mitigated", "closed")
INCIDENT_SOURCE_TYPES: tuple[str, ...] = ("study", "incident_report", "developer_notice")

# Registry entry fields (contract v1.5, CONTRACT.md §11). An entry ("AI system"
# in the UI) is a model or a product; an entry without a kind is a model.
ENTRY_KINDS: tuple[str, ...] = ("model", "product")
DEFAULT_ENTRY_KIND = "model"
AI_TYPES: tuple[str, ...] = ("llm", "imaging", "tabular_risk", "rule_based", "hybrid")
# Per configuration (entry × use case; "Function" in the UI).
# Contract v1.14 (F13) adds patient_communication and administrative; the rules
# keyed on use-case names (§4.2, §4.6) do not read the category.
FUNCTION_CATEGORIES: tuple[str, ...] = (
    "decision_support", "documentation", "image_analysis", "triage", "patient_communication", "administrative",
)
# Developer declarations per configuration, in this order.
DECLARATION_FIELDS: tuple[str, ...] = (
    "declared_intended_purpose",
    "declared_regulatory_status",
    "declared_contact",
    "declared_documentation_url",
)
# Contract v1.14 (§28): the developer's data-protection
# declarations, also in ``declarations``; served only when one is given, so a
# configuration without them reads as before.
DATA_PROTECTION_FIELDS: tuple[str, ...] = (
    "declared_data_use",
    "declared_data_location",
    "declared_retention",
    "declared_privacy_contact",
)
# Contract v1.14 (§28.1): the configuration record of a card, in
# this order (``configuration`` in listModels and the catalogue).
CONFIGURATION_RECORD_FIELDS: tuple[str, ...] = (
    "configuration_id",
    "configuration_date",
    "prompt_summary",
    "prompt_sha256",
    "retrieval",
    "tools",
    "sampling_temperature",
    "sampling_top_p",
    "sampling_max_output_tokens",
    "fine_tuning",
)
# Contract v1.14 (§28.1): what a card's figures measure, against what.
MEASURE_FIELDS: tuple[str, ...] = ("performance_measure", "reference_standard")
CONFIGURATION_ID_PATTERN = r"^[A-Za-z0-9._-]{1,64}$"
PROMPT_SHA256_PATTERN = r"^[0-9a-f]{64}$"
MAX_PROMPT_SUMMARY = 500
MAX_CONFIGURATION_TEXT = 280  # retrieval, fine-tuning
MAX_TOOLS = 10
MAX_TOOL_NAME = 60
TOOL_SEPARATOR = ";"
MAX_MEASURE_TEXT = 200  # performance measure, reference standard
MAX_DATA_USE = 500
MAX_DATA_PROTECTION_TEXT = 200  # data location, retention, privacy contact
SAMPLING_TEMPERATURE_RANGE = (0.0, 2.0)
SAMPLING_TOP_P_RANGE = (0.0, 1.0)

# A stored metric row without an intended-use value (contract v1.11): blank
# intended-use cells in an upload. The store keeps ``intended_use_level`` NOT
# NULL, so such a row is stored with this empty level, ``in_intended_use`` 0,
# and a NULL coverage, and the API serves all three as null.
NO_INTENDED_USE_LEVEL = ""

IN_SCOPE = "in_scope"
PARTIALLY_IN_SCOPE = "partially_in_scope"
OUT_OF_SCOPE = "out_of_scope"

AGE_ALL = "All ages"
SEX_ALL = "All sexes"
ETHNICITY_ALL = "All ethnicities"
DEFAULT_CONTEXT = "Clinical"
# Contract v1.14 (CONTRACT.md §29): the care-setting lens. The
# Context axis keeps its first value, ``Clinical`` (shown as "Any setting"),
# for every row stored before; the specific settings follow it, in this
# order, as axis values (migration 0013). They are the first five study
# setting categories (``SETTING_CATEGORIES``): one vocabulary for the lens,
# the studies, and the lookup's ``context.setting``. Code → axis value.
ANY_SETTING = DEFAULT_CONTEXT
CARE_SETTINGS: dict[str, str] = {
    "emergency_department": "Emergency department",
    "intensive_care": "Intensive care",
    "inpatient_ward": "Inpatient ward",
    "outpatient_clinic": "Outpatient clinic",
    "primary_care": "Primary care",
}
assert tuple(CARE_SETTINGS) == SETTING_CATEGORIES[:5], "the care settings are the first five study setting categories"
# Every Context axis value, Any setting first (/meta.axes.context).
CONTEXTS: tuple[str, ...] = (ANY_SETTING, *CARE_SETTINGS.values())
# Axis value → code (the atlas URL's ``setting`` parameter, the lookup's ``context.setting``).
CARE_SETTING_CODES: dict[str, str] = {label: code for code, label in CARE_SETTINGS.items()}

# Use cases that get conservative (20th percentile) rollups and CDSS safeguards.
CDSS_USE_CASES = frozenset({"Clinician Facing CDSS", "CDSS"})

# The evidence penalty for chapter 06 applies to this exact use case only
# (CONTRACT.md §12 quirk).
CHAPTER_06_PENALTY_USE_CASE = "Clinician Facing CDSS"

# Metric views of the atlas (MetricView in openapi.json).
VIEWS: tuple[str, ...] = ("overall", "performance", "evidence", "intended_use")

# ``not_validated`` was merged into ``no_data`` in contract v1.11.
STATUSES: tuple[str, ...] = ("strong", "moderate", "weak", "out_of_scope", "no_data")

# The frontend's notice in other words (CatalogueApp.jsx CATALOGUE_NOTICE),
# plus the clinical-use limit the exports and the live panel need. It no
# longer forbids "procurement decisions": procurement is one of the named
# audiences, and "not real evidence about any AI system" is the honest limit.
SYNTHETIC_DATA_NOTICE = (
    "Demonstration only: all data in Broad Modelcard is synthetic and is not real evidence "
    "about any AI system. Not for clinical use."
)
# Contract v1.14 (CONTRACT.md §32, §33): the line the card record and every CDS
# Hooks card carry, so an operational system never reads a record as a verdict.
CARD_RECORD_NOTICE = (
    "Synthetic demonstration data. Not a certification, an approval, or evidence about any real AI system. "
    "Not for clinical use."
)
CDS_SYNTHETIC_LINE = "Demonstration on synthetic data, not for clinical use."


def measure_key(value: str) -> str:
    """A performance measure as ``measure_differs`` and the evaluation import compare it (§25,
    §32.2): case and runs of spacing do not count. lower(), as the static port (staticComparison.js)."""
    return " ".join(value.split()).lower()
