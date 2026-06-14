/**
 * WS5 — Profile Dreamer (evolving "who the user actually is" picture).
 *
 * The regex `extractAndStore` in profile-store.js only catches explicit "my name
 * is…" phrasings. The dreamer is the LLM layer: per ACTIVE ORG MEMBER (employees ==
 * org members), it distills a durable, evolving persona from that member's RAW
 * memories and writes grounded profile facts that update as the evidence changes.
 *
 * HARD SAFETY RAILS (red-team safe order — see [[dreaming_ws5_started]]):
 *  - Default INERT: PROFILE_DREAM_ENABLED must be 'true' to run at all.
 *  - Propose-only first: PROFILE_DREAM_APPLY must be 'true' to PERSIST; otherwise
 *    it is a dry-run that returns proposals and writes nothing.
 *  - GROUNDED: every persisted fact must cite ≥1 evidence memory id that actually
 *    exists in the member's fetched memory set. Ungrounded facts are dropped (no
 *    hallucinated persona lines). buildProfileContext additionally render-gates
 *    dreamed facts on evidenceMemoryIds.length > 0.
 *  - Derives from RAW memories ONLY (cognitiveLayerRole null) — never from
 *    syntheses, so the WS3 confidence-temper cascade can't feed back into persona.
 *  - Category-aware decay + FLOOR: a re-dream that doesn't reaffirm a prior dreamed
 *    fact decays its confidence; identity (static) facts have a higher floor so a
 *    stable trait isn't forgotten after one quiet period.
 *  - Does NOT import drift-compaction / purgeVectors — it cannot delete real data.
 */

import { chatCompletion } from '../knowledge/enterprise/litellm-client.js';

const PROFILE_DREAM_ENABLED = process.env.PROFILE_DREAM_ENABLED === 'true';
const PROFILE_DREAM_APPLY   = process.env.PROFILE_DREAM_APPLY === 'true';
const PROFILE_DREAM_MODEL   = process.env.PROFILE_DREAM_MODEL || 'openai/gpt-oss-120b';
const MIN_MEMORIES          = Number(process.env.PROFILE_DREAM_MIN_MEMORIES || 5);
const RAW_TAKE              = Number(process.env.PROFILE_DREAM_RAW_TAKE || 60);
const CONFIDENCE_FLOOR      = Number(process.env.PROFILE_DREAM_CONFIDENCE_FLOOR || 0.55);
const DECAY_FACTOR          = Number(process.env.PROFILE_DREAM_DECAY || 0.8);
// Per-category confidence floor below which a decayed dreamed fact is dropped.
const CATEGORY_FLOOR = { static: 0.5, preference: 0.3, goal: 0.25, dynamic: 0.2 };

export function isProfileDreamEnabled() { return PROFILE_DREAM_ENABLED; }

export class ProfileDreamer {
  constructor({ prisma, logger = console } = {}) {
    this.prisma = prisma;
    this.logger = logger;
  }

  /**
   * Dream every active member of an org. Returns per-user proposal/apply counts.
   * @param {string} orgId
   * @param {{ apply?: boolean }} [opts]
   */
  async dreamProfilesForOrg(orgId, opts = {}) {
    if (!PROFILE_DREAM_ENABLED) return { skipped: true, reason: 'PROFILE_DREAM_ENABLED!=true' };
    if (!this.prisma) return { skipped: true, reason: 'no prisma' };
    const apply = opts.apply === true && PROFILE_DREAM_APPLY;

    let members = [];
    try {
      members = await this.prisma.$queryRawUnsafe(
        `SELECT user_id FROM hivemind.user_organizations WHERE org_id = $1::uuid AND is_active = true`,
        orgId,
      );
    } catch (err) {
      return { skipped: true, reason: `member read failed: ${err.message}` };
    }

    const perUser = [];
    for (const m of members) {
      const userId = m.user_id;
      if (!userId) continue;
      try {
        perUser.push(await this._dreamUser(orgId, userId, apply));
      } catch (err) {
        this.logger.warn?.(`[profile-dreamer] user=${String(userId).slice(0, 8)} failed: ${err.message}`);
        perUser.push({ userId, error: err.message });
      }
    }
    return { orgId, members: members.length, apply, perUser };
  }

  async _dreamUser(orgId, userId, apply) {
    // RAW memories only — never syntheses (cognitiveLayerRole null).
    const raw = await this.prisma.memory.findMany({
      where: {
        userId, orgId, deletedAt: null,
        cognitiveLayerRole: null,
        memoryType: { in: ['fact', 'decision', 'preference', 'goal'] },
        NOT: { tags: { hasSome: ['internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge'] } },
      },
      orderBy: { createdAt: 'desc' },
      take: RAW_TAKE,
      select: { id: true, content: true, title: true, createdAt: true },
    });
    if (raw.length < MIN_MEMORIES) return { userId, skipped: 'below_min_memories', count: raw.length };

    const validIds = new Set(raw.map((r) => r.id));
    const proposed = await this._llmPersona(raw);
    // GROUNDING gate: keep only facts that cite ≥1 evidence id present in this
    // member's own fetched memory set, and clear the confidence floor.
    const grounded = (proposed || [])
      .map((f) => ({
        ...f,
        evidence_memory_ids: (f.evidence_memory_ids || []).filter((id) => validIds.has(id)),
      }))
      .filter((f) => f.value && f.key && f.evidence_memory_ids.length > 0 && (f.confidence || 0) >= CONFIDENCE_FLOOR);

    if (!apply) {
      return { userId, dryRun: true, memories: raw.length, proposals: grounded };
    }

    let applied = 0;
    let decayed = 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', `profile:${userId}`);
      const proposedKeys = new Set(grounded.map((f) => f.key.toLowerCase().trim()));

      for (const f of grounded) {
        const key = f.key.toLowerCase().trim();
        await tx.userProfile.upsert({
          where: { userId_key: { userId, key } },
          update: {
            value: f.value,
            category: f.category || 'dynamic',
            confidence: Math.min(0.95, f.confidence),
            confirmedCount: { increment: 1 },
            lastConfirmedAt: new Date(),
            lastDreamedAt: new Date(),
            evidenceMemoryIds: f.evidence_memory_ids,
            deletedAt: null,
          },
          create: {
            userId, orgId, key, value: f.value,
            category: f.category || 'dynamic',
            confidence: Math.min(0.95, f.confidence),
            lastDreamedAt: new Date(),
            evidenceMemoryIds: f.evidence_memory_ids,
          },
        });
        applied++;
      }

      // Decay prior DREAMED facts not reaffirmed this run, floored per category.
      const priorDreamed = await tx.userProfile.findMany({
        where: { userId, orgId, deletedAt: null, lastDreamedAt: { not: null } },
        select: { id: true, key: true, category: true, confidence: true },
      });
      for (const p of priorDreamed) {
        if (proposedKeys.has(p.key)) continue; // reaffirmed above
        const floor = CATEGORY_FLOOR[p.category] ?? 0.2;
        const next = p.confidence * DECAY_FACTOR;
        if (next < floor) {
          await tx.userProfile.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
        } else {
          await tx.userProfile.update({ where: { id: p.id }, data: { confidence: next } });
        }
        decayed++;
      }
    });

    return { userId, memories: raw.length, applied, decayed };
  }

  async _llmPersona(memories) {
    const facts = memories.map((m) => {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 300);
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown';
      return `[${m.id}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');

    const prompt = `Below are ${memories.length} of one person's own memories. Distill a DURABLE, EVOLVING profile of who this person is — the stable identity, preferences, goals, and working context that recur across the evidence.

STRICT (these facts get injected into the assistant's context — a wrong one poisons every future answer):
- Only durable traits the evidence SUPPORTS. A one-off passing mention is NOT a durable preference — require it to recur or be stated as a settled fact. When in doubt, omit.
- Ground every fact: cite the memory [ids] it comes from. Never invent a trait, name, number, or preference not in the evidence.
- Categories: "static" (stable identity: name, role, company, location, language), "preference" (durable likes/working style), "goal" (what they're trying to achieve), "dynamic" (current focus that may change).
- key = short stable slug (e.g. "role", "company", "preference:async-comms"); value = the concrete fact.

REJECT: speculation, one-off mentions, generic personality fluff, anything not traceable to ≥1 cited memory.

Memories:
${facts}

Output JSON only — an array (max 12), strongest first:
[{ "category":"static|preference|goal|dynamic", "key":"<slug>", "value":"<concrete grounded fact>", "evidence_memory_ids":["<id>",...], "confidence":0.0-1.0 }]`;

    let raw;
    try {
      raw = await chatCompletion({
        model: PROFILE_DREAM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1200,
      });
    } catch (err) {
      this.logger.warn?.(`[profile-dreamer] LLM failed: ${err.message}`);
      return [];
    }
    return this._parseArray(raw);
  }

  _parseArray(raw) {
    if (!raw) return [];
    const s = String(raw).trim();
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      const arr = JSON.parse(s.slice(start, end + 1));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
}
