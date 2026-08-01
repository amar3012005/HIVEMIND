# HIVEMIND build loop — per-feature production hardening

The loop works these **top-to-bottom, one at a time**. While any `[ ]`/`[~]` remains, the Stop hook
re-injects the current goal — "keep going" is default. (Prior sprints: `GOALS.archive.tara-outbound.md`;
the completed per-org-type parity phases are in git history for this file.)

Status: `[ ]` pending · `[~]` in progress · `[x]` shipped+verified · `[!]` blocked (human gate → pauses)

**Live orgs (verified 2026-07-31 — the three orgs the prior sprint named no longer exist):**
- `807ebb88-94a3-447b-8d84-727479cdd979` MANDI — enterprise, 155 memories
- `1380251c-f707-4aee-98a4-dd93b63b4a00` SINGULANCE — scale, 104 memories
- `40da0836-6e0a-4c02-82f3-3c392f155cef` boozit — pro, 0 memories (empty-state case)

**AUTH CONTRACT — get this wrong and every probe lies:**
- core `:2026` → **scoped API key**. The master key resolves to DEFAULT_ORG, not your tenant.
- control-plane `:2027` → `Authorization: Bearer <sessionId>` (live `cp:session:*` keys in redis).
- `X-Org-Id` / `X-User-Id` are CORS allow-list entries, **NOT auth**. `X-Emulate-Org` does not exist.
  A probe using them runs UNSCOPED and returns empty results indistinguishable from a broken feature.
  That produced eight false "production bug" reports on 2026-07-31. Mint a scoped key with:
  `curl -s -X POST http://127.0.0.1:2027/v1/api-keys -H "Authorization: Bearer $SID" -H 'Content-Type: application/json' -d '{"name":"audit"}'`

**Two more rules that cost real time:**
- Check `created_at` before calling a zero a defect — most zero-counts in this DB are historical.
- Verify "X is missing" against running code before reporting it. Five such claims were wrong.

**Per-goal definition of done:** the feature's `.claude/features/<slug>.md` has every guardrail marked
VERIFIED or MISSING **with the evidence that settled it**, a one-command reproduction that actually runs,
defects fixed + deployed + re-verified on the box, then commit → journal → `[x]`.

**Guardrails audited per feature:** tenant isolation · authZ (unauth + wrong-org) · input validation ·
failure mode (never a success-shaped empty result) · idempotency · observability · reproducibility.

**HOW each goal is worked: `.claude/loop/FEATURE-LOOP.md` — read it first, every time.**
FE → backend-to-storage → enterprise failure modes → measure with curl → fix by MODIFYING
existing code → verify e2e in the browser → record → next. No patches, no duplicate paths.
Workflow tool BANNED — agents only.

---

## FOUNDATION — do this before any feature audit
Every feature below consumes this pipeline, so fixing it once fixes them all.

- [ ] **One ingestion path, not seven — source-aware.**
  KB goes through `document-first-ingestion` (segments → evidence →
  anchored claims). Onboarding, connectors, meetings, chat and image each write
  memories DIRECTLY, skipping it. Measured 2026-08-01 after removing the 119
  prospect dumps: `knowledge_base` 267 mems / 149 anchored, `image-upload`
  38 / 27, and **`hyperagents-onboarding` 8 / 0, `connector:gmail` 3 / 0,
  `talk-to-hive` 1 / 0** — three sources at ZERO. An unanchored memory cannot be
  cited, verified, or re-extracted when the extractor improves.

  **The seam already exists — verified, do NOT build a new one:**
  `core/src/knowledge/canonical-ingest.js` (301 lines) exports
  `validateEnvelope`, `resolvePlatform`, `normalizeProvenance`, `detectMode`,
  `canonicalMemoryType`, `canonicalSourceType`, `legacyPayloadToEnvelope`, and
  already defines the vocabularies:
  - `INGEST_SOURCE_TYPES` = `kb | connector | mcp | meeting | chat | api`
  - `INGEST_SCOPES` = `personal | organization | project | team`
  - `CANONICAL_MEMORY_TYPES` = `fact | preference | decision | lesson | goal |
    event | summary | synthesis | conversation`
  Only `server.js` imports it today. The other writers just never call it.

  **REQUIRED — the memory SHAPE must follow the source.** One pipeline does not
  mean one output. Each source carries different structure and must yield the
  memory types that match it, not a flat wall of `fact`:
  | source | expected shape |
  |---|---|
  | **KB doc** | section-tree: one `summary` parent + `fact`/`decision`/`goal` children, each anchored to its segment. Table row-sets become ONE claim with the full enumeration. |
  | **Meeting** | typed section-tree (already built — see the meeting section-tree work): `decision` for what was agreed, `goal` for commitments, `event` for what happened, `fact` for stated numbers. Never one memory per meeting. |
  | **Connector** (gmail/slack/…) | thread-scoped: `conversation` for the exchange, `decision`/`goal` promoted out of it. Short inputs — do NOT force the KB windowing on them. |
  | **Single image** | ONE atomic `fact` (already correct — `image-single-canonical-memory`). Do not fragment. |
  | **Chat** | `conversation` + any `preference`/`decision` the turn states. |
  | **MCP / API** | caller-declared type, validated against `CANONICAL_MEMORY_TYPES`. |

  GATE: every source writes through the seam; `anchored/total` ≈ 100% for all
  sources; a per-source fixture proves the SHAPE (a meeting yields decisions not
  one blob; an image yields exactly one fact; a KB table yields one enumerated
  claim). No duplicate ingestion path is left behind — delete the bypass, do not
  leave it as a fallback.

## Your Brain
- [ ] **Knowledge Base** — finish: close the extraction-yield constraint (`_extractUnified` returns 7
  facts, the pipeline persists 3), then complete the authZ / input-validation / idempotency guardrails.
- [ ] **Memories** — audit `pages/Memories.jsx` (12 endpoints) end to end; scope/visibility filtering
  correct for all 3 orgs; delete + bulk paths idempotent.
- [ ] **Talk to HIVE (chat)** — `/api/chat` guardrails; verify `scopes_found` annotation, citations
  resolve to real memories, latency stays under 2s warm.
- [ ] **Memory Graph** — `pages/MemoryGraph.jsx` + `Brain`/`MemoryGraph2D`; graph reads tenant-scoped;
  the 0-memory org renders without error.
- [ ] **Connectors** — 28 endpoints, the largest non-agent surface. OAuth/Nango token handling, per-org
  grants, revoke path, no cross-tenant connector leakage.
- [ ] **AI Meeting Notes** — ingest → memories → anchoring; verify the evidence lane is populated.
- [ ] **Overview** — counts must agree with the DB for all 3 orgs (including the 0-memory org).

## Workspace Admin
- [ ] **Workspace Admin** — org members, roles, deactivate/reactivate; privilege-escalation checks.
- [ ] **Team Members** — team membership CRUD; a non-member must not read team data.
- [ ] **Projects** — project scoping is the sharpest tenant boundary; a project-scoped memory must
  never surface outside its project.
- [ ] **Cognitive Layer** — `pages/Engine.jsx`; consensus / cognitive-frame endpoints.

## AI Features
- [ ] **Web Intel** — Deep Research / Web Search / Web Crawl. SSRF posture on agent-supplied URLs
  (`core/src/web/web-policy.js` is load-bearing and untested for private-IP rejection).

## Advanced
- [ ] **MCP Server** — transports, token scoping, and that an MCP client cannot cross tenants.
- [ ] **API Keys** — mint / revoke / expiry; a revoked key must fail closed immediately.
- [ ] **Evaluation** — recall-eval gate; make it a real regression signal rather than a page.

## Account
- [ ] **Profile** — profile facts + `profiles/dream`; user-scoped, not org-leaking.
- [ ] **Usage** — `org_usage_daily` was reported missing; verify metering is real, not estimated.
- [ ] **Billing** — plan limits from `core/src/billing/plans.js`; `plan-enforcer.checkLimit` actually
  enforced on the paths that consume quota.
- [ ] **Settings** — org/user settings persistence and scoping.

---

## Deferred — prior sprint (per-org-type parity + billing, June)
Superseded by the feature-hardening queue above. These reference test orgs that no longer exist
(`b30ead1b`, `33db5150`, `1eda3825`), so they need re-scoping before they can run again.
- [~] getUsageSummary on Overview + Usage (getOrgCounts uniform); echo usage on every action
- [~] getOrgCounts on all count surfaces; route self-host recent_titles/tags/Overview band through the seam
- [~] Compass P8 backups+restore drill (before any PG=0). P6 migration saga (real central→agent move).
- [~] Background-LLM token metering completeness (KB distill raw-Groq fetch + embeddings/vision).

## Done
_(shipped goals move here with their commit sha)_
