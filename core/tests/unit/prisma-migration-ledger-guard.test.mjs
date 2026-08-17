import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMigrationLedgerSafe } from '../../scripts/prisma-migrate-deploy.mjs';

test('allows a genuinely empty database to establish its first ledger', () => {
  assert.equal(assertMigrationLedgerSafe({ applicationRelations: 0, currentLedger: false, archivedLedger: false }), true);
});

test('allows an existing application schema with the completed production baseline', () => {
  assert.equal(assertMigrationLedgerSafe({ applicationRelations: 150, currentLedger: true, archivedLedger: false, appliedMigrations: 160 }), true);
});

test('refuses a partially populated current ledger', () => {
  assert.throws(
    () => assertMigrationLedgerSafe({ applicationRelations: 150, currentLedger: true, archivedLedger: true, appliedMigrations: 42 }),
    (error) => error?.code === 'MIGRATION_LEDGER_PARTIAL',
  );
});

test('refuses an existing schema whose migration ledger was archived', () => {
  assert.throws(
    () => assertMigrationLedgerSafe({ applicationRelations: 150, currentLedger: false, archivedLedger: true, appliedMigrations: 0 }),
    (error) => error?.code === 'MIGRATION_LEDGER_UNSAFE' && /archived legacy ledger/.test(error.message),
  );
});
