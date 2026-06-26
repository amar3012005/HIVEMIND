/**
 * TARA Outbound — call_attempt state machine.
 *
 * One TaraCallAttempt row moves through this DAG. Transitions are the ONLY
 * legal status changes; the worker/webhook layers must call assertTransition()
 * (or check canTransition()) before writing a new status, so an out-of-order
 * Telnyx webhook can never corrupt an attempt's lifecycle.
 *
 *   queued ─▶ gated ─▶ dialing ─▶ { no_answer | voicemail | connected | failed }
 *     gated ─▶ skipped            (compliance gate denied — terminal)
 *     connected ─▶ { declined | completed | callback }
 *     no_answer | voicemail | failed ─▶ { callback | done }
 *     declined | completed ─▶ done
 *     callback ─▶ queued          (re-enqueue for a later attempt) | done
 *
 * Terminal states: done, skipped.
 */

export const STATES = Object.freeze([
  'queued',
  'gated',
  'dialing',
  'no_answer',
  'voicemail',
  'connected',
  'failed',
  'declined',
  'completed',
  'callback',
  'skipped',
  'done',
]);

export const INITIAL_STATE = 'queued';

export const TERMINAL_STATES = Object.freeze(new Set(['done', 'skipped']));

/** Allowed next states keyed by current state. Terminal states map to []. */
export const TRANSITIONS = Object.freeze({
  queued: ['gated'],
  gated: ['dialing', 'skipped'],
  dialing: ['no_answer', 'voicemail', 'connected', 'failed'],
  no_answer: ['callback', 'done'],
  voicemail: ['callback', 'done'],
  failed: ['callback', 'done'],
  connected: ['declined', 'completed', 'callback'],
  declined: ['done'],
  completed: ['done'],
  callback: ['queued', 'done'],
  skipped: [],
  done: [],
});

/** @param {string} state @returns {boolean} */
export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/** @param {string} from @param {string} to @returns {boolean} */
export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Throw if `from → to` is not a legal transition; otherwise return `to`.
 * @param {string} from @param {string} to @returns {string}
 */
export function assertTransition(from, to) {
  if (!STATES.includes(from)) {
    throw new Error(`unknown source state: ${from}`);
  }
  if (!STATES.includes(to)) {
    throw new Error(`unknown target state: ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new Error(`illegal call-attempt transition: ${from} → ${to}`);
  }
  return to;
}

/**
 * Map a Telnyx/dial outcome to the post-`dialing` state.
 * @param {string} outcome  answered | no-answer | busy | machine | failed | hangup
 * @returns {string} a state reachable from "dialing"
 */
export function dialOutcomeToState(outcome) {
  switch (outcome) {
    case 'answered':
    case 'connected':
      return 'connected';
    case 'machine':
    case 'voicemail':
      return 'voicemail';
    case 'no-answer':
    case 'no_answer':
    case 'timeout':
    case 'busy':
      return 'no_answer';
    default:
      return 'failed';
  }
}
