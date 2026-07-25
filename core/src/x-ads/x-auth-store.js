import crypto from 'node:crypto';

export const X_AUTH_OAUTH1 = 'OAUTH1';
export const X_AUTH_OAUTH2 = 'OAUTH2';

function encryptionKey(env = process.env) {
  const secret = env.X_ADS_CREDENTIAL_ENCRYPTION_KEY
    || env.HIVEMIND_CONNECTOR_ENCRYPTION_KEY
    || env.HIVEMIND_MCP_TOKEN_SECRET
    || env.SESSION_SECRET;
  if (!secret) {
    const error = new Error('X Ads credential encryption is not configured');
    error.status = 503; error.code = 'x_ads_encryption_unavailable';
    throw error;
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function aad({ orgId, userId, authKind, field }) {
  return Buffer.from(`x-ads:${orgId}:${userId}:${authKind}:${field}`, 'utf8');
}

export function encryptCredential(value, binding, env = process.env) {
  if (value === null || value === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCredential(value, binding, env = process.env) {
  if (!value) return null;
  const [version, iv, tag, encrypted] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted X credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function hashOAuthValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function binding(row, field) {
  return { orgId: row.orgId, userId: row.userId, authKind: row.authKind, field };
}

export async function getXCredential({ prisma, orgId, userId, authKind, includeSecrets = false }) {
  const row = await prisma.xAdsCredential.findUnique({
    where: { orgId_userId_authKind: { orgId, userId, authKind } },
  });
  if (!row || row.status !== 'active') return null;
  if (!includeSecrets) return row;
  return {
    ...row,
    accessToken: decryptCredential(row.accessTokenEncrypted, binding(row, 'access_token')),
    refreshToken: decryptCredential(row.refreshTokenEncrypted, binding(row, 'refresh_token')),
    tokenSecret: decryptCredential(row.tokenSecretEncrypted, binding(row, 'token_secret')),
  };
}

export async function saveXCredential({ prisma, orgId, userId, authKind, accessToken, refreshToken = null, tokenSecret = null, expiresAt = null, scopes = [], xUserId = null, xUsername = null }) {
  const scope = { orgId, userId, authKind };
  const data = {
    xUserId: xUserId ? String(xUserId) : null,
    xUsername: xUsername ? String(xUsername) : null,
    accessTokenEncrypted: encryptCredential(accessToken, { ...scope, field: 'access_token' }),
    refreshTokenEncrypted: encryptCredential(refreshToken, { ...scope, field: 'refresh_token' }),
    tokenSecretEncrypted: encryptCredential(tokenSecret, { ...scope, field: 'token_secret' }),
    expiresAt, scopes: [...new Set(scopes.filter(Boolean))], status: 'active', connectedAt: new Date(),
  };
  return prisma.xAdsCredential.upsert({
    where: { orgId_userId_authKind: scope },
    create: { ...scope, ...data },
    update: data,
  });
}

export async function deleteXCredential({ prisma, orgId, userId, authKind }) {
  return prisma.xAdsCredential.deleteMany({ where: { orgId, userId, authKind } });
}

export async function createOAuthState({ prisma, orgId, userId, authKind, state = null, verifier = null, requestToken = null, requestSecret = null, ttlMs = 10 * 60 * 1000 }) {
  const scope = { orgId, userId, authKind };
  return prisma.xAdsOAuthState.create({ data: {
    ...scope,
    stateHash: state ? hashOAuthValue(state) : null,
    requestTokenHash: requestToken ? hashOAuthValue(requestToken) : null,
    verifierEncrypted: encryptCredential(verifier, { ...scope, field: 'oauth_verifier' }),
    requestSecretEncrypted: encryptCredential(requestSecret, { ...scope, field: 'request_secret' }),
    expiresAt: new Date(Date.now() + ttlMs),
  } });
}

export async function consumeOAuthState({ prisma, authKind, state = null, requestToken = null }) {
  const where = state ? { stateHash: hashOAuthValue(state) } : { requestTokenHash: hashOAuthValue(requestToken) };
  const row = await prisma.xAdsOAuthState.findUnique({ where });
  if (!row || row.authKind !== authKind || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
    const error = new Error('OAuth state is invalid or expired');
    error.status = 400; error.code = 'oauth_state_invalid';
    throw error;
  }
  const claimed = await prisma.xAdsOAuthState.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) {
    const error = new Error('OAuth state has already been used');
    error.status = 409; error.code = 'oauth_state_consumed';
    throw error;
  }
  return {
    ...row,
    verifier: decryptCredential(row.verifierEncrypted, binding(row, 'oauth_verifier')),
    requestSecret: decryptCredential(row.requestSecretEncrypted, binding(row, 'request_secret')),
  };
}
