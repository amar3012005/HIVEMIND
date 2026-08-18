/**
 * Map anydoc's ConvertError onto the {code, detail, retry_with} shape core
 * expects. Verified empirically (2026-08-15) against a real thrown error:
 * `error.code` is the lowercase variant name ('unsupported'), not the
 * capitalized Rust enum name — do not assume casing from the README alone.
 *
 * Codes anydoc is documented to throw: unsupported, malformed, encrypted,
 * resourcelimit / resource_limit, missingpart / missing_part, io.
 * Only 'unsupported' has been empirically observed here; the rest are
 * mapped defensively (case-insensitive, tolerant of both spellings) rather
 * than assumed to match exactly.
 */

const RETRY_WITH_VISION = new Set(['unsupported', 'malformed']);

export function mapConvertError(err) {
  const rawCode = String(err?.code || '').toLowerCase().replace(/[_-]/g, '');
  const normalized = {
    unsupported: 'unsupported',
    malformed: 'malformed',
    encrypted: 'encrypted',
    resourcelimit: 'resource_limit',
    missingpart: 'missing_part',
    io: 'io',
  }[rawCode] || 'unsupported';

  const body = {
    ok: false,
    code: normalized,
    detail: String(err?.message || 'conversion failed').slice(0, 500),
  };
  if (RETRY_WITH_VISION.has(normalized)) body.retry_with = 'vision';
  return body;
}

export function tooLargeError(sizeBytes, maxBytes) {
  return {
    ok: false,
    code: 'too_large',
    detail: `file is ${(sizeBytes / 1048576).toFixed(1)}MB, exceeds MAX_FILE_MB=${(maxBytes / 1048576).toFixed(0)}`,
  };
}
