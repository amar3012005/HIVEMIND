/**
 * Email content cleaner — strips noise, preserves structure.
 *
 * Goal: turn raw Gmail message body into clean searchable markdown that
 * focuses on this message's actual content (not quoted history, not
 * boilerplate signatures, not HTML tag soup).
 */

// ── Quoted-reply detection ─────────────────────────────────────────
//
// Gmail quotes earlier messages with various patterns:
//   "On Mon, Jan 1, 2025 at 10:00 AM, John <j@x.com> wrote:"
//   "From: john@x.com\nSent: ...\nTo: ..."
//   "> quoted text" (plain text)
//   "<blockquote>" (HTML — handled before markdown conversion)
//   "-----Original Message-----"
//   "_____" separator lines
const QUOTE_PATTERNS = [
  // "On <date>, <name> wrote:" — most common Gmail pattern
  /^On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|\w{3,9}),?\s+.{1,200}wrote:\s*$/im,
  // "Le <date>, <name> a écrit:" — French
  /^Le\s+.{1,200}a\s+écrit\s*:\s*$/im,
  // "Am <date> schrieb <name>:" — German
  /^Am\s+.{1,200}schrieb\s+.{1,100}:\s*$/im,
  // Outlook-style "From:" header block
  /^[\s>]*From:\s+.+\n[\s>]*Sent:\s+/im,
  // Forwarded header
  /^[\s>]*-{3,}\s*Forwarded message\s*-{3,}/im,
  // Original message separator
  /^[\s>]*-{3,}\s*Original Message\s*-{3,}/im,
  // Bare separator lines (often above quoted content)
  /^_{10,}$/m,
];

/**
 * Strip quoted reply history. Returns only this message's new content.
 */
export function stripQuotedReplies(text) {
  if (!text) return '';
  let cleaned = text;

  // Find earliest occurrence of any quote-start pattern → truncate from there
  let earliestIdx = cleaned.length;
  for (const pattern of QUOTE_PATTERNS) {
    const match = pattern.exec(cleaned);
    if (match && match.index < earliestIdx) {
      earliestIdx = match.index;
    }
  }
  cleaned = cleaned.slice(0, earliestIdx);

  // Also strip lines starting with > (plain-text quote markers) when they
  // form contiguous blocks of 3+ lines
  cleaned = cleaned.replace(/(?:^[ \t]*>.*(?:\n|$)){3,}/gm, '');

  return cleaned.trim();
}

// ── HTML → Markdown conversion ─────────────────────────────────────
//
// Lightweight HTML→MD: preserves headings, lists, links, code, paragraphs.
// Not a full parser; pragmatic regex-based pipeline tuned for Gmail HTML.

const HTML_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function decodeEntities(html) {
  return html
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

export function htmlToMarkdown(html) {
  if (!html) return '';
  let md = html;

  // 1. Drop noise: <style>, <script>, <head>, <!--comments-->, <blockquote>
  md = md
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip blockquote contents entirely (quoted replies in HTML)
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '');

  // 2. Block-level → markdown
  md = md
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<\/?(?:div|section|article|main|header|footer|nav)[^>]*>/gi, '\n');

  // 3. Lists
  md = md
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) =>
      '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n').trim() + '\n'
    )
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let i = 0;
      return (
        '\n' +
        inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, () => '').trim() +
        '\n'
      ); // simplistic: number prefix on remaining lines below
    });

  // 4. Inline
  md = md
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
    .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<img\s+[^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$1]()')
    .replace(/<img[^>]*>/gi, '');

  // 5. Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // 6. Decode entities
  md = decodeEntities(md);

  // 7. Collapse whitespace
  md = md
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();

  return md;
}

// ── Signature trimming ─────────────────────────────────────────────
const SIGNATURE_MARKERS = [
  /^--\s*$/m, // RFC 3676 standard signature delimiter
  /^Sent from my (?:iPhone|iPad|Android|mobile|Samsung|Pixel|BlackBerry).*$/im,
  /^Get Outlook for (?:iOS|Android).*$/im,
  /^This email .{0,100}confidential/im,
  /^The information contained in this email/im,
  /^DISCLAIMER:?\s*\n/im,
  /^Legal Disclaimer:?\s*\n/im,
  /^CONFIDENTIALITY NOTICE:?/im,
];

export function trimSignature(text) {
  if (!text) return '';
  let earliestIdx = text.length;
  for (const marker of SIGNATURE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < earliestIdx) earliestIdx = match.index;
  }
  return text.slice(0, earliestIdx).trim();
}

// ── Marketing footer / boilerplate stripping ───────────────────────
// Targets unsubscribe blocks, "view in browser", tracking pixels,
// social links, copyright footers. Common in newsletters but also
// in transactional emails (e.g. SaaS notifications).
const MARKETING_FOOTERS = [
  // "View this email in your browser"
  /\b(?:View|Read)\s+(?:this\s+)?(?:email|message|newsletter)\s+in\s+(?:your\s+)?browser\b.*$/gim,
  // "Click here to unsubscribe" / "Unsubscribe from this list"
  /\b(?:click\s+here\s+to\s+)?unsubscribe\b.{0,200}$/gim,
  // "You are receiving this email because"
  /\bYou(?:'re|\s+are)\s+receiving\s+this\s+(?:email|message)\b.*$/gim,
  // "Manage preferences" / "update preferences" / "email preferences"
  /\b(?:Manage|Update|Change)\s+(?:your\s+)?(?:email\s+)?preferences\b.*$/gim,
  // Copyright footer "© 2025 Company Name"
  /(?:©|\(c\)|copyright)\s*(?:19|20)\d{2}.{0,150}$/gim,
  // "Privacy policy | Terms of service" blocks
  /(?:Privacy\s+Policy|Terms\s+of\s+(?:Service|Use))\s*[|·\-•]\s*(?:Privacy\s+Policy|Terms|Contact|Unsubscribe).*$/gim,
  // Social links row: "Facebook | Twitter | LinkedIn"
  /\b(?:Facebook|Twitter|LinkedIn|Instagram|YouTube|Pinterest|TikTok)\s*[|·\-•]\s*(?:Facebook|Twitter|LinkedIn|Instagram|YouTube).*$/gim,
  // "Add us to your address book"
  /\bAdd\s+(?:us|this\s+sender)\s+to\s+your\s+(?:address\s+book|contacts)\b.*$/gim,
  // Tracking pixels / "view | remove" garbage from ad networks
  /\(view\s*\|\s*remove\)/gi,
  // "Open in app" / "Reply via app"
  /\b(?:Open|Reply|View)\s+in\s+(?:the\s+)?app\b.{0,80}$/gim,
];

export function stripMarketingFooters(text) {
  if (!text) return '';
  let cleaned = text;
  for (const pattern of MARKETING_FOOTERS) {
    cleaned = cleaned.replace(pattern, '');
  }
  // Collapse leftover whitespace from removals
  return cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

// ── Noise detection: skip auto-replies, OOO, bounces, calendar invites ──

/**
 * Returns { skip: boolean, reason: string } — caller decides what to do.
 */
export function classifyNoise(message, headers, body) {
  // Auto-submitted header → automated email
  const autoSubmitted = headers['auto-submitted'];
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { skip: true, reason: `auto-submitted: ${autoSubmitted}` };
  }

  // X-Autoreply / X-Autorespond
  if (headers['x-autoreply'] || headers['x-autorespond']) {
    return { skip: true, reason: 'auto-reply header' };
  }

  // Out-of-office Microsoft
  if (headers['x-microsoft-classification'] === 'auto-reply') {
    return { skip: true, reason: 'out-of-office' };
  }

  // Bounce / delivery failure
  const from = (headers['from'] || '').toLowerCase();
  if (
    /(?:mailer-daemon|postmaster|bounce|noreply\+bounce)@/i.test(from) ||
    /(?:undelivered|delivery (?:failed|status))/i.test(headers['subject'] || '')
  ) {
    return { skip: true, reason: 'bounce/delivery-failure' };
  }

  // Calendar invite (.ics attachment) — skip body, but emit minimal event memory
  const contentType = (headers['content-type'] || '').toLowerCase();
  if (contentType.includes('text/calendar') || /method=(?:request|reply|cancel)/i.test(contentType)) {
    return { skip: false, reason: 'calendar-invite', isCalendar: true };
  }

  // Empty body
  if (!body || body.trim().length < 20) {
    return { skip: true, reason: 'empty-body' };
  }

  // Pure-marketing newsletter detection (already in main adapter — duplicate signal here)
  if (/^(?:unsubscribe|view in browser|view this email in your browser)$/im.test(body)) {
    return { skip: false, reason: 'newsletter', isNewsletter: true };
  }

  return { skip: false, reason: null };
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Clean an email message body for ingestion.
 *
 * @param {object} options
 * @param {string} options.rawText - Plain text body (if available)
 * @param {string} options.rawHtml - HTML body (used if rawText is empty)
 * @param {object} options.headers - Header map
 * @returns {{ markdown: string, noise: object, trimStats: object }}
 */
export function cleanEmailBody({ rawText, rawHtml, headers = {} }) {
  // Prefer markdown-from-HTML when HTML present — preserves structure better
  let body = '';
  if (rawHtml && rawHtml.length > 50) {
    body = htmlToMarkdown(rawHtml);
  } else if (rawText) {
    body = rawText;
  }

  const originalLen = body.length;

  // Strip quoted replies first (operate on markdown)
  body = stripQuotedReplies(body);
  const afterQuoteLen = body.length;

  // Strip marketing footers (unsubscribe blocks, "view in browser", social links, etc.)
  body = stripMarketingFooters(body);
  const afterMarketingLen = body.length;

  // Then trim signature
  body = trimSignature(body);
  const afterSigLen = body.length;

  // Final whitespace cleanup
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  const noise = classifyNoise({ ...headers }, headers, body);

  return {
    markdown: body,
    noise,
    trimStats: {
      original: originalLen,
      afterQuoteStrip: afterQuoteLen,
      afterMarketing: afterMarketingLen,
      afterSignature: afterSigLen,
      final: body.length,
      removedPercent: originalLen > 0 ? Math.round((1 - body.length / originalLen) * 100) : 0,
    },
  };
}
