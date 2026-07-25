import crypto from 'node:crypto';
import OAuth from 'oauth-1.0a';
import { getXCredential, saveXCredential, X_AUTH_OAUTH1, X_AUTH_OAUTH2 } from './x-auth-store.js';

const X_BASE = process.env.X_API_BASE_URL || 'https://api.x.com';
const ADS_BASE = process.env.X_ADS_BASE_URL || 'https://ads-api.x.com';
const TOKEN_URL = process.env.X_OAUTH2_TOKEN_URL || 'https://api.x.com/2/oauth2/token';

export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', providerStatus = null, details = null, rateReset = null } = {}) {
    super(message); this.name = 'ProviderError'; this.status = status; this.code = code;
    this.providerStatus = providerStatus; this.details = details; this.rateReset = rateReset;
  }
}

function safeMessage(payload, fallback) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return String(first?.message || first?.detail || payload?.detail || payload?.error_description || payload?.error || fallback).slice(0, 500);
}

export function oauth1Client(env = process.env) {
  const key = env.X_OAUTH1_CONSUMER_KEY;
  const secret = env.X_OAUTH1_CONSUMER_SECRET;
  if (!key || !secret) {
    const error = new Error('Official X OAuth 1.0a is not configured');
    error.status = 503; error.code = 'x_oauth1_unavailable'; throw error;
  }
  return new OAuth({
    consumer: { key, secret }, signature_method: 'HMAC-SHA1',
    hash_function(base, signingKey) { return crypto.createHmac('sha1', signingKey).update(base).digest('base64'); },
  });
}

export function oauth1Authorization({ url, method = 'GET', data = {}, token = null, env = process.env }) {
  const client = oauth1Client(env);
  return client.toHeader(client.authorize({ url, method, data }, token || undefined)).Authorization;
}

async function parseResponse(response) {
  const text = await response.text().catch(() => '');
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const status = [401, 403, 429].includes(response.status) ? response.status : 502;
    throw new ProviderError(safeMessage(payload, `X returned ${response.status}`), {
      status, code: response.status === 429 ? 'rate_limited' : (response.status === 401 ? 'reauth_required' : 'x_api_error'),
      providerStatus: response.status, details: payload, rateReset: response.headers.get('x-rate-limit-reset'),
    });
  }
  return { data: payload, headers: Object.fromEntries([...response.headers.entries()].filter(([key]) => key.startsWith('x-rate-limit') || key.startsWith('x-account-rate-limit'))) };
}

async function perform(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 }) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderError(error?.name === 'TimeoutError' ? 'X request timed out; state requires reconciliation' : 'Could not reach X', {
      status: 502, code: error?.name === 'TimeoutError' ? 'ambiguous_timeout' : 'provider_unreachable',
    });
  }
  return parseResponse(response);
}

function oauth2ClientCredentials(env = process.env) {
  const clientId = env.X_OAUTH2_CLIENT_ID;
  if (!clientId) { const e = new Error('Official X OAuth 2.0 is not configured'); e.status = 503; e.code = 'x_oauth2_unavailable'; throw e; }
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_OAUTH2_CLIENT_SECRET) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${env.X_OAUTH2_CLIENT_SECRET}`).toString('base64')}`;
  return { clientId, headers };
}

export async function refreshOAuth2Credential({ prisma, orgId, userId, force = false, env = process.env }) {
  const refresh = async (db) => {
    const row = await getXCredential({ prisma: db, orgId, userId, authKind: X_AUTH_OAUTH2, includeSecrets: true });
    if (!row) return null;
    if (!force && row.expiresAt && row.expiresAt.getTime() > Date.now() + 60_000) return row;
    if (!row.refreshToken) { const e = new Error('Reconnect X to refresh access'); e.status = 401; e.code = 'reauth_required'; throw e; }
    const { clientId, headers } = oauth2ClientCredentials(env);
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refreshToken });
    if (!env.X_OAUTH2_CLIENT_SECRET) form.set('client_id', clientId);
    const result = await perform(TOKEN_URL, { method: 'POST', headers, body: form });
    const token = result.data;
    await saveXCredential({
      prisma: db, orgId, userId, authKind: X_AUTH_OAUTH2,
      accessToken: token.access_token, refreshToken: token.refresh_token || row.refreshToken,
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
      scopes: String(token.scope || '').split(/\s+/).filter(Boolean), xUserId: row.xUserId, xUsername: row.xUsername,
    });
    return getXCredential({ prisma: db, orgId, userId, authKind: X_AUTH_OAUTH2, includeSecrets: true });
  };
  if (!prisma.$transaction) return refresh(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', `x-ads-oauth2:${orgId}:${userId}`);
    return refresh(tx);
  });
}

export async function directXRequest({ prisma, orgId, userId, path, method = 'GET', body, timeoutMs = 30_000 }) {
  let credential = await getXCredential({ prisma, orgId, userId, authKind: X_AUTH_OAUTH2, includeSecrets: true });
  if (!credential) { const e = new Error('Connect X before continuing'); e.status = 409; e.code = 'x_not_connected'; throw e; }
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now() + 60_000) {
    credential = await refreshOAuth2Credential({ prisma, orgId, userId });
  }
  const headers = { Authorization: `Bearer ${credential.accessToken}` };
  let requestBody;
  if (body !== undefined && path === '/2/media/upload' && body?.media) {
    const form = new FormData();
    form.set('media', new Blob([Buffer.from(body.media, 'base64')], { type: body.media_type || 'application/octet-stream' }), 'campaign-image');
    form.set('media_category', body.media_category || 'tweet_image');
    requestBody = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'; requestBody = JSON.stringify(body);
  }
  return perform(`${X_BASE}${path}`, { method, headers, body: requestBody, timeoutMs });
}

export async function directAdsRequest({ prisma, orgId, userId, path, method = 'GET', body, timeoutMs = 30_000, env = process.env }) {
  const credential = await getXCredential({ prisma, orgId, userId, authKind: X_AUTH_OAUTH1, includeSecrets: true });
  if (!credential?.tokenSecret) { const e = new Error('Enable X Ads before continuing'); e.status = 409; e.code = 'x_ads_not_connected'; throw e; }
  const url = `${ADS_BASE}${path}`;
  const headers = {};
  let requestBody;
  const oauthData = {};
  for (const [key, value] of new URL(url).searchParams.entries()) oauthData[key] = value;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'; requestBody = JSON.stringify(body);
  }
  headers.Authorization = oauth1Authorization({ url, method, data: oauthData, token: { key: credential.accessToken, secret: credential.tokenSecret }, env });
  return perform(url, { method, headers, body: requestBody, timeoutMs });
}
