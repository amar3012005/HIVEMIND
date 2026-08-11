const apiBase = process.env.API_BASE || 'https://api.singulancelabs.com';
const roomId = process.env.ROOM_ID;
const token = process.env.SESSION_TOKEN;
const canaryRevision = process.env.CANARY_REVISION || 'v1';

if (!roomId || !token) throw new Error('ROOM_ID and SESSION_TOKEN are required');

const requestedCases = new Set((process.env.CANARY_CASES || 'direct,synthesis,decision').split(',').map((value) => value.trim()).filter(Boolean));
const cases = [
  {
    id: 'direct',
    request: 'Answer directly in two concise sentences: what is the practical difference between HIVEMIND and TARA for a regulated enterprise? Do not research, create a document, or propose external work.',
  },
  {
    id: 'synthesis',
    request: 'Using retained Singulance company evidence, create a concise buyer profile for a European financial-services CIO. Separate observed facts from assumptions, identify three compliance triggers, and give one recommended message. Do not create a Google Doc or perform an external write.',
  },
  {
    id: 'decision',
    request: 'Decide which first validation motion is stronger for Singulance: a small regulated-enterprise outreach test or an organic awareness test. Compare evidence, risk, measurement, and dependencies, then recommend one bounded next step. Do not send, publish, call, or create provider resources.',
  },
].filter((item) => requestedCases.has(item.id));

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

const results = [];
for (const item of cases) {
  const created = await jsonFetch(`/v1/hyper-rooms/${roomId}/turns`, {
    method: 'POST',
    body: JSON.stringify({
      user_message: item.request,
      idempotency_key: `codex-work-room-${item.id}-20260811-${canaryRevision}`,
    }),
  });
  const turnId = created.turn_id;
  if (!turnId) throw new Error(`${item.id}: no turn_id`);

  let record = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const payload = await jsonFetch(`/v1/hyper-rooms/${roomId}/turns/${turnId}`);
    record = payload.turn || payload;
    if (record.sealed_at || record.sealedAt || (record.status && record.status !== 'live')) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const lines = Array.isArray(record?.lines) ? record.lines : [];
  const finalReports = lines.filter((line) => line?.t === 'final_report');
  const seals = lines.filter((line) => line?.t === 'seal');
  const directorPlans = lines.filter((line) => line?.t === 'turn_plan');
  const roundStarts = lines.filter((line) => line?.t === 'round_start');
  const toolCalls = lines.filter((line) => line?.t === 'tool_call');
  const workOrders = lines.filter((line) => line?.t === 'work_order');
  const finalText = String(finalReports.at(-1)?.content || '').trim();

  if (record?.status === 'live') throw new Error(`${item.id}: turn did not seal`);
  if (seals.length !== 1) throw new Error(`${item.id}: expected one seal, got ${seals.length}`);
  if (roundStarts.length > 1) throw new Error(`${item.id}: whole Director run replayed ${roundStarts.length} times`);
  if (!finalText) throw new Error(`${item.id}: final response missing`);

  results.push({
    case: item.id,
    turn_id: turnId,
    status: record.status,
    final_chars: finalText.length,
    director_plans: directorPlans.length,
    outer_rounds: roundStarts.length,
    tool_calls: toolCalls.length,
    work_orders: workOrders.length,
    caveated: lines.some((line) => line?.t === 'completion_caveat'),
  });
}

console.log(JSON.stringify({ room_id: roomId, results }, null, 2));
