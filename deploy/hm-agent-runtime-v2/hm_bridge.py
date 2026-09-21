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

2. **Forwarding.** Tails a session's SSE stream and POSTs each event to the
   WorkRun inbound sink. hm-core validates the run identity, keeps a durable
   normalized event log, and Rooms reattaches to the native session stream for
   the ordered, rich transcript.

Why a tailer and not a webhook: AgentScope publishes events to its message bus
and exposes them only over SSE. The stream replays buffered history to a late
joiner, so a forwarder that starts after the run began still sees every event;
event ids make that replay idempotent at both the bridge and Core boundaries.

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
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx

_log = logging.getLogger("hm-agent-runtime.bridge")

HM_CORE_URL = os.getenv("HM_CORE_URL", "").strip().rstrip("/")
HM_CORE_EVENT_PATH = os.getenv(
    "HM_CORE_EVENT_PATH",
    "/internal/hyper/turn-event",
).strip()
FORWARD_ENABLED = os.getenv("HM_FORWARD_ENABLED", "0") == "1"
MAX_REPLAY_EVENT_IDS = 4096

# The execution-identity contract hm-core validates on the inbound sink. A
# mismatch is a 409 there, so it must be built exactly as hm-core expects.
EXECUTION_CONTRACT = "work-room-execution.v1"

_FORWARD_TIMEOUT = float(os.getenv("HM_FORWARD_TIMEOUT", "10"))
# Custom events are normally local UI noise. AgentScope's StateChangeMiddleware
# is the exception: it publishes the authoritative native Task snapshot after a
# TaskCreate/TaskUpdate. Keep that one typed projection durable in hm-core.
_SKIP_EVENT_TYPES = set()


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
        on_confirmation: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    ) -> None:
        self._binding = binding
        self._master_key = master_key
        self._base_url = base_url.rstrip("/")
        self._url = f"{self._base_url}{event_path}"
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()
        self._forwarded = 0
        self._failed = 0
        self._on_confirmation = on_confirmation
        # AgentScope reconnects replay its buffered stream. Keep a bounded
        # local identity window to avoid needless Core posts during a live
        # forwarder's reconnect; Core applies the durable second line of
        # defence with the same event id.
        self._seen_event_ids: set[str] = set()
        self._seen_event_order: deque[str] = deque()

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
        # State snapshots and HIVE-owned artifact receipts are both durable
        # product events. Other custom messages are transient runtime noise.
        if event.get("type") == "CUSTOM" and event.get("name") not in {"state_updated", "artifact.created"}:
            return

        event_id = str(event.get("id") or "").strip()
        if event_id and event_id in self._seen_event_ids:
            return

        # WorkRuns execute inside their own AgentScope workspace/container.
        # Tool-permission prompts in that sandbox are runtime mechanics, not
        # HIVE authority grants. Resume them internally and keep them out of
        # the product event stream; external actions remain governed by hm-core.
        if event.get("type") == "REQUIRE_USER_CONFIRM" and self._on_confirmation is not None:
            await self._on_confirmation(event)
            self._remember_event_id(event_id)
            return

        # The WorkRun sink is deliberately the single durable projection seam.
        # It translates AgentScope events into HIVE's compact lifecycle log;
        # Rooms reads native session SSE and persisted session messages for the
        # richer ordered transcript. Sending every delta through a legacy room
        # turn feed would create a competing transcript and duplicate UI rows.
        if await self._forward_workrun(client, event):
            self._remember_event_id(event_id)

    def _remember_event_id(self, event_id: str) -> None:
        if not event_id or event_id in self._seen_event_ids:
            return
        self._seen_event_ids.add(event_id)
        self._seen_event_order.append(event_id)
        if len(self._seen_event_order) > MAX_REPLAY_EVENT_IDS:
            self._seen_event_ids.discard(self._seen_event_order.popleft())

    async def _forward_workrun(self, client: httpx.AsyncClient, event: dict[str, Any]) -> bool:
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
            # interrupted | exceed_max_iters | error.
            # A *successful* reply is one turn of a multi-turn WorkRun session,
            # not the end of the WorkRun. Closing here made follow-up POSTs
            # hit a terminal run (and dropped later events). Only fail/interrupt
            # the run when the agent actually stopped without finishing.
            reason = event.get("finished_reason") or event.get("reason") or "completed"
            failed = reason != "completed"
            if failed:
                body["complete"] = True
                body["result"] = {
                    "finished_reason": reason,
                    "session_id": self._binding.session_id,
                }
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
                return False
            else:
                self._forwarded += 1
                return True
        except httpx.HTTPError as exc:
            self._failed += 1
            _log.warning("forwarder %s: workrun post failed: %s", self._binding.workrun_id, exc)
            return False

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
