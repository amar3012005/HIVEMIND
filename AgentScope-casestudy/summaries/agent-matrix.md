# Packaged Agent Matrix

| Agent | Best Fit | Core Pattern | Main Dependencies | Notes |
| --- | --- | --- | --- | --- |
| `Alias` | General-purpose assistant and router | Mode switching across specialized sub-modes | AgentScope runtime, RAG, MCP, private knowledge base | Best umbrella entry point into packaged agents |
| `Alias-Finance` | Deep financial analysis | Hypothesis, evidence gathering, verification, reporting | Financial tools, tree search, visualization | High rigor and explainability emphasis |
| `Browser-use` | Browser automation and web tasks | Reasoning plus observation plus browser actions | Playwright MCP, Node/npm, DashScope | Designed for multi-step web execution, not just single actions |
| `Data Science` | Analytics and modeling workflows | Natural-language orchestration of end-to-end DS pipeline | Docker, sandboxed execution, DashScope | Covers acquisition, cleaning, modeling, visualization, reporting |
| `DataJuicer Agent` | Data processing through natural language | Multi-agent routing across DJ operators | Data-Juicer, MCP or CLI integration | MCP mode is the stronger long-term integration path |
| `Deep Research` | Multi-source research and report generation | Decomposition, deep search, reflection, synthesis | Tavily MCP, DashScope, Node/npm | Closest packaged match for a research assistant |
| `EvoTraders` | Trading and strategy evolution | Multi-agent analyst team plus memory-driven reflection | Repo-based setup, market tooling, visualization | Most domain-specific packaged system in the set |

## Fast Selection Guide

- Use `Alias` if you want one adaptable assistant rather than a narrow single-purpose agent.
- Use `Deep Research` if the main output is a synthesized report.
- Use `Browser-use` if the work depends on interacting with websites step by step.
- Use `Data Science` if the task is analytical and file-heavy.
- Use `DataJuicer Agent` if the real problem is data processing orchestration.
- Use `Alias-Finance` or `EvoTraders` only when the financial domain requirements are central.

Sources:
- `https://docs.agentscope.io/out-of-box-agents/alias`
- `https://docs.agentscope.io/out-of-box-agents/alias-finance`
- `https://docs.agentscope.io/out-of-box-agents/browser-use`
- `https://docs.agentscope.io/out-of-box-agents/data-science`
- `https://docs.agentscope.io/out-of-box-agents/datajuicer-agent`
- `https://docs.agentscope.io/out-of-box-agents/deep-research`
- `https://docs.agentscope.io/out-of-box-agents/evo-trader`
