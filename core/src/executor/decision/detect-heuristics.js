// core/src/executor/decision/detect-heuristics.js

/**
 * Decision Intelligence — Heuristic Candidate Detector
 *
 * Two-tier signal system:
 *   STRONG signals = high confidence, likely real decisions
 *   WEAK signals   = proposals/leanings that need LLM confirmation
 *
 * High-recall, low-cost pattern matching.
 * Errs on the side of flagging too many (LLM confirms later).
 *
 * @module executor/decision/detect-heuristics
 */

// ─── STRONG decision signals (high confidence) ──────────────────────────────
const STRONG_SIGNALS = {
  common: [
    /\b(decided|decision|i decided|we decided)\b/i,
    /\b(approved|approving|approval)\b/i,
    /\b(we agreed|agreed|consensus|final answer|resolved)\b/i,
    /\b(chosen|chose|picked|selected|went with)\b/i,
    /\b(accepted|accepting|declined|declining)\b/i,
    /\b(rejected|rejecting|not going with|closing in favor)\b/i,
    /\b(assigned|assigned to)\b/i,
    /\b(confirmed|supersede(s|d)?)\b/i,
    /\b(we('re| are) going with|going with)\b/i,
    /\b(merged)\b/i,
    /\b(deferred|postponed|tabled)\b/i,
    /\b(overrid(e|ing|den))\b/i,
  ],
  gmail: [
    /\b(please proceed|go ahead|sign(ed)? off|lgtm)\b/i,
  ],
  slack: [
    /\b(shipping|deploying|rolling out|rollout complete|is live|shipped)\b/i,
  ],
  github: [
    /\b(closed|fixed|ticket created)\b/i,
  ],
};

// ─── WEAK decision signals (proposals/leanings — need LLM) ──────────────────
const WEAK_SIGNALS = {
  common: [
    /\b(i think we should|we should go with|should go with)\b/i,
    /\b(i('m| am) going with|switching to|migrating to|moving to)\b/i,
    /\b(let('s|us) (go with|proceed|move forward|do it|use))\b/i,
    /\b(prefer|i('m| am) leaning toward|leaning towards|i like .+ more|better than)\b/i,
    /\b(opting for|opting to)\b/i,
    /\b(can we bump|bump(ed|ing)? to p[0-3]|now p[0-3])\b/i,
    /\b(can you own|taking ownership|i('ll| will) handle)\b/i,
    /\b(prioritiz(e|ed|ing)|deprioritiz(e|ed|ing))\b/i,
    /\b(revisit|we('ll| will) revisit)\b/i,
    /\b(great call|good call|right call)\b/i,
  ],
  gmail: [],
  slack: [
    /\b(merging|great call)\b/i,
  ],
  github: [],
};

// Hedging phrases that reduce confidence
const HEDGING = [
  /\b(maybe|perhaps|might|could|probably|thinking about|considering)\b/i,
  /\b(not sure|uncertain|what if)\b/i,
];

// Question patterns (reduce confidence but don't auto-reject if strong signals present)
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

// Platforms to skip (system-generated content, not human decisions)
const SKIP_PLATFORMS = ['observer', 'system'];

/**
 * Detect whether content is a potential decision candidate.
 *
 * @param {{ content: string, platform: string, metadata: object }} input
 * @returns {{ is_candidate: boolean, signals: string[], confidence: number, needs_more_context: boolean, signal_strength: 'strong'|'weak'|'none' }}
 */
export function detectDecisionCandidate({ content, platform, metadata = {} }) {
  const signals = [];
  let confidence = 0;
  let hasStrongSignal = false;
  let hasWeakSignal = false;

  if (!content || content.length < 10) {
    return { is_candidate: false, signals: [], confidence: 0, needs_more_context: false, signal_strength: 'none' };
  }

  // Skip system-generated platforms
  if (SKIP_PLATFORMS.includes(platform)) {
    return { is_candidate: false, signals: [], confidence: 0, needs_more_context: false, signal_strength: 'none' };
  }

  // Check STRONG signals (high confidence)
  for (const pattern of STRONG_SIGNALS.common) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`strong:${match[0].toLowerCase()}`);
      confidence += 0.25;
      hasStrongSignal = true;
    }
  }
  const strongPlatform = STRONG_SIGNALS[platform] || [];
  for (const pattern of strongPlatform) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`strong:${match[0].toLowerCase()}`);
      confidence += 0.20;
      hasStrongSignal = true;
    }
  }

  // Check WEAK signals (proposals/leanings — need LLM confirmation)
  for (const pattern of WEAK_SIGNALS.common) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`weak:${match[0].toLowerCase()}`);
      confidence += 0.15;
      hasWeakSignal = true;
    }
  }
  const weakPlatform = WEAK_SIGNALS[platform] || [];
  for (const pattern of weakPlatform) {
    const match = content.match(pattern);
    if (match) {
      signals.push(`weak:${match[0].toLowerCase()}`);
      confidence += 0.10;
      hasWeakSignal = true;
    }
  }

  // GitHub event type signals (always strong)
  if (platform === 'github' && metadata.eventType) {
    if (GITHUB_DECISION_EVENTS.includes(metadata.eventType)) {
      signals.push(`event:${metadata.eventType.replace('pull_request.', 'pr_').replace('.', '_')}`);
      confidence += 0.35;
      hasStrongSignal = true;
    }
  }

  // Penalize questions (scaled by signal strength)
  let isQuestion = false;
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(content)) {
      isQuestion = true;
      // Strong signals survive questions; weak signals get modest penalty
      confidence -= hasStrongSignal ? 0.10 : (hasWeakSignal ? 0.10 : 0.4);
    }
  }

  // Check for hedging (reduces confidence, marks as needs_more_context)
  let isHedging = false;
  for (const pattern of HEDGING) {
    if (pattern.test(content)) {
      isHedging = true;
      confidence -= 0.10;
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));

  // Candidate if any signal found with sufficient confidence
  const is_candidate = confidence >= 0.10 && (hasStrongSignal || hasWeakSignal);
  const needs_more_context = is_candidate && (hasWeakSignal && !hasStrongSignal || isHedging || confidence < 0.3);
  const signal_strength = hasStrongSignal ? 'strong' : (hasWeakSignal ? 'weak' : 'none');

  return { is_candidate, signals, confidence: +confidence.toFixed(2), needs_more_context, signal_strength };
}
