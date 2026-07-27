import { getCampaignCapabilities } from './capabilities.js';
import { approveCampaign, approveCampaignAction, controlCampaign, createCampaign, deleteCampaign, editCampaignAction, getCampaign, getCampaignSettings, listCampaigns, reconcileCampaignAction, regenerateCampaign, retryCampaignAction, syncCampaignMetrics, updateCampaignSettings } from './service.js';
import { dispatchCampaignRoomSafely } from './dispatcher.js';
import { processDueCampaignActions } from './worker.js';
import { campaignWorkerEnabled } from './state.js';
import {
  deleteCampaignAsset, enqueueCampaignImages, getCampaignAssetContent, MAX_UPLOAD_BYTES,
  selectCampaignAsset, uploadCampaignAsset,
} from './image-service.js';

function sendError(res, jsonResponse, error) {
  return jsonResponse(res, { error: error.code || 'campaign_error', message: error.message, ...(error.details != null ? { details: error.details } : {}) }, error.status || 500);
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

async function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES + 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Campaign image upload is too large'), { status: 413, code: 'campaign_asset_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function multipartImage(req, raw) {
  const type = String(req.headers['content-type'] || '');
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw Object.assign(new Error('A multipart upload boundary is required'), { status: 400, code: 'campaign_asset_upload_invalid' });
  const marker = Buffer.from(`--${boundary}`); const fields = {}; let file = null; let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(marker, cursor); if (start < 0) break;
    const next = raw.indexOf(marker, start + marker.length); if (next < 0) break;
    let part = raw.subarray(start + marker.length, next);
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8'); const data = part.subarray(headerEnd + 4);
      const name = headers.match(/name="([^"]+)"/i)?.[1]; const filename = headers.match(/filename="([^"]*)"/i)?.[1];
      const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase();
      if (name === 'image' && filename !== undefined) file = { bytes: data, filename, contentType };
      else if (name) fields[name] = data.toString('utf8');
    }
    cursor = next;
  }
  if (!file) throw Object.assign(new Error('The image file is required'), { status: 400, code: 'campaign_asset_upload_invalid' });
  return { ...file, altText: fields.alt_text || '' };
}

export async function handleCampaignRequest({ pathname, method, body, req, res, prisma, userId, orgId, jsonResponse, auditLogger }) {
  try {
    if (pathname === '/api/campaigns/capabilities' && method === 'GET') {
      return jsonResponse(res, await getCampaignCapabilities({ prisma, userId, orgId }));
    }
    if (pathname === '/api/campaigns/settings' && method === 'GET') {
      return jsonResponse(res, await getCampaignSettings({ prisma, orgId }));
    }
    if (pathname === '/api/campaigns/settings' && method === 'PATCH') {
      const settings = await updateCampaignSettings({ prisma, orgId, userId, autonomyMode: body?.autonomy_mode });
      await audit(prisma, auditLogger, { userId, orgId, action: 'autonomy_changed', campaignId: null, metadata: settings });
      return jsonResponse(res, settings);
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
    if (match && method === 'GET') return jsonResponse(res, { campaign: await getCampaign({ prisma, orgId, userId, id: match[1] }) });
    if (match && method === 'DELETE') {
      const result = await deleteCampaign({ prisma, orgId, userId, id: match[1] });
      await audit(prisma, auditLogger, { userId, orgId, action: 'deleted', campaignId: match[1], metadata: { soft_delete: true } });
      return jsonResponse(res, result);
    }
    const assetContentMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})\/content$/i);
    if (assetContentMatch && method === 'GET') {
      const result = await getCampaignAssetContent({ prisma, orgId, campaignId: assetContentMatch[1], assetId: assetContentMatch[2] });
      res.writeHead(200, { 'Content-Type': result.asset.contentType || 'application/octet-stream', 'Content-Length': result.bytes.length, 'Cache-Control': 'private, max-age=300', ETag: `"${result.asset.contentHash}"` });
      res.end(result.bytes); return;
    }
    const assetGenerateMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/assets\/generate$/i);
    if (assetGenerateMatch && method === 'POST') {
      const result = await enqueueCampaignImages({ prisma, orgId, userId, campaignId: assetGenerateMatch[1], actionId: assetGenerateMatch[2], creativeBrief: body?.creative_brief, variantCount: body?.variant_count });
      await audit(prisma, auditLogger, { userId, orgId, action: 'asset_generation_queued', campaignId: assetGenerateMatch[1], metadata: { action_id: assetGenerateMatch[2], asset_ids: result.assets.map((asset) => asset.id) } });
      return jsonResponse(res, result, result.queued ? 202 : 200);
    }
    const assetUploadMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/assets\/upload$/i);
    if (assetUploadMatch && method === 'POST') {
      const upload = multipartImage(req, await readRawBody(req));
      const asset = await uploadCampaignAsset({ prisma, orgId, userId, campaignId: assetUploadMatch[1], actionId: assetUploadMatch[2], bytes: upload.bytes, contentType: upload.contentType, filename: upload.filename, altText: upload.altText });
      await audit(prisma, auditLogger, { userId, orgId, action: 'asset_uploaded', campaignId: assetUploadMatch[1], metadata: { action_id: assetUploadMatch[2], asset_id: asset.id } });
      return jsonResponse(res, { asset }, 201);
    }
    const assetControlMatch = pathname.match(/^\/api\/campaigns\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})$/i);
    if (assetControlMatch && method === 'POST') {
      const asset = await selectCampaignAsset({ prisma, orgId, userId, campaignId: assetControlMatch[1], actionId: assetControlMatch[2], assetId: assetControlMatch[3] });
      await audit(prisma, auditLogger, { userId, orgId, action: 'asset_selected', campaignId: assetControlMatch[1], metadata: { action_id: assetControlMatch[2], asset_id: asset.id } });
      return jsonResponse(res, { asset });
    }
    if (assetControlMatch && method === 'DELETE') {
      const result = await deleteCampaignAsset({ prisma, orgId, userId, campaignId: assetControlMatch[1], actionId: assetControlMatch[2], assetId: assetControlMatch[3] });
      await audit(prisma, auditLogger, { userId, orgId, action: 'asset_removed', campaignId: assetControlMatch[1], metadata: { action_id: assetControlMatch[2], asset_id: assetControlMatch[3] } });
      return jsonResponse(res, result);
    }
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
