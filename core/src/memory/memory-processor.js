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

    const contentLength = (newMemory.content || '').length;
    const inputTokens = Math.ceil(contentLength / 4);
    // Scale output tokens with input — longer content needs more facts extracted
    const maxTokens = Math.max(300, Math.min(inputTokens + 500, 4000));

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
              content: `You are a memory engine. Quote the user's EXACT words as fact sentences. Do NOT paraphrase or summarize.

Output EXACTLY 6 sections:

RELATIONSHIP: ADD: new topic
PRIORITY: MEDIUM
OBSERVATION: 🟡 [one sentence about what user said]
ENTITIES: entity1, entity2
DATES: date1, date2
FACT_SENTENCES:
- I participated in a webinar on "Data Analysis using Python" two months ago
- I've been a member of 'Book Lovers Unite' for about two weeks now
- I just got back from the "Run for the Cure" event on October 15th

Rules:
- RELATIONSHIP: ADD/UPDATE/EXTEND/NOOP
- PRIORITY: HIGH/MEDIUM/LOW
- OBSERVATION: One sentence summary with 🔴/🟡/🟢. Write TRIVIAL if nothing.
- ENTITIES: Names, places, orgs, events from user's words. Write NONE if empty.
- DATES: ALL dates/times/durations the user mentioned (keep exact wording like "two months ago", "last Saturday", "October 15th", "for about two weeks"). Write NONE if empty.
- FACT_SENTENCES: Copy the user's EXACT sentences that contain personal facts. Keep their original wording — do NOT rephrase. Include dates, durations, event names exactly as the user wrote them. Only extract from "User:" parts, NEVER from "Assistant:" parts. Extract ALL factual statements the user made — do not limit or summarize, include every personal fact from every turn. Write NONE if no personal facts.

CRITICAL RULES:
1. QUOTE the user's exact words. "I've been a member for two weeks" stays as-is.
2. Only extract STATEMENTS, never questions. "Can you suggest ways to minimize distractions?" is a QUESTION — skip it.
3. Look for: "I did X", "I attended X", "I've been X", "I got X", "I just came back from X", "I booked X", "I participated in X".
4. Skip turns where the user only asks questions with no personal facts.
5. If a turn has no personal statements, write FACT_SENTENCES: NONE.`
            },
            {
              role: 'user',
              // Scale content limit with input size — don't truncate short content, allow more for long sessions
              content: hasSimilar
                ? `EXISTING MEMORIES:\n${existingContext}\n\nNEW MEMORY:\n${(newMemory.content || '').slice(0, 16000)}`
                : `NEW MEMORY:\n${(newMemory.content || '').slice(0, 16000)}`
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

    // Parse FACT_SENTENCES
    let factSentences = [];
    const factStartIdx = lines.findIndex(l => /^[-*\s]*FACT.?SENTENCES?\s*[:\-]/i.test(l));
    if (factStartIdx >= 0) {
      for (let k = factStartIdx + 1; k < lines.length; k++) {
        const line = lines[k].trim();
        if (line.startsWith('- ') || line.startsWith('* ')) {
          const fact = line.replace(/^[-*]\s*/, '').trim();
          if (fact.length > 10 && fact !== 'NONE') factSentences.push(fact);
        } else if (/^[A-Z_]+[:\s]/i.test(line)) {
          break; // Hit next section
        }
      }
    }

    // Fallback: extract fact sentences from observation text
    if (factSentences.length === 0 && observation) {
      factSentences = observation.split(/[.!]/).map(s => s.trim()).filter(s => s.length > 15).slice(0, 3);
    }

    return { relationship, observation, facts: { entities, dates }, factSentences, priority };
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

    // Extract from USER content only (not assistant recommendations)
    // For session-based content with multiple User:/Assistant: turns, extract ALL user parts
    const rawContent = newMemory.content || '';
    const userPart = rawContent.split('\n')
      .filter(line => /^User:/i.test(line.trim()))
      .map(line => line.replace(/^User:\s*/i, ''))
      .join('\n') || rawContent;

    let entities = [];
    const properNouns = userPart.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
    if (properNouns) {
      entities = [...new Set(properNouns)].slice(0, 5);
    }

    // Extract dates from USER content only
    let dates = [];
    const contentDates = userPart.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/gi);
    if (contentDates) {
      dates = [...new Set(contentDates.map(d => d.trim()))].slice(0, 5);
    }

    // Extract fact STATEMENTS from USER content (skip questions)
    // For long content (sessions), extract ALL user turns — each may contain facts
    let factSentences = [];
    // Split by "User:" to handle multi-turn sessions
    const userTurns = userPart.split(/\nUser:\s*/i).filter(t => t.length > 10);
    for (const turn of userTurns) {
      const sentences = turn.replace(/^User:\s*/i, '').split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 15);
      const factIndicators = /\b(I|my|me|we|our|I'm|I've|I'll|name|live|work|plan|visit|stay|born|moved|started|joined|bought|attended|participated|favorite|prefer|got|booked|recently|just)\b/i;
      for (const s of sentences) {
        if (s.includes('?') || /^(can|could|do|does|would|should|what|how|where|when|why|is|are)\b/i.test(s)) continue;
        if (factIndicators.test(s)) {
          factSentences.push(s);
        }
      }
    }
    // Scale max facts with content length — longer content gets more facts
    const maxFacts = Math.max(5, Math.min(Math.ceil(rawContent.length / 500), 50));
    factSentences = factSentences.slice(0, maxFacts);

    return { relationship, observation: null, facts: { entities, dates }, factSentences, priority };
  }
}
