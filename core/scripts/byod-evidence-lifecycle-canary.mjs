#!/usr/bin/env node

// Destructive, self-cleaning production acceptance canary for managed,
// embedded .amr, or self-hosted Memory Box organizations. It proves the public
// Core lifecycle rather than treating a direct storage probe as sufficient:
//   evidence-only upload -> durable remote segment -> public recall ->
//   zero central content -> delete -> no longer recallable.
//
// Required env: STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID,
// STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA.

import crypto from 'node:crypto';
import { getPrismaClient } from '../src/db/prisma.js';
import {
  amrKbDocDetail,
  amrKbHydrate,
  amrKbLexicalRemote,
} from '../src/vector/mneme/driver.js';
import { orgIsRemote } from '../src/vector/mneme/driver.js';
import { agentFor } from '../src/vector/mneme/remote-backend.js';

const orgId = String(process.env.STORAGE_CANARY_ORG_ID || '').trim();
const userId = String(process.env.STORAGE_CANARY_USER_ID || '').trim();
const baseUrl = String(process.env.STORAGE_CANARY_CORE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!orgId || !userId || process.env.STORAGE_CANARY_CONFIRM !== 'DELETE_CANARY_DATA') {
  throw new Error('Set STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID, and STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA');
}

const prisma = getPrismaClient();
const marker = `BYOD-EVIDENCE-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
const filename = `storage-evidence-canary-${Date.now()}.md`;
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
let keyId = null;
let documentId = null;
const startedAt = Date.now();

const headers = {
  authorization: `Bearer ${rawKey}`,
  'x-hm-user-id': userId,
  'x-hm-org-id': orgId,
};

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

async function recall() {
  return responseJson(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query: marker, mode: 'quick', limit: 15, debug_timing: true }),
  }));
}

async function deleteDocument() {
  return responseJson(await fetch(`${baseUrl}/api/knowledge/document`, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id: documentId, filename }),
  }));
}

try {
  const key = await prisma.apiKey.create({ data: {
    userId,
    orgId,
    name: 'storage-parity-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  const form = new FormData();
  form.set('file', new Blob([
    `# Remote evidence acceptance\n\nThe exact recovery marker is ${marker}.\n\nThis evidence belongs only on the customer Memory Box.`,
  ], { type: 'text/markdown' }), filename);
  form.set('targetScope', 'organization');
  form.set('ingestMode', 'evidence');
  form.set('smart', 'false');
  const admitted = await responseJson(await fetch(`${baseUrl}/api/knowledge/upload`, {
    method: 'POST', headers, body: form,
  }));

  let status = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    status = await responseJson(await fetch(
      `${baseUrl}/api/knowledge/status?job_id=${encodeURIComponent(admitted.job_id)}`,
      { headers },
    ));
    if (status.status === 'ready' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status?.status !== 'ready') throw new Error(`ingestion_not_ready:${JSON.stringify(status)}`);
  documentId = status.document_id;

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const access = { userId, projectId: null, accessContext: { projectIds: [], teamIds: [] }, scopeFilter: null };
  let storedSegmentCount = 0;
  let lexicalCount = 0;
  let hydratedCount = 0;
  if (remote && !embedded) {
    const [detail, lexical] = await Promise.all([
      amrKbDocDetail(orgId, documentId, access),
      amrKbLexicalRemote(orgId, marker, { limit: 15, access }),
    ]);
    const ids = (lexical || []).map((row) => row.segment_id).filter(Boolean);
    const hydrated = ids.length ? await amrKbHydrate(orgId, ids, access) : [];
    storedSegmentCount = detail?.segments?.length || 0;
    lexicalCount = lexical?.length || 0;
    hydratedCount = hydrated?.length || 0;
  } else if (embedded) {
    const stored = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM hm.knowledge_segments
        WHERE org_id=$1::uuid AND document_id=$2::uuid`,
      orgId, documentId,
    );
    const lexical = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM hm.knowledge_segments
        WHERE org_id=$1::uuid AND document_id=$2::uuid AND content LIKE $3`,
      orgId, documentId, `%${marker}%`,
    );
    storedSegmentCount = Number(stored?.[0]?.n || 0);
    lexicalCount = Number(lexical?.[0]?.n || 0);
    hydratedCount = lexicalCount;
  } else {
    storedSegmentCount = await prisma.knowledgeSegment.count({ where: { orgId, documentId } });
    lexicalCount = await prisma.knowledgeSegment.count({ where: { orgId, documentId, content: { contains: marker } } });
    hydratedCount = lexicalCount;
  }
  if (!storedSegmentCount || !lexicalCount || !hydratedCount) {
    throw new Error(`storage_lane_miss:${JSON.stringify({ storedSegmentCount, lexicalCount, hydratedCount })}`);
  }

  // Public recall runs FIRST. A direct evidence call would warm the embedding
  // path and hide the cold-start regression this canary is meant to catch.
  const recalled = await recall();
  const evidence = Array.isArray(recalled.evidence) ? recalled.evidence : [];
  if (!evidence.some((row) => String(row.snippet || row.content || '').includes(marker))) {
    const diagnosticDirect = await responseJson(await fetch(`${baseUrl}/api/evidence/search`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ query: marker, limit: 15 }),
    }));
    const diagnosticSecond = await recall();
    throw new Error(`public_recall_miss:${JSON.stringify({
      memories: recalled.memories?.length || 0,
      evidence: evidence.length,
      mode_used: recalled.mode_used || null,
      search_method: recalled.search_method || null,
      recall_plan: recalled.recall_plan || null,
      cutoff_reason: recalled.cutoff_reason || null,
      evidence_packet: recalled.evidence_packet || null,
      unified_results: recalled.results?.length || 0,
      trace: recalled.trace || recalled.recall_trace || null,
      timing_ms: recalled.timing_ms || recalled.recall_timing_ms || null,
      stage_breakdown: recalled.stage_breakdown || null,
      direct_after_miss: (diagnosticDirect.results || diagnosticDirect.evidence || []).length,
      second_recall_evidence: diagnosticSecond.evidence?.length || 0,
      second_timing_ms: diagnosticSecond.timing_ms || null,
    })}`);
  }

  const directEvidence = await responseJson(await fetch(`${baseUrl}/api/evidence/search`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query: marker, limit: 15 }),
  }));
  const directEvidenceRows = directEvidence.results || directEvidence.evidence || [];
  if (!directEvidenceRows.some((row) => String(row.snippet || row.content || '').includes(marker))) {
    throw new Error(`direct_evidence_miss:${JSON.stringify({ returned: directEvidenceRows.length })}`);
  }

  const central = {
    documents: await prisma.knowledgeDocument.count({ where: { orgId, id: documentId } }),
    segments: await prisma.knowledgeSegment.count({ where: { orgId, documentId } }),
    memories: await prisma.memory.count({ where: { orgId, content: { contains: marker } } }),
  };
  if (remote && (central.documents || central.segments || central.memories)) {
    throw new Error(`residency_violation:${JSON.stringify(central)}`);
  }
  if (!remote && (central.documents !== 1 || central.segments < 1 || central.memories !== 0)) {
    throw new Error(`managed_persistence_violation:${JSON.stringify(central)}`);
  }

  const removed = await deleteDocument();
  if (!removed.success) throw new Error(`delete_failed:${JSON.stringify(removed)}`);
  documentId = null;
  const after = await recall();
  if ((after.evidence || []).some((row) => String(row.snippet || row.content || '').includes(marker))) {
    throw new Error('deleted_remote_evidence_remains_recallable');
  }

  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    ingest_mode: 'evidence',
    status: status.status,
    segment_count: storedSegmentCount,
    lexical_hits: lexicalCount,
    hydrated_hits: hydratedCount,
    recalled_evidence: evidence.length,
    direct_evidence: directEvidenceRows.length,
    central,
    deleted: true,
    duration_ms: Date.now() - startedAt,
    core_revision: process.env.HIVEMIND_RELEASE_SHA || process.env.GIT_SHA || null,
    timestamp: new Date().toISOString(),
  }));
} finally {
  if (documentId) await deleteDocument().catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
