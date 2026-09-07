import pytest

from hivemind_employees.hyper import engine


@pytest.mark.asyncio
async def test_session_discovery_is_preferred_and_cached(monkeypatch):
    engine._INSPECT_CACHE.clear()
    calls = {"session": 0, "legacy": 0}

    async def session_discovery(name, use_case, **kwargs):
        calls["session"] += 1
        assert name == "gmail"
        assert use_case == "find invoices"
        return {
            "tools": [{
                "name": "composio_gmail_fetch_emails",
                "inputSchema": {"type": "object", "properties": {}},
                "grantId": "grant-1",
                "grantExpiresAt": 9999999999999,
                "toolSlug": "GMAIL_FETCH_EMAILS",
            }]
        }

    async def legacy_discovery(*args, **kwargs):
        calls["legacy"] += 1
        return {}

    monkeypatch.setattr(engine, "composio_session_reads_emulated", session_discovery)
    monkeypatch.setattr(engine, "connector_inspect_emulated", legacy_discovery)

    first = await engine._inspect_connector_tools(
        "gmail", user_id="user-1", org_id="org-1", use_case="find invoices")
    second = await engine._inspect_connector_tools(
        "gmail", user_id="user-1", org_id="org-1", use_case="find invoices")

    assert first == second
    assert first[0]["grantId"] == "grant-1"
    assert calls == {"session": 1, "legacy": 0}


@pytest.mark.asyncio
async def test_session_discovery_cache_is_tenant_scoped(monkeypatch):
    engine._INSPECT_CACHE.clear()
    calls = []

    async def session_discovery(name, use_case, **kwargs):
        calls.append((kwargs["org_id"], kwargs["user_id"]))
        return {"tools": [{
            "name": "composio_gmail_fetch_emails",
            "inputSchema": {"type": "object", "properties": {}},
            "grantId": f"grant-{kwargs['org_id']}",
            "grantExpiresAt": 9999999999999,
            "toolSlug": "GMAIL_FETCH_EMAILS",
        }]}

    monkeypatch.setattr(engine, "composio_session_reads_emulated", session_discovery)
    monkeypatch.setattr(engine, "connector_inspect_emulated", lambda *args, **kwargs: {})

    first = await engine._inspect_connector_tools(
        "gmail", user_id="user-1", org_id="org-1", use_case="find invoices")
    second = await engine._inspect_connector_tools(
        "gmail", user_id="user-2", org_id="org-2", use_case="find invoices")

    assert first[0]["grantId"] != second[0]["grantId"]
    assert calls == [("org-1", "user-1"), ("org-2", "user-2")]


@pytest.mark.asyncio
async def test_session_failure_falls_back_to_legacy_read_inspect(monkeypatch):
    engine._INSPECT_CACHE.clear()
    calls = {"legacy": 0}

    async def failed_session(*args, **kwargs):
        raise RuntimeError("session unavailable")

    async def legacy_discovery(name, **kwargs):
        calls["legacy"] += 1
        assert name == "notion"
        return {
            "inspection": {
                "tools": [{
                    "name": "NOTION_SEARCH",
                    "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
                }]
            }
        }

    monkeypatch.setattr(engine, "composio_session_reads_emulated", failed_session)
    monkeypatch.setattr(engine, "connector_inspect_emulated", legacy_discovery)

    tools = await engine._inspect_connector_tools(
        "notion", user_id="user-1", org_id="org-1", use_case="find roadmap")

    assert [tool["name"] for tool in tools] == ["NOTION_SEARCH"]
    assert calls["legacy"] == 1


@pytest.mark.asyncio
async def test_session_result_preserves_receipt_and_structured_evidence(monkeypatch):
    events = []

    async def emit(event):
        events.append(event)

    director = engine.Director(
        user_message="find invoices", user_id="user-1", org_id="org-1",
        project_id=None, participants=[], room_template="auto", room_goal=None,
        enabled_connectors=["gmail"], emit=emit,
    )
    director._connector_routes["gmail__fetch"] = (
        "composio_session", "gmail", "grant-1|GMAIL_FETCH_EMAILS")
    payload = {"messages": [{"id": "m1", "body": "x" * 3000}]}

    async def execute(*args, **kwargs):
        return {
            "successful": True,
            "data": payload,
            "receipt": {
                "provider": "composio", "transport": "tool_router_session",
                "tool_slug": "GMAIL_FETCH_EMAILS", "session_log_id": "log-1", "effect": "read",
            },
        }

    monkeypatch.setattr(engine, "composio_session_read_exec_emulated", execute)
    output = await director._connector_read("gmail__fetch", {"query": "invoice"})

    assert "log-1" in output
    assert "x" * 1000 in director.blackboard[-1]
    assert director._connector_evidence[0]["provider_receipt"] == "log-1"
    assert director._connector_evidence[0]["content"].endswith("}]}")
    assert any(event["t"] == "evidence_received" for event in events)
