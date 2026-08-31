import asyncio

from hivemind_employees.agents.agentscope_tools import (
    begin_agent_tool_receipts,
    drain_agent_tool_receipts,
    register_cloudflare_browser_tool,
)


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "session_id": "browser-session-1",
            "target_id": "tab-1",
            "live_view_url": "https://example.test/live",
            "screenshot": {"artifact_key": "shots/one.png"},
            "tabs": [{"target_id": "tab-1", "url": "https://example.com/pricing"}],
            "page": {
                "page_valid": True,
                "url": "https://example.com/pricing",
                "title": "Current pricing",
                "text": "Model A starts at $999" + (" x" * 6000) + "UNBOUNDED_TEXT_MARKER",
                "links": [
                    {"text": f"link-{index}", "url": f"https://example.com/{index}"}
                    for index in range(80)
                ],
                "structured": [f"row-{index}-" + ("y" * 2500) for index in range(20)],
                "content_hash": "content-hash-1",
                "captured_at": "2026-08-31T16:00:00Z",
            },
        }


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, *_args, **_kwargs):
        return _Response()


class _Toolkit:
    def create_tool_group(self, **_kwargs):
        return None

    def register_tool_function(self, function, **_kwargs):
        self.function = function


def test_browser_receipt_is_streamed_before_agent_loop_finishes(monkeypatch):
    monkeypatch.setenv("HYPER_GROK_WORKFLOW_URL", "https://worker.example")
    monkeypatch.setenv("HYPER_GROK_WORKFLOW_SECRET", "test-secret")
    monkeypatch.setattr(
        "hivemind_employees.agents.agentscope_tools.httpx.AsyncClient",
        lambda **_kwargs: _Client(),
    )
    emitted = []

    async def callback(receipt):
        emitted.append(receipt)

    toolkit = _Toolkit()
    begin_agent_tool_receipts()
    register_cloudflare_browser_tool(
        toolkit,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "full",
        agent_instance_id="ha-0123456789abcdef0123456789abcdef-v1",
        work_order_id="00000000-0000-4000-8000-000000000003",
        receipt_callback=callback,
    )

    result = asyncio.run(toolkit.function("https://example.com/pricing"))

    ledger = drain_agent_tool_receipts()
    assert len(emitted) == 1
    assert emitted[0]["status"] == "completed"
    assert emitted[0]["content_hash"] == "content-hash-1"
    assert len(ledger) == 1
    assert ledger[0]["url"] == "https://example.com/pricing"
    assert len(emitted[0]["excerpt"]) <= 4000
    assert "UNBOUNDED_TEXT_MARKER" not in str(result)
