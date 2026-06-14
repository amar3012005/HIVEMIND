# Meeting Intelligence (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a meeting is analyzed, automatically generate a grounded "What HIVEMIND already knows" intelligence panel (entity briefs + decision continuity/contradiction + open loops) and show it in the meeting detail view.

**Architecture:** A pure, dependency-injected generator module (`meeting-intelligence.js`) produces the 3-lane intelligence object from a meeting's insights by calling an injected `recall` function and an injected `judge` (LLM) function — so it unit-tests with fakes, no DB/network. The server wires the real recall + a Groq judge, runs it async (BullMQ enrichment queue, inline fallback) on meeting finish, persists it to a new `meetings.intelligence` jsonb column, and the FE polls `GET /api/meetings/:id` to render it.

**Tech Stack:** Node 20 ESM, `node:test` + `node:assert/strict`, Postgres (raw SQL in the meetings handlers), Groq (`gpt-oss-120b`), React (CRA), Prisma schema (doc-only; prod uses raw SQL).

**Scope:** Phase B only (self-contained, shippable). Phase A (schema hardening) is a separate plan.

**Grounding contract (the rule every task upholds):** every emitted line carries ≥1 real `memory_id`. No id → the line is dropped. All lanes empty → `intelligence_status='empty'`.

---

### Task 1: Database columns for the intelligence result

**Files:**
- Create: `core/prisma/migrations/20260614230000_meeting_intelligence/migration.sql`
- Modify: `core/prisma/schema.prisma` (the `Meeting` model — add 3 fields, doc-only since handlers use raw SQL)

- [ ] **Step 1: Write the migration**

Create `core/prisma/migrations/20260614230000_meeting_intelligence/migration.sql`:

```sql
-- Meeting Intelligence (Phase B): grounded cross-reference of a meeting
-- against existing HIVEMIND memory. Additive, backward-compatible.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence JSONB;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_status VARCHAR(16) NOT NULL DEFAULT 'none';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_generated_at TIMESTAMPTZ(6);
```

- [ ] **Step 2: Add the fields to schema.prisma**

In `core/prisma/schema.prisma`, in the `Meeting` model (find `model Meeting`), add after the `insights` field:

```prisma
  intelligence            Json?     @map("intelligence")
  intelligenceStatus      String    @default("none") @map("intelligence_status") @db.VarChar(16)
  intelligenceGeneratedAt DateTime? @map("intelligence_generated_at") @db.Timestamptz(6)
```

(If there is no `model Meeting` in schema.prisma — the table is raw-SQL only — skip this step; the columns exist via the migration.)

- [ ] **Step 3: Verify the SQL parses**

Run: `cd core && node -e "const fs=require('fs');const s=fs.readFileSync('prisma/migrations/20260614230000_meeting_intelligence/migration.sql','utf8'); if(!/ADD COLUMN IF NOT EXISTS intelligence\b/.test(s)) throw new Error('missing'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add core/prisma/migrations/20260614230000_meeting_intelligence/ core/prisma/schema.prisma
git commit -m "feat(meetings): intelligence columns (jsonb + status + generated_at)"
```

---

### Task 2: Generator module skeleton + grounding helper (pure, injected deps)

**Files:**
- Create: `core/src/knowledge/meeting-intelligence.js`
- Test: `core/tests/unit/meeting-intelligence.test.js`

- [ ] **Step 1: Write the failing test for the grounding filter**

Create `core/tests/unit/meeting-intelligence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyGrounded } from '../../src/knowledge/meeting-intelligence.js';

test('onlyGrounded keeps lines with a memory id, drops the rest', () => {
  const items = [
    { brief: 'has id', memory_ids: ['abc'] },
    { brief: 'empty ids', memory_ids: [] },
    { brief: 'no ids field' },
    { brief: 'single id', memory_id: 'xyz' },
  ];
  const kept = onlyGrounded(items);
  assert.deepEqual(kept.map((i) => i.brief), ['has id', 'single id']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: FAIL — `Cannot find module ... meeting-intelligence.js` or `onlyGrounded is not a function`.

- [ ] **Step 3: Write the minimal module**

Create `core/src/knowledge/meeting-intelligence.js`:

```js
/**
 * Meeting Intelligence — cross-reference a finished meeting against existing
 * HIVEMIND memory and emit three GROUNDED lanes: entity briefs, decision
 * continuity/contradiction, and open loops. Pure + dependency-injected:
 * callers pass `recall` and `judge` so this unit-tests with fakes.
 *
 * GROUNDING CONTRACT: every emitted item carries ≥1 real memory id. Items
 * without one are dropped. All lanes empty → status 'empty'.
 */

/** Keep only items grounded in at least one real memory id. */
export function onlyGrounded(items) {
  return (items || []).filter((it) => {
    if (Array.isArray(it?.memory_ids) && it.memory_ids.length) return true;
    if (typeof it?.memory_id === 'string' && it.memory_id) return true;
    return false;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add core/src/knowledge/meeting-intelligence.js core/tests/unit/meeting-intelligence.test.js
git commit -m "feat(meeting-intel): module skeleton + grounding filter"
```

---

### Task 3: Lane 1 — entity briefs

**Files:**
- Modify: `core/src/knowledge/meeting-intelligence.js`
- Test: `core/tests/unit/meeting-intelligence.test.js`

- [ ] **Step 1: Write the failing test**

Append to `core/tests/unit/meeting-intelligence.test.js`:

```js
import { entityBriefs } from '../../src/knowledge/meeting-intelligence.js';

test('entityBriefs: recalls per entity, drops zero-hit, compresses with judge', async () => {
  const recall = async (q) => q === 'Uwe Berger'
    ? { memories: [{ id: 'm1', title: 'Uwe', content: 'MD of B&B' }, { id: 'm2', content: 'partner' }] }
    : { memories: [] }; // "Nobody" → zero hits → dropped
  // judge returns a brief keyed by entity name
  const judge = async () => ({ briefs: { 'Uwe Berger': 'MD of B&B, DACH partner' } });
  const out = await entityBriefs(
    [{ name: 'Uwe Berger', kind: 'person' }, { name: 'Nobody', kind: 'person' }],
    { recall, judge, maxEntities: 6 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Uwe Berger');
  assert.equal(out[0].memory_count, 2);
  assert.deepEqual(out[0].memory_ids, ['m1', 'm2']);
  assert.equal(out[0].brief, 'MD of B&B, DACH partner');
});

test('entityBriefs caps the number of entities queried', async () => {
  let calls = 0;
  const recall = async () => { calls += 1; return { memories: [{ id: 'x' }] }; };
  const judge = async () => ({ briefs: {} });
  const ents = Array.from({ length: 20 }, (_, i) => ({ name: `E${i}`, kind: 'org' }));
  await entityBriefs(ents, { recall, judge, maxEntities: 6 });
  assert.equal(calls, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: FAIL — `entityBriefs is not a function`.

- [ ] **Step 3: Implement `entityBriefs`**

Add to `core/src/knowledge/meeting-intelligence.js`:

```js
/**
 * Lane 1 — for each entity, recall related memories and compress the top hits
 * into a one-line brief via the injected judge. Zero-hit entities are dropped.
 * @param {{name:string,kind:string}[]} entities
 * @param {{recall:Function, judge:Function, maxEntities?:number}} deps
 */
export async function entityBriefs(entities, { recall, judge, maxEntities = 6 }) {
  const picked = (entities || []).filter((e) => e?.name).slice(0, maxEntities);
  const found = [];
  for (const e of picked) {
    const res = await recall(e.name).catch(() => ({ memories: [] }));
    const mems = (res?.memories || []).slice(0, 5);
    if (!mems.length) continue; // zero-hit → dropped (grounding contract)
    found.push({
      name: e.name,
      kind: e.kind || 'entity',
      memory_count: mems.length,
      memory_ids: mems.map((m) => m.id).filter(Boolean),
      _snippets: mems.map((m) => `${m.title || ''} ${m.content || ''}`.trim().slice(0, 240)),
    });
  }
  if (!found.length) return [];
  // ONE batched judge call compresses every entity's snippets into a brief.
  const briefs = await judge({
    task: 'entity_briefs',
    entities: found.map((f) => ({ name: f.name, snippets: f._snippets })),
  }).then((r) => r?.briefs || {}).catch(() => ({}));
  return onlyGrounded(found.map((f) => ({
    name: f.name,
    kind: f.kind,
    memory_count: f.memory_count,
    memory_ids: f.memory_ids,
    brief: (briefs[f.name] || f._snippets[0] || '').toString().slice(0, 240),
  })));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: PASS (3 tests total).

- [ ] **Step 5: Commit**

```bash
git add core/src/knowledge/meeting-intelligence.js core/tests/unit/meeting-intelligence.test.js
git commit -m "feat(meeting-intel): lane 1 entity briefs (bounded, grounded)"
```

---

### Task 4: Lane 2 — continuity / contradiction

**Files:**
- Modify: `core/src/knowledge/meeting-intelligence.js`
- Test: `core/tests/unit/meeting-intelligence.test.js`

- [ ] **Step 1: Write the failing test**

Append to `core/tests/unit/meeting-intelligence.test.js`:

```js
import { continuity } from '../../src/knowledge/meeting-intelligence.js';

test('continuity: emits UPDATES/CONFLICTS above floor, drops NEW + low-confidence + ungrounded', async () => {
  const recall = async (q) => {
    if (q.includes('18%')) return { memories: [{ id: 'p1', content: '15% rev-share with B&B' }] };
    if (q.includes('Austria')) return { memories: [{ id: 'p2', content: 'Germany-first, Austria phase 2' }] };
    if (q.includes('Switzerland')) return { memories: [] }; // net-new → no prior → omitted
    return { memories: [] };
  };
  const judge = async ({ pairs }) => ({
    results: pairs.map((p) => {
      if (p.decision.includes('18%')) return { relation: 'UPDATES', reason: '15→18', confidence: 0.82 };
      if (p.decision.includes('Austria')) return { relation: 'CONFLICTS', reason: 'order', confidence: 0.4 }; // below floor → dropped
      return { relation: 'NEW', confidence: 0.9 };
    }),
  });
  const out = await continuity(
    ['Raise B&B commission to 18%', 'Launch in Austria first', 'Add Switzerland'],
    { recall, judge, maxDecisions: 8, minConfidence: 0.6 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].relation, 'UPDATES');
  assert.equal(out[0].prior_memory_id, 'p1');
  assert.equal(out[0].confidence, 0.82);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: FAIL — `continuity is not a function`.

- [ ] **Step 3: Implement `continuity`**

Add to `core/src/knowledge/meeting-intelligence.js`:

```js
/**
 * Lane 2 — for each decision, recall the most-similar prior decision/fact and
 * ask the judge whether this decision is NEW / UPDATES / CONFLICTS. Only
 * UPDATES & CONFLICTS above the confidence floor AND grounded in a prior
 * memory id are emitted. Phrased as "worth reconciling", never accusatory.
 */
export async function continuity(decisions, { recall, judge, maxDecisions = 8, minConfidence = 0.6 }) {
  const picked = (decisions || []).filter((d) => typeof d === 'string' && d.trim()).slice(0, maxDecisions);
  const pairs = [];
  for (const decision of picked) {
    const res = await recall(decision).catch(() => ({ memories: [] }));
    const prior = (res?.memories || [])[0];
    if (!prior?.id) continue; // no prior memory → can't be UPDATES/CONFLICTS
    pairs.push({ decision, prior_memory_id: prior.id, prior_snippet: (prior.content || prior.title || '').slice(0, 200) });
  }
  if (!pairs.length) return [];
  const judged = await judge({
    task: 'continuity',
    pairs: pairs.map((p) => ({ decision: p.decision, prior: p.prior_snippet })),
  }).then((r) => r?.results || []).catch(() => []);
  const out = [];
  pairs.forEach((p, i) => {
    const j = judged[i] || {};
    const rel = j.relation;
    if ((rel === 'UPDATES' || rel === 'CONFLICTS') && Number(j.confidence) >= minConfidence) {
      out.push({
        decision: p.decision,
        relation: rel,
        prior: p.prior_snippet,
        prior_memory_id: p.prior_memory_id,
        reason: (j.reason || '').toString().slice(0, 160),
        confidence: Number(j.confidence),
      });
    }
  });
  return out; // already grounded — every item has prior_memory_id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add core/src/knowledge/meeting-intelligence.js core/tests/unit/meeting-intelligence.test.js
git commit -m "feat(meeting-intel): lane 2 continuity/contradiction (floor + grounded)"
```

---

### Task 5: Lane 3 — open loops + the `generateIntelligence` orchestrator

**Files:**
- Modify: `core/src/knowledge/meeting-intelligence.js`
- Test: `core/tests/unit/meeting-intelligence.test.js`

- [ ] **Step 1: Write the failing test**

Append to `core/tests/unit/meeting-intelligence.test.js`:

```js
import { openLoops, generateIntelligence } from '../../src/knowledge/meeting-intelligence.js';

test('openLoops: surfaces unresolved risk/action memories, grounded', async () => {
  const recall = async () => ({ memories: [
    { id: 'r1', content: 'B&B contract not countersigned', tags: ['risk'], created_at: '2026-06-01T00:00:00Z', meeting_id: 'mtg-old' },
    { id: 'd1', content: 'random doc', tags: ['fact'] }, // not a risk/action → ignored
  ] });
  const out = await openLoops(['B&B'], { recall, maxTopics: 6 });
  assert.equal(out.length, 1);
  assert.equal(out[0].memory_id, 'r1');
  assert.equal(out[0].kind, 'risk');
});

test('generateIntelligence: all lanes empty → status empty', async () => {
  const recall = async () => ({ memories: [] });
  const judge = async () => ({ briefs: {}, results: [] });
  const meeting = { insights: { entities: { people: ['X'], organizations: [] }, decisions: ['Y'], topics: ['Z'] } };
  const out = await generateIntelligence(meeting, { recall, judge });
  assert.equal(out.status, 'empty');
  assert.equal(out.entities.length, 0);
  assert.equal(out.continuity.length, 0);
  assert.equal(out.open_loops.length, 0);
});

test('generateIntelligence: any populated lane → status ready + related_count', async () => {
  const recall = async (q) => q === 'X' ? { memories: [{ id: 'm1', content: 'about X' }] } : { memories: [] };
  const judge = async () => ({ briefs: { X: 'X is a person' }, results: [] });
  const meeting = { insights: { entities: { people: ['X'], organizations: [] }, decisions: [], topics: [] } };
  const out = await generateIntelligence(meeting, { recall, judge });
  assert.equal(out.status, 'ready');
  assert.equal(out.entities.length, 1);
  assert.ok(out.related_count >= 1);
  assert.ok(out.generated_at);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: FAIL — `openLoops is not a function`.

- [ ] **Step 3: Implement `openLoops` + `generateIntelligence`**

Add to `core/src/knowledge/meeting-intelligence.js`:

```js
const LOOP_KINDS = ['risk', 'next-step', 'goal', 'action'];

/**
 * Lane 3 — recall prior risk/action/next-step memories on the meeting's
 * topics/entities that look unresolved. Heuristic: the memory itself is a
 * risk/action tag. (Exact resolution comes in Phase A via action-item status.)
 */
export async function openLoops(topics, { recall, maxTopics = 6 }) {
  const picked = (topics || []).filter((tp) => typeof tp === 'string' && tp.trim()).slice(0, maxTopics);
  const seen = new Set();
  const out = [];
  for (const tp of picked) {
    const res = await recall(tp).catch(() => ({ memories: [] }));
    for (const m of (res?.memories || [])) {
      if (!m?.id || seen.has(m.id)) continue;
      const tags = Array.isArray(m.tags) ? m.tags : [];
      const kind = LOOP_KINDS.find((k) => tags.includes(k));
      if (!kind) continue;
      seen.add(m.id);
      out.push({
        kind,
        text: (m.content || m.title || '').toString().slice(0, 200),
        memory_id: m.id,
        source_meeting_id: m.meeting_id || null,
        created_at: m.created_at || null,
      });
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return onlyGrounded(out);
}

/**
 * Orchestrator — runs all three lanes within bounded cost and assembles the
 * intelligence object. Never throws (best-effort enrichment); a failed lane
 * contributes nothing. Status: 'ready' if anything grounded, else 'empty'.
 */
export async function generateIntelligence(meeting, { recall, judge, nowIso }) {
  const ins = (meeting?.insights && typeof meeting.insights === 'object') ? meeting.insights : {};
  const people = Array.isArray(ins.entities?.people) ? ins.entities.people : [];
  const orgs = Array.isArray(ins.entities?.organizations) ? ins.entities.organizations : [];
  const ents = [
    ...people.map((n) => ({ name: String(n), kind: 'person' })),
    ...orgs.map((n) => ({ name: String(n), kind: 'org' })),
  ];
  const [entities, cont, loops] = await Promise.all([
    entityBriefs(ents, { recall, judge }).catch(() => []),
    continuity(Array.isArray(ins.decisions) ? ins.decisions : [], { recall, judge }).catch(() => []),
    openLoops(Array.isArray(ins.topics) ? ins.topics : [], { recall }).catch(() => []),
  ]);
  const related = entities.reduce((s, e) => s + (e.memory_count || 0), 0) + cont.length + loops.length;
  const has = entities.length || cont.length || loops.length;
  return {
    generated_at: nowIso || new Date().toISOString(),
    related_count: related,
    entities,
    continuity: cont,
    open_loops: loops,
    status: has ? 'ready' : 'empty',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test tests/unit/meeting-intelligence.test.js`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add core/src/knowledge/meeting-intelligence.js core/tests/unit/meeting-intelligence.test.js
git commit -m "feat(meeting-intel): lane 3 open loops + generateIntelligence orchestrator"
```

---

### Task 6: Server wiring — recall+judge adapters, async trigger, read + regen endpoints

**Files:**
- Modify: `core/src/server.js` (meetings region, ~5298–5470)

- [ ] **Step 1: Add the real recall + judge adapters + runner (helper, near the meetings handlers)**

In `core/src/server.js`, just ABOVE the `POST /api/meetings/:id/ingest` block (search `meetings/([0-9a-fA-F-]{36})/ingest`), insert:

```js
      // ── Meeting Intelligence runner ──────────────────────────────────────
      // Wires the pure generator to real recall + a Groq judge, runs it, and
      // persists the result to the meeting row. Best-effort, never throws.
      async function runMeetingIntelligence(meetingId, mUser, mOrg) {
        try {
          const rows = await prisma.$queryRawUnsafe(
            `SELECT id, insights FROM meetings WHERE id=$1::uuid AND org_id=$2::uuid AND deleted_at IS NULL`,
            meetingId, mOrg,
          );
          const meeting = rows?.[0];
          if (!meeting) return;
          await prisma.$executeRawUnsafe(
            `UPDATE meetings SET intelligence_status='pending' WHERE id=$1::uuid`, meetingId,
          );
          const { generateIntelligence } = await import('./knowledge/meeting-intelligence.js');
          // Real recall — tenant-scoped, excludes this meeting's own children.
          const recall = async (query) => {
            const r = await recallPersistedMemories(persistentMemoryStore, {
              query, userId: mUser, orgId: mOrg, limit: 5,
            }).catch(() => null);
            const memories = (r?.memories || r || []).map((m) => ({
              id: m.id, title: m.title, content: m.content, tags: m.tags,
              created_at: m.created_at || m.createdAt, meeting_id: (m.tags || []).find?.((t) => t.startsWith?.('meeting:'))?.slice(8) || null,
            })).filter((m) => !(m.tags || []).includes(`meeting:${meetingId}`));
            return { memories };
          };
          // Single Groq judge for both entity_briefs and continuity tasks.
          const judge = async (payload) => {
            const sys = payload.task === 'entity_briefs'
              ? 'For each entity, write ONE factual sentence ("brief") summarizing the snippets. STRICT JSON {"briefs":{"<name>":"<brief>"}}. Never invent — only use the snippets.'
              : 'For each {decision,prior} pair decide if the decision is NEW, UPDATES, or CONFLICTS vs the prior memory. STRICT JSON {"results":[{"relation":"NEW|UPDATES|CONFLICTS","reason":"<short>","confidence":0..1}]} in pair order. Be conservative; default NEW when unsure.';
            const resp = await fetch(`${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: process.env.MEETING_INSIGHTS_MODEL || 'openai/gpt-oss-120b',
                temperature: 0.1, response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(payload) }],
              }),
              signal: AbortSignal.timeout(60_000),
            });
            if (!resp.ok) return {};
            try { return JSON.parse((await resp.json()).choices[0].message.content); } catch { return {}; }
          };
          const intel = await generateIntelligence(meeting, { recall, judge });
          await prisma.$executeRawUnsafe(
            `UPDATE meetings SET intelligence=$1::jsonb, intelligence_status=$2, intelligence_generated_at=now() WHERE id=$3::uuid`,
            JSON.stringify(intel), intel.status, meetingId,
          );
        } catch (e) {
          console.warn('[meeting-intel] generate failed:', e.message);
          try { await prisma.$executeRawUnsafe(`UPDATE meetings SET intelligence_status='error' WHERE id=$1::uuid`, meetingId); } catch { /* ignore */ }
        }
      }
```

- [ ] **Step 2: Enqueue on meeting create (fire-and-forget, never blocks the response)**

In the `POST /api/meetings` handler (search `pathname === '/api/meetings' && req.method === 'POST'`), find the success `return jsonResponse(res, { ok: true, id: rows?.[0]?.id ...`. Immediately BEFORE that return, add:

```js
          // Kick off the intelligence generation async — do NOT await.
          const _newId = rows?.[0]?.id;
          if (_newId) { runMeetingIntelligence(_newId, mUser, mOrg).catch(() => {}); }
```

- [ ] **Step 3: Include intelligence in the detail response**

In the `GET /api/meetings/:id` handler (search `meetings/([0-9a-fA-F-]{36})$` or the detail SELECT), add `intelligence, intelligence_status, intelligence_generated_at` to the SELECT column list and to the returned `meeting` object. The returned object must include:

```js
            intelligence: row.intelligence || null,
            intelligence_status: row.intelligence_status || 'none',
            intelligence_generated_at: row.intelligence_generated_at || null,
```

- [ ] **Step 4: Add the manual regen endpoint**

Immediately after the `GET /api/meetings/:id` block, add:

```js
      // POST /api/meetings/:id/intelligence — (re)generate the intelligence panel.
      {
        const mIntel = pathname.match(/^\/api\/meetings\/([0-9a-fA-F-]{36})\/intelligence$/);
        if (mIntel && req.method === 'POST') {
          if (!prisma) return jsonResponse(res, { error: 'db_unavailable' }, 503);
          const mOrg = req.headers['x-hm-org-id'] || DEFAULT_ORG;
          const mUser = req.headers['x-hm-user-id'] || DEFAULT_USER;
          runMeetingIntelligence(mIntel[1], mUser, mOrg).catch(() => {});
          return jsonResponse(res, { ok: true, status: 'pending' }, 202);
        }
      }
```

- [ ] **Step 5: Syntax check**

Run: `cd core && node --check src/server.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add core/src/server.js
git commit -m "feat(meetings): async intelligence runner + detail field + regen endpoint"
```

---

### Task 7: Frontend — intelligence panel + poll + api-client

**Files:**
- Create: `frontend/Da-vinci/src/components/hivemind/app/components/MeetingIntelligencePanel.jsx`
- Modify: `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`
- Modify: `frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx`

- [ ] **Step 1: Add the api-client method**

In `api-client.js`, near the other meeting methods, add:

```js
  async regenerateMeetingIntelligence(id) {
    const { data } = await this.core.post(`/api/meetings/${id}/intelligence`, {});
    return data;
  }
```

- [ ] **Step 2: Create the panel component**

Create `MeetingIntelligencePanel.jsx`:

```jsx
import React from 'react';
import { Brain, User, GitBranch, CircleDot, ArrowUpRight } from 'lucide-react';

const REL = {
  UPDATES:   { label: 'UPDATES',   color: '#b45309', bg: '#fff3e0', bd: '#fde0b8' },
  CONFLICTS: { label: 'CONFLICTS', color: '#dc2626', bg: '#fef2f2', bd: '#fecaca' },
};

export default function MeetingIntelligencePanel({ intelligence, status, onOpenMemory }) {
  if (status === 'pending' || status === 'none') {
    return (
      <div className="bg-white border border-[#117dff]/30 rounded-[12px] p-4 flex items-center gap-2">
        <Brain size={15} className="text-[#117dff] animate-pulse" />
        <span className="text-[12px] text-[#737373]">Cross-referencing your memory…</span>
      </div>
    );
  }
  if (status === 'empty' || !intelligence) {
    return (
      <div className="bg-white border border-[#e3e0db] rounded-[12px] p-3 flex items-center gap-2">
        <Brain size={14} className="text-[#a3a3a3]" />
        <span className="text-[12px] text-[#a3a3a3]">Nothing related in your memory yet.</span>
      </div>
    );
  }
  const { entities = [], continuity = [], open_loops = [], related_count = 0 } = intelligence;
  const open = (id) => id && onOpenMemory?.(id);
  return (
    <div className="bg-white border border-[#117dff] rounded-[12px] overflow-hidden shadow-[0_1px_3px_rgba(17,125,255,0.08)]">
      <div className="px-4 py-3 border-b border-[#eaf2ff] bg-gradient-to-br from-[#117dff]/[0.04] to-white flex items-center gap-2">
        <Brain size={16} className="text-[#117dff]" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#0a0a0a] font-['Space_Grotesk']">What HIVEMIND already knows</div>
          <div className="text-[11px] text-[#737373]">{related_count} related memories cross-referenced</div>
        </div>
      </div>

      {entities.length > 0 && (
        <div className="px-4 py-3 border-b border-[#f3f1ec]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#737373] mb-2 flex items-center gap-1"><User size={11} /> Who &amp; what's involved</div>
          {entities.map((e, i) => (
            <button key={i} onClick={() => open(e.memory_ids?.[0])} className="w-full text-left flex items-start gap-2 p-2 rounded-[8px] hover:bg-[#faf9f4] transition-colors">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold text-[#0a0a0a]">{e.name} <span className="text-[10px] font-normal text-[#a3a3a3]">· {e.kind} · {e.memory_count} memories</span></div>
                <div className="text-[12px] text-[#525252] leading-snug">{e.brief}</div>
              </div>
              <ArrowUpRight size={12} className="text-[#a3a3a3] mt-0.5 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {continuity.length > 0 && (
        <div className="px-4 py-3 border-b border-[#f3f1ec]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#737373] mb-2 flex items-center gap-1"><GitBranch size={11} /> How this connects to past decisions</div>
          {continuity.map((c, i) => {
            const r = REL[c.relation] || REL.UPDATES;
            return (
              <button key={i} onClick={() => open(c.prior_memory_id)} className="w-full text-left flex items-start gap-2 mb-1.5">
                <span className="text-[9px] font-bold rounded px-1.5 py-0.5 shrink-0 mt-0.5" style={{ color: r.color, background: r.bg, border: `1px solid ${r.bd}` }}>{r.label}</span>
                <span className="text-[12px] text-[#525252] leading-snug"><b>“{c.decision}”</b> — {c.reason} <span className="text-[#a3a3a3]">(prior: {c.prior})</span></span>
              </button>
            );
          })}
        </div>
      )}

      {open_loops.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#737373] mb-2 flex items-center gap-1"><CircleDot size={11} /> Still-open from before</div>
          {open_loops.map((o, i) => (
            <button key={i} onClick={() => open(o.memory_id)} className="w-full text-left flex items-start gap-2 mb-1.5">
              <span className="text-[12px] shrink-0 mt-0.5" style={{ color: o.kind === 'risk' ? '#dc2626' : '#117dff' }}>{o.kind === 'risk' ? '!' : '☐'}</span>
              <span className="text-[12px] text-[#525252] leading-snug">{o.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Render + poll in MeetingNotes.jsx**

In `MeetingNotes.jsx`: (a) import the panel at the top:

```jsx
import MeetingIntelligencePanel from '../components/MeetingIntelligencePanel';
```

(b) In the detail view (`openMeeting`), after `setSelected`, add a poll that refetches the meeting while `intelligence_status === 'pending'`. Inside the component body add:

```jsx
  // Poll the open meeting's intelligence until it's ready (async generation).
  useEffect(() => {
    if (!selected?.id) return;
    const st = selected.intelligence_status;
    if (st !== 'pending' && st !== 'none') return;
    let n = 0; let cancelled = false;
    const iv = setInterval(async () => {
      n += 1;
      if (cancelled || n > 6) { clearInterval(iv); return; }
      try {
        const { data } = await apiClient.core.get(`/api/meetings/${selected.id}`);
        const m = data?.meeting;
        if (m && (m.intelligence_status === 'ready' || m.intelligence_status === 'empty' || m.intelligence_status === 'error')) {
          setSelected((cur) => (cur && cur.id === m.id ? { ...cur, ...m } : cur));
          clearInterval(iv);
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selected?.id, selected?.intelligence_status]);
```

(c) In the detail render (where insight Panels render for a selected past meeting), add the panel ABOVE the transcript Panel:

```jsx
              <MeetingIntelligencePanel
                intelligence={selected?.intelligence}
                status={selected?.intelligence_status}
                onOpenMemory={(id) => window.open(`/hivemind/app/memories?focus=${id}`, '_self')}
              />
```

- [ ] **Step 4: Build (strict ESLint)**

Run: `cd frontend/Da-vinci && CI=true npm run build 2>&1 | grep -E "Failed|Line .*:|ready" | head`
Expected: `The build folder is ready to be deployed.` (no `Failed`/`Line` errors). Fix any unused import flagged.

- [ ] **Step 5: Commit**

```bash
git add frontend/Da-vinci/src/components/hivemind/app/components/MeetingIntelligencePanel.jsx \
        frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js \
        frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx
git commit -m "feat(meeting-notes): intelligence panel + async poll + regen client"
```

---

### Task 8: Deploy + production verification

**Files:** none (ops)

- [ ] **Step 1: Push + bump submodule**

```bash
git push origin main
# (Da-vinci submodule bump if frontend changed — follow repo deploy pattern)
```

- [ ] **Step 2: Apply the migration on prod**

Run (on `myserver`):
```bash
PG=$(docker ps --format '{{.Names}}' | grep -E '^postgres-s0k0' | head -1)
docker exec -e PGPASSWORD="hivemind_secure_pwd_2026" "$PG" psql -U hivemind_user -d hivemind \
  -c "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence jsonb;" \
  -c "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_status varchar(16) NOT NULL DEFAULT 'none';" \
  -c "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_generated_at timestamptz;"
```

- [ ] **Step 3: Deploy core (bind-mount + restart BOTH replicas)**

```bash
cd /opt/HIVEMIND && git fetch origin --quiet
git checkout origin/main -- core/src/server.js core/src/knowledge/meeting-intelligence.js
node --check core/src/server.js
docker restart hm-core hm-core-2 && sleep 24
docker exec hm-core sh -c "curl -s -m8 -o /dev/null -w 'core=%{http_code}\n' http://localhost:3000/health"
```

- [ ] **Step 4: Smoke test the runner against a real past meeting**

```bash
MK=$(docker exec hm-core printenv HIVEMIND_MASTER_API_KEY)
# pick a real meeting id + its org/user, trigger regen, then read it back
docker exec hm-core sh -c "curl -s -X POST 'http://localhost:3000/api/meetings/<MID>/intelligence' -H \"X-API-Key: $MK\" -H 'X-HM-Org-Id: <ORG>' -H 'X-HM-User-Id: <U>'"
sleep 8
docker exec hm-core sh -c "curl -s 'http://localhost:3000/api/meetings/<MID>' -H \"X-API-Key: $MK\" -H 'X-HM-Org-Id: <ORG>'" | python3 -c "import sys,json;d=json.load(sys.stdin)['meeting'];print('status=',d.get('intelligence_status'));print(json.dumps(d.get('intelligence'),indent=2)[:600])"
```
Expected: `status= ready` (or `empty` if the org has no related memory) and a grounded intelligence object — every entity/continuity/open-loop item carries a memory id.

- [ ] **Step 5: Poll Vercel for the FE chunk + visual confirm**

Poll the asset manifest for the new chunk, then open a past meeting on `/hivemind/app/meeting-notes` and confirm the "What HIVEMIND already knows" panel renders (or the muted empty state).

---

## Self-Review

**Spec coverage:** §2.1 trigger (Task 6 enqueue) ✓ · §2.2 three lanes (Tasks 3–5) ✓ · §2.3 output schema (Task 5 orchestrator shape) ✓ · §2.4 API GET+POST (Task 6) ✓ · §2.5 migration (Task 1) ✓ · §2.6 FE panel+poll (Task 7) ✓ · §4 cost bounds (maxEntities 6 / maxDecisions 8 / limit 5, Tasks 3–5) ✓ · §5 grounding contract (Task 2 `onlyGrounded`, enforced every lane) + confidence floor (Task 4) + tenant scope (Task 6 recall passes userId/orgId) ✓ · §6 tests (Tasks 2–5) ✓.

**Placeholder scan:** `<MID>/<ORG>/<U>` in Task 8 are real runtime values the operator fills from a live meeting — acceptable for an ops step, not code placeholders. No code placeholders remain.

**Type consistency:** `generateIntelligence` returns `{ generated_at, related_count, entities, continuity, open_loops, status }` — matches the FE panel destructure (Task 7) and the GET response (Task 6). `entityBriefs` item `{ name, kind, memory_count, memory_ids, brief }` matches the panel. `continuity` item `{ decision, relation, prior, prior_memory_id, reason, confidence }` matches. `openLoops` item `{ kind, text, memory_id, source_meeting_id, created_at }` matches. Consistent.

**Note:** Phase A (action-item normalization + canonical entities + display polish) is a SEPARATE plan — this plan ships Phase B end-to-end on its own.
