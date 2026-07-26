import { getCampaignCapabilities } from './capabilities.js';
import { approveCampaign, approveCampaignAction, controlCampaign, createCampaign, editCampaignAction, getCampaign, listCampaigns, reconcileCampaignAction, regenerateCampaign, retryCampaignAction, syncCampaignMetrics } from './service.js';
import { processDueCampaignActions } from './worker.js';
import { campaignWorkerEnabled } from './state.js';

function sendError(res, jsonResponse, error) {
  return jsonResponse(res, { error: error.code || 'campaign_error', message: error.message }, error.status || 500);
}

async function dispatchRoom(dispatch) {
  const base = process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
  const key = process.env.HIVEMIND_MASTER_API_KEY;
  if (!key) throw Object.assign(new Error('Campaign room dispatcher is not configured'), { status: 503, code: 'campaign_dispatch_unavailable' });
  const response = await fetch(`${base}/internal/hyper/room-turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(dispatch),
  });
  if (!response.ok) throw Object.assign(new Error(`Campaign room dispatch failed (${response.status})`), {
    status: 502, code: 'campaign_dispatch_failed', definitive: true,
  });
}

async function audit(prisma, auditLogger, { userId, orgId, action, campaignId, metadata = {} }) {
  const event = {
    userId, organizationId: orgId, eventType: `campaign.${action}`,
    eventCategory: 'data_modification', resourceType: 'campaign', resourceId: campaignId,
    action, actorType: 'user', platformType: 'dashboard', metadata: { campaign_id: campaignId, ...metadata },
  };
  if (auditLogger?.log) return auditLogger.log(event);
  return prisma.auditLog.create({ data: event }).catch(() => {});
}

export async function handleCampaignRequest({ pathname, method, body, res, prisma, userId, orgId, jsonResponse, auditLogger }) {
  try {
    if (pathname === '/api/campaigns/capabilities' && method === 'GET') {
      return jsonResponse(res, await getCampaignCapabilities({ prisma, userId, orgId }));
    }
    if (pathname === '/api/campaigns' && method === 'GET') {
      return jsonResponse(res, { campaigns: await listCampaigns({ prisma, orgId }) });
    }
    if (pathname === '/api/campaigns' && method === 'POST') {
      const result = await createCampaign({ prisma, userId, orgId, body });
      if (result.dispatch) {
        dispatchRoom(result.dispatch).catch(async (error) => {
          const { handleCampaignDispatchError } = await import('./pipeline.js');
          await handleCampaignDispatchError({ prisma, campaignId: result.campaign.id, error }).catch(() => {});
        });
      }
      if (result.created) await audit(prisma, auditLogger, { userId, orgId, action: 'created', campaignId: result.campaign.id });
      return jsonResponse(res, { campaign: result.campaign, created: result.created }, result.created ? 201 : 200);
    }
    const match = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})$/i);
    if (match && method === 'GET') return jsonResponse(res, { campaign: await getCampaign({ prisma, orgId, id: match[1] }) });
    const regenerateMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/regenerate$/i);
    if (regenerateMatch && method === 'POST') {
      const result = await regenerateCampaign({ prisma, orgId, userId, id: regenerateMatch[1], feedback: body?.feedback });
      await audit(prisma, auditLogger, { userId, orgId, action: 'regenerated', campaignId: result.campaignId });
      dispatchRoom(result.dispatch).catch(async (error) => {
        const { handleCampaignDispatchError } = await import('./pipeline.js');
        await handleCampaignDispatchError({ prisma, campaignId: result.campaignId, error }).catch(() => {});
      });
      return jsonResponse(res, { campaignId: result.campaignId, status: 'GENERATING' }, 202);
    }
    const actionMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/(approve|pause|resume|sync)$/i);
    if (actionMatch && method === 'POST') {
      const id = actionMatch[1]; const action = actionMatch[2].toLowerCase();
      if (action === 'sync') {
        const campaign = await syncCampaignMetrics({ prisma, orgId, userId, id });
        await audit(prisma, auditLogger, { userId, orgId, action: 'metrics_synced', campaignId: id });
        return jsonResponse(res, { campaign });
      }
      if (action === 'approve') {
        const result = await approveCampaign({ prisma, orgId, userId, id });
        await audit(prisma, auditLogger, { userId, orgId, action: 'approved', campaignId: id, metadata: { approval_id: result.approval.id } });
        if (campaignWorkerEnabled()) processDueCampaignActions({ prisma, campaignId: id }).catch(() => {});
        return jsonResponse(res, result);
      }
      const campaign = await controlCampaign({ prisma, orgId, userId, id, action });
      await audit(prisma, auditLogger, { userId, orgId, action, campaignId: id });
      if (action === 'resume' && campaignWorkerEnabled()) processDueCampaignActions({ prisma, campaignId: id }).catch(() => {});
      return jsonResponse(res, { campaign });
    }
    const actionApprovalMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/approve$/i);
    if (actionApprovalMatch && method === 'POST') {
      const result = await approveCampaignAction({ prisma, orgId, userId, id: actionApprovalMatch[1], actionId: actionApprovalMatch[2] });
      await audit(prisma, auditLogger, { userId, orgId, action: 'action_approved', campaignId: result.campaignId, metadata: { action_id: result.actionId } });
      if (campaignWorkerEnabled()) processDueCampaignActions({ prisma, campaignId: result.campaignId }).catch(() => {});
      return jsonResponse(res, result);
    }
    const actionEditMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})$/i);
    if (actionEditMatch && ['PATCH', 'DELETE'].includes(method)) {
      const result = await editCampaignAction({ prisma, orgId, userId, id: actionEditMatch[1], actionId: actionEditMatch[2], body: method === 'DELETE' ? { remove: true } : body });
      await audit(prisma, auditLogger, { userId, orgId, action: result.removed ? 'action_removed' : 'action_edited', campaignId: result.campaignId, metadata: { action_id: result.actionId, plan_version_id: result.planVersionId } });
      return jsonResponse(res, result);
    }
    const actionControlMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/(retry|reconcile)$/i);
    if (actionControlMatch && method === 'POST') {
      const [, id, actionId, command] = actionControlMatch;
      const result = command.toLowerCase() === 'retry'
        ? await retryCampaignAction({ prisma, orgId, userId, id, actionId })
        : await reconcileCampaignAction({ prisma, orgId, userId, id, actionId });
      await audit(prisma, auditLogger, { userId, orgId, action: `action_${command.toLowerCase()}`, campaignId: id, metadata: { action_id: actionId, result_status: result.status } });
      if (command.toLowerCase() === 'retry' && campaignWorkerEnabled()) processDueCampaignActions({ prisma, campaignId: id }).catch(() => {});
      return jsonResponse(res, result);
    }
    return jsonResponse(res, { error: 'not_found', message: 'Campaign route not found' }, 404);
  } catch (error) {
    return sendError(res, jsonResponse, error);
  }
}
