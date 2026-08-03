import { evaluateGate } from '../../tara/compliance-gate.js';
import { assertTransition } from '../../tara/call-attempt-state.js';
import { createTaraOutboundCallService } from '../../tara/outbound-call-service.js';
import { resolveTaraProviderCandidates } from '../../tara/provider-policy.js';
import { CampaignAdapterError, publicProviderResponse, requireApproval, requireValue } from './contract.js';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

async function transition(prisma, attempt, next, data = {}) {
  assertTransition(attempt.status, next);
  const updated = await prisma.taraCallAttempt.update({ where: { id: attempt.id }, data: { status: next, ...data } });
  Object.assign(attempt, updated);
  return attempt;
}

async function countCalls(prisma, orgId) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const [concurrency, todayCount] = await Promise.all([
    prisma.taraCallAttempt.count({ where: { orgId, status: { in: ['dialing', 'connected'] } } }),
    prisma.taraCallAttempt.count({ where: { orgId, startedAt: { gte: since } } }),
  ]);
  return { concurrency, todayCount };
}

function validateTaraAction(action) {
  const payload = action?.payload || {};
  const to = requireValue(payload.to, 'TARA recipient is required', 'tara_recipient_required');
  if (!E164_RE.test(to)) throw new CampaignAdapterError('TARA recipient must use E.164 format', { code: 'tara_recipient_invalid', outcome: 'BLOCKED' });
  const opening = requireValue(payload.opening, 'TARA requires a speak-first opening', 'tara_opening_required');
  const lawfulBasis = requireValue(payload.lawful_basis, 'TARA requires a lawful basis', 'tara_lawful_basis_required');
  const country = requireValue(payload.country, 'TARA requires an ISO country', 'tara_country_required').toUpperCase();
  if (!COUNTRY_RE.test(country)) throw new CampaignAdapterError('TARA country must be ISO 3166-1 alpha-2', { code: 'tara_country_invalid', outcome: 'BLOCKED' });
  const timezone = requireValue(payload.timezone, 'TARA requires the contact timezone', 'tara_timezone_required');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch {
    throw new CampaignAdapterError('TARA contact timezone must be a valid IANA timezone', { code: 'tara_timezone_invalid', outcome: 'BLOCKED' });
  }
  return { to, opening, lawfulBasis, country, timezone };
}

export const taraAdapter = {
  channel: 'tara',
  async checkCapability({ prisma, action }) {
    const policy = await resolveTaraProviderCandidates({ prisma, orgId: action.campaign.orgId });
    if (!policy.selected) throw new CampaignAdapterError('No governed TARA provider is currently available', { code: 'tara_runtime_inactive', outcome: 'BLOCKED', details: { rejected_providers: policy.rejected } });
    return { connected: true, selected_provider: policy.selected.provider, candidates: policy.candidates.map((candidate) => candidate.provider) };
  },
  validateAction({ action }) { validateTaraAction(action); return { valid: true }; },
  async execute({ prisma, action, approval, providers = {}, executionAttempt = 1 }) {
    requireApproval(action, approval);
    const payload = action.payload || {};
    const { to, opening, lawfulBasis, country, timezone } = validateTaraAction(action);

    const runtime = await prisma.taraRuntimeConfig.findUnique({ where: { orgId: action.campaign.orgId } });
    const providerPolicy = await resolveTaraProviderCandidates({ prisma, orgId: action.campaign.orgId, fetchImpl: providers.fetch || fetch });
    if (!providerPolicy.selected) throw new CampaignAdapterError('No governed TARA provider is currently available', {
      code: 'tara_provider_unavailable', outcome: 'BLOCKED', details: { rejected_providers: providerPolicy.rejected },
    });
    const authorityProvider = String(payload.provider || '').trim() || null;
    const selected = authorityProvider
      ? providerPolicy.candidates.find((candidate) => candidate.provider === authorityProvider)
      : providerPolicy.selected;
    if (!selected) throw new CampaignAdapterError('The authority-approved TARA provider is unavailable; refresh the immutable action before retrying', {
      code: 'tara_provider_change_requires_reauthorization', outcome: 'BLOCKED',
      details: { approved_provider: authorityProvider, candidates: providerPolicy.candidates.map((candidate) => candidate.provider) },
    });
    const { provider, baseUrl } = selected;
    const callingWindow = payload.calling_window && typeof payload.calling_window === 'object'
      ? payload.calling_window : { tz: timezone, days: [1, 2, 3, 4, 5], startHour: 9, endHour: 20 };
    const taraCampaign = await prisma.taraCampaign.upsert({
      where: { id: (await prisma.taraCampaign.findFirst({ where: { unifiedCampaignId: action.campaignId, orgId: action.campaign.orgId }, select: { id: true } }))?.id || action.campaignId },
      create: {
        orgId: action.campaign.orgId, userId: action.campaign.ownerUserId, unifiedCampaignId: action.campaignId,
        name: action.campaign.name.slice(0, 200), status: 'active', provider,
        configSnapshot: { revision: runtime?.revision || 1, selected_provider: provider, provider_candidates: providerPolicy.candidates.map((candidate) => candidate.provider), rejected_providers: providerPolicy.rejected }, goal: action.campaign.goal,
        callingWindow, caps: payload.caps || { concurrency: 1, dailyMax: 25 },
        complianceConfig: payload.compliance_config || {},
      },
      update: { status: 'active', provider, configSnapshot: { revision: runtime?.revision || 1, selected_provider: provider, provider_candidates: providerPolicy.candidates.map((candidate) => candidate.provider), rejected_providers: providerPolicy.rejected } },
    });
    const contact = await prisma.taraCampaignContact.upsert({
      where: { campaignId_phone: { campaignId: taraCampaign.id, phone: to } },
      create: {
        campaignId: taraCampaign.id, orgId: action.campaign.orgId, userId: action.campaign.ownerUserId,
        phone: to, displayName: payload.recipient_name || null, company: payload.company || null,
        country, timezone, lawfulBasis, metadata: { campaign_action_id: action.id },
      },
      update: { displayName: payload.recipient_name || null, company: payload.company || null, country, timezone, lawfulBasis },
    });
    const actionKey = `campaign:${action.id}:${executionAttempt}`;
    let attempt = await prisma.taraCallAttempt.upsert({
      where: { actionKey },
      create: {
        campaignId: taraCampaign.id, contactId: contact.id, orgId: action.campaign.orgId,
        userId: action.campaign.ownerUserId, provider, actionKey, attemptNo: executionAttempt,
        scheduledAt: action.scheduledAt, providerCandidates: providerPolicy.candidates.map((candidate) => candidate.provider),
        configSnapshot: { revision: runtime?.revision || 1, selected_provider: provider, rejected_providers: providerPolicy.rejected },
      },
      update: {},
    });
    if (attempt.callLegId || attempt.sessionId) {
      return { externalId: attempt.callLegId || attempt.sessionId, response: { provider, session_id: attempt.sessionId, deduplicated: true } };
    }
    if (attempt.status !== 'queued') throw new CampaignAdapterError(`TARA attempt is already ${attempt.status}`, { code: 'tara_attempt_not_retryable', outcome: 'NEEDS_RECONCILIATION' });

    const [dncRows, counts] = await Promise.all([
      prisma.dncList.findMany({ where: { orgId: action.campaign.orgId }, select: { phone: true } }),
      countCalls(prisma, action.campaign.orgId),
    ]);
    const gate = evaluateGate({ contact, campaign: taraCampaign, dncSet: new Set(dncRows.map((row) => row.phone)), ...counts, now: providers.now || new Date() });
    attempt = await transition(prisma, attempt, 'gated', { gateResult: gate });
    if (!gate.allow) {
      await transition(prisma, attempt, 'skipped');
      await prisma.taraCampaignContact.update({ where: { id: contact.id }, data: { status: 'skipped' } });
      throw new CampaignAdapterError(`TARA compliance gate blocked the call: ${gate.reason}`, {
        code: `tara_gate_${gate.stage}`, outcome: 'BLOCKED', details: gate,
      });
    }

    const providerFetch = providers.fetch || fetch;
    const capability = await providerFetch(`${baseUrl}/capabilities`, { signal: AbortSignal.timeout(5000) }).then((res) => res.ok ? res.json() : null).catch(() => null);
    if (capability && capability.telephony === false) {
      await transition(prisma, attempt, 'skipped');
      throw new CampaignAdapterError('The selected TARA provider requires this call to be started in the browser', { code: 'browser_required', outcome: 'BLOCKED' });
    }
    const outboundCalls = createTaraOutboundCallService({ prisma, fetchImpl: providerFetch });
    const receipt = await outboundCalls.execute({
      actionKey,
      attemptNo: executionAttempt,
      executionRef: action.campaignId,
      source: 'campaigns_v2',
      orgId: action.campaign.orgId,
      userId: action.campaign.ownerUserId,
      roomId: action.campaign.roomId || null,
      campaignId: action.campaignId,
      campaignActionId: action.id,
      authorityRef: approval.id,
      campaignName: action.campaign.name,
      recipientName: payload.recipient_name || null,
      recipientCompany: payload.company || null,
      to,
      goal: payload.goal || action.campaign.goal,
      country,
      timezone,
      lawfulBasis,
      callingWindow,
      caps: payload.caps || { concurrency: 1, dailyMax: 25 },
      complianceConfig: payload.compliance_config || {},
      provider: { provider, baseUrl, revision: runtime?.revision || 1 },
      providerCandidates: providerPolicy.candidates.map((candidate) => candidate.provider),
      configSnapshot: { revision: runtime?.revision || 1, gate },
      headers: { 'Content-Type': 'application/json', ...(process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}) },
      providerPayload: {
        user_id: action.campaign.ownerUserId,
        org_id: action.campaign.orgId,
        goal: [payload.goal || action.campaign.goal, `Open with: ${opening}`, payload.strategy ? `Strategy: ${payload.strategy}` : null].filter(Boolean).join('. ').slice(0, 600),
        context: String(payload.context || '').slice(0, 800) || undefined,
        language: String(payload.language || 'en').slice(0, 8),
        provider,
        config_revision: runtime?.revision || 1,
      },
    });
    return {
      externalId: receipt.callLegId || receipt.canonicalSessionId,
      response: publicProviderResponse({
        ...(receipt.body || {}), provider: receipt.provider,
        session_id: receipt.canonicalSessionId,
        requested_session_id: receipt.requestedSessionId,
        tara_call_attempt_id: receipt.attempt?.id,
        deduplicated: receipt.deduplicated === true,
      }),
    };
  },
  async reconcile({ prisma, action }) {
    const attempt = await prisma.taraCallAttempt.findFirst({ where: { actionKey: { startsWith: `campaign:${action.id}:` } }, orderBy: { createdAt: 'desc' } });
    const ledger = await prisma.outboundAction.findFirst({ where: { campaignActionId: action.id, status: 'sent' }, orderBy: { sentAt: 'desc' } });
    if (attempt?.callLegId && ledger) return { status: 'SUCCEEDED', externalId: attempt.callLegId, response: { provider: attempt.provider, session_id: attempt.sessionId, requested_session_id: attempt.requestedSessionId, source: 'call_attempt_and_outbound_ledger' } };
    return { status: 'NEEDS_RECONCILIATION', reason: attempt?.sessionId
      ? 'A TARA session was reserved but no confirmed call-leg and outbound ledger entry exist; inspect provider state before retrying.'
      : 'No TARA session or call-leg ID was recorded.' };
  },
  async pause() { return { status: 'PAUSED', scope: 'scheduler', provider_mutation: false }; },
  async captureBaseline({ prisma, campaign }) {
    const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const calls = await prisma.outboundAction.count({ where: { orgId: campaign.orgId, channel: 'call', status: 'sent', sentAt: { gte: since } } });
    const completed = await prisma.outboundAction.count({ where: { orgId: campaign.orgId, channel: 'call', outcome: 'completed', sentAt: { gte: since } } });
    return { preceding_28d_calls: calls, preceding_28d_completed: completed, captured_at: new Date().toISOString() };
  },
  async syncMetrics({ prisma, action }) {
    const [rows, attempts] = await Promise.all([
      prisma.outboundAction.findMany({ where: { campaignActionId: action.id, channel: 'call' } }),
      prisma.taraCallAttempt.findMany({ where: { actionKey: { startsWith: `campaign:${action.id}:` } } }),
    ]);
    return {
      calls: rows.filter((row) => row.status === 'sent').length,
      completed: rows.filter((row) => row.outcome === 'completed').length,
      booked: rows.filter((row) => row.outcome === 'booked').length,
      no_answer: rows.filter((row) => row.outcome === 'no_answer').length,
      attempts: attempts.length,
      blocked: attempts.filter((row) => row.status === 'skipped').length,
      captured_at: new Date().toISOString(),
    };
  },
};
