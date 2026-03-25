/**
 * round-splitter.js
 *
 * Splits a conversation message array into per-turn "rounds", where each round
 * is one user message paired with the following assistant response. This enables
 * per-turn memory granularity for better retrieval on LongMemEval benchmarks.
 */

/**
 * Split an array of conversation messages into round objects.
 *
 * @param {Array<{role: string, content: string, timestamp?: string}>} messages
 * @returns {Array<{content: string, roundIndex: number, userContent: string, assistantContent: string, timestamp?: string}>}
 */
export function splitIntoRounds(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Filter out system messages
  const filtered = messages.filter((m) => m.role !== 'system');

  const rounds = [];
  let roundIndex = 0;
  let i = 0;

  while (i < filtered.length) {
    const msg = filtered[i];

    if (msg.role === 'user') {
      const userContent = msg.content;
      const timestamp = msg.timestamp;

      // Look ahead for the next assistant message
      let assistantContent = '';
      if (i + 1 < filtered.length && filtered[i + 1].role === 'assistant') {
        assistantContent = filtered[i + 1].content;
        i += 2; // consume both user and assistant
      } else {
        i += 1; // orphan user message, advance past it only
      }

      const round = {
        content: `User: ${userContent}\nAssistant: ${assistantContent}`,
        roundIndex,
        userContent,
        assistantContent,
      };

      if (timestamp !== undefined) {
        round.timestamp = timestamp;
      }

      rounds.push(round);
      roundIndex++;
    } else {
      // Orphan assistant message (no preceding user) — skip
      i += 1;
    }
  }

  return rounds;
}
