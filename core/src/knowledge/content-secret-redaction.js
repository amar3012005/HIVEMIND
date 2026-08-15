/**
 * Redact authentication material before parsed document text crosses any
 * persistence, embedding, extraction, or LLM boundary.
 *
 * This intentionally preserves ordinary email addresses and names: they are
 * useful evidence. It removes only values presented as credentials or values
 * with unmistakable secret-token shapes.
 */

const REDACTED = '[REDACTED_SECRET]';

const RULES = [
  // Credentials embedded in a URL. Preserve protocol and host/path so the
  // source remains intelligible without retaining reusable authentication.
  {
    name: 'url_userinfo',
    pattern: /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    replace: (_match, protocol) => `${protocol}${REDACTED}@`,
  },
  // Explicit labels commonly found in documents, tickets, exports, and chat.
  // Stop at whitespace because these values are credentials, not prose.
  {
    name: 'labelled_secret',
    pattern: /\b(password|passwort|passwd|pwd|pw|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key)\b(\s*(?::|=|is)\s*)([^\s,;]+)/gi,
    replace: (_match, label, separator) => `${label}${separator}${REDACTED}`,
  },
  // Provider/API tokens remain sensitive even when copied without a label.
  {
    name: 'token_shape',
    pattern: /\b(?:hmk_live_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    replace: REDACTED,
  },
  {
    name: 'authorization_header',
    pattern: /\b(authorization\s*:\s*(?:bearer|basic)\s+)([^\s,;]+)/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
];

export function redactSecrets(text) {
  let output = String(text ?? '');
  const counts = {};
  for (const rule of RULES) {
    let count = 0;
    output = output.replace(rule.pattern, (...args) => {
      count += 1;
      return typeof rule.replace === 'function' ? rule.replace(...args) : rule.replace;
    });
    if (count) counts[rule.name] = count;
  }
  return {
    text: output,
    redacted: Object.values(counts).reduce((sum, count) => sum + count, 0) > 0,
    counts,
  };
}

function redactValue(value, aggregate) {
  if (typeof value === 'string') {
    const result = redactSecrets(value);
    for (const [name, count] of Object.entries(result.counts)) {
      aggregate[name] = (aggregate[name] || 0) + count;
    }
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, aggregate));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, aggregate)]));
  }
  return value;
}

export function redactParsedDocument(parseResult) {
  const counts = {};
  const sanitized = redactValue(parseResult || {}, counts);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  sanitized.metadata = {
    ...(sanitized.metadata || {}),
    secret_redaction: {
      applied: total > 0,
      total,
      counts,
      version: 1,
    },
  };
  return sanitized;
}

export { REDACTED };
