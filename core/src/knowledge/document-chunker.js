/**
 * Document Chunker
 *
 * Parses uploaded files (PDF, DOCX, TXT, MD, CSV) and splits them into
 * structured memory chunks using recursive semantic splitting.
 *
 * Architecture per NotebookLM:
 *   - Recursive split-then-merge with semantic boundaries
 *   - 512-1024 token chunks (default 800 chars ≈ ~200 tokens)
 *   - Document-level summary + per-chunk memories
 *   - Metadata extraction: title, headings, section hierarchy
 *
 * @module knowledge/document-chunker
 */

// ── Chunk configuration ──────────────────────────────────

const CHUNK_CONFIG = {
  targetSize: 800,      // chars per chunk (~200 tokens)
  maxSize: 1600,        // hard max before forced split
  minSize: 100,         // skip chunks smaller than this
  overlapSize: 80,      // chars of overlap between adjacent chunks
};

// ── File parsers ─────────────────────────────────────────

/**
 * Parse a file buffer into raw text based on mime type.
 */
export async function parseFile(buffer, mimeType, filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase();

  // PDF
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    await parser.load();
    const textResult = await parser.getText();
    // getText() returns { pages: [...], text: string, total: number }
    const text = typeof textResult === 'string' ? textResult : (textResult?.text || '');
    const info = await parser.getInfo().catch(() => ({}));
    // getInfo() returns { total, info: { PDFFormatVersion, ... }, metadata, ... }
    return {
      text: String(text),
      metadata: {
        pages: info?.total || textResult?.total || null,
        title: info?.info?.Title || filename,
        author: info?.info?.Author || null,
      },
    };
  }

  // DOCX
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const mammothMod = await import('mammoth');
    const mammoth = mammothMod.default || mammothMod;
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: String(result?.value || ''),
      metadata: { title: filename },
    };
  }

  // CSV
  if (mimeType === 'text/csv' || ext === 'csv') {
    const text = buffer.toString('utf-8');
    const lines = text.split('\n');
    const headers = lines[0] || '';
    return {
      text: String(text),
      metadata: {
        title: filename,
        headers: headers.split(',').map(h => h.trim()),
        rowCount: lines.length - 1,
      },
    };
  }

  // TXT, MD, and fallback
  const text = buffer.toString('utf-8');
  return {
    text: String(text),
    metadata: { title: filename },
  };
}

// ── Semantic splitting ───────────────────────────────────

/**
 * Split text into semantic chunks using recursive boundary detection.
 * Boundaries (in priority order): headings, double newlines, single newlines, sentences.
 */
export function chunkText(text, options = {}) {
  const {
    targetSize = CHUNK_CONFIG.targetSize,
    maxSize = CHUNK_CONFIG.maxSize,
    minSize = CHUNK_CONFIG.minSize,
    overlapSize = CHUNK_CONFIG.overlapSize,
  } = options;

  if (!text || text.length < minSize) {
    return text ? [{ text: text.trim(), index: 0 }] : [];
  }

  // Split by semantic boundaries
  const sections = splitBySections(text);
  const chunks = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const section of sections) {
    // If adding this section would exceed target, finalize current chunk
    if (currentChunk.length + section.length > targetSize && currentChunk.length >= minSize) {
      chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });

      // Overlap: carry last N chars into next chunk
      if (overlapSize > 0 && currentChunk.length > overlapSize) {
        currentChunk = currentChunk.slice(-overlapSize) + '\n' + section;
      } else {
        currentChunk = section;
      }
    } else {
      currentChunk += (currentChunk ? '\n' : '') + section;
    }

    // Force split if chunk exceeds max
    if (currentChunk.length > maxSize) {
      const forceSplit = forceSplitLargeChunk(currentChunk, targetSize);
      for (let i = 0; i < forceSplit.length - 1; i++) {
        chunks.push({ text: forceSplit[i].trim(), index: chunkIndex++ });
      }
      currentChunk = forceSplit[forceSplit.length - 1];
    }
  }

  // Final chunk
  if (currentChunk.trim().length >= minSize) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  } else if (currentChunk.trim().length > 0 && chunks.length > 0) {
    // Merge tiny final chunk with previous
    chunks[chunks.length - 1].text += '\n' + currentChunk.trim();
  } else if (currentChunk.trim().length > 0) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  }

  return chunks;
}

/**
 * Split text into logical sections by markdown headings, double newlines, etc.
 */
function splitBySections(text) {
  // Try splitting by markdown headings first
  const headingSplit = text.split(/(?=^#{1,4}\s)/m);
  if (headingSplit.length > 1) return headingSplit;

  // Fall back to double newlines (paragraphs)
  const paragraphs = text.split(/\n\s*\n/);
  if (paragraphs.length > 1) return paragraphs;

  // Fall back to single newlines
  const lines = text.split('\n');
  if (lines.length > 1) return lines;

  // Last resort: sentence split
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Force-split an oversized chunk by sentences.
 */
function forceSplitLargeChunk(text, targetSize) {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const parts = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > targetSize && current.length > 0) {
      parts.push(current);
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ── Section/heading extraction ───────────────────────────

/**
 * Extract section hierarchy from text (markdown headings).
 */
export function extractSections(text) {
  const sections = [];
  const headingRegex = /^(#{1,4})\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(text)) !== null) {
    sections.push({
      level: match[1].length,
      title: match[2].trim(),
      offset: match.index,
    });
  }
  return sections;
}

/**
 * Determine which section a chunk belongs to based on its position.
 */
export function getSectionForChunk(chunkText, sections, fullText) {
  const chunkOffset = fullText.indexOf(chunkText);
  if (chunkOffset < 0) return null;

  // Find the deepest heading before this chunk
  let bestSection = null;
  for (const section of sections) {
    if (section.offset <= chunkOffset) {
      bestSection = section;
    }
  }
  return bestSection;
}

// ── Document-level summary generation ────────────────────

/**
 * Generate a brief document summary from the first ~2000 chars.
 */
export function generateDocumentSummary(text, metadata) {
  const preview = text.slice(0, 2000);
  const sections = extractSections(text);
  const headings = sections.map(s => s.title).slice(0, 10);

  const parts = [
    `Document: ${metadata.title || 'Untitled'}`,
  ];

  if (metadata.author) parts.push(`Author: ${metadata.author}`);
  if (metadata.pages) parts.push(`Pages: ${metadata.pages}`);
  if (metadata.rowCount) parts.push(`Rows: ${metadata.rowCount}`);
  if (headings.length > 0) parts.push(`Sections: ${headings.join(', ')}`);

  // First paragraph as preview
  const firstParagraph = preview.split(/\n\s*\n/)[0]?.trim();
  if (firstParagraph && firstParagraph.length > 50) {
    parts.push('', firstParagraph.slice(0, 500));
  }

  return parts.join('\n');
}

// ── Main: Process document into memory payloads ──────────

/**
 * Process an uploaded document into structured memory payloads.
 *
 * @param {Buffer} buffer - File content
 * @param {string} mimeType - MIME type
 * @param {string} filename - Original filename
 * @param {object} context - { user_id, org_id, project, tags, visibility }
 * @returns {Promise<{ summary: object, chunks: object[] }>}
 */
export async function processDocument(buffer, mimeType, filename, context = {}) {
  const { text, metadata } = await parseFile(buffer, mimeType, filename);

  // Ensure text is always a string
  const docText = typeof text === 'string' ? text : String(text?.text || text || '');

  if (!docText || docText.trim().length < 10) {
    throw new Error('Document appears to be empty or could not be parsed');
  }

  const sections = extractSections(docText);
  const chunks = chunkText(docText);
  const docTitle = metadata.title || filename || 'Untitled Document';
  const baseTags = ['knowledge-base', 'document', ...(context.tags || [])];

  // Document summary memory
  const summary = {
    content: generateDocumentSummary(docText, metadata),
    title: `Document: ${docTitle}`,
    tags: [...baseTags, 'document-summary'],
    memory_type: 'fact',
    source: 'knowledge-base',
    source_metadata: {
      source_type: 'document-upload',
      source_platform: 'knowledge-base',
      source_id: `doc:${filename}`,
      filename,
      mime_type: mimeType,
    },
    metadata: {
      document_title: docTitle,
      total_chunks: chunks.length,
      total_chars: docText.length,
      pages: metadata.pages || null,
      author: metadata.author || null,
      sections: sections.map(s => s.title),
    },
    project: context.project || null,
    visibility: context.visibility || 'private',
    user_id: context.user_id,
    org_id: context.org_id,
  };

  // Per-chunk memories
  const chunkPayloads = chunks.map((chunk, idx) => {
    const section = getSectionForChunk(chunk.text, sections, docText);
    const chunkTitle = section
      ? `${docTitle} — ${section.title}`
      : `${docTitle} — Part ${idx + 1}`;

    return {
      content: chunk.text,
      title: chunkTitle,
      tags: [...baseTags, ...(section ? [`section:${section.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`] : [])],
      memory_type: 'fact',
      source: 'knowledge-base',
      source_metadata: {
        source_type: 'document-upload',
        source_platform: 'knowledge-base',
        source_id: `doc:${filename}:chunk:${idx}`,
        filename,
        chunk_index: idx,
        total_chunks: chunks.length,
      },
      metadata: {
        document_title: docTitle,
        chunk_index: idx,
        total_chunks: chunks.length,
        section: section?.title || null,
        section_level: section?.level || null,
      },
      project: context.project || null,
      visibility: context.visibility || 'private',
      user_id: context.user_id,
      org_id: context.org_id,
    };
  });

  return { summary, chunks: chunkPayloads };
}
