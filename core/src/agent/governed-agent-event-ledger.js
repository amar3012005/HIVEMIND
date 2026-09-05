import crypto from 'node:crypto';

const asText = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function governedEventId({ runId, sequence, type, causationId = null } = {}) {
  return `gae_${digest([runId, sequence, type, causationId || ''].join('\u0000')).slice(0, 48)}`;
}

export function governedEventKey({ runId, sequence, type, causationId = null } = {}) {
  return digest([runId, sequence, type, causationId || ''].join('\u0000')).slice(0, 160);
}

/**
 * Append-only persistence for graph transitions and external resume events.
 * A duplicate delivery returns the original event rather than creating a
 * second provider action.  The ledger is Core/Postgres truth; Cloudflare only
 * receives a sanitized projection of its envelope.
 */
export class GovernedAgentEventLedger {
  constructor({ prisma, logger = console } = {}) {
    this.prisma = prisma;
    this.logger = logger;
  }

  get available() {
    return Boolean(this.prisma?.governedAgentEvent);
  }

  async append({ orgId, userId, runId, sequence, type, causationId = null, payload = {}, occurredAt = new Date() } = {}) {
    const normalizedSequence = Math.max(1, Number(sequence) || 1);
    const id = governedEventId({ runId, sequence: normalizedSequence, type, causationId });
    const idempotencyKey = governedEventKey({ runId, sequence: normalizedSequence, type, causationId });
    const event = {
      id,
      orgId,
      userId,
      runId,
      sequence: normalizedSequence,
      type: asText(type, 80) || 'state_transition',
      causationId: causationId ? asText(causationId, 160) : null,
      idempotencyKey,
      payload: payload && typeof payload === 'object' ? payload : { value: asText(payload, 600) },
      occurredAt: occurredAt instanceof Date ? occurredAt : new Date(occurredAt),
    };
    if (!this.available) return { event, duplicate: false, persisted: false };
    try {
      const row = await this.prisma.governedAgentEvent.create({ data: event });
      return { event: row, duplicate: false, persisted: true };
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const existing = await this.prisma.governedAgentEvent.findFirst({ where: {
        orgId, idempotencyKey,
      } });
      return { event: existing || event, duplicate: true, persisted: Boolean(existing) };
    }
  }

  async receiveProviderEvent({ orgId, userId, runId, eventId, provider, eventType, payload = {}, occurredAt = new Date() } = {}) {
    if (!eventId) throw new Error('governed_provider_event_id_required');
    const idempotencyKey = `provider:${digest([orgId, provider, eventId].join('\u0000')).slice(0, 140)}`;
    const eventDigest = digest([orgId, provider, eventId].join('\u0000'));
    const event = {
      id: `provider_${eventDigest.slice(0, 48)}`,
      orgId,
      userId,
      runId,
      // Provider events can arrive independently of graph transition order.
      // A deterministic negative range cannot collide with positive graph
      // transition sequences and still gives the database a replay key.
      sequence: -Math.max(1, Number.parseInt(eventDigest.slice(0, 7), 16)),
      type: 'provider_event_received',
      causationId: asText(eventId, 160),
      idempotencyKey,
      payload: {
        provider: asText(provider, 80),
        event_type: asText(eventType, 120),
        // Deliberately structural only. Provider bodies remain in the provider
        // receipt store and are not duplicated in an orchestration ledger.
        payload_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 40) : [],
      },
      occurredAt: occurredAt instanceof Date ? occurredAt : new Date(occurredAt),
    };
    if (!this.available) return { event, duplicate: false, persisted: false };
    try {
      const row = await this.prisma.governedAgentEvent.create({ data: event });
      return { event: row, duplicate: false, persisted: true };
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const existing = await this.prisma.governedAgentEvent.findFirst({ where: { orgId, idempotencyKey } });
      return { event: existing || event, duplicate: true, persisted: Boolean(existing) };
    }
  }
}

export function safeEventEnvelope({ event, runId, state, sequence } = {}) {
  return {
    event_id: event?.id || null,
    run_id: runId || event?.runId || null,
    causation_id: event?.causationId || null,
    idempotency_key: event?.idempotencyKey || null,
    type: event?.type || 'state_transition',
    state: state || null,
    sequence: Number(sequence || event?.sequence || 0),
    occurred_at: event?.occurredAt instanceof Date ? event.occurredAt.toISOString() : (event?.occurredAt || new Date().toISOString()),
  };
}
