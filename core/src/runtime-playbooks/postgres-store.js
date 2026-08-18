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
        parentRunId: input.parentRunId || null,
        parentStageId: input.parentStageId || null,
        itemKey: input.itemKey || null,
        position: Number.isInteger(input.position) ? input.position : null,
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
        artifacts: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'asc' } },
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

  async renewRun(runId, orgId, owner) {
    const now = this.now();
    const result = await this.prisma.runtimePlaybookRun.updateMany({
      where: { id: runId, orgId, leaseOwner: owner },
      data: { leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
    return result.count === 1;
  }

  async updateRun(runId, orgId, data) {
    const result = await this.prisma.runtimePlaybookRun.updateMany({
      where: { id: runId, orgId },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error('runtime_run_update_conflict');
    return this.loadRun(runId, orgId);
  }

  async resumeIntervention(runId, orgId, {
    expectedCheckpointSequence,
    resumedBy = null,
    reason = '',
  } = {}) {
    const expected = Number(expectedCheckpointSequence);
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error('runtime_intervention_checkpoint_required');
    }
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.runtimePlaybookRun.findFirst({ where: { id: runId, orgId } });
      if (!found) throw new Error('runtime_run_not_found');
      if (found.status !== 'NEEDS_INTERVENTION') throw new Error('runtime_intervention_not_waiting');
      if (found.checkpointSequence !== expected) throw new Error('runtime_intervention_checkpoint_stale');
      const context = asObject(found.context);
      const repairs = { ...asObject(context.runtime_repair_attempts) };
      delete repairs[found.currentStageId];
      // A HARD_DEADLINE intervention leaves `runtime_deadlines[stage].hard_emitted_at`
      // set — without clearing it, resuming just flips status back to ACTIVE and
      // the executor's own re-entry guard (stage-executor.js, checked before any
      // work) immediately fails it again with the exact same verdict. A genuine
      // resume must restart that stage's deadline clock.
      const deadlines = { ...asObject(context.runtime_deadlines) };
      delete deadlines[found.currentStageId];
      const interventions = [
        ...asArray(context.runtime_interventions),
        {
          stage_id: found.currentStageId,
          resumed_by: resumedBy,
          reason: String(reason || '').slice(0, 1000),
          checkpoint_sequence: expected,
          resumed_at: this.now().toISOString(),
        },
      ].slice(-100);
      const updated = await tx.runtimePlaybookRun.updateMany({
        where: { id: runId, orgId, status: 'NEEDS_INTERVENTION', checkpointSequence: expected },
        data: {
          status: 'ACTIVE',
          lastVerdict: {},
          context: {
            ...context,
            runtime_repair_attempts: repairs,
            runtime_deadlines: deadlines,
            runtime_interventions: interventions,
            runtime_intervention_resume_stage: found.currentStageId,
          },
          checkpointSequence: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error('runtime_intervention_checkpoint_stale');
      await tx.runtimePlaybookCheckpoint.create({ data: {
        runId,
        orgId,
        sequence: expected + 1,
        stageId: found.currentStageId,
        phase: 'INTERVENTION_RESUMED',
        status: 'ACTIVE',
        state: { resumed_by: resumedBy, reason: String(reason || '').slice(0, 1000), previous_checkpoint_sequence: expected },
        verdict: {},
        artifactRefs: [],
      } });
    });
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

  async persistArtifacts(runId, orgId, stageId, artifacts, { replaceStageKeys = false } = {}) {
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
      if (replaceStageKeys) {
        const replacementKeys = [...new Set(normalized.map((artifact) => artifact.key))];
        await tx.runtimePlaybookArtifact.updateMany({
          where: {
            runId,
            orgId,
            stageId,
            artifactKey: { in: replacementKeys },
            artifactId: { notIn: ids },
            status: { not: 'SUPERSEDED' },
          },
          data: { status: 'SUPERSEDED' },
        });
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
