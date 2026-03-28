import { randomUUID } from 'node:crypto';

function confidenceToVerdict(confidence) {
  if (confidence >= 0.85) return 'likely_true';
  if (confidence >= 0.65) return 'uncertain';
  return 'weak';
}

function verificationObservation({
  runId,
  verdict,
  summary,
  rationale,
  verificationChecks = [],
  checksPassed = [],
  checksMissing = [],
  evidenceRefs = [],
  relatedFiles = [],
  relatedMemoryIds = [],
  confidence,
  nextAction,
  hypothesisId,
}) {
  return {
    id: randomUUID(),
    agent_id: 'turing',
    kind: 'verification',
    certainty: confidence,
    content: {
      summary,
      verdict,
      rationale,
      verification_checks: verificationChecks,
      checks_passed: checksPassed,
      checks_missing: checksMissing,
      evidence_refs: evidenceRefs,
      related_files: relatedFiles,
      related_memory_ids: relatedMemoryIds,
      verified_hypothesis_id: hypothesisId,
      confidence,
      next_action: nextAction,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

function evaluateHypothesis(hypothesis = {}) {
  const checks = Array.isArray(hypothesis.verification_checks) ? hypothesis.verification_checks : [];
  const evidenceRefs = Array.isArray(hypothesis.evidence_refs) ? hypothesis.evidence_refs : [];
  const relatedFiles = Array.isArray(hypothesis.related_files) ? hypothesis.related_files : [];
  const noveltyScore = Number(hypothesis.novelty_score || 0);
  const confidence = Number(hypothesis.confidence || 0);
  const checksPassed = [];
  const checksMissing = [];

  if (evidenceRefs.length >= 3) {
    checksPassed.push('enough_evidence_refs');
  } else {
    checksMissing.push('enough_evidence_refs');
  }

  if (relatedFiles.length >= 2) {
    checksPassed.push('cross_memory_spread');
  } else {
    checksMissing.push('cross_memory_spread');
  }

  if (checks.length >= 2) {
    checksPassed.push('explicit_verification_plan');
  } else {
    checksMissing.push('explicit_verification_plan');
  }

  if (noveltyScore >= 0.55) {
    checksPassed.push('novel_pattern');
  } else {
    checksMissing.push('novel_pattern');
  }

  const supportRatio = checksPassed.length / Math.max(1, checksPassed.length + checksMissing.length);
  const verificationConfidence = Math.min(0.95, confidence * 0.7 + supportRatio * 0.3);
  const verdict = confidenceToVerdict(verificationConfidence);

  return {
    verdict,
    confidence: verificationConfidence,
    checksPassed,
    checksMissing,
    supportRatio,
  };
}

function verificationRationale(hypothesis, evaluation) {
  const parts = [
    `Turing evaluated the hypothesis "${hypothesis.summary}".`,
  ];
  if (evaluation.checksPassed.length) {
    parts.push(`Passed checks: ${evaluation.checksPassed.join(', ')}.`);
  }
  if (evaluation.checksMissing.length) {
    parts.push(`Missing checks: ${evaluation.checksMissing.join(', ')}.`);
  }
  if (hypothesis.counter_evidence) {
    parts.push(`Counter-evidence to watch: ${hypothesis.counter_evidence}`);
  }
  return parts.join(' ');
}

function buildVerificationMark({ runId, scope, project, region, goal, verifications }) {
  const promoted = verifications.filter((item) => item.content.verdict === 'likely_true');
  const weak = verifications.filter((item) => item.content.verdict === 'weak');
  const trailId = randomUUID();
  const markKey = `resident-turing:${runId}`;
  const nextPrompt = promoted.length
    ? `Promote the strongest verified finding from Turing into canonical graph knowledge with review.`
    : `No hypothesis is promotion-ready yet; revisit the missing checks before promotion.`;

  return {
    id: trailId,
    trail_id: trailId,
    mark_key: markKey,
    goalId: `resident:${scope}:${project || 'workspace'}`,
    agentId: 'turing',
    status: 'active',
    kind: 'resident_verification_mark',
    summary: promoted.length
      ? `${promoted.length} hypotheses are verification-ready.`
      : 'No hypothesis passed verification strongly enough for promotion.',
    next_agent_prompt: nextPrompt,
    verification_results: verifications.map((item) => ({
      id: item.id,
      summary: item.content.summary,
      verdict: item.content.verdict,
      confidence: item.certainty,
      verified_hypothesis_id: item.content.verified_hypothesis_id,
      checks_passed: item.content.checks_passed,
      checks_missing: item.content.checks_missing,
    })),
    blueprintMeta: {
      resident_verification_mark: true,
      mark_key: markKey,
      run_id: runId,
      scope,
      project,
      region,
      goal,
      promoted_count: promoted.length,
      weak_count: weak.length,
      verification_results: verifications.map((item) => ({
        id: item.id,
        summary: item.content.summary,
        verdict: item.content.verdict,
        confidence: item.certainty,
      })),
      next_agent_prompt: nextPrompt,
    },
    nextAction: {
      toolName: promoted.length ? 'resident.promote_verified_finding' : 'resident.revisit_hypothesis',
      params: {
        run_id: runId,
        trail_id: trailId,
        mark_key: markKey,
        project,
        region,
      },
      rationale: nextPrompt,
    },
    steps: [
      {
        index: 0,
        status: 'succeeded',
        action: {
          toolName: 'resident.verify_hypothesis',
          params: { verification_count: verifications.length },
        },
        resultSummary: promoted.length
          ? `${promoted.length} hypotheses reached likely_true.`
          : 'Verification completed with no promotion-ready hypotheses.',
        tokensUsed: 0,
        durationMs: 0,
        timestamp: Date.now(),
      },
    ],
    executionEventIds: [],
    successScore: promoted.length ? 0.82 : 0.45,
    confidence: promoted[0]?.certainty || verifications[0]?.certainty || 0.5,
    weight: promoted.length ? 0.82 : 0.5,
    decayRate: 0.02,
    tags: [
      'resident',
      'turing',
      'verification_mark',
      `scope:${scope}`,
      ...(project ? [`project:${project}`] : []),
    ],
    createdAt: new Date().toISOString(),
  };
}

export class TuringAgent {
  constructor({ observationStore, logger = console } = {}) {
    this.observationStore = observationStore;
    this.logger = logger;
  }

  async run({
    runId,
    scope = 'project',
    project = null,
    region = null,
    goal = '',
    dryRun = false,
    feynmanRun = null,
    feynmanTrail = null,
    hypotheses = [],
    onProgress = async () => {},
    isCancelled = () => false,
  } = {}) {
    const updateProgress = async (step, totalSteps, currentStep) => {
      await onProgress({
        step,
        total_steps: totalSteps,
        current_step: currentStep,
        percent: Math.round((step / totalSteps) * 100),
      });
    };

    await updateProgress(1, 3, 'loading_hypotheses');

    const hypothesisItems = Array.isArray(hypotheses) && hypotheses.length
      ? hypotheses
      : Array.isArray(feynmanRun?.result?.hypotheses)
        ? feynmanRun.result.hypotheses
        : Array.isArray(feynmanTrail?.blueprintMeta?.hypotheses)
          ? feynmanTrail.blueprintMeta.hypotheses
          : [];

    if (!hypothesisItems.length) {
      return {
        status: 'failed',
        observations: [],
        observations_count: 0,
        current_step: 'missing_feynman_context',
        error: 'No Feynman hypotheses were available for Turing to verify.',
      };
    }

    if (isCancelled()) {
      return {
        status: 'cancelled',
        observations: [],
        observations_count: 0,
        current_step: 'cancelled_before_verification',
      };
    }

    await updateProgress(2, 3, 'verifying_hypotheses');

    const verifications = hypothesisItems.slice(0, 3).map((hypothesis) => {
      const evaluation = evaluateHypothesis(hypothesis);
      const summary = evaluation.verdict === 'likely_true'
        ? `Verification: ${hypothesis.summary} is likely true.`
        : evaluation.verdict === 'uncertain'
          ? `Verification: ${hypothesis.summary} is plausible but still uncertain.`
          : `Verification: ${hypothesis.summary} is too weak to promote yet.`;

      return verificationObservation({
        runId,
        verdict: evaluation.verdict,
        summary,
        rationale: verificationRationale(hypothesis, evaluation),
        verificationChecks: hypothesis.verification_checks || [],
        checksPassed: evaluation.checksPassed,
        checksMissing: evaluation.checksMissing,
        evidenceRefs: hypothesis.evidence_refs || [],
        relatedFiles: hypothesis.related_files || [],
        relatedMemoryIds: hypothesis.evidence_refs || [],
        confidence: evaluation.confidence,
        nextAction: evaluation.verdict === 'likely_true'
          ? 'Promote this finding with human review.'
          : 'Gather stronger cross-memory evidence before promotion.',
        hypothesisId: hypothesis.id,
      });
    });

    await updateProgress(3, 3, 'writing_verifications');

    if (!dryRun && this.observationStore?.writeObservation) {
      for (const verification of verifications) {
        await this.observationStore.writeObservation(verification);
      }
    }

    const verificationMark = buildVerificationMark({
      runId,
      scope,
      project,
      region,
      goal,
      verifications,
    });

    return {
      status: 'completed',
      observations: verifications,
      observations_count: verifications.length,
      current_step: 'completed',
      verification_results: verifications.map((item) => ({
        id: item.id,
        summary: item.content.summary,
        verdict: item.content.verdict,
        confidence: item.certainty,
        checks_passed: item.content.checks_passed,
        checks_missing: item.content.checks_missing,
      })),
      summary: {
        scope,
        project,
        region,
        goal,
        source_run_id: feynmanRun?.run_id || null,
        source_trail_id: feynmanTrail?.id || feynmanTrail?.trail_id || null,
        verification_count: verifications.length,
        promoted_count: verifications.filter((item) => item.content.verdict === 'likely_true').length,
      },
      trail_mark: verificationMark,
      completed_at: new Date().toISOString(),
    };
  }
}
