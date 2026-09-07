function configuration() {
  const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

export async function hyperPlannerModeFor({ orgId, userId, fetchImpl = fetch, logger = console }) {
  const config = configuration();
  if (!config || !orgId || !userId) return 'off';
  try {
    const response = await fetchImpl(
      `${config.baseUrl}/hyper-planner-mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!response.ok) return 'off';
    return (await response.json())?.mode === 'glm_no_reasoning' ? 'glm_no_reasoning' : 'off';
  } catch (error) {
    logger.warn?.(`[hyper-planner] Flagship evaluation failed closed: ${error.message}`);
    return 'off';
  }
}

export async function governedRoomCanaryFor({ orgId, userId, email, fetchImpl = fetch, logger = console }) {
  const config = configuration();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!config || !orgId || !userId || !normalizedEmail) return false;
  try {
    const query = new URLSearchParams({ org_id: orgId, user_id: userId, email: normalizedEmail });
    const response = await fetchImpl(`${config.baseUrl}/governed-room-enabled?${query.toString()}`, {
      headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    return (await response.json())?.enabled === true;
  } catch (error) {
    logger.warn?.(`[governed-hyperagents] Flagship evaluation failed closed: ${error.message}`);
    return false;
  }
}
