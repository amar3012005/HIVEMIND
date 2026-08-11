import crypto from 'node:crypto';

const E164_RE = /^\+[1-9]\d{6,14}$/;

function compact(value, limit) {
  const text = String(value || '').trim();
  return text ? text.slice(0, limit) : null;
}

function actionKey(parts) {
  return `tara:${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex')}`;
}

function classifyError(error) {
  const status = Number(error?.status || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { classification: 'deterministic_response', retryable: false, reconciliationRequired: false };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { classification: 'transient_response', retryable: true, reconciliationRequired: true };
  }
  return { classification: 'uncertain_transport', retryable: false, reconciliationRequired: true };
}

async function ensureCampaignAndContact(prisma, input) {
  const executionRef = input.executionRef || input.runtimePlaybookRunId || input.outreachCampaignId || input.campaignActionId;
  if (!executionRef) throw new Error('tara_call_execution_ref_required');
  let campaign = await prisma.taraCampaign.findFirst({
    where: { orgId: input.orgId, unifiedCampaignId: executionRef },
  });
  if (!campaign) {
    campaign = await prisma.taraCampaign.create({ data: {
      orgId: input.orgId,
      userId: input.userId,
      unifiedCampaignId: executionRef,
      name: compact(input.campaignName || input.recipientName || 'Governed TARA call', 200),
      status: 'active',
      provider: input.provider.provider,
      configSnapshot: { revision: input.provider.revision || 1, source: input.source || 'runtime' },
      goal: compact(input.goal, 2000),
      callingWindow: input.callingWindow || {},
      caps: input.caps || { concurrency: 1 },
      complianceConfig: input.complianceConfig || {},
    } });
  }
  const contact = await prisma.taraCampaignContact.upsert({
    where: { campaignId_phone: { campaignId: campaign.id, phone: input.to } },
    create: {
      campaignId: campaign.id, orgId: input.orgId, userId: input.userId, phone: input.to,
      displayName: compact(input.recipientName, 255), company: compact(input.recipientCompany, 255),
      country: compact(input.country, 2), timezone: compact(input.timezone, 60),
      lawfulBasis: compact(input.lawfulBasis, 40), metadata: input.contactMetadata || {},
    },
    update: {
      displayName: compact(input.recipientName, 255), company: compact(input.recipientCompany, 255),
      country: compact(input.country, 2), timezone: compact(input.timezone, 60),
      lawfulBasis: compact(input.lawfulBasis, 40), metadata: input.contactMetadata || {},
    },
  });
  return { campaign, contact };
}

async function createOutboundLedger(prisma, attempt, input, receipt) {
  if (attempt.outboundActionId) {
    return prisma.outboundAction.findUnique({ where: { id: attempt.outboundActionId } });
  }
  const existing = await prisma.outboundAction.findFirst({
    where: { orgId: input.orgId, channel: 'call', meta: { path: ['tara_call_attempt_id'], equals: attempt.id } },
  });
  const row = existing || await prisma.outboundAction.create({ data: {
    orgId: input.orgId, userId: input.userId, roomId: input.roomId || null,
    campaignId: input.campaignId || null, campaignActionId: input.campaignActionId || null,
    approvalId: compact(input.authorityRef, 80), channel: 'call', recipient: input.to,
    messageId: receipt.callLegId || receipt.canonicalSessionId, status: 'sent',
    meta: {
      source: input.source || 'tara-outbound-call-service',
      tara_call_attempt_id: attempt.id,
      requested_session_id: receipt.requestedSessionId,
      session_id: receipt.canonicalSessionId,
      provider: receipt.provider,
      runtime_playbook_run_id: input.runtimePlaybookRunId || null,
      runtime_stage_id: input.runtimeStageId || null,
      outreach_campaign_id: input.outreachCampaignId || null,
      outreach_target_id: input.outreachTargetId || null,
      lead_id: input.leadId || null,
    },
  } });
  if (!attempt.outboundActionId) {
    await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: { outboundActionId: row.id } });
  }
  return row;
}

async function metric(prisma, input, name, value, unit = 'ms', metadata = {}) {
  if (!Number.isFinite(value)) return;
  await prisma.runtimePerformanceMetric.create({ data: {
    orgId: input.orgId,
    runId: input.runtimePlaybookRunId || null,
    stageId: compact(input.runtimeStageId, 120),
    metric: name, value, unit, source: 'tara-outbound-call-service', metadata,
  } }).catch(() => {});
}

export function createTaraOutboundCallService({ prisma, fetchImpl = fetch } = {}) {
  if (!prisma) throw new Error('tara_outbound_call_service_prisma_required');

  async function reconcile(attemptOrKey, { provider } = {}) {
    const startedAt = Date.now();
    const attempt = typeof attemptOrKey === 'string'
      ? await prisma.taraCallAttempt.findUnique({ where: { actionKey: attemptOrKey } })
      : attemptOrKey;
    if (!attempt) return { status: 'ABSENT' };
    const [ledger, canonicalCall, requestedCall] = await Promise.all([
      attempt.outboundActionId
        ? prisma.outboundAction.findUnique({ where: { id: attempt.outboundActionId } })
        : prisma.outboundAction.findFirst({ where: { orgId: attempt.orgId, channel: 'call', meta: { path: ['tara_call_attempt_id'], equals: attempt.id } } }),
      attempt.sessionId ? prisma.taraCall.findFirst({ where: { orgId: attempt.orgId, sessionId: attempt.sessionId } }) : null,
      attempt.requestedSessionId && attempt.requestedSessionId !== attempt.sessionId
        ? prisma.taraCall.findFirst({ where: { orgId: attempt.orgId, sessionId: attempt.requestedSessionId } }) : null,
    ]);
    const call = canonicalCall || requestedCall;
    if (ledger || call) {
      const canonicalSessionId = call?.sessionId || attempt.sessionId || attempt.requestedSessionId;
      const updated = await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
        sessionId: canonicalSessionId,
        outboundActionId: ledger?.id || attempt.outboundActionId,
        reconciliationState: call?.endedAt ? 'completed' : 'confirmed',
        lastError: null,
      } });
      await metric(prisma, {
        orgId: attempt.orgId, runtimePlaybookRunId: attempt.runtimePlaybookRunId,
        runtimeStageId: attempt.runtimeStageId,
      }, 'tara_reconciliation_duration', Date.now() - startedAt, 'ms', { status: call?.endedAt ? 'COMPLETED' : 'CONFIRMED' });
      return { status: call?.endedAt ? 'COMPLETED' : 'CONFIRMED', attempt: updated, call, ledger };
    }
    if (attempt.callLegId && provider?.baseUrl) {
      const response = await fetchImpl(`${String(provider.baseUrl).replace(/\/$/, '')}/calls/outbound/${encodeURIComponent(attempt.callLegId)}/status`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (response?.ok) {
        const providerState = await response.json().catch(() => ({}));
        const updated = await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
          reconciliationState: 'confirmed', lastError: null,
        } });
        await metric(prisma, {
          orgId: attempt.orgId, runtimePlaybookRunId: attempt.runtimePlaybookRunId,
          runtimeStageId: attempt.runtimeStageId,
        }, 'tara_reconciliation_duration', Date.now() - startedAt, 'ms', { status: 'PROVIDER_CONFIRMED' });
        return { status: 'PROVIDER_CONFIRMED', attempt: updated, provider: providerState };
      }
    }
    await metric(prisma, {
      orgId: attempt.orgId, runtimePlaybookRunId: attempt.runtimePlaybookRunId,
      runtimeStageId: attempt.runtimeStageId,
    }, 'tara_reconciliation_duration', Date.now() - startedAt, 'ms', { status: 'UNKNOWN' });
    return { status: 'UNKNOWN', attempt };
  }

  async function execute(input) {
    const to = String(input.to || '').replace(/[\s()/-]/g, '');
    if (!E164_RE.test(to)) {
      const error = new Error('tara_recipient_invalid'); error.status = 400; throw error;
    }
    if (!input.provider?.baseUrl || !input.provider?.provider) throw new Error('tara_provider_required');
    const normalized = { ...input, to };
    const { campaign, contact } = await ensureCampaignAndContact(prisma, normalized);
    const key = input.actionKey || actionKey([
      input.runtimePlaybookRunId || input.campaignActionId || input.outreachCampaignId || campaign.id,
      input.runtimeStageId || '', input.outreachTargetId || contact.id, to,
    ]);
    let attempt = await prisma.taraCallAttempt.upsert({
      where: { actionKey: key },
      create: {
        campaignId: campaign.id, contactId: contact.id, orgId: input.orgId, userId: input.userId,
        attemptNo: Number(input.attemptNo || 1), provider: input.provider.provider, actionKey: key,
        runtimePlaybookRunId: input.runtimePlaybookRunId || null,
        runtimeStageId: compact(input.runtimeStageId, 120),
        outreachCampaignId: input.outreachCampaignId || null,
        outreachTargetId: input.outreachTargetId || null,
        leadId: input.leadId || null,
        authorityRef: compact(input.authorityRef, 160),
        providerCandidates: input.providerCandidates || [input.provider.provider],
        scheduledAt: input.scheduledAt || null,
        configSnapshot: { ...(input.configSnapshot || {}), request: input.auditContext || {} },
      },
      update: {},
    });
    const reconciled = await reconcile(attempt, { provider: input.provider });
    if (['CONFIRMED', 'COMPLETED', 'PROVIDER_CONFIRMED'].includes(reconciled.status)) {
      const resolved = reconciled.attempt || attempt;
      return {
        deduplicated: true, attempt: resolved, outboundAction: reconciled.ledger || null,
        requestedSessionId: resolved.requestedSessionId,
        canonicalSessionId: resolved.sessionId,
        callLegId: resolved.callLegId,
        provider: resolved.provider,
      };
    }
    if (attempt.status === 'dialing' || attempt.reconciliationState === 'uncertain') {
      const error = new Error('tara_call_outcome_uncertain');
      error.classification = 'uncertain_transport';
      error.reconciliationRequired = true;
      error.attemptId = attempt.id;
      throw error;
    }

    const requestedSessionId = crypto.randomUUID();
    const dispatchStartedAt = Date.now();
    attempt = await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
      status: 'dialing', startedAt: new Date(), requestedSessionId,
      reconciliationState: 'write_started', lastError: null,
    } });
    await prisma.taraCampaignContact.update({ where: { id: contact.id }, data: { status: 'calling' } });
    let response;
    try {
      response = await fetchImpl(`${String(input.provider.baseUrl).replace(/\/$/, '')}/calls/outbound`, {
        method: 'POST', headers: input.headers || { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input.providerPayload, to, session_id: requestedSessionId }),
        signal: AbortSignal.timeout(Number(input.timeoutMs || 20_000)),
      });
    } catch (error) {
      await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
        reconciliationState: 'uncertain', lastError: compact(error?.message || error, 4000),
      } });
      error.classification = 'uncertain_transport';
      error.reconciliationRequired = true;
      error.attemptId = attempt.id;
      throw error;
    }
    const text = await response.text();
    await metric(prisma, normalized, 'tara_dispatch_latency', Date.now() - dispatchStartedAt, 'ms', {
      provider: input.provider.provider, status: response.status,
    });
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const error = new Error(String(body?.error || `tara_outbound_http_${response.status}`));
      error.status = response.status;
      const classification = classifyError(error);
      await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
        status: classification.reconciliationRequired ? 'dialing' : 'done',
        disposition: classification.reconciliationRequired ? null : 'rejected',
        endedAt: classification.reconciliationRequired ? null : new Date(),
        reconciliationState: classification.reconciliationRequired ? 'uncertain' : 'rejected',
        lastError: compact(error.message, 4000),
      } });
      Object.assign(error, classification, { attemptId: attempt.id });
      throw error;
    }
    const canonicalSessionId = compact(body?.session_id, 120);
    const callLegId = compact(body?.call_leg_id, 120);
    if (!canonicalSessionId || !callLegId) {
      await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
        sessionId: canonicalSessionId, callLegId, reconciliationState: 'uncertain',
        lastError: 'provider_success_receipt_incomplete',
      } });
      const error = new Error('provider_success_receipt_incomplete');
      Object.assign(error, { classification: 'uncertain_transport', reconciliationRequired: true, attemptId: attempt.id });
      throw error;
    }
    attempt = await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: {
      sessionId: canonicalSessionId, callLegId, provider: input.provider.provider,
      reconciliationState: 'confirmed', lastError: null,
    } });
    const outboundAction = await createOutboundLedger(prisma, attempt, normalized, {
      requestedSessionId, canonicalSessionId, callLegId, provider: input.provider.provider,
    });
    await metric(prisma, normalized, 'tara_call_start_latency', Date.now() - dispatchStartedAt, 'ms', {
      provider: input.provider.provider, canonical_session_id: canonicalSessionId,
    });
    return { attempt, outboundAction, requestedSessionId, canonicalSessionId, callLegId, provider: input.provider.provider, body };
  }

  return { execute, reconcile, actionKey };
}
