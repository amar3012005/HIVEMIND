import crypto from 'node:crypto';
import { getConnectorRuntime } from '../connectors/runtime/index.js';
import {
  createCampaign, getCampaign, getStatus, listAccounts, listCampaigns,
  listFundingInstruments, normalizeServiceError, prepareCampaign, searchTargets,
  syncCampaign, updateCampaign, uploadCampaignImage,
} from './service.js';

function jsonResult(result) {
  return result?.content?.find((item) => item.type === 'json')?.data || null;
}

async function audit(prisma, auditLogger, { userId, orgId, action, campaignId, metadata = {} }) {
  const event = {
    userId, organizationId: orgId, eventType: `x_ads.${action}`,
    eventCategory: 'data_modification', resourceType: 'x_ads_campaign',
    resourceId: campaignId || null, action, actorType: 'user', platformType: 'dashboard',
    metadata: { campaign_id: campaignId || null, ...metadata },
  };
  if (auditLogger?.log) return auditLogger.log(event);
  await prisma.auditLog.create({ data: event }).catch(() => {});
}

export async function handleXAdsRequest({ pathname, method, body, url, req, res, prisma, userId, orgId, jsonResponse, parseMultipart, auditLogger }) {
  if (!pathname.startsWith('/api/x-ads/')) return false;
  try {
    if (pathname === '/api/x-ads/status' && method === 'GET') return jsonResponse(res, await getStatus({ prisma, userId, orgId }));
    if (pathname === '/api/x-ads/accounts' && method === 'GET') return jsonResponse(res, await listAccounts({ prisma, userId, orgId }));

    let match = pathname.match(/^\/api\/x-ads\/accounts\/([^/]+)\/funding-instruments$/);
    if (match && method === 'GET') return jsonResponse(res, await listFundingInstruments({ prisma, userId, orgId, accountId: match[1] }));

    match = pathname.match(/^\/api\/x-ads\/targeting\/(locations|languages)$/);
    if (match && method === 'GET') return jsonResponse(res, await searchTargets({
      prisma, userId, orgId, type: match[1], query: url.searchParams.get('q') || '',
      countryCode: url.searchParams.get('country_code') || '', locationType: url.searchParams.get('location_type') || '',
    }));

    if (pathname === '/api/x-ads/campaigns') {
      if (method === 'GET') return jsonResponse(res, await listCampaigns({ prisma, orgId }));
      if (method === 'POST') {
        const campaign = await createCampaign({ prisma, userId, orgId, input: body || {} });
        await audit(prisma, auditLogger, { userId, orgId, action: 'draft_created', campaignId: campaign.id });
        return jsonResponse(res, { campaign }, 201);
      }
    }

    match = pathname.match(/^\/api\/x-ads\/campaigns\/([0-9a-f-]{36})$/i);
    if (match) {
      if (method === 'GET') return jsonResponse(res, { campaign: await getCampaign({ prisma, orgId, id: match[1] }) });
      if (method === 'PATCH') {
        const campaign = await updateCampaign({ prisma, userId, orgId, id: match[1], input: body || {} });
        await audit(prisma, auditLogger, { userId, orgId, action: 'draft_updated', campaignId: match[1], metadata: {
          draft_version: campaign.draft_version, daily_budget_micros: campaign.daily_budget_micros,
          total_budget_micros: campaign.total_budget_micros, currency: campaign.account?.currency,
        } });
        return jsonResponse(res, { campaign });
      }
    }

    match = pathname.match(/^\/api\/x-ads\/campaigns\/([0-9a-f-]{36})\/(image|prepare|publish|pause|resume|sync)$/i);
    if (match) {
      const [, id, action] = match;
      if (method !== 'POST') return jsonResponse(res, { error: 'method_not_allowed' }, 405);
      if (action === 'image') {
        const contentType = req.headers['content-type'] || '';
        const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
        if (!boundary) return jsonResponse(res, { error: 'multipart_boundary_required' }, 400);
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 6 * 1024 * 1024) return jsonResponse(res, { error: 'image_too_large' }, 413);
          chunks.push(chunk);
        }
        const file = parseMultipart(Buffer.concat(chunks), boundary).find((part) => part.name === 'image' && part.filename);
        const campaign = await uploadCampaignImage({ prisma, orgId, id, file });
        await audit(prisma, auditLogger, { userId, orgId, action: 'image_uploaded', campaignId: id, metadata: { content_type: file?.contentType, bytes: file?.data?.length } });
        return jsonResponse(res, { campaign });
      }
      if (action === 'prepare') {
        const prepared = await prepareCampaign({ prisma, userId, orgId, id });
        await audit(prisma, auditLogger, { userId, orgId, action: 'confirmed_preview_created', campaignId: id, metadata: {
          daily_budget_micros: prepared.summary.daily_budget_micros,
          total_budget_micros: prepared.summary.total_budget_micros,
          currency: prepared.summary.currency,
          draft_version: prepared.summary.draft_version,
        } });
        return jsonResponse(res, prepared);
      }
      if (action === 'sync') {
        const campaign = await syncCampaign({ prisma, userId, orgId, id, force: true });
        await audit(prisma, auditLogger, { userId, orgId, action: 'metrics_synced', campaignId: id, metadata: {
          status: campaign.status, metrics_synced_at: campaign.metrics_synced_at,
        } });
        return jsonResponse(res, { campaign });
      }

      const toolName = `x_ads__${action}`;
      const runtime = getConnectorRuntime({ db: prisma, prisma, auditLogger });
      const result = await runtime.executeTool(toolName, {
        campaign_id: id, ...(action === 'publish' ? { confirmation_token: body?.confirmation_token } : {}),
      }, {
        requestId: req.headers['x-request-id'] || crypto.randomUUID(), userId, orgId,
        surface: 'dashboard', approvalOwnedBySurface: true, db: prisma,
      });
      if (result.status !== 'completed') {
        const message = result.content?.find((item) => item.type === 'text')?.text || `X Ads ${action} failed`;
        await audit(prisma, auditLogger, { userId, orgId, action: `${action}_failed`, campaignId: id, metadata: {
          runtime_status: result.status, message,
        } });
        return jsonResponse(res, { error: result.status, message }, result.status === 'forbidden' ? 403 : 409);
      }
      const campaign = jsonResult(result);
      await audit(prisma, auditLogger, { userId, orgId, action, campaignId: id, metadata: {
        status: campaign?.status,
        daily_budget_micros: campaign?.daily_budget_micros,
        total_budget_micros: campaign?.total_budget_micros,
        currency: campaign?.account?.currency,
        x_ids: campaign?.x_ids,
        steps: campaign?.steps,
      } });
      return jsonResponse(res, { campaign });
    }
    return jsonResponse(res, { error: 'not_found' }, 404);
  } catch (error) {
    const normalized = normalizeServiceError(error);
    const campaignId = pathname.match(/^\/api\/x-ads\/campaigns\/([0-9a-f-]{36})/i)?.[1] || null;
    await audit(prisma, auditLogger, { userId, orgId, action: 'request_failed', campaignId, metadata: {
      method, path: pathname, error: normalized.body.error, message: normalized.body.message,
    } });
    return jsonResponse(res, normalized.body, normalized.status);
  }
}
