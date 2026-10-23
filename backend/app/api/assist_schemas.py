"""Pydantic models of the assisted data entry operations (contract v1.9, CONTRACT.md §20).

Kept apart from schemas.py; they mirror the ``Assist*`` component schemas of
backend/openapi.json, and ``tests/test_contract_drift.py`` compares them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.json_schema import SkipJsonSchema

from .schemas import ApiModel, RecordValue

AssistProvider = Literal["hosted", "local"]
AssistKind = Literal["metrics", "safety"]
AssistMedia = Literal["pdf", "text", "csv", "xlsx"]
FieldOrigin = Literal["study", "store", "request", "default", "generated", "search"]
DropReason = Literal["unknown_card", "other_card", "unknown_code", "not_a_condition", "invalid_value", "duplicate"]


class AssistStatus(ApiModel):
    """Whether the helper is on, and with which provider. Never the API key."""

    enabled: bool
    provider: AssistProvider | None
    model: str | None
    base_url: str | None = Field(description="Local: the OpenAI-compatible base URL; hosted: a gateway URL, or null for the Anthropic API.")
    key_set: bool = Field(description="Whether an API key is stored. The key itself is write-only.")
    accepts: list[AssistMedia]
    kinds: list[AssistKind]
    max_input_bytes: int
    updated_at: datetime | None
    how_to_enable: str | None = Field(description="Set while the helper is off.")
    privacy: str = Field(description="What leaves the machine, and when.")


class AssistConfigRequest(BaseModel):
    """``configureAssist`` body. Unknown fields are ignored, and invalid values are
    never repeated in problem details (the key is write-only)."""

    model_config = ConfigDict(extra="ignore")

    provider: AssistProvider
    model: str | SkipJsonSchema[None] = Field(default=None, description="Model id; hosted default claude-sonnet-5-5. Required for a local model.")
    base_url: str | SkipJsonSchema[None] = Field(
        default=None, description="Local: the OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1. Hosted: optional gateway (https)."
    )
    api_key: str | SkipJsonSchema[None] = Field(
        default=None, description="Write-only. Required for a hosted model unless one is stored; omit it to keep the stored key."
    )


class AssistFieldSource(ApiModel):
    quote: str | None
    location: str | None


class AssistField(ApiModel):
    origin: FieldOrigin
    source: AssistFieldSource | None
    confidence: float | None = Field(ge=0, le=1)
    uncertain: bool
    reason: str | None


class AssistCondition(ApiModel):
    code: str
    name: str


class AssistRecord(ApiModel):
    record: dict[str, RecordValue] = Field(description="The record exactly as createRecordsUpload takes it.")
    fields: dict[str, AssistField]
    uncertain: bool
    conditions: list[AssistCondition]


class AssistBatch(ApiModel):
    kind: AssistKind
    model_version: str | None = Field(description="metrics: the card to pass to createRecordsUpload; safety: null.")
    use_case: str | None
    records: list[AssistRecord]


class AssistDropped(ApiModel):
    reason: DropReason
    detail: str
    values: dict[str, RecordValue]
    source: AssistFieldSource | None


class AssistInput(ApiModel):
    media: AssistMedia
    bytes: int
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    filename: str | None
    truncated: bool = Field(
        default=False,
        description="Whether the helper read only part of a file: the first 2,000 rows, 100 columns, or 20 sheets of a table, or its first 200,000 characters. Optional; absent means false.",
    )


class AssistProposals(ApiModel):
    kind: AssistKind
    provider: AssistProvider
    model: str
    dataset_version: int
    input: AssistInput
    batches: list[AssistBatch]
    dropped: list[AssistDropped]
    notes: list[str]
    requests: int = Field(description="Requests made to the provider.")
    synthetic_data_notice: str
