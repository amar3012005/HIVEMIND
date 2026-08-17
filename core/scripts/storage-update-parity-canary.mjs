#!/usr/bin/env node

// Destructive, self-cleaning acceptance for public memory update parity.
// Proves create -> update -> get -> recall-new -> no-recall-old -> hard delete
// in managed, embedded AMR, and self-hosted BYOD storage modes.

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
const seed = crypto.randomBytes(8).toString('hex');
const oldMarker = `storageold${seed}`;
const newMarker = `storagenew${seed}`;
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const headers = {
  authorization: `Bearer ${rawKey}`,
  'x-hm-user-id': userId,
  'x-hm-org-id': orgId,
  'content-type': 'application/json',
};
let keyId = null;
let memoryId = null;
const startedAt = Date.now();

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

async function recall(marker) {
  return json(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST', headers,
    body: JSON.stringify({ query: marker, mode: 'quick', limit: 15 }),
  }));
}

function sees(payload, marker) {
  return (payload?.memories || []).some((row) => String(row.content || row.snippet || '').includes(marker));
}

async function awaitRecall(marker, expected) {
  let last = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    last = await recall(marker);
    if (sees(last, marker) === expected) return attempt;
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`recall_${expected ? 'miss' : 'stale'}:${marker}:${JSON.stringify(last)}`);
}

async function hardDelete() {
  if (!memoryId) return;
  await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(memoryId)}?hard=true`, {
    method: 'DELETE', headers,
  }));
  memoryId = null;
}

try {
  const key = await prisma.apiKey.create({ data: {
    userId, orgId, name: 'storage-update-parity-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  const created = await json(await fetch(`${baseUrl}/api/memories?sync=true`, {
    method: 'POST', headers,
    body: JSON.stringify({
      title: 'Storage update parity canary',
      content: `The original update marker is ${oldMarker}.`,
      memory_type: 'fact', scope: 'organization', visibility: 'organization',
      tags: ['storage-update-canary'], smartIngest: false,
      skipProcessing: true, skipPredictCalibrate: true,
      skip_relationship_classification: true, skip_contradiction_detection: true,
      defer_entity_linking: true,
    }),
  }));
  memoryId = created.memory?.id || created.memory?.memory_id || null;
  if (!memoryId) throw new Error(`create_missing_id:${JSON.stringify(created)}`);
  const oldVisibleAttempts = await awaitRecall(oldMarker, true);

  const updated = await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(memoryId)}`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      content: `The replacement update marker is ${newMarker}.`,
      title: 'Storage update parity canary updated',
    }),
  }));
  if (!String(updated.memory?.content || '').includes(newMarker)) {
    throw new Error(`update_response_mismatch:${JSON.stringify(updated)}`);
  }
  const fetched = await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(memoryId)}`, { headers }));
  if (!String(fetched.content || '').includes(newMarker) || String(fetched.content || '').includes(oldMarker)) {
    throw new Error(`update_get_mismatch:${JSON.stringify(fetched)}`);
  }

  const newVisibleAttempts = await awaitRecall(newMarker, true);
  const oldGoneAttempts = await awaitRecall(oldMarker, false);
  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = await prisma.memory.count({ where: { id: memoryId, orgId } });
  if (remote && central !== 0) throw new Error(`residency_violation:${central}`);
  if (!remote && central !== 1) throw new Error(`managed_missing:${central}`);

  await hardDelete();
  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    old_visible_attempts: oldVisibleAttempts,
    new_visible_attempts: newVisibleAttempts,
    old_gone_attempts: oldGoneAttempts,
    central_memories: central,
    hard_deleted: true,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }));
} finally {
  await hardDelete().catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
