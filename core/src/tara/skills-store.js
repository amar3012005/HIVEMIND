/**
 * Skills Store — named prompt presets for TARA, org-scoped.
 *
 * A "skill" is a reusable prompt bundle the user picks in the Skills tab:
 *   - kind 'external' → primary_prompt (system) + secondary_prompt (clinical/SPICED)
 *   - kind 'internal' → primary_prompt only (voice-of-HIVEMIND), no secondary
 *
 * Stored as HIVEMIND memories (memory_type 'tara_skill') so no DB schema change
 * is needed. Selecting a skill COPIES its prompts into the live tara config
 * (system_prompt / clinical_prompt / internal_prompt) — so the stream handler
 * needs zero changes; it keeps reading the same config fields.
 *
 * Two locked built-ins are seeded per org: "Sales Agent" (external) and
 * "Voice of HIVEMIND" (internal), plus "Customer Support" (external) as a
 * second external example. Built-ins can be selected/viewed but not edited or
 * deleted; user-created skills are fully editable.
 */
import crypto from 'node:crypto';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_INTERNAL_PROMPT, DEFAULT_CLINICAL_PROMPT } from './config-store.js';

const CUSTOMER_SUPPORT_PROMPT = `You are a warm, efficient customer-support voice agent. Your job is to resolve the caller's issue quickly and make them feel heard.

## How you talk
- Sound like a calm, competent human. Brief, friendly, never scripted.
- Open by acknowledging their issue, then move straight to helping.
- 2-3 sentences max. This is voice — short and clear wins. No lists, no markdown.
- Confirm understanding before acting ("So the charge appeared twice — let me check that").

## How you help
- Use what you know about this user and account from memory. Reference prior tickets/context when relevant.
- Give the concrete next step, not generic advice. If you need one detail to proceed, ask exactly one focused question.
- If you can't resolve it, say what you'll do next (escalate, follow up) and set a clear expectation.
- Never invent account facts, order numbers, or policy. If it's not in memory, say so and offer to find out.

## Tone
- Patient and reassuring under frustration. Acknowledge the emotion once, then fix the problem.`;

// Desired locked built-ins (seeded once per org).
function builtinSeeds() {
  return [
    { kind: 'external', name: 'Sales Agent', primary_prompt: DEFAULT_SYSTEM_PROMPT, secondary_prompt: DEFAULT_CLINICAL_PROMPT },
    { kind: 'external', name: 'Customer Support', primary_prompt: CUSTOMER_SUPPORT_PROMPT, secondary_prompt: DEFAULT_CLINICAL_PROMPT },
    { kind: 'internal', name: 'Voice of HIVEMIND', primary_prompt: DEFAULT_INTERNAL_PROMPT, secondary_prompt: null },
  ];
}

export class TaraSkillsStore {
  constructor({ memoryStore, configStore }) {
    this.store = memoryStore;
    this.configStore = configStore;
  }

  // ── Seed locked built-ins once per org (idempotent by kind+name) ──
  async ensureBuiltins({ userId, orgId } = {}) {
    const existing = await this._listRaw({ userId, orgId });
    const have = new Set(existing.map((s) => `${s.kind}:${s.name.toLowerCase()}`));
    for (const seed of builtinSeeds()) {
      if (have.has(`${seed.kind}:${seed.name.toLowerCase()}`)) continue;
      await this._write({ ...seed, builtin: true }, { userId, orgId });
    }
  }

  // ── Raw skill list (parsed memories) ──
  async _listRaw({ userId, orgId } = {}) {
    try {
      const { memories } = await this.store.listMemories({
        user_id: userId, org_id: orgId,
        tags: ['tara-skill'],
        limit: 200,
      });
      return (memories || []).map((m) => {
        try {
          const s = JSON.parse(m.content);
          s._memory_id = m.id;
          return s;
        } catch { return null; }
      }).filter(Boolean);
    } catch (err) {
      console.warn('[tara/skills] list failed:', err.message);
      return [];
    }
  }

  // ── Public list + current selection ──
  async list({ userId, orgId } = {}) {
    await this.ensureBuiltins({ userId, orgId });
    const skills = await this._listRaw({ userId, orgId });
    const config = await this.configStore.getConfig('default', 'default', { userId, orgId });
    // Sort: built-ins first, then by created_at.
    skills.sort((a, b) => (b.builtin === a.builtin ? String(a.created_at || '').localeCompare(String(b.created_at || '')) : (b.builtin ? 1 : -1)));
    return {
      skills,
      selected: {
        external_skill_id: config.selected_external_skill_id || null,
        internal_skill_id: config.selected_internal_skill_id || null,
      },
    };
  }

  async _write(skill, { userId, orgId } = {}) {
    const now = new Date().toISOString();
    const id = skill.id || crypto.randomUUID();
    const record = {
      id,
      kind: skill.kind === 'internal' ? 'internal' : 'external',
      name: String(skill.name || 'Untitled').slice(0, 80),
      primary_prompt: String(skill.primary_prompt || ''),
      secondary_prompt: skill.kind === 'internal' ? null : (skill.secondary_prompt || ''),
      builtin: !!skill.builtin,
      created_at: skill.created_at || now,
      updated_at: now,
    };
    await this.store.createMemory({
      id: crypto.randomUUID(),
      user_id: userId,
      org_id: orgId,
      project: 'tara/skills',
      content: JSON.stringify(record),
      title: `TARA Skill — ${record.name} (${record.kind})`,
      tags: ['tara-skill', `kind:${record.kind}`, `skill:${id}`, ...(record.builtin ? ['skill-builtin'] : [])],
      memory_type: 'tara_skill',
      document_date: now,
      metadata: { skill_id: id, kind: record.kind, builtin: record.builtin },
    });
    return record;
  }

  async create({ kind, name, primary_prompt, secondary_prompt }, { userId, orgId } = {}) {
    if (!name || !primary_prompt) throw new Error('name and primary_prompt are required');
    return this._write({ kind, name, primary_prompt, secondary_prompt, builtin: false }, { userId, orgId });
  }

  async _find(skillId, { userId, orgId } = {}) {
    const all = await this._listRaw({ userId, orgId });
    return all.find((s) => s.id === skillId) || null;
  }

  async update(skillId, fields, { userId, orgId } = {}) {
    const cur = await this._find(skillId, { userId, orgId });
    if (!cur) throw new Error('skill not found');
    if (cur.builtin) throw new Error('built-in skills cannot be edited');
    const merged = {
      ...cur,
      name: fields.name != null ? String(fields.name).slice(0, 80) : cur.name,
      primary_prompt: fields.primary_prompt != null ? String(fields.primary_prompt) : cur.primary_prompt,
      secondary_prompt: cur.kind === 'internal' ? null : (fields.secondary_prompt != null ? String(fields.secondary_prompt) : cur.secondary_prompt),
      updated_at: new Date().toISOString(),
    };
    await this.store.updateMemory(cur._memory_id, {
      content: JSON.stringify({ ...merged, _memory_id: undefined }),
    });
    return merged;
  }

  async remove(skillId, { userId, orgId } = {}) {
    const cur = await this._find(skillId, { userId, orgId });
    if (!cur) throw new Error('skill not found');
    if (cur.builtin) throw new Error('built-in skills cannot be deleted');
    await this.store.deleteMemory(cur._memory_id);
    return { removed: skillId };
  }

  // ── Select a skill → copy its prompts into the live config + persist choice ──
  async select(skillId, { userId, orgId } = {}) {
    const skill = await this._find(skillId, { userId, orgId });
    if (!skill) throw new Error('skill not found');
    const config = await this.configStore.getConfig('default', 'default', { userId, orgId });
    const patch = { ...config };
    delete patch._memory_id;
    if (skill.kind === 'external') {
      patch.system_prompt = skill.primary_prompt;
      patch.clinical_prompt = skill.secondary_prompt || '';
      patch.selected_external_skill_id = skill.id;
    } else {
      patch.internal_prompt = skill.primary_prompt;
      patch.selected_internal_skill_id = skill.id;
    }
    await this.configStore.saveConfig('default', 'default', patch, { userId, orgId });
    return { selected: skill.id, kind: skill.kind };
  }
}
