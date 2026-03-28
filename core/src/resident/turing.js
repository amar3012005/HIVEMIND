import { randomUUID } from 'node:crypto';

function confidenceToVerdict(confidence) {
  if (confidence >= 0.85) return 'likely_true';
  if (confidence >= 0.65) return 'uncertain';
  return 'weak';
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function inferSourceSpread(hypothesis = {}) {
  const relatedFiles = Array.isArray(hypothesis.related_files) ? hypothesis.related_files : [];
  const memoryIds = Array.isArray(hypothesis.related_memory_ids)
    ? hypothesis.related_memory_ids
    : Array.isArray(hypothesis.evidence_refs)
      ? hypothesis.evidence_refs
      : [];
  const threadHints = relatedFiles
    .map((value) => String(value))
    .filter((value) => value.startsWith('thread:') || value.startsWith('issue:') || value.startsWith('project:'));
  return unique([...memoryIds, ...threadHints]).length;
}

function buildGraphActions(hypothesis, evaluation) {
  const actions = [];
  const evidenceRefs = unique(hypothesis.evidence_refs || []);
  const relatedMemoryIds = unique(hypothesis.related_memory_ids || hypothesis.evidence_refs || []);
  const relatedFiles = unique(hypothesis.related_files || []);
  const hypothesisType = String(hypothesis.hypothesis_type || '').toLowerCase();
  const verdict = evaluation.verdict;

  if (hypothesisType === 'stale_or_conflicting_truth') {
    actions.push({
      action: verdict === 'likely_true' ? 'link_update_chain' : 'relationship_candidate',
      confidence: evaluation.confidence,
      reason: 'This cluster looks like stale truth versus newer truth and should be linked as an update chain rather than left disconnected.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      expected_impact: 'Increase temporal coherence and reduce contradictory retrieval.',
    });
  }

  if (hypothesisType === 'recurring_operational_issue' && evidenceRefs.length >= 2) {
    actions.push({
      action: verdict === 'likely_true' ? 'promote_known_risk' : 'relationship_candidate',
      confidence: Math.max(0.55, evaluation.confidence - 0.03),
      reason: 'Repeated operational issue evidence should be linked into a canonical risk pattern rather than remaining isolated reports.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      expected_impact: 'Increase graph connectivity across repeated incidents.',
    });
  }

  if (evidenceRefs.length >= 2 && hypothesis.novelty_score < 0.45) {
    actions.push({
      action: 'suppress_noise_cluster',
      confidence: Math.max(0.5, evaluation.confidence - 0.08),
      reason: 'This pattern appears low-novelty and repetitive; suppressing it reduces noise for later agents.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      expected_impact: 'Reduce duplicate hypotheses and lower operational clutter.',
    });
  }

  if (evaluation.verdict === 'likely_true' && evidenceRefs.length >= 3 && relatedMemoryIds.length >= 2) {
    actions.push({
      action: 'merge_duplicate_cluster',
      confidence: evaluation.confidence,
      reason: 'The evidence is strong enough to recommend a canonical merge or cluster promotion review.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      expected_impact: 'Create a cleaner canonical node and reduce fragmented duplicate state.',
    });
  }

  if (!actions.length && (relatedMemoryIds.length >= 2 || relatedFiles.length >= 2)) {
    actions.push({
      action: 'relationship_candidate',
      confidence: Math.max(0.52, evaluation.confidence - 0.1),
      reason: 'This cluster spans multiple linked memories or files and should at least be connected explicitly for future reasoning.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      expected_impact: 'Improve graph connectivity and reduce isolated duplicate reasoning paths.',
    });
  }

  return actions;
}

function candidateKindForAction(action) {
  if (action === 'merge_duplicate_cluster') return 'merge_candidate';
  if (action === 'suppress_noise_cluster') return 'noise_reduction_candidate';
  if (action === 'promote_known_risk') return 'promotion_candidate';
  return 'relationship_candidate';
}

function candidateSummaryForAction(action, region) {
  if (action === 'merge_duplicate_cluster') return `Merge candidate: consolidate duplicate cluster for ${region}.`;
  if (action === 'suppress_noise_cluster') return `Noise reduction candidate: suppress repetitive cluster for ${region}.`;
  if (action === 'promote_known_risk') return `Promotion candidate: elevate ${region} into a known risk pattern.`;
  if (action === 'link_update_chain') return `Relationship candidate: link stale-versus-new truth updates for ${region}.`;
  return `Relationship candidate: connect related memories for ${region}.`;
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
  graphActions = [],
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
      graph_actions: graphActions,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

function candidateObservation({
  runId,
  hypothesis,
  graphAction,
}) {
  return {
    id: randomUUID(),
    agent_id: 'turing',
    kind: candidateKindForAction(graphAction.action),
    certainty: graphAction.confidence,
    content: {
      summary: candidateSummaryForAction(graphAction.action, hypothesis.region || hypothesis.summary || 'this cluster'),
      recommendation: graphAction.action,
      rationale: graphAction.reason,
      expected_impact: graphAction.expected_impact,
      target_memory_ids: graphAction.target_memory_ids || [],
      source_hypothesis_id: hypothesis.id,
      confidence: graphAction.confidence,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

function evaluateHypothesis(hypothesis = {}) {
  const checks = Array.isArray(hypothesis.verification_checks) ? hypothesis.verification_checks : [];
  const evidenceRefs = unique(hypothesis.evidence_refs || []);
  const relatedFiles = unique(hypothesis.related_files || []);
  const noveltyScore = Number(hypothesis.novelty_score || 0);
  const confidence = Number(hypothesis.confidence || 0);
  const checksPassed = [];
  const checksMissing = [];
  const sourceSpread = inferSourceSpread(hypothesis);

  if (evidenceRefs.length >= 3) {
    checksPassed.push('enough_evidence_refs');
  } else {
    checksMissing.push('enough_evidence_refs');
  }

  if (sourceSpread >= 3 || relatedFiles.length >= 2) {
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
  const graphActions = buildGraphActions(hypothesis, {
    verdict,
    confidence: verificationConfidence,
  });

  return {
    verdict,
    confidence: verificationConfidence,
    checksPassed,
    checksMissing,
    supportRatio,
    sourceSpread,
    graphActions,
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
  if (evaluation.graphActions.length) {
    parts.push(`Recommended graph actions: ${evaluation.graphActions.map((action) => action.action).join(', ')}.`);
  }
  if (hypothesis.counter_evidence) {
    parts.push(`Counter-evidence to watch: ${hypothesis.counter_evidence}`);
  }
  return parts.join(' ');
}

function buildVerificationMark({ runId, scope, project, region, goal, verifications, candidateObservations }) {
  const promoted = candidateObservations.filter((item) => item.kind === 'promotion_candidate');
  const mergeCandidates = candidateObservations.filter((item) => item.kind === 'merge_candidate');
  const relationshipCandidates = candidateObservations.filter((item) => item.kind === 'relationship_candidate');
  const noiseReductionCandidates = candidateObservations.filter((item) => item.kind === 'noise_reduction_candidate');
  const weak = verifications.filter((item) => item.content.verdict === 'weak');
  const trailId = randomUUID();
  const markKey = `resident-turing:${runId}`;
  const nextPrompt = promoted.length || mergeCandidates.length || relationshipCandidates.length || noiseReductionCandidates.length
    ? 'Review Turing graph actions and apply the safe merge, relationship, noise-reduction, or promotion candidates.'
    : 'No hypothesis is promotion-ready yet; revisit the missing checks before promotion.';

  return {
    id: trailId,
    trail_id: trailId,
    mark_key: markKey,
    goalId: `resident:${scope}:${project || 'workspace'}`,
    agentId: 'turing',
    status: 'active',
    kind: 'resident_verification_mark',
    summary: promoted.length || mergeCandidates.length || relationshipCandidates.length || noiseReductionCandidates.length
      ? `Turing produced ${candidateObservations.length} graph-shaping actions from ${verifications.length} verifications.`
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
      graph_actions: item.content.graph_actions || [],
    })),
    action_candidates: candidateObservations.map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.content.summary,
      recommendation: item.content.recommendation,
      confidence: item.certainty,
      target_memory_ids: item.content.target_memory_ids || [],
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
      merge_candidate_count: mergeCandidates.length,
      relationship_candidate_count: relationshipCandidates.length,
      noise_reduction_candidate_count: noiseReductionCandidates.length,
      weak_count: weak.length,
      verification_results: verifications.map((item) => ({
        id: item.id,
        summary: item.content.summary,
        verdict: item.content.verdict,
        confidence: item.certainty,
      })),
      action_candidates: candidateObservations.map((item) => ({
        id: item.id,
        kind: item.kind,
        recommendation: item.content.recommendation,
        confidence: item.certainty,
      })),
      next_agent_prompt: nextPrompt,
    },
    nextAction: {
      toolName: candidateObservations.length ? 'resident.apply_graph_actions' : 'resident.revisit_hypothesis',
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
          params: {
            verification_count: verifications.length,
            action_candidate_count: candidateObservations.length,
          },
        },
        resultSummary: candidateObservations.length
          ? `Verification completed with ${candidateObservations.length} graph-shaping recommendations.`
          : 'Verification completed with no promotion-ready hypotheses.',
        tokensUsed: 0,
        durationMs: 0,
        timestamp: Date.now(),
      },
    ],
    executionEventIds: [],
    successScore: candidateObservations.length ? 0.86 : 0.45,
    confidence: promoted[0]?.certainty || verifications[0]?.certainty || 0.5,
    weight: candidateObservations.length ? 0.84 : 0.5,
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

    await updateProgress(1, 4, 'loading_hypotheses');

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

    await updateProgress(2, 4, 'verifying_hypotheses');

    const verificationPairs = hypothesisItems.slice(0, 3).map((hypothesis) => {
      const evaluation = evaluateHypothesis(hypothesis);
      const summary = evaluation.verdict === 'likely_true'
        ? `Verification: ${hypothesis.summary} is likely true.`
        : evaluation.verdict === 'uncertain'
          ? `Verification: ${hypothesis.summary} is plausible but still uncertain.`
          : `Verification: ${hypothesis.summary} is too weak to promote yet.`;

      const verification = verificationObservation({
        runId,
        verdict: evaluation.verdict,
        summary,
        rationale: verificationRationale(hypothesis, evaluation),
        verificationChecks: hypothesis.verification_checks || [],
        checksPassed: evaluation.checksPassed,
        checksMissing: evaluation.checksMissing,
        evidenceRefs: hypothesis.evidence_refs || [],
        relatedFiles: hypothesis.related_files || [],
        relatedMemoryIds: hypothesis.related_memory_ids || hypothesis.evidence_refs || [],
        confidence: evaluation.confidence,
        nextAction: evaluation.graphActions.length
          ? 'Review the recommended graph actions and apply the safe ones.'
          : evaluation.verdict === 'likely_true'
            ? 'Promote this finding with human review.'
            : 'Gather stronger cross-memory evidence before promotion.',
        hypothesisId: hypothesis.id,
        graphActions: evaluation.graphActions,
      });

      const actionCandidates = evaluation.graphActions.map((graphAction) => candidateObservation({
        runId,
        hypothesis,
        graphAction,
      }));

      return { verification, actionCandidates };
    });

    const verifications = verificationPairs.map((item) => item.verification);
    const actionCandidates = verificationPairs.flatMap((item) => item.actionCandidates);

    if (!actionCandidates.length && verifications.length) {
      const fallbackVerification = verifications[0];
      actionCandidates.push({
        id: randomUUID(),
        agent_id: 'turing',
        kind: 'relationship_candidate',
        certainty: Math.max(0.5, Number(fallbackVerification.certainty || 0.6) - 0.08),
        content: {
          summary: 'Relationship candidate: collect and connect the strongest verified cluster before promotion.',
          recommendation: 'relationship_candidate',
          rationale: 'Turing verified a nontrivial hypothesis but lacked enough explicit spread to recommend merge or promotion. The safest next step is to connect the related evidence for future reasoning.',
          expected_impact: 'Improve graph connectivity and give later agents a denser evidence trail.',
          target_memory_ids: fallbackVerification.content.related_memory_ids || [],
          source_hypothesis_id: fallbackVerification.content.verified_hypothesis_id,
          confidence: Math.max(0.5, Number(fallbackVerification.certainty || 0.6) - 0.08),
        },
        source_event_id: runId,
        related_to_trail: runId,
        timestamp: new Date().toISOString(),
      });
    }

    await updateProgress(3, 4, 'writing_verifications');

    if (!dryRun && this.observationStore?.writeObservation) {
      for (const observation of [...verifications, ...actionCandidates]) {
        await this.observationStore.writeObservation(observation);
      }
    }

    await updateProgress(4, 4, 'building_graph_actions');

    const verificationMark = buildVerificationMark({
      runId,
      scope,
      project,
      region,
      goal,
      verifications,
      candidateObservations: actionCandidates,
    });

    return {
      status: 'completed',
      observations: [...verifications, ...actionCandidates],
      observations_count: verifications.length + actionCandidates.length,
      current_step: 'completed',
      verification_results: verifications.map((item) => ({
        id: item.id,
        summary: item.content.summary,
        verdict: item.content.verdict,
        confidence: item.certainty,
        checks_passed: item.content.checks_passed,
        checks_missing: item.content.checks_missing,
        graph_actions: item.content.graph_actions || [],
      })),
      action_candidates: actionCandidates.map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.content.summary,
        recommendation: item.content.recommendation,
        confidence: item.certainty,
        target_memory_ids: item.content.target_memory_ids || [],
        rationale: item.content.rationale || '',
        expected_impact: item.content.expected_impact || '',
      })),
      summary: {
        scope,
        project,
        region,
        goal,
        source_run_id: feynmanRun?.run_id || null,
        source_trail_id: feynmanTrail?.id || feynmanTrail?.trail_id || null,
        verification_count: verifications.length,
        action_candidate_count: actionCandidates.length,
        promoted_count: actionCandidates.filter((item) => item.kind === 'promotion_candidate').length,
      },
      trail_mark: verificationMark,
      completed_at: new Date().toISOString(),
    };
  }
}
