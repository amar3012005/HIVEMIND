from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agentscope_blaiq.contracts.artifact import ArtifactSection, VisualArtifact
from agentscope_blaiq.contracts.events import StreamEvent
from agentscope_blaiq.contracts.evidence import EvidencePack, EvidenceFinding, SourceRecord, Citation
from agentscope_blaiq.agents.clarification import ClarificationPrompt
from agentscope_blaiq.persistence.database import get_session_local
from agentscope_blaiq.contracts.workflow import AgentType, ArtifactSpec, RequirementStage, ResumeWorkflowRequest, SubmitWorkflowRequest, WorkflowMode, WorkflowPlan, WorkflowStatus
from agentscope_blaiq.persistence.redis_state import BranchRedisState, RedisStateStore, WorkflowRedisState
from agentscope_blaiq.persistence.repositories import (
    AgentRunRepository,
    ArtifactRepository,
    EvidenceRepository,
    WorkflowRepository,
)
from agentscope_blaiq.runtime.registry import AgentRegistry
from agentscope_blaiq.tools.artifacts import persist_artifact_files

EventPublisher = Callable[[StreamEvent], Awaitable[StreamEvent]]
logger = logging.getLogger("agentscope_blaiq.workflow")


def _make_agent_log_sink(events: "EventFactory", publish: EventPublisher, agent_name: str, phase: str):
    """Create a log sink bound to a specific agent and phase.

    The sink emits agent_log events through the SSE stream so the
    frontend can render live messages from the agent while it works.
    """

    async def sink(
        message: str,
        message_kind: str = "status",
        visibility: str = "user",
        detail: dict[str, Any] | None = None,
    ) -> None:
        await publish(
            events.build(
                "agent_log",
                agent_name=agent_name,
                phase=phase,
                data={
                    "message": message,
                    "message_kind": message_kind,
                    "visibility": visibility,
                    **({"detail": detail} if detail else {}),
                },
            )
        )

    return sink


def _collect_missing_requirement_prompts(plan: WorkflowPlan, *, stage: RequirementStage | None = None) -> list[str]:
    prompts: list[str] = []
    for item in plan.requirements_checklist.items:
        if not item.must_have or item.status == "filled":
            continue
        if stage is not None and item.blocking_stage != stage:
            continue
        prompts.append(item.text)
    return prompts


@dataclass
class BranchResult:
    branch_id: str
    evidence: EvidencePack | None = None
    section: ArtifactSection | None = None
    error_message: str | None = None


@dataclass
class WorkflowExecutionResult:
    evidence: EvidencePack | None = None
    artifact: VisualArtifact | None = None
    governance_report: dict[str, Any] | None = None
    final_answer: str | None = None


@dataclass
class WorkflowRunContext:
    session: AsyncSession
    session_factory: async_sessionmaker[AsyncSession]
    persistence_lock: asyncio.Lock
    request: SubmitWorkflowRequest
    plan: WorkflowPlan
    resume_answers: dict[str, str]
    run_id: str
    workflow_mode: WorkflowMode
    registry: AgentRegistry
    repo: WorkflowRepository
    artifact_repo: ArtifactRepository
    evidence_repo: EvidenceRepository
    agent_run_repo: AgentRunRepository
    state_store: RedisStateStore
    is_resume: bool = False
    resume_cursor: str | None = None
    last_completed_node: str | None = None

    @property
    def resume_from_post_research_hitl(self) -> bool:
        return self.is_resume and self.resume_cursor == "hitl_evidence" and self.last_completed_node == "research"


class EventFactory:
    def __init__(self, request: SubmitWorkflowRequest, run_id: str) -> None:
        self.request = request
        self.run_id = run_id
        self.sequence = 0

    def build(
        self,
        event_type: str,
        agent_name: str = "system",
        phase: str = "system",
        status: str = "running",
        data: dict[str, Any] | None = None,
    ) -> StreamEvent:
        self.sequence += 1
        return StreamEvent(
            type=event_type,
            sequence=self.sequence,
            run_id=self.run_id,
            thread_id=self.request.thread_id,
            session_id=self.request.session_id,
            tenant_id=self.request.tenant_id,
            agent_name=agent_name,
            phase=phase,
            status=status,
            data=data or {},
        )


class WorkflowEngine:
    def __init__(
        self,
        registry: AgentRegistry,
        state_store: RedisStateStore | None = None,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
    ) -> None:
        self.registry = registry
        self.state_store = state_store or RedisStateStore()
        self.session_factory = session_factory or get_session_local()

    async def run(self, session: AsyncSession, request: SubmitWorkflowRequest):
        async for event in self._run_workflow(session=session, request=request, resume_request=None):
            yield event

    async def resume(self, session: AsyncSession, request: ResumeWorkflowRequest):
        repo = WorkflowRepository(session, self.state_store)
        workflow = await repo.get_workflow_record(request.thread_id)
        if workflow is None:
            raise ValueError("Workflow not found")
        snapshot = await repo.get_status(request.thread_id)
        if snapshot is None:
            raise ValueError("Workflow not found")
        if snapshot.status not in {WorkflowStatus.blocked, WorkflowStatus.error}:
            raise ValueError("Workflow can only be resumed from blocked or error status")

        submit_request = await repo.build_submit_request(request.thread_id)
        if submit_request is None:
            raise ValueError("Workflow not found")
        if request.tenant_id is not None and request.tenant_id != submit_request.tenant_id:
            raise ValueError("tenant_id does not match the stored workflow")

        resume_reason = request.resume_reason or f"retry from {snapshot.status.value}"
        async for event in self._run_workflow(
            session=session,
            request=submit_request,
            resume_request=request,
            resume_reason=resume_reason,
            previous_status=snapshot.status.value,
            previous_run_id=snapshot.run_id,
        ):
            yield event

    async def _run_workflow(
        self,
        *,
        session: AsyncSession,
        request: SubmitWorkflowRequest,
        resume_request: ResumeWorkflowRequest | None,
        resume_reason: str | None = None,
        previous_status: str | None = None,
        previous_run_id: str | None = None,
    ):
        repo = WorkflowRepository(session, self.state_store)
        artifact_repo = ArtifactRepository(session)
        evidence_repo = EvidenceRepository(session)
        agent_run_repo = AgentRunRepository(session)

        is_resume = resume_request is not None
        resume_cursor: str | None = None
        last_completed_node: str | None = None
        run_id = str(uuid4())
        events = EventFactory(request, run_id)
        queue: asyncio.Queue[StreamEvent | object] = asyncio.Queue()
        done_marker = object()
        persistence_lock = asyncio.Lock()

        async def publish(event: StreamEvent) -> StreamEvent:
            async with persistence_lock:
                await repo.append_event(event)
            logger.info(
                "workflow_event type=%s phase=%s agent=%s status=%s thread_id=%s data=%s",
                event.type,
                event.phase,
                event.agent_name,
                event.status,
                event.thread_id,
                self._summarize_event_data(event),
            )
            await queue.put(event)
            return event

        def make_agent_log_sink(agent_name: str, phase: str):
            return _make_agent_log_sink(events, publish, agent_name, phase)

        if not is_resume:
            await repo.create_workflow(request, run_id=run_id, workflow_plan_json=None)
            await self.state_store.set_workflow_state(
                WorkflowRedisState(
                    thread_id=request.thread_id,
                    run_id=run_id,
                    tenant_id=request.tenant_id,
                    session_id=request.session_id,
                    workflow_mode=request.workflow_mode,
                    artifact_type=request.artifact_type,
                    source_scope=request.source_scope,
                    user_query=request.user_query,
                    workflow_plan_json=None,
                    status=WorkflowStatus.queued,
                    current_node="planning",
                    current_phase="planning",
                    current_agent="strategist",
                )
            )
        else:
            current_state = await self.state_store.get_workflow_state(request.thread_id)
            if current_state is not None:
                resume_cursor = current_state.resume_cursor
                last_completed_node = current_state.last_completed_node
            if current_state is None:
                await self.state_store.set_workflow_state(
                    WorkflowRedisState(
                        thread_id=request.thread_id,
                        run_id=run_id,
                        tenant_id=request.tenant_id,
                        session_id=request.session_id,
                        workflow_mode=request.workflow_mode,
                        artifact_type=request.artifact_type,
                        source_scope=request.source_scope,
                        user_query=request.user_query,
                        workflow_plan_json=None,
                        status=WorkflowStatus.queued,
                        current_node="planning",
                        current_phase="planning",
                        current_agent="strategist",
                    )
                )
            await self.state_store.mark_resumed(
                request.thread_id,
                run_id=run_id,
                resume_reason=resume_reason,
            )

        await self._update_workflow_snapshot(
            repo,
            request.thread_id,
            run_id=run_id,
            status=WorkflowStatus.queued,
            current_node="planning",
            current_phase="planning",
            current_agent="strategist",
            latest_event="workflow_resumed" if is_resume else "workflow_submitted",
            workflow_mode=request.workflow_mode,
            workflow_plan_json=None,
            error_message=None,
            final_artifact_json=None,
        )

        async def execute() -> None:
            plan: WorkflowPlan | None = None
            workflow_mode = request.workflow_mode
            try:
                await publish(
                    events.build(
                        "workflow_resumed" if is_resume else "workflow_submitted",
                        phase="workflow",
                        data=(
                            {
                                "workflow_mode": workflow_mode.value,
                                "resume_reason": resume_reason,
                                "previous_status": previous_status,
                                "previous_run_id": previous_run_id,
                            }
                            if is_resume
                            else {"workflow_mode": workflow_mode.value}
                        ),
                    )
                )
                if is_resume:
                    await publish(
                        events.build(
                            "resume_accepted",
                            agent_name="strategist",
                            phase="planning",
                            data={"answers": resume_request.answers if resume_request is not None else {}, "resume_reason": resume_reason},
                        )
                    )
                await publish(
                    events.build(
                        "planning_started",
                        agent_name="strategist",
                        phase="planning",
                        data={"workflow_mode": workflow_mode.value},
                    )
                )
                self._maybe_set_log_sink(self.registry.strategist, make_agent_log_sink("strategist", "planning"))
                plan = await self._resolve_plan(request, repo, is_resume=is_resume)
                workflow_mode = plan.workflow_mode
                await self._update_workflow_snapshot(
                    repo,
                    request.thread_id,
                    run_id=run_id,
                    status=WorkflowStatus.queued,
                    current_node="planning",
                    current_phase="planning",
                    current_agent="strategist",
                    latest_event="planning_started",
                    workflow_mode=workflow_mode,
                    workflow_plan_json=plan.model_dump_json(),
                    error_message=None,
                    final_artifact_json=None,
                )
                await self.state_store.set_workflow_state(
                    WorkflowRedisState(
                        thread_id=request.thread_id,
                        run_id=run_id,
                        tenant_id=request.tenant_id,
                        session_id=request.session_id,
                        workflow_mode=workflow_mode,
                        artifact_type=request.artifact_type,
                        source_scope=request.source_scope,
                        user_query=request.user_query,
                        workflow_plan_json=plan.model_dump_json(),
                        status=WorkflowStatus.queued,
                        current_node="planning",
                        current_phase="planning",
                        current_agent="strategist",
                    )
                )

                ctx = WorkflowRunContext(
                    session=session,
                    session_factory=self.session_factory,
                    persistence_lock=persistence_lock,
                    request=request,
                    plan=plan,
                    resume_answers=resume_request.answers if resume_request is not None else {},
                    run_id=run_id,
                    workflow_mode=workflow_mode,
                    registry=self.registry,
                    repo=repo,
                    artifact_repo=artifact_repo,
                    evidence_repo=evidence_repo,
                    agent_run_repo=agent_run_repo,
                    state_store=self.state_store,
                    is_resume=is_resume,
                    resume_cursor=resume_cursor,
                    last_completed_node=last_completed_node,
                )
                result = await self._execute_workflow(
                    ctx,
                    events,
                    publish,
                    emit_initial_events=False,
                )

                workflow_state = await self.state_store.get_workflow_state(request.thread_id)
                if workflow_state is not None and workflow_state.status == WorkflowStatus.blocked:
                    if result.evidence is not None:
                        evidence_id = str(uuid4())
                        await evidence_repo.save(request.thread_id, request.tenant_id, evidence_id, result.evidence)
                    return

                if result.evidence is not None:
                    evidence_id = str(uuid4())
                    await evidence_repo.save(request.thread_id, request.tenant_id, evidence_id, result.evidence)

                persisted_artifact = result.artifact
                if persisted_artifact is not None:
                    governance_status = "approved"
                    if result.governance_report is not None and not result.governance_report.get("approved", False):
                        governance_status = "revision_required"
                    persisted_artifact = persisted_artifact.model_copy(update={"governance_status": governance_status})
                    html_path, css_path = persist_artifact_files(request.thread_id, persisted_artifact)
                    await artifact_repo.save(request.thread_id, request.tenant_id, persisted_artifact, html_path, css_path)
                    await repo.set_final_artifact(request.thread_id, persisted_artifact)

                await self._update_workflow_snapshot(
                    repo,
                    request.thread_id,
                    run_id=run_id,
                    status=WorkflowStatus.complete,
                    current_node="workflow_complete",
                    current_phase="workflow",
                    current_agent="system",
                    latest_event="workflow_complete",
                    final_artifact_json=persisted_artifact.model_dump_json() if persisted_artifact is not None else None,
                    final_answer=result.final_answer,
                )
                await self.state_store.set_workflow_state(
                    WorkflowRedisState(
                        thread_id=request.thread_id,
                        run_id=run_id,
                        tenant_id=request.tenant_id,
                        session_id=request.session_id,
                        workflow_mode=workflow_mode,
                        artifact_type=request.artifact_type,
                        source_scope=request.source_scope,
                        user_query=request.user_query,
                        workflow_plan_json=plan.model_dump_json(),
                        status=WorkflowStatus.complete,
                        current_node="workflow_complete",
                        current_phase="workflow",
                        current_agent="system",
                        final_artifact_json=persisted_artifact.model_dump_json() if persisted_artifact is not None else None,
                        final_answer=result.final_answer,
                    )
                )
                await publish(
                    events.build(
                        "workflow_complete",
                        phase="workflow",
                        status="complete",
                        data={
                            "workflow_mode": workflow_mode.value,
                            "final_artifact": persisted_artifact.model_dump() if persisted_artifact is not None else None,
                            "final_answer": result.final_answer,
                            "evidence_pack": result.evidence.model_dump() if result.evidence is not None else None,
                            "governance_report": result.governance_report,
                        },
                    )
                )
            except Exception as exc:
                await self._update_workflow_snapshot(
                    repo,
                    request.thread_id,
                    run_id=run_id,
                    status=WorkflowStatus.error,
                    current_node="workflow_error",
                    current_phase="workflow",
                    current_agent="system",
                    latest_event="workflow_error",
                    error_message=str(exc),
                )
                await self.state_store.mark_error(request.thread_id, str(exc))
                await publish(
                    events.build(
                        "workflow_error",
                        phase="workflow",
                        status="error",
                        data={"error_message": str(exc)},
                    )
                )
            finally:
                await queue.put(done_marker)

        task = asyncio.create_task(execute())
        while True:
            item = await queue.get()
            if item is done_marker:
                break
            yield item
        await task

    async def _resolve_plan(self, request: SubmitWorkflowRequest, repo: WorkflowRepository, *, is_resume: bool) -> WorkflowPlan:
        if is_resume:
            workflow = await repo.get_workflow_record(request.thread_id)
            if workflow is not None and workflow.workflow_plan_json:
                try:
                    return WorkflowPlan.model_validate_json(workflow.workflow_plan_json)
                except Exception:
                    pass
        # Log sink is injected by the caller's publish closure via make_agent_log_sink.
        strategist = self.registry.strategist
        build_plan = getattr(strategist, "build_plan")
        signature = inspect.signature(build_plan)
        if "agent_catalog" in signature.parameters:
            return await build_plan(request, agent_catalog=self.registry.list_live_profiles())
        return await build_plan(request)

    @staticmethod
    def _maybe_set_log_sink(agent: Any, sink: Any) -> None:
        setter = getattr(agent, "set_log_sink", None)
        if callable(setter):
            setter(sink)

    @staticmethod
    async def _update_workflow_snapshot(repo: WorkflowRepository, thread_id: str, **kwargs: Any) -> None:
        update = getattr(repo, "update_workflow_snapshot", None)
        if not callable(update):
            return
        signature = inspect.signature(update)
        filtered = {key: value for key, value in kwargs.items() if key in signature.parameters}
        await update(thread_id, **filtered)

    @staticmethod
    def _task_graph_node(plan: WorkflowPlan, node_id: str) -> Any | None:
        for node in plan.task_graph.nodes:
            if node.node_id == node_id:
                return node
        return None

    @staticmethod
    def _missing_requirements(
        plan: WorkflowPlan,
        answers: dict[str, str] | None = None,
        *,
        stages: set[RequirementStage] | None = None,
    ) -> list[str]:
        provided = {key.strip(): str(value).strip() for key, value in (answers or {}).items() if str(value).strip()}
        missing: list[str] = []
        for item in plan.requirements_checklist.items:
            if not item.must_have:
                continue
            if item.status == "filled":
                continue
            if stages is not None and item.blocking_stage not in stages:
                continue
            if item.requirement_id in provided:
                continue
            missing.append(item.requirement_id)
        return missing

    @staticmethod
    def _event_stage_label(stages: set[RequirementStage]) -> str:
        if stages == {RequirementStage.before_research}:
            return "initial"
        if stages == {RequirementStage.evidence_informed, RequirementStage.before_render}:
            return "evidence_informed"
        return "general"

    @staticmethod
    def _blocked_question(plan: WorkflowPlan, missing_ids: list[str]) -> str:
        texts = []
        for item in plan.requirements_checklist.items:
            if item.requirement_id in missing_ids:
                texts.append(item.text)
        return " ".join(texts).strip() or "Please provide the missing requirements to continue."

    async def _build_clarification_prompt(
        self,
        ctx: WorkflowRunContext,
        missing_ids: list[str],
        evidence: EvidencePack,
        make_agent_log_sink: Callable[[str, str], Any],
    ) -> ClarificationPrompt:
        hitl = self.registry.hitl
        self._maybe_set_log_sink(hitl, make_agent_log_sink("hitl", "clarification"))
        self.registry.mark_agent_busy("hitl", "clarification")
        try:
            generate_prompt = getattr(hitl, "generate_prompt")
            signature = inspect.signature(generate_prompt)
            kwargs = {
                "user_query": ctx.request.user_query,
                "artifact_family": ctx.plan.artifact_family,
                "requirements": ctx.plan.requirements_checklist,
                "missing_requirement_ids": missing_ids,
                "evidence_summary": evidence.summary,
                "target_audience": ctx.request.target_audience,
                "delivery_channel": ctx.request.delivery_channel,
                "brand_context": ctx.request.brand_context,
            }
            if "evidence" in signature.parameters:
                kwargs["evidence"] = evidence
            return await generate_prompt(**kwargs)
        finally:
            self.registry.mark_agent_ready("hitl", "idle")

    async def _load_latest_evidence(self, evidence_repo: EvidenceRepository, thread_id: str) -> EvidencePack | None:
        records = await evidence_repo.list_for_thread(thread_id)
        if not records:
            return None
        latest = records[-1]
        try:
            return EvidencePack.model_validate_json(latest.evidence_json)
        except Exception:
            return None

    async def _emit_catalog_snapshot(self, publish: EventPublisher, events: EventFactory) -> None:
        await publish(
            events.build(
                "agent_catalog_snapshot",
                agent_name="strategist",
                phase="planning",
                data={"agents": [agent.model_dump() for agent in self.registry.list_live_profiles()]},
            )
        )

    async def _emit_evidence_signals(self, publish: EventPublisher, events: EventFactory, evidence: EvidencePack) -> None:
        if evidence.contradictions:
            await publish(
                events.build(
                    "contradictions_detected",
                    agent_name="research",
                    phase="research",
                    data={
                        "count": len(evidence.contradictions),
                        "contradictions": [item.model_dump() for item in evidence.contradictions],
                    },
                )
            )
        if evidence.provenance.save_back_eligible:
            await publish(
                events.build(
                    "save_back_available",
                    agent_name="research",
                    phase="research",
                    data={
                        "eligible": True,
                        "primary_ground_truth": evidence.provenance.primary_ground_truth,
                        "memory_sources": evidence.provenance.memory_sources,
                    },
                )
            )

    async def _run_content_director(
        self,
        ctx: WorkflowRunContext,
        events: EventFactory,
        publish: EventPublisher,
        *,
        evidence: EvidencePack,
    ) -> dict[str, Any]:
        node_id = "content_director"
        await self._set_branch(
            ctx,
            branch_id=node_id,
            agent_name="content_director",
            branch_kind="content_director",
            status="running",
            current_phase="content_director",
            input_json={
                "artifact_family": ctx.plan.artifact_family.value,
                "requirements": ctx.plan.requirements_checklist.model_dump(),
                "resume_answers": ctx.resume_answers,
            },
        )
        await publish(
            events.build(
                "content_director_started",
                agent_name="content_director",
                phase="content_director",
                data={"artifact_family": ctx.plan.artifact_family.value, "node_id": node_id},
            )
        )
        self.registry.mark_agent_busy("content_director", "content_director")
        brief = await self.registry.content_director.plan_content(
            user_query=ctx.request.user_query,
            evidence_summary=evidence.summary,
            artifact_spec=ctx.plan.artifact_spec or ArtifactSpec(family=ctx.plan.artifact_family),
            requirements=ctx.plan.requirements_checklist,
            hitl_answers=ctx.resume_answers,
        )
        content_brief = brief.model_dump()
        await self._update_workflow_snapshot(
            ctx.repo,
            ctx.request.thread_id,
            run_id=ctx.run_id,
            current_node="content_director",
            current_phase="content_director",
            current_agent="content_director",
            latest_event="content_director_completed",
            content_director_output_json=json.dumps(content_brief, default=str),
            last_completed_node="content_director",
        )
        workflow_state = await self.state_store.get_workflow_state(ctx.request.thread_id)
        if workflow_state is not None:
            workflow_state.current_node = "content_director"
            workflow_state.current_phase = "content_director"
            workflow_state.current_agent = "content_director"
            workflow_state.content_director_output_json = json.dumps(content_brief, default=str)
            workflow_state.last_completed_node = "content_director"
            workflow_state.updated_at = utc_now()
            await self.state_store.set_workflow_state(workflow_state)
        await publish(
            events.build(
                "content_director_completed",
                agent_name="content_director",
                phase="content_director",
                data={"content_brief": content_brief},
            )
        )
        self.registry.mark_agent_ready("content_director", "idle")
        await self._complete_branch(ctx, branch_id=node_id, output_json=content_brief)
        return content_brief

    async def _maybe_block_for_requirements(
        self,
        ctx: WorkflowRunContext,
        events: EventFactory,
        publish: EventPublisher,
        *,
        evidence: EvidencePack,
        stages: set[RequirementStage],
        pending_node: str,
    ) -> WorkflowExecutionResult | None:
        missing = self._missing_requirements(ctx.plan, ctx.resume_answers, stages=stages)
        if not missing:
            return None
        stage_label = self._event_stage_label(stages)
        try:
            clarification = await self._build_clarification_prompt(ctx, missing, evidence, lambda agent_name, phase: _make_agent_log_sink(events, publish, agent_name, phase))
        except Exception:
            clarification = None
        if clarification is not None:
            blocked_question = clarification.blocked_question or self._blocked_question(ctx.plan, missing)
            questions = [
                {
                    "requirement_id": question.requirement_id,
                    "question": question.question,
                    "why_it_matters": question.why_it_matters,
                    "answer_hint": question.answer_hint,
                }
                for question in clarification.questions
            ]
            expected_answer_schema = clarification.expected_answer_schema or {
                question["requirement_id"]: question["question"] for question in questions
            }
        else:
            blocked_question = self._blocked_question(ctx.plan, missing)
            questions = [
                {
                    "requirement_id": item.requirement_id,
                    "question": item.text,
                    "why_it_matters": None,
                    "answer_hint": item.text,
                }
                for item in ctx.plan.requirements_checklist.items
                if item.requirement_id in missing
            ]
            expected_answer_schema = {
                item.requirement_id: item.text
                for item in ctx.plan.requirements_checklist.items
                if item.requirement_id in missing
            }
        await self._set_branch(
            ctx,
            branch_id=pending_node,
            agent_name="strategist",
            branch_kind="hitl",
            status="blocked",
            current_phase="planning",
            input_json={"missing_requirements": missing, "clarification_stage": stage_label},
        )
        await publish(
            events.build(
                "workflow_blocked",
                agent_name="hitl",
                phase="clarification",
                status="blocked",
                data={
                    "artifact_family": ctx.plan.artifact_family.value,
                    "clarification_stage": stage_label,
                    "prompt_headline": clarification.headline if clarification is not None else "Clarification needed",
                    "prompt_intro": clarification.intro if clarification is not None else "Please help me fill the remaining requirements.",
                    "blocked_question": blocked_question,
                    "questions": questions,
                    "expected_answer_schema": {
                        "answers": expected_answer_schema,
                    },
                    "pending_node": pending_node,
                    "missing_requirements": missing,
                },
            )
        )
        await self._update_workflow_snapshot(
            ctx.repo,
            ctx.request.thread_id,
            run_id=ctx.run_id,
            status=WorkflowStatus.blocked,
            current_node="hitl",
            current_phase="planning",
            current_agent="strategist",
            latest_event="workflow_blocked",
            error_message=blocked_question,
            artifact_family=ctx.plan.artifact_family.value,
            blocked_question=blocked_question,
            expected_answer_schema={"answers": expected_answer_schema},
            resume_cursor=pending_node,
            last_completed_node="research" if stage_label == "evidence_informed" else "planning",
            requirements_checklist_json=ctx.plan.requirements_checklist.model_dump_json(),
        )
        await self.state_store.mark_blocked(
            ctx.request.thread_id,
            blocked_question,
            blocked_question=blocked_question,
            expected_answer_schema={"answers": expected_answer_schema},
            pending_node=pending_node,
            resume_cursor=pending_node,
            last_completed_node="research" if stage_label == "evidence_informed" else "planning",
            requirements_checklist_json=ctx.plan.requirements_checklist.model_dump_json(),
            artifact_family=ctx.plan.artifact_family.value,
        )
        workflow_state = await self.state_store.get_workflow_state(ctx.request.thread_id)
        if workflow_state is not None:
            workflow_state.current_node = pending_node
            workflow_state.current_phase = "planning"
            workflow_state.current_agent = "strategist"
            workflow_state.status = WorkflowStatus.blocked
            workflow_state.updated_at = utc_now()
            await self.state_store.set_workflow_state(workflow_state)
        return WorkflowExecutionResult(evidence=evidence, artifact=None, governance_report=None)

    @staticmethod
    def _summarize_event_data(event: StreamEvent) -> str:
        data = event.data or {}
        if event.type == "planning_complete":
            plan = data.get("plan") or {}
            summary = str(plan.get("summary") or "").strip()
            task_count = len(plan.get("tasks") or [])
            return json.dumps(
                {
                    "workflow_mode": plan.get("workflow_mode"),
                    "summary": summary,
                    "notes": plan.get("notes") or [],
                    "task_count": task_count,
                },
                ensure_ascii=False,
            )
        if event.type in {"parallel_branch_started", "parallel_branch_completed"}:
            return json.dumps(
                {
                    "branch": data.get("branch"),
                    "branch_kind": data.get("branch_kind"),
                },
                ensure_ascii=False,
            )
        if event.type == "artifact_section_ready":
            return json.dumps(
                {
                    "section_id": data.get("section_id"),
                    "title": data.get("title"),
                },
                ensure_ascii=False,
            )
        if event.type == "workflow_error":
            return json.dumps({"error_message": data.get("error_message")}, ensure_ascii=False)
        if event.type == "workflow_complete":
            artifact = data.get("final_artifact") or {}
            return json.dumps(
                {
                    "workflow_mode": data.get("workflow_mode"),
                    "artifact_title": artifact.get("title"),
                    "governance_status": artifact.get("governance_status"),
                },
                ensure_ascii=False,
            )
        if "message" in data:
            return json.dumps({"message": data.get("message")}, ensure_ascii=False)
        if "workflow_mode" in data:
            return json.dumps({"workflow_mode": data.get("workflow_mode")}, ensure_ascii=False)
        return json.dumps(data, ensure_ascii=False) if data else "{}"

    async def _execute_workflow(
        self,
        ctx: WorkflowRunContext,
        events: EventFactory,
        publish: EventPublisher,
        *,
        entry_event_type: str = "workflow_submitted",
        entry_data: dict[str, Any] | None = None,
        emit_initial_events: bool = True,
    ) -> WorkflowExecutionResult:
        emit_planning_replay = not ctx.resume_from_post_research_hitl
        if emit_initial_events:
            await publish(events.build(entry_event_type, phase="workflow", data=entry_data or {"workflow_mode": ctx.workflow_mode.value}))
            await publish(events.build("planning_started", agent_name="strategist", phase="planning", data={"workflow_mode": ctx.workflow_mode.value}))
        if emit_planning_replay:
            await publish(events.build("planning_complete", agent_name="strategist", phase="planning", data={"plan": ctx.plan.model_dump()}))
            await publish(
                events.build(
                    "artifact_family_selected",
                    agent_name="strategist",
                    phase="planning",
                    data={"artifact_family": ctx.plan.artifact_family.value, "artifact_spec": ctx.plan.artifact_spec.model_dump() if ctx.plan.artifact_spec else None},
                )
            )
            await publish(events.build("requirements_check_started", agent_name="strategist", phase="planning", data={"artifact_family": ctx.plan.artifact_family.value}))
            await publish(
                events.build(
                    "requirements_check_completed",
                    agent_name="strategist",
                    phase="planning",
                    data={
                        "artifact_family": ctx.plan.artifact_family.value,
                        "requirements_checklist": ctx.plan.requirements_checklist.model_dump(),
                        "missing_requirements": ctx.plan.requirements_checklist.missing_required_ids,
                    },
                )
            )
            await self._emit_catalog_snapshot(publish, events)
        await self._update_workflow_snapshot(
            ctx.repo,
            ctx.request.thread_id,
            run_id=ctx.run_id,
            status=WorkflowStatus.running,
            current_node="planning",
            current_phase="planning",
            current_agent="strategist",
            latest_event="planning_complete",
            workflow_mode=ctx.workflow_mode,
            workflow_plan_json=ctx.plan.model_dump_json(),
            artifact_family=ctx.plan.artifact_family.value,
            requirements_checklist_json=ctx.plan.requirements_checklist.model_dump_json(),
            task_graph_json=ctx.plan.task_graph.model_dump_json(),
            pending_node="research",
            resume_cursor="research",
        )

        if ctx.workflow_mode == WorkflowMode.sequential:
            return await self._run_sequential(ctx, events, publish)
        if ctx.workflow_mode == WorkflowMode.parallel:
            return await self._run_parallel(ctx, events, publish)
        return await self._run_hybrid(ctx, events, publish)

    async def _run_sequential(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher) -> WorkflowExecutionResult:
        if ctx.plan.direct_answer:
            return await self._run_direct_answer(ctx, events, publish)
        branch_id = "sequential-research"
        evidence = await self._load_latest_evidence(ctx.evidence_repo, ctx.request.thread_id) if ctx.resume_answers else None
        if evidence is None:
            await self._set_branch(
                ctx,
                branch_id=branch_id,
                agent_name="research",
                branch_kind="research",
                status="running",
                current_phase="research",
                input_json={"query": ctx.request.user_query, "scope": ctx.request.source_scope},
            )
            research_run = await ctx.agent_run_repo.create_run(
                thread_id=ctx.request.thread_id,
                tenant_id=ctx.request.tenant_id,
                agent_name="research",
                agent_type=AgentType.research.value,
                branch_id=branch_id,
                input_json={"query": ctx.request.user_query, "scope": ctx.request.source_scope},
            )

            await publish(events.build("agent_started", agent_name="research", phase="research", data={"branch_id": branch_id}))
            self.registry.mark_agent_busy("research", "research")
            self._maybe_set_log_sink(self.registry.research, _make_agent_log_sink(events, publish, "research", "research"))
            evidence = await self.registry.research.gather(ctx.session, ctx.request.tenant_id, ctx.request.user_query, ctx.request.source_scope)
            self.registry.mark_agent_ready("research", "idle")
            await publish(
                events.build(
                    "agent_completed",
                    agent_name="research",
                    phase="research",
                    data={"branch_id": branch_id, "evidence_pack": evidence.model_dump()},
                )
            )
            await self._emit_evidence_signals(publish, events, evidence)
            await ctx.agent_run_repo.mark_complete(research_run.run_id, evidence.model_dump())
            await self._complete_branch(ctx, branch_id=branch_id, output_json=evidence.model_dump())

        blocked = await self._maybe_block_for_requirements(
            ctx,
            events,
            publish,
            evidence=evidence,
            stages={RequirementStage.before_render, RequirementStage.evidence_informed},
            pending_node="hitl_evidence",
        )
        if blocked is not None:
            return blocked

        content_brief = await self._run_content_director(ctx, events, publish, evidence=evidence)
        artifact_result = await self._generate_artifact(ctx, events, publish, evidence=evidence, content_brief=content_brief)
        await self._emit_artifact_sections(ctx, events, publish, artifact_result.artifact, parallel=False)
        governance = await self._review_artifact(ctx, events, publish, artifact=artifact_result.artifact, evidence=evidence)
        return WorkflowExecutionResult(evidence=evidence, artifact=artifact_result.artifact, governance_report=governance.report)

    async def _run_direct_answer(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher) -> WorkflowExecutionResult:
        branch_id = "research-answer"
        await self._set_branch(
            ctx,
            branch_id=branch_id,
            agent_name="research",
            branch_kind="research",
            status="running",
            current_phase="research",
            input_json={"query": ctx.request.user_query, "scope": ctx.request.source_scope, "response_mode": "direct_answer"},
        )
        research_run = await ctx.agent_run_repo.create_run(
            thread_id=ctx.request.thread_id,
            tenant_id=ctx.request.tenant_id,
            agent_name="research",
            agent_type=AgentType.research.value,
            branch_id=branch_id,
            input_json={"query": ctx.request.user_query, "scope": ctx.request.source_scope, "response_mode": "direct_answer"},
        )
        await publish(events.build("agent_started", agent_name="research", phase="research", data={"branch_id": branch_id}))
        self.registry.mark_agent_busy("research", "research")
        self._maybe_set_log_sink(self.registry.research, _make_agent_log_sink(events, publish, "research", "research"))
        evidence = await self.registry.research.gather(ctx.session, ctx.request.tenant_id, ctx.request.user_query, ctx.request.source_scope)
        await publish(
            events.build(
                "agent_completed",
                agent_name="research",
                phase="research",
                data={"branch_id": branch_id, "evidence_pack": evidence.model_dump()},
            )
        )
        await self._emit_evidence_signals(publish, events, evidence)
        final_answer = await self.registry.research.answer_question(ctx.request.user_query, evidence)
        self.registry.mark_agent_ready("research", "idle")
        await ctx.agent_run_repo.mark_complete(research_run.run_id, {"evidence": evidence.model_dump(), "final_answer": final_answer})
        await self._complete_branch(ctx, branch_id=branch_id, output_json={"evidence": evidence.model_dump(), "final_answer": final_answer})
        return WorkflowExecutionResult(evidence=evidence, final_answer=final_answer)

    async def _run_parallel(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher) -> WorkflowExecutionResult:
        merged_evidence = await self._load_latest_evidence(ctx.evidence_repo, ctx.request.thread_id) if ctx.resume_answers else None
        branch_ids = ["research-web", "research-docs"]
        replay_research_merge = not (ctx.resume_from_post_research_hitl and merged_evidence is not None)
        if merged_evidence is None:
            branch_jobs = [
                asyncio.create_task(self._research_branch(ctx, events, publish, branch_kind="web")),
                asyncio.create_task(self._research_branch(ctx, events, publish, branch_kind="docs")),
            ]

            results: list[BranchResult] = []
            for task in asyncio.as_completed(branch_jobs):
                results.append(await task)

            if any(result.error_message for result in results):
                raise RuntimeError("; ".join(result.error_message for result in results if result.error_message))

            merged_evidence = self._merge_evidence(*(result.evidence for result in results if result.evidence is not None))
            branch_ids = [result.branch_id for result in results]
        if replay_research_merge:
            await publish(
                events.build(
                    "fanin_started",
                    agent_name="strategist",
                    phase="fanin",
                    data={"branches": branch_ids},
                )
            )
            await publish(events.build("fanin_completed", agent_name="strategist", phase="fanin", data={"evidence_pack": merged_evidence.model_dump()}))
            await self._emit_evidence_signals(publish, events, merged_evidence)

        blocked = await self._maybe_block_for_requirements(
            ctx,
            events,
            publish,
            evidence=merged_evidence,
            stages={RequirementStage.before_render, RequirementStage.evidence_informed},
            pending_node="hitl_evidence",
        )
        if blocked is not None:
            return blocked

        content_brief = await self._run_content_director(ctx, events, publish, evidence=merged_evidence)
        artifact_result = await self._generate_artifact(ctx, events, publish, evidence=merged_evidence, content_brief=content_brief)
        await self._emit_artifact_sections(ctx, events, publish, artifact_result.artifact, parallel=True)
        governance = await self._review_artifact(ctx, events, publish, artifact=artifact_result.artifact, evidence=merged_evidence)
        return WorkflowExecutionResult(evidence=merged_evidence, artifact=artifact_result.artifact, governance_report=governance.report)

    async def _run_hybrid(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher) -> WorkflowExecutionResult:
        merged_evidence = await self._load_latest_evidence(ctx.evidence_repo, ctx.request.thread_id) if ctx.resume_answers else None
        branch_ids = ["research-web", "research-docs"]
        replay_research_merge = not (ctx.resume_from_post_research_hitl and merged_evidence is not None)
        if merged_evidence is None:
            branch_jobs = [
                asyncio.create_task(self._research_branch(ctx, events, publish, branch_kind="web")),
                asyncio.create_task(self._research_branch(ctx, events, publish, branch_kind="docs")),
            ]

            results: list[BranchResult] = []
            for task in asyncio.as_completed(branch_jobs):
                results.append(await task)

            if any(result.error_message for result in results):
                raise RuntimeError("; ".join(result.error_message for result in results if result.error_message))

            merged_evidence = self._merge_evidence(*(result.evidence for result in results if result.evidence is not None))
            branch_ids = [result.branch_id for result in results]
        if replay_research_merge:
            await publish(
                events.build(
                    "fanin_started",
                    agent_name="strategist",
                    phase="fanin",
                    data={"branches": branch_ids},
                )
            )
            await publish(events.build("fanin_completed", agent_name="strategist", phase="fanin", data={"evidence_pack": merged_evidence.model_dump()}))
            await self._emit_evidence_signals(publish, events, merged_evidence)

        blocked = await self._maybe_block_for_requirements(
            ctx,
            events,
            publish,
            evidence=merged_evidence,
            stages={RequirementStage.before_render, RequirementStage.evidence_informed},
            pending_node="hitl_evidence",
        )
        if blocked is not None:
            return blocked

        content_brief = await self._run_content_director(ctx, events, publish, evidence=merged_evidence)
        artifact_result = await self._generate_artifact(ctx, events, publish, evidence=merged_evidence, content_brief=content_brief)
        await self._emit_artifact_sections(ctx, events, publish, artifact_result.artifact, parallel=True)
        governance = await self._review_artifact(ctx, events, publish, artifact=artifact_result.artifact, evidence=merged_evidence)
        return WorkflowExecutionResult(evidence=merged_evidence, artifact=artifact_result.artifact, governance_report=governance.report)

    async def _research_branch(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher, branch_kind: str) -> BranchResult:
        branch_id = f"research-{branch_kind}"
        await self._set_branch(
            ctx,
            branch_id=branch_id,
            agent_name="research",
            branch_kind=branch_kind,
            status="running",
            current_phase="research",
            input_json={"query": ctx.request.user_query, "scope": branch_kind},
        )
        result = BranchResult(branch_id=branch_id)
        if isinstance(ctx.session, AsyncSession):
            branch_session_cm = ctx.session_factory()
        else:
            branch_session_cm = _PassthroughAsyncContext(ctx.session)

        async with branch_session_cm as branch_session:
            branch_agent_run_repo = AgentRunRepository(branch_session)
            async with ctx.persistence_lock:
                agent_run = await branch_agent_run_repo.create_run(
                    thread_id=ctx.request.thread_id,
                    tenant_id=ctx.request.tenant_id,
                    agent_name="research",
                    agent_type=AgentType.research.value,
                    branch_id=branch_id,
                    input_json={"query": ctx.request.user_query, "scope": branch_kind},
                )
            try:
                await publish(
                    events.build(
                        "parallel_branch_started",
                        agent_name="research",
                        phase="research",
                        data={"branch": branch_id, "branch_kind": branch_kind},
                    )
                )
                scope = "web" if branch_kind == "web" else "docs"
                self._maybe_set_log_sink(self.registry.research, _make_agent_log_sink(events, publish, "research", "research"))
                evidence = await self.registry.research.gather(branch_session, ctx.request.tenant_id, ctx.request.user_query, scope)
                result.evidence = evidence
                await publish(
                    events.build(
                        "parallel_branch_completed",
                        agent_name="research",
                        phase="research",
                        data={"branch": branch_id, "branch_kind": branch_kind, "evidence_pack": evidence.model_dump()},
                    )
                )
                async with ctx.persistence_lock:
                    await branch_agent_run_repo.mark_complete(agent_run.run_id, evidence.model_dump())
                await self._complete_branch(ctx, branch_id=branch_id, output_json=evidence.model_dump())
                return result
            except Exception as exc:
                result.error_message = str(exc)
                async with ctx.persistence_lock:
                    await branch_agent_run_repo.mark_failed(agent_run.run_id, str(exc))
                await self._fail_branch(ctx, branch_id=branch_id, error_message=str(exc))
                return result

    @dataclass
    class _ArtifactOutcome:
        artifact: VisualArtifact

    @dataclass
    class _GovernanceOutcome:
        report: dict[str, Any]

    async def _generate_artifact(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher, evidence: EvidencePack, content_brief: dict[str, Any] | None = None) -> _ArtifactOutcome:
        branch_id = "artifact"
        await self._set_branch(
            ctx,
            branch_id=branch_id,
            agent_name="vangogh",
            branch_kind="artifact",
            status="running",
            current_phase="artifact",
            input_json={"user_query": ctx.request.user_query, "evidence_summary": evidence.summary},
        )
        agent_run = await ctx.agent_run_repo.create_run(
            thread_id=ctx.request.thread_id,
            tenant_id=ctx.request.tenant_id,
            agent_name="vangogh",
            agent_type=AgentType.vangogh.value,
            branch_id=branch_id,
            input_json={"user_query": ctx.request.user_query, "evidence_summary": evidence.summary},
        )

        await publish(events.build("artifact_started", agent_name="vangogh", phase="artifact", data={"branch": branch_id}))
        self.registry.mark_agent_busy("vangogh", "artifact")
        self._maybe_set_log_sink(self.registry.vangogh, _make_agent_log_sink(events, publish, "vangogh", "artifact"))
        artifact = await self.registry.vangogh.generate(ctx.request.user_query, evidence, content_brief=content_brief)
        self.registry.mark_agent_ready("vangogh", "idle")
        await publish(
            events.build(
                "artifact_ready",
                agent_name="vangogh",
                phase="artifact",
                data={"artifact_manifest": artifact.model_dump(exclude={"html", "css"})},
            )
        )
        await ctx.agent_run_repo.mark_complete(agent_run.run_id, artifact.model_dump())
        await self._complete_branch(ctx, branch_id=branch_id, output_json=artifact.model_dump())
        return WorkflowEngine._ArtifactOutcome(artifact=artifact)

    async def _emit_artifact_sections(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher, artifact: VisualArtifact, parallel: bool) -> None:
        if not artifact.sections:
            return

        if parallel:
            tasks = [
                asyncio.create_task(self._section_branch(ctx, events, publish, section, emit_parallel_events=True))
                for section in artifact.sections
            ]
            results = [await task for task in asyncio.as_completed(tasks)]
        else:
            results = []
            for section in artifact.sections:
                results.append(await self._section_branch(ctx, events, publish, section, emit_parallel_events=False))

        if any(result.error_message for result in results):
            raise RuntimeError("; ".join(result.error_message for result in results if result.error_message))

    async def _section_branch(
        self,
        ctx: WorkflowRunContext,
        events: EventFactory,
        publish: EventPublisher,
        section: ArtifactSection,
        *,
        emit_parallel_events: bool,
    ) -> BranchResult:
        branch_id = f"artifact-section-{section.section_id}"
        await self._set_branch(
            ctx,
            branch_id=branch_id,
            agent_name="vangogh",
            branch_kind="artifact-section",
            status="running",
            current_phase="artifact",
            input_json=section.model_dump(),
        )
        branch = BranchResult(branch_id=branch_id, section=section)
        try:
            if emit_parallel_events:
                await publish(
                    events.build(
                        "parallel_branch_started",
                        agent_name="vangogh",
                        phase="artifact",
                        data={"branch": branch_id, "section_id": section.section_id},
                    )
                )
            await publish(
                events.build(
                    "artifact_section_ready",
                    agent_name="vangogh",
                    phase="artifact",
                    data={
                        "section_id": section.section_id,
                        "section_index": section.section_index,
                        "title": section.title,
                        "summary": section.summary,
                        "html_fragment": section.html_fragment,
                        "section_data": section.section_data,
                    },
                )
            )
            if emit_parallel_events:
                await publish(
                    events.build(
                        "parallel_branch_completed",
                        agent_name="vangogh",
                        phase="artifact",
                        data={"branch": branch_id, "section_id": section.section_id},
                    )
                )
            await self._complete_branch(ctx, branch_id=branch_id, output_json=section.model_dump())
            return branch
        except Exception as exc:
            branch.error_message = str(exc)
            await self._fail_branch(ctx, branch_id=branch_id, error_message=str(exc))
            return branch

    async def _review_artifact(self, ctx: WorkflowRunContext, events: EventFactory, publish: EventPublisher, artifact: VisualArtifact, evidence: EvidencePack) -> _GovernanceOutcome:
        branch_id = "governance"
        await self._set_branch(
            ctx,
            branch_id=branch_id,
            agent_name="governance",
            branch_kind="governance",
            status="running",
            current_phase="governance",
            input_json={"artifact_id": artifact.artifact_id, "evidence_refs": artifact.evidence_refs},
        )
        agent_run = await ctx.agent_run_repo.create_run(
            thread_id=ctx.request.thread_id,
            tenant_id=ctx.request.tenant_id,
            agent_name="governance",
            agent_type=AgentType.governance.value,
            branch_id=branch_id,
            input_json={"artifact_id": artifact.artifact_id, "evidence_refs": artifact.evidence_refs},
        )
        await publish(events.build("governance_started", agent_name="governance", phase="governance"))
        self._maybe_set_log_sink(self.registry.governance, _make_agent_log_sink(events, publish, "governance", "governance"))
        report = (await self.registry.governance.review(artifact, evidence)).model_dump()
        await publish(events.build("governance_complete", agent_name="governance", phase="governance", data={"governance_report": report}))
        await ctx.agent_run_repo.mark_complete(agent_run.run_id, report)
        await self._complete_branch(ctx, branch_id=branch_id, output_json=report)
        return WorkflowEngine._GovernanceOutcome(report=report)

    def _merge_evidence(self, *evidences: EvidencePack) -> EvidencePack:
        cleaned = [e for e in evidences if e is not None]
        if not cleaned:
            return EvidencePack(summary="No evidence gathered.", confidence=0.0)

        source_by_id: dict[str, SourceRecord] = {}
        citations_by_id: dict[str, Citation] = {}
        web_findings_by_id: dict[str, EvidenceFinding] = {}
        doc_findings_by_id: dict[str, EvidenceFinding] = {}
        open_questions: list[str] = []
        summary_parts: list[str] = []
        confidence = 0.0

        for evidence in cleaned:
            if evidence.summary:
                summary_parts.append(evidence.summary)
            for source in evidence.sources:
                source_by_id[source.source_id] = source
            for finding in evidence.web_findings:
                web_findings_by_id[finding.finding_id] = finding
            for finding in evidence.doc_findings:
                doc_findings_by_id[finding.finding_id] = finding
            for question in evidence.open_questions:
                if question not in open_questions:
                    open_questions.append(question)
            for citation in evidence.citations:
                citations_by_id[citation.source_id] = citation
            confidence = max(confidence, evidence.confidence)

        return EvidencePack(
            summary=" ".join(summary_parts).strip() or "Merged evidence pack.",
            sources=list(source_by_id.values()),
            web_findings=list(web_findings_by_id.values()),
            doc_findings=list(doc_findings_by_id.values()),
            open_questions=open_questions,
            confidence=confidence,
            citations=list(citations_by_id.values()),
        )

    async def _set_branch(
        self,
        ctx: WorkflowRunContext,
        *,
        branch_id: str,
        agent_name: str,
        branch_kind: str,
        status: str,
        current_phase: str | None,
        input_json: dict[str, Any] | None = None,
    ) -> None:
        state = BranchRedisState(
            thread_id=ctx.request.thread_id,
            run_id=ctx.run_id,
            branch_id=branch_id,
            agent_name=agent_name,
            branch_kind=branch_kind,
            status=status,
            current_phase=current_phase,
            input_json=json.dumps(input_json or {}, default=str),
        )
        await ctx.state_store.set_branch_state(state)
        workflow_state = await ctx.state_store.get_workflow_state(ctx.request.thread_id)
        if workflow_state is not None:
            if branch_id not in workflow_state.branch_ids:
                workflow_state.branch_ids.append(branch_id)
            workflow_state.current_node = branch_id
            workflow_state.current_agent = agent_name
            workflow_state.current_phase = current_phase
            await ctx.state_store.set_workflow_state(workflow_state)

    async def _complete_branch(self, ctx: WorkflowRunContext, *, branch_id: str, output_json: dict[str, Any]) -> None:
        current = await ctx.state_store.get_branch_state(ctx.request.thread_id, branch_id)
        if current is None:
            return
        current.status = "complete"
        current.output_json = json.dumps(output_json, default=str)
        current.finished_at = utc_now()
        current.updated_at = utc_now()
        await ctx.state_store.set_branch_state(current)

    async def _fail_branch(self, ctx: WorkflowRunContext, *, branch_id: str, error_message: str) -> None:
        current = await ctx.state_store.get_branch_state(ctx.request.thread_id, branch_id)
        if current is None:
            return
        current.status = "error"
        current.error_message = error_message
        current.finished_at = utc_now()
        current.updated_at = utc_now()
        await ctx.state_store.set_branch_state(current)


def utc_now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


class _PassthroughAsyncContext:
    def __init__(self, value: Any) -> None:
        self.value = value

    async def __aenter__(self) -> Any:
        return self.value

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False
