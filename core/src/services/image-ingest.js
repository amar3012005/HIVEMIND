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

function describePrompt({ kind, hint, filename }) {
  // Filename is a powerful disambiguation signal — e.g. "Branding Skizze1
  // (11).png" tells Groq this is a branding sketch, not a random drawing
  // it might otherwise misread as a smart-home diagram. Include it in the
  // context so the model titles + describes consistent with user intent.
  const filenameBlock = filename ? `\nORIGINAL FILENAME: ${filename}` : '';
  const hintBlock = (filename || hint)
    ? `${filenameBlock}${hint ? `\nUSER HINT: ${hint}` : ''}\n`
    : '';
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

// Lenient JSON salvage: exact parse → first {...} block → truncated-JSON repair
// (drop the trailing partial field + close the brace). Vision models under
// max-token pressure emit valid-looking-but-truncated JSON; this recovers it.
function lenientJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { /* try harder */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* truncated — repair below */ } }
  const start = raw.indexOf('{');
  if (start >= 0) {
    const s = raw.slice(start);
    const lastComma = s.lastIndexOf(',');
    if (lastComma > 0) { try { return JSON.parse(s.slice(0, lastComma) + '}'); } catch { /* noop */ } }
    try { return JSON.parse(s.replace(/,\s*$/, '') + '}'); } catch { /* noop */ }
  }
  return null;
}

function postGroqVision({ apiKey, model, base64DataUrl, prompt, maxTokens, signal, jsonMode }) {
  return fetch(GROQ_URL, {
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
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      max_completion_tokens: maxTokens,
      temperature: 0.1,
    }),
    signal,
  });
}

async function callGroqVision({ apiKey, model, base64DataUrl, prompt, maxTokens = 1500, signal }) {
  // Strict json_object is the happy path, but llama-4-scout sometimes emits
  // truncated/invalid JSON → Groq returns 400 `json_validate_failed` with the
  // model's actual output in `error.failed_generation`. Image ingest must NEVER
  // 500 just because the JSON was malformed: salvage failed_generation, then
  // retry in plain-text mode + lenient-parse, then wrap prose as a description.
  // Only throw if every path fails.
  const r = await postGroqVision({ apiKey, model, base64DataUrl, prompt, maxTokens, signal, jsonMode: true });
  if (r.ok) {
    const data = await r.json();
    const parsed = lenientJsonParse(data.choices?.[0]?.message?.content || '') || {};
    return { parsed, usage: data.usage };
  }
  const errText = await r.text().catch(() => '');
  // (1) Salvage the model output Groq returned inside the json_validate_failed error.
  try {
    const fg = JSON.parse(errText)?.error?.failed_generation;
    if (fg) {
      const salvaged = lenientJsonParse(fg);
      if (salvaged && Object.keys(salvaged).length) {
        console.warn('[image-ingest] salvaged failed_generation from Groq json_validate_failed');
        return { parsed: salvaged, usage: null };
      }
    }
  } catch { /* error body not JSON */ }
  // (2) Retry once WITHOUT strict JSON — take the prose, lenient-parse or wrap it.
  try {
    const r2 = await postGroqVision({ apiKey, model, base64DataUrl, prompt: `${prompt}\n\nReturn ONLY the JSON object, no prose.`, maxTokens, signal, jsonMode: false });
    if (r2.ok) {
      const raw2 = (await r2.json()).choices?.[0]?.message?.content || '';
      const parsed2 = lenientJsonParse(raw2);
      if (parsed2 && Object.keys(parsed2).length) return { parsed: parsed2, usage: null };
      if (raw2.trim()) {
        return { parsed: { title: raw2.trim().split(/[.\n]/)[0].slice(0, 80), description: raw2.trim().slice(0, 1200) }, usage: null };
      }
    }
  } catch { /* fall through to throw */ }
  throw new Error(`Groq vision ${r.status}: ${errText.slice(0, 300)}`);
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
  // Filename is a strong prior — feed it to the classifier so a sketch
  // titled "Branding Skizze1 (11).png" gets classified as a branding
  // diagram, not whatever Groq vision guesses from raw pixels.
  const filenameLine = filename ? `\nORIGINAL FILENAME: ${filename}` : '';
  const hintLine     = hint ? `\nUSER HINT: ${hint}` : '';
  const classifyPrompt = (filename || hint)
    ? `${CLASSIFY_PROMPT}${filenameLine}${hintLine}`
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
  const extractPrompt = describePrompt({ kind: classification.kind, hint, filename });
  const ext = await callGroqVision({
    apiKey, model: VISION_MODEL, base64DataUrl, prompt: extractPrompt, maxTokens: 2400,
  });
  const extraction = ext.parsed || {};

  // ── Step 3: shape into memory payload ─────────────────────────────
  // Title ALWAYS leads with the original filename when present, so recall
  // by filename matches via title field even if Groq misread the image.
  // Vision's interpretation comes as a colon-suffix descriptor.
  const visionTitle = (extraction.title || classification.suggested_title || 'Image').slice(0, 160);
  const title = filename
    ? `${filename} — ${visionTitle}`.slice(0, 220)
    : visionTitle.slice(0, 200);

  // Build markdown-ish content body so search + retrieval gets rich text.
  // Lead content with filename too — guarantees FTS matches even on
  // tag-less legacy code paths.
  const contentParts = [];
  if (filename) contentParts.push(`File: ${filename}`);
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
    ...(filename ? [`filename:${filename}`] : []),
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
