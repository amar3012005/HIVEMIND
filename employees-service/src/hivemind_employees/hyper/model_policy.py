"""Canonical model policy for HyperAgents inference."""
from __future__ import annotations

import re


HYPER_FAST_MODEL = "openai/gpt-oss-20b:nitro"
HYPER_PLANNER_MODEL = "google/gemini-2.5-flash-lite"
_LEGACY_FAST_MODELS = {"gpt-oss-20b", "openai/gpt-oss-20b"}
_LEGACY_GROK_RE = re.compile(r"^(?:x-ai/)?grok(?:[-/:].*)?$", re.IGNORECASE)


def canonical_hyper_model(model: str | None) -> str:
    """Collapse retired HyperAgent text models onto the governed fast tier."""
    value = str(model or "").strip()
    if not value or value.lower() in _LEGACY_FAST_MODELS or _LEGACY_GROK_RE.match(value):
        return HYPER_FAST_MODEL
    return value


def requires_openrouter(model: str | None) -> bool:
    """Nitro is an OpenRouter routing variant, never a direct-provider model."""
    return canonical_hyper_model(model).endswith(":nitro")
