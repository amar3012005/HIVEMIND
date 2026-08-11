# HIVEMIND Changelog

Reverse-chronological log of features, changes, and upgrades. Each dated file is a self-contained
entry. Newest first.

| Date | Entry | Headline |
|------|-------|----------|
| 2026-06-26 | [mneme / `.amr` memory engine](2026-06-26-mneme-amr-engine.md) | Single-file memory engine + per-org driver: one config flip swaps a tenant's whole store (`memory + graph + subgraph`) from Postgres+Qdrant to `.amr`, pipeline unchanged. Live on sai (org `71bc75ab`), PG=0. |

## Conventions
- One file per dated milestone (`YYYY-MM-DD-<slug>.md`).
- Each entry: **What shipped · Why · How it works · Migration/flags · Risks · Verification**.
- Flags and commits are quoted verbatim so the entry is auditable.
