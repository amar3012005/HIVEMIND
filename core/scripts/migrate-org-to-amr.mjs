#!/usr/bin/env node
// Explicit one-org cutover. Dry-run by default; never deletes PostgreSQL/Qdrant source data.
import fs from 'node:fs';
import Pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { AmrMemoryStore, migrateFromPostgres } from '../src/vector/mneme/amr-store.mjs';
import { PERSONAL_COLLECTION, orgContainerName } from '../src/vector/container-router.js';

const orgId = process.env.ORG_ID;
const commit = process.argv.includes('--commit');
if (!orgId) throw new Error('ORG_ID is required');

const prisma = new PrismaClient();
const pg = new Pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=hivemind,public' });
const qdrant = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const qdrantKey = process.env.QDRANT_API_KEY || '';
const dataRoot = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const dim = Number(process.env.EMBEDDING_DIMENSION || 1024);
const registryFile = process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
const isEnterprisePlan = (plan) => ['enterprise', 'managed', 'scale'].includes(String(plan).toLowerCase());

const qFetch = (path, options = {}) => fetch(`${qdrant}${path}`, {
  ...options,
  headers: { 'content-type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}), ...(options.headers || {}) },
});

try {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, plan: true, hostingMode: true, memoryStorageMode: true } });
  if (!org) throw new Error(`Organization not found: ${orgId}`);
  if (org.hostingMode === 'self_host') throw new Error('BYOD organizations are migrated on the customer data plane');
  const sourceMemories = await prisma.memory.count({ where: { orgId, deletedAt: null } });
  const sourceRelationships = await prisma.relationship.count({ where: { fromMemory: { orgId } } });
  const collection = isEnterprisePlan(org.plan) ? orgContainerName(orgId) : PERSONAL_COLLECTION;
  const amr = new AmrMemoryStore({ dataRoot, org: orgId, dim });

  console.log(JSON.stringify({ orgId, commit, sourceMemories, sourceRelationships, sourceCollection: collection, targetLive: amr.liveCount() }));
  if (!commit) process.exit(0);
  if (org.memoryStorageMode === 'amr_embedded') throw new Error('Organization already uses embedded AMR');
  if (amr.liveCount() !== 0) throw new Error('Target AMR shard is not empty; refusing to overwrite');

  const result = await migrateFromPostgres(amr, pg, qFetch, collection, orgId);
  const stats = amr.stats({});
  if (result.migrated !== sourceMemories || stats.memories !== sourceMemories || result.relationships !== sourceRelationships) {
    throw new Error(`Verification failed: source memories=${sourceMemories}, target=${stats.memories}, source relationships=${sourceRelationships}, target=${result.relationships}`);
  }

  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { /* new registry */ }
  registry[orgId] = { url: 'local:', token: '', kind: 'amr-central' };
  fs.writeFileSync(registryFile, JSON.stringify(registry), 'utf8');
  await prisma.organization.update({ where: { id: orgId }, data: { memoryStorageMode: 'amr_embedded', vectorContainer: null } });
  console.log(JSON.stringify({ ok: true, orgId, ...result, verified: stats }));
} finally {
  await pg.end();
  await prisma.$disconnect();
}
