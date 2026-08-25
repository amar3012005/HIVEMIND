import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogger } from '../../src/audit/audit-logger.js';

const uuid = '11111111-1111-4111-8111-111111111111';

test('audit UUID columns are normalized while non-UUID identifiers are retained in metadata', async () => {
  let data;
  const prisma = {
    auditLog: { create: async ({ data: value }) => { data = value; return { id: uuid }; } },
    $transaction: async () => {},
  };
  const audit = new AuditLogger(prisma);
  await audit.log({
    userId: ` ${uuid} `,
    organizationId: 'remote-org:acme', resourceId: 'amr://memory/42',
    actorApiKeyId: 'key_live_123', sessionId: 'browser-session',
    eventType: 'memory.read', action: 'read', metadata: { request_source: 'test' },
  });

  assert.equal(data.userId, uuid);
  assert.equal(data.organizationId, null);
  assert.equal(data.resourceId, null);
  assert.equal(data.actorApiKeyId, null);
  assert.equal(data.sessionId, null);
  assert.deepEqual(data.metadata, {
    request_source: 'test',
    audit_raw_identifiers: {
      organizationId: 'remote-org:acme', resourceId: 'amr://memory/42',
      actorApiKeyId: 'key_live_123', sessionId: 'browser-session',
    },
  });
});

test('audit write failures are reported once per distinct error', async () => {
  const warnings = [];
  const audit = new AuditLogger({ auditLog: { create: async () => { throw new Error('database unavailable'); } } }, {
    logger: { warn: (...args) => warnings.push(args) },
  });
  await audit.log({ eventType: 'test', action: 'read' });
  await audit.log({ eventType: 'test', action: 'read' });
  assert.equal(warnings.length, 1);
});
