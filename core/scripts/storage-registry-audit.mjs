#!/usr/bin/env node

// Read-only production audit for the Memory Box registry. It deliberately
// emits no URLs, tokens, connection strings, names, or user data.

import fs from 'node:fs';
import { getPrismaClient } from '../src/db/prisma.js';

const registryPath = process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
const prisma = getPrismaClient();
const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const ids = Object.keys(raw);
const organizations = await prisma.organization.findMany({
  where: { id: { in: ids } },
  select: { id: true, memoryStorageMode: true, hostingMode: true },
});
const orgById = new Map(organizations.map((org) => [org.id, org]));
const failures = [];
const results = [];

for (const [orgId, entry] of Object.entries(raw)) {
  const org = orgById.get(orgId);
  const embedded = entry?.url === 'local:';
  const external = !!entry?.url && !embedded;
  const row = {
    org_id: orgId,
    registered: true,
    organization_exists: !!org,
    storage_mode: org?.memoryStorageMode || null,
    hosting_mode: org?.hostingMode || null,
    backend: embedded ? 'amr_embedded' : external ? 'byod' : 'direct',
    token_present: embedded || !!entry?.token,
    health: embedded ? 'in_process' : external ? 'pending' : 'not_applicable',
  };
  if (!org) failures.push(`${orgId}:organization_missing`);
  if (embedded && org?.memoryStorageMode !== 'amr_embedded') failures.push(`${orgId}:embedded_mode_mismatch`);
  if (embedded && org?.hostingMode !== 'managed') failures.push(`${orgId}:embedded_hosting_mismatch`);
  if (external && org?.memoryStorageMode !== 'byod_amr') failures.push(`${orgId}:byod_mode_mismatch`);
  if (external && org?.hostingMode !== 'self_host') failures.push(`${orgId}:byod_hosting_mismatch`);
  if (external && !entry?.token) failures.push(`${orgId}:token_missing`);
  if (external) {
    try {
      const response = await fetch(`${String(entry.url).replace(/\/$/, '')}/health`, {
        headers: entry.token ? { authorization: `Bearer ${entry.token}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = await response.json().catch(() => ({}));
      if (body?.status !== 'healthy' && body?.ok !== true) throw new Error('not_healthy');
      row.health = 'healthy';
    } catch (error) {
      row.health = 'failed';
      failures.push(`${orgId}:health_${error.message}`);
    }
  }
  results.push(row);
}

const mode = fs.statSync(registryPath).mode & 0o777;
if ((mode & 0o077) !== 0) failures.push(`registry_permissions:${mode.toString(8)}`);

console.log(JSON.stringify({
  ok: failures.length === 0,
  registry_mode: mode.toString(8),
  registrations: results.length,
  embedded: results.filter((row) => row.backend === 'amr_embedded').length,
  byod: results.filter((row) => row.backend === 'byod').length,
  direct: results.filter((row) => row.backend === 'direct').length,
  results,
  failures,
  timestamp: new Date().toISOString(),
}));

await prisma.$disconnect();
if (failures.length) process.exitCode = 1;
