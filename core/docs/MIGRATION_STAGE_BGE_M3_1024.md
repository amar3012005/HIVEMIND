# Migration Stage — bge-m3 1024-dim Qdrant cutover

**Status:** DONE (data migrated) · app cutover PENDING
**Date:** 2026-06-03
**Owner:** amarsai3012005

---

## What happened

Migrated HIVEMIND memories + evidence from the legacy **384-dim MiniLM** Qdrant
(collection `BUNDB AGENT`, Hetzner/Coolify) to a new external **prometheus** box
running **bge-m3 (1024-dim)** embeddings.

### New box

- **Qdrant** — prometheus box, exposed via Cloudflare quick tunnel (ephemeral URL,
  rotates on restart). Gated by `QDRANT_API_KEY` (rotated — old `prod-secret-key-123`
  is dead).
- **Embed** — prometheus GPU FastAPI `/embed` (RTX 4060, ~42ms single / ~214ms batch32).
  Fallback = blaiq LiteLLM `bge-m3` (~136ms single). Same model → interchangeable.
- **NOTE:** embed endpoint (8001) currently has NO auth. Quick-tunnel URLs are
  ephemeral — for prod use tailscale or a named tunnel.

### Collection topology (the contract)

Every collection: **1024 dim**, HNSW `m=32 ef_construct=256`, scalar int8 quant
(always_ram, quantile 0.99), `on_disk` vectors + `on_disk_payload`. Payload indexes
(keyword): `user_id, org_id, project_id, layer, memory_type`. One collection holds
BOTH memory and evidence, separated by a **`layer`** payload discriminator
(`memory` | `evidence`). Tenant/project separation by `user_id` / `project_id` filter.

| Collection | Type | Contents |
|---|---|---|
| `UWE_BERGER` | org (per-agent) | 651 (278 mem + 373 ev) |
| `CEYDA_SARIOGLU` | org (per-agent) | 1262 (8 mem + 1254 ev) |
| `AMAR_SAI` | org | 372 (167 mem + 205 ev) |
| `SEBASTIAN_GARN` | org | 3 |
| `HIVEMIND_PERSONAL` | shared personal pool | 948 — user_id tenant filter (Gundoju 480, Rama 281, Sai Vamshi 92, Dipesh 91, Wolfgang 4) |

Org accounts → individual collections. Personal accounts → one shared
`HIVEMIND_PERSONAL`, isolated by `user_id` filter (verified isolation works).

### Why 1024 over 384

Proven recall lift on German enterprise queries (e.g. "Architektur vier
Entscheidungen" score 0.584 → 0.847; on-topic top-3 vs OCR garbage). Recommended
**top-5 final** (retrieve wide, deliver narrow).

---

## PENDING — app cutover (not yet wired)

1. **Org-container auto-provisioning** (P1, starting now) — on org account creation,
   auto-create a Qdrant collection keyed by org; route all org members into it;
   projects shared inside via `project_id` filter. See plan below.
2. `EMBEDDING_DIMENSION=384 → 1024` env flip + bge-m3 primary (prometheus) /
   blaiq fallback embed wiring.
3. Collection resolver in `qdrant-client` — route by (orgId, scope, userId):
   org-scope → org collection, personal → `HIVEMIND_PERSONAL` + user_id filter.
4. `layer` filters on recall (memory vs evidence).
5. Stable transport for prod (tailscale / named tunnel, not quick-tunnel URL).
6. Add `organizations.account_type` + `organizations.vector_container` columns.
7. **Bug to fix:** `retrieveEvidence` passes `scoreThreshold` (camelCase) to
   `searchMemories` which expects `score_threshold` (snake) → override ignored
   (silently uses 0.15 default).

## Org-container provisioning plan (P1)

- Container = per ORG, keyed by `org_id`. All members → one collection.
  Separation inside by `user_id` / `project_id` / `layer` filters.
- Personal accounts → shared `HIVEMIND_PERSONAL` (user_id filter).
- Naming `org_<orgId>` (stable, survives rename). Stored on org row.
- Hook: `control-plane-server.js` org-create (`prisma.organization.create`)
  → if account_type=org, provision collection (idempotent PUT, async non-blocking),
  set `org.vector_container`.
- Resolver `resolveCollection({scope, orgId, userId})`: personal→HIVEMIND_PERSONAL,
  org/project/team→org.vector_container, fallback→legacy `BUNDB AGENT` during rollout.
- Existing per-tenant scaffold: `buildCollectionName(userId, orgId)` in
  `indexer.js` (gated by `QDRANT_PER_TENANT`) — finish + make scope-aware.
