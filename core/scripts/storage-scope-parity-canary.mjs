#!/usr/bin/env node

// Destructive, self-cleaning production acceptance for scope parity across
// managed, embedded .amr, and self-hosted BYOD storage modes. It proves the
// public create/recall boundary for personal, organization, team, project, and
// denied project access with unique markers and a temporary non-member.

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
const nonce = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
const marker = (scope) => `SCOPE-${scope.toUpperCase()}-${nonce}`;
const ids = { memories: [], keys: [], team: null, project: null, outsider: null };
const startedAt = Date.now();

function keyMaterial() {
  const raw = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

async function createKey(user, name) {
  const material = keyMaterial();
  const row = await prisma.apiKey.create({ data: {
    userId: user,
    orgId,
    name,
    keyHash: material.hash,
    keyPrefix: material.raw.slice(0, 12),
    scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  ids.keys.push(row.id);
  return material.raw;
}

function headers(raw, user) {
  return {
    authorization: `Bearer ${raw}`,
    'x-hm-user-id': user,
    'x-hm-org-id': orgId,
    'content-type': 'application/json',
  };
}

async function decode(response) {
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function createMemory(raw, scope, extra = {}) {
  const response = await decode(await fetch(`${baseUrl}/api/memories?sync=true`, {
    method: 'POST',
    headers: headers(raw, userId),
    body: JSON.stringify({
      title: `Storage ${scope} scope canary`,
      content: `The exact ${scope} scope marker is ${marker(scope)}.`,
      memory_type: 'fact',
      scope,
      visibility: scope === 'organization' ? 'organization' : 'private',
      tags: ['storage-scope-canary', `scope-marker:${scope}`],
      smartIngest: false,
      skipProcessing: true,
      skipPredictCalibrate: true,
      skip_relationship_classification: true,
      skip_contradiction_detection: true,
      defer_entity_linking: true,
      ...extra,
    }),
  }));
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`create_${scope}_failed:${response.status}:${JSON.stringify(response.payload)}`);
  }
  const memoryId = response.payload.memory?.id || response.payload.memory?.memory_id;
  if (!memoryId) throw new Error(`create_${scope}_missing_id:${JSON.stringify(response.payload)}`);
  ids.memories.push(memoryId);
  return memoryId;
}

async function recall(raw, user, query, projectId = null) {
  return decode(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST',
    headers: headers(raw, user),
    body: JSON.stringify({ query, mode: 'quick', limit: 15, ...(projectId ? { project_id: projectId } : {}) }),
  }));
}

function containsMarker(payload, expected) {
  return (payload?.memories || []).some((row) => String(row.content || row.snippet || '').includes(expected));
}

async function awaitVisible(raw, user, scope, projectId = null) {
  let last = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    last = await recall(raw, user, marker(scope), projectId);
    if (last.status === 200 && containsMarker(last.payload, marker(scope))) return attempt;
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${scope}_not_visible:${last?.status}:${JSON.stringify(last?.payload || {})}`);
}

async function deleteMemory(raw, memoryId) {
  const result = await decode(await fetch(`${baseUrl}/api/memories/${encodeURIComponent(memoryId)}?hard=true`, {
    method: 'DELETE', headers: headers(raw, userId),
  }));
  if (result.status >= 300 || (result.payload.ok !== true && result.payload.success !== true)) {
    throw new Error(`memory_delete_failed:${memoryId}:${result.status}:${JSON.stringify(result.payload)}`);
  }
}

let ownerKey = null;
try {
  ownerKey = await createKey(userId, 'storage-scope-owner-canary');
  const outsider = await prisma.user.create({ data: {
    zitadelUserId: `storage-scope-${nonce}`,
    email: `storage-scope-${nonce}@invalid.example`,
    displayName: 'Storage Scope Canary Outsider',
  } });
  ids.outsider = outsider.id;
  await prisma.userOrganization.create({ data: {
    userId: outsider.id, orgId, role: 'member', roles: ['member'], isActive: true, joinedAt: new Date(),
  } });
  const outsiderKey = await createKey(outsider.id, 'storage-scope-outsider-canary');

  const team = await prisma.team.create({ data: {
    orgId, name: `Storage Scope Team ${nonce}`, slug: `storage-scope-team-${nonce}`.slice(0, 120), createdBy: userId,
    members: { create: { userId, role: 'lead', addedById: userId } },
  } });
  ids.team = team.id;
  const project = await prisma.project.create({ data: {
    orgId, teamId: team.id, name: `Storage Scope Project ${nonce}`,
    slug: `storage-scope-project-${nonce}`.slice(0, 120), policy: 'private', createdBy: userId,
    members: { create: { userId, role: 'owner', addedById: userId } },
  } });
  ids.project = project.id;

  await createMemory(ownerKey, 'personal');
  await createMemory(ownerKey, 'organization');
  await createMemory(ownerKey, 'team', { primary_team_id: team.id });
  await createMemory(ownerKey, 'project', { project_ids: [project.id] });

  const visibilityAttempts = {
    personal: await awaitVisible(ownerKey, userId, 'personal'),
    organization: await awaitVisible(ownerKey, userId, 'organization'),
    team: await awaitVisible(ownerKey, userId, 'team'),
    project: await awaitVisible(ownerKey, userId, 'project', project.id),
  };

  const outsiderOrg = await awaitVisible(outsiderKey, outsider.id, 'organization');
  const outsiderPersonal = await recall(outsiderKey, outsider.id, marker('personal'));
  const outsiderTeam = await recall(outsiderKey, outsider.id, marker('team'));
  const outsiderProject = await recall(outsiderKey, outsider.id, marker('project'), project.id);
  if (containsMarker(outsiderPersonal.payload, marker('personal'))) throw new Error('personal_scope_leaked_to_outsider');
  if (containsMarker(outsiderTeam.payload, marker('team'))) throw new Error('team_scope_leaked_to_nonmember');
  if (outsiderProject.status !== 403 || outsiderProject.payload?.error !== 'Project not found or access denied') {
    throw new Error(`project_scope_did_not_fail_closed:${outsiderProject.status}:${JSON.stringify(outsiderProject.payload)}`);
  }

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = await prisma.memory.count({ where: { id: { in: ids.memories }, orgId } });
  if (remote && central !== 0) throw new Error(`scope_residency_violation:${central}`);
  if (!remote && central !== 4) throw new Error(`managed_scope_memory_count:${central}`);

  for (const memoryId of [...ids.memories]) await deleteMemory(ownerKey, memoryId);
  ids.memories.length = 0;

  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    visibility_attempts: visibilityAttempts,
    outsider_organization_attempts: outsiderOrg,
    denied: { personal: true, team: true, project_status: outsiderProject.status },
    central_memories: central,
    deleted: true,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }));
} finally {
  if (ownerKey) {
    for (const memoryId of [...ids.memories]) await deleteMemory(ownerKey, memoryId).catch(() => {});
  }
  if (ids.project) await prisma.project.delete({ where: { id: ids.project } }).catch(() => {});
  if (ids.team) await prisma.team.delete({ where: { id: ids.team } }).catch(() => {});
  for (const keyId of ids.keys) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  if (ids.outsider) await prisma.user.delete({ where: { id: ids.outsider } }).catch(() => {});
  await prisma.$disconnect();
}
