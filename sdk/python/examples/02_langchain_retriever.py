"""LangChain RAG with HIVEMIND as the retriever.

Install:
    pip install "hivemind-sdk[langchain]" langchain-anthropic
"""

import os

from langchain_anthropic import ChatAnthropic
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableParallel, RunnablePassthrough

from hivemind import HiveMind
from hivemind.integrations.langchain import HiveMindRetriever


def format_docs(docs):
    return "\n\n".join(
        f"[source: {d.metadata['source']}] {d.metadata['title']}\n{d.page_content}"
        for d in docs
    )


def main():
    hm = HiveMind(api_key=os.environ["HIVEMIND_API_KEY"])
    retriever = HiveMindRetriever(hm=hm, k=5, scope="team")

    llm = ChatAnthropic(model="claude-sonnet-4-5", max_tokens=1024)
    prompt = ChatPromptTemplate.from_template(
        """Answer using ONLY the context below. Cite the source memory id in [brackets].
If the context doesn't contain the answer, say so honestly.

Context:
{context}

Question: {question}
"""
    )

    chain = (
        RunnableParallel({"context": retriever | format_docs, "question": RunnablePassthrough()})
        | prompt
        | llm
        | StrOutputParser()
    )

    answer = chain.invoke("What did we decide about EU AI Act compliance?")
    print(answer)


if __name__ == "__main__":
    main()
