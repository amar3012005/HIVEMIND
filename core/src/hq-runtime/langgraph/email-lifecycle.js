import {
  Annotation,
  END,
  Send,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';

export const EMAIL_LIFECYCLE_VERSION = 1;

export const EMAIL_LIFECYCLE_STATUS = Object.freeze({
  LOADING: 'LOADING',
  DRAFTING: 'DRAFTING',
  REPAIRING: 'REPAIRING',
  READY_FOR_APPROVAL: 'READY_FOR_APPROVAL',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  REJECTED: 'REJECTED',
  SENDING: 'SENDING',
  WAITING_FOR_EVENT: 'WAITING_FOR_EVENT',
  REPLY_RECEIVED: 'REPLY_RECEIVED',
  FOLLOW_UP_DUE: 'FOLLOW_UP_DUE',
  SUPPRESSED: 'SUPPRESSED',
  BOUNCED: 'BOUNCED',
  SEQUENCE_EXHAUSTED: 'SEQUENCE_EXHAUSTED',
  COMPLETED: 'COMPLETED',
});

const mergeRecords = (current, update) => ({
  ...(current || {}),
  ...(update || {}),
});

const appendEvents = (current, update) => [
  ...(current || []),
  ...(Array.isArray(update) ? update : [update]).filter(Boolean),
];

export const EmailLifecycleState = Annotation.Root({
  executionId: Annotation(),
  organizationId: Annotation(),
  workOrderId: Annotation(),
  graphVersion: Annotation(),
  mode: Annotation(),
  externalWrites: Annotation(),
  status: Annotation(),
  prospectIds: Annotation(),
  draftRefs: Annotation({ reducer: mergeRecords, default: () => ({}) }),
  receiptRefs: Annotation({ reducer: mergeRecords, default: () => ({}) }),
  followUpDraftRefs: Annotation({ reducer: mergeRecords, default: () => ({}) }),
  followUpReceiptRefs: Annotation({ reducer: mergeRecords, default: () => ({}) }),
  governance: Annotation(),
  approval: Annotation(),
  incomingEvent: Annotation(),
  pendingFollowUp: Annotation(),
  processedEventIds: Annotation({ reducer: appendEvents, default: () => [] }),
  terminalOutcomes: Annotation({ reducer: mergeRecords, default: () => ({}) }),
  events: Annotation({ reducer: appendEvents, default: () => [] }),

  // Send payload fields are scoped to a dynamic branch and are not returned.
  prospectId: Annotation(),
  repair: Annotation(),
});

function requireMethod(target, name) {
  if (!target || typeof target[name] !== 'function') {
    throw new Error(`email_lifecycle_missing_dependency:${name}`);
  }
}

function assertInitialState(state) {
  for (const field of ['executionId', 'organizationId', 'workOrderId']) {
    if (!String(state[field] || '').trim()) {
      throw new Error(`email_lifecycle_missing_${field}`);
    }
  }
  if (!['PREPARE', 'AUTONOMOUS'].includes(state.mode)) {
    throw new Error('email_lifecycle_invalid_mode');
  }
  if (!['approval_required', 'auto'].includes(state.externalWrites)) {
    throw new Error('email_lifecycle_invalid_external_writes_policy');
  }
}

function lifecycleEvent(type, details = {}) {
  return {
    type,
    at: new Date().toISOString(),
    ...details,
  };
}

export function createEmailLifecycleGraph({ domainStore, roomExecutor, provider }) {
  requireMethod(domainStore, 'listAcceptedProspects');
  requireMethod(domainStore, 'upsertDraft');
  requireMethod(domainStore, 'listDrafts');
  requireMethod(domainStore, 'upsertReceipt');
  requireMethod(domainStore, 'listReceipts');
  requireMethod(domainStore, 'getFollowUpDraft');
  requireMethod(domainStore, 'upsertFollowUpDraft');
  requireMethod(domainStore, 'getFollowUpReceipt');
  requireMethod(domainStore, 'upsertFollowUpReceipt');
  requireMethod(roomExecutor, 'draftEmail');
  requireMethod(roomExecutor, 'governDrafts');
  requireMethod(roomExecutor, 'draftFollowUp');
  requireMethod(roomExecutor, 'governFollowUp');
  requireMethod(provider, 'sendEmail');

  const load = async (state) => {
    assertInitialState(state);
    const prospects = await domainStore.listAcceptedProspects({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
    });
    const prospectIds = prospects.map((prospect) => String(prospect.id));
    if (!prospectIds.length) {
      throw new Error('email_lifecycle_no_accepted_prospects');
    }

    const drafts = await domainStore.listDrafts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    const draftRefs = Object.fromEntries(drafts.map((draft) => [draft.prospectId, draft.id]));

    return {
      graphVersion: EMAIL_LIFECYCLE_VERSION,
      status: EMAIL_LIFECYCLE_STATUS.DRAFTING,
      prospectIds,
      draftRefs,
      events: [lifecycleEvent('prospects_loaded', { count: prospectIds.length })],
    };
  };

  const routeDraftWork = (state) => {
    const repairIds = state.governance?.repairIds || [];
    const targetIds = repairIds.length
      ? repairIds
      : state.prospectIds.filter((id) => !state.draftRefs?.[id]);

    if (!targetIds.length) return 'governDrafts';
    return targetIds.map((prospectId) => new Send('draftProspect', {
      ...state,
      prospectId,
      repair: repairIds.includes(prospectId),
    }));
  };

  const draftProspect = async (state) => {
    const prospect = await domainStore.getAcceptedProspect({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      prospectId: state.prospectId,
    });
    if (!prospect) throw new Error(`email_lifecycle_prospect_not_found:${state.prospectId}`);

    const existingDraft = await domainStore.getDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: state.prospectId,
    });
    if (existingDraft && !state.repair) {
      return {
        draftRefs: { [state.prospectId]: existingDraft.id },
        events: [lifecycleEvent('existing_draft_reconciled', {
          prospectId: state.prospectId,
          draftId: existingDraft.id,
        })],
      };
    }

    const previousDraft = state.repair ? existingDraft : null;
    const generated = await roomExecutor.draftEmail({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      executionId: state.executionId,
      prospect,
      previousDraft,
      repair: Boolean(state.repair),
    });
    const draft = await domainStore.upsertDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: state.prospectId,
      subject: generated.subject,
      body: generated.body,
      recipient: generated.recipient,
      evidenceRefs: generated.evidenceRefs || [],
      version: Number(previousDraft?.version || 0) + 1,
    });
    return {
      draftRefs: { [state.prospectId]: draft.id },
      events: [lifecycleEvent(state.repair ? 'draft_repaired' : 'draft_created', {
        prospectId: state.prospectId,
        draftId: draft.id,
      })],
    };
  };

  const governDrafts = async (state) => {
    const drafts = await domainStore.listDrafts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    const result = await roomExecutor.governDrafts({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      prospectIds: state.prospectIds,
      drafts,
    });
    const repairIds = [...new Set(result.repairIds || [])]
      .filter((id) => state.prospectIds.includes(id));
    return {
      governance: {
        accepted: repairIds.length === 0 && result.accepted !== false,
        repairIds,
        issues: result.issues || [],
      },
      status: repairIds.length
        ? EMAIL_LIFECYCLE_STATUS.REPAIRING
        : EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL,
      events: [lifecycleEvent(repairIds.length ? 'governance_repair_required' : 'governance_accepted', {
        repairCount: repairIds.length,
      })],
    };
  };

  const routeAfterGovernance = (state) => {
    if (state.governance?.repairIds?.length) return routeDraftWork(state);
    if (state.mode === 'PREPARE') return END;
    if (state.externalWrites === 'approval_required' && state.approval !== 'approved') {
      return 'approvalGate';
    }
    return 'dispatchSends';
  };

  const approvalGate = (state) => {
    const decision = interrupt({
      type: 'email_outreach_approval',
      executionId: state.executionId,
      workOrderId: state.workOrderId,
      prospectCount: state.prospectIds.length,
      draftIds: Object.values(state.draftRefs || {}),
    });
    return {
      approval: decision?.approved ? 'approved' : 'rejected',
      status: decision?.approved
        ? EMAIL_LIFECYCLE_STATUS.SENDING
        : EMAIL_LIFECYCLE_STATUS.REJECTED,
      events: [lifecycleEvent(decision?.approved ? 'approval_granted' : 'approval_rejected')],
    };
  };

  const routeAfterApproval = (state) => (
    state.approval === 'approved' ? 'dispatchSends' : END
  );

  const dispatchSends = async (state) => {
    const receipts = await domainStore.listReceipts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    const receiptRefs = Object.fromEntries(receipts.map((receipt) => [receipt.prospectId, receipt.id]));
    return {
      receiptRefs,
      status: EMAIL_LIFECYCLE_STATUS.SENDING,
      events: [lifecycleEvent('send_dispatch_started')],
    };
  };

  const routeSendWork = (state) => {
    const missing = state.prospectIds.filter((id) => !state.receiptRefs?.[id]);
    if (!missing.length) return 'waitForEvent';
    return missing.map((prospectId) => new Send('sendProspect', {
      ...state,
      prospectId,
    }));
  };

  const sendProspect = async (state) => {
    const existingReceipts = await domainStore.listReceipts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    const existingReceipt = existingReceipts.find((receipt) => (
      receipt.prospectId === state.prospectId && Number(receipt.touch || 1) === 1
    ));
    if (existingReceipt) {
      return {
        receiptRefs: { [state.prospectId]: existingReceipt.id },
        events: [lifecycleEvent('existing_send_receipt_reconciled', {
          prospectId: state.prospectId,
          receiptId: existingReceipt.id,
        })],
      };
    }

    const draft = await domainStore.getDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: state.prospectId,
    });
    if (!draft) throw new Error(`email_lifecycle_draft_not_found:${state.prospectId}`);

    const idempotencyKey = `${state.executionId}:touch-1:${state.prospectId}`;
    const providerReceipt = await provider.sendEmail({
      organizationId: state.organizationId,
      executionId: state.executionId,
      workOrderId: state.workOrderId,
      prospectId: state.prospectId,
      touch: 1,
      recipient: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      idempotencyKey,
    });
    const receipt = await domainStore.upsertReceipt({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: state.prospectId,
      touch: 1,
      idempotencyKey,
      providerMessageId: providerReceipt.providerMessageId,
      providerThreadId: providerReceipt.providerThreadId,
      outboundActionId: providerReceipt.outboundActionId || null,
      status: providerReceipt.status || 'sent',
    });
    return {
      receiptRefs: { [state.prospectId]: receipt.id },
      events: [lifecycleEvent('email_sent', {
        prospectId: state.prospectId,
        receiptId: receipt.id,
      })],
    };
  };

  const waitForEvent = async (state) => {
    const receipts = await domainStore.listReceipts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    if (receipts.length !== state.prospectIds.length) {
      throw new Error('email_lifecycle_receipt_count_mismatch');
    }
    const incomingEvent = interrupt({
      type: 'email_provider_event_or_deadline',
      executionId: state.executionId,
      receiptIds: receipts.map((receipt) => receipt.id),
    });
    return {
      incomingEvent,
      status: EMAIL_LIFECYCLE_STATUS.WAITING_FOR_EVENT,
      events: [lifecycleEvent('external_event_received', {
        eventType: incomingEvent?.type || 'unknown',
      })],
    };
  };

  const classifyEvent = (state) => {
    const event = state.incomingEvent || {};
    const eventId = String(event.id || '').trim();
    if (!eventId) throw new Error('email_lifecycle_event_missing_id');
    if ((state.processedEventIds || []).includes(eventId)) {
      return {
        incomingEvent: null,
        events: [lifecycleEvent('duplicate_email_event_ignored', { eventId })],
      };
    }
    const prospectId = String(event.prospectId || '');
    if (!state.prospectIds.includes(prospectId)) {
      throw new Error('email_lifecycle_event_unknown_prospect');
    }
    const mapping = {
      positive_reply: EMAIL_LIFECYCLE_STATUS.REPLY_RECEIVED,
      unsubscribe: EMAIL_LIFECYCLE_STATUS.SUPPRESSED,
      bounce: EMAIL_LIFECYCLE_STATUS.BOUNCED,
      no_reply_deadline: EMAIL_LIFECYCLE_STATUS.FOLLOW_UP_DUE,
    };
    const status = mapping[event.type];
    if (!status) throw new Error(`email_lifecycle_unknown_event:${event.type || 'missing'}`);
    const touch = Math.max(1, Number(event.touch || 1));
    const resolvedStatus = event.type === 'no_reply_deadline' && touch >= 2
      ? EMAIL_LIFECYCLE_STATUS.SEQUENCE_EXHAUSTED
      : status;
    return {
      status: resolvedStatus,
      incomingEvent: null,
      processedEventIds: [eventId],
      pendingFollowUp: resolvedStatus === EMAIL_LIFECYCLE_STATUS.FOLLOW_UP_DUE
        ? { prospectId, touch: touch + 1, repair: false }
        : null,
      terminalOutcomes: resolvedStatus === EMAIL_LIFECYCLE_STATUS.FOLLOW_UP_DUE
        ? {}
        : { [prospectId]: resolvedStatus },
      events: [lifecycleEvent('email_event_classified', { prospectId, status: resolvedStatus })],
    };
  };

  const routeAfterEvent = (state) => {
    if (state.pendingFollowUp) return 'draftFollowUp';
    const terminalCount = Object.keys(state.terminalOutcomes || {}).length;
    if (terminalCount === state.prospectIds.length) return 'complete';
    return 'waitForEvent';
  };

  const draftFollowUp = async (state) => {
    const pending = state.pendingFollowUp;
    if (!pending) throw new Error('email_lifecycle_follow_up_missing_context');
    const existing = await domainStore.getFollowUpDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
    });
    if (existing && !pending.repair) {
      return {
        followUpDraftRefs: { [pending.prospectId]: existing.id },
        events: [lifecycleEvent('existing_follow_up_draft_reconciled', {
          prospectId: pending.prospectId,
          touch: pending.touch,
        })],
      };
    }
    const prospect = await domainStore.getAcceptedProspect({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      prospectId: pending.prospectId,
    });
    const generated = await roomExecutor.draftFollowUp({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      executionId: state.executionId,
      prospect,
      touch: pending.touch,
      previousDraft: existing,
      repair: Boolean(pending.repair),
    });
    const draft = await domainStore.upsertFollowUpDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
      recipient: generated.recipient,
      subject: generated.subject,
      body: generated.body,
      evidenceRefs: generated.evidenceRefs || [],
      version: Number(existing?.version || 0) + 1,
    });
    return {
      followUpDraftRefs: { [pending.prospectId]: draft.id },
      events: [lifecycleEvent(pending.repair ? 'follow_up_repaired' : 'follow_up_created', {
        prospectId: pending.prospectId,
        touch: pending.touch,
      })],
    };
  };

  const governFollowUp = async (state) => {
    const pending = state.pendingFollowUp;
    const draft = await domainStore.getFollowUpDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
    });
    const result = await roomExecutor.governFollowUp({
      organizationId: state.organizationId,
      workOrderId: state.workOrderId,
      prospectId: pending.prospectId,
      touch: pending.touch,
      draft,
    });
    return {
      pendingFollowUp: { ...pending, repair: result.accepted === false },
      events: [lifecycleEvent(result.accepted === false
        ? 'follow_up_governance_repair_required'
        : 'follow_up_governance_accepted', {
        prospectId: pending.prospectId,
        touch: pending.touch,
      })],
    };
  };

  const routeAfterFollowUpGovernance = (state) => {
    if (state.pendingFollowUp?.repair) return 'draftFollowUp';
    if (state.externalWrites === 'approval_required') return 'followUpApprovalGate';
    return 'sendFollowUp';
  };

  const followUpApprovalGate = (state) => {
    const pending = state.pendingFollowUp;
    const decision = interrupt({
      type: 'email_follow_up_approval',
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
      draftId: state.followUpDraftRefs?.[pending.prospectId],
    });
    return {
      approval: decision?.approved ? 'approved' : 'rejected',
      status: decision?.approved
        ? EMAIL_LIFECYCLE_STATUS.SENDING
        : EMAIL_LIFECYCLE_STATUS.REJECTED,
      events: [lifecycleEvent(decision?.approved
        ? 'follow_up_approval_granted'
        : 'follow_up_approval_rejected')],
    };
  };

  const routeAfterFollowUpApproval = (state) => (
    state.approval === 'approved' ? 'sendFollowUp' : END
  );

  const sendFollowUp = async (state) => {
    const pending = state.pendingFollowUp;
    const existing = await domainStore.getFollowUpReceipt({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
    });
    if (existing) {
      return {
        followUpReceiptRefs: { [pending.prospectId]: existing.id },
        pendingFollowUp: null,
        status: EMAIL_LIFECYCLE_STATUS.WAITING_FOR_EVENT,
        events: [lifecycleEvent('existing_follow_up_receipt_reconciled', {
          prospectId: pending.prospectId,
          touch: pending.touch,
        })],
      };
    }
    const draft = await domainStore.getFollowUpDraft({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
    });
    const idempotencyKey = `${state.executionId}:touch-${pending.touch}:${pending.prospectId}`;
    const priorReceipts = await domainStore.listReceipts({
      organizationId: state.organizationId,
      executionId: state.executionId,
    });
    const priorReceipt = priorReceipts.find((receipt) => receipt.prospectId === pending.prospectId);
    const providerReceipt = await provider.sendEmail({
      organizationId: state.organizationId,
      executionId: state.executionId,
      workOrderId: state.workOrderId,
      prospectId: pending.prospectId,
      touch: pending.touch,
      recipient: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      idempotencyKey,
      providerThreadId: priorReceipt?.providerThreadId || null,
    });
    const receipt = await domainStore.upsertFollowUpReceipt({
      organizationId: state.organizationId,
      executionId: state.executionId,
      prospectId: pending.prospectId,
      touch: pending.touch,
      idempotencyKey,
      providerMessageId: providerReceipt.providerMessageId,
      providerThreadId: providerReceipt.providerThreadId,
      outboundActionId: providerReceipt.outboundActionId || null,
      status: providerReceipt.status || 'sent',
    });
    return {
      followUpReceiptRefs: { [pending.prospectId]: receipt.id },
      pendingFollowUp: null,
      status: EMAIL_LIFECYCLE_STATUS.WAITING_FOR_EVENT,
      events: [lifecycleEvent('follow_up_sent', {
        prospectId: pending.prospectId,
        touch: pending.touch,
      })],
    };
  };

  const complete = () => ({
    status: EMAIL_LIFECYCLE_STATUS.COMPLETED,
    events: [lifecycleEvent('email_lifecycle_completed')],
  });

  return new StateGraph(EmailLifecycleState)
    .addNode('load', load)
    .addNode('draftProspect', draftProspect)
    .addNode('governDrafts', governDrafts)
    .addNode('approvalGate', approvalGate)
    .addNode('dispatchSends', dispatchSends)
    .addNode('sendProspect', sendProspect)
    .addNode('waitForEvent', waitForEvent)
    .addNode('classifyEvent', classifyEvent)
    .addNode('draftFollowUp', draftFollowUp)
    .addNode('governFollowUp', governFollowUp)
    .addNode('followUpApprovalGate', followUpApprovalGate)
    .addNode('sendFollowUp', sendFollowUp)
    .addNode('complete', complete)
    .addEdge(START, 'load')
    .addConditionalEdges('load', routeDraftWork)
    .addEdge('draftProspect', 'governDrafts')
    .addConditionalEdges('governDrafts', routeAfterGovernance)
    .addConditionalEdges('approvalGate', routeAfterApproval)
    .addConditionalEdges('dispatchSends', routeSendWork)
    .addEdge('sendProspect', 'waitForEvent')
    .addEdge('waitForEvent', 'classifyEvent')
    .addConditionalEdges('classifyEvent', routeAfterEvent)
    .addEdge('draftFollowUp', 'governFollowUp')
    .addConditionalEdges('governFollowUp', routeAfterFollowUpGovernance)
    .addConditionalEdges('followUpApprovalGate', routeAfterFollowUpApproval)
    .addEdge('sendFollowUp', 'waitForEvent')
    .addEdge('complete', END);
}

export function compileEmailLifecycle(dependencies, { checkpointer } = {}) {
  return createEmailLifecycleGraph(dependencies).compile({ checkpointer });
}
