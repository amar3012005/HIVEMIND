/** Internal ingress for AgentScope events. Authentication remains at the route. */
export async function handleInternalWorkRunEventRoute({
  req, res, parseBody, jsonResponse, hasInternalApiKey, workRunId, applyRuntimeEvent, completeWorkRun, prisma,
} = {}) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  if (!hasInternalApiKey(key)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
  const body = await parseBody(req).catch(() => null);
  if (!body?.event) return jsonResponse(res, { error: 'event is required' }, 400);
  const applied = await applyRuntimeEvent(prisma, workRunId, body.event);
  let completion = null;
  if (body.complete) completion = await completeWorkRun(prisma, workRunId, {
    result: body.result || {}, error: body.error || null,
  });
  return jsonResponse(res, { ok: true, ...applied, ...(completion ? { completion } : {}) });
}
