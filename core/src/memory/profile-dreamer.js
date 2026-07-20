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
import { runWithOrg, currentOrg } from '../db/prisma.js';
import { orgIsRemote } from '../vector/mneme/driver.js';
import { remoteList } from '../vector/mneme/remote-backend.js';

const PROFILE_DREAM_ENABLED = process.env.PROFILE_DREAM_ENABLED === 'true';
const PROFILE_DREAM_APPLY   = process.env.PROFILE_DREAM_APPLY === 'true';
const PROFILE_DREAM_MODEL   = process.env.PROFILE_DREAM_MODEL || 'openai/gpt-oss-120b';
const MIN_MEMORIES          = Number(process.env.PROFILE_DREAM_MIN_MEMORIES || 5);
const RAW_TAKE              = Number(process.env.PROFILE_DREAM_RAW_TAKE || 60);
const CONFIDENCE_FLOOR      = Number(process.env.PROFILE_DREAM_CONFIDENCE_FLOOR || 0.55);
const DECAY_FACTOR          = Number(process.env.PROFILE_DREAM_DECAY || 0.8);
// gpt-oss-* are reasoning models: thinking + answer share the completion budget.
// With the long strict persona prompt, 1200 tokens were spent on reasoning and the
// JSON answer came back EMPTY → the dreamer silently produced 0 facts. Give it real
// headroom so the array is actually emitted. Pure-additive (more room only); never
// alters the prompt, grounding gate, decay, or fact selection — so quality can't drop.
const MAX_TOKENS            = Number(process.env.PROFILE_DREAM_MAX_TOKENS || 4096);
// WS5 step-4 — bounded read-only TRANSCRIPT REPLAY. When on, the dreamer ALSO reads
// recent conversation transcripts as persona evidence (a lot of "who the user is"
// signal lives in chat, not in extracted facts). STRICT rail: transcripts are READ
// ONLY — never ingestMemory'd, never written back; they only feed the persona LLM
// and serve as grounding ids. Bounded so a long chat history can't blow the prompt.
const PROFILE_DREAM_TRANSCRIPTS = process.env.PROFILE_DREAM_TRANSCRIPTS === 'true';
// WS5 step-5 — embed applied persona facts into the separate profile_<org> Qdrant
// collection (persona recall lane). Flag-gated default OFF.
const PROFILE_DREAM_EMBED   = process.env.PROFILE_DREAM_EMBED === 'true';
const TRANSCRIPT_TAKE       = Number(process.env.PROFILE_DREAM_TRANSCRIPT_TAKE || 12);
const TRANSCRIPT_CHARS      = Number(process.env.PROFILE_DREAM_TRANSCRIPT_CHARS || 1200);
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
    if (orgId && currentOrg() !== orgId) return runWithOrg(orgId, () => this.dreamProfilesForOrg(orgId, opts)); // residency: org's store
    if (!PROFILE_DREAM_ENABLED) return { skipped: true, reason: 'PROFILE_DREAM_ENABLED!=true' };
    if (!this.prisma) return { skipped: true, reason: 'no prisma' };
    const apply = opts.apply === true && PROFILE_DREAM_APPLY;
    // force=true bypasses the dirty-gate (re-dream even if nothing changed) —
    // used by the manual endpoint. Scheduled runs leave it false so unchanged
    // users are skipped (no wasted LLM call).
    const force = opts.force === true;

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
        perUser.push(await this._dreamUser(orgId, userId, apply, force));
      } catch (err) {
        this.logger.warn?.(`[profile-dreamer] user=${String(userId).slice(0, 8)} failed: ${err.message}`);
        perUser.push({ userId, error: err.message });
      }
    }
    return { orgId, members: members.length, apply, perUser };
  }

  async _dreamUser(orgId, userId, apply, force = false) {
    // RAW memories only — never syntheses (cognitiveLayerRole null).
    // Remote (self-host): memory rows live on the agent — bounded recent list mapped to the
    // same {id, content, title, createdAt} fields the downstream code reads.
    const _remoteDream = orgIsRemote(orgId);
    const _dreamExcl = ['internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge'];
    const raw = _remoteDream
      ? ((await remoteList(orgId, { user_id: userId, memory_type: ['fact', 'decision', 'preference', 'goal'], is_latest: true }, null, RAW_TAKE))?.memories || [])
          // NOTE: self-host 'summary' company rows aren't tag-filterable through
          // remoteList; kept out of the remote lane to avoid pulling all
          // summaries. Central onboarding (the common path) gets company facts
          // via the tag-scoped OR in the local branch below + the onboarding
          // upsert. Revisit if self-host onboarding needs company personas.
          .filter((m) => !(m.tags || []).some((t) => _dreamExcl.includes(t)))
          .map((m) => ({
            id: m.memory_id || m.id,
            content: m.content || '',
            title: m.title || null,
            createdAt: m.created_at ? new Date(m.created_at) : null,
          }))
      : await this.prisma.memory.findMany({
          where: {
            userId, orgId, deletedAt: null,
            cognitiveLayerRole: null,
            NOT: { tags: { hasSome: _dreamExcl } },
            // fact/decision/preference/goal of any provenance, PLUS 'summary'
            // ONLY when tagged company-profile/org-canon — i.e. the onboarding
            // company IDENTITY/MISSION rows. Untagged 'summary' (cognition
            // rollups, doc/image captions, chat-session summaries) is NOT pulled,
            // so the dreamer prompt stays lean and on-signal.
            OR: [
              { memoryType: { in: ['fact', 'decision', 'preference', 'goal'] } },
              { memoryType: 'summary', tags: { hasSome: ['company-profile', 'org-canon'] } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: RAW_TAKE,
          select: { id: true, content: true, title: true, createdAt: true },
        });
    if (raw.length < MIN_MEMORIES) return { userId, skipped: 'below_min_memories', count: raw.length };

    // DIRTY-GATE — skip the (expensive) LLM re-distillation when nothing new has
    // arrived since this user was last dreamed. raw is ordered desc so raw[0] is
    // their newest memory; compare to the max lastDreamedAt across their profile.
    // Bounds scheduled-run cost to ONLY users with fresh evidence. force bypasses.
    // (A user who has never been dreamed has lastDreamedAt=null → always runs.)
    if (!force) {
      try {
        const agg = await this.prisma.userProfile.aggregate({
          where: { userId, orgId: orgId || null, deletedAt: null },
          _max: { lastDreamedAt: true },
        });
        const lastDreamed = agg?._max?.lastDreamedAt || null;
        const latestMem = raw[0]?.createdAt || null;
        if (lastDreamed && latestMem && new Date(latestMem) <= new Date(lastDreamed)) {
          return { userId, skipped: 'no_new_memories', lastDreamed, latestMem, count: raw.length };
        }
      } catch (err) {
        // Gate failure must never block dreaming — fall through and dream.
        this.logger.warn?.(`[profile-dreamer] dirty-gate check failed for ${String(userId).slice(0, 8)}: ${err.message}`);
      }
    }

    // WS5 step-4: optionally fold in recent conversation transcripts as READ-ONLY
    // persona evidence. Bounded + truncated. NEVER written back / ingested.
    let evidence = raw;
    let transcriptCount = 0;
    if (PROFILE_DREAM_TRANSCRIPTS) {
      try {
        // Remote (self-host): pull conversation rows from the agent, mapped to the same fields.
        const tx = _remoteDream
          ? ((await remoteList(orgId, { user_id: userId, memory_type: ['conversation'], is_latest: true }, null, TRANSCRIPT_TAKE))?.memories || [])
              .map((m) => ({
                id: m.memory_id || m.id,
                content: m.content || '',
                title: m.title || null,
                createdAt: m.created_at ? new Date(m.created_at) : null,
              }))
          : await this.prisma.memory.findMany({
              where: {
                userId, orgId, deletedAt: null, cognitiveLayerRole: null,
                memoryType: 'conversation',
              },
              orderBy: { createdAt: 'desc' },
              take: TRANSCRIPT_TAKE,
              select: { id: true, content: true, title: true, createdAt: true },
            });
        // Truncate transcript content so a long chat can't dominate the prompt.
        const trimmed = tx.map((t) => ({
          ...t,
          content: (t.content || '').split(/\bassistant:/i)[0].slice(0, TRANSCRIPT_CHARS),
        }));
        transcriptCount = trimmed.length;
        evidence = [...raw, ...trimmed];
      } catch (err) {
        this.logger.warn?.(`[profile-dreamer] transcript read failed: ${err.message}`);
      }
    }

    const validIds = new Set(evidence.map((r) => r.id));
    const proposed = await this._llmPersona(evidence);
    // GROUNDING gate: keep only facts that cite ≥1 evidence id present in this
    // member's own fetched memory set, and clear the confidence floor.
    const grounded = (proposed || [])
      .map((f) => ({
        ...f,
        evidence_memory_ids: (f.evidence_memory_ids || []).filter((id) => validIds.has(id)),
      }))
      .filter((f) => f.value && f.key && f.evidence_memory_ids.length > 0 && (f.confidence || 0) >= CONFIDENCE_FLOOR);

    if (!apply) {
      return { userId, dryRun: true, memories: raw.length, transcripts: transcriptCount, proposals: grounded };
    }

    // M7: derive each fact's source project. A persona fact built purely from ONE
    // project's memories is scoped to that project; evidence spanning multiple
    // projects (or none) → null = org-level identity (visible in every project).
    const memProj = new Map();
    // Remote (self-host): memoryProject join rows are central-only — skip; facts default to
    // org-level scope (_projectId=null), which is the safe visibility fallback.
    try {
      if (!_remoteDream) {
        const mp = await this.prisma.memoryProject.findMany({
          where: { memoryId: { in: Array.from(validIds) } },
          select: { memoryId: true, projectId: true },
        });
        for (const r of mp) {
          if (!memProj.has(r.memoryId)) memProj.set(r.memoryId, new Set());
          memProj.get(r.memoryId).add(r.projectId);
        }
      }
    } catch (err) {
      this.logger.warn?.(`[profile-dreamer] project map failed: ${err.message}`);
    }
    for (const f of grounded) {
      const projs = new Set();
      for (const id of f.evidence_memory_ids) for (const p of (memProj.get(id) || [])) projs.add(p);
      f._projectId = projs.size === 1 ? [...projs][0] : null;
    }

    let applied = 0;
    let decayed = 0;
    const appliedFacts = [];   // for persona-vector embed (after txn — no I/O under lock)
    const removedKeys = [];     // decayed-out keys → remove their persona vectors
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', `profile:${orgId}:${userId}`);
      const proposedKeys = new Set(grounded.map((f) => f.key.toLowerCase().trim()));

      for (const f of grounded) {
        const key = f.key.toLowerCase().trim();
        appliedFacts.push({ key, value: f.value, category: f.category || 'dynamic' });
        await tx.userProfile.upsert({
          where: { userId_orgId_key: { userId, orgId: orgId || null, key } },
          update: {
            value: f.value,
            category: f.category || 'dynamic',
            confidence: Math.min(0.95, f.confidence),
            confirmedCount: { increment: 1 },
            lastConfirmedAt: new Date(),
            lastDreamedAt: new Date(),
            evidenceMemoryIds: f.evidence_memory_ids,
            deletedAt: null,
            projectId: f._projectId ?? null, // M7: refresh provenance each dream
          },
          create: {
            userId, orgId, key, value: f.value,
            category: f.category || 'dynamic',
            confidence: Math.min(0.95, f.confidence),
            lastDreamedAt: new Date(),
            evidenceMemoryIds: f.evidence_memory_ids,
            projectId: f._projectId ?? null,
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
          removedKeys.push(p.key);
        } else {
          await tx.userProfile.update({ where: { id: p.id }, data: { confidence: next } });
        }
        decayed++;
      }
    }, { timeout: Number(process.env.PROFILE_TXN_TIMEOUT_MS || 15000), maxWait: 8000 });

    // WS5 step-5: embed applied persona facts into the SEPARATE profile_<org>
    // Qdrant collection (network I/O OUTSIDE the advisory lock). Flag-gated.
    let embedded = 0;
    if (PROFILE_DREAM_EMBED && (appliedFacts.length || removedKeys.length)) {
      try {
        const { upsertPersonaVector, deletePersonaVector } = await import('./persona-vector.js');
        const { default: getEmbedService } = await import('../embeddings/factory.js');
        const svc = getEmbedService();
        for (const f of appliedFacts) {
          if (await upsertPersonaVector({ orgId, userId, key: f.key, category: f.category, value: f.value, embedService: svc, logger: this.logger })) embedded++;
        }
        for (const key of removedKeys) {
          await deletePersonaVector({ orgId, userId, key, logger: this.logger });
        }
      } catch (err) {
        this.logger.warn?.(`[profile-dreamer] persona embed failed: ${err.message}`);
      }
    }

    return { userId, memories: raw.length, transcripts: transcriptCount, applied, decayed, embedded };
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
        max_tokens: MAX_TOKENS,
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
