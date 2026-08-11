/**
 * CognitiveTool — abstract base for governance-driven synthesis tools.
 *
 * Each tool owns:
 *   - name           — action_type written to governance_action_log
 *   - cognitiveRole  — value stamped on resulting Memory.cognitive_layer_role
 *   - assess()       — pure read; decides applicability + computes cluster_hash
 *   - execute()      — does the write, returns { memory_id, tokens_used, ... }
 *
 * Tools share access to a prisma client + cognition-loop instance (we
 * reuse cognition-loop's LLM helpers + lossless summary builder so we
 * don't reimplement the proven content paths). The cognition-loop is
 * NOT actively running — we just use its methods as a library.
 */

import crypto from 'node:crypto';

/** Stable 48-char hash for cooldown + dedup keying. */
export function clusterHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 48);
}

/** Returns intersection / union ratio between two id sets. */
export function jaccard(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** True when output text is a near-verbatim restatement of source members. */
export function isRestatement(outputText, members) {
  if (!outputText) return true;
  const out = String(outputText).toLowerCase();
  const total = members.length;
  if (total === 0) return false;
  let restated = 0;
  for (const m of members) {
    const src = String(m.content || '').toLowerCase();
    if (!src) continue;
    // Trigram overlap heuristic — if 60%+ of source trigrams appear in output,
    // it's a restatement, not a synthesis.
    const tris = new Set();
    for (let i = 0; i < src.length - 2; i += 1) tris.add(src.slice(i, i + 3));
    if (tris.size === 0) continue;
    let hit = 0;
    for (const t of tris) if (out.includes(t)) hit += 1;
    if (hit / tris.size >= 0.6) restated += 1;
  }
  return restated / total >= 0.5;
}

/** Confidence dampening on revision count (matches cognition-loop). */
export function capConfidence(raw, revision = 1) {
  const r = Number.isFinite(raw) ? raw : 0.5;
  const dampening = 1 - Math.min(0.4, 0.05 * Math.max(0, revision - 1));
  return Math.max(0, Math.min(1, r * dampening));
}

export class CognitiveTool {
  constructor({ prisma, cognitionLoopFactory, memoryStore, logger = console } = {}) {
    this.prisma = prisma;
    this.cognitionLoopFactory = cognitionLoopFactory; // lazy — load only when needed
    this.memoryStore = memoryStore;
    this.logger = logger;
    this._loop = null;
    this.tokensUsedLifetime = 0;
  }

  get name() { throw new Error('subclass must define name'); }
  get cognitiveRole() { throw new Error('subclass must define cognitiveRole'); }

  /** Lazy cognition-loop instance for helper access (no scheduling). */
  async getLoop() {
    if (this._loop) return this._loop;
    if (typeof this.cognitionLoopFactory === 'function') {
      this._loop = await this.cognitionLoopFactory();
    }
    return this._loop;
  }

  /** Check + record cooldown in governance_agent_state.config.cooldown_map. */
  async isOnCooldown(orgId, hash, { hours = 6 } = {}) {
    if (!this.prisma || !orgId || !hash) return false;
    try {
      const row = await this.prisma.governanceAgentState.findUnique({
        where: { agentName: 'turing' },
        select: { config: true },
      });
      const map = row?.config?.cooldown_map || {};
      const key = `${orgId}:${hash}`;
      const last = map[key];
      if (!last) return false;
      const ageMs = Date.now() - new Date(last).getTime();
      return ageMs < hours * 60 * 60 * 1000;
    } catch {
      return false;
    }
  }

  async recordCooldown(orgId, hash) {
    if (!this.prisma || !orgId || !hash) return;
    try {
      const row = await this.prisma.governanceAgentState.findUnique({
        where: { agentName: 'turing' },
        select: { config: true },
      });
      const map = { ...(row?.config?.cooldown_map || {}) };
      // Prune old entries (>7 days) to keep config small.
      const now = Date.now();
      for (const k of Object.keys(map)) {
        if (now - new Date(map[k]).getTime() > 7 * 24 * 60 * 60 * 1000) delete map[k];
      }
      map[`${orgId}:${hash}`] = new Date().toISOString();
      // UPSERT, not update. agentName is the @id, and update() throws
      // "Record to update not found" whenever the row does not exist yet — which
      // is every org that has never had a turing run. Observed nine times per
      // governance cycle across three orgs, caught by the surrounding catch and
      // logged as prisma:error noise that buried real failures.
      // Every other column has a schema default, so create needs only the id.
      const nextConfig = { ...(row?.config || {}), cooldown_map: map };
      await this.prisma.governanceAgentState.upsert({
        where: { agentName: 'turing' },
        update: { config: nextConfig },
        create: { agentName: 'turing', config: nextConfig },
      });
    } catch (err) {
      this.logger?.warn?.(`[cognitive-tool] cooldown record failed: ${err.message}`);
    }
  }

  /** Find existing canonical/bridge/compression with same cluster_hash. */
  async findExistingByHash(orgId, hash) {
    if (!this.prisma || !orgId || !hash) return null;
    try {
      return await this.prisma.memory.findFirst({
        where: {
          orgId,
          deletedAt: null,
          synthesisClusterHash: hash,
        },
        orderBy: { updatedAt: 'desc' },
      });
    } catch {
      return null;
    }
  }

  /**
   * Assess-side dedup: don't re-emit a proposal for a cluster that already
   * has an OPEN (proposed/approved) action_log row within the recent window.
   * Prevents same proposal flooding consecutive cycles before user reviews.
   * cluster_hash is matched against governance_action_log.reasoning JSON.
   * Window default 6h (matches canonical cooldown).
   */
  async hasOpenProposal(orgId, hash, actionType, { hours = 6 } = {}) {
    if (!this.prisma || !orgId || !hash) return false;
    try {
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      // We embed cluster_hash in action_log.reasoning OR we match via batch.
      // Cheap approach: fetch recent proposed/approved rows of this type for
      // org, scan for cluster_hash match in beforeSnapshot / afterSnapshot.
      const rows = await this.prisma.governanceActionLog.findMany({
        where: {
          orgId,
          actionType,
          status: { in: ['proposed', 'approved'] },
          createdAt: { gte: since },
        },
        select: { id: true, beforeSnapshot: true, afterSnapshot: true, reasoning: true },
        take: 50,
      });
      return rows.some((r) => {
        if (r.beforeSnapshot?.cluster_hash === hash) return true;
        if (r.afterSnapshot?.cluster_hash === hash) return true;
        if (typeof r.reasoning === 'string' && r.reasoning.includes(hash)) return true;
        return false;
      });
    } catch {
      return false;
    }
  }

  /** Subclass overrides. */
  async assess(/* context */) {
    return { applicable: false, reason: 'not_implemented' };
  }

  async execute(/* args */) {
    return { status: 'failed', reason: 'not_implemented' };
  }
}
