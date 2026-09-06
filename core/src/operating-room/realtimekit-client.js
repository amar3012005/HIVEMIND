const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

function config(env = process.env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const appId = String(env.CLOUDFLARE_REALTIMEKIT_APP_ID || '').trim();
  const apiToken = String(env.CLOUDFLARE_REALTIMEKIT_API_TOKEN || '').trim();
  const hostPreset = String(env.CLOUDFLARE_REALTIMEKIT_HOST_PRESET || env.CLOUDFLARE_REALTIMEKIT_PRESET || 'group_call_host').trim();
  const memberPreset = String(env.CLOUDFLARE_REALTIMEKIT_MEMBER_PRESET || 'group_call_participant').trim();
  if (!accountId || !appId || !apiToken) {
    const error = new Error('Cloudflare RealtimeKit is not configured');
    error.code = 'realtimekit_not_configured';
    error.status = 503;
    throw error;
  }
  return { accountId, appId, apiToken, hostPreset, memberPreset, baseUrl: String(env.CLOUDFLARE_REALTIMEKIT_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '') };
}

async function request(path, { method = 'POST', body, env, fetchImpl = fetch } = {}) {
  const cfg = config(env);
  const response = await fetchImpl(`${cfg.baseUrl}/accounts/${encodeURIComponent(cfg.accountId)}/realtime/kit/${encodeURIComponent(cfg.appId)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `RealtimeKit request failed (${response.status})`);
    error.code = 'realtimekit_request_failed';
    error.status = response.status >= 500 ? 503 : 502;
    throw error;
  }
  return payload?.result || payload?.data || payload;
}

export async function createRealtimeMeeting({ title, env, fetchImpl } = {}) {
  return request('/meetings', { env, fetchImpl, body: { title } });
}

export async function addRealtimeParticipant({ meetingId, userId, name, isHost = false, env, fetchImpl } = {}) {
  const cfg = config(env);
  return request(`/meetings/${encodeURIComponent(meetingId)}/participants`, {
    env,
    fetchImpl,
    body: { name, preset_name: isHost ? cfg.hostPreset : cfg.memberPreset, custom_participant_id: userId },
  });
}

export async function refreshRealtimeParticipant({ meetingId, participantId, env, fetchImpl } = {}) {
  return request(`/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}/token`, {
    env,
    fetchImpl,
    body: {},
  });
}
