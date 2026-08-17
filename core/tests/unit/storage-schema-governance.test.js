import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schema = fs.readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../../prisma/migrations/20260817193000_reconcile_storage_provenance_constraints/migration.sql', import.meta.url),
  'utf8',
);

test('append-only audit identifiers are not modeled as mutable foreign-key relations', () => {
  const audit = schema.slice(schema.indexOf('model AuditLog {'), schema.indexOf('model DataExportRequest {'));
  assert.doesNotMatch(audit, /@relation/);
  assert.doesNotMatch(migration, /UPDATE\s+"hivemind"\."audit_logs"/i);
  assert.doesNotMatch(migration, /ALTER TABLE\s+"hivemind"\."audit_logs"/i);
});

test('document table provenance is constrained and orphan-cleaned before validation', () => {
  assert.match(schema, /map:\s*"document_tables_document_id_fkey"/);
  assert.match(migration, /DELETE FROM "hivemind"\."document_tables"/);
  assert.match(migration, /ADD CONSTRAINT "document_tables_document_id_fkey"/);
  assert.match(migration, /VALIDATE CONSTRAINT "document_tables_document_id_fkey"/);
});
