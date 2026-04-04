---
title: "Tool"
url: "https://docs.agentscope.io/basic-concepts/tool"
path: "/basic-concepts/tool"
section: "basic-concepts"
lastmod: "2026-03-30T04:05:56.977Z"
---
# Tool
Source: https://agentscope-ai-786677c7.mintlify.app/basic-concepts/tool

Bridge your agent with the real world.

Tools bridge your agent with the real world, enabling it to execute code, search the web, call external APIs, and more. AgentScope supports three categories of tools:

<CardGroup>
  <Card title="Native Python Functions" icon="python">
    Wrap any Python function as a tool using the `Toolkit` class with automatic JSON schema generation.
  </Card>

  <Card title="MCP Server" icon="server">
    Connect to Model Context Protocol (MCP) servers to access a wide ecosystem of external tools.
  </Card>

  <Card title="Agent Skills" icon="puzzle-piece">
    Reusable, composable skill modules that encapsulate higher-level agent capabilities.
  </Card>
</CardGroup>

<Info>
  AgentScope delegates tool invocation entirely to LLM provider APIs (OpenAI, Anthropic, Google Gemini, DashScope). Structured output parsing and tool-calling logic happen on the model inference side, not within the framework itself. AgentScope focuses on providing a seamless interface for defining and integrating tools.
</Info>
