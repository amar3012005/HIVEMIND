/**
 * dr-server.js — Deep Research HTTP server (port 8055)
 *
 * Runs inside the same process as server.js.
 * All dependencies (memoryStore, prisma, recallFn, browserRuntime, authenticateFn)
 * are injected by server.js — no HTTP hop, no duplicate DB connections.
 *
 * Usage (from server.js):
 *   import { startDRServer } from './deep-research/dr-server.js';
 *   await startDRServer({ memoryStore, prisma, recallFn, browserRuntime, authenticateFn, port: 8055 });
 */

import http from 'http';
import crypto from 'crypto';
import { randomUUID } from 'crypto';

// ── Trail helpers (copied from server.js) ────────────────────────────────────

function getResearchProjectId(sessionId, session = {}) {
  return session.projectId || `research/${sessionId.slice(0, 8)}`;
}

function coerceTrailSnippet(value, limit = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, limit);
  try { return JSON.stringify(value).slice(0, limit); } catch { return String(value).slice(0, limit); }
}

function getTrailMemoryCreatedAt(memory) {
  const metadata = memory?.metadata || {};
  return new Date(
    metadata.completedAt || metadata.updatedAt || memory?.updated_at ||
    metadata.startedAt || memory?.created_at || 0,
  ).getTime();
}

function isSessionScopedResearchMemory(memory, sessionId, projectId, sessionStartTime) {
  if (!memory) return false;
  const tags = memory.tags || [];
  const metadata = memory.metadata || {};
  const createdAt = new Date(memory.created_at || metadata.createdAt || metadata.updatedAt || 0).getTime();
  const sessionTags = new Set([`session:${sessionId}`, `research-session:${sessionId}`]);
  const scopedSessionId = metadata.sessionId || metadata.session_id || metadata.research_session_id || null;
  const scopedProject = memory.project || metadata.projectId || metadata.project_id || null;
  const matchesSession = tags.some(tag => sessionTags.has(tag)) || scopedSessionId === sessionId;
  const matchesProject = !projectId || scopedProject === projectId;
  const matchesTime = !sessionStartTime || createdAt >= new Date(sessionStartTime).getTime();
  return matchesProject && matchesTime && (matchesSession || tags.includes('research-trail') || tags.includes('research-checkpoint'));
}

function normalizeResearchAgentId(agent = '') {
  const id = String(agent || '').toLowerCase();
  if (id === 'explorer') return 'faraday';
  if (id === 'analyst') return 'feynmann';
  if (id === 'verifier') return 'turing';
  if (id === 'synthesizer') return 'synthesis';
  return id || 'faraday';
}

function normalizeTrailStep(step, { trailId, sessionId, projectId, sourceMemoryId = null, fallbackIndex = 0, synthetic = false } = {}) {
  const stepIndex = Number.isInteger(step?.stepIndex) ? step.stepIndex : fallbackIndex;
  const provenance = step?.provenance && typeof step.provenance === 'object' ? step.provenance : {};
  return {
    id: step?.id || `trail-step-${trailId}-${stepIndex}`,
    trailId: `trail-${trailId}`,
    sessionId,
    projectId,
    stepIndex,
    agent: normalizeResearchAgentId(step?.agent || 'faraday'),
    action: step?.action || step?.kind || 'research_task',
    input: coerceTrailSnippet(step?.input || step?.query || step?.description || step?.prompt || ''),
    output: coerceTrailSnippet(step?.output || step?.result?.summary || step?.summary || step?.answer || step?.response || ''),
    confidence: step?.confidence ?? step?.result?.confidence ?? step?.progress?.confidence ?? null,
    rejected: step?.rejected ?? (step?.status === 'failed' || step?.status === 'blocked'),
    reason: coerceTrailSnippet(step?.reason || step?.error || ''),
    thought: coerceTrailSnippet(step?.thought || step?.reasoning || ''),
    why: coerceTrailSnippet(step?.why || ''),
    alternativeConsidered: coerceTrailSnippet(step?.alternativeConsidered || ''),
    cotThoughtId: step?.cotThoughtId || provenance?.cotThoughtId || null,
    cotTraceId: step?.cotTraceId || provenance?.cotTraceId || null,
    cotParentThoughtId: step?.cotParentThoughtId || provenance?.cotParentThoughtId || null,
    traceSignal: step?.traceSignal || provenance?.traceSignal || null,
    sourceMemoryId,
    synthetic,
    provenance: { ...provenance, sourceMemoryId, synthetic, taskId: step?.taskId || step?.id || provenance.taskId || null, trailTaskStatus: step?.status || provenance.trailTaskStatus || null },
  };
}

function expandTrailLikeSteps(trailLike = {}, metadata = {}, fallbackTrailId, sessionId, projectId, sourceMemoryId = null) {
  const explicitSteps = Array.isArray(metadata.steps) && metadata.steps.length > 0
    ? metadata.steps
    : Array.isArray(trailLike.steps) && trailLike.steps.length > 0
      ? trailLike.steps
      : [];
  if (explicitSteps.length > 0) {
    return explicitSteps.map((step, idx) => normalizeTrailStep(step, { trailId: fallbackTrailId, sessionId, projectId, sourceMemoryId, fallbackIndex: Number.isInteger(step?.stepIndex) ? step.stepIndex : idx, synthetic: false }));
  }
  const completed = Array.isArray(trailLike.completed) && trailLike.completed.length > 0 ? trailLike.completed : [];
  const taskMap = trailLike.tasks && typeof trailLike.tasks === 'object' ? trailLike.tasks : {};
  const completedTasks = completed.map(entry => (entry && typeof entry === 'object') ? entry : (taskMap[entry] || null)).filter(Boolean);
  if (completedTasks.length > 0) {
    return completedTasks.map((task, idx) => normalizeTrailStep(task, { trailId: fallbackTrailId, sessionId, projectId, sourceMemoryId, fallbackIndex: Number.isInteger(task?.stepIndex) ? task.stepIndex : idx, synthetic: true }));
  }
  const stackEntries = Array.isArray(trailLike.stack) ? trailLike.stack : [];
  return stackEntries.map((task, idx) => normalizeTrailStep(task, { trailId: fallbackTrailId, sessionId, projectId, sourceMemoryId, fallbackIndex: Number.isInteger(task?.stepIndex) ? task.stepIndex : idx, synthetic: true }));
}

function normalizeResearchTrailMemory(memory, session = {}, fallbackTrail = null) {
  if (!memory) return null;
  const metadata = memory.metadata || {};
  const sessionId = metadata.sessionId || metadata.session_id || metadata.research_session_id || session.id || fallbackTrail?.sessionId || null;
  const projectId = memory.project || metadata.projectId || metadata.project_id || getResearchProjectId(sessionId || session.id || 'unknown', session);
  const trailId = metadata.trailId || metadata.trail_id || memory.id || fallbackTrail?.trailId || `trail-${sessionId || 'unknown'}`;
  const trailNodeId = trailId.startsWith('trail-') ? trailId : `trail-${trailId}`;
  const trailLike = metadata.trail || fallbackTrail?.trail || memory.result?.trail || memory.trail || {};
  const steps = expandTrailLikeSteps(trailLike, metadata, trailId, sessionId || session.id || 'unknown', projectId, memory.id);
  const isCheckpointTrail = (memory.tags || []).includes('research-checkpoint') || metadata.trailType === 'op/research-checkpoint';
  const status = metadata.status || (metadata.completedAt ? 'completed' : fallbackTrail?.status || (isCheckpointTrail ? 'interrupted' : 'completed'));
  const query = metadata.query || session.query || fallbackTrail?.query || memory.title?.replace(/^(Research Trail|Checkpoint): /, '') || '';
  return {
    id: trailId,
    nodeId: trailNodeId,
    sessionId: sessionId || session.id || null,
    projectId,
    query,
    status,
    startedAt: metadata.startedAt || memory.created_at || fallbackTrail?.startedAt || null,
    completedAt: metadata.completedAt || fallbackTrail?.completedAt || null,
    report: metadata.report || fallbackTrail?.report || null,
    trailType: metadata.trailType || metadata.contradictionType || ((memory.tags || []).includes('research-checkpoint') ? 'op/research-checkpoint' : 'op/research-trail'),
    sourceMemoryId: memory.id,
    tags: memory.tags || [],
    confidence: metadata.confidence || fallbackTrail?.confidence || memory.importance_score || null,
    blueprintUsed: metadata.blueprintUsed || fallbackTrail?.blueprintUsed || null,
    blueprintCandidate: metadata.blueprintCandidate || fallbackTrail?.blueprintCandidate || false,
    stepCount: steps.length,
    contradictionCount: metadata.contradictionCount || fallbackTrail?.contradictionCount || 0,
    steps,
    metadata,
  };
}

async function fetchSessionTrailMemories(memoryStore, sessionId, session = {}, userId, orgId, { includeCheckpoints = true, limit = 20 } = {}) {
  const projectId = getResearchProjectId(sessionId, session);
  const createdAfter = session.startedAt ? new Date(session.startedAt).toISOString() : session.createdAt;
  const userScope = session.userId || userId;
  const orgScope = session.orgId || orgId;

  const plans = [
    { query: '', user_id: userScope, org_id: orgScope, project: projectId, memory_type: 'decision', tags: ['research-trail', `session:${sessionId}`], is_latest: true, created_after: createdAfter, n_results: limit },
    { query: '', user_id: userScope, org_id: orgScope, project: projectId, memory_type: 'decision', tags: ['research-trail'], is_latest: true, created_after: createdAfter, n_results: limit },
    { query: '', user_id: userScope, org_id: orgScope, project: projectId, tags: ['research-trail'], is_latest: true, created_after: createdAfter, n_results: limit },
    { query: '', user_id: userScope, org_id: orgScope, project: projectId, memory_type: 'decision', tags: ['csi-trail', `session:${sessionId}`], is_latest: true, created_after: createdAfter, n_results: limit },
  ];

  if (includeCheckpoints) {
    plans.push(
      { query: '', user_id: userScope, org_id: orgScope, project: projectId, memory_type: 'decision', tags: ['research-checkpoint', `session:${sessionId}`], is_latest: true, created_after: createdAfter, n_results: limit },
      { query: '', user_id: userScope, org_id: orgScope, project: projectId, tags: ['research-checkpoint', `session:${sessionId}`], is_latest: true, created_after: createdAfter, n_results: limit },
      { query: '', user_id: userScope, org_id: orgScope, project: projectId, memory_type: 'decision', tags: ['research-checkpoint'], is_latest: true, created_after: createdAfter, n_results: limit },
      { query: '', user_id: userScope, org_id: orgScope, project: projectId, tags: ['research-checkpoint'], is_latest: true, created_after: createdAfter, n_results: limit },
    );
  }

  const seen = new Map();
  for (const plan of plans) {
    try {
      const memories = await memoryStore.searchMemories(plan);
      for (const memory of memories || []) {
        if (!memory || !isSessionScopedResearchMemory(memory, sessionId, projectId, createdAfter)) continue;
        if (!seen.has(memory.id)) seen.set(memory.id, memory);
      }
    } catch (err) {
      console.error('[dr-server] failed to load trail memories:', err.message);
    }
  }

  return [...seen.values()].sort((left, right) => {
    const delta = getTrailMemoryCreatedAt(right) - getTrailMemoryCreatedAt(left);
    if (delta !== 0) return delta;
    return String(right.id).localeCompare(String(left.id));
  });
}

function selectPrimaryTrailMemory(memories = []) {
  if (!memories.length) return null;
  const completed = memories.find(m => (m.metadata || {}).status === 'completed' || (m.metadata || {}).completedAt);
  return completed || memories[0];
}

// ── Session persistence helpers ──────────────────────────────────────────────

async function restoreSessionFromCSI(sessionId, userId, orgId, memoryStore) {
  try {
    const sessionContext = { id: sessionId, userId, orgId };
    const trailMemories = await fetchSessionTrailMemories(memoryStore, sessionId, sessionContext, userId, orgId, { includeCheckpoints: true, limit: 20 });
    const source = selectPrimaryTrailMemory(trailMemories);
    if (!source) return null;

    const meta = source.metadata || {};
    const normalizedTrail = normalizeResearchTrailMemory(source, sessionContext, null);
    const isCheckpoint = normalizedTrail?.trailType === 'op/research-checkpoint';
    const status = normalizedTrail?.status || (isCheckpoint ? 'interrupted' : 'completed');

    const session = {
      id: sessionId,
      query: meta.query || source.title?.replace(/^(Research Trail|Checkpoint): /, '') || 'Restored session',
      userId: source.user_id || userId,
      orgId: source.org_id || orgId,
      projectId: normalizedTrail?.projectId || source.project || meta.projectId || `research/${sessionId.slice(0, 8)}`,
      status,
      events: [],
      graphEvents: [],
      sseClients: [],
      result: normalizedTrail ? {
        report: normalizedTrail.report || null,
        findings: [],
        sources: [],
        gaps: [],
        durationMs: 0,
        taskProgress: { confidence: normalizedTrail.steps?.slice(-1)[0]?.confidence || meta.confidence || 0.7 },
        fromCache: false,
        projectId: normalizedTrail?.projectId || source.project || meta.projectId,
        trail: normalizedTrail,
      } : null,
      error: isCheckpoint ? 'Research was interrupted. Partial results available.' : null,
      createdAt: source.created_at,
      startedAt: new Date(source.created_at),
      _restored: true,
      _interrupted: isCheckpoint,
      _checkpointWave: isCheckpoint ? meta.waveCompleted : null,
      _checkpointConfidence: isCheckpoint ? meta.confidence : null,
    };
    researchSessions.set(sessionId, session);
    console.log('[dr-server] Restored session from CSI:', sessionId, 'status:', status, 'project:', session.projectId,
      isCheckpoint ? `(interrupted at wave ${meta.waveCompleted})` : '');
    return session;
  } catch (err) {
    console.error('[dr-server] Failed to restore session from CSI:', err.message);
    return null;
  }
}

async function persistSessionStatus(sessionId, status, userId, orgId, projectId, memoryStore) {
  try {
    const checkpointId = `checkpoint-${sessionId}`;
    await memoryStore.createMemory({
      id: checkpointId,
      user_id: userId,
      org_id: orgId,
      project: projectId,
      content: `Research session ${status}: ${sessionId}`,
      title: `Session ${status}`,
      memory_type: 'event',
      tags: ['research-checkpoint', `session:${sessionId}`, `status:${status}`],
      is_latest: true,
      importance_score: 0.3,
      metadata: { sessionId, status, projectId, updatedAt: new Date().toISOString() },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).catch(() => {
      // Duplicate — update instead (best-effort via PATCH)
      return memoryStore.updateMemory(checkpointId, {
        content: `Research session ${status}: ${sessionId}`,
        metadata: { sessionId, status, projectId, updatedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    });
  } catch {
    // Non-fatal
  }
}

// ── SSE broadcast helpers (copied exactly from server.js) ────────────────────

function isResearchGraphEvent(event) {
  const type = event?.type || '';
  return type.startsWith('graph.') || type.startsWith('csi.');
}

function sortResearchEvents(events) {
  return [...events].sort((a, b) => {
    const left = new Date(a?.timestamp || 0).getTime();
    const right = new Date(b?.timestamp || 0).getTime();
    return left - right;
  });
}

function replayResearchEvents(res, session) {
  const replay = sortResearchEvents([...(session.events || []), ...(session.graphEvents || [])]);
  for (const event of replay) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function broadcastResearchEvent(session, event) {
  if (isResearchGraphEvent(event)) {
    if (!Array.isArray(session.graphEvents)) session.graphEvents = [];
    session.graphEvents.push(event);
  } else {
    session.events.push(event);
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  session.sseClients = session.sseClients.filter(client => {
    try { client.write(payload); return true; } catch { return false; }
  });
}

// ── Graph helper functions (copied from server.js) ───────────────────────────

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function uniqueValues(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function inferCsiStage(metadata = {}) {
  if (metadata.csiStage) return metadata.csiStage;
  const agent = normalizeResearchAgentId(metadata.agent);
  if (agent === 'faraday') return 'faraday';
  if (agent === 'feynmann') return 'feynman';
  if (agent === 'turing') return 'turing';
  if (metadata.action === 'verify_findings') return 'turing';
  return null;
}

function inferCsiNodeType(stage) {
  if (stage === 'faraday') return 'csi-observation';
  if (stage === 'feynman') return 'csi-hypothesis';
  if (stage === 'turing') return 'csi-verdict';
  return 'csi-observation';
}

function edgeTypeForCsiStage(stage, verdict) {
  if (stage === 'faraday') return 'observes';
  if (stage === 'feynman') return 'analyzes';
  if (stage === 'turing') {
    if (verdict === 'disputed') return 'disputes';
    if (verdict === 'verified') return 'supports';
    return 'reviews';
  }
  return 'related';
}

function deriveResearchSourceIds(metadata = {}) {
  const directSourceId =
    metadata.findingType === 'web' || metadata.findingType === 'follow_up' ||
    metadata.research_type === 'web' || metadata.research_type === 'follow_up' ||
    String(metadata.source || metadata.source_url || '').startsWith('http')
      ? metadata.sourceId || metadata.source_id
      : null;
  return uniqueValues([
    directSourceId,
    ...(metadata.sourceIds || []),
    ...(metadata.output?.sourceIds || []),
  ]);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

async function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.replace('Bearer ', '').trim();
  if (!apiKey) return null;
  const identity = await resolveApiKey(apiKey, CORE_BASE_URL, MASTER_API_KEY);
  return identity; // { userId, orgId } or null
}

// ── HTTP response helpers ────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

// ── Build research graph layers from session memories ────────────────────────

async function buildResearchGraph(session, sessionId, userId, orgId, memoryStore) {
  const projectId = session.projectId || `research/${sessionId.slice(0, 8)}`;

  const memories = await memoryStore.searchMemories({
    query: '',
    user_id: session.userId || userId,
    org_id: session.orgId || orgId,
    project: projectId,
    created_after: session.startedAt || session.createdAt,
    n_results: 100,
  });

  const sessionStartTime = session.startedAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const filteredMemories = (memories || []).filter(m => {
    const memTime = new Date(m.created_at || m.metadata?.createdAt || 0);
    return memTime >= sessionStartTime;
  });

  const layers = {
    sources: [], claims: [], trails: [], observations: [], executionEvents: [],
    csi: [], blueprints: [], promotedClaims: [],
    weights: { edges: [] },
  };
  const seenEdges = new Set();
  const pushEdge = (from, to, type = 'related', confidence = null, extra = {}) => {
    if (!from || !to) return;
    const key = `${from}|${to}|${type}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    layers.weights.edges.push({ from, to, type, confidence, ...extra });
  };

  (filteredMemories || []).forEach(m => {
    const tags = m.tags || [];
    const metadata = m.metadata || {};
    const memoryType = m.memoryType || m.memory_type;
    const createdAt = m.created_at || metadata.createdAt || metadata.saved_at || new Date().toISOString();
    const sourceIds = deriveResearchSourceIds(metadata);
    const claimIds = uniqueValues(metadata.claimIds || metadata.output?.claimIds || metadata.relatedClaimIds);
    const observationIds = uniqueValues(metadata.observationIds || metadata.output?.observationIds);
    const verdict = metadata.verdict || metadata.output?.verdict || null;
    const csiStage = inferCsiStage(metadata);
    const csiNodeType = metadata.csiNodeType || inferCsiNodeType(csiStage);
    const isPromotedMemory = tags.includes('promoted-claim') || tags.includes('report') || metadata.promotedAt || metadata.source_type === 'deep_research_report' || memoryType === 'decision';
    const isResearchTrail = tags.includes('research-trail') || tags.includes('csi-trail') || metadata.trailType === 'op/research-trail';

    if (tags.includes('promoted-claim')) {
      layers.promotedClaims.push({ id: m.id, content: m.content?.slice(0, 300), title: m.title, confidence: m.metadata?.confidence || m.importance_score, sourceIds: m.metadata?.sourceIds || [], agent: m.metadata?.agent || 'unknown', sessionId: m.metadata?.sessionId, promotedAt: m.metadata?.promotedAt, structured: m.metadata?.structured || null, createdAt: m.created_at });
      return;
    }

    if (tags.includes('research-source') || tags.includes('web-source') || metadata.source_type === 'web' || (memoryType === 'fact' && tags.includes('web')) || (m.memory_type === 'fact' && tags.includes('web'))) {
      layers.sources.push({ id: m.id, title: m.title, url: metadata.url || metadata.source_url, runtime: metadata.research_source || 'tavily', score: m.importance_score, favicon: metadata.favicon, taskId: metadata.taskId || null, wave: metadata.wave ?? null, createdAt });
    }

    if (tags.includes('research-finding') || (memoryType === 'fact' && !tags.includes('research-observation') && !tags.includes('research-execution-event'))) {
      const isStructured = metadata.structured || metadata.subject;
      layers.claims.push({ id: m.id, content: m.content?.slice(0, 500), confidence: metadata.confidence || m.importance_score, source: metadata.source_url || metadata.source_id, sourceIds, taskId: metadata.taskId || null, wave: metadata.wave ?? null, dimension: metadata.dimension || null, agent: normalizeResearchAgentId(metadata.agent || null), createdAt, type: isStructured ? 'structured-claim' : 'plain-claim', structured: isStructured ? { subject: metadata.structured?.subject || metadata.subject, predicate: metadata.structured?.predicate || metadata.predicate, object: metadata.structured?.object || metadata.object, entities: metadata.structured?.entities || metadata.entities || [], sourceIds: metadata.structured?.sourceIds || metadata.sourceIds || [] } : null });
    }

    if (!isResearchTrail) {
      if (tags.includes('research-observation') || metadata.observationType === 'op/research-observation') {
        layers.observations.push({ id: m.id, title: m.title, agent: normalizeResearchAgentId(metadata.agent || 'unknown'), action: metadata.action || 'unknown', findingType: metadata.findingType || 'web', source: metadata.source, sourceId: metadata.sourceId, sourceIds, claimIds, confidence: metadata.confidence || m.importance_score, stepIndex: metadata.stepIndex, taskId: metadata.taskId || null, wave: metadata.wave ?? null, dimension: metadata.dimension || null, csiStage, verdict, createdAt });
      }

      if (tags.includes('research-execution-event') || metadata.executionType === 'op/research-execution-event') {
        layers.executionEvents.push({ id: m.id, title: m.title, agent: normalizeResearchAgentId(metadata.agent || 'unknown'), action: metadata.action || 'unknown', success: metadata.success !== false, latency: metadata.latency, taskId: metadata.taskId || null, wave: metadata.wave ?? null, phase: metadata.phase || null, sourceIds, claimIds, observationIds, csiStage, verdict, confidence: metadata.confidence || metadata.output?.confidence || m.importance_score, createdAt });
      }

      if (csiStage) {
        layers.csi.push({ id: m.id, type: csiNodeType, stage: csiStage, title: metadata.csiTitle || m.title, summary: metadata.summary || m.content?.slice(0, 280) || '', kind: metadata.findingType || metadata.action || metadata.phase || 'analysis', verdict, confidence: metadata.confidence || metadata.output?.confidence || m.importance_score, claimIds, sourceIds, observationIds, taskId: metadata.taskId || null, wave: metadata.wave ?? null, agent: normalizeResearchAgentId(metadata.agent || 'unknown'), action: metadata.action || 'unknown', createdAt });
      }
    }

    if (tags.includes('kg/blueprint') || metadata.blueprint_id) {
      layers.blueprints.push({ blueprintId: metadata.blueprint_id, name: metadata.blueprint_name || m.title, domain: metadata.blueprint_domain, timesReused: metadata.blueprint_times_reused || 0, successRate: metadata.blueprint_success_rate, pattern: metadata.blueprint_pattern || [], patternCount: Array.isArray(metadata.blueprint_pattern) ? metadata.blueprint_pattern.length : 0, hasCapturedState: !!metadata.blueprint_captured_state || !!metadata.blueprint_has_captured_state, capturedStateSummary: metadata.blueprint_captured_state_summary || null });
    }

    if (isPromotedMemory) {
      layers.promoted = layers.promoted || [];
      layers.promoted.push({ id: m.id, title: m.title, content: m.content?.slice(0, 500), memoryType, confidence: metadata.confidence || m.importance_score, sourceIds, claimIds, trailStepIds: uniqueValues(metadata.trailStepIds || metadata.reportProvenance?.trailStepIds), recalledMemoryIds: uniqueValues(metadata.recalledMemoryIds || metadata.reportProvenance?.recalledMemoryIds), reportId: metadata.reportId || metadata.reportProvenance?.reportId || null, goldenLine: metadata.goldenLine || metadata.reportProvenance?.goldenLine || null, promotedAt: metadata.promotedAt || createdAt, createdAt });
    }
  });

  const trailMemories = await fetchSessionTrailMemories(memoryStore, sessionId, session, session.userId || userId, session.orgId || orgId, { includeCheckpoints: true, limit: 20 });
  const normalizedTrails = trailMemories.map(memory => normalizeResearchTrailMemory(memory, session)).filter(Boolean);
  const fallbackTrail = !normalizedTrails.length && session.result?.trail
    ? normalizeResearchTrailMemory({ id: `session-${sessionId}`, project: projectId, tags: ['research-trail', `session:${sessionId}`], metadata: { query: session.query, status: session.status, startedAt: session.createdAt } }, session, session.result.trail)
    : null;
  const activeTrails = normalizedTrails.length > 0 ? normalizedTrails : fallbackTrail ? [fallbackTrail] : [];

  const trailDiagnostics = {
    trail_count: activeTrails.length,
    trail_memory_ids: normalizedTrails.map(t => t.sourceMemoryId).filter(Boolean),
    trail_node_ids: activeTrails.map(t => t.nodeId).filter(Boolean),
    total_step_count: activeTrails.reduce((sum, t) => sum + (t.stepCount || t.steps?.length || 0), 0),
    source_path: normalizedTrails.length > 0 ? 'trail_store_memories' : fallbackTrail ? 'session_fallback' : 'none',
  };

  activeTrails.forEach(trail => {
    layers.csi.push({ id: trail.nodeId, type: trail.trailType === 'op/research-checkpoint' ? 'csi-checkpoint' : 'csi-trail', stage: 'trail', title: trail.trailType === 'op/research-checkpoint' ? `Checkpoint: ${trail.query || session.query || 'Research'}` : `Trail: ${trail.query || session.query || 'Research'}`, summary: trail.report || trail.metadata?.summary || trail.steps?.slice(-1)[0]?.output || '', kind: 'provenance', verdict: trail.status === 'completed' ? 'verified' : 'uncertain', confidence: trail.confidence, claimIds: [], sourceIds: [], observationIds: [], taskId: null, wave: null, agent: 'trail-store', action: 'research_trail', createdAt: trail.startedAt || session.createdAt || new Date().toISOString(), stepCount: trail.stepCount, sourceMemoryId: trail.sourceMemoryId, trailId: trail.id });
    if (trail.blueprintUsed) pushEdge(trail.nodeId, `blueprint-${trail.blueprintUsed}`, 'used_blueprint', 0.9);
    trail.steps.forEach((step, idx) => {
      const stepNodeId = step.id || `trail-step-${trail.id}-${idx}`;
      layers.trails.push({ id: stepNodeId, trailId: trail.nodeId, stepIndex: step.stepIndex ?? idx, agent: normalizeResearchAgentId(step.agent || 'faraday'), action: step.action || 'search_web', input: step.input, output: step.output, confidence: step.confidence, rejected: step.rejected, thought: step.thought, why: step.why, alternativeConsidered: step.alternativeConsidered, sourceMemoryId: trail.sourceMemoryId, provenance: step.provenance, synthetic: step.synthetic });
      pushEdge(trail.nodeId, stepNodeId, 'contains', Math.max(0.55, step.confidence ?? trail.confidence ?? 0.7));
      if (idx > 0) { const prevStep = trail.steps[idx - 1]; pushEdge(prevStep.id || `trail-step-${trail.id}-${idx - 1}`, stepNodeId, 'sequence', Math.max(0.55, step.confidence ?? prevStep.confidence ?? 0.7)); }
    });
  });

  (filteredMemories || []).forEach(m => {
    const metadata = m.metadata || {};
    const srcIds = deriveResearchSourceIds(metadata);
    const clIds = uniqueValues(metadata.claimIds || metadata.output?.claimIds || metadata.relatedClaimIds);
    const obsIds = uniqueValues(metadata.observationIds || metadata.output?.observationIds);
    const stage = inferCsiStage(metadata);
    const verdict = metadata.verdict || metadata.output?.verdict || null;
    const isTrail = (m.tags || []).includes('research-trail') || (m.tags || []).includes('csi-trail') || metadata.trailType === 'op/research-trail' || metadata.trailType === 'op/research-checkpoint';
    if (isTrail) return;

    if (metadata.sourceId) pushEdge(`claim-${m.id}`, `source-${metadata.sourceId}`, 'derived_from', m.importance_score);
    srcIds.forEach(sid => {
      if ((m.tags || []).includes('research-finding')) pushEdge(`claim-${m.id}`, `source-${sid}`, 'derived_from', metadata.confidence || m.importance_score);
      if ((m.tags || []).includes('research-observation')) pushEdge(`obs-${m.id}`, `source-${sid}`, 'observed_from', metadata.confidence || m.importance_score);
      if ((m.tags || []).includes('research-trail')) pushEdge(`trail-${m.id}`, `source-${sid}`, 'explored', 0.7);
      if (stage) pushEdge(`csi-${m.id}`, `source-${sid}`, stage === 'faraday' ? 'found_source' : edgeTypeForCsiStage(stage, verdict), metadata.confidence || m.importance_score);
    });
    clIds.forEach(cid => {
      if ((m.tags || []).includes('research-observation')) pushEdge(`obs-${m.id}`, `claim-${cid}`, 'about_claim', metadata.confidence || m.importance_score);
      if ((m.tags || []).includes('research-trail')) pushEdge(`trail-${m.id}`, `claim-${cid}`, 'discovered', 0.8);
      if ((m.tags || []).includes('research-execution-event')) pushEdge(`exec-${m.id}`, `claim-${cid}`, edgeTypeForCsiStage(stage, verdict), metadata.confidence || metadata.output?.confidence || m.importance_score);
      if (stage) pushEdge(`csi-${m.id}`, `claim-${cid}`, edgeTypeForCsiStage(stage, verdict), metadata.confidence || metadata.output?.confidence || m.importance_score);
    });
    obsIds.forEach(oid => {
      if ((m.tags || []).includes('research-execution-event')) pushEdge(`exec-${m.id}`, `obs-${oid}`, stage === 'turing' ? 'verifies' : 'analyzes', metadata.confidence || metadata.output?.confidence || m.importance_score);
      if ((m.tags || []).includes('research-trail')) pushEdge(`trail-${m.id}`, `obs-${oid}`, 'found', 0.75);
      if (stage) pushEdge(`csi-${m.id}`, `obs-${oid}`, stage === 'turing' ? 'verifies' : 'analyzes', metadata.confidence || metadata.output?.confidence || m.importance_score);
    });
    if (metadata.blueprintUsed) pushEdge(`trail-${m.id}`, `blueprint-${metadata.blueprintUsed}`, 'used_blueprint', 0.9);
    if ((m.tags || []).includes('blueprint')) {
      srcIds.forEach(sid => pushEdge(`blueprint-${m.blueprintId}`, `source-${sid}`, 'targets', 0.6));
      clIds.forEach(cid => pushEdge(`blueprint-${m.blueprintId}`, `claim-${cid}`, 'validates', 0.7));
    }
  });

  // Cross-claim edges
  const promotedClaims = (filteredMemories || []).filter(m => (m.tags || []).includes('promoted-claim'));
  const newClaims = (filteredMemories || []).filter(m => (m.tags || []).includes('research-finding') && !(m.tags || []).includes('promoted-claim'));
  if (promotedClaims.length > 0 && newClaims.length > 0) {
    for (const newClaim of newClaims) {
      const newWords = new Set((newClaim.content || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
      for (const promoted of promotedClaims) {
        const promotedWords = new Set((promoted.content || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
        let shared = 0;
        for (const word of newWords) { if (promotedWords.has(word)) shared++; }
        const union = new Set([...newWords, ...promotedWords]).size;
        const jaccard = union > 0 ? shared / union : 0;
        if (jaccard >= 0.25) pushEdge(`claim-${newClaim.id}`, `claim-${promoted.id}`, jaccard >= 0.5 ? 'updates' : 'derives_from', Math.min(0.95, jaccard + 0.3));
      }
    }
  }

  return { layers, trailDiagnostics, projectId };
}

// ── Main HTTP server ─────────────────────────────────────────────────────────

/**
 * Start the DR server. Called once from server.js at startup.
 * @param {Object} deps
 * @param {Object} deps.memoryStore - shared PrismaGraphStore instance
 * @param {Object} deps.prisma - shared Prisma client
 * @param {Function} deps.recallFn - recallPersistedMemories function
 * @param {Object} [deps.browserRuntime] - optional BrowserRuntime for web scraping
 * @param {Function} deps.authenticateFn - async (apiKey) => { userId, orgId } | null
 * @param {number} [deps.port=8055]
 */
export async function startDRServer({ memoryStore, prisma, recallFn, browserRuntime = null, authenticateFn, port = 8055 }) {
  // Deep Research module imports (lazy — only loaded when DR server starts)
  const { DeepResearcher } = await import('./researcher.js');
  const { TrailStore } = await import('./trail-store.js');
  const { BlueprintMiner } = await import('./blueprint-miner.js');

  // In-memory session store
  const researchSessions = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [id, session] of researchSessions) {
      if (new Date(session.createdAt).getTime() < cutoff) researchSessions.delete(id);
    }
  }, 600000);

  // Shared blueprint miner instance (has access to prisma now)
  const blueprintMiner = new BlueprintMiner({ memoryStore, prisma });
  function getBlueprintMiner() { return blueprintMiner; }

  const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${port}`);
  const pathname = urlObj.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Health check (no auth)
  if (pathname === '/health') {
    return jsonResponse(res, { status: 'ok', service: 'dr-server' });
  }

  // Parse body for POST/PATCH
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    body = await parseBody(req);
  }

  // Authenticate via injected function (reuses server.js auth — no HTTP hop)
  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) return jsonResponse(res, { error: 'Unauthorized' }, 401);
  const identity = await authenticateFn(apiKey);
  if (!identity) return jsonResponse(res, { error: 'Unauthorized' }, 401);
  const { userId, orgId } = identity;

  // ── Routes ──────────────────────────────────────────────────────────────────

  // POST /research/start
  if (pathname === '/research/start' && req.method === 'POST') {
    const query = body.query;
    if (!query || typeof query !== 'string' || query.length < 5 || query.length > 1000) {
      return jsonResponse(res, { error: 'query must be a string between 5 and 1000 characters' }, 400);
    }

    const sessionId = crypto.randomUUID();
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
    const projectId = `research/${slug}`;
    const now = new Date();
    const session = {
      id: sessionId, query, userId, orgId, projectId,
      status: 'running',
      events: [], graphEvents: [], sseClients: [],
      result: null, error: null,
      createdAt: now.toISOString(), startedAt: now,
      _researcher: null,
    };
    researchSessions.set(sessionId, session);

    const trailStore = new TrailStore({ memoryStore, userId, orgId });
    const researcher = new DeepResearcher({
      memoryStore,
      recallFn,
      prisma,
      groqApiKey: process.env.GROQ_API_KEY,
      browserRuntime,
      webJobStore: null,
      stigmergicCoT: null,
      maxLlmCalls: parseInt(process.env.DEEP_RESEARCH_MAX_LLM_CALLS || '100', 10),
      onEvent: (event) => broadcastResearchEvent(session, event),
      trailStore,
    });
    session._researcher = researcher;

    const blueprintId = body.blueprintId;
    const useBlueprints = body.useBlueprints !== false;

    researcher.research(query, userId, orgId, {
      forceRefresh: body.forceRefresh,
      sessionId,
      projectId,
      blueprintId: blueprintId || undefined,
      useBlueprints,
      maxLlmCalls: Number.isInteger(body.maxLlmCalls) ? body.maxLlmCalls : undefined,
      maxTasks: Number.isInteger(body.maxTasks) && body.maxTasks > 0 ? body.maxTasks : undefined,
    })
      .then(result => {
        session.status = 'completed';
        session._researcher = null;
        session.result = result;
        persistSessionStatus(sessionId, 'completed', userId, orgId, session.projectId, memoryStore).catch(() => {});
        const donePayload = `event: done\ndata: ${JSON.stringify({ status: 'completed' })}\n\n`;
        session.sseClients.forEach(c => { try { c.write(donePayload); c.end(); } catch {} });
        session.sseClients = [];
      })
      .catch(err => {
        const isCancelled = err.message === 'Research cancelled by user';
        session.status = isCancelled ? 'cancelled' : 'failed';
        session._researcher = null;
        session.error = err.message;
        persistSessionStatus(sessionId, session.status, userId, orgId, session.projectId, memoryStore).catch(() => {});
        try {
          const partialTrailStore = new TrailStore({ memoryStore, userId, orgId });
          const partialReport = isCancelled ? `Research ${session.status}: ${session.query}` : `Research failed: ${err.message}`;
          partialTrailStore.finalizeTrail(sessionId, partialReport, null).catch(() => {});
        } catch {}
        const donePayload = `event: done\ndata: ${JSON.stringify({ status: session.status, error: err.message })}\n\n`;
        session.sseClients.forEach(c => { try { c.write(donePayload); c.end(); } catch {} });
        session.sseClients = [];
      });

    return jsonResponse(res, { session_id: sessionId, project_id: projectId, status: 'started' }, 202);
  }

  // GET /research/sessions
  if (pathname === '/research/sessions' && req.method === 'GET') {
    const sessions = [];
    for (const [id, session] of researchSessions) {
      if (session.userId === userId) {
        sessions.push({ id: session.id, query: session.query, status: session.status, createdAt: session.createdAt, confidence: session.result?.taskProgress?.confidence || null });
      }
    }
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return jsonResponse(res, { sessions });
  }

  // GET /research/blueprints
  if (pathname === '/research/blueprints' && req.method === 'GET') {
    const domain = urlObj.searchParams.get('domain') || null;
    const blueprints = await getBlueprintMiner().getBlueprints(userId, orgId, domain);
    return jsonResponse(res, { blueprints, count: blueprints.length });
  }

  // GET /research/blueprints/suggest
  if (pathname === '/research/blueprints/suggest' && req.method === 'GET') {
    const query = urlObj.searchParams.get('query');
    if (!query || query.length < 5) return jsonResponse(res, { error: 'query parameter is required (min 5 chars)' }, 400);
    const suggestions = await getBlueprintMiner().suggestBlueprints(userId, orgId, query);
    return jsonResponse(res, { suggestions, count: suggestions.length });
  }

  // POST /research/blueprints/mine
  if (pathname === '/research/blueprints/mine' && req.method === 'POST') {
    const blueprints = await getBlueprintMiner().mine(userId, orgId, { minConfidence: body.minConfidence || 0.7, limit: body.limit || 10 });
    return jsonResponse(res, { blueprints, count: blueprints.length, message: `Mined ${blueprints.length} blueprints from completed research trails` });
  }

  // GET /research/blueprints/:blueprintId
  const bpGetMatch = pathname.match(/^\/research\/blueprints\/([^/]+)$/);
  if (bpGetMatch && req.method === 'GET') {
    const bpId = bpGetMatch[1];
    if (bpId !== 'suggest' && bpId !== 'mine') {
      const blueprint = await getBlueprintMiner().getBlueprintById(userId, orgId, bpId);
      if (!blueprint) return jsonResponse(res, { error: 'Blueprint not found' }, 404);
      return jsonResponse(res, { blueprint });
    }
  }

  // POST /research/blueprints/:blueprintId/reuse
  const bpReuseMatch = pathname.match(/^\/research\/blueprints\/([^/]+)\/reuse$/);
  if (bpReuseMatch && req.method === 'POST') {
    const bpId = bpReuseMatch[1];
    const result = await getBlueprintMiner().incrementReuseCount(userId, orgId, bpId);
    if (!result) return jsonResponse(res, { error: 'Blueprint not found' }, 404);
    return jsonResponse(res, { blueprint: result, message: 'Reuse count incremented' });
  }

  // POST /research/blueprint/:blueprintId/rerun
  const bpRerunMatch = pathname.match(/^\/research\/blueprint\/([^/]+)\/rerun$/);
  if (bpRerunMatch && req.method === 'POST') {
    const bpId = bpRerunMatch[1];
    const baseQuery = body.query || body.baseQuery;
    if (!baseQuery) return jsonResponse(res, { error: 'query or baseQuery is required' }, 400);

    const blueprint = await getBlueprintMiner().getBlueprintById(userId, orgId, bpId);
    if (!blueprint) return jsonResponse(res, { error: 'Blueprint not found' }, 404);

    const sessionId = crypto.randomUUID();
    const projectId = `research/${baseQuery.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
    const session = {
      id: sessionId, query: baseQuery, userId, orgId, projectId,
      status: 'running', events: [], graphEvents: [], sseClients: [],
      result: null, error: null,
      createdAt: new Date().toISOString(), startedAt: new Date(),
      baseBlueprintId: bpId, baseCapturedState: blueprint.capturedState,
    };
    researchSessions.set(sessionId, session);

    const trailStore = new TrailStore({ memoryStore, userId, orgId });
    const researcher = new DeepResearcher({
      memoryStore, recallFn, prisma: null, groqApiKey: process.env.GROQ_API_KEY,
      browserRuntime: null, webJobStore: null, stigmergicCoT: null,
      maxLlmCalls: parseInt(process.env.DEEP_RESEARCH_MAX_LLM_CALLS || '100', 10),
      onEvent: (event) => broadcastResearchEvent(session, event),
      trailStore,
    });

    researcher.research(baseQuery, userId, orgId, { sessionId, projectId, blueprintId: bpId, useBlueprints: true, baseState: blueprint.capturedState, maxLlmCalls: Number.isInteger(body.maxLlmCalls) ? body.maxLlmCalls : undefined })
      .then(result => {
        session.status = 'completed'; session.result = result;
        const donePayload = `event: done\ndata: ${JSON.stringify({ status: 'completed' })}\n\n`;
        session.sseClients.forEach(c => { try { c.write(donePayload); c.end(); } catch {} });
        session.sseClients = [];
      })
      .catch(err => {
        session.status = 'failed'; session.error = err.message;
        const donePayload = `event: done\ndata: ${JSON.stringify({ status: 'failed', error: err.message })}\n\n`;
        session.sseClients.forEach(c => { try { c.write(donePayload); c.end(); } catch {} });
        session.sseClients = [];
      });

    return jsonResponse(res, { session_id: sessionId, project_id: projectId, status: 'started', blueprintId: bpId, blueprintName: blueprint.name }, 202);
  }

  // ── Per-session routes ───────────────────────────────────────────────────────
  // Match /research/:sessionId[/action]
  const sessionMatch = pathname.match(/^\/research\/([^/]+)(?:\/(.+))?$/);
  if (!sessionMatch) {
    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  const sessionId = sessionMatch[1];
  const action = sessionMatch[2] || null;

  // Skip non-session route prefixes
  if (sessionId === 'start' || sessionId === 'sessions' || sessionId === 'blueprints' || sessionId === 'blueprint') {
    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // POST /research/:id/cancel
  if (action === 'cancel' && req.method === 'POST') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    if (session.status !== 'running') return jsonResponse(res, { error: `Session is ${session.status}, not running`, status: session.status }, 400);
    if (session._researcher) { session._researcher.cancel(); }
    session.status = 'cancelling';
    return jsonResponse(res, { status: 'cancelling', sessionId });
  }

  // POST /research/:id/synthesize
  if (action === 'synthesize' && req.method === 'POST') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    const researcher = session._researcher;
    if (researcher?._synthesizeResolve) {
      researcher._synthesizeResolve();
      researcher._synthesizeResolve = null;
      broadcastResearchEvent(session, { type: 'research.synthesis_confirmed', sessionId, timestamp: new Date().toISOString() });
      return jsonResponse(res, { status: 'synthesizing', message: 'Report generation started' });
    }
    return jsonResponse(res, { error: 'Session not awaiting synthesis confirmation', status: session.status }, 400);
  }

  // POST /research/:id/synthesize-from-blueprint
  if (action === 'synthesize-from-blueprint' && req.method === 'POST') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    if (session.status === 'running' || session.status === 'cancelling') return jsonResponse(res, { error: 'Session still running — wait for completion or cancel first' }, 409);

    let bpId = body.blueprintId || null;
    if (!bpId) {
      try {
        const bps = await memoryStore.searchMemories({ query: session.query || '', user_id: userId, org_id: orgId, project: session.projectId, n_results: 5 });
        const bp = (bps || []).find(m => (m.tags || []).includes('blueprint'));
        if (bp) bpId = bp.metadata?.blueprint_id || bp.id;
      } catch {}
    }

    const synResearcher = new DeepResearcher({ memoryStore, recallFn, prisma: null, groqApiKey: process.env.GROQ_API_KEY, onEvent: (event) => broadcastResearchEvent(session, event) });
    try {
      const result = await synResearcher.synthesizeFromBlueprint({ sessionId, query: session.query, projectId: session.projectId, blueprintId: bpId, userId, orgId });
      if (!session.result) session.result = {};
      session.result.report = result.report;
      session.result.findings = result.findings;
      session.result.sources = result.sources;
      session.result.fromBlueprint = true;
      persistSessionStatus(sessionId, session.status, userId, orgId, session.projectId, memoryStore).catch(() => {});
      return jsonResponse(res, { report: result.report, findings: result.findings, sources: result.sources, fromBlueprint: true, blueprintId: result.blueprintId || null, durationMs: result.durationMs, findingCount: result.findings.length, sourceCount: result.sources.length });
    } catch (err) {
      console.error('[dr-server] synthesize-from-blueprint failed:', err.message);
      return jsonResponse(res, { error: 'Synthesis failed: ' + err.message }, 500);
    }
  }

  // POST /research/:id/save-as-blueprint
  if (action === 'save-as-blueprint' && req.method === 'POST') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);

    const projectId = session.projectId || `research/${sessionId.slice(0, 8)}`;
    const blueprintName = body.name || `Research: ${session.query?.slice(0, 50)}`;
    const capturedState = await getBlueprintMiner().captureResearchState(sessionId, userId, orgId, projectId);
    if (!capturedState) return jsonResponse(res, { error: 'Failed to capture research state' }, 500);

    const blueprint = {
      blueprintId: randomUUID(), name: blueprintName, version: 1, pattern: [], domain: null,
      successRate: session.result?.confidence || 0.7, timesReused: 0, avgConfidence: session.result?.confidence || 0.7,
      sourceTrailIds: [sessionId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null,
    };
    const saved = await getBlueprintMiner().saveBlueprintWithState(blueprint, userId, orgId, capturedState);
    if (!saved) return jsonResponse(res, { error: 'Failed to save blueprint' }, 500);
    return jsonResponse(res, { blueprint: saved, message: 'Research saved as reusable blueprint' });
  }

  // POST /research/:id/capture-state
  if (action === 'capture-state' && req.method === 'POST') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);

    const projectId = session.projectId || `research/${sessionId.slice(0, 8)}`;
    const capturedState = await getBlueprintMiner().captureResearchState(sessionId, userId, orgId, projectId);
    if (!capturedState) return jsonResponse(res, { error: 'Failed to capture research state' }, 500);
    return jsonResponse(res, { capturedState, message: `Captured ${capturedState.sources?.length || 0} sources, ${capturedState.findings?.length || 0} findings, ${capturedState.trails?.length || 0} trails` });
  }

  // GET /research/:id/stream (SSE)
  if (action === 'stream' && req.method === 'GET') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    replayResearchEvents(res, session);

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled' || session.status === 'interrupted') {
      res.write(`event: done\ndata: ${JSON.stringify({ status: session.status, error: session.error || null })}\n\n`);
      res.end();
      return;
    }

    if (!Array.isArray(session.sseClients)) session.sseClients = [];
    session.sseClients.push(res);

    const pingInterval = setInterval(() => {
      try { res.write(`:keepalive\n\n`); } catch { clearInterval(pingInterval); }
    }, 30000);

    req.on('close', () => {
      clearInterval(pingInterval);
      session.sseClients = session.sseClients.filter(c => c !== res);
    });
    return;
  }

  // GET /research/:id/status or /research/:id
  if ((!action || action === 'status') && req.method === 'GET') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    return jsonResponse(res, { status: session.status, query: session.query, progress: session.result?.taskProgress || null, events: session.events.slice(-20), error: session.error || null, interrupted: session._interrupted || false, checkpointWave: session._checkpointWave || null, checkpointConfidence: session._checkpointConfidence || null });
  }

  // GET /research/:id/report
  if (action === 'report' && req.method === 'GET') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    if (session.status !== 'completed') return jsonResponse(res, { error: 'Research not yet complete', status: session.status }, 202);
    return jsonResponse(res, { report: session.result.report, findings: session.result.findings, sources: session.result.sources, gaps: session.result.gaps, durationMs: session.result.durationMs, confidence: session.result.taskProgress?.confidence ?? session.result.taskProgress?.overallConfidence ?? 0, taskProgress: session.result.taskProgress, fromCache: session.result.fromCache, projectId: session.result.projectId });
  }

  // GET /research/:id/graph
  if (action === 'graph' && req.method === 'GET') {
    let session = researchSessions.get(sessionId);
    if (!session) session = await restoreSessionFromCSI(sessionId, userId, orgId, memoryStore);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    try {
      const { layers, trailDiagnostics, projectId } = await buildResearchGraph(session, sessionId, userId, orgId, memoryStore);
      return jsonResponse(res, { sessionId, projectId, layers, trail_diagnostics: trailDiagnostics, agent_alias_map: { explorer: 'faraday', analyst: 'feynmann', verifier: 'turing', synthesizer: 'synthesis' }, nodeCount: layers.sources.length + layers.claims.length + layers.trails.length + layers.observations.length + layers.executionEvents.length + layers.csi.length + layers.blueprints.length + (layers.promoted?.length || 0) + layers.promotedClaims.length, edgeCount: layers.weights.edges.length });
    } catch (err) {
      console.error('[dr-server] graph lookup failed:', err.message);
      return jsonResponse(res, { error: 'Failed to retrieve graph' }, 500);
    }
  }

  // GET /research/:id/trail
  if (action === 'trail' && req.method === 'GET') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);

    try {
      const trailMemories = await fetchSessionTrailMemories(memoryStore, sessionId, session, session.userId || userId, session.orgId || orgId, { includeCheckpoints: true, limit: 20 });
      const trailMemory = selectPrimaryTrailMemory(trailMemories);
      const normalizedTrail = trailMemory
        ? normalizeResearchTrailMemory(trailMemory, session)
        : session.result?.trail
          ? normalizeResearchTrailMemory({ id: `session-${sessionId}`, project: session.projectId || `research/${sessionId.slice(0, 8)}`, tags: ['research-trail', `session:${sessionId}`], metadata: { query: session.query, status: session.status, startedAt: session.createdAt } }, session, session.result.trail)
          : null;

      if (normalizedTrail) {
        return jsonResponse(res, { trail: normalizedTrail, sessionId, query: normalizedTrail.query || session.query, status: normalizedTrail.status || session.status, fromCSI: !!trailMemory });
      }
      return jsonResponse(res, { error: 'Trail not found', status: session.status }, 404);
    } catch (err) {
      console.error('[dr-server] trail lookup failed:', err.message);
      return jsonResponse(res, { error: 'Failed to retrieve trail' }, 500);
    }
  }

  // GET /research/:id/contradictions
  if (action === 'contradictions' && req.method === 'GET') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    try {
      const contradictionMemories = await memoryStore.searchMemories({ query: sessionId, user_id: session.userId || userId, org_id: session.orgId || orgId, tags: ['research-contradiction'], n_results: 50 });
      const contradictions = (contradictionMemories || []).map(m => ({ id: m.id, dimension: m.metadata?.contradictionType?.split('/')?.[1] || m.tags?.find(t => t.startsWith('dimension:'))?.split(':')[1], claimA: m.metadata?.claimA, claimB: m.metadata?.claimB, unresolved: m.metadata?.unresolved ?? true, detectedAt: m.created_at }));
      return jsonResponse(res, { contradictions, count: contradictions.length, sessionId });
    } catch (err) {
      console.error('[dr-server] contradictions lookup failed:', err.message);
      return jsonResponse(res, { error: 'Failed to retrieve contradictions' }, 500);
    }
  }

  // POST /research/:id/save-memory
  if (action === 'save-memory' && req.method === 'POST') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    const { sourceId, title, url, tags = [] } = body;
    if (!url) return jsonResponse(res, { error: 'url is required' }, 400);
    try {
      const projectId = session.projectId || `research/${sessionId.slice(0, 8)}`;
      const savedMemory = await memoryStore.createMemory({ user_id: session.userId || userId, org_id: session.orgId || orgId, project: projectId, title: title || url, content: `Web source from deep research: ${url}`, memory_type: 'fact', source_type: 'web', metadata: { url, sourceId, researchSession: sessionId, saved_at: new Date().toISOString() }, tags: [...tags, 'web-search', 'deep-research'] });
      return jsonResponse(res, { success: true, memory: savedMemory });
    } catch (err) {
      console.error('[dr-server] save-memory failed:', err.message);
      return jsonResponse(res, { error: 'Failed to save to memory' }, 500);
    }
  }

  // POST /research/:id/promote-memory
  if (action === 'promote-memory' && req.method === 'POST') {
    const session = researchSessions.get(sessionId);
    if (!session) return jsonResponse(res, { error: 'Session not found' }, 404);
    try {
      const projectId = session.projectId || `research/${sessionId.slice(0, 8)}`;
      const reportData = session.result || {};
      const findings = Array.isArray(reportData.findings) ? [...reportData.findings] : [];
      findings.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      const topFindings = findings.slice(0, 5);
      const promotedAt = new Date().toISOString();
      const promotedMemories = [];

      for (const finding of topFindings) {
        const memoryPayload = { user_id: session.userId || userId, org_id: session.orgId || orgId, project: projectId, title: finding.title || 'Promoted claim', content: [finding.title || 'Promoted claim', finding.content || '', '', `Source: ${finding.source || finding.sourceId || 'unknown'}`, `Confidence: ${((finding.confidence || 0) * 100).toFixed(0)}%`, finding.id ? `Claim ID: ${finding.id}` : null, reportData.reportProvenance?.goldenLine ? `Golden line: ${reportData.reportProvenance.goldenLine}` : null].filter(Boolean).join('\n'), memory_type: 'fact', source_type: 'deep_research', importance_score: finding.confidence || 0.7, tags: ['deep-research', 'promoted-claim', `session:${sessionId}`, ...(finding.agent ? [`agent:${finding.agent}`] : [])], metadata: { sessionId, reportId: reportData.reportProvenance?.reportId || null, claimId: finding.id || null, sourceIds: finding.sourceIds || [], trailStepIds: reportData.reportProvenance?.trailStepIds || [], recalledMemoryIds: reportData.reportProvenance?.recalledMemoryIds || [], promotedAt, goldenLine: reportData.reportProvenance?.goldenLine || null, reportProvenance: reportData.reportProvenance || null } };
        const savedMemory = await memoryStore.createMemory(memoryPayload).catch(() => null);
        if (savedMemory) promotedMemories.push(savedMemory);
      }

      if (reportData.report) {
        await memoryStore.createMemory({ user_id: session.userId || userId, org_id: session.orgId || orgId, project: projectId, title: `Research report: ${session.query || sessionId}`, content: [reportData.report, '', 'Golden line:', reportData.reportProvenance?.goldenLine || ''].filter(Boolean).join('\n'), memory_type: 'decision', source_type: 'deep_research_report', importance_score: 0.85, tags: ['deep-research', 'report', `session:${sessionId}`], metadata: { sessionId, reportId: reportData.reportProvenance?.reportId || null, provenance: reportData.reportProvenance || null, promotedAt } }).catch(() => {});
      }

      return jsonResponse(res, { success: true, promotedCount: promotedMemories.length, promotedClaimIds: topFindings.map(f => f.id).filter(Boolean), promotedAt });
    } catch (err) {
      console.error('[dr-server] promote-memory failed:', err.message);
      return jsonResponse(res, { error: 'Failed to promote memory' }, 500);
    }
  }

  return jsonResponse(res, { error: 'Not found' }, 404);
  }); // end http.createServer

  await new Promise((resolve, reject) => {
    server.listen(port, (err) => err ? reject(err) : resolve());
  });
  console.log(`[DR Server] Listening on port ${port}`);
  return server;
} // end startDRServer

export default server;
