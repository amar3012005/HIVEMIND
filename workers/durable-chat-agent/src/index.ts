import { Agent, getAgentByName } from 'agents';
import { CHAT_MODES, isTerminalMetadata, type ChatMode, type SessionMetadata, validateMetadata } from './contract';
export { ChatTurnWorkflow } from './workflow';

export interface Env extends Cloudflare.Env {
  CHAT_SESSION: DurableObjectNamespace<HivemindChatSession>;
  FLAGS: Flagship;
  ENVIRONMENT: 'development' | 'local' | 'production';
  DURABLE_CHAT_FLAG: 'durable_chat_agent_v1';
  DURABLE_CHAT_AGENT_ENABLED: 'true' | 'false';
  DURABLE_CHAT_AGENT_SECRET: string;
  CHAT_TURN_WORKFLOW: Workflow;
}

type MetadataRow = {
  event_id: string | null;
  run_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  sequence: number;
  event_type: string;
  phase: string;
  status: string;
  trace_id: string | null;
  state: string | null;
  occurred_at: string;
};

export class HivemindChatSession extends Agent<Env> {
  onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS session_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      turn_id TEXT NOT NULL, mode TEXT NOT NULL, phase TEXT NOT NULL,
      status TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS lifecycle_events (
      sequence INTEGER PRIMARY KEY, event_type TEXT NOT NULL, phase TEXT NOT NULL,
      status TEXT NOT NULL, trace_id TEXT, occurred_at TEXT NOT NULL,
      event_id TEXT, run_id TEXT, causation_id TEXT, idempotency_key TEXT, state TEXT
    )`;
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(lifecycle_events)`.map(row => row.name));
    if (!columns.has('event_id')) this.sql`ALTER TABLE lifecycle_events ADD COLUMN event_id TEXT`;
    if (!columns.has('run_id')) this.sql`ALTER TABLE lifecycle_events ADD COLUMN run_id TEXT`;
    if (!columns.has('causation_id')) this.sql`ALTER TABLE lifecycle_events ADD COLUMN causation_id TEXT`;
    if (!columns.has('idempotency_key')) this.sql`ALTER TABLE lifecycle_events ADD COLUMN idempotency_key TEXT`;
    if (!columns.has('state')) this.sql`ALTER TABLE lifecycle_events ADD COLUMN state TEXT`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_events_event_id_unique ON lifecycle_events(event_id) WHERE event_id IS NOT NULL`;
  }

  open(input: SessionMetadata): { ok: true; turn_id: string } {
    const metadata = validateMetadata(input);
    this.sql`INSERT INTO session_state (singleton, turn_id, mode, phase, status, last_sequence, opened_at, updated_at)
      VALUES (1, ${metadata.turn_id}, ${metadata.mode || 'session'}, ${metadata.phase}, ${metadata.status}, 0, ${metadata.occurred_at}, ${metadata.occurred_at})
      ON CONFLICT(singleton) DO UPDATE SET phase=excluded.phase, status=excluded.status, updated_at=excluded.updated_at`;
    return { ok: true, turn_id: metadata.turn_id };
  }

  record(input: SessionMetadata): { ok: true; sequence: number; duplicate: boolean } {
    const metadata = validateMetadata(input);
    const sequence = Number(metadata.sequence || 0);
    const exists = metadata.event_id
      ? this.sql<{ sequence: number }>`SELECT sequence FROM lifecycle_events WHERE sequence=${sequence} OR event_id=${metadata.event_id}`[0]
      : this.sql<{ sequence: number }>`SELECT sequence FROM lifecycle_events WHERE sequence=${sequence}`[0];
    if (exists) return { ok: true, sequence, duplicate: true };
    this.sql`INSERT INTO lifecycle_events (sequence, event_type, phase, status, trace_id, occurred_at, event_id, run_id, causation_id, idempotency_key, state)
      VALUES (${sequence}, ${metadata.event_type || 'progress'}, ${metadata.phase}, ${metadata.status}, ${metadata.trace_id || null}, ${metadata.occurred_at}, ${metadata.event_id || null}, ${metadata.run_id || null}, ${metadata.causation_id || null}, ${metadata.idempotency_key || null}, ${metadata.state || null})`;
    this.sql`UPDATE session_state SET phase=${metadata.phase}, status=${metadata.status}, last_sequence=${sequence}, updated_at=${metadata.occurred_at}
      WHERE singleton=1 AND last_sequence <= ${sequence}`;
    return { ok: true, sequence, duplicate: false };
  }

  status(): { state: Record<string, unknown> | null; events: MetadataRow[] } {
    const state = this.sql<Record<string, unknown>>`SELECT * FROM session_state WHERE singleton=1`[0] || null;
    const events = this.sql<MetadataRow>`SELECT sequence, event_type, phase, status, trace_id, occurred_at, event_id, run_id, causation_id, idempotency_key, state FROM lifecycle_events ORDER BY sequence DESC LIMIT 100`;
    return { state, events };
  }
}

function authorized(request: Request, env: Env): boolean {
  const expected = `Bearer ${env.DURABLE_CHAT_AGENT_SECRET || ''}`;
  const actual = request.headers.get('authorization') || '';
  if (!env.DURABLE_CHAT_AGENT_SECRET || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i += 1) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function evaluateMode(env: Env, url: URL): Promise<ChatMode> {
  const orgId = url.searchParams.get('org_id') || '';
  const userId = url.searchParams.get('user_id') || '';
  if (env.DURABLE_CHAT_AGENT_ENABLED !== 'true' || !orgId || !userId) return 'off';
  try {
    const details = await env.FLAGS.getStringDetails(env.DURABLE_CHAT_FLAG || 'durable_chat_agent_v1', 'off', {
      targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT,
    });
    return CHAT_MODES.includes(details.value as ChatMode) ? details.value as ChatMode : 'off';
  } catch { return 'off'; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'hivemind-durable-chat-agent', content_storage: false });
    if (!authorized(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/mode' && request.method === 'GET') return Response.json({ mode: await evaluateMode(env, url) });
    if ((url.pathname === '/sessions/open' || url.pathname === '/sessions/event') && request.method === 'POST') {
      try {
        const metadata = validateMetadata(await request.json());
        const session = await getAgentByName<Env, HivemindChatSession>(env.CHAT_SESSION, metadata.turn_id);
        if (url.pathname.endsWith('/open')) {
          const opened = await session.open(metadata);
          let workflow_instance_id: string | null = null;
          if (metadata.mode === 'workflow' || metadata.mode === 'full') {
            workflow_instance_id = `chat-${metadata.turn_id}`;
            await env.CHAT_TURN_WORKFLOW.create({
              id: workflow_instance_id,
              params: { turn_id: metadata.turn_id, mode: metadata.mode },
            }).catch(() => null);
          }
          return Response.json({ ...opened, workflow_instance_id });
        }
        const recorded = await session.record(metadata);
        if (isTerminalMetadata(metadata)) {
          const workflow = await env.CHAT_TURN_WORKFLOW.get(`chat-${metadata.turn_id}`);
          await workflow.sendEvent({ type: 'chat-terminal', payload: metadata }).catch(() => null);
        }
        return Response.json(recorded);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'invalid_metadata' }, { status: 400 });
      }
    }
    if (url.pathname === '/sessions/status' && request.method === 'GET') {
      const turnId = url.searchParams.get('turn_id') || '';
      try {
        validateMetadata({ turn_id: turnId, phase: 'read', status: 'read', occurred_at: new Date().toISOString() });
        return Response.json(await (await getAgentByName<Env, HivemindChatSession>(env.CHAT_SESSION, turnId)).status());
      } catch { return Response.json({ error: 'invalid_turn_id' }, { status: 400 }); }
    }
    if (url.pathname === '/workflows/status' && request.method === 'GET') {
      const turnId = url.searchParams.get('turn_id') || '';
      try {
        validateMetadata({ turn_id: turnId, phase: 'read', status: 'read', occurred_at: new Date().toISOString() });
        return Response.json(await (await env.CHAT_TURN_WORKFLOW.get(`chat-${turnId}`)).status());
      } catch { return Response.json({ error: 'invalid_turn_id' }, { status: 400 }); }
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
