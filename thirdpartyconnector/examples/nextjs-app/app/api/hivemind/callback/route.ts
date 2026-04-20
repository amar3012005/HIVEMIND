import { NextRequest, NextResponse } from 'next/server';
import { consumeTransientState } from '../../../../lib/transient-state';
import { saveConnection } from '../../../../lib/token-store';

const HIVE_BASE_URL = process.env.HIVEMIND_BASE_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.HIVEMIND_OAUTH_CLIENT_ID || 'hivemind-local-dev';
const REDIRECT_URI = process.env.HIVEMIND_OAUTH_REDIRECT_URI || 'http://localhost:3401/api/hivemind/callback';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const appBase = process.env.NEXT_PUBLIC_APP_BASE_URL || `${url.protocol}//${url.host}`;
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  if (error) {
    return NextResponse.redirect(new URL(`/connection?error=${encodeURIComponent(error)}`, appBase));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/connection?error=missing_code_or_state', appBase));
  }

  const transient = consumeTransientState(state);
  if (!transient) {
    return NextResponse.redirect(new URL('/connection?error=invalid_state', appBase));
  }

  const tokenResp = await fetch(`${HIVE_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: transient.codeVerifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID
    })
  });
  const tokenPayload = await tokenResp.json();
  if (!tokenResp.ok) {
    return NextResponse.redirect(new URL(`/connection?error=${encodeURIComponent(tokenPayload.error || 'token_exchange_failed')}`, appBase));
  }

  saveConnection({
    provider: 'hivemind',
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token,
    scope: tokenPayload.scope || '',
    workspaceId: tokenPayload?.claims?.workspace_id || null,
    connectedAt: new Date().toISOString()
  });

  return NextResponse.redirect(new URL('/connection', appBase));
}
