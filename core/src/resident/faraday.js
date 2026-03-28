import { randomUUID } from 'node:crypto';
import { FARADAY_OBSERVATION_KINDS } from './contract.js';

const SEMANTIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our', 'you', 'are', 'was', 'were',
  'can', 'could', 'would', 'should', 'will', 'just', 'about', 'what', 'when', 'where', 'why', 'how',
  'scan', 'inspect', 'search', 'find', 'look', 'review', 'check', 'project', 'workspace', 'region',
  'memory', 'memories', 'graph', 'agent', 'agents', 'anomalies', 'anomaly', 'stale', 'assumptions',
  'risk', 'risking', 'high', 'low', 'current', 'scope', 'signal', 'signals', 'region', 'regions',
  'test', 'tests', 'doc', 'docs', 'documentation', 'duplicate', 'duplicates', 'cluster', 'clusters',
  'next', 'step', 'steps', 'trail', 'marks', 'mark',
]);

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s/._:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSemantic(value = '') {
  return normalizeText(value)
    .split(/[\s/._:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !SEMANTIC_STOPWORDS.has(token));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function jaccardOverlap(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token));
  const union = new Set([...leftSet, ...rightSet]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function semanticSignature(memory = {}) {
  const tokens = tokenizeSemantic([memory.title, memoryPath(memory), memory.content].filter(Boolean).join(' '));
  return tokens.slice(0, 12).sort().join(' ');
}

function clusterLabel(cluster = {}) {
  if (cluster.keywords?.length) {
    return cluster.keywords.slice(0, 5).join(' ');
  }
  const titles = Object.entries(cluster.titleCounts || {})
    .sort((left, right) => right[1] - left[1])
    .map(([title]) => title)
    .filter(Boolean);
  if (titles.length > 0) return titles[0].slice(0, 120);
  return cluster.sampleMemory?.title || cluster.sampleMemory?.id || 'semantic region';
}

function buildSemanticProbes({ goal = '', scope = 'project', project = null, region = null }) {
  const probes = [];
  const goalText = normalizeText(goal);
  if (goalText) probes.push(goalText);

  const goalTokens = tokenizeSemantic(goal).slice(0, 8);
  if (goalTokens.length >= 2) {
    probes.push(goalTokens.slice(0, 2).join(' '));
    probes.push(goalTokens.slice(0, 3).join(' '));
  }
  if (goalTokens.length >= 4) {
    probes.push(goalTokens.slice(1, 4).join(' '));
  }

  const contextual = [
    region,
    project,
    `${scope} anomalies`,
    `${scope} duplicate clusters`,
    `${scope} stale assumptions`,
    `${scope} test gaps`,
    `${scope} documentation gaps`,
  ].filter(Boolean);
  probes.push(...contextual.map((value) => normalizeText(value)));

  if (goalTokens.length > 0) {
    const joined = goalTokens.slice(0, 5).join(' ');
    probes.push(joined);
    if (goalTokens.length >= 3) {
      probes.push(goalTokens.slice(-3).join(' '));
    }
  }

  return uniqueBy(probes.map((probe) => normalizeText(probe)).filter((probe) => probe.length >= 2), (probe) => probe)
    .slice(0, 10);
}

function expandProbeFromCluster(cluster = {}) {
  const keywords = cluster.keywords || [];
  if (keywords.length >= 3) return [keywords.slice(0, 3).join(' '), keywords.slice(0, 4).join(' ')];
  if (keywords.length >= 2) return [keywords.slice(0, 2).join(' ')];
  return [];
}

function clusterSemanticMemories(memories = []) {
  const clusters = [];

  for (const memory of memories) {
    const tokens = tokenizeSemantic([memory.title, memory.content, memoryPath(memory)].filter(Boolean).join(' '));
    if (tokens.length === 0) continue;

    let cluster = clusters.find((candidate) => jaccardOverlap(candidate.tokens, tokens) >= 0.34);
    if (!cluster) {
      cluster = {
        id: randomUUID(),
        tokens: [...tokens],
        memories: [],
        titleCounts: {},
        pathCounts: {},
        sourceCounts: {},
        keywords: [],
        sampleMemory: memory,
      };
      clusters.push(cluster);
    }

    cluster.memories.push(memory);
    cluster.sampleMemory = cluster.sampleMemory || memory;
    cluster.tokens = Array.from(new Set([...cluster.tokens, ...tokens])).slice(0, 40);

    const titleKey = normalizeText(memory.title || '');
    if (titleKey) cluster.titleCounts[titleKey] = (cluster.titleCounts[titleKey] || 0) + 1;
    const pathKey = normalizeText(memoryPath(memory) || '');
    if (pathKey) cluster.pathCounts[pathKey] = (cluster.pathCounts[pathKey] || 0) + 1;
    const sourceKey = normalizeText(memory.source_metadata?.source_type || memory.source?.source_type || memory.source || '');
    if (sourceKey) cluster.sourceCounts[sourceKey] = (cluster.sourceCounts[sourceKey] || 0) + 1;
  }

  for (const cluster of clusters) {
    const tokenCounts = new Map();
    for (const memory of cluster.memories) {
      for (const token of tokenizeSemantic([memory.title, memory.content, memoryPath(memory)].filter(Boolean).join(' '))) {
        tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
      }
    }
    cluster.keywords = [...tokenCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([token]) => token)
      .filter((token) => !SEMANTIC_STOPWORDS.has(token))
      .slice(0, 8);
    cluster.label = clusterLabel(cluster);
    cluster.score = cluster.memories.length * 10 + cluster.keywords.length;
  }

  return clusters.sort((left, right) => right.score - left.score);
}

async function collectRelatedMemoryIds(memoryStore, seedMemory, scopeFilter) {
  if (!memoryStore?.getRelatedMemories || !seedMemory?.id) return [];
  const relationships = await memoryStore.getRelatedMemories(seedMemory.id, {
    maxDepth: 1,
    minConfidence: 0.35,
    ...scopeFilter,
  });
  const ids = [];
  for (const relationship of relationships || []) {
    if (relationship.from_id && relationship.from_id !== seedMemory.id) ids.push(relationship.from_id);
    if (relationship.to_id && relationship.to_id !== seedMemory.id) ids.push(relationship.to_id);
  }
  return ids;
}

async function fetchMemoriesByIds(memoryStore, ids = [], scopeFilter = {}) {
  if (!memoryStore?.getMemory) return [];
  const loaded = [];
  for (const id of ids) {
    try {
      const memory = await memoryStore.getMemory(id, scopeFilter);
      if (memory) loaded.push(memory);
    } catch {
      /* best effort */
    }
  }
  return loaded;
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

    const semanticProbes = buildSemanticProbes({ goal, scope, project, region });
    const semanticSeedMap = new Map();
    const probeHitMap = new Map();

    if (this.memoryStore?.searchMemories) {
      for (const [probeIndex, probe] of semanticProbes.entries()) {
        if (isCancelled()) {
          return { status: 'cancelled', observations: [], observations_count: 0, current_step: 'cancelled_before_probe_scan' };
        }

        const probeResults = await this.memoryStore.searchMemories({
          query: probe,
          user_id: userId,
          org_id: orgId,
          project,
          is_latest: true,
          n_results: 12,
        });

        for (const result of probeResults || []) {
          if (!result?.id) continue;
          const existing = semanticSeedMap.get(result.id);
          const score = Number(result.score || 0);
          const weightedScore = score + Math.max(0, (semanticProbes.length - probeIndex) * 0.05);
          if (!existing || weightedScore > existing.score) {
            semanticSeedMap.set(result.id, {
              ...result,
              score: weightedScore,
              semantic_probes: existing?.semantic_probes ? Array.from(new Set([...existing.semantic_probes, probe])) : [probe],
            });
          } else {
            existing.semantic_probes = Array.from(new Set([...(existing.semantic_probes || []), probe]));
          }
          probeHitMap.set(probe, (probeHitMap.get(probe) || 0) + 1);
        }
      }
    }

    const semanticSeeds = [...semanticSeedMap.values()].sort((left, right) => (right.score || 0) - (left.score || 0));
    const seedRelatedIds = new Set();
    for (const seed of semanticSeeds.slice(0, 5)) {
      const relatedIds = await collectRelatedMemoryIds(this.memoryStore, seed, {
        user_id: userId,
        org_id: orgId,
        project,
      });
      for (const relatedId of relatedIds) {
        seedRelatedIds.add(relatedId);
      }
    }

    const relatedMemories = await fetchMemoriesByIds(this.memoryStore, [...seedRelatedIds], {
      user_id: userId,
      org_id: orgId,
      project,
    });

    memories = uniqueBy(
      [...memories, ...semanticSeeds, ...relatedMemories],
      (memory) => memory.id,
    );

    await updateProgress(2, 4, 'analyzing_scope');

    const files = new Map();
    const duplicateGroups = new Map();
    const semanticClusters = clusterSemanticMemories(memories);

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

    const topSemanticClusters = semanticClusters
      .slice(0, 5)
      .map((cluster) => ({
        id: cluster.id,
        label: cluster.label,
        count: cluster.memories.length,
        evidence_refs: cluster.memories.slice(0, 5).map((memory) => memory.id),
        related_files: uniqueBy(cluster.memories.map((memory) => memoryPath(memory)).filter(Boolean), (item) => item).slice(0, 5),
        keywords: cluster.keywords.slice(0, 8),
        score: cluster.score,
      }));

    observations.push(observationPayload({
      agentId,
      runId,
      kind: 'graph_observation',
      summary: `Faraday scanned ${memoryCount} memories and ${relationshipCount} relationships for ${scope} scope using ${semanticProbes.length} semantic probes.`,
      region: region || project || scope,
      signalType: 'scope_summary',
      severity: 'low',
      confidence: 0.95,
      evidenceRefs: semanticSeeds.slice(0, 5).map((memory) => memory.id),
      relatedFiles: topFiles.map((item) => item.file).slice(0, 8),
      relatedMemoryIds: semanticSeeds.slice(0, 10).map((memory) => memory.id),
      relatedRelationshipIds: [],
      nextAction: topSemanticClusters.length > 0
        ? `Follow the semantic trail marks for ${topSemanticClusters[0].label}.`
        : 'Inspect the highest-count file groups for code smell and test gaps.',
      extra: {
        memory_count: memoryCount,
        relationship_count: relationshipCount,
        semantic_probe_count: semanticProbes.length,
        semantic_seed_count: semanticSeeds.length,
        semantic_probes: semanticProbes,
        semantic_clusters: topSemanticClusters,
        top_files: topFiles,
        scope,
        project,
      },
    }));

    for (const cluster of semanticClusters.slice(0, 3)) {
      if (isCancelled()) {
        return {
          status: 'cancelled',
          observations,
          observations_count: observations.length,
          current_step: 'cancelled_during_semantic_mark',
        };
      }

      if (cluster.memories.length < 2) continue;

      observations.push(observationPayload({
        agentId,
        runId,
        kind: 'reasoning_trail',
        summary: `Semantic trail mark: ${cluster.label} links ${cluster.memories.length} related memories and should be treated as one concept.`,
        region: cluster.label,
        signalType: 'semantic_trail_mark',
        severity: 'low',
        confidence: Math.min(0.9, 0.55 + (cluster.memories.length * 0.08)),
        evidenceRefs: cluster.memories.slice(0, 5).map((memory) => memory.id),
        relatedFiles: uniqueBy(cluster.memories.map((memory) => memoryPath(memory)).filter(Boolean), (item) => item).slice(0, 5),
        relatedMemoryIds: cluster.memories.slice(0, 8).map((memory) => memory.id),
        nextAction: `When you revisit this area, ask the next agent to follow the semantic trail mark for ${cluster.label}.`,
        extra: {
          semantic_cluster: cluster.label,
          semantic_cluster_count: cluster.memories.length,
          semantic_cluster_keywords: cluster.keywords.slice(0, 8),
        },
      }));
    }

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

    const semanticTrailMark = {
      trail_id: runId ? `resident-faraday-${runId}` : `resident-faraday-${randomUUID()}`,
      kind: 'resident_mark',
      label: topSemanticClusters[0]?.label || clusterLabel(semanticClusters[0] || {}),
      summary: topSemanticClusters.length > 0
        ? `Follow ${topSemanticClusters[0].label} as the leading semantic trail mark.`
        : `Follow the highest-signal semantic cluster for ${scope}.`,
      next_agent_prompt: topSemanticClusters.length > 0
        ? `Inspect the semantic trail mark for ${topSemanticClusters[0].label} before making any conclusions.`
        : `Inspect the strongest semantic region and verify whether it hides an anomaly or a repeated pattern.`,
      semantic_probes: semanticProbes,
      semantic_seeds: semanticSeeds.slice(0, 10).map((memory) => memory.id),
      semantic_clusters: topSemanticClusters,
      observation_ids: observations.map((observation) => observation.id),
      scope,
      project,
      region,
    };

    return {
      status: 'completed',
      observations,
      observations_count: observations.length,
      current_step: 'completed',
      semantic_probes: semanticProbes,
      semantic_seeds: semanticSeeds.slice(0, 10).map((memory) => memory.id),
      semantic_clusters: topSemanticClusters,
      summary: {
        scope,
        project,
        region,
        goal,
        memory_count: memoryCount,
        relationship_count: relationshipCount,
        top_files: topFiles,
        semantic_probes: semanticProbes,
        semantic_seeds: semanticSeeds.slice(0, 10).map((memory) => memory.id),
        semantic_clusters: topSemanticClusters,
        trail_mark: semanticTrailMark,
      },
      run_state: observations.some((obs) => FARADAY_OBSERVATION_KINDS.includes(obs.kind))
        ? 'signal_found'
        : 'quiet',
      trail_mark: semanticTrailMark,
      completed_at: new Date().toISOString(),
    };
  }
}
