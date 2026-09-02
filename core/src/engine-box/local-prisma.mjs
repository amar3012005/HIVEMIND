import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let client = null;

/**
 * Engine Box deliberately owns a direct, local Prisma client. Importing the
 * hosted client configures MNEME/BYOD split routing and can load customer-remote
 * drivers, which is invalid for an appliance whose data plane is local.
 */
export function getLocalPrismaClient(env = process.env) {
  if (client) return client;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for local Engine Box storage');
  // Keep the entrypoint importable in source-only contract tests. The signed
  // Engine Box image carries @prisma/client and fails explicitly at runtime if
  // that packaging invariant is ever broken.
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); }
  catch { throw new Error('Engine Box image is missing @prisma/client'); }
  client = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
  });
  return client;
}

export async function disconnectLocalPrisma() {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
