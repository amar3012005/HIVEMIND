# HIVE-MIND Final Go-Live Checklist

**Target:** Enterprise memory engine for cross-platform AI agents  
**Usage:** Work top-down. Do not move to the next priority block until all mandatory items in the current block are `PASS`.  
**Updated:** 2026-03-13

## What We Are Building

HIVE-MIND must operate as three connected layers:

1. **Connectors**
Ingest source data from Gmail, codebases, chat sessions, docs, tickets, and other systems.

2. **Memory Engine**
Store normalized memory objects with `source`, `org_id`, `user_id`, `project`, timestamps, permissions, relationships, and versioning.

3. **Retrieval and Tool Layer**
Inject scoped, relevant context into Claude, GPT, Gemini, Cursor, and internal agents through APIs, MCP, and recall flows.

## Final Definition Of Done

HIVE-MIND is enterprise-ready only when it can:

- ingest data from at least one external business system and one code source
- preserve tenant, project, and user boundaries for every stored memory
- return accurate, specific, scoped context to multiple AI platforms
- support tool-driven retrieval without leaking unrelated or private context
- survive production failures with monitoring, backup, restore, and auditability

## Current Program State

The platform is no longer at "basic memory API" stage. It already has:

- persisted memory writes and recall on Postgres/Prisma
- Qdrant-backed vector retrieval in the live stack
- MCP-native client access for Claude/Codex/Antigravity
- async ingestion pipeline with connector support
- webapp middleware for ChatGPT/Gemini-style wrappers

The highest-value gap is now **memory correctness**, not raw ingestion breadth.
The next implementation order is:

1. explicit `Updates` / `Extends` / `Derives` persistence
2. version history plus current-state queries
3. graph expansion in recall

---

## Priority 0 - Core Stability

**Expectation:** The platform starts reliably, tests are trustworthy, and local/docker workflows are reproducible.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| API server boots cleanly in Docker on the canonical port | Backend Lead | P0 |  | `docker compose ps` and `/health` |
| Core tests are green or explicitly quarantined with rationale | QA Lead | P0 |  | CI report and failing test list |
| No broken imports, dependency mismatches, or dead startup paths | Backend Lead | P0 |  | startup logs and `node --check` |
| Local stack is reproducible with one documented command | Platform Engineer | P0 |  | local runbook |
| Retrieval endpoints return consistent results for stored memories | Backend Lead | P0 |  | curl or integration test output |

---

## Priority 1 - Security And Data Boundaries

**Expectation:** No enterprise customer will trust the system until isolation, auth, and secret handling are defensible.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| All hardcoded API keys and secrets removed from repo | Security Engineer | P0 |  | secret scan report |
| Exposed keys rotated and revoked | Security Engineer | P0 |  | rotation record |
| Every memory is scoped by `org_id`, `user_id`, and `project` | Backend Lead | P0 |  | schema and endpoint tests |
| Retrieval filters are applied before ranking, not after | Backend Lead | P0 |  | search implementation review |
| API key and OAuth flows support revoke, expiry, and last-used tracking | Backend Lead | P0 |  | auth tests |
| Audit logging exists for memory read, write, delete, and auth events | Compliance Lead | P0 |  | audit trail samples |

---

## Priority 2 - Memory Engine Correctness

**Expectation:** This must be more than generic RAG. It needs memory behavior, not just chunk search.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| Normalized memory schema is defined and enforced | Backend Lead | P0 |  | schema and validation tests |
| Explicit `Updates`, `Extends`, and `Derives` edges are persisted for real save/ingest flows, not only engine internals | Backend Lead | P0 |  | integration test proving stored relationship rows |
| `Updates` transitions are atomic: old node `is_latest = false`, new node latest, edge written in same transaction | Backend Lead | P0 |  | transaction test and row snapshots |
| `Extends` keeps both memories latest and preserves lineage to the root memory | Backend Lead | P0 |  | golden-set tests |
| `Derives` is threshold-guarded and asynchronous, not speculative inline ingest behavior | ML Engineer | P0 |  | derive worker test and confidence threshold logs |
| Version history is preserved for changed facts and queryable as a timeline | Backend Lead | P0 |  | state mutation tests |
| "Current state" queries default to latest truth and can optionally include history | Backend Lead | P0 |  | `/api/memories/query` examples and tests |
| Temporal fields distinguish record time vs event time | Backend Lead | P1 |  | API examples and tests |
| Source metadata is attached to every ingested memory | Backend Lead | P0 |  | stored memory examples |
| Code ingestion preserves AST/scope metadata where applicable | ML Engineer | P1 |  | code ingestion test set |
| Golden tests exist for the exact Priority 2 enterprise patterns: chronological audit, refinement, provenance, and code structure | QA Lead | P0 |  | golden test suite |

---

## Priority 3 - Connectors

**Expectation:** The platform must ingest from real enterprise sources, not just manual POSTs.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| Gmail connector design finalized with OAuth scopes and sync rules | Integrations Lead | P0 |  | connector spec |
| Gmail ingestion stores thread, sender, labels, timestamps, and permissions | Integrations Lead | P1 |  | sample ingested memories |
| Codebase connector can index at least one repo end-to-end | ML Engineer | P0 |  | ingestion report for a real repo |
| Chat/session connector captures Claude or agent session summaries | Integrations Lead | P1 |  | stored session examples |
| Connector deduplication and update rules are defined | Backend Lead | P0 |  | dedupe policy doc |
| Connector failures are retryable and observable | Platform Engineer | P1 |  | retry logs and alerting |

---

## Priority 4 - Retrieval And Context Injection

**Expectation:** Different platforms must get the right context for the right question, with no leakage.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| `/api/recall` returns specific, query-relevant memories | Backend Lead | P0 |  | retrieval eval set |
| Retrieval uses hybrid lexical + vector + graph + policy ranking in production path | Backend Lead | P0 |  | retrieval implementation review and live eval |
| Graph expansion pulls supporting memories from `Updates` / `Extends` / `Derives` around strong seed hits | ML Engineer | P0 |  | recall trace output and tests |
| Current-state queries prefer latest version by default and exclude deprecated conflicts unless history is requested | Backend Lead | P0 |  | recall and query tests |
| Context injection format is stable across clients | Backend Lead | P0 |  | API contract examples |
| Claude, GPT, Gemini, and internal agents can all consume the same recall contract | Integrations Lead | P1 |  | client integration demos |
| MCP tools/resources expose memory safely and consistently | Backend Lead | P1 |  | MCP contract tests |
| Tool calls can request scoped context by source, project, or role | Backend Lead | P1 |  | tool parameter tests |
| Retrieval quality is measured on real enterprise-like queries | ML Engineer | P0 |  | precision/recall eval |
| Retrieval traces expose why a memory was included: lexical, vector, graph, policy, and provenance data | Backend Lead | P1 |  | debug trace examples |

---

## Priority 5 - LLM Integration

**Expectation:** The memory engine must not stop at retrieval. It must support grounded generation using approved models.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| Groq inference path is configured and tested | Backend Lead | P0 |  | successful generation call |
| Chosen production model is documented by use case | ML Engineer | P0 |  | model selection matrix |
| Grounded generation uses recall output, not raw unfiltered memory dumps | ML Engineer | P0 |  | prompt assembly review |
| Model fallback policy is defined for outages or rate limits | Backend Lead | P1 |  | fallback runbook |
| Prompt injection and unsafe memory handling are tested | Security Engineer | P1 |  | red-team report |

---

## Priority 6 - Reliability And Operations

**Expectation:** Enterprise deployment requires visibility, recovery, and predictable behavior under load.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| API, Postgres, Qdrant, and connector jobs have health checks | SRE Lead | P0 |  | monitoring dashboard |
| Metrics and alerts cover error rate, latency, auth failures, and sync lag | SRE Lead | P0 |  | alert config |
| Backup and restore tested for Postgres and Qdrant | SRE Lead | P0 |  | restore drill |
| Load tests cover retrieval, recall, and connector ingestion | Performance Engineer | P1 |  | benchmark report |
| Incident runbooks exist for auth, data corruption, and retrieval degradation | SRE Lead | P1 |  | runbook links |

---

## Priority 7 - Compliance And Enterprise Readiness

**Expectation:** Regulated customers need clear answers about governance and data handling.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| GDPR export and erasure workflows are tested | Compliance Lead | P0 |  | compliance test logs |
| Data retention policy is implemented by source type | Compliance Lead | P1 |  | retention config |
| Tenant access model is documented for admins, agents, and end users | Security Lead | P0 |  | access control matrix |
| Legal and operational ownership for connector data is defined | Product Lead | P1 |  | policy document |
| Customer-facing API and MCP docs are versioned and current | Product Lead | P1 |  | published docs |

---

## Priority 8 - Staging And Hetzner Readiness

**Expectation:** Production rollout happens only after the platform proves itself in staging with the real topology.

| Item | Owner | Priority | Pass/Fail | Evidence |
|---|---|---|---|---|
| Hetzner staging environment is provisioned through IaC | Platform Engineer | P0 |  | infra apply logs |
| Network, firewall, TLS, and secrets distribution are verified | Platform Engineer | P0 |  | staging validation report |
| Blue/green or rollback-capable deployment flow is tested | Platform Engineer | P0 |  | deployment drill |
| End-to-end staging demo covers connector ingest to cross-platform recall | Engineering Lead | P0 |  | demo checklist |
| Go-live sign-off is recorded by Engineering, Security, Compliance, and Product | Program Manager | P0 |  | approval record |

---

## Immediate Next Actions

These are the highest-value items to do next in order:

1. Persist explicit `Updates`, `Extends`, and `Derives` relationships for live session, connector, and memory-save flows.
2. Add first-class version history storage and current-state query behavior, with `is_latest` invariants tested under mutation.
3. Upgrade recall from graph-boosting to graph-expansion around the best seed memories.
4. Write golden correctness tests for chronological audit, refinement, provenance, and structural code retrieval.
5. Tighten retrieval policy and scope enforcement so graph expansion cannot leak cross-project or low-trust context.
6. Only after the above, broaden connector coverage and staged deployment work.

---

## Final Decision

- **Go-Live Decision:** `GO` / `NO-GO`
- **Current Highest Open Priority:** `P0` / `P1`
- **Approved By:** ______________________
- **Date:** ______________________
- **Notes:** ________________________________________________
