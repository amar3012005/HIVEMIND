/**
 * hm-extract adapter — calls the standalone hm-extract service (see
 * hm-extract/README.md and .claude/decision-docs/HM_EXTRACT_PLAN.md) for a
 * NARROW allowlist of formats where it is a proven win over docling, not a
 * blanket replacement.
 *
 * Scope decision (2026-08-19), made explicit after reading the CURRENT
 * docling-adapter.js tier ladder in core/src/server.js: most formats already
 * bypass plain docling via dedicated, measured-better tiers —
 * sheet-direct/csv-direct keep a real structured cell grid docling drops
 * entirely; the mammoth "seam" tier already solves docx heading loss; fast-pdf
 * + groq-vision already beat docling on PDF (18-606s for docling vs ~800ms,
 * plus hm-extract measured ZERO page numbers on PDF, a real regression vs
 * fast-pdf which keeps them). Replacing any of those with hm-extract would be
 * a regression, not an improvement — so this only covers the formats where
 * docling genuinely is still the primary/only path today: pptx/ppt (picture
 * description disabled by default, still slow, still real docling) and
 * legacy doc/docm/odt/rtf/epub. xlsx/csv/docx/pdf are deliberately excluded.
 *
 * Same shape as core/src/knowledge/normalize.js's seam tier
 * ({ok, tier, markdown, text, meta}) — this IS a sibling tier, inserted right
 * before the Tier 2 docling call in server.js's doclingAdapter.parseBuffer,
 * and on any failure the caller falls through to docling exactly like the
 * seam tier does. Only replaces the PARSE step — hm-extract's own atomic
 * chunking/structural_density are NOT used here; the existing, already-tuned
 * chunker/semantic-reslice pipeline keeps doing its job on the returned
 * markdown/text, same as the plain-text and seam tiers.
 *
 * REACHABILITY NOTE: the real upload contract admits the same proven narrow
 * set: pptx plus doc/docm/odt/rtf/epub. Formats merely advertised by anydoc
 * (ppt/pptm/ppsx/ppsm and others) remain unreachable until their complete
 * upload, extraction, ingestion and recall lifecycle is accepted.
 */

const KB_EXTRACT_URL = process.env.KB_EXTRACT_URL || '';
const KB_EXTRACT_FORMATS = String(
  process.env.KB_EXTRACT_FORMATS || 'pptx,doc,docm,odt,rtf,epub',
).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const KB_EXTRACT_TIMEOUT_MS = Number(process.env.KB_EXTRACT_TIMEOUT_MS || 30_000);
// Circuit breaker: after this many consecutive failures, skip hm-extract for
// a cooldown window rather than let every upload pay a fresh timeout during
// an incident. Matches HM_EXTRACT_PLAN.md §3's runtime-fallback design.
const KB_EXTRACT_FAILURE_THRESHOLD = Number(process.env.KB_EXTRACT_FAILURE_THRESHOLD || 5);
const KB_EXTRACT_COOLDOWN_MS = Number(process.env.KB_EXTRACT_COOLDOWN_MS || 60_000);

let consecutiveFailures = 0;
let cooldownUntil = 0;

function recordSuccess() {
  consecutiveFailures = 0;
  cooldownUntil = 0;
}

function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= KB_EXTRACT_FAILURE_THRESHOLD) {
    cooldownUntil = Date.now() + KB_EXTRACT_COOLDOWN_MS;
    console.warn(`[hm-extract-adapter] ${consecutiveFailures} consecutive failures — `
      + `cooling down for ${KB_EXTRACT_COOLDOWN_MS}ms, falling back to docling until then`);
  }
}

export function isHmExtractEnabled(ext) {
  if (!KB_EXTRACT_URL) return false;
  if (!KB_EXTRACT_FORMATS.includes(String(ext || '').toLowerCase())) return false;
  if (Date.now() < cooldownUntil) return false;
  return true;
}

/**
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @returns {Promise<{ok: boolean, tier?: string, markdown?: string|null, text?: string, meta?: object, error?: string}>}
 */
export async function parseWithHmExtract(fileBuffer, filename) {
  if (!KB_EXTRACT_URL) return { ok: false, error: 'KB_EXTRACT_URL not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KB_EXTRACT_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), filename);
    form.append('filename', filename);

    const res = await fetch(`${KB_EXTRACT_URL}/extract`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);

    if (!res.ok || !body || !body.ok) {
      recordFailure();
      const detail = body?.detail || body?.code || `http ${res.status}`;
      return { ok: false, error: `hm-extract: ${detail}` };
    }

    recordSuccess();
    return {
      ok: true,
      tier: `hm-extract:${body.format}`,
      markdown: body.markdown || null,
      text: body.text || body.markdown || '',
      meta: {
        segments: Array.isArray(body.segments) ? body.segments.length : 0,
        structural_density: body.structural_density || null,
      },
    };
  } catch (err) {
    recordFailure();
    const isTimeout = err?.name === 'AbortError';
    return { ok: false, error: `hm-extract ${isTimeout ? 'timeout' : 'error'}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
