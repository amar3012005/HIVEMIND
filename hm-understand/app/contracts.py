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
    source_start: int | None = Field(default=None, ge=0)
    source_end: int | None = Field(default=None, ge=0)
    locator: Locator = Field(default_factory=Locator)
    language: str | None = Field(default=None, max_length=16)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source_range(self):
        if (self.source_start is None) != (self.source_end is None):
            raise ValueError("source_start and source_end must be provided together")
        if self.source_start is not None and self.source_end < self.source_start:
            raise ValueError("source_end must be greater than or equal to source_start")
        if self.source_start is not None:
            utf16_length = len(self.text.encode("utf-16-le", errors="surrogatepass")) // 2
            if self.source_end - self.source_start != utf16_length:
                raise ValueError("source range length must match the block's UTF-16 code-unit length")
        return self


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
    source_start: int | None = None
    source_end: int | None = None
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
