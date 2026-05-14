# Universal Memory Adapter — Remaining Work

**Status:** ~70% shipped. Core SDKs + integrations + OpenAPI live on main.
**Owner:** amar
**Last updated:** 2026-05-14

---

## 1. What's already shipped

| Item | Location | Status |
|---|---|---|
| Python SDK core (sync + async) | `sdk/python/hivemind/{client,models}.py` | ✅ |
| LangChain retriever | `sdk/python/hivemind/integrations/langchain.py` | ✅ |
| LlamaIndex retriever | `sdk/python/hivemind/integrations/llamaindex.py` | ✅ |
| OpenAI Assistants `file_search` drop-in | `sdk/python/hivemind/integrations/openai_assistants.py` | ✅ |
| Anthropic Claude tool-use | `sdk/python/hivemind/integrations/anthropic.py` | ✅ |
| Vercel AI SDK tool wrapper (JS) | `sdk/src/integrations/vercel-ai-sdk.js` | ✅ |
| OpenAPI 3.0 spec | `docs/openapi.yaml` | ✅ |
| 6 hello-world examples | `sdk/python/examples/01-05`, `sdk/examples/vercel-ai-sdk.ts` | ✅ |
| MCP server | `core/src/mcp/hosted-service.js` | ✅ (pre-existing) |
| JS SDK basics | `sdk/src/index.js` | ✅ (pre-existing) |
| Python SDK README + competitive table | `sdk/python/README.md` | ✅ |

---

## 2. Remaining work

### P0 — Required to publicly ship (~2 days total)

| Item | Effort | Why blocking |
|---|---|---|
| Publish `hivemind-sdk` to PyPI | 1h | Devs can't `pip install` until published |
| Bump + publish `@hivemind/sdk` to npm | 1h | Same — `npm install` |
| Integration tests against staging API | 4h | Catch breaking API changes |
| API docs site (Mintlify or Docusaurus from `docs/openapi.yaml`) | 4h | Public marketing surface |
| Landing page at `hivemind.davinciai.eu/sdk` | 4h | Public entry point with quickstart |

**Outcome:** anyone can `pip install hivemind-sdk` and follow docs to integrate.

### P1 — Enterprise polish (~4 days total)

| Item | Effort | Impact |
|---|---|---|
| Streaming search SSE (`/api/search/stream`) | 4h | Long retrieval results stream-first vs wait-and-dump |
| Webhook subscribe (`memory.created`, `.updated`, `.deleted`) | 1d | Push integration — customer systems react to memory changes |
| Scoped API keys (`memory:read:project=eu-ai-act`) | 4h | RBAC, compliance, principle of least privilege |
| Tool-use audit log per retrieval | 2h | SOC2/ISO27001 requirement |
| Citation format standardized in retrieval responses | 2h | LLM trust signal, easier prompt engineering |
| Rate-limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) | 2h | SDK auto-backoff |
| Retry + exponential backoff in SDKs | 2h | Production hardening |

**Outcome:** safe to charge $50/seat enterprise tier. Streaming + webhooks + scoped keys are table stakes.

### P2 — Multi-language reach (~5 days total)

| Item | Effort |
|---|---|
| Go SDK (codegen from `docs/openapi.yaml` via `oapi-codegen`) | 1d |
| Java SDK (codegen via `openapi-generator`) | 1d |
| .NET SDK (codegen via NSwag) | 1d |
| Rust SDK (codegen via `openapi-generator`) | 1d |
| GraphQL endpoint mirror (`/api/graphql`) | 1d |

**Outcome:** opens enterprise market beyond Python/JS.

### P3 — Ecosystem / distribution (~10 days total)

| Item | Effort |
|---|---|
| LangChain Hub listing | 1d |
| LlamaHub listing | 1d |
| MCP listing in Anthropic registry | 1d |
| Vercel Marketplace integration | 2d |
| Continue.dev / Cursor / Cline plugin | 3d |
| Zapier app (no-code integration) | 2d |
| n8n custom node | 1d |

**Outcome:** distribution flywheel — HIVEMIND shows up in every dev/no-code marketplace.

---

## 3. Recommended sequencing

| Stage | Days | Output |
|---|---|---|
| **Stage 1: Publish + docs (P0)** | 2 | `pip install hivemind-sdk` works, public landing live |
| **Stage 2: Enterprise polish (P1)** | 4 | Streaming + webhooks + scoped keys + audit |
| **Stage 3: Multi-language (P2)** | 5 | Go/Java/.NET/Rust SDKs |
| **Stage 4: Ecosystem (P3)** | 10 | Plugins, marketplaces, listings |
| **Total to "fully shipped"** | **~21 days** | |

## 4. Minimum viable

- **P0 only:** 2 days → public, installable, demoable. Enough for first enterprise pilots.
- **P0 + P1:** 6 days → safe to charge enterprise tier.

## 5. Suggested next ship order (when we come back to this)

1. **PyPI + npm publish** (2h) → makes everything real
2. **Scoped API keys + audit log** (6h) → unblocks enterprise sales
3. **Streaming search SSE** (4h) → demo wow factor
4. **Docs site from `docs/openapi.yaml`** (4h) → marketing
5. **Webhooks** (1d) → integration locks customers in

That sequence = ~3 days work → "files in repo" to "enterprise pitch-ready".

## 6. Publishing commands (reference)

```bash
# PyPI
cd sdk/python
python -m build
twine upload dist/*

# npm
cd sdk
npm version minor
npm publish --access public

# OpenAPI docs site (Mintlify)
npx mintlify init
# Point at docs/openapi.yaml
```

## 7. Related files

- Plan: `docs/UNIVERSAL_MEMORY_ADAPTER_TODO.md` (this file)
- Grand strategy: ship order in this doc maps to "Layer 3 — AI surface" from earlier company-brain discussion
- Backend foundation: Redis cache + tenant gate + Prisma pool tuning shipped (`core/src/memory/{graph-cache,tenant-gate}.js`, `core/src/db/prisma.js`) — handles 1000-tenant load
