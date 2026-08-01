import { runtimePlaybookContentHash } from './registry.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactRecord(artifact) {
  const artifactId = String(artifact?.id || '').trim();
  const artifactKey = String(artifact?.key || '').trim();
  if (!artifactId) throw new Error('runtime_artifact_id_required');
  if (!artifactKey) throw new Error('runtime_artifact_key_required');
  const normalized = {
    id: artifactId,
    key: artifactKey,
    status: String(artifact.status || 'READY').trim().toUpperCase(),
    data: asObject(artifact.data),
    source_refs: asArray(artifact.source_refs).map(String).filter(Boolean),
    external_ref: artifact.external_ref == null ? null : String(artifact.external_ref),
  };
  return { ...normalized, content_hash: runtimePlaybookContentHash(normalized) };
}

function publicArtifact(row) {
  return {
    id: row.artifactId,
    key: row.artifactKey,
    status: row.status,
    data: row.data,
    source_refs: asArray(row.sourceRefs),
    external_ref: row.externalRef,
    stage_id: row.stageId,
    created_at: row.createdAt,
  };
}

export class PostgresRuntimeStore {
  constructor({ prisma, now = () => new Date(), leaseMs = 60_000 } = {}) {
    if (!prisma) throw new Error('runtime_store_prisma_required');
    this.prisma = prisma;
    this.now = now;
    this.leaseMs = leaseMs;
  }

  async createRun(input) {
    return this.prisma.runtimePlaybookRun.upsert({
      where: { orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey } },
      create: {
        orgId: input.orgId,
        roomId: input.roomId || null,
        scopeKey: input.scopeKey || 'global',
        playbookId: input.playbookId,
        playbookVersion: input.playbookVersion,
        idempotencyKey: input.idempotencyKey,
        currentStageId: input.currentStageId,
        trigger: asObject(input.trigger),
        context: asObject(input.context),
      },
      update: {},
    });
  }

  async loadRun(runId, orgId) {
    const run = await this.prisma.runtimePlaybookRun.findFirst({
      where: { id: runId, orgId },
      include: {
        artifacts: { orderBy: { createdAt: 'asc' } },
        authorities: { where: { status: 'GRANTED', revokedAt: null } },
      },
    });
    if (!run) throw new Error('runtime_run_not_found');
    return {
      ...run,
      artifacts: run.artifacts.map(publicArtifact),
      authorityGates: run.authorities.map((authority) => authority.gate),
      authorityRecords: run.authorities,
    };
  }

  async claimRun(runId, orgId, owner) {
    const now = this.now();
    const result = await this.prisma.runtimePlaybookRun.updateMany({
      where: {
        id: runId,
        orgId,
        status: { notIn: ['COMPLETED', 'TERMINATED'] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }, { leaseOwner: owner }],
      },
      data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
    return result.count === 1;
  }

  async releaseRun(runId, orgId, owner) {
    await this.prisma.runtimePlaybookRun.updateMany({
      where: { id: runId, orgId, leaseOwner: owner },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  async updateRun(runId, orgId, data) {
    const result = await this.prisma.runtimePlaybookRun.updateMany({
      where: { id: runId, orgId },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error('runtime_run_update_conflict');
    return this.loadRun(runId, orgId);
  }

  async appendCheckpoint(runId, orgId, checkpoint) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.runtimePlaybookRun.findFirst({ where: { id: runId, orgId } });
      if (!found) throw new Error('runtime_run_not_found');
      const run = await tx.runtimePlaybookRun.update({
        where: { id: runId },
        data: { checkpointSequence: { increment: 1 }, version: { increment: 1 } },
      });
      return tx.runtimePlaybookCheckpoint.create({ data: {
        runId,
        orgId,
        sequence: run.checkpointSequence,
        stageId: checkpoint.stageId || null,
        phase: checkpoint.phase,
        status: checkpoint.status,
        state: asObject(checkpoint.state),
        verdict: asObject(checkpoint.verdict),
        artifactRefs: asArray(checkpoint.artifactRefs),
      } });
    });
  }

  async persistArtifacts(runId, orgId, stageId, artifacts) {
    const normalized = artifacts.map(artifactRecord);
    if (normalized.length === 0) return [];
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.runtimePlaybookRun.findFirst({ where: { id: runId, orgId }, select: { id: true } });
      if (!run) throw new Error('runtime_run_not_found');
      const ids = normalized.map((artifact) => artifact.id);
      const existing = await tx.runtimePlaybookArtifact.findMany({
        where: { runId, artifactId: { in: ids } },
      });
      const byId = new Map(existing.map((artifact) => [artifact.artifactId, artifact]));
      for (const artifact of normalized) {
        const previous = byId.get(artifact.id);
        if (previous && previous.contentHash !== artifact.content_hash) {
          throw new Error(`runtime_artifact_immutable:${artifact.id}`);
        }
      }
      await tx.runtimePlaybookArtifact.createMany({
        data: normalized.filter((artifact) => !byId.has(artifact.id)).map((artifact) => ({
          runId,
          orgId,
          stageId,
          artifactId: artifact.id,
          artifactKey: artifact.key,
          status: artifact.status,
          data: artifact.data,
          sourceRefs: artifact.source_refs,
          externalRef: artifact.external_ref,
          contentHash: artifact.content_hash,
        })),
        skipDuplicates: true,
      });
      const rows = await tx.runtimePlaybookArtifact.findMany({
        where: { runId, artifactId: { in: ids } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(publicArtifact);
    });
  }

  async grantAuthority(runId, orgId, gate, { grantedBy = null, payload = {} } = {}) {
    return this.prisma.runtimePlaybookAuthority.upsert({
      where: { runId_gate: { runId, gate } },
      create: { runId, orgId, gate, grantedBy, payload: asObject(payload) },
      update: { status: 'GRANTED', grantedBy, payload: asObject(payload), grantedAt: this.now(), revokedAt: null },
    });
  }
}
