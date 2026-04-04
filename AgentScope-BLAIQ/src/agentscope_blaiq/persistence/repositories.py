from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from agentscope_blaiq.contracts.artifact import VisualArtifact
from agentscope_blaiq.contracts.events import StreamEvent, WorkflowStatusSnapshot
from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.contracts.workflow import ResumeWorkflowRequest, SubmitWorkflowRequest, WorkflowMode, WorkflowStatus
from agentscope_blaiq.persistence.redis_state import BranchRedisState, RedisStateStore, WorkflowRedisState

from .models import AgentRunRecord, ArtifactRecord, EvidencePackRecord, UploadRecord, WorkflowEventRecord, WorkflowRecord


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WorkflowRepository:
    def __init__(self, session: AsyncSession, state_store: RedisStateStore | None = None) -> None:
        self.session = session
        self.state_store = state_store or RedisStateStore()

    def _load_state_payload(self, workflow: WorkflowRecord) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if workflow.workflow_state_json:
            try:
                raw_payload = json.loads(workflow.workflow_state_json)
                if isinstance(raw_payload, dict):
                    payload.update(raw_payload)
            except Exception:
                payload = {}
        if not payload:
            payload = {
                "schema_version": "v1",
                "thread_id": workflow.thread_id,
                "session_id": workflow.session_id,
                "tenant_id": workflow.tenant_id,
                "workflow_mode": workflow.workflow_mode,
                "user_query": workflow.user_query,
                "artifact_type": "visual_html",
                "source_scope": "web_and_docs",
            }
        return payload

    def _dump_state_payload(self, workflow: WorkflowRecord, payload: dict[str, Any]) -> str:
        payload = dict(payload)
        payload.setdefault("schema_version", "v1")
        payload.setdefault("thread_id", workflow.thread_id)
        payload.setdefault("session_id", workflow.session_id)
        payload.setdefault("tenant_id", workflow.tenant_id)
        payload.setdefault("workflow_mode", workflow.workflow_mode)
        payload.setdefault("user_query", workflow.user_query)
        payload.setdefault("artifact_type", "visual_html")
        payload.setdefault("source_scope", "web_and_docs")
        return json.dumps(
            payload,
            default=lambda value: value.value if hasattr(value, "value") else value.isoformat() if hasattr(value, "isoformat") else str(value),
        )

    async def get_workflow_record(self, thread_id: str) -> WorkflowRecord | None:
        return await self.session.get(WorkflowRecord, thread_id)

    async def create_workflow(self, request: SubmitWorkflowRequest, run_id: str | None = None, workflow_plan_json: str | None = None) -> WorkflowRecord:
        run_id = run_id or str(uuid4())
        state_payload = {
            "schema_version": request.schema_version,
            "thread_id": request.thread_id,
            "run_id": run_id,
            "session_id": request.session_id,
            "tenant_id": request.tenant_id,
            "workflow_mode": request.workflow_mode.value,
            "user_query": request.user_query,
            "artifact_type": request.artifact_type,
            "source_scope": request.source_scope,
            "status": WorkflowStatus.queued.value,
            "current_node": "planning",
            "current_phase": "planning",
            "current_agent": "strategist",
            "latest_event": "workflow_submitted",
            "error_message": None,
            "workflow_plan_json": workflow_plan_json,
        }
        record = WorkflowRecord(
            thread_id=request.thread_id,
            run_id=run_id,
            session_id=request.session_id,
            tenant_id=request.tenant_id,
            workflow_mode=request.workflow_mode.value,
            user_query=request.user_query,
            status=WorkflowStatus.queued.value,
            current_node="planning",
            current_phase="planning",
            workflow_plan_json=workflow_plan_json,
            workflow_state_json=json.dumps(
                state_payload
            ),
        )
        self.session.add(record)
        await self.session.commit()
        await self.session.refresh(record)
        return record

    async def append_event(self, event: StreamEvent) -> None:
        workflow = await self.session.get(WorkflowRecord, event.thread_id)
        if workflow is None:
            return
        state_payload = self._load_state_payload(workflow)
        workflow.run_id = event.run_id or workflow.run_id
        workflow.latest_event = event.type
        workflow.current_agent = event.agent_name
        workflow.current_node = event.data.get("branch") or event.data.get("section_id") or event.agent_name
        workflow.current_phase = event.phase
        if event.type == "workflow_resumed":
            workflow.status = WorkflowStatus.queued.value
        elif event.type not in {"workflow_complete", "workflow_error"}:
            workflow.status = WorkflowStatus.running.value
        if event.type == "workflow_complete":
            workflow.status = WorkflowStatus.complete.value
        if event.type == "workflow_error":
            workflow.status = WorkflowStatus.error.value
            workflow.error_message = event.data.get("error_message")
        state_payload.update(
            {
                "thread_id": event.thread_id,
                "session_id": event.session_id,
                "run_id": event.run_id,
                "tenant_id": event.tenant_id,
                "status": workflow.status,
                "current_node": workflow.current_node,
                "current_phase": workflow.current_phase,
                "current_agent": workflow.current_agent,
                "latest_event": workflow.latest_event,
                "error_message": workflow.error_message,
            }
        )
        workflow.workflow_state_json = self._dump_state_payload(workflow, state_payload)
        self.session.add(
            WorkflowEventRecord(
                run_id=event.run_id,
                thread_id=event.thread_id,
                sequence=event.sequence,
                event_type=event.type,
                agent_name=event.agent_name,
                payload_json=event.model_dump_json(),
            )
        )
        await self.session.commit()
        await self.state_store.append_workflow_event(event.thread_id, event.model_dump())

    async def set_final_artifact(self, thread_id: str, artifact: VisualArtifact) -> None:
        workflow = await self.session.get(WorkflowRecord, thread_id)
        if workflow is None:
            return
        workflow.final_artifact_json = artifact.model_dump_json()
        workflow.status = WorkflowStatus.complete.value
        workflow.current_node = "governance"
        workflow.current_phase = "governance"
        await self.session.commit()
        await self.state_store.mark_final_artifact(thread_id, artifact)

    async def update_workflow_snapshot(
        self,
        thread_id: str,
        *,
        run_id: str | None = None,
        status: WorkflowStatus | None = None,
        workflow_mode: WorkflowMode | None = None,
        current_node: str | None = None,
        current_phase: str | None = None,
        current_agent: str | None = None,
        latest_event: str | None = None,
        error_message: str | None = None,
        workflow_plan_json: str | None = None,
        final_artifact_json: str | None = None,
        artifact_family: str | None = None,
        blocked_question: str | None = None,
        expected_answer_schema: dict[str, Any] | None = None,
        requirements_checklist_json: str | None = None,
        task_graph_json: str | None = None,
        content_director_output_json: str | None = None,
        pending_node: str | None = None,
        resume_cursor: str | None = None,
        last_completed_node: str | None = None,
        resume_count: int | None = None,
        last_resume_reason: str | None = None,
    ) -> None:
        workflow = await self.session.get(WorkflowRecord, thread_id)
        if workflow is None:
            return
        state_payload = self._load_state_payload(workflow)
        if run_id is not None:
            workflow.run_id = run_id
        if status is not None:
            workflow.status = status.value
        if workflow_mode is not None:
            workflow.workflow_mode = workflow_mode.value
        if current_node is not None:
            workflow.current_node = current_node
        if current_phase is not None:
            workflow.current_phase = current_phase
        if current_agent is not None:
            workflow.current_agent = current_agent
        if latest_event is not None:
            workflow.latest_event = latest_event
        if error_message is not None:
            workflow.error_message = error_message
        if workflow_plan_json is not None:
            workflow.workflow_plan_json = workflow_plan_json
        if final_artifact_json is not None:
            workflow.final_artifact_json = final_artifact_json
        state_payload_updates = {
            "artifact_family": artifact_family,
            "blocked_question": blocked_question,
            "expected_answer_schema": expected_answer_schema,
            "requirements_checklist_json": requirements_checklist_json,
            "task_graph_json": task_graph_json,
            "content_director_output_json": content_director_output_json,
            "pending_node": pending_node,
            "resume_cursor": resume_cursor,
            "last_completed_node": last_completed_node,
            "resume_count": resume_count,
            "last_resume_reason": last_resume_reason,
        }
        for key, value in state_payload_updates.items():
            if value is not None:
                state_payload[key] = value
        state_payload.update(
            {
                "thread_id": workflow.thread_id,
                "run_id": workflow.run_id,
                "session_id": workflow.session_id,
                "tenant_id": workflow.tenant_id,
                "status": workflow.status,
                "workflow_mode": workflow.workflow_mode,
                "current_node": workflow.current_node,
                "current_phase": workflow.current_phase,
                "current_agent": workflow.current_agent,
                "latest_event": workflow.latest_event,
                "error_message": workflow.error_message,
                "workflow_plan_json": workflow.workflow_plan_json,
                "final_artifact_json": workflow.final_artifact_json,
            }
        )
        workflow.workflow_state_json = self._dump_state_payload(workflow, state_payload)
        await self.session.commit()

    async def build_submit_request(self, thread_id: str) -> SubmitWorkflowRequest | None:
        workflow = await self.get_workflow_record(thread_id)
        if workflow is None:
            return None
        payload = self._load_state_payload(workflow)
        payload.setdefault("schema_version", "v1")
        payload.setdefault("artifact_type", "visual_html")
        payload.setdefault("source_scope", "web_and_docs")
        payload.setdefault("workflow_mode", workflow.workflow_mode)
        payload.setdefault("thread_id", workflow.thread_id)
        payload.setdefault("session_id", workflow.session_id)
        payload.setdefault("tenant_id", workflow.tenant_id)
        payload.setdefault("user_query", workflow.user_query)
        return SubmitWorkflowRequest.model_validate(payload)

    async def get_status(self, thread_id: str) -> WorkflowStatusSnapshot | None:
        workflow = await self.session.get(WorkflowRecord, thread_id)
        if workflow is None:
            return None
        state_payload = self._load_state_payload(workflow)
        redis_state = await self.state_store.get_workflow_state(thread_id)
        if redis_state is not None:
            final_artifact = VisualArtifact.model_validate_json(redis_state.final_artifact_json) if redis_state.final_artifact_json else None
            requirements_checklist = None
            if redis_state.requirements_checklist_json:
                try:
                    from agentscope_blaiq.contracts.workflow import RequirementsChecklist
                    requirements_checklist = RequirementsChecklist.model_validate_json(redis_state.requirements_checklist_json).model_dump()
                except Exception:
                    requirements_checklist = None
            return WorkflowStatusSnapshot(
                thread_id=redis_state.thread_id,
                session_id=redis_state.session_id,
                run_id=redis_state.run_id,
                status=redis_state.status,
                current_node=redis_state.current_node,
                current_agent=redis_state.current_agent,
                latest_event=redis_state.recent_events[-1]["type"] if redis_state.recent_events else workflow.latest_event,
                final_artifact=final_artifact,
                error_message=redis_state.error_message,
                artifact_family=redis_state.artifact_family or state_payload.get("artifact_family"),
                blocked_question=redis_state.blocked_question,
                expected_answer_schema=redis_state.expected_answer_schema,
                requirements_checklist=requirements_checklist,
                pending_node=redis_state.pending_node or redis_state.current_node,
                resume_count=redis_state.resume_count,
                last_resume_reason=redis_state.last_resume_reason,
                updated_at=redis_state.updated_at,
            )
        final_artifact = VisualArtifact.model_validate_json(workflow.final_artifact_json) if workflow.final_artifact_json else None
        requirements_checklist = None
        if isinstance(state_payload.get("requirements_checklist_json"), str):
            try:
                from agentscope_blaiq.contracts.workflow import RequirementsChecklist
                requirements_checklist = RequirementsChecklist.model_validate_json(state_payload["requirements_checklist_json"]).model_dump()
            except Exception:
                requirements_checklist = None
        return WorkflowStatusSnapshot(
            thread_id=workflow.thread_id,
            session_id=workflow.session_id,
            run_id=workflow.run_id,
            status=WorkflowStatus(workflow.status),
            current_node=workflow.current_node,
            current_agent=workflow.current_agent,
            latest_event=workflow.latest_event,
            error_message=workflow.error_message,
            final_artifact=final_artifact,
            artifact_family=state_payload.get("artifact_family"),
            blocked_question=state_payload.get("blocked_question"),
            expected_answer_schema=state_payload.get("expected_answer_schema"),
            requirements_checklist=requirements_checklist,
            pending_node=state_payload.get("pending_node"),
            resume_count=int(state_payload.get("resume_count") or 0),
            last_resume_reason=state_payload.get("last_resume_reason"),
            updated_at=workflow.updated_at,
        )

    async def get_record(self, thread_id: str) -> WorkflowRecord | None:
        return await self.session.get(WorkflowRecord, thread_id)

    async def build_submit_request_from_record(
        self,
        record: WorkflowRecord,
        *,
        tenant_id: str | None = None,
    ) -> SubmitWorkflowRequest:
        payload = self._load_state_payload(record)
        payload.update(
            {
                "user_query": record.user_query,
                "workflow_mode": WorkflowMode(record.workflow_mode),
                "tenant_id": tenant_id or record.tenant_id,
                "session_id": record.session_id,
                "thread_id": record.thread_id,
                "artifact_type": payload.get("artifact_type", "visual_html"),
                "source_scope": payload.get("source_scope", "web_and_docs"),
            }
        )
        return SubmitWorkflowRequest.model_validate(payload)

    async def purge_thread_runtime(self, thread_id: str) -> None:
        workflow = await self.session.get(WorkflowRecord, thread_id)
        branch_ids: list[str] = []
        if workflow is not None:
            redis_state = await self.state_store.get_workflow_state(thread_id)
            if redis_state is not None:
                branch_ids = list(redis_state.branch_ids)
        await self.session.execute(delete(WorkflowEventRecord).where(WorkflowEventRecord.thread_id == thread_id))
        await self.session.execute(delete(AgentRunRecord).where(AgentRunRecord.thread_id == thread_id))
        await self.session.execute(delete(ArtifactRecord).where(ArtifactRecord.thread_id == thread_id))
        await self.session.execute(delete(EvidencePackRecord).where(EvidencePackRecord.thread_id == thread_id))
        await self.session.commit()
        await self.state_store.clear_workflow_bundle(thread_id, branch_ids)

    async def prepare_resume(self, request: ResumeWorkflowRequest) -> SubmitWorkflowRequest:
        record = await self.get_record(request.thread_id)
        if record is None:
            raise ValueError("workflow_not_found")
        if record.status not in {WorkflowStatus.blocked.value, WorkflowStatus.error.value}:
            raise ValueError("workflow_not_resumable")
        submit_request = await self.build_submit_request_from_record(record, tenant_id=request.tenant_id)
        await self.update_workflow_snapshot(
            request.thread_id,
            status=WorkflowStatus.queued,
            current_node="resume",
            current_phase="resume",
            current_agent="system",
            latest_event="workflow_resumed",
            error_message=None,
            pending_node="hitl",
            resume_cursor="hitl",
        )
        return submit_request


class ArtifactRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def save(self, thread_id: str, tenant_id: str, artifact: VisualArtifact, html_path: str, css_path: str) -> None:
        self.session.add(
            ArtifactRecord(
                artifact_id=artifact.artifact_id,
                thread_id=thread_id,
                tenant_id=tenant_id,
                artifact_type=artifact.artifact_type,
                title=artifact.title,
                html_path=html_path,
                css_path=css_path,
                artifact_json=artifact.model_dump_json(),
            )
        )
        await self.session.commit()

    async def get_by_thread(self, thread_id: str) -> VisualArtifact | None:
        result = await self.session.execute(
            select(ArtifactRecord).where(ArtifactRecord.thread_id == thread_id).order_by(ArtifactRecord.created_at.desc())
        )
        record = result.scalars().first()
        if record is None:
            return None
        return VisualArtifact.model_validate_json(record.artifact_json)

    async def get_record_by_thread(self, thread_id: str) -> ArtifactRecord | None:
        result = await self.session.execute(
            select(ArtifactRecord).where(ArtifactRecord.thread_id == thread_id).order_by(ArtifactRecord.created_at.desc())
        )
        return result.scalars().first()


class EvidenceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def save(self, thread_id: str, tenant_id: str, evidence_id: str, evidence: EvidencePack) -> None:
        self.session.add(
            EvidencePackRecord(
                evidence_id=evidence_id,
                thread_id=thread_id,
                tenant_id=tenant_id,
                evidence_json=evidence.model_dump_json(),
            )
        )
        await self.session.commit()

    async def list_for_thread(self, thread_id: str) -> list[EvidencePackRecord]:
        result = await self.session.execute(select(EvidencePackRecord).where(EvidencePackRecord.thread_id == thread_id))
        return list(result.scalars().all())


class UploadRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def save(self, upload_id: str, tenant_id: str, filename: str, storage_path: str, content_type: str | None, metadata: dict, thread_id: str | None = None) -> None:
        self.session.add(
            UploadRecord(
                upload_id=upload_id,
                tenant_id=tenant_id,
                filename=filename,
                storage_path=storage_path,
                content_type=content_type,
                metadata_json=json.dumps(metadata),
                thread_id=thread_id,
            )
        )
        await self.session.commit()

    async def list_for_tenant(self, tenant_id: str) -> list[UploadRecord]:
        result = await self.session.execute(select(UploadRecord).where(UploadRecord.tenant_id == tenant_id))
        return list(result.scalars().all())

    async def list_for_thread(self, thread_id: str) -> list[UploadRecord]:
        result = await self.session.execute(select(UploadRecord).where(UploadRecord.thread_id == thread_id))
        return list(result.scalars().all())

    async def get_by_upload_id(self, upload_id: str) -> UploadRecord | None:
        result = await self.session.execute(select(UploadRecord).where(UploadRecord.upload_id == upload_id))
        return result.scalar_one_or_none()


class AgentRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_run(
        self,
        *,
        thread_id: str,
        tenant_id: str,
        agent_name: str,
        agent_type: str,
        branch_id: str | None = None,
        input_json: dict | None = None,
    ) -> AgentRunRecord:
        run_id = str(uuid4())
        record = AgentRunRecord(
            run_id=run_id,
            thread_id=thread_id,
            tenant_id=tenant_id,
            agent_name=agent_name,
            agent_type=agent_type,
            branch_id=branch_id,
            status="running",
            input_json=json.dumps(input_json or {}),
        )
        self.session.add(record)
        await self.session.commit()
        await self.session.refresh(record)
        return record

    async def mark_complete(self, run_id: str, output_json: dict | None = None) -> None:
        record = await self.session.get(AgentRunRecord, run_id)
        if record is None:
            return
        record.status = "complete"
        record.output_json = json.dumps(output_json or {})
        record.finished_at = utc_now()
        await self.session.commit()

    async def mark_failed(self, run_id: str, error_message: str) -> None:
        record = await self.session.get(AgentRunRecord, run_id)
        if record is None:
            return
        record.status = "error"
        record.error_message = error_message
        record.finished_at = utc_now()
        await self.session.commit()

    async def list_for_thread(self, thread_id: str) -> list[AgentRunRecord]:
        result = await self.session.execute(select(AgentRunRecord).where(AgentRunRecord.thread_id == thread_id))
        return list(result.scalars().all())
