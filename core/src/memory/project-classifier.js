/**
 * Deterministic multilingual project resolution for every memory-write surface.
 * BGE-M3 embeddings compare the memory with authorized project names and
 * descriptions. The result is cached, bounded, and never invokes a chat model.
 */

import { getEmbedService } from '../embeddings/factory.js';

const CONF_AUTO = Number(process.env.PROJECT_CLASSIFY_AUTO_CONF || 0.72);
const CONF_FLOOR = Number(process.env.PROJECT_CLASSIFY_FLOOR || 0.40);
const MARGIN = Number(process.env.PROJECT_CLASSIFY_MARGIN || 0.15);
const TIMEOUT_MS = Number(process.env.PROJECT_CLASSIFY_TIMEOUT_MS || 1500);
const CACHE_MAX = Number(process.env.PROJECT_EMBED_CACHE_MAX || 2000);
const projectVectorCache = new Map();

function projectText(project) {
  return [project.name, project.slug, project.description].filter(Boolean).join('\n').slice(0, 2000);
}

function projectKey(project) {
  return `${project.id}:${projectText(project)}`;
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

async function embedWithDeadline(texts, signal) {
  if (signal?.aborted) throw new Error('project_classifier_aborted');
  let timer;
  try {
    return await Promise.race([
      getEmbedService().embed(texts),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('project_classifier_timeout')), TIMEOUT_MS);
        signal?.addEventListener('abort', () => reject(new Error('project_classifier_aborted')), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rankProjects({ text, projects, signal }) {
  const missing = projects.filter((project) => !projectVectorCache.has(projectKey(project)));
  const inputs = [String(text || '').slice(0, 4000), ...missing.map(projectText)];
  const vectors = await embedWithDeadline(inputs, signal);
  const queryVector = vectors[0];
  missing.forEach((project, index) => projectVectorCache.set(projectKey(project), vectors[index + 1]));
  while (projectVectorCache.size > CACHE_MAX) projectVectorCache.delete(projectVectorCache.keys().next().value);
  return projects
    .map((project) => ({ project, score: Math.max(0, Math.min(1, cosine(queryVector, projectVectorCache.get(projectKey(project))))) }))
    .sort((left, right) => right.score - left.score);
}

export async function classifyProjectForMemory({ text, projects, signal }) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return { decision: 'personal', projectId: null, confidence: 0, reason: 'no projects' };
  }
  const candidates = projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug }));
  let ranked;
  try {
    ranked = await rankProjects({ text, projects, signal });
  } catch (error) {
    return { decision: 'ask', projectId: null, confidence: 0, reason: error.message, candidates };
  }
  const best = ranked[0];
  const secondScore = ranked[1]?.score || 0;
  if (!best || best.score < CONF_FLOOR) {
    return { decision: 'personal', projectId: null, confidence: best?.score || 0, reason: 'no semantic project fit' };
  }
  if (best.score >= CONF_AUTO && best.score - secondScore >= MARGIN) {
    return {
      decision: 'auto', projectId: best.project.id, projectName: best.project.name,
      confidence: best.score, reason: 'bge-m3 semantic project match',
    };
  }
  return {
    decision: 'ask', projectId: null, suggestedId: best.project.id,
    suggestedName: best.project.name, confidence: best.score,
    reason: 'ambiguous semantic project fit', candidates,
  };
}

export async function resolveProjectForSave({ text, projects, policy, callerProjectId, signal }) {
  if (callerProjectId) return { decision: 'explicit', projectId: callerProjectId };
  const normalizedPolicy = String(policy || 'private').toLowerCase();
  if (normalizedPolicy === 'org-wide') return { decision: 'org', projectId: null };
  if (!Array.isArray(projects) || projects.length === 0) return { decision: 'personal', projectId: null };
  if (normalizedPolicy === 'ask') {
    return {
      decision: 'ask', projectId: null, suggestedId: null,
      candidates: projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug })),
      reason: 'org policy = ask',
    };
  }
  return classifyProjectForMemory({ text, projects, signal });
}
