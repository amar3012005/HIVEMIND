/**
 * WorkingSet — rolling spotlight on user's active context.
 *
 * Updated after every chat message. Stores:
 *   activeEntities  — proper-noun bigrams extracted from last N messages (rolling 7d window)
 *   activeThreads   — thread/channel/conversation IDs referenced
 *   activeProjects  — project IDs touched
 *   pinnedMemoryIds — memories the user explicitly pinned
 *
 * Used by recall router to boost relevance:
 *   memory.entity ∈ activeEntities → score × 1.30
 *   memory.thread ∈ activeThreads  → score × 1.50
 *   memory.project ∈ activeProjects → score × 1.20
 *
 * One row per (userId). Cheap upsert, idempotent.
 */

const MAX_ENTITIES = 25;
const MAX_THREADS = 15;
const MAX_PROJECTS = 5;

/**
 * Extract proper-noun + bigram tokens from text.
 * Same heuristic as recall-router entity boost so the two agree.
 */
export function extractEntitiesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  // Multi-word capitalized phrases
  const capPhrases = text.match(/[A-Z][\w&]+(?:\s+[A-Z][\w&]+)+/g) || [];
  for (const p of capPhrases) out.add(p);
  // Singleton capitalized 4+ chars
  const singletons = text.match(/\b[A-Z][\w&]{3,}\b/g) || [];
  for (const s of singletons) out.add(s);
  return Array.from(out).slice(0, 20);
}

/**
 * Read the current working set for a user. Returns empty shape if no row.
 */
export async function getWorkingSet(prisma, userId) {
  if (!prisma?.workingSet || !userId) return _emptySet(userId);
  try {
    const row = await prisma.workingSet.findUnique({ where: { userId } });
    if (!row) return _emptySet(userId);
    return {
      userId: row.userId,
      orgId: row.orgId,
      activeEntities: row.activeEntities || [],
      activeThreads: row.activeThreads || [],
      activeProjects: row.activeProjects || [],
      pinnedMemoryIds: row.pinnedMemoryIds || [],
      updatedAt: row.updatedAt,
    };
  } catch (err) {
    console.warn(`[working-set] read failed for ${userId.slice(0, 8)}: ${err.message}`);
    return _emptySet(userId);
  }
}

/**
 * Merge new signals into the working set. Idempotent upsert.
 * Caps each array to its max length (LRU — newest first).
 *
 * @param {{ userId: string, orgId?: string, entities?: string[], threads?: string[],
 *           projects?: string[], pinnedAdd?: string[] }} signals
 */
export async function updateWorkingSet(prisma, signals) {
  if (!prisma?.workingSet || !signals?.userId) return null;
  const {
    userId, orgId,
    entities = [], threads = [], projects = [], pinnedAdd = [],
  } = signals;

  try {
    const current = await prisma.workingSet.findUnique({ where: { userId } });

    const mergedEntities = _mergeAndCap(entities, current?.activeEntities, MAX_ENTITIES);
    const mergedThreads = _mergeAndCap(threads, current?.activeThreads, MAX_THREADS);
    const mergedProjects = _mergeAndCap(projects, current?.activeProjects, MAX_PROJECTS);
    const mergedPinned = _mergeAndCap(pinnedAdd, current?.pinnedMemoryIds, 50);

    if (current) {
      return await prisma.workingSet.update({
        where: { userId },
        data: {
          orgId: orgId || current.orgId,
          activeEntities: mergedEntities,
          activeThreads: mergedThreads,
          activeProjects: mergedProjects,
          pinnedMemoryIds: mergedPinned,
        },
      });
    }
    return await prisma.workingSet.create({
      data: {
        userId,
        orgId: orgId || null,
        activeEntities: mergedEntities,
        activeThreads: mergedThreads,
        activeProjects: mergedProjects,
        pinnedMemoryIds: mergedPinned,
      },
    });
  } catch (err) {
    console.warn(`[working-set] update failed for ${userId.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Convenience: extract entities from a chat message string + merge into working set.
 * Fire-and-forget. Caller should not await for hot-path latency.
 */
export async function tapChatMessage(prisma, { userId, orgId, message, threadId, projectId }) {
  if (!userId || !message) return;
  const entities = extractEntitiesFromText(message);
  await updateWorkingSet(prisma, {
    userId,
    orgId,
    entities,
    threads: threadId ? [String(threadId)] : [],
    projects: projectId ? [String(projectId)] : [],
  });
}

function _mergeAndCap(incoming, existing, cap) {
  // newest first → take incoming first, then top up from existing without dupes
  const seen = new Set();
  const merged = [];
  for (const v of incoming || []) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    merged.push(v);
    if (merged.length >= cap) return merged;
  }
  for (const v of existing || []) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    merged.push(v);
    if (merged.length >= cap) break;
  }
  return merged;
}

function _emptySet(userId) {
  return {
    userId,
    orgId: null,
    activeEntities: [],
    activeThreads: [],
    activeProjects: [],
    pinnedMemoryIds: [],
    updatedAt: null,
  };
}
