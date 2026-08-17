#!/usr/bin/env node

// Destructive, self-cleaning public-API acceptance for temporal, entity, and
// graph parity across managed, embedded AMR, and self-hosted BYOD storage.

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
const topic = `temporalgraph${seed}`;
const entity = `entity${seed}`;
const oldMarker = `historical${seed}`;
const currentMarker = `current${seed}`;
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const headers = {
  authorization: `Bearer ${rawKey}`,
  'x-hm-user-id': userId,
  'x-hm-org-id': orgId,
  'content-type': 'application/json',
};
const memoryIds = [];
let keyId = null;
const startedAt = Date.now();

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

async function createMemory(content, validFrom) {
  const result = await json(await fetch(`${baseUrl}/api/memories?sync=true`, {
    method: 'POST', headers,
    body: JSON.stringify({
      title: `Storage temporal graph ${seed}`,
      content, memory_type: 'fact', scope: 'organization', visibility: 'organization',
      valid_from: validFrom, document_date: validFrom,
      tags: ['storage-temporal-graph-canary', `entity:${entity}`],
      smartIngest: false, skipProcessing: true, skipPredictCalibrate: true,
      skip_relationship_classification: true, skip_contradiction_detection: true,
      defer_entity_linking: true,
    }),
  }));
  const id = result.memory?.id || result.memory?.memory_id;
  if (!id) throw new Error(`create_missing_id:${JSON.stringify(result)}`);
  memoryIds.push(id);
  return id;
}

async function recall(query, validAt = null) {
  return json(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST', headers,
    body: JSON.stringify({ query, mode: 'quick', limit: 15, ...(validAt ? { valid_at: validAt } : {}) }),
  }));
}

function contents(payload) {
  return (payload?.memories || []).map((row) => String(row.content || row.snippet || ''));
}

async function awaitRecall(query, predicate) {
  let last;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    last = await recall(query.query, query.validAt);
    if (predicate(contents(last))) return { attempt, payload: last };
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`recall_assertion_failed:${JSON.stringify(last)}`);
}

async function cleanup() {
  for (const id of memoryIds.splice(0)) {
    await fetch(`${baseUrl}/api/memories/${encodeURIComponent(id)}?hard=true`, { method: 'DELETE', headers }).catch(() => {});
  }
}

try {
  const key = await prisma.apiKey.create({ data: {
    userId, orgId, name: 'storage-temporal-graph-parity-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  const oldId = await createMemory(`${topic} ${entity} was ${oldMarker}.`, '2024-01-01T00:00:00.000Z');
  const oldBeforeClose = await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(oldId)}`, { headers }));
  if (!String(oldBeforeClose.valid_from || oldBeforeClose.document_date || '').startsWith('2024-01-01')) {
    throw new Error(`temporal_origin_missing:${JSON.stringify(oldBeforeClose)}`);
  }
  await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(oldId)}`, {
    method: 'PUT', headers, body: JSON.stringify({ valid_to: '2025-01-01T00:00:00.000Z' }),
  }));
  const oldAfterClose = await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(oldId)}`, { headers }));
  if (!String(oldAfterClose.valid_to || '').startsWith('2025-01-01')) {
    throw new Error(`temporal_close_missing:${JSON.stringify(oldAfterClose)}`);
  }
  const currentId = await createMemory(`${topic} ${entity} is ${currentMarker}.`, '2025-01-01T00:00:00.000Z');

  const historical = await awaitRecall(
    { query: topic, validAt: '2024-06-01T00:00:00.000Z' },
    (rows) => rows.some((x) => x.includes(oldMarker)) && !rows.some((x) => x.includes(currentMarker)),
  );
  const current = await awaitRecall(
    { query: topic, validAt: '2026-01-01T00:00:00.000Z' },
    (rows) => rows.some((x) => x.includes(currentMarker)) && !rows.some((x) => x.includes(oldMarker)),
  );
  const entityRecall = await awaitRecall(
    { query: entity },
    (rows) => rows.some((x) => x.includes(currentMarker)),
  );

  const relationship = await json(await fetch(`${baseUrl}/api/relationships`, {
    method: 'POST', headers,
    body: JSON.stringify({ from_id: currentId, to_id: oldId, type: 'Updates', confidence: 1 }),
  }));
  if (!relationship.success) throw new Error(`relationship_create_failed:${JSON.stringify(relationship)}`);

  let relationshipRead;
  let traversal;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    relationshipRead = await json(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(currentId)}/relationships`, { headers }));
    traversal = await json(await fetch(`${baseUrl}/api/memories/traverse`, {
      method: 'POST', headers,
      body: JSON.stringify({ start_id: currentId, depth: 1, relationship_types: ['Updates'] }),
    }));
    const edgeSeen = [...(relationshipRead.out || []), ...(relationshipRead.in || [])]
      .some((edge) => edge.type === 'Updates');
    const peerSeen = (traversal.nodes || []).some((node) => node.id === oldId);
    if (edgeSeen && peerSeen) break;
    if (attempt === 8) throw new Error(`graph_readback_failed:${JSON.stringify({ relationshipRead, traversal })}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = await prisma.memory.count({ where: { id: { in: [oldId, currentId] }, orgId } });
  if (remote && central !== 0) throw new Error(`residency_violation:${central}`);
  if (!remote && central !== 2) throw new Error(`managed_missing:${central}`);

  await cleanup();
  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    historical_attempts: historical.attempt,
    current_attempts: current.attempt,
    entity_attempts: entityRecall.attempt,
    relationship_edges: [...(relationshipRead.out || []), ...(relationshipRead.in || [])].filter((x) => x.type === 'Updates').length,
    traversal_nodes: traversal.nodes?.length || 0,
    traversal_edges: traversal.edges?.length || 0,
    central_memories: central,
    hard_deleted: true,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }));
} finally {
  await cleanup();
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
