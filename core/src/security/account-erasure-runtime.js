/**
 * Account erasure step for Runtime: asks the native Runtime host to archive the account's sessions and rooms, delete
 * their wakes and release owned Agents. Committed session data is kept. The host is reached at the same origin as the
 * employee lifecycle callback, with the same service secret and a separate audience. An unconfigured host or an
 * unverified receipt throws, so the erasure blocks and retries.
 */
import { lifecycleCallbackToken } from '../employees/native-lifecycle-bridge.js';

const PATH = '/internal/hivemind/account-erasure';

/**
 * @param {{ operationId: string, userId: string, orgIds: string[] }} input - Erasure operation and its company scope.
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ verified: true, operationId: string, archivedSessions: number, removedWakes: number }>}
 */
export async function eraseRuntimeAccount({ operationId, userId, orgIds }, { env = process.env, fetchImpl = fetch } = {}) {
  const secret = env.HIVE_HARNESS_RUNNER_SERVICE_SECRET;
  let url;
  try { url = new URL(env.HIVEMIND_EMPLOYEE_LIFECYCLE_URL); } catch { url = undefined; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !secret || Buffer.byteLength(secret) < 32) {
    throw Object.assign(new Error('Runtime account erasure is not configured'), { code: 'RUNTIME_ERASURE_UNAVAILABLE' });
  }
  url = new URL(PATH, url.origin);
  const payload = { operationId, userId, orgIds: [...orgIds].sort() };
  let result;
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${lifecycleCallbackToken(payload, secret, Date.now(), 'hivemind-account-erasure')}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
    const raw = await response.text();
    result = response.ok && raw.length <= 32000 ? JSON.parse(raw) : null;
  } catch { result = null; }
  if (result?.verified !== true || result.operationId !== operationId || !Number.isInteger(result.archivedSessions) || !Number.isInteger(result.removedWakes)) {
    throw Object.assign(new Error('Runtime account erasure is not verified'), { code: 'RUNTIME_ERASURE_INCOMPLETE' });
  }
  return { verified: true, operationId, archivedSessions: result.archivedSessions, removedWakes: result.removedWakes };
}
