# Chat Tool-Router Benchmarks

Classification-only benchmarks for the HIVEMIND chat planner. They never execute recall, memory writes, connector actions, or tenant APIs.

## Runs

```bash
CEREBRAS_API_KEY=... node benchmarks/tool-routing/cerebras-progressive-benchmark.mjs

OPENROUTER_API_KEY=... \
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1 \
node benchmarks/tool-routing/gemini-production-router-benchmark.mjs
```

The Cerebras benchmark evaluates six progressively disclosed capability groups. The Gemini benchmark evaluates the same 30 prompts against the narrower four-tool production router schema.

## Safety

- Credentials are read from environment variables and are never written to results.
- Connector and write prompts test tool selection only.
- Results are JSONL so individual failures and aggregate latency/token metrics remain auditable.

## Latest comparison

| Router | Desired accuracy | Average latency | p95 latency | Average tokens |
|---|---:|---:|---:|---:|
| Cerebras progressive six-tool router | 96.7% | 779 ms | 1,548 ms | 1,346 |
| Gemini 2.5 Flash Lite with production four-tool schema | 53.3% | 2,468 ms | 9,102 ms | 465 |

Gemini's production-schema score includes seven desired capabilities the current schema cannot express. Among the 23 schema-supported cases, it selected the expected route in 16 cases (69.6%).
