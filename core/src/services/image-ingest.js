/**
 * Image-ingest service — Groq vision pipeline for .jpg / .png / .webp.
 *
 * Two-stage call to Llama 4 Scout:
 *   1. classify({image}) → { kind, has_structured_layout, suggested_title }
 *   2. extract({image, kind}) → { title, description, content_md, entities[],
 *                                  key_facts[], structured_fields{}, ocr_text }
 *
 * Returns an ingest-ready payload matching the shape buildRoutedIngestPayloads
 * expects, so the same downstream graph + dedup + scope routing applies as
 * text memories.
 *
 * No docling involvement. Pure Groq vision + Groq text. Auto-routed per image
 * kind so a receipt and a whiteboard photo come out shaped differently.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const VISION_MODEL = process.env.HIVEMIND_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const TEXT_MODEL = process.env.HIVEMIND_VISION_TEXT_MODEL || 'llama-3.3-70b-versatile';

const CLASSIFY_PROMPT = `You classify a single image for a memory ingestion pipeline. Return STRICT JSON only — no prose, no markdown fence:
{
  "kind": "receipt" | "invoice" | "id_card" | "form" | "document" | "screenshot" | "whatsapp" | "slack" | "email_screenshot" | "whiteboard" | "diagram" | "chart" | "scene" | "selfie" | "product" | "code" | "ui_mock" | "other",
  "has_structured_layout": true,
  "suggested_title": "<6-10 word title>",
  "language": "<ISO 639-1 of dominant text, or null if image has no text>",
  "confidence": 0.0
}

Rules:
- has_structured_layout = true ONLY when rows/columns/fields are visible (receipts, invoices, forms, IDs, tables, spreadsheets).
- "screenshot" covers app/desktop captures with prose UI.
- "scene" / "selfie" / "product" for non-textual photos.
- If user provided a hint, weight it heavily but don't blindly accept — verify against the image.
- suggested_title should describe the image specifically, not generically ("Saturn receipt €43.20", not "A receipt").`;

function describePrompt({ kind, hint }) {
  const hintBlock = hint ? `\nUSER HINT: ${hint}\n` : '';
  if (['receipt', 'invoice'].includes(kind)) {
    return `You extract a payment receipt / invoice from an image. Return STRICT JSON:
{
  "title": "<vendor + amount + date>",
  "description": "<1-2 sentence prose summary, who/what/when/how-much>",
  "structured_fields": {
    "vendor": "<vendor name>",
    "vendor_address": "<if visible>",
    "date": "<ISO YYYY-MM-DD>",
    "currency": "<ISO 4217>",
    "subtotal": <number or null>,
    "tax": <number or null>,
    "tip": <number or null>,
    "total": <number or null>,
    "payment_method": "<card/cash/transfer/null>",
    "line_items": [{ "description": "<text>", "qty": <number>, "unit_price": <number>, "total": <number> }, ...]
  },
  "entities": ["<vendor>", "<city>", ...],
  "key_facts": ["<bullet 1>", "<bullet 2>"],
  "ocr_text": "<full visible text, line breaks preserved>"
}
Read every line item even if the table is dense. If a field is missing, set null. Don't invent numbers.${hintBlock}`;
  }
  if (['id_card', 'form'].includes(kind)) {
    return `You extract an ID / form. Return STRICT JSON:
{
  "title": "<doc type + holder>",
  "description": "<1 sentence summary>",
  "structured_fields": { "<field>": "<value>", ... },
  "entities": ["<name>", "<issuer>", ...],
  "key_facts": ["..."],
  "ocr_text": "<full visible text>"
}
Redact partial sensitive numbers (show last 4 only) for IDs, card numbers, SSN, passport. Don't store full PII.${hintBlock}`;
  }
  if (['screenshot', 'whatsapp', 'slack', 'email_screenshot'].includes(kind)) {
    return `You extract a chat / app screenshot. Return STRICT JSON:
{
  "title": "<who-spoke-to-who about topic>",
  "description": "<1-2 sentences of what's in this conversation>",
  "structured_fields": {
    "platform": "<whatsapp/slack/imessage/email/other>",
    "participants": ["<name1>", "<name2>"],
    "topic": "<topic>",
    "messages": [{ "speaker": "<name>", "text": "<msg>", "timestamp": "<if visible>" }, ...]
  },
  "entities": ["<names>", "<projects>", ...],
  "key_facts": ["<claim or decision in the thread>"],
  "ocr_text": "<full visible text>"
}
Order messages chronologically. Skip UI chrome (read receipts, time pills) unless they matter.${hintBlock}`;
  }
  if (['whiteboard', 'diagram', 'chart', 'ui_mock'].includes(kind)) {
    return `You extract a diagram / whiteboard / chart / mockup. Return STRICT JSON:
{
  "title": "<diagram subject>",
  "description": "<2-4 sentences explaining what it shows and the relationships>",
  "structured_fields": {
    "diagram_type": "<flowchart/graph/chart/architecture/ui/other>",
    "nodes": [{ "label": "<text>", "kind": "<box/circle/icon/screen>" }, ...],
    "edges": [{ "from": "<label>", "to": "<label>", "label": "<arrow text or null>" }, ...]
  },
  "entities": ["<labels>", "<people>", ...],
  "key_facts": ["<insight 1>", "<insight 2>"],
  "ocr_text": "<all visible text>"
}
Capture every label. Edges include arrows + lines + connectors.${hintBlock}`;
  }
  if (kind === 'code') {
    return `You extract a code screenshot. Return STRICT JSON:
{
  "title": "<language + function/class name>",
  "description": "<1 sentence what this code does>",
  "structured_fields": { "language": "<lang>", "code": "<full code, preserve indentation>" },
  "entities": ["<function names>", "<imports>"],
  "key_facts": ["<insight>"],
  "ocr_text": "<same as code>"
}
Preserve whitespace.${hintBlock}`;
  }
  // scene / selfie / product / other
  return `You describe a photo for memory ingestion. Return STRICT JSON:
{
  "title": "<6-10 words describing the image>",
  "description": "<2-4 sentence narrative: who/what/where/notable details>",
  "structured_fields": { "setting": "<indoor/outdoor/etc>", "people_count": <number>, "objects": ["..."] },
  "entities": ["<recognisable names, brands, places>"],
  "key_facts": ["<facts a memory engine should remember>"],
  "ocr_text": "<any visible text, or empty string>"
}
Don't speculate on identities of unknown people — describe attributes. If user gave a hint about who is in the image, use those names.${hintBlock}`;
}

async function callGroqVision({ apiKey, model, base64DataUrl, prompt, maxTokens = 1500, signal }) {
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: base64DataUrl } },
        ],
      }],
      response_format: { type: 'json_object' },
      max_completion_tokens: maxTokens,
      temperature: 0.1,
    }),
    signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Groq vision ${r.status}: ${t.slice(0, 400)}`);
  }
  const data = await r.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = {}; } }
  }
  return { parsed, usage: data.usage };
}

/**
 * Top-level: classify + extract → ingest-ready payload.
 *
 * @param {object} opts
 * @param {Buffer} opts.imageBuffer
 * @param {string} opts.mimeType — image/png | image/jpeg | image/webp
 * @param {string} [opts.hint] — optional user-provided "what is this"
 * @param {string} opts.userId
 * @param {string} opts.orgId
 * @param {string} [opts.projectId]
 * @param {string} [opts.sourceUrl] — if image already stored externally
 * @param {string} [opts.filename]
 * @returns {Promise<{ payload, classification, extraction, usage }>}
 */
export async function buildImageMemoryPayload({
  imageBuffer,
  mimeType,
  hint,
  userId,
  orgId,
  projectId,
  sourceUrl,
  filename,
}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY missing');
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) throw new Error('imageBuffer required');

  // Groq's vision API wants image_url field — accepts data URL.
  const safeMime = /^image\/(png|jpeg|jpg|webp|gif)$/i.test(mimeType || '')
    ? mimeType.toLowerCase().replace('image/jpg', 'image/jpeg')
    : 'image/png';
  const base64DataUrl = `data:${safeMime};base64,${imageBuffer.toString('base64')}`;

  // ── Step 1: classify ──────────────────────────────────────────────
  const classifyPrompt = hint
    ? `${CLASSIFY_PROMPT}\n\nUSER HINT: ${hint}`
    : CLASSIFY_PROMPT;
  const cls = await callGroqVision({
    apiKey, model: VISION_MODEL, base64DataUrl, prompt: classifyPrompt, maxTokens: 300,
  });
  const classification = {
    kind: String(cls.parsed.kind || 'other').toLowerCase(),
    has_structured_layout: !!cls.parsed.has_structured_layout,
    suggested_title: cls.parsed.suggested_title || (filename || 'Image').replace(/\.[^.]+$/, ''),
    language: cls.parsed.language || null,
    confidence: Number(cls.parsed.confidence) || 0.5,
  };

  // ── Step 2: kind-specific extract ─────────────────────────────────
  const extractPrompt = describePrompt({ kind: classification.kind, hint });
  const ext = await callGroqVision({
    apiKey, model: VISION_MODEL, base64DataUrl, prompt: extractPrompt, maxTokens: 2400,
  });
  const extraction = ext.parsed || {};

  // ── Step 3: shape into memory payload ─────────────────────────────
  const title = (extraction.title || classification.suggested_title || 'Image').slice(0, 200);

  // Build markdown-ish content body so search + retrieval gets rich text.
  const contentParts = [];
  if (extraction.description) contentParts.push(extraction.description);
  if (extraction.key_facts?.length) {
    contentParts.push('\nKey facts:\n' + extraction.key_facts.map(f => `- ${f}`).join('\n'));
  }
  if (extraction.structured_fields && Object.keys(extraction.structured_fields).length) {
    contentParts.push('\n```json\n' + JSON.stringify(extraction.structured_fields, null, 2) + '\n```');
  }
  if (extraction.ocr_text && extraction.ocr_text.trim()) {
    contentParts.push('\nOCR:\n' + extraction.ocr_text.trim());
  }
  const content = contentParts.join('\n').trim() || `(Image: ${classification.kind})`;

  const tags = [
    'image',
    `kind:${classification.kind}`,
    ...(Array.isArray(extraction.entities) ? extraction.entities.slice(0, 8).map(e => `entity:${String(e).slice(0, 40)}`) : []),
  ];

  // Memory type by kind
  const KIND_TO_TYPE = {
    receipt: 'fact', invoice: 'fact', id_card: 'fact', form: 'fact', document: 'fact',
    screenshot: 'fact', whatsapp: 'fact', slack: 'fact', email_screenshot: 'fact',
    whiteboard: 'fact', diagram: 'fact', chart: 'fact', ui_mock: 'fact', code: 'fact',
    scene: 'event', selfie: 'event', product: 'fact', other: 'fact',
  };
  const memory_type = KIND_TO_TYPE[classification.kind] || 'fact';

  const payload = {
    title,
    content,
    tags,
    memory_type,
    user_id: userId,
    org_id: orgId,
    project_ids: projectId ? [projectId] : [],
    source_metadata: {
      source_type: 'image',
      source_platform: 'image-upload',
      source_url: sourceUrl || null,
      mime: safeMime,
      filename: filename || null,
    },
    metadata: {
      image_classification: classification,
      image_extracted: extraction,
      hint: hint || null,
    },
  };

  return {
    payload,
    classification,
    extraction,
    usage: {
      classify: cls.usage,
      extract: ext.usage,
    },
  };
}
