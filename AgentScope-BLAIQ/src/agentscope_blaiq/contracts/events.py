from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from .artifact import VisualArtifact
from .workflow import WorkflowStatus


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StreamEvent(BaseModel):
    type: str
    version: str = "v1"
    sequence: int
    thread_id: str
    session_id: str
    run_id: str = Field(default_factory=lambda: str(uuid4()))
    tenant_id: str = "default"
    agent_name: str = "system"
    phase: str = "system"
    status: str = "running"
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=utc_now)


class WorkflowStatusSnapshot(BaseModel):
    thread_id: str
    session_id: str
    run_id: str | None = None
    status: WorkflowStatus
    current_node: str | None = None
    current_agent: str | None = None
    latest_event: str | None = None
    final_artifact: VisualArtifact | None = None
    error_message: str | None = None
    artifact_family: str | None = None
    blocked_question: str | None = None
    expected_answer_schema: dict[str, Any] | None = None
    requirements_checklist: dict[str, Any] | None = None
    pending_node: str | None = None
    resume_count: int = 0
    last_resume_reason: str | None = None
    updated_at: datetime = Field(default_factory=utc_now)
