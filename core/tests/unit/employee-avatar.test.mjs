import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeAvatarPath, employeeAvatarUrl, renderEmployeeAvatarPng } from '../../src/email/employee-avatar.js';

const env = { HIVEMIND_EMAIL_AVATAR_SECRET: 'test-secret-one' };
const appearance = (over = {}) => ({
  version: 1, provider: 'humation', template: 'humation-1', asset_version: '1.0.1', seed: 'employee-uuid-seed', crop: 'avatar',
  selections: { head: 'hm1-p-000011', body: 'hm1-p-000030', bottom: 'hm1-p-000033', item: 'hm1-p-000053', glasses: 'hm1-p-000056' },
  colors: { stroke: '171717', hair: '171717', skin: 'FFFFFF', clothes: 'E9A637', bottom: '283345' },
  background: 'FFF0CC', ...over,
});
const file = path => path.split('/').pop();
const png = buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

test('a signed path renders a PNG of the saved look', async () => {
  const path = employeeAvatarPath(appearance(), env);
  assert.match(path, /^\/v1\/public\/employee-avatar\/[0-9A-Fx_-]+\.[A-Za-z0-9_-]{22}\.png$/);
  const bytes = await renderEmployeeAvatarPng(file(path), env);
  assert.ok(png(bytes));
  assert.ok(bytes.length > 1000);
  assert.deepEqual(await renderEmployeeAvatarPng(file(path), env), bytes);
});

test('the URL carries only the look and is stable per look', () => {
  const a = employeeAvatarPath(appearance(), env);
  assert.equal(employeeAvatarPath(appearance({ seed: 'another-seed' }), env), a);
  assert.notEqual(employeeAvatarPath(appearance({ colors: { ...appearance().colors, clothes: '5276BB' } }), env), a);
  assert.ok(!a.includes('employee-uuid-seed'));
  assert.equal(employeeAvatarUrl(appearance(), { env, baseUrl: 'https://api.example.test' }).startsWith('https://api.example.test/v1/public/employee-avatar/'), true);
});

test('a transparent background uses the neutral tile and still renders', async () => {
  const path = employeeAvatarPath(appearance({ background: 'transparent' }), env);
  assert.ok(path.includes('_x.'));
  assert.ok(png(await renderEmployeeAvatarPng(file(path), env)));
});

test('unsigned, tampered, re-keyed and malformed tokens are not rendered', async () => {
  const path = employeeAvatarPath(appearance(), env);
  const [look, sig] = file(path).split('.');
  const otherLook = look.replace('E9A637', '000000');
  for (const bad of [`${look}.${'A'.repeat(22)}.png`, `${otherLook}.${sig}.png`, `${look}.${sig}.svg`, `../${look}.${sig}.png`, '', `${look}.png`, `${'9'.repeat(200)}.${sig}.png`])
    assert.equal(await renderEmployeeAvatarPng(bad, env), null, bad);
  assert.equal(await renderEmployeeAvatarPng(file(path), { HIVEMIND_EMAIL_AVATAR_SECRET: 'rotated' }), null);
  assert.equal(await renderEmployeeAvatarPng(file(path), {}), null);
});

test('a signed look outside the Humation 1 manifest is rejected', async () => {
  const path = employeeAvatarPath(appearance(), env);
  const look = file(path).split('.')[0].replace(/^\d{6}/, '999999');
  const { createHmac } = await import('node:crypto');
  const key = createHmac('sha256', 'test-secret-one').update('hivemind:employee-avatar:v1').digest();
  const sig = createHmac('sha256', key).update(look).digest('base64url').slice(0, 22);
  assert.equal(await renderEmployeeAvatarPng(`${look}.${sig}.png`, env), null);
});

test('no secret or no valid saved look yields no URL', () => {
  assert.equal(employeeAvatarPath(appearance(), {}), null);
  assert.equal(employeeAvatarPath(null, env), null);
  assert.equal(employeeAvatarPath({ version: 1 }, env), null);
  assert.equal(employeeAvatarPath(appearance({ selections: { ...appearance().selections, head: 'hm1-p-999999' } }), env), null);
  assert.equal(employeeAvatarUrl(undefined, { env }), null);
});
