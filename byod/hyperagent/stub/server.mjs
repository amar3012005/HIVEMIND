/** Local HyperAgent box stub: health, capabilities, org filesystem. No UI. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const ORG_ID = String(process.env.ORG_ID || '').trim();
const FS_ROOT = String(process.env.HYPERAGENT_FS_ROOT || '/data/fs');
const BOX_TOKEN = String(process.env.BOX_TOKEN || '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!BOX_TOKEN || BOX_TOKEN.startsWith('replace-')) return true;
  const header = String(req.headers.authorization || '');
  const bearer = header.replace(/^Bearer\s+/i, '');
  if (bearer.length !== BOX_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(bearer), Buffer.from(BOX_TOKEN));
}

function orgRoot() {
  if (!UUID.test(ORG_ID)) throw new Error('ORG_ID must be a UUID');
  return path.join(FS_ROOT, 'org', ORG_ID);
}

function ensureLayout() {
  const root = orgRoot();
  for (const rel of ['users', 'rooms', 'shared']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true, mode: 0o750 });
  }
}

function listTree(dir, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.map((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return { name: entry.name, type: 'dir', children: listTree(full, depth + 1) };
    const stat = fs.statSync(full);
    return { name: entry.name, type: 'file', bytes: stat.size };
  });
}

ensureLayout();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'hm-byod-hyperagent', org_id: ORG_ID });
  }
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
    return json(res, 200, {
      hyperagent: true,
      filesystem: true,
      harness_profile: 'hivemind-hyperagent',
      k3s: false,
      jobs: 'inbox-empty-until-control-plane',
      org_id: ORG_ID,
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/fs/tree') {
    return json(res, 200, { org_id: ORG_ID, tree: listTree(orgRoot()) });
  }
  if (req.method === 'GET' && url.pathname === '/v1/jobs/inbox') {
    return json(res, 200, { jobs: [] });
  }
  if (req.method === 'POST' && url.pathname === '/v1/jobs/claim') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ event: 'hyperagent_stub_listen', port: PORT, org_id: ORG_ID }) + '\n');
});
