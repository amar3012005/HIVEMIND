import { getCampaignCapabilities } from './capabilities.js';
import { approveCampaign, approveCampaignAction, controlCampaign, createCampaign, editCampaignAction, getCampaign, listCampaigns, reconcileCampaignAction, regenerateCampaign, retryCampaignAction, syncCampaignMetrics } from './service.js';
import { dispatchCampaignRoomSafely } from './dispatcher.js';
import { processDueCampaignActions } from './worker.js';
import { campaignWorkerEnabled } from './state.js';

function sendError(res, jsonResponse, error) {
  return jsonResponse(res, { error: error.code || 'campaign_error', message: error.message }, error.status || 500);
}

async function audit(prisma, auditLogger, { userId, orgId, action, campaignId, metadata = {}, platformType = 'dashboard' }) {
  const event = {
    userId, organizationId: orgId, eventType: `campaign.${action}`,
    eventCategory: 'data_modification', resourceType: 'campaign', resourceId: campaignId,
    action, actorType: 'user', platformType, metadata: { campaign_id: campaignId, ...metadata },
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
        dispatchCampaignRoomSafely({ prisma, campaignId: result.campaign.id, dispatch: result.dispatch }).catch(() => {});
      }
      if (result.created) await audit(prisma, auditLogger, {
        userId, orgId, action: 'created', campaignId: result.campaign.id,
        platformType: body?.trigger_surface === 'hyperagents' ? 'hyperagents' : 'dashboard',
        metadata: body?.trigger_surface === 'hyperagents' ? {
          source_room_id: body?.source_room_id || null,
          source_turn_id: body?.source_turn_id || null,
          tool: true,
        } : {},
      });
      return jsonResponse(res, { campaign: result.campaign, created: result.created }, result.created ? 201 : 200);
    }
    const match = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})$/i);
    if (match && method === 'GET') return jsonResponse(res, { campaign: await getCampaign({ prisma, orgId, id: match[1] }) });
    const regenerateMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/regenerate$/i);
    if (regenerateMatch && method === 'POST') {
      const result = await regenerateCampaign({ prisma, orgId, userId, id: regenerateMatch[1], feedback: body?.feedback });
      await audit(prisma, auditLogger, { userId, orgId, action: 'regenerated', campaignId: result.campaignId });
      dispatchCampaignRoomSafely({ prisma, campaignId: result.campaignId, dispatch: result.dispatch }).catch(() => {});
      return jsonResponse(res, { campaignId: result.campaignId, status: 'GENERATING' }, 202);
    }
    const actionMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/(approve|launch|pause|resume|sync)$/i);
    if (actionMatch && method === 'POST') {
      const id = actionMatch[1]; const action = actionMatch[2].toLowerCase();
      if (action === 'sync') {
        const campaign = await syncCampaignMetrics({ prisma, orgId, userId, id });
        await audit(prisma, auditLogger, { userId, orgId, action: 'metrics_synced', campaignId: id });
        return jsonResponse(res, { campaign });
      }
      if (['approve', 'launch'].includes(action)) {
        const result = await approveCampaign({ prisma, orgId, userId, id });
        await audit(prisma, auditLogger, { userId, orgId, action: action === 'launch' ? 'launched' : 'approved', campaignId: id, metadata: { approval_id: result.approval.id, launched_at: result.launch.launched_at } });
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
