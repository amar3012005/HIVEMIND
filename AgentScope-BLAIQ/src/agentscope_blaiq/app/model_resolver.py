from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from typing import Any


@dataclass(frozen=True)
class ModelRoute:
    raw: str
    provider: str
    model: str


@dataclass(frozen=True)
class LiteLLMConfig:
    strategic_model: str
    research_model: str
    vangogh_model: str
    governance_model: str
    api_base_url: str | None
    pre_model: str | None
    post_model: str | None
    planner_model: str | None
    reformat_model: str | None
    fallback_model: str | None
    timeout_seconds: int
    max_output_tokens: int | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_route(model_name: str) -> ModelRoute:
    if "/" not in model_name:
        return ModelRoute(raw=model_name, provider="openai", model=model_name)
    provider, model = model_name.split("/", 1)
    return ModelRoute(raw=model_name, provider=provider, model=model)


def current_litellm_config() -> LiteLLMConfig:
    return LiteLLMConfig(
        strategic_model=os.getenv("STRATEGIC_MODEL", os.getenv("LITELLM_STRATEGIST_MODEL", "gpt-4o-mini")),
        research_model=os.getenv("RESEARCH_MODEL", os.getenv("LITELLM_PRE_MODEL", "gpt-4o-mini")),
        vangogh_model=os.getenv("VANGOGH_MODEL", os.getenv("LITELLM_POST_MODEL", "gpt-4o-mini")),
        governance_model=os.getenv("GOVERNANCE_MODEL", os.getenv("LITELLM_REFORMAT_MODEL", "gpt-4o-mini")),
        api_base_url=os.getenv("LITELLM_API_BASE_URL", os.getenv("OPENAI_API_BASE_URL")),
        pre_model=os.getenv("LITELLM_PRE_MODEL"),
        post_model=os.getenv("LITELLM_POST_MODEL"),
        planner_model=os.getenv("LITELLM_PLANNER_MODEL"),
        reformat_model=os.getenv("LITELLM_REFORMAT_MODEL"),
        fallback_model=os.getenv("OPENAI_FALLBACK_MODEL"),
        timeout_seconds=int(os.getenv("LITELLM_TIMEOUT_SECONDS", os.getenv("LLM_TIMEOUT_SECONDS", "25"))),
        max_output_tokens=(
            int(os.getenv("LITELLM_MAX_OUTPUT_TOKENS"))
            if os.getenv("LITELLM_MAX_OUTPUT_TOKENS")
            else int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "1200"))
        ),
    )
