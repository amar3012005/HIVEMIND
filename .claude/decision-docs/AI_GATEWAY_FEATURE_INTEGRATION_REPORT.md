# Cloudflare AI Gateway — HIVE-MIND Feature Integration Report

Date: 2026-08-16

## Decision

Cloudflare AI Gateway is the primary HTTP transport for server-owned generative
model calls. Model selection remains owned by each workload. The Gateway does
not change retrieval, prompts, tool authorization, approval gates, tenant scope,
or response schemas.

Provider credentials use stored BYOK aliases when configured. During migration,
Cloudflare's documented provider-passthrough contract is used: the provider key
is sent to the authenticated Gateway endpoint alongside `cf-aig-authorization`.
Tenant-bearing inference requests set `cf-aig-skip-cache: true`; semantic/server
cache policy remains separate and tenant-scoped.

Disabling `CLOUDFLARE_AI_GATEWAY_ENABLED` is the explicit direct-provider
rollback. Gateway mode does not silently retry a failed request directly.

## Page-by-page coverage

| HIVE-MIND page | AI workload | Runtime | Gateway result |
|---|---|---|---|
| Overview / Talk to HIVE | intent, query rewrite, grounded synthesis, tool planning | Core | Primary, including SSE chat |
| Connectors | OAuth and provider operations | Core / Composio / Nango | No server LLM in the page; connected-app execution remains provider-authorized |
| Memories | distillation, conflict resolution, entity and relationship enrichment | Core | Primary |
| AI Meeting Notes | segment extraction, insights and final report synthesis | Core | Primary; STT is classified separately below |
| Memory Graph | entity linking, relationship inference and cognition | Core | Primary |
| Knowledge Base | document classification, claim extraction, vision interpretation | Core | Primary |
| Workspace Admin | members, teams, projects, invitations | Control Plane | No LLM for CRUD/authorization operations |
| Cognitive Layer | cognition proposals, verification, resident analysis | Core | Primary |
| Web Intel / Deep Research | research planning and synthesis | Core / Employees | Primary |
| Web Search / Web Crawl | provider search and browser retrieval | Core / Employees | Retrieval is not an LLM call; any synthesis is Gateway-primary |
| HyperAgents / Rooms | director, debate, verification and final synthesis | Employees | Primary for direct HTTP and AgentScope model clients |
| TARA | strategist, opening plan and direct answer generation | TARA Deepgram / Core | Primary, including streamed direct answers |
| MCP Server | tool registration and configuration | Core | No LLM in the page itself; downstream chat/tool planning is covered by Talk to HIVE |
| Profile / Usage / Billing / Settings | account and billing operations | Control Plane | No LLM |

## Transport coverage

- Node/Core and Control Plane use `cloudflare-gateway.js` as the credential and
  URL boundary. Legacy Groq-shaped text calls resolve through the canonical
  model router. Raw supported provider calls, including multipart inference,
  no longer bypass Gateway merely because the body is not replayable.
- Enterprise ingestion's explicit `node-fetch` client is wired directly to the
  Gateway helper, so it does not depend on the Core entrypoint's global fetch
  wrapper.
- The legacy `GroqClient` used by fact extraction, observer and reflector is
  wired directly to the same helper.
- Employees has a Python transport shared by the HyperAgent engine, Hyper Rooms
  web-intelligence synthesis and AgentScope OpenAI-compatible clients.
- TARA Deepgram has a Python transport for router, opening planner and streamed
  direct-answer inference.

## Security and isolation

- Stored BYOK aliases remove the upstream `Authorization` header before the
  request reaches Gateway.
- Provider passthrough is used only when the provider has no stored alias and is
  sent only to the authenticated Cloudflare Gateway hostname.
- Provider keys and Gateway tokens are never returned to the browser, persisted
  in traces, or committed to git.
- Gateway caching is disabled for tenant-bearing prompts. Existing tenant-aware
  recall/projection caches remain the only cache authority.
- Gateway failure does not trigger a second direct-provider execution. This
  prevents double billing, duplicate tool effects and data-egress ambiguity.

## Intentional non-LLM and protocol exceptions

- Qdrant, PostgreSQL, Redis, Nango, Composio, Tavily and browser calls are not
  model inference and do not go through AI Gateway.
- User-connected Gemini is a connector tool executed with user authorization,
  not a HIVE-MIND-owned model call.
- TARA realtime media WebSockets remain on their realtime provider protocol.
  Ordinary TARA HTTP planning/synthesis is Gateway-primary.
- Embedding and external cross-encoder reranking are retrieval infrastructure,
  not chat-generation calls. They keep their existing endpoints until a
  separately benchmarked migration proves vector identity and ranking parity.
- Provider catalog, connection-management and billing-control endpoints remain
  direct because Gateway proxies inference, not provider control planes.

## Verification gates

1. Unit tests must prove URL rewriting, stored-key header isolation, provider
   passthrough, one-shot multipart routing, streaming, and no direct retry.
2. Core, Employees and TARA syntax/import tests must pass.
3. Production canaries must cover Overview chat SSE, Knowledge Base extraction,
   Meeting Notes synthesis, one HyperAgent room, Web Intel synthesis and TARA
   planning.
4. Fresh logs must contain no direct-provider fallback, missing alias, malformed
   stream, duplicate execution or tenant-scope errors.
5. The immutable image SHA and rollback image are recorded in the release ledger.
