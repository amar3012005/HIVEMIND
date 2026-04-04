# AgentScope Case Study

Generated from the live AgentScope docs exports on 2026-04-03.

## Included Artifacts

- `raw/`: original crawled exports from the documentation site.
- `inventory/`: sitemap-derived URL inventory and generated manifest.
- `pages/`: one markdown file per documentation page.
- `summaries/`: section-level indexes, curated briefings, and comparison notes.

## Coverage

- Pages captured from sitemap: `33`
- Top-level sections: `10`

## Section Counts

- `basic-concepts`: 5
- `building-blocks`: 7
- `deploy-and-serve`: 2
- `index`: 1
- `observe-and-evaluate`: 2
- `others`: 1
- `out-of-box-agents`: 7
- `quickstart`: 1
- `tune-agent`: 5
- `tutorial`: 2

## Start Here

- `summaries/overview.md`: best single entry point for the full case study.
- `summaries/agent-matrix.md`: packaged agent comparison and best-fit guide.
- `summaries/practical-takeaways.md`: integration, runtime, tuning, and evaluation notes.
- `summaries/model-and-context.md`: model, memory, RAG, and retrieval navigation.
- `summaries/conversation-and-orchestration.md`: routing, handoffs, debate, and pipelines.
- `summaries/agent-runtime.md`: runtime agent capabilities, hooks, sessions, A2A, and skills.
- `summaries/features.md`: observability, evaluation, embeddings, TTS, and tuning.

## Source Endpoints

- Sitemap: `https://docs.agentscope.io/sitemap.xml`
- Index export: `https://docs.agentscope.io/llms.txt`
- Full export: `https://docs.agentscope.io/llms-full.txt`
- OpenAPI: `https://docs.agentscope.io/api-reference/openapi.json`

## Rebuild

- Generator script: `scripts/build_agentscope_casestudy.py`

See `summaries/overview.md` for the synthesized briefing.
