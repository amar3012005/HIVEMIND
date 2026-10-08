import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const sql = readFileSync(new URL('../../prisma/migrations/20261008170000_runtime_attention_scoped_reads/migration.sql', import.meta.url), 'utf8');
test('attention exposes scoped security-barrier views without base-table grants', () => {
  assert.equal((sql.match(/CREATE VIEW/g) || []).length, 3);
  assert.equal((sql.match(/security_barrier=true/g) || []).length, 3);
  assert.match(sql, /REVOKE ALL ON[\s\S]*FROM PUBLIC/);
  assert.doesNotMatch(sql, /GRANT SELECT ON/);
  assert.match(sql, /current_setting\('app.hivemind_org_id',true\)/);
  assert.match(sql, /current_setting\('app.hivemind_user_id',true\)/);
  assert.match(sql, /a.role IN\('owner','admin'\)/);
  assert.match(sql, /jsonb_build_object\('source',s.config->>'source'\) AS config/);
});
test('decision memory is limited to canonical Runtime typed records', () => {
  assert.match(sql, /m.agent_slug='runtime'/);
  assert.match(sql, /m.kind IN\('user_agenda','uncertainty'\)/);
  assert.match(sql, /m.context->>'sessionId'=h.session_id/);
  assert.match(sql, /r.status='active'/);
});
test('event view preserves native connection and saved Dreamer evidence checks', () => {
  for (const clause of ['p.attention_org_id=e.org_id', 'e.occurred_at>=p.attention_enabled_at', 'ds.revision=d.revision', "'flashback'=ANY(m.tags)", "p.policy='org_visible'", 'native_source_created_at']) assert.ok(sql.includes(clause), clause);
});
