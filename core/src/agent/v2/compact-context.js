import crypto from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createPostgresCheckpointer } from '../../hq-runtime/langgraph/postgres-checkpointer.js';

const MAX_TURNS = 6;
const MAX_TURN_CHARS = 1000;
const MAX_SOURCE_REFS = 8;

function normalizeTurn(turn) {
  if (!turn || !['user', 'assistant'].includes(turn.role)) return null;
  const content = String(turn.content || '').trim().slice(0, MAX_TURN_CHARS);
  return content ? { role: turn.role, content } : null;
}

function compactTurns(turns = []) {
  const normalized = turns.map(normalizeTurn).filter(Boolean);
  const deduped = [];
  for (const turn of normalized) {
    const previous = deduped[deduped.length - 1];
    if (previous?.role === turn.role && previous.content === turn.content) continue;
    deduped.push(turn);
  }
  return deduped.slice(-MAX_TURNS);
}

function compactSourceRefs(refs = []) {
  const seen = new Set();
  return refs.flatMap((ref) => {
    const url = String(ref?.url || '').trim().slice(0, 1000);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      title: String(ref?.title || ref?.source_label || url).slice(0, 300),
      url,
      retrieved_at: ref?.retrieved_at || null,
    }];
  }).slice(-MAX_SOURCE_REFS);
}

const CompactState = Annotation.Root({
  turns: Annotation({ reducer: (left = [], right = []) => compactTurns([...left, ...right]), default: () => [] }),
  sourceRefs: Annotation({ reducer: (left = [], right = []) => compactSourceRefs([...left, ...right]), default: () => [] }),
});

export function createCompactContextGraph({ checkpointer } = {}) {
  return new StateGraph(CompactState)
    .addNode('compact', async () => ({}))
    .addEdge(START, 'compact')
    .addEdge('compact', END)
    .compile(checkpointer ? { checkpointer } : {});
}

let productionGraphPromise;
let checkpointUnavailableUntil = 0;
let checkpointLastWarningAt = 0;
function reportCheckpointFailure(message) {
  const now = Date.now();
  if (now - checkpointLastWarningAt >= 60_000) {
    console.warn(`[chat-context] checkpoint degraded: ${message}`);
    checkpointLastWarningAt = now;
  }
}
async function productionGraph() {
  if (Date.now() < checkpointUnavailableUntil) throw new Error('checkpoint_circuit_open');
  if (!productionGraphPromise) {
    productionGraphPromise = (async () => {
      const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      const handle = await createPostgresCheckpointer({
        connectionString,
        schema: 'hivemind_chat_langgraph',
      });
      return createCompactContextGraph({ checkpointer: handle.checkpointer });
    })().catch((error) => {
      productionGraphPromise = null;
      checkpointUnavailableUntil = Date.now() + 30_000;
      throw error;
    });
  }
  return productionGraphPromise;
}

export async function warmCompactContextCheckpoint() {
  await productionGraph();
  return true;
}

export function compactThreadKey({ orgId, userId, threadId } = {}) {
  if (!orgId || !userId || !threadId) return null;
  const digest = crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32);
  return `chat:${orgId}:${userId}:${digest}:v2`;
}

function graphConfig(identity) {
  const threadKey = compactThreadKey(identity);
  return threadKey ? { configurable: { thread_id: threadKey } } : null;
}

export async function hydrateCompactContext(input = {}, { graph } = {}) {
  const fallback = compactTurns(input.history || []);
  const config = graphConfig(input);
  if (!config) return { history: fallback, sourceRefs: [] };
  try {
    const runtime = graph || await productionGraph();
    const current = normalizeTurn({ role: 'user', content: input.message });
    const result = await runtime.invoke({
      turns: [...fallback, ...(current ? [current] : [])],
      sourceRefs: [],
    }, config);
    // The current message is supplied separately to the planner. Do not send
    // it twice as both history and the active user turn.
    const turns = compactTurns(result.turns || []);
    if (current && turns.at(-1)?.role === 'user' && turns.at(-1)?.content === current.content) turns.pop();
    return { history: turns, sourceRefs: compactSourceRefs(result.sourceRefs || []) };
  } catch (error) {
    reportCheckpointFailure(error.message);
    return { history: fallback, sourceRefs: [] };
  }
}

export async function recordCompactAssistantTurn({ orgId, userId, threadId, response, sources = [] } = {}, { graph } = {}) {
  const config = graphConfig({ orgId, userId, threadId });
  const turn = normalizeTurn({ role: 'assistant', content: response });
  if (!config || !turn) return false;
  try {
    const runtime = graph || await productionGraph();
    await runtime.invoke({ turns: [turn], sourceRefs: compactSourceRefs(sources) }, config);
    return true;
  } catch (error) {
    reportCheckpointFailure(error.message);
    return false;
  }
}

export const compactContextLimits = Object.freeze({ turns: MAX_TURNS, turnChars: MAX_TURN_CHARS, sourceRefs: MAX_SOURCE_REFS });
