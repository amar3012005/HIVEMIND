import assert from 'node:assert/strict';

const base = (process.env.CONTROL_PLANE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.env.HM_API_KEY || 'local-master';
const userId = process.env.HM_USER_ID || '00000000-0000-4000-8000-000000000001';
const orgId = process.env.HM_ORG_ID || '00000000-0000-4000-8000-000000000002';
const headers = {
  'X-API-Key': apiKey,
  'X-HM-User-Id': userId,
  'X-HM-Org-Id': orgId,
};

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const catalog = await request('/internal/hivemind/playbooks');
assert.equal(catalog.status, 'completed');
const selected = catalog.playbooks.find((entry) => entry.id === 'global:market-research');
assert.ok(selected, 'catalog must expose the global market-research playbook');
assert.equal(selected.instructions, undefined, 'catalog must remain compact');

const loaded = await request('/internal/hivemind/playbooks/get', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: selected.id }),
});
assert.equal(loaded.status, 'completed');
assert.match(loaded.playbook.instructions, /sourced market brief/i);
assert.deepEqual(loaded.playbook.completion_contract, {
  tasks: { min_completed: 1, require_all_completed: true },
  artifacts: { min_count: 1 },
});

console.log(`company-task-playbook-canary-ok catalog=${catalog.playbooks.length} selected=${selected.id}`);
