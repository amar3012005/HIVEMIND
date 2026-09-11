import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('fresh organizations receive a successful empty Hyper company state', () => {
  const source = fs.readFileSync(path.resolve('src/control-plane-server.js'), 'utf8');
  const route = source.indexOf("if (pathname === '/v1/hyper/company' && req.method === 'GET')");
  const noCompany = source.indexOf("if (!row?.company) return jsonResponse(res, { onboarded: false }, 200);", route);

  assert.ok(route >= 0, 'Hyper company route is present');
  assert.ok(noCompany > route, 'fresh organization state is successful rather than a 404');
});
