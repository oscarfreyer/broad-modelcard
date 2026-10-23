"""Upload templates: the columns of each data set's CSV/XLSX file (Track A3).

One template per data set kind (``DATASET_KINDS``). Every data row is one
record; the header row names the columns. Header matching ignores case,
spacing, and punctuation, so ``CI low``, ``ci_low``, and ``CI-low`` are the
same column. backend/README.md documents the templates for maintainers.

* ``models``: one row per AI system × function (a card).
* ``metrics``: one row per condition × demographic lens, for the one card
  chosen at upload.
* ``multimorbidity``: one row per condition set × demographic lens, for the
  one card chosen at upload.
* ``prevalence``: one row per ICD-11 code.
* ``safety``: one row per safety incident (contract v1.7).
* ``population``: one row per ICD-11 code of one local population, chosen
  at upload (contract v1.10); the prevalence columns. Aggregate data only.

The 13 metric fields (``METRIC_ROW_FORMAT``) appear as readable columns in the
same order. Metrics and prevalence also take the optional Action, Source,
Study, and Source date columns (contract v1.7): a merge upload uses them to
remove rows and to say where each row comes from. All data is synthetic
demonstration data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .contract import (
    AGE_ALL,
    AI_TYPES,
    ANY_SETTING,
    CARE_SETTINGS,
    DATASET_KINDS,
    ENTRY_KINDS,
    ETHNICITY_ALL,
    FUNCTION_CATEGORIES,
    IN_SCOPE,
    INCIDENT_HARMS,
    INCIDENT_SOURCE_TYPES,
    INCIDENT_STATUSES,
    INCIDENT_TYPES,
    METRIC_ROW_FORMAT,
    GUIDELINE_FOLLOWED,
    OUT_OF_SCOPE,
    PARTIALLY_IN_SCOPE,
    REPORTING_GUIDELINES,
    RISK_OF_BIAS,
    SEX_ALL,
    STUDY_CONDUCTORS,
    STUDY_DESIGNS,
    EFFECT_APPRAISAL_TOOLS,
    EFFECT_DIRECTIONS,
    EFFECT_JUDGEMENTS,
    EFFECT_MEASURES,
    EFFECT_OUTCOME_TYPES,
    APPLICABILITY,
    QUALITY_TOOLS,
    SETTING_CATEGORIES,
    MAX_CONFIGURATION_TEXT,
    MAX_DATA_USE,
    MAX_MEASURE_TEXT,
    MAX_PROMPT_SUMMARY,
    MAX_TOOL_NAME,
    MAX_TOOLS,
    TOOL_SEPARATOR,
)

PATIENT_DATA_NOTICE = (
    "Aggregate synthetic data only. Never upload patient-level or real patient data."
)

DATASET_TITLES = {
    "models": "AI systems & functions",
    "metrics": "Performance metrics",
    "multimorbidity": "Multimorbidity",
    "prevalence": "Prevalence",
    "safety": "Safety incidents",
    "population": "Local populations",
    "studies": "Studies",
    "local_metrics": "Local results",
    "model_cards": "Narrow model cards",
    "effects": "Effects on outcomes",
}

# Readable labels offered in dropdowns. Uploads also accept the codes
# themselves (``clinical_study_multisite``, ``in_scope``, ``very_rare``).
VALIDATION_TYPE_LABELS = {
    "clinical_study_multisite": "Clinical study (multisite)",
    "clinical_study_single_site": "Clinical study (single site)",
    "benchmark": "Benchmark",
    "vignette_study": "Vignette study",
    "simulation_study": "Simulation study",
    "internal_test": "Internal test",
}
INTENDED_USE_LEVEL_LABELS = {
    IN_SCOPE: "In scope",
    PARTIALLY_IN_SCOPE: "Partially in scope",
    OUT_OF_SCOPE: "Out of scope",
}
PREVALENCE_TIER_LABELS = {
    "very_rare": "Very rare",
    "rare": "Rare",
    "uncommon": "Uncommon",
    "common": "Common",
    "very_common": "Very common",
}
MODEL_STATUSES = ("ACTIVE", "EXPERIMENTAL")
# Registry entry fields (contract v1.5). Uploads accept the label or the code.
ENTRY_KIND_LABELS = {"model": "Model", "product": "Product"}
AI_TYPE_LABELS = {
    "llm": "Large language model",
    "imaging": "Imaging model",
    "tabular_risk": "Tabular risk model",
    "rule_based": "Rule-based system",
    "hybrid": "Hybrid",
}
FUNCTION_CATEGORY_LABELS = {
    "decision_support": "Decision support",
    "documentation": "Documentation",
    "image_analysis": "Image analysis",
    "triage": "Triage",
    "patient_communication": "Patient communication",
    "administrative": "Administrative",
}
# Safety incidents (contract v1.7).
INCIDENT_TYPE_LABELS = {
    "harmful_recommendation": "Harmful or incorrect recommendation",
    "fabricated_content": "Fabricated content",
    "subgroup_bias": "Subgroup bias",
    "performance_drift": "Performance drift",
    "developer_notice_or_recall": "Developer notice or recall",
    "other": "Other",
}
HARM_LABELS = {"occurred": "Occurred", "possible": "Possible", "none": "None"}
INCIDENT_STATUS_LABELS = {"open": "Open", "mitigated": "Mitigated", "closed": "Closed"}
SOURCE_TYPE_LABELS = {"study": "Study", "incident_report": "Incident report", "developer_notice": "Developer notice"}
assert tuple(INCIDENT_TYPE_LABELS) == INCIDENT_TYPES
assert tuple(HARM_LABELS) == INCIDENT_HARMS
assert tuple(INCIDENT_STATUS_LABELS) == INCIDENT_STATUSES
assert tuple(SOURCE_TYPE_LABELS) == INCIDENT_SOURCE_TYPES
MAX_SUMMARY = 280
# Studies (contract v1.13, CONTRACT.md §22). Uploads accept the label or the code.
STUDY_DESIGN_LABELS = {
    "vignette": "Vignette",
    "simulation": "Simulation",
    "benchmark": "Benchmark",
    "retrospective": "Retrospective",
    "prospective": "Prospective",
    "real_world_deployment": "Real-world deployment",
    "randomized_trial": "Randomized trial",
}
STUDY_CONDUCTOR_LABELS = {"developer": "Developer", "independent": "Independent", "hospital": "Hospital"}
REPORTING_GUIDELINE_LABELS = {
    "none": "None",
    "tripod_ai": "TRIPOD+AI",
    "stard_ai": "STARD-AI",
    "consort_ai": "CONSORT-AI",
    "decide_ai": "DECIDE-AI",
    "other": "Other",
}
GUIDELINE_FOLLOWED_LABELS = {"yes": "Yes", "partly": "Partly", "no": "No"}
RISK_OF_BIAS_LABELS = {"low": "Low", "some_concerns": "Some concerns", "high": "High", "unclear": "Unclear"}
# Contract v1.13 (§26): public records, or a hospital's own.
SCOPE_LABELS = {"public": "Public", "hospital": "Hospital"}
assert tuple(STUDY_DESIGN_LABELS) == STUDY_DESIGNS
assert tuple(STUDY_CONDUCTOR_LABELS) == STUDY_CONDUCTORS
assert tuple(REPORTING_GUIDELINE_LABELS) == REPORTING_GUIDELINES
assert tuple(GUIDELINE_FOLLOWED_LABELS) == GUIDELINE_FOLLOWED
assert tuple(RISK_OF_BIAS_LABELS) == RISK_OF_BIAS
# Contract v1.14 (§22): optional, never graded.
APPLICABILITY_LABELS = {"low": "Low", "high": "High", "unclear": "Unclear"}
QUALITY_TOOL_LABELS = {"probast_ai": "PROBAST+AI", "appraise_ai": "APPRAISE-AI", "quadas_ai": "QUADAS-AI", "other": "Other"}
SETTING_CATEGORY_LABELS = {
    "emergency_department": "Emergency department",
    "intensive_care": "Intensive care",
    "inpatient_ward": "Inpatient ward",
    "outpatient_clinic": "Outpatient clinic",
    "primary_care": "Primary care",
    "mixed": "Mixed",
}
assert tuple(APPLICABILITY_LABELS) == APPLICABILITY
assert tuple(QUALITY_TOOL_LABELS) == QUALITY_TOOLS
assert tuple(SETTING_CATEGORY_LABELS) == SETTING_CATEGORIES
# Contract v1.14 (§29): one wording for a study's setting category and the setting lens.
assert all(SETTING_CATEGORY_LABELS[code] == label for code, label in CARE_SETTINGS.items())
MAX_STUDY_TITLE = 200
MAX_STUDY_TEXT = 280  # setting, population
MAX_STUDY_NOTES = 500  # evaluation conditions, risk-of-bias notes
# Intervention effects (contract v1.13, CONTRACT.md §27). Uploads accept the label or the code.
OUTCOME_TYPE_LABELS = {"benefit": "Benefit", "harm": "Harm", "process": "Process"}
EFFECT_MEASURE_LABELS = {
    "risk_ratio": "Risk ratio",
    "odds_ratio": "Odds ratio",
    "hazard_ratio": "Hazard ratio",
    "risk_difference": "Risk difference",
    "mean_difference": "Mean difference",
    "standardized_mean_difference": "Standardized mean difference",
}
EFFECT_DIRECTION_LABELS = {"higher_is_better": "Higher is better", "lower_is_better": "Lower is better"}
APPRAISAL_TOOL_LABELS = {"rob2": "RoB 2", "robins_i": "ROBINS-I"}
EFFECT_JUDGEMENT_LABELS = {
    "low": "Low",
    "some_concerns": "Some concerns",
    "high": "High",
    "critical": "Critical",
    "unclear": "Unclear",
}
assert tuple(OUTCOME_TYPE_LABELS) == EFFECT_OUTCOME_TYPES
assert tuple(EFFECT_MEASURE_LABELS) == EFFECT_MEASURES
assert tuple(EFFECT_DIRECTION_LABELS) == EFFECT_DIRECTIONS
assert tuple(APPRAISAL_TOOL_LABELS) == EFFECT_APPRAISAL_TOOLS
assert tuple(EFFECT_JUDGEMENT_LABELS) == EFFECT_JUDGEMENTS
MAX_OUTCOME = 200
MAX_EFFECT_TEXT = 280  # population, comparator
MAX_EFFECT_UNIT = 40
MAX_FOLLOW_UP = 120
MAX_EFFECT_NOTES = 500
# The Action column of merge uploads (contract v1.7). An empty cell adds or
# replaces the row; Remove deletes its key.
ACTION_UPSERT, ACTION_REMOVE = "upsert", "remove"
ACTION_LABELS = {ACTION_UPSERT: "Add or replace", ACTION_REMOVE: "Remove"}
CHAPTER_PREFIX = "chapter"
CODE_SEPARATOR = ";"
assert tuple(ENTRY_KIND_LABELS) == ENTRY_KINDS
assert tuple(AI_TYPE_LABELS) == AI_TYPES
assert tuple(FUNCTION_CATEGORY_LABELS) == FUNCTION_CATEGORIES
# Longest values of the free-text registry fields.
MAX_DESCRIPTION = 280
MAX_DECLARATION = 500
YES, NO = "Yes", "No"
YES_NO = (YES, NO)

# Separators inside one cell.
WARNING_SEPARATOR = ";"
BUILT_ON_SEPARATOR = ";"
CONDITION_SEPARATOR = "+"


@dataclass(frozen=True)
class Column:
    key: str
    header: str
    help: str
    # The column must be present in an upload. Informational columns
    # (``info=True``) are optional and ignored.
    required: bool = True
    info: bool = False
    # Name of the allowed-value list for dropdowns ("lens:age", "grades", ...).
    choices: str | None = None
    width: int = 14
    aliases: tuple[str, ...] = ()


def normalize_header(value: object) -> str:
    """Lower case, with every run of non-alphanumerics as one space."""
    return re.sub(r"[^a-z0-9]+", " ", str(value if value is not None else "").lower()).strip()


# Columns the annotated file adds; ignored when the file is uploaded again.
PROBLEMS_COLUMN = Column("problems", "Problems", "Problems found in this row (annotated files only).", required=False, info=True, width=60)

_LENS_COLUMNS = (
    Column("age", "Age", f'Age group, e.g. "{AGE_ALL}" or "Age 65+".', choices="lens:age", width=12),
    Column("sex", "Sex", f'"{SEX_ALL}", "Sex Female", or "Sex Male".', choices="lens:sex", width=12),
    Column("ethnicity", "Ethnicity", f'Ethnicity group, e.g. "{ETHNICITY_ALL}".', choices="lens:ethnicity", width=18),
)

# Contract v1.14 (CONTRACT.md §29): the care setting of a metrics or local results row.
# Optional: a file without the column (or an empty cell) stores Any setting, as before.
ANY_SETTING_LABEL = "Any setting"
SETTING_LABELS = {ANY_SETTING: ANY_SETTING_LABEL, **{label: label for label in CARE_SETTINGS.values()}}
SETTING_COLUMN = Column(
    "setting",
    "Setting",
    f'Care setting: "{ANY_SETTING_LABEL}" (or empty) for a result that holds across settings, or '
    + ", ".join(f'"{label}"' for label in CARE_SETTINGS.values())
    + " for a result measured in that setting only.",
    required=False,
    choices="settings",
    aliases=("care setting", "context"),
    width=20,
)

_METRIC_COLUMNS = (
    Column("perf", "Performance", "Performance between 0 and 1 (e.g. 0.84). Empty: no performance data.", aliases=("perf",), width=13),
    Column("ci_low", "CI low", "Lower bound of the 95% confidence interval, 0 to 1. Not above Performance.", width=9),
    Column("ci_high", "CI high", "Upper bound of the 95% confidence interval, 0 to 1. Not below Performance.", width=9),
    Column("evidence_grade", "Evidence grade", "Source evidence grade A to F (the atlas derives its own grade from the study details).", choices="grades", width=10),
    Column("n_samples", "Samples", "Number of samples (whole number).", aliases=("n samples",), width=10),
    Column("n_sites", "Sites", "Number of sites (whole number).", aliases=("n sites",), width=8),
    Column("n_studies", "Studies", "Number of studies (whole number). Empty: estimated from the samples.", aliases=("n studies",), width=9),
    Column("peer_reviewed_studies", "Peer-reviewed studies", "How many of the studies are peer reviewed (whole number, at most Studies).", width=12),
    Column("validation_type", "Validation type", "How the AI system was validated. Empty: no evidence, and then Performance must be empty too.", choices="validation_types", width=26),
    Column("in_intended_use", "In intended use", '"Yes" if the AI system is meant for this group, otherwise "No". Leave it and Intended-use level empty when the intended use does not say.', choices="yes_no", width=10),
    Column("intended_use_coverage", "Intended-use coverage", "Share of the group the intended use covers, 0 to 1.", width=12),
    Column("intended_use_level", "Intended-use level", '"In scope", "Partially in scope", or "Out of scope". Empty together with In intended use: not stated.', choices="intended_use_levels", width=18),
    Column("warnings", "Warnings", 'Warning codes, separated by ";" (e.g. "clinician_review_required; wide_confidence_interval"). Empty: none.', required=True, width=48),
)
assert tuple(column.key for column in _METRIC_COLUMNS) == METRIC_ROW_FORMAT

# Merge uploads (contract v1.7, CONTRACT.md §11.2). Optional columns: a
# replace upload may leave them out; a merge upload needs Source, Study, and
# Source date on every row it adds or replaces.
ACTION_COLUMN = Column("action", "Action", 'Merge uploads only: "Remove" deletes this row\'s record; empty (or "Add or replace") adds or replaces it.', required=False, choices="actions", width=14)
_PROVENANCE_COLUMNS = (
    Column("source", "Source", "Where the values come from, e.g. a study or report title (fictional in this demonstration). Required on every row of a merge upload that adds or replaces a record.", required=False, width=36),
    Column("study", "Study", "Study identifier, e.g. NBR-2026-01. Required with Source in a merge upload.", required=False, aliases=("study id",), width=16),
    Column("source_date", "Source date", "Date of the study or report as YYYY-MM-DD. Required with Source in a merge upload; a merge row older than the stored row's source date is kept out.", required=False, aliases=("study date",), width=13),
)

TEMPLATES: dict[str, tuple[Column, ...]] = {
    "models": (
        Column("model_version", "Model version", "Identifier of the AI system's version, e.g. SynGPT-2.0. Repeat it on every row of that AI system.", width=22),
        Column("display_name", "Display name", "Name shown in the atlas.", width=22),
        Column("model_name", "Model name", "Name without the version (optional).", width=16),
        Column("model_release", "Release", "Release number (optional).", aliases=("model release",), width=10),
        Column("status", "Status", '"ACTIVE" or "EXPERIMENTAL".', choices="model_statuses", width=14),
        Column("use_case", "Function", "One function of this AI system per row, e.g. Discharge letter generation.", aliases=("use case", "function"), width=28),
        Column("default_use_case", "Default function", '"Yes" on the function the atlas opens first for this AI system (at most one per AI system).', choices="yes_no", aliases=("default use case",), width=12),
        Column("default_model", "Default model", '"Yes" on the rows of the AI system the atlas opens first (at most one).', choices="yes_no", width=12),
        # Optional since contract v1.5: files without these columns stay valid.
        # Entry fields describe the AI system; repeat them on every row of it.
        Column("kind", "Kind", '"Model" (a general AI model) or "Product" (an AI system packaged for a clinical purpose). Empty: Model. The same on every row of the AI system.', required=False, choices="entry_kinds", aliases=("entry kind",), width=10),
        Column("ai_type", "AI type", "Large language model, imaging model, tabular risk model, rule-based system, or hybrid. The same on every row of the AI system (optional).", required=False, choices="ai_types", width=22),
        Column("developer", "Developer", "Who develops the AI system (optional; fictional names only in this demonstration). The same on every row of the AI system.", required=False, width=30),
        Column("release_date", "Release date", "Release date as YYYY-MM-DD, e.g. 2026-03-01 (optional). The same on every row of the AI system.", required=False, width=13),
        Column("description", "Description", f"What the AI system is, in at most {MAX_DESCRIPTION} characters (optional). The same on every row of the AI system.", required=False, width=48),
        Column("built_on", "Built on", f'Products only: model versions from this registry the product is built on, separated by "{BUILT_ON_SEPARATOR}" (optional). The same on every row of the AI system.', required=False, width=24),
        # Configuration fields: one value per row (a card: AI system × function).
        Column("function_category", "Function category", "Decision support, documentation, image analysis, triage, patient communication, or administrative (optional).", required=False, choices="function_categories", width=18),
        Column("declared_intended_purpose", "Declared intended purpose", f"The intended purpose as the developer states it, at most {MAX_DECLARATION} characters (optional; shown as declared by the developer, not verified).", required=False, width=48),
        Column("declared_regulatory_status", "Declared regulatory status", "The regulatory status as the developer states it (optional; not verified). Never write certified or approved for demonstration data.", required=False, width=30),
        Column("declared_contact", "Declared contact", "Contact for questions about this card, as the developer states it (optional).", required=False, width=30),
        Column("declared_documentation_url", "Declared documentation URL", "Link to the developer's documentation, starting with https:// or http:// (optional).", required=False, aliases=("documentation url",), width=40),
        # Optional since contract v1.11: files without the column stay valid.
        Column("intended_use_defined", "Intended use stated", '"No" when this card has no intended-use statement (a broad model): the atlas then shows no intended use and scores without it. "Yes" or empty: the card states its intended use in the metrics.', required=False, choices="yes_no", aliases=("intended use defined", "has intended use"), width=12),
        # Optional since contract v1.14. Replaces (§28.2) is an entry field: the same on every row of the AI system.
        Column("replaces", "Replaces", "The model version of another AI system in this file that this one supersedes, e.g. an earlier release (optional). The same on every row of the AI system.", required=False, aliases=("previous version", "supersedes"), width=22),
        # Optional since contract v1.14 (§28.1): the card's configuration record,
        # what its figures measure, and data-protection declarations. One value per row.
        Column("configuration_id", "Configuration ID", 'A label for the deployed configuration, e.g. cfg-2026-09 (letters, digits, ".", "_", "-"; at most 64 characters; optional).', required=False, aliases=("configuration",), width=16),
        Column("configuration_date", "Configuration date", "The date this configuration took effect, as YYYY-MM-DD (optional).", required=False, width=13),
        Column("prompt_summary", "Prompt summary", f"A short summary of the instructions the AI system is given, at most {MAX_PROMPT_SUMMARY} characters (optional). Never paste the full prompt.", required=False, width=48),
        Column("prompt_sha256", "Prompt SHA-256", "The SHA-256 checksum of the full prompt: 64 characters 0-9 and a-f (optional). Lets readers check the prompt without seeing it.", required=False, aliases=("prompt sha256", "prompt hash"), width=24),
        Column("retrieval", "Retrieval", f"What the AI system looks up while it answers, e.g. local guidelines, at most {MAX_CONFIGURATION_TEXT} characters (optional).", required=False, width=36),
        Column("tools", "Tools", f'Names of the tools the AI system can call, separated by "{TOOL_SEPARATOR}" (at most {MAX_TOOLS}, each at most {MAX_TOOL_NAME} characters; optional).', required=False, width=30),
        Column("sampling_temperature", "Sampling temperature", "Temperature between 0 and 2 (optional).", required=False, aliases=("temperature",), width=12),
        Column("sampling_top_p", "Sampling top-p", "Top-p between 0 and 1 (optional).", required=False, aliases=("top p",), width=12),
        Column("sampling_max_output_tokens", "Max output tokens", "Largest answer length in tokens, a whole number of at least 1 (optional).", required=False, aliases=("sampling max output tokens",), width=12),
        Column("fine_tuning", "Fine-tuning", f"How the AI system was adapted to this function, at most {MAX_CONFIGURATION_TEXT} characters (optional).", required=False, aliases=("fine tuning",), width=36),
        Column("performance_measure", "Performance measure", f"What the Performance figures of this card measure, e.g. Top-3 diagnostic accuracy, at most {MAX_MEASURE_TEXT} characters (optional).", required=False, width=30),
        Column("reference_standard", "Reference standard", f"What the figures are measured against, e.g. Final diagnosis at discharge, at most {MAX_MEASURE_TEXT} characters (optional).", required=False, width=30),
        Column("declared_data_use", "Declared data use", f"How the AI system uses patient data, as the developer states it, at most {MAX_DATA_USE} characters (optional; not verified).", required=False, width=48),
        Column("declared_data_location", "Declared data location", "Where the data is processed and stored, as the developer states it (optional; not verified).", required=False, width=30),
        Column("declared_retention", "Declared retention", "How long the data is kept, as the developer states it (optional; not verified).", required=False, width=30),
        Column("declared_privacy_contact", "Declared privacy contact", "Contact for data-protection questions, as the developer states it (optional).", required=False, width=30),
    ),
    "metrics": (
        Column("code", "ICD-11 code", "Code of a top-level condition, e.g. 5A11.", aliases=("icd11 code", "icd code", "concept id", "code"), width=12),
        Column("condition", "Condition", "Name of the condition (for reading only; ignored on upload).", required=False, info=True, width=36),
        *_LENS_COLUMNS,
        SETTING_COLUMN,
        *_METRIC_COLUMNS,
        ACTION_COLUMN,
        *_PROVENANCE_COLUMNS,
    ),
    "multimorbidity": (
        Column("codes", "Condition codes", 'Two or more top-level condition codes joined by "+", e.g. "5A11 + BA00".', aliases=("condition ids", "codes"), width=20),
        Column("label", "Combination label", "Name of the combination (optional; repeat it on every row of the combination).", aliases=("label",), width=36),
        Column("conditions", "Conditions", "Names of the conditions (for reading only; ignored on upload).", required=False, info=True, width=40),
        *_LENS_COLUMNS,
        *_METRIC_COLUMNS,
    ),
    "prevalence": (
        Column("code", "ICD-11 code", "ICD-11 code of a condition or subcategory, e.g. 5A11.", aliases=("icd11 code", "icd code", "concept id", "code"), width=12),
        Column("condition", "Condition", "Name of the condition (for reading only; ignored on upload).", required=False, info=True, width=40),
        Column("tier", "Commonness", '"Very rare", "Rare", "Uncommon", "Common", or "Very common".', aliases=("tier", "prevalence tier", "commonness tier"), choices="prevalence_tiers", width=14),
        ACTION_COLUMN,
        *_PROVENANCE_COLUMNS,
    ),
    "safety": (
        Column("incident_id", "Incident ID", "Your identifier of the incident, e.g. SI-2026-014 (letters, digits, \".\", \"_\", \"-\"; at most 64 characters). One row per incident.", aliases=("incident",), width=16),
        Column("model_version", "Model version", "The AI system the incident concerns, e.g. SynGPT-2.0.", aliases=("ai system",), width=22),
        Column("use_case", "Function", "The function of that AI system, e.g. Clinician Facing CDSS. Together they name the card.", aliases=("use case", "function"), width=28),
        Column("codes", "ICD-11 codes", f'Codes of the affected conditions separated by "{CODE_SEPARATOR}", e.g. "5A11; BA00" (subcategories count for their top-level condition), or one whole chapter as "chapter 06".', aliases=("icd11 codes", "icd 11 code", "codes", "chapter"), width=22),
        Column("age", "Age", f'Age group the incident concerns. Empty: "{AGE_ALL}".', required=False, choices="lens:age", width=12),
        Column("sex", "Sex", f'Sex the incident concerns. Empty: "{SEX_ALL}".', required=False, choices="lens:sex", width=12),
        Column("ethnicity", "Ethnicity", f'Ethnicity group the incident concerns. Empty: "{ETHNICITY_ALL}".', required=False, choices="lens:ethnicity", width=18),
        Column("incident_type", "Incident type", "Harmful or incorrect recommendation, fabricated content, subgroup bias, performance drift, developer notice or recall, or other.", choices="incident_types", aliases=("type",), width=30),
        Column("harm", "Harm", '"Occurred", "Possible", or "None": whether a patient was harmed or could have been.', choices="harms", width=10),
        Column("status", "Status", '"Open", "Mitigated", or "Closed".', choices="incident_statuses", width=11),
        Column("source_type", "Source type", '"Study", "Incident report", or "Developer notice".', choices="source_types", width=16),
        Column("source_reference", "Source reference", "Where the incident is reported, e.g. a report number or study title (fictional in this demonstration).", width=36),
        Column("study_id", "Study ID", "The study's identifier; required when Source type is Study.", required=False, aliases=("study",), width=14),
        Column("reported_date", "Reported date", "When the incident was reported, as YYYY-MM-DD.", width=13),
        Column("updated_date", "Updated date", "When its status last changed, as YYYY-MM-DD (optional; not before Reported date).", required=False, width=13),
        Column("summary", "Summary", f"What happened, in at most {MAX_SUMMARY} characters. Synthetic text only: no patient details.", width=60),
        # Optional since contract v1.13 (§26).
        Column("scope", "Scope", '"Public" (the default) or "Hospital": an incident this hospital recorded itself. A public release import keeps hospital incidents.', required=False, choices="scopes", width=12),
        ACTION_COLUMN,
    ),
    # Contract v1.13 (CONTRACT.md §22): one row per study. Metric rows link to a
    # study when their Study column holds its Study ID exactly.
    "studies": (
        Column("study_id", "Study ID", "Your identifier of the study, e.g. NBR-2026-01 (letters, digits, \".\", \"_\", \"-\"; at most 64 characters). Metric rows whose Study column holds exactly this ID are graded with this record. One row per study.", aliases=("study",), width=16),
        Column("title", "Title", f"The study's title, at most {MAX_STUDY_TITLE} characters (fictional in this demonstration).", width=40),
        Column("design", "Design", "Vignette, simulation, benchmark, retrospective, prospective, real-world deployment, or randomized trial.", choices="study_designs", aliases=("study design",), width=20),
        Column("setting", "Setting", f'Where the study took place, e.g. "Emergency department, tertiary hospital" (at most {MAX_STUDY_TEXT} characters).', width=36),
        Column("sites", "Sites", "Number of sites (whole number, at least 1).", aliases=("n sites",), width=8),
        Column("patients", "Patients", "Number of patients or cases evaluated (whole number). Aggregate counts only.", aliases=("cases", "n patients"), width=10),
        Column("peer_reviewed", "Peer reviewed", '"Yes" if the study is published in a peer-reviewed venue, otherwise "No".', choices="yes_no", width=10),
        Column("conducted_by", "Conducted by", '"Developer", "Independent", or "Hospital": who ran the study.', choices="study_conductors", width=14),
        Column("reporting_guideline", "Reporting guideline", "None, TRIPOD+AI, STARD-AI, CONSORT-AI, DECIDE-AI, or Other.", choices="reporting_guidelines", aliases=("guideline",), width=16),
        Column("guideline_followed", "Guideline followed", '"Yes", "Partly", or "No". Required unless Reporting guideline is None (then leave it empty).', required=False, choices="guideline_followed", width=12),
        Column("risk_of_bias", "Risk of bias", '"Low", "Some concerns", "High", or "Unclear": the overall judgement (for example with PROBAST+AI).', choices="risk_of_bias", aliases=("rob",), width=14),
        Column("risk_of_bias_notes", "Risk-of-bias notes", f"Optional notes per domain, e.g. participants, predictors, outcome, analysis (at most {MAX_STUDY_NOTES} characters).", required=False, aliases=("rob notes",), width=40),
        Column("population", "Population", f"Who was studied, e.g. \"Adults admitted with suspected sepsis\" (at most {MAX_STUDY_TEXT} characters).", width=36),
        Column("evaluation_conditions", "Evaluation conditions", f"How the AI system was evaluated: reference standard, period, data source (at most {MAX_STUDY_NOTES} characters).", width=40),
        Column("model_version", "Model version evaluated", "The AI system's model version the study evaluated, e.g. SynGPT-2.0 (optional; must be in AI systems & functions).", required=False, aliases=("model version", "ai system"), width=22),
        Column("publication_date", "Publication date", "When the study was published, as YYYY-MM-DD.", width=13),
        Column("source_url", "Source URL", "Link to the study, starting with https:// or http:// (optional; .example addresses in this demonstration).", required=False, aliases=("url", "study url"), width=36),
        # Optional since contract v1.13 (§26): files without the columns stay valid (public studies).
        Column("scope", "Scope", '"Public" (a published or developer study; the default) or "Hospital" (this hospital\'s own evaluation of a local population).', required=False, choices="scopes", width=12),
        Column("population_id", "Local population", "Hospital evaluations only: the id of the local population evaluated, e.g. northbridge-region. Its local results must name this study.", required=False, aliases=("population", "local population id"), width=20),
        # Optional since contract v1.14 (§22): shown in Study quality, never graded. Files without the columns stay valid.
        Column("applicability", "Applicability concerns", '"Low", "High", or "Unclear": how well the study\'s patients, setting, and outcome match the intended use (overall judgement, for example with PROBAST+AI). Optional.', required=False, choices="applicability", aliases=("applicability",), width=14),
        Column("applicability_notes", "Applicability notes", f"Optional notes on the applicability judgement (at most {MAX_STUDY_NOTES} characters).", required=False, width=40),
        Column("quality_tool", "Appraisal tool", '"PROBAST+AI", "APPRAISE-AI", "QUADAS-AI", or "Other": the tool used to appraise the study. Optional.', required=False, choices="quality_tools", aliases=("quality tool",), width=14),
        Column("quality_score", "Appraisal score", "The tool's score from 0 to 100, for a tool that scores (e.g. APPRAISE-AI). Optional; needs an Appraisal tool.", required=False, aliases=("quality score",), width=10),
        Column("setting_category", "Setting category", '"Emergency department", "Intensive care", "Inpatient ward", "Outpatient clinic", "Primary care", or "Mixed". Optional; Setting keeps the free text.', required=False, choices="setting_categories", width=20),
        Column("configuration_id", "Configuration evaluated", 'The configuration of the AI system the study evaluated, e.g. cfg-2026-03 (letters, digits, ".", "_", "-"; at most 64). Optional.', required=False, aliases=("configuration", "configuration id"), width=18),
        ACTION_COLUMN,
    ),
}
# Contract v1.13 (CONTRACT.md §27): one row per effect on an outcome, from a
# study that compared care with and without the AI system. Never graded.
TEMPLATES["effects"] = (
    Column("effect_id", "Effect ID", "Your identifier of the effect, e.g. EFF-2026-01 (letters, digits, \".\", \"_\", \"-\"; at most 64 characters). One row per effect.", aliases=("effect",), width=16),
    Column("study_id", "Study ID", "The study that measured the effect, exactly as its Study ID in Studies. Its design must be Randomized trial, Prospective, or Real-world deployment.", aliases=("study",), width=16),
    Column("model_version", "Model version", "The AI system that was used, e.g. Vantrel-Triage-2.1.", aliases=("ai system",), width=22),
    Column("use_case", "Function", "The function of that AI system, e.g. Emergency department triage. Together they name the card.", aliases=("use case", "function"), width=28),
    Column("codes", "ICD-11 codes", f'Codes of the conditions the effect concerns separated by "{CODE_SEPARATOR}", e.g. "BA41; BA80" (subcategories count for their top-level condition), or one whole chapter as "chapter 11".', aliases=("icd11 codes", "icd 11 code", "codes", "chapter"), width=22),
    Column("outcome", "Outcome", f'What was measured, e.g. "Time from arrival to first treatment" (at most {MAX_OUTCOME} characters).', width=36),
    Column("outcome_type", "Outcome type", '"Benefit", "Harm", or "Process": a patient benefit, a harm, or a measure of how care runs.', choices="outcome_types", width=12),
    Column("population", "Population", f'Who was studied, e.g. "Adults attending the emergency department" (at most {MAX_EFFECT_TEXT} characters).', width=36),
    Column("comparator", "Comparator", f'What care with the AI system was compared with, e.g. "Usual care without the AI system" (at most {MAX_EFFECT_TEXT} characters).', width=36),
    Column("effect_measure", "Effect measure", "Risk ratio, odds ratio, hazard ratio, risk difference, mean difference, or standardized mean difference.", choices="effect_measures", aliases=("measure",), width=22),
    Column("estimate", "Estimate", "The effect estimate, AI system against comparator, e.g. 0.82 for a risk ratio or -14 for a mean difference. Ratios must be above 0.", aliases=("effect estimate",), width=10),
    Column("ci_low", "CI low", "Lower bound of the 95% confidence interval. Not above Estimate.", width=9),
    Column("ci_high", "CI high", "Upper bound of the 95% confidence interval. Not below Estimate.", width=9),
    Column("unit", "Unit", f'The unit of a difference, e.g. "minutes" or "percentage points" (optional, at most {MAX_EFFECT_UNIT} characters).', required=False, width=12),
    Column("direction", "Direction of benefit", '"Higher is better" or "Lower is better": which side of no effect favours the AI system.', choices="effect_directions", aliases=("direction",), width=16),
    Column("follow_up", "Follow-up", f'How long patients were followed, e.g. "30 days" (optional, at most {MAX_FOLLOW_UP} characters).', required=False, aliases=("follow up",), width=12),
    Column("appraisal_tool", "Appraisal tool", '"RoB 2" for a randomized trial, "ROBINS-I" for a prospective study or a real-world deployment.', choices="appraisal_tools", aliases=("risk of bias tool", "rob tool"), width=12),
    Column("judgement", "Risk-of-bias judgement", '"Low", "Some concerns", "High", "Critical" (ROBINS-I only), or "Unclear": the overall judgement. Enter a ROBINS-I "Moderate" as Some concerns and "Serious" as High.', choices="effect_judgements", aliases=("judgement", "judgment", "risk of bias"), width=16),
    Column("notes", "Notes", f"Optional notes, e.g. per-domain judgements (at most {MAX_EFFECT_NOTES} characters).", required=False, width=40),
    ACTION_COLUMN,
)

# A local population (contract v1.10) uses the prevalence columns: one tier
# per code for the whole population. Replace uploads only, so no Remove.
TEMPLATES["population"] = TEMPLATES["prevalence"]
# Local results (contract v1.13, §26) use the metrics columns; their Study must
# name a hospital evaluation of the local population chosen at upload.
TEMPLATES["local_metrics"] = TEMPLATES["metrics"]
# Narrow model cards are JSON or Markdown files, not spreadsheets: no template.
SPREADSHEET_KINDS = tuple(kind for kind in DATASET_KINDS if kind != "model_cards")
assert set(TEMPLATES) == set(SPREADSHEET_KINDS)

# Kinds whose uploads name one card (AI system × function).
TARGETED_KINDS = frozenset({"metrics", "multimorbidity", "local_metrics"})

ROW_DESCRIPTIONS = {
    "models": "one row per AI system and function",
    "metrics": "one row per condition and demographic group of one card",
    "multimorbidity": "one row per combination of conditions and demographic group of one card",
    "prevalence": "one row per ICD-11 code",
    "safety": "one row per safety incident",
    "population": "one row per ICD-11 code of one local population",
    "studies": "one row per study",
    "local_metrics": "one row per condition and demographic group of one card, from one hospital evaluation of one local population",
    "effects": "one row per effect on an outcome",
}

MERGE_INSTRUCTIONS = (
    "Merge upload: only the rows in the file change. A row adds its record or replaces the stored one; a row with Action \"Remove\" deletes its record. Records not in the file stay as they are.",
    "Every row that adds or replaces a record needs Source, Study, and Source date. A row from a study older than the stored row's is kept out, and the check lists it (the newer study stays).",
)

INSTRUCTIONS = {
    "models": (
        "List every AI system the atlas offers, with one row per AI system and function (a card).",
        "The upload replaces the whole list: AI systems or functions missing from the file are removed from the atlas.",
        "A function can only be added once its performance metrics exist: upload them under Performance metrics first.",
        "The columns from Kind onwards are optional. Kind, AI type, Developer, Release date, Description, and Built on describe the AI system: give them the same value on every row of that model version.",
        "Function category and the four Declared columns belong to one row (one card). Declarations are the developer's own statements and are shown as such.",
        "Intended use stated: \"No\" for a card without an intended-use statement (for example a broad language model); the atlas then shows no intended use for it. Empty means Yes.",
        "Replaces names the earlier version this AI system supersedes; it must be another AI system in this file. The atlas then links the two versions.",
        "The configuration columns (Configuration ID to Fine-tuning) describe how this card is deployed. Give a prompt summary, never the full prompt. Performance measure and Reference standard say what the card's figures measure.",
        "The four data-protection columns (Declared data use to Declared privacy contact) are the developer's statements, shown as declared and never verified.",
    ),
    "metrics": (
        "Performance metrics for one card (AI system and function), chosen when you upload the file.",
        "Give each condition one row per demographic group (age × sex × ethnicity). Every condition needs the same groups.",
        "Setting is optional: empty (or \"Any setting\") is a result that holds across care settings. A specific setting (Emergency department, Intensive care, Inpatient ward, Outpatient clinic, Primary care) is a result measured there only; give it only where such evidence exists, for any conditions and groups. A reader who chooses that setting sees only these rows.",
        "A replace upload replaces all metrics of that card: conditions missing from the file lose their data. A merge upload changes only its rows.",
        "Empty cells mean no data, except in the columns ICD-11 code, Age, Sex, and Ethnicity, which are required.",
        "A Performance value needs its evidence: a Validation type (and the study details) on the same row. A row with Performance but no evidence is rejected.",
        "In intended use and Intended-use level go together: fill both, or leave both empty when the intended use does not say anything about the row.",
        *MERGE_INSTRUCTIONS,
    ),
    "multimorbidity": (
        "Performance on combinations of conditions, for one card (AI system and function), chosen when you upload the file.",
        "Give each combination one row per demographic group. Every combination needs the same groups; the current data has only the all-population group.",
        "The upload replaces all combinations of that card: combinations missing from the file are removed.",
    ),
    "prevalence": (
        "How common each condition is, as a commonness tier (not a literal prevalence rate).",
        "A replace upload replaces the whole table: codes missing from the file lose their tier. A merge upload changes only its rows.",
        "Tiers change the atlas layout and slightly change evidence grades for rare conditions.",
        *MERGE_INSTRUCTIONS,
    ),
    "population": (
        "How common conditions are in one local population (a region or a service), as commonness tiers; the population's id and name are chosen when you upload the file.",
        "List only the codes whose local tier you know: every other condition keeps the default tier. The upload replaces that population's whole list.",
        "Aggregate data only: one tier per code for the whole population. Never upload patient-level data (no identifiers, dates of birth, or values per person).",
        "A local population changes evidence grades for rare conditions, rollup weights, and the atlas layout only on the views that choose it; the default answers stay as they are.",
    ),
    "safety": (
        "Safety incidents reported for a card (AI system and function): one row per incident. Safety incidents never change grades; the atlas marks the affected conditions Caution or Serious.",
        "Serious: an open incident in which harm occurred or could have occurred, or an open developer notice or recall. Caution: any other open incident, or a mitigated one. Closed incidents stay listed but are not marked.",
        "Name the conditions by ICD-11 codes separated by \";\", or a whole chapter as \"chapter 06\". Empty demographic cells mean all groups.",
        "A replace upload replaces every incident: incidents missing from the file are removed. A merge upload adds, replaces, or (with Action \"Remove\") removes only its incidents; a row whose Updated date (or Reported date) is older than the stored incident's is kept out.",
        "Summaries are synthetic text in this demonstration. Never enter patient details.",
    ),
    "studies": (
        "Studies behind the performance metrics: one row per study, with its design, setting, who ran it, the reporting guideline, and the risk of bias.",
        "A metric row is linked to a study when its Study column holds the Study ID exactly. A linked row's evidence grade goes up when the reporting guideline was followed and down with a high, unclear, or some-concerns risk of bias; unlinked rows are graded as before.",
        "Guideline followed is required unless Reporting guideline is None. Model version evaluated is optional and must name an AI system in AI systems & functions.",
        "A replace upload replaces every study: studies missing from the file are removed, and the rows that named them are graded without a study again. A merge upload adds, replaces, or (with Action \"Remove\") removes only its studies.",
        "Aggregate, synthetic descriptions only. Never enter patient details.",
        "Scope and Local population are optional: Hospital marks this hospital's own evaluation of one local population, whose local results name it.",
        "Applicability concerns, Appraisal tool, Appraisal score, Setting category, and Configuration evaluated are optional. They are shown with the study and never change a grade. An Appraisal score needs its Appraisal tool.",
    ),
    "local_metrics": (
        "Local results: this hospital's own evaluation results for one card and one local population, both chosen when you upload the file.",
        "When a reader chooses that local population, each local row replaces the public result of the same condition and demographic group; every other result stays public.",
        "Every row needs Source, Study, and Source date. Study must be the Study ID of a hospital evaluation of this local population (Studies: Scope Hospital, Local population this id).",
        "A Performance value needs its evidence (a Validation type), as in Performance metrics.",
        "Setting is optional, as in Performance metrics: empty means Any setting; a specific setting replaces the public result of that setting only.",
        "A replace upload replaces this card's local results for the population. A merge upload changes only its rows; Action \"Remove\" deletes one.",
        "Aggregate synthetic results only. Never upload patient-level data.",
    ),
    "effects": (
        "Effects on outcomes: what using an AI system changed for patients or for care, against a comparator, from a study that compared care with and without it. One row per effect.",
        "Effects are never part of a grade: the atlas grades predictive performance only. Each effect is shown on the condition card of its card and conditions.",
        "Study ID must name a study in Studies whose design is Randomized trial (appraise with RoB 2), Prospective, or Real-world deployment (appraise with ROBINS-I). Add or publish the study first.",
        "Ratios (risk, odds, hazard) are above 0, and 1 means no effect; differences may be negative, and 0 means no effect. CI low is not above Estimate, and CI high not below it.",
        "A replace upload replaces every effect: effects missing from the file are removed. A merge upload adds, replaces, or (with Action \"Remove\") removes only its effects.",
        "Aggregate, synthetic results only. Never enter patient details.",
    ),
}


def column_lookup(kind: str) -> dict[str, Column]:
    """Normalized header (and aliases) → column, including the Problems column."""
    lookup: dict[str, Column] = {}
    for column in (*TEMPLATES[kind], PROBLEMS_COLUMN):
        for name in (column.header, column.key, *column.aliases):
            lookup.setdefault(normalize_header(name), column)
    return lookup
