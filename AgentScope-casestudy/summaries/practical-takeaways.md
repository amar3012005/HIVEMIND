# Practical Takeaways

## If You Want To Learn AgentScope Quickly

1. Read `pages/quickstart/quickstart.md`.
2. Read `pages/basic-concepts/msg.md`, `pages/basic-concepts/agent.md`, and `pages/basic-concepts/tool.md`.
3. Read `pages/building-blocks/agent.md`, `pages/building-blocks/orchestration.md`, and `pages/building-blocks/tool-capabilities.md`.
4. Pick one tutorial:
   `pages/tutorial/tutorial_research_agent.md` for memory and RAG.
   `pages/tutorial/tutorial_sales_agent.md` for multi-agent routing.

## If You Want To Build On Top Of It

- Keep your internal contract aligned with `Msg` and explicit workflow outputs.
- Treat `Toolkit` as the integration boundary for Python tools, MCP servers, middleware, and skills.
- Decide early whether memory is agent-controlled or orchestrator-controlled.
- Design around accumulative streaming rather than delta streaming.
- Avoid hiding runtime concerns. AgentScope expects tracing, evaluation, and sandboxing to be part of the design.

## If You Want To Deploy It

- Start from `AgentApp` and runtime lifecycle examples in `pages/deploy-and-serve/agent-as-service.md`.
- Use remote sandboxes when compute isolation, multi-user reuse, or Kubernetes-backed scaling matters.
- Keep sandbox-tested actions inside the sandbox. The docs explicitly warn against replaying them on the host.
- Treat observability as mandatory. OpenTelemetry support is a core path, not an add-on.

## If You Want To Tune It

- Use model selection first when the question is “which model should run this workflow?”
- Use prompt tuning when you want fast iteration without touching model weights.
- Use RL tuning only when you actually have the GPU stack, Linux runtime, and enough evaluation discipline to justify it.
- For multi-agent systems, expect reward and workflow definitions to move from single-response quality to episode-level outcomes.

## Main Constraints To Keep In Mind

- Several features depend on provider behavior, especially tool-calling and some streaming semantics.
- Text exports capture most of the docs, but diagrams and UI-only blocks may still hold nuance not visible in plain text.
- Some sections overlap by design. `basic-concepts` explains the mental model; `building-blocks` explains the concrete APIs.

Sources:
- `summaries/overview.md`
- `pages/deploy-and-serve/agent-as-service.md`
- `pages/deploy-and-serve/sandbox-and-tool.md`
- `pages/observe-and-evaluate/observability.md`
- `pages/observe-and-evaluate/evaluation.md`
