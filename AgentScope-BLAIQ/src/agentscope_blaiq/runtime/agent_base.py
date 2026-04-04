from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, TypeVar

from agentscope.agent import ReActAgent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.message import Msg, TextBlock
from agentscope.plan import PlanNotebook
from agentscope.tool import ToolResponse, Toolkit
from pydantic import BaseModel

from agentscope_blaiq.runtime.config import settings
from agentscope_blaiq.runtime.model_resolver import LiteLLMModelResolver

T = TypeVar("T", bound=BaseModel)

# Type alias for the event sink callback that agents use to stream live logs.
# The engine injects a concrete implementation bound to the SSE publish() closure.
AgentLogSink = Callable[[str, str, str, dict[str, Any] | None], Awaitable[None]]
# signature: (message: str, message_kind: str, visibility: str, detail: dict | None) -> None


async def _noop_sink(_msg: str, _kind: str, _vis: str, _detail: dict[str, Any] | None = None) -> None:
    """Default no-op sink when no event publisher is wired."""


class BaseAgent:
    """Shared AgentScope-backed runtime wrapper for BLAIQ specialist agents."""

    def __init__(
        self,
        *,
        name: str,
        role: str,
        sys_prompt: str,
        resolver: LiteLLMModelResolver | None = None,
        toolkit: Toolkit | None = None,
    ) -> None:
        self.name = name
        self.role = role
        self.sys_prompt = sys_prompt
        self.resolver = resolver or LiteLLMModelResolver.from_settings(settings)
        self._shared_toolkit = toolkit
        self._log_sink: AgentLogSink = _noop_sink

    def set_log_sink(self, sink: AgentLogSink) -> None:
        """Inject the live event sink. Called by the engine before each run."""
        self._log_sink = sink

    async def log(
        self,
        message: str,
        *,
        kind: str = "status",
        visibility: str = "user",
        detail: dict[str, Any] | None = None,
    ) -> None:
        """Emit a live agent_log event to the SSE stream.

        Args:
            message: Human-readable message for the frontend chat.
            kind: One of thought, tool_call, tool_result, status, decision, artifact, review.
            visibility: 'user' for frontend chat, 'debug' for operator console.
            detail: Optional structured payload.
        """
        await self._log_sink(message, kind, visibility, detail)

    def build_toolkit(self) -> Toolkit:
        return self._shared_toolkit or Toolkit()

    def _create_runtime_agent(self) -> ReActAgent:
        return ReActAgent(
            name=self.name,
            sys_prompt=self.sys_prompt,
            model=self.resolver.build_agentscope_model(self.role),
            formatter=OpenAIChatFormatter(),
            toolkit=self.build_toolkit(),
            memory=InMemoryMemory(),
            plan_notebook=PlanNotebook(),
            max_iters=6,
            parallel_tool_calls=True,
        )

    def make_msg(self, content: Any, role: str = "assistant", **metadata: Any) -> Msg:
        sender_name = "user" if role == "user" else self.name
        msg = Msg(sender_name, content, role, metadata=metadata or None)
        if metadata:
            msg.metadata = {**(msg.metadata or {}), **metadata}
        return msg

    async def reply(self, msg: Msg | str, *, extra_context: dict[str, Any] | None = None) -> Msg:
        agent = self._create_runtime_agent()
        user_text = msg.content if isinstance(msg, Msg) else str(msg)
        runtime_msg = self.make_msg(
            self._build_user_prompt(user_text, extra_context or {}),
            role="user",
            phase="request",
        )
        return await agent.reply(runtime_msg)

    async def complete_text(
        self,
        *,
        user_content: str,
        extra_context: dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        del temperature, max_tokens  # AgentScope model settings are role-scoped at construction time.
        agent = self._create_runtime_agent()
        response = await agent.reply(
            self.make_msg(
                self._build_user_prompt(user_content, extra_context or {}),
                role="user",
                phase="request",
            ),
        )
        return self._extract_msg_text(response)

    async def complete_json(
        self,
        model: type[T],
        *,
        user_content: str,
        extra_context: dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> T:
        del temperature, max_tokens
        agent = self._create_runtime_agent()
        response = await agent.reply(
            self.make_msg(
                self._build_user_prompt(user_content, extra_context or {}),
                role="user",
                phase="request",
            ),
            structured_model=model,
        )
        if response.metadata:
            return model.model_validate(response.metadata)
        payload = self.resolver.safe_json_loads(self._extract_msg_text(response))
        return model.model_validate(payload)

    def _build_user_prompt(self, user_content: str, extra_context: dict[str, Any]) -> str:
        if not extra_context:
            return user_content
        context_blob = json.dumps(extra_context, indent=2, sort_keys=True, default=str)
        return f"{user_content}\n\nContext:\n{context_blob}"

    @staticmethod
    def tool_response(payload: Any, *, metadata: dict[str, Any] | None = None) -> ToolResponse:
        text = json.dumps(payload, indent=2, sort_keys=True, default=str) if not isinstance(payload, str) else payload
        return ToolResponse(
            content=[TextBlock(type="text", text=text)],
            metadata=metadata or (payload if isinstance(payload, dict) else {"value": payload}),
        )

    @staticmethod
    def _extract_msg_text(msg: Msg) -> str:
        if isinstance(msg.content, str):
            return msg.content.strip()
        if isinstance(msg.content, list):
            text_parts: list[str] = []
            for block in msg.content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(str(block.get("text", "")))
                else:
                    text_parts.append(str(block))
            return "\n".join(part for part in text_parts if part).strip()
        return str(msg.content).strip()
