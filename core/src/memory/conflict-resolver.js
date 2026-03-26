/**
 * LLM Conflict Resolver
 *
 * Compares a new memory against existing similar memories
 * and classifies the relationship: ADD, UPDATE, NOOP, EXTEND.
 * Uses Groq openai/gpt-oss-20b with include_reasoning: false.
 */

export class ConflictResolver {
  constructor(options = {}) {
    this.groqApiKey = options.groqApiKey || process.env.GROQ_API_KEY;
  }

  /**
   * Resolve conflict between new and existing memory.
   * @param {object} newMemory - { content, title, tags }
   * @param {object} existingMemory - { id, content, title, tags }
   * @returns {Promise<{action: 'ADD'|'UPDATE'|'NOOP'|'EXTEND', reason: string, targetId: string|null}>}
   */
  async resolve(newMemory, existingMemory) {
    if (!this.groqApiKey) {
      // No LLM — fall back to heuristic
      return this._heuristicResolve(newMemory, existingMemory);
    }

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
              content: `You are a memory conflict resolver. Compare an EXISTING memory with a NEW memory and classify the relationship.

Output EXACTLY one of:
- UPDATE: The new memory supersedes/corrects the existing one (e.g., preference changed, fact updated, status changed)
- EXTEND: The new memory adds additional details to the same topic (not contradicting)
- NOOP: The new memory is semantically identical (exact duplicate, no new info)
- ADD: The memories are about different topics (low relationship)

Output format: ACTION: reason
Example: UPDATE: user changed favorite restaurant from Olive Garden to Cheesecake Factory`
            },
            {
              role: 'user',
              content: `EXISTING MEMORY:\n${(existingMemory.content || '').slice(0, 1000)}\n\nNEW MEMORY:\n${(newMemory.content || '').slice(0, 1000)}`
            }
          ],
          max_tokens: 500,
          temperature: 0,
          include_reasoning: false,
        }),
      });

      if (!resp.ok) throw new Error(`Groq ${resp.status}`);
      const data = await resp.json();
      const output = (data.choices[0]?.message?.content || '').replace(/[\uD800-\uDFFF]/g, '').trim();

      // Parse ACTION: reason
      const match = output.match(/^(UPDATE|EXTEND|NOOP|ADD):\s*(.+)/i);
      if (match) {
        return {
          action: match[1].toUpperCase(),
          reason: match[2].trim(),
          targetId: existingMemory.id,
        };
      }

      // Fallback: check if output starts with the action word
      for (const action of ['UPDATE', 'EXTEND', 'NOOP', 'ADD']) {
        if (output.toUpperCase().startsWith(action)) {
          return { action, reason: output, targetId: existingMemory.id };
        }
      }

      return this._heuristicResolve(newMemory, existingMemory);
    } catch (err) {
      console.warn('[conflict-resolver] LLM failed, using heuristic:', err.message);
      return this._heuristicResolve(newMemory, existingMemory);
    }
  }

  _heuristicResolve(newMemory, existingMemory) {
    // Simple heuristic: check for negation/change words
    const changeWords = /\b(changed|updated|now|new|switched|moved|no longer|instead|replaced|actually)\b/i;
    if (changeWords.test(newMemory.content || '')) {
      return { action: 'UPDATE', reason: 'change_words_detected', targetId: existingMemory.id };
    }
    return { action: 'ADD', reason: 'heuristic_default', targetId: null };
  }
}
