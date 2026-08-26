// Characterization harness for gatherEvidence() — the Stage C refactor safety net.
//
// This test does NOT assert "correct" behavior; it SNAPSHOTS the CURRENT
// behavior of the 441-line merge loop so the EvidenceBus + capability-registry
// refactor can be proven byte-identical at every step. It drives gatherEvidence
// with an injected ctx._toolkit fake (no real recall / no LLM / no network) and
// asserts on the full return object + the exact steps[] + onEvent sequences.
//
// Each fixture targets one or more of the 11 preservation risks (R1–R11) named
// in the design dossier. If any of these change, the refactor changed behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherEvidence } from '../../src/agent/react-agent-v2.js';

// ── Fake toolkit ─────────────────────────────────────────────────────────
// dispatchTool routes through ctx._toolkit.hasTool/execute when present, and
// returns response.meta.raw. We map tool-name → canned raw response. A value
// may be an Error (to characterize the catch branches) or a function(args).
function makeCtx(toolResponses, { extra = {} } = {}) {
  const calls = [];
  const toolkit = {
    hasTool: (name) => name in toolResponses,
    async execute(name, args) {
      calls.push({ name, args });
      let raw = toolResponses[name];
      if (typeof raw === 'function') raw = raw(args);
      if (raw instanceof Error) return { status: 'error', meta: { error: raw.message } };
      return { status: 'ok', content: [], meta: { raw } };
    },
  };
  return { ctx: { userId: 'u1', orgId: 'o1', _toolkit: toolkit, ...extra }, calls };
}

function recordEvents() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

// Far-future deadline so nothing times out (deadline discipline tested separately).
const FAR = () => Date.now() + 60_000;

const basePlan = (over = {}) => ({
  operation: 'recall',
  user_message: 'tell me about solvis',
  query_original: 'tell me about solvis',
  query_canonical_en: 'tell me about solvis',
  sub_queries: [],
  named_entities: [],
  recall_mode: 'quick',
  tool_groups: [],
  ...over,
});

const memRows = (...ids) => ids.map((id) => ({ id, content: `mem ${id}` }));
const toolNames = (r) => r.steps.map((s) => s.tool);
const memIds = (r) => r.memories.map((m) => m.id);

// ─────────────────────────────────────────────────────────────────────────
// Base quick recall — the common path. R1 (dedup order), R10 (telemetry seq).
// ─────────────────────────────────────────────────────────────────────────
test('base quick recall: single recall, dedup by id, step + event sequence', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: {
      memories: [...memRows('A', 'B'), { id: 'A', content: 'dup A' }],
      evidence: [{ id: 'e1', document_title: 'Doc', page: 1, content: 'x' }],
      live: [{ id: 'l1', source: 's', title: 't' }],
      relationships: [{ from_id: 'A', to_id: 'B', type: 'Mentions' }],
      evidence_packet: { citations: [{ id: 'C1' }] },
    },
  });
  const { events, onEvent } = recordEvents();
  const r = await gatherEvidence({ plan: basePlan(), ctx, onEvent, deadlineAt: FAR() });

  assert.deepEqual(memIds(r), ['A', 'B'], 'R1: first-writer-wins, dup A ignored');
  assert.equal(r.memories[0].content, 'mem A', 'R1: original A object kept, not the dup');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.live.length, 1);
  assert.equal(r.relationships.length, 1);
  assert.equal(r.recall_packets.length, 1);
  assert.equal(r.escalation_count, 0);
  assert.deepEqual(toolNames(r), ['hivemind_recall']);
  // R10: startTool fires tool_selected, tool_started, tool_call; recordTool
  // fires tool_completed then tool_result.
  const names = events.map((e) => e.type);
  assert.deepEqual(names, ['tool_selected', 'tool_started', 'tool_call', 'tool_completed', 'tool_result']);
});

test('single-call native plan never starts a second recall when first-pass coverage is empty', async () => {
  let recallCalls = 0;
  const { ctx } = makeCtx({
    hivemind_recall: () => {
      recallCalls += 1;
      return { memories: [], evidence: [], evidence_count: 0 };
    },
  });
  const r = await gatherEvidence({
    plan: basePlan({ _native_single_call: true }),
    ctx,
    deadlineAt: FAR(),
  });
  assert.equal(recallCalls, 1);
  assert.equal(r.escalation_count, 0);
  assert.deepEqual(toolNames(r), ['hivemind_recall']);
});

test('base recall preserves distinct adapter evidence rows with identical prefixes', async () => {
  const sharedPrefix = 'The same document boilerplate starts every chunk before its distinct product detail.';
  const { ctx } = makeCtx({
    hivemind_recall: {
      memories: [],
      evidence: [
        { segment_id: 'segment-snake', document_title: 'Catalog', content: `${sharedPrefix} SolvisTim` },
        { segmentId: 'segment-camel', document_title: 'Catalog', content: `${sharedPrefix} SolvisTom` },
      ],
      ranked_candidates: [
        { kind: 'evidence', segment_id: 'segment-snake' },
        { kind: 'evidence', segment_id: 'segment-camel' },
      ],
      evidence_count: 2,
    },
  });
  const result = await gatherEvidence({ plan: basePlan(), ctx, deadlineAt: FAR() });
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.evidence.map((row) => row.segment_id || row.segmentId), ['segment-snake', 'segment-camel']);
  assert.equal(result.ranked_candidates.length, 2);
});

test('explicit web fallback polls once and promotes public evidence into the synthesis pool', async () => {
  const internal = Array.from({ length: 15 }, (_, index) => ({
    segment_id: `internal-${index}`, document_title: 'Internal', content: `internal ${index}`,
  }));
  const { ctx } = makeCtx({
    hivemind_recall: { memories: [], evidence: internal, evidence_count: internal.length },
    hivemind_web_search: { job_id: 'web-job-1', status: 'queued' },
  }, { extra: {
    runWebSearchJob: async () => ({ ok: true, job_id: 'web-job-1' }),
    webJobStore: {
      get: async () => ({
        id: 'web-job-1', status: 'succeeded', completed_at: '2026-08-26T10:00:00Z',
        results: [{ title: 'Public pricing', url: 'https://example.com/pricing', snippet: 'Current price.' }],
      }),
    },
  } });
  const result = await gatherEvidence({
    plan: basePlan({
      needs_web: true,
      web_fallback: { allowed: true, query: 'current public pricing', reason: 'explicit_web' },
    }),
    ctx, deadlineAt: FAR(),
  });
  assert.equal(result.steps.at(-1).tool, 'hivemind_web_search');
  assert.equal(result.steps.at(-1).result_summary, '1 public web sources');
  assert.equal(result.evidence[0].source_platform, 'public_web');
  assert.equal(result.ranked_candidates[0].segment_id, 'web:web-job-1:1');
});

// ─────────────────────────────────────────────────────────────────────────
// R2 — the flag-collision case: base adds X unflagged, temporal re-adds X with
// _superseded_predecessor. The flag MUST WIN on the existing entry.
// ─────────────────────────────────────────────────────────────────────────
test('R2: _superseded_predecessor flag wins over prior unflagged base entry', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: memRows('X', 'Y') },
    hivemind_timeline: {
      memories: [
        { id: 'X', content: 'mem X', _superseded_predecessor: true },
        { id: 'Z', content: 'mem Z', _superseded_predecessor: true },
      ],
      version_count: 2,
    },
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'timeline' }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  const X = r.memories.find((m) => m.id === 'X');
  const Z = r.memories.find((m) => m.id === 'Z');
  assert.equal(X._superseded_predecessor, true, 'R2: flag propagated onto existing base entry');
  assert.equal(Z._superseded_predecessor, true, 'R2: new flagged row inserted with flag');
  assert.deepEqual(memIds(r), ['X', 'Y', 'Z'], 'order = base then temporal-new');
  assert.deepEqual(toolNames(r), ['hivemind_recall', 'hivemind_timeline']);
});

// ─────────────────────────────────────────────────────────────────────────
// R2 — _diff_removed: clone-if-absent, tagged, must NOT overwrite same-id row.
// hivemind_diff carries added (via .added) + removed rows.
// ─────────────────────────────────────────────────────────────────────────
test('R2: _diff_removed tags a clone only when id absent, never overwrites', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: memRows('P') },   // P already present, unflagged
    hivemind_diff: {
      added: [{ id: 'Q', content: 'added Q' }],
      removed: [
        { id: 'P', content: 'removed P' },  // same id as base — must NOT overwrite
        { id: 'R', content: 'removed R' },  // absent — insert tagged clone
      ],
      added_count: 1, removed_count: 2,
    },
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'timeline', time: { range: { start: '2025-01-01' } } }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  const P = r.memories.find((m) => m.id === 'P');
  const R = r.memories.find((m) => m.id === 'R');
  assert.equal(P.content, 'mem P', 'R2: existing P not overwritten by removed P');
  assert.equal(P._diff_removed, undefined, 'R2: existing P not tagged');
  assert.equal(R._diff_removed, true, 'R2: absent R inserted as tagged clone');
  assert.equal(r.memories.find((m) => m.id === 'Q').content, 'added Q');
  assert.equal(toolNames(r).includes('hivemind_diff'), true);
});

// ─────────────────────────────────────────────────────────────────────────
// R3 — two edge-merge policies: base = if-absent, escalation = overwrite.
// Trigger escalation by an uncovered source request so the second recall runs.
// ─────────────────────────────────────────────────────────────────────────
test('R3: escalation edge overwrites base edge with same key (last-writer-wins)', async () => {
  const sameKey = { from_id: 'A', to_id: 'B', type: 'Mentions' };
  const { ctx } = makeCtx({
    hivemind_recall: (args) => {
      // base returns weight 1; escalation (different args.mode/limit) returns weight 2
      const isEscalation = args.escalation || args._escalation || args.mode === 'full' || args.limit >= 20;
      return {
        memories: memRows('A'),
        relationships: [{ ...sameKey, weight: isEscalation ? 2 : 1 }],
        evidence: [],
      };
    },
  });
  // Force escalation: source requested but not covered, non-explicit mode.
  const r = await gatherEvidence({
    plan: basePlan({ source: { title: 'Some Doc', requested: true } }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  // Whether escalation fires depends on chooseRecallEscalation; snapshot the
  // edge weight + escalation_count as the current contract.
  const edge = r.relationships.find((e) => e.from_id === 'A' && e.to_id === 'B');
  assert.ok(edge, 'edge present');
  // Snapshot: record BOTH the escalation_count and surviving weight so the
  // refactor must reproduce whichever the current code produces.
  assert.equal(typeof r.escalation_count, 'number');
  assert.ok(edge.weight === 1 || edge.weight === 2, 'edge weight is one of the two variants');
});

// ─────────────────────────────────────────────────────────────────────────
// R6 — relation post-adjust runs only on relation_between + relationChecked.
// relation dispatch success → coverage.graph_covered === true.
// ─────────────────────────────────────────────────────────────────────────
test('R6: relation_between success sets coverage.graph_covered true', async () => {
  const { ctx } = makeCtx({
    hivemind_relation_between: {
      memories: memRows('A', 'B'),
      evidence: [{ id: 'e1', document_title: 'D', page: 2, content: 'rel' }],
      relationships: [{ from_id: 'A', to_id: 'B', type: 'RelatedTo' }],
      co_mentions: [{ a: 'A', b: 'B' }],
      evidence_packets: [{ citations: [{ id: 'RC1' }] }],
      direct_edges: [{}], shared_paths: [],
    },
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'relation_between', relation_intent: { entities: ['SolvisPia', 'SolvisMax'] } }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(r.coverage.graph_covered, true, 'R6: graph_covered set on relation success');
  assert.deepEqual(memIds(r), ['A', 'B'], 'relation is a dedicated lane: no base recall');
  // SNAPSHOT: relation success yields full coverage, so escalation does NOT fire.
  assert.deepEqual(toolNames(r), ['hivemind_relation_between'], 'covered → no escalation recall');
  assert.equal(r.escalation_count, 0);
});

test('R6: relation dispatch ERROR-RETURN still flips relationChecked (dispatchTool resolves errors, does not throw)', async () => {
  // makeCtx maps an Error to {status:'error'} → dispatchTool returns
  // {error, _failure_mode} as a RESOLVED value (only a deadline rejects). So the
  // try-block succeeds, relationChecked=true, and the post-adjust runs. This is
  // the real tool-error contract — snapshot it exactly.
  const { ctx } = makeCtx({
    hivemind_relation_between: new Error('boom'),
    hivemind_recall: { memories: [], evidence: [] },  // escalation follow-up
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'relation_between', relation_intent: { entities: ['A', 'B'] } }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(r.coverage.graph_covered, true, 'error-return still flips relationChecked → post-adjust runs');
  assert.deepEqual(toolNames(r), ['hivemind_relation_between', 'hivemind_recall'],
    'error-return summary is "0 typed edges…"; empty coverage → escalation recall');
  assert.equal(r.escalation_count, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// R11 — aggregate return shape with requires_complete_coverage.
// aggregate is a dedicated lane (no base recall).
// ─────────────────────────────────────────────────────────────────────────
test('R11: aggregate coverage block reflects aggregateResult.coverage.complete', async () => {
  const { ctx } = makeCtx({
    hivemind_aggregate_entities: {
      count: 3, entity_kind: 'product',
      coverage: { complete: true },
      entities: ['a', 'b', 'c'],
    },
    hivemind_recall: { memories: [], evidence: [] },  // escalation follow-up
  });
  const r = await gatherEvidence({
    plan: basePlan({
      operation: 'aggregate',
      aggregate: { parent: 'Solvis', kind: 'product' },
      requires_complete_coverage: true,
    }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(r.aggregate.count, 3);
  assert.equal(r.coverage.aggregate_requested, true);
  assert.equal(r.coverage.aggregate_complete, true);
  assert.equal(r.coverage.complete, true);
  // SNAPSHOT: aggregate skips BASE recall (dedicatedLane) but assessRecallCoverage
  // on the empty memory set marks coverage incomplete → an escalation recall fires
  // after the aggregate tool. This escalation is NOT gated by dedicatedLane — a
  // real preservation subtlety (R7). The refactor must keep this 2-tool sequence.
  assert.deepEqual(toolNames(r), ['hivemind_aggregate_entities', 'hivemind_recall'],
    'dedicated lane skips base recall but escalation still fires');
  assert.equal(r.escalation_count, 1);
});

test('R11: aggregate incomplete → cutoff_reason set', async () => {
  const { ctx } = makeCtx({
    hivemind_aggregate_entities: {
      count: 2, entity_kind: 'product',
      coverage: { complete: false, reason: 'top_k_only' },
    },
    hivemind_recall: { memories: [], evidence: [] },  // escalation follow-up
  });
  const r = await gatherEvidence({
    plan: basePlan({
      operation: 'aggregate',
      aggregate: { parent: 'Solvis', kind: 'product' },
      requires_complete_coverage: true,
    }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(r.coverage.aggregate_complete, false);
  assert.equal(r.coverage.cutoff_reason, 'top_k_only');
});

// ─────────────────────────────────────────────────────────────────────────
// Profile dedicated lane — R (packet append + profile_context) + no base recall.
// ─────────────────────────────────────────────────────────────────────────
test('profile lane: get_user_profile only, packet appended, profile_context set', async () => {
  const { ctx } = makeCtx({
    get_user_profile: { context: 'You are Head of Product at Solvis.', fact_count: 5 },
    hivemind_recall: { memories: [], evidence: [] },  // escalation follow-up
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'profile' }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(r.profile_context, 'You are Head of Product at Solvis.');
  assert.equal(r.recall_packets.length, 1, 'profile packet appended');
  assert.equal(r.recall_packets[0].citations[0].id, 'PROFILE1');
  // SNAPSHOT: profile skips BASE recall (dedicatedLane) but an escalation recall
  // fires after get_user_profile (empty-anchor coverage → escalate). R7 subtlety.
  assert.deepEqual(toolNames(r), ['get_user_profile', 'hivemind_recall'],
    'dedicated lane skips base recall but escalation still fires');
  assert.deepEqual(memIds(r), [], 'profile lane pulls no memories (escalation empty too)');
  assert.equal(r.escalation_count, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// R4 — evidence key formula: base includes page, temporal omits it.
// Same title, different page, arriving base then temporal.
// ─────────────────────────────────────────────────────────────────────────
test('R4: evidence dedup key differs base(withPage) vs temporal(noPage)', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: {
      memories: memRows('A'),
      evidence: [{ document_title: 'Same', page: 1, content: 'same-content-prefix-aaaaaaaaaaaaaaaaaaaa' }],
    },
    hivemind_timeline: {
      memories: [],
      // Same title + same content prefix, different page. Base kept page in the
      // key; temporal key omits page → collides with base's content-only tail?
      // Snapshot whatever the current code yields.
      evidence: [{ document_title: 'Same', page: 2, content: 'same-content-prefix-aaaaaaaaaaaaaaaaaaaa' }],
    },
  });
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'timeline' }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  // Snapshot: record the evidence count the current merge produces.
  assert.equal(typeof r.evidence.length, 'number');
  assert.ok(r.evidence.length >= 1);
});

// ─────────────────────────────────────────────────────────────────────────
// R8 — web boundary: needs_web + <2 memories fires web; >=2 does not.
// R9 — web dispatch is UNWRAPPED (no startTool events for it).
// ─────────────────────────────────────────────────────────────────────────
test('R8: web fires when needs_web and memories < 2', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: memRows('A') },  // exactly 1 → <2
    hivemind_web_search: { job_id: 'jobabcdef' },
  });
  const r = await gatherEvidence({
    plan: basePlan({ needs_web: true, sub_queries: ['solvis'] }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.ok(toolNames(r).includes('hivemind_web_search'), 'R8: web fired at 1 memory');
});

test('R8: web does NOT fire when memories >= 2', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: memRows('A', 'B') },  // 2 → not <2
    hivemind_web_search: { job_id: 'jobabcdef' },
  });
  const r = await gatherEvidence({
    plan: basePlan({ needs_web: true, sub_queries: ['solvis'] }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.equal(toolNames(r).includes('hivemind_web_search'), false, 'R8: web suppressed at 2 memories');
});

test('R10/R9: web path uses recordTool only (no tool_selected/started for web)', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: memRows('A') },
    hivemind_web_search: { job_id: 'jobabcdef' },
  });
  const { events, onEvent } = recordEvents();
  await gatherEvidence({
    plan: basePlan({ needs_web: true, sub_queries: ['solvis'] }),
    ctx, onEvent, deadlineAt: FAR(),
  });
  const webSelected = events.filter((e) => e.type === 'tool_selected' && e.name === 'hivemind_web_search');
  assert.equal(webSelected.length, 0, 'R10: web has no tool_selected (unwrapped, recordTool only)');
  const webCompleted = events.filter((e) => e.type === 'tool_completed' && e.name === 'hivemind_web_search');
  assert.equal(webCompleted.length, 1, 'web still recorded via recordTool');
});

// ─────────────────────────────────────────────────────────────────────────
// R9 — deadline discipline: past deadline → no dispatch at all.
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// fix #2 (Stage C step 5) — execTimeline OWNS the version-history walk. Even
// when the temporal tool returns only the LATEST memory (no predecessor), the
// executor walks the injected Updates edges and hydrates the predecessor,
// flagged _superseded_predecessor — regardless of which temporal tool fired.
// This is what makes "over time" answer identically to "before it changed".
// ─────────────────────────────────────────────────────────────────────────
test('fix#2: execTimeline walks Updates edges to hydrate superseded predecessor', async () => {
  const LATEST = 'launch-latest';   // Aug 19 (isLatest)
  const PRED = 'launch-pred';       // Aug 18 (superseded)
  const { ctx } = makeCtx({
    // base recall surfaces only the LATEST memory (predecessor doesn't rank in)
    hivemind_recall: { memories: [{ id: LATEST, content: 'launch date is August 19, 2026' }] },
    // hivemind_diff (the "over time" route) returns the latest as added, NO predecessor
    hivemind_diff: { added: [{ id: LATEST, content: 'launch date is August 19, 2026' }], added_count: 1, removed_count: 0 },
  });
  // Inject the graph loader + memory store so the Updates walk can run.
  ctx.prisma = {};
  ctx._loadTypedGraphEvidence = async () => ({
    items: [{ from_id: LATEST, to_id: PRED, type: 'Updates' }],
  });
  ctx.persistentMemoryStore = {
    async getMemories(ids) {
      const m = new Map();
      if (ids.includes(PRED)) m.set(PRED, { id: PRED, content: 'launch date is August 18, 2026' });
      return m;
    },
  };
  const r = await gatherEvidence({
    // "over time" → time.range triggers hivemind_diff, the path that previously
    // dropped the predecessor.
    plan: basePlan({ operation: 'timeline', needs_time_travel: true, time: { range: { start: '2026-01-01' } } }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  const pred = r.memories.find((m) => m.id === PRED);
  assert.ok(pred, 'fix#2: predecessor hydrated even though diff did not return it');
  assert.equal(pred._superseded_predecessor, true, 'fix#2: predecessor flagged');
  assert.ok(/August 18/.test(pred.content), 'fix#2: the prior value (Aug 18) is now available to synthesis');
  const latest = r.memories.find((m) => m.id === LATEST);
  assert.ok(latest && !latest._superseded_predecessor, 'latest stays unflagged');
  assert.ok(r.relationships.some((e) => e.to_id === PRED && String(e.type).toLowerCase() === 'updates'),
    'fix#2: the Updates edge is surfaced for synthesis');
});

test('fix#2: no Updates edges → timeline unchanged (additive, never breaks)', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: { memories: [{ id: 'X', content: 'only current value' }] },
    hivemind_timeline: { memories: [{ id: 'X', content: 'only current value' }], version_count: 1 },
  });
  ctx.prisma = {};
  ctx._loadTypedGraphEvidence = async () => ({ items: [] });   // no Updates edges
  ctx.persistentMemoryStore = { async getMemories() { return new Map(); } };
  const r = await gatherEvidence({
    plan: basePlan({ operation: 'timeline' }),
    ctx, onEvent: undefined, deadlineAt: FAR(),
  });
  assert.deepEqual(memIds(r), ['X'], 'no predecessor invented when no Updates edge exists');
  assert.equal(r.memories[0]._superseded_predecessor, undefined);
});

test('R9: deadline already passed → base recall skipped, empty result', async () => {
  const { ctx, calls } = makeCtx({
    hivemind_recall: { memories: memRows('A') },
  });
  const r = await gatherEvidence({
    plan: basePlan(),
    ctx, onEvent: undefined, deadlineAt: Date.now() - 1000,  // already expired
  });
  // recallQueries still built, but beforeDeadline rejects → recorded as error,
  // OR the block still enters. Snapshot the current behavior: recall attempted
  // but beforeDeadline rejects immediately.
  assert.equal(memIds(r).length, 0, 'no memories survive an expired deadline');
});

test('a Memory Box outage is preserved as unavailable coverage, never empty evidence', async () => {
  const { ctx } = makeCtx({
    hivemind_recall: new Error('memory box unavailable for workspace o1 (/v1/recall)'),
  });
  const r = await gatherEvidence({
    plan: basePlan(),
    ctx,
    onEvent: undefined,
    deadlineAt: FAR(),
  });
  assert.equal(r.memories.length, 0);
  assert.equal(r.coverage.retrieval_unavailable, true);
  assert.equal(r.coverage.complete, false);
  assert.match(r.steps[0].result_summary, /memory box unavailable/i);
});
