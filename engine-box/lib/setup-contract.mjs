const ROLES = new Set(['owner', 'admin', 'operator', 'auditor', 'user']);
const REQUIRED_MODEL_CAPABILITIES = ['embedding', 'rerank', 'chat'];

/** Validate the local-only setup payload before it reaches appliance storage. */
export function validateSetupInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('setup payload must be an object');
  const oidc = input.oidc;
  if (!oidc || !httpsUrl(oidc.issuer) || !nonEmpty(oidc.client_id) || !nonEmpty(oidc.client_secret) || !httpsUrl(oidc.redirect_url)) {
    throw new Error('valid local OIDC issuer, client ID, client secret, and HTTPS redirect URL are required');
  }
  if (!oidc.redirect_url.includes('/oauth2/callback')) throw new Error('OIDC redirect URL must end at /oauth2/callback');
  const groupMapping = oidc.group_mapping || {};
  for (const [role, groups] of Object.entries(groupMapping)) {
    if (!ROLES.has(role) || !Array.isArray(groups) || groups.some((group) => !nonEmpty(group))) throw new Error('OIDC group mapping is invalid');
  }
  const routes = input.model_routes;
  if (!routes || typeof routes !== 'object') throw new Error('local model routes are required');
  for (const capability of REQUIRED_MODEL_CAPABILITIES) {
    const route = routes[capability];
    if (!route || !httpsUrl(route.base_url) || !nonEmpty(route.model)) throw new Error(`local ${capability} model route is required`);
    if (route.execution !== 'local') throw new Error(`initial ${capability} model route must be local`);
  }
  if (!Number.isInteger(routes.embedding.dimension) || routes.embedding.dimension < 1) throw new Error('embedding route requires a positive dimension');
  const backup = input.backup;
  if (!backup || !nonEmpty(backup.destination) || !nonEmpty(backup.encryption_key_reference)) throw new Error('encrypted backup destination and key reference are required');
  const access = input.access || { mode: 'loopback' };
  if (!['loopback', 'lan_https'].includes(access.mode)) throw new Error('access mode must be loopback or lan_https');
  if (access.mode === 'lan_https' && !nonEmpty(access.hostname)) throw new Error('LAN HTTPS requires a local hostname');
  return true;
}

export function createSetupRecord(input, { now = new Date().toISOString() } = {}) {
  validateSetupInput(input);
  return {
    version: 1,
    state: 'configured',
    configured_at: now,
    access: { mode: input.access?.mode || 'loopback', hostname: input.access?.hostname || null },
    oidc: {
      issuer: input.oidc.issuer,
      client_id: input.oidc.client_id,
      redirect_url: input.oidc.redirect_url,
      group_mapping: input.oidc.group_mapping || {},
    },
    model_routes: input.model_routes,
    backup: input.backup,
    // The secret is intentionally stored separately and is never returned in
    // an API response or copied into the audit record.
    secret_fields: ['oidc.client_secret'],
  };
}

export function assertActivationRecord(record = {}, canary = {}) {
  if (record.state !== 'configured') throw new Error('local setup has not completed');
  if (!canary || canary.state !== 'passed' || !nonEmpty(canary.receipt_id)) throw new Error('functional canary receipt is required before activation');
  return true;
}

export function redactSetupRecord(record = {}) {
  const clone = structuredClone(record);
  delete clone.oidc?.client_secret;
  delete clone.model_routes?.embedding?.api_key;
  delete clone.model_routes?.rerank?.api_key;
  delete clone.model_routes?.chat?.api_key;
  return clone;
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function httpsUrl(value) { try { return new URL(value).protocol === 'https:'; } catch { return false; } }
