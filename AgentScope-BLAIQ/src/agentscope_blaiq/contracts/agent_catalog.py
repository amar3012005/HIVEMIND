from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    ready = "ready"
    busy = "busy"
    degraded = "degraded"
    disabled = "disabled"


class AgentCapability(BaseModel):
    name: str
    description: str
    supported_task_types: list[str] = Field(default_factory=list)
    supported_task_roles: list[str] = Field(default_factory=list)
    supported_artifact_families: list[str] = Field(default_factory=list)


class AgentSkill(BaseModel):
    name: str
    level: str = "core"


class LiveAgentProfile(BaseModel):
    name: str
    role: str
    status: AgentStatus = AgentStatus.ready
    model: str | None = None
    capabilities: list[AgentCapability] = Field(default_factory=list)
    skills: list[AgentSkill] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    current_load: float = 0.0
    current_stage: str | None = None
    last_seen: str | None = None
    planner_roles: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class AgentTaskAssignment(BaseModel):
    task_id: str
    agent_name: str
    role: str
    reason: str
    parallel_group: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    task_role: str | None = None
    executor_kind: str = "agent"
    task_graph_node_id: str | None = None
    requires_approval: bool = False
    input_refs: list[str] = Field(default_factory=list)
    output_refs: list[str] = Field(default_factory=list)
