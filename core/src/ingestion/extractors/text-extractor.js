async function extractText(payload) {
  return {
    title: payload.title || 'Untitled text document',
    language: payload.language || 'text',
    pages: [{ page_number: 1, content: String(payload.content || '') }],
    content: String(payload.content || ''),
    metadata: payload.metadata || {},
  };
}

module.exports = {
  extractText,
};
