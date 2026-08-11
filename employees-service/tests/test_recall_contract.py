import asyncio

from hivemind_employees import hivemind_client


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {"memories": []}


class _Client:
    calls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, path, json):
        self.calls.append((path, json))
        return _Response()


def test_hyperagents_recall_defaults_to_explain_and_allows_full(monkeypatch):
    _Client.calls = []
    monkeypatch.setattr(hivemind_client.httpx, "AsyncClient", _Client)

    asyncio.run(hivemind_client.recall_emulated(
        "default context", user_id="user-1", org_id="org-1",
    ))
    asyncio.run(hivemind_client.recall_emulated(
        "research source", user_id="user-1", org_id="org-1", mode="full",
    ))

    assert [body["mode"] for _, body in _Client.calls] == ["explain", "full"]
    assert all(path == "/api/recall" for path, _ in _Client.calls)
