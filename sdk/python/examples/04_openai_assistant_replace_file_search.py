"""Replace OpenAI Assistants `file_search` with HIVEMIND retrieval in 12 lines.

Install:
    pip install "hivemind-sdk[openai]"

Run:
    HIVEMIND_API_KEY=hmk_live_...  OPENAI_API_KEY=sk-...  python 04_openai_assistant_replace_file_search.py
"""

import os
import time

from openai import OpenAI

from hivemind import HiveMind
from hivemind.integrations.openai_assistants import build_assistant_kwargs, handle_tool_call


def main():
    client = OpenAI()
    hm = HiveMind(api_key=os.environ["HIVEMIND_API_KEY"])

    # Create assistant — HIVEMIND retrieval baked in via tool spec.
    assistant = client.beta.assistants.create(**build_assistant_kwargs(
        name="EU AI Act Compliance Bot",
        model="gpt-4o",
        instructions_extra="Always answer in 3-5 bullet points.",
    ))

    thread = client.beta.threads.create()
    client.beta.threads.messages.create(
        thread_id=thread.id,
        role="user",
        content="What are the EU AI Act deadlines for high-risk AI systems?",
    )
    run = client.beta.threads.runs.create(thread_id=thread.id, assistant_id=assistant.id)

    while run.status in ("queued", "in_progress", "requires_action"):
        if run.status == "requires_action":
            outputs = [
                handle_tool_call(call, hm)
                for call in run.required_action.submit_tool_outputs.tool_calls
            ]
            run = client.beta.threads.runs.submit_tool_outputs(
                thread_id=thread.id, run_id=run.id, tool_outputs=outputs
            )
        else:
            time.sleep(0.5)
            run = client.beta.threads.runs.retrieve(thread_id=thread.id, run_id=run.id)

    # Print final answer
    msgs = client.beta.threads.messages.list(thread_id=thread.id, order="desc", limit=1)
    print(msgs.data[0].content[0].text.value)


if __name__ == "__main__":
    main()
