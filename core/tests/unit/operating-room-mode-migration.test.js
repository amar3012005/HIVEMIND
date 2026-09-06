import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../prisma/migrations/20260906190000_operating_room_mode/migration.sql', import.meta.url),
  'utf8',
);

test('hyper room mode constraint accepts every canonical room mode', () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "hyper_rooms_room_mode_check"/);
  assert.match(
    migration,
    /CHECK \("room_mode" IN \('work', 'runtime', 'operating'\)\)/,
  );
});
