# Governance Swarm — Memory Engine Janitorial Agents

> Production-grade self-governance for HIVEMIND. Three resident agents
> (Faraday, Feynman, Turing) keep the memory engine clean, debugged, and
> pollution-free. All destructive actions require explicit human approval.

---

## 1. Why this exists

HIVEMIND ingests from many noisy sources — Gmail (sometimes 800+
threads on first sync), Slack history, KB uploads, Drive docs, manual
notes. Without active governance the graph degrades:

| Pain | Symptom |
|------|---------|
| Re-ingest dedup misses | 5 versions of the same Gmail thread |
| Smart-ingest fragmentation | One email → 5 "extracted-fact" rows |
| Stale facts not superseded | "Job title is X" lingers after user said "now Y" |
| Orphan memories | Isolated rows clutter recall ranker |
| Bad ingest source | Promo emails pollute personal scope |
| Schema drift | Memories missing required tags slip through |
| Pipeline errors | Audit log shows failures, nobody reviewing |

The Governance Swarm catches all of these continuously and on demand,
proposes fixes in plain English, and waits for a human to click
**Approve** before mutating the graph.

---

## 2. Roles

```
┌──────────────────────────────────────────────────────────────────────┐
│  Faraday (Scanner)                                                   │
│  Observation & telemetry. Sweeps the graph for duplicates, stale     │
│  rows, orphans, contradictions, noise, schema drift, broken edges,   │
│  malformed source_metadata, missing tags, doc-hash collisions.       │
│  Emits health_event observations.                                    │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Feynman (Analyst)                                                   │
│  Pattern + hypothesis. Clusters recent ingests via Qdrant kNN +      │
│  Jaccard similarity. Detects duplicate-cluster candidates,           │
│  update-chain candidates, contradiction candidates, low-value-noise  │
│  candidates. Emits proposal observations with confidence + reasons.  │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Turing (Verifier + Decision)                                        │
│  Policy + verdict. Verifies each Feynman proposal against the        │
│  policy gate (pinned, important, legal-hold, recent-touch).          │
│  Emits final verdicts. NEVER auto-executes destructive ops.          │
│  Auto-executes only the safest reversible ops at confidence ≥ 0.95   │
│  (when SWARM_AUTO_EXECUTE=true — default false).                     │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │   ApprovalQueue       │
                  │  (per-run, in-memory  │
                  │   on run.pending_     │
                  │   proposals)          │
                  └───────────────────────┘
                              │
                              ▼
              Human reviews on /hivemind/app/swarm
              · Approve   → executes via graph-action-executor
              · Skip      → drops from queue, no action
              · Delete    → soft-delete via store.deleteMemory
              · Approve   → ALL bulk-approves entire pending queue
                  All        (confirms via window.confirm first)
```

---

## 3. Action catalog

| Action key | What it does | Reversible | Logs to audit_log |
|------------|--------------|-----------|-------------------|
| `archive_duplicates` | Keep canonical (longest content + highest importance), mark others `isLatest=false`, `importanceScore=0.05`, add `Derives` edge for traceability | ✅ flip `isLatest` back | ✅ |
| `archive` | Mark `isLatest=false` + drop importance to 0.05 | ✅ | ✅ |
| `delete` | Soft-delete via `deletedAt=now` + `isLatest=false` | ✅ flip `deletedAt` back | ✅ |
| `suppress` | Drop `importanceScore` to 0.05; row remains searchable | ✅ raise importance | ✅ |
| `link_update_chain` | Create `Updates` edge between old → new versions | ✅ delete edge | ✅ |
| `resolve` | Pick winner from contradicting cluster, archive losers | ✅ | ✅ |
| ~~`merge`~~ | **DEPRECATED** — policy: never fuse content. Aliased to `archive_duplicates` for backward compat | — | — |

**No content fusion. No silent mutation. Every action emits one
audit_log row tagged `data_modification`.**

---

## 4. Natural-language interface

The `goal` textbox on `/swarm` accepts free text. Backend parses it
through `nl-intent-parser.js`:

```
"clean gmail noise from 2024"
   ↓
{
  categories: ["noise"],
  filter: {
    source_platform: "gmail",
    date_from: "2024-01-01T00:00:00Z",
    date_to:   "2024-12-31T23:59:59Z",
    tags: [],
    keywords: []
  },
  safety_class: "mutate",
  summary: "Clean Gmail noise from 2024",
  source: "llm"  // or "keyword" or "default"
}
```

### Parse pipeline
1. **LLM** (Groq `llama-3.3-70b-versatile`, JSON-mode strict schema)
2. Fallback: **keyword regex** (date, source, safety verbs)
3. Final fallback: **default intent** (all categories, read-only)

### Recognized signals
| User says | Parsed to |
|-----------|-----------|
| `delete` / `remove permanently` / `wipe` / `purge` | `safety_class: destructive` |
| `clean` / `archive` / `tidy` / `dedupe` / `suppress` | `safety_class: mutate` |
| `find` / `show` / `audit` / `scan` / `list` | `safety_class: read` |
| `gmail` / `email` | `source_platform: gmail` |
| `drive` / `docs` | `source_platform: google_drive` / `google_docs` |
| `slack` / `notion` / `github` | `source_platform: slack` / `notion` / `github` |
| `2024` / `last 30 days` / `this year` / `this month` | `date_from` + `date_to` |
| `duplicates` / `dupes` | `categories: ['duplicates']` |
| `noise` / `spam` / `newsletter` / `unsubscribe` | `categories: ['noise']` |
| `stale` / `old` / `outdated` | `categories: ['stale']` |
| `orphan` / `orphaned` / `disconnected` | `categories: ['orphans']` |
| `contradiction` / `conflicting` | `categories: ['contradictions']` |

The FE displays a blue chip: `Understood: <summary>` so the user sees
how the LLM interpreted them.

### Env switches
| Var | Default | Effect |
|-----|---------|--------|
| `SWARM_NL_INTENT` | `true` | Disable LLM intent parsing (keyword-only) |
| `SWARM_INTENT_MODEL` | `llama-3.3-70b-versatile` | Override Groq model |

---

## 5. Heuristic scanners

`core/src/resident/graph-hygiene-scanner.js`

Six detectors, each returning proposals with:
```ts
{
  id: string,            // unique per proposal
  category: 'duplicate' | 'noise' | 'stale' | 'orphan' | 'contradiction' | 'artifact',
  severity: 'low' | 'medium' | 'high',
  confidence: number,    // 0..1, multi-signal weighted
  suggestedAction: string,
  reason: string,        // heuristic detail
  plainEnglishReason: string,  // UI-friendly
  memories: Array<{ id, title, content_preview, is_canonical, ... }>
}
```

### Duplicates
- Jaccard token-set similarity, threshold default `0.70`
- BFS clusters connected components
- Canonical = longest content, tie-break by highest importance
- `suggestedAction: archive_duplicates`

### Noise
- Patterns: unsubscribe, no-reply, "view in browser", ESP tracker links
- Short content (< 20 chars)
- Empty / pure-emoji / no alphanumeric
- `suggestedAction: delete`

### Stale (rewritten — was generating 83% false positives)
- **Skip** protected tags: `pinned`, `do-not-delete`, `important`, `legal-hold`, `starred`
- **Skip** already-superseded (`is_latest=false`)
- **Multi-signal score** (not constant 0.90):
  - Age signal (gradual to 730 days): +0.30
  - Recall = 0: +0.25
  - Importance < 0.3: +0.20
  - No edges: +0.15
  - Recent activity (< 30d): **score × 0.3** (big penalty)
- Cutoff: `score ≥ 0.60 AND ≥ 2 signals`
- `suggestedAction: archive`

### Orphans (rewritten)
- Bare "no edges" was too noisy → now requires ALL:
  - `age > 90d`
  - `recall_count = 0`
  - `importance < 0.4`
  - Not pinned/do-not-delete/important/legal-hold/starred
  - Not `is_latest=false`
- Multi-signal score, cutoff 0.55
- `suggestedAction: archive`

### Contradictions
- Tag-based contradiction detection
- `suggestedAction: resolve`

### Artifacts
- Title patterns (`TARA Turn`, `Clinical Insight`, `Session:`, etc.)
- Internal-system tag set
- `suggestedAction: archive`

---

## 6. LLM verification gate

`core/src/resident/llm-proposal-verifier.js`

Top-N heuristic proposals get re-ranked by Groq with grounded prompts:

```js
{
  verdict: "confirm" | "drop" | "low_confidence",
  confidence: 0..1,
  reason: "<plain English, ≤140 chars>"
}
```

### Hard rules in the LLM system prompt
- NEVER confirm deletion of: contracts, valuations, agreements, decisions, people, financial figures
- NEVER confirm action on `importance > 0.5`
- Marketing / newsletter / auto-reply → safe to confirm archive
- Older versions of evolving facts → confirm link_update_chain

### Confidence blending
```
final_confidence = (llm_confidence × 0.6) + (heuristic_confidence × 0.4)
```
Sanity floor — pure-LLM jitter can't single-handedly nuke things.

### Behavior
- `drop` verdicts → removed from queue entirely
- `confirm` verdicts → shown with "LLM-verified" chip
- `low_confidence` verdicts → shown with "Needs your review" chip
- LLM error / budget cap → fall back to heuristic, mark `low_confidence`

### Env switches
| Var | Default | Effect |
|-----|---------|--------|
| `SWARM_LLM_VERIFY` | `true` | Disable entirely (heuristic-only) |
| `SWARM_LLM_VERIFY_BUDGET` | `40` | Cap top-N candidates per scan |
| `SWARM_VERIFY_MODEL` | `llama-3.3-70b-versatile` | Override model |

---

## 7. Policy gate (Turing)

Hard rules — these are baked into the executor + verifier:

| Tag on memory | Effect |
|---------------|--------|
| `pinned` | Never touched by any auto-action |
| `do-not-delete` | Never deleted; archive allowed (still gated by approval) |
| `important` | Never auto-actioned; approval required for ALL actions |
| `legal-hold` | Frozen — no archive, no delete, no merge, no suppress |
| `starred` | Treated as pinned |
| `is_latest=false` | Skipped by all scanners (already history) |

Also:
- `SWARM_AUTO_EXECUTE=false` (default) → all actions queue for approval
- Cross-tenant query gating: every Faraday/Feynman/Turing query
  enforces `userId` AND `orgId` to prevent cross-tenant leak.

---

## 8. Endpoints

### `POST /api/swarm/resident/agents/:agent_id/run`
Run a single agent (`faraday` / `feynman` / `turing`).
**Request body**: `{ goal?, scope?, project?, dry_run? }`
**Response**: `{ run_id, status }`

### `GET /api/swarm/resident/runs/:run_id`
Poll run status.
**Response**: `{ status, result, observations, pending_proposals?, graph_actions_result? }`

### `GET /api/swarm/resident/runs/:run_id/observations`
List all observations emitted in a run.

### `POST /api/swarm/resident/runs/:run_id/cancel`
Abort a running agent.

### `POST /api/graph/hygiene/scan`
Run the full hygiene scanner + NL intent + LLM verifier.
**Request body**:
```json
{
  "goal": "clean gmail noise from 2024",   // optional NL
  "categories": ["noise", "stale"],         // optional, overrides intent
  "limit": 50                               // max proposals returned
}
```
**Response**:
```json
{
  "proposals": [ { ...proposal } ],
  "stats": {
    "scanned": 245,
    "issues": 12,
    "byCategory": { "duplicates": 3, "noise": 5, ... },
    "llm_verified": 12,
    "llm_dropped": 4,
    "queued_for_approval": 8
  },
  "intent": {
    "categories": ["noise"],
    "filter": { "source_platform": "gmail", "date_from": "2024-...", ... },
    "safety_class": "mutate",
    "summary": "Clean Gmail noise from 2024",
    "source": "llm"
  }
}
```

### `POST /api/graph/hygiene/execute`
Approve and execute one or more proposals.
**Request body**:
```json
{
  "proposals": [ { ...proposal } ],
  "action": "archive_duplicates" | "archive" | "delete" | "suppress" | "resolve"
}
```
**Response**:
```json
{
  "results": [
    {
      "proposalId": "uuid",
      "status": "executed" | "failed" | "skipped",
      "affected_memory_ids": ["..."],
      "error": "..."   // when status=failed
    }
  ]
}
```

### `GET /api/graph/hygiene/stats`
Lightweight stats (no scan).
**Response**: `{ total_memories, noise_estimate, duplicate_estimate, orphan_estimate, stale_estimate, artifact_count }`

---

## 9. Audit trail

Every action emits one audit_log row (visible on `/hivemind/app/audit-log`):

```json
{
  "eventType": "graph.hygiene.execute",
  "eventCategory": "data_modification",
  "action": "delete",
  "resourceType": "graph",
  "userId": "<uuid>",
  "organizationId": "<uuid>",
  "metadata": {
    "proposalCount": 1,
    "action": "delete",
    "results": [
      { "proposalId": "abc", "status": "executed", "deleted": 1 }
    ]
  },
  "ipAddress": "...",
  "userAgent": "..."
}
```

Filter on `eventCategory: data_modification` + `action: delete|archive|archive_duplicates|suppress|resolve` to audit all swarm-driven mutations.

Other audit eventTypes emitted by the swarm:
- `graph.hygiene.scan` — every scan run (no mutation, just data_access)
- `connector.gmail.flush` / `connector.gmail.flush.hard` — bulk source cleanup
- `connector.gmail.ingest_selected` — preview-approve ingest

---

## 10. FE — `/hivemind/app/swarm`

```
┌────────────────────────────────────────────────┐
│ Agent Swarm Intelligence                       │
│                                                │
│ [Faraday] [Feynman] [Turing]   [Run All]      │
├────────────────────────────────────────────────┤
│ Goal: "clean gmail noise from 2024"  [Run]    │
├────────────────────────────────────────────────┤
│ Faraday Scan — 8 observations                  │
│  • Semantic trail marks                        │
│  • LLM cluster analyses                        │
├────────────────────────────────────────────────┤
│ Feynman Hypotheses — 3 hypotheses              │
│  • emerging pattern: ...                       │
├────────────────────────────────────────────────┤
│ Turing Verifications — 3 verdicts              │
│  • Verified — archive duplicates               │
├────────────────────────────────────────────────┤
│ Cleanup Approvals                              │
│  [Understood: Clean Gmail noise from 2024]    │
│  [▶ Approve All (N)] [↻ Re-scan]              │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ duplicate · medium · 80%                 │  │
│  │ 3 near-identical copies. Keep one,       │  │
│  │ hide the rest.                           │  │
│  │  [LLM-verified]                          │  │
│  │  keep 12ed6860  Amar_cv.pdf — Page 1     │  │
│  │       05f289af  G. AMAR SAI — Section 1  │  │
│  │       ab512156  Document: Amar_cv.pdf    │  │
│  │                                          │  │
│  │              [Approve] [Skip] [Delete]   │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

### Per-card actions
- **Approve** — runs `suggestedAction` for that proposal
- **Skip** — local-only; drops from view, no DB write, no audit row
- **Delete** — hard route via `_executeDelete`, always allowed

### Bulk
- **Approve All (N)** — confirm modal then sequential execution of all pending proposals via their `suggestedAction`. Sequential, not parallel, so partial failures surface one at a time.
- **↻ Re-scan** — manual refresh of the hygiene scan

### Empty states
- Loading: spinner + "Scanning graph health…"
- Scan returned 0: green check + "Nothing to clean."
- Turing done but no scan: warning + "Scan graph for cleanup" CTA

---

## 11. Tenancy isolation

All swarm queries enforce both `userId` AND `orgId` on the where-clause:

```js
const whereClause = { userId, orgId, deletedAt: null, isLatest: true };
```

Memory-graph scope filter ensures Faraday/Feynman/Turing can never see
or mutate memories outside the requesting user's tenant. Audit log
records always include `organizationId` so cross-tenant queries are
flagged in compliance reviews.

---

## 12. Run-manager pending_proposals contract

When `SWARM_AUTO_EXECUTE=false` (default), Faraday + Turing observations
that would otherwise hit `graph-action-executor.executeActions()` are
diverted to `run.pending_proposals`:

```ts
{
  id: "<run_id>:<index>",
  source: "faraday" | "turing",
  recommendation: string,         // e.g. "archive_duplicates"
  target_memory_ids: string[],
  confidence: number,
  reason: string | null,
  status: "pending" | "approved" | "rejected",
  created_at: ISOString
}
```

FE reads this via `GET /api/swarm/resident/runs/:run_id` and renders
the same approval queue UI used by the hygiene scan.

---

## 13. Env switch reference

| Var | Default | Scope | Effect |
|-----|---------|-------|--------|
| `SWARM_AUTO_EXECUTE` | `false` | Run-manager | When false, Faraday + Turing emit proposals only; never auto-mutate |
| `SWARM_ALLOW_MERGE` | `false` | Run-manager | When false, `merge_duplicate_cluster` recommendations are dropped (no-merge policy) |
| `SWARM_NL_INTENT` | `true` | Intent parser | Disable LLM intent parsing (keyword-only) |
| `SWARM_INTENT_MODEL` | `llama-3.3-70b-versatile` | Intent parser | Override Groq model |
| `SWARM_LLM_VERIFY` | `true` | Verifier | Disable LLM verification (heuristic-only) |
| `SWARM_LLM_VERIFY_BUDGET` | `40` | Verifier | Top-N cap per scan |
| `SWARM_VERIFY_MODEL` | `llama-3.3-70b-versatile` | Verifier | Override Groq model |
| `GROQ_API_KEY` | — | Both LLM gates | Without it, both fall back to heuristic/keyword |
| `GROQ_API_URL` | `https://api.groq.com/...` | Both | Custom endpoint |

---

## 14. Common cleanup recipes

### Gmail pollution sweep
```
Goal: "clean gmail noise from this year"
→ Backend parses: { categories: ['noise'], filter: { source_platform: 'gmail', date_from: <Jan 1 current year> }, safety: 'mutate' }
→ Scanner finds: 50 newsletter/promo/auto-reply rows
→ LLM drops business emails, keeps marketing
→ User clicks Approve All → soft-deletes all flagged rows
```

### Find duplicate decisions
```
Goal: "find duplicate decisions about pricing"
→ { categories: ['duplicates'], filter: { keywords: ['pricing'] }, safety: 'read' }
→ Scanner clusters: 4 near-identical pricing notes
→ User reviews per-card → approves 3, skips 1 (the "current" one)
```

### Stale meeting summaries
```
Goal: "archive stale meeting summaries older than a year"
→ { categories: ['stale'], filter: { keywords: ['meeting'], date_to: <1 yr ago> }, safety: 'mutate' }
→ Scanner finds 18 untouched meeting notes
→ LLM verifies, drops 3 with high importance, keeps 15
→ Approve All → archives all 15
```

### Hard purge Gmail (nuclear option)
```bash
curl -X POST "https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/flush?hard=true" \
  -H "Authorization: Bearer hmk_live_..." \
  -H "Content-Type: application/json" -d '{}'
```
Soft-delete on next reconnect: drop `?hard=true`.

---

## 15. Operational runbook

### When the swarm fires too many false positives
1. Check `confidence` floor — bump `SWARM_LLM_VERIFY_BUDGET` so more get
   filtered through LLM
2. Tighten heuristic cutoffs in `graph-hygiene-scanner.js`
3. Inspect `audit_log` for recent `graph.hygiene.scan` runs — look at
   `llm_dropped` count vs `queued_for_approval`

### When approve fails with `action must be one of: ...`
Check the action allow-list at `/api/graph/hygiene/execute` in
`core/src/server.js`. Add the action name to the validator array.

### When the same proposal keeps reappearing
Scanner is finding the same memory because action didn't actually flip
`is_latest`. Verify executor wrote to DB — check `audit_log.metadata.results`
for the run. If `status: executed` but row still `isLatest=true`, the
Prisma write is silently failing (check FK constraints or transaction
rollback).

### When the LLM verifier rate-limits
Drop `SWARM_LLM_VERIFY_BUDGET` to 20, or disable via `SWARM_LLM_VERIFY=false`.
Heuristic-only mode still works; just less calibrated.

### When a tenant claims wrong data was deleted
1. Audit log: filter by `userId` + `eventCategory=data_modification`
2. Identify the proposal_id from `metadata.results`
3. All swarm deletes are SOFT (`deletedAt=now`) — restore via:
   ```sql
   UPDATE memories SET deleted_at=NULL, is_latest=true WHERE id='<id>';
   ```
4. For `archive_duplicates`, also flip `is_latest` back on the
   superseded rows and remove the `Derives` edge if undesired.

---

## 16. Safety guarantees

| Guarantee | How |
|-----------|-----|
| No autonomous destructive ops | `SWARM_AUTO_EXECUTE=false` default + executor checks queue path |
| Cross-tenant leak prevention | All queries enforce `userId + orgId` |
| Protected tags inviolable | Scanner + verifier hard-skip pinned/important/legal-hold/starred |
| Reversibility | All ops soft (deletedAt, isLatest flag) — no hard DROP/DELETE in normal path |
| Cost containment | LLM budget cap (40 items per scan) + Groq free tier |
| Auditability | Every action → audit_log row with proposal_id + affected_memory_ids |
| Confidence calibration | Heuristic + LLM blend (40/60), drop verdicts removed from queue |
| Blast radius cap | Max 1000 destructive ops per approval batch (in executor) |

---

## 17. Roadmap

- **Phase 3**: Cron-driven continuous loop (every 4h emits proposals to queue without user trigger)
- **Phase 4**: Pre-ingest pollution gate — connectors call `policy-engine.shouldIngest(payload)` before save; high-noise sources rate-limited
- **Phase 5**: Per-org policy overrides (custom confidence floors, custom protected tags)
- **Phase 6**: Per-user pause toggle in connector settings
- **Phase 7**: Per-memory audit rows (not per-batch) for fine-grained compliance forensics
- **Phase 8**: Slack/email digest of pending approvals (out-of-band approval channel)
- **Phase 9**: Schema migration to extend `MemoryType` enum so per-provider memory types (gmail_thread, drive_doc, calendar_event) can land first-class

---

## 18. File index

```
core/src/resident/
├── faraday.js                    # Scanner agent
├── feynman.js                    # Analyst agent
├── turing.js                     # Verifier + decision agent (no auto-merge)
├── scheduler.js                  # Unwired cron primitive (Phase 3 target)
├── run-manager.js                # Run orchestration + pending_proposals queue
├── graph-action-executor.js      # Atomic action executor
├── graph-hygiene-scanner.js      # Heuristic scanners + per-action executors
├── llm-proposal-verifier.js      # Groq JSON-mode re-ranker
├── nl-intent-parser.js           # Free-text → structured intent
├── contract.js                   # Observation / run / verdict schemas
└── routes.js                     # Resident API route templates

core/src/server.js                # Endpoints:
                                  #   /api/graph/hygiene/{scan,execute,stats}
                                  #   /api/swarm/resident/agents/:id/run
                                  #   /api/swarm/resident/runs/:id

frontend/Da-vinci/src/components/hivemind/app/pages/
└── AgentSwarm.jsx                # /swarm page — NL input + 3-agent timeline + approval queue + Approve All
```

---

## 19. Acknowledgements

The Governance Swarm was rebuilt iteratively after a v1 that:
- Auto-executed 6 ops without approval per run
- Merged duplicates despite the no-merge product policy
- Hardcoded 90% confidence on every stale row → 83% false-positive rate
- Showed bulk "Merge All Dupes / Delete All Noise" buttons (enterprise foot-gun)

Current v2 inverts those defaults: nothing mutates without human approval,
no content fusion, multi-signal scoring with LLM grounding, plain-English
reasoning per card, audit log per action, per-tenant isolation, env-gated
opt-in for autonomy.

The product policy that drove the redesign:
> "Every org datum is contextual and highly relevant. The swarm should
> propose; humans decide. No silent destruction. No merging."
