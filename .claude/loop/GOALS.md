# HIVEMIND build loop — per-org-type parity + billing

The loop works these **top-to-bottom, one at a time**. While any `[ ]`/`[~]` remains, the Stop hook
re-injects the current goal — "keep going" is default. (Archived prior sprint: GOALS.archive.tara-outbound.md)

Status: `[ ]` pending · `[~]` in progress · `[x]` shipped+verified · `[!]` blocked (human gate → pauses)

**Test orgs (verify EVERY phase against all 3):**
- self-host : `b30ead1b-288f-4e79-8399-b3fef63b7cb8` (enterprise, self_host, agent on myserver) — key `/tmp/sh_key.txt`
- personal  : `33db5150-f2f2-4d99-9c9c-e17602a4af6f` (free, managed, HIVEMIND_PERSONAL)
- managed   : `1eda3825-b99e-4132-90e9-5eba9f05b6ce` (enterprise, managed, org_<id>)

**PRINCIPLE:** engine uniform; org-type matters ONLY at a storage seam (`memoryBackend`/`getOrgCounts`/
`amrGraph`). No `if(orgIsRemote)` in feature/endpoint code — route inside a seam helper.

**Plan limits source of truth:** `core/src/billing/plans.js` (`PLANS`). Enforce `plan-enforcer.checkLimit`;
surface `getUsageSummary`.

**Per-goal pipeline:** recon (grep, not stale graph) → surgical build (reuse>rebuild) → `node --check`
→ deploy (scp + rebuild core/control-plane/agent as needed; `--env-file ../.env`; rebuild control-plane
separately) → e2e verify on the 3 orgs BEFORE push → commit (author amarsai3012005; main=prod) →
changelog + memory → mark `[x]`. Workflow tool BANNED — agents only.

---

## Phase 1 — Feature-matrix ground truth (TEST, no build)
- [x] Exercise every feature for all 3 orgs; record PASS/GAP per (feature × type): save, recall, graph,
  relationships, profile counts, KB upload, connectors, meeting notes, HyperAgents room+turn, Web Intel,
  TARA, MCP, cognition. Commit the matrix. GATE: matrix file committed; gaps feed Phases 2-5.

## Phase 1.5 — FIX GAP-1 (managed per-tenant vector isolation) — URGENT
- [x] Managed-enterprise vectors write to shared HIVEMIND_PERSONAL, not their org_<id> collection
  (resolveCollectionForOrg returns the right name but plan-lookup/cache returns personal at write time).
  Enterprise tenants' vectors are co-mingled = isolation bug. Fix the plan-resolution/cache so the WRITE
  routes to org_<id>; backfill/migrate any mis-placed vectors. Also clean GAP-2 (21 stale central vectors
  in org_b30ead1b for the self-host org). GATE: managed save → vector in org_<id>, NOT HIVEMIND_PERSONAL;
  org_<id> point count grows; HIVEMIND_PERSONAL only holds free-tier vectors.

## Phase 2 — KB-on-agent (unblock KB for self-host)
- [x] Agent knowledge_documents + knowledge_segments tables + segment vectors; route doc+segment
  write/read/recall to the agent via outbox; lift the KB-upload assertKbAllowedForOrg block.
  GATE: PDF upload to b30ead1b → segments+memories on agent, central=0, recall returns the doc.

## Phase 3 — Structured enrichment + cognition for self-host (compass P5)
- [ ] Run enrichMemoryStructured + cognition-loop centrally for remote orgs, push tags/syntheses to the
  agent via outbox (remove the orgIsRemote skips). GATE: self-host memory gets urgency/kind tags;
  synthesize-now on b30ead1b → synthesis on agent, central=0.

## Phase 4 — Billing: used/left everywhere + enforce all callsites
- [ ] getUsageSummary on Overview + Usage (getOrgCounts uniform); echo usage on every action
  (X-Usage-* headers / usage block) so the API key always knows used/left; enforce remaining callsites
  (connectors ALL providers, graphQueries block, seats/maxUsers on invite); consolidate+document plans.js.
  GATE: free org hits each cap → 402/403 with used/left; Usage shows all counters for all 3 types.

## Phase 5 — Meetings + TARA for self-host
- [ ] Route meeting + tara rows to the agent so the 501 blocks lift. GATE: record a meeting on
  b30ead1b → lands on agent, central=0.

## Phase 6 — Uniform-count sweep + cosmetic parity
- [ ] getOrgCounts on all count surfaces; route self-host recent_titles/tags/Overview band through the
  agent; remove remaining per-type branches. GATE: Overview+Profile+Usage one code path across 3 types;
  grep shows no orgIsRemote outside seam helpers.

## Later (situational, not blocking the loop)
- [ ] Compass P8 backups+restore drill (before any PG=0). P6 migration saga (real central→agent move).
  P11 managed density decision. P12 .amr swap.
- [ ] Background-LLM token metering completeness (KB distill raw-Groq fetch + embeddings/vision).
