"""Build a SlackAgents Assistant for one DigitalEmployee row.

Returns a configured Assistant ready to receive .chat() calls. The
caller is responsible for routing Slack events to the correct
employee's Assistant and posting the reply back via Slack action tool.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from slackagents import Assistant, OpenAILLM, BaseLLMConfig
from slackagents.llms.base import BaseLLM

from .tools import build_hivemind_tools

log = logging.getLogger(__name__)


# OpenRouter is OpenAI-compatible — lets us route to claude/haiku/etc.
# without needing a separate Anthropic adapter for SlackAgents.
OPENROUTER_BASE = "https://openrouter.ai/api/v1"


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

    # Default to OpenRouter for everything else (anthropic, groq, etc.)
    # OpenRouter prefixes: anthropic/claude-..., groq/llama-..., etc.
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
    cfg = BaseLLMConfig(
        model=routed_model,
        api_key=api_key,
        base_url=os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_BASE),
    )
    return OpenAILLM(cfg)


def build_assistant(employee_row: dict, hivemind_api_key: str) -> Assistant:
    """Construct an Assistant from a DigitalEmployee row.

    employee_row keys required:
      - id, name, slug, persona, model, llm_provider, tools (list[str])
    """
    name = employee_row["slug"]  # used as agent identifier — slug is unique
    desc = f"{employee_row['name']} — autonomous HIVEMIND agent"
    persona = employee_row["persona"]
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
        system_prompt=persona,
        llm=llm,
        max_steps=10,
        verbose=False,
    )

    log.info(
        "Built Assistant for employee=%s model=%s tools=%d",
        name, employee_row.get("model"), len(tools),
    )
    return assistant
