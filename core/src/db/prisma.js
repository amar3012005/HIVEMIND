import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { configureDriver, wrapPrisma, anyMnemeOrg } from '../vector/mneme/driver.js';
import { pgUrlFor } from '../vector/mneme/remote-backend.js';
import { ROUTED_MODELS } from '../vector/mneme/prisma-proxy.js';

let prisma; // the real Postgres client (singleton)

// Full data residency (self-host): the tenant's MEMORY subgraph lives in the CUSTOMER's Postgres
// (their box, via tunnel). Everything else — User/Organization/ApiKey/memberships/billing/settings,
// the "data information" — stays in the ONE global central Postgres for ALL users, like today.
// So a self-host org gets a SPLIT client: memory models → customer PG, everything else → central.
// Managed orgs (no pgUrl) → central for everything, unchanged. runWithOrg() scopes the context;
// AsyncLocalStorage means the 35 getPrismaClient() call sites stay as-is.
const _orgCtx = new AsyncLocalStorage();
const _orgClients = new Map(); // orgId -> split client (memory→customer PG, rest→central)
// apiKeyId (optional) rides in the SAME store so the LLM chokepoint can attribute every completion to
// the org's HIVEMIND API key, not just the org. Defaulted null → existing runWithOrg(orgId, fn) callers
// (background jobs, workers, re-scoped remote-org ingest) are unchanged and record org-level (null-key)
// spend; the request path threads the real key via enterOrgContext below.
export function runWithOrg(orgId, fn, apiKeyId = null, userId = null) { return _orgCtx.run({ orgId, apiKeyId, userId }, fn); }
export function currentOrg() { return _orgCtx.getStore()?.orgId || null; }
// The org's API key id for the current async context (null for system/background/master-key calls).
export function currentApiKey() { return _orgCtx.getStore()?.apiKeyId || null; }
export function currentUser() { return _orgCtx.getStore()?.userId || null; }
// Set the org context for the REST of the current request (no callback to wrap). Used at the auth
// seam so every downstream handler + synchronous write in this request routes to the org's store.
// enterWith persists through the awaiting continuation; each HTTP request is its own async context,
// so there is no cross-request leak. A null/empty orgId is ignored (resolution falls back to central).
// apiKeyId is threaded from the resolved request principal so the LLM meter can attribute per key.
export function enterOrgContext(orgId, apiKeyId = null, userId = null) { if (orgId) _orgCtx.enterWith({ orgId, apiKeyId, userId }); }
// Bridge for CommonJS modules (ingestion pipeline) that can't statically import this ESM module.
// Set synchronously at load so CJS code reads the SAME AsyncLocalStorage instance with no import race.
globalThis.__hivemindOrgCtx = { runWithOrg, currentOrg, currentApiKey, currentUser, enterOrgContext };

// Proxy for a self-host org's split client:
//   • memory-subgraph models (ROUTED_MODELS)            → customer PG (the data plane)
//   • raw SQL + transactions ($transaction/$queryRaw/…) → CENTRAL. Under Model B (current arch) a
//     self-host org's memory data lives in its .amr (served by the driver seam), NOT the customer PG, so
//     raw memory-graph SQL is not on the remote path. Routing raw → customer (the abandoned Model-A
//     assumption) broke raw reads of CENTRAL tables (organizations cognition flags, retrieval_config,
//     OrgUsage) which have no row on the customer box. Global tables are central; raw stays central.
//   • everything else                                   → central global client.
const CUSTOMER_RAW = new Set();
function makeSplitClient(central, customer) {
  return new Proxy(central, {
    get(target, prop) {
      if (typeof prop === 'string' && ROUTED_MODELS.has(prop)) return customer[prop];
      if (typeof prop === 'string' && CUSTOMER_RAW.has(prop)) {
        const cv = customer[prop];
        return typeof cv === 'function' ? cv.bind(customer) : cv;
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
function clientForOrg(orgId) {
  const url = pgUrlFor(orgId);
  if (!url) return null; // not a full-residency org → caller uses the central client for everything
  let split = _orgClients.get(orgId);
  if (!split) {
    const customer = new PrismaClient({ datasources: { db: { url: tunedDatabaseUrl(url) } }, log: ['error'] });
    installTenantIsolationMiddleware(customer);
    split = makeSplitClient(buildRealClient(), customer); // memory→customer PG, global→central
    _orgClients.set(orgId, split);
  }
  return split;
}
// .amr routing lives entirely behind the driver seam (vector/mneme/driver.js). getPrismaClient()
// returns ONE stable proxy that routes the configured .amr orgs' memory subgraph to their .amr stores
// per-call, everything else to Postgres. ONE config value (MNEME_ORGS) drives it.
let _mnemeProxy = null;
let _driverConfigured = false;
// Honest engine state — separate from _driverConfigured, which only means
// "configuration was attempted." Never conflate "documents exist" with
// "the native engine is loaded"; getAmrEngineStatus() below is the one place
// that draws that line, so nothing downstream has to guess.
let _mnemeEngineLoaded = false;
let _mnemeLoadError = null;

/**
 * Append connection pool tuning to DATABASE_URL if not already specified.
 * Prevents pool exhaustion under 1000+ concurrent tenant load.
 *
 *   connection_limit: Postgres uses 2 * vCPUs + spindle_count. We default
 *     to 50 since core containers run on 4-8 vCPU boxes and we have ~6
 *     queries per /api/graph hit.
 *   pool_timeout: how long a query waits for a free conn before throwing
 *   socket_timeout: hard kill long-running queries (prevents wedged conns)
 */
function tunedDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', process.env.PRISMA_CONNECTION_LIMIT || '50');
    }
    if (!u.searchParams.has('pool_timeout')) {
      u.searchParams.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT || '15');
    }
    if (!u.searchParams.has('socket_timeout')) {
      u.searchParams.set('socket_timeout', process.env.PRISMA_SOCKET_TIMEOUT || '30');
    }
    return u.toString();
  } catch (_err) {
    return rawUrl; // bad URL? hand it back as-is, let Prisma error naturally
  }
}

function buildRealClient() {
  if (!prisma) {
    const tunedUrl = tunedDatabaseUrl(process.env.DATABASE_URL);
    prisma = new PrismaClient({
      datasources: { db: { url: tunedUrl } },
      log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
    });
    installTenantIsolationMiddleware(prisma);
  }
  return prisma;
}

// Inject the native binding + backends into the driver once (the driver then opens each .amr org's
// shard lazily on first use). Fire-and-forget; until configured, .amr orgs transparently use Postgres.
async function configureMnemeDriver() {
  if (_driverConfigured) return;
  _driverConfigured = true;
  try {
    // Forward-only by decision (2026-08-25): organizations.memory_storage_mode
    // can say 'amr_embedded' for an org that MNEME_ORGS doesn't cover — found
    // live for 8 existing "Personal" accounts, whose runtime routing silently
    // fell back to Postgres/hybrid despite the DB declaring .amr. Those 8 are
    // deliberately left as-is: retroactively flipping them risks a recall gap
    // (their shard never got the dual-write while mis-routed, and no
    // Postgres->shard backfill exists — shard-maintenance.js's mirror job runs
    // the opposite direction). Explicit product decision: don't touch existing
    // orgs/users, only guarantee correctness for orgs promoted from here on.
    // That forward guarantee lives at the promotion call sites themselves —
    // see registerMnemeOrg() in vector/mneme/driver.js, called from
    // billing/promotion-service.js the instant an org's storageMode is set to
    // 'amr_embedded' — so a brand-new org is routed immediately, in-process,
    // with no restart and no backfill risk (it has no prior memories).
    const { loadBinding, MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend } = await import('../vector/mneme/amr-store-backend.mjs');
    const bindingPath = process.env.MNEME_BINDING || new URL('../vector/mneme/singulance-amr.linux-x64-gnu.node', import.meta.url).pathname;
    const bind = loadBinding(bindingPath);
    configureDriver({
      backend: { openStore: (r, c, d) => bind.MnemeStore.open(r, c, d), MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend },
      realPrisma: buildRealClient(),
      dataRoot: process.env.MNEME_DATA_ROOT || '/app/data/mneme',
      dim: process.env.EMBEDDING_DIMENSION,
    });
    _mnemeEngineLoaded = true;
    _mnemeLoadError = null;
  } catch (e) {
    _driverConfigured = false; // allow retry
    _mnemeEngineLoaded = false;
    _mnemeLoadError = e.message;
    console.warn('[mneme] driver configure failed, all orgs on Postgres:', e.message);
  }
}

// Honest engine-state reporting (per product decision 2026-08-25): never let
// "some .amr data exists on disk" pass for "the engine is active." Three
// states only, no vague middle ground:
//   READY       native .amr binding loaded AND a real embedding link is
//               configured — full semantic .amr recall is actually possible.
//   DEGRADED    an .amr org is configured (MNEME_ORGS non-empty / BYOD org)
//               but the native binding failed to load, or no embedding
//               provider key is present — traffic for that org is served
//               from Postgres/hybrid instead of its shard, or shard writes
//               would work but recall can't embed the query. Not a crash;
//               just not what the org's storage mode promises.
//   UNAVAILABLE nothing is configured at all — no .amr orgs, no engine
//               attempted. Nothing is broken; .amr simply isn't in use.
function hasEmbeddingKeyConfigured() {
  return Boolean(
    process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY
    || process.env.OPENROUTER_API_KEY || process.env.MISTRAL_API_KEY,
  );
}
export function getAmrEngineStatus() {
  // Read the LIVE org set via anyMnemeOrg(), not a re-parse of process.env —
  // registerMnemeOrg() (driver.js) mutates the in-memory set the instant an
  // org is promoted, without touching MNEME_ORGS itself, so an env-string
  // check here would keep reporting UNAVAILABLE/stale for an org this same
  // process is already actively routing to .amr.
  const anyOrgConfigured = anyMnemeOrg() || _driverConfigured;
  if (!anyOrgConfigured && !_mnemeEngineLoaded) {
    return { state: 'UNAVAILABLE', engineLoaded: false, embeddingsConfigured: hasEmbeddingKeyConfigured(), reason: 'no .amr org configured' };
  }
  const embeddingsConfigured = hasEmbeddingKeyConfigured();
  if (_mnemeEngineLoaded && embeddingsConfigured) {
    return { state: 'READY', engineLoaded: true, embeddingsConfigured: true, reason: null };
  }
  return {
    state: 'DEGRADED',
    engineLoaded: _mnemeEngineLoaded,
    embeddingsConfigured,
    reason: !_mnemeEngineLoaded ? (_mnemeLoadError || 'native .amr binding not loaded') : 'no embedding provider key configured',
  };
}

// Resolve the underlying client for the CURRENT org context (per call): a self-host org → its customer
// PG split client; an .amr org → the .amr-routing proxy; else the central real client.
function _resolveClient() {
  if (!process.env.DATABASE_URL) return null;
  const ctxOrg = _orgCtx.getStore()?.orgId;
  if (ctxOrg) {
    const c = clientForOrg(ctxOrg); // full residency: memory→customer PG, global→central
    if (process.env.MNEME_DEBUG_ROUTING === '1') console.log('[resolve] ctxOrg', ctxOrg, 'split?', !!c);
    if (c) return c;
  }
  const real = buildRealClient();
  if (!anyMnemeOrg()) return real;
  if (!_mnemeProxy) { configureMnemeDriver(); _mnemeProxy = wrapPrisma(real); }
  return _mnemeProxy;
}

// getPrismaClient() returns ONE stable proxy that re-resolves the client on every property access by
// the current runWithOrg() context. So a module that captures `const db = getPrismaClient()` ONCE at
// construction STILL routes per-org per-call — the captured-client problem disappears, and wrapping an
// entry point in runWithOrg(orgId) is enough to send all its DB work to that org's store.
let _ctxProxy = null;
export function getPrismaClient() {
  if (!process.env.DATABASE_URL) return null;
  if (!_ctxProxy) {
    _ctxProxy = new Proxy({}, {
      get(_t, prop) {
        const c = _resolveClient();
        if (!c) return undefined;
        const v = c[prop];
        return typeof v === 'function' ? v.bind(c) : v;
      },
    });
  }
  return _ctxProxy;
}

// The RAW central client — bypasses ALL org routing (.amr proxy / customer-PG split). Use for tables
// that are ALWAYS central regardless of the current org context (B1): the agent registry, org-config,
// and the memory_outbox (Phase 4). enqueuePush runs INSIDE a remote org's runWithOrg() context, so
// getPrismaClient() there would return the mneme proxy and silently drop a central-only write.
export function getCentralPrismaClient() { return buildRealClient(); }

// kept for back-compat with any external caller; no longer used by the boot path.
export function setMnemeProxy(p) { _mnemeProxy = p; }

/**
 * Phase 1 tenant-isolation middleware.
 *
 * For governance_* tables, REJECT any read/write that lacks an orgId scope.
 * For GovernanceMetric the primary key already includes orgId so this is
 * mostly defensive — but it catches `findMany({})` accidents that would
 * otherwise leak cross-tenant audit rows.
 *
 * Skipped models (state is global by design):
 *  - GovernanceAgentState (single-row per agent, not per org)
 *
 * Allowed mutation in raw SQL is unchanged — middleware only covers the
 * model API. Callers using $queryRaw must scope by org_id themselves.
 */
function installTenantIsolationMiddleware(client) {
  // Strict-mode models: throw on unscoped query (audit data).
  const STRICT_MODELS = new Set(['GovernanceActionLog', 'GovernanceMetric']);
  // Warn-mode models: log unscoped query but don't throw. After 1 week of
  // clean logs, promote to STRICT_MODELS. Set MEMORY_TENANT_STRICT=true to
  // promote Memory eagerly.
  const WARN_MODELS = new Set(['Memory', 'Relationship', 'SourceMetadata']);
  const READ_ACTIONS = new Set([
    'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
    'aggregate', 'count', 'groupBy',
  ]);
  const WRITE_ACTIONS = new Set([
    'create', 'createMany', 'update', 'updateMany',
    'upsert', 'delete', 'deleteMany',
  ]);

  // Counters surfaced via /api/tenant-isolation/stats for ops review.
  const stats = global.__tenantIsolationStats || (global.__tenantIsolationStats = {
    warns: 0,
    blocks: 0,
    byModel: {},
  });

  // Tenant scope can come from orgId, userId, OR an FK that transitively
  // resolves to a tenant (SourceMetadata.memoryId → Memory.orgId,
  // Relationship.fromId/toId → Memory.orgId). Accepts unique-id lookups
  // (id, where.id) since those are tenant-irrelevant by definition.
  const TENANT_FK_KEYS = ['orgId', 'userId', 'memoryId', 'fromId', 'toId', 'id'];
  // Prisma relational filter keys — when present, scope is enforced
  // transitively (e.g. fromMemory.user_id or memory.orgId).
  const RELATIONAL_SCOPE_KEYS = ['user', 'memory', 'fromMemory', 'toMemory', 'organization', 'org'];
  const hasOrgScope = (where) => {
    if (!where || typeof where !== 'object') return false;
    for (const k of TENANT_FK_KEYS) if (where[k] !== undefined) return true;
    for (const k of RELATIONAL_SCOPE_KEYS) if (where[k] !== undefined) return true;
    if (where.user?.orgId !== undefined) return true;
    if (where.memory?.orgId !== undefined) return true;
    if (where.AND?.some?.((c) => TENANT_FK_KEYS.some((k) => c?.[k] !== undefined)
        || RELATIONAL_SCOPE_KEYS.some((k) => c?.[k] !== undefined))) return true;
    if (where.OR?.some?.((c) => TENANT_FK_KEYS.some((k) => c?.[k] !== undefined)
        || RELATIONAL_SCOPE_KEYS.some((k) => c?.[k] !== undefined))) return true;
    return false;
  };

  const dataHasOrg = (data) => {
    const records = Array.isArray(data) ? data : [data].filter(Boolean);
    if (records.length === 0) return true; // delete/update with where-only
    return records.every((r) => TENANT_FK_KEYS.some((k) => r?.[k] !== undefined));
  };

  client.$use(async (params, next) => {
    if (process.env.TENANT_ISOLATION_DISABLE === 'true') {
      return next(params);
    }
    const model = params.model;
    const action = params.action;
    const isStrict = STRICT_MODELS.has(model)
      || (WARN_MODELS.has(model) && process.env.MEMORY_TENANT_STRICT === 'true');
    const isWarn  = !isStrict && WARN_MODELS.has(model);
    if (!isStrict && !isWarn) return next(params);

    let scoped = true;
    if (READ_ACTIONS.has(action)) {
      scoped = hasOrgScope(params.args?.where);
    } else if (WRITE_ACTIONS.has(action)) {
      scoped = hasOrgScope(params.args?.where) || dataHasOrg(params.args?.data);
    }

    if (!scoped) {
      stats.byModel[model] = (stats.byModel[model] || 0) + 1;
      if (isStrict) {
        stats.blocks += 1;
        const err = new Error(`[tenant-isolation] ${model}.${action} requires orgId/userId scope`);
        err.code = 'TENANT_ISOLATION_VIOLATION';
        throw err;
      }
      // Warn mode: log once per minute per model+action to avoid spam.
      stats.warns += 1;
      const key = `${model}.${action}`;
      const lastWarn = (stats._lastWarn = stats._lastWarn || {});
      const now = Date.now();
      if (!lastWarn[key] || now - lastWarn[key] > 60_000) {
        lastWarn[key] = now;
        console.warn(`[tenant-isolation:warn] ${model}.${action} unscoped (warn-mode)`);
      }
    }
    return next(params);
  });
}

export async function ensureTenantContext(client, { user_id, org_id }) {
  if (!client || !user_id || !org_id) {
    return;
  }

  const orgSlug = `local-org-${org_id.slice(0, 8)}`;
  const userEmail = `${user_id}@local.hivemind.dev`;

  await client.organization.upsert({
    where: { id: org_id },
    update: {},
    create: {
      id: org_id,
      zitadelOrgId: `local-zitadel-org-${org_id}`,
      name: `Local Org ${org_id.slice(0, 8)}`,
      slug: orgSlug
    }
  });

  await client.user.upsert({
    where: { id: user_id },
    update: {},
    create: {
      id: user_id,
      zitadelUserId: `local-zitadel-user-${user_id}`,
      email: userEmail,
      displayName: `Local User ${user_id.slice(0, 8)}`
    }
  });

  await client.userOrganization.upsert({
    where: {
      userId_orgId: {
        userId: user_id,
        orgId: org_id
      }
    },
    update: {
      joinedAt: new Date()
    },
    create: {
      userId: user_id,
      orgId: org_id,
      role: 'owner',
      joinedAt: new Date()
    }
  });
}
