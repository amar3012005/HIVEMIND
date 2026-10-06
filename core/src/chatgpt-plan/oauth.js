import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { ChatgptPlanError, planEnabled, ownerKey, encrypt, decrypt, storeVerifiedPlanGrant,
  modifyPlanConnection, refreshPlanGrant } from './connections.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export function hostedClient(env) {
  planEnabled(env);
  if (!/^[a-zA-Z0-9_-]{8,256}$/.test(env.HIVE_CHATGPT_PLAN_CLIENT_ID) || env.HIVE_CHATGPT_PLAN_CLIENT_ID === 'dynamic_agent_client') {
    throw new ChatgptPlanError('hosted_client_unconfigured', 503);
  }
  const urls = {};
  for (const [name, variable] of Object.entries({ authorize: 'AUTHORIZATION_URL', token: 'TOKEN_URL', jwks: 'JWKS_URL', revoke: 'REVOCATION_URL' })) {
    try {
      const url = new URL(env[`HIVE_CHATGPT_PLAN_${variable}`]);
      if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) throw new Error();
      urls[name] = url.href;
    } catch { throw new ChatgptPlanError('hosted_endpoints_unconfigured', 503); }
  }
  let redirect;
  try {
    redirect = new URL(env.HIVE_CHATGPT_PLAN_REDIRECT_URI);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error();
  } catch { throw new ChatgptPlanError('hosted_callback_unconfigured', 503); }
  const method = env.HIVE_CHATGPT_PLAN_TOKEN_AUTH_METHOD;
  if (!['none', 'client_secret_post'].includes(method) || (method === 'client_secret_post' && !env.HIVE_CHATGPT_PLAN_CLIENT_SECRET)) {
    throw new ChatgptPlanError('hosted_token_auth_unconfigured', 503);
  }
  return { ...urls, redirect: redirect.href, clientId: env.HIVE_CHATGPT_PLAN_CLIENT_ID, method };
}
async function jsonFetch(url, init, fetchImpl) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (text.length > 1_000_000) throw new ChatgptPlanError('plan_provider_contract_invalid', 502);
  let body; try { body = JSON.parse(text); } catch { throw new ChatgptPlanError('plan_provider_contract_invalid', 502); }
  return { response, body };
}
export async function tokenRequest(env, fields, fetchImpl = fetch) {
  const client = hostedClient(env);
  const form = new URLSearchParams({ ...fields, client_id: client.clientId, resource: RESOURCE });
  if (client.method === 'client_secret_post') form.set('client_secret', env.HIVE_CHATGPT_PLAN_CLIENT_SECRET);
  const { response, body } = await jsonFetch(client.token, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, fetchImpl);
  if (!response.ok) {
    const invalid = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(body?.error);
    throw new ChatgptPlanError(invalid ? 'plan_reauthorization_required' : 'plan_provider_temporarily_unavailable', invalid ? 401 : 503);
  }
  if (!body || typeof body !== 'object' || (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
    || typeof body.access_token !== 'string' || (body.access_token.length < 10 || body.access_token.length > 32000) || typeof body.refresh_token !== 'string' || (!body.refresh_token || body.refresh_token.length > 32000)
    || !Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 86400 * 30
    || typeof body.scope !== 'string' || !body.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) {
    throw new ChatgptPlanError('plan_token_contract_invalid', 502);
  }
  return body;
}
export async function verifyIdentity(token, nonce, env, fetchImpl = fetch) {
  if (typeof token !== 'string' || token.length > 32000) throw new ChatgptPlanError('plan_identity_invalid');
  let header, payload, signature, signed;
  try {
    const parts = token.split('.'); if (parts.length !== 3) throw new Error();
    header = JSON.parse(Buffer.from(parts[0], 'base64url')); payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
    signature = Buffer.from(parts[2], 'base64url'); signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  } catch { throw new ChatgptPlanError('plan_identity_invalid'); }
  if (!['RS256', 'ES256'].includes(header?.alg) || typeof header.kid !== 'string' || header.crit) throw new ChatgptPlanError('plan_identity_invalid');
  const { response, body } = await jsonFetch(hostedClient(env).jwks, {}, fetchImpl);
  if (!response.ok || !Array.isArray(body?.keys) || body.keys.length > 100) throw new ChatgptPlanError('plan_identity_keys_unavailable', 503);
  const keys = body.keys.filter(key => key.kid === header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg)
    && (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
  let valid = false;
  try { valid = keys.length === 1 && verify('sha256', signed,
    { key: createPublicKey({ key: keys[0], format: 'jwk' }), ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }, signature); } catch {}
  const now = Math.floor(Date.now() / 1000); const client = hostedClient(env);
  const audience = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  if (!valid || payload.iss !== ISSUER || !audience.includes(client.clientId) || (audience.length > 1 && payload.azp !== client.clientId)
    || (nonce !== undefined && payload.nonce !== nonce) || typeof payload.sub !== 'string' || !payload.sub || !Number.isSafeInteger(payload.exp)
    || payload.exp < now - 30 || !Number.isSafeInteger(payload.iat) || payload.iat > now + 30
    || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > now + 30))) throw new ChatgptPlanError('plan_identity_invalid');
  return payload;
}
function grantFrom(token, subject, client, previous = {}) {
  return { ...previous, issuer: ISSUER, subject, clientId: client.clientId, accessToken: token.access_token,
    refreshToken: token.refresh_token, scopes: token.scope.split(/\s+/), expiresAt: Date.now() + token.expires_in * 1000 };
}
export async function fetchModels(grant, fetchImpl = fetch) {
  const { response, body } = await jsonFetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${grant.accessToken}` } }, fetchImpl);
  if (!response.ok) throw new ChatgptPlanError('plan_catalog_unavailable', 503);
  if (!Array.isArray(body?.models) || body.models.length > 1000) throw new ChatgptPlanError('plan_catalog_invalid', 502);
  const models = [...new Set(body.models.filter(item => item?.visibility === 'list' && typeof item.slug === 'string'
    && item.slug.length > 0 && item.slug.length <= 100).map(item => item.slug))];
  if (!models.length) throw new ChatgptPlanError('plan_models_unavailable', 503);
  return models;
}
export async function startPlanOAuth(prisma, owner, env) {
  const client = hostedClient(env); ownerKey(owner);
  if (!(await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } }))?.isActive) {
    throw new ChatgptPlanError('plan_membership_revoked');
  }
  const state = random(), verifier = random(), nonce = random();
  await prisma.chatgptPlanOAuthAttempt.deleteMany({ where: { ...owner, expiresAt: { lt: new Date() } } });
  await prisma.chatgptPlanOAuthAttempt.create({ data: { ...owner, stateHash: hash(state), expiresAt: new Date(Date.now() + 600000),
    encryptedContext: encrypt(owner, { kind: 'oauth-pending', stateHash: hash(state), verifier, nonce, redirect: client.redirect }, env) } });
  const url = new URL(client.authorize);
  for (const [name, value] of Object.entries({ client_id: client.clientId, response_type: 'code', redirect_uri: client.redirect,
    resource: RESOURCE, scope: SCOPES, state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(name, value);
  return { authorization_url: url.href, expires_in: 600 };
}
export async function finishPlanOAuth(prisma, owner, input, env, fetchImpl = fetch) {
  const client = hostedClient(env); ownerKey(owner);
  if (!input || typeof input.state !== 'string' || !/^[\w-]{43}$/.test(input.state)
    || typeof input.code !== 'string' || !input.code || input.code.length > 8192) throw new ChatgptPlanError('plan_callback_invalid', 400);
  const where = { stateHash: hash(input.state), ...owner, expiresAt: { gt: new Date() }, consumedAt: null };
  const attempt = await prisma.chatgptPlanOAuthAttempt.findFirst({ where });
  if (!attempt || (await prisma.chatgptPlanOAuthAttempt.updateMany({ where, data: { consumedAt: new Date(), encryptedContext: '' } })).count !== 1) {
    throw new ChatgptPlanError('plan_callback_expired_or_replayed');
  }
  if (!(await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } }))?.isActive) {
    throw new ChatgptPlanError('plan_membership_revoked');
  }
  const pending = decrypt(owner, attempt.encryptedContext, env);
  if (pending.kind !== 'oauth-pending' || pending.stateHash !== hash(input.state) || pending.redirect !== client.redirect) throw new ChatgptPlanError('plan_callback_invalid');
  const token = await tokenRequest(env, { grant_type: 'authorization_code', code: input.code, code_verifier: pending.verifier,
    redirect_uri: pending.redirect }, fetchImpl);
  const identity = await verifyIdentity(token.id_token, pending.nonce, env, fetchImpl);
  const grant = grantFrom(token, identity.sub, client); grant.models = await fetchModels(grant, fetchImpl);
  await storeVerifiedPlanGrant(prisma, owner, grant, env);
  return { connected: true, models: grant.models };
}
export function registeredRefresh(env, fetchImpl = fetch) {
  return async current => {
    const client = hostedClient(env);
    const token = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: current.refreshToken }, fetchImpl);
    if (token.id_token) {
      const identity = await verifyIdentity(token.id_token, undefined, env, fetchImpl);
      if (identity.sub !== current.subject) throw new ChatgptPlanError('plan_reauthorization_required', 401);
    }
    return grantFrom(token, current.subject, client, current);
  };
}
export async function connectionStatus(prisma, owner, env) {
  ownerKey(owner);
  let available = true, reason = null; try { hostedClient(env); } catch (error) { available = false; reason = error.code || 'hosted_client_unconfigured'; }
  if (!(await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } }))?.isActive) throw new ChatgptPlanError('plan_membership_revoked');
  const row = await prisma.chatgptPlanConnection.findUnique({ where: { orgId_userId: owner } });
  const grant = available && row?.status === 'active' ? decrypt(owner, row.encryptedGrant, env) : null;
  return { available, reason, connected: Boolean(grant),
    models: grant?.models || [], selected_model: grant?.selectedModel || grant?.models?.[0] || null, platform_fallback: grant?.platformFallback === true };
}
export async function updateConnection(prisma, owner, env, operation, input, fetchImpl = fetch) {
  if (operation === 'disconnect') {
    return modifyPlanConnection(prisma, owner, env, async (tx, row, grant) => {
      let revoked = !grant;
      if (grant) {
        try {
          const client = hostedClient(env); const form = new URLSearchParams({ token: grant.refreshToken, token_type_hint: 'refresh_token', client_id: client.clientId });
          if (client.method === 'client_secret_post') form.set('client_secret', env.HIVE_CHATGPT_PLAN_CLIENT_SECRET);
          const response = await fetchImpl(client.revoke, { method: 'POST', body: form,
            headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
          revoked = response.ok;
        } catch { revoked = false; }
      }
      if (row) await tx.chatgptPlanConnection.update({ where: { orgId_userId: owner }, data: { status: 'revoked', encryptedGrant: '' } });
      return { disconnected: true, remote_revocation_confirmed: revoked };
    });
  }
  hostedClient(env);
  const renewed = await refreshPlanGrant(prisma, owner, env, registeredRefresh(env, fetchImpl));
  if (renewed.reauthorizationRequired) throw new ChatgptPlanError('plan_reauthorization_required', 401);
  return modifyPlanConnection(prisma, owner, env, async (tx, row, grant) => {
    if (!grant) throw new ChatgptPlanError('chatgpt_connection_required');
    if (operation === 'models') grant.models = await fetchModels(grant, fetchImpl);
    else if (operation === 'select') {
      if (!input || typeof input.model !== 'string' || !grant.models.includes(input.model) || typeof input.platform_fallback !== 'boolean') {
        throw new ChatgptPlanError('plan_selection_invalid', 400);
      }
      grant.selectedModel = input.model; grant.platformFallback = input.platform_fallback;
    } else throw new ChatgptPlanError('plan_operation_invalid', 400);
    if (!grant.models.includes(grant.selectedModel)) grant.selectedModel = grant.models[0];
    await tx.chatgptPlanConnection.update({ where: { orgId_userId: owner }, data: { encryptedGrant: encrypt(owner, grant, env) } });
    return { models: grant.models, selected_model: grant.selectedModel, platform_fallback: grant.platformFallback === true };
  });
}

export async function brainConnectionRoute(prisma, owner, sessionId, env) {
  ownerKey(owner);
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new ChatgptPlanError('owned_brain_session_required');
  const status = await connectionStatus(prisma, owner, env);
  if (!status.available || !status.connected) return { eligible: false, ...status };
  const session = await prisma.harnessSession.findFirst({ where: { id: sessionId, ...owner, status: 'active' } });
  const eligible = Boolean(session && session.profile === 'hivemind-chat' && session.header?.agentPreset === 'hivemind-chat' && !session.header?.parentSession);
  return { eligible, ...status };
}
