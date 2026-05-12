"""Builds an AgentScope ReActAgent for one DigitalEmployee row.

Used by `orchestration.TeamRoom` to spin up one agent per employee in a
collaborative task. Distinct from `factory.build_assistant()` which
returns a slackagents.Assistant — that path still drives the
single-employee Slack gateway flow.

Provider routing mirrors the slackagents factory:
  - 'openai' → AgentScope's OpenAIChatModel against api.openai.com
  - everything else → OpenAIChatModel against OpenRouter (Anthropic via
    OpenRouter prefix `anthropic/<model>`, Groq via `groq/<model>`, etc.).

This keeps a single OpenAI-compatible client for the multi-agent runner
while letting users keep their existing OpenRouter API keys.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from agentscope.agent import ReActAgent
from agentscope.formatter import (
    AnthropicChatFormatter,
    AnthropicMultiAgentFormatter,
    FormatterBase,
    OpenAIChatFormatter,
    OpenAIMultiAgentFormatter,
)
from agentscope.memory import InMemoryMemory
from agentscope.model import AnthropicChatModel, ChatModelBase, OpenAIChatModel

from .agentscope_tools import build_hivemind_toolkit

log = logging.getLogger(__name__)

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _resolve_model(employee_row: dict, llm_api_key: Optional[str] = None) -> ChatModelBase:
    """Map employee.llm_provider + employee.model → AgentScope chat model."""
    provider = (employee_row.get("llm_provider") or "anthropic").lower()
    model = employee_row.get("model") or "claude-haiku-4-5"

    if provider == "openai":
        api_key = llm_api_key or os.environ.get("OPENAI_API_KEY", "")
        return OpenAIChatModel(model_name=model, api_key=api_key, stream=False)

    if provider == "anthropic_direct":
        # Native Anthropic SDK path (skips OpenRouter). Only used when an
        # employee explicitly opts in — the default 'anthropic' path stays
        # on OpenRouter for billing parity with the rest of HIVEMIND.
        api_key = llm_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        return AnthropicChatModel(model_name=model, api_key=api_key, stream=False)

    # OpenRouter (anthropic, groq, etc.) via the OpenAI-compatible client.
    routed_model = model
    if provider == "anthropic" and "/" not in model:
        routed_model = f"anthropic/{model}"
    elif provider == "groq" and "/" not in model:
        routed_model = f"groq/{model}"

    api_key = (
        llm_api_key
        or os.environ.get("OPENROUTER_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY", "")
    )
    base_url = os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_BASE)
    return OpenAIChatModel(
        model_name=routed_model,
        api_key=api_key,
        stream=False,
        client_kwargs={"base_url": base_url},
    )


def _resolve_formatter(provider: str) -> FormatterBase:
    """Pick the multi-agent formatter matching the provider family.

    Multi-agent formatters preserve speaker identity in prompts (using
    name-tagged turns) instead of collapsing everything to a single
    user/assistant alternation. This is what makes the ReActAgent see
    peer replies as distinct voices when participating in MsgHub.
    """
    p = (provider or "").lower()
    if p == "anthropic_direct":
        return AnthropicMultiAgentFormatter()
    # OpenAIMultiAgentFormatter works for OpenAI direct AND OpenRouter
    # (OpenAI-compatible API surface).
    return OpenAIMultiAgentFormatter()


def build_react_agent(employee_row: dict, hivemind_api_key: str) -> ReActAgent:
    """Construct an AgentScope ReActAgent for one DigitalEmployee.

    employee_row required keys:
      - id, name, slug, persona, model, llm_provider, tools (list[str]).

    The persona becomes the ReActAgent's `sys_prompt` so the ReAct loop
    stays in-character. Tools come from the same HIVEMIND endpoints as
    the slackagents path.
    """
    name = employee_row["slug"]  # unique per org
    persona = employee_row.get("persona") or ""
    enabled_tools = employee_row.get("tools") or [
        "hivemind_recall",
        "hivemind_save_memory",
    ]

    toolkit = build_hivemind_toolkit(api_key=hivemind_api_key, enabled_tool_names=enabled_tools)
    model = _resolve_model(employee_row)
    formatter = _resolve_formatter(employee_row.get("llm_provider") or "anthropic")

    agent = ReActAgent(
        name=name,
        sys_prompt=persona,
        model=model,
        formatter=formatter,
        toolkit=toolkit,
        memory=InMemoryMemory(),
        max_iters=10,
        # Sequential tool calls keep transcripts deterministic for
        # multi-agent reasoning. Parallel tool calls can be re-enabled
        # per-employee later if we want speedups for trusted roles.
        parallel_tool_calls=False,
        print_hint_msg=False,
    )
    log.info(
        "Built ReActAgent for employee=%s model=%s tools=%d",
        name, employee_row.get("model"), len(enabled_tools),
    )
    return agent
