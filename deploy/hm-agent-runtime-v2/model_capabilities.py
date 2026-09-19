# -*- coding: utf-8 -*-
"""Provider capability profiles.

The frontend never chooses AgentScope features. The runtime maps
(model id → profile) onto ContextConfig / tool assembly so DeepSeek cannot
receive a request that its API rejects (e.g. the manual compression tool).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from agentscope.agent import ContextConfig, ReActConfig


@dataclass(frozen=True)
class ModelProfile:
    tools: bool = True
    parallel_tools: bool = True
    structured_output: bool = True
    images: bool = False
    manual_compression_tool: bool = False
    max_iters: int = 50


PROFILES: Mapping[str, ModelProfile] = {
    "deepseek/deepseek-v4-flash": ModelProfile(manual_compression_tool=False, parallel_tools=False),
    "deepseek/deepseek-v4-flash-0731": ModelProfile(manual_compression_tool=False, parallel_tools=False),
    "deepseek/deepseek-v4-flash-0731:nitro": ModelProfile(manual_compression_tool=False, parallel_tools=False),
    "deepseek/deepseek-chat": ModelProfile(manual_compression_tool=False, parallel_tools=False),
    "openai/gpt-4o": ModelProfile(manual_compression_tool=True, images=True),
    "anthropic/claude-sonnet-4": ModelProfile(manual_compression_tool=True, images=True),
}

DEFAULT = ModelProfile(manual_compression_tool=False)


def profile_for(model: str | None) -> ModelProfile:
    key = str(model or "").strip()
    if key in PROFILES:
        return PROFILES[key]
    family = key.split("/")[0] if "/" in key else key
    for name, prof in PROFILES.items():
        if name.startswith(family + "/"):
            return prof
    return DEFAULT


def context_config_for(model: str | None) -> ContextConfig:
    prof = profile_for(model)
    return ContextConfig(compression_tool_enabled=bool(prof.manual_compression_tool))


def react_config_for(model: str | None) -> ReActConfig:
    prof = profile_for(model)
    return ReActConfig(max_iters=int(prof.max_iters))
