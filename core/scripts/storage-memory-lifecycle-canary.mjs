#!/usr/bin/env node

// Destructive, self-cleaning production acceptance canary for the public
// memory-only lifecycle in managed, embedded .amr, and self-hosted BYOD modes.
// Required env: STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID,
// STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA.

import crypto from 'node:crypto';
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
const marker = `MEMORY-LIFECYCLE-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const startedAt = Date.now();
let keyId = null;
let memoryId = null;

const headers = {
  authorization: `Bearer ${rawKey}`,
  'x-hm-user-id': userId,
  'x-hm-org-id': orgId,
  'content-type': 'application/json',
};

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

async function recall() {
  return responseJson(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: marker, mode: 'quick', limit: 15, debug_timing: true }),
  }));
}

async function removeMemory() {
  if (!memoryId) return null;
  const removed = await responseJson(await fetch(
    `${baseUrl}/api/memories/${encodeURIComponent(memoryId)}?hard=true`,
    { method: 'DELETE', headers },
  ));
  memoryId = null;
  return removed;
}

try {
  const key = await prisma.apiKey.create({ data: {
    userId,
    orgId,
    name: 'storage-memory-parity-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  const created = await responseJson(await fetch(`${baseUrl}/api/memories?sync=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Storage memory lifecycle canary',
      content: `The exact durable memory marker is ${marker}.`,
      memory_type: 'fact',
      visibility: 'organization',
      tags: ['storage-canary', `marker:${marker.toLowerCase()}`],
      smartIngest: false,
      skipProcessing: true,
      skipPredictCalibrate: true,
      skip_relationship_classification: true,
      skip_contradiction_detection: true,
      defer_entity_linking: true,
    }),
  }));
  memoryId = created.memory?.id || created.memory?.memory_id || null;
  if (!memoryId) throw new Error(`memory_create_missing_id:${JSON.stringify(created)}`);

  const fetched = await responseJson(await fetch(
    `${baseUrl}/api/memories/${encodeURIComponent(memoryId)}`,
    { headers },
  ));
  if (!String(fetched.content || '').includes(marker)) throw new Error('memory_get_content_mismatch');

  const recalled = await recall();
  const memories = Array.isArray(recalled.memories) ? recalled.memories : [];
  if (!memories.some((row) => String(row.content || row.snippet || '').includes(marker))) {
    throw new Error(`public_memory_recall_miss:${JSON.stringify({
      memories: memories.length,
      evidence: recalled.evidence?.length || 0,
      timing_ms: recalled.timing_ms || recalled.recall_timing_ms || null,
      trace: recalled.trace || recalled.recall_trace || null,
    })}`);
  }

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = await prisma.memory.count({ where: { id: memoryId, orgId } });
  if (remote && central !== 0) throw new Error(`memory_residency_violation:${central}`);
  if (!remote && central !== 1) throw new Error(`managed_memory_missing:${central}`);

  const removed = await removeMemory();
  if (removed?.ok !== true) throw new Error(`memory_delete_failed:${JSON.stringify(removed)}`);
  const after = await recall();
  if ((after.memories || []).some((row) => String(row.content || row.snippet || '').includes(marker))) {
    throw new Error('deleted_memory_remains_recallable');
  }

  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    recalled_memories: memories.length,
    central_memories: central,
    deleted: true,
    duration_ms: Date.now() - startedAt,
    core_revision: process.env.HIVEMIND_RELEASE_SHA || process.env.GIT_SHA || null,
    timestamp: new Date().toISOString(),
  }));
} finally {
  if (memoryId) await removeMemory().catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
