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
