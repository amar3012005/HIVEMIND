import asyncio
from types import SimpleNamespace

from hivemind_employees import hivemind_client


class _Response:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    calls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, path, **_kwargs):
        self.calls.append(path)
        return _Response(502, {
            "error": "governed web search returned no usable URL-backed citations",
            "provider_attempts": [
                {"provider": "composio_search", "status": "unavailable"},
                {"provider": "parallel_search", "status": "unavailable"},
            ],
        })


def test_room_web_search_does_not_silently_fall_back_to_legacy_core_search(monkeypatch):
    _Client.calls = []
    monkeypatch.setattr(hivemind_client, "get_settings", lambda: SimpleNamespace(
        hivemind_cp_url="http://control.test", hivemind_core_url="http://core.test",
    ))
    monkeypatch.setattr(hivemind_client.httpx, "AsyncClient", _Client)

    result = asyncio.run(hivemind_client.web_search_emulated(
        "Solvis GmbH Hannover competitors", user_id="user", org_id="org",
    ))

    assert result["error"] == "governed web search returned no usable URL-backed citations"
    assert result["provider_attempts"][-1]["provider"] == "parallel_search"
    assert _Client.calls == ["http://control.test/internal/hyper/web-search"]
