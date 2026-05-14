"""LlamaIndex query engine with HIVEMIND as the retriever.

Install:
    pip install "hivemind-sdk[llamaindex]" llama-index-llms-anthropic
"""

import os

from llama_index.core import Settings
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.response_synthesizers import ResponseMode
from llama_index.llms.anthropic import Anthropic

from hivemind import HiveMind
from hivemind.integrations.llamaindex import HiveMindRetriever


def main():
    Settings.llm = Anthropic(model="claude-sonnet-4-5")

    hm = HiveMind(api_key=os.environ["HIVEMIND_API_KEY"])
    retriever = HiveMindRetriever(hm=hm, similarity_top_k=5, scope="team")

    query_engine = RetrieverQueryEngine.from_args(
        retriever=retriever,
        response_mode=ResponseMode.COMPACT,
    )

    response = query_engine.query("What did we decide about pricing in Q2?")
    print(response)
    print("\n--- sources ---")
    for node in response.source_nodes:
        print(f"  [{node.score:.3f}] {node.metadata.get('title', 'untitled')}")


if __name__ == "__main__":
    main()
