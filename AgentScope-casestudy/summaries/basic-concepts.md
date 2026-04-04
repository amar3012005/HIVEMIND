# basic-concepts

Pages in this section: 5

## Agent

- URL: https://docs.agentscope.io/basic-concepts/agent
- Path: `/basic-concepts/agent`
- Index description: An agent should be able to think and act.
- Extracted summary: An agent should be able to think and act. In AgentScope, an agent is an **independent** entity that can receive outside information, process it, and take actions to achieve specific goals. To achieve this, an agent is abstracted into two main methods: During the `reply` process, the agent reasons based on the current s

## Context and Memory

- URL: https://docs.agentscope.io/basic-concepts/context-and-memory
- Path: `/basic-concepts/context-and-memory`
- Index description: Background about Context and Memory
- Extracted summary: Background about Context and Memory This document introduces how AgentScope handles context and memory in agent workflows. For implementation details and APIs, see [Context and Memory](/building-blocks/context-and-memory). *** ## Why It Matters Without memory, an agent treats every turn as a new conversation. With memo

## Model

- URL: https://docs.agentscope.io/basic-concepts/model
- Path: `/basic-concepts/model`
- Index description: The main concepts of AgentScope model layer
- Extracted summary: The main concepts of AgentScope model layer AgentScope provides unified async abstractions for various AI models across different providers: Core text generation with reasoning, streaming, and tools API support. Convert text to speech with realtime and non-realtime options. Bidirectional WebSocket streaming for low-lat

## Message

- URL: https://docs.agentscope.io/basic-concepts/msg
- Path: `/basic-concepts/msg`
- Index description: The basic data structure in AgentScope
- Extracted summary: The basic data structure in AgentScope Message (`Msg`) is the basic data structure in AgentScope, responsible for exchanging information among agents, users, and tools. Its basic fields include: The `content` field can be a plain string for simple text messages, or a list of content blocks for multimodal and tool call

## Tool

- URL: https://docs.agentscope.io/basic-concepts/tool
- Path: `/basic-concepts/tool`
- Index description: Bridge your agent with the real world.
- Extracted summary: Bridge your agent with the real world. Tools bridge your agent with the real world, enabling it to execute code, search the web, call external APIs, and more. AgentScope supports three categories of tools: Wrap any Python function as a tool using the `Toolkit` class with automatic JSON schema generation. Connect to Mod
