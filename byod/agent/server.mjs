// hm-agent — HIVEMIND BYOD data-plane. Runs on the CUSTOMER's box. Holds the org's .amr file (and,
// optionally, fronts a local Postgres). Serves the driver's data ops over an authenticated HTTP
// endpoint; our central core reaches it (via the broker tunnel) in MNEME_MODE=remote. The customer's
// memory NEVER leaves their box — only ranked results / requested rows traverse the (TLS) link.
//
// Env:
//   ORG_ID            the org this agent serves (must match the API key's org)
//   AGENT_TOKEN       bearer token the core presents (issued at enrollment)
//   AGENT_PORT        listen port (default 8787)
//   MNEME_DIM         embedding dim (default 1024)
//   MNEME_DATA_ROOT   where the .amr lives (default /data/mneme)
//   MNEME_BINDING     path to the native .node binding
//   DATABASE_URL      optional local Postgres (for /v1/hydrate — keeps content on-box)
import http from 'node:http';
import { loadBinding, MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend } from './mneme/amr-store-backend.mjs';
import { initMnemeStore } from './mneme/mneme-init.js';
import { mnemeSearch } from './mneme/mneme-recall.js';

const ORG = process.env.ORG_ID || die('ORG_ID required');
const TOKEN = process.env.AGENT_TOKEN || die('AGENT_TOKEN required');
const PORT = Number(process.env.AGENT_PORT || 8787);
const DIM = Number(process.env.MNEME_DIM || 1024);
const ROOT = process.env.MNEME_DATA_ROOT || '/data/mneme';
const BINDING = process.env.MNEME_BINDING || './mneme/singulance-amr.linux-x64-gnu.node';

function die(m) { console.error(`[hm-agent] ${m}`); process.exit(1); }

// optional local Postgres for hydrate (content stays on the customer box)
let pg = null;
if (process.env.DATABASE_URL) {
  const { default: Pg } = await import('pg').catch(() => ({ default: null }));
  if (Pg) { pg = new Pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); }
}

const bind = loadBinding(BINDING);
const backend = { openStore: (r, c, d) => bind.MnemeStore.open(r, c, d), MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend };
const realPrisma = {}; // agent uses the adapter directly — no proxy
const { store, adapter, storeMemoryUnified } = initMnemeStore({ realPrisma, orgId: ORG, dim: DIM, dataRoot: ROOT, backend });
console.log(`[hm-agent] org=${ORG} .amr open at ${ROOT}/org_${ORG} dim=${DIM} pg=${!!pg}`);

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const routes = {
  // vector recall over the local .amr — returns Qdrant-shaped hits (content in payload)
  '/v1/recall': async (b) => ({ results: mnemeSearch(store, b.vector, b.filter || {}, b.limit || 10, b.scoreThreshold ?? 0.0) || [] }),
  // unified write: memory record + vector (+ rels)
  '/v1/write': async (b) => { await storeMemoryUnified(b.record, b.vector, b.rels || []); return { ok: true }; },
  // typed edge into the local graph
  '/v1/edge': async (b) => { if (b.rel?.fromId && b.rel?.toId) await adapter.relationship.create({ data: { id: b.rel.id, fromId: b.rel.fromId, toId: b.rel.toId, type: b.rel.type, confidence: b.rel.confidence ?? 1 } }); return { ok: true }; },
  // tag resync: entity:* tags attach AFTER the initial write (deferred entity-linking). Update the
  // .amr record so recalled candidates carry their entity tags → the co-mention overlap gate works.
  '/v1/update-tags': async (b) => {
    if (b.id && Array.isArray(b.tags)) {
      try { await adapter.memory.update({ where: { id: b.id }, data: { tags: b.tags } }); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: true };
  },
  // hydrate full memory rows from the LOCAL Postgres by id (content never leaves the box uninvited)
  '/v1/hydrate': async (b) => {
    if (!pg || !Array.isArray(b.ids) || !b.ids.length) return { memories: [] };
    const { rows } = await pg.query('SELECT * FROM memories WHERE id = ANY($1::uuid[]) AND org_id = $2::uuid', [b.ids, ORG]);
    return { memories: rows };
  },
};

http.createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true, org: ORG, store: 'amr', pg: !!pg });
  if (req.method !== 'POST' || !routes[req.url]) return send(res, 404, { error: 'not found' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  if (req.headers['x-org-id'] && req.headers['x-org-id'] !== ORG) return send(res, 403, { error: 'org mismatch' });
  try { send(res, 200, await routes[req.url](await readBody(req))); }
  catch (e) { console.error(`[hm-agent] ${req.url} failed:`, e.message); send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`[hm-agent] listening :${PORT} (org ${ORG})`));
