/**
 * Web Intelligence — Safety & Policy Layer
 *
 * Enforces domain restrictions, content filtering, per-user rate limits,
 * abuse detection, and robots/ToS advisory warnings for all web operations.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Internal/private IP patterns that must never be fetched. */
const INTERNAL_IP_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^\[::1\]$/,
  /^::1$/,
  /^0:0:0:0:0:0:0:1$/,
  /^fd[0-9a-f]{2}:/i,   // IPv6 ULA
  /^fe80:/i,             // IPv6 link-local
];

/**
 * Blocked domain substrings / patterns. Any hostname containing one of these
 * strings (case-insensitive) is rejected outright.
 */
export const BLOCKED_DOMAINS = [
  // Adult content
  'pornhub.com',
  'xvideos.com',
  'xnxx.com',
  'xhamster.com',
  'redtube.com',
  'youporn.com',
  'tube8.com',
  'spankbang.com',
  'chaturbate.com',
  'livejasmin.com',
  'stripchat.com',
  'bongacams.com',

  // Known malware / phishing distribution
  'malware-traffic-analysis.net',
  'vidar.download',
  'raccoon-stealer.com',

  // Illegal marketplaces
  'silkroad',
  'alphabaymarket',
];

/** Maximum raw text size we will retain per page (bytes). */
const MAX_CONTENT_BYTES = 500 * 1024; // 500 KB

/** Patterns stripped during content filtering. */
const DANGEROUS_CONTENT_PATTERNS = [
  // Script tags (with content)
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  // Inline event handlers
  /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
  // Iframes
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  // Object / embed / applet tags
  /<(object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gi,
  // Base64 data URIs (images are fine; scripts/html are not)
  /data:\s*(?:text\/html|application\/javascript|application\/x-javascript|text\/javascript)[^"'\s)]+/gi,
  // javascript: URIs
  /javascript\s*:/gi,
  // vbscript: URIs
  /vbscript\s*:/gi,
];

/** Domains known to have strict robots.txt or ToS that forbid automated access. */
const RESTRICTED_DOMAIN_ADVISORIES = new Map([
  ['twitter.com',     'Twitter/X ToS prohibit automated scraping; use their API instead.'],
  ['x.com',           'Twitter/X ToS prohibit automated scraping; use their API instead.'],
  ['facebook.com',    'Facebook ToS prohibit automated data collection.'],
  ['instagram.com',   'Instagram ToS prohibit automated data collection.'],
  ['linkedin.com',    'LinkedIn aggressively blocks scrapers and may pursue legal action.'],
  ['tiktok.com',      'TikTok ToS prohibit automated data collection.'],
  ['reddit.com',      'Reddit requires API access for bulk retrieval (see robots.txt).'],
  ['pinterest.com',   'Pinterest ToS restrict automated access.'],
  ['amazon.com',      'Amazon robots.txt blocks most automated access to product pages.'],
]);

// ---------------------------------------------------------------------------
// 1. Domain Policy
// ---------------------------------------------------------------------------

/**
 * Validate whether a given URL is allowed under the current domain policy.
 *
 * @param {string} url - Absolute URL to check.
 * @param {object} [userPolicy={}] - Optional per-user overrides.
 * @param {string[]} [userPolicy.allowlist] - Domains explicitly allowed (bypass default blocks).
 * @param {string[]} [userPolicy.denylist]  - Additional domains the user wants blocked.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function validateDomain(url, userPolicy = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Malformed URL.' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const { allowlist = [], denylist = [] } = userPolicy;

  // Normalised allowlist set for quick lookups
  const allowed = new Set(allowlist.map((d) => d.toLowerCase()));

  // --- User denylist (checked first — always wins) ---
  for (const deny of denylist) {
    if (hostname === deny.toLowerCase() || hostname.endsWith('.' + deny.toLowerCase())) {
      return { allowed: false, reason: `Domain "${hostname}" is on your denylist.` };
    }
  }

  // --- Internal / private IP ranges ---
  for (const pattern of INTERNAL_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { allowed: false, reason: 'Requests to internal/private network addresses are blocked.' };
    }
  }

  // Also catch numeric IPs that sneak through (e.g. 169.254.x.x)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { allowed: false, reason: 'Requests to link-local addresses are blocked.' };
  }

  // --- Blocked domains (skip if user explicitly allowlisted) ---
  if (!allowed.has(hostname)) {
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) {
        return { allowed: false, reason: `Domain "${hostname}" is on the global blocklist.` };
      }
    }
  }

  // --- Non-HTTP(S) schemes ---
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Unsupported protocol "${parsed.protocol}".` };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// 2. Content Filtering
// ---------------------------------------------------------------------------

/**
 * Strip potentially dangerous markup from raw page text and enforce size limits.
 *
 * @param {string} text - Raw text/HTML content.
 * @param {object} [options={}]
 * @param {number} [options.maxBytes=500*1024] - Maximum byte length to retain.
 * @returns {{ text: string, filtered_count: number }}
 */
export function filterContent(text, options = {}) {
  if (typeof text !== 'string') {
    return { text: '', filtered_count: 0 };
  }

  const maxBytes = options.maxBytes ?? MAX_CONTENT_BYTES;
  let filtered = text.replace(/\x00/g, ''); // Strip null bytes (PostgreSQL rejects 0x00)
  let filteredCount = 0;

  for (const pattern of DANGEROUS_CONTENT_PATTERNS) {
    // Reset lastIndex for global regexes used multiple times
    pattern.lastIndex = 0;
    const before = filtered;
    filtered = filtered.replace(pattern, '');
    if (filtered.length !== before.length) {
      // Count individual matches by running the pattern again on the original
      pattern.lastIndex = 0;
      const matches = before.match(pattern);
      filteredCount += matches ? matches.length : 1;
    }
  }

  // Truncate if content exceeds size limit
  if (Buffer.byteLength(filtered, 'utf8') > maxBytes) {
    // Slice conservatively — binary-safe truncation
    const buf = Buffer.from(filtered, 'utf8');
    filtered = buf.subarray(0, maxBytes).toString('utf8');
    // Drop the last character in case we split a multi-byte char
    filtered = filtered.replace(/[\uFFFD]$/, '');
    filteredCount += 1; // count the truncation itself
  }

  return { text: filtered, filtered_count: filteredCount };
}

// ---------------------------------------------------------------------------
// 3. Per-User Rate Limiter (sliding window, in-memory)
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter keyed by user ID.
 *
 * Tracks per-minute and per-hour burst limits.  Old timestamps are pruned on
 * every `check()` call so memory stays bounded.
 */
export class UserRateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerMinute=10] - Maximum requests per 60-second window.
   * @param {number} [opts.maxPerHour=60]   - Maximum requests per 3600-second window.
   */
  constructor({ maxPerMinute = 10, maxPerHour = 60 } = {}) {
    /** @type {number} */
    this.maxPerMinute = maxPerMinute;
    /** @type {number} */
    this.maxPerHour = maxPerHour;
    /**
     * Map from userId to array of request timestamps (epoch ms).
     * @type {Map<string, number[]>}
     */
    this._windows = new Map();
  }

  /**
   * Prune entries older than one hour for a given user.
   * @param {string} userId
   * @returns {number[]} Pruned array of timestamps.
   */
  _prune(userId) {
    const now = Date.now();
    const cutoff = now - 3_600_000; // 1 hour
    let timestamps = this._windows.get(userId);
    if (!timestamps) return [];
    timestamps = timestamps.filter((t) => t > cutoff);
    if (timestamps.length === 0) {
      this._windows.delete(userId);
    } else {
      this._windows.set(userId, timestamps);
    }
    return timestamps;
  }

  /**
   * Check whether the user is allowed to make another request right now.
   *
   * Does **not** record a new request — call {@link record} after the check
   * passes and the request is actually dispatched.
   *
   * @param {string} userId
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  check(userId) {
    const now = Date.now();
    const timestamps = this._prune(userId);

    // Per-hour check
    if (timestamps.length >= this.maxPerHour) {
      const oldest = timestamps[0];
      const retryAfterMs = oldest + 3_600_000 - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    // Per-minute check
    const oneMinuteAgo = now - 60_000;
    const recentCount = timestamps.filter((t) => t > oneMinuteAgo).length;
    if (recentCount >= this.maxPerMinute) {
      const oldestInMinute = timestamps.filter((t) => t > oneMinuteAgo)[0];
      const retryAfterMs = oldestInMinute + 60_000 - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    return { allowed: true };
  }

  /**
   * Record a request timestamp for the given user.
   * @param {string} userId
   */
  record(userId) {
    if (!this._windows.has(userId)) {
      this._windows.set(userId, []);
    }
    this._windows.get(userId).push(Date.now());
  }

  /**
   * Reset all rate-limit state for a user (e.g. after a cooldown or admin override).
   * @param {string} userId
   */
  reset(userId) {
    this._windows.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// 4. Abuse Detection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AbuseCheckParams
 * @property {string} userId           - User triggering the request.
 * @property {string} type             - Job type (e.g. 'scrape', 'search', 'crawl').
 * @property {string[]} [urls]         - URLs involved in this request.
 * @property {string} [query]          - Search query (if applicable).
 * @property {number} recentJobCount   - Number of jobs the user has dispatched recently.
 */

/**
 * Detect potentially abusive request patterns.
 *
 * @param {AbuseCheckParams} params
 * @returns {{ suspicious: boolean, reason?: string, action: 'allow' | 'warn' | 'block' }}
 */
export function detectAbuse(params) {
  const { userId, type, urls = [], query, recentJobCount } = params;

  if (!userId) {
    return { suspicious: true, reason: 'Missing userId.', action: 'block' };
  }

  // --- Rapid sequential requests ---
  if (recentJobCount > 50) {
    return {
      suspicious: true,
      reason: `User "${userId}" has dispatched ${recentJobCount} jobs recently — possible automation abuse.`,
      action: 'block',
    };
  }

  if (recentJobCount > 20) {
    return {
      suspicious: true,
      reason: `User "${userId}" has dispatched ${recentJobCount} jobs recently — elevated activity.`,
      action: 'warn',
    };
  }

  // --- Same URL repeated in a single batch ---
  if (urls.length > 1) {
    const unique = new Set(urls.map((u) => u.toLowerCase()));
    const dupeCount = urls.length - unique.size;
    if (dupeCount > 0) {
      return {
        suspicious: true,
        reason: `Request contains ${dupeCount} duplicate URL(s).`,
        action: 'warn',
      };
    }
  }

  // --- Unusually deep crawl ---
  if (type === 'crawl' && urls.length > 100) {
    return {
      suspicious: true,
      reason: `Crawl request targets ${urls.length} URLs — exceeds safe threshold (100).`,
      action: 'block',
    };
  }

  if (type === 'crawl' && urls.length > 30) {
    return {
      suspicious: true,
      reason: `Crawl request targets ${urls.length} URLs — review recommended.`,
      action: 'warn',
    };
  }

  // --- Suspiciously long query string (possible injection) ---
  if (query && query.length > 2000) {
    return {
      suspicious: true,
      reason: 'Search query exceeds 2 000 characters — possible injection attempt.',
      action: 'block',
    };
  }

  return { suspicious: false, action: 'allow' };
}

// ---------------------------------------------------------------------------
// 5. Robots / ToS Awareness
// ---------------------------------------------------------------------------

/**
 * Return an advisory warning if the target URL belongs to a domain known to
 * restrict automated access via robots.txt or Terms of Service.
 *
 * This is informational only — it does **not** block the request.
 *
 * @param {string} url - Absolute URL to check.
 * @returns {{ warning?: string, advisory: boolean }}
 */
export function getRobotsWarning(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { advisory: false };
  }

  // Strip leading "www."
  const bare = hostname.replace(/^www\./, '');

  // Direct match
  if (RESTRICTED_DOMAIN_ADVISORIES.has(bare)) {
    return { warning: RESTRICTED_DOMAIN_ADVISORIES.get(bare), advisory: true };
  }

  // Sub-domain match (e.g. m.facebook.com)
  for (const [domain, warning] of RESTRICTED_DOMAIN_ADVISORIES) {
    if (bare.endsWith('.' + domain)) {
      return { warning, advisory: true };
    }
  }

  return { advisory: false };
}
