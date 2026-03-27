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
    /\b(decided|decision|i decided|we decided|we('re| are) going with|going with|let('s|us) (go with|proceed|move forward))\b/i,
    /\b(approved|approval|we agreed|agreed|consensus|final answer|resolved)\b/i,
    /\b(chosen|chose|picked|selected|went with|opting for)\b/i,
    /\b(accepted|accepting|declined|declining|rejected|rejecting|not going with|closing in favor)\b/i,
    /\b(prioritiz(e|ed|ing)|deprioritiz(e|ed|ing))\b/i,
    /\b(assigned|assigned to|taking ownership|i('ll| will) handle)\b/i,
    /\b(i('m| am) going with|switching to|migrating to|moving to)\b/i,
    /\b(i like .+ more|prefer .+ over|better than)\b/i,
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
      signals.push(`event:${metadata.eventType.replace('pull_request.', 'pr_').replace('.', '_')}`);
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
