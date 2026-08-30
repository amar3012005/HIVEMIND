import crypto from 'node:crypto';
import { createWorkspaceNotification } from '../workspace/notifications.js';

export const DREAM_PIPELINE_VERSION = 2;
export const DREAM_STAGES = Object.freeze([
  'admit', 'select-subjects', 'walk-graph', 'generate-candidates',
  'verify-candidates', 'persist-cognition', 'project-derivations',
  'update-profiles', 'embed', 'reconcile', 'publish', 'finalize',
]);

const STAGE_PROGRESS = Object.freeze(Object.fromEntries(DREAM_STAGES.map((v, i) => [v, Math.round((i / (DREAM_STAGES.length - 1)) * 100)])));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'error', 'cancelled']);
const ALLOWED_TRIGGERS = new Set(['dirty', 'idle', 'scheduled', 'manual', 'recovery']);
const HIGH_RISK_TYPES = new Set(['risk', 'policy', 'contradiction']);
const SUBJECT_TYPES = new Set(['user', 'organization', 'project', 'goal', 'team', 'person', 'customer', 'product', 'system', 'service', 'location', 'policy', 'custom']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

export function mostRestrictiveVisibility(memories) {
  const levels = { private: 3, project: 2, team: 2, organization: 1, public: 0 };
  return memories.reduce((chosen, row) => (levels[row.visibility] ?? 3) > (levels[chosen] ?? 0) ? row.visibility : chosen, 'public');
}

export function validateAdmission(input) {
  if (!UUID.test(String(input?.org_id || ''))) throw Object.assign(new Error('invalid_org_id'), { retryable: false });
  if (!ALLOWED_TRIGGERS.has(input?.trigger)) throw Object.assign(new Error('invalid_trigger'), { retryable: false });
  if (!input?.trigger_key || String(input.trigger_key).length > 160) throw Object.assign(new Error('invalid_trigger_key'), { retryable: false });
  if (!input?.workflow_instance_id || String(input.workflow_instance_id).length > 100) throw Object.assign(new Error('invalid_workflow_instance_id'), { retryable: false });
}

export class DurableDreamLifecycle {
  constructor({ prisma, cognitionLoop, logger = console }) {
    this.prisma = prisma;
    this.cognitionLoop = cognitionLoop;
    this.logger = logger;
  }

  async listEligible({ limit = 100 } = {}) {
    const rows = await this.prisma.organization.findMany({
      where: { cognitionOrgEnabled: true },
      select: { id: true, cognitionScheduleMode: true, cognitionWindowStartHour: true, cognitionWindowEndHour: true, cognitionScheduleTz: true },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
    const now = new Date();
    const eligible = [];
    for (const row of rows) {
      if (row.cognitionScheduleMode === 'continuous') continue;
      let localHour = now.getUTCHours();
      let localDate = now.toISOString().slice(0, 10);
      try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: row.cognitionScheduleTz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
        const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
        localHour = Number(map.hour);
        localDate = `${map.year}-${map.month}-${map.day}`;
      } catch { /* invalid timezone safely uses UTC */ }
      const start = Number.isInteger(row.cognitionWindowStartHour) ? row.cognitionWindowStartHour : 0;
      const end = Number.isInteger(row.cognitionWindowEndHour) ? row.cognitionWindowEndHour : start + 1;
      const due = row.cognitionScheduleMode === 'interval'
        ? (start <= end ? localHour >= start && localHour < end : localHour >= start || localHour < end)
        : localHour === start;
      if (!due) continue;
      eligible.push({ org_id: row.id, trigger: 'scheduled', trigger_key: `scheduled:${localDate}`, requested_at: now.toISOString(), pipeline_version: DREAM_PIPELINE_VERSION });
    }
    return eligible;
  }

  async admit(input) {
    validateAdmission(input);
    const org = await this.prisma.organization.findUnique({
      where: { id: input.org_id },
      select: {
        id: true, cognitionOrgEnabled: true, cognitionPersonalEnabled: true,
        cognitionCrossProjectEnabled: true, profileAutomaintainEnabled: true,
        subscriptionStatus: true, memoryStorageMode: true,
      },
    });
    if (!org || !org.cognitionOrgEnabled) throw Object.assign(new Error('cognition_disabled'), { retryable: false });
    const scopeSnapshot = {
      personal_opt_in_required: true,
      personal_enabled: org.cognitionPersonalEnabled,
      cross_project_enabled: org.cognitionCrossProjectEnabled,
      profile_automaintain_enabled: org.profileAutomaintainEnabled,
      storage_mode: org.memoryStorageMode,
    };
    const create = {
      orgId: org.id, trigger: input.trigger, triggerKey: input.trigger_key,
      workflowInstanceId: input.workflow_instance_id, pipelineVersion: DREAM_PIPELINE_VERSION,
      status: 'running', currentStage: 'admit', progress: 0, heartbeatAt: new Date(),
      latchedFlags: { ...(input.flags || {}), _evaluation: input.flag_details || {} }, scopeSnapshot,
      modelRoute: input.model_route || process.env.CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE || null,
      embeddingModel: input.embedding_model || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
      triggeredBy: UUID.test(String(input.triggered_by || '')) ? input.triggered_by : null,
      lookbackHours: Math.min(Math.max(Number(input.lookback_hours) || 24, 1), 24 * 30),
    };
    let run = await this.prisma.cognitionRun.findUnique({ where: { orgId_triggerKey_pipelineVersion: { orgId: org.id, triggerKey: input.trigger_key, pipelineVersion: DREAM_PIPELINE_VERSION } } });
    if (!run) run = await this.prisma.cognitionRun.findFirst({ where: { orgId: org.id, pipelineVersion: DREAM_PIPELINE_VERSION, status: 'running' }, orderBy: { startedAt: 'asc' } });
    if (!run) {
      try { run = await this.prisma.cognitionRun.create({ data: create }); }
      catch (error) {
        // The partial unique index is the cross-replica coalescing authority.
        run = await this.prisma.cognitionRun.findFirst({ where: { orgId: org.id, pipelineVersion: DREAM_PIPELINE_VERSION, status: 'running' }, orderBy: { startedAt: 'asc' } });
        if (!run) throw error;
      }
    }
    return this._receipt(run);
  }

  async executeStage({ run_id: runId, stage, shard_key: shardKey = 'root', input = {} }) {
    if (!UUID.test(String(runId || ''))) throw Object.assign(new Error('invalid_run_id'), { retryable: false });
    if (!DREAM_STAGES.includes(stage)) throw Object.assign(new Error('invalid_stage'), { retryable: false });
    const run = await this.prisma.cognitionRun.findUnique({ where: { id: runId } });
    if (!run) throw Object.assign(new Error('run_not_found'), { retryable: false });
    if (run.cancelledAt || run.status === 'cancelled') throw Object.assign(new Error('run_cancelled'), { retryable: false });
    // A terminal authoritative run is immutable. In particular, a delayed
    // Workflow retry must never reach finalize and convert an error/cancelled
    // run back to completed.
    if (TERMINAL.has(run.status)) return this._receipt(run);

    const inputDigest = digest({ run_id: runId, stage, shard_key: shardKey, input, pipeline_version: run.pipelineVersion });
    const existing = await this.prisma.cognitionStep.findUnique({
      where: { runId_pipelineVersion_stageKey_shardKey: { runId, pipelineVersion: run.pipelineVersion, stageKey: stage, shardKey } },
    });
    if (existing?.status === 'completed') return existing.outputReceipt;
    if (existing?.status === 'running' && existing.leaseExpiresAt > new Date()) throw Object.assign(new Error('stage_lease_busy'), { retryable: true });

    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
    if (existing) {
      const claimed = await this.prisma.cognitionStep.updateMany({
        where: { id: existing.id, status: { not: 'completed' }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
        data: { status: 'running', attempt: { increment: 1 }, inputDigest, startedAt: existing.startedAt || new Date(), leaseExpiresAt },
      });
      if (claimed.count !== 1) throw Object.assign(new Error('stage_lease_busy'), { retryable: true });
    } else {
      try {
        await this.prisma.cognitionStep.create({ data: { runId, pipelineVersion: run.pipelineVersion, stageKey: stage, shardKey, status: 'running', attempt: 1, inputDigest, startedAt: new Date(), leaseExpiresAt } });
      } catch {
        throw Object.assign(new Error('stage_lease_busy'), { retryable: true });
      }
    }
    await this.prisma.cognitionRun.update({ where: { id: runId }, data: { currentStage: stage, progress: STAGE_PROGRESS[stage], heartbeatAt: new Date() } });

    try {
      const output = await this[`_${stage.replaceAll('-', '_')}`](run, input);
      await this.prisma.cognitionStep.update({
        where: { runId_pipelineVersion_stageKey_shardKey: { runId, pipelineVersion: run.pipelineVersion, stageKey: stage, shardKey } },
        data: { status: 'completed', outputReceipt: output, counters: output.counts || {}, completedAt: new Date(), leaseExpiresAt: null },
      });
      return output;
    } catch (error) {
      await this.prisma.cognitionStep.update({
        where: { runId_pipelineVersion_stageKey_shardKey: { runId, pipelineVersion: run.pipelineVersion, stageKey: stage, shardKey } },
        data: { status: 'failed', error: { message: error.message, retryable: error.retryable !== false }, leaseExpiresAt: null },
      }).catch(() => null);
      await this.prisma.cognitionRun.update({ where: { id: runId }, data: { error: error.message, heartbeatAt: new Date() } }).catch(() => null);
      throw error;
    }
  }

  async failRun(input) {
    const runId = String(input?.run_id || '');
    if (!UUID.test(runId)) throw Object.assign(new Error('invalid_run_id'), { retryable: false });
    const run = await this.prisma.cognitionRun.findUnique({ where: { id: runId } });
    if (!run) throw Object.assign(new Error('run_not_found'), { retryable: false });
    if (TERMINAL.has(run.status)) return this._receipt(run);
    const failedStage = String(input?.failed_stage || run.currentStage || 'unknown').slice(0, 48);
    const failureCode = String(input?.failure_code || 'workflow_retry_exhausted').replace(/[^a-z0-9_-]/gi, '_').slice(0, 160);
    const finishedAt = new Date();
    const updated = await this.prisma.cognitionRun.update({
      where: { id: run.id },
      data: {
        status: 'error', currentStage: failedStage, recoveryStatus: 'retry_exhausted',
        terminalReason: failureCode, heartbeatAt: finishedAt, finishedAt,
        runMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
      },
    });
    return this._receipt(updated);
  }

  async _admit(run) { return this._receipt(run); }

  async _select_subjects(run) {
    const org = await this.prisma.organization.findUnique({ where: { id: run.orgId }, select: { id: true, name: true } });
    const [members, projects, teams, entities] = await Promise.all([
      this.prisma.userOrganization.findMany({ where: { orgId: run.orgId, isActive: true }, select: { userId: true } }),
      this.prisma.project.findMany({ where: { orgId: run.orgId, status: 'active', selfEvolveEnabled: true }, select: { id: true, name: true, updatedAt: true } }),
      this.prisma.team.findMany({ where: { orgId: run.orgId, archivedAt: null }, select: { id: true, name: true, updatedAt: true } }),
      this.prisma.entity.findMany({ where: { orgId: run.orgId, isActive: true, OR: [{ mentionCount: { gte: Number(process.env.DREAM_SUBJECT_MIN_MENTIONS || 2) } }, { metadata: { path: ['dream_pinned'], equals: true } }] }, orderBy: [{ mentionCount: 'desc' }, { lastSeenAt: 'desc' }], take: Number(process.env.DREAM_SUBJECT_MAX || 100), select: { id: true, entityType: true, canonicalName: true, aliases: true, mentionCount: true, lastSeenAt: true, metadata: true } }),
    ]);
    const subjects = [
      ...(org ? [{ type: 'organization', key: org.id, name: org.name || 'Organization', aliases: [], importance: 1, activity: new Date() }] : []),
      ...members.map((m) => ({ type: 'user', key: m.userId, name: `User ${m.userId.slice(0, 8)}`, aliases: [], importance: 0.8, activity: new Date() })),
      ...projects.map((p) => ({ type: 'project', key: p.id, name: p.name, aliases: [], importance: 0.85, activity: p.updatedAt })),
      ...teams.map((t) => ({ type: 'team', key: t.id, name: t.name, aliases: [], importance: 0.7, activity: t.updatedAt })),
      ...entities.map((e) => ({ type: SUBJECT_TYPES.has(e.entityType) ? e.entityType : 'custom', key: e.id, name: e.canonicalName, aliases: e.aliases, importance: Math.min(1, 0.4 + e.mentionCount / 20), activity: e.lastSeenAt, pinned: e.metadata?.dream_pinned === true })),
    ];
    for (const s of subjects) {
      await this.prisma.subjectProfile.upsert({
        where: { orgId_subjectType_subjectKey: { orgId: run.orgId, subjectType: s.type, subjectKey: String(s.key) } },
        create: { orgId: run.orgId, subjectType: s.type, subjectKey: String(s.key), displayName: s.name, aliases: s.aliases || [], importance: s.importance, pinned: s.pinned || false, lastActivityAt: s.activity },
        update: { displayName: s.name, aliases: s.aliases || [], importance: s.importance, pinned: s.pinned || false, lastActivityAt: s.activity, active: true },
      });
    }
    return { run_id: run.id, subject_count: subjects.length, counts: { subjects: subjects.length } };
  }

  async _walk_graph(run) {
    const profiles = await this.prisma.subjectProfile.findMany({ where: { orgId: run.orgId, active: true }, orderBy: [{ pinned: 'desc' }, { importance: 'desc' }], take: Number(process.env.DREAM_SUBJECTS_PER_RUN || 40) });
    let eligible = 0;
    const bundles = [];
    for (const profile of profiles) {
      const keys = [profile.displayName, ...(profile.aliases || [])].map(slug).filter(Boolean);
      const tags = keys.flatMap((k) => [`entity:${k}`, `person:${k}`, `organization:${k}`, `project:${k}`, `topic:${k}`]);
      const where = { orgId: run.orgId, isLatest: true, deletedAt: null, cognitiveLayerRole: null };
      if (profile.subjectType === 'user' && UUID.test(profile.subjectKey)) where.userId = profile.subjectKey;
      else if (profile.subjectType === 'project') where.OR = [{ project: profile.subjectKey }, ...(UUID.test(profile.subjectKey) ? [{ projectId: profile.subjectKey }] : []), { tags: { hasSome: tags } }];
      else if (profile.subjectType !== 'organization') {
        // Entity night-walk: begin at canonical entity mentions, then traverse
        // bounded verified memory edges. This never crosses the tenant filter.
        let walkedIds = [];
        if (UUID.test(profile.subjectKey) && run.latchedFlags?.dream_entity_walk_v1) {
          const mentions = await this.prisma.entityMention.findMany({ where: { entityId: profile.subjectKey, memoryId: { not: null } }, select: { memoryId: true }, take: 100 });
          const roots = [...new Set(mentions.map((m) => m.memoryId).filter(Boolean))];
          const allowedTypes = ['Updates', 'Extends', 'Contradicts', 'DependsOn', 'GroundedIn'];
          const edges = roots.length ? await this.prisma.relationship.findMany({ where: { type: { in: allowedTypes }, OR: [{ fromId: { in: roots } }, { toId: { in: roots } }] }, select: { fromId: true, toId: true }, take: 300 }) : [];
          walkedIds = [...new Set([...roots, ...edges.flatMap((e) => [e.fromId, e.toId])])].slice(0, 200);
        }
        where.OR = [{ tags: { hasSome: tags } }, ...(walkedIds.length ? [{ id: { in: walkedIds } }] : [])];
      }
      const count = await this.prisma.memory.count({ where });
      if (count >= 2) {
        eligible += 1;
        const refs = await this.prisma.memory.findMany({ where, select: { id: true }, orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }], take: 24 });
        bundles.push({ subject_profile_id: profile.id, memory_ids: refs.map((m) => m.id) });
      }
    }
    return { run_id: run.id, walked_subjects: profiles.length, eligible_subjects: eligible, bundles, counts: { walked: profiles.length, eligible } };
  }

  async _generate_candidates(run) {
    if (!this.cognitionLoop?._llmCanonicalFact) throw Object.assign(new Error('cognition_generator_unavailable'), { retryable: true });
    const profiles = await this.prisma.subjectProfile.findMany({ where: { orgId: run.orgId, active: true }, orderBy: [{ pinned: 'desc' }, { importance: 'desc' }], take: Number(process.env.DREAM_SUBJECTS_PER_RUN || 40) });
    const walk = await this.prisma.cognitionStep.findUnique({ where: { runId_pipelineVersion_stageKey_shardKey: { runId: run.id, pipelineVersion: run.pipelineVersion, stageKey: 'walk-graph', shardKey: 'root' } } });
    const bundleMap = new Map((walk?.outputReceipt?.bundles || []).map((b) => [b.subject_profile_id, b.memory_ids]));
    let created = 0;
    let generationAttempts = 0;
    let providerFailures = 0;
    for (const profile of profiles) {
      const keys = [profile.displayName, ...(profile.aliases || [])].map(slug).filter(Boolean);
      const tags = keys.flatMap((k) => [`entity:${k}`, `person:${k}`, `organization:${k}`, `project:${k}`, `topic:${k}`]);
      const where = { orgId: run.orgId, isLatest: true, deletedAt: null, cognitiveLayerRole: null };
      if (profile.subjectType === 'user' && UUID.test(profile.subjectKey)) where.userId = profile.subjectKey;
      else if (profile.subjectType === 'project') where.OR = [{ project: profile.subjectKey }, ...(UUID.test(profile.subjectKey) ? [{ projectId: profile.subjectKey }] : []), { tags: { hasSome: tags } }];
      else if (profile.subjectType !== 'organization') where.tags = { hasSome: tags };
      const walkedIds = bundleMap.get(profile.id) || [];
      if (walkedIds.length) {
        const tagFilter = where.tags;
        delete where.tags;
        where.OR = [...(where.OR || []), ...(tagFilter ? [{ tags: tagFilter }] : []), { id: { in: walkedIds } }];
      }
      const members = await this.prisma.memory.findMany({ where, orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }], take: 12 });
      if (members.length < 2) continue;
      generationAttempts += 1;
      const generated = await this.cognitionLoop._llmCanonicalFact(profile.displayName, members).catch((error) => {
        providerFailures += 1;
        this.logger.warn(`[dream-v2] candidate generation failed profile=${profile.id}: ${error.message}`);
        return null;
      });
      if (!generated?.canonical_fact) continue;
      const sourceIds = [...new Set((generated.supporting_memory_ids || []).filter((id) => members.some((m) => m.id === id)))];
      if (sourceIds.length < 2) continue;
      const hash = digest({ org: run.orgId, subject: profile.id, claim: generated.canonical_fact, sources: sourceIds.sort(), version: run.pipelineVersion });
      const risk = HIGH_RISK_TYPES.has(generated.type) || /\b(policy|legal|security|medical|financial|terminate|fire|fraud)\b/i.test(generated.canonical_fact) ? 'high' : 'low';
      const result = await this.prisma.dreamCandidate.upsert({
        where: { orgId_deterministicHash: { orgId: run.orgId, deterministicHash: hash } },
        create: { runId: run.id, orgId: run.orgId, subjectProfileId: profile.id, deterministicHash: hash, type: generated.type || 'canonical', claim: generated.canonical_fact, sourceMemoryIds: sourceIds, confidence: Math.max(0, Math.min(1, Number(generated.confidence) || 0)), risk, scopeSnapshot: run.scopeSnapshot },
        update: {},
      });
      if (result.runId === run.id) created += 1;
    }
    if (generationAttempts > 0 && providerFailures === generationAttempts) {
      const error = new Error('candidate_generation_provider_unavailable');
      error.retryable = true;
      throw error;
    }
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { candidateCount: created } });
    return { run_id: run.id, candidate_count: created, counts: { candidates: created } };
  }

  async _verify_candidates(run) {
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, verdict: 'pending' } });
    let accepted = 0; let rejected = 0; let quarantined = 0;
    for (const candidate of candidates) {
      const sources = await this.prisma.memory.findMany({ where: { id: { in: candidate.sourceMemoryIds }, orgId: run.orgId, isLatest: true, deletedAt: null } });
      const reasons = [];
      if (sources.length !== candidate.sourceMemoryIds.length) reasons.push('missing_or_unauthorized_source');
      if (sources.length < 2) reasons.push('insufficient_independent_sources');
      const visibility = mostRestrictiveVisibility(sources);
      if (visibility === 'private') {
        if (!run.scopeSnapshot?.personal_enabled) reasons.push('personal_cognition_not_enabled');
        else {
          const owners = [...new Set(sources.map((s) => s.userId).filter(Boolean))];
          const opted = await this.prisma.userOrganization.count({ where: { orgId: run.orgId, userId: { in: owners }, cognitionPersonalOptIn: true, isActive: true } });
          if (opted !== owners.length) reasons.push('personal_owner_not_opted_in');
        }
      }
      const projectKeys = new Set(sources.flatMap((s) => [s.project, s.projectId]).filter(Boolean));
      if (projectKeys.size > 1 && !run.scopeSnapshot?.cross_project_enabled) reasons.push('cross_project_not_enabled');
      if (candidate.confidence < Number(process.env.DREAM_MIN_VERIFY_CONFIDENCE || 0.72)) reasons.push('confidence_below_verification_floor');
      const verdict = reasons.length ? 'rejected' : 'accepted';
      const publicationStatus = verdict === 'rejected' ? 'rejected' : candidate.risk === 'low' && candidate.confidence >= Number(process.env.DREAM_AUTO_PUBLISH_CONFIDENCE || 0.86) ? 'approved' : 'quarantined';
      await this.prisma.dreamCandidate.update({ where: { id: candidate.id }, data: { verdict, publicationStatus, rejectionReasons: reasons, scopeSnapshot: { ...run.scopeSnapshot, visibility, projects: [...projectKeys] }, verifierReceipt: { deterministic: true, source_count: sources.length, checked_at: new Date().toISOString() } } });
      if (verdict === 'rejected') rejected += 1; else accepted += 1;
      if (publicationStatus === 'quarantined') quarantined += 1;
    }
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { acceptedCount: accepted, rejectedCount: rejected, quarantinedCount: quarantined } });
    return { run_id: run.id, accepted_count: accepted, rejected_count: rejected, quarantined_count: quarantined, counts: { accepted, rejected, quarantined } };
  }

  async _persist_cognition(run) {
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, verdict: 'accepted', publicationStatus: 'approved', publishedMemoryId: null }, include: { subjectProfile: true } });
    let persisted = 0;
    for (const candidate of candidates) {
      const members = await this.prisma.memory.findMany({ where: { id: { in: candidate.sourceMemoryIds }, orgId: run.orgId } });
      if (members.length !== candidate.sourceMemoryIds.length) continue;
      // Heal the narrow crash window between canonical persistence and receipt
      // update by finding the deterministic synthesis digest before writing.
      const existing = await this.prisma.memory.findFirst({ where: { orgId: run.orgId, synthesisClusterHash: candidate.deterministicHash, deletedAt: null } });
      const created = existing || await this.cognitionLoop._writeSynthMemory({
        orgId: run.orgId, userId: members[0]?.userId, project: members[0]?.project || null,
        sourceType: 'canonical-fact', tag: candidate.subjectProfile?.displayName || candidate.type,
        members, content: candidate.claim, confidence: candidate.confidence,
        evidenceIds: candidate.sourceMemoryIds, clusterHash: candidate.deterministicHash,
        extraMeta: { dream_run_id: run.id, dream_candidate_id: candidate.id, pipeline_version: run.pipelineVersion, publication_state: 'approved' },
      });
      if (!created?.id) continue;
      await this.prisma.dreamCandidate.update({ where: { id: candidate.id }, data: { publishedMemoryId: created.id, publicationStatus: 'persisted' } });
      persisted += 1;
    }
    return { run_id: run.id, persisted_count: persisted, counts: { persisted } };
  }

  async _project_derivations(run) {
    if (!run.latchedFlags?.dream_verified_derivations_v1) return { run_id: run.id, skipped: true, reason: 'derivation_flag_disabled', counts: { relationships: 0 } };
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, publishedMemoryId: { not: null } } });
    let relationships = 0;
    for (const candidate of candidates) {
      for (const sourceId of candidate.sourceMemoryIds) {
        const receipt = await this.prisma.derivationReceipt.upsert({
          where: { orgId_fromMemoryId_toMemoryId_relationshipType: { orgId: run.orgId, fromMemoryId: candidate.publishedMemoryId, toMemoryId: sourceId, relationshipType: 'GroundedIn' } },
          create: { orgId: run.orgId, candidateId: candidate.id, fromMemoryId: candidate.publishedMemoryId, toMemoryId: sourceId, relationshipType: 'GroundedIn', status: 'verified', attempts: 1, receipt: { source_exists: true, tenant_verified: true }, processedAt: new Date() },
          update: {},
        });
        await this.prisma.relationship.upsert({
          where: { fromId_toId_type: { fromId: candidate.publishedMemoryId, toId: sourceId, type: 'GroundedIn' } },
          create: { fromId: candidate.publishedMemoryId, toId: sourceId, type: 'GroundedIn', confidence: candidate.confidence, createdBy: 'dream-workflow-v2', metadata: { receipt_id: receipt.id, candidate_id: candidate.id } },
          update: {},
        });
        relationships += 1;
      }
    }
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { relationshipCount: relationships } });
    return { run_id: run.id, relationship_count: relationships, counts: { relationships } };
  }

  async _update_profiles(run) {
    if (!run.latchedFlags?.dream_subject_profiles_v1) return { run_id: run.id, skipped: true, reason: 'profile_flag_disabled', counts: { profiles: 0 } };
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, publishedMemoryId: { not: null }, publicationStatus: 'persisted', subjectProfileId: { not: null } } });
    let updated = 0;
    for (const candidate of candidates) {
      const profile = await this.prisma.subjectProfile.findUnique({ where: { id: candidate.subjectProfileId } });
      if (!profile) continue;
      const factKey = `${candidate.type}:${candidate.deterministicHash.slice(0, 24)}`;
      const last = await this.prisma.subjectProfileFact.findFirst({ where: { profileId: profile.id, factKey }, orderBy: { revision: 'desc' } });
      const revision = (last?.revision || 0) + 1;
      const temporalClass = ['trajectory', 'risk', 'opportunity'].includes(candidate.type) ? 'dynamic' : 'stable';
      const fact = await this.prisma.subjectProfileFact.create({ data: { profileId: profile.id, factKey, value: candidate.claim, category: candidate.type, temporalClass, confidence: candidate.confidence, revision, evidenceMemoryIds: candidate.sourceMemoryIds, lastConfirmedAt: new Date(), expiresAt: temporalClass === 'dynamic' ? new Date(Date.now() + Number(process.env.DREAM_DYNAMIC_FACT_TTL_DAYS || 30) * 86_400_000) : null, supersedesId: last?.id || null } });
      if (last) await this.prisma.subjectProfileFact.update({ where: { id: last.id }, data: { status: 'superseded', validTo: new Date() } });
      const version = profile.projectionVersion + 1;
      const facts = await this.prisma.subjectProfileFact.findMany({ where: { profileId: profile.id, status: 'active' }, orderBy: { confidence: 'desc' } });
      await this.prisma.subjectProfile.update({ where: { id: profile.id }, data: { projectionVersion: version, stableProjection: facts.filter((f) => f.temporalClass === 'stable').map((f) => ({ id: f.id, key: f.factKey, value: f.value, confidence: f.confidence })), dynamicProjection: facts.filter((f) => f.temporalClass !== 'stable').map((f) => ({ id: f.id, key: f.factKey, value: f.value, confidence: f.confidence })), lastReconciledAt: new Date() } });
      await this.prisma.subjectProfileRevision.create({ data: { profileId: profile.id, runId: run.id, version, changedFactIds: [fact.id], verification: candidate.verifierReceipt } });
      updated += 1;
    }
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { profileUpdateCount: updated } });
    return { run_id: run.id, profile_update_count: updated, counts: { profiles: updated } };
  }

  async _embed(run) {
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, publishedMemoryId: { not: null } }, select: { publishedMemoryId: true } });
    const ids = candidates.map((c) => c.publishedMemoryId);
    const vectors = ids.length ? await this.prisma.vectorEmbedding.count({ where: { memoryId: { in: ids }, syncStatus: 'synced' } }) : 0;
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { vectorCount: vectors } });
    if (vectors !== ids.length) throw Object.assign(new Error('vector_coverage_incomplete'), { retryable: true });
    return { run_id: run.id, expected: ids.length, vector_count: vectors, counts: { vectors } };
  }

  async _reconcile(run) {
    if (run.latchedFlags?.dream_reconsolidation_v1) {
      const facts = await this.prisma.subjectProfileFact.findMany({ where: { profile: { orgId: run.orgId }, status: 'active' }, select: { id: true, evidenceMemoryIds: true, expiresAt: true } });
      for (const fact of facts) {
        const expired = fact.expiresAt && fact.expiresAt <= new Date();
        const live = fact.evidenceMemoryIds.length ? await this.prisma.memory.count({ where: { id: { in: fact.evidenceMemoryIds }, orgId: run.orgId, isLatest: true, deletedAt: null } }) : 0;
        if (expired || live !== fact.evidenceMemoryIds.length) await this.prisma.subjectProfileFact.update({ where: { id: fact.id }, data: { status: expired ? 'expired' : 'inactive', validTo: new Date() } });
      }
    }
    const candidates = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id } });
    const published = candidates.filter((c) => c.publishedMemoryId);
    const ids = published.map((c) => c.publishedMemoryId);
    const [memories, relations, vectors] = await Promise.all([
      ids.length ? this.prisma.memory.count({ where: { id: { in: ids }, orgId: run.orgId, deletedAt: null } }) : 0,
      ids.length ? this.prisma.relationship.count({ where: { fromId: { in: ids }, type: 'GroundedIn' } }) : 0,
      ids.length ? this.prisma.vectorEmbedding.count({ where: { memoryId: { in: ids }, syncStatus: 'synced' } }) : 0,
    ]);
    const expectedRelations = run.latchedFlags?.dream_verified_derivations_v1 ? published.reduce((n, c) => n + c.sourceMemoryIds.length, 0) : 0;
    const grounding = memories === ids.length && vectors === ids.length && relations >= expectedRelations ? 'complete' : 'partial';
    if (grounding !== 'complete') throw Object.assign(new Error('dream_reconciliation_incomplete'), { retryable: true });
    return { run_id: run.id, grounding_status: grounding, counts: { memories, relationships: relations, vectors } };
  }

  async _publish(run) {
    const persisted = await this.prisma.dreamCandidate.findMany({ where: { runId: run.id, publicationStatus: 'persisted', publishedMemoryId: { not: null } } });
    await this.prisma.dreamCandidate.updateMany({ where: { id: { in: persisted.map((c) => c.id) } }, data: { publicationStatus: 'published' } });
    const quarantined = await this.prisma.dreamCandidate.count({ where: { runId: run.id, publicationStatus: 'quarantined' } });
    const admins = run.latchedFlags?.dream_ui_insights_v1 ? await this.prisma.userOrganization.findMany({ where: { orgId: run.orgId, isActive: true, OR: [{ role: { in: ['owner', 'admin'] } }, { roles: { hasSome: ['owner', 'admin'] } }] }, select: { userId: true } }) : [];
    for (const admin of admins) {
      await createWorkspaceNotification(this.prisma, { orgId: run.orgId, userId: admin.userId, type: quarantined ? 'cognition.review_required' : 'cognition.run_completed', title: quarantined ? 'Dreaming produced insights to review' : 'Dreaming completed', body: `${persisted.length} insight(s) published${quarantined ? ` and ${quarantined} held for review` : ''}.`, resourceType: 'cognition_run', resourceId: run.id, dedupeKey: `dream-v2:${run.id}:publish`, data: { run_id: run.id, published_count: persisted.length, quarantined_count: quarantined } });
    }
    await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { publishedCount: persisted.length, quarantinedCount: quarantined } });
    return { run_id: run.id, published_count: persisted.length, quarantined_count: quarantined, counts: { published: persisted.length, quarantined } };
  }

  async _finalize(run) {
    const fresh = await this.prisma.cognitionRun.findUnique({ where: { id: run.id } });
    const finishedAt = new Date();
    const updated = await this.prisma.cognitionRun.update({ where: { id: run.id }, data: { status: 'completed', currentStage: 'finalize', progress: 100, heartbeatAt: finishedAt, finishedAt, runMs: Math.max(0, finishedAt.getTime() - fresh.startedAt.getTime()), terminalReason: 'verified_and_published' } });
    return this._receipt(updated);
  }

  _receipt(run) {
    return {
      run_id: run.id, org_id: run.orgId, workflow_instance_id: run.workflowInstanceId,
      pipeline_version: run.pipelineVersion, status: run.status, stage: run.currentStage,
      progress: run.progress, candidate_count: run.candidateCount, accepted_count: run.acceptedCount,
      rejected_count: run.rejectedCount, quarantined_count: run.quarantinedCount,
      published_count: run.publishedCount, profile_update_count: run.profileUpdateCount,
      grounding_status: run.status === 'completed' ? 'complete' : 'pending', recovery_status: run.recoveryStatus,
    };
  }
}
