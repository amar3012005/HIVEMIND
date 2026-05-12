"""EmployeeWorker — adapter over an AgentScope ReActAgent.

Each Digital Employee participates in a team task as one ReActAgent. The
adapter holds metadata we use for reviewer selection + Slack streaming
(role_archetype, peer_review_targets, display name) which AgentScope
itself does not need but the TeamRoom does.

The underlying agent owns its own memory + tools + ReAct loop. We feed
it a phase instruction Msg per turn; AgentScope routes peer messages
into the same memory automatically via MsgHub.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from agentscope.agent import AgentBase
from agentscope.message import Msg

log = logging.getLogger(__name__)


@dataclass
class WorkerMessage:
    """Lightweight transcript record kept alongside MsgHub for streaming +
    persistence. AgentScope already owns the canonical Msg objects; this
    is the dehydrated view we ship to Slack cards / SSE consumers / DB."""
    msg_id: str
    sender_id: str
    sender_name: str
    sender_role: Optional[str]
    content: str
    round_num: int
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    kind: str = "chat"  # chat | claim | review | revision | synthesis | system
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "msg_id": self.msg_id,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "sender_role": self.sender_role,
            "content": self.content,
            "kind": self.kind,
            "round_num": self.round_num,
            "ts": self.ts,
            "metadata": self.metadata,
        }


class EmployeeWorker:
    """One Digital Employee, wrapping one ReActAgent for a team task."""

    def __init__(
        self,
        employee_id: str,
        employee_name: str,
        slug: str,
        role_archetype: str,
        peer_review_targets: Optional[List[str]],
        agent: AgentBase,
    ):
        self.employee_id = employee_id
        self.employee_name = employee_name
        self.slug = slug
        self.role_archetype = role_archetype or "generalist"
        self.peer_review_targets = peer_review_targets or []
        self.agent = agent

    # ── Identity helpers ─────────────────────────────────────────
    @property
    def display(self) -> str:
        return f"{self.employee_name} <{self.role_archetype}>"

    def can_challenge(self, other_role: str) -> bool:
        """Used by TeamRoom to bias reviewer selection."""
        if not self.peer_review_targets:
            return False
        normalized = (other_role or "").replace("_", "-").lower()
        targets = {t.replace("_", "-").lower() for t in self.peer_review_targets}
        return normalized in targets

    # ── Core respond loop ────────────────────────────────────────
    async def respond(self, instruction: str, *, round_num: int) -> str:
        """Send a phase instruction Msg into the wrapped agent.

        When this worker is inside an `agentscope.pipeline.MsgHub`
        context, peer agents will already have observed prior messages
        — so the ReActAgent's memory contains the full team transcript
        without us managing it.
        """
        prompt = Msg(
            name="TeamRoom",
            content=instruction,
            role="user",
            metadata={"phase_round": round_num, "addressed_to": self.slug},
        )
        try:
            reply: Msg = await self.agent(prompt)
        except Exception as exc:
            log.exception("worker %s reply failed: %s", self.slug, exc)
            return f"(internal error from {self.employee_name}: {exc})"

        # Msg.content can be a string or a list of content blocks; reduce
        # to plain text so downstream parsers (claim/verdict regex) work.
        content = reply.content if reply is not None else ""
        if isinstance(content, list):
            text_parts = []
            for blk in content:
                if isinstance(blk, dict):
                    text_parts.append(blk.get("text") or "")
                else:
                    text_parts.append(str(blk))
            content = "\n".join(p for p in text_parts if p)
        return (content or "").strip()
