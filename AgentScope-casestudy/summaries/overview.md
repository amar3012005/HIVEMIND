# AgentScope Overview

## Scope

This folder captures the live AgentScope docs under `https://docs.agentscope.io/` using the public documentation exports:

- `https://docs.agentscope.io/sitemap.xml`
- `https://docs.agentscope.io/llms.txt`
- `https://docs.agentscope.io/llms-full.txt`
- `https://docs.agentscope.io/api-reference/openapi.json`

Coverage is based on the sitemap plus the Mintlify `llms` exports. The corpus includes 33 documentation pages split into 10 top-level sections.

## Doc Map

- `basic-concepts`: conceptual model for agents, messages, models, tools, and memory.
- `building-blocks`: implementation-facing APIs for agents, hooks, orchestration, RAG, memory, models, and toolkits.
- `quickstart`: minimal install and first runnable agent loop.
- `tutorial`: end-to-end tutorials for research and multi-agent customer support.
- `tune-agent`: model selection, prompt tuning, RL weight tuning, and multi-agent tuning.
- `out-of-box-agents`: packaged agents such as Alias, Browser-use, Deep Research, Data Science, and EvoTraders.
- `deploy-and-serve`: runtime, service abstraction, sandboxing, MCP tool exposure, and deployment targets.
- `observe-and-evaluate`: OpenTelemetry tracing, evaluation runners, metrics, and storage.
- `others`: FAQ and migration/runtime clarifications.
- `index`: the main landing page exported by Mintlify.

## Cross-Cutting Themes

- `Msg` is the universal exchange unit. Agent, tool, and user flows are all described in terms of structured messages rather than ad hoc payloads.
- `reply` and `observe` are the core agent lifecycle hooks. This distinction shows up repeatedly in memory, orchestration, and realtime behavior.
- `Toolkit` is the center of tool integration. Plain Python tools, MCP tools, middleware, and agent skills converge here.
- Memory is treated as a two-part system: short-term session state and long-term persistent retrieval. Context assembly decides what actually reaches model inference.
- AgentScope assumes production concerns early. Observability, evaluation, sandboxing, runtime lifecycle, and deployment are first-class topics rather than afterthoughts.
- Multi-agent work is presented as normal, not advanced edge behavior. Routing, delegation, shared hubs, and peer workflows appear across tutorials and packaged agents.

## Section Syntheses

### Basic Concepts

- `Msg` defines the payload contract: `id`, `name`, `role`, `content`, `timestamp`, and `metadata`, with support for multimodal and tool-related blocks.
- An agent is defined through `reply` and `observe`. `reply` is the ReAct-style reasoning/acting path; `observe` updates state without emitting a response.
- The model layer unifies chat, TTS, realtime, and embeddings across providers. Streaming is described as accumulative rather than delta-based.
- Context is the final inference input; memory is the backing store behind it.
- Tool execution relies on provider tool-calling support rather than a custom AgentScope-only invocation model.

Sources:
- `pages/basic-concepts/*.md`
- `https://docs.agentscope.io/basic-concepts/agent`
- `https://docs.agentscope.io/basic-concepts/msg`
- `https://docs.agentscope.io/basic-concepts/model`
- `https://docs.agentscope.io/basic-concepts/context-and-memory`
- `https://docs.agentscope.io/basic-concepts/tool`

### Building Blocks

- `ReActAgent` is the main implementation anchor, with hooks, session/state management, A2A support, and realtime behavior.
- Hooks can intercept `reply`, `observe`, printing, reasoning, and acting. The docs explicitly warn against recursive self-calls inside hooks.
- Memory APIs distinguish storage from selection. `ReActAgent` exposes different control modes for memory interactions.
- RAG is built from readers, documents, knowledge abstractions, and vector-backed retrieval.
- Orchestration supports master-worker and peer-style workflows, with `MsgHub`, `ChatRoom`, and pipeline primitives for sequencing and concurrency.

Sources:
- `pages/building-blocks/*.md`
- `https://docs.agentscope.io/building-blocks/agent`
- `https://docs.agentscope.io/building-blocks/hooking-functions`
- `https://docs.agentscope.io/building-blocks/context-and-memory`
- `https://docs.agentscope.io/building-blocks/orchestration`
- `https://docs.agentscope.io/building-blocks/rag`
- `https://docs.agentscope.io/building-blocks/tool-capabilities`

### Quickstart and Tutorials

- The shortest path starts with Python 3.10+, package install, and a terminal-oriented `ReActAgent` wired to a `Toolkit`.
- The research assistant tutorial is the clearest staged progression from chat to tool use, short-term memory, long-term memory, and RAG.
- The customer support tutorial is the clearest orchestration example. It teaches routing, delegation, structured outputs, `MsgHub`, and human review hooks.

Sources:
- `pages/quickstart/quickstart.md`
- `pages/tutorial/tutorial_research_agent.md`
- `pages/tutorial/tutorial_sales_agent.md`

### Tune Agent

- The tuner is organized around three modes: model selection, prompt tuning, and model-weights tuning through RL.
- All tuning flows share a strict contract around datasets, workflow functions, and judge functions.
- RL tuning carries the heaviest infrastructure requirements: Linux, NVIDIA GPU, CUDA 12.8+, and Ray.
- Multi-agent tuning treats reward as an episode-level signal while allowing some models to remain frozen.

Sources:
- `pages/tune-agent/*.md`
- `https://docs.agentscope.io/tune-agent/tune-your-first-agent`
- `https://docs.agentscope.io/tune-agent/model-selection-tuning`
- `https://docs.agentscope.io/tune-agent/prompt-tuning`
- `https://docs.agentscope.io/tune-agent/model-weights-tuning`
- `https://docs.agentscope.io/tune-agent/tune-multi-agents`

### Packaged Agents

- `Alias` is the umbrella assistant with multiple operation modes and automatic switching behavior.
- `Alias-Finance` is a rigor-first financial analyst built around hypotheses, verification, and evidence chains.
- `Browser-use` is the browser automation path, built around Playwright MCP and web task decomposition.
- `Data Science` and `DataJuicer Agent` focus on analytical and data-processing workflows with sandboxing and natural-language orchestration.
- `Deep Research` is the clearest packaged research/report generator.
- `EvoTraders` is a memory-driven, self-evolving trading team with backtesting and live trading support.

Sources:
- `pages/out-of-box-agents/*.md`
- `https://docs.agentscope.io/out-of-box-agents/alias`
- `https://docs.agentscope.io/out-of-box-agents/deep-research`
- `https://docs.agentscope.io/out-of-box-agents/browser-use`
- `https://docs.agentscope.io/out-of-box-agents/data-science`
- `https://docs.agentscope.io/out-of-box-agents/datajuicer-agent`
- `https://docs.agentscope.io/out-of-box-agents/evo-trader`

### Deploy, Observe, Evaluate

- `AgentApp` is the core service abstraction in the runtime layer.
- Runtime coverage includes local daemon use, detached process execution, Kubernetes, Knative, Function Compute, and other deployment targets.
- Sandbox usage is split between local and remote. Remote sandboxes are the path for heavier compute and shared infrastructure.
- Observability is OpenTelemetry-based and can emit to AgentScope Studio or third-party OTLP backends.
- Evaluation is benchmark-style and centered on solution functions, metrics, storage, and optional scaling via Ray.

Sources:
- `pages/deploy-and-serve/*.md`
- `pages/observe-and-evaluate/*.md`
- `pages/others/faq.md`

## Practical Implications

- AgentScope is opinionated about contracts. If you integrate it into another system, align around `Msg`, toolkit schemas, and explicit workflow outputs.
- The framework expects operational maturity. Sandboxing, observability, evaluation, and deployment belong in the initial design, not a later phase.
- The clearest adoption path is:
  1. quickstart
  2. basic concepts
  3. building blocks
  4. one tutorial
  5. tuning and runtime layers
- If the goal is packaged capability rather than framework learning, start from `Alias`, `Deep Research`, `Browser-use`, or `Data Science` depending on the task shape.

## Crawl Caveats

- Sitemap coverage is strong, but Mintlify pages can still contain UI-only affordances, tabs, or diagrams whose meaning is only partially preserved in text exports.
- The root landing page is represented in exports as `index`, so the case-study keeps that naming where needed.
- `basic-concepts` and `building-blocks` intentionally overlap. Read the first as architecture and the second as implementation detail.
