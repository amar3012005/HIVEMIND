"""LlamaIndex adapter for HIVEMIND.

Drop-in retriever — use HIVEMIND inside any LlamaIndex query engine.

Example:
    from llama_index.core import VectorStoreIndex, get_response_synthesizer
    from llama_index.core.query_engine import RetrieverQueryEngine
    from hivemind import HiveMind
    from hivemind.integrations.llamaindex import HiveMindRetriever

    hm = HiveMind(api_key="hmk_live_...")
    retriever = HiveMindRetriever(hm=hm, similarity_top_k=5, scope="team")

    query_engine = RetrieverQueryEngine.from_args(retriever=retriever)
    response = query_engine.query("What did we decide about pricing?")
    print(response)
"""

from __future__ import annotations

from typing import Any, Literal

try:
    from llama_index.core.callbacks import CBEventType, EventPayload
    from llama_index.core.retrievers import BaseRetriever
    from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "LlamaIndex adapter requires llama-index-core. Install with:\n"
        "    pip install hivemind-sdk[llamaindex]"
    ) from e

from hivemind.client import HiveMind
from hivemind.models import SearchResult


class HiveMindRetriever(BaseRetriever):
    """LlamaIndex BaseRetriever backed by HIVEMIND.

    Args:
        hm: HiveMind client.
        similarity_top_k: Number of results.
        scope: 'personal' | 'team' | 'all'.
        tags: Optional tag filter.
        project: Optional project filter.
        mode: 'search' or 'recall' (with quick/panorama/insight reasoning).
        recall_mode: Reasoning mode when mode='recall'.
    """

    def __init__(
        self,
        hm: HiveMind,
        *,
        similarity_top_k: int = 5,
        scope: Literal["personal", "team", "all"] = "personal",
        tags: list[str] | None = None,
        project: str | None = None,
        mode: Literal["search", "recall"] = "search",
        recall_mode: Literal["quick", "panorama", "insight"] = "quick",
        **kwargs: Any,
    ):
        self.hm = hm
        self.similarity_top_k = similarity_top_k
        self.scope = scope
        self.tags = tags
        self.project = project
        self.mode = mode
        self.recall_mode = recall_mode
        super().__init__(**kwargs)

    def _to_node(self, result: SearchResult) -> NodeWithScore:
        mem = result.memory
        node = TextNode(
            text=mem.content,
            id_=mem.id or "",
            metadata={
                "title": mem.title or "",
                "tags": mem.tags,
                "memory_type": mem.memory_type,
                "project": mem.project,
                "method": result.method,
                "cluster_id": mem.cluster_id,
                "cluster_role": mem.cluster_role,
            },
        )
        return NodeWithScore(node=node, score=result.score)

    def _retrieve(self, query_bundle: QueryBundle) -> list[NodeWithScore]:
        query = query_bundle.query_str
        with self.callback_manager.event(
            CBEventType.RETRIEVE,
            payload={EventPayload.QUERY_STR: query},
        ) as event:
            if self.mode == "recall":
                results = self.hm.recall(
                    query,
                    n_results=self.similarity_top_k,
                    mode=self.recall_mode,
                    scope=self.scope,
                    project=self.project,
                )
            else:
                results = self.hm.search(
                    query,
                    n_results=self.similarity_top_k,
                    scope=self.scope,
                    tags=self.tags,
                    project=self.project,
                )
            nodes = [self._to_node(r) for r in results]
            event.on_end(payload={EventPayload.NODES: nodes})
            return nodes


__all__ = ["HiveMindRetriever"]
