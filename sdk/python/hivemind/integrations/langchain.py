"""LangChain adapter for HIVEMIND.

Drop-in BaseRetriever — use HIVEMIND as the retrieval layer in any
LangChain RAG pipeline.

Example:
    from langchain_anthropic import ChatAnthropic
    from langchain_core.prompts import ChatPromptTemplate
    from hivemind import HiveMind
    from hivemind.integrations.langchain import HiveMindRetriever

    hm = HiveMind(api_key="hmk_live_...")
    retriever = HiveMindRetriever(hm=hm, k=5, scope="team")

    llm = ChatAnthropic(model="claude-sonnet-4-5")
    prompt = ChatPromptTemplate.from_template(
        "Answer using only this context:\\n{context}\\n\\nQuestion: {question}"
    )
    chain = (
        {"context": retriever, "question": lambda x: x}
        | prompt
        | llm
    )
    print(chain.invoke("What did we decide about EU AI Act compliance?"))
"""

from __future__ import annotations

from typing import Any, Literal

try:
    from langchain_core.callbacks import (
        AsyncCallbackManagerForRetrieverRun,
        CallbackManagerForRetrieverRun,
    )
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "LangChain adapter requires langchain-core. Install with:\n"
        "    pip install hivemind-sdk[langchain]"
    ) from e

from pydantic import Field

from hivemind.client import AsyncHiveMind, HiveMind


class HiveMindRetriever(BaseRetriever):
    """LangChain BaseRetriever backed by HIVEMIND.

    Args:
        hm: HiveMind client (sync). Required.
        ahm: AsyncHiveMind client (async). Optional, falls back to sync.
        k: Number of results to return per query.
        scope: 'personal' | 'team' | 'all'.
        tags: Optional tag filter.
        project: Optional project filter.
        mode: 'search' (raw search) or 'recall' (with quick/panorama/insight reasoning).
        recall_mode: When mode='recall', the reasoning mode to use.
    """

    hm: HiveMind = Field(exclude=True)
    ahm: AsyncHiveMind | None = Field(default=None, exclude=True)
    k: int = 5
    scope: Literal["personal", "team", "all"] = "personal"
    tags: list[str] | None = None
    project: str | None = None
    mode: Literal["search", "recall"] = "search"
    recall_mode: Literal["quick", "panorama", "insight"] = "quick"

    class Config:
        arbitrary_types_allowed = True

    def _result_to_doc(self, result: Any) -> Document:
        mem = result.memory
        return Document(
            page_content=mem.content,
            metadata={
                "source": mem.id,
                "title": mem.title or "",
                "tags": mem.tags,
                "memory_type": mem.memory_type,
                "project": mem.project,
                "score": result.score,
                "method": result.method,
                "cluster_id": mem.cluster_id,
                "cluster_role": mem.cluster_role,
            },
        )

    def _get_relevant_documents(
        self,
        query: str,
        *,
        run_manager: CallbackManagerForRetrieverRun | None = None,
    ) -> list[Document]:
        if self.mode == "recall":
            results = self.hm.recall(
                query,
                n_results=self.k,
                mode=self.recall_mode,
                scope=self.scope,
                project=self.project,
            )
        else:
            results = self.hm.search(
                query,
                n_results=self.k,
                scope=self.scope,
                tags=self.tags,
                project=self.project,
            )
        return [self._result_to_doc(r) for r in results]

    async def _aget_relevant_documents(
        self,
        query: str,
        *,
        run_manager: AsyncCallbackManagerForRetrieverRun | None = None,
    ) -> list[Document]:
        client = self.ahm
        if client is None:
            # Fallback to sync inside async context
            return self._get_relevant_documents(query)
        if self.mode == "recall":
            results = await client.recall(
                query,
                n_results=self.k,
                mode=self.recall_mode,
                scope=self.scope,
            )
        else:
            results = await client.search(
                query,
                n_results=self.k,
                scope=self.scope,
                tags=self.tags,
                project=self.project,
            )
        return [self._result_to_doc(r) for r in results]


__all__ = ["HiveMindRetriever"]
