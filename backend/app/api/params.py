"""Query and path parameters shared by the read endpoints (openapi.json ``components.parameters``).

FastAPI validates these before a handler runs. A failure becomes a 422 problem
whose code names the parameter (``invalid_lens``, ``invalid_version``, ...; see
``problems._PARAMETER_CODES``), so parameter errors come before lookups that
return 404.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import Path, Query
from pydantic.json_schema import SkipJsonSchema

from ..schema.contract import ANY_SETTING, POPULATION_ID_PATTERN
from ..services.types import Lens
from .problems import ApiError
from .schemas import AgeLens, ContextLens, EthnicityLens, SexLens, SummaryView, SummaryWeights
from .store import VERSION_PATTERN

MAX_SELECTED = 12

Version = Annotated[
    str,
    Query(
        pattern=VERSION_PATTERN,
        description="live (default) or staged:<upload_id> to read a staged, unpublished upload layered over live data.",
    ),
]
# Contract v1.10 (CONTRACT.md §21): read for a local population instead of the default one.
Population = Annotated[
    str | None,
    Query(
        pattern=POPULATION_ID_PATTERN,
        description=(
            "A local population id from /meta populations. Its tiers replace the default prevalence for this request "
            "only; absent: the default population. Unknown: 404 unknown_population."
        ),
    ),
]
# Contract v1.13 (CONTRACT.md §23): read the atlas in another ontology, projected over ICD-11.
ONTOLOGY_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,31}$"
Ontology = Annotated[
    str | None,
    Query(
        pattern=ONTOLOGY_ID_PATTERN,
        description=(
            "An ontology id from /meta ontologies: icd11 (the default; the same as leaving it out), icd10cm, or mondo "
            "when the store imported them. Other ontologies serve the mapped ICD-11 results. Unknown: 404 unknown_ontology."
        ),
    ),
]
Model = Annotated[str, Query(min_length=1, description="model_version from the registry.")]
UseCase = Annotated[str, Query(min_length=1)]
Age = Annotated[AgeLens, Query()]
Sex = Annotated[SexLens, Query()]
Ethnicity = Annotated[EthnicityLens, Query()]
# Contract v1.14 (CONTRACT.md §29): the care setting, the Context axis of the lens.
#: Declare it as ``setting: Context = ANY_SETTING`` (handlers use ``context`` for the version context).
Context = Annotated[
    ContextLens,
    Query(
        alias="context",
        description=(
            "The care setting (a /meta axes.context value): Clinical (the default, shown as Any setting; every row "
            "stored without a setting) or a specific setting, which reads only the rows stored for it. "
            "Other values: 422 invalid_lens."
        ),
    ),
]
# getMetricSummary's view: a metric view, or safety marks (contract v1.7).
SummaryViewQuery = Annotated[SummaryView, Query()]
# Contract v1.14 (CONTRACT.md §30): getMetricSummary adds weighted_distribution only when asked.
SummaryWeightsQuery = Annotated[
    SummaryWeights | SkipJsonSchema[None],
    Query(
        description=(
            "prevalence adds weighted_distribution: each status's share of the prevalence weight of the depth-1 "
            "conditions (CONTRACT.md §6's weights, the local population's for a population read). Absent: the "
            "summary is exactly what it was without the parameter. Other values: 422 invalid_parameter."
        ),
    ),
]
Scope = Annotated[Literal["atlas", "chapter"], Query()]
ChapterIdQuery = Annotated[
    str | None, Query(min_length=1, max_length=64, description="Required when scope=chapter.")
]
Selected = Annotated[
    str | None,
    Query(
        description=(
            "Selected condition concept ids in selection order, comma-separated. "
            "Deeper concepts are canonicalized to their metric anchor."
        ),
    ),
]
ConceptIdPath = Annotated[str, Path(min_length=1, max_length=64)]


def lens_of(age: str, sex: str, ethnicity: str, setting: str = ANY_SETTING) -> Lens:
    return Lens(age=age, sex=sex, ethnicity=ethnicity, setting=setting)


def parse_selected(selected: str | None) -> tuple[str, ...]:
    """``selected=a,b,c`` (form style, not exploded). Empty means no selection."""
    if not selected:
        return ()
    ids = tuple(selected.split(","))
    if len(ids) > MAX_SELECTED:
        raise ApiError(422, "invalid_selection", f"Select at most {MAX_SELECTED} conditions; got {len(ids)}.")
    for concept_id in ids:
        if not 1 <= len(concept_id) <= 64:
            raise ApiError(422, "invalid_selection", f"Invalid concept id {concept_id!r} in selected.")
    return ids


def require_chapter(scope: str, chapter_id: str | None) -> str | None:
    if scope != "chapter":
        return None
    if not chapter_id:
        raise ApiError(422, "missing_chapter_id", "Pass chapter_id with scope=chapter.")
    return chapter_id
