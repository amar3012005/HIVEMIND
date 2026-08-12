"""delegate_to (dual-engine agentic task engine, 2026-08-13): lets the lead
hand a bounded subtask to a REAL teammate's own agent (their persona, their
tools/connectors, their own reasoning loop) instead of doing everything alone
or faking their voice with a single-shot debate-style text call.
"""
import asyncio

from hivemind_employees.agents.agentscope_tools import register_delegate_to_tool


class _FakeToolkit:
    """Captures the registered function the same way AgentScope's real
    Toolkit.register_tool_function would, without needing a live toolkit."""
    def __init__(self):
        self.fn = None

    def register_tool_function(self, fn):
        self.fn = fn


class _FakeReply:
    def __init__(self, text):
        self.content = [{"type": "text", "text": text}]


PARTICIPANTS = [
    {"slug": "priya-nair", "name": "Priya Nair", "_lane": "Strategist"},
    {"slug": "lina-meyer", "name": "Lina Meyer", "_lane": "Skeptic"},
]


def _register(build_sub_agent, max_delegations=4):
    tk = _FakeToolkit()
    register_delegate_to_tool(tk, PARTICIPANTS, build_sub_agent, max_delegations)
    assert tk.fn is not None, "delegate_to must be registered"
    return tk.fn


def test_successful_delegation_returns_the_sub_agents_text():
    async def build_sub_agent(target_row):
        assert target_row["slug"] == "priya-nair"
        async def fake_agent(msg):
            return _FakeReply("Priya's real, tool-grounded subtask result.")
        return fake_agent

    delegate_to = _register(build_sub_agent)
    response = asyncio.run(delegate_to("priya-nair", "qualify these three leads"))
    assert response.content[0]["text"] == "Priya's real, tool-grounded subtask result."
    assert response.metadata["delegated_to"] == "priya-nair"


def test_unknown_slug_lists_real_teammates_instead_of_inventing_one():
    async def build_sub_agent(target_row):
        raise AssertionError("must never build an agent for an unknown slug")

    delegate_to = _register(build_sub_agent)
    response = asyncio.run(delegate_to("someone-who-does-not-exist", "do a thing"))
    text = response.content[0]["text"]
    assert "priya-nair" in text and "lina-meyer" in text
    assert "someone-who-does-not-exist" in text


def test_delegation_budget_is_enforced():
    calls = {"n": 0}

    async def build_sub_agent(target_row):
        calls["n"] += 1
        async def fake_agent(msg):
            return _FakeReply(f"reply {calls['n']}")
        return fake_agent

    delegate_to = _register(build_sub_agent, max_delegations=2)
    r1 = asyncio.run(delegate_to("priya-nair", "task 1"))
    r2 = asyncio.run(delegate_to("lina-meyer", "task 2"))
    r3 = asyncio.run(delegate_to("priya-nair", "task 3 — should be refused"))

    assert "reply 1" in r1.content[0]["text"]
    assert "reply 2" in r2.content[0]["text"]
    assert "budget exhausted" in r3.content[0]["text"].lower()
    assert calls["n"] == 2, "a refused delegation must never build a third sub-agent"


def test_sub_agent_failure_is_reported_not_raised():
    async def broken_build(target_row):
        raise RuntimeError("agent build failed")

    delegate_to = _register(broken_build)
    response = asyncio.run(delegate_to("priya-nair", "do a thing"))
    assert "failed" in response.content[0]["text"].lower()


def test_empty_roster_registers_nothing():
    tk = _FakeToolkit()

    async def build_sub_agent(target_row):
        raise AssertionError("never called — nothing should be registered")

    register_delegate_to_tool(tk, [], build_sub_agent, 4)
    assert tk.fn is None
