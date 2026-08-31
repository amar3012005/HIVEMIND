interface AuthEmailMessage { outbox_id: string; environment: 'local' | 'production'; processing_version: number }
interface Queue<T> { send(message: T): Promise<void> }
interface QueueMessage<T> { body: T; ack(): void; retry(): void }
interface MessageBatch<T> { messages: QueueMessage<T>[] }
interface FlagshipBinding { getStringValue(key: string, fallback: string, context: Record<string, string>): Promise<string> }
interface Env { AUTH_EMAIL_QUEUE: Queue<AuthEmailMessage>; CONTROL_PLANE_URL: string; AUTH_EMAIL_QUEUE_SECRET: string; ENVIRONMENT: string; FLAGS: FlagshipBinding }

function authorized(request: Request, env: Env): boolean {
  const supplied = request.headers.get('x-auth-email-secret') || '';
  return Boolean(env.AUTH_EMAIL_QUEUE_SECRET && supplied === env.AUTH_EMAIL_QUEUE_SECRET);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, service: 'auth-email', environment: env.ENVIRONMENT });
    if (request.method === 'GET' && url.pathname === '/mode') {
      if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const mode = await env.FLAGS.getStringValue('email_identity_v1', 'off', { targetingKey: env.ENVIRONMENT, environment: env.ENVIRONMENT });
        return Response.json({ mode: ['off', 'shadow', 'primary', 'email_only'].includes(mode) ? mode : 'off' });
      } catch { return Response.json({ mode: 'off' }); }
    }
    if (request.method !== 'POST' || url.pathname !== '/enqueue') return new Response('Not found', { status: 404 });
    if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
    const body = await request.json() as AuthEmailMessage;
    if (!UUID.test(body.outbox_id) || body.environment !== env.ENVIRONMENT || body.processing_version !== 1) return new Response('Invalid message', { status: 400 });
    await env.AUTH_EMAIL_QUEUE.send({ outbox_id: body.outbox_id, environment: body.environment, processing_version: 1 });
    return Response.json({ ok: true }, { status: 202 });
  },

  async queue(batch: MessageBatch<AuthEmailMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      if (body.environment !== env.ENVIRONMENT || body.processing_version !== 1) { message.ack(); continue; }
      try {
        const response = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}/internal/auth-email/outbox/${body.outbox_id}/deliver`, {
          method: 'POST', headers: { 'x-auth-email-secret': env.AUTH_EMAIL_QUEUE_SECRET },
        });
        if (!response.ok) throw new Error(`delivery returned ${response.status}`);
        message.ack();
      } catch { message.retry(); }
    }
  },
};
