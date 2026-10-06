/** Reuse Core's existing Prisma connection/transaction lifecycle, not a second pool.
 * SQL strings are fixed service-owned statements; values use PostgreSQL placeholders.
 * Never accept SQL or a client factory from a browser/model tool argument.
 */
export function createPrismaAppRuntimeTransactionRunner(prisma) {
  if (typeof prisma?.$transaction !== 'function') throw new TypeError('Existing Prisma client required');
  return async (_principal, execute) => prisma.$transaction(async tx => execute({
    async query(sql, parameters = []) {
      if (/^\s*SELECT\b/i.test(sql)) return { rows: await tx.$queryRawUnsafe(sql, ...parameters) };
      if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new TypeError('Unsupported App Runtime SQL statement');
      return { rows: [], rowCount: await tx.$executeRawUnsafe(sql, ...parameters) };
    },
  }), { maxWait: 5000, timeout: 20000 });
}
