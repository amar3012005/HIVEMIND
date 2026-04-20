import { NextResponse } from 'next/server';
import { clearConnection, loadConnection } from '../../../../lib/token-store';

const HIVE_BASE_URL = process.env.HIVEMIND_BASE_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.HIVEMIND_OAUTH_CLIENT_ID || 'hivemind-local-dev';

export async function POST() {
  const connection = loadConnection();
  if (connection?.refreshToken) {
    await fetch(`${HIVE_BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: connection.refreshToken,
        client_id: CLIENT_ID
      })
    }).catch(() => {});
  } else if (connection?.accessToken) {
    await fetch(`${HIVE_BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: connection.accessToken,
        client_id: CLIENT_ID
      })
    }).catch(() => {});
  }

  clearConnection();
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL || 'http://localhost:3401';
  return NextResponse.redirect(new URL('/connection', appBaseUrl), 302);
}
