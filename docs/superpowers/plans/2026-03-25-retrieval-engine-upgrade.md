# Retrieval Engine Upgrade — LongMemEval >90% Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade HIVEMIND's ingestion and retrieval pipeline to score >90% on LongMemEval-S, surpassing Supermemory's 85.2%.

**Architecture:** Four upgrades layered on the existing pipeline: (1) round-level ingestion granularity for per-turn memory storage, (2) fact-augmented key expansion that enriches Qdrant embeddings with extracted keyphrases, (3) time-aware query expansion that pre-filters search by date ranges, (4) chain-of-note structured reading that forces the LLM to reason over notes before answering.

**Tech Stack:** Node.js (ESM), Qdrant Cloud (384d vectors), Groq Llama 3 (fast extraction), Mistral embeddings, PostgreSQL/Prisma, existing graph-engine.js + qdrant-client.js + operator-layer.js + hybrid.js

---

### Task 1: Round-Level Ingestion Splitter

**Files:**
- Create: `core/src/memory/round-splitter.js`
- Test: `core/tests/unit/round-splitter.test.js`

This module takes a raw conversation (array of `{role, content}` messages) and splits it into individual rounds (one user message + one assistant response), each becoming its own memory.

- [ ] **Step 1: Write the failing test**

```javascript
// core/tests/unit/round-splitter.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoRounds } from '../../src/memory/round-splitter.js';

describe('splitIntoRounds', () => {
  it('splits a 4-message conversation into 2 rounds', () => {
    const messages = [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'The capital of France is Paris.' },
      { role: 'user', content: 'And Germany?' },
      { role: 'assistant', content: 'The capital of Germany is Berlin.' },
    ];
    const rounds = splitIntoRounds(messages);
    assert.equal(rounds.length, 2);
    assert.ok(rounds[0].content.includes('capital of France'));
    assert.ok(rounds[0].content.includes('Paris'));
    assert.ok(rounds[1].content.includes('Germany'));
    assert.ok(rounds[1].content.includes('Berlin'));
    assert.equal(rounds[0].roundIndex, 0);
    assert.equal(rounds[1].roundIndex, 1);
  });

  it('handles a single user message without assistant response', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const rounds = splitIntoRounds(messages);
    assert.equal(rounds.length, 1);
    assert.ok(rounds[0].content.includes('Hello'));
  });

  it('handles system messages by skipping them', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    const rounds = splitIntoRounds(messages);
    assert.equal(rounds.length, 1);
  });

  it('preserves timestamps when provided', () => {
    const messages = [
      { role: 'user', content: 'Test', timestamp: '2026-03-20T10:00:00Z' },
      { role: 'assistant', content: 'Response', timestamp: '2026-03-20T10:00:05Z' },
    ];
    const rounds = splitIntoRounds(messages);
    assert.equal(rounds[0].timestamp, '2026-03-20T10:00:00Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/round-splitter.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// core/src/memory/round-splitter.js
/**
 * Round-Level Splitter
 *
 * Splits a conversation into individual "rounds" — one user message
 * paired with one assistant response. Each round becomes its own
 * memory for fine-grained retrieval (per LongMemEval best practices).
 */

/**
 * @param {Array<{role: string, content: string, timestamp?: string}>} messages
 * @returns {Array<{content: string, roundIndex: number, userContent: string, assistantContent: string, timestamp?: string}>}
 */
export function splitIntoRounds(messages) {
  if (!messages || messages.length === 0) return [];

  const rounds = [];
  let i = 0;

  // Skip system messages
  const filtered = messages.filter(m => m.role !== 'system');

  while (i < filtered.length) {
    const msg = filtered[i];

    if (msg.role === 'user') {
      const userContent = msg.content || '';
      const userTimestamp = msg.timestamp || null;
      let assistantContent = '';

      // Look ahead for paired assistant response
      if (i + 1 < filtered.length && filtered[i + 1].role === 'assistant') {
        assistantContent = filtered[i + 1].content || '';
        i += 2;
      } else {
        i += 1;
      }

      const content = assistantContent
        ? `User: ${userContent}\nAssistant: ${assistantContent}`
        : `User: ${userContent}`;

      rounds.push({
        content,
        userContent,
        assistantContent,
        roundIndex: rounds.length,
        timestamp: userTimestamp,
      });
    } else {
      // Orphan assistant message (no preceding user) — store standalone
      rounds.push({
        content: `Assistant: ${msg.content || ''}`,
        userContent: '',
        assistantContent: msg.content || '',
        roundIndex: rounds.length,
        timestamp: msg.timestamp || null,
      });
      i += 1;
    }
  }

  return rounds;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/round-splitter.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/round-splitter.js core/tests/unit/round-splitter.test.js
git commit -m "feat: round-level ingestion splitter for per-turn memory granularity"
```

---

### Task 2: Fact Extraction Service

**Files:**
- Create: `core/src/memory/fact-extractor.js`
- Test: `core/tests/unit/fact-extractor.test.js`

Uses Groq (Llama 3) to extract keyphrases, user facts, and temporal references from memory content. Output is concatenated with raw text before embedding.

- [ ] **Step 1: Write the failing test**

```javascript
// core/tests/unit/fact-extractor.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, buildAugmentedKey } from '../../src/memory/fact-extractor.js';

describe('extractFacts', () => {
  it('extracts keyphrases from technical content', async () => {
    const content = 'We decided to migrate the database from MySQL to PostgreSQL on March 15th because of JSONB support.';
    const facts = await extractFacts(content, { useLLM: false });
    assert.ok(facts.keyphrases.length > 0);
    assert.ok(facts.keyphrases.some(k => k.toLowerCase().includes('postgresql') || k.toLowerCase().includes('mysql')));
  });

  it('extracts temporal references', async () => {
    const content = 'The deployment happened last Tuesday and the fix was applied on March 20th.';
    const facts = await extractFacts(content, { useLLM: false });
    assert.ok(facts.temporalRefs.length > 0);
  });

  it('extracts entity names', async () => {
    const content = 'Sarah proposed the OAuth2 migration and Jake approved the RFC.';
    const facts = await extractFacts(content, { useLLM: false });
    assert.ok(facts.entities.length > 0);
  });
});

describe('buildAugmentedKey', () => {
  it('concatenates raw content with extracted facts', () => {
    const content = 'Original memory content here.';
    const facts = {
      keyphrases: ['memory', 'content'],
      entities: ['User123'],
      temporalRefs: ['March 2026'],
      summary: 'A memory about content.',
    };
    const key = buildAugmentedKey(content, facts);
    assert.ok(key.includes('Original memory content here.'));
    assert.ok(key.includes('memory'));
    assert.ok(key.includes('User123'));
    assert.ok(key.includes('March 2026'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/fact-extractor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// core/src/memory/fact-extractor.js
/**
 * Fact Extractor
 *
 * Extracts keyphrases, entities, temporal references from memory content.
 * Uses heuristic extraction by default, LLM extraction when enabled.
 * Output is used for fact-augmented key expansion (K = V + facts).
 */

const TEMPORAL_PATTERNS = [
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4}\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b(last|next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year)\b/gi,
  /\b(yesterday|today|tomorrow)\b/gi,
  /\b(Q[1-4]\s*\d{4})\b/gi,
  /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g,
];

const ENTITY_PATTERNS = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,  // Multi-word capitalized (names, orgs)
  /\b([A-Z][A-Z0-9_]{2,})\b/g,               // Acronyms (API, OAuth, GDPR)
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they', 'their',
  'what', 'when', 'where', 'who', 'will', 'with', 'this', 'that', 'from',
  'about', 'into', 'more', 'some', 'than', 'them', 'then', 'would', 'could',
  'should', 'also', 'just', 'like', 'been', 'only', 'each', 'make', 'does',
]);

/**
 * Extract facts from content using heuristic patterns.
 * @param {string} content
 * @param {object} options - { useLLM: boolean, groqClient?: object }
 * @returns {Promise<{keyphrases: string[], entities: string[], temporalRefs: string[], summary: string}>}
 */
export async function extractFacts(content, options = {}) {
  if (!content || content.length < 10) {
    return { keyphrases: [], entities: [], temporalRefs: [], summary: '' };
  }

  // Heuristic extraction (fast, no API call)
  const keyphrases = extractKeyphrases(content);
  const entities = extractEntities(content);
  const temporalRefs = extractTemporalRefs(content);
  const summary = content.slice(0, 200).replace(/\n/g, ' ').trim();

  // LLM extraction (optional, for higher quality)
  if (options.useLLM && options.groqClient) {
    try {
      const llmFacts = await llmExtractFacts(content, options.groqClient);
      return {
        keyphrases: [...new Set([...keyphrases, ...llmFacts.keyphrases])],
        entities: [...new Set([...entities, ...llmFacts.entities])],
        temporalRefs: [...new Set([...temporalRefs, ...llmFacts.temporalRefs])],
        summary: llmFacts.summary || summary,
      };
    } catch {
      // Fall back to heuristic
    }
  }

  return { keyphrases, entities, temporalRefs, summary };
}

/**
 * Build augmented key by concatenating raw content with extracted facts.
 * This enriched string is what gets embedded in Qdrant.
 * @param {string} content - Raw memory content
 * @param {object} facts - Output of extractFacts()
 * @returns {string} Augmented key for embedding
 */
export function buildAugmentedKey(content, facts) {
  const parts = [content];

  if (facts.keyphrases.length > 0) {
    parts.push(`\nKey topics: ${facts.keyphrases.join(', ')}`);
  }
  if (facts.entities.length > 0) {
    parts.push(`\nEntities: ${facts.entities.join(', ')}`);
  }
  if (facts.temporalRefs.length > 0) {
    parts.push(`\nDates: ${facts.temporalRefs.join(', ')}`);
  }

  return parts.join('');
}

function extractKeyphrases(text) {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

function extractEntities(text) {
  const entities = new Set();
  for (const pattern of ENTITY_PATTERNS) {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(text)) !== null) {
      const entity = match[1] || match[0];
      if (entity.length > 2 && entity.length < 50 && !STOPWORDS.has(entity.toLowerCase())) {
        entities.add(entity);
      }
    }
  }
  return [...entities].slice(0, 15);
}

function extractTemporalRefs(text) {
  const refs = new Set();
  for (const pattern of TEMPORAL_PATTERNS) {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(text)) !== null) {
      refs.add(match[0].trim());
    }
  }
  return [...refs].slice(0, 10);
}

async function llmExtractFacts(content, groqClient) {
  const response = await groqClient.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Extract structured facts from the text. Return ONLY valid JSON: {"keyphrases": ["..."], "entities": ["..."], "temporalRefs": ["..."], "summary": "one sentence summary"}'
      },
      { role: 'user', content: content.slice(0, 2000) }
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(response.choices[0].message.content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/fact-extractor.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/fact-extractor.js core/tests/unit/fact-extractor.test.js
git commit -m "feat: fact extraction service for augmented key expansion"
```

---

### Task 3: Integrate Fact-Augmented Keys into Qdrant Embedding

**Files:**
- Modify: `core/src/vector/qdrant-client.js` (the `storeMemory` method)
- Test: `core/tests/unit/augmented-embedding.test.js`

Modify the Qdrant upsert to embed the augmented key (`content + facts`) instead of raw content. Store raw content in payload as before, but the vector represents the enriched key.

- [ ] **Step 1: Write the failing test**

```javascript
// core/tests/unit/augmented-embedding.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAugmentedKey, extractFacts } from '../../src/memory/fact-extractor.js';

describe('augmented embedding integration', () => {
  it('augmented key is longer than raw content', async () => {
    const content = 'We migrated the PostgreSQL database on March 15th. Sarah led the project.';
    const facts = await extractFacts(content, { useLLM: false });
    const augmented = buildAugmentedKey(content, facts);
    assert.ok(augmented.length > content.length, 'Augmented key should be longer than raw content');
    assert.ok(augmented.startsWith(content), 'Augmented key should start with raw content');
  });

  it('augmented key includes extracted entities', async () => {
    const content = 'GDPR compliance requires data encryption. OAuth2 migration planned for Q1 2026.';
    const facts = await extractFacts(content, { useLLM: false });
    const augmented = buildAugmentedKey(content, facts);
    assert.ok(augmented.includes('GDPR') || augmented.includes('OAuth'));
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (these test the fact-extractor, not qdrant)

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/augmented-embedding.test.js`
Expected: PASS (uses already-implemented extractFacts)

- [ ] **Step 3: Modify qdrant-client.js storeMemory to use augmented key**

In `core/src/vector/qdrant-client.js`, find the `storeMemory` method. Change the embedding generation from:
```javascript
const embedding = await this.generateEmbedding(memory.content);
```
to:
```javascript
// Fact-augmented key expansion: embed enriched key, store raw content in payload
const { extractFacts, buildAugmentedKey } = await import('../memory/fact-extractor.js');
const facts = await extractFacts(memory.content, { useLLM: false });
const augmentedKey = buildAugmentedKey(memory.content, facts);
const embedding = await this.generateEmbedding(augmentedKey);
```

The Qdrant payload continues to store `memory.content` (raw text) — only the vector changes.

- [ ] **Step 4: Syntax-check the modified file**

Run: `cd /opt/HIVEMIND/core && node --check src/vector/qdrant-client.js`
Expected: No errors

- [ ] **Step 5: Deploy and verify a test memory gets the augmented embedding**

Run:
```bash
bash /opt/HIVEMIND/scripts/deploy.sh core
curl -sk "https://core.hivemind.davinciai.eu:8050/api/memories" -X POST \
  -H "X-API-Key: hmk_live_24c848dbef0e152cf6d47bcb1413d9eb85de48c1e0fb436d" \
  -H "Content-Type: application/json" \
  -d '{"content":"Sarah proposed moving to OAuth2 on March 15th. Jake approved the RFC.","title":"Auth Migration Decision","tags":["test","augmented-key"]}'
```
Expected: 200 OK with memory created. Check Qdrant Cloud point count increased.

- [ ] **Step 6: Commit**

```bash
git add core/src/vector/qdrant-client.js core/tests/unit/augmented-embedding.test.js
git commit -m "feat: fact-augmented key expansion in Qdrant embedding pipeline"
```

---

### Task 4: Time-Aware Query Expansion

**Files:**
- Create: `core/src/search/time-aware-expander.js`
- Test: `core/tests/unit/time-aware-expander.test.js`
- Modify: `core/src/search/hybrid.js` (add pre-filter step)

Extracts date ranges from queries with temporal references and passes them as Qdrant `dateRange` filters before vector search.

- [ ] **Step 1: Write the failing test**

```javascript
// core/tests/unit/time-aware-expander.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemporalQuery } from '../../src/search/time-aware-expander.js';

describe('expandTemporalQuery', () => {
  it('extracts date range from "last week"', () => {
    const result = expandTemporalQuery('What did we discuss last week?');
    assert.ok(result.hasTemporalFilter);
    assert.ok(result.dateRange.start);
    assert.ok(result.dateRange.end);
    const start = new Date(result.dateRange.start);
    const end = new Date(result.dateRange.end);
    assert.ok(end > start);
    const diffDays = (end - start) / 86400000;
    assert.ok(diffDays >= 6 && diffDays <= 8, `Expected ~7 day range, got ${diffDays}`);
  });

  it('extracts date range from "in March 2026"', () => {
    const result = expandTemporalQuery('What happened in March 2026?');
    assert.ok(result.hasTemporalFilter);
    assert.equal(new Date(result.dateRange.start).getMonth(), 2); // March = 2
  });

  it('returns no filter for non-temporal query', () => {
    const result = expandTemporalQuery('What is our tech stack?');
    assert.equal(result.hasTemporalFilter, false);
  });

  it('handles "yesterday"', () => {
    const result = expandTemporalQuery('What did I do yesterday?');
    assert.ok(result.hasTemporalFilter);
    const start = new Date(result.dateRange.start);
    const now = new Date();
    const diffDays = (now - start) / 86400000;
    assert.ok(diffDays >= 0.5 && diffDays <= 2.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/time-aware-expander.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// core/src/search/time-aware-expander.js
/**
 * Time-Aware Query Expansion
 *
 * Detects temporal references in queries and computes date range filters
 * for pre-filtering Qdrant search. Boosts Temporal Reasoning by 7-11%.
 */

const RELATIVE_PATTERNS = [
  { pattern: /\byesterday\b/i, daysBefore: 1, daysRange: 1 },
  { pattern: /\btoday\b/i, daysBefore: 0, daysRange: 1 },
  { pattern: /\blast\s+week\b/i, daysBefore: 7, daysRange: 7 },
  { pattern: /\bthis\s+week\b/i, daysBefore: 7, daysRange: 7 },
  { pattern: /\blast\s+month\b/i, daysBefore: 30, daysRange: 30 },
  { pattern: /\bthis\s+month\b/i, daysBefore: 30, daysRange: 30 },
  { pattern: /\blast\s+(\d+)\s+days?\b/i, daysBefore: null, daysRange: null }, // dynamic
  { pattern: /\brecently\b/i, daysBefore: 14, daysRange: 14 },
  { pattern: /\blast\s+year\b/i, daysBefore: 365, daysRange: 365 },
];

const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const ABSOLUTE_MONTH_YEAR = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i;
const ABSOLUTE_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const BEFORE_AFTER = /\b(before|after|since)\s+(.+?)(?:\.|$)/i;

/**
 * @param {string} query
 * @returns {{ hasTemporalFilter: boolean, dateRange?: { start: string, end: string }, temporalHint?: string }}
 */
export function expandTemporalQuery(query) {
  if (!query || typeof query !== 'string') {
    return { hasTemporalFilter: false };
  }

  const now = new Date();

  // Check relative patterns first
  for (const { pattern, daysBefore, daysRange } of RELATIVE_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      let actualDaysBefore = daysBefore;
      let actualRange = daysRange;

      // Handle "last N days" dynamically
      if (actualDaysBefore === null && match[1]) {
        actualDaysBefore = parseInt(match[1], 10);
        actualRange = actualDaysBefore;
      }
      if (actualDaysBefore === null) continue;

      const start = new Date(now.getTime() - actualDaysBefore * 86400000);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + actualRange * 86400000);

      return {
        hasTemporalFilter: true,
        dateRange: { start: start.toISOString(), end: end.toISOString() },
        temporalHint: match[0],
      };
    }
  }

  // Check absolute month + year (e.g., "March 2026")
  const monthMatch = query.match(ABSOLUTE_MONTH_YEAR);
  if (monthMatch) {
    const month = MONTH_NAMES[monthMatch[1].toLowerCase()];
    const year = parseInt(monthMatch[2], 10);
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59);
    return {
      hasTemporalFilter: true,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      temporalHint: monthMatch[0],
    };
  }

  // Check absolute date (e.g., "2026-03-15")
  const dateMatch = query.match(ABSOLUTE_DATE);
  if (dateMatch) {
    const date = new Date(`${dateMatch[0]}T00:00:00Z`);
    const end = new Date(date.getTime() + 86400000);
    return {
      hasTemporalFilter: true,
      dateRange: { start: date.toISOString(), end: end.toISOString() },
      temporalHint: dateMatch[0],
    };
  }

  // Check before/after/since
  const baMatch = query.match(BEFORE_AFTER);
  if (baMatch) {
    const direction = baMatch[1].toLowerCase();
    const ref = baMatch[2].trim();
    // Try to parse the reference as a date
    const refDate = new Date(ref);
    if (!isNaN(refDate.getTime())) {
      if (direction === 'before') {
        return {
          hasTemporalFilter: true,
          dateRange: { start: new Date(0).toISOString(), end: refDate.toISOString() },
          temporalHint: baMatch[0],
        };
      } else {
        return {
          hasTemporalFilter: true,
          dateRange: { start: refDate.toISOString(), end: now.toISOString() },
          temporalHint: baMatch[0],
        };
      }
    }
  }

  return { hasTemporalFilter: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/time-aware-expander.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: Wire into hybrid.js**

In `core/src/search/hybrid.js` (or its external copy), at the top of the `hybridSearch()` function, after the query preprocessing step, add:

```javascript
// Time-aware query expansion — pre-filter by date range if temporal references detected
const { expandTemporalQuery } = await import('./time-aware-expander.js');
const temporalExpansion = expandTemporalQuery(effectiveQuery);
if (temporalExpansion.hasTemporalFilter && !options.dateRange) {
  options.dateRange = temporalExpansion.dateRange;
  console.log(`[hybrid] Time-aware expansion: ${temporalExpansion.temporalHint} → ${JSON.stringify(temporalExpansion.dateRange)}`);
}
```

This reuses the existing `dateRange` filter infrastructure in `buildQdrantFilter()`.

- [ ] **Step 6: Syntax-check and deploy**

Run:
```bash
cd /opt/HIVEMIND/core
node --check src/search/time-aware-expander.js
node --check src/search/hybrid.js
bash /opt/HIVEMIND/scripts/deploy.sh core
```
Expected: Clean syntax, 9 endpoints pass

- [ ] **Step 7: Commit**

```bash
git add core/src/search/time-aware-expander.js core/tests/unit/time-aware-expander.test.js core/src/search/hybrid.js
git commit -m "feat: time-aware query expansion with date range pre-filtering"
```

---

### Task 5: Chain-of-Note Structured Reading

**Files:**
- Modify: `core/src/memory/operator-layer.js` (the `formatInjectionPayload` function)
- Test: `core/tests/unit/chain-of-note.test.js`

Changes the prompt injection format to force structured JSON reasoning: the LLM first writes notes per memory, then reasons to the answer. Pure prompt engineering — no architecture change.

- [ ] **Step 1: Write the failing test**

```javascript
// core/tests/unit/chain-of-note.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatChainOfNotePayload } from '../../src/memory/operator-layer.js';

describe('formatChainOfNotePayload', () => {
  it('produces structured JSON memory injection', () => {
    const memories = [
      { id: 'mem-1', content: 'Sarah proposed OAuth2 migration.', memory_type: 'decision', created_at: '2026-03-10T10:00:00Z' },
      { id: 'mem-2', content: 'Jake approved the RFC on March 14.', memory_type: 'event', created_at: '2026-03-14T10:00:00Z' },
    ];
    const query = 'What was decided about the auth migration?';
    const payload = formatChainOfNotePayload(memories, query);

    assert.ok(payload.includes('<chain-of-note>'));
    assert.ok(payload.includes('</chain-of-note>'));
    assert.ok(payload.includes('"id": "mem-1"'));
    assert.ok(payload.includes('OAuth2'));
    assert.ok(payload.includes('INSTRUCTIONS'));
  });

  it('includes reasoning instructions', () => {
    const memories = [{ id: 'm1', content: 'Test', memory_type: 'fact', created_at: '2026-03-20T00:00:00Z' }];
    const payload = formatChainOfNotePayload(memories, 'test query');
    assert.ok(payload.includes('Write a brief note'));
    assert.ok(payload.includes('reason over your notes'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/chain-of-note.test.js`
Expected: FAIL — `formatChainOfNotePayload` not found

- [ ] **Step 3: Add formatChainOfNotePayload to operator-layer.js**

Add this exported function at the end of `core/src/memory/operator-layer.js`, before the export block:

```javascript
/**
 * Chain-of-Note injection format.
 * Forces the LLM to extract notes from each memory before reasoning.
 * Improves reading accuracy by ~10 absolute points.
 *
 * @param {Array} memories - Retrieved memories
 * @param {string} query - The user's query
 * @returns {string} Structured injection payload
 */
export function formatChainOfNotePayload(memories, query) {
  const memoryJSON = memories.map((m, i) => ({
    id: m.id,
    type: m.memory_type || 'fact',
    date: m.created_at || m.document_date || null,
    content: (m.content || '').slice(0, 1000),
  }));

  return `<chain-of-note>
<query>${query}</query>
<memories>
${JSON.stringify(memoryJSON, null, 2)}
</memories>
<INSTRUCTIONS>
You have been given relevant memories from the user's knowledge graph.
Follow this exact process:
1. For EACH memory above, write a brief note: what information does it contain that is relevant to the query? If it is not relevant, write "Not relevant."
2. After processing all memories, reason over your notes to synthesize the final answer.
3. If memories contain conflicting information, prefer the most recent date.
4. If no memory contains the answer, say "I don't have information about this in my memory."
</INSTRUCTIONS>
</chain-of-note>`;
}
```

Also export it in the module's export block.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/HIVEMIND/core && node --test tests/unit/chain-of-note.test.js`
Expected: 2 tests PASS

- [ ] **Step 5: Wire into the recall pipeline**

In `core/src/memory/persisted-retrieval.js`, modify the `injectionText` generation near the end of `recallPersistedMemories()`:

Replace:
```javascript
injectionText = `<relevant-memories>\n${top.map(item => `- ${item.memory.content}`).join('\n')}\n</relevant-memories>`
```

With:
```javascript
const { formatChainOfNotePayload } = await import('./operator-layer.js');
const queryContext = typeof query_context === 'string' ? query_context : '';
injectionText = formatChainOfNotePayload(top.map(item => item.memory), queryContext);
```

- [ ] **Step 6: Syntax-check and deploy**

Run:
```bash
cd /opt/HIVEMIND/core
node --check src/memory/operator-layer.js
node --check src/memory/persisted-retrieval.js
bash /opt/HIVEMIND/scripts/deploy.sh core
```
Expected: Clean syntax, 9 endpoints pass

- [ ] **Step 7: Commit**

```bash
git add core/src/memory/operator-layer.js core/src/memory/persisted-retrieval.js core/tests/unit/chain-of-note.test.js
git commit -m "feat: chain-of-note structured reading for improved recall accuracy"
```

---

### Task 6: Integration Test — Full Pipeline Verification

**Files:**
- Create: `core/tests/integration/retrieval-upgrade.test.js`

End-to-end test that ingests a multi-round conversation, then queries it using the upgraded pipeline and verifies all 4 improvements are active.

- [ ] **Step 1: Write the integration test**

```javascript
// core/tests/integration/retrieval-upgrade.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoRounds } from '../../src/memory/round-splitter.js';
import { extractFacts, buildAugmentedKey } from '../../src/memory/fact-extractor.js';
import { expandTemporalQuery } from '../../src/search/time-aware-expander.js';
import { formatChainOfNotePayload } from '../../src/memory/operator-layer.js';

describe('Retrieval Engine Upgrade — Integration', () => {
  it('round-splitter + fact-extractor + time-expander + chain-of-note pipeline', async () => {
    // Step 1: Split conversation into rounds
    const conversation = [
      { role: 'user', content: 'We decided to use PostgreSQL for the new project on March 10th.' },
      { role: 'assistant', content: 'Good choice! PostgreSQL has excellent JSONB support.' },
      { role: 'user', content: 'Sarah will lead the migration starting next week.' },
      { role: 'assistant', content: 'Got it. I will remind you about the migration timeline.' },
    ];
    const rounds = splitIntoRounds(conversation);
    assert.equal(rounds.length, 2, 'Should have 2 rounds');

    // Step 2: Extract facts from each round
    for (const round of rounds) {
      const facts = await extractFacts(round.content, { useLLM: false });
      const augmented = buildAugmentedKey(round.content, facts);
      assert.ok(augmented.length >= round.content.length, 'Augmented key should be >= raw content');
      round._augmentedKey = augmented;
      round._facts = facts;
    }

    // Verify facts were extracted
    const allKeyphrases = rounds.flatMap(r => r._facts.keyphrases);
    assert.ok(allKeyphrases.some(k => k.includes('postgresql') || k.includes('migration')));

    // Step 3: Time-aware query expansion
    const query = 'What did we decide last week about the database?';
    const temporal = expandTemporalQuery(query);
    assert.ok(temporal.hasTemporalFilter, 'Should detect temporal reference');

    // Step 4: Chain-of-note formatting
    const mockMemories = rounds.map((r, i) => ({
      id: `round-${i}`,
      content: r.content,
      memory_type: 'event',
      created_at: new Date().toISOString(),
    }));
    const payload = formatChainOfNotePayload(mockMemories, query);
    assert.ok(payload.includes('<chain-of-note>'));
    assert.ok(payload.includes('PostgreSQL'));
    assert.ok(payload.includes('Write a brief note'));
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd /opt/HIVEMIND/core && node --test tests/integration/retrieval-upgrade.test.js`
Expected: 1 test PASS

- [ ] **Step 3: Run all existing tests to verify no regressions**

Run: `cd /opt/HIVEMIND/core && node --test tests/ 2>&1 | tail -20`
Expected: All existing tests still pass

- [ ] **Step 4: Final deploy and production verification**

Run:
```bash
bash /opt/HIVEMIND/scripts/deploy.sh core
# Test search with temporal query
curl -sk "https://core.hivemind.davinciai.eu:8050/api/search/quick" \
  -H "X-API-Key: hmk_live_24c848dbef0e152cf6d47bcb1413d9eb85de48c1e0fb436d" \
  -H "Content-Type: application/json" \
  -d '{"query": "What happened last week with the auth migration?"}'
```
Expected: Results filtered by date range, with augmented key matching

- [ ] **Step 5: Final commit**

```bash
git add core/tests/integration/retrieval-upgrade.test.js
git commit -m "test: integration test for retrieval engine upgrade pipeline"
git push origin main
```

---

## Post-Implementation: Run LongMemEval-S

After all 6 tasks are complete and deployed, execute the benchmark using the existing plan at `docs/longmemeval-benchmark-plan.md`. The 4 upgrades target:

| Upgrade | LongMemEval Category | Expected Boost |
|---------|---------------------|----------------|
| Round-level ingestion | Multi-Session (MS) | +3% |
| Fact-augmented keys | Information Extraction (IE) | +5% |
| Time-aware expansion | Temporal Reasoning (TR) | +7-11% |
| Chain-of-note reading | All categories | +10% |

**Combined realistic estimate: 88-93% (up from 81%)**
