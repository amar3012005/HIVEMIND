/**
 * HIVE-MIND - Enterprise Document Type Auto-Detector
 *
 * Uses LLM to classify uploaded documents into known types
 * (invoice, contract, SOP, spreadsheet, meeting notes, general).
 *
 * @module src/knowledge/enterprise/detector
 */

import { chatCompletion, getDefaultModel } from './litellm-client.js';
import { DOCUMENT_TYPES, getDetectionPromptContext } from './schemas/index.js';

const PREVIEW_CHARS = 2000;
const DETECTION_MAX_TOKENS = 1024;
const FALLBACK_RESULT = { type: 'general', confidence: 0.3, reasoning: 'Detection failed, using fallback' };

/**
 * Detect the document type for a single document.
 *
 * @param {string} text - Document content (full text or preview rows for Excel)
 * @param {Object} [options={}]
 * @param {string} [options.model] - LLM model override
 * @param {string} [options.filename] - Filename hint for classification
 * @returns {Promise<{type: string, confidence: number, reasoning: string}>}
 */
export async function detectDocumentType(text, options = {}) {
  const { model, filename } = options;

  const preview = (text || '').slice(0, PREVIEW_CHARS);
  if (!preview.trim()) {
    console.log(`[enterprise-detect] type=general confidence=0.1 file=${filename || 'unknown'}`);
    return { type: 'general', confidence: 0.1, reasoning: 'Empty document content' };
  }

  const prompt = buildSingleDetectionPrompt(preview, filename);

  let result;
  try {
    result = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: model || getDefaultModel(),
      temperature: 0.1,
      max_tokens: DETECTION_MAX_TOKENS,
      json_mode: true,
    });
  } catch (err) {
    console.log(`[enterprise-detect] LLM call failed: ${err.message}`);
    return { ...FALLBACK_RESULT };
  }

  return validateResult(result, filename);
}

/**
 * Detect document types for multiple Excel sheets in a single LLM call.
 *
 * @param {Array<{name: string, headers: string[], preview: string, row_count: number}>} sheets
 * @param {Object} [options={}]
 * @param {string} [options.model] - LLM model override
 * @returns {Promise<Array<{sheet_name: string, detected_type: string, confidence: number, reasoning: string}>>}
 */
export async function detectExcelSheetTypes(sheets, options = {}) {
  const { model } = options;

  const nonEmpty = sheets.filter(s => s.preview && s.preview.trim());
  if (nonEmpty.length === 0) {
    return sheets.map(s => ({
      sheet_name: s.name,
      detected_type: 'general',
      confidence: 0.1,
      reasoning: 'Empty sheet content',
    }));
  }

  const prompt = buildBatchDetectionPrompt(nonEmpty);

  let results;
  try {
    results = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: model || getDefaultModel(),
      temperature: 0.1,
      max_tokens: DETECTION_MAX_TOKENS,
      json_mode: true,
    });
  } catch (err) {
    console.log(`[enterprise-detect] LLM batch call failed: ${err.message}`);
    return nonEmpty.map(s => ({
      sheet_name: s.name,
      detected_type: 'general',
      confidence: 0.3,
      reasoning: 'Detection failed, using fallback',
    }));
  }

  // Normalize: LLM may return { sheets: [...] } or just [...]
  const arr = Array.isArray(results) ? results : (Array.isArray(results?.sheets) ? results.sheets : []);

  // Build a map from sheet name to LLM result for safe lookup
  const resultMap = new Map();
  for (const r of arr) {
    if (r && r.sheet_name) {
      resultMap.set(r.sheet_name, r);
    }
  }

  return nonEmpty.map(s => {
    const r = resultMap.get(s.name);
    if (!r) {
      console.log(`[enterprise-detect] type=general confidence=0.3 file=sheet:${s.name}`);
      return {
        sheet_name: s.name,
        detected_type: 'general',
        confidence: 0.3,
        reasoning: 'Sheet not found in LLM response, using fallback',
      };
    }

    const type = DOCUMENT_TYPES.includes(r.detected_type) ? r.detected_type : 'general';
    const confidence = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.3;
    const reasoning = r.reasoning || 'No reasoning provided';

    console.log(`[enterprise-detect] type=${type} confidence=${confidence} file=sheet:${s.name}`);
    return { sheet_name: s.name, detected_type: type, confidence, reasoning };
  });
}

// ── Internal helpers ──────────────────────────────────────────────────

function buildSingleDetectionPrompt(preview, filename) {
  return `You are a document classifier. Analyze the following document content and determine its type.

Available document types:
${getDetectionPromptContext()}

Document filename: ${filename || 'unknown'}

Document content (preview):
---
${preview}
---

Respond with JSON:
{
  "type": "<one of: invoice, contract, sop, spreadsheet, meeting, general>",
  "confidence": <0.0 to 1.0>,
  "reasoning": "<brief explanation of why this type was chosen>"
}

Rules:
- Choose the single best matching type
- If unsure, use "general" with low confidence
- Confidence should reflect how well the content matches the type definition
- Consider both content structure and terminology`;
}

function buildBatchDetectionPrompt(sheets) {
  const sheetPreviews = sheets.map((s, i) => {
    const preview = (s.preview || '').slice(0, PREVIEW_CHARS);
    return `### Sheet ${i + 1}: "${s.name}" (${s.row_count} rows)
Headers: ${(s.headers || []).join(', ')}
Preview:
${preview}`;
  }).join('\n\n');

  return `You are a document classifier. Analyze each Excel sheet below and determine its document type.

Available document types:
${getDetectionPromptContext()}

${sheetPreviews}

Respond with a JSON object:
{
  "sheets": [
    {
      "sheet_name": "<exact sheet name>",
      "detected_type": "<one of: invoice, contract, sop, spreadsheet, meeting, general>",
      "confidence": <0.0 to 1.0>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Rules:
- Choose the single best matching type for each sheet
- If unsure, use "general" with low confidence
- Confidence should reflect how well the content matches the type definition
- Consider both headers and content structure`;
}

function validateResult(result, filename) {
  if (!result || typeof result !== 'object') {
    console.log(`[enterprise-detect] type=general confidence=0.3 file=${filename || 'unknown'}`);
    return { ...FALLBACK_RESULT };
  }

  const type = DOCUMENT_TYPES.includes(result.type) ? result.type : 'general';
  const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.3;
  const reasoning = result.reasoning || 'No reasoning provided';

  console.log(`[enterprise-detect] type=${type} confidence=${confidence} file=${filename || 'unknown'}`);
  return { type, confidence, reasoning };
}
