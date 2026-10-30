/**
 * Control-initiated removal of an Open Dot employee's data. After Control deletes the employee row, the trusted Open Dot
 * controller deletes the dot, its conversations, files, computer, routines and memory. Library artifacts and team memory
 * are Control records and are untouched. The call reuses the account-erasure channel (ACCOUNT_ERASURE_NATIVE_URL and
 * ACCOUNT_ERASURE_NATIVE_TOKEN) at the sibling path /v1/employee-removal and never carries a user ID or file path.
 */
const ERASURE_PATH = '/v1/account-erasure';
const REMOVAL_PATH = '/v1/employee-removal';
/** Delays before background retries of a pending cleanup; a repeated `remove` also retries it. */
export const REMOVAL_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);

/** Employee-removal endpoint derived from the configured erasure endpoint, or null when unconfigured or malformed. */
export function openDotRemovalEndpoint(env = process.env) {
  let url; try { url = new URL(env.ACCOUNT_ERASURE_NATIVE_URL); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== ERASURE_PATH) return null;
  if (!env.ACCOUNT_ERASURE_NATIVE_TOKEN) return null;
  url.pathname = REMOVAL_PATH;
  return url;
}

/** One idempotent cleanup attempt; never throws. Returns {status:'verified',dotsRemoved,alreadyRemoved} or {status:'pending',reason}. */
export async function removeOpenDotEmployee({ orgId, employeeId, dotId }, { env = process.env, fetchImpl = fetch } = {}) {
  const url = openDotRemovalEndpoint(env);
  if (!url) return { status: 'pending', reason: 'open_dot_removal_unconfigured' };
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${env.ACCOUNT_ERASURE_NATIVE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: orgId, employeeId, ...(typeof dotId === 'string' && dotId ? { dotId } : {}) }) });
    const raw = await response.text();
    if (raw.length > 32_000) throw Error('oversized');
    const result = JSON.parse(raw);
    if (!response.ok || result?.verified !== true || result.employeeId !== employeeId || result.computersRemoved !== true) {
      return { status: 'pending', reason: /^[a-z_]{3,80}$/.test(result?.error || '') ? `open_dot_${result.error}` : 'open_dot_removal_unconfirmed' };
    }
    return { status: 'verified', dotsRemoved: Number(result.dotsRemoved) || 0, alreadyRemoved: result.alreadyRemoved === true };
  } catch { return { status: 'pending', reason: 'open_dot_removal_unreachable' }; }
}

/** First attempt now; a pending result is retried in the background on {@link REMOVAL_RETRY_DELAYS_MS}. Returns the first result. */
export async function removeOpenDotEmployeeWithRetry(args, { delays = REMOVAL_RETRY_DELAYS_MS, remove = removeOpenDotEmployee, schedule = setTimeout, log = console.warn } = {}) {
  const first = await remove(args);
  if (first.status === 'verified' || first.reason === 'open_dot_removal_unconfigured') return first;
  const attempt = index => {
    if (index >= delays.length) { log('[open-dot-removal] cleanup still pending; repeat the employee removal to retry', { employeeId: args.employeeId, reason: first.reason }); return; }
    const timer = schedule(async () => {
      const result = await remove(args);
      if (result.status !== 'verified') attempt(index + 1);
    }, delays[index]);
    timer?.unref?.();
  };
  attempt(0);
  return first;
}
