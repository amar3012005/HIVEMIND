#!/usr/bin/env node

// Destructive, self-cleaning production acceptance canary. It seeds the exact
// durable state left by a terminal ingestion failure (job row + retained raw
// bytes), resumes it through the public retry endpoint, then submits the same
// bytes through the public upload endpoint and proves duplicate delivery does
// not create a second document. Runs unchanged for managed, embedded .amr and
// self-hosted BYOD organizations.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPrismaClient } from '../src/db/prisma.js';
import { orgIsRemote } from '../src/vector/mneme/driver.js';
import { agentFor } from '../src/vector/mneme/remote-backend.js';

const orgId = String(process.env.STORAGE_CANARY_ORG_ID || '').trim();
const userId = String(process.env.STORAGE_CANARY_USER_ID || '').trim();
const baseUrl = String(process.env.STORAGE_CANARY_CORE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!orgId || !userId || process.env.STORAGE_CANARY_CONFIRM !== 'DELETE_CANARY_DATA') {
  throw new Error('Set STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID, and STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA');
}

const prisma = getPrismaClient();
const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
const marker = `STORAGE-RETRY-DEDUP-${nonce}`;
const filename = `storage-retry-dedup-${nonce}.md`;
const content = Buffer.from(`# Durable ingestion retry\n\nThe exact recovery marker is ${marker}.\n`, 'utf8');
const checksum = crypto.createHash('sha256').update(content).digest('hex');
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const rawDir = path.join(process.env.KB_STORE_DIR || '/app/data/kb-store', orgId, checksum);
const rawPath = path.join(rawDir, filename);
const headers = {
  authorization: `Bearer ${rawKey}`,
  'x-hm-user-id': userId,
  'x-hm-org-id': orgId,
};
let keyId;
let jobId;
let documentId;
const startedAt = Date.now();

async function payload(response) {
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function requireOk(response) {
  const result = await payload(response);
  if (!result.response.ok) throw new Error(`${result.response.status}:${JSON.stringify(result.body)}`);
  return result.body;
}

async function deleteDocument() {
  if (!documentId) return;
  await requireOk(await fetch(`${baseUrl}/api/knowledge/document`, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id: documentId, filename }),
  }));
  documentId = null;
}

try {
  const org = await prisma.organization.findUnique({
    where: { id: orgId }, select: { memoryStorageMode: true },
  });
  if (!org) throw new Error('organization_not_found');
  const key = await prisma.apiKey.create({ data: {
    userId, orgId, name: 'storage-retry-dedup-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(rawPath, content, { mode: 0o600 });
  const seeded = await prisma.knowledgeIngestJob.create({ data: {
    orgId, userId,
    scopeType: 'organization', scopeId: orgId, scopeKey: `organization:${orgId}`,
    storageMode: org.memoryStorageMode || 'hybrid',
    filename, contentType: 'text/markdown', mediaKind: 'document', ingestMode: 'evidence',
    checksum, status: 'failed', stage: 'failed', progress: 0, processingVersion: 1,
    attempt: 3, errorCode: 'CANARY_FORCED_FAILURE',
    errorMessage: 'Synthetic terminal failure for retry acceptance',
    metadata: {
      ingest_mode: 'evidence', target_scope: 'organization', scope_type: 'organization',
      scope_id: orgId, project_ids: [], primary_team_id: null,
    },
  } });
  jobId = seeded.id;

  const retried = await requireOk(await fetch(`${baseUrl}/api/knowledge/jobs/retry`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: jobId }),
  }));
  if (retried.processing_version !== 2 || retried.status !== 'queued') {
    throw new Error(`retry_not_acknowledged:${JSON.stringify(retried)}`);
  }

  let status;
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    status = await requireOk(await fetch(`${baseUrl}/api/knowledge/status?job_id=${encodeURIComponent(jobId)}`, { headers }));
    if (['ready', 'failed', 'dead'].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status?.status !== 'ready') throw new Error(`retry_did_not_recover:${JSON.stringify(status)}`);
  documentId = status.document_id;

  const before = await prisma.knowledgeIngestJob.count({ where: { orgId, checksum } });
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'text/markdown' }), filename);
  form.set('targetScope', 'organization');
  form.set('ingestMode', 'evidence');
  form.set('smart', 'false');
  const duplicate = await payload(await fetch(`${baseUrl}/api/knowledge/upload`, {
    method: 'POST', headers, body: form,
  }));
  if (duplicate.response.status !== 409 || duplicate.body.duplicate !== true
      || duplicate.body.existing_document_id !== documentId) {
    throw new Error(`duplicate_not_deduplicated:${duplicate.response.status}:${JSON.stringify(duplicate.body)}`);
  }
  const after = await prisma.knowledgeIngestJob.count({ where: { orgId, checksum } });
  if (before !== 1 || after !== 1) throw new Error(`duplicate_job_count_changed:${before}:${after}`);

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = {
    documents: await prisma.knowledgeDocument.count({ where: { orgId, id: documentId } }),
    segments: await prisma.knowledgeSegment.count({ where: { orgId, documentId } }),
  };
  if (remote && (central.documents || central.segments)) {
    throw new Error(`residency_violation:${JSON.stringify(central)}`);
  }
  if (!remote && (central.documents !== 1 || central.segments < 1)) {
    throw new Error(`managed_retry_missing:${JSON.stringify(central)}`);
  }

  await deleteDocument();
  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    retry_processing_version: retried.processing_version,
    recovered_status: status.status,
    duplicate_status: duplicate.response.status,
    duplicate_document_id_matched: true,
    job_count_before: before,
    job_count_after: after,
    central,
    hard_deleted: true,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }));
} finally {
  await deleteDocument().catch(() => {});
  if (jobId) await prisma.knowledgeIngestJob.deleteMany({ where: { id: jobId, orgId } }).catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  fs.rmSync(rawDir, { recursive: true, force: true });
  await prisma.$disconnect();
}
