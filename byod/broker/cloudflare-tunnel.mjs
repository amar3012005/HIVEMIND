const API = 'https://api.cloudflare.com/client/v4';
const inflight = new Map();

function orgHostLabel(orgId) {
  const compact = String(orgId).replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) throw Object.assign(new Error('invalid organization identifier'), { statusCode: 400 });
  return compact.slice(0, 16);
}

function memoryBoxDomain() {
  const domain = String(process.env.CLOUDFLARE_MEMORY_BOX_DOMAIN || 'singulancelabs.com').toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw Object.assign(new Error('invalid Memory Box domain configuration'), { statusCode: 503 });
  }
  return domain;
}

export function memoryBoxHostname(orgId) {
  return `mb-${orgHostLabel(orgId)}.${memoryBoxDomain()}`;
}

/** Native HyperAgent Harness UI on the same managed tunnel as the Memory Box agent. */
export function harnessHostname(orgId) {
  return `hr-${orgHostLabel(orgId)}.${memoryBoxDomain()}`;
}

async function request(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const token = process.env.CLOUDFLARE_MEMORY_BOX_API_TOKEN;
  if (!token) throw Object.assign(new Error('automatic tunnel provisioning unavailable'), { statusCode: 503 });
  const response = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) throw Object.assign(new Error(`Cloudflare tunnel request failed (${response.status})`), { statusCode: 502 });
  return payload.result;
}

async function ensureCname(zoneId, hostname, tunnelId, { fetchImpl = fetch } = {}) {
  const records = await request(`/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`, { fetchImpl });
  const existing = Array.isArray(records) ? records[0] : null;
  const record = { type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 };
  if (existing && String(existing.content || '').toLowerCase() !== record.content.toLowerCase()) {
    throw Object.assign(new Error('Memory Box hostname is already owned by another DNS record'), { statusCode: 409 });
  }
  await request(existing ? `/zones/${zoneId}/dns_records/${existing.id}` : `/zones/${zoneId}/dns_records`, { method: existing ? 'PUT' : 'POST', body: record, fetchImpl });
}

async function provisionTunnelOnce(orgId, { fetchImpl = fetch } = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw Object.assign(new Error('automatic tunnel provisioning unavailable'), { statusCode: 503 });
  const agentHost = memoryBoxHostname(orgId);
  const harnessHost = harnessHostname(orgId);
  const domain = memoryBoxDomain();
  const name = `hivemind-memory-box-${orgId}`;
  const found = await request(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`, { fetchImpl });
  let tunnel = Array.isArray(found) ? found.find((item) => item?.name === name && !item.deleted_at) : null;
  if (!tunnel) tunnel = await request(`/accounts/${accountId}/cfd_tunnel`, { method: 'POST', body: { name, config_src: 'cloudflare' }, fetchImpl });
  const originRequest = { keepAliveConnections: 32, keepAliveTimeout: 90, connectTimeout: 10 }
  await request(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { method: 'PUT', body: { config: { ingress: [
    { hostname: agentHost, service: 'http://agent:8787', originRequest },
    { hostname: harnessHost, service: 'http://harness:3080', originRequest },
    { service: 'http_status:404' },
  ] } }, fetchImpl });
  let zoneId = process.env.CLOUDFLARE_MEMORY_BOX_ZONE_ID;
  if (!zoneId) { const zones = await request(`/zones?name=${encodeURIComponent(domain)}&status=active`, { fetchImpl }); zoneId = Array.isArray(zones) ? zones[0]?.id : null; }
  if (!zoneId) throw Object.assign(new Error('Memory Box DNS zone unavailable'), { statusCode: 503 });
  await ensureCname(zoneId, agentHost, tunnel.id, { fetchImpl });
  await ensureCname(zoneId, harnessHost, tunnel.id, { fetchImpl });
  const connectorToken = await request(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`, { fetchImpl });
  if (typeof connectorToken !== 'string' || connectorToken.length < 40) throw Object.assign(new Error('invalid tunnel connector credential'), { statusCode: 502 });
  return {
    tunnelId: tunnel.id,
    agentUrl: `https://${agentHost}`,
    harnessUrl: `https://${harnessHost}`,
    connectorToken,
  };
}

export async function provisionTunnel(orgId, options = {}) {
  const key = String(orgId);
  if (inflight.has(key)) return inflight.get(key);
  const operation = provisionTunnelOnce(orgId, options).finally(() => inflight.delete(key));
  inflight.set(key, operation);
  return operation;
}

export async function checkTunnelProvisioningReady({ fetchImpl = fetch } = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !process.env.CLOUDFLARE_MEMORY_BOX_API_TOKEN) return false;
  await request(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=1`, { fetchImpl });
  const zoneId = process.env.CLOUDFLARE_MEMORY_BOX_ZONE_ID;
  if (!zoneId) return false;
  await request(`/zones/${zoneId}/dns_records?per_page=1`, { fetchImpl });
  return true;
}
