import { subscribeTurnStream } from '../realtime/hyper-turn-events.js';
import { persistHyperArtifactCandidate } from '../artifacts/hyper-artifacts.js';

export async function handleHyperTurnStreamRoute({
  req,
  res,
  prisma,
  roomId,
  turnId,
  orgId,
  jsonResponse,
} = {}) {
  const room = await prisma.hyperRoom.findFirst({
    where: { id: roomId, orgId },
  });
  if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);

  const lastEventId = req.headers['last-event-id']
    ? parseInt(req.headers['last-event-id'], 10) || 0
    : 0;

  let cursor = 0;
  let alive = true;
  const HEARTBEAT_MS = 15_000;
  let unsubscribe = null;

  const flush = (lines) => {
    for (let i = cursor; i < lines.length; i += 1) {
      const evt = lines[i];
      if (i < lastEventId) continue;
      res.write(`id: ${i}\n`);
      res.write(`event: ${evt.t || 'line'}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    cursor = lines.length;
  };

  const closeStream = () => {
    alive = false;
    clearInterval(heartbeat);
    try { unsubscribe?.(); } catch {}
    try { res.end(); } catch {}
  };

  const heartbeat = setInterval(() => {
    if (!alive) return;
    try { res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`); }
    catch { alive = false; }
  }, HEARTBEAT_MS);

  const fetchTurn = async () => prisma.hyperTurn.findFirst({
    where: { id: turnId, roomId },
    select: { lines: true, status: true, sealedAt: true },
  });

  const initialTurn = await fetchTurn();
  if (!initialTurn) {
    clearInterval(heartbeat);
    return jsonResponse(res, { error: 'Turn not found' }, 404);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  flush(Array.isArray(initialTurn.lines) ? initialTurn.lines : []);
  if (initialTurn.sealedAt || ['complete', 'failed', 'cost_capped'].includes(initialTurn.status)) {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
    return;
  }

  unsubscribe = subscribeTurnStream(turnId, {
    onEvent: (evt, index) => {
      if (!alive) return;
      const nextIndex = typeof index === 'number' ? index : cursor;
      if (nextIndex < cursor) return;
      try {
        res.write(`id: ${nextIndex}\n`);
        res.write(`event: ${evt?.t || 'line'}\n`);
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
        cursor = nextIndex + 1;
      } catch {
        alive = false;
      }
      if (evt?.t === 'seal' && alive) closeStream();
    },
    onSeal: () => { if (alive) closeStream(); },
    onError: (msg) => {
      if (!alive) return;
      try { res.write(`event: error\ndata: ${JSON.stringify({ message: msg.message || 'Turn stream error' })}\n\n`); } catch {}
    },
  }, {
    lastLineCount: cursor,
    fetchTurn,
  });

  req.on('close', () => { if (alive) closeStream(); });
}

export async function handleInternalHyperTurnEventRoute({
  req,
  res,
  prisma,
  jsonResponse,
  parseBody,
  hasInternalApiKey,
  appendTurnEvent,
  sealTurn,
} = {}) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  if (!hasInternalApiKey(apiKey)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
  const body = await parseBody(req).catch(() => null);
  if (!body?.turn_id || !body?.event) return jsonResponse(res, { error: 'turn_id and event are required' }, 400);

  if (body.execution_identity) {
    const identity = body.execution_identity;
    const turn = await prisma.hyperTurn.findUnique({
      where: { id: body.turn_id },
      select: { id: true, roomId: true, room: { select: { orgId: true, userId: true, roomMode: true } } },
    });
    const valid = identity.contract === 'work-room-execution.v1'
      && identity.execution_id === turn?.id
      && identity.turn_id === turn?.id
      && identity.room_id === turn?.roomId
      && identity.org_id === turn?.room?.orgId
      && identity.user_id === turn?.room?.userId
      && turn?.room?.roomMode === 'work';
    if (!valid) return jsonResponse(res, { error: 'work_room_execution_identity_mismatch' }, 409);
  }

  let artifact = null;
  if (body.event.t === 'artifact_candidate') {
    artifact = await persistHyperArtifactCandidate({
      prisma,
      turnId: body.turn_id,
      candidate: body.event.candidate,
    });
    if (!artifact.ok) {
      return {
        body,
        sealed: false,
        response: { ok: true, artifact: { ok: false, errors: artifact.errors || ['Artifact validation failed.'] } },
      };
    }
    body.event = artifact.event;
  }

  if (body.event.t === 'seal') {
    await sealTurn(prisma, body.turn_id, {
      status: body.event.status || 'complete',
      costTokens: body.event.cost_tokens || 0,
      event: body.event,
    });
  } else {
    await appendTurnEvent(prisma, body.turn_id, {
      ...body.event,
      received_ts: Date.now(),
    });
  }

  const artifactResponse = artifact
    ? Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'event'))
    : null;
  return {
    body,
    sealed: body.event.t === 'seal',
    response: artifactResponse ? { ok: true, artifact: artifactResponse } : { ok: true },
  };
}
