from tara_aaas import ai_gateway


def test_tara_aaas_stt_and_tts_use_gateway(monkeypatch):
    for key, value in {
        "CLOUDFLARE_AI_GATEWAY_ENABLED": "true",
        "CLOUDFLARE_ACCOUNT_ID": "account",
        "CLOUDFLARE_AI_GATEWAY_ID": "gateway",
        "CLOUDFLARE_AI_GATEWAY_TOKEN": "token",
    }.items():
        monkeypatch.setenv(key, value)
    groq, headers = ai_gateway.route(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {"Authorization": "Bearer provider"},
    )
    cartesia, _ = ai_gateway.route("https://api.cartesia.ai/tts/bytes")
    assert "/gateway/groq/openai/v1/audio/transcriptions" in groq
    assert cartesia.endswith("/gateway/cartesia/tts/bytes")
    assert headers["cf-aig-authorization"] == "Bearer token"
    websocket, websocket_headers = ai_gateway.cartesia_websocket_route(
        "wss://api.cartesia.ai/tts/websocket?cartesia_version=2025-04-16",
        {"Authorization": "Bearer provider"},
    )
    assert websocket == "wss://gateway.ai.cloudflare.com/v1/account/gateway/cartesia?cartesia_version=2025-04-16"
    assert websocket_headers["cf-aig-authorization"] == "Bearer token"
