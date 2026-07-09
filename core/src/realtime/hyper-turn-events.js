import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
const turnState = new Map();

const FALLBACK_POLL_MS = Number(process.env.HYPER_TURN_FALLBACK_POLL_MS || 2000);
const VANISH_LIMIT = Number(process.env.HYPER_TURN_VANISH_LIMIT || 15);

function ensureState(turnId) {
  let state = turnState.get(turnId);
  if (!state) {
    state = {
      listeners: 0,
      pollTimer: null,
      stopRequested: false,
      missingTicks: 0,
      lastLineCount: 0,
      fetchTurn: null,
    };
    turnState.set(turnId, state);
  }
  return state;
}

function stopPoller(turnId) {
  const state = turnState.get(turnId);
  if (!state) return;
  state.stopRequested = true;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (state.listeners <= 0) turnState.delete(turnId);
}

function schedulePoll(turnId) {
  const state = turnState.get(turnId);
  if (!state || state.stopRequested || state.pollTimer || typeof state.fetchTurn !== 'function') return;
  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    if (state.stopRequested || typeof state.fetchTurn !== 'function') return;
    try {
      const turn = await state.fetchTurn();
      if (!turn) {
        state.missingTicks += 1;
        if (state.missingTicks >= VANISH_LIMIT) {
          publishTurnError(turnId, { message: 'Turn vanished' });
          stopPoller(turnId);
          return;
        }
      } else {
        state.missingTicks = 0;
        const lines = Array.isArray(turn.lines) ? turn.lines : [];
        for (let i = state.lastLineCount; i < lines.length; i += 1) {
          publishTurnEvent(turnId, lines[i], i);
        }
        state.lastLineCount = lines.length;
        if (turn.sealedAt || ['complete', 'failed', 'cost_capped'].includes(turn.status)) {
          stopPoller(turnId);
          return;
        }
      }
    } catch (err) {
      publishTurnError(turnId, { message: err?.message || 'turn poll failed' });
    }
    schedulePoll(turnId);
  }, FALLBACK_POLL_MS);
}

export function publishTurnEvent(turnId, event, index = null) {
  const state = ensureState(turnId);
  if (typeof index === 'number' && index + 1 > state.lastLineCount) state.lastLineCount = index + 1;
  emitter.emit(`turn:${turnId}`, { type: 'event', turnId, event, index });
}

export function publishTurnSeal(turnId, payload = {}) {
  emitter.emit(`turn:${turnId}`, { type: 'seal', turnId, ...payload });
  stopPoller(turnId);
}

export function publishTurnError(turnId, payload = {}) {
  emitter.emit(`turn:${turnId}`, { type: 'error', turnId, ...payload });
}

export function subscribeTurnStream(turnId, handlers = {}, options = {}) {
  const state = ensureState(turnId);
  state.listeners += 1;
  if (options.lastLineCount != null) state.lastLineCount = Math.max(state.lastLineCount, Number(options.lastLineCount) || 0);
  if (typeof options.fetchTurn === 'function') {
    state.fetchTurn = options.fetchTurn;
    schedulePoll(turnId);
  }

  const listener = (msg) => {
    if (msg.type === 'event') handlers.onEvent?.(msg.event, msg.index);
    else if (msg.type === 'seal') handlers.onSeal?.(msg);
    else if (msg.type === 'error') handlers.onError?.(msg);
  };

  emitter.on(`turn:${turnId}`, listener);

  return () => {
    emitter.off(`turn:${turnId}`, listener);
    const next = turnState.get(turnId);
    if (!next) return;
    next.listeners = Math.max(0, next.listeners - 1);
    if (next.listeners === 0) stopPoller(turnId);
  };
}
