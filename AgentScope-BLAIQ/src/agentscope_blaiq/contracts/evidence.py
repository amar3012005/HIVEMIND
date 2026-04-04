from __future__ import annotations

from pydantic import BaseModel, Field


class Citation(BaseModel):
    source_id: str
    label: str
    excerpt: str | None = None
    url: str | None = None


class SourceRecord(BaseModel):
    source_id: str
    source_type: str
    title: str
    location: str
    metadata: dict[str, str] = Field(default_factory=dict)


class EvidenceFinding(BaseModel):
    finding_id: str
    title: str
    summary: str
    source_ids: list[str] = Field(default_factory=list)
    confidence: float = 0.5


class EvidenceContradiction(BaseModel):
    topic: str
    description: str
    source_ids: list[str] = Field(default_factory=list)
    severity: str = "medium"


class EvidenceFreshness(BaseModel):
    memory_is_fresh: bool = True
    web_verified: bool = False
    freshness_summary: str = ""
    checked_at: str | None = None


class EvidenceProvenance(BaseModel):
    memory_sources: int = 0
    web_sources: int = 0
    upload_sources: int = 0
    graph_traversals: int = 0
    primary_ground_truth: str = "memory"
    save_back_eligible: bool = False


class EvidencePack(BaseModel):
    summary: str
    sources: list[SourceRecord] = Field(default_factory=list)
    memory_findings: list[EvidenceFinding] = Field(default_factory=list)
    web_findings: list[EvidenceFinding] = Field(default_factory=list)
    doc_findings: list[EvidenceFinding] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    confidence: float = 0.5
    citations: list[Citation] = Field(default_factory=list)
    contradictions: list[EvidenceContradiction] = Field(default_factory=list)
    freshness: EvidenceFreshness = Field(default_factory=EvidenceFreshness)
    provenance: EvidenceProvenance = Field(default_factory=EvidenceProvenance)
    recommended_followups: list[str] = Field(default_factory=list)
