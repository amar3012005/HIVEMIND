/**
 * Control Plane listing rule for "Reconnect". An expired or failed account is
 * worth a warning only when this person connected it (their own subject), so
 * reconnecting it is their action. An expired workspace-subject account that
 * nobody here owns is shown as plain available: the person cannot repair it
 * unless they connect the app themselves, which "available" already offers.
 * Used by control-plane-server.js only, never by the Core process.
 */

/**
 * @param {string} orgId organization id
 * @param {Array<{ toolkit?: string, status?: string, subject?: string }>} accounts rows from listConnectedAccounts
 * @param {Map<string, { toolkit: string, status: string, origin: string|null, accountId: string|null }>} rows toolkitConnectionRows result
 * @returns {Map<string, object>} rows where `reconnect` remains only for toolkits with a dead personal account
 */
export function actionableToolkitRows(orgId, accounts, rows) {
  const personalDead = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const status = String(account?.status || '').toUpperCase();
    if ((status === 'EXPIRED' || status === 'FAILED') && account.subject && String(account.subject) !== String(orgId)) {
      personalDead.add(String(account.toolkit || '').toLowerCase());
    }
  }
  const result = new Map();
  for (const [toolkit, row] of rows) {
    if (row.status === 'reconnect' && !personalDead.has(String(toolkit).toLowerCase())) continue;
    result.set(toolkit, row);
  }
  return result;
}
