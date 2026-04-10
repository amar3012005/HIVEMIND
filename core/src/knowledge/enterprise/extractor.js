/**
 * HIVE-MIND — Enterprise Schema Extractor
 *
 * Extracts structured fields from documents using LLM,
 * based on the confirmed document type's schema definition.
 *
 * @module src/knowledge/enterprise/extractor
 */

import { getSchema } from './schemas/index.js';
import { chatCompletion, getDefaultModel } from './litellm-client.js';

const MAX_DOC_CHARS = 30_000;

/**
 * Build the field description string for a single schema field.
 * For array fields with items, includes the item structure.
 */
function describeField(name, field) {
  let line = `- ${name} (${field.type}): ${field.description}`;
  if (field.type === 'array' && field.items) {
    const itemFields = Object.entries(field.items)
      .map(([k, v]) => `    - ${k} (${v.type || 'string'})`)
      .join('\n');
    line += `\n  Item structure:\n${itemFields}`;
  }
  return line;
}

/**
 * Build the extraction prompt for the LLM.
 */
function buildPrompt(schema, text) {
  const requiredLines = schema.required
    .map(name => describeField(name, schema.fields[name]))
    .join('\n');

  const optionalLines = schema.optional
    .map(name => describeField(name, schema.fields[name]))
    .join('\n');

  const truncated = text.slice(0, MAX_DOC_CHARS);

  return `You are a document data extractor. Extract structured information from the following ${schema.label} document.

## Required Fields (MUST extract, use null if not found):
${requiredLines}

## Optional Fields (extract if present):
${optionalLines}

## Additional Fields
If you find other important structured data not listed above, include it in an "_additional" object.

## Document Content:
---
${truncated}
---

Respond with a JSON object containing the extracted fields. For array fields, use arrays of objects. For missing required fields, use null. For dates, use ISO 8601 format (YYYY-MM-DD).`;
}

/**
 * Coerce a value to roughly match the expected field type.
 * Returns the coerced value, or null if impossible.
 */
function coerceType(value, fieldDef) {
  if (value === null || value === undefined) return null;

  switch (fieldDef.type) {
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case 'array':
      return Array.isArray(value) ? value : null;
    case 'string':
      return typeof value === 'string' ? value : String(value);
    default:
      return value;
  }
}

/**
 * Validate and normalise the extracted fields against the schema.
 * - Ensures required fields exist (null if missing)
 * - Coerces types where possible
 * - Moves unexpected fields into _additional
 */
function validateFields(raw, schema) {
  const knownFields = new Set([...schema.required, ...schema.optional]);
  const fields = {};
  const additional = {};

  // Process known fields
  for (const name of knownFields) {
    const fieldDef = schema.fields[name];
    if (!fieldDef) continue;
    const value = raw[name] !== undefined ? raw[name] : undefined;
    if (value !== undefined) {
      fields[name] = coerceType(value, fieldDef);
    }
  }

  // Ensure all required fields exist
  for (const name of schema.required) {
    if (!(name in fields)) {
      fields[name] = null;
    }
  }

  // Move unexpected fields into _additional
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_additional') {
      Object.assign(additional, value);
    } else if (!knownFields.has(key)) {
      additional[key] = value;
    }
  }

  if (Object.keys(additional).length > 0) {
    fields._additional = additional;
  }

  const missing_required = schema.required.filter(name => fields[name] === null || fields[name] === undefined);

  return { fields, missing_required };
}

// ── Summary builders ────────────────────────────────────────────────

function safeLen(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

function summaryInvoice(f) {
  const parts = ['Invoice'];
  if (f.vendor) parts[0] += ` from ${f.vendor}`;
  if (f.invoice_number) parts.push(`#${f.invoice_number}`);
  if (f.date) parts.push(`dated ${f.date}`);
  let head = parts.join(', ') + '.';
  const details = [];
  if (f.total_amount != null) {
    const cur = f.currency || '';
    const items = safeLen(f.line_items);
    details.push(`Total: ${cur}${cur ? ' ' : ''}${f.total_amount}${items ? ` (${items} line items)` : ''}`);
  }
  if (f.payment_terms) details.push(`Payment terms: ${f.payment_terms}`);
  return details.length ? `${head} ${details.join('. ')}.` : head;
}

function summaryContract(f) {
  const parts = [];
  parts.push(f.document_title ? `Contract: ${f.document_title}` : 'Contract');
  if (Array.isArray(f.parties) && f.parties.length) parts.push(`Parties: ${f.parties.join(', ')}`);
  if (f.effective_date) parts.push(`Effective: ${f.effective_date}`);
  if (safeLen(f.clauses)) parts.push(`${f.clauses.length} clauses`);
  return parts.join('. ') + '.';
}

function summarySop(f) {
  const title = f.title || 'SOP';
  const parts = [f.category ? `${title} — ${f.category}` : title];
  if (f.version) parts.push(`Version ${f.version}`);
  if (safeLen(f.sections)) parts.push(`${f.sections.length} sections`);
  if (f.department) parts.push(`Department: ${f.department}`);
  return parts.join('. ') + '.';
}

function summarySpreadsheet(f) {
  const parts = [f.sheet_name ? `Sheet: ${f.sheet_name}` : 'Spreadsheet'];
  if (f.row_count != null) parts.push(`${f.row_count} rows`);
  if (safeLen(f.headers)) parts.push(`${f.headers.length} columns`);
  if (f.data_type) parts.push(`Type: ${f.data_type}`);
  return parts.join('. ') + '.';
}

function summaryMeeting(f) {
  const parts = [f.title || 'Meeting'];
  if (f.date) parts[0] += `, ${f.date}`;
  if (safeLen(f.attendees)) parts.push(`${f.attendees.length} attendees`);
  if (safeLen(f.decisions)) parts.push(`${f.decisions.length} decisions`);
  if (safeLen(f.action_items)) parts.push(`${f.action_items.length} action items`);
  return parts.join('. ') + '.';
}

function summaryGeneral(f) {
  const parts = [];
  if (f.title) parts.push(f.title);
  if (f.summary) parts.push(f.summary);
  return parts.join('. ') || 'Document extracted.';
}

const SUMMARY_BUILDERS = {
  invoice: summaryInvoice,
  contract: summaryContract,
  sop: summarySop,
  spreadsheet: summarySpreadsheet,
  meeting: summaryMeeting,
  general: summaryGeneral,
};

function buildSummary(documentType, fields) {
  const builder = SUMMARY_BUILDERS[documentType] || summaryGeneral;
  try {
    return builder(fields);
  } catch {
    return 'Document extracted.';
  }
}

// ── Main export ─────────────────────────────────────────────────────

/**
 * Extract structured schema fields from a document using LLM.
 *
 * @param {string} text - Full document content
 * @param {string} documentType - Confirmed type string (e.g. 'invoice', 'contract')
 * @param {Object} [options]
 * @param {string} [options.model] - LLM model override
 * @param {string} [options.filename] - Optional source filename
 * @returns {Promise<{ fields: Object, summary: string, missing_required: string[], model_used: string }>}
 */
export async function extractSchema(text, documentType, options = {}) {
  const schema = getSchema(documentType);
  const model_used = options.model || getDefaultModel();

  try {
    const prompt = buildPrompt(schema, text);

    const messages = [
      { role: 'system', content: 'You are a precise document data extractor. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ];

    const raw = await chatCompletion({
      messages,
      model: options.model,
      temperature: 0.1,
      max_tokens: 4096,
      json_mode: true,
    });

    const { fields, missing_required } = validateFields(raw, schema);
    const summary = buildSummary(documentType, fields);

    console.log(`[enterprise-extract] type=${documentType} required=${schema.required.length} missing=${missing_required.length}`);

    return { fields, summary, missing_required, model_used };
  } catch (err) {
    console.error(`[enterprise-extract] Extraction failed for type=${documentType}: ${err.message}`);
    return {
      fields: {},
      summary: 'Extraction failed',
      missing_required: [...schema.required],
      model_used,
    };
  }
}
