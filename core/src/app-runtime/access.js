import { AppRuntimeError } from './contract.js';
export function assertAppRuntimePrincipal(principal, method = 'GET') {
  if (!principal?.orgId || !principal?.userId) throw new AppRuntimeError('unauthorized','Authentication required');
  // Org-wide v1 cannot broaden project/team/container constrained credentials.
  if (principal.projectId || principal.teamId || principal.project_id || principal.team_id || principal.isServiceKey
      || (Array.isArray(principal.containerTags) && principal.containerTags.length)) {
    throw new AppRuntimeError('forbidden','Organization-wide CRM requires unscoped user authority');
  }
  const scopes = principal.effectiveScopes ?? principal.scopes;
  const allowed = method === 'GET' ? ['*','mcp','app:read','app:write'] : ['*','mcp','app:write'];
  if (!Array.isArray(scopes) || !allowed.some(scope => scopes.includes(scope))) throw new AppRuntimeError('forbidden','CRM access is not granted by this credential');
  return principal;
}
/** Exact fixed prefix/method match, never a wildcard proxy grant. */
export function isAllowedAppRuntimeOperation(path, method) {
  const base = '/api/app-runtime/apps';
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  if(path===base) return method==='GET'||method==='POST';
  if(new RegExp(`^${base}/${id}$`,'i').test(path)) return method==='GET'||method==='PATCH';
  if(new RegExp(`^${base}/${id}/(published|workflows)$`,'i').test(path)) return method==='GET';
  if(new RegExp(`^${base}/${id}/(validate|publish)$`,'i').test(path)) return method==='POST';
  if(new RegExp(`^${base}/${id}/records$`,'i').test(path)) return method==='GET'||method==='POST';
  return method==='PATCH'&&new RegExp(`^${base}/${id}/records/${id}$`,'i').test(path);
}
