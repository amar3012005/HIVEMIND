async function extractConversation(payload) {
  const turns = Array.isArray(payload.turns)
    ? payload.turns.map((turn, index) => ({
        turn_index: index,
        role: turn.role || 'user',
        content: String(turn.content || ''),
      }))
    : [];

  const content = turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n');

  return {
    title: payload.title || 'Conversation',
    language: payload.language || 'text',
    pages: [{ page_number: 1, content }],
    turns,
    content,
    metadata: {
      ...payload.metadata,
      extraction_method: 'conversation-role-preserving',
    },
  };
}

module.exports = {
  extractConversation,
};
