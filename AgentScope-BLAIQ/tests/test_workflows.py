from types import SimpleNamespace
import asyncio

import pytest

from agentscope_blaiq.contracts.artifact import ArtifactSection, VisualArtifact
from agentscope_blaiq.contracts.agent_catalog import AgentCapability, AgentSkill, AgentStatus, LiveAgentProfile
from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.contracts.workflow import AgentRunPayload, AgentType, SubmitWorkflowRequest, WorkflowMode, WorkflowPlan
import agentscope_blaiq.workflows.engine as workflow_engine_module
from agentscope_blaiq.workflows.engine import WorkflowEngine


class FakeWorkflowRepository:
    def __init__(self, session, state_store=None):
        self.events = session.setdefault("events", [])
        self.status = session.setdefault("status", {})
        self.state_store = state_store

    async def create_workflow(self, request, run_id=None, workflow_plan_json=None):
        self.status[request.thread_id] = {"status": "queued"}
        return self.status[request.thread_id]

    async def append_event(self, event):
        self.events.append(event)

    async def update_workflow_snapshot(
        self,
        thread_id,
        *,
        run_id=None,
        status=None,
        current_node=None,
        current_phase=None,
        current_agent=None,
        latest_event=None,
        error_message=None,
        workflow_mode=None,
        workflow_plan_json=None,
        final_artifact_json=None,
        **kwargs,
    ):
        snapshot = self.status.setdefault(thread_id, {})
        if status is not None:
            snapshot["status"] = status.value if hasattr(status, "value") else status
        if latest_event is not None:
            snapshot["latest_event"] = latest_event
        if current_node is not None:
            snapshot["current_node"] = current_node
        if current_phase is not None:
            snapshot["current_phase"] = current_phase
        if current_agent is not None:
            snapshot["current_agent"] = current_agent
        if error_message is not None:
            snapshot["error_message"] = error_message
        if workflow_mode is not None:
            snapshot["workflow_mode"] = workflow_mode.value if hasattr(workflow_mode, "value") else workflow_mode
        if workflow_plan_json is not None:
            snapshot["workflow_plan_json"] = workflow_plan_json
        if final_artifact_json is not None:
            snapshot["final_artifact_json"] = final_artifact_json
        for key, value in kwargs.items():
            if value is not None:
                snapshot[key] = value

    async def set_final_artifact(self, thread_id, artifact):
        self.status[thread_id] = {"status": "complete", "artifact": artifact}


class FakeArtifactRepository:
    def __init__(self, session):
        self.session = session

    async def save(self, thread_id, tenant_id, artifact, html_path, css_path):
        self.session.setdefault("artifacts", {})[thread_id] = artifact


class FakeEvidenceRepository:
    def __init__(self, session):
        self.session = session

    async def save(self, thread_id, tenant_id, evidence_id, evidence):
        self.session.setdefault("evidence", {})[thread_id] = evidence


class FakeAgentRunRepository:
    def __init__(self, session):
        self.session = session

    async def create_run(self, *, thread_id, tenant_id, agent_name, agent_type, branch_id=None, input_json=None):
        run_id = f"{agent_name}-{len(self.session.setdefault('agent_runs', [])) + 1}"
        record = SimpleNamespace(
            run_id=run_id,
            thread_id=thread_id,
            tenant_id=tenant_id,
            agent_name=agent_name,
            agent_type=agent_type,
            branch_id=branch_id,
            input_json=input_json or {},
            status="running",
        )
        self.session.setdefault("agent_runs", []).append(record)
        return record

    async def mark_complete(self, run_id, output_json=None):
        self.session.setdefault("agent_run_status", {})[run_id] = {"status": "complete", "output": output_json or {}}

    async def mark_failed(self, run_id, error_message):
        self.session.setdefault("agent_run_status", {})[run_id] = {"status": "error", "error_message": error_message}


@pytest.fixture(autouse=True)
def fake_repositories(monkeypatch):
    monkeypatch.setattr(workflow_engine_module, "WorkflowRepository", FakeWorkflowRepository)
    monkeypatch.setattr(workflow_engine_module, "ArtifactRepository", FakeArtifactRepository)
    monkeypatch.setattr(workflow_engine_module, "EvidenceRepository", FakeEvidenceRepository)
    monkeypatch.setattr(workflow_engine_module, "AgentRunRepository", FakeAgentRunRepository)


@pytest.fixture
def session():
    return {}


class FakeStrategist:
    def __init__(self):
        self.agent_catalog = []

    async def build_plan(self, request, agent_catalog=None):
        self.agent_catalog = agent_catalog or []
        return WorkflowPlan(
            workflow_mode=request.workflow_mode,
            summary="test plan",
            tasks=[AgentRunPayload(agent_type=AgentType.research, purpose="test")],
            available_agents=agent_catalog or [],
        )


class FakeResearch:
    async def gather(self, session, tenant_id, query, scope):
        return EvidencePack(summary=f"{scope} evidence", confidence=0.8)

    async def answer_question(self, query, evidence):
        return f"Direct answer for: {query}"


class FakeVangogh:
    async def generate(self, user_query, evidence, content_brief=None):
        return VisualArtifact(
            artifact_id="artifact-1",
            title="Artifact",
            sections=[
                ArtifactSection(
                    section_id="hero",
                    section_index=0,
                    title="Hero",
                    summary="Hero section",
                    html_fragment="<section>Hero</section>",
                )
            ],
            evidence_refs=["source-1"],
            html="<html></html>",
            css="body{}",
        )


class FakeGovernance:
    async def review(self, artifact, evidence):
        class _Report:
            def model_dump(self_inner):
                return {"approved": True, "issues": [], "readiness_score": 1.0}

        return _Report()


class FakeContentDirector:
    async def plan_content(self, *, user_query, evidence_summary, artifact_spec, requirements, hitl_answers=None):
        return SimpleNamespace(
            model_dump=lambda: {
                "title": user_query,
                "family": getattr(getattr(artifact_spec, "family", None), "value", "custom"),
                "template_name": "default",
                "narrative": evidence_summary,
                "section_plan": [],
                "distribution_notes": [],
                "handoff_notes": [],
            }
        )


class FakeHITL:
    async def generate_prompt(
        self,
        *,
        user_query,
        artifact_family,
        requirements,
        missing_requirement_ids,
        evidence_summary=None,
        target_audience=None,
        delivery_channel=None,
        brand_context=None,
    ):
        questions = [
            {
                "requirement_id": requirement.requirement_id,
                "question": requirement.text,
                "why_it_matters": "",
                "answer_hint": requirement.text,
            }
            for requirement in requirements.items
            if requirement.requirement_id in missing_requirement_ids
        ]
        return SimpleNamespace(
            headline="Clarification needed",
            intro="Please provide the missing details.",
            questions=questions,
            blocked_question=" ".join(question["question"] for question in questions),
            expected_answer_schema={question["requirement_id"]: question["question"] for question in questions},
            family=artifact_family,
        )


class FakeRegistry:
    def __init__(self):
        self.strategist = FakeStrategist()
        self.hitl = FakeHITL()
        self.research = FakeResearch()
        self.content_director = FakeContentDirector()
        self.vangogh = FakeVangogh()
        self.governance = FakeGovernance()

    def mark_agent_busy(self, name, stage=None):
        return None

    def mark_agent_ready(self, name, stage=None):
        return None

    def list_live_profiles(self):
        return [
            LiveAgentProfile(
                name="hitl",
                role="human clarification",
                status=AgentStatus.ready,
                capabilities=[AgentCapability(name="clarification_dialogue", description="Frame missing requirements as natural language questions.")],
                skills=[AgentSkill(name="question_framing")],
                tools=["clarify_requirements"],
            ),
            LiveAgentProfile(
                name="research",
                role="evidence gathering",
                status=AgentStatus.ready,
                capabilities=[AgentCapability(name="web_research", description="Fetch web sources.")],
                skills=[AgentSkill(name="source_citation")],
                tools=["fetch_url_summary"],
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
                name="content_director",
                role="content planning",
                status=AgentStatus.ready,
                capabilities=[AgentCapability(name="content_distribution", description="Plan content distribution.")],
                skills=[AgentSkill(name="render_brief_generation")],
                tools=["content_distribution"],
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


@pytest.mark.asyncio
async def test_sequential_workflow_emits_terminal_event(session):
    engine = WorkflowEngine(FakeRegistry())
    request = SubmitWorkflowRequest(user_query="Create a strategy visual", workflow_mode=WorkflowMode.sequential)
    events = [event async for event in engine.run(session, request)]
    assert events[0].type == "workflow_submitted"
    assert events[-1].type == "workflow_complete"
    assert any(event.type == "artifact_ready" for event in events)


@pytest.mark.asyncio
async def test_parallel_workflow_emits_fanin(session):
    engine = WorkflowEngine(FakeRegistry())
    request = SubmitWorkflowRequest(user_query="Create a research-backed visual", workflow_mode=WorkflowMode.parallel)
    events = [event async for event in engine.run(session, request)]
    event_types = [event.type for event in events]
    assert "parallel_branch_started" in event_types
    assert "fanin_completed" in event_types
    assert event_types[-1] == "workflow_complete"


class SlowStrategist(FakeStrategist):
    async def build_plan(self, request, agent_catalog=None):
        await asyncio.sleep(0.2)
        return await super().build_plan(request, agent_catalog=agent_catalog)


class SlowRegistry(FakeRegistry):
    def __init__(self):
        super().__init__()
        self.strategist = SlowStrategist()


class DirectAnswerStrategist(FakeStrategist):
    async def build_plan(self, request, agent_catalog=None):
        return WorkflowPlan(
            workflow_mode=WorkflowMode.sequential,
            summary="Direct knowledge question routed to research-only answer path.",
            direct_answer=True,
            tasks=[AgentRunPayload(agent_type=AgentType.research, purpose="Research and answer directly")],
            available_agents=agent_catalog or [],
        )


class DirectAnswerRegistry(FakeRegistry):
    def __init__(self):
        super().__init__()
        self.strategist = DirectAnswerStrategist()


@pytest.mark.asyncio
async def test_workflow_streams_immediate_submission_before_plan_resolves(session):
    engine = WorkflowEngine(SlowRegistry())
    request = SubmitWorkflowRequest(user_query="Create a streamed plan", workflow_mode=WorkflowMode.hybrid)
    stream = engine.run(session, request)

    first_event = await asyncio.wait_for(stream.__anext__(), timeout=0.1)
    second_event = await asyncio.wait_for(stream.__anext__(), timeout=0.1)

    assert first_event.type == "workflow_submitted"
    assert second_event.type == "planning_started"

    remaining_events = [event async for event in stream]
    assert any(event.type == "planning_complete" for event in remaining_events)


@pytest.mark.asyncio
async def test_direct_knowledge_query_returns_final_answer_without_artifact_or_hitl(session):
    engine = WorkflowEngine(DirectAnswerRegistry())
    request = SubmitWorkflowRequest(user_query="what do u know about me", workflow_mode=WorkflowMode.hybrid, source_scope="web")

    events = [event async for event in engine.run(session, request)]
    event_types = [event.type for event in events]

    assert event_types[0] == "workflow_submitted"
    assert "agent_completed" in event_types
    assert "workflow_blocked" not in event_types
    assert "artifact_ready" not in event_types
    assert event_types[-1] == "workflow_complete"
    assert events[-1].data["final_answer"] == "Direct answer for: what do u know about me"
    assert events[-1].data["final_artifact"] is None


@pytest.mark.asyncio
async def test_typoed_direct_knowledge_query_returns_final_answer_without_artifact_or_hitl(session):
    engine = WorkflowEngine(DirectAnswerRegistry())
    request = SubmitWorkflowRequest(user_query="what di u know about me", workflow_mode=WorkflowMode.hybrid, source_scope="web")

    events = [event async for event in engine.run(session, request)]
    event_types = [event.type for event in events]

    assert event_types[0] == "workflow_submitted"
    assert "agent_completed" in event_types
    assert "workflow_blocked" not in event_types
    assert "artifact_ready" not in event_types
    assert event_types[-1] == "workflow_complete"
    assert events[-1].data["final_answer"] == "Direct answer for: what di u know about me"
    assert events[-1].data["final_artifact"] is None
