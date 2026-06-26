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
// The memory subgraph — the ONLY tables that live with the tenant's data (customer PG for self-host).
// Everything else (User, Organization, ApiKey, memberships, billing, settings = "data information")
// stays in the ONE global central Postgres for ALL users, exactly like the current version.
export const ROUTED_MODELS = new Set([
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

// FK-reference fields → the adapter model they point at. A child op with no orgId routes to the
// adapter iff one of these references a record the adapter already holds (memory/segment/document) —
// so the whole ingest subgraph (children keyed by memoryId/segmentId/fromId/...) routes together,
// and other orgs' children (whose parents aren't in this adapter) never touch it.
const REF_FIELDS = {
  memoryId: 'memory', sourceMemoryId: 'memory', targetMemoryId: 'memory', relatedMemoryId: 'memory',
  fromId: 'memory', toId: 'memory',
  segmentId: 'knowledgeSegment', knowledgeSegmentId: 'knowledgeSegment',
  documentId: 'knowledgeDocument', knowledgeDocumentId: 'knowledgeDocument',
};
function refsAmrRecord(args, adapter) {
  for (const src of argSources(args)) {
    if (!src || typeof src !== 'object') continue;
    for (const [field, model] of Object.entries(REF_FIELDS)) {
      let v = src[field];
      if (v && typeof v === 'object') v = v.equals;
      if (typeof v === 'string' && adapter[model]?.byId?.has(v)) return true;
    }
    for (const v of Object.values(src)) if (v && typeof v === 'object' && typeof v.memoryId === 'string' && adapter.memory?.byId?.has(v.memoryId)) return true;
  }
  return false;
}

// Resolve WHICH adapter serves this op, or null for Postgres. org-scoped → that org's adapter if it
// is an .amr org; otherwise (FK-child / own-id, no orgId on the op) scan the live .amr adapters for
// the one already holding the referenced/own record. Multi-org aware via ctx.getAllAdapters().
function pickAdapter(modelName, args, ctx) {
  const org = orgOf(args);
  if (org) return ctx.isAmrOrg(org) ? (ctx.getAdapter(org) || null) : null;
  let ownId = args?.where?.id ?? args?.data?.id;
  if (ownId && typeof ownId === 'object') ownId = ownId.equals;
  for (const adapter of ctx.getAllAdapters()) {
    if (!adapter) continue;
    if (typeof ownId === 'string' && adapter[modelName]?.byId?.has(ownId)) return adapter;
    if (refsAmrRecord(args, adapter)) return adapter;
  }
  return null;
}

function wrapModel(realModel, modelName, ctx) {
  const methodCache = new Map();
  return new Proxy(realModel, {
    get(target, method) {
      const real = target[method];
      if (typeof real !== 'function') return real;
      if (!methodCache.has(method)) {
        methodCache.set(method, (args) => {
          const adapter = pickAdapter(modelName, args, ctx);
          const am = adapter && adapter[modelName];
          if (am && typeof am[method] === 'function') return am[method](args);
          return real.call(target, args);
        });
      }
      return methodCache.get(method);
    },
  });
}

// Normalize single-org ({amrOrg, adapter|getAdapter}) and multi-org ({isAmrOrg, getAdapter(org),
// getAllAdapters}) call styles into one routing context.
function toCtx(opts) {
  if (opts.isAmrOrg) {
    return {
      isAmrOrg: opts.isAmrOrg,
      getAdapter: opts.getAdapter || (() => null),
      getAllAdapters: opts.getAllAdapters || (() => []),
    };
  }
  const amrOrg = opts.amrOrg;
  const get = () => (opts.getAdapter ? opts.getAdapter() : opts.adapter) || null;
  return {
    isAmrOrg: (o) => o === amrOrg,
    getAdapter: () => get(),
    getAllAdapters: () => { const a = get(); return a ? [a] : []; },
  };
}

// realPrisma: the live client. opts: single-org {amrOrg, adapter|getAdapter} OR multi-org
// {isAmrOrg, getAdapter(org), getAllAdapters}. Returns the stable routing proxy.
export function makeMnemePrisma(realPrisma, opts = {}) {
  const ctx = toCtx(opts);
  const wrapped = {};
  for (const model of ROUTED_MODELS) {
    if (realPrisma[model]) wrapped[model] = wrapModel(realPrisma[model], model, ctx);
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
        return (arg, txOpts) => {
          if (typeof arg === 'function') {
            return target.$transaction((tx) => arg(wrapTxClient(tx, ctx)), txOpts);
          }
          return target.$transaction(arg, txOpts); // batch (array) form — passthrough
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v; // $queryRaw/$connect/etc. passthrough
    },
  });
}

// Wrap an interactive-transaction client so its routed models route per-org, like the top-level proxy.
function wrapTxClient(tx, ctx) {
  const wrapped = {};
  for (const model of ROUTED_MODELS) {
    if (tx[model]) wrapped[model] = wrapModel(tx[model], model, ctx);
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
