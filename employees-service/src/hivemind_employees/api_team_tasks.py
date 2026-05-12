"""REST endpoints for kicking off + monitoring multi-employee team tasks.

Mounted on the FastAPI app in main.py. Authenticates via the master API
key (same model as /admin/reload), so callers are trusted upstream
services (HIVEMIND core, web UI proxy, Slack slash-command bridge).

Endpoints:
  POST /v1/team-tasks                — create + run a task (async)
  GET  /v1/team-tasks/:id            — status + outcome
  GET  /v1/team-tasks/:id/transcript — full transcript (paginated)

A POST returns immediately with task_id + status='running'; the actual
TeamRoom run happens in a background asyncio task. Callers poll the
status endpoint OR subscribe to SSE (next phase) for live updates.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .agents.agentscope_factory import build_react_agent
from .bootstrap_client import fetch_bootstrap
from .config import get_settings
from .db import init_pool, list_running_employees
from .orchestration import EmployeeWorker, TeamRoom, TeamTask, WorkerMessage
from .orchestration.slack_streamer import SlackStreamer
from .orchestration.task_store import TaskStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/team-tasks", tags=["team-tasks"])


# ── Request / response models ────────────────────────────────────
class CreateTeamTaskRequest(BaseModel):
    brief: str = Field(..., min_length=1, description="Task brief / question for the team")
    org_id: str = Field(..., description="UUID of the owning organization")
    team_id: Optional[str] = Field(None, description="Optional UUID of the team scope")
    requested_by: Optional[str] = Field(None, description="UUID of the requesting user")
    roster_slugs: List[str] = Field(..., min_length=1, description="Employee slugs to staff the room")
    max_rounds: int = Field(2, ge=1, le=6)
    # Optional Slack stream
    slack_channel: Optional[str] = None
    slack_thread_ts: Optional[str] = None
    slack_api_key: Optional[str] = Field(
        None, description="HIVEMIND API key with slack:act scope used for milestone cards"
    )


class CreateTeamTaskResponse(BaseModel):
    task_id: str
    status: str = "running"
    roster: List[str]


class TeamTaskStatus(BaseModel):
    task_id: str
    status: str
    rounds_completed: int
    claim_count: int
    review_count: int
    revision_count: int
    contradictions: int
    gate_reason: Optional[str]
    final_answer: Optional[str]
    error: Optional[str]


# ── Auth helper ──────────────────────────────────────────────────
def _require_master_key(token: Optional[str]) -> None:
    settings = get_settings()
    expected = settings.hivemind_master_api_key
    if not expected:
        raise HTTPException(503, "service not configured (master key missing)")
    if token != expected:
        raise HTTPException(401, "Invalid admin token")


# ── In-process registry of running tasks ─────────────────────────
# Keyed by task_id → asyncio.Task. Used by callers polling /v1/team-tasks/:id
# while the run is still in-flight; once the asyncio.Task finishes we
# rely on Postgres state for status reads.
_RUNNING: Dict[str, asyncio.Task] = {}


def _reap(task_id: str, _task: asyncio.Task) -> None:
    _RUNNING.pop(task_id, None)


# ── Background runner ────────────────────────────────────────────
async def _build_roster(slugs: List[str]) -> List[EmployeeWorker]:
    rows = await list_running_employees()
    boot = {b["id"]: b for b in await fetch_bootstrap()}
    by_slug = {r["slug"]: r for r in rows}
    roster: List[EmployeeWorker] = []
    for slug in slugs:
        emp = by_slug.get(slug)
        if not emp:
            log.warning("team-task: employee slug=%s not running — skip", slug)
            continue
        b = boot.get(emp["id"], {})
        api_key = b.get("api_key")
        if not api_key:
            log.warning("team-task: no bootstrap api_key for %s — skip", slug)
            continue
        agent = build_react_agent(emp, api_key)
        # Phase 3.3: role_archetype + peer_review_targets are first-class
        # columns. Fall back to legacy policy_rules JSONB for older rows
        # that predate the migration.
        policy = emp.get("policy_rules") or {}
        role_archetype = (
            emp.get("role_archetype")
            or policy.get("role_archetype")
            or "generalist"
        )
        peer_review_targets = (
            emp.get("peer_review_targets")
            or policy.get("peer_review_targets")
            or []
        )
        roster.append(EmployeeWorker(
            employee_id=emp["id"],
            employee_name=emp["name"],
            slug=slug,
            role_archetype=role_archetype,
            peer_review_targets=peer_review_targets,
            agent=agent,
        ))
    return roster


async def _run_task_background(
    task: TeamTask,
    req: CreateTeamTaskRequest,
) -> None:
    """Owns the TeamRoom run end-to-end. Persists, streams to Slack,
    swallows exceptions (logged + persisted as 'failed')."""
    store = TaskStore(org_id=req.org_id, team_id=req.team_id or None)
    try:
        roster = await _build_roster(req.roster_slugs)
        if not roster:
            await store.open(task, [])
            await store.fail(task.task_id, "no eligible employees in roster")
            return

        # Optional Slack streamer — uses the same /api/employees/slack-action
        # path the gateway already drives, so identity overrides flow.
        if req.slack_channel and req.slack_api_key:
            identity_lookup = {
                w.employee_id: {"name": w.employee_name}
                for w in roster
            }
            async with SlackStreamer(
                channel=req.slack_channel,
                thread_ts=req.slack_thread_ts or None,
                api_key=req.slack_api_key,
                identity_lookup=identity_lookup,
            ) as streamer:
                room = TeamRoom(
                    task=task,
                    roster=roster,
                    on_event=streamer.on_event,
                    task_store=store,
                )
                await room.run()
        else:
            room = TeamRoom(task=task, roster=roster, on_event=None, task_store=store)
            await room.run()
    except Exception as exc:
        log.exception("team-task %s failed: %s", task.task_id, exc)
        try:
            await store.fail(task.task_id, str(exc)[:5000])
        except Exception:
            pass


# ── Endpoints ────────────────────────────────────────────────────
@router.post("", response_model=CreateTeamTaskResponse)
async def create_team_task(
    req: CreateTeamTaskRequest,
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
) -> CreateTeamTaskResponse:
    _require_master_key(x_admin_token)

    task = TeamTask(
        task_id=str(uuid.uuid4()),
        brief=req.brief,
        requested_by=req.requested_by,
        channel=req.slack_channel,
        thread_ts=req.slack_thread_ts,
        max_rounds=req.max_rounds,
    )
    bg = asyncio.create_task(_run_task_background(task, req))
    _RUNNING[task.task_id] = bg
    bg.add_done_callback(lambda t: _reap(task.task_id, t))

    return CreateTeamTaskResponse(
        task_id=task.task_id,
        status="running",
        roster=req.roster_slugs,
    )


@router.get("/{task_id}", response_model=TeamTaskStatus)
async def get_team_task(
    task_id: str,
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
) -> TeamTaskStatus:
    _require_master_key(x_admin_token)
    pool = await init_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id::text, status, rounds_completed, claim_count, review_count,
                   revision_count, contradictions, gate_reason, final_answer, error
            FROM hivemind.team_tasks
            WHERE id = $1
            """,
            task_id,
        )
    if not row:
        raise HTTPException(404, "task not found")
    return TeamTaskStatus(
        task_id=row["id"],
        status=row["status"],
        rounds_completed=row["rounds_completed"] or 0,
        claim_count=row["claim_count"] or 0,
        review_count=row["review_count"] or 0,
        revision_count=row["revision_count"] or 0,
        contradictions=row["contradictions"] or 0,
        gate_reason=row["gate_reason"],
        final_answer=row["final_answer"],
        error=row["error"],
    )


@router.get("/{task_id}/transcript")
async def get_team_task_transcript(
    task_id: str,
    limit: int = 500,
    after_ts: Optional[str] = None,
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
) -> Dict[str, Any]:
    _require_master_key(x_admin_token)
    if limit < 1 or limit > 2000:
        raise HTTPException(400, "limit must be in [1, 2000]")
    pool = await init_pool()
    async with pool.acquire() as conn:
        if after_ts:
            rows = await conn.fetch(
                """
                SELECT id::text AS msg_id, sender_id, sender_name, sender_role,
                       kind, round_num, content, metadata, ts
                FROM hivemind.team_task_messages
                WHERE task_id = $1 AND ts > $2::timestamptz
                ORDER BY ts ASC
                LIMIT $3
                """,
                task_id, after_ts, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id::text AS msg_id, sender_id, sender_name, sender_role,
                       kind, round_num, content, metadata, ts
                FROM hivemind.team_task_messages
                WHERE task_id = $1
                ORDER BY ts ASC
                LIMIT $2
                """,
                task_id, limit,
            )
    return {
        "task_id": task_id,
        "count": len(rows),
        "messages": [
            {
                "msg_id": r["msg_id"],
                "sender_id": r["sender_id"],
                "sender_name": r["sender_name"],
                "sender_role": r["sender_role"],
                "kind": r["kind"],
                "round_num": r["round_num"],
                "content": r["content"],
                "metadata": r["metadata"] or {},
                "ts": r["ts"].isoformat() if r["ts"] else None,
            }
            for r in rows
        ],
    }
