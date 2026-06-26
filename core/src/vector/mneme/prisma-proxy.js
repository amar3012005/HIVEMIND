// Per-org Prisma router — THE fix for the cutover. getPrismaClient() returns this one stable proxy
// object (when the .amr org is set); every consumer — captured early, late, or in an in-process
// worker — holds the same reference. Routing is decided PER CALL by the query's orgId, so
// capture-timing is irrelevant (that was the split-brain bug: post-capture injection missed early
// captures). memory + relationship for the .amr org → the adapter; everything else (other orgs,
// other models, raw queries, $transaction, sai's segments) → real Postgres, byte-identical.
//
// The adapter is resolved through getAdapter() on every call, so the proxy can be returned
// immediately at boot while the .amr shard loads async — until it's ready, getAdapter() returns null
// and the .amr org transparently falls through to Postgres (no error, no loss; the cutover activates
// the instant the adapter is live).

// Option B — the WHOLE memory subgraph routes to .amr/sidecar for the .amr org, so it touches
// Postgres zero times. memory+relationship → .amr shard; the rest → JSON sidecars (no FK enforcement).
const ROUTED_MODELS = new Set([
  'memory', 'relationship', 'sourceMetadata', 'memoryVersion', 'memoryProject',
  'codeMemoryMetadata', 'derivationJob', 'memoryDerivation', 'memoryEvidenceLink',
  'vectorEmbedding', 'entityMention', 'memoryEntityLink', 'knowledgeDocument', 'knowledgeSegment',
]);

// extract the org_id an operation is scoped to, from where (incl. relation filters) or data.
function orgOf(args) {
  if (!args || typeof args !== 'object') return null;
  const fromWhere = (w) => {
    if (!w || typeof w !== 'object') return null;
    const direct = w.orgId;
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object' && typeof direct.equals === 'string') return direct.equals;
    for (const rel of ['fromMemory', 'toMemory', 'memory']) {
      const r = w[rel];
      if (r && typeof r.orgId === 'string') return r.orgId;
      if (r?.orgId?.equals) return r.orgId.equals;
    }
    for (const k of ['AND', 'OR']) {
      const arr = Array.isArray(w[k]) ? w[k] : w[k] ? [w[k]] : [];
      for (const sub of arr) { const o = fromWhere(sub); if (o) return o; }
    }
    return null;
  };
  return fromWhere(args.where) || (typeof args.data?.orgId === 'string' ? args.data.orgId : null);
}

// memoryId-scoped FK children (no orgId in their queries) — route by whether the memoryId belongs
// to the .amr org (present in the adapter's memory set). org-scoped models route by orgOf.
const MEMID_SCOPED = new Set([
  'sourceMetadata', 'memoryVersion', 'memoryProject', 'codeMemoryMetadata',
  'derivationJob', 'memoryDerivation', 'memoryEvidenceLink', 'vectorEmbedding',
  'entityMention', 'memoryEntityLink',
]);
const MEMID_FIELDS = ['memoryId', 'sourceMemoryId', 'targetMemoryId'];

// scan every arg payload (where/data/create/update; data may be an array) for a memory-id field.
function argSources(args) {
  const out = [];
  for (const k of ['where', 'data', 'create', 'update']) {
    const v = args?.[k];
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}
function memIdOf(args) {
  if (!args || typeof args !== 'object') return null;
  for (const src of argSources(args)) {
    if (!src || typeof src !== 'object') continue;
    for (const field of MEMID_FIELDS) {
      if (typeof src[field] === 'string') return src[field];
      if (src[field]?.equals) return src[field].equals;
    }
    for (const v of Object.values(src)) if (v && typeof v === 'object' && typeof v.memoryId === 'string') return v.memoryId;
  }
  return null;
}

// Decide if an op on `modelName` belongs to the .amr org. org-scoped → orgOf; FK-child → the
// memoryId must be in the adapter's memory set (so other orgs' children never touch this adapter).
function shouldRoute(modelName, args, amrOrg, adapter) {
  if (!adapter) return false;
  const org = orgOf(args);
  if (org) return org === amrOrg;
  if (MEMID_SCOPED.has(modelName)) {
    const mid = memIdOf(args);
    return !!(mid && adapter.memory?.byId?.has(mid));
  }
  // relationship.create/upsert carry fromId/toId (FK to memory) but no orgId — route if an endpoint
  // belongs to the .amr org's memory set. Scan where/data/create/update.
  if (modelName === 'relationship') {
    for (const src of argSources(args)) {
      const fid = src?.fromId || src?.toId;
      if (fid && adapter.memory?.byId?.has(fid)) return true;
    }
    return false;
  }
  return false; // unresolvable org on an org-scoped model → fail-safe to Postgres
}

function wrapModel(realModel, modelName, amrOrg, resolveAdapter) {
  const methodCache = new Map();
  return new Proxy(realModel, {
    get(target, method) {
      const real = target[method];
      if (typeof real !== 'function') return real;
      if (!methodCache.has(method)) {
        methodCache.set(method, (args) => {
          const adapter = resolveAdapter();
          if (adapter && shouldRoute(modelName, args, amrOrg, adapter)) {
            const am = adapter[modelName];
            if (am && typeof am[method] === 'function') return am[method](args);
          }
          return real.call(target, args);
        });
      }
      return methodCache.get(method);
    },
  });
}

// realPrisma: the live client. Pass either a fixed `adapter` or a lazy `getAdapter` (preferred for
// prod — the .amr shard loads async). Returns the stable routing proxy.
export function makeMnemePrisma(realPrisma, { amrOrg, adapter = null, getAdapter = null }) {
  const resolveAdapter = getAdapter || (() => adapter);
  const wrapped = {};
  for (const model of ROUTED_MODELS) {
    if (realPrisma[model]) wrapped[model] = wrapModel(realPrisma[model], model, amrOrg, resolveAdapter);
  }
  return new Proxy(realPrisma, {
    get(target, prop) {
      if (typeof prop === 'string' && wrapped[prop]) return wrapped[prop];
      // $transaction: HIVEMIND wraps writes in transactions and rebuilds stores with the raw `tx`
      // client (PrismaGraphStore(tx)). Without wrapping tx, every transactional write bypasses
      // routing → Postgres. So wrap the interactive-tx client too: its routed models route per-org
      // (the .amr write is applied immediately — the .amr store is not part of PG's ACID tx; that's
      // acceptable for a sole-store org where memory lives in .amr, not Postgres).
      if (prop === '$transaction') {
        return (arg, opts) => {
          if (typeof arg === 'function') {
            return target.$transaction((tx) => arg(wrapTxClient(tx, amrOrg, resolveAdapter)), opts);
          }
          return target.$transaction(arg, opts); // batch (array) form — passthrough
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v; // $queryRaw/$connect/etc. passthrough
    },
  });
}

// Wrap an interactive-transaction client so its routed models route per-org, like the top-level proxy.
function wrapTxClient(tx, amrOrg, resolveAdapter) {
  const wrapped = {};
  for (const model of ROUTED_MODELS) {
    if (tx[model]) wrapped[model] = wrapModel(tx[model], model, amrOrg, resolveAdapter);
  }
  return new Proxy(tx, {
    get(target, prop) {
      if (typeof prop === 'string' && wrapped[prop]) return wrapped[prop];
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export { orgOf };
