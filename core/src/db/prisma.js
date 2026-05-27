import { PrismaClient } from '@prisma/client';

let prisma;

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

export function getPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

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
  const hasOrgScope = (where) => {
    if (!where || typeof where !== 'object') return false;
    for (const k of TENANT_FK_KEYS) if (where[k] !== undefined) return true;
    if (where.user?.orgId !== undefined) return true;
    if (where.memory?.orgId !== undefined) return true;
    if (where.AND?.some?.((c) => TENANT_FK_KEYS.some((k) => c?.[k] !== undefined))) return true;
    if (where.OR?.some?.((c) => TENANT_FK_KEYS.some((k) => c?.[k] !== undefined))) return true;
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
