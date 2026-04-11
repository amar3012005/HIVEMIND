/**
 * Unified Memory Processor
 *
 * Single LLM call that outputs:
 * 1. Relationship classification (ADD/UPDATE/EXTEND/DERIVE/NOOP)
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
              content: `You are a memory engine that extracts factual information from content. Extract key facts as standalone sentences.

Output EXACTLY 6 sections:

RELATIONSHIP: ADD: new topic
PRIORITY: MEDIUM
OBSERVATION: 🟡 [one sentence summary of the content]
ENTITIES: entity1, entity2
DATES: date1, date2
FACT_SENTENCES:
- SolvisLino is a pellet heating system manufactured by SOLVIS
- Gabriele Münzer is the Geschäftsführerin (managing director) of SOLVIS
- The system supports temperatures up to 85°C

Rules:
- RELATIONSHIP: ADD/UPDATE/EXTEND/DERIVE/NOOP
- PRIORITY: HIGH/MEDIUM/LOW
- OBSERVATION: One sentence summary with 🔴/🟡/🟢. Write TRIVIAL if nothing noteworthy.
- ENTITIES: Names of people, companies, products, places, technologies. Write NONE if empty.
- DATES: ALL dates/times/durations mentioned. Write NONE if empty.
- FACT_SENTENCES: Extract specific, standalone facts from the content. Each fact should be a complete sentence that makes sense on its own.

CRITICAL RULES:
1. Extract FACTS from the content — product names, people's names/roles, specifications, decisions, events.
2. For documents/PDFs: extract the actual information (product specs, company info, people mentioned), NOT meta-commentary about the document.
3. NEVER write "The user provided/discussed/shared/mentioned..." — these are useless meta-observations. Extract the ACTUAL facts instead.
4. NEVER write "no personal facts were found" or similar — just write NONE.
5. For conversations with "User:" turns: quote the user's exact factual statements.
6. For documents without "User:" turns: extract key facts, names, products, specifications, and relationships from the document content.
7. Skip questions — only extract statements and facts.
8. If the content has no extractable facts, write FACT_SENTENCES: NONE. Do NOT invent meta-commentary.`
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
    let relationship = { action: 'ADD', targetId: null, sourceIds: [], reason: 'default' };
    const relLine = lines.find(l => /^(ADD|UPDATE|EXTEND|DERIVE|NOOP)[:\s]/i.test(l));
    if (relLine) {
      const match = relLine.match(/^(ADD|UPDATE|EXTEND|DERIVE|NOOP)[:\s]+(?:\[?([^\]]*)\]?)?\s*(.*)/i);
      if (match) {
        relationship.action = match[1].toUpperCase();
        const idOrReason = (match[2] || '').trim();
        relationship.reason = (match[3] || idOrReason || '').trim();
        // Try to match the ID against similar memories
        if (relationship.action === 'UPDATE' || relationship.action === 'EXTEND') {
          const target = similarMemories.find(m => idOrReason.includes(m.id));
          relationship.targetId = target?.id || similarMemories[0]?.id || null;
        } else if (relationship.action === 'DERIVE') {
          const idMatches = [...new Set([
            ...similarMemories
              .filter(m => idOrReason.includes(m.id))
              .map(m => m.id),
            ...similarMemories.slice(0, 3).map(m => m.id),
          ])];
          relationship.sourceIds = idMatches.length > 0 ? idMatches : similarMemories.slice(0, 2).map(m => m.id);
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
    const synthesisWords = /\b(based on|combining|combined|synthes(?:e|is|ized)|from (?:multiple )?sources?|overall|in summary|therefore|thus|together|cross[- ]reference|synthesizing)\b/i;

    let relationship = { action: 'ADD', targetId: null, sourceIds: [], reason: 'heuristic' };
    if (similarMemories.length > 0 && changeWords.test(content)) {
      relationship = { action: 'UPDATE', targetId: similarMemories[0].id, reason: 'change_words' };
    } else if (similarMemories.length >= 2 && synthesisWords.test(content)) {
      relationship = {
        action: 'DERIVE',
        sourceIds: similarMemories.slice(0, 3).map(memory => memory.id),
        reason: 'synthesis_words',
      };
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
