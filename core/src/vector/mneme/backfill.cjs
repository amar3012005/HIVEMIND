// One-time backfill: scroll an org's existing Qdrant points (vector + payload) into its .amr
// shard, building the id->slot map (idmap.json) so the adapter can do upsert-by-id replace +
// delete. Runs INSIDE hm-core (linux, docker network). Read-only on Qdrant. Usage:
//   docker exec -e BACKFILL_ORG=<orgId> hm-core node /app/src/vector/mneme/backfill.cjs
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MnemeStore, sanitizeOrg } = require('./index.cjs');

const KEY = process.env.QDRANT_API_KEY;
const ORG = process.env.BACKFILL_ORG;
const COLL = 'org_' + ORG;
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';

function scroll(body) {
  const data = JSON.stringify(body);
  return new Promise((res, rej) => {
    const r = http.request(
      { host: 'hm-qdrant', port: 6333, path: `/collections/${COLL}/points/scroll`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': KEY, 'Content-Length': Buffer.byteLength(data) } },
      (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => res(JSON.parse(b))); }
    );
    r.on('error', rej); r.write(data); r.end();
  });
}

(async () => {
  if (!ORG) throw new Error('set BACKFILL_ORG');
  const store = MnemeStore.open(DATA_ROOT, sanitizeOrg(COLL), DIM);
  const idMap = {};
  let offset = null, total = 0;
  for (;;) {
    const body = { limit: 500, with_vector: true, with_payload: true };
    if (offset) body.offset = offset;
    const j = await scroll(body);
    const pts = (j.result && j.result.points) || [];
    for (const p of pts) {
      const id = String(p.id);
      const validFrom = Number(p.payload && p.payload.event_time_ns) || 0;
      const slot = store.insert(JSON.stringify({ id, payload: p.payload || {} }), Float32Array.from(p.vector), validFrom);
      idMap[id] = slot;
      total++;
    }
    offset = j.result && j.result.next_page_offset;
    if (!offset || pts.length === 0) break;
  }
  store.enableHnsw();
  store.flush();
  const dir = path.join(DATA_ROOT, sanitizeOrg(COLL));
  fs.writeFileSync(path.join(dir, 'idmap.json'), JSON.stringify(idMap));
  console.log(`backfilled ${total} points into ${COLL} at ${DATA_ROOT} (idmap: ${Object.keys(idMap).length} ids)`);
})();
