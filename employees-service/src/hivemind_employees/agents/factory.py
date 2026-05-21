"""Build a SlackAgents Assistant for one DigitalEmployee row.

Returns a configured Assistant ready to receive .chat() calls. The
caller is responsible for routing Slack events to the correct
employee's Assistant and posting the reply back via Slack action tool.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from slackagents.agent.assistant import Assistant
from slackagents.llms.base import BaseLLM
from slackagents.llms.base import BaseLLMConfig
from slackagents.llms.openai import OpenAILLM

from .tools import build_hivemind_tools

log = logging.getLogger(__name__)


# OpenRouter is OpenAI-compatible — lets us route to claude/haiku/etc.
# without needing a separate Anthropic adapter for SlackAgents.
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
    if provider != "groq" or "/" in model:
        groq_model = os.environ.get("GROQ_INFERENCE_MODEL") or "llama-3.3-70b-versatile"
    base_url = os.environ.get("GROQ_BASE_URL", GROQ_BASE)
    return groq_model, groq_key, base_url


def _resolve_llm(employee_row: dict, llm_api_key: Optional[str] = None) -> BaseLLM:
    """Map employee.llm_provider + employee.model → SlackAgents LLM.

    Strategy:
    - 'anthropic' / 'openrouter' / 'groq' → OpenRouter (OpenAI-compatible) so
      we can use Claude through the same OpenAI client SlackAgents ships with.
    - 'openai' → OpenAI direct.
    - Custom base_url overridable via OPENAI_BASE_URL env.
    """
    provider = (employee_row.get("llm_provider") or "anthropic").lower()
    model = employee_row.get("model") or "claude-haiku-4-5"

    if provider == "openai":
        api_key = llm_api_key or os.environ.get("OPENAI_API_KEY", "")
        return OpenAILLM(BaseLLMConfig(model=model, api_key=api_key))

    # Default to OpenRouter for everything else when configured, otherwise
    # use Groq's OpenAI-compatible endpoint with the shared inference model.
    routed_model, api_key, base_url = _resolve_openai_compatible_target(
        provider,
        model,
        llm_api_key=llm_api_key,
    )
    cfg = BaseLLMConfig(
        model=routed_model,
        api_key=api_key,
        openrouter_base_url=base_url,
    )
    return OpenAILLM(cfg)


def build_assistant(employee_row: dict, hivemind_api_key: str) -> Assistant:
    """Construct an Assistant from a DigitalEmployee row.

    employee_row keys required:
      - id, name, slug, persona, model, llm_provider, tools (list[str])
    """
    name = employee_row["slug"]  # used as agent identifier — slug is unique
    desc = f"{employee_row['name']} — autonomous HIVEMIND agent"
    active_prompt = (
        (employee_row.get("active_prompt_version") or {}).get("system_prompt")
        or employee_row.get("persona")
        or ""
    )
    enabled_tools = employee_row.get("tools") or []
    if not enabled_tools:
        # Sensible default if config is empty
        enabled_tools = [
            "hivemind_recall",
            "hivemind_save_memory",
            "hivemind_slack_post",
        ]

    tools = build_hivemind_tools(api_key=hivemind_api_key, enabled_tool_names=enabled_tools)
    llm = _resolve_llm(employee_row)

    assistant = Assistant(
        name=name,
        desc=desc,
        tools=tools,
        system_prompt=active_prompt,
        llm=llm,
        max_steps=10,
        verbose=False,
    )

    log.info(
        "Built Assistant for employee=%s model=%s tools=%d",
        name, employee_row.get("model"), len(tools),
    )
    return assistant
