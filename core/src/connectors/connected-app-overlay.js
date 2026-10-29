/** Merge active account receipts without waiting for the toolkit catalog. */
export function overlayActiveApps(connectors, accounts, nativeSlack = false) {
  const rows = new Map(connectors.map(row => [row.provider, row]));
  for (const account of accounts) {
    if (account?.status !== 'ACTIVE' || typeof account.toolkit !== 'string' || !/^[a-z0-9_-]+$/i.test(account.toolkit)) continue;
    const provider = account.toolkit.toLowerCase();
    const previous = rows.get(provider);
    rows.set(provider, { ...previous, provider, label: previous?.label || provider,
      status: 'connected', is_active: true, source: 'composio' });
  }
  if (nativeSlack) {
    rows.set('slack', { ...rows.get('slack'), provider: 'slack', label: 'Slack',
      status: 'connected', is_active: true, source: 'native' });
  }
  return [...rows.values()];
}

/**
 * Merge the chosen connection of every toolkit into the connector list. `rows` is the result of
 * `toolkitConnectionRows`: one row per toolkit by the shared rule (ACTIVE account, personal first,
 * newest when both subjects hold one; expired-only is `reconnect`). A connected row sets the
 * chosen account and origin; a reconnect row marks the provider `needs_reauth` unless another
 * source already reports it connected. Providers without an account are left unchanged.
 * @param {Array<object>} connectors rows already in the list
 * @param {Map<string, { toolkit: string, status: string, origin: string|null, accountId: string|null }>} rows
 * @returns {Array<object>} a new list
 */
export function overlayToolkitRows(connectors, rows) {
  const merged = new Map(connectors.map(row => [row.provider, row]));
  for (const row of rows.values()) {
    if (typeof row.toolkit !== 'string' || !/^[a-z0-9_-]+$/i.test(row.toolkit)) continue;
    const provider = row.toolkit.toLowerCase();
    const previous = merged.get(provider);
    if (row.status === 'connected') {
      merged.set(provider, { ...previous, provider, label: previous?.label || provider, status: 'connected', is_active: true,
        account_ref: row.accountId || previous?.account_ref || null, origin: row.origin, source: 'composio' });
    } else if (previous?.status !== 'connected') {
      merged.set(provider, { ...previous, provider, label: previous?.label || provider, status: 'needs_reauth', is_active: false,
        origin: null, source: 'composio' });
    }
  }
  return [...merged.values()];
}
