import { PrismaClient } from '@prisma/client';
import { makeMnemePrisma } from '../vector/mneme/prisma-proxy.js';

let prisma; // the real Postgres client (singleton)
// Path B: per-org .amr routing. When MNEME_PRISMA_ORG is set, getPrismaClient() returns ONE stable
// proxy that routes that org's memory/relationship to .amr per-call, everything else to Postgres.
let _mnemeProxy = null;
let _mnemeAdapter = null; // live .amr adapter (loaded async; null = not ready → falls back to PG)
let _mnemeInitStarted = false;

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

// Load the .amr adapter for MNEME_PRISMA_ORG once, async (the native binding + shard hydrate). Until
// it resolves, the proxy's getAdapter() returns null and the .amr org transparently uses Postgres.
async function ensureMnemeAdapter() {
  if (_mnemeAdapter || _mnemeInitStarted) return;
  _mnemeInitStarted = true;
  try {
    const { initMnemeStore } = await import('../vector/mneme/mneme-init.js');
    const { loadBinding, MnemeMemoryBackend, MnemeRelationshipBackend } = await import('../vector/mneme/amr-store-backend.mjs');
    const bindingPath = process.env.MNEME_BINDING || new URL('../vector/mneme/singulance-amr.linux-x64-gnu.node', import.meta.url).pathname;
    const bind = loadBinding(bindingPath);
    const backend = { openStore: (r, c, d) => bind.MnemeStore.open(r, c, d), MnemeMemoryBackend, MnemeRelationshipBackend };
    const init = initMnemeStore({
      realPrisma: buildRealClient(),
      orgId: process.env.MNEME_PRISMA_ORG,
      dim: Number(process.env.EMBEDDING_DIMENSION || 1024),
      dataRoot: process.env.MNEME_DATA_ROOT || '/app/data/mneme',
      backend,
    });
    _mnemeAdapter = init.adapter;
    globalThis.__mnemeInit = init;
    console.log('[mneme] adapter LIVE org=' + process.env.MNEME_PRISMA_ORG, JSON.stringify(init.counts));
  } catch (e) {
    _mnemeInitStarted = false; // allow retry on next call
    console.warn('[mneme] adapter init failed, org stays on Postgres:', e.message);
  }
}

export function getPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  const real = buildRealClient();
  if (!process.env.MNEME_PRISMA_ORG) return real;
  // .amr org set → memory stays in Postgres (relational hub: source_metadata, memory_project,
  // embeddings all FK to it — moving it out breaks them). We DON'T route prisma writes to .amr.
  // Instead we just open the org's .amr shard (sets globalThis.__mnemeInit) so the unified write
  // mirrors records+vectors into it and recall serves from it. Postgres = relational store of
  // truth + correct counts; .amr = the vector/graph/recall engine. Return the real client.
  ensureMnemeAdapter(); // fire-and-forget; opens the shard for mirror-write + recall
  return real;
}

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
