import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMigrationLedgerSafe } from '../../scripts/prisma-migrate-deploy.mjs';

test('allows a genuinely empty database to establish its first ledger', () => {
  assert.equal(assertMigrationLedgerSafe({ applicationRelations: 0, currentLedger: false, archivedLedger: false }), true);
});

test('allows an existing application schema with a current Prisma ledger', () => {
  assert.equal(assertMigrationLedgerSafe({ applicationRelations: 150, currentLedger: true, archivedLedger: false }), true);
});

test('refuses an existing schema whose migration ledger was archived', () => {
  assert.throws(
    () => assertMigrationLedgerSafe({ applicationRelations: 150, currentLedger: false, archivedLedger: true }),
    (error) => error?.code === 'MIGRATION_LEDGER_UNSAFE' && /archived legacy ledger/.test(error.message),
  );
});
