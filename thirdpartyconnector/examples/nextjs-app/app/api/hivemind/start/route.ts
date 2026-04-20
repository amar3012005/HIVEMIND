import { NextResponse } from 'next/server';
import { buildPkcePair, randomBase64Url } from '../../../../lib/pkce';
import { putTransientState } from '../../../../lib/transient-state';

const HIVE_BASE_URL = process.env.HIVEMIND_BASE_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.HIVEMIND_OAUTH_CLIENT_ID || 'hivemind-local-dev';
const REDIRECT_URI = process.env.HIVEMIND_OAUTH_REDIRECT_URI || 'http://localhost:3401/api/hivemind/callback';
const SCOPE = process.env.HIVEMIND_OAUTH_SCOPE || 'memory.read memory.write tools.invoke workspace.connect mcp.connect';
const RESOURCE = process.env.HIVEMIND_OAUTH_RESOURCE || HIVE_BASE_URL;

export async function POST() {
  const state = randomBase64Url(24);
  const { verifier, challenge } = buildPkcePair();
  putTransientState({ state, codeVerifier: verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE
  });

  return NextResponse.redirect(`${HIVE_BASE_URL}/oauth/authorize?${params.toString()}`);
}
