import crypto from 'node:crypto';
import {
  consumeOAuthState, createOAuthState, deleteXCredential, getXCredential, saveXCredential,
  X_AUTH_OAUTH1, X_AUTH_OAUTH2,
} from './x-auth-store.js';
import { directXRequest, oauth1Client } from './x-api-client.js';

const OAUTH2_AUTHORIZE_URL = process.env.X_OAUTH2_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize';
const OAUTH2_TOKEN_URL = process.env.X_OAUTH2_TOKEN_URL || 'https://api.x.com/2/oauth2/token';
const OAUTH1_REQUEST_TOKEN_URL = process.env.X_OAUTH1_REQUEST_TOKEN_URL || 'https://api.x.com/oauth/request_token';
const OAUTH1_AUTHORIZE_URL = process.env.X_OAUTH1_AUTHORIZE_URL || 'https://api.x.com/oauth/authorize';
const OAUTH1_ACCESS_TOKEN_URL = process.env.X_OAUTH1_ACCESS_TOKEN_URL || 'https://api.x.com/oauth/access_token';
const X_SCOPES = ['users.read', 'tweet.read', 'tweet.write', 'media.write', 'offline.access'];

function callbackBase(env = process.env) {
  const value = env.X_ADS_CALLBACK_BASE_URL || env.HIVEMIND_API_URL;
  if (!value) throw configurationError('callback URL');
  return String(value).replace(/\/$/, '');
}

export function oauth2CallbackUrl(env = process.env) { return `${callbackBase(env)}/api/x-ads/oauth/oauth2/callback`; }
export function oauth1CallbackUrl(env = process.env) { return `${callbackBase(env)}/api/x-ads/oauth/oauth1/callback`; }

function frontendCampaignsUrl(env = process.env) {
  return env.X_ADS_FRONTEND_URL || 'https://next.singulancelabs.com/hivemind/app/employees/campaigns';
}

function configurationError(kind) {
  const error = new Error(`Official X ${kind} is not configured`);
  error.status = 503; error.code = `x_${kind.toLowerCase().replaceAll(' ', '')}_unavailable`; return error;
}

function oauth2Client(env = process.env) {
  if (!env.X_OAUTH2_CLIENT_ID) throw configurationError('OAuth2');
  return { id: env.X_OAUTH2_CLIENT_ID, secret: env.X_OAUTH2_CLIENT_SECRET || null };
}

function oauth1Header({ url, method = 'POST', data = {}, token, env = process.env }) {
  const client = oauth1Client(env);
  const signed = client.authorize({ url, method, data }, token);
  for (const [key, value] of Object.entries(data)) if (key.startsWith('oauth_')) signed[key] = value;
  return client.toHeader(signed).Authorization;
}

async function urlEncodedRequest(url, { headers, body }) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  } catch {
    const error = new Error('Could not reach X OAuth'); error.status = 502; error.code = 'x_oauth_unreachable'; throw error;
  }
  const text = await response.text();
  const data = Object.fromEntries(new URLSearchParams(text));
  if (!response.ok || data.error) {
    const error = new Error(String(data.error_description || data.error || `X OAuth returned ${response.status}`).slice(0, 500));
    error.status = response.status === 401 || response.status === 403 ? response.status : 502;
    error.code = 'x_oauth_exchange_failed'; throw error;
  }
  return data;
}

export async function startOAuth2({ prisma, orgId, userId, env = process.env }) {
  const client = oauth2Client(env);
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  await createOAuthState({ prisma, orgId, userId, authKind: X_AUTH_OAUTH2, state, verifier, ttlMs: 5 * 60 * 1000 });
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.id, redirect_uri: oauth2CallbackUrl(env),
    scope: X_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return { authorization_url: `${OAUTH2_AUTHORIZE_URL}?${query}`, expires_in: 300 };
}

export async function startOAuth1({ prisma, orgId, userId, env = process.env }) {
  const identity = await getXCredential({ prisma, orgId, userId, authKind: X_AUTH_OAUTH2 });
  if (!identity) { const e = new Error('Connect X before enabling X Ads'); e.status = 409; e.code = 'x_not_connected'; throw e; }
  const callback = oauth1CallbackUrl(env);
  const headers = {
    Authorization: oauth1Header({ url: OAUTH1_REQUEST_TOKEN_URL, data: { oauth_callback: callback }, env }),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const token = await urlEncodedRequest(OAUTH1_REQUEST_TOKEN_URL, { headers });
  if (!token.oauth_token || !token.oauth_token_secret || token.oauth_callback_confirmed !== 'true') {
    const error = new Error('X did not confirm the OAuth callback'); error.status = 502; error.code = 'x_oauth_callback_unconfirmed'; throw error;
  }
  await createOAuthState({
    prisma, orgId, userId, authKind: X_AUTH_OAUTH1,
    requestToken: token.oauth_token, requestSecret: token.oauth_token_secret, ttlMs: 10 * 60 * 1000,
  });
  return { authorization_url: `${OAUTH1_AUTHORIZE_URL}?${new URLSearchParams({ oauth_token: token.oauth_token })}`, expires_in: 600 };
}

export async function completeOAuth2({ prisma, code, state, env = process.env }) {
  if (!code || !state) { const e = new Error('X OAuth callback is incomplete'); e.status = 400; e.code = 'oauth_callback_incomplete'; throw e; }
  const pending = await consumeOAuthState({ prisma, authKind: X_AUTH_OAUTH2, state });
  const client = oauth2Client(env);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const form = new URLSearchParams({
    code, grant_type: 'authorization_code', redirect_uri: oauth2CallbackUrl(env), code_verifier: pending.verifier,
  });
  if (client.secret) headers.Authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
  else form.set('client_id', client.id);
  const response = await fetch(OAUTH2_TOKEN_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(30_000) });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) {
    const e = new Error(String(token.error_description || token.error || 'X token exchange failed').slice(0, 500));
    e.status = response.status === 401 || response.status === 403 ? response.status : 502; e.code = 'x_oauth_exchange_failed'; throw e;
  }
  await saveXCredential({
    prisma, orgId: pending.orgId, userId: pending.userId, authKind: X_AUTH_OAUTH2,
    accessToken: token.access_token, refreshToken: token.refresh_token || null,
    expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
    scopes: String(token.scope || X_SCOPES.join(' ')).split(/\s+/).filter(Boolean),
  });
  try {
    const me = (await directXRequest({ prisma, orgId: pending.orgId, userId: pending.userId, path: '/2/users/me?user.fields=id,name,username,profile_image_url' }))?.data?.data;
    await saveXCredential({
      prisma, orgId: pending.orgId, userId: pending.userId, authKind: X_AUTH_OAUTH2,
      accessToken: token.access_token, refreshToken: token.refresh_token || null,
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
      scopes: String(token.scope || X_SCOPES.join(' ')).split(/\s+/).filter(Boolean), xUserId: me?.id, xUsername: me?.username,
    });
  } catch (error) {
    await deleteXCredential({ prisma, orgId: pending.orgId, userId: pending.userId, authKind: X_AUTH_OAUTH2 });
    throw error;
  }
  return pending;
}

export async function completeOAuth1({ prisma, requestToken, verifier, env = process.env }) {
  if (!requestToken || !verifier) { const e = new Error('X Ads OAuth callback is incomplete'); e.status = 400; e.code = 'oauth_callback_incomplete'; throw e; }
  const pending = await consumeOAuthState({ prisma, authKind: X_AUTH_OAUTH1, requestToken });
  const data = { oauth_verifier: verifier };
  const headers = {
    Authorization: oauth1Header({ url: OAUTH1_ACCESS_TOKEN_URL, data, token: { key: requestToken, secret: pending.requestSecret }, env }),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const token = await urlEncodedRequest(OAUTH1_ACCESS_TOKEN_URL, { headers });
  if (!token.oauth_token || !token.oauth_token_secret || !token.user_id) {
    const error = new Error('X did not return an Ads user credential'); error.status = 502; error.code = 'x_oauth_exchange_failed'; throw error;
  }
  const identity = await getXCredential({ prisma, orgId: pending.orgId, userId: pending.userId, authKind: X_AUTH_OAUTH2 });
  if (!identity || String(identity.xUserId || '') !== String(token.user_id)) {
    const error = new Error('Enable X Ads with the same X identity connected in step one');
    error.status = 409; error.code = 'x_identity_mismatch'; throw error;
  }
  await saveXCredential({
    prisma, orgId: pending.orgId, userId: pending.userId, authKind: X_AUTH_OAUTH1,
    accessToken: token.oauth_token, tokenSecret: token.oauth_token_secret,
    xUserId: token.user_id, xUsername: token.screen_name || null,
  });
  return pending;
}

export async function disconnectX({ prisma, orgId, userId, authKind }) {
  await deleteXCredential({ prisma, orgId, userId, authKind });
  return { disconnected: true, auth_kind: authKind };
}

function redirect(res, status, error = null, env = process.env) {
  const target = new URL(frontendCampaignsUrl(env));
  target.searchParams.set('x_connection', status);
  if (error) target.searchParams.set('x_error', error);
  res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

async function auditConnection(prisma, pending, action) {
  await prisma.auditLog.create({ data: {
    userId: pending.userId, organizationId: pending.orgId, eventType: `x_ads.${action}`,
    eventCategory: 'data_modification', resourceType: 'x_ads_connection', resourceId: null,
    action, actorType: 'user', platformType: 'dashboard', metadata: { auth_kind: pending.authKind },
  } }).catch(() => {});
}

export async function handleXAdsOAuthCallback({ pathname, url, res, prisma }) {
  if (pathname !== '/api/x-ads/oauth/oauth2/callback' && pathname !== '/api/x-ads/oauth/oauth1/callback') return false;
  try {
    if (url.searchParams.get('denied') || url.searchParams.get('error')) {
      const error = new Error('X authorization was cancelled'); error.code = 'authorization_cancelled'; throw error;
    }
    if (pathname.endsWith('/oauth2/callback')) {
      const pending = await completeOAuth2({ prisma, code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      await auditConnection(prisma, pending, 'oauth2_connected');
      redirect(res, 'x_connected');
    } else {
      const pending = await completeOAuth1({ prisma, requestToken: url.searchParams.get('oauth_token'), verifier: url.searchParams.get('oauth_verifier') });
      await auditConnection(prisma, pending, 'oauth1_connected');
      redirect(res, 'ads_connected');
    }
  } catch (error) {
    console.warn('[x-ads-oauth] callback failed:', error.code || error.message);
    redirect(res, 'error', error.code || 'oauth_failed');
  }
  return true;
}
