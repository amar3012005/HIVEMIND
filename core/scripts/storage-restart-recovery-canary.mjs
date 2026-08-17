#!/usr/bin/env node

// Two-phase Core-restart recovery canary.
//
// seed: requires an empty KB queue, pauses it, creates one terminal failed job
// with retained bytes per storage mode, calls the public retry endpoint, and
// persists a root-only transient state file.
// verify: resumes the durable queue after Core recreation, requires every job
// to reach ready in its original backend, then hard-cleans all canary state.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getPrismaClient } from '../src/db/prisma.js';
import { orgIsRemote } from '../src/vector/mneme/driver.js';
import { agentFor } from '../src/vector/mneme/remote-backend.js';

const require = createRequire(import.meta.url);
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const phase = String(process.env.STORAGE_CANARY_PHASE || '').trim();
const confirm = process.env.STORAGE_CANARY_CONFIRM === 'DELETE_CANARY_DATA';
const statePath = process.env.STORAGE_CANARY_STATE_FILE || '/app/data/storage-restart-recovery-canary.json';
const baseUrl = String(process.env.STORAGE_CANARY_CORE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const targets = JSON.parse(process.env.STORAGE_CANARY_TARGETS || '[]');
if (!confirm || !['seed', 'verify'].includes(phase)) {
  throw new Error('Set STORAGE_CANARY_PHASE=seed|verify and STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA');
}
if (phase === 'seed' && (!Array.isArray(targets) || targets.length !== 3)) {
  throw new Error('STORAGE_CANARY_TARGETS must contain exactly managed, amr_embedded, and byod targets');
}

const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
const queue = new Queue('kb-ingest', { connection: redis });
const prisma = getPrismaClient();

function headers(item) {
  return {
    authorization: `Bearer ${item.rawKey}`,
    'x-hm-user-id': item.userId,
    'x-hm-org-id': item.orgId,
  };
}

async function requireJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(body)}`);
  return body;
}

async function cleanup(items) {
  for (const item of items || []) {
    if (item.documentId) {
      await fetch(`${baseUrl}/api/knowledge/document`, {
        method: 'DELETE', headers: { ...headers(item), 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.documentId, filename: item.filename }),
      }).catch(() => {});
    }
    if (item.jobId) await prisma.knowledgeIngestJob.deleteMany({ where: { id: item.jobId, orgId: item.orgId } }).catch(() => {});
    if (item.keyId) await prisma.apiKey.deleteMany({ where: { id: item.keyId } }).catch(() => {});
    if (item.rawDir) fs.rmSync(item.rawDir, { recursive: true, force: true });
  }
  fs.rmSync(statePath, { force: true });
}

if (phase === 'seed') {
  const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'prioritized');
  if (Object.values(counts).some((count) => Number(count) > 0)) {
    throw new Error(`kb_queue_not_empty:${JSON.stringify(counts)}`);
  }
  const state = { createdAt: new Date().toISOString(), items: [] };
  try {
    await queue.pause();
    for (const target of targets) {
      const orgId = String(target.orgId || '');
      const userId = String(target.userId || '');
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { memoryStorageMode: true } });
      if (!org) throw new Error(`${target.mode}:organization_not_found`);
      const nonce = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
      const marker = `STORAGE-RESTART-${target.mode}-${nonce}`;
      const filename = `storage-restart-${target.mode}-${nonce}.md`;
      const content = Buffer.from(`# Restart recovery\n\nThe exact durable marker is ${marker}.\n`, 'utf8');
      const checksum = crypto.createHash('sha256').update(content).digest('hex');
      const rawDir = path.join(process.env.KB_STORE_DIR || '/app/data/kb-store', orgId, checksum);
      fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(rawDir, filename), content, { mode: 0o600 });
      const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
      const key = await prisma.apiKey.create({ data: {
        userId, orgId, name: 'storage-restart-recovery-canary',
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
      } });
      const job = await prisma.knowledgeIngestJob.create({ data: {
        orgId, userId, scopeType: 'organization', scopeId: orgId,
        scopeKey: `organization:${orgId}`, storageMode: org.memoryStorageMode || 'hybrid',
        filename, contentType: 'text/markdown', mediaKind: 'document', ingestMode: 'evidence',
        checksum, status: 'failed', stage: 'failed', progress: 0, processingVersion: 1,
        attempt: 3, errorCode: 'CANARY_FORCED_FAILURE', errorMessage: 'Restart recovery acceptance',
        metadata: { ingest_mode: 'evidence', target_scope: 'organization', scope_type: 'organization', scope_id: orgId },
      } });
      const item = { ...target, orgId, userId, marker, filename, checksum, rawDir, rawKey, keyId: key.id, jobId: job.id };
      state.items.push(item);
      const retried = await requireJson(await fetch(`${baseUrl}/api/knowledge/jobs/retry`, {
        method: 'POST', headers: { ...headers(item), 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: job.id }),
      }));
      if (retried.status !== 'queued' || retried.processing_version !== 2) throw new Error(`${target.mode}:retry_not_queued`);
    }
    fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ ok: true, phase, queue_paused: true, jobs: state.items.length, state_mode: (fs.statSync(statePath).mode & 0o777).toString(8) }));
  } catch (error) {
    await queue.resume().catch(() => {});
    await cleanup(state.items);
    throw error;
  }
} else {
  if (!fs.existsSync(statePath)) throw new Error('restart_state_missing');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const results = [];
  try {
    await queue.resume();
    for (const item of state.items) {
      let status;
      for (let attempt = 1; attempt <= 90; attempt += 1) {
        status = await requireJson(await fetch(`${baseUrl}/api/knowledge/status?job_id=${encodeURIComponent(item.jobId)}`, { headers: headers(item) }));
        if (['ready', 'failed', 'dead'].includes(status.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (status?.status !== 'ready') throw new Error(`${item.mode}:not_ready:${JSON.stringify(status)}`);
      item.documentId = status.document_id;
      const remote = orgIsRemote(item.orgId);
      const embedded = remote && agentFor(item.orgId)?.url === 'local:';
      const actualMode = embedded ? 'amr_embedded' : remote ? 'byod' : 'managed';
      if (actualMode !== item.mode) throw new Error(`${item.mode}:resolved_as_${actualMode}`);
      const central = {
        documents: await prisma.knowledgeDocument.count({ where: { orgId: item.orgId, id: item.documentId } }),
        segments: await prisma.knowledgeSegment.count({ where: { orgId: item.orgId, documentId: item.documentId } }),
      };
      if (remote && (central.documents || central.segments)) throw new Error(`${item.mode}:residency_violation`);
      if (!remote && (central.documents !== 1 || central.segments < 1)) throw new Error(`${item.mode}:central_missing`);
      results.push({ mode: item.mode, status: status.status, processing_version: 2, central });
    }
    await cleanup(state.items);
    console.log(JSON.stringify({ ok: true, phase, queue_resumed: true, recovered: results.length, results, cleaned: true, timestamp: new Date().toISOString() }));
  } finally {
    await queue.resume().catch(() => {});
    if (results.length !== state.items.length) await cleanup(state.items).catch(() => {});
  }
}

await queue.close();
await redis.quit();
await prisma.$disconnect();
