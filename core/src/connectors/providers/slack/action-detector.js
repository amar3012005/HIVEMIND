// Slack action intent detector for Talk-to-HIVE.
//
// Parses user chat messages and classifies them into Slack action intents:
//   - slack_post   — "send/post/message/dm/say [to] #channel|@user [saying/:] <text>"
//   - slack_react  — "react with :emoji: to last in #channel"  (limited; needs ts)
//   - slack_search — "search slack for X"  (read-only; bypasses confirm)
//   - slack_history — "show last N messages in #channel"  (read-only)
//
// Returns { matched: bool, action_type, payload, confidence, draftAck }.
// Write actions (post, react) require a 2-turn confirm flow handled by caller:
// detector returns the draft, caller stores intent in conversation state and
// asks user to reply `confirm` / `yes` / `send`. On next turn the caller
// re-runs `parseConfirmation()` against history + message.

/* eslint-disable no-useless-escape */

const POST_VERBS = /(send|post|message|msg|dm|notify|tell|say|write|share|ping)/i;
const REACT_VERBS = /(react|emoji|thumbs|heart|like|upvote)/i;
const SEARCH_VERBS = /(search|find|look up|grep)\s+(slack|messages?|threads?|conversations?)/i;
const HISTORY_VERBS = /(show|get|fetch|list|read|tail)\s+(last\s+\d+\s+)?(messages?|history)\s+(in|from|of)/i;

const CHANNEL_RE = /#([a-z0-9][a-z0-9._-]{0,79})/i;
const USER_RE = /@([a-zA-Z][a-zA-Z0-9._-]{0,79})/;
// Quoted text "..." or '...' or after "saying"/"with"/":"/"that"
const QUOTED_TEXT_RE = /(?:["“]([^"”]+)["”]|['‛]([^'’]+)['’])/;
const AFTER_KEYWORD_RE = /(?:saying|with the message|with text|that\s+says|message|content|:)\s+(.+?)$/i;

const CONFIRM_RE = /^(confirm|yes|y|yep|yeah|sure|go|send|do it|fire|ship it|proceed|ok|okay)\b/i;
const CANCEL_RE  = /^(no|n|nope|cancel|abort|stop|skip|nevermind|never mind|don'?t)\b/i;

// Strict sentinel placed in draft ack so confirm detection knows what to execute.
// Caller stores last assistant turn; detector finds this sentinel + JSON tail.
export const PENDING_ACTION_SENTINEL = '<<HIVEMIND:SLACK_PENDING>>';

/**
 * Extract channel/user target from message. Returns canonical Slack-ready id
 * string (e.g. "#general" → "general", "@alice" → "@alice"). Caller resolves
 * to Slack channel/user id via SlackBridge.resolveChannel().
 */
function extractTarget(message) {
  const ch = CHANNEL_RE.exec(message);
  if (ch) return { type: 'channel', raw: `#${ch[1]}`, normalized: ch[1] };
  const u = USER_RE.exec(message);
  if (u) return { type: 'user', raw: `@${u[1]}`, normalized: u[1] };
  return null;
}

/**
 * Pull message text from natural language. Tries in order:
 * quoted span → text after "saying"/"with"/":"/"that says" → null.
 */
function extractText(message) {
  const q = QUOTED_TEXT_RE.exec(message);
  if (q) return (q[1] || q[2] || '').trim();
  const k = AFTER_KEYWORD_RE.exec(message);
  if (k) return k[1].trim().replace(/^["'“‛]|["'”’]$/g, '');
  return null;
}

/**
 * Main classify entry-point. Pass user message + optional last-assistant turn
 * (for 2-turn confirm flow).
 */
export function detectSlackAction(message, { lastAssistantTurn = null } = {}) {
  if (!message || typeof message !== 'string') return { matched: false };
  const text = message.trim();

  // ─── 1. Confirmation gate: is user replying to a pending action? ───
  if (lastAssistantTurn && typeof lastAssistantTurn === 'string') {
    const pending = parsePendingAction(lastAssistantTurn);
    if (pending) {
      if (CONFIRM_RE.test(text)) {
        return {
          matched: true,
          phase: 'execute',
          action_type: pending.action_type,
          payload: pending.payload,
          confidence: 1.0,
        };
      }
      if (CANCEL_RE.test(text)) {
        return {
          matched: true,
          phase: 'cancel',
          action_type: pending.action_type,
          confidence: 1.0,
        };
      }
      // Otherwise fall through — user changed topic mid-flow; treat as new intent.
    }
  }

  // ─── 2. Read-only intents (no confirmation needed) ───
  if (SEARCH_VERBS.test(text) && /slack/i.test(text)) {
    const query = text.replace(SEARCH_VERBS, '').replace(/^[\s:]+/, '').trim() || text;
    return {
      matched: true,
      phase: 'execute',
      action_type: 'slack_search',
      payload: { query, count: 10 },
      confidence: 0.7,
    };
  }

  if (HISTORY_VERBS.test(text)) {
    const target = extractTarget(text);
    if (target?.type === 'channel') {
      const countMatch = /last\s+(\d+)/i.exec(text);
      const limit = countMatch ? Math.min(parseInt(countMatch[1], 10), 200) : 50;
      return {
        matched: true,
        phase: 'execute',
        action_type: 'slack_history',
        payload: { channel: target.normalized, limit },
        confidence: 0.8,
      };
    }
  }

  // ─── 3. Write intents (post/dm/react) — stage for confirmation ───
  const looksLikePost = POST_VERBS.test(text) && (CHANNEL_RE.test(text) || USER_RE.test(text));
  if (looksLikePost && !REACT_VERBS.test(text.split(/[.!?]/)[0])) {
    const target = extractTarget(text);
    const msgText = extractText(text);
    if (target && msgText && msgText.length > 0 && msgText.length <= 2000) {
      const payload = target.type === 'channel'
        ? { channel: target.normalized, text: msgText }
        : { channel: target.raw, text: msgText }; // bridge resolves @user → DM
      return {
        matched: true,
        phase: 'stage',
        action_type: 'slack_post',
        payload,
        confidence: 0.85,
        draftAck: buildPendingAck('slack_post', payload, target),
      };
    }
    // Intent matched but extraction failed — ask for clarification, don't fire.
    if (target && !msgText) {
      return {
        matched: true,
        phase: 'clarify',
        action_type: 'slack_post',
        confidence: 0.5,
        clarify: `I see you want to post to ${target.raw}, but I couldn't find the message text. Quote it like: \`post to ${target.raw}: "your message here"\`.`,
      };
    }
  }

  return { matched: false };
}

/**
 * Build the draft ack with embedded sentinel so confirm parser can recover
 * the pending action on the next user turn.
 */
function buildPendingAck(action_type, payload, target) {
  const preview = payload.text.length > 140 ? `${payload.text.slice(0, 140)}…` : payload.text;
  const body =
    `I'll post to **${target.raw}**:\n\n> ${preview}\n\n` +
    `Reply **\`confirm\`** to send, or **\`cancel\`** to drop.`;
  // Sentinel + JSON tail kept on its own line so it's easy to strip when
  // rendering in the UI (UI matches the sentinel and hides everything after).
  const tail = `\n\n${PENDING_ACTION_SENTINEL}${JSON.stringify({ action_type, payload })}`;
  return body + tail;
}

/**
 * Recover the staged action from last assistant turn's sentinel.
 */
export function parsePendingAction(assistantText) {
  if (!assistantText || typeof assistantText !== 'string') return null;
  const idx = assistantText.indexOf(PENDING_ACTION_SENTINEL);
  if (idx === -1) return null;
  const jsonStr = assistantText.slice(idx + PENDING_ACTION_SENTINEL.length).trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || !parsed.action_type || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Strip the sentinel+JSON tail before rendering assistant message in UI.
 */
export function stripPendingSentinel(text) {
  if (!text) return text;
  const idx = text.indexOf(PENDING_ACTION_SENTINEL);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}
