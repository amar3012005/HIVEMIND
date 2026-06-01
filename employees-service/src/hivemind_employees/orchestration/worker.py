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

from ..hivemind_client import HivemindClient

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


@dataclass
class WorkerTurn:
    text: str
    actions: List[Dict[str, Any]] = field(default_factory=list)
    tokens: int = 0


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
        api_key: Optional[str] = None,
        enabled_tools: Optional[List[str]] = None,
        use_simulation_actions: bool = False,
        slack_team_id: Optional[str] = None,
    ):
        self.employee_id = employee_id
        self.employee_name = employee_name
        self.slug = slug
        self.role_archetype = role_archetype or "generalist"
        self.peer_review_targets = peer_review_targets or []
        self.agent = agent
        self.api_key = api_key
        self.enabled_tools = enabled_tools or []
        self.use_simulation_actions = use_simulation_actions
        self.slack_team_id = slack_team_id
        self.task_brief: str = ""

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

    def bind_task(self, brief: str) -> None:
        self.task_brief = brief or ""

    # ── Core respond loop ────────────────────────────────────────
    async def respond(
        self,
        instruction: str,
        *,
        round_num: int,
        phase: Optional[str] = None,
        target_message: Optional[WorkerMessage] = None,
    ) -> WorkerTurn:
        """Send a phase instruction Msg into the wrapped agent.

        When this worker is inside an `agentscope.pipeline.MsgHub`
        context, peer agents will already have observed prior messages
        — so the ReActAgent's memory contains the full team transcript
        without us managing it.
        """
        actions, observation = await self._prepare_simulation_actions(
            phase=phase,
            target_message=target_message,
        )
        if observation:
            instruction = f"{instruction}\n\nSIMULATION ACTION OBSERVATIONS\n------------------------------\n{observation}"

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
            return WorkerTurn(text=f"(internal error from {self.employee_name}: {exc})", actions=actions)

        # Extract token usage from the reply Msg BEFORE text conversion;
        # usage may live on reply.usage or reply.metadata.usage.
        tokens = self._extract_tokens(reply)

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
        text = (content or "").strip()
        actions.extend(await self._postprocess_simulation_actions(phase=phase, reply_text=text, target_message=target_message))
        return WorkerTurn(text=text, actions=actions, tokens=tokens)

    @staticmethod
    def _extract_tokens(reply: Optional[Msg]) -> int:
        """Pull total token count off a reply Msg's usage block, if present.
        Checks reply.usage then reply.metadata.usage; tolerates dicts/objects."""
        if reply is None:
            return 0
        usage = getattr(reply, "usage", None)
        if usage is None:
            meta = getattr(reply, "metadata", None)
            if isinstance(meta, dict):
                usage = meta.get("usage")
            elif meta is not None:
                usage = getattr(meta, "usage", None)
        if usage is None:
            return 0

        def _get(obj: Any, key: str) -> Any:
            if isinstance(obj, dict):
                return obj.get(key)
            return getattr(obj, key, None)

        for key in ("total_tokens", "total"):
            val = _get(usage, key)
            if val:
                try:
                    return int(val)
                except (TypeError, ValueError):
                    pass
        total = 0
        for key in ("input_tokens", "prompt_tokens", "output_tokens", "completion_tokens"):
            val = _get(usage, key)
            if val:
                try:
                    total += int(val)
                except (TypeError, ValueError):
                    pass
        return total

    async def _prepare_simulation_actions(
        self,
        *,
        phase: Optional[str],
        target_message: Optional[WorkerMessage],
    ) -> tuple[List[Dict[str, Any]], str]:
        if not self.use_simulation_actions or not self.api_key:
            return [], ""

        actions: List[Dict[str, Any]] = []
        observations: List[str] = []
        client = HivemindClient(self.api_key)
        try:
            if phase == "investigate" and "hivemind_recall" in self.enabled_tools and self.task_brief:
                recall = await client.recall(self.task_brief, max_memories=3)
                memories = recall.get("memories") or recall.get("results") or []
                summary = self._summarize_memories(memories)
                actions.append({"label": "read_memory", "content": f"Reviewed workspace memory for: {self.task_brief}", "metadata": {"tool": "hivemind_recall", "memory_count": len(memories)}})
                if summary:
                    observations.append(f"Memory recall summary: {summary}")

            if phase == "investigate" and "hivemind_slack_search" in self.enabled_tools:
                simulated_query = self.task_brief or "current workspace discussion"
                actions.append({"label": "search_context", "content": f"Searched shared conversation context for '{simulated_query[:120]}'", "metadata": {"tool": "simulation_search", "query": simulated_query}})
                observations.append(f"Context search focused on: {simulated_query[:140]}")

            if phase == "investigate" and "hivemind_slack_history" in self.enabled_tools and target_message is None:
                actions.append({"label": "read_history", "content": "Read the active workspace transcript before responding.", "metadata": {"tool": "simulation_history"}})

        finally:
            await client.aclose()
        return actions, "\n".join(observations)

    async def _postprocess_simulation_actions(
        self,
        *,
        phase: Optional[str],
        reply_text: str,
        target_message: Optional[WorkerMessage],
    ) -> List[Dict[str, Any]]:
        if not self.use_simulation_actions:
            return []

        actions: List[Dict[str, Any]] = []
        if phase == "review" and "hivemind_slack_react" in self.enabled_tools and target_message is not None:
            lower = reply_text.lower()
            emoji = "eyes"
            if "verdict: supports" in lower:
                emoji = "thumbsup"
            elif "verdict: contradicts" in lower:
                emoji = "warning"
            actions.append({"label": "react", "content": f"Reacted to {target_message.sender_name}'s message with :{emoji}:.", "metadata": {"tool": "simulation_react", "emoji": emoji, "target_message_id": target_message.msg_id}})

        if phase == "synthesize" and "hivemind_slack_post" in self.enabled_tools:
            actions.append({"label": "post_update", "content": "Posted the team recommendation into the shared workspace summary thread.", "metadata": {"tool": "simulation_post"}})

        if phase == "synthesize" and "hivemind_save_memory" in self.enabled_tools and self.api_key and reply_text:
            client = HivemindClient(self.api_key)
            try:
                await client.save_memory(
                    title=f"Team task summary: {self.task_brief[:80]}",
                    content=reply_text[:4000],
                    tags=["digital-employees", "team-task", self.slug],
                )
                actions.append({"label": "write_memory", "content": "Saved the final synthesis back into workspace memory.", "metadata": {"tool": "hivemind_save_memory"}})
            except Exception as exc:
                actions.append({"label": "write_memory_failed", "content": f"Memory save failed: {exc}", "metadata": {"tool": "hivemind_save_memory", "error": str(exc)}})
            finally:
                await client.aclose()

        return actions

    def _summarize_memories(self, memories: List[Dict[str, Any]]) -> str:
        lines: List[str] = []
        for memory in memories[:3]:
            title = memory.get("title") or memory.get("summary") or "Untitled memory"
            snippet = memory.get("content") or memory.get("text") or ""
            snippet = str(snippet).replace("\n", " ").strip()
            if len(snippet) > 140:
                snippet = snippet[:137] + "..."
            lines.append(f"- {title}: {snippet}" if snippet else f"- {title}")
        return "\n".join(lines)
