import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Open Dot service bridge derives identity and exposes only governed read actions', () => {
  const source = fs.readFileSync(path.join(root, 'core/src/control-plane-server.js'), 'utf8');
  const start = source.indexOf("if (pathname === '/v1/service/connected-apps/tasks'");
  const end = source.indexOf("// GET /v1/company/context", start);
  assert.ok(start >= 0 && end > start, 'public read bridge route exists before company context');
  const route = source.slice(start, end);
  assert.match(route, /authenticatePersistedApiKey\(prisma, rawKey\)/);
  assert.match(route, /scopes\.includes\('mcp'\)/);
  assert.match(route, /resolveKeyAccess\(prisma, keyRecord/);
  assert.match(route, /getActiveOrganizationMembership\(prisma/);
  assert.match(route, /Caller identity fields are not accepted/);
  assert.match(route, /\['org_id', 'user_id', 'orgId', 'userId', 'organization_id', 'organizationId'\]/);
  assert.match(route, /\['connection_status', 'search', 'execute_read'\]/);
  assert.match(route, /issueGovernedReadGrant/);
  assert.match(route, /resolveGovernedReadGrant/);
  assert.match(route, /executeGovernedSessionRead/);
  assert.match(route, /user-scoped-composio-read/);
  assert.match(route, /server-derived-from-api-key/);
  assert.doesNotMatch(route, /body\.(?:org_id|user_id|orgId|userId)/);
  assert.doesNotMatch(route, /action === '(?:execute|execute_write|manage_connection|schemas)'/);
});

test('native Nango Gmail reads reuse the HyperAgents manifest and stay distinct from Composio', () => {
  const source = fs.readFileSync(path.join(root, 'core/src/control-plane-server.js'), 'utf8');
  const start = source.indexOf("if (pathname === '/v1/service/connected-apps/tasks'");
  const end = source.indexOf("// GET /v1/company/context", start);
  const route = source.slice(start, end);
  assert.match(route, /providerKey: 'gmail', status: 'active'/);
  assert.match(route, /GMAIL_MANIFEST\.tools[\s\S]*tool\.access === 'read'[\s\S]*tool\.approval === 'never'[\s\S]*allowedSurfaces\?\.includes\('hyperagents'\)/);
  assert.match(route, /providerSource: 'nango-native-gmail'/);
  assert.match(route, /sessionId: 'nango-native-gmail'/);
  assert.match(route, /runGoogleTool\(nativeTool\.legacyName/);
  assert.match(route, /Native Gmail connection is no longer active/);
  assert.match(route, /providerSource: 'composio'/);
});
