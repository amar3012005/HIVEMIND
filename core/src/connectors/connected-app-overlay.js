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
