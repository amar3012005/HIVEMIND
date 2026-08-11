# Phase 0 — Recon & Baseline   ✅ DONE

## Envisioned state
Every production ingestion call site + bypass is accounted for before any code
changes. A source-path matrix (KB/image/Gmail/Slack/connector/meeting/MCP/chat/
/api/memories) and a production baseline exist.

## Result
3 parallel recon agents produced the source-path matrix + full bypass inventory.
Baseline: org 807ebb88 = 259 memories, 38 docs, 395 entities/164 canonical, ~4% dup.
Key finding: canonical stack ~75% already built (ingestSource + canonical-ingest.js
live; RecallRouter is the single recall service; relationship validator in enforce
mode; Updates transactional). Bypasses: /api/memories POST, /api/enterprise/upload,
store.createMemory class (Tara/deep-research/enterprise-chat), ingestion/indexer
double-vector-write, /api/relationships raw edge.

## Acceptance (met)
Read-only cURL health/version/counts captured as baseline; matrix covers every call site.
