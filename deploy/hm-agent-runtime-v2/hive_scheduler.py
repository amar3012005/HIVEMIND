"""Native AgentScope scheduler adapter for governed HIVE Routines.

The timer, reconciliation, persistence and single-owner semantics remain in
AgentScope's ``SchedulerManager``. This subclass only changes what happens for
an explicitly marked HIVE routine record: its native timer fire is handed to
hm-core, which claims the fire and creates the governed WorkRun. Ordinary
AgentScope schedules continue through the untouched native trigger.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from agentscope.app._manager import SchedulerManager

import hm_auth
import hm_bridge

logger = logging.getLogger("hm-agent-runtime.hive-scheduler")


class HiveRoutineSchedulerManager(SchedulerManager):
    """Use AgentScope's timer and hand governed routine fires to hm-core."""

    def _build_trigger(self, record: Any):
        try:
            envelope = json.loads(record.data.description or "")
        except (TypeError, ValueError):
            envelope = None
        if not isinstance(envelope, dict) or envelope.get("kind") != "hive_routine_fire":
            return super()._build_trigger(record)

        async def _trigger() -> None:
            if not record.data.enabled:
                logger.info("[Routine:%s] skipped — disabled", envelope.get("routine_id"))
                return
            if not hm_bridge.HM_CORE_URL:
                logger.error("[Routine:%s] cannot fire: HM_CORE_URL is unset", envelope.get("routine_id"))
                return
            payload = {
                "routine_id": envelope.get("routine_id"),
                "scheduled_at": datetime.now(timezone.utc).isoformat(),
                "agent_id": record.agent_id,
                "user_id": record.user_id,
                "goal": envelope.get("goal"),
            }
            url = f"{hm_bridge.HM_CORE_URL}/internal/routines/{envelope.get('routine_id')}/fire"
            headers = {
                "X-API-Key": hm_auth._master_key(),
                "X-HM-User-Id": record.user_id,
                "Content-Type": "application/json",
            }
            timeout = float(os.getenv("HM_ROUTINE_FIRE_TIMEOUT_S", "30"))
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.post(url, headers=headers, json=payload)
                if response.status_code >= 400:
                    logger.error("[Routine:%s] hm-core fire rejected: HTTP %s", envelope.get("routine_id"), response.status_code)
                    return
                logger.info("[Routine:%s] handed native fire to hm-core", envelope.get("routine_id"))
            except Exception:  # noqa: BLE001 - scheduler must keep running
                logger.exception("[Routine:%s] hm-core fire failed", envelope.get("routine_id"))

        return _trigger


__all__ = ["HiveRoutineSchedulerManager"]

