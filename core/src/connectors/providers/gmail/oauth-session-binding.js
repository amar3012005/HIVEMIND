/**
 * Google Workspace OAuth state binding.
 *
 * The HMAC-signed state proves that Core minted it, but not that the browser
 * completing the consent is the one that started it. Without a browser binding
 * an attacker can mint a state for their own account, send a victim the Google
 * consent URL, and receive the victim's Google tokens. The callback therefore
 * requires (1) the dashboard session of the browser that hits the callback to
 * be the principal named in the state, and (2) a one-time server-side nonce
 * created at connect time for that same principal.
 */

export const GMAIL_CONNECT_STATE_PURPOSE = 'gmail_connect';

/**
 * Decide whether a verified state payload may bind tokens for the browser
 * session that completed the Google redirect.
 *
 * @param {{ userId?: string, orgId?: string, nonce?: string } | null} state verified state payload
 * @param {{ userId?: string, orgId?: string | null } | null} session browser session resolved at the callback
 * @param {{ purpose?: string, userId?: string, orgId?: string } | null} nonceRecord consumed one-time record, or null when absent/expired/replayed
 * @returns {{ ok: true } | { ok: false, reason: 'session_required' | 'session_mismatch' | 'state_replayed' }}
 */
export function checkGmailStateBinding(state, session, nonceRecord) {
  if (!session || !session.userId) return { ok: false, reason: 'session_required' };
  if (!state || !state.userId || String(state.userId) !== String(session.userId)) {
    return { ok: false, reason: 'session_mismatch' };
  }
  if (session.orgId && String(state.orgId || '') !== String(session.orgId)) {
    return { ok: false, reason: 'session_mismatch' };
  }
  if (!nonceRecord
    || nonceRecord.purpose !== GMAIL_CONNECT_STATE_PURPOSE
    || String(nonceRecord.userId || '') !== String(state.userId)
    || String(nonceRecord.orgId || '') !== String(state.orgId || '')) {
    return { ok: false, reason: 'state_replayed' };
  }
  return { ok: true };
}
