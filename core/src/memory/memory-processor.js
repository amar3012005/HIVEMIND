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
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `You are a memory engine processor. You MUST output EXACTLY 5 lines. Analyze the NEW memory and output:

RELATIONSHIP: ADD: new topic
PRIORITY: MEDIUM
OBSERVATION: 🟡 User did something
ENTITIES: entity1, entity2
DATES: date1, date2

Rules for each line:
- RELATIONSHIP: One of ADD/UPDATE/EXTEND/NOOP with reason
- PRIORITY: HIGH (personal facts), MEDIUM (events/preferences), LOW (casual)
- OBSERVATION: 1-2 sentence summary with emoji 🔴/🟡/🟢. Write TRIVIAL if nothing notable.
- ENTITIES: Comma-separated people, places, orgs, products, activities, events. Write NONE if empty.
- DATES: Comma-separated dates/times mentioned (exact or relative like "two months ago"). Write NONE if empty.

IMPORTANT: You MUST output all 5 lines. Never skip any line.`
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
        }),
      });

      if (!resp.ok) throw new Error(`Groq ${resp.status}`);
      const data = await resp.json();
      const output = (data.choices[0]?.message?.content || '')
        .replace(/[\uD800-\uDFFF]/g, '').replace(/\x00/g, '').trim();


      return this._parseOutput(output, similarMemories, newMemory.content);
    } catch (err) {
      console.warn('[memory-processor] LLM failed, using heuristic:', err.message);
      return this._heuristicProcess(newMemory, similarMemories);
    }
  }

  _parseOutput(output, similarMemories, originalContent) {
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

    // Parse ENTITIES (tolerant: handles bullets, lowercase, extra spacing)
    let entities = [];
    const entLine = lines.find(l => /^[-*\s]*ENTITIES\s*[:\-]/i.test(l));
    if (entLine) {
      const raw = entLine.replace(/^[-*\s]*ENTITIES\s*[:\-]\s*/i, '').trim();
      if (raw && raw.toUpperCase() !== 'NONE') {
        entities = raw.split(',').map(e => e.trim()).filter(Boolean);
      }
    }

    // Parse DATES (tolerant: handles bullets, lowercase, extra spacing)
    let dates = [];
    const dateLine = lines.find(l => /^[-*\s]*DATES\s*[:\-]/i.test(l));
    if (dateLine) {
      const raw = dateLine.replace(/^[-*\s]*DATES\s*[:\-]\s*/i, '').trim();
      if (raw && raw.toUpperCase() !== 'NONE') {
        dates = raw.split(',').map(d => d.trim()).filter(Boolean);
      }
    }

    // Fallback: extract entities and dates from the full LLM output text
    if (entities.length === 0 && dates.length === 0) {
      const quotedEntities = output.match(/['"]([^'"]{3,50})['"]/g);
      if (quotedEntities) {
        entities = quotedEntities.map(q => q.replace(/['"]/g, '').trim()).slice(0, 5);
      }

      const datePatterns = output.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/gi);
      if (datePatterns) {
        dates = [...new Set(datePatterns.map(d => d.trim()))].slice(0, 5);
      }
    }

    // Last resort: extract from original memory content
    if (entities.length === 0) {
      const properNouns = (originalContent || '').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
      if (properNouns) {
        entities = [...new Set(properNouns)].slice(0, 5);
      }
    }

    if (dates.length === 0) {
      const contentDates = (originalContent || '').match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/gi);
      if (contentDates) {
        dates = [...new Set(contentDates.map(d => d.trim()))].slice(0, 5);
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

    // Extract entities from original content (proper nouns)
    let entities = [];
    const rawContent = newMemory.content || '';
    const properNouns = rawContent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
    if (properNouns) {
      entities = [...new Set(properNouns)].slice(0, 5);
    }

    // Extract dates from original content
    let dates = [];
    const contentDates = rawContent.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/gi);
    if (contentDates) {
      dates = [...new Set(contentDates.map(d => d.trim()))].slice(0, 5);
    }

    return { relationship, observation: null, facts: { entities, dates }, priority };
  }
}
