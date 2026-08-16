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
