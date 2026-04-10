/**
 * Enterprise Chunker
 *
 * Takes extracted schema fields and creates structured memory payloads:
 *   - 1 parent "schema memory" (document-level summary + extracted fields)
 *   - N child "chunk memories" (line items, clauses, sections, row groups, etc.)
 *
 * This is the final processing step before memories are ingested into HIVEMIND.
 *
 * @module knowledge/enterprise/enterprise-chunker
 */

import { generateTags, getSchema } from './schemas/index.js';
import { groupRows } from './excel-parser.js';

// ── Helpers ─────────────────────────────────────────────

/**
 * Build a human-readable title for the parent schema memory.
 */
function buildTitle(documentType, fields) {
  switch (documentType) {
    case 'invoice': {
      const suffix = fields.invoice_number || fields.date || '';
      return `Invoice: ${fields.vendor || 'Unknown Vendor'}${suffix ? ` \u2014 ${suffix}` : ''}`;
    }
    case 'contract':
      return `Contract: ${fields.document_title || 'Untitled Contract'}`;
    case 'sop': {
      const cat = fields.category ? ` \u2014 ${fields.category}` : '';
      return `${fields.title || 'SOP'}${cat}`;
    }
    case 'spreadsheet':
      return `Sheet: ${fields.sheet_name || 'Untitled Sheet'}`;
    case 'meeting': {
      const dt = fields.date ? ` \u2014 ${fields.date}` : '';
      return `Meeting: ${fields.title || 'Untitled Meeting'}${dt}`;
    }
    default:
      return fields.title || 'Document';
  }
}

/**
 * Simple semantic splitting for fallback chunking.
 * Splits by double newlines, then groups adjacent paragraphs until reaching targetSize chars.
 */
function semanticSplit(text, targetSize = 800) {
  if (!text || !text.trim()) return [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  if (paragraphs.length === 0) return [];

  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 > targetSize && current.length > 0) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Deduplicate a tags array while preserving order.
 */
function dedupeTags(tags) {
  return [...new Set(tags)];
}

// ── Chunk builders per document type ────────────────────

function buildInvoiceChunks(fields, rawText) {
  const chunks = [];

  // Header chunk with invoice metadata
  const headerParts = [];
  if (fields.vendor) headerParts.push(`Vendor: ${fields.vendor}`);
  if (fields.date) headerParts.push(`Date: ${fields.date}`);
  if (fields.due_date) headerParts.push(`Due Date: ${fields.due_date}`);
  if (fields.invoice_number) headerParts.push(`Invoice #: ${fields.invoice_number}`);
  if (fields.po_number) headerParts.push(`PO #: ${fields.po_number}`);
  if (fields.payment_terms) headerParts.push(`Payment Terms: ${fields.payment_terms}`);
  if (fields.total_amount != null) headerParts.push(`Total: ${fields.currency || ''} ${fields.total_amount}`);
  if (fields.tax_amount != null) headerParts.push(`Tax: ${fields.tax_amount}`);
  if (fields.billing_address) headerParts.push(`Billing Address: ${fields.billing_address}`);

  if (headerParts.length > 0) {
    chunks.push({
      content: headerParts.join('\n'),
      chunk_type: 'header',
      label: 'Header',
      fields: {
        vendor: fields.vendor,
        date: fields.date,
        due_date: fields.due_date,
        invoice_number: fields.invoice_number,
        payment_terms: fields.payment_terms,
      },
    });
  }

  // Line item chunks
  if (Array.isArray(fields.line_items) && fields.line_items.length > 0) {
    fields.line_items.forEach((item, i) => {
      const parts = [`Line Item ${i + 1}: ${item.description || 'N/A'}`];
      if (item.quantity != null) parts[0] += ` \u2014 Qty: ${item.quantity}`;
      if (item.unit_price != null) parts[0] += `, Unit Price: ${item.unit_price}`;
      if (item.amount != null) parts[0] += `, Amount: ${item.amount}`;

      chunks.push({
        content: parts[0],
        chunk_type: 'line_item',
        label: `Line Item ${i + 1}`,
        fields: item,
      });
    });
  } else {
    // Fallback to semantic chunking of rawText
    const splits = semanticSplit(rawText);
    splits.forEach((text, i) => {
      chunks.push({
        content: text,
        chunk_type: 'section',
        label: `Section ${i + 1}`,
        fields: {},
      });
    });
  }

  return chunks;
}

function buildContractChunks(fields, rawText) {
  if (Array.isArray(fields.clauses) && fields.clauses.length > 0) {
    return fields.clauses.map((clause, i) => {
      const parts = [`Clause: ${clause.title || `Clause ${i + 1}`}`];
      if (clause.type) parts.push(`Type: ${clause.type}`);
      parts.push('');
      parts.push(clause.content || '');

      return {
        content: parts.join('\n'),
        chunk_type: 'clause',
        label: clause.title || `Clause ${i + 1}`,
        fields: clause,
      };
    });
  }

  // Fallback
  return semanticSplit(rawText).map((text, i) => ({
    content: text,
    chunk_type: 'section',
    label: `Section ${i + 1}`,
    fields: {},
  }));
}

function buildSOPChunks(fields, rawText) {
  if (Array.isArray(fields.sections) && fields.sections.length > 0) {
    return fields.sections.map((section, i) => ({
      content: `${section.title || `Section ${i + 1}`}\n\n${section.content || ''}`,
      chunk_type: 'section',
      label: section.title || `Section ${i + 1}`,
      fields: section,
    }));
  }

  return semanticSplit(rawText).map((text, i) => ({
    content: text,
    chunk_type: 'section',
    label: `Section ${i + 1}`,
    fields: {},
  }));
}

function buildSpreadsheetChunks(sheetData) {
  if (!sheetData || !Array.isArray(sheetData.rows) || sheetData.rows.length === 0) {
    return [];
  }

  const groups = groupRows(sheetData.rows, sheetData.headers, 30);
  return groups.map((group, i) => ({
    content: group.content,
    chunk_type: 'row_group',
    label: `Rows ${group.start_row + 1}\u2013${group.end_row + 1}`,
    fields: {
      start_row: group.start_row,
      end_row: group.end_row,
      row_count: group.row_count,
    },
  }));
}

function buildMeetingChunks(fields, rawText) {
  const chunks = [];

  // Agenda item chunks
  if (Array.isArray(fields.agenda_items) && fields.agenda_items.length > 0) {
    fields.agenda_items.forEach((item, i) => {
      const content = typeof item === 'string' ? item : (item.content || item.description || item.title || JSON.stringify(item));
      chunks.push({
        content,
        chunk_type: 'agenda_item',
        label: `Agenda Item ${i + 1}`,
        fields: typeof item === 'object' ? item : {},
      });
    });
  }

  // Dedicated action items chunk
  if (Array.isArray(fields.action_items) && fields.action_items.length > 0) {
    const lines = fields.action_items.map((ai, i) => {
      const parts = [`${i + 1}. ${ai.description || 'Action item'}`];
      if (ai.owner) parts.push(`   Owner: ${ai.owner}`);
      if (ai.deadline) parts.push(`   Deadline: ${ai.deadline}`);
      return parts.join('\n');
    });

    chunks.push({
      content: `Action Items:\n\n${lines.join('\n\n')}`,
      chunk_type: 'action_items',
      label: 'Action Items',
      fields: { action_items: fields.action_items },
    });
  }

  // If no structured data, fall back
  if (chunks.length === 0) {
    return semanticSplit(rawText).map((text, i) => ({
      content: text,
      chunk_type: 'section',
      label: `Section ${i + 1}`,
      fields: {},
    }));
  }

  return chunks;
}

function buildGeneralChunks(rawText) {
  return semanticSplit(rawText).map((text, i) => ({
    content: text,
    chunk_type: 'section',
    label: `Section ${i + 1}`,
    fields: {},
  }));
}

// ── Main export ─────────────────────────────────────────

/**
 * Create structured memory payloads from extracted schema fields.
 *
 * @param {object} options
 * @param {string} options.documentType - 'invoice', 'contract', 'sop', 'spreadsheet', 'meeting', 'general'
 * @param {object} options.extractedSchema - { fields, summary, missing_required, model_used }
 * @param {string} options.rawText - full document text (for semantic fallback)
 * @param {string} options.filename - original filename
 * @param {string} options.uploadId - unique upload ID
 * @param {string} options.userId - user who uploaded
 * @param {string} options.orgId - organization
 * @param {string} [options.project] - containerTag
 * @param {string} [options.visibility] - 'private' or 'organization'
 * @param {string[]} [options.userTags] - user-provided tags
 * @param {object} [options.sheetData] - { name, headers, rows, row_count } for spreadsheets
 * @returns {{ parent: object, chunks: object[] }}
 */
export function createEnterpriseMemories(options) {
  const {
    documentType,
    extractedSchema,
    rawText = '',
    filename,
    uploadId,
    userId,
    orgId,
    project = null,
    visibility = 'private',
    userTags = [],
    sheetData = null,
  } = options;

  const fields = extractedSchema.fields || {};
  const parentTitle = buildTitle(documentType, fields);

  // Generate tags: schema tags + schema-record + upload tag + user tags (deduplicated)
  const schemaTags = generateTags(documentType, fields);
  const parentTags = dedupeTags([
    ...schemaTags,
    'schema-record',
    `upload:${uploadId}`,
    ...userTags,
  ]);

  // Child tags: same but without 'schema-record'
  const childTags = dedupeTags([
    ...schemaTags,
    `upload:${uploadId}`,
    ...userTags,
  ]);

  // Build raw chunk descriptors based on document type
  let rawChunks;
  const schema = getSchema(documentType);

  switch (schema.chunkBy) {
    case 'line_items':
      rawChunks = buildInvoiceChunks(fields, rawText);
      break;
    case 'clauses':
      rawChunks = buildContractChunks(fields, rawText);
      break;
    case 'sections':
      rawChunks = buildSOPChunks(fields, rawText);
      break;
    case 'row_groups':
      rawChunks = buildSpreadsheetChunks(sheetData);
      break;
    case 'agenda_items':
      rawChunks = buildMeetingChunks(fields, rawText);
      break;
    case 'semantic':
    default:
      rawChunks = buildGeneralChunks(rawText);
      break;
  }

  const totalChunks = rawChunks.length;

  // Parent schema memory — include data preview for better search/embedding quality
  let parentContent = extractedSchema.summary;
  if (rawText && rawText.length > 0) {
    const preview = rawText.slice(0, 1500);
    parentContent += '\n\n' + preview;
  }

  const parent = {
    content: parentContent,
    title: parentTitle,
    memory_type: 'fact',
    tags: parentTags,
    source: 'knowledge-base',
    source_metadata: {
      source_type: 'enterprise-upload',
      source_platform: 'knowledge-base',
      source_id: `enterprise:${uploadId}`,
      filename,
    },
    metadata: {
      extracted_schema: fields,
      document_type: documentType,
      detection_confidence: null,   // filled in by caller
      extraction_model: extractedSchema.model_used,
      filename,
      total_chunks: totalChunks,
      source_upload_id: uploadId,
    },
    project: project || null,
    visibility: visibility || 'private',
    user_id: userId,
    org_id: orgId,
  };

  // Child chunk memories
  const chunks = rawChunks.map((raw, index) => ({
    content: raw.content,
    title: `${parentTitle} \u2014 ${raw.label}`,
    memory_type: 'fact',
    tags: childTags,
    source: 'knowledge-base',
    source_metadata: {
      source_type: 'enterprise-upload',
      source_platform: 'knowledge-base',
      source_id: `enterprise:${uploadId}:chunk:${index}`,
      filename,
    },
    metadata: {
      document_type: documentType,
      parent_schema_id: null,       // filled after parent is ingested
      chunk_type: raw.chunk_type,
      chunk_index: index,
      total_chunks: totalChunks,
      extracted_fields: raw.fields || {},
    },
    project: project || null,
    visibility: visibility || 'private',
    user_id: userId,
    org_id: orgId,
  }));

  return { parent, chunks };
}

export { buildTitle, semanticSplit };
