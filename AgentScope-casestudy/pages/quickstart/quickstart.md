---
title: "Quickstart"
url: "https://docs.agentscope.io/quickstart"
path: "/quickstart"
section: "quickstart"
lastmod: "2026-03-30T04:06:01.138Z"
---
# Quickstart
Source: https://agentscope-ai-786677c7.mintlify.app/quickstart

Start building agent in 5 minutes

## Installation

AgentScope requires Python 3.10 or higher. You can install from source or pypi.

### From PyPI

```bash theme={null}
uv pip install agentscope
# or
# pip install agentscope
```

### From Source

To install AgentScope from source, you need to clone the repository from
GitHub and install by the following commands

```bash theme={null}
git clone -b main https://github.com/agentscope-ai/agentscope
cd agentscope
pip install -e .
```

To ensure AgentScope is installed successfully, check via executing the following code:

```python theme={null}
import agentscope

print(agentscope.__version__)
```

## Extra Dependencies

To satisfy the requirements of different functionalities, AgentScope provides
extra dependencies that can be installed based on your needs.

* full: Including extra dependencies for model APIs and tool functions
* dev: Development dependencies, including testing and documentation tools

For example, when installing the full dependencies, the installation command varies depending on your operating system.

* For Windows users:

```bash theme={null}
pip install agentscope[full]
```

* For Mac and Linux users:

```bash theme={null}
pip install agentscope\[full\]
```

## Simple Example

Here is a simple example of interacting with an agent in the terminal:

```python theme={null}
import asyncio
import os

from agentscope.agent import ReActAgent, UserAgent
from agentscope.formatter import DashScopeChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import DashScopeChatModel
from agentscope.tool import (
    Toolkit,
    execute_shell_command,
    execute_python_code,
    view_text_file,
)


async def main() -> None:
    """The main entry point for the ReAct agent example."""
    toolkit = Toolkit()

    toolkit.register_tool_function(execute_shell_command)
    toolkit.register_tool_function(execute_python_code)
    toolkit.register_tool_function(view_text_file)

    agent = ReActAgent(
        name="Friday",
        sys_prompt="You are a helpful assistant named Friday.",
        model=DashScopeChatModel(
            api_key=os.environ.get("DASHSCOPE_API_KEY"),
            model_name="qwen3.5-plus",
            enable_thinking=False,
            stream=True,
            multimodality=True
        ),
        formatter=DashScopeChatFormatter(),
        toolkit=toolkit,
    )

    user = UserAgent("User")

    msg = None
    while True:
        msg = await user(msg)
        if msg.get_text_content() == "exit":
            break
        msg = await agent(msg)

asyncio.run(main())
```
