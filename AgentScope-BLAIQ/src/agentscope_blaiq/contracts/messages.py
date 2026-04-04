from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MsgEnvelope(BaseModel):
    """Msg-aligned internal transport envelope."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    sender: str
    role: str
    phase: str
    content: Any
    metadata: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)
    thread_id: str
    tenant_id: str
    agent_name: str
    created_at: datetime = Field(default_factory=utc_now)
