from __future__ import annotations

from collections.abc import Callable

from agentscope.tool import Toolkit
from pydantic import BaseModel, Field

from agentscope_blaiq.contracts.agent_catalog import AgentTaskAssignment, AgentStatus, LiveAgentProfile
from agentscope_blaiq.contracts.workflow import (
    AgentRunPayload,
    AgentType,
    ArtifactFamily,
    ArtifactSpec,
    ExecutorKind,
    RequirementItem,
    RequirementStage,
    RequirementsChecklist,
    SubmitWorkflowRequest,
    WorkflowEdge,
    TaskGraph,
    TaskRole,
    WorkflowMode,
    WorkflowNode,
    WorkflowPlan,
)
from agentscope_blaiq.runtime.agent_base import BaseAgent


class StrategicDraft(BaseModel):
    workflow_mode: WorkflowMode
    summary: str
    task_count: int = Field(ge=0)
    notes: list[str] = Field(default_factory=list)
    topology_reason: str = ""
    artifact_family: ArtifactFamily = ArtifactFamily.custom
    artifact_spec: ArtifactSpec | None = None
    requirements_checklist: RequirementsChecklist = Field(default_factory=RequirementsChecklist)
    task_graph: TaskGraph = Field(default_factory=TaskGraph)
    hitl_nodes: list[WorkflowNode] = Field(default_factory=list)
    content_director_nodes: list[WorkflowNode] = Field(default_factory=list)


ARTIFACT_BLUEPRINTS: dict[ArtifactFamily, dict[str, object]] = {
    ArtifactFamily.pitch_deck: {
        "required_sections": ["Hero", "Problem", "Solution", "Proof", "CTA"],
        "blocking_fields": ["target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "pitch-deck-executive",
        "tone": "executive",
        "content_distribution": ["hero", "problem", "solution", "proof", "cta"],
    },
    ArtifactFamily.keynote: {
        "required_sections": ["Opening", "Narrative", "Proof", "Closing"],
        "blocking_fields": ["target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "keynote-stage",
        "tone": "presentational",
        "content_distribution": ["opening", "narrative", "proof", "closing"],
    },
    ArtifactFamily.poster: {
        "required_sections": ["Headline", "Visual Hook", "Supporting Proof"],
        "blocking_fields": ["delivery_channel"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "poster-vertical",
        "tone": "bold",
        "content_distribution": ["headline", "visual", "proof"],
    },
    ArtifactFamily.brochure: {
        "required_sections": ["Cover", "Offer", "Details", "CTA"],
        "blocking_fields": ["target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "brochure-fold",
        "tone": "informative",
        "content_distribution": ["cover", "offer", "details", "cta"],
    },
    ArtifactFamily.one_pager: {
        "required_sections": ["Headline", "Value", "Evidence", "CTA"],
        "blocking_fields": ["target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "one-pager-executive",
        "tone": "concise",
        "content_distribution": ["headline", "value", "evidence", "cta"],
    },
    ArtifactFamily.landing_page: {
        "required_sections": ["Hero", "Benefits", "Proof", "CTA"],
        "blocking_fields": ["delivery_channel", "target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "landing-page-conversion",
        "tone": "conversion",
        "content_distribution": ["hero", "benefits", "proof", "cta"],
    },
    ArtifactFamily.report: {
        "required_sections": ["Executive Summary", "Findings", "Recommendations"],
        "blocking_fields": ["target_audience"],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "report-executive",
        "tone": "analytical",
        "content_distribution": ["summary", "findings", "recommendations"],
    },
    ArtifactFamily.custom: {
        "required_sections": ["Hero", "Evidence"],
        "blocking_fields": [],
        "evidence_informed_fields": ["must_have_sections"],
        "template": "default",
        "tone": "executive",
        "content_distribution": ["hero", "evidence"],
    },
}

TASK_ROLE_TO_AGENT_TYPE: dict[TaskRole, AgentType] = {
    TaskRole.strategist: AgentType.strategist,
    TaskRole.research: AgentType.research,
    TaskRole.content_director: AgentType.content_director,
    TaskRole.vangogh: AgentType.vangogh,
    TaskRole.governance: AgentType.governance,
    TaskRole.synthesis: AgentType.strategist,
    TaskRole.render: AgentType.vangogh,
    TaskRole.custom: AgentType.strategist,
}


class StrategyInspection(BaseModel):
    requested_mode: WorkflowMode
    chosen_mode: WorkflowMode
    topology_reason: str
    ready_agents: list[LiveAgentProfile] = Field(default_factory=list)
    matches: list[AgentTaskAssignment] = Field(default_factory=list)


class StrategicAgent(BaseAgent):
    def __init__(
        self,
        *,
        catalog_provider: Callable[[], list[LiveAgentProfile]] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(
            name="StrategicAgent",
            role="strategic",
            sys_prompt=(
                "You are the BLAIQ strategist. Inspect the live agent catalog before choosing a workflow topology and task graph. "
                "Be strategy-driven, not template-driven: decide the execution order from the request, the available agents, and the dependencies between outputs. "
                "Default policy: research should happen before clarification when research can sharpen the questions. "
                "Only ask humans early if a true blocker prevents meaningful research. "
                "Prefer sequential for linear low-entropy tasks, parallel when multiple independent specialists are available, "
                "and hybrid when research can fan out first before content direction, rendering, and governance converge."
            ),
            **kwargs,
        )
        self.catalog_provider = catalog_provider or (lambda: [])

    def build_toolkit(self) -> Toolkit:
        toolkit = Toolkit()
        toolkit.register_tool_function(
            self._tool_classify_artifact_family,
            func_name="classify_artifact_family",
            func_description="Classify the request into an artifact family.",
        )
        toolkit.register_tool_function(
            self._tool_derive_artifact_requirements,
            func_name="derive_artifact_requirements",
            func_description="Derive the family-specific requirement checklist.",
        )
        toolkit.register_tool_function(
            self._tool_compute_missing_requirements,
            func_name="compute_missing_requirements",
            func_description="Compute the missing required items for the current request.",
        )
        toolkit.register_tool_function(
            self._tool_compose_task_graph,
            func_name="compose_task_graph",
            func_description="Compose a task graph from the live catalog and requirement checklist.",
        )
        toolkit.register_tool_function(
            self._tool_match_agents_for_task_role,
            func_name="match_agents_for_task_role",
            func_description="Match live agents to a planner task role.",
        )
        toolkit.register_tool_function(
            self._tool_list_live_agents,
            func_name="list_live_agents",
            func_description="Return the live agent catalog with status, capabilities, skills, tools, and model metadata.",
        )
        toolkit.register_tool_function(
            self._tool_match_agent_capabilities,
            func_name="match_agent_capabilities",
            func_description="Match required task capabilities to live agents in the catalog.",
        )
        toolkit.register_tool_function(
            self._tool_compose_execution_strategy,
            func_name="compose_execution_strategy",
            func_description="Compose the topology, task assignments, and fan-in strategy from the live catalog.",
        )
        return toolkit

    def _tool_classify_artifact_family(self, request_payload: dict | None = None):
        family = self.classify_artifact_family(request_payload or {})
        return self.tool_response({"artifact_family": family.value})

    def _tool_derive_artifact_requirements(self, request_payload: dict | None = None):
        family = self.classify_artifact_family(request_payload or {})
        checklist = self.derive_artifact_requirements(family, request_payload or {})
        return self.tool_response(checklist.model_dump())

    def _tool_compute_missing_requirements(self, checklist: dict | None = None):
        model = RequirementsChecklist.model_validate(checklist or {})
        return self.tool_response(self.compute_missing_requirements(model).model_dump())

    def _tool_compose_task_graph(self, request_payload: dict | None = None, agent_catalog: list[dict] | None = None):
        family = self.classify_artifact_family(request_payload or {})
        checklist = self.derive_artifact_requirements(family, request_payload or {})
        graph = self.compose_task_graph(family, checklist, [LiveAgentProfile.model_validate(agent) for agent in (agent_catalog or [])])
        return self.tool_response(graph.model_dump())

    def _tool_match_agents_for_task_role(self, task_role: str | None = None, agent_catalog: list[dict] | None = None):
        role = TaskRole(task_role or "custom")
        matches = self.match_agents_for_task_role(role, [LiveAgentProfile.model_validate(agent) for agent in (agent_catalog or [])])
        return self.tool_response(matches)

    def _tool_list_live_agents(self):
        return self.tool_response([agent.model_dump() for agent in self.catalog_provider()])

    def _tool_match_agent_capabilities(self, required_capabilities: list[str] | None = None):
        required = {cap.lower() for cap in (required_capabilities or []) if cap}
        matches = []
        for agent in self.catalog_provider():
            capability_names = {cap.name.lower() for cap in agent.capabilities}
            overlap = sorted(required & capability_names)
            if required and not overlap:
                continue
            matches.append(
                {
                    "agent_name": agent.name,
                    "role": agent.role,
                    "status": agent.status.value,
                    "matched_capabilities": overlap,
                    "skills": [skill.model_dump() for skill in agent.skills],
                    "tools": agent.tools,
                    "model": agent.model,
                    "current_load": agent.current_load,
                }
            )
        return self.tool_response(matches)

    def _tool_compose_execution_strategy(
        self,
        request_payload: dict | None = None,
        agent_catalog: list[dict] | None = None,
    ):
        return self.tool_response(
            {
                "request_payload": request_payload or {},
                "agent_catalog": agent_catalog or [agent.model_dump() for agent in self.catalog_provider()],
                "rules": {
                    "sequential": "Use when the workflow is linear or when a required specialist is unavailable.",
                    "parallel": "Use when two or more branches can run independently against distinct live agents.",
                    "hybrid": "Use when research can fan out first, then converge into artifact generation and governance.",
                },
            }
        )

    def _workflow_topology_rules(self):
        return self.tool_response(
            {
                "sequential": "Use when work is linear and later stages depend directly on earlier results.",
                "parallel": "Use when branches can run independently and merge before review.",
                "hybrid": "Use when research should fan out first, then converge into artifact generation.",
            }
        )

    @staticmethod
    def _normalized_query_text(raw_query: str) -> str:
        normalized = "".join(char.lower() if char.isalnum() or char.isspace() else " " for char in raw_query)
        return " ".join(normalized.split())

    @classmethod
    def is_direct_knowledge_query(cls, request_payload: dict[str, object] | SubmitWorkflowRequest) -> bool:
        if isinstance(request_payload, SubmitWorkflowRequest):
            raw_query = request_payload.user_query
        else:
            raw_query = str(request_payload.get("user_query", ""))

        query = cls._normalized_query_text(raw_query)

        if not query:
            return False

        artifact_signals = (
            "create ", "make ", "generate ", "build ", "design ", "render ", "draft ",
            "pitch deck", "presentation", "deck", "poster", "brochure", "landing page",
            "one pager", "one-pager", "report", "proposal", "web page", "webpage",
        )
        if any(signal in query for signal in artifact_signals):
            return False

        knowledge_signals = (
            "what do you know", "what do u know", "who am i", "tell me about",
            "what is", "who is", "when is", "where is", "why is", "how does",
            "how do", "do you know", "summarize", "explain", "what can you tell me",
        )
        if any(query.startswith(signal) for signal in knowledge_signals):
            return True

        tokens = query.split()
        token_set = set(tokens)
        if {"know", "about", "me"} <= token_set and tokens[:1] and tokens[0] in {"what", "wat", "wht"}:
            return True
        if ("me" in token_set or "my" in token_set or "myself" in token_set) and tokens[:1] and tokens[0] in {
            "what", "wat", "wht", "who", "tell", "summarize", "explain",
        }:
            return True
        if any(phrase in query for phrase in ("about me", "about myself", "my projects", "my company", "my work")):
            return True
        return raw_query.strip().endswith("?")

    @staticmethod
    def classify_artifact_family(request_payload: dict[str, object] | SubmitWorkflowRequest) -> ArtifactFamily:
        if isinstance(request_payload, SubmitWorkflowRequest):
            hint = request_payload.artifact_family_hint
            query = request_payload.user_query.lower()
            target_audience = (request_payload.target_audience or "").lower()
            delivery_channel = (request_payload.delivery_channel or "").lower()
            sections = [section.lower() for section in request_payload.must_have_sections]
        else:
            hint = request_payload.get("artifact_family_hint")
            query = str(request_payload.get("user_query", "")).lower()
            target_audience = str(request_payload.get("target_audience", "")).lower()
            delivery_channel = str(request_payload.get("delivery_channel", "")).lower()
            sections = [str(section).lower() for section in request_payload.get("must_have_sections", [])]

        if hint:
            return hint if isinstance(hint, ArtifactFamily) else ArtifactFamily(str(hint))

        signal = " ".join([query, target_audience, delivery_channel, " ".join(sections)])
        if any(token in signal for token in ("pitch deck", "slide deck", "presentation", "deck")):
            return ArtifactFamily.pitch_deck
        if "keynote" in signal:
            return ArtifactFamily.keynote
        if any(token in signal for token in ("poster", "event poster", "research poster")):
            return ArtifactFamily.poster
        if any(token in signal for token in ("brochure", "booklet", "fold")):
            return ArtifactFamily.brochure
        if any(token in signal for token in ("one pager", "one-pager", "brief", "summary")):
            return ArtifactFamily.one_pager
        if any(token in signal for token in ("landing page", "homepage", "web page", "webpage")):
            return ArtifactFamily.landing_page
        if any(token in signal for token in ("report", "proposal", "analysis")):
            return ArtifactFamily.report
        return ArtifactFamily.custom

    @staticmethod
    def derive_artifact_requirements(family: ArtifactFamily, request_payload: dict[str, object] | SubmitWorkflowRequest) -> RequirementsChecklist:
        if isinstance(request_payload, SubmitWorkflowRequest):
            values = {
                "target_audience": request_payload.target_audience,
                "delivery_channel": request_payload.delivery_channel,
                "brand_context": request_payload.brand_context,
                "must_have_sections": request_payload.must_have_sections,
                "explicit_requirements": request_payload.explicit_requirements,
            }
        else:
            values = {
                "target_audience": request_payload.get("target_audience"),
                "delivery_channel": request_payload.get("delivery_channel"),
                "brand_context": request_payload.get("brand_context"),
                "must_have_sections": request_payload.get("must_have_sections", []),
                "explicit_requirements": request_payload.get("explicit_requirements", []),
            }

        blueprint = ARTIFACT_BLUEPRINTS[family]
        items: list[RequirementItem] = []
        missing_ids: list[str] = []
        for index, section in enumerate(blueprint["required_sections"], start=1):
            requirement_id = f"section:{str(section).lower().replace(' ', '_')}"
            must_have = True
            status = "filled" if str(section).lower() in {str(item).lower() for item in values["must_have_sections"]} else "pending"
            if status == "pending":
                missing_ids.append(requirement_id)
            items.append(
                RequirementItem(
                    requirement_id=requirement_id,
                    text=f"Provide the {section} for the {family.value} artifact.",
                    category="section",
                    source="artifact_family",
                    priority=index,
                    must_have=must_have,
                    owner_task_id="content_director" if section else None,
                    status=status,
                    blockers=[],
                    blocking_stage=RequirementStage.evidence_informed,
                )
            )

        for field_name in blueprint["blocking_fields"]:
            value = values.get(field_name)
            requirement_id = f"field:{field_name}"
            status = "filled" if value else "pending"
            if status == "pending":
                missing_ids.append(requirement_id)
            items.append(
                RequirementItem(
                    requirement_id=requirement_id,
                    text=f"Collect {field_name.replace('_', ' ')}.",
                    category="clarification",
                    source="hitl",
                    priority=0,
                    must_have=True,
                    owner_task_id="hitl",
                    status=status,
                    blocking_stage=RequirementStage.before_render,
                )
            )

        for field_name in blueprint.get("evidence_informed_fields", []):
            value = values.get(field_name)
            requirement_id = f"field:{field_name}"
            normalized_value = value if not isinstance(value, list) else [str(item).strip() for item in value if str(item).strip()]
            status = "filled" if normalized_value else "pending"
            if status == "pending":
                missing_ids.append(requirement_id)
            items.append(
                RequirementItem(
                    requirement_id=requirement_id,
                    text=f"Collect {field_name.replace('_', ' ')} after research context is available.",
                    category="clarification",
                    source="hitl",
                    priority=1,
                    must_have=True,
                    owner_task_id="hitl_evidence",
                    status=status,
                    blocking_stage=RequirementStage.evidence_informed,
                )
            )

        for index, requirement in enumerate(values["explicit_requirements"], start=1):
            requirement_id = f"explicit:{index}"
            items.append(
                RequirementItem(
                    requirement_id=requirement_id,
                    text=str(requirement),
                    category="explicit",
                    source="user",
                    priority=10 + index,
                    must_have=True,
                    owner_task_id="content_director",
                    status="pending",
                    blocking_stage=RequirementStage.before_render,
                )
            )
            missing_ids.append(requirement_id)

        coverage = 1.0 if items and not missing_ids else max(0.0, 1.0 - (len(missing_ids) / max(len(items), 1)))
        return RequirementsChecklist(items=items, coverage_score=coverage, missing_required_ids=sorted(set(missing_ids)))

    @staticmethod
    def compute_missing_requirements(checklist: RequirementsChecklist) -> RequirementsChecklist:
        missing = [item.requirement_id for item in checklist.items if item.must_have and item.status != "filled"]
        coverage = 1.0 if checklist.items and not missing else max(0.0, 1.0 - (len(missing) / max(len(checklist.items), 1)))
        return checklist.model_copy(update={"coverage_score": coverage, "missing_required_ids": sorted(set(missing))})

    def match_agents_for_task_role(self, task_role: TaskRole, agent_catalog: list[LiveAgentProfile]) -> list[dict[str, object]]:
        matches: list[dict[str, object]] = []
        for agent in agent_catalog:
            if agent.status == AgentStatus.disabled:
                continue
            capability_names = {cap.name.lower() for cap in agent.capabilities}
            if task_role == TaskRole.hitl:
                continue
            if task_role == TaskRole.content_director and not any(name in capability_names for name in {"content_distribution", "section_planning"}):
                continue
            if task_role == TaskRole.research and not any(name in capability_names for name in {"web_research", "document_research", "memory_retrieval", "memory_synthesis"}):
                continue
            if task_role == TaskRole.vangogh and not any(name in capability_names for name in {"artifact_layout", "html_css_composition"}):
                continue
            if task_role == TaskRole.governance and "artifact_validation" not in capability_names:
                continue
            matches.append(
                {
                    "agent_name": agent.name,
                    "role": agent.role,
                    "status": agent.status.value,
                    "current_load": agent.current_load,
                    "capabilities": [cap.name for cap in agent.capabilities],
                    "skills": [skill.name for skill in agent.skills],
                }
            )
        return matches

    def compose_task_graph(
        self,
        family: ArtifactFamily,
        requirements: RequirementsChecklist,
        agent_catalog: list[LiveAgentProfile],
    ) -> TaskGraph:
        web_agent, docs_agent = self._assign_research_agents(agent_catalog)
        content_director_agent = self._assign_role_agent(agent_catalog, "content_distribution", "content_director")
        design_agent = self._assign_role_agent(agent_catalog, "artifact_layout", "vangogh")
        governance_agent = self._assign_role_agent(agent_catalog, "artifact_validation", "governance")
        needs_evidence_hitl = any(
            item.must_have and item.status != "filled" and item.blocking_stage in {RequirementStage.evidence_informed, RequirementStage.before_render}
            for item in requirements.items
        )

        nodes: list[WorkflowNode] = [
            WorkflowNode(
                node_id="research-web",
                task_role=TaskRole.research,
                executor_kind=ExecutorKind.agent,
                purpose="Research web evidence",
                parallel_group="research",
                outputs={"evidence_type": "web"},
                required_capabilities=["web_research"],
                assigned_to=web_agent,
            ),
            WorkflowNode(
                node_id="research-docs",
                task_role=TaskRole.research,
                executor_kind=ExecutorKind.agent,
                purpose="Research uploaded docs",
                parallel_group="research",
                outputs={"evidence_type": "docs"},
                required_capabilities=["document_research"],
                assigned_to=docs_agent,
            ),
        ]
        if needs_evidence_hitl:
            nodes.append(
                WorkflowNode(
                    node_id="hitl_evidence",
                    task_role=TaskRole.hitl,
                    executor_kind=ExecutorKind.human,
                    purpose="Resolve evidence-informed gaps before rendering",
                    depends_on=["research-web", "research-docs"],
                    inputs={
                        "missing_requirements": [
                            item.requirement_id
                            for item in requirements.items
                            if item.must_have and item.status != "filled" and item.blocking_stage in {RequirementStage.evidence_informed, RequirementStage.before_render}
                        ]
                    },
                    acceptance_criteria=["Evidence-aware user answers collected"],
                    requires_approval=True,
                    assigned_to="user",
                )
            )
        nodes.extend(
            [
                WorkflowNode(
                    node_id="content_director",
                    task_role=TaskRole.content_director,
                    executor_kind=ExecutorKind.agent,
                    purpose="Turn requirements and evidence into a content distribution brief",
                    depends_on=["research-web", "research-docs"]
                    + (["hitl_evidence"] if needs_evidence_hitl else []),
                    inputs={"artifact_family": family.value},
                    outputs={"content_brief": True},
                    required_capabilities=["content_distribution", "section_planning"],
                    assigned_to=content_director_agent,
                ),
                WorkflowNode(
                    node_id="vangogh",
                    task_role=TaskRole.vangogh,
                    executor_kind=ExecutorKind.agent,
                    purpose="Render the final visual artifact",
                    depends_on=["content_director"],
                    inputs={"artifact_family": family.value},
                    outputs={"artifact": True},
                    required_capabilities=["artifact_layout", "html_css_composition"],
                    assigned_to=design_agent,
                ),
                WorkflowNode(
                    node_id="governance",
                    task_role=TaskRole.governance,
                    executor_kind=ExecutorKind.agent,
                    purpose="Validate the final artifact",
                    depends_on=["vangogh"],
                    inputs={"artifact_family": family.value},
                    outputs={"governance_report": True},
                    required_capabilities=["artifact_validation"],
                    assigned_to=governance_agent,
                    requires_approval=True,
                ),
            ]
        )

        edges = [
            WorkflowEdge(from_node="research-web", to_node="content_director"),
            WorkflowEdge(from_node="research-docs", to_node="content_director"),
            WorkflowEdge(from_node="content_director", to_node="vangogh"),
            WorkflowEdge(from_node="vangogh", to_node="governance"),
        ]
        if needs_evidence_hitl:
            edges.extend(
                [
                    WorkflowEdge(from_node="research-web", to_node="hitl_evidence"),
                    WorkflowEdge(from_node="research-docs", to_node="hitl_evidence"),
                    WorkflowEdge(from_node="hitl_evidence", to_node="content_director"),
                ]
            )
        return TaskGraph(
            nodes=nodes,
            edges=edges,
            entry_nodes=["research-web", "research-docs"],
            terminal_nodes=["governance"],
            fan_in_groups=["research"],
        )

    @staticmethod
    def _infer_catalog_summary(agent_catalog: list[LiveAgentProfile]) -> dict[str, list[str]]:
        summary: dict[str, list[str]] = {"research": [], "design": [], "review": [], "strategy": []}
        for agent in agent_catalog:
            caps = {cap.name for cap in agent.capabilities}
            if any(name in caps for name in {"web_research", "document_research"}):
                summary["research"].append(agent.name)
            if any(name in caps for name in {"artifact_layout", "html_css_composition"}):
                summary["design"].append(agent.name)
            if "artifact_validation" in caps:
                summary["review"].append(agent.name)
            if any(name in caps for name in {"route_planning", "task_graph_authoring"}):
                summary["strategy"].append(agent.name)
        return summary

    @staticmethod
    def _heuristic_topology(request: SubmitWorkflowRequest, agent_catalog: list[LiveAgentProfile]) -> WorkflowMode:
        query = request.user_query.lower()
        summary = StrategicAgent._infer_catalog_summary(agent_catalog)
        research_agents = summary["research"]
        design_agents = summary["design"]
        review_agents = summary["review"]
        full_core_present = bool(research_agents and design_agents and review_agents)
        parallel_ready = len(research_agents) >= 2

        if request.workflow_mode != WorkflowMode.hybrid:
            return request.workflow_mode
        if not full_core_present:
            return WorkflowMode.sequential
        if parallel_ready or request.source_scope == "web_and_docs":
            return WorkflowMode.hybrid
        if any(keyword in query for keyword in ("compare", "analyze", "research", "multi", "parallel", "several", "multiple")):
            return WorkflowMode.parallel
        return WorkflowMode.sequential

    async def choose_topology(self, request: SubmitWorkflowRequest, agent_catalog: list[LiveAgentProfile]) -> WorkflowMode:
        await self.log("Analyzing your request against the live agent catalog to determine workflow topology.", kind="thought")
        await self.log(
            "Inspecting request shape, artifact family, and available live agents before selecting a topology.",
            kind="thought",
            detail={
                "requested_mode": request.workflow_mode.value,
                "artifact_type": request.artifact_type,
                "source_scope": request.source_scope,
                "live_agent_count": len(agent_catalog),
            },
        )
        mode = self._heuristic_topology(request, agent_catalog)
        await self.log(
            f"Selected '{mode.value}' topology from the live catalog.",
            kind="decision",
            detail={
                "workflow_mode": mode.value,
                "reasoning": "Immediate catalog-aware heuristic selection.",
                "topology_reason": "Topology chosen from live agent availability, request shape, and source scope without waiting on a model round-trip.",
            },
        )
        return mode

    def _assign_research_agents(self, agent_catalog: list[LiveAgentProfile]) -> tuple[str, str]:
        web_agent = "research"
        docs_agent = "research"
        for agent in agent_catalog:
            capability_names = {cap.name for cap in agent.capabilities}
            if "web_research" in capability_names and web_agent == "research":
                web_agent = agent.name
            if "document_research" in capability_names and docs_agent == "research":
                docs_agent = agent.name
        return web_agent, docs_agent

    @staticmethod
    def _assign_role_agent(agent_catalog: list[LiveAgentProfile], capability_name: str, default_agent: str) -> str:
        for agent in agent_catalog:
            if any(cap.name == capability_name for cap in agent.capabilities):
                return agent.name
        return default_agent

    def _compose_assignments(self, mode: WorkflowMode, agent_catalog: list[LiveAgentProfile]) -> list[AgentTaskAssignment]:
        web_agent, docs_agent = self._assign_research_agents(agent_catalog)
        content_director_agent = self._assign_role_agent(agent_catalog, "content_distribution", "content_director")
        design_agent = self._assign_role_agent(agent_catalog, "artifact_layout", "vangogh")
        governance_agent = self._assign_role_agent(agent_catalog, "artifact_validation", "governance")

        if mode == WorkflowMode.sequential:
            return [
                AgentTaskAssignment(
                    task_id="research-web",
                    agent_name=web_agent,
                    role="research",
                    reason="Sequential research requires the best available research agent.",
                    required_capabilities=["web_research", "document_research"],
                    task_role=TaskRole.research.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="research-web",
                ),
                AgentTaskAssignment(
                    task_id="content_director",
                    agent_name=content_director_agent,
                    role="content_director",
                    reason="Content direction follows the completed research step.",
                    required_capabilities=["content_distribution", "section_planning"],
                    task_role=TaskRole.content_director.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="content_director",
                ),
                AgentTaskAssignment(
                    task_id="artifact",
                    agent_name=design_agent,
                    role="vangogh",
                    reason="Artifact generation follows the completed research step.",
                    required_capabilities=["artifact_layout", "html_css_composition"],
                    task_role=TaskRole.vangogh.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="vangogh",
                ),
                AgentTaskAssignment(
                    task_id="governance",
                    agent_name=governance_agent,
                    role="governance",
                    reason="Validation closes the sequential workflow.",
                    required_capabilities=["artifact_validation"],
                    task_role=TaskRole.governance.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="governance",
                ),
            ]

        if mode == WorkflowMode.parallel:
            return [
                AgentTaskAssignment(
                    task_id="research-web",
                    agent_name=web_agent,
                    role="research",
                    parallel_group="research",
                    reason="Assigned to the web-capable research agent.",
                    required_capabilities=["web_research"],
                    task_role=TaskRole.research.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="research-web",
                ),
                AgentTaskAssignment(
                    task_id="research-docs",
                    agent_name=docs_agent,
                    role="research",
                    parallel_group="research",
                    reason="Assigned to the document-capable research agent.",
                    required_capabilities=["document_research"],
                    task_role=TaskRole.research.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="research-docs",
                ),
                AgentTaskAssignment(
                    task_id="content_director",
                    agent_name=content_director_agent,
                    role="content_director",
                    reason="Content direction follows fan-in.",
                    required_capabilities=["content_distribution", "section_planning"],
                    task_role=TaskRole.content_director.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="content_director",
                ),
                AgentTaskAssignment(
                    task_id="artifact",
                    agent_name=design_agent,
                    role="vangogh",
                    parallel_group="artifact",
                    reason="Artifact generation happens after fan-in.",
                    required_capabilities=["artifact_layout", "html_css_composition"],
                    task_role=TaskRole.vangogh.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="vangogh",
                ),
                AgentTaskAssignment(
                    task_id="governance",
                    agent_name=governance_agent,
                    role="governance",
                    reason="Validation is the final gate.",
                    required_capabilities=["artifact_validation"],
                    task_role=TaskRole.governance.value,
                    executor_kind=ExecutorKind.agent.value,
                    task_graph_node_id="governance",
                ),
            ]

        return [
            AgentTaskAssignment(
                task_id="research-web",
                agent_name=web_agent,
                role="research",
                parallel_group="research",
                reason="Web evidence can run in parallel.",
                required_capabilities=["web_research"],
                task_role=TaskRole.research.value,
                executor_kind=ExecutorKind.agent.value,
                task_graph_node_id="research-web",
            ),
            AgentTaskAssignment(
                task_id="research-docs",
                agent_name=docs_agent,
                role="research",
                parallel_group="research",
                reason="Document evidence can run in parallel.",
                required_capabilities=["document_research"],
                task_role=TaskRole.research.value,
                executor_kind=ExecutorKind.agent.value,
                task_graph_node_id="research-docs",
            ),
            AgentTaskAssignment(
                task_id="content_director",
                agent_name=content_director_agent,
                role="content_director",
                reason="Content direction turns evidence into a page plan.",
                required_capabilities=["content_distribution", "section_planning"],
                task_role=TaskRole.content_director.value,
                executor_kind=ExecutorKind.agent.value,
                task_graph_node_id="content_director",
            ),
            AgentTaskAssignment(
                task_id="artifact",
                agent_name=design_agent,
                role="vangogh",
                reason="Artifact generation consumes merged evidence.",
                required_capabilities=["artifact_layout", "html_css_composition"],
                task_role=TaskRole.vangogh.value,
                executor_kind=ExecutorKind.agent.value,
                task_graph_node_id="vangogh",
            ),
            AgentTaskAssignment(
                task_id="governance",
                agent_name=governance_agent,
                role="governance",
                reason="Validation closes the hybrid workflow.",
                required_capabilities=["artifact_validation"],
                task_role=TaskRole.governance.value,
                executor_kind=ExecutorKind.agent.value,
                task_graph_node_id="governance",
            ),
        ]

    async def _build_strategy_draft(
        self,
        request: SubmitWorkflowRequest,
        mode: WorkflowMode,
        task_count: int,
        *,
        agent_catalog: list[LiveAgentProfile],
        assignments: list[AgentTaskAssignment],
    ) -> StrategicDraft:
        await self.log(f"Building execution strategy for {task_count} tasks in '{mode.value}' mode.", kind="thought")
        research_agents = [agent.name for agent in agent_catalog if any(cap.name in {"web_research", "document_research"} for cap in agent.capabilities)]
        content_agents = [agent.name for agent in agent_catalog if any(cap.name in {"content_distribution", "section_planning"} for cap in agent.capabilities)]
        design_agents = [agent.name for agent in agent_catalog if any(cap.name in {"artifact_layout", "html_css_composition"} for cap in agent.capabilities)]
        review_agents = [agent.name for agent in agent_catalog if any(cap.name == "artifact_validation" for cap in agent.capabilities)]
        assignment_names = [assignment.agent_name for assignment in assignments]

        summary = (
            f"The strategy starts with {'parallel research' if mode != WorkflowMode.sequential else 'a sequential research pass'} "
            f"to ground the request in HIVE-MIND memory, uploaded sources, and freshness checks when needed. It then uses {content_agents[0] if content_agents else 'the content director'} "
            f"to translate the brief into section-level guidance before {design_agents[0] if design_agents else 'Vangogh'} renders the final artifact "
            f"and {review_agents[0] if review_agents else 'Governance'} validates the result."
        )
        notes = [
            f"Live catalog agents considered: {', '.join(research_agents + content_agents + design_agents + review_agents) or 'none'}.",
            f"Assignments resolved: {', '.join(assignment_names) or 'none'}.",
            "The workflow prefers research before clarification so follow-up questions can be shaped by evidence instead of guesswork.",
        ]
        draft = StrategicDraft(
            workflow_mode=mode,
            summary=summary,
            notes=notes,
            task_count=task_count,
            topology_reason="Deterministic strategy draft derived from the live agent catalog and artifact requirements.",
        )
        await self.log(summary, kind="status")
        return draft

    async def fan_in(self, evidence_packs: list[dict]) -> dict:
        await self.log(f"Merging {len(evidence_packs)} evidence packs into a consolidated brief.", kind="status")
        result = {
            "summary": f"Merged {len(evidence_packs)} evidence packs.",
            "evidence_packs": evidence_packs,
        }
        await self.log("Evidence merge complete. Ready for artifact generation.", kind="status")
        return result

    async def build_plan(self, request: SubmitWorkflowRequest, agent_catalog: list[LiveAgentProfile] | None = None) -> WorkflowPlan:
        catalog = agent_catalog if agent_catalog is not None else self.catalog_provider()
        if self.is_direct_knowledge_query(request):
            await self.log(
                "Detected a direct knowledge question. Routing straight to memory-first research and a final synthesized answer.",
                kind="decision",
            )
            research_node = WorkflowNode(
                node_id="research-answer",
                task_role=TaskRole.research,
                executor_kind=ExecutorKind.agent,
                purpose="Research the question with HIVE-MIND recall first, then synthesize a direct answer.",
                assigned_to="research",
                required_capabilities=["memory_retrieval", "memory_synthesis"],
                inputs={"response_mode": "direct_answer"},
            )
            task_graph = TaskGraph(
                nodes=[research_node],
                edges=[],
                entry_nodes=["research-answer"],
                terminal_nodes=["research-answer"],
            )
            task = AgentRunPayload(
                agent_type=AgentType.research,
                purpose=research_node.purpose,
                node_id=research_node.node_id,
                task_role=research_node.task_role,
                executor_kind=research_node.executor_kind,
                inputs=research_node.inputs,
                required_capabilities=research_node.required_capabilities,
                assigned_to=research_node.assigned_to,
            )
            summary = (
                "This is a direct knowledge question, so I will skip artifact generation, run HIVE-MIND-first research, "
                "and return a synthesized answer."
            )
            notes = [
                "Route chosen: direct answer, not artifact workflow.",
                "Research still prefers HIVE-MIND memory before any live web fallback.",
            ]
            return WorkflowPlan(
                workflow_mode=WorkflowMode.sequential,
                summary=summary,
                direct_answer=True,
                notes=notes,
                artifact_family=ArtifactFamily.custom,
                artifact_spec=ArtifactSpec(
                    family=ArtifactFamily.custom,
                    title=request.user_query,
                    audience=request.target_audience,
                    deliverable_format="text_answer",
                    required_sections=[],
                    tone="direct",
                    constraints=[],
                    success_criteria=["Research uses HIVE-MIND recall first", "Final answer is concise and evidence-backed"],
                ),
                requirements_checklist=RequirementsChecklist(items=[], coverage_score=1.0, missing_required_ids=[]),
                task_graph=task_graph,
                tasks=[task],
                hitl_nodes=[],
                content_director_nodes=[],
                available_agents=catalog,
                agent_assignments=self._compose_assignments(WorkflowMode.sequential, catalog),
                topology_reason="Direct knowledge query routed to research-only answer path.",
                fan_in_required=False,
            )
        artifact_family = self.classify_artifact_family(request)
        artifact_spec = ArtifactSpec(
            family=artifact_family,
            title=request.user_query,
            audience=request.target_audience,
            deliverable_format=request.artifact_type,
            required_sections=list(ARTIFACT_BLUEPRINTS[artifact_family]["required_sections"]),
            tone=str(ARTIFACT_BLUEPRINTS[artifact_family]["tone"]),
            constraints=[str(constraint) for constraint in request.explicit_requirements],
            success_criteria=[
                "Strategy acknowledges the live catalog",
                "Research is grounded in sources",
                "Content director produces a section plan",
                "Vangogh renders the final artifact",
            ],
        )
        requirements = self.compute_missing_requirements(
            self.derive_artifact_requirements(artifact_family, request)
        )
        mode = await self.choose_topology(request, catalog)
        if artifact_family != ArtifactFamily.custom:
            mode = WorkflowMode.hybrid if mode == WorkflowMode.hybrid else mode
        assignments = self._compose_assignments(mode, catalog)
        task_graph = self.compose_task_graph(artifact_family, requirements, catalog)
        topology_reason = (
            f"Planner matched the request to the {artifact_family.value} artifact family and selected a {mode.value} topology so research can fan out before content direction, rendering, and governance converge."
        )

        def node_to_task(node: WorkflowNode) -> AgentRunPayload | None:
            if node.executor_kind == ExecutorKind.human:
                return None
            return AgentRunPayload(
                agent_type=TASK_ROLE_TO_AGENT_TYPE.get(node.task_role, AgentType.strategist),
                purpose=node.purpose,
                depends_on=list(node.depends_on),
                branch_key=node.parallel_group,
                task_input={
                    "artifact_family": artifact_family.value,
                    "inputs": node.inputs,
                    "outputs": node.outputs,
                    "acceptance_criteria": node.acceptance_criteria,
                },
                node_id=node.node_id,
                task_role=node.task_role,
                executor_kind=node.executor_kind,
                parallel_group=node.parallel_group,
                inputs=node.inputs,
                outputs=node.outputs,
                acceptance_criteria=node.acceptance_criteria,
                requires_approval=node.requires_approval,
                assigned_to=node.assigned_to,
                required_capabilities=node.required_capabilities,
            )

        tasks = [task for node in task_graph.nodes if (task := node_to_task(node)) is not None]
        hitl_nodes = [node for node in task_graph.nodes if node.task_role == TaskRole.hitl]
        content_director_nodes = [node for node in task_graph.nodes if node.task_role == TaskRole.content_director]
        draft = await self._build_strategy_draft(
            request,
            mode,
            len(tasks),
            agent_catalog=catalog,
            assignments=assignments,
        )
        draft = draft.model_copy(
            update={
                "artifact_family": artifact_family,
                "artifact_spec": artifact_spec,
                "requirements_checklist": requirements,
                "task_graph": task_graph,
                "hitl_nodes": hitl_nodes,
                "content_director_nodes": content_director_nodes,
                "topology_reason": topology_reason,
            }
        )
        await self.log(
            f"Plan ready: {artifact_family.value} uses {mode.value} execution with {len(hitl_nodes)} HITL node(s).",
            kind="decision",
            detail={"artifact_family": artifact_family.value, "coverage_score": requirements.coverage_score},
        )
        fan_in_required = bool(task_graph.fan_in_groups)
        return WorkflowPlan(
            workflow_mode=mode,
            summary=draft.summary,
            direct_answer=False,
            notes=draft.notes,
            artifact_family=artifact_family,
            artifact_spec=artifact_spec,
            requirements_checklist=requirements,
            task_graph=task_graph,
            tasks=tasks,
            hitl_nodes=hitl_nodes,
            content_director_nodes=content_director_nodes,
            available_agents=catalog,
            agent_assignments=assignments,
            topology_reason=draft.topology_reason or topology_reason,
            fan_in_required=fan_in_required,
        )
