import os
import asyncio

import pytest

from hivemind_employees import ai_gateway


@pytest.fixture(autouse=True)
def gateway_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_AI_GATEWAY_ENABLED", "true")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account")
    monkeypatch.setenv("CLOUDFLARE_AI_GATEWAY_ID", "gateway")
    monkeypatch.setenv("CLOUDFLARE_AI_GATEWAY_TOKEN", "gateway-token")
    monkeypatch.setenv("CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS", "first-bundb")


def test_openrouter_route_strips_provider_version_and_secret():
    direct = "https://openrouter.ai/api/v1/chat/completions"
    assert ai_gateway.provider_url(direct) == (
        "https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter/chat/completions"
    )
    headers = ai_gateway.gateway_headers(direct, {"Authorization": "Bearer direct", "x-trace": "1"})
    assert "Authorization" not in headers
    assert headers["cf-aig-authorization"] == "Bearer gateway-token"
    assert headers["cf-aig-byok-alias"] == "first-bundb"
    assert headers["x-trace"] == "1"


def test_missing_alias_uses_provider_passthrough(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_AI_GATEWAY_GROQ_BYOK_ALIAS", raising=False)
    headers = ai_gateway.gateway_headers(
        "https://api.groq.com/openai/v1/chat/completions", {"Authorization": "Bearer provider"}
    )
    assert headers["Authorization"] == "Bearer provider"
    assert headers["cf-aig-authorization"] == "Bearer gateway-token"


def test_embedding_and_voice_providers_are_gateway_native():
    assert ai_gateway.provider("https://api.mistral.ai/v1/embeddings") == "mistral"
    assert ai_gateway.provider("https://api.cohere.com/v2/rerank") == "cohere"
    assert ai_gateway.provider("https://api.deepgram.com/v1/speak") == "deepgram"
    assert ai_gateway.provider("https://api.cartesia.ai/tts/bytes") == "cartesia"


def test_workers_ai_chat_uses_gateway_and_disables_thinking(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        def json(self):
            return {"choices": [{"message": {"content": "ok"}}]}

    class Client:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_args):
            return None
        async def post(self, url, **kwargs):
            captured.update(url=url, **kwargs)
            return Response()

    monkeypatch.setattr(ai_gateway.httpx, "AsyncClient", Client)
    result = asyncio.run(ai_gateway.workers_ai_chat({
        "model": "@cf/zai-org/glm-5.3-flash",
        "messages": [{"role": "user", "content": "plan"}],
        "reasoning_effort": "high",
    }, timeout=ai_gateway.httpx.Timeout(5.0)))

    assert result["choices"][0]["message"]["content"] == "ok"
    assert captured["url"].endswith("/v1/account/gateway/compat/chat/completions")
    assert captured["json"]["model"] == "workers-ai/@cf/zai-org/glm-5.3-flash"
    assert captured["json"]["chat_template_kwargs"]["enable_thinking"] is False
    assert "reasoning_effort" not in captured["json"]
    assert "openrouter" not in captured["url"]
