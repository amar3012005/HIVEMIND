import { NextResponse } from 'next/server';
import { loadConnection, saveConnection } from '../../../../lib/token-store';

const HIVE_BASE_URL = process.env.HIVEMIND_BASE_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.HIVEMIND_OAUTH_CLIENT_ID || 'hivemind-local-dev';

async function refreshIfNeeded(refreshToken: string) {
  const resp = await fetch(`${HIVE_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    })
  });
  if (!resp.ok) return null;
  return resp.json();
}

export async function GET() {
  const connection = loadConnection();
  if (!connection) {
    return NextResponse.json({ connected: false });
  }

  let statusResp = await fetch(`${HIVE_BASE_URL}/oauth/connection-status`, {
    headers: { Authorization: `Bearer ${connection.accessToken}` }
  });
  if (statusResp.status === 401 && connection.refreshToken) {
    const refreshed = await refreshIfNeeded(connection.refreshToken);
    if (refreshed?.access_token) {
      saveConnection({
        ...connection,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || connection.refreshToken,
        scope: refreshed.scope || connection.scope
      });
      statusResp = await fetch(`${HIVE_BASE_URL}/oauth/connection-status`, {
        headers: { Authorization: `Bearer ${refreshed.access_token}` }
      });
    }
  }

  if (!statusResp.ok) {
    return NextResponse.json({ connected: false, error: 'status_lookup_failed' }, { status: 401 });
  }
  const statusPayload = await statusResp.json();
  return NextResponse.json({ connected: true, ...statusPayload });
}
