# HIVEMIND — 7-Day Work Log (2026-05-31 → 2026-06-06)

This folder documents every commit landed on `HIVEMIND/main` and the `Da-vinci`
frontend submodule over the last seven days, grouped by subsystem. Source =
`git log` commit bodies (each commit carries a full description).

**Author of all commits:** `amarsai3012005`
**Production status:** LIVE at `hivemind.davinciai.eu` (FE) / `core.hivemind.davinciai.eu` (BE).
People are actively using it — every change below shipped behind a flag or a
backward-compatible default.

---

## Index

| # | Doc | Subsystem | Headline |
|---|-----|-----------|----------|
| 01 | [01-security-pqc.md](./01-security-pqc.md) | Security | Post-quantum TLS + ML-DSA memory signatures + SLH-DSA tamper-evident audit chain |
| 02 | [02-memory-engine.md](./02-memory-engine.md) | Memory core | Salience scoring, selective vector forgetting, P2010 crash fixes, honest drift metric |
| 03 | [03-recall.md](./03-recall.md) | Recall | Retrieve-wide-deliver-narrow (top-5), cross-encoder reranker, per-org score threshold |
| 04 | [04-cognition-governance.md](./04-cognition-governance.md) | Cognitive layer | Governance agents (Faraday/Feynman/Turing), self-evolving retrieval, grounded bridges |
| 05 | [05-vector-embeddings.md](./05-vector-embeddings.md) | Evidence/vector | bge-m3 1024-dim, per-org Qdrant containers, plan-based routing |
| 06 | [06-hyperagents.md](./06-hyperagents.md) | HyperAgents | Durable CSI artifact graph, recursive convergence loop, latency cuts, self-healing |
| 07 | [07-tara-voice.md](./07-tara-voice.md) | TARA voice | Skills presets, language stickiness, clinical reasoning, activity isolation |
| 08 | [08-meetings.md](./08-meetings.md) | AI Meeting Notes | Org meetings table, multi-speaker diarization, control-deck UI |
| 09 | [09-employees-connectors.md](./09-employees-connectors.md) | Employees / connectors | Self-improvement tuning loop, OAuth consent redesign, Slack save flow |
| — | [STRATEGY.md](./STRATEGY.md) | **Forward plan** | What's solid, what's fragile, and the 24/7 autonomous hardening plan |

---

## 7-day shape at a glance

- **May 31 – Jun 1:** Employees self-improvement loop, OAuth/MCP connector consent, Slack save flow, HyperAgents CSI artifact graph + convergence.
- **Jun 2:** Memory-engine hardening blitz (P2–P6 roadmap), KB async upload, AI Meeting Notes page, TARA voice widget v1.
- **Jun 3:** **Security day** — PQC TLS + signatures + audit chain. Plus bge-m3 embeddings + per-org vector containers groundwork. TARA call history.
- **Jun 4:** Recall tuning (top-5, reranker), TARA Skills + clinical/language, per-tenant vector routing.
- **Jun 5:** Cognition Phases 0–3 (governance gate + self-evolving retrieval), HyperAgents render/polling fixes.
- **Jun 6:** HyperAgents latency cuts (reasoning_effort=low, stagger 1.5s→0.25s).

The throughline: **make the foundation (memory + evidence + cognition + security)
production-grade while keeping every new capability flag-gated and dark-safe.**
