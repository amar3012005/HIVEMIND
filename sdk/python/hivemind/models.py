"""Pydantic models for HIVEMIND SDK."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


MemoryType = Literal[
    "fact",
    "preference",
    "decision",
    "lesson",
    "goal",
    "event",
    "relationship",
]

RelationshipType = Literal["Updates", "Extends", "Derives", "Contradicts"]


class Memory(BaseModel):
    """A single memory unit in HIVEMIND."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str | None = None
    title: str | None = None
    content: str
    tags: list[str] = Field(default_factory=list)
    memory_type: MemoryType | None = Field(default="fact", alias="memoryType")
    project: str | None = None
    importance_score: float | None = Field(default=None, alias="importanceScore")
    strength: float | None = None
    recall_count: int | None = Field(default=None, alias="recallCount")
    cluster_id: str | None = Field(default=None, alias="clusterId")
    cluster_role: Literal["hub", "spoke", "bridge"] | None = Field(default=None, alias="clusterRole")
    created_at: datetime | None = Field(default=None, alias="createdAt")
    updated_at: datetime | None = Field(default=None, alias="updatedAt")


class Relationship(BaseModel):
    """A typed edge between two memories."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    from_id: str = Field(alias="source")
    to_id: str = Field(alias="target")
    type: RelationshipType
    confidence: float = 1.0
    inference_model: str | None = Field(default=None, alias="inferenceModel")


class SearchResult(BaseModel):
    """A single retrieval result with provenance for LLM citation."""

    model_config = ConfigDict(extra="allow")

    memory: Memory
    score: float
    method: Literal["embedding", "token", "graph_expanded", "hybrid"] = "hybrid"
    explanation: str | None = None

    def as_citation(self) -> dict[str, Any]:
        """Format for LLM tool-use response with provenance."""
        return {
            "source": self.memory.id,
            "title": self.memory.title,
            "content": self.memory.content,
            "score": round(self.score, 4),
            "method": self.method,
            "tags": self.memory.tags,
        }
