import { randomUUID } from 'node:crypto';

function normalizeWords(values = []) {
  return values
    .flatMap((value) => String(value || '').toLowerCase().split(/[\s/._:-]+/))
    .map((token) => token.trim())
    .filter(Boolean);
}

function inferHypothesisType(cluster = {}) {
  const words = normalizeWords([cluster.label, ...(cluster.keywords || [])]);
  if (words.some((word) => ['failed', 'error', 'incident', 'notification', 'deploy'].includes(word))) {
    return 'recurring_operational_issue';
  }
  if (words.some((word) => ['policy', 'updated', 'verify', 'vacation', 'days'].includes(word))) {
    return 'stale_or_conflicting_truth';
  }
  if (words.some((word) => ['meeting', 'standup', 'moved', 'schedule', 'monday'].includes(word))) {
    return 'temporal_update_chain';
  }
  if (cluster.count >= 5) {
    return 'repeated_pattern_cluster';
  }
  return 'emerging_pattern';
}

function buildSummary(type, cluster) {
  const label = cluster.label || 'semantic region';
  if (type === 'recurring_operational_issue') {
    return `Hypothesis: ${label} is a recurring operational issue rather than isolated memory noise.`;
  }
  if (type === 'stale_or_conflicting_truth') {
    return `Hypothesis: ${label} contains stale or conflicting truth that should be reconciled.`;
  }
  if (type === 'temporal_update_chain') {
    return `Hypothesis: ${label} reflects an update chain that needs temporal verification.`;
  }
  if (type === 'repeated_pattern_cluster') {
    return `Hypothesis: ${label} is a repeated pattern cluster worth formalizing.`;
  }
  return `Hypothesis: ${label} is a meaningful semantic pattern, not just an isolated memory.`;
}

function summariseSupportingSignals(observationKinds = []) {
  const counts = new Map();
  for (const kind of observationKinds) {
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}${count > 1 ? ` x${count}` : ''}`);
}

function buildVerificationChecks(type, cluster) {
  const label = cluster.label || 'semantic region';
  if (type === 'recurring_operational_issue') {
    return [
      `Check whether the evidence refs for "${label}" span multiple threads or memory sources.`,
      `Check whether the latest related memories still indicate failure rather than a resolved state.`,
      `Check whether the same keywords recur in distinct evidence refs, not just one duplicated memory.`,
    ];
  }
  if (type === 'stale_or_conflicting_truth') {
    return [
      `Check whether the evidence refs for "${label}" contain contradictory numeric or policy values.`,
      `Check whether one evidence ref is clearly newer and should supersede the others.`,
      `Check whether the underlying memories should be linked through an update relationship.`,
    ];
  }
  if (type === 'temporal_update_chain') {
    return [
      `Check whether the evidence refs for "${label}" describe a before/after state change.`,
      `Check whether the latest memory agrees with the proposed timeline.`,
      `Check whether the cluster mixes two separate schedules that should not be merged.`,
    ];
  }
  return [
    `Check whether the evidence refs for "${label}" come from more than one conversation or source.`,
    `Check whether the cluster has enough distinct evidence to justify a reusable finding.`,
  ];
}

function buildCounterEvidence(type, cluster) {
  const label = cluster.label || 'semantic region';
  if (type === 'recurring_operational_issue') {
    return `Counter-evidence would be a newer memory showing ${label} was resolved or a single duplicated thread causing the cluster.`;
  }
  if (type === 'stale_or_conflicting_truth') {
    return `Counter-evidence would be a clear latest memory that resolves the older policy statements in ${label}.`;
  }
  if (type === 'temporal_update_chain') {
    return `Counter-evidence would be a latest memory showing no actual state transition for ${label}.`;
  }
  return `Counter-evidence would show that ${label} is only one narrow conversation fragment and not a cross-memory pattern.`;
}

function buildWhyNow({ cluster, faradayRun, scope }) {
  const count = cluster.count || 0;
  const updatedAt = faradayRun?.updated_at || faradayRun?.finished_at || null;
  const timePart = updatedAt ? ` It was surfaced in the latest ${scope} Faraday pass at ${updatedAt}.` : '';
  if (count >= 5) {
    return `This matters now because the cluster already spans ${count} related memories, which is large enough to hide repeated failure or stale-truth patterns.${timePart}`;
  }
  return `This matters now because the cluster has enough repeated evidence to justify verification before it hardens into graph knowledge.${timePart}`;
}

function buildEvidenceSummary(cluster = {}) {
  const fileCount = Array.isArray(cluster.related_files) ? cluster.related_files.length : 0;
  const evidenceCount = Array.isArray(cluster.evidence_refs) ? cluster.evidence_refs.length : 0;
  const keywordSummary = (cluster.keywords || []).slice(0, 5).join(', ');
  return `Cluster size ${cluster.count || 0}; evidence refs ${evidenceCount}; related files ${fileCount}; keywords: ${keywordSummary || 'n/a'}.`;
}

function buildRationale({ cluster, observationKinds = [], scope, goal }) {
  const parts = [
    `Faraday grouped ${cluster.count} related memories under "${cluster.label}".`,
  ];
  if (cluster.keywords?.length) {
    parts.push(`Shared keywords: ${cluster.keywords.slice(0, 5).join(', ')}.`);
  }
  const signals = summariseSupportingSignals(observationKinds);
  if (signals.length) {
    parts.push(`Supporting observations: ${signals.join(', ')}.`);
  }
  if (goal) {
    parts.push(`This aligns with the resident goal: ${goal}.`);
  }
  parts.push(`Treat this as a ${scope} explanation candidate until Turing verifies it.`);
  return parts.join(' ');
}

function computeNoveltyScore(cluster = {}) {
  const evidenceCount = Array.isArray(cluster.evidence_refs) ? cluster.evidence_refs.length : 0;
  const keywordCount = Array.isArray(cluster.keywords) ? cluster.keywords.length : 0;
  return Math.min(1, 0.3 + evidenceCount * 0.08 + keywordCount * 0.03);
}

function computeConfidence(cluster = {}, type) {
  const base = type === 'stale_or_conflicting_truth' ? 0.58 : 0.54;
  const count = Math.min(cluster.count || 0, 6);
  const fileSpread = Math.min((cluster.related_files || []).length, 5);
  return Math.min(0.94, base + count * 0.05 + fileSpread * 0.02);
}

function hypothesisObservation({
  runId,
  summary,
  rationale,
  hypothesisType,
  region,
  confidence,
  whyNow,
  evidenceSummary,
  evidenceRefs = [],
  relatedFiles = [],
  relatedMemoryIds = [],
  verificationChecks = [],
  counterEvidence,
  nextAction,
  supportingSignals = [],
  noveltyScore,
  claimsToVerify = [],
}) {
  return {
    id: randomUUID(),
    agent_id: 'feynman',
    kind: 'hypothesis',
    certainty: confidence,
    content: {
      summary,
      rationale,
      hypothesis_type: hypothesisType,
      region,
      confidence,
      why_now: whyNow,
      supporting_evidence_summary: evidenceSummary,
      evidence_refs: evidenceRefs,
      related_files: relatedFiles,
      related_memory_ids: relatedMemoryIds,
      supporting_signals: supportingSignals,
      verification_checks: verificationChecks,
      counter_evidence: counterEvidence,
      novelty_score: noveltyScore,
      claims_to_verify: claimsToVerify,
      next_action: nextAction,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

function buildHypothesisMark({ runId, scope, project, region, goal, hypotheses }) {
  const lead = hypotheses[0] || null;
  const trailId = randomUUID();
  const markKey = `resident-feynman:${runId}`;
  const leadSummary = lead?.content?.summary || 'Verify the strongest Feynman hypothesis.';
  const nextPrompt = lead
    ? `Use Turing to verify the hypothesis "${lead.content.summary}" against the linked evidence.`
    : 'Use Turing to verify whether the strongest hypothesis is supported by the evidence.';

  return {
    id: trailId,
    trail_id: trailId,
    mark_key: markKey,
    goalId: `resident:${scope}:${project || 'workspace'}`,
    agentId: 'feynman',
    status: 'active',
    kind: 'resident_hypothesis_mark',
    summary: leadSummary,
    next_agent_prompt: nextPrompt,
    hypotheses: hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      summary: hypothesis.content.summary,
      rationale: hypothesis.content.rationale,
      hypothesis_type: hypothesis.content.hypothesis_type,
      confidence: hypothesis.certainty,
      why_now: hypothesis.content.why_now,
      supporting_evidence_summary: hypothesis.content.supporting_evidence_summary,
      evidence_refs: hypothesis.content.evidence_refs || [],
      related_files: hypothesis.content.related_files || [],
      verification_checks: hypothesis.content.verification_checks || [],
    })),
    blueprintMeta: {
      resident_hypothesis_mark: true,
      mark_key: markKey,
      run_id: runId,
      scope,
      project,
      region,
      goal,
      hypotheses: hypotheses.map((hypothesis) => ({
        id: hypothesis.id,
        summary: hypothesis.content.summary,
        rationale: hypothesis.content.rationale,
        hypothesis_type: hypothesis.content.hypothesis_type,
        confidence: hypothesis.certainty,
        why_now: hypothesis.content.why_now,
        supporting_evidence_summary: hypothesis.content.supporting_evidence_summary,
        evidence_refs: hypothesis.content.evidence_refs || [],
        verification_checks: hypothesis.content.verification_checks || [],
      })),
      next_agent_prompt: nextPrompt,
    },
    nextAction: {
      toolName: 'resident.verify_hypothesis',
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
          toolName: 'resident.explain_cluster',
          params: { hypothesis_count: hypotheses.length },
        },
        resultSummary: leadSummary,
        tokensUsed: 0,
        durationMs: 0,
        timestamp: Date.now(),
      },
    ],
    executionEventIds: [],
    successScore: lead ? Math.min(1, 0.55 + lead.certainty * 0.35) : 0.4,
    confidence: lead?.certainty || 0.55,
    weight: lead ? Math.min(1, 0.45 + lead.certainty * 0.45) : 0.45,
    decayRate: 0.02,
    tags: [
      'resident',
      'feynman',
      'hypothesis_mark',
      `scope:${scope}`,
      ...(project ? [`project:${project}`] : []),
    ],
    createdAt: new Date().toISOString(),
  };
}

export class FeynmanAgent {
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
    faradayRun = null,
    faradayTrail = null,
    faradayObservations = [],
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

    await updateProgress(1, 3, 'loading_trail_mark');

    const trailMark = faradayRun?.trail_mark || faradayTrail?.blueprintMeta || faradayTrail || null;
    const semanticClusters = Array.isArray(trailMark?.semantic_clusters)
      ? trailMark.semantic_clusters
      : Array.isArray(faradayRun?.result?.semantic_clusters)
        ? faradayRun.result.semantic_clusters
        : [];

    if (!semanticClusters.length) {
      return {
        status: 'failed',
        observations: [],
        observations_count: 0,
        current_step: 'missing_faraday_context',
        error: 'No Faraday trail mark or semantic clusters were available for Feynman.',
      };
    }

    if (isCancelled()) {
      return {
        status: 'cancelled',
        observations: [],
        observations_count: 0,
        current_step: 'cancelled_before_reasoning',
      };
    }

    await updateProgress(2, 3, 'forming_hypotheses');

    const observationKinds = faradayObservations.map((observation) => observation.kind).filter(Boolean);
    const hypotheses = semanticClusters.slice(0, 3).map((cluster) => {
      const type = inferHypothesisType(cluster);
      const confidence = computeConfidence(cluster, type);
      const verificationChecks = buildVerificationChecks(type, cluster);
      const claimsToVerify = [
        buildSummary(type, cluster).replace(/^Hypothesis:\s*/, '').replace(/\.$/, ''),
        `Evidence count remains coherent across ${cluster.count || 0} related memories`,
      ];

      return hypothesisObservation({
        runId,
        summary: buildSummary(type, cluster),
        rationale: buildRationale({ cluster, observationKinds, scope, goal }),
        hypothesisType: type,
        region: cluster.label || region || project || scope,
        confidence,
        whyNow: buildWhyNow({ cluster, faradayRun, scope }),
        evidenceSummary: buildEvidenceSummary(cluster),
        evidenceRefs: cluster.evidence_refs || [],
        relatedFiles: cluster.related_files || [],
        relatedMemoryIds: cluster.evidence_refs || [],
        verificationChecks,
        counterEvidence: buildCounterEvidence(type, cluster),
        noveltyScore: computeNoveltyScore(cluster),
        claimsToVerify,
        nextAction: `Ask Turing to verify whether "${cluster.label}" is a real ${type.replaceAll('_', ' ')}.`,
        supportingSignals: summariseSupportingSignals(observationKinds),
      });
    });

    if (!hypotheses.length) {
      return {
        status: 'completed',
        observations: [],
        observations_count: 0,
        current_step: 'completed',
        summary: {
          scope,
          project,
          region,
          goal,
          hypothesis_count: 0,
        },
        completed_at: new Date().toISOString(),
      };
    }

    await updateProgress(3, 3, 'writing_hypotheses');

    if (!dryRun && this.observationStore?.writeObservation) {
      for (const hypothesis of hypotheses) {
        await this.observationStore.writeObservation(hypothesis);
      }
    }

    const hypothesisMark = buildHypothesisMark({
      runId,
      scope,
      project,
      region,
      goal,
      hypotheses,
    });

    return {
      status: 'completed',
      observations: hypotheses,
      observations_count: hypotheses.length,
      current_step: 'completed',
      hypotheses: hypotheses.map((hypothesis) => ({
        id: hypothesis.id,
        summary: hypothesis.content.summary,
        rationale: hypothesis.content.rationale,
        confidence: hypothesis.certainty,
        hypothesis_type: hypothesis.content.hypothesis_type,
        why_now: hypothesis.content.why_now,
        supporting_evidence_summary: hypothesis.content.supporting_evidence_summary,
        evidence_refs: hypothesis.content.evidence_refs || [],
        related_files: hypothesis.content.related_files || [],
        related_memory_ids: hypothesis.content.related_memory_ids || hypothesis.content.evidence_refs || [],
        verification_checks: hypothesis.content.verification_checks || [],
        novelty_score: hypothesis.content.novelty_score,
      })),
      summary: {
        scope,
        project,
        region,
        goal,
        source_run_id: faradayRun?.run_id || null,
        source_trail_id: faradayTrail?.id || faradayTrail?.trail_id || null,
        hypothesis_count: hypotheses.length,
        semantic_cluster_count: semanticClusters.length,
      },
      trail_mark: hypothesisMark,
      completed_at: new Date().toISOString(),
    };
  }
}
