import {
  remoteCapabilities,
  clearRemoteAgentMaintenanceQuarantine,
  quarantineRemoteAgentMaintenance,
  remoteKbSegment,
  remoteList,
  remoteVectorPending,
  remoteVectorRepair,
  remoteVectorStatus,
  remoteWrite,
} from './remote-backend.js';

const DEFAULT_BATCH = Math.min(Math.max(Number(process.env.REMOTE_VECTOR_RECONCILE_BATCH || 20), 1), 100);
const MAINTENANCE_FAILURE_THRESHOLD = Math.max(1, Number(process.env.REMOTE_VECTOR_MAINTENANCE_FAILURE_THRESHOLD || 3));
const MAINTENANCE_QUARANTINE_MS = Math.max(60_000, Number(process.env.REMOTE_VECTOR_MAINTENANCE_QUARANTINE_MS || 3_600_000));
const maintenanceState = new Map();

export function recordRemoteMaintenanceSuccess(orgId) {
  maintenanceState.delete(orgId);
  clearRemoteAgentMaintenanceQuarantine(orgId);
  return { failures: 0, quarantined_until: null };
}

export function recordRemoteMaintenanceFailure(orgId, {
  now = Date.now(),
  threshold = MAINTENANCE_FAILURE_THRESHOLD,
  quarantineMs = MAINTENANCE_QUARANTINE_MS,
} = {}) {
  const prior = maintenanceState.get(orgId) || { failures: 0, quarantinedUntil: 0 };
  const failures = prior.failures + 1;
  const quarantinedUntil = failures >= threshold ? now + quarantineMs : prior.quarantinedUntil;
  const next = { failures, quarantinedUntil };
  maintenanceState.set(orgId, next);
  if (quarantinedUntil) quarantineRemoteAgentMaintenance(orgId, quarantinedUntil);
  return { failures, quarantined_until: quarantinedUntil || null };
}

export function remoteMaintenanceStatus(orgId, now = Date.now()) {
  const state = maintenanceState.get(orgId) || { failures: 0, quarantinedUntil: 0 };
  return {
    failures: state.failures,
    quarantined: state.quarantinedUntil > now,
    quarantined_until: state.quarantinedUntil || null,
  };
}

export function remoteMemoryRecord(row, orgId) {
  return {
    id: row.id,
    orgId,
    userId: row.user_id || row.userId || null,
    content: String(row.content || ''),
    title: row.title || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    memoryType: row.memory_type || row.memoryType || null,
    isLatest: row.is_latest ?? row.isLatest ?? true,
    layer: row.layer || 'memory',
    cognitiveLayerRole: row.cognitive_layer_role || row.cognitiveLayerRole || null,
    confidence: row.confidence ?? null,
    createdAt: row.created_at || row.createdAt || null,
    validFrom: row.valid_from || row.validFrom || null,
    validTo: row.valid_to || row.validTo || null,
    documentDate: row.document_date || row.documentDate || null,
    project: row.project || null,
    projectIds: row.project_ids || row.projectIds || [],
    scope: row.scope || null,
    primaryTeamId: row.primary_team_id || row.primaryTeamId || null,
    recallCount: row.recall_count ?? row.recallCount ?? 0,
    strength: row.strength ?? 1,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  };
}

export function remoteEvidenceSegment(row) {
  return {
    id: row.id,
    userId: row.user_id || row.userId || null,
    documentId: row.document_id || row.documentId,
    content: String(row.content || ''),
    contentHash: row.content_hash || row.contentHash || null,
    segmentType: row.segment_type || row.segmentType || 'chunk',
    segmentIndex: row.segment_index ?? row.segmentIndex ?? 0,
    previousSegmentId: row.previous_segment_id || row.previousSegmentId || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    startPage: row.start_page ?? row.startPage ?? null,
    endPage: row.end_page ?? row.endPage ?? null,
    wordCount: row.word_count ?? row.wordCount ?? null,
    createdAt: row.created_at || row.createdAt || null,
  };
}

async function collectPending(orgId, kind, batchSize, deps) {
  const pending = [];
  let cursor = null;
  let modern = true;
  do {
    const page = await deps.remoteVectorPending(orgId, { kind, cursor, limit: batchSize, transportClass: 'maintenance' });
    if (!page) { modern = false; break; }
    pending.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  if (modern || kind === 'evidence') return { pending, modern };

  // Compatibility recovery for already-deployed agents that predate
  // /v1/vector-pending. Their /v1/list includes vector_synced.
  cursor = null;
  do {
    const page = await deps.remoteList(orgId, { is_latest: true, layer: 'memory' }, cursor, 500, 0, { transportClass: 'maintenance' });
    const rows = page?.memories || [];
    pending.push(...rows.filter((row) => row.vector_synced !== true));
    cursor = page?.cursor || null;
  } while (cursor);
  return { pending, modern: false };
}

export async function reconcileRemoteVectors(orgId, options = {}) {
  if (!orgId) throw new Error('orgId is required');
  const commit = options.commit === true;
  const batchSize = Math.min(Math.max(Number(options.batchSize || DEFAULT_BATCH), 1), 100);
  const embedService = options.deps?.embedService
    || (await import('../../embeddings/factory.js')).getEmbedService();
  const deps = {
    embedService,
    remoteCapabilities,
    remoteKbSegment,
    remoteList,
    remoteVectorPending,
    remoteVectorRepair,
    remoteVectorStatus,
    remoteWrite,
    ...(options.deps || {}),
  };
  const negotiated = await deps.remoteCapabilities(orgId, { transportClass: 'maintenance' });
  const advertised = new Set(negotiated?.capabilities || []);
  const explicitlyLegacy = negotiated && !advertised.has('vector.pending');
  const before = explicitlyLegacy ? null : await deps.remoteVectorStatus(orgId, { transportClass: 'maintenance' });
  const modernDeps = explicitlyLegacy
    ? { ...deps, remoteVectorPending: async () => null }
    : deps;
  const memories = await collectPending(orgId, 'memory', batchSize, modernDeps);
  const evidence = await collectPending(orgId, 'evidence', batchSize, modernDeps);
  const report = {
    orgId,
    commit,
    before,
    capabilities: negotiated,
    compatibility_mode: !memories.modern,
    memory: { pending: memories.pending.length, repaired: 0, failed: [] },
    evidence: { pending: evidence.pending.length, repaired: 0, failed: [] },
  };
  if (!commit) return report;
  const expectedDimension = negotiated?.vector_dimension || null;
  const vectorIsValid = (vector) => Array.isArray(vector)
    && vector.every(Number.isFinite)
    && (!expectedDimension || vector.length === expectedDimension);

  for (let i = 0; i < memories.pending.length; i += batchSize) {
    const rows = memories.pending.slice(i, i + batchSize);
    const vectors = await deps.embedService.embed(rows.map((row) => String(row.content || '')));
    for (let j = 0; j < rows.length; j++) {
      if (!vectorIsValid(vectors[j])) {
        report.memory.failed.push(rows[j].id);
        continue;
      }
      const ok = memories.modern
        ? await deps.remoteVectorRepair(orgId, { kind: 'memory', id: rows[j].id, vector: vectors[j], transportClass: 'maintenance' })
        : await deps.remoteWrite(orgId, remoteMemoryRecord(rows[j], orgId), vectors[j], [], { transportClass: 'maintenance' });
      if (ok) report.memory.repaired += 1;
      else report.memory.failed.push(rows[j].id);
    }
  }
  for (let i = 0; i < evidence.pending.length; i += batchSize) {
    const rows = evidence.pending.slice(i, i + batchSize);
    const vectors = await deps.embedService.embed(rows.map((row) => String(row.content || '')));
    for (let j = 0; j < rows.length; j++) {
      if (!vectorIsValid(vectors[j])) {
        report.evidence.failed.push(rows[j].id);
        continue;
      }
      const ok = await deps.remoteVectorRepair(orgId, { kind: 'evidence', id: rows[j].id, vector: vectors[j], transportClass: 'maintenance' });
      if (ok) report.evidence.repaired += 1;
      else report.evidence.failed.push(rows[j].id);
    }
  }
  report.after = explicitlyLegacy ? null : await deps.remoteVectorStatus(orgId, { transportClass: 'maintenance' });
  return report;
}

let reconcileTimer = null;
export function startRemoteVectorReconciler() {
  if (reconcileTimer || (process.env.REMOTE_VECTOR_RECONCILE_ENABLED ?? 'true') !== 'true') return;
  const intervalMs = Math.max(Number(process.env.REMOTE_VECTOR_RECONCILE_INTERVAL_MS || 600_000), 60_000);
  const run = async () => {
    const { remoteAgentOrgIds } = await import('./remote-backend.js');
    for (const orgId of remoteAgentOrgIds()) {
      const maintenance = remoteMaintenanceStatus(orgId);
      if (maintenance.quarantined) continue;
      try {
        const report = await reconcileRemoteVectors(orgId, { commit: true, batchSize: DEFAULT_BATCH });
        recordRemoteMaintenanceSuccess(orgId);
        if (report.memory.pending || report.evidence.pending) {
          console.log('[remote-vector-reconcile]', JSON.stringify({
            orgId,
            memory: report.memory,
            evidence: report.evidence,
            compatibility_mode: report.compatibility_mode,
          }));
        }
      } catch (error) {
        const state = recordRemoteMaintenanceFailure(orgId);
        // The transport layer already emits one deduplicated circuit transition.
        // Only add a reconciler event when maintenance actually changes state.
        if (state.quarantined_until && state.failures === MAINTENANCE_FAILURE_THRESHOLD) {
          console.warn(`[remote-vector-reconcile] org=${orgId} maintenance quarantined until ${new Date(state.quarantined_until).toISOString()}`);
        }
      }
    }
  };
  reconcileTimer = setInterval(run, intervalMs);
  reconcileTimer.unref?.();
  setTimeout(run, Number(process.env.REMOTE_VECTOR_RECONCILE_INITIAL_DELAY_MS || 30_000)).unref?.();
}

export default reconcileRemoteVectors;
