import assert from 'assert/strict';
import test from 'node:test';
import { spawn } from 'child_process';
import crypto from 'crypto';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function extractInputValue(html, name) {
  const regex = new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]*)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : '';
}

async function waitForServer(baseUrl) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return;
    } catch {
      // keep polling
    }
    await sleep(200);
  }
  throw new Error('Server did not become ready in time');
}

function startServer(port) {
  const clientConfig = JSON.stringify([
    {
      client_id: 'test-partner-client',
      client_name: 'Test Partner',
      redirect_uris: ['http://127.0.0.1:7788/callback'],
      allowed_scopes: ['memory.read', 'memory.write', 'tools.invoke', 'workspace.connect', 'mcp.connect'],
      is_public: true,
      status: 'active'
    }
  ]);

  const child = spawn('node', ['src/server.js'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      PORT: String(port),
      HIVEMIND_API_KEY_REQUIRED: 'false',
      HIVEMIND_OAUTH_BASE_URL: `http://127.0.0.1:${port}`,
      HIVEMIND_OAUTH_CLIENTS_JSON: clientConfig,
      HIVEMIND_ADMIN_SECRET: 'integration-admin-secret'
    }
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  return { child, getOutput: () => output };
}

test('OAuth authorization code + refresh + revoke flow works end-to-end', async () => {
  const port = 37901;
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, getOutput } = startServer(port);

  try {
    await waitForServer(baseUrl);
    const { verifier, challenge } = buildPkce();
    const state = 'integration-state-1';
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-partner-client',
      redirect_uri: 'http://127.0.0.1:7788/callback',
      scope: 'memory.read memory.write mcp.connect',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: baseUrl
    });

    const loginPageResp = await fetch(`${baseUrl}/oauth/authorize?${authorizeParams.toString()}`, { redirect: 'manual' });
    assert.equal(loginPageResp.status, 200);
    const loginHtml = await loginPageResp.text();
    assert.ok(loginHtml.includes('Sign in to HiveMind'));

    const loginResp = await fetch(`${baseUrl}/oauth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        admin_secret: 'integration-admin-secret',
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'memory.read memory.write mcp.connect',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: baseUrl
      })
    });
    assert.equal(loginResp.status, 302);
    const cookie = loginResp.headers.get('set-cookie');
    assert.ok(cookie);
    const authorizeRedirect = loginResp.headers.get('location');
    assert.ok(authorizeRedirect?.startsWith('/oauth/authorize?'));

    const consentResp = await fetch(`${baseUrl}${authorizeRedirect}`, {
      headers: { Cookie: cookie.split(';')[0] }
    });
    assert.equal(consentResp.status, 200);
    const consentHtml = await consentResp.text();
    const oauthStateId = extractInputValue(consentHtml, 'oauth_state_id');
    assert.ok(oauthStateId);

    const approveResp = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie.split(';')[0]
      },
      redirect: 'manual',
      body: new URLSearchParams({
        action: 'approve',
        oauth_state_id: oauthStateId,
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'memory.read memory.write mcp.connect',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: baseUrl
      })
    });
    assert.equal(approveResp.status, 302);
    const callbackLocation = approveResp.headers.get('location');
    assert.ok(callbackLocation?.startsWith('http://127.0.0.1:7788/callback'));
    const callbackUrl = new URL(callbackLocation);
    assert.equal(callbackUrl.searchParams.get('state'), state);
    const code = callbackUrl.searchParams.get('code');
    assert.ok(code);

    const tokenResp = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        code,
        code_verifier: verifier
      })
    });
    assert.equal(tokenResp.status, 200);
    const tokenPayload = await tokenResp.json();
    assert.ok(tokenPayload.access_token);
    assert.ok(tokenPayload.refresh_token);
    assert.equal(tokenPayload.claims.aud, baseUrl);

    const statusResp = await fetch(`${baseUrl}/oauth/connection-status`, {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
    });
    assert.equal(statusResp.status, 200);
    const statusPayload = await statusResp.json();
    assert.equal(statusPayload.connected, true);

    const refreshResp = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'test-partner-client',
        refresh_token: tokenPayload.refresh_token
      })
    });
    assert.equal(refreshResp.status, 200);
    const refreshPayload = await refreshResp.json();
    assert.ok(refreshPayload.access_token);
    assert.ok(refreshPayload.refresh_token);
    assert.notEqual(refreshPayload.refresh_token, tokenPayload.refresh_token);

    const revokeResp = await fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'test-partner-client',
        token: refreshPayload.refresh_token
      })
    });
    assert.equal(revokeResp.status, 200);
    const revokePayload = await revokeResp.json();
    assert.equal(revokePayload.revoked, true);
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
    const output = getOutput();
    if (/Error: listen EADDRINUSE/.test(output)) {
      throw new Error(`Port conflict while running test: ${output}`);
    }
  }
});

test('OAuth token endpoint rejects invalid PKCE verifier and invalid consent state', async () => {
  const port = 37902;
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child } = startServer(port);

  try {
    await waitForServer(baseUrl);
    const { challenge } = buildPkce();
    const state = 'integration-state-2';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-partner-client',
      redirect_uri: 'http://127.0.0.1:7788/callback',
      scope: 'memory.read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });

    const loginPageResp = await fetch(`${baseUrl}/oauth/authorize?${params.toString()}`);
    const html = await loginPageResp.text();
    assert.ok(html.includes('Sign in to HiveMind'));

    const loginResp = await fetch(`${baseUrl}/oauth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        admin_secret: 'integration-admin-secret',
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'memory.read',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
    });
    const cookie = loginResp.headers.get('set-cookie')?.split(';')[0] || '';
    const consentResp = await fetch(`${baseUrl}${loginResp.headers.get('location')}`, { headers: { Cookie: cookie } });
    const consentHtml = await consentResp.text();
    const oauthStateId = extractInputValue(consentHtml, 'oauth_state_id');
    assert.ok(oauthStateId);

    const badConsentResp = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie
      },
      body: new URLSearchParams({
        action: 'approve',
        oauth_state_id: 'bad-state-id',
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'memory.read',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
    });
    assert.equal(badConsentResp.status, 400);

    const approveResp = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie
      },
      redirect: 'manual',
      body: new URLSearchParams({
        action: 'approve',
        oauth_state_id: oauthStateId,
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'memory.read',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
    });
    const callback = new URL(approveResp.headers.get('location'));
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenResp = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'test-partner-client',
        redirect_uri: 'http://127.0.0.1:7788/callback',
        code,
        code_verifier: 'wrong-verifier'
      })
    });
    assert.equal(tokenResp.status, 400);
    const payload = await tokenResp.json();
    assert.equal(payload.error, 'invalid_grant');
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
});
