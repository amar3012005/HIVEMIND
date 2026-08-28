import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionTunnel } from '../../../byod/broker/cloudflare-tunnel.mjs';
import { validateEndpoint } from '../../../byod/broker/endpoint-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Control Plane delegates lifecycle writes to the dedicated broker', () => {
  const source = fs.readFileSync(path.join(root, 'core/src/control-plane-server.js'), 'utf8');
  assert.match(source, /BYOD_BROKER_URL/);
  assert.match(source, /BYOD_BROKER_INTERNAL_TOKEN/);
  assert.match(source, /pathname === '\/v1\/selfhost\/bootstrap'/);
  assert.match(source, /pathname === '\/v1\/selfhost\/canary-bootstrap'/);
  assert.match(source, /MEMORY_BOX_CANARY_ORG_ALLOWLIST/);
  assert.match(source, /const canaryEligible = process\.env\.MEMORY_BOX_CANARY_ENROLLMENT_ENABLED === 'true' && canaryAllowlist\.has\(orgId\)/);
  assert.match(source, /releaseChannel === 'canary' && !canaryEligible/);
  assert.match(source, /releaseChannel === 'stable' && canaryEligible \? \{ canary_eligible: true \} : \{\}/);
  assert.match(source, /channel: releaseChannel/);
  assert.match(source, /scopes: \['selfhost:bootstrap'\]/);
  assert.match(source, /memoryBoxBrokerRequest\(pathname, body\)/);
  assert.match(source, /memoryBoxBrokerRequest\('\/v1\/selfhost\/readiness'/);
  assert.match(source, /memory_box_automatic_setup_unavailable/);
  assert.match(source, /warning: 'Memory Box broker unavailable; showing last known state'/);
  assert.match(source, /pathname === '\/v1\/selfhost\/disenroll'/);
});

test('broker enforces expiring tenant credentials and stores only credential hashes', () => {
  const source = fs.readFileSync(path.join(root, 'byod/broker/server.mjs'), 'utf8');
  assert.match(source, /options: '-c search_path=hivemind,public'/);
  assert.match(source, /k\.expires_at IS NULL OR k\.expires_at>now\(\)/);
  assert.match(source, /o\.hosting_mode='self_host'/);
  assert.match(source, /BYOD_BROKER_INTERNAL_TOKEN required/);
  assert.match(source, /credential_hash/);
  assert.match(source, /credentialHash:\s*durableToken \? sha256\(durableToken\) : null/);
  assert.match(source, /enrollment credential already used/);
  assert.match(source, /failures >= 3 \? 'OFFLINE'/);
  assert.doesNotMatch(source, /metadata:\s*\{\s*pgUrl/);
  assert.match(source, /async function reconcileLegacyRegistry\(\)/);
  assert.match(source, /IMPORTED_UNVERIFIED/);
  assert.match(source, /last_heartbeat_at,metadata\)[\s\S]*NULL/);
  assert.match(source, /entry\.kind === 'amr-central'/);
  assert.match(source, /import \{ validateEndpoint \} from '\.\/endpoint-policy\.mjs'/);
  assert.match(source, /registered Memory Box credentials cannot change transport ownership/);
  assert.match(source, /scopes\.includes\('selfhost:connect'\)/);
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /connectorCredential: seal\(tunnel\.connectorToken\)/);
  assert.match(source, /projectionPending: true/);
  assert.match(source, /await projectConnection[\s\S]*Memory Box enrollment consumed/);
  assert.match(source, /restoreConnectionProjection/);
  assert.match(source, /if \(!isInternal\(req\) \|\| !body\.orgId\) return send\(res, 401/);
  assert.doesNotMatch(source, /await authenticate\(body\)/);
});

test('broker writes the shared registry as the same uid used by Core', () => {
  const compose = fs.readFileSync(path.join(root, 'infra/docker-compose.hetzner.yml'), 'utf8');
  assert.match(compose, /byod-broker:[\s\S]*?user: "1001:1001"[\s\S]*?MNEME_AGENT_REGISTRY_FILE: \/app\/data\/byod-agents\.json/);
});

test('endpoint policy binds managed hostnames and rejects custom HTTPS resolving privately', async () => {
  const previous = { ...process.env };
  process.env.CLOUDFLARE_MEMORY_BOX_DOMAIN = 'example.com';
  const orgId = '11111111-1111-1111-1111-111111111111';
  try {
    assert.equal(await validateEndpoint('https://mb-1111111111111111.example.com', 'cloudflare', orgId), true);
    assert.equal(await validateEndpoint('https://attacker.example.com', 'cloudflare', orgId), false);
    assert.equal(await validateEndpoint('https://public.example', 'custom_https', orgId, null,
      async () => [{ address: '93.184.216.34', family: 4 }]), true);
    assert.equal(await validateEndpoint('https://rebinding.example', 'custom_https', orgId, null,
      async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]), false);
    assert.equal(await validateEndpoint('https://127.0.0.1', 'custom_https', orgId), false);
    assert.equal(await validateEndpoint('http://box.tail123.ts.net', 'tailscale', orgId), true);
    assert.equal(await validateEndpoint('http://10.0.0.7', 'tailscale', orgId), false);
  } finally { process.env = previous; }
});

test('Cloudflare provisioning reuses tunnel and DNS then returns connector credential once', async () => {
  const previous = { ...process.env };
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
  process.env.CLOUDFLARE_MEMORY_BOX_API_TOKEN = 'token';
  process.env.CLOUDFLARE_MEMORY_BOX_ZONE_ID = 'zone';
  process.env.CLOUDFLARE_MEMORY_BOX_DOMAIN = 'example.com';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    let result = {};
    if (url.includes('cfd_tunnel?')) result = [{ id: 'tunnel', name: 'hivemind-memory-box-11111111-1111-1111-1111-111111111111' }];
    else if (url.endsWith('/dns_records?type=CNAME&name=mb-1111111111111111.example.com')) result = [{ id: 'dns', content: 'tunnel.cfargotunnel.com' }];
    else if (url.endsWith('/token')) result = 'x'.repeat(80);
    return { ok: true, async json() { return { success: true, result }; } };
  };
  try {
    const result = await provisionTunnel('11111111-1111-1111-1111-111111111111', { fetchImpl });
    assert.equal(result.agentUrl, 'https://mb-1111111111111111.example.com');
    assert.equal(result.tunnelId, 'tunnel');
    assert.equal(result.connectorToken.length, 80);
    assert.equal(calls.some(([, method]) => method === 'POST' && calls[0][0].endsWith('/cfd_tunnel')), false);
    assert.ok(calls.some(([url, method]) => url.endsWith('/configurations') && method === 'PUT'));
    assert.ok(calls.some(([url, method]) => url.endsWith('/dns_records/dns') && method === 'PUT'));
    assert.ok(calls.every(([, , body]) => !body || JSON.stringify(body).includes('connectorToken') === false));
  } finally {
    process.env = previous;
  }
});

test('Cloudflare provisioning refuses to overwrite a hostname owned by another tunnel', async () => {
  const previous = { ...process.env };
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
  process.env.CLOUDFLARE_MEMORY_BOX_API_TOKEN = 'token';
  process.env.CLOUDFLARE_MEMORY_BOX_ZONE_ID = 'zone';
  process.env.CLOUDFLARE_MEMORY_BOX_DOMAIN = 'example.com';
  const fetchImpl = async (url) => {
    let result = {};
    if (url.includes('cfd_tunnel?')) result = [{ id: 'tunnel', name: 'hivemind-memory-box-11111111-1111-1111-1111-111111111111' }];
    else if (url.includes('/dns_records?')) result = [{ id: 'dns', content: 'someone-else.cfargotunnel.com' }];
    return { ok: true, async json() { return { success: true, result }; } };
  };
  try {
    await assert.rejects(() => provisionTunnel('11111111-1111-1111-1111-111111111111', { fetchImpl }), /already owned/);
  } finally { process.env = previous; }
});
