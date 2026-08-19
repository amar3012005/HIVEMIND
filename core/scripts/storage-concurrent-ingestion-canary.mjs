#!/usr/bin/env node

// Self-cleaning production acceptance: eight concurrent uploads (four evidence,
// four both), 45+ segments each, while an interactive recall runs in parallel.
// Every document must become ready and every managed segment must have an
// acknowledged vector before the canary succeeds.

import crypto from 'node:crypto';
import { getPrismaClient } from '../src/db/prisma.js';
import { orgIsRemote } from '../src/vector/mneme/driver.js';

const orgId = String(process.env.STORAGE_CANARY_ORG_ID || '').trim();
const userId = String(process.env.STORAGE_CANARY_USER_ID || '').trim();
const baseUrl = String(process.env.STORAGE_CANARY_CORE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!orgId || !userId || process.env.STORAGE_CANARY_CONFIRM !== 'DELETE_CANARY_DATA') {
  throw new Error('Set STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID, and STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA');
}

const prisma = getPrismaClient();
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const headers = { authorization: `Bearer ${rawKey}`, 'x-hm-user-id': userId, 'x-hm-org-id': orgId };
const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const uploads = [];
let keyId = null;

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(body)}`);
  return body;
}

function corpus(index) {
  const marker = `CONCURRENT-${suffix}-${index}`;
  const paragraphs = Array.from({ length: 90 }, (_, row) => (
    `## Record ${row + 1}\n\n${marker} states that product P${index}-${row + 1} has approved capacity ${1000 + row} units, owner Person ${index}-${row + 1}, and review date 203${row % 10}-0${(row % 9) + 1}-15. This atomic record must remain linked to its source evidence.`
  ));
  return { marker, text: `# Concurrent ingestion ${index}\n\n${paragraphs.join('\n\n')}` };
}

async function upload(index) {
  const mode = index < 4 ? 'evidence' : 'both';
  const { marker, text } = corpus(index);
  const filename = `concurrent-${suffix}-${index}.md`;
  const form = new FormData();
  form.set('file', new Blob([text], { type: 'text/markdown' }), filename);
  form.set('targetScope', 'organization');
  form.set('ingestMode', mode);
  form.set('smart', mode === 'both' ? 'true' : 'false');
  const admitted = await json(await fetch(`${baseUrl}/api/knowledge/upload`, { method: 'POST', headers, body: form }));
  const item = { index, mode, marker, filename, jobId: admitted.job_id, documentId: null, status: null };
  uploads.push(item);
  return item;
}

async function waitReady(item) {
  for (let poll = 0; poll < 300; poll += 1) {
    const status = await json(await fetch(`${baseUrl}/api/knowledge/status?job_id=${encodeURIComponent(item.jobId)}`, { headers }));
    item.status = status;
    item.documentId = status.document_id || item.documentId;
    if (status.status === 'ready') return item;
    if (['failed', 'dead'].includes(status.status)) throw new Error(`job_${item.index}_${status.status}:${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`job_${item.index}_timeout`);
}

async function cleanup() {
  for (const item of uploads) {
    if (item.documentId) {
      await fetch(`${baseUrl}/api/knowledge/document`, {
        method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.documentId, filename: item.filename }),
      }).catch(() => {});
    }
    if (item.jobId) await prisma.knowledgeIngestJob.deleteMany({ where: { id: item.jobId, orgId, userId } }).catch(() => {});
  }
}

const startedAt = Date.now();
try {
  const key = await prisma.apiKey.create({ data: {
    userId, orgId, name: 'storage-concurrent-ingestion-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;
  const items = await Promise.all(Array.from({ length: 8 }, (_, index) => upload(index)));
  const interactive = (async () => {
    const started = Date.now();
    const result = await json(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'What are the latest organizational facts?', mode: 'quick', limit: 5, debug_timing: true }),
    }));
    return { result, wallMs: Date.now() - started };
  })();
  const [ready, recalledProbe] = await Promise.all([Promise.all(items.map(waitReady)), interactive]);
  const recalled = recalledProbe.result;
  const recallWallMs = recalledProbe.wallMs;
  const documentIds = ready.map((item) => item.documentId);
  const remote = orgIsRemote(orgId);
  let vectorState = { total: 0, synced: 0, pending: 0 };
  if (!remote) {
    const [total, synced] = await Promise.all([
      prisma.knowledgeSegment.count({ where: { orgId, documentId: { in: documentIds } } }),
      prisma.knowledgeSegment.count({ where: { orgId, documentId: { in: documentIds }, vectorStored: true } }),
    ]);
    vectorState = { total, synced, pending: total - synced };
    if (total < 360 || synced !== total) throw new Error(`managed_vectors_incomplete:${JSON.stringify(vectorState)}`);
  }
  for (const item of ready) {
    if (item.mode === 'evidence' && (item.status.memory_ids || []).length) throw new Error(`evidence_promoted_memory:${item.index}`);
    if (item.mode === 'both' && !(item.status.memory_ids || []).length) throw new Error(`both_missing_memories:${item.index}`);
  }
  console.log(JSON.stringify({
    ok: true, storage_mode: remote ? 'byod' : 'managed', uploads: ready.length,
    evidence_uploads: 4, both_uploads: 4,
    segments_reported: ready.reduce((sum, item) => sum + Number(item.status.counts?.segments || item.status.segment_count || 0), 0),
    vector_state: vectorState, interactive_recall_wall_ms: recallWallMs,
    interactive_memories: recalled.memories?.length || 0, interactive_evidence: recalled.evidence?.length || 0,
    duration_ms: Date.now() - startedAt,
  }));
} finally {
  await cleanup().catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
