# building-blocks

Pages in this section: 7

## Agent

- URL: https://docs.agentscope.io/building-blocks/agent
- Path: `/building-blocks/agent`
- Index description: A guide to using built-in agents in AgentScope, including ReActAgent, hooks, state management, A2A, and realtime agents.
- Extracted summary: A guide to using built-in agents in AgentScope, including ReActAgent, hooks, state management, A2A, and realtime agents. AgentScope provides several built-in agent types to cover different use cases. Use the cards below to jump to the section you need. The primary agent for tool-using, reasoning, and structured output

## Memory

- URL: https://docs.agentscope.io/building-blocks/context-and-memory
- Path: `/building-blocks/context-and-memory`
- Index description: Practical usage of short-term and long-term memory in AgentScope
- Extracted summary: Practical usage of short-term and long-term memory in AgentScope This document covers practical usage of memory modules in AgentScope, including short-term memory backends and long-term memory integrations. The memory module in AgentScope is responsible for: A **mark** is a string label associated with each message. It

## Hooking Functions

- URL: https://docs.agentscope.io/building-blocks/hooking-functions
- Path: `/building-blocks/hooking-functions`
- Index description: Customize agent behaviors at specific execution points using pre/post hooks
- Extracted summary: Customize agent behaviors at specific execution points using pre/post hooks Hooking functions are extension points that let you customize agent behavior at specific execution points without modifying the agent's core code. Log the agent's internal state, reasoning process, and actions for debugging and analysis. Modify

## Models

- URL: https://docs.agentscope.io/building-blocks/models
- Path: `/building-blocks/models`
- Index description: The details of AgentScope model layer
- Extracted summary: The details of AgentScope model layer This document covers detailed usage examples and provider-specific references for each model class in AgentScope. Text generation, streaming, reasoning, and tools API. Non-realtime and realtime text-to-speech synthesis. Bidirectional WebSocket streaming for voice agents. Vector rep

## Orchestration

- URL: https://docs.agentscope.io/building-blocks/orchestration
- Path: `/building-blocks/orchestration`
- Index description: Detailed usage examples and component references for multi-agent orchestration
- Extracted summary: Detailed usage examples and component references for multi-agent orchestration This document covers detailed usage examples and component references for multi-agent orchestration in AgentScope. ## Orchestration Paradigms AgentScope supports two primary orchestration paradigms for building multi-agent applications: A ce

## RAG

- URL: https://docs.agentscope.io/building-blocks/rag
- Path: `/building-blocks/rag`
- Index description: Retrieval-Augmented Generation in AgentScope
- Extracted summary: Retrieval-Augmented Generation in AgentScope AgentScope provides built-in support for Retrieval-Augmented Generation (RAG). This page demonstrates how to use the RAG module, how to build multimodal knowledge bases, and how to integrate RAG with `ReActAgent` in both agentic and generic manners. AgentScope does not requi

## Tool Capabilities

- URL: https://docs.agentscope.io/building-blocks/tool-capabilities
- Path: `/building-blocks/tool-capabilities`
- Index description: Manage tool functions, middleware, MCP integration, and agent skills with the Toolkit class
- Extracted summary: Manage tool functions, middleware, MCP integration, and agent skills with the Toolkit class AgentScope provides a unified `Toolkit` class to manage all tool-related capabilities, including: ## Tool Functions A tool function is a Python function that: ```python theme={null} def tool_function(a: int, b: str) -> ToolRespo
