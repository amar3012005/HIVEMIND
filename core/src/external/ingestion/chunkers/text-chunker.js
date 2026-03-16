function tokenizeApprox(text) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  return clean.split(/\s+/);
}

function chunkTokens(tokens, size, overlap) {
  if (tokens.length === 0) return [];

  const chunks = [];
  let cursor = 0;

  while (cursor < tokens.length) {
    const end = Math.min(tokens.length, cursor + size);
    const piece = tokens.slice(cursor, end).join(' ');
    chunks.push(piece);
    if (end === tokens.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }

  return chunks;
}

function chooseTextChunkConfig(document) {
  const title = String(document.title || '').toLowerCase();
  const sourceHint = String(document.metadata?.source_hint || '').toLowerCase();
  const technical = title.includes('api') || title.includes('spec') || title.includes('docs') || sourceHint === 'technical';

  if (technical) {
    return { size: 384, overlap: 50, strategy: 'technical-sliding-window' };
  }

  return { size: 512, overlap: 50, strategy: 'contextual-rag' };
}

function splitConversationTurns(document) {
  if (!Array.isArray(document.turns)) {
    return [];
  }

  return document.turns
    .map((turn) => ({
      content: `${turn.role}: ${turn.content}`,
      metadata: {
        role: turn.role,
        turn_index: turn.turn_index,
      },
    }))
    .filter((chunk) => chunk.content.trim().length > 0);
}

function chunkTextDocument(document) {
  const config = chooseTextChunkConfig(document);
  const tokens = tokenizeApprox(document.content);
  const slices = chunkTokens(tokens, config.size, config.overlap);

  return slices.map((content, index) => ({
    chunk_index: index,
    content,
    token_count: tokenizeApprox(content).length,
    metadata: {
      chunk_strategy: config.strategy,
      page_number: 1,
    },
  }));
}

module.exports = {
  tokenizeApprox,
  chunkTokens,
  chunkTextDocument,
  splitConversationTurns,
};
