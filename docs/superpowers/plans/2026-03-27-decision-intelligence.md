# Cross-Platform Decision Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first commercial wedge for CSI — detect decisions across Gmail/Slack/GitHub, link cross-platform evidence, store structured decision objects, and enable provenance-aware recall.

**Architecture:** Five new decision tools (detect, classify, link, store, recall) registered in the Trail Executor. Heuristic detection is pure JS pattern matching. LLM classification uses Groq. Evidence linking uses existing searchMemories. Decision objects are stored as memories with `memory_type: "decision"`. Ten trails seeded for capture + recall flows.

**Tech Stack:** Node.js ES modules, Vitest, Groq API (LLM), Prisma (PostgreSQL), existing memory/connector infrastructure.

---

## File Structure

### New Files
```
core/src/executor/decision/detect-heuristics.js    — Heuristic decision candidate detection (per-platform patterns)
core/src/executor/decision/classify-decision.js     — LLM-based decision confirmation + structured extraction
core/src/executor/decision/link-evidence.js         — Cross-platform evidence search + corroboration scoring
core/src/executor/decision/store-decision.js        — Decision object writer with merge-on-key
core/src/executor/decision/recall-decision.js       — Multi-signal provenance-aware decision retrieval
core/src/executor/decision/decision-key.js          — Canonical decision key normalization + hashing
tests/executor/decision/detect-heuristics.test.js
tests/executor/decision/classify-decision.test.js
tests/executor/decision/store-decision.test.js
tests/executor/decision/recall-decision.test.js
```

### Modified Files
```
core/src/server.js                          — Register 5 new tools + seed 10 decision trails
```

---

## Task 1: Decision Key + Heuristic Detector

**Files:**
- Create: `core/src/executor/decision/decision-key.js`
- Create: `core/src/executor/decision/detect-heuristics.js`
- Create: `tests/executor/decision/detect-heuristics.test.js`

- [ ] **Step 1: Write tests**

```js
// tests/executor/decision/detect-heuristics.test.js
import { describe, it, expect } from 'vitest';
import { generateDecisionKey } from '../../core/src/executor/decision/decision-key.js';
import { detectDecisionCandidate } from '../../core/src/executor/decision/detect-heuristics.js';

describe('generateDecisionKey', () => {
  it('should normalize and hash consistently', () => {
    const key1 = generateDecisionKey('acme', 'choice', 'Use Redis for caching');
    const key2 = generateDecisionKey('acme', 'choice', 'use redis for caching');
    expect(key1).toBe(key2);
  });

  it('should strip punctuation and collapse whitespace', () => {
    const key1 = generateDecisionKey('acme', 'approval', 'Approved: the new API!');
    const key2 = generateDecisionKey('acme', 'approval', 'approved the new api');
    expect(key1).toBe(key2);
  });

  it('should produce different keys for different decisions', () => {
    const key1 = generateDecisionKey('acme', 'choice', 'Use Redis');
    const key2 = generateDecisionKey('acme', 'choice', 'Use Postgres');
    expect(key1).not.toBe(key2);
  });
});

describe('detectDecisionCandidate', () => {
  it('should detect Gmail approval pattern', () => {
    const result = detectDecisionCandidate({
      content: 'Looks good, approved. Let\'s proceed with the Redis approach.',
      platform: 'gmail',
      metadata: {},
    });
    expect(result.is_candidate).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some(s => s.includes('approved'))).toBe(true);
  });

  it('should detect Slack decision pattern', () => {
    const result = detectDecisionCandidate({
      content: 'We\'re going with option B for the deployment pipeline. Final answer.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.is_candidate).toBe(true);
  });

  it('should detect GitHub PR merge as decision signal', () => {
    const result = detectDecisionCandidate({
      content: 'Merging this PR after review approval.',
      platform: 'github',
      metadata: { eventType: 'pull_request.merged' },
    });
    expect(result.is_candidate).toBe(true);
    expect(result.signals.some(s => s.includes('pr_merged'))).toBe(true);
  });

  it('should NOT flag a simple status update', () => {
    const result = detectDecisionCandidate({
      content: 'Just pushed the latest changes. Build is green.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.is_candidate).toBe(false);
  });

  it('should NOT flag a question', () => {
    const result = detectDecisionCandidate({
      content: 'Should we use Redis or Postgres for caching?',
      platform: 'gmail',
      metadata: {},
    });
    expect(result.is_candidate).toBe(false);
  });

  it('should return confidence between 0 and 1', () => {
    const result = detectDecisionCandidate({
      content: 'We decided to go with the monorepo approach.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should flag needs_more_context for ambiguous content', () => {
    const result = detectDecisionCandidate({
      content: 'I think we should probably go with Redis maybe.',
      platform: 'slack',
      metadata: {},
    });
    // Ambiguous — hedging language
    if (result.is_candidate) {
      expect(result.needs_more_context).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/executor/decision/detect-heuristics.test.js
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement decision-key.js**

```js
// core/src/executor/decision/decision-key.js

import { createHash } from 'node:crypto';

/**
 * Normalize a string for decision key generation.
 * Lowercase, strip punctuation, collapse whitespace.
 * @param {string} str
 * @returns {string}
 */
export function normalizeForKey(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')   // collapse whitespace
    .trim();
}

/**
 * Generate a canonical decision key for deduplication.
 * @param {string} project
 * @param {string} decisionType
 * @param {string} statement
 * @returns {string}
 */
export function generateDecisionKey(project, decisionType, statement) {
  const normalized = `${normalizeForKey(project)}:${normalizeForKey(decisionType)}:${normalizeForKey(statement)}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}
```

- [ ] **Step 4: Implement detect-heuristics.js**

```js
// core/src/executor/decision/detect-heuristics.js

/**
 * Decision Intelligence — Heuristic Candidate Detector
 *
 * High-recall, low-cost pattern matching for decision signals.
 * Errs on the side of flagging too many (LLM confirms later).
 *
 * @module executor/decision/detect-heuristics
 */

// Decision signal phrases by platform
const DECISION_PHRASES = {
  common: [
    /\b(decided|decision|we('re| are) going with|let('s|us) (go with|proceed|move forward))\b/i,
    /\b(approved|approval|we agreed|consensus|final answer|resolved)\b/i,
    /\b(chosen|picked|selected|went with|opting for)\b/i,
    /\b(closing in favor|rejecting|declining|not going with)\b/i,
    /\b(prioritiz(e|ed|ing)|deprioritiz(e|ed|ing))\b/i,
    /\b(assigned to|taking ownership|i('ll| will) handle)\b/i,
  ],
  gmail: [
    /\b(please proceed|go ahead|sign(ed)? off|lgtm)\b/i,
  ],
  slack: [
    /\b(shipping|merging|deploying|rolling out)\b/i,
  ],
  github: [
    /\b(merged|closed|resolved|fixed)\b/i,
  ],
};

// Hedging phrases that reduce confidence
const HEDGING = [
  /\b(maybe|perhaps|might|could|probably|thinking about|considering)\b/i,
  /\b(not sure|uncertain|what if|should we)\b/i,
];

// Question patterns (reduce confidence significantly)
const QUESTION_PATTERNS = [
  /\?\s*$/,
  /\b(should we|what do you think|any thoughts|opinions)\b/i,
];

// GitHub event types that strongly indicate decisions
const GITHUB_DECISION_EVENTS = [
  'pull_request.merged',
  'pull_request.closed',
  'issues.closed',
  'pull_request_review.submitted',
];

/**
 * Detect whether content is a potential decision candidate.
 *
 * @param {{ content: string, platform: string, metadata: object }} input
 * @returns {{ is_candidate: boolean, signals: string[], confidence: number, needs_more_context: boolean }}
 */
export function detectDecisionCandidate({ content, platform, metadata = {} }) {
  const signals = [];
  let confidence = 0;

  if (!content || content.length < 10) {
    return { is_candidate: false, signals: [], confidence: 0, needs_more_context: false };
  }

  // Check common decision phrases
  for (const pattern of DECISION_PHRASES.common) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`phrase:${match[0].toLowerCase()}`);
      confidence += 0.25;
    }
  }

  // Check platform-specific phrases
  const platformPhrases = DECISION_PHRASES[platform] || [];
  for (const pattern of platformPhrases) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`phrase:${match[0].toLowerCase()}`);
      confidence += 0.15;
    }
  }

  // GitHub event type signals
  if (platform === 'github' && metadata.eventType) {
    if (GITHUB_DECISION_EVENTS.includes(metadata.eventType)) {
      signals.push(`event:${metadata.eventType.replace('.', '_')}`);
      confidence += 0.35;
    }
  }

  // Penalize questions
  let isQuestion = false;
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(content)) {
      isQuestion = true;
      confidence -= 0.4;
    }
  }

  // Check for hedging
  let isHedging = false;
  for (const pattern of HEDGING) {
    if (pattern.test(content)) {
      isHedging = true;
      confidence -= 0.15;
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  const is_candidate = confidence >= 0.15 && !isQuestion;
  const needs_more_context = is_candidate && (isHedging || confidence < 0.4);

  return { is_candidate, signals, confidence: +confidence.toFixed(2), needs_more_context };
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/executor/decision/detect-heuristics.test.js
```
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add core/src/executor/decision/decision-key.js core/src/executor/decision/detect-heuristics.js tests/executor/decision/detect-heuristics.test.js
git commit -m "feat: implement decision key normalization + heuristic candidate detector"
```

---

## Task 2: LLM Decision Classifier

**Files:**
- Create: `core/src/executor/decision/classify-decision.js`
- Create: `tests/executor/decision/classify-decision.test.js`

- [ ] **Step 1: Write tests**

```js
// tests/executor/decision/classify-decision.test.js
import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt, parseClassificationResponse } from '../../core/src/executor/decision/classify-decision.js';

describe('buildClassificationPrompt', () => {
  it('should produce a structured prompt', () => {
    const prompt = buildClassificationPrompt({
      content: 'Approved — let\'s go with Redis for the caching layer.',
      platform: 'gmail',
      context: { signals: ['phrase:approved'] },
    });
    expect(prompt).toContain('Redis');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('is_decision');
  });
});

describe('parseClassificationResponse', () => {
  it('should parse valid JSON classification', () => {
    const raw = JSON.stringify({
      is_decision: true,
      decision_type: 'approval',
      decision_statement: 'Use Redis for caching',
      rationale: 'Lower latency for hot keys',
      alternatives_rejected: ['Postgres'],
      participants: [{ name: 'Alice', role: 'approver', platform: 'gmail' }],
      confidence: 0.9,
      needs_more_context: false,
    });
    const result = parseClassificationResponse(raw);
    expect(result.is_decision).toBe(true);
    expect(result.decision_type).toBe('approval');
    expect(result.confidence).toBe(0.9);
  });

  it('should handle LLM wrapping JSON in markdown', () => {
    const raw = '```json\n{"is_decision": false, "confidence": 0.2}\n```';
    const result = parseClassificationResponse(raw);
    expect(result.is_decision).toBe(false);
  });

  it('should return safe default on parse failure', () => {
    const result = parseClassificationResponse('not json at all');
    expect(result.is_decision).toBe(false);
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Implement classify-decision.js**

```js
// core/src/executor/decision/classify-decision.js

/**
 * Decision Intelligence — LLM Decision Classifier
 *
 * High-precision confirmation + structured extraction via Groq API.
 * Only called for items that passed heuristic detection.
 *
 * @module executor/decision/classify-decision
 */

/**
 * Build a structured prompt for decision classification.
 * @param {{ content: string, platform: string, context: { signals: string[], thread_context?: string } }} input
 * @returns {string}
 */
export function buildClassificationPrompt({ content, platform, context }) {
  return `You are a decision classifier. Analyze this ${platform} content and determine if it contains a real organizational decision.

CONTENT:
${content}

DETECTION SIGNALS: ${(context.signals || []).join(', ')}
${context.thread_context ? `THREAD CONTEXT:\n${context.thread_context}` : ''}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "is_decision": true/false,
  "decision_type": "choice"|"approval"|"rejection"|"priority"|"assignment"|"resolution"|"policy",
  "decision_statement": "concise statement of what was decided",
  "rationale": "why this decision was made",
  "alternatives_rejected": ["list of alternatives that were not chosen"],
  "participants": [{"name": "person name", "role": "proposer|approver|reviewer|decider", "platform": "${platform}"}],
  "confidence": 0.0-1.0,
  "needs_more_context": true/false
}

Rules:
- A question is NOT a decision
- A suggestion without agreement is NOT a decision
- An approval or merge IS a decision
- A choice between alternatives IS a decision
- If uncertain, set is_decision=false and needs_more_context=true
- confidence should reflect how certain you are this is a real decision`;
}

/**
 * Parse LLM classification response, handling common format issues.
 * @param {string} raw
 * @returns {object}
 */
export function parseClassificationResponse(raw) {
  const DEFAULT = {
    is_decision: false, decision_type: null, decision_statement: null,
    rationale: null, alternatives_rejected: [], participants: [],
    confidence: 0, needs_more_context: false,
  };

  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);
    return { ...DEFAULT, ...parsed };
  } catch {
    return DEFAULT;
  }
}

/**
 * Classify a decision candidate using an LLM.
 * @param {{ content: string, platform: string, context: object }} input
 * @param {object} groqClient - Groq LLM client with generate() method
 * @returns {Promise<object>}
 */
export async function classifyDecision(input, groqClient) {
  if (!groqClient?.isAvailable()) {
    return { is_decision: false, confidence: 0, error: 'LLM unavailable' };
  }

  const prompt = buildClassificationPrompt(input);
  const raw = await groqClient.generate(prompt, {
    temperature: 0.1,
    maxTokens: 512,
  });

  return parseClassificationResponse(raw);
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/executor/decision/classify-decision.test.js
```
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add core/src/executor/decision/classify-decision.js tests/executor/decision/classify-decision.test.js
git commit -m "feat: implement LLM decision classifier with structured extraction"
```

---

## Task 3: Evidence Linker + Decision Store + Decision Recall

**Files:**
- Create: `core/src/executor/decision/link-evidence.js`
- Create: `core/src/executor/decision/store-decision.js`
- Create: `core/src/executor/decision/recall-decision.js`
- Create: `tests/executor/decision/store-decision.test.js`
- Create: `tests/executor/decision/recall-decision.test.js`

- [ ] **Step 1: Implement link-evidence.js**

```js
// core/src/executor/decision/link-evidence.js

/**
 * Decision Intelligence — Evidence Linker
 *
 * Cross-platform search for corroborating and conflicting evidence.
 * Uses existing searchMemories infrastructure.
 *
 * @module executor/decision/link-evidence
 */

/**
 * Link cross-platform evidence for a decision.
 * @param {{ decision_statement: string, tags: string[], source_platform: string, scope?: object }} input
 * @param {object} memoryStore - PrismaGraphStore with searchMemories()
 * @returns {Promise<{ supporting: object[], conflicting: object[], evidence_strength: number, related_decisions: object[] }>}
 */
export async function linkEvidence(input, memoryStore) {
  if (!memoryStore?.searchMemories) {
    return { supporting: [], conflicting: [], evidence_strength: 0, related_decisions: [] };
  }

  const { decision_statement, tags = [], source_platform, scope } = input;

  // Search for related content across all platforms
  const results = await memoryStore.searchMemories({
    query: decision_statement,
    n_results: 20,
    tags: tags.length ? tags : undefined,
    project: scope?.project,
  });

  const supporting = [];
  const conflicting = [];
  const related_decisions = [];

  for (const r of results) {
    if (r.score < 0.2) continue; // too weak

    const evidence = {
      platform: r.source_platform || 'unknown',
      ref_id: r.id,
      snippet: (r.content || '').substring(0, 200),
      score: r.score,
      tags: r.tags,
      timestamp: r.created_at,
    };

    // Skip same-platform same-content
    if (r.source_platform === source_platform && r.score > 0.95) continue;

    // Check if this is a related decision
    if (r.memory_type === 'decision') {
      related_decisions.push({
        id: r.id,
        relationship_type: 'related',
        statement: r.content?.substring(0, 100),
      });
      continue;
    }

    // Simple heuristic: high similarity = supporting, contradicting keywords = conflicting
    const hasContradiction = /\b(but|however|disagree|instead|rather|won't|shouldn't|against)\b/i.test(r.content || '');
    if (hasContradiction && r.score > 0.3) {
      conflicting.push(evidence);
    } else {
      supporting.push(evidence);
    }
  }

  // Evidence strength: based on unique platforms and count
  const uniquePlatforms = new Set(supporting.map(e => e.platform));
  const evidence_strength = Math.min(1, (supporting.length * 0.2) + (uniquePlatforms.size * 0.3));

  return {
    supporting: supporting.slice(0, 10),
    conflicting: conflicting.slice(0, 5),
    evidence_strength: +evidence_strength.toFixed(2),
    related_decisions,
  };
}
```

- [ ] **Step 2: Implement store-decision.js**

```js
// core/src/executor/decision/store-decision.js

/**
 * Decision Intelligence — Decision Store
 *
 * Writer only — does not judge. Persists decision objects as memories
 * with memory_type "decision". Handles merge-on-decision_key.
 *
 * @module executor/decision/store-decision
 */

import { randomUUID } from 'node:crypto';

/**
 * Compute decision status from promotion rules.
 * @param {number} confidence - LLM classification confidence
 * @param {number} evidenceStrength - cross-platform corroboration
 * @param {number} uniquePlatformCount - number of distinct evidence platforms
 * @returns {{ status: string, state_reason: string }}
 */
export function computeDecisionStatus(confidence, evidenceStrength, uniquePlatformCount) {
  if (confidence >= 0.8 && uniquePlatformCount >= 2) {
    return { status: 'validated', state_reason: 'cross_platform_corroborated' };
  }
  if (confidence >= 0.6) {
    return { status: 'candidate', state_reason: uniquePlatformCount < 2 ? 'single_source_only' : 'moderate_confidence' };
  }
  return { status: 'candidate', state_reason: 'low_classifier_confidence' };
}

/**
 * Store a decision object as a memory. Handles merge-on-decision_key.
 * @param {{ decision_object: object }} input
 * @param {object} memoryStore - PrismaGraphStore with searchMemories, createMemory
 * @returns {Promise<{ decision_id: string, status: string, merged: boolean, stored: boolean, done: boolean }>}
 */
export async function storeDecision({ decision_object }, memoryStore) {
  if (!memoryStore) {
    return { decision_id: null, status: 'error', merged: false, stored: false, done: true };
  }

  const dKey = decision_object.decision_key;

  // Check for existing decision with same key (merge-on-key)
  let merged = false;
  if (dKey && memoryStore.searchMemories) {
    const existing = await memoryStore.searchMemories({
      query: decision_object.decision_statement,
      memory_type: 'decision',
      n_results: 5,
    });

    for (const ex of existing) {
      const exMeta = ex.metadata || {};
      if (exMeta.decision_key === dKey) {
        // Merge: add new evidence to existing
        const existingEvidence = exMeta.evidence || { supporting: [], conflicting: [] };
        const newSupporting = decision_object.evidence?.supporting || [];
        const newConflicting = decision_object.evidence?.conflicting || [];

        existingEvidence.supporting = [...existingEvidence.supporting, ...newSupporting];
        existingEvidence.conflicting = [...existingEvidence.conflicting, ...newConflicting];

        // Re-evaluate status after merge
        const uniquePlatforms = new Set(existingEvidence.supporting.map(e => e.platform));
        const { status, state_reason } = computeDecisionStatus(
          Math.max(exMeta.confidence || 0, decision_object.confidence || 0),
          decision_object.evidence_strength || 0,
          uniquePlatforms.size,
        );

        // Update existing memory (if store supports it)
        if (memoryStore.updateMemory) {
          await memoryStore.updateMemory(ex.id, {
            metadata: {
              ...exMeta,
              evidence: existingEvidence,
              status,
              decision_state_reason: state_reason,
              confidence: Math.max(exMeta.confidence || 0, decision_object.confidence || 0),
            },
          });
        }

        return { decision_id: ex.id, status, merged: true, stored: true, done: true };
      }
    }
  }

  // Create new decision memory
  const id = randomUUID();
  const { status, state_reason } = computeDecisionStatus(
    decision_object.confidence || 0,
    decision_object.evidence_strength || 0,
    new Set((decision_object.evidence?.supporting || []).map(e => e.platform)).size,
  );

  const memory = {
    id,
    content: decision_object.decision_statement,
    memory_type: 'decision',
    tags: decision_object.tags || [],
    source_platform: decision_object.source_platform || 'unknown',
    metadata: {
      ...decision_object,
      status,
      decision_state_reason: state_reason,
      review_status: 'unreviewed',
    },
  };

  if (memoryStore.createMemory) {
    await memoryStore.createMemory(memory);
  }

  return { decision_id: id, status, merged: false, stored: true, done: true };
}
```

- [ ] **Step 3: Implement recall-decision.js**

```js
// core/src/executor/decision/recall-decision.js

/**
 * Decision Intelligence — Decision Recall
 *
 * Provenance-aware decision retrieval with multi-signal ranking.
 *
 * @module executor/decision/recall-decision
 */

/**
 * Recall decisions with provenance-aware multi-signal ranking.
 * @param {{ query: string, scope?: object, project?: string, top_k?: number }} input
 * @param {object} memoryStore
 * @returns {Promise<{ decisions: object[], total_found: number, done: boolean }>}
 */
export async function recallDecision(input, memoryStore) {
  if (!memoryStore?.searchMemories) {
    return { decisions: [], total_found: 0, done: true };
  }

  const { query, scope, project, top_k = 5 } = input;

  const results = await memoryStore.searchMemories({
    query,
    memory_type: 'decision',
    project: project || scope?.project,
    n_results: top_k * 3, // over-fetch for re-ranking
  });

  const now = Date.now();
  const decisions = results.map(r => {
    const meta = r.metadata || {};
    const semanticMatch = r.score || 0;
    const isValidated = meta.status === 'validated' ? 1 : 0.5;
    const evidenceStrength = meta.evidence_strength || 0;
    const ageMs = now - new Date(r.created_at || 0).getTime();
    const recencyScore = Math.max(0, 1 - (ageMs / (30 * 86400000))); // decay over 30 days
    const scopeMatch = (project && meta.scope?.project === project) ? 1 : 0.5;
    const contradictionPenalty = (meta.evidence?.conflicting?.length || 0) > 0 ? 0.2 : 0;

    const recall_score =
      0.35 * semanticMatch +
      0.20 * isValidated +
      0.15 * evidenceStrength +
      0.15 * recencyScore +
      0.10 * scopeMatch +
      0.05 * (1 - contradictionPenalty);

    // Completeness: how much of the decision object is filled
    const fields = [meta.rationale, meta.evidence?.supporting?.length, meta.participants?.length];
    const completeness_score = fields.filter(Boolean).length / fields.length;

    return {
      decision_id: r.id,
      decision_statement: r.content,
      decision_type: meta.decision_type,
      rationale: meta.rationale,
      evidence: meta.evidence,
      participants: meta.participants,
      confidence: meta.confidence,
      evidence_strength: meta.evidence_strength,
      status: meta.status,
      scope: meta.scope,
      detected_at: meta.detected_at,
      recall_score: +recall_score.toFixed(3),
      completeness_score: +completeness_score.toFixed(2),
    };
  });

  // Sort by recall_score descending
  decisions.sort((a, b) => b.recall_score - a.recall_score);

  return {
    decisions: decisions.slice(0, top_k),
    total_found: decisions.length,
    done: true,
  };
}
```

- [ ] **Step 4: Write store + recall tests**

```js
// tests/executor/decision/store-decision.test.js
import { describe, it, expect } from 'vitest';
import { computeDecisionStatus } from '../../core/src/executor/decision/store-decision.js';

describe('computeDecisionStatus', () => {
  it('should auto-validate high confidence + multi-platform', () => {
    const { status } = computeDecisionStatus(0.9, 0.8, 2);
    expect(status).toBe('validated');
  });

  it('should stay candidate with single source', () => {
    const { status, state_reason } = computeDecisionStatus(0.7, 0.5, 1);
    expect(status).toBe('candidate');
    expect(state_reason).toBe('single_source_only');
  });

  it('should stay candidate with low confidence', () => {
    const { status } = computeDecisionStatus(0.5, 0.3, 3);
    expect(status).toBe('candidate');
  });
});
```

```js
// tests/executor/decision/recall-decision.test.js
import { describe, it, expect } from 'vitest';
import { recallDecision } from '../../core/src/executor/decision/recall-decision.js';

describe('recallDecision', () => {
  it('should return empty for no store', async () => {
    const result = await recallDecision({ query: 'test' }, null);
    expect(result.decisions).toHaveLength(0);
    expect(result.done).toBe(true);
  });

  it('should rank validated decisions higher', async () => {
    const mockStore = {
      searchMemories: async () => [
        { id: '1', content: 'Use Redis', score: 0.8, memory_type: 'decision', created_at: new Date().toISOString(), metadata: { status: 'candidate', evidence_strength: 0.3 } },
        { id: '2', content: 'Use Redis for caching', score: 0.8, memory_type: 'decision', created_at: new Date().toISOString(), metadata: { status: 'validated', evidence_strength: 0.9, evidence: { supporting: [{}, {}] } } },
      ],
    };
    const result = await recallDecision({ query: 'Redis caching' }, mockStore);
    expect(result.decisions[0].status).toBe('validated');
    expect(result.decisions[0].recall_score).toBeGreaterThan(result.decisions[1].recall_score);
  });

  it('should include completeness_score', async () => {
    const mockStore = {
      searchMemories: async () => [
        { id: '1', content: 'Decision', score: 0.9, memory_type: 'decision', created_at: new Date().toISOString(),
          metadata: { rationale: 'Good reason', evidence: { supporting: [{}] }, participants: [{}] } },
      ],
    };
    const result = await recallDecision({ query: 'test' }, mockStore);
    expect(result.decisions[0].completeness_score).toBe(1);
  });
});
```

- [ ] **Step 5: Run all decision tests**

```bash
npx vitest run tests/executor/decision/
```
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add core/src/executor/decision/link-evidence.js core/src/executor/decision/store-decision.js core/src/executor/decision/recall-decision.js tests/executor/decision/store-decision.test.js tests/executor/decision/recall-decision.test.js
git commit -m "feat: implement link-evidence, store-decision, recall-decision tools"
```

---

## Task 4: Register Tools + Seed Trails in Server

**Files:**
- Modify: `core/src/server.js`

- [ ] **Step 1: Add decision tool imports**

After the existing executor imports (around line 125):

```js
const { detectDecisionCandidate } = await import('./executor/decision/detect-heuristics.js');
const { classifyDecision } = await import('./executor/decision/classify-decision.js');
const { linkEvidence } = await import('./executor/decision/link-evidence.js');
const { storeDecision } = await import('./executor/decision/store-decision.js');
const { recallDecision } = await import('./executor/decision/recall-decision.js');
const { generateDecisionKey } = await import('./executor/decision/decision-key.js');
```

- [ ] **Step 2: Register 5 decision tool definitions**

After the existing tool registrations (around line 245):

```js
  // Decision Intelligence tools
  trailToolRegistry.register({
    name: 'detect_decision_candidate',
    description: 'Heuristic scan for decision signals in content',
    params: {
      content: { type: 'string', required: true, description: 'Raw content to scan' },
      platform: { type: 'string', required: true, description: 'Source platform (gmail/slack/github)' },
    },
    maxTokens: 1000, timeoutMs: 5000,
  });
  trailToolRegistry.register({
    name: 'classify_decision',
    description: 'LLM-based decision confirmation and structured extraction',
    params: {
      content: { type: 'string', required: true, description: 'Content to classify' },
      platform: { type: 'string', required: true, description: 'Source platform' },
    },
    maxTokens: 2000, timeoutMs: 15000,
  });
  trailToolRegistry.register({
    name: 'link_evidence',
    description: 'Cross-platform evidence search for decision corroboration',
    params: {
      decision_statement: { type: 'string', required: true, description: 'Decision to find evidence for' },
    },
    maxTokens: 5000, timeoutMs: 15000,
  });
  trailToolRegistry.register({
    name: 'store_decision',
    description: 'Store a structured decision object with merge-on-key',
    params: {
      decision_statement: { type: 'string', required: true, description: 'The decision statement' },
      decision_type: { type: 'string', required: true, description: 'Type of decision' },
    },
    maxTokens: 2000, timeoutMs: 10000,
  });
  trailToolRegistry.register({
    name: 'recall_decision',
    description: 'Provenance-aware decision retrieval',
    params: {
      query: { type: 'string', required: true, description: 'Natural language recall query' },
    },
    maxTokens: 5000, timeoutMs: 10000,
  });
```

- [ ] **Step 3: Register 5 decision tool executors**

After the existing tool runner registrations:

```js
  // Decision tool executors
  trailToolRunner.register('detect_decision_candidate', async (params) => {
    return detectDecisionCandidate({
      content: params.content,
      platform: params.platform,
      metadata: params.metadata || {},
    });
  });

  trailToolRunner.register('classify_decision', async (params) => {
    return classifyDecision({
      content: params.content,
      platform: params.platform,
      context: { signals: params.signals || [], thread_context: params.thread_context },
    }, groqClient);
  });

  trailToolRunner.register('link_evidence', async (params) => {
    return linkEvidence({
      decision_statement: params.decision_statement,
      tags: params.tags || [],
      source_platform: params.source_platform || 'unknown',
      scope: params.scope,
    }, persistentMemoryStore);
  });

  trailToolRunner.register('store_decision', async (params) => {
    const dKey = generateDecisionKey(
      params.scope?.project || 'default',
      params.decision_type || 'choice',
      params.decision_statement,
    );
    return storeDecision({
      decision_object: {
        decision_key: dKey,
        decision_statement: params.decision_statement,
        decision_type: params.decision_type || 'choice',
        rationale: params.rationale,
        alternatives_rejected: params.alternatives_rejected || [],
        participants: params.participants || [],
        evidence: params.evidence || { supporting: [], conflicting: [] },
        confidence: params.confidence || 0.5,
        evidence_strength: params.evidence_strength || 0,
        source_platform: params.source_platform || 'unknown',
        tags: params.tags || [],
        scope: params.scope,
        detected_at: new Date().toISOString(),
      },
    }, persistentMemoryStore);
  });

  trailToolRunner.register('recall_decision', async (params) => {
    return recallDecision({
      query: params.query,
      scope: params.scope,
      project: params.project,
      top_k: params.top_k || 5,
    }, persistentMemoryStore);
  });
```

- [ ] **Step 4: Seed 10 decision trails**

After trail executor initialization, add trail seeding (only if store supports it):

```js
  // Seed decision intelligence trails (idempotent — trails are checked by goalId)
  const decisionTrails = [
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['gmail', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['slack', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['github', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'classify_decision', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['classify'], weight: 0.7, confidence: 0.7 },
    { goalId: 'capture_decision', tool: 'link_evidence', params: { decision_statement: '$ctx.decision_statement' }, tags: ['link', 'evidence'], weight: 0.65, confidence: 0.7 },
    { goalId: 'capture_decision', tool: 'store_decision', params: { decision_statement: '$ctx.decision_statement', decision_type: '$ctx.decision_type' }, tags: ['store', 'decision'], weight: 0.6, confidence: 0.7 },
    { goalId: 'recall_decision', tool: 'recall_decision', params: { query: '$ctx.query' }, tags: ['recall', 'query'], weight: 0.8, confidence: 0.8 },
    { goalId: 'recall_decision', tool: 'recall_decision', params: { query: '$ctx.query', project: '$ctx.project' }, tags: ['recall', 'scope'], weight: 0.75, confidence: 0.8 },
  ];

  for (const t of decisionTrails) {
    const existing = await executorStore.getCandidateTrails(t.goalId);
    const alreadyExists = existing.some(e => e.nextAction?.tool === t.tool && JSON.stringify(e.tags) === JSON.stringify(t.tags));
    if (!alreadyExists) {
      await executorStore.putTrail({
        id: crypto.randomUUID(),
        goalId: t.goalId,
        agentId: 'system',
        status: 'active',
        kind: 'raw',
        nextAction: { tool: t.tool, paramsTemplate: t.params },
        steps: [],
        executionEventIds: [],
        successScore: 0,
        confidence: t.confidence,
        weight: t.weight,
        decayRate: 0.05,
        tags: t.tags,
        createdAt: new Date().toISOString(),
      });
    }
  }
  console.log('[DecisionIntelligence] Decision tools registered, trails seeded');
```

- [ ] **Step 5: Verify server syntax**

```bash
node --check core/src/server.js
```
Expected: No errors.

- [ ] **Step 6: Run all tests**

```bash
npx vitest run tests/executor/
```
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/server.js
git commit -m "feat: register decision intelligence tools + seed 10 capture/recall trails"
```

---

## Task 5: Deploy + End-to-End Validation

**Files:** None (deploy and test only)

- [ ] **Step 1: Deploy**

```bash
bash /opt/HIVEMIND/scripts/deploy.sh core
```

- [ ] **Step 2: Verify decision tools registered**

```bash
API_KEY="hmk_live_6e3c4962c39612fcd54fe65fbf2a41f70418e8c971d13841"
USER_ID="986ac853-5597-40b2-b48a-02dc88d3ae1d"
BASE="http://localhost:3001"

curl -s "$BASE/api/swarm/executor/status" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Tools: {d[\"tools\"]}')
print(f'Decision tools present: {all(t in d[\"tools\"] for t in [\"detect_decision_candidate\", \"classify_decision\", \"link_evidence\", \"store_decision\", \"recall_decision\"])}')
"
```

- [ ] **Step 3: Test decision capture pipeline**

```bash
# Seed a capture trail manually and execute
curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d '{
    "goal": "capture_decision",
    "agent_id": "decision_scanner",
    "max_steps": 4,
    "routing": { "temperature": 0.5 }
  }' | python3 -c "
import sys, json
d = json.load(sys.stdin)
cs = d['chainSummary']
print(f'Steps: {d[\"stepsExecuted\"]} | Tools: {\" → \".join(cs[\"toolSequence\"])} | Done: {cs[\"doneReason\"]} | Failures: {d[\"finalState\"][\"failuresCount\"]}')
"
```

- [ ] **Step 4: Test decision recall**

```bash
curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d '{
    "goal": "recall_decision",
    "agent_id": "decision_recall",
    "max_steps": 2,
    "routing": { "temperature": 0.3 }
  }' | python3 -m json.tool
```

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: decision intelligence deployed — 5 tools, 10 trails, capture + recall verified"
git push origin main
```

---

## Success Criteria Checklist

- [ ] Heuristic detector correctly flags decision phrases (≥ 5/7 test cases)
- [ ] Heuristic detector rejects questions and status updates
- [ ] LLM classifier produces structured decision JSON
- [ ] Classifier handles markdown-wrapped responses
- [ ] Decision key normalization is consistent (case, punctuation, whitespace)
- [ ] Store decision computes correct promotion status
- [ ] Recall ranks validated decisions higher than candidates
- [ ] Recall includes completeness score
- [ ] All 5 decision tools registered and appear in executor/status
- [ ] Decision trails seeded for capture_decision and recall_decision goals
- [ ] Capture pipeline executes end-to-end with ≥ 1 tool call
- [ ] All existing 141+ tests still pass

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Plan Complete |
