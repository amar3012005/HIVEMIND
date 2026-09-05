import { resumeGovernedProviderEvent } from './governed-agent-runtime.js';

const text = (value, limit) => String(value ?? '').trim().slice(0, limit);

/**
 * Shared adapter boundary for provider webhook handlers. It accepts only an
 * authenticated, already-authorized provider event reference; raw provider
 * data remains in that provider's canonical artifact/receipt store. Every
 * adapter can call this without becoming a second workflow engine.
 */
export async function ingestGovernedProviderEvent({
  prisma,
  orgId,
  userId,
  runId,
  provider,
  eventId,
  eventType,
  outcome = 'unknown',
  payload = {},
  onEvent,
  checkpointer = null,
} = {}) {
  if (!prisma || !orgId || !userId || !runId || !provider || !eventId) {
    throw new Error('governed_provider_event_scope_required');
  }
  return resumeGovernedProviderEvent({
    prisma,
    ctx: { orgId, userId, prisma },
    runId: text(runId, 80),
    provider: text(provider, 80),
    eventId: text(eventId, 160),
    eventType: text(eventType || 'provider_event', 120),
    outcome: ['succeeded', 'failed'].includes(String(outcome || '').toLowerCase())
      ? String(outcome).toLowerCase() : 'unknown',
    payload,
    onEvent,
    checkpointer,
  });
}
