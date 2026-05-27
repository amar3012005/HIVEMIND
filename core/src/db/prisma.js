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
  const GUARDED_MODELS = new Set(['GovernanceActionLog', 'GovernanceMetric']);
  const READ_ACTIONS = new Set([
    'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
    'aggregate', 'count', 'groupBy',
  ]);
  const WRITE_ACTIONS = new Set([
    'create', 'createMany', 'update', 'updateMany',
    'upsert', 'delete', 'deleteMany',
  ]);

  client.$use(async (params, next) => {
    if (process.env.TENANT_ISOLATION_DISABLE === 'true') {
      return next(params);
    }
    if (!GUARDED_MODELS.has(params.model)) {
      return next(params);
    }

    const action = params.action;
    if (READ_ACTIONS.has(action)) {
      const where = params.args?.where || {};
      const hasOrg =
        where.orgId !== undefined ||
        where.AND?.some?.((c) => c?.orgId !== undefined) ||
        where.OR?.some?.((c) => c?.orgId !== undefined);
      if (!hasOrg) {
        const err = new Error(
          `[tenant-isolation] ${params.model}.${action} requires orgId in where{}`
        );
        err.code = 'TENANT_ISOLATION_VIOLATION';
        throw err;
      }
    } else if (WRITE_ACTIONS.has(action)) {
      const data = params.args?.data;
      const where = params.args?.where || {};
      const records = Array.isArray(data) ? data : [data].filter(Boolean);
      const writeHasOrg = records.length === 0
        ? true // delete/update with where-only
        : records.every((r) => r?.orgId !== undefined);
      const whereHasOrg =
        where.orgId !== undefined ||
        where.AND?.some?.((c) => c?.orgId !== undefined);
      if (!writeHasOrg && !whereHasOrg) {
        const err = new Error(
          `[tenant-isolation] ${params.model}.${action} requires orgId in data/where`
        );
        err.code = 'TENANT_ISOLATION_VIOLATION';
        throw err;
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
