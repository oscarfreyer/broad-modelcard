"""Pydantic response models mirroring backend/openapi.json (contract v1).

Model names match the contract's component schemas; inline contract objects
get their own small models. Required fields, nullability (``X | None``), and
enums (``Literal``) follow the contract exactly; ``tests/test_contract_drift.py``
compares the generated schemas with openapi.json and fails on any difference.

Fields that are optional but never null in the contract use
``X | SkipJsonSchema[None] = None``: they may be omitted, but are never sent as
null.

The handlers serialize responses themselves (for speed and ETags); these models
define the documented schema, and the app validates every response against
them when created with ``validate_responses=True``, as the tests do.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, WithJsonSchema
from pydantic.json_schema import SkipJsonSchema

from ..services.presentation import MAP_COLUMNS

ConceptId = Annotated[str, Field(min_length=1, max_length=64)]
Grade = Literal["A", "B", "C", "D", "E", "F"]
# not_validated was merged into no_data in contract v1.11.
Status = Literal["strong", "moderate", "weak", "out_of_scope", "no_data"]
IntendedUseLevel = Literal["in_scope", "partially_in_scope", "out_of_scope"]
MetricView = Literal["overall", "performance", "evidence", "intended_use"]
# getMetricSummary's views: the metric views and the safety marks (contract v1.7).
SummaryView = Literal["overall", "performance", "evidence", "intended_use", "safety"]
# getMetricSummary's optional weights (contract v1.14, CONTRACT.md §30).
SummaryWeights = Literal["prevalence"]
SafetyMark = Literal["serious", "caution"]
AgeLens = Literal["All ages", "Age 0-17", "Age 18-39", "Age 40-64", "Age 65+"]
SexLens = Literal["All sexes", "Sex Female", "Sex Male"]
EthnicityLens = Literal[
    "All ethnicities",
    "Ethnicity White",
    "Ethnicity Black",
    "Ethnicity Hispanic",
    "Ethnicity Asian",
    "Ethnicity Other",
]
# Contract v1.14 (CONTRACT.md §29): the Context axis, the care-setting lens. Clinical is Any setting.
ContextLens = Literal[
    "Clinical",
    "Emergency department",
    "Intensive care",
    "Inpatient ward",
    "Outpatient clinic",
    "Primary care",
]
PrevalenceTier = Literal["very_rare", "rare", "uncommon", "common", "very_common"]
Relevance = Literal["High", "Medium", "Low"]
SafeguardId = Literal[
    "scope-stop", "perf-missing", "scope-partial", "perf-low", "ci-wide", "evidence-weak", "evidence-missing",
    "cdss-governance", "overall-weak", "standard-monitoring",
]
Priority = Literal["Critical", "Important", "Routine"]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Problem(ApiModel):
    type: str
    title: str
    status: int
    detail: str | SkipJsonSchema[None] = None
    code: str = Field(
        description=(
            "Stable machine-readable error code, e.g. unknown_model, unknown_use_case, invalid_lens, "
            "unknown_concept, staged_upload_exists, upload_not_valid, publish_in_progress, backend_unavailable."
        )
    )


# ------------------------------------------------------------------- meta

class Lens(ApiModel):
    age: AgeLens
    sex: SexLens
    ethnicity: EthnicityLens


class Filters(ApiModel):
    model: str
    use_case: str
    context: str
    lens: Lens


class Axes(ApiModel):
    context: list[str]
    age: list[AgeLens]
    sex: list[SexLens]
    ethnicity: list[EthnicityLens]


class StatusBand(ApiModel):
    status: Status
    grades: list[Grade]
    min: float | None
    max: float | None


class StatusBands(ApiModel):
    overall: list[StatusBand]
    performance: list[StatusBand]
    evidence: list[StatusBand]


class OverallScoreWeights(ApiModel):
    performance_grade: float
    perf: float
    evidence_grade: float
    intended_use: float


class OverallScoreWeightsWithoutIntendedUse(ApiModel):
    """The weights for a row without an intended-use value (contract v1.11, CONTRACT.md §4.4)."""

    performance_grade: float
    perf: float
    evidence_grade: float


class EvidenceSignalWeights(ApiModel):
    """The weights of the evidence signal's terms (CONTRACT.md §4.2), published in v1.13."""

    type: float
    studies: float
    sites: float
    peer: float
    size: float


class RiskOfBiasAdjustments(ApiModel):
    low: float
    some_concerns: float
    high: float
    unclear: float


class EvidenceStudyAdjustments(ApiModel):
    """How a linked study changes a row's evidence signal (v1.13, CONTRACT.md §22)."""

    guideline_followed: float = Field(description="Added when the study's reporting guideline was followed (yes).")
    risk_of_bias: RiskOfBiasAdjustments


class Concept(ApiModel):
    concept_id: ConceptId
    icd11_code: str | None = None
    pt: str = Field(description="Preferred term.")
    fsn: str | None = Field(default=None, description="Fully specified name.")
    level: Literal[0, 1, 2] = Field(description="0 chapter, 1 block, 2 category/condition.")
    parent_id: str | None
    chapter_id: str
    chapter_no: str = Field(pattern=r"^[0-9]{2}$")
    block_id: str | None = None
    sort_order: int
    depth_in_kind: int | None = None
    metric_anchor_id: str | None = None
    prevalence_tier: PrevalenceTier | None = None
    prevalence_score: float | None = None
    code: str | None = Field(
        default=None,
        description=(
            "Reads in another ontology (v1.13, CONTRACT.md §23) only: the ontology's own code (ICD-10-CM code or "
            "section, MONDO id); null for a grouping without one. icd11_code is then null."
        ),
    )


OntologyId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,31}$")]
MappingKind = Literal["exact", "stem", "block", "parent", "none"]


class OntologyRef(ApiModel):
    """The ontology a read used (v1.13, CONTRACT.md §23); absent on ICD-11 reads."""

    id: OntologyId
    name: str


OntologyField = Annotated[
    OntologyRef | SkipJsonSchema[None],
    Field(description="The ontology this answer is read in (v1.13, CONTRACT.md §23); absent for ICD-11."),
]


class MappingCounts(ApiModel):
    """Conditions by crosswalk kind (v1.13)."""

    exact: int
    stem: int
    block: int
    parent: int
    none: int


class AppraisalCounts(ApiModel):
    """Depth-1 conditions with an evidence grade at the lens, and how many of them rest on a stored
    row linked to a study record (2026-10-21, CONTRACT.md §22). Sent only when at least one is linked."""

    graded: int
    linked: int


class ConfigurationCounts(ApiModel):
    """Of the linked depth-1 conditions (``AppraisalCounts.linked``), how many rest on studies of the card's
    current configuration, of an earlier one, or of one not stated (v1.14, CONTRACT.md §28.5). Information only."""

    current: int = Field(ge=0)
    earlier: int = Field(ge=0)
    not_stated: int = Field(ge=0)


class OntologyCounts(ApiModel):
    chapters: int
    blocks: int
    conditions: int = Field(description="Depth-1 conditions (the atlas ring).")
    concepts: int = Field(description="Level-2 concepts, deeper levels included.")


class OntologySource(ApiModel):
    id: str
    release: str
    licence: str
    attribution: str


class OntologyInfo(ApiModel):
    """An ontology the atlas reads accept with ontology=<id> (v1.13, CONTRACT.md §23)."""

    id: OntologyId
    name: str
    release: str | None
    licence: str
    attribution: str
    is_default: bool = Field(description="True for ICD-11, the storage key of every result.")
    counts: OntologyCounts
    mapping_counts: MappingCounts | None = Field(description="Depth-1 conditions by crosswalk kind; null for ICD-11.")
    sources: list[OntologySource] = Field(description="The pinned releases the import read (empty for ICD-11).")


class ConceptRef(ApiModel):
    concept_id: ConceptId
    pt: str


class MappedConcept(ApiModel):
    """The ICD-11 atlas concept a mapping names: a condition (level 2) or a block (level 1)."""

    concept_id: ConceptId
    code: str | None
    pt: str
    level: Literal[1, 2]


class ConceptMapping(ApiModel):
    """A level-2 concept's crosswalk to ICD-11 (v1.13, CONTRACT.md §23)."""

    kind: MappingKind
    icd11: MappedConcept | None = Field(description="The ICD-11 concept whose result is served; null for none.")
    via: ConceptRef | None = Field(description="kind parent: the parent whose mapping is inherited.")
    steps: int | None = Field(description="kind parent: is_a steps up to the via concept (1 or 2).")
    source: str | None = Field(description="Which table or cross-reference the mapping came from.")
    source_code: str | None = Field(description="The code the source was read under (ICD-10 code, foundation id).")
    icd11_code: str | None = Field(description="The ICD-11 MMS code the source named, before it was resolved to the atlas.")


class PopulationRef(ApiModel):
    """The local population a read used (contract v1.10, CONTRACT.md §21); absent on default reads."""

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    name: str


class PopulationInfo(ApiModel):
    """A local population a read can name with population=<id> (v1.10)."""

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    name: str
    codes: int = Field(description="How many codes the population lists; every other condition keeps the default tier.")
    updated_version: int | None = Field(description="The version that put its current set in place; null for a staged set.")


PopulationField = Annotated[
    PopulationRef | SkipJsonSchema[None],
    Field(description="The local population this answer uses (v1.10); absent for the default population."),
]


class InstanceProfile(ApiModel):
    """The instance profile (contract v1.13, CONTRACT.md §26). No login: it names who runs this copy."""

    kind: Literal["public", "hospital"]
    organisation: str = Field(min_length=1, max_length=120)
    maintained_by: str = Field(min_length=1, max_length=120)
    contact: str | None = Field(default=None, max_length=200)
    data_protection_note: str | SkipJsonSchema[None] = Field(
        default=None,
        max_length=500,
        description=(
            "The organisation's own note on data protection (v1.14, CONTRACT.md §26.2), e.g. a hospital's; sent only when set. "
            "In updateInstance, leaving it out clears it."
        ),
    )


class SubgroupDifferenceRule(ApiModel):
    """When getConceptSubgroups flags a group (v1.13, CONTRACT.md §24)."""

    min_delta: float = Field(description="Smallest |group perf − all-patients perf| that can be flagged.")
    requires_ci_separation: bool = Field(description="Whether the two confidence intervals must not overlap.")
    note: str


class Meta(ApiModel):
    api_version: Literal["1"]
    dataset_version: str
    synthetic_data_notice: str
    default_model_version: str
    axes: Axes
    statuses: list[Status]
    status_bands: StatusBands
    overall_score_weights: OverallScoreWeights | SkipJsonSchema[None] = Field(
        default=None, description="Weights of the overall score terms (CONTRACT.md §4.4). Added in v1.3."
    )
    overall_score_weights_without_intended_use: OverallScoreWeightsWithoutIntendedUse | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Weights for a row without an intended-use value (a card without an intended-use statement, or a row "
            "that gives none): the intended-use term dropped, the others scaled to 100% (CONTRACT.md §4.4). Added in v1.11."
        ),
    )
    chapters: list[Concept]
    populations: list[PopulationInfo] | SkipJsonSchema[None] = Field(
        default=None, description="Local populations of this version (v1.10, CONTRACT.md §21); always sent."
    )
    evidence_signal_weights: EvidenceSignalWeights | SkipJsonSchema[None] = Field(
        default=None, description="Weights of the evidence signal's terms (CONTRACT.md §4.2). Added in v1.13; always sent."
    )
    evidence_study_adjustments: EvidenceStudyAdjustments | SkipJsonSchema[None] = Field(
        default=None,
        description="How a linked study record changes a row's evidence signal (CONTRACT.md §22). Added in v1.13; always sent.",
    )
    subgroup_difference: SubgroupDifferenceRule | SkipJsonSchema[None] = Field(
        default=None,
        description="The rule that flags a group in getConceptSubgroups (CONTRACT.md §24); a prototype heuristic, not a grade. "
        "Added in v1.13; always sent.",
    )
    ontologies: list[OntologyInfo] | SkipJsonSchema[None] = Field(
        default=None,
        description="The ontologies the atlas reads accept, ICD-11 first (v1.13, CONTRACT.md §23); always sent.",
    )
    comparison: ComparisonMeta | SkipJsonSchema[None] = Field(
        default=None,
        description="The comparability rule of getComparison: card limits, reason codes, design groups (v1.13, CONTRACT.md §25); always sent.",
    )
    instance: InstanceProfile | SkipJsonSchema[None] = Field(
        default=None,
        description="Who runs this copy of the tool: a public service or a hospital version (v1.13, CONTRACT.md §26); always sent.",
    )


EntryKind = Literal["model", "product"]
AiType = Literal["llm", "imaging", "tabular_risk", "rule_based", "hybrid"]
FunctionCategory = Literal[
    "decision_support", "documentation", "image_analysis", "triage", "patient_communication", "administrative"
]
_DATA_PROTECTION = (
    "Data-protection declaration (v1.14, CONTRACT.md §28); the four are sent together, only when one of them is given."
)


class Declarations(ApiModel):
    """What the developer declares about one configuration; not verified (v1.5, data protection since v1.14)."""

    declared_intended_purpose: str | None
    declared_regulatory_status: str | None
    declared_contact: str | None
    declared_documentation_url: str | None
    declared_data_use: str | None = Field(
        default=None, max_length=500, description=f"How the AI system uses patient data. {_DATA_PROTECTION}"
    )
    declared_data_location: str | None = Field(
        default=None, max_length=200, description=f"Where the data is processed and stored. {_DATA_PROTECTION}"
    )
    declared_retention: str | None = Field(
        default=None, max_length=200, description=f"How long the data is kept. {_DATA_PROTECTION}"
    )
    declared_privacy_contact: str | None = Field(
        default=None, max_length=200, description=f"Contact for data-protection questions. {_DATA_PROTECTION}"
    )


class ConfigurationRecord(ApiModel):
    """The deployed configuration of a card (v1.14, CONTRACT.md §28.1): every field, null when not given.
    A summary of the prompt, never the prompt itself."""

    configuration_id: str | None = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$", description="A label, e.g. cfg-2026-09.")
    configuration_date: date | None = Field(description="ISO date the configuration took effect.")
    prompt_summary: str | None = Field(max_length=500)
    prompt_sha256: str | None = Field(pattern=r"^[0-9a-f]{64}$", description="SHA-256 of the full prompt, lower-case hex.")
    retrieval: str | None = Field(max_length=280)
    tools: list[Annotated[str, Field(min_length=1, max_length=60)]] = Field(max_length=10, description="Tool names; empty when none.")
    sampling_temperature: float | None = Field(ge=0, le=2)
    sampling_top_p: float | None = Field(ge=0, le=1)
    sampling_max_output_tokens: int | None = Field(ge=1)
    fine_tuning: str | None = Field(max_length=280)


_CONFIGURATION = (
    "The card's configuration record (v1.14, CONTRACT.md §28.1); sent only when one of its fields is given."
)
_MEASURE = "Sent only when given (v1.14, CONTRACT.md §28.1)."


class UseCaseEntry(ApiModel):
    use_case: str
    has_multimorbidity: bool
    function_category: FunctionCategory | None = Field(
        default=None, description="Category of the function (the use case). Added in v1.5; null when not given."
    )
    declarations: Declarations | None = Field(
        default=None, description="Developer declarations for this configuration. Added in v1.5; null when none is given."
    )
    intended_use_defined: bool | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Whether the card has an intended-use statement (v1.11); absent means true. When false, every intended-use "
            "field of the card is null and its scores leave intended use out (CONTRACT.md §4.4)."
        ),
    )
    configuration: ConfigurationRecord | SkipJsonSchema[None] = Field(default=None, description=_CONFIGURATION)
    performance_measure: str | SkipJsonSchema[None] = Field(
        default=None, max_length=200, description=f"What the card's figures measure, e.g. Top-3 diagnostic accuracy. {_MEASURE}"
    )
    reference_standard: str | SkipJsonSchema[None] = Field(
        default=None, max_length=200, description=f"What the figures are measured against. {_MEASURE}"
    )
    settings: list[ContextLens] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.14 (CONTRACT.md §29): the care settings the card's metrics store rows for, Clinical (Any setting) first; "
            "sent only when the card stores a specific setting, so absent means Any setting only."
        ),
    )


_LINEAGE = "Version lineage (v1.14, CONTRACT.md §28.2)"


class ModelEntry(ApiModel):
    model_version: str
    model_name: str | None = None
    model_release: str | None = None
    display_name: str
    status: Literal["ACTIVE", "EXPERIMENTAL"]
    default_use_case: str
    use_cases: list[UseCaseEntry]
    kind: EntryKind | SkipJsonSchema[None] = Field(
        default=None, description="Model or product (\"AI system\" in the UI). Added in v1.5; an entry without a kind is a model."
    )
    ai_type: AiType | None = Field(default=None, description="Added in v1.5; null when not given.")
    developer: str | None = Field(default=None, description="Added in v1.5; null when not given.")
    release_date: date | None = Field(default=None, description="ISO date. Added in v1.5; null when not given.")
    description: str | None = Field(default=None, max_length=280, description="Added in v1.5; null when not given.")
    built_on: list[str] | SkipJsonSchema[None] = Field(
        default=None,
        description="Products only: model versions of this registry the product is built on. Added in v1.5; empty for models.",
    )
    replaces: str | SkipJsonSchema[None] = Field(
        default=None, description=f"{_LINEAGE}: the model version this AI system supersedes; sent only when given."
    )
    replaced_by: list[str] | SkipJsonSchema[None] = Field(
        default=None,
        description=f"{_LINEAGE}: the entries whose replaces names this one, in registry order (derived); sent only when not empty.",
    )


class ModelRegistry(ApiModel):
    default_model_version: str
    models: list[ModelEntry]


# ------------------------------------------------------------------ atlas

class AtlasOverview(ApiModel):
    dataset_version: str
    chapters: list[Concept]
    blocks: list[Concept]
    conditions: list[Concept] = Field(description="The depth-1 top-level conditions (2,400 in ICD-11).")
    population: PopulationField = None
    ontology: OntologyField = None


class ChapterDetail(ApiModel):
    dataset_version: str
    chapter: Concept
    blocks: list[Concept]
    concepts: list[Concept] = Field(description="All level-2 concepts in the chapter, including deeper categories.")
    population: PopulationField = None
    ontology: OntologyField = None


# ---------------------------------------------------------------- metrics

def _exact_columns(columns: list[str]) -> list[str]:
    if tuple(columns) != MAP_COLUMNS:
        raise ValueError(f"columns must be {list(MAP_COLUMNS)}")
    return columns


MapColumns = Annotated[
    list[str],
    AfterValidator(_exact_columns),
    WithJsonSchema({"type": "array", "const": list(MAP_COLUMNS)}),
]

MapRow = tuple[
    ConceptId,
    Status,
    Grade | None,
    float | None,
    Status,
    Grade | None,
    float | None,
    Status,
    Grade | None,
    IntendedUseLevel | None,
    float | None,  # ci_low (contract v1.1)
    float | None,  # ci_high (contract v1.1)
    SafetyMark | None,  # safety (contract v1.7)
    Annotated[int, Field(ge=0)] | None,  # child_count (contract v1.10): 0 marks a rollup without children (§6)
]


class MetricMap(ApiModel):
    """Columnar to stay small. Each row is an array aligned with ``columns``."""

    dataset_version: str
    filters: Filters
    columns: MapColumns
    rows: list[MapRow]
    population: PopulationField = None
    mapping: list[MappingKind | None] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Reads in another ontology (v1.13) only: each row's crosswalk kind, aligned with rows; null for block and "
            "chapter rows (rollups), none for one none of whose conditions maps. Kind none has no result: No mapping."
        ),
    )
    layer: list[Literal["local", "includes_local"] | None] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.13 (CONTRACT.md §26), ICD-11 reads for a local population with local results for the card only: aligned "
            "with rows, local for a condition served from local results, includes_local for a block or chapter with at "
            "least one such condition, else null."
        ),
    )
    appraisal: list[Literal["linked", "includes_linked"] | None] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "2026-10-21 (CONTRACT.md §22), only when at least one row of the answer rests on a study record: aligned with "
            "rows, linked for a condition whose result rests on a stored row linked to a study record, includes_linked for "
            "a result that aggregates conditions (a block, a chapter, or a condition mapped to an ICD-11 block) at least one "
            "of which is linked, else null (no study appraisal). Absent: no row of the answer is linked."
        ),
    )
    ontology: OntologyField = None


class StatusCounts(ApiModel):
    strong: int
    moderate: int
    weak: int
    out_of_scope: int
    no_data: int


class IntendedUseCounts(ApiModel):
    in_scope: int | SkipJsonSchema[None] = None
    partially_in_scope: int | SkipJsonSchema[None] = None
    out_of_scope: int | SkipJsonSchema[None] = None


class SafetyCounts(ApiModel):
    """Conditions by safety mark (contract v1.7); ``none``: no open or mitigated incident applies."""

    serious: int
    caution: int
    none: int


class ChapterCounts(ApiModel):
    chapter_id: str
    total: int
    counts: StatusCounts
    safety_counts: SafetyCounts | SkipJsonSchema[None] = Field(default=None, description="view=safety only (v1.7).")


class MetricSummary(ApiModel):
    """Counts over depth-1 top-level conditions."""

    dataset_version: str
    filters: Filters
    view: SummaryView
    total: int
    counts: StatusCounts
    intended_use_counts: IntendedUseCounts | None | SkipJsonSchema[None] = Field(
        default=None, description="view=intended_use only; null for a card without an intended-use statement (v1.11)."
    )
    safety_counts: SafetyCounts | SkipJsonSchema[None] = Field(
        default=None, description="view=safety only (v1.7); counts then stays all zero."
    )
    chapters: list[ChapterCounts]
    population: PopulationField = None
    mapping_counts: MappingCounts | SkipJsonSchema[None] = Field(
        default=None,
        description="Reads in another ontology (v1.13) only: the conditions by crosswalk kind; those of kind none count as no_data.",
    )
    appraisal_counts: AppraisalCounts | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "2026-10-21 (CONTRACT.md §22), only when at least one graded condition rests on a study record: the depth-1 "
            "conditions with an evidence grade at the lens and how many of them are linked to a study record. Any view."
        ),
    )
    configuration_counts: ConfigurationCounts | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.14 (CONTRACT.md §28.5), sent exactly when appraisal_counts is: the linked conditions by the configuration "
            "their studies evaluated (the card's current one, an earlier one, or not stated). Never a grade."
        ),
    )
    weighted_distribution: dict[str, Annotated[float, Field(ge=0, le=1)]] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.14 (CONTRACT.md §30), only with weights=prevalence: each status's share of the prevalence weight of the "
            "depth-1 conditions (§6's weights; a local population's for a population read), rounded to 4 decimals. Keys: "
            "the five statuses of counts (overall, performance, evidence), in_scope, partially_in_scope, out_of_scope, "
            "and no_data (intended_use), or serious, caution, and none (safety). Never a grade."
        ),
    )
    ontology: OntologyField = None


class WarningShare(ApiModel):
    count: int
    total: int


class Warning(ApiModel):
    code: str
    relevance: Relevance
    share: WarningShare | SkipJsonSchema[None] = None


class Safeguard(ApiModel):
    id: SafeguardId
    priority: Priority


class Rollup(ApiModel):
    child_count: int | SkipJsonSchema[None] = None
    aggregation: Literal["p20", "weighted_mean"] | SkipJsonSchema[None] = None


class DataSource(ApiModel):
    """Where a stored row's values come from (contract v1.7, CONTRACT.md §11.3)."""

    source: str
    study: str | None
    date: date | None


class Provenance(ApiModel):
    source: Literal["condition", "anchor", "rollup", "multimorbidity"]
    anchor_concept_id: str | None = None
    rollup: Rollup | None = None
    lens_fallback: bool
    data_source: DataSource | None = Field(
        default=None,
        description="getConceptMetrics only (v1.7): the stored row's source; null for aggregated rows.",
    )
    layer: Literal["local"] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.13 (CONTRACT.md §26): local for a row served from a hospital's local evaluation results (a read that "
            "names the local population); absent on every public row."
        ),
    )


class Overall(ApiModel):
    tier: Literal["graded", "no_data", "out_of_scope", "no_evidence_data", "no_performance_data"]
    score: float | None
    grade: Grade | None


class RowStatus(ApiModel):
    overall: Status
    performance: Status
    evidence: Status


StudyDesign = Literal[
    "vignette", "simulation", "benchmark", "retrospective", "prospective", "real_world_deployment", "randomized_trial"
]
RiskOfBias = Literal["low", "some_concerns", "high", "unclear"]


Scope = Literal["public", "hospital"]


class Study(ApiModel):
    """One study record (contract v1.13, CONTRACT.md §22). Synthetic."""

    study_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")
    title: str
    design: StudyDesign
    setting: str
    sites: int = Field(ge=1)
    patients: int = Field(ge=0)
    peer_reviewed: bool
    conducted_by: Literal["developer", "independent", "hospital"]
    reporting_guideline: Literal["none", "tripod_ai", "stard_ai", "consort_ai", "decide_ai", "other"]
    guideline_followed: Literal["yes", "partly", "no"] | None = Field(description="Null exactly when the guideline is none.")
    risk_of_bias: RiskOfBias
    risk_of_bias_notes: str | None
    population: str
    evaluation_conditions: str
    model_version: str | None = Field(description="The model version the study evaluated, or null.")
    publication_date: date
    source_url: str | None
    scope: Scope | SkipJsonSchema[None] = Field(default=None, description="v1.13 (§26): public, or hospital for a hospital evaluation; always sent.")
    population_id: str | None | SkipJsonSchema[None] = Field(default=None, description="v1.13 (§26): the local population a hospital evaluation evaluated; null for public.")
    # Contract v1.14 (§22): optional, never graded; each is sent only when stored (never null).
    applicability: Literal["low", "high", "unclear"] | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§22): applicability concerns, the overall judgement (PROBAST+AI style); absent when not stated. Never graded."
    )
    applicability_notes: str | SkipJsonSchema[None] = Field(default=None, description="v1.14 (§22): notes on the applicability judgement; absent when none.")
    quality_tool: Literal["probast_ai", "appraise_ai", "quadas_ai", "other"] | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§22): the appraisal tool; absent when not stated."
    )
    quality_score: Annotated[float, Field(ge=0, le=100)] | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§22): the appraisal tool's score, 0 to 100; only with quality_tool. Never graded."
    )
    setting_category: Literal[
        "emergency_department", "intensive_care", "inpatient_ward", "outpatient_clinic", "primary_care", "mixed"
    ] | SkipJsonSchema[None] = Field(default=None, description="v1.14 (§22): the setting category beside the free-text setting; absent when not stated.")
    configuration_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")] | SkipJsonSchema[None] = Field(
        default=None,
        description="v1.14 (§22): the configuration the study evaluated, as a label; not checked against the registry. Absent when not stated.",
    )


class EvidenceSignalTerms(ApiModel):
    """The terms of a linked stored row's evidence signal (v1.13, CONTRACT.md §22): each
    term's score (0–1; weights in /meta.evidence_signal_weights), the weighted sum before
    penalties, the §4.2 penalties, the study's two adjustments, the served signal, and its grade."""

    type: float
    studies: float
    sites: float
    peer: float
    size: float
    base_signal: float
    penalties: float = Field(description="The sum of the §4.2 penalties that apply (0 or negative).")
    guideline_adjustment: float
    risk_of_bias_adjustment: float
    signal: float = Field(description="The served evidence_signal: the sum of the above, clamped to 0–1.")
    grade: Grade


class Appraisal(ApiModel):
    """How a study record entered a row's evidence grade (v1.13, CONTRACT.md §22). Absent
    when no linked study enters the row."""

    study: Study | None = Field(description="The linked study; null for an aggregated row (rollup, lens fallback).")
    study_adjustment: float = Field(
        description="The change to the evidence signal: the study's guideline and risk-of-bias adjustment, or for an "
        "aggregated row the mean over its rows."
    )
    applied: bool = Field(description="Whether the row's evidence signal is derived (and so includes the adjustment).")
    terms: EvidenceSignalTerms | None = Field(description="Stored rows with a derived signal only; else null.")


class MetricRow(ApiModel):
    concept_id: str
    model_version: str
    use_case: str
    context: str
    lens: Lens
    perf: float | None
    ci_low: float | None
    ci_high: float | None
    performance_grade: Grade | None
    evidence_grade: Grade | None
    evidence_signal: float | None = None
    n_samples: int | None
    n_sites: int | None
    n_studies: int | None
    peer_reviewed_studies: int | None
    validation_type: str | None
    in_intended_use: bool | None = Field(description="Null when the row has no intended-use value (v1.11).")
    intended_use_coverage: float | None
    intended_use_level: IntendedUseLevel | None
    overall: Overall
    status: RowStatus
    warnings: list[Warning]
    safeguards: list[Safeguard]
    provenance: Provenance
    appraisal: Appraisal | SkipJsonSchema[None] = Field(
        default=None,
        description="getConceptMetrics and exportConcept only (v1.13): how a linked study entered the evidence grade; "
        "absent when none did.",
    )


IncidentType = Literal[
    "harmful_recommendation", "fabricated_content", "subgroup_bias", "performance_drift",
    "developer_notice_or_recall", "other",
]


class SafetyIncident(ApiModel):
    """One safety incident of a card (contract v1.7, CONTRACT.md §18). Synthetic."""

    incident_id: str
    model_version: str
    use_case: str
    codes: list[str] = Field(description="ICD-11 codes as given; empty for a chapter incident.")
    condition_ids: list[str] = Field(description="The depth-1 condition of each code, in the same order.")
    chapter_id: str | None = Field(description="The chapter the incident covers as a whole, or null.")
    lens: Lens
    incident_type: IncidentType
    harm: Literal["occurred", "possible", "none"]
    status: Literal["open", "mitigated", "closed"]
    severity: SafetyMark | None = Field(description="Derived (CONTRACT.md §18); null for a closed incident.")
    source_type: Literal["study", "incident_report", "developer_notice"]
    source_reference: str
    study_id: str | None
    reported_date: date
    updated_date: date | None
    summary: str = Field(max_length=280)
    scope: Scope | SkipJsonSchema[None] = Field(
        default=None, description="v1.13 (CONTRACT.md §26): public, or hospital for an incident a hospital recorded itself; always sent."
    )


class StoredIncident(SafetyIncident):
    """A stored incident for the Data Library's incident list (contract v1.11): the
    ``SafetyIncident`` fields plus what the incident form shows."""

    code_names: list[str | None] = Field(
        description="The preferred term of each code, in the same order (null for a code the atlas lacks)."
    )
    chapter_no: str | None = Field(description="The two-digit number of chapter_id, or null.")


class IncidentList(ApiModel):
    """``listIncidents`` (contract v1.11, CONTRACT.md §18): stored incidents, closed ones included, newest first."""

    dataset_version: str
    incidents: list[StoredIncident]


class StudyList(ApiModel):
    """``listStudies`` (v1.13, CONTRACT.md §22): the study records of the version, in stored order."""

    dataset_version: str
    studies: list[Study]


class StudyDetail(ApiModel):
    """``getStudy`` (v1.13, CONTRACT.md §22)."""

    dataset_version: str
    study: Study


SubgroupLayer = Literal["local", "includes_local", "public"]


class SubgroupDifference(ApiModel):
    """How a group's performance differs from all patients' (v1.13, CONTRACT.md §24). A prototype
    heuristic, not a grade: it changes no status."""

    delta: float | None = Field(description="Group perf minus all-patients perf, 3 decimals; null without both values.")
    direction: Literal["higher", "lower"] | None = Field(description="Sign of delta; null when it is 0 or null.")
    flagged: bool = Field(description="|delta| ≥ min_delta and the confidence intervals do not overlap (/meta.subgroup_difference).")
    reason: Literal["separated", "below_delta", "ci_overlap", "missing_ci", "no_result", "layer_differs"]
    compared_with: SubgroupLayer | None | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Only when the card has local results for the chosen population (v1.13, §24): the layer of the all-patients "
            "result the group was compared with (public: public_all_patients when all_patients is not public); null when "
            "it was compared with nothing."
        ),
    )


class SubgroupResult(ApiModel):
    """One concept's result at one lens for the Across groups comparison (v1.13, CONTRACT.md §24)."""

    axis: Literal["all", "age", "sex", "ethnicity"] = Field(description="all for the all-patients entry.")
    group: str | None = Field(description="The specific lens value (e.g. Age 65+); null for all patients.")
    lens: Lens
    has_result: bool = Field(description="Whether a row exists at the lens (stored, fallback, anchor, or rollup).")
    perf: float | None
    ci_low: float | None
    ci_high: float | None
    performance_grade: Grade | None
    evidence_grade: Grade | None
    overall: Overall
    status: RowStatus
    intended_use_level: IntendedUseLevel | None
    safety: SafetyMark | None = Field(description="The concept's safety mark at the lens (CONTRACT.md §18).")
    provenance: Provenance | None = Field(description="As getConceptMetrics serves it, data_source included; null without a row.")
    n_samples: int | None = Field(
        description="v1.14 (§24): the row's patients or cases (n_samples, as getConceptMetrics serves it; a mean for a rollup or a lens fallback); null without a row or count."
    )
    n_sites: int | None = Field(description="v1.14 (§24): the row's sites (n_sites); null without a row or count.")
    layer: SubgroupLayer | None | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Only when the card has local results for the chosen population (v1.13, §24): local (a local result), "
            "includes_local (a block or chapter with at least one local condition), or public; null without a row."
        ),
    )
    difference: SubgroupDifference | SkipJsonSchema[None] = Field(
        default=None, description="Groups only: the difference from all patients. Absent on the all-patients entry."
    )


class SubgroupFilters(ApiModel):
    model: str
    use_case: str
    context: str


class ConceptSubgroups(ApiModel):
    dataset_version: str
    concept: Concept
    filters: SubgroupFilters
    all_patients: SubgroupResult
    public_all_patients: SubgroupResult | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.13 (§24): when all_patients is local or includes local results, the card's public all-patients result "
            "(layer public, or no result), which public groups are compared with; absent otherwise."
        ),
    )
    groups: list[SubgroupResult] = Field(
        description="Every one-group lens: each specific age, then sex, then ethnicity value (axis order of /meta), the other axes at All."
    )
    population: PopulationField = None
    mapping: ConceptMapping | None | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Reads in another ontology (v1.13, §23) only: the concept's crosswalk to ICD-11 as getConceptMetrics serves it; "
            "null for chapters and blocks, kind none for an unmapped concept (whose entries then have no result)."
        ),
    )
    ontology: OntologyField = None


class SubgroupSummaryCondition(ApiModel):
    """A depth-1 ICD-11 condition flagged in one group (v1.14, CONTRACT.md §24)."""

    concept_id: ConceptId
    code: str | None = Field(description="The ICD-11 code.")
    pt: str
    chapter_id: str
    delta: float = Field(description="Group perf minus the all-patients perf it was compared with, 3 decimals.")
    direction: Literal["higher", "lower"]


class SubgroupSummaryGroup(ApiModel):
    """One one-group lens over a card's depth-1 ICD-11 conditions (v1.14, CONTRACT.md §24). A heuristic, never a grade."""

    axis: Literal["age", "sex", "ethnicity"]
    group: str = Field(description="The specific lens value, e.g. Age 65+.")
    lens: Lens
    with_result: int = Field(description="Conditions with a performance value in the group.")
    no_result: int = Field(description="Conditions with a performance value at all patients but none in the group.")
    compared: int = Field(description="Conditions whose group result was compared with an all-patients result (a delta exists).")
    flagged_higher: int
    flagged_lower: int
    flagged: list[SubgroupSummaryCondition] = Field(
        max_length=5, description="Up to 5 flagged conditions, largest |delta| first (then ICD-11 order)."
    )


class SubgroupSummary(ApiModel):
    """getSubgroupSummary (v1.14, CONTRACT.md §24): per one-group lens, how many of a card's depth-1
    ICD-11 conditions differ from all patients. A prototype heuristic, never a grade."""

    dataset_version: str
    filters: SubgroupFilters
    classification_basis: Literal["icd11"] = Field(description="Always icd11: counted over ICD-11 depth-1 conditions, whatever ontology was asked for.")
    total: int = Field(description="Depth-1 ICD-11 conditions.")
    all_patients_with_result: int = Field(description="Conditions with a performance value at all patients.")
    layered: bool = Field(description="True when the card has local results for the chosen population: groups are compared within their layer (§24 Layers).")
    groups: list[SubgroupSummaryGroup] = Field(description="Every one-group lens, in the order of getConceptSubgroups.")
    population: PopulationField = None


EffectMeasure = Literal[
    "risk_ratio", "odds_ratio", "hazard_ratio", "risk_difference", "mean_difference", "standardized_mean_difference",
]


class Effect(ApiModel):
    """One intervention effect (contract v1.13, CONTRACT.md §27): what using the AI system changed for
    patients or care against a comparator, from a study that compared care with and without it. Synthetic.
    **Never part of any grade, status, Overview, comparison flag, or summary.**"""

    effect_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")
    study_id: str = Field(description="The study that measured the effect (Studies, §22).")
    model_version: str
    use_case: str
    codes: list[str] = Field(description="ICD-11 codes as given; empty for an effect on a whole chapter.")
    condition_ids: list[str] = Field(description="The depth-1 condition of each code, in the same order.")
    chapter_id: str | None = Field(description="The chapter the effect concerns as a whole, or null.")
    outcome: str = Field(max_length=200)
    outcome_type: Literal["benefit", "harm", "process"]
    population: str
    comparator: str = Field(description='What care with the AI system was compared with, e.g. "Usual care without the AI system".')
    effect_measure: EffectMeasure = Field(
        description="Ratios (risk, odds, hazard) have the null value 1; differences the null value 0."
    )
    estimate: float = Field(description="AI system against comparator.")
    ci_low: float = Field(description="Lower bound of the 95% confidence interval (≤ estimate; > 0 for a ratio).")
    ci_high: float = Field(description="Upper bound of the 95% confidence interval (≥ estimate).")
    unit: str | None = Field(description='The unit of a difference, e.g. "minutes", or null.')
    direction: Literal["higher_is_better", "lower_is_better"] = Field(
        description="Which side of the null value favours the AI system."
    )
    follow_up: str | None
    appraisal_tool: Literal["rob2", "robins_i"] = Field(
        description="RoB 2 for a randomized trial, ROBINS-I for a prospective study or a real-world deployment."
    )
    judgement: Literal["low", "some_concerns", "high", "critical", "unclear"] = Field(
        description="The overall risk-of-bias judgement; critical with ROBINS-I only."
    )
    notes: str | None
    study: Study | None = Field(
        description="The study record of the version (design, setting, who ran it); null when the version's studies set no longer holds it."
    )


class EffectList(ApiModel):
    """``listEffects`` (v1.13, CONTRACT.md §27): the effects of the version, in stored order."""

    dataset_version: str
    effects: list[Effect]


class ConceptMetrics(ApiModel):
    dataset_version: str
    concept: Concept
    path: list[Concept] = Field(description="Chapter → block → concept.")
    metrics: MetricRow | None
    incidents: list[SafetyIncident] = Field(
        description=(
            "Safety incidents of the card that apply to the concept at the lens, closed ones included, newest first "
            "(v1.7). Rollups list those of their conditions."
        )
    )
    effects: list[Effect] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Intervention effects of the card that concern the concept (v1.13, §27), in stored order; a rollup lists "
            "those of its conditions. Absent when there are none. Never part of any grade."
        ),
    )
    population: PopulationField = None
    mapping: ConceptMapping | None | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "Reads in another ontology (v1.13) only: the condition's crosswalk to ICD-11; null for chapters and blocks "
            "(rollups), kind none for one none of whose conditions maps."
        ),
    )
    other_parents: list[ConceptRef] | SkipJsonSchema[None] = Field(
        default=None,
        description="Reads in another ontology (v1.13), conditions only: the parents besides the primary one (MONDO is a graph).",
    )
    public_metrics: MetricRow | None | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.13 (CONTRACT.md §26): when metrics is a local result (provenance.layer local), the card's public row for "
            "the same concept and lens under the same prevalence, or null when there is none; absent otherwise."
        ),
    )
    ontology: OntologyField = None


# ------------------------------------------------------------- comparison

ComparisonReasonCode = Literal[
    "function_category_differs", "function_category_unknown", "population_differs", "measure_differs", "measure_unknown",
    "no_mapping", "mapped_broader", "no_result", "out_of_scope", "lens_fallback", "design_differs", "setting_differs",
]
StudySettingCategory = Literal["emergency_department", "intensive_care", "inpatient_ward", "outpatient_clinic", "primary_care", "mixed"]
DesignGroup = Literal["clinical_study", "test_cases", "internal_test"]


class ComparisonReason(ApiModel):
    """Why a row's results are not directly comparable (v1.13, CONTRACT.md §25), and the cards it concerns."""

    code: ComparisonReasonCode
    cards: list[str] = Field(description="The card ids (model_version|use_case) the reason concerns, in request order.")


class ComparisonLenses(ApiModel):
    stored: int = Field(description="How many lens combinations the card stores rows for at the requested setting (v1.14, §29).")
    total: int = Field(description="How many lens combinations the axes define per setting (90).")
    all_patients_only: bool = Field(description="The card stores the all-population lens only (a product), at the requested setting.")
    requested: Literal["stored", "fallback", "none"] = Field(
        description="The requested lens: stored as such, combined from narrower groups (§7), or not stored at all."
    )
    settings: list[ContextLens] | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.14 (CONTRACT.md §29): the care settings the card stores rows for, Clinical (Any setting) first; "
            "sent only when it stores a specific setting."
        ),
    )


class ComparisonConfiguration(ApiModel):
    """A compared card's configuration (v1.14, CONTRACT.md §25, §28.1): its id and date, each null when not given."""

    configuration_id: str | None = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")
    configuration_date: date | None


class ComparisonNarrowModelCard(ApiModel):
    """Whether the compared card's AI system has a narrow model card (v1.14, CONTRACT.md §25, §26.4). Never verified."""

    present: bool
    submitted_at: str | None = Field(description="When the narrow model card was submitted; null when there is none.")


class ComparisonConductors(ApiModel):
    """The compared card's linked studies by who conducted them (v1.14, CONTRACT.md §25, §22)."""

    developer: int = Field(ge=0)
    independent: int = Field(ge=0)
    hospital: int = Field(ge=0)


class ComparisonCard(ApiModel):
    """The header facts of one compared card (v1.13, CONTRACT.md §25)."""

    card_id: str
    model_version: str
    use_case: str
    display_name: str
    kind: EntryKind
    developer: str | None
    status: str
    function_category: FunctionCategory | None
    intended_use_defined: bool
    lenses: ComparisonLenses
    studies: list[Study] = Field(description="The study records linked to any stored row of the card (§22), in stored order.")
    validation_types: list[str] = Field(
        description="The validation types of the card's depth-1 ICD-11 conditions at the requested lens, in §4.2 order."
    )
    design_groups: list[DesignGroup] = Field(description="The design groups of those validation types and linked studies.")
    # Contract v1.14 (Q4, CONTRACT.md §25): what the figures measure and the configuration only when given.
    performance_measure: str | SkipJsonSchema[None] = Field(
        default=None, max_length=200, description="v1.14 (§28.1): what the card's Performance figures measure; absent when not given."
    )
    reference_standard: str | SkipJsonSchema[None] = Field(
        default=None, max_length=200, description="v1.14 (§28.1): what the figures are measured against; absent when not given."
    )
    configuration: ComparisonConfiguration | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§28.1): the card's configuration id and date; absent when it states neither."
    )
    narrow_model_card: ComparisonNarrowModelCard | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§26.4): whether the AI system has a narrow model card; always sent since v1.14."
    )
    conductors: ComparisonConductors | SkipJsonSchema[None] = Field(
        default=None, description="v1.14: the linked studies (studies) counted by who conducted them; always sent since v1.14."
    )


class ComparisonCell(ApiModel):
    """One card's result for one row, as the atlas shows it (v1.13, CONTRACT.md §25)."""

    status: Status = Field(description="Overview status as presented: a rollup without children or No mapping is no_data.")
    performance_status: Status
    evidence_status: Status
    perf: float | None
    ci_low: float | None
    ci_high: float | None
    evidence_grade: Grade | None
    validation_type: str | None
    study_design: StudyDesign | None = Field(description="The design of the study a stored row links (§22), else null.")
    design_group: DesignGroup | None
    lens_fallback: bool
    safety: SafetyMark | None
    # Contract v1.14 (Q4, CONTRACT.md §25): on cells with values only, each left out when it does not apply.
    layer: SubgroupLayer | SkipJsonSchema[None] = Field(
        default=None,
        description=(
            "v1.14 (§26.1): local, includes_local, or public, on a cell with values of a card that has local results for "
            "the population; absent otherwise."
        ),
    )
    setting_category: StudySettingCategory | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (§22): the setting category of the study the cell's stored row links, when it states one; absent otherwise."
    )


class ComparisonRow(ApiModel):
    concept_id: ConceptId
    code: str | None = Field(description="The concept's code in the chosen ontology (ICD-11 code, ICD-10-CM code, MONDO id), else null.")
    pt: str
    level: int = Field(ge=0, le=2)
    parent_id: str | None
    chapter_no: str | None
    mapping: MappingKind | None = Field(description="Another ontology only: the condition's crosswalk kind (§23); null for ICD-11 and rollups.")
    cells: list[ComparisonCell] = Field(description="One cell per card, in the order of cards.")
    comparable: bool = Field(description="True when every card has a result and no reason applies.")
    reasons: list[ComparisonReason] = Field(description="Card-level reasons first, then the row's, in /meta.comparison.reasons order.")
    perf_spread: float | None = Field(description="Largest difference in perf between cards with a result; null for fewer than two.")


class ComparisonFilters(ApiModel):
    context: str
    lens: Lens
    scope: Literal["atlas", "chapter"]
    chapter_id: str | None
    chapter_pt: str | None = Field(description="The chapter's preferred term at chapter scope, else null.")


class Comparison(ApiModel):
    """``getComparison`` (v1.13, CONTRACT.md §25): 2–4 cards side by side, with comparability per row."""

    dataset_version: str
    filters: ComparisonFilters
    cards: list[ComparisonCard]
    card_reasons: list[ComparisonReason] = Field(description="The reasons that hold on every row (they are also in each row's reasons).")
    rows: list[ComparisonRow]
    population: PopulationField = None
    ontology: OntologyField = None


class ComparisonDesignGroup(ApiModel):
    validation_types: list[str]
    study_designs: list[StudyDesign]


class ComparisonDesignGroups(ApiModel):
    clinical_study: ComparisonDesignGroup
    test_cases: ComparisonDesignGroup
    internal_test: ComparisonDesignGroup


class ComparisonMeta(ApiModel):
    """The published comparability rule (v1.13, CONTRACT.md §25). A prototype heuristic."""

    min_cards: int
    max_cards: int
    reasons: list[ComparisonReasonCode]
    design_groups: ComparisonDesignGroups
    heuristic: Literal[True]


# --------------------------------------------------------- multimorbidity

class MultimorbidityCandidates(ApiModel):
    dataset_version: str
    has_multimorbidity: bool
    selected: list[str]
    combination_key: str | None = None
    candidate_ids: list[str]
    display: MetricMap
    population: PopulationField = None


class MultimorbidityCombination(ApiModel):
    dataset_version: str
    selected: list[str]
    combination_key: str
    combination_label: str | None
    metrics: MetricRow | None
    population: PopulationField = None


# ----------------------------------------------------------------- search

class SearchResult(Concept):
    """A search match: the concept record; a synonym match (v1.14, CONTRACT.md §31) adds two fields."""

    match: Literal["synonym"] | SkipJsonSchema[None] = Field(
        default=None,
        description="Contract v1.14 (CONTRACT.md §9, §31): synonym for a concept found by a synonym only; absent for every other match.",
    )
    matched_term: str | SkipJsonSchema[None] = Field(
        default=None, description="Contract v1.14: the synonym the concept was found by (with match synonym only)."
    )


class SearchResults(ApiModel):
    query: str
    total: int
    results: list[SearchResult]
    population: PopulationField = None
    ontology: OntologyField = None


# ------------------------------------------------- plain-language search (v1.14, §31)

ChipKind = Literal["system", "function", "condition", "age", "sex", "ethnicity", "setting"]


class InterpretationChip(ApiModel):
    kind: ChipKind
    value: str = Field(
        description=(
            "The contract value: a model_version (system), a use_case (function), a concept_id (condition), a lens value "
            "(age, sex, ethnicity), or a care setting's Context axis value (setting)."
        )
    )
    label: str = Field(description="Plain words for the chip: the system's display name, the function, the preferred term, Women, Age 65+, …")
    matched_text: str = Field(description="The words of the query the chip was read from (empty for a helper chip whose words are not in the query).")
    code: str | SkipJsonSchema[None] = Field(default=None, description="Conditions only: the ICD-11 code (else the concept id).")
    pt: str | SkipJsonSchema[None] = Field(default=None, description="Conditions only: the preferred term.")
    match: Literal["term", "synonym", "code"] | SkipJsonSchema[None] = Field(
        default=None, description="Conditions only: found by its preferred term, a synonym, or its code."
    )
    matched_term: str | SkipJsonSchema[None] = Field(default=None, description="Conditions found by a synonym: the synonym.")
    concept: Concept | SkipJsonSchema[None] = Field(default=None, description="Conditions only: the ICD-11 concept record, to open it.")


class Interpretation(ApiModel):
    query: str = Field(description="The query, trimmed with its spacing collapsed (at most 200 characters).")
    chips: list[InterpretationChip] = Field(description="Ordered by kind (system, function, condition, sex, age, ethnicity, setting), then position.")
    unrecognized: list[str] = Field(description="Runs of words no rule recognized (stopwords left out), and the words of chips that cancelled.")


class InterpretRequest(ApiModel):
    q: str = Field(min_length=1, max_length=200, description="The query, as the reader typed it.")


class DroppedChip(ApiModel):
    kind: str
    value: str
    reason: Literal["unknown_kind", "unknown_value", "not_found", "conflict", "limit"]


class HelperInterpretation(Interpretation):
    """The optional helper's interpretation (v1.14, CONTRACT.md §20, §31), every chip checked against the vocabularies."""

    provider: Literal["hosted", "local"]
    model: str
    dropped: list[DroppedChip] = Field(description="Chips the helper proposed that are not in the vocabularies (or not found), with the reason.")


# ----------------------------------------------------------------- export

class ExportedConcept(ApiModel):
    code: str | None = None
    block: str | None = None
    name: str | SkipJsonSchema[None] = None
    hierarchy: list[str] | SkipJsonSchema[None] = None
    mapping: ConceptMapping | None | SkipJsonSchema[None] = Field(
        default=None, description="Exports in another ontology (v1.13) only: the concept's crosswalk to ICD-11."
    )


class ExportContext(ApiModel):
    model: str | SkipJsonSchema[None] = None
    use_case: str | SkipJsonSchema[None] = None
    population: Lens | SkipJsonSchema[None] = None
    setting: ContextLens | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (CONTRACT.md §29): the care setting read, only when a specific one was."
    )


class ConceptExport(ApiModel):
    exported_at: datetime
    audience_view: Literal["patient", "expert"]
    dataset_version: str
    synthetic_data_notice: str
    concept: ExportedConcept
    context: ExportContext
    model_card: MetricRow | None
    warnings: list[Warning]
    safeguards: list[Safeguard]
    population: PopulationField = None
    ontology: OntologyField = None


class DatasetExport(ApiModel):
    meta: dict
    concepts: list[Concept]
    metric_axes: Axes
    metrics_by_key: dict[str, MetricRow]
    summary: dict | SkipJsonSchema[None] = None
    population: PopulationField = None


# -------------------------------------------------------------- catalogue

class CatalogueLens(ApiModel):
    context: str
    age: AgeLens
    sex: SexLens
    ethnicity: EthnicityLens


class CatalogueSystem(ApiModel):
    """The registry entry ("AI system") of a tile (CONTRACT.md §11.1)."""

    display_name: str
    model_name: str | None
    model_release: str | None
    status: Literal["ACTIVE", "EXPERIMENTAL"] = Field(
        description="Registry status; the catalogue's status filter uses it (CONTRACT.md §17)."
    )
    kind: EntryKind
    ai_type: AiType | None
    developer: str | None
    release_date: date | None
    description: str | None = Field(max_length=280)
    built_on: list[str]
    replaces: str | SkipJsonSchema[None] = Field(
        default=None, description=f"{_LINEAGE}: the model version this AI system supersedes; sent only when given."
    )
    replaced_by: list[str] | SkipJsonSchema[None] = Field(
        default=None, description=f"{_LINEAGE}: the entries that supersede this one (derived); sent only when not empty."
    )


class PerformanceDistribution(ApiModel):
    strong: int
    moderate: int
    weak: int
    no_data: int


class EvidenceDistribution(ApiModel):
    strong: int
    moderate: int
    weak: int
    no_data: int


class IntendedUseDistribution(ApiModel):
    in_scope: int
    partially_in_scope: int
    out_of_scope: int
    no_data: int


class TileDistribution(ApiModel):
    """Conditions per status for each view, at the catalogue lens (CONTRACT.md §17)."""

    overall: StatusCounts
    performance: PerformanceDistribution
    evidence: EvidenceDistribution
    intended_use: IntendedUseDistribution | None = Field(
        description="Null for a card without an intended-use statement (v1.11)."
    )


class TileChapter(ApiModel):
    chapter_id: str
    chapter_no: str = Field(pattern=r"^[0-9]{2}$")
    condition_count: int
    overall: StatusCounts


class TileSafety(ApiModel):
    """A card's safety incidents over every lens (contract v1.7): the open ones by derived
    severity (serious + caution = open), and every incident by status."""

    serious: int
    caution: int
    open: int
    mitigated: int
    closed: int


class LastUpdated(ApiModel):
    version: int = Field(description="The newest published version that changed this configuration (CONTRACT.md §17).")
    at: datetime


class TileSnapshot(ApiModel):
    """Per subchapter, aligned with ``Catalogue.snapshot_blocks`` (contract v1.11, CONTRACT.md §17)."""

    overview: list[Status] = Field(description="Each subchapter's Overview status at the catalogue lens.")
    safety: list[SafetyMark | None] = Field(
        description="Each subchapter's safety mark from open and mitigated incidents at the catalogue lens, or null."
    )


class SnapshotBlock(ApiModel):
    id: str = Field(description="The subchapter's concept id.")
    chapter: str = Field(description="Its chapter's concept id.")


class CatalogueTile(ApiModel):
    card_id: str = Field(description="<model_version>|<use_case>.")
    model_version: str
    use_case: str
    system: CatalogueSystem
    function_category: FunctionCategory | None
    declarations: Declarations | None
    intended_use_defined: bool | SkipJsonSchema[None] = Field(
        default=None, description="Whether the card has an intended-use statement (v1.11); absent means true."
    )
    configuration: ConfigurationRecord | SkipJsonSchema[None] = Field(default=None, description=_CONFIGURATION)
    performance_measure: str | SkipJsonSchema[None] = Field(default=None, max_length=200, description=_MEASURE)
    reference_standard: str | SkipJsonSchema[None] = Field(default=None, max_length=200, description=_MEASURE)
    has_multimorbidity: bool
    is_default_use_case: bool
    distribution: TileDistribution
    chapters: list[TileChapter] = Field(description="Every chapter, in chapter order, also those without conditions.")
    snapshot: TileSnapshot | SkipJsonSchema[None] = Field(
        default=None, description="Per-subchapter Overview status and safety mark (v1.11); always sent."
    )
    safety: TileSafety
    last_updated: LastUpdated
    staged_change: bool = Field(
        description="True in a staged read when the staged upload changes this configuration; always false in live reads."
    )


class Catalogue(ApiModel):
    """One tile per configuration, in registry order (CONTRACT.md §17). Added in v1.6."""

    dataset_version: str
    synthetic_data_notice: str
    lens: CatalogueLens
    condition_count: int = Field(description="The depth-1 top-level conditions every distribution counts.")
    snapshot_blocks: list[SnapshotBlock] | SkipJsonSchema[None] = Field(
        default=None,
        description="The subchapters, in atlas order, that every tile's snapshot lists (v1.11); always sent.",
    )
    tiles: list[CatalogueTile]
    population: PopulationField = None


# ----------------------------------------------------------------- lookup
# The live interaction plugin's lookup (contract v1.8, CONTRACT.md §19). The
# request is shaped like a CDS Hooks context and closed at every level, so free
# text or identifiers cannot be sent along with the codes.

MAX_LOOKUP_CONDITIONS = 12
LookupAgeGroup = Literal["0-17", "18-39", "40-64", "65+"]
LookupSex = Literal["female", "male"]
LookupEthnicity = Literal["white", "black", "hispanic", "asian", "other"]
# Contract v1.14 (§29): the care settings' codes (the first five study setting categories).
LookupSetting = Literal["emergency_department", "intensive_care", "inpatient_ward", "outpatient_clinic", "primary_care"]


class LookupCardRef(ApiModel):
    model_version: str = Field(min_length=1, max_length=200)
    use_case: str = Field(min_length=1, max_length=200)


class LookupCoding(ApiModel):
    system: Literal["http://id.who.int/icd/release/11/mms"] | None = Field(
        default=None, description="Optional; if given, the ICD-11 MMS URI."
    )
    code: str = Field(
        pattern=r"^[A-Za-z0-9.]{1,16}$",
        description="An ICD-11 MMS code, e.g. 5A11 or 1A03.0. Letters, digits, and dots only.",
    )


class LookupPopulation(ApiModel):
    """Coarse population values only; null or absent means the whole population on that axis."""

    age_group: LookupAgeGroup | None = None
    sex: LookupSex | None = None
    ethnicity: LookupEthnicity | None = None


class LookupContext(ApiModel):
    card: LookupCardRef
    conditions: list[LookupCoding] = Field(min_length=1, max_length=MAX_LOOKUP_CONDITIONS)
    population: LookupPopulation | None = Field(default=None, description="Absent or null: the whole population.")
    population_id: str | None = Field(
        default=None,
        pattern=r"^[a-z0-9][a-z0-9-]{0,39}$",
        description="A local population from /meta populations (v1.10); absent or null: the default population.",
    )
    setting: LookupSetting | None = Field(
        default=None,
        description=(
            "v1.14 (CONTRACT.md §29): a specific care setting by its code; absent or null: any setting. "
            "Other values: 422 invalid_lens."
        ),
    )


class LookupRequest(ApiModel):
    """CDS Hooks–shaped lookup input (v1.8). Unknown keys anywhere are rejected (422)."""

    hook: Literal["broad-modelcard-lookup"] | None = None
    context: LookupContext


class LookupCard(ApiModel):
    model_version: str
    use_case: str
    display_name: str
    kind: EntryKind
    card_url: str = Field(description="The card on the atlas, relative to the frontend root (CONTRACT.md §19).")
    intended_use_defined: bool | SkipJsonSchema[None] = Field(default=None, description="Whether the card has an intended-use statement (v1.11); absent means true.")


class LookupLens(ApiModel):
    context: str
    age: AgeLens
    sex: SexLens
    ethnicity: EthnicityLens


class LookupStatuses(ApiModel):
    overall: Status
    performance: Status
    evidence: Status
    intended_use: IntendedUseLevel | None = Field(description="The intended-use level; null when there is no row.")


class LookupCondition(ApiModel):
    """A code that names a level-2 concept: what /metrics/concepts serves for it at the lens."""

    code: str
    matched: Literal[True]
    concept_id: str
    pt: str
    icd11_code: str
    anchor_id: str = Field(description="The depth-1 condition whose row the concept shows (its own id at depth 1).")
    statuses: LookupStatuses
    safety: SafetyMark | None
    warnings: list[Warning]
    safeguards: list[Safeguard]
    incidents: list[SafetyIncident]
    provenance: Provenance | None = Field(description="Null when the condition has no row at the lens.")
    card_url: str


class LookupUnmatchedCondition(ApiModel):
    """A code that names no level-2 concept of the atlas."""

    code: str
    matched: Literal[False]


class LookupCombination(ApiModel):
    """The stored combination of the matched conditions (CONTRACT.md §8); never inferred."""

    combination_key: str
    label: str
    concept_ids: list[str] = Field(description="The matched conditions as depth-1 anchors, in request order.")
    statuses: LookupStatuses
    safety: SafetyMark | None
    warnings: list[Warning]
    safeguards: list[Safeguard]
    provenance: Provenance | None
    card_url: str


class Lookup(ApiModel):
    """Statuses, warnings, safeguards, and incidents per code on one card (v1.8). Nothing is stored or logged."""

    dataset_version: str
    synthetic_data_notice: str
    disclaimer: str
    card: LookupCard
    lens: LookupLens
    conditions: list[LookupCondition | LookupUnmatchedCondition] = Field(description="One entry per code, in request order.")
    combination: LookupCombination | None
    population: PopulationField = None


# ------------------------------------------------------------------- admin

DatasetKind = Literal[
    "models", "metrics", "multimorbidity", "prevalence", "safety", "population", "studies", "effects", "local_metrics",
    "model_cards",
]
# What an upload can be (v1.14, CONTRACT.md §32.2): a data set, or evaluation results, which are no data set.
UploadKind = Literal[
    "models", "metrics", "multimorbidity", "prevalence", "safety", "population", "studies", "effects", "local_metrics",
    "model_cards", "evaluation_results",
]
# Records uploads (v1.7); since v1.13 a developer submission may send its registry rows (models) too.
RecordsKind = Literal["metrics", "prevalence", "safety", "studies", "effects", "local_metrics", "models"]
PublisherRole = Literal["developer", "custodian", "hospital", "maintainer"]
UploadMode = Literal["replace", "merge"]
UploadStatus = Literal["checking", "invalid", "valid", "published", "discarded", "superseded"]


class DatasetInfo(ApiModel):
    kind: DatasetKind
    version: int
    updated_at: datetime
    counts: dict[str, int] = Field(description="E.g. models, use_cases, metric_rows, combinations, codes.")
    staged_upload_id: str | None
    staged_upload_ids: list[str] | SkipJsonSchema[None] = None


class IssueExample(ApiModel):
    row: int
    column: str | None = None
    value: str | None = None
    problem: str
    record: int | SkipJsonSchema[None] = Field(
        default=None, description="Records uploads only (v1.7): the index of the record (row − 2)."
    )


class IssueGroup(ApiModel):
    code: str
    message: str
    fix: str
    count: int
    examples: list[IssueExample] = Field(max_length=20)


class ValidationReport(ApiModel):
    row_count: int
    errors: list[IssueGroup]
    notes: list[IssueGroup]


class UploadTarget(ApiModel):
    """The card of a metrics or multimorbidity upload, or (v1.10) the local population of a population upload."""

    model_version: str | SkipJsonSchema[None] = None
    use_case: str | SkipJsonSchema[None] = None
    population_id: str | SkipJsonSchema[None] = None
    population_name: str | SkipJsonSchema[None] = None


class Upload(ApiModel):
    upload_id: str
    kind: UploadKind = Field(description="A data set kind, or (v1.14, CONTRACT.md §32.2) evaluation_results, which publish nothing.")
    filename: str
    status: UploadStatus
    progress: float = Field(ge=0, le=1)
    created_at: datetime
    target: UploadTarget | None
    report: ValidationReport | None
    previewed: bool
    mode: UploadMode = Field(description="replace or merge (v1.7).")
    origin: Literal["file", "records"] = Field(description="An uploaded file, or JSON records (v1.7).")
    submission_id: str | None = Field(
        default=None, description="v1.13 (CONTRACT.md §26): the developer submission the upload belongs to, or null."
    )


class RowSample(ApiModel):
    key: str
    name: str
    concept_id: str | None
    code: str | None
    lens: Lens | None
    setting: ContextLens | SkipJsonSchema[None] = Field(
        default=None, description="v1.14 (CONTRACT.md §29): the care setting of a metrics row of a specific setting; absent for Any setting."
    )


class RowSettingChanges(ApiModel):
    """Rows of one specific care setting that an upload adds, changes, or removes (v1.14, CONTRACT.md §29)."""

    setting: ContextLens
    added: int
    changed: int
    removed: int


class RowSamples(ApiModel):
    added: list[RowSample] = Field(max_length=50)
    changed: list[RowSample] = Field(max_length=50)
    removed: list[RowSample] = Field(max_length=50)


class RowChanges(ApiModel):
    added: int
    changed: int
    removed: int
    unchanged: int
    samples: RowSamples | SkipJsonSchema[None] = None
    settings: list[RowSettingChanges] | SkipJsonSchema[None] = Field(
        default=None,
        description="v1.14 (CONTRACT.md §29): metrics and local results only, per specific care setting the upload touches; absent when it touches Any setting only.",
    )


class ModelChanges(ApiModel):
    added: list[str] | SkipJsonSchema[None] = None
    changed: list[str] | SkipJsonSchema[None] = None
    removed: list[str] | SkipJsonSchema[None] = None


class UseCaseChanges(ApiModel):
    added: list[str] | SkipJsonSchema[None] = None
    removed: list[str] | SkipJsonSchema[None] = None


class StatusShiftTarget(ApiModel):
    model_version: str
    use_case: str
    count: int
    sample_concept_ids: list[str] = Field(max_length=50)


class StatusShift(ApiModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    view: MetricView
    from_: str = Field(alias="from")
    to: str
    count: int
    sample_concept_ids: list[str] = Field(max_length=50)
    targets: list[StatusShiftTarget] | SkipJsonSchema[None] = None


class ChangeSummary(ApiModel):
    upload_id: str
    kind: DatasetKind
    base_version: int
    rows: RowChanges
    models: ModelChanges
    use_cases: UseCaseChanges
    status_shifts: list[StatusShift]


Note = Annotated[
    str | None,
    Field(max_length=500, description="Change note (v1.7), at most 500 characters; stored on the version and shown in history."),
]


PublisherName = Annotated[
    str | None,
    Field(max_length=80, description="v1.13 (CONTRACT.md §26): the name entered in the workspace (no login); shown in history."),
]
PublisherRoleField = Annotated[
    PublisherRole | None,
    Field(description="v1.13 (CONTRACT.md §26): the workspace published in (no login); developer is refused (developers submit)."),
]


class PublishRequest(ApiModel):
    previewed: bool = Field(description="Whether the maintainer previewed on the atlas; recorded in history, not enforced.")
    note: Note = None
    role: PublisherRoleField = None
    publisher_name: PublisherName = None


class RollbackRequest(ApiModel):
    note: Note = None
    role: PublisherRoleField = None
    publisher_name: PublisherName = None


RecordValue = str | int | float | bool | None


class RecordsUploadRequest(ApiModel):
    """JSON records turned into a staged merge upload in template form (v1.7, CONTRACT.md §11.4)."""

    kind: RecordsKind
    model_version: str | SkipJsonSchema[None] = Field(default=None, min_length=1, description="Required for kind=metrics.")
    use_case: str | SkipJsonSchema[None] = Field(default=None, min_length=1, description="Required for kind=metrics.")
    population_id: str | SkipJsonSchema[None] = Field(
        default=None, pattern=r"^[a-z0-9][a-z0-9-]{0,39}$", description="Required for kind=local_metrics (v1.13): the local population."
    )
    submission_id: str | SkipJsonSchema[None] = Field(
        default=None, min_length=1, max_length=64, description="v1.13: join this developer submission (kind=models only with it)."
    )
    mode: Literal["merge"] = "merge"
    records: list[dict[str, RecordValue]] = Field(
        min_length=1,
        max_length=5000,
        description="One object per template row, keyed by column key or header (e.g. incident_id or \"Incident ID\").",
    )
    replace_staged: bool = False


class VersionEntry(ApiModel):
    version_id: int
    kind: DatasetKind | None
    published_at: datetime
    summary: str
    upload_id: str | None
    rollback_of: int | None
    previewed: bool
    note: str | None = Field(description="The change note given on publish or rollback (v1.7), or null.")
    publisher_role: PublisherRole | None | SkipJsonSchema[None] = Field(
        default=None, description="v1.13 (CONTRACT.md §26): the workspace it was published in, or null (no login)."
    )
    publisher_name: str | None = Field(
        default=None, description="v1.13 (CONTRACT.md §26): the name entered when publishing, or null."
    )


# Meta names the comparison rule (v1.13), whose schema is defined after it.
Meta.model_rebuild()


# ------------------------------------------------- v1.13 §26: workspaces, release


class NarrowModelCardResult(ApiModel):
    task: str | None
    dataset: str | None
    metric: str | None
    value: float
    icd11_codes: list[str]
    use_case: str | None
    samples: int | None
    sites: int | None


class NarrowModelCard(ApiModel):
    """A developer's narrow model card of one AI system (v1.13, CONTRACT.md §26). Synthetic; never verified."""

    model_version: str
    source_format: Literal["json", "markdown"]
    name: str | None
    version: str | None
    licence: str | None
    intended_use: str | None
    limitations: str | None
    training_data: str | None
    date: str | None
    results: list[NarrowModelCardResult]
    markdown: str | None = Field(description="The Markdown text as submitted; null for a JSON card.")
    submitted_at: datetime


class NarrowModelCardRead(ApiModel):
    """``getNarrowModelCard`` (v1.13, CONTRACT.md §26)."""

    dataset_version: str
    model_version: str
    narrow_model_card: NarrowModelCard | None


class PublicVersionEntry(ApiModel):
    """One published version for operational systems (v1.13, CONTRACT.md §26)."""

    version_id: int
    published_at: datetime
    kind: DatasetKind | None
    summary: str
    note: str | None
    publisher_role: PublisherRole | None


class VersionFeed(ApiModel):
    """``listDatasetVersions`` (v1.13, CONTRACT.md §26): published versions, newest first."""

    dataset_version: str
    versions: list[PublicVersionEntry]


class SubmissionRequest(ApiModel):
    developer_name: str = Field(min_length=1, max_length=80)
    model_version: str = Field(min_length=1, max_length=64, description="The AI system the submission is about.")
    note: str | None = Field(default=None, max_length=500)


class Submission(ApiModel):
    """A developer submission (v1.13, CONTRACT.md §26): staged uploads that wait for a custodian."""

    submission_id: str
    developer_name: str
    model_version: str
    created_at: datetime
    status: Literal["submitted", "returned", "accepted"]
    note: str | None
    custodian_note: str | None
    decided_by: str | None
    decided_at: datetime | None
    published_versions: list[int]
    uploads: list[Upload]


class SubmissionDecision(ApiModel):
    note: Note = None
    publisher_name: PublisherName = None


class ModelCardUploadRequest(ApiModel):
    """A narrow model card as text (v1.13, CONTRACT.md §26)."""

    model_version: str = Field(min_length=1, max_length=64)
    format: Literal["json", "markdown"]
    content: str = Field(min_length=1, description="The card: JSON, or Markdown with optional simple front matter (at most 1 MB).")
    filename: str | None = Field(default=None, max_length=200)
    submission_id: str | None = Field(default=None, min_length=1, max_length=64)
    replace_staged: bool = False


class ProposedBatch(ApiModel):
    model_version: str
    use_case: str
    records: list[dict[str, RecordValue]]


class ProposedSkip(ApiModel):
    result: int
    code: str | None
    reason: Literal["unknown_code", "no_function", "value_out_of_range"]


class ModelCardProposals(ApiModel):
    """Metric records proposed from a narrow model card's results (v1.13, CONTRACT.md §26); nothing is staged."""

    upload_id: str
    model_version: str
    batches: list[ProposedBatch]
    skipped: list[ProposedSkip]


class ReleaseInfo(ApiModel):
    dataset_version: int
    created_at: datetime
    organisation: str
    maintained_by: str
    format_version: int


class ReleaseProblem(ApiModel):
    code: str
    message: str


class ChangeCounts(ApiModel):
    added: int
    changed: int
    removed: int
    unchanged: int


class ReleaseChanges(ApiModel):
    models: ChangeCounts
    metrics: ChangeCounts
    multimorbidity: ChangeCounts
    prevalence: ChangeCounts
    studies: ChangeCounts
    safety: ChangeCounts
    effects: ChangeCounts
    model_cards: ChangeCounts


class ReleaseKeeps(ApiModel):
    populations: int
    local_results: int
    hospital_studies: int
    hospital_incidents: int


class ReleaseImport(ApiModel):
    """A checked public release import of a hospital instance (v1.13, CONTRACT.md §26)."""

    import_id: str
    filename: str
    created_at: datetime
    status: Literal["invalid", "valid", "published", "discarded"]
    release: ReleaseInfo | None
    problems: list[ReleaseProblem]
    changes: ReleaseChanges | None
    keeps: ReleaseKeeps | None
    notes: list[str]
    published_version: int | None


class ReleasePublishRequest(ApiModel):
    note: Note = None
    role: PublisherRoleField = None
    publisher_name: PublisherName = None


# --------------------------------------------- evaluation results (v1.14)

class EvaluationUploadRequest(ApiModel):
    """An evaluation results file as text (v1.14, CONTRACT.md §32.2): format bmc-evaluation-results/1."""

    content: str = Field(min_length=1, description="The JSON file of one evaluation run for one card (at most 1 MB).")
    filename: str | None = Field(default=None, max_length=200)
    submission_id: str | None = Field(default=None, min_length=1, max_length=64)
    replace_staged: bool = False


class EvaluationProposedResult(ApiModel):
    result: int = Field(description="The result's position in the file (0-based).")
    code: str = Field(description="The ICD-11 code as written.")
    concept_id: str = Field(description="The depth-1 condition the record is stored on (its anchor for a subcategory).")
    measure: str


class EvaluationProposals(ApiModel):
    """Records proposed from a valid evaluation results upload (v1.14, CONTRACT.md §32.2): one benchmark
    study record and one metrics merge record per result, for createRecordsUpload (study first). Nothing is staged."""

    upload_id: str
    model_version: str
    use_case: str
    study: dict[str, RecordValue] = Field(description="One record in the studies template's keys (design benchmark).")
    metrics: ProposedBatch
    results: list[EvaluationProposedResult]
    notes: list[IssueGroup] = Field(description="The check's notes (measure_differs_from_card, configuration_not_current, ...).")


# ----------------------------------------------------- card record (v1.14)

class CardRecordGenerated(ApiModel):
    notice: str = Field(description="Synthetic demonstration data; not a certification, an approval, or evidence.")
    synthetic_data_notice: str
    classification: Literal["ICD-11 MMS"]
    lens: CatalogueLens
    prevalence: Literal["default"]


class CardRecordCard(ApiModel):
    function_category: FunctionCategory | None
    is_default_use_case: bool
    intended_use_defined: bool
    declarations: Declarations | None
    has_multimorbidity: bool
    last_updated: LastUpdated
    configuration: ConfigurationRecord | SkipJsonSchema[None] = Field(default=None, description=_CONFIGURATION)
    performance_measure: str | SkipJsonSchema[None] = Field(default=None, max_length=200, description=_MEASURE)
    reference_standard: str | SkipJsonSchema[None] = Field(default=None, max_length=200, description=_MEASURE)


class CardRecordSummary(ApiModel):
    """The Overview counts over the depth-1 conditions at all patients (the catalogue tile's distributions)
    and the conditions by safety mark from the card's public incidents."""

    condition_count: int
    overall: StatusCounts
    performance: PerformanceDistribution
    evidence: EvidenceDistribution
    intended_use: IntendedUseDistribution | None
    safety: SafetyCounts


class CardRecordChapter(ApiModel):
    chapter_id: str
    chapter_no: str = Field(pattern=r"^[0-9]{2}$")
    name: str
    condition_count: int
    overall: Status
    performance: Status
    evidence: Status
    intended_use: Literal["in_scope", "partially_in_scope", "out_of_scope", "no_data"] | None = Field(
        description="The chapter's intended-use level, no_data without one; null for a card without an intended-use statement."
    )
    perf: float | None = Field(description="The chapter rollup's performance (0–1), or null.")
    ci_low: float | None
    ci_high: float | None
    safety: SafetyMark | None
    overall_counts: StatusCounts | None = Field(description="The chapter's conditions by Overview status.")


class CardRecordLinks(ApiModel):
    atlas: str = Field(description="The card on the atlas, relative to the frontend root (atlas.html?…).")
    record: str
    record_jsonld: str
    narrow_model_card: str | None = Field(description="The developer's narrow model card (API path), or null when none is published.")


class CardRecord(ApiModel):
    """``getCardRecord`` (v1.14, CONTRACT.md §32.1): one card for operational systems. Synthetic; never a certification."""

    format: Literal["bmc-card-record/1"]
    dataset_version: str
    generated: CardRecordGenerated
    card_id: str
    model_version: str
    use_case: str
    system: CatalogueSystem
    card: CardRecordCard
    summary: CardRecordSummary
    chapters: list[CardRecordChapter]
    studies: list[Study]
    effects: list[Effect]
    incidents: list[SafetyIncident] = Field(description="The card's public safety incidents, newest first.")
    links: CardRecordLinks


# The JSON-LD form (§32.3): the same content with @context, @id, and @type; the
# keys of CardRecord, open otherwise (nested sections carry @type too).
CARD_RECORD_JSONLD_SCHEMA = {
    "type": "object",
    "required": ["@context", "@id", "@type", "format", "dataset_version", "card_id", "system", "card", "summary", "chapters"],
    "properties": {
        "@context": {"type": "object"},
        "@id": {"type": "string"},
        "@type": {"type": "string", "const": "obo:MCRO_0000001"},
        "format": {"type": "string", "const": "bmc-card-record/1"},
        "dataset_version": {"type": "string"},
        "card_id": {"type": "string"},
        "system": {"type": "object"},
        "card": {"type": "object"},
        "summary": {"type": "object"},
        "chapters": {"type": "array", "items": {"type": "object"}},
    },
}


# ------------------------------------------------------ CDS Hooks (v1.14)
# A local CDS Hooks–shaped service (CONTRACT.md §33). The request is parsed by
# hand (FHIR resources are open objects); these models shape the responses.

class CdsServiceInfo(ApiModel):
    id: str
    hook: Literal["patient-view"]
    title: str
    description: str
    prefetch: dict[str, str]
    usageRequirements: str
    extension: dict[str, Any] = Field(description="broad-modelcard: the default card, the dataset version, and the notice.")


class CdsServices(ApiModel):
    """CDS Hooks discovery (v1.14, CONTRACT.md §33)."""

    services: list[CdsServiceInfo]


class CdsSource(ApiModel):
    label: str


class CdsLink(ApiModel):
    label: str
    url: str
    type: Literal["absolute"]


class CdsCard(ApiModel):
    uuid: str
    summary: str = Field(max_length=140)
    indicator: Literal["info", "warning", "critical"]
    detail: str = Field(description="Short markdown: status, top warnings, safeguards, open incidents, the synthetic-data line.")
    source: CdsSource
    links: list[CdsLink]
    extension: dict[str, Any] = Field(description="broad-modelcard: the code, its system, the mapping, statuses, and safety mark.")


class CdsResponse(ApiModel):
    """One CDS card per condition of the request (v1.14, CONTRACT.md §33). Synthetic; not for clinical use."""

    cards: list[CdsCard]


CDS_REQUEST_SCHEMA = {
    "type": "object",
    "required": ["hook", "hookInstance", "context"],
    "properties": {
        "hook": {"type": "string", "const": "patient-view"},
        "hookInstance": {"type": "string", "maxLength": 128},
        "fhirServer": {"type": "string"},
        "context": {
            "type": "object",
            "required": ["patientId"],
            "properties": {"patientId": {"type": "string", "maxLength": 128}, "userId": {"type": "string"}},
        },
        "prefetch": {
            "type": "object",
            "properties": {
                "patient": {"type": ["object", "null"], "description": "FHIR Patient: birthDate and gender are read."},
                "conditions": {
                    "type": ["object", "null"],
                    "description": "FHIR Bundle of Condition resources, code.coding in ICD-11 MMS or ICD-10-CM.",
                },
            },
        },
        "extension": {
            "type": "object",
            "description": "broad-modelcard: {card_id, setting?, population?}; absent: the registry's default card.",
        },
    },
}
