// Optional: if payload.filepath is given AND Docling is reachable, pull
// structural hybrid chunks. Caller can disable by passing
// payload.skip_docling=true. Failure is non-fatal — we fall back to the
// page/content data the caller provided.
async function tryDoclingHybridChunks(payload) {
  if (!payload.filepath || payload.skip_docling) return null;
  if (process.env.DOCLING_CHUNKER_ENABLED === 'false') return null;
  try {
    const { chunkWithDocling } = await import('../../knowledge/enterprise/docling-adapter.js');
    const { chunks, error } = await chunkWithDocling(payload.filepath, payload.file_name || 'document.pdf');
    if (error || !Array.isArray(chunks) || chunks.length === 0) return null;
    return chunks.map((c) => ({
      text: c.text,
      page: c.page,
      headings: c.headings || [],
      num_tokens: c.meta?.num_tokens || null,
    }));
  } catch (_err) {
    return null;
  }
}

async function extractPdf(payload) {
  const pages = Array.isArray(payload.pages)
    ? payload.pages.map((page, index) => ({
        page_number: page.page_number || index + 1,
        content: String(page.content || ''),
      }))
    : [{ page_number: 1, content: String(payload.content || '') }];

  const structural_chunks = await tryDoclingHybridChunks(payload);

  return {
    title: payload.title || payload.file_name || 'PDF document',
    language: payload.language || 'text',
    pages,
    content: pages.map((page) => page.content).join('\n\n'),
    structural_chunks,
    metadata: {
      ...payload.metadata,
      extraction_method: structural_chunks ? 'docling-hybrid' : 'pymupdf-compatible',
      page_count: pages.length,
      structural_chunk_count: structural_chunks ? structural_chunks.length : 0,
    },
  };
}

module.exports = {
  extractPdf,
};
