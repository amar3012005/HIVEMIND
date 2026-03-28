import { randomUUID } from 'node:crypto';

function hypothesisObservation({
  runId,
  summary,
  rationale,
  hypothesisType,
  region,
  confidence,
  evidenceRefs = [],
  relatedFiles = [],
  relatedMemoryIds = [],
  nextAction,
  supportingSignals = [],
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
      evidence_refs: evidenceRefs,
      related_files: relatedFiles,
      related_memory_ids: relatedMemoryIds,
      supporting_signals: supportingSignals,
      next_action: nextAction,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

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

function buildRationale({ cluster, observationKinds = [], scope, goal }) {
  const parts = [
    `Faraday grouped ${cluster.count} related memories under "${cluster.label}".`,
  ];
  if (cluster.keywords?.length) {
    parts.push(`Shared keywords: ${cluster.keywords.slice(0, 5).join(', ')}.`);
  }
  if (observationKinds.length) {
    parts.push(`Supporting observations: ${observationKinds.join(', ')}.`);
  }
  if (goal) {
    parts.push(`This aligns with the resident goal: ${goal}.`);
  }
  parts.push(`Treat this as a ${scope} explanation candidate until Turing verifies it.`);
  return parts.join(' ');
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
      evidence_refs: hypothesis.content.evidence_refs || [],
      related_files: hypothesis.content.related_files || [],
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
        evidence_refs: hypothesis.content.evidence_refs || [],
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
      const confidence = Math.min(0.92, 0.58 + Math.min(cluster.count || 0, 6) * 0.06);
      return hypothesisObservation({
        runId,
        summary: buildSummary(type, cluster),
        rationale: buildRationale({ cluster, observationKinds, scope, goal }),
        hypothesisType: type,
        region: cluster.label || region || project || scope,
        confidence,
        evidenceRefs: cluster.evidence_refs || [],
        relatedFiles: cluster.related_files || [],
        relatedMemoryIds: cluster.evidence_refs || [],
        nextAction: `Ask Turing to verify whether "${cluster.label}" is a real ${type.replaceAll('_', ' ')}.`,
        supportingSignals: observationKinds,
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
