"""Postgres-backed persistence for TeamTask + transcript.

Wraps `asyncpg` so the orchestration layer can:
  - open() a task row when TeamRoom starts (status='running')
  - record() every WorkerMessage as TeamRoom publishes it
  - close() with the final TeamOutcome (status='completed' | 'failed')

The store is best-effort: if Postgres is unreachable the orchestration
layer continues in-memory and logs a warning. TeamRoom does not depend
on persistence to drive the phase machine — this is a side-channel for
audit, replay, and frontend live-stream consumers.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from ..db import init_pool
from .team_room import TeamOutcome, TeamTask
from .worker import WorkerMessage

log = logging.getLogger(__name__)


class TaskStore:
    """Persistence adapter for one TeamRoom run."""

    def __init__(self, org_id: str, team_id: Optional[str] = None):
        if not org_id:
            raise ValueError("TaskStore requires org_id")
        self.org_id = org_id
        self.team_id = team_id

    # ── Lifecycle ────────────────────────────────────────────────
    async def open(self, task: TeamTask, roster_employee_ids: List[str]) -> None:
        """Insert the team_tasks row. Idempotent on task.task_id (UUID)."""
        pool = await init_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO hivemind.team_tasks (
                    id, org_id, team_id, brief, requested_by,
                    slack_channel, slack_thread_ts, roster_employee_ids,
                    status, max_rounds, started_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], 'running', $9, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    brief = EXCLUDED.brief,
                    started_at = COALESCE(hivemind.team_tasks.started_at, NOW())
                """,
                task.task_id,
                self.org_id,
                self.team_id,
                task.brief,
                task.requested_by,
                task.channel,
                task.thread_ts,
                roster_employee_ids,
                task.max_rounds,
            )
        log.info("task_store: opened task=%s roster_size=%d", task.task_id, len(roster_employee_ids))

    async def record(self, task_id: str, msg: WorkerMessage) -> None:
        """Insert one transcript line. Safe to call concurrently."""
        pool = await init_pool()
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO hivemind.team_task_messages (
                        id, task_id, sender_id, sender_name, sender_role,
                        kind, round_num, content, metadata, ts
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                    """,
                    msg.msg_id,
                    task_id,
                    msg.sender_id,
                    msg.sender_name,
                    msg.sender_role,
                    msg.kind,
                    msg.round_num,
                    msg.content,
                    json.dumps(msg.metadata or {}),
                    _parse_ts(msg.ts),
                )
        except Exception as exc:
            # Persistence must never break the live phase machine.
            log.warning("task_store record failed (task=%s msg=%s): %s", task_id, msg.msg_id, exc)

    async def close(self, outcome: TeamOutcome, status: str = "completed") -> None:
        """Stamp the task row with final outcome counters + answer."""
        pool = await init_pool()
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE hivemind.team_tasks SET
                        status = $2,
                        rounds_completed = $3,
                        gate_reason = $4,
                        final_answer = $5,
                        claim_count = $6,
                        review_count = $7,
                        revision_count = $8,
                        contradictions = $9,
                        completed_at = NOW()
                    WHERE id = $1
                    """,
                    outcome.task_id,
                    status,
                    outcome.rounds_completed,
                    outcome.gate_reason,
                    outcome.final_answer,
                    outcome.claim_count,
                    outcome.review_count,
                    outcome.revision_count,
                    outcome.contradictions,
                )
        except Exception as exc:
            log.warning("task_store close failed (task=%s): %s", outcome.task_id, exc)

    async def fail(self, task_id: str, error: str) -> None:
        pool = await init_pool()
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE hivemind.team_tasks SET
                        status = 'failed',
                        error = $2,
                        completed_at = NOW()
                    WHERE id = $1
                    """,
                    task_id, error[:5000],
                )
        except Exception as exc:
            log.warning("task_store fail update failed: %s", exc)


def _parse_ts(iso: Optional[str]) -> datetime:
    if not iso:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
