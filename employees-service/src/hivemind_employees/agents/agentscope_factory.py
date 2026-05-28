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
GROQ_BASE = "https://api.groq.com/openai/v1"


def _resolve_openai_compatible_target(
    provider: str,
    model: str,
    llm_api_key: Optional[str] = None,
) -> tuple[str, str, str]:
    openrouter_key = llm_api_key or os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        routed_model = model
        if provider == "anthropic" and "/" not in model:
            routed_model = f"anthropic/{model}"
        elif provider == "groq" and "/" not in model:
            routed_model = f"groq/{model}"
        base_url = os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_BASE)
        return routed_model, openrouter_key, base_url

    groq_key = llm_api_key or os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY", "")
    groq_model = model
    # Groq-hosted Llama-3.x models emit Llama-tag <function=NAME{...}> format
    # under strict-mode tool validation → tool_use_failed (400). Force a
    # tool-call-reliable model (openai/gpt-oss-120b by default, overridable
    # via GROQ_INFERENCE_MODEL). Applies whenever we fall back to Groq AND
    # the requested model is a known-broken Llama family.
    fallback_default = os.environ.get("GROQ_INFERENCE_MODEL") or "openai/gpt-oss-120b"
    if provider != "groq" or "/" in model:
        groq_model = fallback_default
    elif "llama-3" in model.lower() or "llama3" in model.lower():
        log.info("Swapping Groq tool-unreliable model %s -> %s", model, fallback_default)
        groq_model = fallback_default
    base_url = os.environ.get("GROQ_BASE_URL", GROQ_BASE)
    return groq_model, groq_key, base_url


def _uses_groq_fallback(provider: str) -> bool:
    normalized = (provider or "").lower()
    if normalized in {"openai", "anthropic_direct"}:
        return False
    return not os.environ.get("OPENROUTER_API_KEY") and bool(
        os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY")
    )


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

    # OpenAI-compatible providers can route through OpenRouter when present,
    # otherwise fall back to the same Groq endpoint used by Talk to HIVE.
    routed_model, api_key, base_url = _resolve_openai_compatible_target(
        provider,
        model,
        llm_api_key=llm_api_key,
    )
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


def build_react_agent(
    employee_row: dict,
    hivemind_api_key: str,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
) -> ReActAgent:
    """Construct an AgentScope ReActAgent for one DigitalEmployee.

    employee_row required keys:
      - id, name, slug, persona, model, llm_provider, tools (list[str]).

    The persona becomes the ReActAgent's `sys_prompt` so the ReAct loop
    stays in-character. Tools come from the same HIVEMIND endpoints as
    the slackagents path.
    """
    name = employee_row["slug"]  # unique per org
    persona = (
        (employee_row.get("active_prompt_version") or {}).get("system_prompt")
        or employee_row.get("persona")
        or ""
    )
    # Default fallback is wider than before — gives a fresh employee
    # the full HIVEMIND reach. Hyper-room agents override via merged_emp.
    requested_tools = employee_row.get("tools") or [
        "hivemind_recall",
        "hivemind_list_memories",
        "hivemind_get_memory",
        "hivemind_traverse_graph",
        "hivemind_query_with_ai",
        "hivemind_save_memory",
    ]
    enabled_tools = list(requested_tools)

    provider = employee_row.get("llm_provider") or "anthropic"
    # Tool calling works on Groq llama-3.3-70b + all OpenRouter providers
    # through the OpenAI-compatible chat completions API. Previously we
    # disabled tools whenever the runtime fell back to Groq — that left
    # swarm agents blind to HIVEMIND. Re-enable; if a specific model
    # turns out to be incompatible, set HYPER_DISABLE_GROQ_TOOLS=true.
    disable_groq_tools = os.environ.get("HYPER_DISABLE_GROQ_TOOLS", "").lower() == "true"
    toolkit = None
    if disable_groq_tools and _uses_groq_fallback(provider):
        enabled_tools = []
        log.info("HYPER_DISABLE_GROQ_TOOLS set; tools disabled for employee=%s", name)
    else:
        toolkit = build_hivemind_toolkit(
            api_key=hivemind_api_key,
            enabled_tool_names=enabled_tools,
            user_id=user_id,
            org_id=org_id,
        )

    model = _resolve_model(employee_row)
    formatter = _resolve_formatter(provider)

    agent = ReActAgent(
        name=name,
        sys_prompt=persona,
        model=model,
        formatter=formatter,
        toolkit=toolkit,
        memory=InMemoryMemory(),
        # Bumped from 10 -> 25. Hyper-room agents chain hivemind_recall +
        # graph traversal + occasional web search, plus the final
        # synthesis turn. Each tool round eats one iter.
        max_iters=25,
        # Sequential tool calls keep transcripts deterministic for
        # multi-agent reasoning. Parallel tool calls can be re-enabled
        # per-employee later if we want speedups for trusted roles.
        parallel_tool_calls=False,
        print_hint_msg=False,
    )
    setattr(agent, "hivemind_enabled_tools", list(requested_tools))
    setattr(agent, "hivemind_use_simulation_actions", _uses_groq_fallback(provider))
    log.info(
        "Built ReActAgent for employee=%s model=%s tools=%d",
        name, employee_row.get("model"), len(enabled_tools),
    )
    return agent
