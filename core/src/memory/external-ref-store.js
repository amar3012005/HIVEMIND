/**
 * ExternalRefStore — first-class system-of-record ID mapping for memories.
 *
 * Indexes memories by (system, object_type, external_id) so:
 *   • Re-sync is idempotent (lookup by SF Id → existing memory → Updates op)
 *   • Cross-system entity correlation works (Slack user email == SF Contact email)
 *   • Memory cards can deep-link back to source (Salesforce / Slack / Gmail UI)
 */

export class ExternalRefStore {
  constructor({ prisma } = {}) {
    if (!prisma) throw new Error('ExternalRefStore requires prisma');
    this.prisma = prisma;
  }

  async create({ memoryId, system, objectType, externalId, externalUrl, organizationId, userId, metadata = {} }) {
    if (!memoryId || !system || !objectType || !externalId || !organizationId || !userId) {
      throw new Error('external ref requires memoryId, system, objectType, externalId, organizationId, userId');
    }
    try {
      return await this.prisma.externalRef.create({
        data: {
          memoryId,
          system,
          objectType,
          externalId: String(externalId),
          externalUrl: externalUrl || null,
          organizationId,
          userId,
          metadata,
        },
      });
    } catch (err) {
      // Unique violation = already present. Re-fetch and return.
      if (err.code === 'P2002') {
        return this.prisma.externalRef.findFirst({
          where: { organizationId, system, objectType, externalId: String(externalId), memoryId },
        });
      }
      throw err;
    }
  }

  async findByExternal({ organizationId, system, objectType, externalId }) {
    return this.prisma.externalRef.findFirst({
      where: { organizationId, system, objectType, externalId: String(externalId) },
    });
  }

  async listForMemory(memoryId) {
    return this.prisma.externalRef.findMany({ where: { memoryId } });
  }
}
