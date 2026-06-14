# AI Meeting Notes — HIVEMIND Intelligence + Robust Schema (Design)

**Date:** 2026-06-14
**Status:** Approved design → implementation planning
**Scope order (user decision):** Build the **recall-augmentation (Phase B)** first,
then **harden the schema + display (Phase A)**.

---

## 1. Goal

After a meeting is analyzed, automatically cross-reference it against everything
already in HIVEMIND and surface a single **"What HIVEMIND already knows"**
intelligence panel — entity briefs, decision continuity/contradictions, and
unresolved open loops — every line grounded in a real memory. Then make the
persisted meeting memory itself more robustly schemed and better displayed.

Non-goals: real-time/live intelligence during recording; the Chrome extension
(tracked separately); changing the transcribe/insights models.

---

## 2. Phase B — Meeting Intelligence (build first)

### 2.1 Trigger & flow (auto + async)

The meeting finishes instantly with insights (unchanged). The intelligence
panel fills in a few seconds later from a **background job**, so the main flow
never waits and compute is spent only when a meeting actually happens.

```
process() finishes → persistRow() (meetings row exists, insights present)
        │
        └── enqueue MEETING_INTELLIGENCE job { meetingId, userId, orgId }
                 │  via the existing BullMQ enrichment queue (survives restart);
                 │  if the queue is unavailable, fall back to an inline
                 │  fire-and-forget async (welcome-email pattern) so a missing
                 │  Redis never blocks or loses the meeting itself.
                 ▼
        generateIntelligence(meeting)  → writes meetings.intelligence (jsonb)
                                       + meetings.intelligence_status='ready'
        ▼
FE detail view polls GET /api/meetings/:id every ~3s while
intelligence_status='pending' → renders the panel when 'ready'
```

`intelligence_status`: `none` (no meeting yet) → `pending` (job queued) →
`ready` | `empty` (nothing relevant) | `error`.

### 2.2 The generator — three lanes, all grounded

`core/src/knowledge/meeting-intelligence.js` (new module). Input: the persisted
meeting row (insights + entities). Bounded by design (cost): cap entities to top
6, decisions to top 8, one recall per entity/decision, dedupe by memory id.

**Lane 1 — Entity briefs (`who`).** For each person/org in
`insights.entities` (+ speaker_names), run
`recallPersistedMemories(store, { query: <entity>, userId, orgId, limit: 5 })`.
Take the top memories, ask ONE bounded LLM call to compress them into a 1-line
"what we know" brief per entity. Output: `{ name, kind, memoryCount, brief,
topMemoryIds[] }`. Skip entities with zero hits.

**Lane 2 — Continuity / contradiction (`connects`).** For each decision in
`insights.decisions`, recall the most similar prior memories
(`memoryType in (decision,fact)`, exclude this meeting's own children via
`meeting:<id>` tag). Classify each (decision × top-candidate) pair with a
**dedicated bounded LLM judgment** (NOT the heuristic classifier — accuracy
matters when shown to the user): `NEW | UPDATES | CONFLICTS`, with the prior
memory snippet + id + a one-line reason. Confidence floor; only show UPDATES/
CONFLICTS above it, everything else is NEW or omitted.

**Lane 3 — Open loops (`open`).** Recall prior memories tagged
`risk` / `next-step` / `goal` (action items) on the same topics/entities that
have NO resolving memory after them (heuristic: most-recent memory on that
thread is the risk/action itself, nothing newer marks it done). Output the
unresolved items with their source meeting + age.

**Grounding contract (hard rule):** every emitted line carries ≥1
`memory_id`. If a lane has no grounded items it's omitted. If all three are
empty → `intelligence_status='empty'`, panel renders a tiny "nothing related in
memory yet" and stays out of the way. **Never invent.**

### 2.3 Output schema (`meetings.intelligence` jsonb)

```jsonc
{
  "generated_at": "2026-06-14T14:24:00Z",
  "related_count": 14,
  "entities": [
    { "name": "Uwe Berger", "kind": "person", "memory_count": 6,
      "brief": "MD of B&B; exclusive DACH GTM partner (18% rev-share)…",
      "memory_ids": ["c4b8…"] }
  ],
  "continuity": [
    { "decision": "Raise B&B commission to 18%", "relation": "UPDATES",
      "prior": "15% rev-share with B&B", "prior_memory_id": "…",
      "reason": "value changed 15%→18%", "confidence": 0.82 }
  ],
  "open_loops": [
    { "kind": "risk", "text": "B&B contract not yet countersigned",
      "source_meeting_id": "…", "memory_id": "…", "age_days": 12 }
  ]
}
```

### 2.4 API

- `GET /api/meetings/:id` — add `intelligence` + `intelligence_status` to the
  response (FE polls this; no new endpoint needed for read).
- `POST /api/meetings/:id/intelligence` — manual (re)generate (admin/owner or
  meeting owner); also used if the async job failed. Returns the same shape.
- The async trigger is internal (enqueue on meeting finish + on
  `POST /api/meetings/:id/ingest`).

### 2.5 Data migration

`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence jsonb;`
`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_status varchar(16) DEFAULT 'none';`
`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_generated_at timestamptz;`
(Add to schema.prisma + run on prod; the meetings handlers already use raw SQL.)

### 2.6 FE — the panel

New component `MeetingIntelligencePanel.jsx` rendered in the meeting detail
(above the transcript, below the insight panels). Three collapsible lanes
matching the approved mockup (👤 briefs / 🔗 connects / ⭕ open). While
`intelligence_status='pending'` show a subtle "cross-referencing your
memory…" shimmer; poll `GET /api/meetings/:id` every 3s (cap ~6 polls). Each
line links to its memory (open the existing memory modal). On `empty`, a single
muted line. Theme: the existing operator-console tokens; the panel card gets the
blue accent border to read as "intelligence".

---

## 3. Phase A — Robust schema + display (build second)

Once the intelligence layer exists, harden the persisted meeting memory:

1. **Normalize `action_items`** — from `{task, owner, due}` strings to
   `{ task, owner_entity, owner_raw, due_iso, status: 'open'|'done' }`. Resolve
   `owner` to a canonical entity tag; parse `due` to ISO. Carry forward
   `status` so Lane-3 open-loop detection becomes exact instead of heuristic.
2. **Canonical entities** — map `insights.entities.{people,organizations}` to
   `entity:<Canonical>` tags via the existing `normalizeEntity` so meeting
   people/orgs join the same graph clusters as everything else (ties into the
   graph-edge-orphans work).
3. **Stable insight contract** — version the insights blob (`schema_version`)
   so the detail view + intelligence generator read a guaranteed shape.
4. **Display polish** — the detail view already renders panels per section;
   add the intelligence panel + an action-items board with owner/due/status
   chips (the robust schema made visible).

Phase A is deliberately scoped down — the durable win is action-item
normalization + canonical entities, which directly sharpen Phase B.

---

## 4. Cost & latency bounds (must-haves)

- Top **6 entities**, top **8 decisions**, **1 recall each**, dedupe by id →
  ~14 recalls + ~2 bounded LLM calls (entity-brief batch + per-decision
  judgment batched) per meeting. Async, so zero added latency on the user path.
- Per-meeting wall budget ~5–10s; hard timeout → write whatever lanes
  completed + `status='ready'` (partial is fine, never block).
- Reuse one embedding/recall per entity; never N× the same query.

---

## 5. Safety / skeptic register

- **Contradiction false-positives** (Lane 2) — the highest-value, highest-risk
  lane. Mitigation: dedicated LLM judgment with a confidence floor + always show
  the prior snippet so the user verifies; phrase as "worth reconciling", never
  "you contradicted yourself". Ship behind the same grounding contract.
- **Tenant isolation** — every recall is `userId`+`orgId` scoped (recall
  functions already enforce); the generator must pass them through, never widen.
- **Hallucination** — hard grounding contract: no `memory_id`, no line.
- **Cost runaway** — fixed caps above; no unbounded fan-out.
- **Stale intelligence** — regenerate on `:id/ingest` (force) and expose the
  manual regen endpoint; show `generated_at` in the panel.
- **Empty-but-noisy** — if nothing relevant, the panel must shrink to one muted
  line, not show three empty lanes.

---

## 6. Testing

- Unit: generator with a fixture meeting + a seeded memory set → asserts each
  lane only emits grounded items, empty input → `status='empty'`.
- Unit: grounding contract — any line without a memory_id is dropped.
- Integration: enqueue → generate → `GET /api/meetings/:id` returns
  `intelligence_status='ready'` with the expected shape.
- Tenant: a memory in org B never surfaces for an org-A meeting.
- Cost: assert recall call count ≤ cap for a meeting with 20 entities.

---

## 7. File map (planned)

| File | Change |
|---|---|
| `core/src/knowledge/meeting-intelligence.js` | NEW — the 3-lane generator |
| `core/src/server.js` | enqueue on finish/ingest; add `intelligence*` to `GET /api/meetings/:id`; `POST /api/meetings/:id/intelligence` |
| `core/prisma/schema.prisma` + migration | `intelligence`, `intelligence_status`, `intelligence_generated_at` |
| `frontend/.../pages/MeetingNotes.jsx` | render panel + poll |
| `frontend/.../components/MeetingIntelligencePanel.jsx` | NEW — 3-lane UI |
| `frontend/.../shared/api-client.js` | `regenerateMeetingIntelligence(id)` |
| Phase A | `meeting-insights` action-item normalization + canonical entity tags in the ingest tree |
