from agentscope_blaiq.agents.strategic import StrategicAgent
from agentscope_blaiq.contracts.agent_catalog import AgentCapability, AgentSkill, AgentStatus, LiveAgentProfile
from agentscope_blaiq.contracts.workflow import SubmitWorkflowRequest, WorkflowMode
from agentscope_blaiq.runtime.registry import AgentRegistry


def test_registry_exposes_structured_live_agent_catalog():
    registry = AgentRegistry()
    live_agents = registry.list_live_profiles()

    strategist = next(agent for agent in live_agents if agent.name == "strategist")
    research = next(agent for agent in live_agents if agent.name == "research")

    assert strategist.status == AgentStatus.ready
    assert any(cap.name == "route_planning" for cap in strategist.capabilities)
    assert any(skill.name == "workflow_decomposition" for skill in strategist.skills)
    assert any(cap.name == "web_research" for cap in research.capabilities)
    assert any(skill.name == "source_citation" for skill in research.skills)


def test_strategic_agent_uses_catalog_for_hybrid_assignment():
    catalog = [
        LiveAgentProfile(
            name="strategist",
            role="workflow topology",
            status=AgentStatus.ready,
            capabilities=[AgentCapability(name="route_planning", description="Plan workflows.")],
            skills=[AgentSkill(name="workflow_decomposition")],
            tools=["list_live_agents"],
        ),
        LiveAgentProfile(
            name="research-web",
            role="evidence gathering",
            status=AgentStatus.ready,
            capabilities=[AgentCapability(name="web_research", description="Fetch web evidence.")],
            skills=[AgentSkill(name="source_citation")],
            tools=["fetch_url_summary"],
        ),
        LiveAgentProfile(
            name="research-docs",
            role="evidence gathering",
            status=AgentStatus.ready,
            capabilities=[AgentCapability(name="document_research", description="Scan uploads.")],
            skills=[AgentSkill(name="source_citation")],
            tools=["validate_document_path"],
        ),
        LiveAgentProfile(
            name="vangogh",
            role="visual artifact generation",
            status=AgentStatus.ready,
            capabilities=[AgentCapability(name="artifact_layout", description="Compose layouts.")],
            skills=[AgentSkill(name="editorial_layout")],
            tools=["artifact_contract"],
        ),
        LiveAgentProfile(
            name="governance",
            role="validation",
            status=AgentStatus.ready,
            capabilities=[AgentCapability(name="artifact_validation", description="Validate artifacts.")],
            skills=[AgentSkill(name="quality_gate")],
            tools=["validate_visual_artifact"],
        ),
    ]

    strategist = StrategicAgent(catalog_provider=lambda: catalog)
    request = SubmitWorkflowRequest(user_query="Create a professional pitch deck presentation", workflow_mode=WorkflowMode.hybrid)
    mode = strategist._heuristic_topology(request, catalog)
    assignments = strategist._compose_assignments(mode, catalog)

    assert mode == WorkflowMode.hybrid
    assert len(assignments) == 5
    assert assignments[0].agent_name == "research-web"
    assert assignments[1].agent_name == "research-docs"
    assert assignments[2].agent_name == "content_director"
    assert assignments[3].agent_name == "vangogh"
    assert assignments[4].agent_name == "governance"


def test_strategic_agent_detects_direct_knowledge_query():
    request = SubmitWorkflowRequest(user_query="what do u know about me", workflow_mode=WorkflowMode.hybrid)
    assert StrategicAgent.is_direct_knowledge_query(request) is True

    typo_request = SubmitWorkflowRequest(user_query="what di u know about me", workflow_mode=WorkflowMode.hybrid)
    assert StrategicAgent.is_direct_knowledge_query(typo_request) is True

    artifact_request = SubmitWorkflowRequest(user_query="Create a professional pitch deck presentation", workflow_mode=WorkflowMode.hybrid)
    assert StrategicAgent.is_direct_knowledge_query(artifact_request) is False
