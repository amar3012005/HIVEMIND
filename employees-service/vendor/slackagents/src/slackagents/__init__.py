"""SlackAgents package and its key APIs."""

from slackagents.agent.assistant import Assistant
from slackagents.llms.openai import OpenAILLM, BaseLLMConfig


__version__ = "0.0.2"
__all__ = ["Assistant", "OpenAILLM", "BaseLLMConfig"]
