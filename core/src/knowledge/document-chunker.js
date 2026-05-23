/**
 * Document Chunker
 *
 * Parses uploaded files (PDF, DOCX, TXT, MD, CSV) and splits them into
 * structured memory chunks using recursive semantic splitting.
 *
 * PDFs use a layout-aware extraction pass with OCR fallback for sparse
 * or image-only pages before chunking.
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
    return extractPdfDocument(buffer, filename);
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

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatPdfTable(table, tableIndex = 0) {
  if (!Array.isArray(table) || table.length === 0) return '';

  const rows = table
    .map((row) => (Array.isArray(row) ? row.map((cell) => normalizeExtractedText(cell)).filter(Boolean) : []))
    .filter((row) => row.length > 0);

  if (rows.length === 0) return '';

  return [`Table ${tableIndex + 1}`, ...rows.map((row) => row.join(' | '))].join('\n');
}

function mergePdfPageContent(pageText, tables = []) {
  const parts = [];
  const normalizedText = normalizeExtractedText(pageText);

  if (normalizedText) {
    parts.push(normalizedText);
  }

  const formattedTables = tables
    .map((table, index) => formatPdfTable(table, index))
    .filter(Boolean);

  if (formattedTables.length > 0) {
    parts.push(['Tables', ...formattedTables].join('\n\n'));
  }

  return parts.join('\n\n').trim();
}

async function ocrPdfPages(parser, pageNumbers, filename) {
  if (!pageNumbers.length) return new Map();

  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch (err) {
    console.warn(
      `[knowledge] OCR dependency unavailable for ${filename || 'document'}: ${err.message}`
    );
    return new Map();
  }

  let worker;
  try {
    worker = await createWorker('eng');
  } catch (err) {
    console.warn(
      `[knowledge] OCR worker initialization failed for ${filename || 'document'}: ${err.message}`
    );
    return new Map();
  }

  const ocrPages = new Map();

  try {
    const screenshot = await parser.getScreenshot({
      partial: pageNumbers,
      scale: 3,
      imageDataUrl: false,
      imageBuffer: true,
    });

    for (const page of screenshot.pages || []) {
      const image = page.data || page.image || page.bitmap;
      if (!image) continue;

      const bufferImage = Buffer.isBuffer(image) ? image : Buffer.from(image);
      const result = await worker.recognize(bufferImage, { rotateAuto: true });
      const text = normalizeExtractedText(result?.data?.text || '');
      if (text) {
        ocrPages.set(page.pageNumber || page.num, text);
      }
    }
  } catch (err) {
    console.warn(`[knowledge] OCR fallback failed for ${filename || 'document'}: ${err.message}`);
  } finally {
    await worker.terminate().catch(() => {});
  }

  return ocrPages;
}

function chunkPdfPages(pages) {
  const chunks = [];
  for (const page of pages) {
    const pageChunks = chunkText(page.content);
    for (const chunk of pageChunks) {
      chunks.push({
        text: chunk.text,
        index: chunks.length,
        page_number: page.page_number,
        page_label: page.page_label || null,
        table_count: page.table_count || 0,
      });
    }
  }
  return chunks;
}

async function extractPdfDocument(buffer, filename) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });

  try {
    const [info, textResult, tableResult] = await Promise.all([
      parser.getInfo({ parsePageInfo: true }).catch(() => null),
      parser.getText({
        parsePageInfo: true,
        parseHyperlinks: true,
        lineEnforce: true,
        cellSeparator: ' | ',
        itemJoiner: ' ',
      }).catch(() => null),
      parser.getTable().catch(() => null),
    ]);

    const textPages = new Map((textResult?.pages || []).map((page) => [page.num, normalizeExtractedText(page.text)]));
    const tablePages = new Map((tableResult?.pages || []).map((page) => [page.num, page.tables || []]));
    const totalPages = info?.total || textResult?.total || tableResult?.total || Math.max(
      0,
      ...(textResult?.pages || []).map((page) => page.num),
      ...(tableResult?.pages || []).map((page) => page.num),
    );
    const infoPages = info?.pages || [];

    const lowTextPages = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const existing = textPages.get(pageNumber) || '';
      if (existing.length < 40) {
        lowTextPages.push(pageNumber);
      }
    }

    const ocrPages = lowTextPages.length > 0
      ? await ocrPdfPages(parser, lowTextPages, filename)
      : new Map();

    const pages = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const pageText = textPages.get(pageNumber) || '';
      const tables = tablePages.get(pageNumber) || [];
      const ocrText = ocrPages.get(pageNumber) || '';
      const content = mergePdfPageContent([pageText, ocrText].filter(Boolean).join('\n\n'), tables);
      const pageInfo = infoPages.find((page) => page.pageNumber === pageNumber);

      pages.push({
        page_number: pageNumber,
        page_label: pageInfo?.pageLabel || null,
        content,
        text: pageText,
        ocr_text: ocrText,
        tables,
        table_count: tables.length,
        text_length: (pageText + ocrText).length,
      });
    }

    const text = pages.map((page) => page.content).filter(Boolean).join('\n\n');
    const totalTables = pages.reduce((sum, page) => sum + (page.table_count || 0), 0);
    const totalTextChars = pages.reduce((sum, page) => sum + (page.text_length || 0), 0);
    const ocrPageCount = pages.filter((page) => page.ocr_text && page.ocr_text.length > 0).length;

    return {
      text,
      pages,
      metadata: {
        title: info?.info?.Title || filename,
        author: info?.info?.Author || null,
        pages: totalPages || null,
        page_labels: infoPages.map((page) => page.pageLabel || null).filter(Boolean),
        links: infoPages.flatMap((page) => (page.links || []).map((link) => ({
          page_number: page.pageNumber,
          text: link.text,
          url: link.url,
        }))),
        outline: info?.outline || null,
        extraction_method: 'pdf-parse-layout',
        ocr_fallback_pages: ocrPageCount,
        page_count: totalPages || null,
        table_count: totalTables,
        text_char_count: totalTextChars,
      },
    };
  } catch (err) {
    throw new Error(`PDF extraction failed for ${filename || 'document'}: ${err.message}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
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
export function buildDocumentPayloads(parsed, mimeType, filename, context = {}) {
  const { text, metadata = {}, pages: extractedPages = [] } = parsed || {};
  // Ensure text is always a string
  let docText = typeof text === 'string' ? text : String(text?.text || text || '');
  const normalizedText = docText.trim();
  const lowerFilename = String(filename || '').toLowerCase();
  const isPdf = mimeType === 'application/pdf' || lowerFilename.endsWith('.pdf');
  const hasExtractedPageContent = extractedPages.some(
    (page) => typeof page?.content === 'string' && page.content.trim().length > 0
  );
  let parseWarning = null;

  // Use the new chunking logic that handles sparse/scanned PDFs gracefully
  if (!normalizedText || normalizedText.length < 10) {
    if (isPdf && (metadata.pages || extractedPages.length > 0)) {
      parseWarning = 'pdf_text_unavailable';
      docText = [
        `Scanned PDF uploaded: ${filename || 'Untitled PDF'}.`,
        'Direct text extraction was unavailable for this document.',
        'The file is stored in the knowledge base, but its content may require OCR-enabled processing for full-text recall.',
      ].join('\n');
    } else {
      throw new Error('Document appears to be empty or could not be parsed');
    }
  }

  const sections = extractSections(docText);
  let chunks = hasExtractedPageContent
    ? chunkPdfPages(extractedPages)
    : chunkText(docText);
  if (!chunks.length) {
    chunks = chunkText(docText);
  }
  const docTitle = metadata.title || filename || 'Untitled Document';
  // Always tag with the original filename so recall can find the doc by
  // exact filename regardless of stemmer / vector strength.
  // Pattern: `filename:<original-with-extension>`.
  const filenameTag = filename ? `filename:${filename}` : null;
  const baseTags = [
    'knowledge-base',
    'document',
    ...(filenameTag ? [filenameTag] : []),
    ...(context.tags || []),
  ];

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
      table_count: metadata.table_count || 0,
      ocr_fallback_pages: metadata.ocr_fallback_pages || 0,
      parse_warning: parseWarning,
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
      : chunk.page_number
        ? `${docTitle} — Page ${chunk.page_number}`
        : `${docTitle} — Part ${idx + 1}`;

    return {
      content: chunk.text,
      title: chunkTitle,
      tags: [
        ...baseTags,
        ...(section ? [`section:${section.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`] : []),
        ...(chunk.page_number ? [`page:${chunk.page_number}`] : []),
      ],
      memory_type: 'fact',
      source: 'knowledge-base',
      source_metadata: {
        source_type: 'document-upload',
        source_platform: 'knowledge-base',
        source_id: `doc:${filename}:chunk:${idx}`,
        filename,
        chunk_index: idx,
        total_chunks: chunks.length,
        page_number: chunk.page_number || null,
        page_label: chunk.page_label || null,
      },
      metadata: {
        document_title: docTitle,
        chunk_index: idx,
        total_chunks: chunks.length,
        section: section?.title || null,
        section_level: section?.level || null,
        page_number: chunk.page_number || null,
        page_label: chunk.page_label || null,
        table_count: chunk.table_count || 0,
        parse_warning: parseWarning,
      },
      project: context.project || null,
      visibility: context.visibility || 'private',
      user_id: context.user_id,
      org_id: context.org_id,
    };
  });

  return { summary, chunks: chunkPayloads };
}

export async function processDocument(buffer, mimeType, filename, context = {}) {
  const parsed = await parseFile(buffer, mimeType, filename);
  return buildDocumentPayloads(parsed, mimeType, filename, context);
}

export {
  chunkPdfPages,
  formatPdfTable,
  mergePdfPageContent,
  normalizeExtractedText,
};
