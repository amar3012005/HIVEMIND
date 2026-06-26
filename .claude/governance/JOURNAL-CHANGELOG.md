# Governance Changelog — the accountability ledger

One dated entry per turn. Quotes commits + the verifier's verdict. Records RED turns too. Newest first.

---

## 2026-06-26 — Governance crew created
- type: setup   verdict: GREEN
- decided: a 4-agent loop (architect/builder/verifier/scribe) distilled from this session's failure modes.
- built: `.claude/governance/` (README, LOOP, agents/*, journals/*, this ledger).
- state: active (the loop is now the process for setup/bug/feature work).
- residuals: none.
- refs: `.claude/governance/README.md`, `LOOP.md`.

## 2026-06-26 — BYOD data residency: gaps closed
- type: feature   verdict: GREEN
- decided: customer box = DATA only (Postgres + Qdrant / `.amr`); engine + global info central; one seam.
- built: split client + `runWithOrg` context proxy (B4) · per-org Qdrant · control-plane
  `/v1/selfhost/{enroll,register}` + curated-schema bootstrap (B3) · public PG image (B1) · standalone
  `infra/setup.sh` (A3) · tara in compose + extras documented (A1) · transport guide (B2).
- verified: register e2e on prod (throwaway org) → `{ok, migrated:true}`, schema applied; managed (sai)
  recall + ingest intact after every deploy; prod inert by default (no registry file).
- state: deployed + INERT (activates when a customer registers — the shared registry file is the switch).
- residuals: hermes/playwright/stt source not in main repo (need Dockerfiles/images); central must join
  the customer tailnet (operational); a real full customer-box acceptance run pending.
- refs: `docs/architecture/*`, `byod/` + `byod` branch, `infra/` + `infra` branch.

## 2026-06-26 — `.amr` engine + dual-write + reverts
- type: feature   verdict: GREEN
- decided: `.amr` = additive vector+graph index (replaces Qdrant), Postgres keeps rows (dual). Dreams =
  cognitive-layer memories, NOT tables.
- built: dual-write mode · `.amr` lexical recall + no-PG write · dreams→cognitive layer · typed-graph in `.amr`.
- REVERTED (recorded honestly): the over-complication — 5 sidecar tables (userProfile/clusterIndex/…)
  + profile/cognition `if(isMnemeOrg)` branches. They were a SQL schema imposed on `.amr`; backed out.
- verified: sai recall (vector+lexical) on `.amr`; managed intact.
- state: deployed.
- refs: `CHANGELOG/2026-06-26-mneme-amr-engine.md`.
