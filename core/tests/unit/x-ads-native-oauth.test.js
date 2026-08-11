import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeOAuthState, createOAuthState, decryptCredential, encryptCredential,
  getXCredential, X_AUTH_OAUTH2,
} from '../../src/x-ads/x-auth-store.js';
import { oauth1Client } from '../../src/x-ads/x-api-client.js';
import { completeOAuth1, oauth2CallbackUrl, startOAuth2 } from '../../src/x-ads/oauth.js';

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const ENV = { X_ADS_CREDENTIAL_ENCRYPTION_KEY: 'unit-test-encryption-key' };

function statePrisma() {
  const rows = [];
  return {
    rows,
    xAdsOAuthState: {
      create: async ({ data }) => {
        const row = { id: `state-${rows.length + 1}`, consumedAt: null, createdAt: new Date(), ...data };
        rows.push(row); return row;
      },
      findUnique: async ({ where }) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
      updateMany: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id && !item.consumedAt && item.expiresAt > where.expiresAt.gt);
        if (!row) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
  };
}

test('credential ciphertext is bound to organization, user, auth kind and field', () => {
  const binding = { orgId: ORG, userId: USER, authKind: X_AUTH_OAUTH2, field: 'access_token' };
  const encrypted = encryptCredential('secret-token', binding, ENV);
  assert.equal(decryptCredential(encrypted, binding, ENV), 'secret-token');
  assert.throws(() => decryptCredential(encrypted, { ...binding, userId: 'other-user' }, ENV));
  assert.throws(() => decryptCredential(encrypted, { ...binding, field: 'refresh_token' }, ENV));
});

test('credential lookup uses the exact organization and user compound key', async () => {
  let query;
  const prisma = { xAdsCredential: { findUnique: async (args) => { query = args; return null; } } };
  assert.equal(await getXCredential({ prisma, orgId: ORG, userId: USER, authKind: X_AUTH_OAUTH2 }), null);
  assert.deepEqual(query.where, { orgId_userId_authKind: { orgId: ORG, userId: USER, authKind: X_AUTH_OAUTH2 } });
});

test('OAuth state is hashed at rest, tenant-bound and consumed only once', async () => {
  const previous = process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = ENV.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  const prisma = statePrisma();
  await createOAuthState({ prisma, orgId: ORG, userId: USER, authKind: X_AUTH_OAUTH2, state: 'browser-state', verifier: 'pkce-verifier' });
  assert.notEqual(prisma.rows[0].stateHash, 'browser-state');
  assert.equal(prisma.rows[0].verifierEncrypted.includes('pkce-verifier'), false);
  const consumed = await consumeOAuthState({ prisma, authKind: X_AUTH_OAUTH2, state: 'browser-state' });
  assert.equal(consumed.orgId, ORG); assert.equal(consumed.userId, USER); assert.equal(consumed.verifier, 'pkce-verifier');
  await assert.rejects(() => consumeOAuthState({ prisma, authKind: X_AUTH_OAUTH2, state: 'browser-state' }), /invalid or expired|already been used/);
  if (previous === undefined) delete process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY; else process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = previous;
});

test('OAuth2 start creates an S256 official X authorization request', async () => {
  const previous = process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = ENV.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  const prisma = statePrisma();
  const env = {
    ...ENV, X_OAUTH2_CLIENT_ID: 'x-client', X_ADS_CALLBACK_BASE_URL: 'https://core.example.test',
  };
  const result = await startOAuth2({ prisma, orgId: ORG, userId: USER, env });
  const url = new URL(result.authorization_url);
  assert.equal(url.origin, 'https://x.com');
  assert.equal(url.searchParams.get('client_id'), 'x-client');
  assert.equal(url.searchParams.get('redirect_uri'), oauth2CallbackUrl(env));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /offline\.access/);
  assert.equal(prisma.rows[0].orgId, ORG); assert.equal(prisma.rows[0].userId, USER);
  if (previous === undefined) delete process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY; else process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = previous;
});

test('OAuth1 signer matches the RFC 5849 reference signature', () => {
  const client = oauth1Client({
    X_OAUTH1_CONSUMER_KEY: 'dpf43f3p2l4k3l03',
    X_OAUTH1_CONSUMER_SECRET: 'kd94hf93k423kf44',
  });
  client.getNonce = () => 'kllo9940pd9333jh';
  client.getTimeStamp = () => '1191242096';
  const signed = client.authorize({
    url: 'http://photos.example.net/photos?file=vacation.jpg&size=original', method: 'GET', data: {},
  }, { key: 'nnch734d00sl2jdk', secret: 'pfkkdhi9sl3r4s00' });
  assert.equal(signed.oauth_signature, 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
});

test('OAuth1 Ads authorization rejects a different X identity', async () => {
  const previousKey = process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  const previousFetch = global.fetch;
  process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = ENV.X_ADS_CREDENTIAL_ENCRYPTION_KEY;
  const prisma = statePrisma();
  prisma.xAdsCredential = {
    findUnique: async () => ({ status: 'active', xUserId: 'connected-user-42' }),
    upsert: async () => { throw new Error('mismatched identity must not be saved'); },
  };
  await createOAuthState({
    prisma, orgId: ORG, userId: USER, authKind: 'OAUTH1',
    requestToken: 'temporary-token', requestSecret: 'temporary-secret',
  });
  global.fetch = async () => new Response(new URLSearchParams({
    oauth_token: 'access-token', oauth_token_secret: 'access-secret',
    user_id: 'different-user-99', screen_name: 'wrong-account',
  }).toString(), { status: 200 });
  await assert.rejects(() => completeOAuth1({
    prisma, requestToken: 'temporary-token', verifier: 'verifier',
    env: { X_OAUTH1_CONSUMER_KEY: 'consumer', X_OAUTH1_CONSUMER_SECRET: 'secret' },
  }), (error) => error.code === 'x_identity_mismatch');
  global.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY; else process.env.X_ADS_CREDENTIAL_ENCRYPTION_KEY = previousKey;
});
