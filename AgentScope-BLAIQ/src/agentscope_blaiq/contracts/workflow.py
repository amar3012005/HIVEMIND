from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field

from .agent_catalog import AgentTaskAssignment, LiveAgentProfile


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WorkflowMode(str, Enum):
    sequential = "sequential"
    parallel = "parallel"
    hybrid = "hybrid"


class ArtifactFamily(str, Enum):
    pitch_deck = "pitch_deck"
    keynote = "keynote"
    poster = "poster"
    brochure = "brochure"
    one_pager = "one_pager"
    landing_page = "landing_page"
    report = "report"
    custom = "custom"


class TaskRole(str, Enum):
    strategist = "strategist"
    research = "research"
    hitl = "hitl"
    content_director = "content_director"
    vangogh = "vangogh"
    governance = "governance"
    synthesis = "synthesis"
    render = "render"
    custom = "custom"


class ExecutorKind(str, Enum):
    agent = "agent"
    human = "human"
    tool = "tool"
    system = "system"


class RequirementStage(str, Enum):
    before_research = "before_research"
    before_render = "before_render"
    evidence_informed = "evidence_informed"


class WorkflowStatus(str, Enum):
    queued = "queued"
    running = "running"
    blocked = "blocked"
    complete = "complete"
    error = "error"


class AgentType(str, Enum):
    strategist = "strategist"
    research = "research"
    content_director = "content_director"
    vangogh = "vangogh"
    governance = "governance"
    graph_knowledge = "graph_knowledge"


class ArtifactSpec(BaseModel):
    family: ArtifactFamily = ArtifactFamily.custom
    title: str | None = None
    audience: str | None = None
    deliverable_format: str = "visual_html"
    required_sections: list[str] = Field(default_factory=list)
    tone: str = "executive"
    constraints: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)


class RequirementItem(BaseModel):
    requirement_id: str
    text: str
    category: str = "general"
    source: str = "strategy"
    priority: int = 0
    must_have: bool = True
    owner_task_id: str | None = None
    status: str = "pending"
    blockers: list[str] = Field(default_factory=list)
    blocking_stage: RequirementStage = RequirementStage.before_render


class RequirementsChecklist(BaseModel):
    items: list[RequirementItem] = Field(default_factory=list)
    coverage_score: float = 0.0
    missing_required_ids: list[str] = Field(default_factory=list)


class WorkflowNode(BaseModel):
    node_id: str = Field(default_factory=lambda: str(uuid4()))
    task_role: TaskRole = TaskRole.custom
    executor_kind: ExecutorKind = ExecutorKind.agent
    purpose: str
    depends_on: list[str] = Field(default_factory=list)
    parallel_group: str | None = None
    inputs: dict = Field(default_factory=dict)
    outputs: dict = Field(default_factory=dict)
    acceptance_criteria: list[str] = Field(default_factory=list)
    requires_approval: bool = False
    assigned_to: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)


class WorkflowEdge(BaseModel):
    from_node: str
    to_node: str
    condition: str | None = None


class TaskGraph(BaseModel):
    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    entry_nodes: list[str] = Field(default_factory=list)
    terminal_nodes: list[str] = Field(default_factory=list)
    fan_in_groups: list[str] = Field(default_factory=list)


class SubmitWorkflowRequest(BaseModel):
    schema_version: str = "v1"
    user_query: str
    workflow_mode: WorkflowMode = WorkflowMode.hybrid
    tenant_id: str = "default"
    session_id: str = Field(default_factory=lambda: str(uuid4()))
    thread_id: str = Field(default_factory=lambda: str(uuid4()))
    artifact_type: str = "visual_html"
    source_scope: str = "web_and_docs"
    artifact_family_hint: ArtifactFamily | None = None
    target_audience: str | None = None
    delivery_channel: str | None = None
    brand_context: str | None = None
    must_have_sections: list[str] = Field(default_factory=list)
    explicit_requirements: list[str] = Field(default_factory=list)
    hivemind_project: str | None = None
    hivemind_tags: list[str] = Field(default_factory=list)


class ResumeWorkflowRequest(BaseModel):
    thread_id: str
    tenant_id: str | None = None
    resume_reason: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)


class AgentRunPayload(WorkflowNode):
    run_id: str = Field(default_factory=lambda: str(uuid4()))
    agent_type: AgentType = AgentType.research
    task_input: dict = Field(default_factory=dict)


class WorkflowPlan(BaseModel):
    workflow_mode: WorkflowMode
    summary: str
    direct_answer: bool = False
    notes: list[str] = Field(default_factory=list)
    artifact_family: ArtifactFamily = ArtifactFamily.custom
    artifact_spec: ArtifactSpec | None = None
    requirements_checklist: RequirementsChecklist = Field(default_factory=RequirementsChecklist)
    task_graph: TaskGraph = Field(default_factory=TaskGraph)
    tasks: list[AgentRunPayload] = Field(default_factory=list)
    hitl_nodes: list[WorkflowNode] = Field(default_factory=list)
    content_director_nodes: list[WorkflowNode] = Field(default_factory=list)
    available_agents: list[LiveAgentProfile] = Field(default_factory=list)
    agent_assignments: list[AgentTaskAssignment] = Field(default_factory=list)
    topology_reason: str = ""
    fan_in_required: bool = False
    fan_in_agent: AgentType = AgentType.strategist
    created_at: datetime = Field(default_factory=utc_now)
