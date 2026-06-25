// Per-org Prisma router — the seam that makes .amr the sole store for ONE org while every other org
// stays on Postgres, with ZERO changes to the 182 call sites. Wraps the real Prisma client: for
// memory/relationship/knowledgeSegment calls scoped to the .amr org, route to the mneme adapter;
// everything else (other orgs, other models, raw queries, $transaction) passes straight through to
// real Prisma. Hybrid prod is byte-for-byte unchanged for the other 13 orgs.

const ROUTED_MODELS = new Set(['memory', 'relationship', 'knowledgeSegment']);

// extract the org_id an operation is scoped to, from where (incl. relation filters) or data.
function orgOf(args) {
  if (!args || typeof args !== 'object') return null;
  const fromWhere = (w) => {
    if (!w || typeof w !== 'object') return null;
    const direct = w.orgId;
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object' && typeof direct.equals === 'string') return direct.equals;
    // relation filters used by the relationship model
    for (const rel of ['fromMemory', 'toMemory', 'memory']) {
      const r = w[rel];
      if (r && typeof r.orgId === 'string') return r.orgId;
      if (r?.orgId?.equals) return r.orgId.equals;
    }
    // AND/OR nesting
    for (const k of ['AND', 'OR']) {
      const arr = Array.isArray(w[k]) ? w[k] : w[k] ? [w[k]] : [];
      for (const sub of arr) { const o = fromWhere(sub); if (o) return o; }
    }
    return null;
  };
  return fromWhere(args.where) || (typeof args.data?.orgId === 'string' ? args.data.orgId : null);
}

// Wrap one model so each method routes by org. Methods the adapter doesn't implement, or calls with
// no resolvable org (can't prove they're the .amr org), fall through to real Prisma — fail-safe.
function wrapModel(realModel, adapterModel, amrOrg) {
  return new Proxy(realModel, {
    get(target, method) {
      const real = target[method];
      if (typeof real !== 'function' || !adapterModel || typeof adapterModel[method] !== 'function') {
        return typeof real === 'function' ? real.bind(target) : real;
      }
      return (args) => {
        const org = orgOf(args);
        if (org && org === amrOrg) return adapterModel[method](args);
        return real.call(target, args);
      };
    },
  });
}

// realPrisma: the live Prisma client. adapter: makeMnemeAdapter({...}) for amrOrg. Returns a drop-in
// Prisma client the pipeline uses unchanged.
export function makeMnemePrisma(realPrisma, { amrOrg, adapter }) {
  const wrapped = {};
  for (const model of ROUTED_MODELS) {
    if (realPrisma[model] && adapter[model]) wrapped[model] = wrapModel(realPrisma[model], adapter[model], amrOrg);
  }
  return new Proxy(realPrisma, {
    get(target, prop) {
      if (typeof prop === 'string' && wrapped[prop]) return wrapped[prop];
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v; // $transaction, $queryRaw, $connect, etc. pass through
    },
  });
}

export { orgOf };
