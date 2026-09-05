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
  // The most recent public-web answer is a replaceable conversational unit,
  // not an ever-growing bag of URLs. Replacing (and explicitly clearing) it
  // makes immediate follow-ups deterministic while preventing stale web
  // context from leaking into unrelated later turns.
  sourceContext: Annotation({ reducer: (_left, right) => right, default: () => null }),
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
  if (!orgId || !userId || !String(threadId || '').trim()) return null;
  const tid = String(threadId).trim();
  const digest = crypto.createHash('sha256').update(tid).digest('hex').slice(0, 32);
  return `chat:${orgId}:${userId}:${digest}:v2`;
}

function graphConfig(identity) {
  const threadKey = compactThreadKey(identity);
  return threadKey ? { configurable: { thread_id: threadKey } } : null;
}

export async function hydrateCompactContext(input = {}, { graph } = {}) {
  const fallback = compactTurns(input.history || []);
  const config = graphConfig(input);
  if (!config) return { history: fallback, sourceRefs: [], sourceContext: null };
  try {
    const runtime = graph || await productionGraph();
    // Hydration is a read boundary. Persisting the active user message here
    // would commit failed/aborted turns before validation and poison later
    // plans. The completed-turn boundary below appends the user/assistant pair.
    const checkpoint = await runtime.getState(config);
    const values = checkpoint?.values || {};
    const turns = compactTurns([...(values.turns || []), ...fallback]);
    const sourceContext = values.sourceContext && typeof values.sourceContext === 'object'
      ? {
        answer: String(values.sourceContext.answer || '').slice(0, 4000),
        refs: compactSourceRefs(values.sourceContext.refs || []),
      }
      : null;
    return {
      history: turns,
      sourceRefs: sourceContext?.refs || compactSourceRefs(values.sourceRefs || []),
      sourceContext,
    };
  } catch (error) {
    reportCheckpointFailure(error.message);
    return { history: fallback, sourceRefs: [], sourceContext: null };
  }
}

export async function recordCompactAssistantTurn({ orgId, userId, threadId, userMessage, response, sources = [] } = {}, { graph } = {}) {
  const config = graphConfig({ orgId, userId, threadId });
  const userTurn = normalizeTurn({ role: 'user', content: userMessage });
  const assistantTurn = normalizeTurn({ role: 'assistant', content: response });
  if (!config || !assistantTurn) return false;
  try {
    const runtime = graph || await productionGraph();
    const publicRefs = compactSourceRefs((sources || []).filter((source) => (
      source?.source_type === 'public_web'
      || source?.source_platform === 'public_web'
      || String(source?.segment_id || '').startsWith('web:')
    )));
    await runtime.invoke({
      turns: [userTurn, assistantTurn].filter(Boolean),
      sourceRefs: publicRefs,
      sourceContext: publicRefs.length ? { answer: assistantTurn.content, refs: publicRefs } : null,
    }, config);
    return true;
  } catch (error) {
    reportCheckpointFailure(error.message);
    return false;
  }
}

export const compactContextLimits = Object.freeze({ turns: MAX_TURNS, turnChars: MAX_TURN_CHARS, sourceRefs: MAX_SOURCE_REFS });
