/**
 * The connected apps of one company, for Runtime's attention layer: it offers an event's assessment only the tools of apps the company
 * has an active connection for. The list comes from the connected-app catalogue Core already reads (`listConnectedAccounts`), is scoped to
 * the event's organization and user, and is cached briefly so an event burst reads the provider once. A failed or slow read answers
 * `undefined`, never an empty or a stale list: Runtime then offers only the event's own app, which is today's behaviour.
 */
const TOOLKIT = /^[a-z0-9_-]{1,60}$/u;
/** Most apps sent; Runtime's request schema allows the same. */
export const MAX_CONNECTED_TOOLKITS = 40;

/**
 * Active toolkit names of a connected-account listing.
 * @param {Array<{toolkit?: unknown, status?: unknown}>} accounts Catalogue rows.
 * @returns {string[]} Lower-case, well-formed, unique names, sorted, at most MAX_CONNECTED_TOOLKITS.
 */
export function activeToolkits(accounts) {
  const names = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (String(account?.status).toUpperCase() !== 'ACTIVE' || typeof account?.toolkit !== 'string') continue;
    const name = account.toolkit.toLowerCase();
    if (TOOLKIT.test(name)) names.add(name);
  }
  return [...names].sort().slice(0, MAX_CONNECTED_TOOLKITS);
}

/**
 * A cached, bounded lookup of a company's connected apps.
 * @param {{list: (orgId: string, userId: string) => Promise<Array<object>>, now?: () => number, ttlMs?: number, failureMs?: number, timeoutMs?: number, maxEntries?: number}} options The catalogue reader and bounds.
 * @returns {(row: {org_id: string, user_id: string}) => Promise<string[]|undefined>} The lookup; `undefined` when the catalogue cannot be read in time.
 */
export function createConnectedToolkitsLookup({ list, now = Date.now, ttlMs = 5 * 60_000, failureMs = 30_000, timeoutMs = 1500, maxEntries = 256 }) {
  const entries = new Map();
  return async function connectedToolkits(row) {
    if (typeof row?.org_id !== 'string' || typeof row?.user_id !== 'string') return undefined;
    const key = `${row.org_id}:${row.user_id}`;
    const saved = entries.get(key);
    if (saved && now() < saved.until) return saved.value;
    let timer;
    try {
      const accounts = await Promise.race([list(row.org_id, row.user_id), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
      const value = activeToolkits(accounts);
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { value, until: now() + ttlMs });
      return value;
    } catch {
      // A read that failed or timed out is unknown, never an empty catalogue; retry after a short pause.
      entries.delete(key);
      entries.set(key, { value: undefined, until: now() + failureMs });
      return undefined;
    } finally { clearTimeout(timer); }
  };
}

let production;
/**
 * The production lookup, backed by the Composio catalogue and shared by every bridge so the cache outlives one classification pass.
 * @returns {(row: {org_id: string, user_id: string}) => Promise<string[]|undefined>} The lookup.
 */
export function productionConnectedToolkits() {
  production ??= createConnectedToolkitsLookup({ list: async (orgId, userId) => (await import('./composio-service.js')).listConnectedAccounts(orgId, { userId }) });
  return production;
}
