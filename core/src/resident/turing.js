import { randomUUID } from 'node:crypto';

function confidenceToVerdict(confidence) {
  if (confidence >= 0.70) return 'likely_true';
  if (confidence >= 0.50) return 'uncertain';
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
      evidence_memory_ids: evidenceRefs.slice(0, 6),
      relationship_type: verdict === 'likely_true' ? 'Updates' : 'Derives',
      expected_impact: 'Increase temporal coherence and reduce contradictory retrieval.',
    });
  }

  if (hypothesisType === 'recurring_operational_issue' && evidenceRefs.length >= 2) {
    actions.push({
      action: verdict === 'likely_true' ? 'promote_known_risk' : 'relationship_candidate',
      confidence: Math.max(0.55, evaluation.confidence - 0.03),
      reason: 'Repeated operational issue evidence should be linked into a canonical risk pattern rather than remaining isolated reports.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      evidence_memory_ids: evidenceRefs.slice(0, 6),
      relationship_type: 'Derives',
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

  if (evaluation.verdict === 'likely_true' && evidenceRefs.length >= 2 && relatedMemoryIds.length >= 1) {
    // No-merge policy: emit archive_duplicates (keep canonical, hide
    // copies as is_latest=false) instead of merging content together.
    actions.push({
      action: 'archive_duplicates',
      confidence: evaluation.confidence,
      reason: 'Strong evidence of duplicate cluster — keep canonical version, archive the rest (reversible).',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      evidence_memory_ids: evidenceRefs.slice(0, 6),
      expected_impact: 'Reduce duplicate noise in recall while preserving every original row as version history.',
    });
  }

  // When multiple memories together imply a new conclusion, create a Derives relationship
  if (evaluation.verdict === 'likely_true' && relatedMemoryIds.length >= 3 && evidenceRefs.length >= 2) {
    const alreadyHasDerivesAction = actions.some((a) => a.relationship_type === 'Derives');
    if (!alreadyHasDerivesAction) {
      actions.push({
        action: 'relationship_candidate',
        confidence: Math.max(0.6, evaluation.confidence - 0.05),
        reason: 'Multiple memories together imply a synthesized conclusion — linking them with Derives edges to capture the inferential relationship.',
        target_memory_ids: relatedMemoryIds.slice(0, 6),
        evidence_memory_ids: evidenceRefs.slice(0, 6),
        relationship_type: 'Derives',
        expected_impact: 'Capture inferential provenance so downstream agents can trace how conclusions were derived.',
      });
    }
  }

  if (!actions.length && (relatedMemoryIds.length >= 1 || relatedFiles.length >= 1)) {
    actions.push({
      action: 'relationship_candidate',
      confidence: Math.max(0.52, evaluation.confidence - 0.1),
      reason: 'This cluster spans multiple linked memories or files and should at least be connected explicitly for future reasoning.',
      target_memory_ids: relatedMemoryIds.slice(0, 6),
      evidence_memory_ids: evidenceRefs.slice(0, 6),
      relationship_type: relatedMemoryIds.length >= 3 ? 'Derives' : 'Extends',
      expected_impact: 'Improve graph connectivity and reduce isolated duplicate reasoning paths.',
    });
  }

  return actions;
}

function candidateKindForAction(action) {
  if (action === 'archive_duplicates') return 'archive_duplicates';
  if (action === 'merge_duplicate_cluster') return 'archive_duplicates'; // legacy alias
  if (action === 'suppress_noise_cluster') return 'noise_reduction_candidate';
  if (action === 'promote_known_risk') return 'promotion_candidate';
  return 'relationship_candidate';
}

function candidateSummaryForAction(action, region) {
  if (action === 'archive_duplicates') return `Archive duplicates: keep canonical, hide other copies for ${region}.`;
  if (action === 'merge_duplicate_cluster') return `Archive duplicates: keep canonical, hide other copies for ${region}.`;
  if (action === 'suppress_noise_cluster') return `Suppress noise: lower importance for repetitive cluster around ${region}.`;
  if (action === 'promote_known_risk') return `Promote: elevate ${region} into a known-risk pattern.`;
  if (action === 'link_update_chain') return `Link update chain: connect old → new truth around ${region}.`;
  return `Connect related memories around ${region}.`;
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
      evidence_memory_ids: graphAction.evidence_memory_ids || [],
      source_hypothesis_id: hypothesis.id,
      confidence: graphAction.confidence,
      ...(graphAction.relationship_type ? { relationship_type: graphAction.relationship_type } : {}),
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

    // ── Phase 4 — Synthesis proposals (governance owns cognitive layer) ──
    // Heuristic emitters. Conservative thresholds keep noise low; downstream
    // approve flow gates the actual write. Three families:
    //   - canonical_synthesis: ≥2 likely_true verifications sharing ≥1 evidence_ref
    //   - bridge_synthesis:    ≥2 verifications from disjoint clusters sharing entity tag
    //   - compression:         ≥3 verifications grouped by same hypothesis topic
    try {
      const liked = verifications.filter((v) => v.content?.verdict === 'likely_true');
      const evCounts = new Map();
      for (const v of liked) {
        for (const id of (v.content?.related_memory_ids || v.content?.evidence_refs || [])) {
          evCounts.set(id, (evCounts.get(id) || 0) + 1);
        }
      }
      const sharedEvidence = [...evCounts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
      if (liked.length >= 2 && sharedEvidence.length >= 1) {
        actionCandidates.push({
          id: randomUUID(),
          agent_id: 'turing',
          kind: 'merge_candidate', // existing observation kind closest fit
          certainty: 0.82,
          content: {
            summary: `Canonical synthesis: ${liked.length} verified hypotheses share ${sharedEvidence.length} evidence.`,
            recommendation: 'canonical_synthesis',
            rationale: 'Multiple likely_true verifications converge on a stable cluster — promote to canonical layer.',
            expected_impact: 'Top-down recall surfaces a single canonical answer instead of fragments.',
            target_memory_ids: sharedEvidence.slice(0, 8),
            confidence: 0.82,
          },
          source_event_id: runId,
          related_to_trail: runId,
          timestamp: new Date().toISOString(),
        });
      }

      // Compression — when ≥3 verifications cluster on same hypothesis topic.
      const topicGroups = new Map();
      for (const v of verifications) {
        const topic = (v.content?.summary || '').match(/[a-z][a-z0-9_-]{3,}/i)?.[0]?.toLowerCase();
        if (!topic) continue;
        if (!topicGroups.has(topic)) topicGroups.set(topic, []);
        topicGroups.get(topic).push(v);
      }
      for (const [topic, group] of topicGroups) {
        if (group.length >= 3) {
          const evidenceIds = [...new Set(group.flatMap((v) => v.content?.related_memory_ids || []))].slice(0, 12);
          if (evidenceIds.length >= 3) {
            actionCandidates.push({
              id: randomUUID(),
              agent_id: 'turing',
              kind: 'merge_candidate',
              certainty: 0.78,
              content: {
                summary: `Compress ${group.length} hypotheses around "${topic}" into a canonical summary.`,
                recommendation: 'compression',
                rationale: 'Cluster size exceeds compression threshold — collapse to summary memory.',
                expected_impact: 'Reduces recall noise; canonical-summary surfaces via top-down boost.',
                target_memory_ids: evidenceIds,
                topic,
                confidence: 0.78,
              },
              source_event_id: runId,
              related_to_trail: runId,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // Bridge synthesis — pairs of verifications with disjoint clusters
      // sharing >=1 entity tag (extracted from hypothesis summary).
      if (liked.length >= 2) {
        const tagsOf = (v) => new Set(
          (v.content?.summary || '')
            .match(/[A-Z][a-zA-Z0-9_-]{2,}/g)
            ?.map((s) => s.toLowerCase()) || []
        );
        const evSetOf = (v) => new Set(v.content?.related_memory_ids || []);
        for (let i = 0; i < liked.length; i += 1) {
          for (let j = i + 1; j < liked.length; j += 1) {
            const ti = tagsOf(liked[i]);
            const tj = tagsOf(liked[j]);
            const ei = evSetOf(liked[i]);
            const ej = evSetOf(liked[j]);
            const sharedTag = [...ti].find((t) => tj.has(t));
            const disjointEv = [...ei].every((id) => !ej.has(id));
            if (sharedTag && disjointEv && ei.size >= 1 && ej.size >= 1) {
              actionCandidates.push({
                id: randomUUID(),
                agent_id: 'turing',
                kind: 'relationship_candidate',
                certainty: 0.74,
                content: {
                  summary: `Bridge clusters linked by "${sharedTag}".`,
                  recommendation: 'bridge_synthesis',
                  rationale: 'Two verified clusters share an entity but no overlapping evidence — bridge them.',
                  expected_impact: 'Cross-cluster recall via bridge memory.',
                  target_memory_ids: [...ei, ...ej].slice(0, 8),
                  bridge_tag: sharedTag,
                  confidence: 0.74,
                },
                source_event_id: runId,
                related_to_trail: runId,
                timestamp: new Date().toISOString(),
              });
              break; // one bridge per cluster pair is enough
            }
          }
        }
      }
    } catch (synthErr) {
      // Synthesis emit is best-effort; never block the rest of Turing.
      console.warn?.(`[turing] synthesis emit failed: ${synthErr?.message || synthErr}`);
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
