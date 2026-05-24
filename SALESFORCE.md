# HIVEMIND × Salesforce — Integration State + Continuation Plan

> **Last updated:** 2026-05-24
> **Status:** Week 1-5 shipped (foundation + ingestion + entity layer). Weeks 6-12 + tuning + manual setup remain.

This file is the single source of truth to resume Salesforce work in HIVEMIND. Read top-to-bottom on session start.

---

## TL;DR — What's done, what's blocking, what's next

| Layer | State | Blocker |
|---|---|---|
| Schema (external_refs, canonical_entities, decisions, playbooks, bi-temporal) | ✅ Migrated to prod | — |
| Salesforce adapter (9 object types) | ✅ Shipped | Nango integration not registered |
| Smart router `_routeSalesforce` | ✅ Shipped | — |
| CRM-aware enrichment schemas | ✅ Shipped | — |
| Entity resolver + auto-link | ✅ Shipped | Thresholds too lax (75% review queue) |
| `/api/entities/*` endpoints | ✅ 7 endpoints live | — |
| FE Connectors.jsx card | ✅ Switched to nangoProvider | — |
| Entity backfill on 876 existing memories | ✅ Ran (535 entities created, 659 queued for review) | Need review UI |
| Nango Salesforce integration | ❌ Not registered | Manual admin step |
| FE Entities atlas + review-inbox UI | ❌ Endpoints only | 1-2 days work |
| Decision capture (Phase E) | ❌ Table only | Phase 6-7 |
| Playbooks (Phase F) | ❌ Table only | Phase 8-9 |
| Salesforce agent tool group | ❌ Not started | Phase 9 |
| Observability dashboard | ❌ Not started | Phase 11 |
| Eval-harness SF case | ❌ Not started | 2 hours |

---

## 0. Infrastructure + credentials (preserved)

```
Prod host:      Hetzner 116.202.24.69 (SSH alias `myserver`)
Core container: hm-core (port 3000, mounts /opt/HIVEMIND → /app)
DB:             postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771
                user=hivemind_user db=hivemind schema=hivemind

Test user:      54f5568b-4d6a-4ae1-9a33-48cb2909d59b (amarsai2005@gmail.com)
Test org:       67503d34-97e9-49a8-8c52-8ee30cc7603e
Master API key: hmk_live_9df53ce92a71a514a8b43f75365543921c1344c08eed9908
```

**Nango (for SF registration step):**
```
URL:               https://api.hivemind.davinciai.eu:8042
Admin user:        admin@hivemind.local
Admin password:    Hivemind2026!Nango
Webhook signing:   8c78854b-f4b5-41a3-8a33-cfc70d757ed4
Master secret key: 2ba4b0a5-e674-4257-88b3-bdd34a4284cd
```

**Commit author MUST be:**
```bash
git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit -m "..."
```

---

## 1. What shipped (Week 1-5)

### 1.1 Schema (migration `20260524180000_salesforce_memory_layer`)

| Table | Purpose | Key cols |
|---|---|---|
| `external_refs` | Cross-system ID mapping (idempotent re-sync) | `(org, system, object_type, external_id, memory_id)` UNIQUE |
| `canonical_entities` | Master IDs for real-world things | `id`, `canonical_name`, `entity_kind`, `aliases[]`, `email_domains[]`, `external_refs(jsonb)` |
| `memory_entity_links` | Many-to-many memory↔entity w/ role + confidence | PK `(memory_id, entity_id, role)` |
| `entity_review_candidates` | Fuzzy match queue (0.70-0.95) | `status` pending/approved/rejected |
| `decisions` | Layer 4 — table only, no surface yet | `what_decided`, `reasoning`, `alternatives(jsonb)`, `context_snapshot`, `outcome_*` |
| `playbooks` | Layer 5 — table only | `pattern_type`, `segment_filter(jsonb)`, `trigger_signal`, `intervention` |
| `memories.valid_from / valid_to` | Bi-temporal valid-time | indexed |

### 1.2 Code paths added/modified

```
core/prisma/schema.prisma                                     # +5 models, +2 cols on Memory
core/prisma/migrations/20260524180000_salesforce_memory_layer/migration.sql

core/src/memory/normalizers/salesforce.js                     # NEW — flatten + strip + business fields
core/src/memory/normalizers/index.js                          # registered salesforce

core/src/connectors/providers/salesforce/adapter.js           # 4 → 9 object types, unified normalize()
core/src/connectors/providers/salesforce/enrichment-schema.js # NEW — per-object CRM prompts

core/src/memory/smart-ingest-router.js                        # +_routeSalesforce
core/src/memory/graph-engine.js                               # enrichMemoryStructured dispatches by sf-object:* tag

core/src/memory/entity-resolver.js                            # NEW — auto-link ladder + merge
core/src/memory/external-ref-store.js                         # NEW — first-class refs

core/src/connectors/framework/sync-engine.js                  # +_postIngestHooks (writes external_ref + runs resolver)

core/src/server.js                                            # module-scope externalRefStore + entityResolver
                                                              # wired into all 5 SyncEngine instantiation sites
                                                              # +7 /api/entities/* endpoints

core/scripts/entity-resolution-backfill.mjs                   # NEW — sweep + propose canonical entities

frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx  # SF card → nangoProvider:'salesforce'

~/.claude/skills/hivemind-salesforce/SKILL.md                 # full integration playbook
```

### 1.3 Endpoints live

```
GET    /api/entities                              # list (q + kind filters)
GET    /api/entities/:id                          # detail + linked memories + external_refs
POST   /api/entities/:id/merge                    # body: { target_entity_id }
GET    /api/entities/stats                        # counts + dedup ratio + pending review
GET    /api/entities/review-queue                 # ?status=pending|approved|rejected
POST   /api/entities/review-queue/:id/approve
POST   /api/entities/review-queue/:id/reject
GET    /api/entities/by-external-ref?system=...&external_id=...
```

### 1.4 Current data shape (after backfill on test user)

```
{
  "total_entities":  535,
  "by_kind":         { "person": 535 },
  "memory_links":    540,
  "pending_review":  659
}
```

659 review-queue rate (75%) **too high** — see §3 tuning.

### 1.5 Commits

| SHA | Description |
|---|---|
| `2da36cc` | feat(salesforce): true memory-layer integration — schema + normalizer + router + enrichment + entity resolver |
| `3d1a7e7` | feat(connectors): Salesforce card → Nango provider (submodule) |

---

## 2. Manual steps blocking first live sync

### 2.1 Register Salesforce in Nango admin

1. Open https://api.hivemind.davinciai.eu:8042 → login (admin@hivemind.local / Hivemind2026!Nango)
2. Integrations → New Integration
3. **Provider**: `salesforce`
4. **Unique key**: `salesforce` ← MUST match exactly; backend `_routeSalesforce` keys off this
5. **OAuth Type**: OAuth2
6. **Client ID + Secret**: from Salesforce Connected App (setup below)
7. **Scopes**: `api refresh_token offline_access`
8. **Callback URL**: `https://api.hivemind.davinciai.eu:8042/oauth/callback`
9. Save

### 2.2 Create Salesforce Connected App (one-time)

1. Salesforce → Setup → App Manager → New Connected App
2. Enable OAuth Settings
3. Callback URL: `https://api.hivemind.davinciai.eu:8042/oauth/callback`
4. Scopes: `api`, `refresh_token`, `offline_access`
5. Save → wait 10min for OAuth to propagate
6. Copy Consumer Key (= client_id) + Consumer Secret (= client_secret) → paste into Nango

### 2.3 Verify

```bash
ssh myserver "docker exec postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771 \
  psql -U hivemind_user -d nango \
  -c \"SELECT unique_key, provider FROM nango._nango_configs WHERE unique_key='salesforce';\""
```

Expected: one row `salesforce | salesforce`.

### 2.4 Trigger first sync via FE

1. https://hivemind.davinciai.eu/hivemind/app/connectors
2. Salesforce card → Connect → Nango Connect popup
3. Sign in to Salesforce → grant access → popup closes
4. First sync runs automatically (~5-10min for typical org)

### 2.5 Verify live ingestion

```bash
# Check external_refs populating (every record gets one)
ssh myserver "docker exec postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771 \
  psql -U hivemind_user -d hivemind \
  -c \"SELECT object_type, count(*) FROM external_refs WHERE system='salesforce' GROUP BY 1 ORDER BY 2 DESC;\""

# Memories arriving with sf-object:* tags
ssh myserver "docker exec postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771 \
  psql -U hivemind_user -d hivemind \
  -c \"SELECT count(*) FROM memories WHERE tags @> ARRAY['salesforce']::text[] AND created_at > NOW() - INTERVAL '1 hour';\""

# Enrichment firing on SF memories
ssh myserver "docker exec hm-core curl -sS http://localhost:3000/api/memory/enrichment/stats \
  -H 'Authorization: Bearer hmk_live_9df53ce92a71a514a8b43f75365543921c1344c08eed9908' \
  -H 'X-HM-User-Id: 54f5568b-4d6a-4ae1-9a33-48cb2909d59b' \
  -H 'X-HM-Org-Id: 67503d34-97e9-49a8-8c52-8ee30cc7603e'"

# Canonical entities being created from SF records
ssh myserver "docker exec hm-core curl -sS http://localhost:3000/api/entities/stats \
  -H 'Authorization: Bearer hmk_live_...' -H 'X-HM-User-Id: ...' -H 'X-HM-Org-Id: ...'"
```

---

## 3. Entity-resolver tuning needed (HIGH PRIORITY)

**Symptom:** 659/876 = 75% review queue rate.

**Root cause:** Fuzzy threshold 0.70 catches near-misses on person names sharing common tokens (e.g. multiple "John"s).

### 3.1 Proposed tuning

`core/src/memory/entity-resolver.js`:

1. **Tighten person fuzzy floor to 0.85** (currently 0.70 hits the queue at 0.80)
2. **Require email or org context** for person fuzzy match before queueing — bare-name match alone is too noisy
3. **Drop common firstnames** from tokenization before jaccard (John, Mike, Sarah, etc. — pre-built list)
4. **Boost company match** to auto-link at 0.85 (more identifying tokens per name; GmbH/AG/Inc dropped)

### 3.2 Reset procedure

```bash
# Clear pending review + canonical entities (test user only)
ssh myserver "docker exec postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771 psql -U hivemind_user -d hivemind <<SQL
DELETE FROM entity_review_candidates WHERE organization_id='67503d34-97e9-49a8-8c52-8ee30cc7603e';
DELETE FROM memory_entity_links WHERE entity_id IN (SELECT id FROM canonical_entities WHERE organization_id='67503d34-97e9-49a8-8c52-8ee30cc7603e');
DELETE FROM canonical_entities WHERE organization_id='67503d34-97e9-49a8-8c52-8ee30cc7603e';
SQL"

# Re-run backfill with tuned thresholds
ssh myserver "docker exec -e USER_ID=54f5568b-... -e ORG_ID=67503d34-... hm-core node /app/scripts/entity-resolution-backfill.mjs --commit"
```

**Success criteria:** review queue rate ≤20%, auto-link rate ≥80%.

---

## 4. FE work (Week 6-7 scope)

### 4.1 Entities.jsx atlas page

Route: `/hivemind/app/entities`

Layout:
- Left: list of canonical entities w/ kind filter chips (person/company/product/place)
- Right: detail panel — entity card + linked memories timeline + external_refs deep-links

API:
- `GET /api/entities?kind=&q=&limit=&offset=`
- `GET /api/entities/:id`
- `POST /api/entities/:id/merge` body `{ target_entity_id }`

### 4.2 Review-inbox UI

Route: `/hivemind/app/entities?tab=review`

Each row = `entity_review_candidates` row showing:
- proposed canonical entity (display name, kind, primary_email)
- candidate name + reason + confidence
- linked memory preview
- Approve / Reject buttons → calls `/approve` or `/reject`

### 4.3 Memory card enrichment surface

`frontend/Da-vinci/src/components/.../MemoryCard.jsx`:

Read enrichment fields from `source_metadata.metadata.enrichment` + render:
- `urgency:high` → red dot
- `kind:decision` → badge
- `has-action:N` → "N open actions"
- `salesforce_stage` → stage chip
- canonical entities → clickable chips → opens entity detail

### 4.4 SF-aware Chat (TalkToHive)

Recognize patterns:
- "Show me {AccountName}'s history" → entity lookup + cross-source timeline
- "Why did we lose {OppName}?" → decision lookup + linked events
- "Find deals like {OppName}" → similar-memory recall

---

## 5. Phase E — Decision Capture (Weeks 6-8)

### 5.1 Three capture rails

| Rail | Trigger | Path |
|---|---|---|
| **Chat (manual)** | User types `/decision ...` or "log decision: ..." | Parse via LLM → `decisions` row |
| **Synthesized (auto)** | Opp stage transition + Slack/email thread within 7d | LLM extracts → `decisions` row |
| **Form (structured)** | FE Decision modal on Opp detail page | Direct write |

### 5.2 Files to create

```
core/src/memory/decision-store.js
  class DecisionStore {
    async create({orgId, decisionType, decidedAt, whatDecided, reasoning,
                  alternatives, entityRefs, outcomeResolvesAt, ...})
    async findSimilar({orgId, decisionType, entityKind, segment})
    async trackOutcome({decisionId, outcomeStatus, outcomeDetails})
    async pendingOutcomes({orgId})   // past resolve date + no status
  }

core/scripts/decision-outcome-tracker-cron.mjs
  # nightly: query SF Opps for decisions past outcome_resolves_at,
  # LLM compares decision intent → actual outcome, writes outcome_status
```

### 5.3 Endpoints

```
POST   /api/decisions
GET    /api/decisions?entity_id=
POST   /api/decisions/:id/outcome
GET    /api/decisions/similar?type=concession&entity_kind=company&segment[industry]=real_estate
GET    /api/decisions/pending-outcomes
```

### 5.4 FE

- Decision capture modal (TalkToHive `/decision` slash command + Opp detail page button)
- Decision Journal page `/hivemind/app/decisions`
- Auto-suggest banner after Salesforce stage change ("Did you make a decision here? Capture it.")

---

## 6. Phase F — Playbooks (Weeks 8-9)

### 6.1 V1 = human-curated, LLM-suggested (NOT statistical mining)

Sample sizes year 1 too small for real pattern mining. LLM proposes candidates from `decisions` table; humans validate.

### 6.2 Files

```
core/src/memory/playbook-engine.js
  class PlaybookEngine {
    async proposeCandidates({orgId, segment})    // LLM scans decisions, proposes patterns
    async validate({playbookId, supportingEvidence})  // human approves → status=validated
    async deploy({playbookId})                   // status=deployed, fires for agents
    async retire({playbookId})
    async applicableFor(memoryOrEntity)          // which playbooks fire for this context?
  }
```

### 6.3 "Find deals like this one" recall

Embedding similarity (Qdrant) + filter by enrichment fields:

```
GET /api/memories/similar?memory_id=<opp_id>&filter[memory_kind]=opportunity&filter[deal_stage]=Closed Lost
→ returns top-K opps + their decisions + their outcomes
```

This populates `decisions.context_snapshot.similar_past_decisions` automatically.

### 6.4 Endpoints

```
POST   /api/playbooks
GET    /api/playbooks?status=validated|deployed
GET    /api/playbooks/applicable?memory_id=<id>
POST   /api/playbooks/:id/validate
POST   /api/playbooks/:id/deploy
POST   /api/playbooks/:id/retire
```

### 6.5 FE

- Playbook library page `/hivemind/app/playbooks`
- Candidate queue (LLM proposals awaiting validation)
- Validated playbook detail (segment filter + trigger + intervention + supporting decisions)

---

## 7. Phase G — Agent integration (Weeks 9-10)

### 7.1 New tool group: `salesforce-tools` (Nango REST proxy)

`core/src/agent/connector-toolkits/salesforce-tools.js`:

```
salesforce_query                    # SOQL query proxy
salesforce_get_record               # Account/Contact/Opp lookup
salesforce_get_opportunity_history  # stage transitions
salesforce_create_task              # write-back gated by draft-approval
salesforce_update_opportunity       # write-back gated
```

Register in `toolkit-factory.NANGO_REST_GROUPS`:

```js
{ id: 'salesforce', provider: 'salesforce', tools: SALESFORCE_TOOLS }
```

### 7.2 New static HIVEMIND tools

`core/src/agent/tool-registry.js`:

```
hivemind_find_similar_decisions     # for decision-time context recall
hivemind_get_applicable_playbooks   # auto-injects playbook recs
hivemind_get_entity_context         # canonical entity + all linked memories
hivemind_track_decision             # log decision from chat
```

### 7.3 Renewal-Risk Agent (proof-of-value)

Input: Opportunity ID
Pulls:
- Salesforce Opp + Account + Contacts + recent Cases
- Linked Slack threads + recent emails (cross-source)
- Similar past Opps (closed-lost) + their decisions
- Applicable playbooks

Output: structured risk report w/ leading indicators + recommended interventions. Read-only first. Write-back (create Task) gated via draft-approval.

---

## 8. Phase I — Eval + observability (Weeks 11-12)

### 8.1 Eval-harness cases to add

`core/scripts/eval-harness.mjs`:

```
sf-ingest-roundtrip         # post fake Nango webhook → assert memory + external_ref + entity
sf-opportunity-tree         # opp + 3 history events → tree shape preserved
sf-entity-resolution        # Slack msg from same person as SF Contact → entity merge
sf-decision-capture-from-chat  # "log decision: ..." → decisions row
sf-similar-deals-recall     # "find deals like X" → top-K w/ correct filtering
sf-playbook-fires           # memory matches segment_filter → playbook surfaces
sf-outcome-tracking         # decision past outcome_resolves_at → cron triggers status update
```

### 8.2 Observability endpoints

```
GET /api/admin/salesforce/sync-status     # per-object lag, error rate, daily quota used
GET /api/admin/entities/dedup-stats       # entities/dedup ratio, manual-review backlog
GET /api/admin/decisions/outcome-stats    # decisions logged, outcomes resolved, accuracy
GET /api/admin/playbooks/usage            # playbooks fired, intervention follow-through
```

### 8.3 SLOs

| Metric | Target |
|---|---|
| Salesforce → HIVEMIND latency p95 | < 6min (Nango incremental sync) |
| Entity-resolution auto-link rate | ≥ 80% (≤ 20% review queue) |
| Decision capture cadence | ≥ 1 decision per active user per week |
| Playbook fire precision | ≥ 75% (humans agree intervention applies) |
| Enrichment success rate | ≥ 95% (excluding short-content skips) |

---

## 9. Salesforce gotchas (memorize before debug)

| Pitfall | Mitigation |
|---|---|
| Bulk v2 silent partial failures | Audit failed-record CSV per Nango sync output |
| Governor limits (CPU/SOQL/heap) | Composite API max 25 calls/req; never bulk-write from HIVEMIND |
| Person Account vs Business Account | Normalizer branches on `IsPersonAccount` |
| Compound fields (Name, Address) | Normalizer flattens; preserves compound + components |
| Multi-currency confusion | Store both ISO + corporate currency converted |
| Custom object drift | Daily Metadata API introspection (NOT yet wired — flag for v2) |
| Field-level security | Integration user must have FLS on all required fields |
| OpportunityHistory | Read-only child events, tree-shaped under Opportunity parent |
| CDC 72hr replay cap | Fall back to Bulk catch-up by LastModifiedDate range on gap detect |
| Entity merge mistakes | `merged_from` preserved → undoable. Auto-merge floor 0.95 |

---

## 10. Anti-patterns (never do these)

- ❌ Direct Salesforce REST/Bulk calls — use Nango sync templates
- ❌ Skip `external_refs` insert — breaks idempotency on re-sync
- ❌ Generic enrichment prompt on SF records — loses CRM-specific signals
- ❌ Auto-merge entities < 0.95 confidence — irreversible without manual override
- ❌ Bulk-write back to Salesforce — governor limits; gate via Composite + draft-approval
- ❌ Treat OpportunityHistory as standalone — must be child under Opportunity parent
- ❌ Drop `sf-object:<type>` tag — enrichment dispatch fails, generic schema fires

---

## 11. Resume-work checklist

When starting a new session on Salesforce:

1. Read this file top-to-bottom
2. Read `~/.claude/skills/hivemind-salesforce/SKILL.md` for canonical pipeline details
3. Check prod state:
   ```bash
   ssh myserver "docker logs hm-core --since 60s 2>&1 | grep -E 'EntityResolver|ExternalRef|salesforce' | head -10"
   ssh myserver "docker exec hm-core curl -sS http://localhost:3000/api/entities/stats \
     -H 'Authorization: Bearer hmk_live_...' -H 'X-HM-User-Id: ...' -H 'X-HM-Org-Id: ...'"
   ```
4. Check Nango registration state:
   ```bash
   ssh myserver "docker exec postgres-... psql -U hivemind_user -d nango \
     -c \"SELECT unique_key,provider FROM nango._nango_configs WHERE unique_key='salesforce';\""
   ```
5. Pick task from §2-§8 priority list
6. Use HIVEMIND-APEX commit/deploy flow (skill: `hivemind-apex`)

---

## 12. Recommended next 3 ships (in order)

1. **§2 — Register Salesforce in Nango** (manual, 15min) + trigger first real sync
2. **§3 — Tune entity-resolver thresholds** to drop review queue rate to ≤20%
3. **§4 — Ship FE Entities atlas + review-inbox UI** so 659 queued candidates clearable

Then either:
- **§5 — Decision capture** (biggest moat-builder, unblocks McKinsey "thoughts" pitch)
- **§7 — Renewal-risk agent** (fastest proof-of-value demo for first SF customer)

---

## 13. Pitch (when ready to sell)

> "Salesforce is the system of record. HIVEMIND is the system of memory.
>
> System of record = what is true now.
> System of memory = what we knew, when we knew it, why we decided what we did, and what we learned.
>
> Salesforce admitted (Feb 2026) that effective AI agents need memory that evolves with interactions. They built a session-level memory layer inside their walled garden. We build the cross-system, cross-tenant, compounding memory layer that no CRM vendor can architect — because their trust model prevents it."

Three structural gaps Salesforce can't close:
1. Einstein only sees inside Salesforce
2. Zero-retention LLM = no learning loop
3. Trust Layer is privacy-focused, not memory-focused

HIVEMIND fills all three.
