# HIVEMIND — Phase 2 Final Integration Plan

> Single source of truth for the work needed to bring the document-backed,
> evidence-first company-brain to full production. Self-evolution loop runs
> last so the core ingestion + retrieval + UI path stabilizes first.

---

## Baseline (already integrated)

| Layer | KB Upload | Enterprise Upload | Connector Webhooks (Slack, Notion) |
|---|---|---|---|
| source_artifacts (immutable evidence) | ✅ | ✅ | ✅ |
| knowledge_documents | ✅ idempotent | ✅ | ✅ |
| knowledge_segments | ✅ | ✅ | ✅ |
| Docling parse | ✅ live container | ✅ | n/a (connector-native) |
| hivemind_evidence Qdrant | ✅ 1024-dim | ✅ | ✅ |
| Entity extraction (LLM + regex + resolver) | ✅ | ✅ | ✅ |
| entity_mentions (segment + memory level) | ✅ | ✅ | ✅ |
| SmartIngestRouter → graph-engine | ✅ | ✅ | ✅ |
| memory_evidence_links + memory_derivation | ✅ | ✅ | ✅ |
| Updates / Extends / Derives edges | ✅ | ✅ | ✅ |
| Evidence retrieval API (search, hybrid, memory, document) | ✅ | ✅ | ✅ |
| Hygiene cron | ✅ daily | — | — |

---

## Execution order (this PR series)

### Wave 1 — Connector breadth (high impact, ~10h)

| # | Task | File | Effort |
|---|---|---|---|
| 1.1 | GitHub adapter | `core/src/connectors/adapters/github/github-adapter.js` | 2h |
| 1.2 | Linear adapter | `core/src/connectors/adapters/linear/linear-adapter.js` | 2h |
| 1.3 | Jira adapter | `core/src/connectors/adapters/jira/jira-adapter.js` | 2h |
| 1.4 | Confluence adapter | `core/src/connectors/adapters/confluence/confluence-adapter.js` | 1.5h |
| 1.5 | Adapter self-registration boot block adds new providers | `core/src/server.js` | 15min |
| 1.6 | Webhook subscription auto-register on Nango connect | `core/src/server.js` route `/api/connectors/connect` | 2h |
| 1.7 | `/v1/connectors/:provider/resync` routes connector backfill through `ingestConnectorRecord` (Phase1) | `core/src/control-plane-server.js` | 1h |

### Wave 2 — Frontend Memory Intelligence Center (~9h)

| # | Task | File | Effort |
|---|---|---|---|
| 2.1 | KB upload result UI: segment vs promoted memory split | `frontend/Da-vinci/.../KnowledgeBase.jsx` | 2h |
| 2.2 | Memory detail "Evidence" tab — linked segments + source doc | new component | 3h |
| 2.3 | Memory detail "Entities" tab | new component | 2h |
| 2.4 | Search UI mode toggle (memory / evidence / hybrid) | `frontend/Da-vinci/.../SearchBar.jsx` | 1h |
| 2.5 | Wire SyncConfigPanel into Connectors.jsx | `frontend/Da-vinci/.../Connectors.jsx` | 1h |

### Wave 3 — Hardening (~8h)

| # | Task | Effort |
|---|---|---|
| 3.1 | Legacy BUNDB AGENT Qdrant cleanup (drop chunk-as-memory points where memory has evidence link) | 2h |
| 3.2 | Docling sidecar in Coolify-managed compose | 1h |
| 3.3 | Dead-letter admin endpoint for failed `inbound_webhook_events` | 2h |
| 3.4 | Prometheus metrics (segments/doc, promoted_per_segment, dup rate) | 2h |
| 3.5 | source_artifact payload backup strategy (S3-compatible blob store) | 1h |

### Wave 4 — Cross-source layer (~8h)

| # | Task | Effort |
|---|---|---|
| 4.1 | Cross-source entity resolution (merge same person across Slack + email + Notion) | 4h |
| 4.2 | TopicState rolling summary writer (entity → recent decisions/state) | 4h |

### Wave 5 — Self-evolution (LAST, ~12h)

| # | Task | Effort |
|---|---|---|
| 5.1 | Memory promotion jobs scheduler (re-evaluate candidates, mark stale, age decay) | 4h |
| 5.2 | Contradiction scanner — emit Contradicts edges + alert | 4h |
| 5.3 | Memory synthesis job — higher-order summaries from clustered memories | 4h |

---

## Acceptance criteria

- [ ] All 6 connector adapters self-register on boot
- [ ] Connect Slack workspace → webhook subscription row INSERTed automatically
- [ ] Real Slack message → arrives at webhook → segment + memory + entity_mention persisted
- [ ] KB upload UI displays: "5 segments, 3 promoted memories, 12 entities extracted"
- [ ] Memory detail page shows: linked segments (with snippets), source document, entities mentioned
- [ ] Search UI toggle works for memory / evidence / hybrid modes
- [ ] Legacy Qdrant `BUNDB AGENT` chunk-as-memory points removed for documents now backed by evidence
- [ ] `/health` reports all schedulers green + sidecar reachable
- [ ] Promotion jobs run on cron; Contradicts edges generated for >70% confidence conflicts

---

## Rollback plan

Every change is feature-flagged:
- `ENABLE_DOCUMENT_FIRST_INGEST=false` → falls back to legacy chunk-as-memory path
- `ENABLE_EVIDENCE_RECALL=false` → evidence endpoints return 501
- `ENABLE_ENTITY_EXTRACTION=false` → skip entity layer (segments still land)
- `ENABLE_HYGIENE_CRON=false` → no background scans
- `ENABLE_MEMORY_PROMOTION_JOBS=false` → no self-evolution writes

Rollback = flip flag, restart hm-core, no migration revert needed.
