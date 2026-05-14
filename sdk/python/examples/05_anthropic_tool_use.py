"""Claude tool-use loop with HIVEMIND.

Install:
    pip install "hivemind-sdk[anthropic]"
"""

import os

from anthropic import Anthropic

from hivemind import HiveMind
from hivemind.integrations.anthropic import HIVEMIND_TOOL_DEF, handle_tool_use


def main():
    client = Anthropic()
    hm = HiveMind(api_key=os.environ["HIVEMIND_API_KEY"])

    messages = [
        {"role": "user", "content": "What did we decide about pricing in Q2? Cite sources."}
    ]

    while True:
        resp = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            tools=[HIVEMIND_TOOL_DEF],
            messages=messages,
        )

        if resp.stop_reason != "tool_use":
            # Final answer
            for block in resp.content:
                if hasattr(block, "text"):
                    print(block.text)
            break

        # Execute tool call(s)
        tool_results = []
        for block in resp.content:
            if block.type == "tool_use":
                tool_results.append(handle_tool_use(block, hm))

        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content": tool_results})


if __name__ == "__main__":
    main()
