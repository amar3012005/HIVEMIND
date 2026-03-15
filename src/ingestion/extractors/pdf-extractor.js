async function extractPdf(payload) {
  const pages = Array.isArray(payload.pages)
    ? payload.pages.map((page, index) => ({
        page_number: page.page_number || index + 1,
        content: String(page.content || ''),
      }))
    : [{ page_number: 1, content: String(payload.content || '') }];

  return {
    title: payload.title || payload.file_name || 'PDF document',
    language: payload.language || 'text',
    pages,
    content: pages.map((page) => page.content).join('\n\n'),
    metadata: {
      ...payload.metadata,
      extraction_method: 'pymupdf-compatible',
      page_count: pages.length,
    },
  };
}

module.exports = {
  extractPdf,
};
