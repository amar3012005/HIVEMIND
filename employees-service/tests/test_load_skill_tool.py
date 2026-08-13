"""load_skill (dual-engine agentic task engine, 2026-08-13): the domain's own
strategy/method playbooks (hyper/domains/<slug>/skills/*.md) loaded on demand
mid-task, instead of dumped upfront on the blackboard the way the debate
pipeline does it. Reuses the SAME catalogs the debate pipeline already reads
from — no new skills.
"""
from hivemind_employees.agents.agentscope_tools import register_load_skill_tool


class _FakeToolkit:
    def __init__(self):
        self.fn = None

    def register_tool_function(self, fn):
        self.fn = fn


def test_real_domain_skill_loads_its_actual_body():
    tk = _FakeToolkit()
    register_load_skill_tool(tk, "seo")
    assert tk.fn is not None, "a domain with real skills must register load_skill"
    import asyncio
    response = asyncio.run(tk.fn("technical-seo-audit"))
    text = response.content[0]["text"]
    assert text and "no skill named" not in text.lower()


def test_unknown_skill_name_lists_the_real_catalog():
    tk = _FakeToolkit()
    register_load_skill_tool(tk, "legal_finance")
    import asyncio
    response = asyncio.run(tk.fn("not-a-real-skill"))
    text = response.content[0]["text"]
    assert "gdpr-processing-screen" in text  # a real skill in this domain's catalog
    assert "not-a-real-skill" in text


def test_room_kind_with_no_domain_skills_registers_nothing():
    """outreach's skills live under the METHOD_SKILLS kind-skill system, not a
    domain-pack skills/ folder — domain_skill_catalog('outreach') is []. This
    must be a clean no-op, not an error."""
    tk = _FakeToolkit()
    register_load_skill_tool(tk, "outreach")
    assert tk.fn is None


def test_unrecognized_room_kind_registers_nothing():
    tk = _FakeToolkit()
    register_load_skill_tool(tk, "general")
    assert tk.fn is None


def test_empty_room_kind_registers_nothing():
    tk = _FakeToolkit()
    register_load_skill_tool(tk, "")
    assert tk.fn is None
