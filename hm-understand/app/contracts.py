from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Locator(BaseModel):
    page: int | None = None
    slide: int | None = None
    sheet: str | None = None
    row: int | None = None
    cell: str | None = None
    heading_path: list[str] = Field(default_factory=list)
    message_id: str | None = None


class TextBlock(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    text: str = Field(min_length=1, max_length=100_000)
    locator: Locator = Field(default_factory=Locator)
    language: str | None = Field(default=None, max_length=16)
    metadata: dict[str, Any] = Field(default_factory=dict)


class Source(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    revision: str = Field(min_length=1, max_length=256)
    occurred_at: str | None = None
    timezone: str | None = Field(default=None, max_length=128)
    content_hash: str | None = Field(default=None, max_length=128)


class AnalyzeRequest(BaseModel):
    schema_version: Literal["1"] = "1"
    source: Source
    blocks: list[TextBlock] = Field(min_length=1, max_length=100)
    entity_types: list[str] = Field(
        default_factory=lambda: ["person", "organization", "location", "product", "project", "date", "money"],
        max_length=40,
    )
    include_candidates: bool = True

    @field_validator("entity_types")
    @classmethod
    def validate_types(cls, values: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(" ".join(value.split())[:80] for value in values if value.strip()))
        if not cleaned:
            raise ValueError("entity_types must contain at least one non-empty type")
        return cleaned

    @model_validator(mode="after")
    def bound_total_text(self):
        if sum(len(block.text) for block in self.blocks) > 1_000_000:
            raise ValueError("combined block text exceeds 1,000,000 characters")
        return self


class EvidenceRef(BaseModel):
    source_id: str
    source_revision: str
    block_id: str
    quote: str
    start: int
    end: int
    locator: Locator


class Mention(BaseModel):
    text: str
    label: str
    score: float | None = None
    evidence: EvidenceRef
    extractor: str
    uncertainty_reason: str | None = None


class Candidate(BaseModel):
    kind: Literal["fact", "decision", "event", "preference", "task", "uncertain"]
    text: str
    evidence: EvidenceRef
    signals: list[str] = Field(default_factory=list)
    needs_review: bool = True


class BlockResult(BaseModel):
    block_id: str
    language: dict[str, Any]
    mentions: list[Mention]
    candidates: list[Candidate]
    quality: dict[str, Any]
    processing_ms: int


class AnalyzeResponse(BaseModel):
    schema_version: Literal["1"] = "1"
    source_id: str
    source_revision: str
    content_hash: str
    pipeline_version: str
    model_versions: dict[str, str | None]
    complete: bool
    blocks: list[BlockResult]
    totals: dict[str, int]
