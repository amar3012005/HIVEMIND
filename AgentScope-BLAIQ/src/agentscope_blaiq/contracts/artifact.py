from __future__ import annotations

from pydantic import BaseModel, Field


class ArtifactSection(BaseModel):
    section_id: str
    section_index: int
    title: str
    summary: str
    html_fragment: str
    section_data: dict[str, str] = Field(default_factory=dict)


class PreviewMetadata(BaseModel):
    viewport: str = "desktop"
    format_hint: str = "visual_html"
    theme_notes: list[str] = Field(default_factory=list)


class VisualArtifact(BaseModel):
    artifact_id: str
    artifact_type: str = "visual_html"
    title: str
    sections: list[ArtifactSection] = Field(default_factory=list)
    theme: dict[str, str] = Field(default_factory=dict)
    evidence_refs: list[str] = Field(default_factory=list)
    governance_status: str = "pending"
    html: str
    css: str
    preview_metadata: PreviewMetadata = Field(default_factory=PreviewMetadata)
