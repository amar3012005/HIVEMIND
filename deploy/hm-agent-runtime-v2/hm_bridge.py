# -*- coding: utf-8 -*-
"""hm-core bridge — WorkRun → session mapping and event forwarding.

The Agent Service owns sessions; hm-core owns WorkRuns. Neither learns the
other's vocabulary:

    hm-core                          Agent Service
    -------                          -------------
    WorkRun (unit of work)    <-->   session (one run of an employee)
    employee definition       <-->   agent record
    org-scoped provider key   <-->   credential record
    event bus / SSE           <--    GET /sessions/{id}/stream

This module is the only place that knows both. It does two things:

1. **Mapping.** Persists `workrun_id -> (agent_id, session_id, workspace_id)` in
   the runtime's own Redis, so a WorkRun can be resumed, and so an inbound
   hm-core call can find the session it refers to. hm-core stores the session id
   on its side too; this table is the reverse index.

2. **Forwarding.** Tails a session's SSE stream and POSTs each event to hm-core's
   inbound sink, mirroring `POST /internal/hyper/turn-event`
   (`core/src/routes/hyper-rooms.js`). hm-core validates the execution identity
   and fans the event out to its own SSE subscribers.

Why a tailer and not a webhook: AgentScope publishes events to its message bus
and exposes them only over SSE. The stream replays buffered history to a late
joiner, so a forwarder that starts after the run began still sees every event —
which is what makes this safe to start lazily.

Configuration:

    HM_CORE_URL              base URL of hm-core (required to forward)
    HM_CORE_EVENT_PATH       default /internal/hyper/turn-event
    HIVEMIND_MASTER_API_KEY  shared secret (same as hm_auth)
    HM_FORWARD_ENABLED       "1" to enable forwarding (default off)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

_log = logging.getLogger("hm-agent-runtime.bridge")

HM_CORE_URL = os.getenv("HM_CORE_URL", "").strip().rstrip("/")
HM_CORE_EVENT_PATH = os.getenv(
    "HM_CORE_EVENT_PATH",
    "/internal/hyper/turn-event",
).strip()
FORWARD_ENABLED = os.getenv("HM_FORWARD_ENABLED", "0") == "1"

# The execution-identity contract hm-core validates on the inbound sink. A
# mismatch is a 409 there, so it must be built exactly as hm-core expects.
EXECUTION_CONTRACT = "work-room-execution.v1"

_FORWARD_TIMEOUT = float(os.getenv("HM_FORWARD_TIMEOUT", "10"))
# Events that carry no information for hm-core and would just be noise.
_SKIP_EVENT_TYPES = {"CUSTOM"}


@dataclass
class WorkRunBinding:
    """The reverse index entry: one WorkRun's runtime coordinates.

    `turn_id` and `room_id` are hm-core's ids, not ours. They are required
    because hm-core's inbound sink validates the execution identity against the
    persisted `HyperTurn` row:

        identity.execution_id == turn.id
        identity.turn_id     == turn.id
        identity.room_id     == turn.roomId
        identity.org_id      == turn.room.orgId
        identity.user_id     == turn.room.userId
        turn.room.roomMode   == 'work'

    A WorkRun maps to one **HyperTurn** (one user turn = one Director run), not
    to a HyperRoom. Getting this wrong is a 409 at hm-core, not a silent drop.
    """

    workrun_id: str
    user_id: str
    org_id: Optional[str]
    agent_id: str
    session_id: str
    # hm-core ids — required for the identity contract.
    turn_id: str = ""
    room_id: str = ""
    workspace_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(
            {
                "workrun_id": self.workrun_id,
                "user_id": self.user_id,
                "org_id": self.org_id,
                "agent_id": self.agent_id,
                "session_id": self.session_id,
                "turn_id": self.turn_id,
                "room_id": self.room_id,
                "workspace_id": self.workspace_id,
                "created_at": self.created_at,
            },
        )

    @classmethod
    def from_json(cls, raw: str) -> "WorkRunBinding":
        d = json.loads(raw)
        return cls(
            workrun_id=d["workrun_id"],
            user_id=d["user_id"],
            org_id=d.get("org_id"),
            agent_id=d["agent_id"],
            session_id=d["session_id"],
            turn_id=d.get("turn_id", ""),
            room_id=d.get("room_id", ""),
            workspace_id=d.get("workspace_id"),
            created_at=d.get("created_at", time.time()),
        )


class WorkRunStore:
    """Redis-backed `workrun_id -> binding` index.

    Uses the runtime's own Redis (the same one AgentScope uses) — this is
    runtime state, not hm-core state, and keeping it here means the runtime can
    be reset without touching hm-core.
    """

    _PREFIX = "hm:workrun:"

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def put(self, binding: WorkRunBinding) -> None:
        await self._redis.set(
            f"{self._PREFIX}{binding.workrun_id}",
            binding.to_json(),
        )

    async def get(self, workrun_id: str) -> Optional[WorkRunBinding]:
        raw = await self._redis.get(f"{self._PREFIX}{workrun_id}")
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return WorkRunBinding.from_json(raw)

    async def delete(self, workrun_id: str) -> None:
        await self._redis.delete(f"{self._PREFIX}{workrun_id}")


def build_execution_identity(
    *,
    binding: WorkRunBinding,
) -> dict[str, Any]:
    """The identity block hm-core's inbound sink validates.

    Mirrors `buildWorkRoomExecutionIdentity()` in
    `core/src/contracts/hyper-seams.js` exactly. hm-core re-derives every field
    from the persisted `HyperTurn` row and answers **409** on any mismatch, so
    these must be hm-core's ids — not the WorkRun id.

    `execution_id == turn_id`: one turn owns one Director run and every event,
    work order, verification and repair it produces.
    """
    return {
        "contract": EXECUTION_CONTRACT,
        "execution_id": binding.turn_id,
        "room_id": binding.room_id,
        "turn_id": binding.turn_id,
        "user_id": binding.user_id,
        "org_id": binding.org_id or "",
        "epoch": 1,
    }


class EventForwarder:
    """Tails a session's SSE stream and forwards events to hm-core.

    One forwarder per active WorkRun. It is idempotent to start: the SSE stream
    replays buffered history, so a restart re-sends events rather than losing
    them. hm-core dedupes on `event.id`.
    """

    def __init__(
        self,
        *,
        binding: WorkRunBinding,
        master_key: str,
        base_url: str = HM_CORE_URL,
        event_path: str = HM_CORE_EVENT_PATH,
    ) -> None:
        self._binding = binding
        self._master_key = master_key
        self._base_url = base_url.rstrip("/")
        self._url = f"{self._base_url}{event_path}"
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()
        self._forwarded = 0
        self._failed = 0

    @property
    def stats(self) -> dict[str, int]:
        return {"forwarded": self._forwarded, "failed": self._failed}

    def start(self, stream_url: str, user_id: str) -> None:
        """Begin tailing. `stream_url` is the Agent Service SSE endpoint."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(
            self._run(stream_url, user_id),
            name=f"forwarder:{self._binding.workrun_id}",
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self, stream_url: str, user_id: str) -> None:
        headers = {
            "Accept": "text/event-stream",
            # The runtime's own auth: internal key + resolved principal.
            "X-API-Key": self._master_key,
            "X-HM-User-Id": user_id,
        }
        if self._binding.org_id:
            headers["X-HM-Org-Id"] = self._binding.org_id

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", stream_url, headers=headers) as resp:
                    if resp.status_code != 200:
                        _log.warning(
                            "forwarder %s: stream returned %s",
                            self._binding.workrun_id,
                            resp.status_code,
                        )
                        return
                    async for line in resp.aiter_lines():
                        if self._stop.is_set():
                            break
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            event = json.loads(payload)
                        except ValueError:
                            continue
                        await self._forward(client, event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a forwarder must never crash the service
            _log.warning("forwarder %s ended: %s", self._binding.workrun_id, exc)

    async def _forward(self, client: httpx.AsyncClient, event: dict[str, Any]) -> None:
        if event.get("type") in _SKIP_EVENT_TYPES:
            return

        # Two sinks, deliberately:
        #
        #   1. /internal/workruns/{id}/event — the WorkRun progress log. hm-core
        #      normalizes the AgentScope event into its own small vocabulary, so
        #      neither side learns the other's event names. This is the durable
        #      seam: it survives a browser close and is what a reconnecting UI
        #      re-attaches to.
        #
        #   2. /internal/hyper/turn-event — the existing room feed. The room UI
        #      already renders this vocabulary, so a WorkRun is visible in the
        #      room it belongs to without the UI needing a second renderer.
        #
        # Both are real surfaces, not a fallback: the WorkRun log is the run's
        # own record, the turn feed is the room's. Dropping either would lose
        # information the other does not carry.
        await self._forward_workrun(client, event)
        await self._forward_turn(client, event)

    async def _forward_workrun(self, client: httpx.AsyncClient, event: dict[str, Any]) -> None:
        """Post one event to the WorkRun sink.

        hm-core normalizes it; this side sends the raw AgentScope event and does
        not pre-translate, so the vocabulary lives in exactly one place.
        """
        body: dict[str, Any] = {"event": event}

        # A terminal reply ends the run. hm-core needs the completion signal
        # explicitly because the event vocabulary models progress, not outcome —
        # the result payload has no home in an event.
        if event.get("type") == "REPLY_END":
            # AgentScope's ReplyFinishedReason is exactly: completed |
            # interrupted | exceed_max_iters | error. Only `completed` is a
            # clean finish — the others mean the run stopped without finishing,
            # so they must close the WorkRun as failed rather than as done.
            reason = event.get("finished_reason") or event.get("reason") or "completed"
            failed = reason != "completed"
            body["complete"] = True
            body["result"] = {
                "finished_reason": reason,
                "session_id": self._binding.session_id,
            }
            if failed:
                body["error"] = event.get("error") or f"agent run ended: {reason}"

        try:
            resp = await client.post(
                f"{self._base_url}/internal/workruns/{self._binding.workrun_id}/event",
                json=body,
                headers={
                    "X-API-Key": self._master_key,
                    "Content-Type": "application/json",
                },
                timeout=_FORWARD_TIMEOUT,
            )
            if resp.status_code >= 400:
                self._failed += 1
                _log.warning(
                    "forwarder %s: workrun sink returned %s for %s",
                    self._binding.workrun_id,
                    resp.status_code,
                    event.get("type"),
                )
            else:
                self._forwarded += 1
        except httpx.HTTPError as exc:
            self._failed += 1
            _log.warning("forwarder %s: workrun post failed: %s", self._binding.workrun_id, exc)

    async def _forward_turn(self, client: httpx.AsyncClient, event: dict[str, Any]) -> None:
        """Post one event to the existing room turn feed.

        hm-core's sink requires a TOP-LEVEL `turn_id` (hyper-rooms.js:114) —
        without it the request is a 400, not a 409. The identity block alone is
        not enough.
        """
        body = {
            "turn_id": self._binding.turn_id,
            "execution_identity": build_execution_identity(binding=self._binding),
            "event": event,
        }
        try:
            resp = await client.post(
                self._url,
                json=body,
                headers={
                    "X-API-Key": self._master_key,
                    "Content-Type": "application/json",
                },
                timeout=_FORWARD_TIMEOUT,
            )
            if resp.status_code >= 400:
                # Not counted as a forwarder failure: the room feed is a
                # secondary surface, and a room that has been archived must not
                # make the run look broken.
                _log.warning(
                    "forwarder %s: turn feed returned %s for %s",
                    self._binding.workrun_id,
                    resp.status_code,
                    event.get("type"),
                )
        except httpx.HTTPError as exc:
            _log.warning("forwarder %s: turn post failed: %s", self._binding.workrun_id, exc)


def describe() -> str:
    if not FORWARD_ENABLED:
        return "forwarding=off"
    if not HM_CORE_URL:
        return "forwarding=ON but HM_CORE_URL is UNSET (will not forward)"
    return (
        f"forwarding=ON -> {HM_CORE_URL}{HM_CORE_EVENT_PATH} "
        f"+ {HM_CORE_URL}/internal/workruns/<id>/event"
    )
