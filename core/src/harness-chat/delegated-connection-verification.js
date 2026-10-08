import { requireNativeRuntime } from '../employees/native-lifecycle.js';
import { nativeAgentStoragePrincipal } from './organization-agent-access.js';
import { listNativeConnectedAccounts } from '../connectors/composio/composio-service.js';

function fail(code, status = 403) { throw Object.assign(new Error(code), { code, status }); }

/** Provider account state is authority; browser return flags and emails are not. */
export async function verifyDelegatedConnection({ db, claims, input, sharedOrganizationAgents = false,
  accounts = listNativeConnectedAccounts, runtime = requireNativeRuntime, storage = nativeAgentStoragePrincipal,
  now = () => new Date() }) {
  if (claims.operating_role !== 'runtime' || !claims.operating_session) fail('runtime_authority_required');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['session_id', 'toolkits', 'router_session_id'].includes(key))
    || typeof input.session_id !== 'string' || input.session_id.length > 180
    || typeof input.router_session_id !== 'string' || input.router_session_id.length > 180
    || !Array.isArray(input.toolkits) || !input.toolkits.length || input.toolkits.length > 8
    || input.toolkits.some(value => typeof value !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(value))) fail('invalid_connection_verification', 400);
  const principal = { orgId: claims.org_id, userId: claims.sub, runtimeSessionId: claims.operating_session, sharedOrganizationAgents };
  await runtime(db, principal);
  const scoped = await storage(db, principal);
  const session = await db.harnessSession.findFirst({ where: { id: input.session_id, orgId: scoped.orgId, userId: scoped.userId, status: 'active' } });
  if (!session) fail('employee_session_not_authorized');
  const event = await db.harnessSessionEvent.findFirst({ where: { sessionId: input.session_id, orgId: scoped.orgId, userId: scoped.userId,
    eventType: 'hivemind/composio-session' }, orderBy: { sequence: 'desc' } });
  const witness = event?.payload?.data;
  if (event?.payload?.type !== 'hivemind/composio-session' || witness?.routerSessionId !== input.router_session_id) fail('connection_session_witness_required');
  const userSubject = `hivemind:${principal.userId}`;
  const legacySubject = principal.orgId;
  if (![userSubject, legacySubject].includes(witness.subject)) fail('connection_actor_scope_mismatch');
  // Legacy org accounts are considered only when that exact subject is already
  // attested in this employee's router session; never broaden on a failed read.
  const rows = await accounts(principal.orgId, principal.userId, witness.subject);
  const statuses = [...new Set(input.toolkits)].map(toolkit => ({ toolkit,
    connected: rows.some(row => row.toolkit?.toLowerCase() === toolkit && row.status === 'ACTIVE') }));
  return { contract: 'hivemind.delegated-connection-verification.v1', verified: statuses.every(row => row.connected),
    statuses, checked_at: now().toISOString(), evidence: 'fresh-provider-account-state' };
}
