// One-time backfill: scroll an org's existing Qdrant points (vector + payload) and build its
// .amr shard, so mneme recall is complete from the first request. Runs INSIDE hm-core (linux,
// docker network). Read-only on Qdrant. Usage:
//   docker exec -e BACKFILL_ORG=<orgId> hm-core node /app/src/vector/mneme/backfill.cjs
const http = require('http');
const { MnemeVectorStore } = require('./index.cjs');

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
  const store = new MnemeVectorStore({ dataRoot: DATA_ROOT, dim: DIM });
  let offset = null, total = 0;
  for (;;) {
    const body = { limit: 500, with_vector: true, with_payload: true };
    if (offset) body.offset = offset;
    const j = await scroll(body);
    const pts = (j.result && j.result.points) || [];
    if (pts.length) {
      await store.upsert(COLL, pts.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload || {} })));
      total += pts.length;
    }
    offset = j.result && j.result.next_page_offset;
    if (!offset || pts.length === 0) break;
  }
  // trigger one search to build the HNSW overlay, then flush.
  await store.search(COLL, new Float32Array(DIM), 1).catch(() => {});
  console.log(`backfilled ${total} points into mneme shard ${COLL} at ${DATA_ROOT}`);
})();
