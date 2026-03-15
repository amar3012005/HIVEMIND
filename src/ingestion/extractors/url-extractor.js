const { extractText } = require('./text-extractor');

function stripHtml(raw = '') {
  return String(raw)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractUrl(payload) {
  if (!payload.content && !payload.html && !payload.url) {
    return extractText(payload);
  }

  const normalized = stripHtml(payload.content || payload.html || '');
  const title = payload.title || payload.url || 'URL document';

  return {
    title,
    language: payload.language || 'text',
    pages: [{ page_number: 1, content: normalized }],
    content: normalized,
    metadata: {
      ...payload.metadata,
      url: payload.url,
      extraction_method: payload.content || payload.html ? 'provided-html' : 'playwright-readability-fallback',
    },
  };
}

module.exports = {
  extractUrl,
};
