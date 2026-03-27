/**
 * Auto Dataset Generator
 *
 * Dynamically generates evaluation queries from a user's actual memories.
 * No hardcoded UUIDs — works for any user on the platform.
 *
 * Architecture (per NotebookLM):
 *   "Seed & Reverse-Engineer" — sample memories by tag clusters,
 *   use title/content to form queries, seed UUIDs become ground truth.
 *
 * @module evaluation/auto-dataset-generator
 */

import { getPrismaClient } from '../db/prisma.js';

// ── Category classification ──────────────────────────────

const CATEGORY_KEYWORDS = {
  technical: ['api', 'prisma', 'qdrant', 'mcp', 'server', 'database', 'migration', 'code', 'bug', 'fix', 'deploy', 'docker', 'redis', 'postgres', 'schema', 'route', 'endpoint', 'embedding', 'vector', 'graph', 'memory', 'ingestion', 'connector', 'bridge', 'sdk', 'pipeline', 'stt', 'tts'],
  business: ['roadmap', 'billing', 'plan', 'feature', 'onboarding', 'product', 'sprint', 'milestone', 'enterprise', 'gdpr', 'compliance'],
  personal: ['preference', 'rule', 'habit', 'reminder', 'note', 'journal'],
};

const NOISE_MEMORY_TYPES = new Set(['trace', 'cot', 'observation', 'system', 'notification', 'tool', 'debug']);

function isNoiseMemory(memory) {
  const title = (memory.title || '').trim().toLowerCase();
  const content = (memory.content || '').trim().toLowerCase();
  const type = (memory.memoryType || '').trim().toLowerCase();

  if (NOISE_MEMORY_TYPES.has(type)) return true;
  if (title.includes('benchmark') || title.includes('smoke') || title.includes('probe')) return true;
  if (content.includes('benchmark') || content.includes('smoke test') || content.includes('do not reply')) return true;

  return false;
}

function classifyCategory(memory) {
  const text = `${memory.title || ''} ${(memory.tags || []).join(' ')} ${memory.content?.slice(0, 200) || ''}`.toLowerCase();
  let best = 'technical';
  let bestScore = 0;
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.filter(kw => text.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

// ── Query generation from a memory ───────────────────────

function generateQuery(memory) {
  const title = memory.title || '';
  const tags = memory.tags || [];
  const content = memory.content || '';
  const type = memory.memoryType || 'fact';

  // Skip junk memories (too short, test probes, web-crawl noise, etc.)
  if (content.length < 20 && !title) return null;
  if (isNoiseMemory(memory)) return null;
  const contentLower = content.trim().toLowerCase();
  const titleLower = (title || '').trim().toLowerCase();
  if (['probe', 'tmp', 'deltmp', 'bridge-auth-test', 'bridge-auth-test-4'].includes(contentLower)) return null;
  if (['probe', 'tmp', 'deltmp'].includes(titleLower)) return null;
  // Skip generic web-crawl titles
  if (titleLower === 'web crawl results') return null;
  // Skip CSS/SVG/XML content
  if (contentLower.startsWith('{') && contentLower.includes('"url"')) return null;
  if (contentLower.includes('@layer') || contentLower.includes('.shimmer-sweep') || contentLower.includes('<svg')) return null;
  if (contentLower.startsWith('<?xml') || contentLower.startsWith('https://') && contentLower.length < 100) return null;
  // Skip MCP verify test conversations
  if (titleLower.startsWith('mcp verify')) return null;
  if (titleLower.startsWith('rpc smoke')) return null;
  if (titleLower.startsWith('smoke test')) return null;

  // Skip transactional/notification emails (terrible evaluation queries)
  const TRANSACTIONAL_PATTERNS = /\b(otp|confirm|verification|verify|refund|receipt|password|reset|alert|pending|unsubscribe|do not reply|noreply|no-reply|invoice|billing|subscription|activate|deactivate|security alert|sign.?in|log.?in|two.?factor|2fa|mfa|token|code:|pin:|one.?time)\b/i;
  if (TRANSACTIONAL_PATTERNS.test(titleLower) || TRANSACTIONAL_PATTERNS.test(contentLower.slice(0, 200))) return null;

  // Skip email forwards/replies with no substance
  if (/^(re:|fwd:|fw:)\s/i.test(titleLower) && content.length < 200) return null;

  // Skip ALL Gmail-sourced memories — raw emails are not distilled knowledge,
  // they make terrible evaluation queries and pollute metrics
  const isGmail = tags.some(t => t === 'gmail') || (memory.sourcePlatform === 'gmail');
  if (isGmail) return null;
  // Skip thread summaries (auto-generated, not user knowledge)
  if (tags.includes('thread-summary')) return null;
  // Skip stigmergic CoT traces (system traces, not user knowledge)
  if (tags.includes('cot') || tags.includes('trace')) return null;
  // Skip web-search result memories (often poorly indexed)
  if (tags.includes('web-search') && !title) return null;

  // Strategy 1: Title-based query
  if (title && title.length > 10) {
    if (title.includes('?')) return title;

    // Trim overly long titles (web pages often have "Foo — Bar — Baz" pattern)
    const cleanTitle = title.length > 80 ? title.split(/\s*[—|–|-]\s*/)[0].trim() : title;
    if (cleanTitle.length < 5) return null;

    switch (type) {
      case 'decision': return `What was decided about ${cleanTitle}?`;
      case 'lesson': return `What did we learn about ${cleanTitle}?`;
      case 'event': return `What happened with ${cleanTitle}?`;
      default: return `Tell me about ${cleanTitle}`;
    }
  }

  // Strategy 2: Tag-based query (use meaningful tags)
  const meaningfulTags = tags.filter(t =>
    t.length > 2 &&
    !t.startsWith('web:') &&
    !t.startsWith('source:') &&
    !t.startsWith('url:') &&
    !t.startsWith('agent:') &&
    !t.startsWith('task:') &&
    !['other', 'conversation', 'webapp', 'trace', 'cot', 'smoke'].includes(t)
  );
  if (meaningfulTags.length >= 2) {
    return `What do we know about ${meaningfulTags.slice(0, 3).join(' and ')}?`;
  }

  // Strategy 3: First sentence of content
  const firstSentence = content.split(/[.!?\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 20 && firstSentence.length < 120) {
    return `Tell me about: ${firstSentence}`;
  }

  return null;
}

// ── Group related memories by tag clusters ───────────────

function groupByTags(memories) {
  const groups = new Map();
  for (const mem of memories) {
    const meaningful = (mem.tags || [])
      .filter(t => t.length > 2 && !t.startsWith('url:') && !t.startsWith('source:') && !t.startsWith('web:'))
      .sort()
      .slice(0, 2)
      .join(':');
    const key = meaningful || mem.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mem);
  }
  return groups;
}

// ── Difficulty assignment ────────────────────────────────

function assignDifficulty(groupSize, hasTitle) {
  if (hasTitle && groupSize === 1) return 'easy';
  if (groupSize >= 3) return 'hard';
  return 'medium';
}

// ── Quality scoring for ranking candidates ───────────────

function scoreQuality(memory) {
  let score = 0;
  const tags = memory.tags || [];

  if (memory.title && memory.title.length > 10) score += 3;

  // Count meaningful tags (not source/url/web metadata)
  const meaningfulTags = tags.filter(t =>
    !t.startsWith('web:') && !t.startsWith('source:') && !t.startsWith('url:') &&
    !t.startsWith('web-') && t !== 'other'
  );
  score += Math.min(meaningfulTags.length, 4);

  score += Math.min(Math.floor((memory.content || '').length / 200), 3);

  if (memory.createdAt) {
    const ageDays = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
    if (ageDays < 7) score += 2;
    else if (ageDays < 30) score += 1;
  }

  // Penalize web-crawl sourced memories (they often don't embed well)
  const isWebCrawl = tags.some(t => t === 'web:crawl' || t === 'source:web-intelligence' || t === 'web-crawl');
  if (isWebCrawl) score -= 5;

  // Heavily penalize Gmail-sourced memories (transactional noise, poor eval queries)
  const isGmail = tags.some(t => t === 'gmail');
  if (isGmail) score -= 8;

  // Boost user-created decisions/lessons/preferences (high-value memories)
  const type = memory.memoryType || 'fact';
  if (['decision', 'lesson', 'preference', 'goal'].includes(type)) score += 2;
  if (NOISE_MEMORY_TYPES.has(type)) score -= 8;

  return score;
}

// ── Main: Generate evaluation queries for a user ─────────

/**
 * Generate evaluation queries dynamically from a user's memories.
 *
 * @param {string} userId - User ID
 * @param {string} [orgId] - Org ID (optional)
 * @param {object} [options]
 * @param {number} [options.maxQueries=20] - Max queries to generate
 * @param {number} [options.maxMemories=300] - Max memories to sample
 * @returns {Promise<Array>} Array of {query, relevantMemories, category, difficulty, description}
 */
export async function generateEvalQueries(userId, orgId, options = {}) {
  const { maxQueries = 20, maxMemories = 300 } = options;

  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error('Database not available — cannot generate evaluation queries');
  }

  // Fetch user's latest, non-deleted memories
  const where = { userId, deletedAt: null, isLatest: true };
  if (orgId) where.orgId = orgId;

  // Prefer non-gmail, high-quality memories first
  // Fetch more than needed so we can filter aggressively
  const memories = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: maxMemories,
    select: {
      id: true,
      title: true,
      content: true,
      tags: true,
      memoryType: true,
      sourcePlatform: true,
      createdAt: true,
    },
  });

  if (memories.length === 0) {
    return [];
  }

  // Post-filter: skip memories with very short content (< 50 chars)
  const filtered = memories.filter(m => (m.content || '').length >= 50);

  if (filtered.length === 0) {
    return [];
  }

  // Group by tag clusters
  const groups = groupByTags(filtered);

  // Generate candidate queries
  const candidates = [];
  const seenQueries = new Set();

  for (const mem of filtered) {
    const query = generateQuery(mem);
    if (!query) continue;

    const key = query.toLowerCase().trim();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);

    const tagKey = (mem.tags || [])
      .filter(t => t.length > 2 && !t.startsWith('url:') && !t.startsWith('source:') && !t.startsWith('web:'))
      .sort().slice(0, 2).join(':') || mem.id;
    const group = groups.get(tagKey) || [mem];

    // Relevant memories = this memory + others in same tag cluster
    const relevantIds = [...new Set(group.map(m => m.id))];

    candidates.push({
      query,
      relevantMemories: relevantIds,
      category: classifyCategory(mem),
      difficulty: assignDifficulty(group.length, !!(mem.title && mem.title.length > 10)),
      description: `Auto: ${(mem.title || mem.content?.slice(0, 60) || mem.id).slice(0, 80)}`,
      tags: (mem.tags || []).filter(t => !t.startsWith('url:') && !t.startsWith('source:')),
      _score: scoreQuality(mem),
    });
  }

  // Sort by quality, take top N
  candidates.sort((a, b) => b._score - a._score);
  const top = candidates.slice(0, maxQueries);

  // Clean internal fields
  return top.map(({ _score, ...rest }) => rest);
}
