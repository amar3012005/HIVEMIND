from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from agentscope_blaiq.runtime.config import Settings, settings

try:
    from agentscope.model import OpenAIChatModel
except ImportError:  # pragma: no cover
    OpenAIChatModel = None  # type: ignore[assignment]


@dataclass(frozen=True)
class ResolvedModel:
    role: str
    model_name: str
    provider: str
    api_key: str | None
    api_base: str | None
    timeout_seconds: int
    max_output_tokens: int
    temperature: float
    reasoning_effort: str | None = None
    fallback_model: str | None = None


class LiteLLMModelResolver:
    """Central LiteLLM routing policy for all AgentScope-BLAIQ agents."""

    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings

    @classmethod
    def from_settings(cls, runtime_settings: Settings | None = None) -> "LiteLLMModelResolver":
        return cls(runtime_settings=runtime_settings)

    def _provider_for_model(self, model_name: str) -> str:
        if model_name.startswith("groq/"):
            return "groq"
        if model_name.startswith(("openai/", "vertex_ai/", "aws-cris/", "gemini/", "anthropic/")):
            return "openai_compatible"
        return "openai_compatible"

    @staticmethod
    def _strip_provider_prefix(model_name: str) -> str:
        if "/" not in model_name:
            return model_name
        return model_name.split("/", 1)[1]

    def _prefer_litellm_proxy(self) -> bool:
        return bool(self.settings.litellm_api_base_url)

    def _build_resolved_model(
        self,
        *,
        role: str,
        model_name: str,
        temperature: float,
        fallback_model: str | None,
    ) -> ResolvedModel:
        provider = self._provider_for_model(model_name)
        if self._prefer_litellm_proxy():
            api_key = self.settings.litellm_api_key or self.settings.openai_api_key
            api_base = self.settings.litellm_api_base_url
        elif provider == "groq":
            api_key = self.settings.groq_api_key
            api_base = self.settings.groq_api_base_url
        else:
            api_key = self.settings.openai_api_key
            api_base = self.settings.openai_api_base_url

        return ResolvedModel(
            role=role,
            model_name=model_name,
            provider=provider,
            api_key=api_key,
            api_base=api_base,
            timeout_seconds=self.settings.llm_timeout_seconds,
            max_output_tokens=self.settings.llm_max_output_tokens,
            temperature=temperature,
            reasoning_effort=self.settings.model_reasoning_effort,
            fallback_model=fallback_model,
        )

    def resolve(self, role: str) -> ResolvedModel:
        role_key = role.lower()
        if role_key == "strategic":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.strategic_model,
                temperature=self.settings.strategic_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "research":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.research_model,
                temperature=self.settings.research_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "hitl":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.hitl_model,
                temperature=self.settings.hitl_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "content_director":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.content_director_model,
                temperature=self.settings.strategic_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "vangogh":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.vangogh_model,
                temperature=self.settings.vangogh_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "governance":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.governance_model,
                temperature=self.settings.governance_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        if role_key == "graph_knowledge":
            return self._build_resolved_model(
                role=role_key,
                model_name=self.settings.research_model,
                temperature=self.settings.research_temperature,
                fallback_model=self.settings.llm_fallback_model,
            )
        raise ValueError(f"Unknown model role: {role}")

    def resolve_model_name(
        self,
        model_name: str,
        *,
        role: str,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        fallback_model: str | None = None,
    ) -> ResolvedModel:
        resolved_role = role.lower()
        base = self.resolve(resolved_role)
        resolved = self._build_resolved_model(
            role=resolved_role,
            model_name=model_name,
            temperature=base.temperature if temperature is None else temperature,
            fallback_model=fallback_model,
        )
        if max_output_tokens is None:
            return resolved
        return ResolvedModel(
            role=resolved.role,
            model_name=resolved.model_name,
            provider=resolved.provider,
            api_key=resolved.api_key,
            api_base=resolved.api_base,
            timeout_seconds=resolved.timeout_seconds,
            max_output_tokens=max_output_tokens,
            temperature=resolved.temperature,
            reasoning_effort=resolved.reasoning_effort,
            fallback_model=resolved.fallback_model,
        )

    def build_agentscope_model(self, role: str) -> OpenAIChatModel:
        if OpenAIChatModel is None:  # pragma: no cover
            raise RuntimeError("agentscope is required to construct runtime models")

        resolved = self.resolve(role)
        client_kwargs: dict[str, Any] = {}
        if resolved.api_base:
            client_kwargs["base_url"] = resolved.api_base

        model_name = resolved.model_name if self._prefer_litellm_proxy() else self._strip_provider_prefix(resolved.model_name)
        return OpenAIChatModel(
            model_name=model_name,
            api_key=resolved.api_key,
            stream=False,
            reasoning_effort=resolved.reasoning_effort,  # type: ignore[arg-type]
            client_kwargs=client_kwargs or None,
            generate_kwargs={
                "temperature": resolved.temperature,
                "max_tokens": resolved.max_output_tokens,
                "timeout": resolved.timeout_seconds,
            },
        )

    async def acompletion(
        self,
        role: str,
        messages: list[dict[str, str]],
        *,
        stream: bool = False,
        response_format: dict[str, Any] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Any:
        resolved = self.resolve(role)
        try:
            from litellm import acompletion
        except ImportError as exc:  # pragma: no cover - dependency missing in shell
            raise RuntimeError("litellm is required to execute AgentScope-BLAIQ model calls") from exc

        kwargs: dict[str, Any] = {
            "model": resolved.model_name,
            "messages": messages,
            "api_key": resolved.api_key,
            "api_base": resolved.api_base,
            "timeout": resolved.timeout_seconds,
            "stream": stream,
            "temperature": resolved.temperature if temperature is None else temperature,
            "max_tokens": resolved.max_output_tokens if max_tokens is None else max_tokens,
        }
        if response_format is not None:
            kwargs["response_format"] = response_format

        try:
            return await acompletion(**kwargs)
        except Exception:
            if resolved.fallback_model and resolved.fallback_model != resolved.model_name:
                fallback = self.resolve_model_name(
                    resolved.fallback_model,
                    role=role,
                    temperature=kwargs["temperature"],
                    max_output_tokens=kwargs["max_tokens"],
                )
                kwargs["model"] = fallback.model_name
                kwargs["api_key"] = fallback.api_key
                kwargs["api_base"] = fallback.api_base
                kwargs["timeout"] = fallback.timeout_seconds
                kwargs["temperature"] = fallback.temperature
                kwargs["max_tokens"] = fallback.max_output_tokens
                return await acompletion(**kwargs)
            raise

    @staticmethod
    def extract_text(response: Any) -> str:
        choice = response.choices[0]
        message = getattr(choice, "message", None)
        if message is not None:
            content = getattr(message, "content", None)
            if isinstance(content, str):
                return content.strip()
            if content is not None:
                return str(content).strip()
        text = getattr(choice, "text", None)
        if isinstance(text, str):
            return text.strip()
        return str(response).strip()

    @staticmethod
    def extract_json_text(text: str) -> str:
        cleaned = text.strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        return cleaned.strip()

    @staticmethod
    def safe_json_loads(text: str) -> dict[str, Any]:
        cleaned = LiteLLMModelResolver.extract_json_text(text)
        if not cleaned:
            raise json.JSONDecodeError("Empty payload", cleaned, 0)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass

        object_match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if object_match:
            return json.loads(object_match.group(0))

        array_match = re.search(r"\[.*\]", cleaned, re.DOTALL)
        if array_match:
            parsed = json.loads(array_match.group(0))
            if isinstance(parsed, dict):
                return parsed
            return {"items": parsed}

        raise json.JSONDecodeError("No JSON object found in payload", cleaned, 0)
