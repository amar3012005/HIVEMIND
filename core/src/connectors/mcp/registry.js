import fs from 'fs';
import path from 'path';

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]\n', 'utf8');
  }
}

function readJson(filePath) {
  ensureFile(filePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  ensureFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export class MCPConnectorRegistry {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  list({ user_id, org_id } = {}) {
    const endpoints = readJson(this.filePath);
    return endpoints.filter(endpoint => {
      if (user_id && endpoint.user_id !== user_id) return false;
      if (org_id && endpoint.org_id !== org_id) return false;
      return true;
    });
  }

  get(name, scope = {}) {
    return this.list(scope).find(endpoint => endpoint.name === name) || null;
  }

  upsert(endpoint) {
    if (!endpoint?.name) {
      throw new Error('endpoint.name is required');
    }

    const endpoints = readJson(this.filePath);
    const next = endpoints.filter(item => item.name !== endpoint.name);
    next.push({
      ...endpoint,
      transport: endpoint.transport || (endpoint.url ? 'streamable-http' : 'stdio'),
      args: endpoint.args || [],
      env: endpoint.env || {},
      headers: endpoint.headers || {},
      url: endpoint.url || null,
      allow_sse_fallback: endpoint.allow_sse_fallback !== false,
      updated_at: new Date().toISOString(),
    });
    writeJson(this.filePath, next);
    return this.get(endpoint.name, { user_id: endpoint.user_id, org_id: endpoint.org_id });
  }
}
