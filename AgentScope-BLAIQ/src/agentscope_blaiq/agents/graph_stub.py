from __future__ import annotations

from pydantic import BaseModel

from agentscope_blaiq.runtime.agent_base import BaseAgent


class GraphKnowledgeResult(BaseModel):
    enabled: bool = False
    message: str = "GraphKnowledgeAgent is reserved for a later release."


class GraphKnowledgeAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__(
            name="GraphKnowledgeAgent",
            role="graph_knowledge",
            sys_prompt="Reserved future graph-backed knowledge agent.",
        )

    async def gather(self) -> GraphKnowledgeResult:
        return GraphKnowledgeResult()
