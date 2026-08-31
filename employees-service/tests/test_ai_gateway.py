import os

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


def test_sdk_target_uses_server_owned_byok_alias():
    base, _, headers = ai_gateway.sdk_target(
        "https://openrouter.ai/api/v1", "stale-provider-key"
    )
    assert base.endswith("/account/gateway/openrouter")
    assert headers["Authorization"] == ""
    assert headers["cf-aig-byok-alias"] == "first-bundb"


def test_workers_ai_sdk_target_uses_gateway_compat_and_not_openrouter():
    model, key, base, headers = ai_gateway.workers_ai_sdk_target(
        "@cf/zai-org/glm-5.3-flash"
    )
    assert model == "workers-ai/@cf/zai-org/glm-5.3-flash"
    assert key == "gateway-token"
    assert base == "https://gateway.ai.cloudflare.com/v1/account/gateway/compat"
    assert headers["cf-aig-authorization"] == "Bearer gateway-token"


@pytest.mark.asyncio
async def test_workers_ai_chat_posts_to_gateway_compat(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "ok"}}]}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            captured.update(url=url, headers=headers, json=json)
            return Response()

    monkeypatch.setattr(ai_gateway.httpx, "AsyncClient", lambda **_kwargs: Client())
    result = await ai_gateway.workers_ai_chat(
        {"model": "@cf/zai-org/glm-5.3-flash", "messages": []},
        timeout=ai_gateway.httpx.Timeout(5.0),
    )

    assert result["choices"][0]["message"]["content"] == "ok"
    assert captured["url"].endswith("/account/gateway/compat/chat/completions")
    assert captured["json"]["model"] == "workers-ai/@cf/zai-org/glm-5.3-flash"
    assert captured["json"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert "reasoning_effort" not in captured["json"]
    assert "openrouter" not in captured["url"]
