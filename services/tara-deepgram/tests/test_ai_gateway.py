import pytest

from tara_deepgram import ai_gateway


def test_tara_openrouter_inference_uses_gateway(monkeypatch):
    for key, value in {
        "CLOUDFLARE_AI_GATEWAY_ENABLED": "true",
        "CLOUDFLARE_ACCOUNT_ID": "account",
        "CLOUDFLARE_AI_GATEWAY_ID": "gateway",
        "CLOUDFLARE_AI_GATEWAY_TOKEN": "token",
        "CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS": "alias",
    }.items():
        monkeypatch.setenv(key, value)
    url, headers = ai_gateway.route(
        "https://openrouter.ai/api/v1/chat/completions",
        {"Authorization": "Bearer provider", "content-type": "application/json"},
    )
    assert url.endswith("/gateway/openrouter/chat/completions")
    assert "Authorization" not in headers
    assert headers["cf-aig-byok-alias"] == "alias"
