import { randomUUID } from 'node:crypto';
import { FARADAY_OBSERVATION_KINDS } from './contract.js';

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s/._:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryText(memory = {}) {
  return `${memory.title || ''}\n${memory.content || ''}`;
}

function memoryPath(memory = {}) {
  return (
    memory.metadata?.filepath
    || memory.metadata?.path
    || memory.source_metadata?.source_url
    || memory.source_metadata?.source_id
    || memory.title
    || memory.id
  );
}

function memoryTags(memory = {}) {
  const tags = memory.tags || [];
  return Array.isArray(tags) ? tags : [];
}

function isCodeLikeMemory(memory = {}) {
  const path = String(memoryPath(memory) || '');
  const tags = memoryTags(memory);
  return (
    tags.includes('code')
    || path.includes('/src/')
    || path.includes('.js')
    || path.includes('.ts')
    || path.includes('.jsx')
    || path.includes('.tsx')
    || path.includes('.py')
    || path.includes('.sql')
  );
}

function isDocLikeMemory(memory = {}) {
  const path = String(memoryPath(memory) || '');
  const tags = memoryTags(memory);
  return (
    tags.includes('doc')
    || tags.includes('docs')
    || tags.includes('documentation')
    || /readme|docs?|design|spec|notes?/i.test(path)
  );
}

function isTestLikeMemory(memory = {}) {
  const path = String(memoryPath(memory) || '');
  const tags = memoryTags(memory);
  return (
    tags.includes('test')
    || tags.includes('tests')
    || /test|spec/i.test(path)
  );
}

function observationPayload({
  agentId = 'faraday',
  runId = null,
  kind,
  summary,
  region,
  signalType,
  severity,
  confidence,
  evidenceRefs = [],
  relatedFiles = [],
  relatedMemoryIds = [],
  relatedRelationshipIds = [],
  nextAction,
  extra = {},
}) {
  return {
    id: randomUUID(),
    agent_id: agentId,
    kind,
    certainty: confidence,
    content: {
      summary,
      region,
      evidence_refs: evidenceRefs,
      related_files: relatedFiles,
      related_memory_ids: relatedMemoryIds,
      related_relationship_ids: relatedRelationshipIds,
      signal_type: signalType,
      severity,
      confidence,
      next_action: nextAction,
      ...extra,
    },
    source_event_id: runId,
    related_to_trail: runId,
    timestamp: new Date().toISOString(),
  };
}

export class FaradayAgent {
  constructor({ memoryStore, observationStore, logger = console } = {}) {
    this.memoryStore = memoryStore;
    this.observationStore = observationStore;
    this.logger = logger;
  }

  async run({
    agentId = 'faraday',
    userId,
    orgId,
    scope = 'project',
    project = null,
    region = null,
    goal = '',
    dryRun = false,
    runId,
    onProgress = async () => {},
    isCancelled = () => false,
  } = {}) {
    const observations = [];

    const updateProgress = async (step, totalSteps, currentStep) => {
      await onProgress({
        step,
        total_steps: totalSteps,
        current_step: currentStep,
        percent: Math.round((step / totalSteps) * 100),
      });
    };

    await updateProgress(1, 4, 'loading_memories');

    let memories = [];
    if (this.memoryStore?.listLatestMemories) {
      memories = await this.memoryStore.listLatestMemories({
        user_id: userId,
        org_id: orgId,
        project,
      });
    } else if (this.memoryStore?.searchMemories) {
      memories = await this.memoryStore.searchMemories({
        query: goal || region || project || '',
        user_id: userId,
        org_id: orgId,
        project,
        n_results: 100,
      });
    }

    if (project) {
      memories = memories.filter((memory) => memory.project === project);
    }

    if (region) {
      const regionNorm = normalizeText(region);
      memories = memories.filter((memory) => {
        const path = normalizeText(memoryPath(memory));
        const title = normalizeText(memory.title || '');
        const content = normalizeText(memory.content || '');
        return path.includes(regionNorm) || title.includes(regionNorm) || content.includes(regionNorm);
      });
    }

    if (isCancelled()) {
      return { status: 'cancelled', observations: [], observations_count: 0, current_step: 'cancelled_before_scan' };
    }

    await updateProgress(2, 4, 'analyzing_scope');

    const files = new Map();
    const duplicateGroups = new Map();

    for (const memory of memories) {
      const fileKey = String(memoryPath(memory) || memory.id);
      if (!files.has(fileKey)) {
        files.set(fileKey, []);
      }
      files.get(fileKey).push(memory);

      const signature = normalizeText(memoryText(memory));
      if (!duplicateGroups.has(signature)) {
        duplicateGroups.set(signature, []);
      }
      duplicateGroups.get(signature).push(memory);
    }

    const memoryCount = memories.length;
    const relationshipCount = this.memoryStore?.listRelationships
      ? (await this.memoryStore.listRelationships({
          user_id: userId,
          org_id: orgId,
          project,
          limit: 500,
        })).length
      : 0;

    const topFiles = [...files.entries()]
      .map(([file, group]) => ({
        file,
        count: group.length,
        testLike: group.some(isTestLikeMemory),
        docLike: group.some(isDocLikeMemory),
        codeLike: group.some(isCodeLikeMemory),
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 8);

    observations.push(observationPayload({
      agentId,
      runId,
      kind: 'graph_observation',
      summary: `Faraday scanned ${memoryCount} memories and ${relationshipCount} relationships for ${scope} scope.`,
      region: region || project || scope,
      signalType: 'scope_summary',
      severity: 'low',
      confidence: 0.95,
      evidenceRefs: memories.slice(0, 5).map((memory) => memory.id),
      relatedFiles: topFiles.map((item) => item.file).slice(0, 8),
      relatedMemoryIds: memories.slice(0, 10).map((memory) => memory.id),
      relatedRelationshipIds: [],
      nextAction: 'Inspect the highest-count file groups for code smell and test gaps.',
      extra: {
        memory_count: memoryCount,
        relationship_count: relationshipCount,
        top_files: topFiles,
        scope,
        project,
      },
    }));

    await updateProgress(3, 4, 'detecting_anomalies');

    for (const [file, group] of files.entries()) {
      if (isCancelled()) {
        return {
          status: 'cancelled',
          observations,
          observations_count: observations.length,
          current_step: 'cancelled_during_scan',
        };
      }

      const codeLike = group.some(isCodeLikeMemory);
      const testLike = group.some(isTestLikeMemory);
      const docLike = group.some(isDocLikeMemory);

      const relatedIds = group.map((memory) => memory.id);
      const fileLabel = String(file).slice(0, 120);

      if (codeLike && group.length >= 3 && !testLike) {
        observations.push(observationPayload({
          agentId,
          runId,
          kind: 'code_smell',
          summary: `High-churn code region ${fileLabel} has repeated memory updates without matching tests.`,
          region: region || project || scope,
          signalType: 'test_gap',
          severity: 'medium',
          confidence: 0.84,
          evidenceRefs: relatedIds.slice(0, 5),
          relatedFiles: [fileLabel],
          relatedMemoryIds: relatedIds.slice(0, 10),
          nextAction: `Verify test coverage for ${fileLabel}.`,
          extra: {
            memory_count: group.length,
            has_tests: testLike,
            has_docs: docLike,
          },
        }));
      }

      if (codeLike && !docLike && group.length >= 2) {
        observations.push(observationPayload({
          agentId,
          runId,
          kind: 'risk_candidate',
          summary: `Code region ${fileLabel} has repeated updates but no nearby documentation signal.`,
          region: region || project || scope,
          signalType: 'stale_doc',
          severity: 'medium',
          confidence: 0.78,
          evidenceRefs: relatedIds.slice(0, 5),
          relatedFiles: [fileLabel],
          relatedMemoryIds: relatedIds.slice(0, 10),
          nextAction: `Add or refresh documentation for ${fileLabel}.`,
          extra: {
            memory_count: group.length,
            has_tests: testLike,
            has_docs: docLike,
          },
        }));
      }
    }

    for (const [signature, group] of duplicateGroups.entries()) {
      if (isCancelled()) {
        return {
          status: 'cancelled',
          observations,
          observations_count: observations.length,
          current_step: 'cancelled_during_duplicate_scan',
        };
      }

      if (group.length < 2) continue;

      observations.push(observationPayload({
        agentId,
        runId,
        kind: 'anomaly_candidate',
        summary: `Repeated content was found across ${group.length} memories, suggesting a duplicate or near-duplicate cluster.`,
        region: region || project || scope,
        signalType: 'duplicate_memory',
        severity: 'low',
        confidence: 0.7,
        evidenceRefs: group.map((memory) => memory.id).slice(0, 10),
        relatedFiles: group.map((memory) => memoryPath(memory)).filter(Boolean).slice(0, 10),
        relatedMemoryIds: group.map((memory) => memory.id).slice(0, 10),
        nextAction: 'Review whether these memories should be merged, linked, or left separate.',
        extra: {
          signature,
          duplicate_count: group.length,
        },
      }));
    }

    if (observations.length === 1) {
      observations.push(observationPayload({
        agentId,
        runId,
        kind: 'graph_observation',
        summary: 'No strong anomalies found in the selected scope.',
        region: region || project || scope,
        signalType: 'no_strong_anomaly',
        severity: 'low',
        confidence: 0.6,
        evidenceRefs: memories.slice(0, 3).map((memory) => memory.id),
        relatedFiles: topFiles.map((item) => item.file).slice(0, 5),
        relatedMemoryIds: memories.slice(0, 5).map((memory) => memory.id),
        nextAction: 'Try a narrower region or a higher-churn project scope.',
      }));
    }

    await updateProgress(4, 4, 'writing_observations');

    if (!dryRun && this.observationStore?.writeObservation) {
      for (const observation of observations) {
        await this.observationStore.writeObservation({
          ...observation,
          agent_id: agentId,
        });
      }
    }

    return {
      status: 'completed',
      observations,
      observations_count: observations.length,
      current_step: 'completed',
      summary: {
        scope,
        project,
        region,
        goal,
        memory_count: memoryCount,
        relationship_count: relationshipCount,
        top_files: topFiles,
      },
      run_state: observations.some((obs) => FARADAY_OBSERVATION_KINDS.includes(obs.kind))
        ? 'signal_found'
        : 'quiet',
      completed_at: new Date().toISOString(),
    };
  }
}
