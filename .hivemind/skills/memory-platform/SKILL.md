---
name: memory-platform
description: Build or repair HIVE Core memory, evidence, ingestion, recall, entities, and MCP contracts.
---

# Memory platform

Use for company-memory behavior. Keep authorization, durable evidence, and retrieval semantics in
Core/Postgres/Qdrant; do not make browser state or a worker cache authoritative.

Trace writes through persistence and asynchronous ingestion, and trace reads through authorization,
scope, retrieval, and cited projection. Validate the real entity/recall path with tenant-scoped
fixtures. Keep raw provider material and large receipts server-side; expose typed, bounded fields.
