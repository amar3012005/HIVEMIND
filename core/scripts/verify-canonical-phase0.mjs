import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { materializeCanonicalKnowledge } from '../src/memory/canonical-knowledge.js';

const prisma = new PrismaClient();
const rollback = Symbol('rollback');
let receipt;

process.env.CANONICAL_KNOWLEDGE_ENABLED = 'true';

try {
  await prisma.$transaction(async (tx) => {
    const tenant = await tx.memory.findFirst({
      where: { orgId: { not: null }, deletedAt: null },
      select: { userId: true, orgId: true },
    });
    assert.ok(tenant?.userId && tenant?.orgId, 'local database needs one tenant memory fixture');
    const memoryId = crypto.randomUUID();
    await tx.memory.create({
      data: {
        id: memoryId, userId: tenant.userId, orgId: tenant.orgId,
        title: 'Uwe Egly teaching deep learning',
        content: 'He started teaching deep learning from tomorrow.',
        tags: ['phase0-canary', 'entity:uwe-egly', 'entity:deep-learning'],
        memoryType: 'event', createdAt: new Date('2026-08-30T18:23:00Z'),
      },
    });
    const input = {
      memoryId, organizationId: tenant.orgId,
      title: 'Uwe Egly teaching deep learning',
      content: 'He started teaching deep learning from tomorrow.',
      entities: [{ name: 'uwe egly', kind: 'concept' }, { name: 'deep learning', kind: 'concept' }],
      claims: [{
        subject: { name: 'deep learning', kind: 'technology' }, predicate: 'is_taught_by',
        object: { name: 'Uwe Egly', kind: 'person' }, assertion_status: 'user_asserted',
      }],
      exactQuote: 'He started teaching deep learning from tomorrow.',
      knownAt: '2026-08-30T18:23:00Z', timeZone: 'Europe/Berlin',
    };
    const adapter = { $transaction: (fn) => fn(tx) };
    const first = await materializeCanonicalKnowledge({ prisma: adapter, mode: 'write', input });
    const replay = await materializeCanonicalKnowledge({ prisma: adapter, mode: 'write', input });
    const claims = await tx.canonicalClaim.findMany({
      where: { organizationId: tenant.orgId, evidence: { some: { memoryId } } },
      include: { subject: true, objectEntity: true, predicate: true, evidence: true },
    });
    const links = await tx.memoryEntityLink.findMany({ where: { memoryId }, include: { entity: true } });
    const lineage = await tx.relationship.count({ where: { OR: [{ fromId: memoryId }, { toId: memoryId }] } });
    assert.equal(first.claimCount, 1);
    assert.equal(replay.claimCount, 1);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].subject.canonicalName, 'Uwe Egly');
    assert.equal(claims[0].subject.entityKind, 'person');
    assert.equal(claims[0].objectEntity.entityKind, 'technology');
    assert.equal(claims[0].predicate.name, 'teaches');
    assert.equal(claims[0].validFrom.toISOString().slice(0, 10), '2026-08-31');
    assert.equal(claims[0].assertionStatus, 'user_asserted');
    assert.equal(claims[0].evidence.length, 1);
    assert.equal(lineage, 0);
    assert.deepEqual(new Set(links.map((link) => link.entity.entityKind)), new Set(['person', 'technology']));
    receipt = { claim_count: claims.length, entity_count: new Set(links.map((link) => link.entityId)).size, evidence_count: claims[0].evidence.length, lineage_count: lineage };
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify({ ok: true, rolled_back: true, ...receipt }));
