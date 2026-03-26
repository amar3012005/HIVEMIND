/**
 * Unified Memory Processor
 *
 * Single LLM call that outputs:
 * 1. Relationship classification (ADD/UPDATE/EXTEND/NOOP)
 * 2. Compressed observation
 * 3. Extracted facts (entities, dates, preferences)
 *
 * Replaces separate ConflictResolver + Observer calls.
 */

export class MemoryProcessor {
  constructor(options = {}) {
    this.groqApiKey = options.groqApiKey || process.env.GROQ_API_KEY;
  }

  /**
   * Process a new memory against existing similar memories.
   * @param {object} newMemory - { content, title, tags, document_date }
   * @param {object[]} similarMemories - TOP-K similar existing memories [{ id, content }]
   * @returns {Promise<{ relationship: {action, targetId, reason}, observation: string|null, facts: {entities, dates, preferences}, priority: string }>}
   */
  async process(newMemory, similarMemories = []) {
    if (!this.groqApiKey) {
      return this._heuristicProcess(newMemory, similarMemories);
    }

    const hasSimilar = similarMemories.length > 0;
    const existingContext = hasSimilar
      ? similarMemories.slice(0, 3).map((m, i) => `EXISTING_${i + 1} [id:${m.id}]:\n${(m.content || '').slice(0, 500)}`).join('\n\n')
      : '';

    const inputTokens = Math.ceil((newMemory.content || '').length / 4);
    const maxTokens = Math.max(200, Math.min(inputTokens + 400, 800));

    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            {
              role: 'system',
              content: `You are a memory engine processor. Analyze the NEW memory and output ALL of the following in a single response:

LINE 1 — RELATIONSHIP: Compare against existing memories (if any). Output exactly one of:
  ADD: [reason] — new topic, no relationship to existing
  UPDATE: [existing_id] [reason] — supersedes/corrects an existing memory
  EXTEND: [existing_id] [reason] — adds details to an existing topic
  NOOP: [reason] — exact semantic duplicate, no new information

LINE 2 — PRIORITY: Exactly one of: HIGH, MEDIUM, LOW
  HIGH = personal facts (name, job, address, family, finances, health)
  MEDIUM = preferences, events, decisions, plans
  LOW = generic questions, casual chat, greetings

LINE 3 — OBSERVATION: A dense 1-2 sentence summary of the key user facts. Use emoji: 🔴 (high), 🟡 (medium), 🟢 (low). If no memorable facts, write: TRIVIAL

LINE 4 — ENTITIES: Comma-separated list of key entities (people, places, orgs, products). If none, write: NONE

LINE 5 — DATES: Comma-separated dates mentioned. If none, write: NONE

Be concise. Never hallucinate facts not in the input.`
            },
            {
              role: 'user',
              content: hasSimilar
                ? `EXISTING MEMORIES:\n${existingContext}\n\nNEW MEMORY:\n${(newMemory.content || '').slice(0, 2000)}`
                : `NEW MEMORY:\n${(newMemory.content || '').slice(0, 2000)}`
            }
          ],
          max_tokens: maxTokens,
          temperature: 0,
          include_reasoning: false,
        }),
      });

      if (!resp.ok) throw new Error(`Groq ${resp.status}`);
      const data = await resp.json();
      const output = (data.choices[0]?.message?.content || '')
        .replace(/[\uD800-\uDFFF]/g, '').replace(/\x00/g, '').trim();

      return this._parseOutput(output, similarMemories);
    } catch (err) {
      console.warn('[memory-processor] LLM failed, using heuristic:', err.message);
      return this._heuristicProcess(newMemory, similarMemories);
    }
  }

  _parseOutput(output, similarMemories) {
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

    // Parse RELATIONSHIP
    let relationship = { action: 'ADD', targetId: null, reason: 'default' };
    const relLine = lines.find(l => /^(ADD|UPDATE|EXTEND|NOOP)[:\s]/i.test(l));
    if (relLine) {
      const match = relLine.match(/^(ADD|UPDATE|EXTEND|NOOP)[:\s]+(?:\[?([^\]]*)\]?)?\s*(.*)/i);
      if (match) {
        relationship.action = match[1].toUpperCase();
        const idOrReason = (match[2] || '').trim();
        relationship.reason = (match[3] || idOrReason || '').trim();
        // Try to match the ID against similar memories
        if (relationship.action === 'UPDATE' || relationship.action === 'EXTEND') {
          const target = similarMemories.find(m => idOrReason.includes(m.id));
          relationship.targetId = target?.id || similarMemories[0]?.id || null;
        }
      }
    }

    // Parse PRIORITY
    let priority = 'medium';
    const priLine = lines.find(l => /^(PRIORITY[:\s]|HIGH|MEDIUM|LOW)/i.test(l));
    if (priLine) {
      if (/HIGH/i.test(priLine)) priority = 'high';
      else if (/LOW/i.test(priLine)) priority = 'low';
    }

    // Parse OBSERVATION
    let observation = null;
    const obsLine = lines.find(l => /^(OBSERVATION[:\s]|🔴|🟡|🟢)/i.test(l));
    if (obsLine) {
      const cleaned = obsLine.replace(/^OBSERVATION[:\s]*/i, '').trim();
      if (cleaned && cleaned !== 'TRIVIAL' && cleaned.length > 5) {
        observation = cleaned;
      }
    }

    // Parse ENTITIES
    let entities = [];
    const entLine = lines.find(l => /^ENTITIES[:\s]/i.test(l));
    if (entLine) {
      const raw = entLine.replace(/^ENTITIES[:\s]*/i, '').trim();
      if (raw && raw !== 'NONE') {
        entities = raw.split(',').map(e => e.trim()).filter(Boolean);
      }
    }

    // Parse DATES
    let dates = [];
    const dateLine = lines.find(l => /^DATES[:\s]/i.test(l));
    if (dateLine) {
      const raw = dateLine.replace(/^DATES[:\s]*/i, '').trim();
      if (raw && raw !== 'NONE') {
        dates = raw.split(',').map(d => d.trim()).filter(Boolean);
      }
    }

    return { relationship, observation, facts: { entities, dates }, priority };
  }

  _heuristicProcess(newMemory, similarMemories) {
    const content = (newMemory.content || '').toLowerCase();
    const changeWords = /\b(changed|updated|now|new|switched|moved|no longer|instead|replaced|actually)\b/i;

    let relationship = { action: 'ADD', targetId: null, reason: 'heuristic' };
    if (similarMemories.length > 0 && changeWords.test(content)) {
      relationship = { action: 'UPDATE', targetId: similarMemories[0].id, reason: 'change_words' };
    }

    let priority = 'medium';
    if (/\b(my|i)\s+(name|job|work|live|born|salary|degree)\b/i.test(content)) priority = 'high';
    if (/\b(thanks|joke|hello|hi|bye)\b/i.test(content)) priority = 'low';

    return { relationship, observation: null, facts: { entities: [], dates: [] }, priority };
  }
}
