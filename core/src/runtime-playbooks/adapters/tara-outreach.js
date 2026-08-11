import crypto from 'node:crypto';
import { resolveTaraProviderCandidates } from '../../tara/provider-policy.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s()/-]/g, '');
}

function validPhone(value) {
  return /^\+[1-9]\d{6,14}$/.test(normalizePhone(value));
}

function internalBaseUrl() {
  return String(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000').replace(/\/$/, '');
}

function internalKey() {
  return process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
}

async function ownerFor(prisma, context) {
  const room = await prisma.hyperRoom.findFirst({
    where: { id: context.roomId, orgId: context.orgId, archivedAt: null },
    select: { userId: true },
  });
  if (!room?.userId) throw new Error('runtime_tara_room_owner_not_found');
  return room.userId;
}

async function turnFor(prisma, context, briefs) {
  const supplied = briefs.map((artifact) => String(artifact?.data?.room_turn_id || '')).find(Boolean);
  if (supplied) return supplied;
  const turn = await prisma.hyperTurn.findFirst({
    where: { roomId: context.roomId, runtimePlaybookRunId: context.runId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!turn?.id) throw new Error('runtime_tara_room_turn_not_found');
  return turn.id;
}

function rejection(context, artifact, reason, key) {
  return {
    id: artifactId(key, context.runId, context.stageId, artifact?.id || 'unknown'),
    key,
    status: 'REJECTED',
    data: { input_ref: artifact?.id || null, reason: String(reason).slice(0, 1000) },
    source_refs: artifact?.source_refs || [],
    external_ref: null,
  };
}

async function prepare(prisma, input, context) {
  const config = input.config || {};
  const briefs = asArray(input.inputs?.[`artifacts.${config.input_key || 'call_brief'}`]);
  const outputKey = config.output_key || 'call_contract';
  if (!briefs.length) return { artifacts: [], warnings: ['No call briefs were supplied.'] };
  const valid = briefs.filter((artifact) => validPhone(artifact?.data?.phone));
  const rejected = briefs.filter((artifact) => !validPhone(artifact?.data?.phone))
    .map((artifact) => rejection(context, artifact, 'A verified E.164 phone number is required.', outputKey));
  if (!valid.length) return { artifacts: rejected };

  const userId = await ownerFor(prisma, context);
  const turnId = await turnFor(prisma, context, valid);
  const providerPolicy = await resolveTaraProviderCandidates({ prisma, orgId: context.orgId });
  if (!providerPolicy.selected) throw new Error('runtime_tara_outbound_capability_unavailable');
  let campaign = await prisma.outreachCampaign.findFirst({
    where: {
      orgId: context.orgId,
      channel: 'call',
      voiceConfigSnapshot: { path: ['runtime_playbook_run_id'], equals: context.runId },
    },
    include: { targets: { orderBy: { position: 'asc' } } },
  });
  if (!campaign) {
    campaign = await prisma.outreachCampaign.create({
      data: {
        roomId: context.roomId,
        turnId,
        userId,
        orgId: context.orgId,
        channel: 'call',
        status: 'queued',
        voiceConfigSnapshot: {
          runtime_playbook_run_id: context.runId,
          runtime_playbook_stage_id: context.stageId,
          selected_provider: providerPolicy.selected,
          provider_candidates: providerPolicy.candidates.map((candidate) => candidate.provider),
          rejected_providers: providerPolicy.rejected,
        },
        voiceProvider: providerPolicy.selected.provider,
        targets: {
          create: valid.map((artifact, position) => ({
            position,
            company: String(artifact.data?.prospect || artifact.data?.phone || 'Call recipient').slice(0, 300),
            phone: normalizePhone(artifact.data?.phone).slice(0, 40),
            leadId: /^[0-9a-f-]{36}$/i.test(String(artifact.data?.lead_ref || '')) ? artifact.data.lead_ref : null,
            inputContext: {
              notes: artifact.data?.personal_notes || null,
              special_instruction: artifact.data?.instruction || null,
              runtime_call_brief_ref: artifact.id,
            },
            payload: {
              goal: String(artifact.data?.goal || '').slice(0, 300),
              opener: String(artifact.data?.opener || '').slice(0, 400),
              context: String(artifact.data?.context || '').slice(0, 800),
              language: String(artifact.data?.language || 'en').slice(0, 8),
              strategy: String(artifact.data?.strategy || '').slice(0, 200),
              voice_style: String(artifact.data?.voice_style || '').slice(0, 40),
            },
            state: 'ready',
          })),
        },
      },
      include: { targets: { orderBy: { position: 'asc' } } },
    });
  }
  if (!campaign.voiceConfigSnapshot?.selected_provider) {
    campaign = await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: {
        voiceProvider: providerPolicy.selected.provider,
        voiceConfigSnapshot: {
          ...(campaign.voiceConfigSnapshot || {}),
          selected_provider: providerPolicy.selected,
          provider_candidates: providerPolicy.candidates.map((candidate) => candidate.provider),
          rejected_providers: providerPolicy.rejected,
        },
      },
      include: { targets: { orderBy: { position: 'asc' } } },
    });
  }
  const byBrief = new Map(campaign.targets.map((target) => [String(target.inputContext?.runtime_call_brief_ref || ''), target]));
  const artifacts = valid.map((artifact) => {
    const target = byBrief.get(artifact.id);
    if (!target) return rejection(context, artifact, 'The persisted call target could not be reconciled.', outputKey);
    return {
      id: artifactId('call-contract', context.runId, target.id),
      key: outputKey,
      status: 'READY',
      data: {
        input_ref: artifact.id,
        campaign_ref: campaign.id,
        target_ref: target.id,
        phone: target.phone,
        lead_ref: target.leadId || artifact.data?.lead_ref || null,
        verified_email: artifact.data?.verified_email || null,
        prospect: target.company,
        goal: target.payload?.goal || null,
        opener: target.payload?.opener || null,
        strategy: target.payload?.strategy || null,
        language: target.payload?.language || 'en',
        voice_style: target.payload?.voice_style || null,
        provider: campaign.voiceConfigSnapshot?.selected_provider?.provider || campaign.voiceProvider,
        provider_candidates: campaign.voiceConfigSnapshot?.provider_candidates || [],
        rejected_providers: campaign.voiceConfigSnapshot?.rejected_providers || [],
      },
      source_refs: [...new Set([...(artifact.source_refs || []), `outreach-campaign:${campaign.id}`, `outreach-target:${target.id}`])],
      external_ref: target.id,
    };
  });
  return { artifacts: [...artifacts, ...rejected] };
}

async function startCampaign(campaignRef, context, { fetchImpl, baseUrl, apiKey }) {
  const response = await fetchImpl(`${baseUrl}/internal/hyper/outreach/runtime-call/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      campaign_id: campaignRef,
      run_id: context.runId,
      stage_id: context.stageId,
      org_id: context.orgId,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(String(body?.error || `runtime_tara_start_http_${response.status}`));
    error.status = response.status;
    throw error;
  }
  return body;
}

async function deliver(input, context, transport) {
  const config = input.config || {};
  const contracts = asArray(input.inputs?.[`artifacts.${config.input_key || 'call_contract'}`]);
  const outputKey = config.output_key || 'call_receipt';
  const rejectionKey = config.rejection_key || 'call_rejection';
  const uncertainKey = config.uncertain_key || 'call_uncertain';
  const artifacts = [];
  if (contracts.length > 1) {
    return {
      artifacts: contracts.map((contract) => ({
        ...rejection(context, contract, 'This exact-call lifecycle accepts one recipient. Use an Outreach call campaign for a governed serial batch.', rejectionKey),
        key: rejectionKey,
      })),
      warnings: ['The exact-call lifecycle did not dial because more than one recipient was supplied.'],
    };
  }
  for (const contract of contracts) {
    try {
      const result = await startCampaign(contract?.data?.campaign_ref, context, transport);
      const target = result?.target;
      const sessionId = String(target?.resultRef?.sessionId || '').trim();
      const providerReceipt = String(target?.resultRef?.taraCallLegId || '').trim();
      if (!sessionId || !providerReceipt) throw new Error('runtime_tara_provider_receipt_missing');
      artifacts.push({
        id: artifactId('call-receipt', context.runId, target.id, providerReceipt),
        key: outputKey,
        status: 'READY',
        data: {
          input_ref: contract.id,
          campaign_ref: contract.data?.campaign_ref,
          target_ref: target.id,
          provider_receipt_id: providerReceipt,
          correlation_ref: sessionId,
          status: 'dialing',
          external_action_marker: {
            id: `tara-call:${providerReceipt}`,
            presentation_type: 'call',
            provider: 'tara',
            channel: 'voice',
            status: 'dialing',
            headline: 'Your TARA outreach call has started.',
            note: `TARA is calling ${contract?.data?.prospect || contract?.data?.name || contract?.data?.phone || 'the selected contact'}.`,
            payload: {
              prospect: contract?.data?.prospect || contract?.data?.name || null,
              phone: contract?.data?.phone || contract?.data?.recipient || null,
              goal: contract?.data?.goal || contract?.data?.objective || null,
              opener: contract?.data?.opener || null,
              strategy: contract?.data?.strategy || null,
              session_id: sessionId,
              provider_receipt_id: providerReceipt,
            },
          },
        },
        source_refs: [...new Set([...(contract.source_refs || []), `tara-session:${sessionId}`, `tara-call-leg:${providerReceipt}`])],
        external_ref: providerReceipt,
      });
    } catch (error) {
      const status = Number(error?.status || 0);
      const deterministic = status >= 400 && status < 500;
      artifacts.push({
        ...rejection(context, contract, error?.message || error, deterministic ? rejectionKey : uncertainKey),
        key: deterministic ? rejectionKey : uncertainKey,
        status: deterministic ? 'REJECTED' : 'UNCERTAIN',
      });
    }
  }
  return { artifacts };
}

async function monitor(input, context) {
  const config = input.config || {};
  const receipts = asArray(input.inputs?.[`artifacts.${config.input_key || 'call_receipt'}`]);
  const outputKey = config.output_key || 'call_subscription';
  return {
    artifacts: receipts.map((receipt) => ({
      id: artifactId('call-subscription', context.runId, receipt.id),
      key: outputKey,
      status: 'READY',
      data: {
        input_ref: receipt.id,
        campaign_ref: receipt.data?.campaign_ref || null,
        target_ref: receipt.data?.target_ref || null,
        correlation_ref: receipt.data?.correlation_ref || null,
      },
      source_refs: receipt.source_refs || [],
      external_ref: receipt.data?.correlation_ref || null,
    })),
  };
}

export function createTaraOutreachRuntimeAdapter({
  prisma,
  fetchImpl = fetch,
  baseUrl = internalBaseUrl(),
  apiKey = internalKey(),
} = {}) {
  if (!prisma) throw new Error('runtime_tara_adapter_prisma_required');
  const transport = { fetchImpl, baseUrl: String(baseUrl).replace(/\/$/, ''), apiKey };
  return {
    id: 'tara-outreach',
    name: 'TARA outreach calls',
    description: 'Persists governed call contracts and executes them through the existing serial Outreach and TARA call runner.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const action = String(input?.config?.action || '').trim();
      if (action === 'prepare') return prepare(prisma, input, context);
      if (action === 'deliver') return deliver(input, context, transport);
      throw new Error(`runtime_tara_adapter_action_unsupported:${action}`);
    },
    async monitor(input, context) {
      return monitor(input, context);
    },
  };
}
