/**
 * round-splitter.js
 *
 * Splits a conversation message array into per-turn "rounds", where each round
 * is one user message paired with the following assistant response. This enables
 * per-turn memory granularity for better retrieval on LongMemEval benchmarks.
 */

const PARA_SPLIT_RE = /\n\s*\n+/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;

function splitContentIntoBlocks(content = '') {
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [''];
  }

  const paragraphs = normalized
    .split(PARA_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);

  const blocks = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);

    if (lines.length > 1 && lines.every((line) => LIST_ITEM_RE.test(line))) {
      blocks.push(...lines);
      continue;
    }

    blocks.push(paragraph);
  }

  return blocks.length > 0 ? blocks : [''];
}

/**
 * Split an array of conversation messages into round objects.
 *
 * The splitter keeps the original user/assistant turn structure, but it also
 * breaks multi-paragraph or list-style assistant replies into smaller memory
 * chunks so downstream retrieval can land on a tighter factual slice.
 *
 * @param {Array<{role: string, content: string, timestamp?: string}>} messages
 * @returns {Array<{content: string, roundIndex: number, userContent: string, assistantContent: string, timestamp?: string, assistantSegmentIndex?: number, assistantSegmentCount?: number}>}
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

      const assistantBlocks = splitContentIntoBlocks(assistantContent);
      const assistantSegmentCount = assistantBlocks.length;

      for (let assistantSegmentIndex = 0; assistantSegmentIndex < assistantSegmentCount; assistantSegmentIndex++) {
        const assistantBlock = assistantBlocks[assistantSegmentIndex] || '';
        const round = {
          content: `User: ${userContent}\nAssistant: ${assistantBlock}`,
          roundIndex,
          userContent,
          assistantContent: assistantBlock,
        };

        if (assistantSegmentCount > 1) {
          round.assistantSegmentIndex = assistantSegmentIndex;
          round.assistantSegmentCount = assistantSegmentCount;
        }

        if (timestamp !== undefined) {
          round.timestamp = timestamp;
        }

        rounds.push(round);
        roundIndex++;
      }
    } else {
      // Orphan assistant message (no preceding user) — skip
      i += 1;
    }
  }

  return rounds;
}
