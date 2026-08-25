import crypto from 'node:crypto';
import { fetchBearerFromNango, isPermanentNangoCredentialError } from '../../mcp/nango-service.js';
import { scheduleHqWake } from '../../../hq-runtime/repository.js';
import { registerWatch, needsRenewal } from './gmail-watch.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PROVIDERS = ['gmail', 'google-mail'];

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function gmailFetch(path, token) {
  const response = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = new Error(`gmail_watcher_api_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function headersOf(message) {
  return Object.fromEntries((message?.payload?.headers || []).map((header) => [String(header.name).toLowerCase(), header.value]));
}

function address(value = '') {
  const match = String(value).match(/<([^>]+)>/) || String(value).match(/[\w.+-]+@[\w.-]+/);
  return String(match?.[1] || match?.[0] || '').trim().toLowerCase();
}

function isInbound(message, accountEmail) {
  const labels = new Set(message?.labelIds || []);
  return !labels.has('SENT') && !labels.has('DRAFT') && address(headersOf(message).from) !== String(accountEmail || '').toLowerCase();
}

async function patchConnectionMetadata(prisma, connection, watcher) {
  return prisma.nangoConnection.update({
    where: { id: connection.id },
    data: { metadata: { ...(connection.metadata || {}), gmail_watcher: watcher } },
  });
}

async function persistReplyEvent({ prisma, connection, message, outbound }) {
  const headers = headersOf(message);
  const sender = address(headers.from);
  const subject = String(headers.subject || '');
  const eventType = /mailer-daemon|postmaster/i.test(sender) || /undeliver|delivery status|failure notice|mail delivery/i.test(subject)
    ? 'delivery.bounced'
    : /unsubscribe|remove me|stop emailing/i.test(subject)
      ? 'recipient.unsubscribed'
      : 'response.received';
  const providerEventId = `gmail:${message.id}`;
  const payload = {
    provider_event_id: providerEventId,
    thread_id: message.threadId,
    message_id: message.id,
    outbound_action_id: outbound?.id || null,
    lead_memory_id: outbound?.leadMemoryId || null,
    workflow_execution_id: outbound?.meta?.execution_id || outbound?.meta?.workflow_id || null,
    workflow_prospect_id: outbound?.meta?.prospect_id || null,
    workflow_touch: Number(outbound?.meta?.touch || 1),
    runtime_playbook_run_id: outbound?.meta?.runtime_playbook_run_id || null,
    runtime_playbook_stage_id: outbound?.meta?.runtime_playbook_stage_id || null,
    runtime_correlation_ref: outbound?.meta?.correlation_ref || message.threadId || null,
    match_type: outbound?.matchType || 'thread',
    event_type: eventType,
    sender,
    subject: subject.slice(0, 500),
    received_at: headers.date || null,
  };
  const checksum = hash(payload);
  let artifact = await prisma.sourceArtifact.findFirst({
    where: { userId: connection.userId, orgId: connection.orgId, sourcePlatform: 'gmail_watcher', sourceId: providerEventId },
  });
  if (!artifact) {
    artifact = await prisma.sourceArtifact.create({
      data: {
        userId: connection.userId,
        orgId: connection.orgId,
        artifactType: 'webhook',
        sourcePlatform: 'gmail_watcher',
        sourceId: providerEventId,
        contentType: 'application/json',
        checksum,
        storageLocation: 'inline:gmail-watcher',
        payload,
        metadata: {
          event_type: outbound?.matchType === 'sender_fallback' ? 'possible_email_reply' : 'email_reply',
          provider: 'gmail',
          outbound_action_id: outbound?.id || null,
          lead_memory_id: outbound?.leadMemoryId || null,
          match_type: outbound?.matchType || 'thread',
          autonomous: outbound?.matchType !== 'sender_fallback',
        },
      },
    }).catch(async (error) => {
      if (String(error.code || '') !== 'P2002') throw error;
      return prisma.sourceArtifact.findFirst({ where: { userId: connection.userId, orgId: connection.orgId, checksum, sourcePlatform: 'gmail_watcher' } });
    });
  }
  return { artifact, payload };
}

export function runtimePlaybookReplyWake({ runtime, payload, artifact }) {
  if (!payload?.runtime_playbook_run_id) return null;
  return {
    runtimeId: runtime.id,
    orgId: runtime.orgId,
    runtimeEpoch: runtime.epoch,
    idempotencyKey: `runtime-playbook-event:${payload.runtime_playbook_run_id}:${payload.provider_event_id}`,
    triggerType: 'runtime_playbook_event',
    dueAt: new Date(),
    payload: {
      run_id: payload.runtime_playbook_run_id,
      event: {
        id: payload.provider_event_id,
        type: payload.event_type || 'response.received',
        data: {
          correlation_ref: payload.runtime_correlation_ref || payload.thread_id,
          artifact_id: artifact.id,
          message_id: payload.message_id,
          thread_id: payload.thread_id,
          sender: payload.sender,
        },
      },
    },
  };
}

async function wakeHqForReply({ prisma, connection, artifact, payload }) {
  const runtime = await prisma.hqRuntime.findFirst({ where: { orgId: connection.orgId } });
  if (!runtime || ['INACTIVE', 'PAUSED'].includes(runtime.state)) return { woke: false, reason: 'runtime_not_active' };
  if (payload.runtime_playbook_run_id) {
    await scheduleHqWake({ prisma, ...runtimePlaybookReplyWake({ runtime, payload, artifact }) });
    return { woke: true, runtimePlaybook: true, runId: payload.runtime_playbook_run_id };
  }
  if (payload.workflow_execution_id && payload.workflow_prospect_id) {
    await scheduleHqWake({
      prisma,
      runtimeId: runtime.id,
      orgId: connection.orgId,
      runtimeEpoch: runtime.epoch,
      idempotencyKey: `email-lifecycle-reply:${payload.provider_event_id}`,
      triggerType: 'email_lifecycle_event',
      dueAt: new Date(),
      payload: {
        execution_id: payload.workflow_execution_id,
        artifact_id: artifact.id,
        event: {
          id: payload.provider_event_id,
          type: 'positive_reply',
          prospectId: payload.workflow_prospect_id,
          touch: payload.workflow_touch || 1,
          providerArtifactId: artifact.id,
          providerMessageId: payload.message_id,
          providerThreadId: payload.thread_id,
        },
      },
    });
    return { woke: true, lifecycle: true, executionId: payload.workflow_execution_id };
  }
  const existing = await prisma.hqTodo.findFirst({
    where: { runtimeId: runtime.id, context: { path: ['gmail_provider_event_id'], equals: payload.provider_event_id } },
  });
  const todo = existing || await prisma.hqTodo.create({
    data: {
      runtimeId: runtime.id,
      orgId: connection.orgId,
      title: `Review reply from ${payload.sender || 'a prospect'}`,
      objective: 'Read the verified reply to a tracked outbound email, determine the next appropriate governed outreach action, and preserve the outcome in the shared lead and outreach records.',
      kind: 'outreach',
      status: 'READY',
      priority: 1,
      position: 0,
      requiredCapabilities: ['gmail'],
      context: {
        room_tag: 'outreach',
        gmail_provider_event_id: payload.provider_event_id,
        gmail_artifact_id: artifact.id,
        outbound_action_id: payload.outbound_action_id,
        lead_memory_id: payload.lead_memory_id,
        thread_id: payload.thread_id,
        sender: payload.sender,
        authority_mode: 'PREPARE',
        acceptance_criteria: ['Read the matching Gmail thread.', 'Persist the reply outcome and next step.', 'Prepare, but do not send, any proposed response without approval.'],
      },
    },
  });
  await scheduleHqWake({
    prisma,
    runtimeId: runtime.id,
    orgId: connection.orgId,
    runtimeEpoch: runtime.epoch,
    idempotencyKey: `email-reply:${artifact.id}`,
    triggerType: 'email_reply',
    dueAt: new Date(),
    payload: { todo_id: todo.id, artifact_id: artifact.id, provider_event_id: payload.provider_event_id },
  });
  return { woke: true, todoId: todo.id };
}

function leadEmailFromMemory(content) {
  const match = String(content || '').match(/(?:^|\n)EMAIL:\s*([^\s]+@[^\s]+)/i);
  return address(match?.[1] || '');
}

async function findLeadByEmail(prisma, connection, email) {
  if (!email) return null;
  const rows = await prisma.memory.findMany({
    where: {
      orgId: connection.orgId,
      deletedAt: null,
      isLatest: true,
      OR: [
        { tags: { has: 'prospect' } },
        { sourcePlatform: 'hyperagents-prospect' },
      ],
    },
    select: { id: true, title: true, content: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  return rows.find((row) => leadEmailFromMemory(row.content) === email) || null;
}

function hqRuntimeOutboundWhere() {
  // Runtime ownership is explicit. A Room-approved or manually sent email is
  // still visible on the lead, but it must never wake HQ as an autonomous reply.
  return `(
    meta->>'origin' = 'hq_runtime'
    OR meta->>'via' IN ('hq-runtime', 'hq_runtime', 'hq-email-lifecycle')
    OR meta ? 'hq_runtime_id'
  )`;
}

async function findRuntimeOutboundByThread(prisma, orgId, threadId, sender) {
  if (!threadId || !sender) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, recipient, meta
       FROM "hivemind"."outbound_actions"
      WHERE org_id = $1::uuid
        AND channel = 'email'
        AND status = 'sent'
        AND thread_id = $2
        AND lower(COALESCE(recipient, '')) = $3
        AND ${hqRuntimeOutboundWhere()}
      ORDER BY sent_at DESC LIMIT 1`,
    orgId, String(threadId), sender,
  );
  return rows[0] || null;
}

async function findRuntimeOutboundByRecipient(prisma, orgId, sender) {
  if (!sender) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, recipient, meta
       FROM "hivemind"."outbound_actions"
      WHERE org_id = $1::uuid
        AND channel = 'email'
        AND status = 'sent'
        AND lower(COALESCE(recipient, '')) = $2
        AND ${hqRuntimeOutboundWhere()}
      ORDER BY sent_at DESC LIMIT 1`,
    orgId, sender,
  );
  return rows[0] || null;
}

export async function reconcileGmailWatch({ prisma, connection, reason = 'manual', register = false }) {
  const token = await fetchBearerFromNango(connection.providerKey, connection.connectionId);
  const profile = await gmailFetch('/profile', token);
  const current = connection.metadata?.gmail_watcher || {};
  const accountEmail = String(profile.emailAddress || current.email || '').toLowerCase();
  let watch = current.watch || null;
  const topicName = String(process.env.GCP_PUBSUB_TOPIC || '').trim();
  if (register && !topicName) throw new Error('gmail_watcher_pubsub_not_configured');
  if (topicName && (register || needsRenewal(watch))) {
    watch = await registerWatch({ accessToken: token, topicName });
  }
  const cursor = String(current.history_id || '').trim();
  if (!cursor) {
    await patchConnectionMetadata(prisma, connection, { ...current, email: accountEmail, history_id: String(profile.historyId || watch?.historyId || ''), watch, last_reconciled_at: new Date().toISOString() });
    return { mode: 'initialized', account_email: accountEmail, reason, replies: 0, possible_replies: 0, history_id: String(profile.historyId || '') };
  }
  const history = await gmailFetch(`/history?${new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded', maxResults: '500' })}`, token).catch(async (error) => {
    if (error.status !== 404) throw error;
    return { history: [], historyId: profile.historyId, resynchronized: true };
  });
  const messages = [];
  for (const row of history.history || []) for (const added of row.messagesAdded || []) if (added.message?.id) messages.push(added.message.id);
  let replies = 0;
  let possibleReplies = 0;
  for (const messageId of [...new Set(messages)]) {
    const message = await gmailFetch(`/messages/${encodeURIComponent(messageId)}?format=full`, token);
    if (!isInbound(message, accountEmail)) continue;
    const sender = address(headersOf(message).from);
    const lead = await findLeadByEmail(prisma, connection, sender);
    const exact = await findRuntimeOutboundByThread(prisma, connection.orgId, message.threadId, sender);
    if (!exact) {
      // Gmail occasionally starts a new thread for a reply. Preserve a lead-linked
      // signal when the sender is known and HQ sent that address, but never wake
      // the runtime or alter the send outcome without a thread-level match.
      const fallback = lead && await findRuntimeOutboundByRecipient(prisma, connection.orgId, sender);
      if (!fallback) continue;
      const { artifact } = await persistReplyEvent({
        prisma, connection, message,
        outbound: { ...fallback, leadMemoryId: lead.id, matchType: 'sender_fallback' },
      });
      if (artifact) possibleReplies += 1;
      continue;
    }
    const outbound = { ...exact, leadMemoryId: lead?.id || null, matchType: 'thread' };
    const { artifact, payload } = await persistReplyEvent({ prisma, connection, message, outbound });
    await prisma.$executeRawUnsafe(
      `UPDATE "hivemind"."outbound_actions" SET outcome = 'replied', outcome_at = now()
        WHERE id = $1::uuid AND outcome IS NULL`, outbound.id,
    );
    await wakeHqForReply({ prisma, connection, artifact, payload });
    replies += 1;
  }
  await patchConnectionMetadata(prisma, connection, {
    ...current, email: accountEmail, history_id: String(history.historyId || profile.historyId || cursor), watch,
    last_reconciled_at: new Date().toISOString(), last_reason: reason,
  });
  return { mode: history.resynchronized ? 'resynchronized' : 'reconciled', account_email: accountEmail, reason, messages: messages.length, replies, possible_replies: possibleReplies, history_id: String(history.historyId || profile.historyId || cursor) };
}

export async function reconcileGmailWatchForTenant({ prisma, userId, orgId, ...options }) {
  const connection = await prisma.nangoConnection.findFirst({ where: { userId, orgId, providerKey: { in: PROVIDERS }, status: 'active' }, orderBy: { updatedAt: 'desc' } });
  if (!connection) throw new Error('gmail_watcher_connection_not_found');
  return reconcileGmailWatch({ prisma, connection, ...options });
}

export async function handleGmailPushNotification({ prisma, emailAddress, historyId, reason = 'push' }) {
  const rows = await prisma.nangoConnection.findMany({ where: { providerKey: { in: PROVIDERS }, status: 'active' } });
  const connection = rows.find((row) => String(row.metadata?.gmail_watcher?.email || '').toLowerCase() === String(emailAddress || '').toLowerCase());
  if (!connection) return { acknowledged: true, handled: false, reason: 'connection_not_found' };
  return { acknowledged: true, handled: true, history_id: historyId, result: await reconcileGmailWatch({ prisma, connection, reason }) };
}

export async function reconcileAllGmailWatches({ prisma, logger = console, reconcile = reconcileGmailWatch }) {
  const rows = await prisma.nangoConnection.findMany({ where: { providerKey: { in: PROVIDERS }, status: 'active' } });
  const results = await Promise.allSettled(rows.map((connection) => reconcile({ prisma, connection, reason: 'scheduled' })));
  let failed = 0;
  let disabled = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== 'rejected') continue;
    const connection = rows[index];
    if (isPermanentNangoCredentialError(result.reason)) {
      const updated = await prisma.nangoConnection.updateMany({
        where: { id: connection.id, status: 'active' },
        data: {
          status: 'error',
          metadata: {
            ...(connection.metadata || {}),
            gmail_watcher: {
              ...(connection.metadata?.gmail_watcher || {}),
              disabled_at: new Date().toISOString(),
              disabled_reason: 'credentials_invalid_reconnect_required',
            },
          },
        },
      });
      if (updated.count) disabled += 1;
      logger.warn?.(`[gmail-watcher] disabled stale connection ${connection.id}; reconnect required`);
      continue;
    }
    failed += 1;
    logger.warn?.(`[gmail-watcher] reconciliation failed connection=${connection.id} org=${connection.orgId}:`, result.reason?.message || result.reason);
  }
  return { checked: rows.length, reconciled: results.length - failed - disabled, failed, disabled };
}

export function startGmailWatcherScheduler({ prisma, logger = console, intervalMs = Number(process.env.GMAIL_WATCHER_INTERVAL_MS || 3600000) } = {}) {
  if (!prisma || process.env.GMAIL_WATCHER_ENABLED === 'false') return { enabled: false };
  const every = Math.max(300000, intervalMs);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileAllGmailWatches({ prisma, logger }); } finally { running = false; }
  };
  const timer = setInterval(() => tick().catch((error) => logger.warn?.('[gmail-watcher] tick failed:', error.message)), every);
  timer.unref?.();
  setTimeout(() => tick().catch((error) => logger.warn?.('[gmail-watcher] initial tick failed:', error.message)), 30000).unref?.();
  if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
    logger.log?.(`[gmail-watcher] scheduler active every ${Math.round(every / 60000)}min`);
  }
  return { enabled: true, tick, stop: () => clearInterval(timer) };
}
