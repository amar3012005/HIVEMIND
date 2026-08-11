import crypto from 'node:crypto';

import { nangoProxyFetch } from '../../agent/connector-toolkits/nango-fetch.js';
import { appendHqEvent, scheduleHqWake } from '../repository.js';
import {
  createRoomTurn,
  workEnvelope,
  workOrderDisplayMessage,
  workOrderPrompt,
} from '../work-dispatcher.js';
import {
  EMAIL_LIFECYCLE_STATUS,
  compileEmailLifecycle,
} from './email-lifecycle.js';
import { createWorkflowEmailDomainStore } from './email-lifecycle-domain-store.js';
import { createEmailRoomExecutor } from './email-room-executor.js';
import { createEmailLifecycleRuntime } from './email-lifecycle-runtime.js';
import { createPostgresCheckpointer } from './postgres-checkpointer.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_PROVIDERS = ['gmail', 'google-mail'];
const FOLLOW_UP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function headerValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeRawEmail({ recipient, subject, body, messageId }) {
  const headers = [
    `To: ${headerValue(recipient)}`,
    `Subject: ${headerValue(subject)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean).join('\r\n');
  return Buffer.from(`${headers}\r\n\r\n${String(body || '')}`, 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deterministicMessageId(idempotencyKey) {
  const digest = crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 40);
  return `<hq-${digest}@runtime.singulance.internal>`;
}

function interruptValue(result) {
  return asList(result?.__interrupt__)[0]?.value || null;
}

function lifecycleContext(workflow) {
  return asObject(asObject(workflow?.context).email_lifecycle);
}

function deliveryStep(steps) {
  return steps.find((step) => ['email_delivery', 'email_send', 'email_outreach_delivery'].includes(String(step.kind || '').toLowerCase())) || null;
}

function todoIdForStep(step) {
  return String(asObject(step?.input).todo_id || '').trim() || null;
}

async function runtimeForWorkflow(prisma, workflow) {
  return prisma.hqRuntime.findFirst({ where: { id: workflow.runtimeId, orgId: workflow.orgId } });
}

async function findOutreachRoom(prisma, organizationId) {
  return prisma.hyperRoom.findFirst({
    where: { orgId: organizationId, archivedAt: null, roomTag: 'outreach' },
    orderBy: { updatedAt: 'desc' },
  });
}

function createExecutionRegistry({ prisma }) {
  return {
    async create(value) {
      const workflow = await prisma.hqWorkflow.findFirst({ where: { id: value.executionId, orgId: value.organizationId } });
      if (!workflow) throw new Error('email_lifecycle_execution_workflow_not_found');
      const current = lifecycleContext(workflow);
      const execution = {
        executionId: value.executionId,
        organizationId: value.organizationId,
        workOrderId: value.workOrderId,
        threadId: current.thread_id || value.threadId,
        graphVersion: Number(current.graph_version || value.graphVersion || 1),
      };
      await prisma.hqWorkflow.update({
        where: { id: workflow.id },
        data: { context: { ...asObject(workflow.context), email_lifecycle: {
          ...current,
          execution_id: execution.executionId,
          thread_id: execution.threadId,
          graph_version: execution.graphVersion,
          work_order_id: execution.workOrderId,
          started_at: current.started_at || new Date().toISOString(),
        } } },
      });
      return execution;
    },
    async get(executionId) {
      const workflow = await prisma.hqWorkflow.findUnique({ where: { id: executionId } });
      if (!workflow) return null;
      const current = lifecycleContext(workflow);
      if (!current.execution_id || !current.thread_id) return null;
      return {
        executionId: current.execution_id,
        organizationId: workflow.orgId,
        workOrderId: current.work_order_id || workflow.id,
        threadId: current.thread_id,
        graphVersion: Number(current.graph_version || workflow.graphVersion || 1),
      };
    },
  };
}

function createRoomInvoker({ prisma }) {
  return async ({ roomTag, order, userMessage, executionContext }) => {
    const room = await findOutreachRoom(prisma, order.org_id);
    if (!room || roomTag !== 'outreach') throw new Error('email_lifecycle_outreach_room_not_found');
    const runtime = await prisma.hqRuntime.findFirst({ where: { orgId: order.org_id } });
    if (!runtime) throw new Error('email_lifecycle_runtime_not_found');
    const roomOrder = {
      ...order,
      room_id: room.id,
      room_tag: room.roomTag,
      room_goal: room.goal,
      project_id: room.projectId,
      participant_ids: room.participantIds,
      owner_user_id: runtime.ownerUserId,
      runtime_epoch: runtime.epoch,
    };
    const turnId = await createRoomTurn(prisma, roomOrder);
    const key = process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
    const base = process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
    const response = await fetch(`${base}/internal/hyper/room-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        schema_version: 'hq-work-order.v2', room_id: room.id, turn_id: turnId,
        user_id: runtime.ownerUserId, org_id: order.org_id,
        user_message: userMessage || workOrderPrompt(roomOrder),
        display_message: workOrderDisplayMessage(roomOrder),
        execution_context: executionContext || workEnvelope(roomOrder),
        task_tag: 'outreach', room_goal: room.goal || null,
        project_id: room.projectId || null, participant_ids: asList(room.participantIds).slice(0, 8),
        callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
        write_policy: 'deny',
      }),
      signal: AbortSignal.timeout(600000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && !body.status) throw new Error(`email_lifecycle_room_http_${response.status}`);
    return body;
  };
}

function createGmailProvider({ prisma }) {
  return {
    async sendEmail(input) {
      const runtime = await prisma.hqRuntime.findFirst({ where: { orgId: input.organizationId } });
      if (!runtime) throw new Error('email_lifecycle_runtime_not_found');
      const connection = await prisma.nangoConnection.findFirst({
        where: { orgId: input.organizationId, userId: runtime.ownerUserId, providerKey: { in: GMAIL_PROVIDERS }, status: 'active' },
        orderBy: { updatedAt: 'desc' },
      });
      if (!connection) throw new Error('email_lifecycle_gmail_not_connected');
      const existing = await prisma.outboundAction.findFirst({
        where: { orgId: input.organizationId, channel: 'email', meta: { path: ['idempotency_key'], equals: input.idempotencyKey } },
        orderBy: { sentAt: 'desc' },
      });
      if (existing?.messageId && existing?.threadId) {
        return { providerMessageId: existing.messageId, providerThreadId: existing.threadId, outboundActionId: existing.id, status: existing.status };
      }

      const messageIdHeader = deterministicMessageId(input.idempotencyKey);
      const ctx = { userId: runtime.ownerUserId, orgId: input.organizationId, prisma };
      const found = await nangoProxyFetch({
        providerKey: connection.providerKey,
        url: `${GMAIL_API}/messages?q=${encodeURIComponent(`rfc822msgid:${messageIdHeader}`)}&maxResults=1`,
        ctx,
      }).catch(() => ({ messages: [] }));
      let providerMessageId = found.messages?.[0]?.id || null;
      let providerThreadId = found.messages?.[0]?.threadId || null;
      if (providerMessageId && !providerThreadId) {
        const reconciled = await nangoProxyFetch({
          providerKey: connection.providerKey,
          url: `${GMAIL_API}/messages/${encodeURIComponent(providerMessageId)}?format=minimal`,
          ctx,
        });
        providerThreadId = reconciled.threadId;
      }
      if (!providerMessageId) {
        const sent = await nangoProxyFetch({
          providerKey: connection.providerKey,
          url: `${GMAIL_API}/messages/send`, method: 'POST',
          body: {
            raw: encodeRawEmail({ ...input, messageId: messageIdHeader }),
            ...(input.providerThreadId ? { threadId: input.providerThreadId } : {}),
          },
          ctx,
        });
        providerMessageId = sent.id;
        providerThreadId = sent.threadId;
      }
      if (!providerMessageId || !providerThreadId) throw new Error('email_lifecycle_gmail_receipt_incomplete');

      const outbound = await prisma.outboundAction.create({
        data: {
          orgId: input.organizationId, userId: runtime.ownerUserId,
          channel: 'email', recipient: String(input.recipient).toLowerCase(), subject: input.subject,
          messageId: providerMessageId, threadId: providerThreadId, status: 'sent',
          meta: {
            origin: 'hq_runtime', via: 'hq-email-lifecycle', hq_runtime_id: runtime.id,
            execution_id: input.executionId, workflow_id: input.executionId,
            work_order_id: input.workOrderId, prospect_id: input.prospectId,
            touch: input.touch, idempotency_key: input.idempotencyKey,
            message_id_header: messageIdHeader,
          },
        },
      }).catch(async (error) => {
        const reconciled = await prisma.outboundAction.findFirst({
          where: { orgId: input.organizationId, channel: 'email', meta: { path: ['idempotency_key'], equals: input.idempotencyKey } },
        });
        if (reconciled) return reconciled;
        throw error;
      });
      return { providerMessageId, providerThreadId, outboundActionId: outbound.id, status: 'sent' };
    },
  };
}

export async function createProductionEmailLifecycleService({ prisma, logger = console } = {}) {
  if (!prisma) throw new Error('email_lifecycle_service_prisma_required');
  const checkpointRuntime = await createPostgresCheckpointer({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.HQ_LANGGRAPH_SCHEMA || 'hivemind_langgraph',
  });
  const domainStore = createWorkflowEmailDomainStore({ prisma });
  const graph = compileEmailLifecycle({
    domainStore,
    roomExecutor: createEmailRoomExecutor({ invokeRoom: createRoomInvoker({ prisma }) }),
    provider: createGmailProvider({ prisma }),
  }, { checkpointer: checkpointRuntime.checkpointer });
  const runtimeApi = createEmailLifecycleRuntime({
    graph, checkpointer: checkpointRuntime.checkpointer,
    executionRegistry: createExecutionRegistry({ prisma }),
  });

  const sync = async ({ organizationId, executionId, result, event = null }) => {
    const workflow = await prisma.hqWorkflow.findFirst({
      where: { id: executionId, orgId: organizationId }, include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow) throw new Error('email_lifecycle_workflow_not_found');
    const step = deliveryStep(workflow.steps);
    if (!step) throw new Error('email_lifecycle_delivery_step_missing');
    const interrupt = interruptValue(result);
    let status = result?.status || EMAIL_LIFECYCLE_STATUS.LOADING;
    let stepStatus = 'RUNNING';
    if (interrupt?.type === 'email_outreach_approval' || interrupt?.type === 'email_follow_up_approval') {
      status = EMAIL_LIFECYCLE_STATUS.WAITING_FOR_APPROVAL;
      stepStatus = 'WAITING_FOR_APPROVAL';
    } else if (interrupt?.type === 'email_provider_event_or_deadline') {
      status = EMAIL_LIFECYCLE_STATUS.WAITING_FOR_EVENT;
      stepStatus = 'WAITING_FOR_EVENT';
    } else if ([EMAIL_LIFECYCLE_STATUS.COMPLETED].includes(status)) stepStatus = 'COMPLETED';
    else if ([EMAIL_LIFECYCLE_STATUS.REJECTED, EMAIL_LIFECYCLE_STATUS.BOUNCED, EMAIL_LIFECYCLE_STATUS.SUPPRESSED].includes(status)) stepStatus = 'BLOCKED';

    const existingContext = asObject(workflow.context);
    await prisma.$transaction(async (tx) => {
      await tx.hqWorkflowStep.update({ where: { id: step.id }, data: {
        status: stepStatus,
        result: { ...asObject(step.result), lifecycle_status: status, interrupt: interrupt || null, last_event: event || null },
        ...(stepStatus === 'COMPLETED' ? { completedAt: new Date(), blockedReason: null } : {}),
      } });
      const todoId = todoIdForStep(step);
      if (todoId) await tx.hqTodo.updateMany({ where: { id: todoId, orgId: organizationId }, data: {
        status: stepStatus, blockedReason: stepStatus === 'BLOCKED' ? `Email lifecycle ended as ${status}` : null,
        ...(stepStatus === 'COMPLETED' ? { completedAt: new Date() } : {}),
      } });
      await tx.hqWorkflow.update({ where: { id: workflow.id }, data: {
        status: stepStatus === 'COMPLETED' && workflow.steps.every((row) => row.id === step.id || row.status === 'COMPLETED') ? 'COMPLETED' : stepStatus,
        context: { ...existingContext, email_lifecycle: { ...lifecycleContext(workflow), status, interrupt: interrupt || null, updated_at: new Date().toISOString() } },
        ...(stepStatus === 'COMPLETED' ? { completedAt: new Date(), terminalReason: null } : {}),
      } });
    });

    const hq = await runtimeForWorkflow(prisma, workflow);
    if (hq) {
      if (stepStatus === 'WAITING_FOR_APPROVAL') {
        await appendHqEvent({
          prisma, runtimeId: hq.id, orgId: organizationId, runtimeEpoch: hq.epoch,
          eventType: 'approval_required', title: interrupt.type === 'email_follow_up_approval' ? 'Follow-up emails are ready' : 'Outreach emails are ready',
          summary: interrupt.type === 'email_follow_up_approval'
            ? 'The Outreach Room prepared and governed the next follow-up. Approve the exact draft before Gmail sends it.'
            : `The Outreach Room prepared and governed ${Number(interrupt.prospectCount || 0)} email(s). Approve the exact drafts before Gmail sends them.`,
          details: { workflow_id: workflow.id, execution_id: executionId, approval: interrupt },
        });
      } else if (stepStatus === 'WAITING_FOR_EVENT') {
        const receipts = await domainStore.listReceipts({ organizationId, executionId });
        for (const receipt of receipts) {
          const dueAt = new Date(new Date(receipt.sentAt || Date.now()).getTime() + FOLLOW_UP_DELAY_MS);
          await scheduleHqWake({
            prisma, runtimeId: hq.id, orgId: organizationId, runtimeEpoch: hq.epoch,
            idempotencyKey: `email-lifecycle-deadline:${executionId}:${receipt.prospectId}:touch-${receipt.touch}`,
            triggerType: 'email_lifecycle_event', dueAt,
            payload: { execution_id: executionId, event: { id: `deadline:${executionId}:${receipt.prospectId}:touch-${receipt.touch}`, type: 'no_reply_deadline', prospectId: receipt.prospectId, touch: receipt.touch } },
          });
        }
        await appendHqEvent({
          prisma, runtimeId: hq.id, orgId: organizationId, runtimeEpoch: hq.epoch,
          eventType: 'tool_result', title: 'Gmail delivery receipts retained',
          summary: `${receipts.length} sent email receipt(s) are now monitored for replies.`,
          toolRef: 'gmail_send', details: { workflow_id: workflow.id, receipts: receipts.map((row) => ({ id: row.id, prospect_id: row.prospectId, touch: row.touch, thread_id: row.providerThreadId })) },
        });
      } else if (event?.type === 'positive_reply') {
        const existingReplyTodo = await prisma.hqTodo.findFirst({
          where: {
            runtimeId: hq.id,
            orgId: organizationId,
            context: { path: ['email_lifecycle_event_id'], equals: event.id },
          },
        });
        const replyTodo = existingReplyTodo || await prisma.hqTodo.create({
          data: {
            runtimeId: hq.id,
            orgId: organizationId,
            title: 'Review and respond to a tracked prospect reply',
            objective: 'Read the exact Gmail thread for this tracked prospect, classify the reply, update the shared lead timeline, and prepare the next appropriate response. Do not send without the organization approval policy.',
            kind: 'outreach',
            status: 'READY',
            priority: -200,
            position: 0,
            requiredCapabilities: ['gmail'],
            context: {
              room_tag: 'outreach',
              workflow_id: workflow.id,
              email_lifecycle_event_id: event.id,
              prospect_id: event.prospectId,
              gmail_artifact_id: event.providerArtifactId || null,
              thread_id: event.providerThreadId || null,
              authority_mode: 'PREPARE',
              acceptance_criteria: [
                'Read the complete matching Gmail thread.',
                'Classify the prospect reply and persist the lead outcome.',
                'Prepare a grounded reply or next action with evidence.',
                'Do not send unless the organization approval policy permits it.',
              ],
            },
          },
        });
        await appendHqEvent({
          prisma, runtimeId: hq.id, orgId: organizationId, runtimeEpoch: hq.epoch,
          eventType: 'observation', title: 'A tracked prospect replied',
          summary: 'Gmail matched the reply to the exact HQ Runtime thread. The email lifecycle advanced from provider evidence.',
          details: { workflow_id: workflow.id, reply_todo_id: replyTodo.id, event },
        });
        await scheduleHqWake({
          prisma, runtimeId: hq.id, orgId: organizationId, runtimeEpoch: hq.epoch,
          idempotencyKey: `email-reply-queue:${event.id}`,
          triggerType: 'queue_advance', dueAt: new Date(),
          payload: { todo_id: replyTodo.id, workflow_id: workflow.id, source: 'email_lifecycle_reply' },
        });
      }
    }
    return { workflowId: workflow.id, executionId, status, stepStatus, interrupt };
  };

  return {
    async maybeStartForAcceptedWork({ runtime, workflowId }) {
      if (!workflowId) return null;
      const workflow = await prisma.hqWorkflow.findFirst({
        where: { id: workflowId, orgId: runtime.orgId }, include: { steps: { orderBy: { position: 'asc' } }, artifacts: true },
      });
      if (!workflow || lifecycleContext(workflow).execution_id) return null;
      const step = deliveryStep(workflow.steps);
      const hasDrafts = workflow.artifacts.some((row) => ['email_drafts', 'email_draft'].includes(normalizedKind(row.artifactType)));
      const hasProspects = workflow.artifacts.some((row) => normalizedKind(row.artifactType) === 'prospect_records');
      if (!step || !hasDrafts || !hasProspects) return null;
      const result = await runtimeApi.start({
        executionId: workflow.id, organizationId: workflow.orgId, workOrderId: workflow.id,
        graphVersion: 1, mode: 'AUTONOMOUS',
        externalWrites: asObject(workflow.authorityPolicy).external_writes === 'auto' ? 'auto' : 'approval_required',
        status: EMAIL_LIFECYCLE_STATUS.LOADING, prospectIds: [], draftRefs: {}, receiptRefs: {},
        followUpDraftRefs: {}, followUpReceiptRefs: {}, terminalOutcomes: {}, processedEventIds: [],
        pendingFollowUp: null, events: [],
      });
      return sync({ organizationId: workflow.orgId, executionId: workflow.id, result });
    },
    async approve({ organizationId, executionId, approved }) {
      const workflow = await prisma.hqWorkflow.findFirst({ where: { id: executionId, orgId: organizationId } });
      if (!workflow) throw new Error('email_lifecycle_execution_not_found');
      if (workflow.status !== 'WAITING_FOR_APPROVAL') {
        return {
          workflowId: workflow.id,
          executionId,
          status: lifecycleContext(workflow).status || workflow.status,
          stepStatus: workflow.status,
          alreadyResolved: true,
        };
      }
      const result = await runtimeApi.resume({ organizationId, executionId, value: { approved: approved === true } });
      return sync({ organizationId, executionId, result, event: { type: approved ? 'approval_granted' : 'approval_rejected' } });
    },
    async resumeEvent({ organizationId, executionId, event }) {
      const snapshot = await runtimeApi.getState({ organizationId, executionId });
      const existingOutcome = snapshot?.values?.terminalOutcomes?.[event?.prospectId];
      if (existingOutcome) {
        return { workflowId: executionId, executionId, status: snapshot.values.status, stepStatus: 'WAITING_FOR_EVENT', ignored: true, reason: `prospect_already_terminal:${existingOutcome}` };
      }
      const result = await runtimeApi.resume({ organizationId, executionId, value: event });
      return sync({ organizationId, executionId, result, event });
    },
    async retry({ organizationId, executionId }) {
      const result = await runtimeApi.retry({ organizationId, executionId });
      return sync({ organizationId, executionId, result });
    },
    async listPendingApprovals({ organizationId }) {
      const workflows = await prisma.hqWorkflow.findMany({
        where: { orgId: organizationId, status: 'WAITING_FOR_APPROVAL' },
        include: { artifacts: { where: { artifactType: { in: ['email_drafts', 'email_draft', 'email_follow_up'] } }, orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' }, take: 20,
      });
      return workflows.map((workflow) => ({
        workflow_id: workflow.id, title: workflow.title, objective: workflow.objective,
        interrupt: lifecycleContext(workflow).interrupt || null,
        drafts: workflow.artifacts.flatMap((row) => normalizedKind(row.artifactType) === 'email_drafts'
          ? asList(artifactPayload(row).records) : [artifactPayload(row)]),
        updated_at: workflow.updatedAt,
      }));
    },
    getState: runtimeApi.getState,
    deleteCheckpoints: runtimeApi.deleteCheckpoints,
    async close() { await checkpointRuntime.close(); },
  };
}

function normalizedKind(value) {
  return String(value || '').trim().toLowerCase().replaceAll('-', '_');
}

function artifactPayload(row) {
  return row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
}
