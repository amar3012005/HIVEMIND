import pytest

from agentscope_blaiq.agents.research import ResearchAgent
from agentscope_blaiq.contracts.evidence import EvidenceFinding
from agentscope_blaiq.runtime.hivemind_mcp import HivemindMCPClient


class FakeHivemindClient(HivemindMCPClient):
    def __init__(self):
        super().__init__(rpc_url="https://example.com/mcp", api_key="test-key")
        self.recall_queries = []
        self.recall_modes = []
        self.web_queries = []
        self.web_domains = []

    async def recall(self, *, query: str, limit: int = 20, mode: str = "insight"):
        self.recall_queries.append(query)
        self.recall_modes.append(mode)
        query_key = query.lower()
        if "what projects am i working on" in query_key:
            return {
                "memories": [
                    {
                        "memory_id": "mem-projects",
                        "title": "Current projects",
                        "content": "You are currently working on BLAIQ and HIVE-MIND.",
                        "score": 0.91,
                    }
                ]
            }
        if "company overview" in query_key:
            return {
                "memories": [
                    {
                        "memory_id": "mem-company",
                        "title": "Company overview",
                        "content": "BunDB provides enterprise workflow software.",
                        "score": 0.84,
                    }
                ]
            }
        if "proof points and credibility" in query_key:
            return {
                "memories": [
                    {
                        "memory_id": "mem-proof",
                        "title": "Customer proof",
                        "content": "Reference customers and internal proof points are available.",
                        "score": 0.79,
                    }
                ]
            }
        return {"memories": []}

    async def query_with_ai(self, *, question: str, context_limit: int = 8):
        return {"answer": "Synthesized memory summary."}

    async def traverse_graph(self, *, memory_id: str, depth: int = 2):
        return {"memories": []}

    async def web_usage(self):
        return {"ok": True}

    async def web_search(self, *, query: str, domains: list[str] | None = None, limit: int = 5):
        self.web_queries.append(query)
        self.web_domains.append(domains or [])
        return {"results": []}


class FakeResearchAgent(ResearchAgent):
    async def complete_json(self, model, *, user_content: str, extra_context=None, temperature=None, max_tokens=None):
        del user_content, temperature, max_tokens
        context = extra_context or {}
        if model.__name__ == "MemoryQueryPlan":
            user_query = context.get("user_query", "")
            if user_query.lower() == "create me a hiveind about myself":
                return model(
                    optimized_query="what do you know about me",
                    alternate_queries=[],
                    focus_terms=["me", "profile", "history"],
                    avoid_terms=[],
                )
            if user_query == "Create a professional pitch deck presentation for bundb.de":
                return model(
                    optimized_query=user_query,
                    alternate_queries=[
                        "bundb.de company overview",
                        "Create a professional pitch deck presentation for bundb.de proof points and credibility",
                    ],
                    focus_terms=["company", "product", "proof"],
                    avoid_terms=[],
                )
            return model(
                optimized_query=user_query,
                alternate_queries=[],
                focus_terms=["project", "work", "company"],
                avoid_terms=["trip", "tesla", "accident"],
            )
        if model.__name__ == "MemorySelectionDecision":
            candidates = context.get("memory_candidates", [])
            kept = [item["memory_id"] for item in candidates if "project" in item.get("excerpt", "").lower() or "working on" in item.get("excerpt", "").lower()]
            return model(memory_ids=kept)
        raise AssertionError(f"Unexpected model {model.__name__}")


@pytest.mark.asyncio
async def test_research_agent_breaks_request_into_memory_first_recall_passes():
    hivemind = FakeHivemindClient()
    agent = FakeResearchAgent(hivemind=hivemind)

    evidence = await agent.gather(
        session=None,  # not used when scope is web-only
        tenant_id="tenant-1",
        query="Create a professional pitch deck presentation for bundb.de",
        scope="web",
    )

    assert len(hivemind.recall_queries) >= 2
    assert hivemind.recall_queries[0] == "Create a professional pitch deck presentation for bundb.de"
    assert any("bundb.de company overview" == query for query in hivemind.recall_queries)
    assert any("proof points and credibility" in query.lower() for query in hivemind.recall_queries)
    assert hivemind.recall_modes[0] == "quick"
    assert evidence.memory_findings
    assert evidence.provenance.primary_ground_truth == "memory"
    assert hivemind.web_queries == ["Create a professional pitch deck presentation for bundb.de"]
    assert hivemind.web_domains == [["bundb.de"]]


def test_research_agent_freshness_gate_skips_web_for_non_fresh_query_when_memory_exists():
    findings = [
        EvidenceFinding(
            finding_id="memory:mem-company",
            title="Company overview",
            summary="BundB provides enterprise workflow software.",
            source_ids=["mem-company"],
            confidence=0.84,
        )
    ]

    assert ResearchAgent._needs_web_freshness(
        "Create a professional pitch deck presentation for bundb.de",
        "web_and_docs",
        findings,
    ) is False


def test_research_agent_optimizes_raw_personal_prompt_for_memory_search():
    planned = ResearchAgent._research_query_plan("create me a hiveind about myself")
    assert planned[0] == "what do you know about me"


def test_research_agent_filters_irrelevant_personal_project_memories():
    memories = [
        {
            "memory_id": "mem-project",
            "title": "Current projects",
            "content": "You are working on BLAIQ and HIVE-MIND.",
        },
        {
            "memory_id": "mem-trip",
            "title": "Trip update",
            "content": "I am excited about the Tokyo trip next month.",
        },
        {
            "memory_id": "mem-car",
            "title": "Car accident",
            "content": "The Tesla accident was stressful.",
        },
    ]

    filtered = ResearchAgent._filter_memories_for_query("What projects am I working on?", memories)

    assert [item["memory_id"] for item in filtered] == ["mem-project"]


@pytest.mark.asyncio
async def test_personal_memory_query_uses_quick_recall_and_skips_web_without_freshness_need():
    hivemind = FakeHivemindClient()
    agent = FakeResearchAgent(hivemind=hivemind)

    evidence = await agent.gather(
        session=None,
        tenant_id="tenant-1",
        query="What projects am I working on?",
        scope="web",
    )

    assert hivemind.recall_modes == ["quick"]
    assert hivemind.recall_queries == ["What projects am I working on?"]
    assert hivemind.web_queries == []
    assert len(evidence.memory_findings) == 1
    assert evidence.memory_findings[0].title == "Current projects"


@pytest.mark.asyncio
async def test_injection_text_is_converted_into_memory_findings_for_project_queries():
    class InjectionTextHivemindClient(FakeHivemindClient):
        async def recall(self, *, query: str, limit: int = 20, mode: str = "insight"):
            self.recall_queries.append(query)
            self.recall_modes.append(mode)
            return {
                "memories": [
                    {
                        "memory_id": "mem-apple",
                        "title": "Browsing Apple products",
                        "content": "The user is browsing Apple products and services.",
                        "score": 0.75,
                    }
                ],
                "injection_text": """
                <user-profile>
                Key Facts:
                • You are currently working on BLAIQ and HIVE-MIND this quarter.
                • You are a founder at DaVinci AI.
                </user-profile>
                """,
            }

    hivemind = InjectionTextHivemindClient()
    agent = FakeResearchAgent(hivemind=hivemind)

    evidence = await agent.gather(
        session=None,
        tenant_id="tenant-1",
        query="What projects am I working on?",
        scope="web",
    )

    assert len(evidence.memory_findings) == 1
    assert "working on BLAIQ and HIVE-MIND" in evidence.memory_findings[0].summary
    assert evidence.memory_findings[0].source_ids[0].startswith("injection:")
