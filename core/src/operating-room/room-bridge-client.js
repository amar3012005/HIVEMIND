function bridgeConfig(env = process.env) {
  const token = String(env.PLAYWRIGHT_SERVICE_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('Operating Room bridge is not configured'), { code: 'operating_room_bridge_not_configured', status: 503 });
  return {
    token,
    baseUrl: String(env.OPERATING_ROOM_BRIDGE_URL || 'http://hm-playwright:8932/v1/room-bridges').replace(/\/$/, ''),
  };
}

async function request(path, { method = 'POST', body, env, fetchImpl = fetch } = {}) {
  const cfg = bridgeConfig(env);
  const response = await fetchImpl(`${cfg.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `Operating Room bridge failed (${response.status})`), { code: 'operating_room_bridge_failed', status: 503 });
  return payload;
}

export function startOperatingRoomBridge({ roomId, meetingId, authToken, participantId, env, fetchImpl } = {}) {
  return request(`/${encodeURIComponent(roomId)}`, {
    env, fetchImpl,
    body: { room_id: roomId, meeting_id: meetingId, auth_token: authToken, participant_id: participantId },
  });
}

export function closeOperatingRoomBridge({ roomId, env, fetchImpl } = {}) {
  return request(`/${encodeURIComponent(roomId)}`, { method: 'DELETE', body: { room_id: roomId }, env, fetchImpl });
}

export function getOperatingRoomBridge({ roomId, env, fetchImpl } = {}) {
  return request(`/${encodeURIComponent(roomId)}`, { method: 'GET', env, fetchImpl });
}
