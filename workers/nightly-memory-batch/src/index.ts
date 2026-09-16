type Env = {
  NIGHT_BATCH_QUEUE: Queue;
  HIVEMIND_CORE_URL: string;
  NIGHT_BATCH_LIMIT?: string;
  NIGHT_BATCH_WORKFLOW_FLAG?: string;
  NIGHT_BATCH_SECRET: string;
};

type WorkItem = {
  org_id: string;
  trigger: 'scheduled';
  trigger_key: string;
  requested_at: string;
  pipeline_version?: number;
  lookback_hours?: number;
};

async function core(env: Env, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.NIGHT_BATCH_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || payload.message || `core_http_${response.status}`));
  return payload;
}

async function dispatch(env: Env) {
  const eligible = await core(env, '/internal/dream/eligible', {
    limit: Number(env.NIGHT_BATCH_LIMIT || 100),
    flag: env.NIGHT_BATCH_WORKFLOW_FLAG || 'night_memory_batch_v1',
  });
  const items = Array.isArray(eligible?.tenants) ? eligible.tenants : [];
  if (items.length) await env.NIGHT_BATCH_QUEUE.sendBatch(items.map((item: WorkItem) => ({ body: item })));
  return { dispatched: items.length, tenants: items.map((item: WorkItem) => item.org_id) };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const result = await dispatch(env);
      console.log(JSON.stringify({ event: 'night_memory_batch_dispatched', ...result }));
    })());
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/dispatch' || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
    const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!supplied || supplied !== env.NIGHT_BATCH_SECRET) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try { return Response.json({ ok: true, ...(await dispatch(env)) }, { status: 202 }); }
    catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 502 }); }
  },

  async queue(batch: MessageBatch<WorkItem>, env: Env) {
    for (const message of batch.messages) {
      try {
        const item = message.body;
        await core(env, '/internal/dream/admit', {
          ...item,
          workflow_instance_id: `night-batch:${item.org_id}:${item.trigger_key}`,
          lookback_hours: item.lookback_hours || 24,
          flags: { dream_entity_walk_v1: true, night_batch: true },
        });
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: 'night_memory_batch_failed', message_id: message.id, error: String(error) }));
        message.retry();
      }
    }
  },
};
