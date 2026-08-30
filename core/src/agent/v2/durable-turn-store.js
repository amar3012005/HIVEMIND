import crypto from 'node:crypto';

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

const EVENT_PHASES = Object.freeze({
  turn_accepted: 'accepted',
  scope_bound: 'authorized',
  intent_parsed: 'planned',
  plan_ready: 'planned',
  retrieval_planned: 'retrieving',
  query_optimized: 'retrieving',
  recall_window_revealed: 'recall_verified',
  coverage_assessed: 'recall_verified',
  tool_start: 'tools_running',
  tool_result: 'tools_running',
  orchestration_resumed: 'tools_running',
  orchestration_input_required: 'waiting_input',
  synthesis_start: 'synthesizing',
  answer_start: 'synthesizing',
  validation_complete: 'validating',
  finish: 'validating',
  done: 'completed',
  error: 'failed',
  cancelled: 'cancelled',
});

function json(value, fallback = {}) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function phaseForChatEvent(event = {}) {
  return EVENT_PHASES[String(event.type || '')] || null;
}

export function cloudflareEventMetadata({ turnId, event, phase, status }) {
  return {
    turn_id: turnId,
    sequence: Number(event?.sequence || 0),
    event_type: String(event?.type || 'progress').slice(0, 80),
    phase: String(phase || 'running').slice(0, 40),
    status: String(status || 'running').slice(0, 32),
    trace_id: event?.trace_id ? digest(event.trace_id).slice(0, 32) : null,
    occurred_at: new Date().toISOString(),
  };
}

export class DurableChatTurnStore {
  constructor({ prisma, notifier = null, logger = console } = {}) {
    this.prisma = prisma;
    this.notifier = notifier;
    this.logger = logger;
  }

  get available() {
    return !!(this.prisma?.durableChatTurn && this.prisma?.durableChatEvent && this.prisma?.durableChatCheckpoint);
  }

  async createOrReuse({ orgId, userId, threadId, idempotencyKey, mode, requestPayload, scopeSnapshot }) {
    if (!this.available) throw new Error('durable_chat_schema_unavailable');
    const key = String(idempotencyKey || crypto.randomUUID()).slice(0, 180);
    const prior = await this.prisma.durableChatTurn.findFirst({ where: { orgId, idempotencyKey: key } });
    if (prior) return { turn: prior, created: false };
    try {
      const turn = await this.prisma.durableChatTurn.create({
        data: {
          orgId, userId,
          threadDigest: threadId ? digest(threadId) : null,
          idempotencyKey: key,
          orchestrationMode: mode,
          requestPayload: json(requestPayload),
          scopeSnapshot: json(scopeSnapshot),
        },
      });
      // Cloudflare is an orchestration mirror, never the semantic authority.
      // Do not put its network latency on the admission path: Core/Postgres
      // remains able to accept and finish a turn during an edge outage.
      Promise.resolve(this.notifier?.open?.({
        turn_id: turn.id, mode, status: 'accepted', phase: 'accepted', occurred_at: new Date().toISOString(),
      })).catch((error) => this.logger?.warn?.(`[durable-chat] session open mirror degraded: ${error.message}`));
      return { turn, created: true };
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const turn = await this.prisma.durableChatTurn.findFirst({ where: { orgId, idempotencyKey: key } });
      if (!turn) throw error;
      return { turn, created: false };
    }
  }

  async appendEvent(turnId, event) {
    if (!this.available || !turnId) return null;
    const sequence = Math.max(1, Number(event?.sequence || 1));
    const eventType = String(event?.type || 'progress').slice(0, 80);
    const phase = phaseForChatEvent(event);
    const terminal = phase && TERMINAL_PHASES.has(phase);
    try {
      const saved = await this.prisma.$transaction(async (tx) => {
        const row = await tx.durableChatEvent.create({
          data: { turnId, sequence, eventType, event: json(event) },
        });
        if (phase) {
          const status = terminal ? phase : (phase === 'accepted' ? 'accepted' : 'running');
          await tx.durableChatCheckpoint.upsert({
            where: { turnId_phase: { turnId, phase } },
            create: {
              turnId, phase, status: terminal ? phase : 'complete',
              inputDigest: event?.trace_id ? digest(event.trace_id) : null,
              receipt: { sequence, event_type: eventType },
              completedAt: new Date(),
            },
            update: {
              status: terminal ? phase : 'complete',
              receipt: { sequence, event_type: eventType },
              completedAt: new Date(), updatedAt: new Date(),
            },
          });
          await tx.durableChatTurn.update({
            where: { id: turnId },
            data: {
              currentPhase: phase, status,
              updatedAt: new Date(),
              ...(terminal ? { completedAt: new Date() } : {}),
            },
          });
        }
        return row;
      });
      const status = terminal ? phase : 'running';
      // Persist locally before mirroring and deliberately do not await the
      // remote request. A slow/unavailable Worker must not serialize every
      // lifecycle event or delay the final answer.
      Promise.resolve(this.notifier?.event?.(cloudflareEventMetadata({ turnId, event, phase, status })))
        .catch((mirrorError) => this.logger?.warn?.(`[durable-chat] event mirror degraded turn=${turnId}: ${mirrorError.message}`));
      return saved;
    } catch (error) {
      if (error?.code === 'P2002') return null;
      throw error;
    }
  }

  async complete(turnId, responsePayload, sequence) {
    if (!this.available || !turnId) return;
    await this.prisma.durableChatTurn.update({
      where: { id: turnId },
      data: { status: 'completed', currentPhase: 'completed', responsePayload: json(responsePayload), completedAt: new Date(), updatedAt: new Date() },
    });
    Promise.resolve(this.notifier?.event?.(cloudflareEventMetadata({
      turnId,
      event: { type: 'turn_completed', sequence: Number(sequence) || 0 },
      phase: 'completed', status: 'completed',
    }))).catch((error) => this.logger?.warn?.(`[durable-chat] completion mirror degraded turn=${turnId}: ${error.message}`));
  }

  async fail(turnId, error, sequence) {
    if (!this.available || !turnId) return;
    const safeError = { code: String(error?.code || 'chat_orchestration_failed'), message: String(error?.message || error || 'unknown').slice(0, 1000) };
    await this.prisma.durableChatTurn.update({
      where: { id: turnId },
      data: { status: 'failed', currentPhase: 'failed', error: safeError, completedAt: new Date(), updatedAt: new Date() },
    });
    Promise.resolve(this.notifier?.event?.(cloudflareEventMetadata({
      turnId,
      event: { type: 'turn_failed', sequence: Number(sequence) || 0 },
      phase: 'failed', status: 'failed',
    }))).catch((mirrorError) => this.logger?.warn?.(`[durable-chat] failure mirror degraded turn=${turnId}: ${mirrorError.message}`));
  }

  async readAuthorized({ turnId, orgId, userId, after = 0, limit = 200 }) {
    if (!this.available) throw new Error('durable_chat_schema_unavailable');
    const turn = await this.prisma.durableChatTurn.findFirst({ where: { id: turnId, orgId, userId } });
    if (!turn) return null;
    const events = await this.prisma.durableChatEvent.findMany({
      where: { turnId, sequence: { gt: Math.max(0, Number(after) || 0) } },
      orderBy: { sequence: 'asc' }, take: Math.max(1, Math.min(500, Number(limit) || 200)),
    });
    return {
      turn: {
        id: turn.id, status: turn.status, phase: turn.currentPhase,
        mode: turn.orchestrationMode, created_at: turn.createdAt,
        updated_at: turn.updatedAt, completed_at: turn.completedAt,
      },
      events: events.map((row) => row.event),
      next_sequence: events.length ? events.at(-1).sequence : Math.max(0, Number(after) || 0),
    };
  }
}

export function createDurableEventSink({ store, turnId, startSequence = 0, emit = null } = {}) {
  let sequence = Number(startSequence) || 0;
  let chain = Promise.resolve();
  let failure = null;
  return {
    push(event = {}) {
      const normalized = { ...event, sequence: Number(event.sequence) > sequence ? Number(event.sequence) : ++sequence };
      sequence = normalized.sequence;
      emit?.(normalized);
      chain = chain.then(() => store.appendEvent(turnId, normalized)).catch((error) => {
        failure = error;
        store.logger?.warn?.(`[durable-chat] event persistence degraded turn=${turnId}: ${error.message}`);
      });
      return normalized;
    },
    async flush() { await chain; return { sequence, failure }; },
    get sequence() { return sequence; },
  };
}
