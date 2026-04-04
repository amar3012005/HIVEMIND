from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

try:  # pragma: no cover - optional dependency for local test environments
    from redis.asyncio import Redis
except Exception:  # pragma: no cover
    Redis = None  # type: ignore[assignment]

from agentscope_blaiq.contracts.artifact import VisualArtifact
from agentscope_blaiq.contracts.workflow import WorkflowMode, WorkflowStatus
from agentscope_blaiq.runtime.config import settings


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WorkflowRedisState(BaseModel):
    thread_id: str
    run_id: str | None = None
    tenant_id: str
    session_id: str
    workflow_mode: WorkflowMode
    artifact_type: str = "visual_html"
    source_scope: str = "web_and_docs"
    status: WorkflowStatus = WorkflowStatus.queued
    current_node: str | None = None
    current_phase: str | None = None
    current_agent: str | None = None
    user_query: str
    workflow_plan_json: str | None = None
    artifact_family: str | None = None
    blocked_question: str | None = None
    expected_answer_schema: dict[str, Any] | None = None
    requirements_checklist_json: str | None = None
    task_graph_json: str | None = None
    content_director_output_json: str | None = None
    pending_node: str | None = None
    resume_cursor: str | None = None
    last_completed_node: str | None = None
    branch_ids: list[str] = Field(default_factory=list)
    recent_events: list[dict[str, Any]] = Field(default_factory=list)
    final_artifact_json: str | None = None
    error_message: str | None = None
    resume_count: int = 0
    last_resume_reason: str | None = None
    last_resume_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utc_now)
    created_at: datetime = Field(default_factory=utc_now)


class BranchRedisState(BaseModel):
    thread_id: str
    run_id: str | None = None
    branch_id: str
    agent_name: str
    branch_kind: str
    status: str = "queued"
    current_phase: str | None = None
    input_json: str | None = None
    output_json: str | None = None
    error_message: str | None = None
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class RedisStateStore:
    def __init__(self) -> None:
        self.client = Redis.from_url(settings.redis_url, decode_responses=True) if Redis is not None else None
        self._memory_workflows: dict[str, str] = {}
        self._memory_branches: dict[str, str] = {}

    def workflow_key(self, thread_id: str) -> str:
        return f"agentscope-blaiq:workflow:{thread_id}"

    def branch_key(self, thread_id: str, branch_id: str) -> str:
        return f"agentscope-blaiq:workflow:{thread_id}:branch:{branch_id}"

    async def _set_raw(self, key: str, payload: str, ttl: int = 86400) -> None:
        if self.client is None:
            if key.startswith("agentscope-blaiq:workflow:") and ":branch:" in key:
                self._memory_branches[key] = payload
            else:
                self._memory_workflows[key] = payload
            return
        try:
            await self.client.set(key, payload, ex=ttl)
        except Exception:
            if key.startswith("agentscope-blaiq:workflow:") and ":branch:" in key:
                self._memory_branches[key] = payload
            else:
                self._memory_workflows[key] = payload

    async def _get_raw(self, key: str) -> str | None:
        if self.client is None:
            if key.startswith("agentscope-blaiq:workflow:") and ":branch:" in key:
                return self._memory_branches.get(key)
            return self._memory_workflows.get(key)
        try:
            raw = await self.client.get(key)
            if raw is not None:
                return raw
        except Exception:
            pass
        if key.startswith("agentscope-blaiq:workflow:") and ":branch:" in key:
            return self._memory_branches.get(key)
        return self._memory_workflows.get(key)

    async def set_workflow_state(self, state: WorkflowRedisState, ttl: int = 86400) -> None:
        state.updated_at = utc_now()
        await self._set_raw(self.workflow_key(state.thread_id), state.model_dump_json(), ttl=ttl)

    async def get_workflow_state(self, thread_id: str) -> WorkflowRedisState | None:
        raw = await self._get_raw(self.workflow_key(thread_id))
        if raw is None:
            return None
        return WorkflowRedisState.model_validate_json(raw)

    async def append_workflow_event(self, thread_id: str, event: dict[str, Any], limit: int = 50, ttl: int = 86400) -> WorkflowRedisState | None:
        state = await self.get_workflow_state(thread_id)
        if state is None:
            return None
        state.recent_events.append(event)
        state.recent_events = state.recent_events[-limit:]
        state.updated_at = utc_now()
        await self.set_workflow_state(state, ttl=ttl)
        return state

    async def set_branch_state(self, state: BranchRedisState, ttl: int = 86400) -> None:
        state.updated_at = utc_now()
        await self._set_raw(self.branch_key(state.thread_id, state.branch_id), state.model_dump_json(), ttl=ttl)

    async def get_branch_state(self, thread_id: str, branch_id: str) -> BranchRedisState | None:
        raw = await self._get_raw(self.branch_key(thread_id, branch_id))
        if raw is None:
            return None
        return BranchRedisState.model_validate_json(raw)

    async def mark_final_artifact(self, thread_id: str, artifact: VisualArtifact, ttl: int = 86400) -> WorkflowRedisState | None:
        state = await self.get_workflow_state(thread_id)
        if state is None:
            return None
        state.final_artifact_json = artifact.model_dump_json()
        state.status = WorkflowStatus.complete
        state.current_node = "governance"
        state.current_phase = "governance"
        state.current_agent = "governance"
        await self.set_workflow_state(state, ttl=ttl)
        return state

    async def mark_resumed(
        self,
        thread_id: str,
        *,
        run_id: str,
        resume_reason: str | None = None,
        ttl: int = 86400,
    ) -> WorkflowRedisState | None:
        state = await self.get_workflow_state(thread_id)
        if state is None:
            return None
        state.run_id = run_id
        state.status = WorkflowStatus.queued
        state.current_node = state.resume_cursor or state.pending_node or state.current_node or "planning"
        state.current_phase = "planning"
        state.current_agent = "strategist"
        state.error_message = None
        state.resume_count += 1
        state.last_resume_reason = resume_reason
        state.last_resume_at = utc_now()
        await self.set_workflow_state(state, ttl=ttl)
        return state

    async def mark_blocked(
        self,
        thread_id: str,
        error_message: str,
        *,
        blocked_question: str | None = None,
        expected_answer_schema: dict[str, Any] | None = None,
        pending_node: str | None = None,
        resume_cursor: str | None = None,
        last_completed_node: str | None = None,
        requirements_checklist_json: str | None = None,
        artifact_family: str | None = None,
        ttl: int = 86400,
    ) -> WorkflowRedisState | None:
        state = await self.get_workflow_state(thread_id)
        if state is None:
            return None
        state.status = WorkflowStatus.blocked
        state.error_message = error_message
        state.blocked_question = blocked_question or error_message
        state.expected_answer_schema = expected_answer_schema
        state.pending_node = pending_node or state.pending_node
        state.resume_cursor = resume_cursor or state.resume_cursor
        state.last_completed_node = last_completed_node or state.last_completed_node
        state.requirements_checklist_json = requirements_checklist_json or state.requirements_checklist_json
        state.artifact_family = artifact_family or state.artifact_family
        state.updated_at = utc_now()
        await self.set_workflow_state(state, ttl=ttl)
        return state

    async def mark_error(self, thread_id: str, error_message: str, ttl: int = 86400) -> WorkflowRedisState | None:
        state = await self.get_workflow_state(thread_id)
        if state is None:
            return None
        state.status = WorkflowStatus.error
        state.error_message = error_message
        await self.set_workflow_state(state, ttl=ttl)
        return state

    async def delete_workflow_state(self, thread_id: str) -> None:
        if self.client is None:
            self._memory_workflows.pop(self.workflow_key(thread_id), None)
            return
        try:
            await self.client.delete(self.workflow_key(thread_id))
        except Exception:
            self._memory_workflows.pop(self.workflow_key(thread_id), None)

    async def delete_branch_state(self, thread_id: str, branch_id: str) -> None:
        key = self.branch_key(thread_id, branch_id)
        if self.client is None:
            self._memory_branches.pop(key, None)
            return
        try:
            await self.client.delete(key)
        except Exception:
            self._memory_branches.pop(key, None)

    async def clear_workflow_bundle(self, thread_id: str, branch_ids: list[str] | None = None) -> None:
        for branch_id in branch_ids or []:
            await self.delete_branch_state(thread_id, branch_id)
        await self.delete_workflow_state(thread_id)
