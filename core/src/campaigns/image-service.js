import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { campaignError } from './errors.js';
import { DEFAULT_CAMPAIGN_IMAGE_MODEL, generateCampaignImage } from './image-provider.js';
import { buildCampaignImagePrompt, creativeBriefErrors, normalizeCreativeBrief } from './visual-prompt.js';

const STORAGE_ROOT = path.resolve(process.env.HIVEMIND_DATA_DIR || '/app/data', 'campaign-assets');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DAILY_GENERATION_LIMIT = 40;
const IMAGE_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const MUTABLE_CAMPAIGN_STATUSES = new Set(['PREPARING_ASSETS', 'READY_FOR_APPROVAL', 'NEEDS_INPUT', 'NEEDS_REPAIR']);

function hasValidImageSignature(bytes, contentType) {
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function publicAsset(asset) {
  const { storageKey, ...safe } = asset;
  return {
    ...safe,
    content_url: storageKey && !asset.deletedAt
      ? `/v1/campaigns/${asset.campaignId}/assets/${asset.id}/content`
      : null,
  };
}

function dimensions(bytes, contentType) {
  if (contentType === 'image/png' && bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (contentType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b0 = bytes[21]; const b1 = bytes[22]; const b2 = bytes[23]; const b3 = bytes[24];
      return { width: 1 + b0 + ((b1 & 0x3f) << 8), height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10) };
    }
  }
  if (contentType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const size = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += Math.max(size + 2, 2);
    }
  }
  return { width: null, height: null };
}

async function requireEditor(prisma, campaign, userId) {
  if (campaign.ownerUserId === userId) return;
  const membership = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId: campaign.orgId } }, select: { role: true } });
  if (!['owner', 'admin'].includes(membership?.role)) throw campaignError('Only the campaign creator or an organization admin can change campaign images', 403, 'campaign_editor_required');
}

async function editableAction(prisma, { orgId, userId, campaignId, actionId }) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId },
    include: { actions: { where: { id: actionId }, take: 1 } },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireEditor(prisma, campaign, userId);
  const action = campaign.actions[0];
  if (!action || action.planVersionId !== campaign.currentPlanVersionId) throw campaignError('Campaign action not found', 404, 'campaign_action_not_found');
  if (!MUTABLE_CAMPAIGN_STATUSES.has(campaign.status) || action.status !== 'READY') throw campaignError('Campaign images can only change before launch', 409, 'campaign_asset_not_editable');
  return { campaign, action };
}

export function queuedAssetData({ campaignId, actionId, creativeBrief, requestedBy = null, variantIndex = 0 }) {
  const brief = normalizeCreativeBrief(creativeBrief);
  const prompt = buildCampaignImagePrompt(brief);
  return {
    campaignId, actionId, kind: 'IMAGE', status: 'QUEUED', provider: 'openrouter', model: DEFAULT_CAMPAIGN_IMAGE_MODEL, prompt,
    metadata: { creative_brief: brief, alt_text: brief.alt_text, aspect_ratio: brief.aspect_ratio, requested_by: requestedBy, variant_index: variantIndex },
  };
}

export async function enqueueCampaignImages({ prisma, orgId, userId, campaignId, actionId, creativeBrief, variantCount = 1 }) {
  const { campaign, action } = await editableAction(prisma, { orgId, userId, campaignId, actionId });
  const brief = normalizeCreativeBrief(creativeBrief || action.payload?.creative_brief || {});
  const errors = creativeBriefErrors({ ...brief, required: true });
  if (errors.length) throw campaignError(errors.join('; '), 400, 'campaign_creative_brief_invalid');
  const count = Math.max(1, Math.min(Number(variantCount) || 1, 2));
  const generatedToday = await prisma.campaignAsset.count({ where: { campaign: { orgId }, provider: 'openrouter', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, status: { not: 'DELETED' } } });
  if (generatedToday + count > DAILY_GENERATION_LIMIT) throw campaignError(`The organization image limit of ${DAILY_GENERATION_LIMIT} generations per 24 hours has been reached`, 429, 'campaign_image_daily_limit');
  const existing = await prisma.campaignAsset.findMany({ where: { campaignId, actionId, status: { in: ['QUEUED', 'GENERATING'] }, deletedAt: null } });
  if (existing.length) return { queued: false, assets: existing.map(publicAsset), campaign_status: campaign.status };
  const assets = await prisma.$transaction(async (tx) => {
    const created = [];
    for (let index = 0; index < count; index += 1) {
      created.push(await tx.campaignAsset.create({ data: queuedAssetData({ campaignId, actionId, creativeBrief: brief, requestedBy: userId, variantIndex: index }) }));
    }
    await tx.campaignEvent.create({ data: { campaignId, orgId, eventType: 'campaign_asset_generation_queued', actorType: 'user', actorId: userId, data: { action_id: actionId, asset_ids: created.map((asset) => asset.id), variant_count: count } } });
    return created;
  });
  return { queued: true, assets: assets.map(publicAsset), campaign_status: campaign.status };
}

async function storeBytes({ orgId, campaignId, assetId, bytes, contentType }) {
  const ext = IMAGE_TYPES.get(contentType);
  if (!ext) throw campaignError('Only PNG, JPG, and WEBP images are supported', 400, 'campaign_asset_type_invalid');
  if (!hasValidImageSignature(bytes, contentType)) throw campaignError('The uploaded bytes do not match the declared image type', 400, 'campaign_asset_content_invalid');
  const relative = path.join(String(orgId), String(campaignId), `${assetId}.${ext}`);
  const destination = path.resolve(STORAGE_ROOT, relative);
  if (!destination.startsWith(`${STORAGE_ROOT}${path.sep}`)) throw campaignError('Invalid campaign asset path', 400, 'campaign_asset_path_invalid');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await fs.rename(temporary, destination);
  return relative;
}

async function selectReadyAsset(prisma, { campaign, action, asset }) {
  const selectedPayload = { ...action.payload, asset_id: asset.id, asset_hash: asset.contentHash, asset_alt_text: asset.metadata?.alt_text || '' };
  const siblings = await prisma.campaignAsset.findMany({ where: { campaignId: campaign.id, actionId: action.id, deletedAt: null }, select: { id: true, metadata: true } });
  await prisma.$transaction([
    prisma.campaignAction.update({ where: { id: action.id }, data: { payload: selectedPayload } }),
    ...siblings.map((item) => prisma.campaignAsset.update({ where: { id: item.id }, data: { metadata: { ...(item.metadata || {}), selected: item.id === asset.id } } })),
  ]);
}

async function finalizeCampaignAssets(prisma, campaignId) {
  const identity = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { currentPlanVersionId: true } });
  if (!identity?.currentPlanVersionId) return;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { actions: { where: { planVersionId: identity.currentPlanVersionId }, include: { assets: { where: { deletedAt: null } } } }, runs: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  if (!campaign || !['PREPARING_ASSETS', 'READY_FOR_APPROVAL'].includes(campaign.status)) return;
  if (campaign.actions.some((action) => action.assets.some((asset) => ['QUEUED', 'GENERATING'].includes(asset.status)))) return;
  const currentActions = campaign.actions;
  const missing = currentActions.filter((action) => action.payload?.creative_brief?.required === true && !action.payload?.asset_id);
  if (missing.length) {
    const message = `Image generation needs attention for ${missing.length} campaign action${missing.length === 1 ? '' : 's'}`;
    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'NEEDS_INPUT', lastError: message } }),
      prisma.campaignEvent.create({ data: { campaignId: campaign.id, orgId: campaign.orgId, eventType: 'campaign_asset_generation_failed', data: { action_ids: missing.map((action) => action.id), error: message } } }),
    ]);
    const { scheduleRuntimeCampaignEvent } = await import('./runtime-bridge.js');
    await scheduleRuntimeCampaignEvent({ prisma, campaignId: campaign.id, type: 'campaign.contract_failed', data: { status: 'NEEDS_INPUT', reason: message } }).catch(() => {});
    return;
  }
  if (campaign.status === 'PREPARING_ASSETS') {
    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'READY_FOR_APPROVAL', lastError: null } }),
      prisma.campaignEvent.create({ data: { campaignId: campaign.id, orgId: campaign.orgId, eventType: 'campaign_ready', data: { campaign_id: campaign.id, room_id: campaign.roomId, turn_id: campaign.runs[0]?.turnId || null, plan_version_id: campaign.currentPlanVersionId, display: { title: campaign.name, objective: campaign.objective, channels: campaign.requestedChannels, action_count: currentActions.length, status: 'READY_FOR_APPROVAL', message: 'Your campaign content and visuals are ready to review.' } } } }),
    ]);
  } else {
    await prisma.campaignEvent.create({ data: { campaignId: campaign.id, orgId: campaign.orgId, eventType: 'campaign_visuals_ready', data: { plan_version_id: campaign.currentPlanVersionId, action_count: currentActions.length } } });
  }
  const { autoLaunchCampaignIfReady } = await import('./service.js');
  const { scheduleRuntimeCampaignEvent } = await import('./runtime-bridge.js');
  await scheduleRuntimeCampaignEvent({ prisma, campaignId: campaign.id, type: 'campaign.visuals_ready', data: { plan_version_id: campaign.currentPlanVersionId } }).catch(() => {});
  await autoLaunchCampaignIfReady({ prisma, campaignId: campaign.id });
}

export async function processQueuedCampaignAssets({ prisma, limit = 1, provider = generateCampaignImage } = {}) {
  await prisma.campaignAsset.updateMany({ where: { status: 'GENERATING', updatedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) }, deletedAt: null }, data: { status: 'QUEUED' } });
  let processed = 0;
  while (processed < Math.max(1, Math.min(Number(limit) || 1, 4))) {
    const queued = await prisma.campaignAsset.findFirst({ where: { status: 'QUEUED', deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { campaign: true, action: true } });
    if (!queued) break;
    const claimed = await prisma.campaignAsset.updateMany({ where: { id: queued.id, status: 'QUEUED' }, data: { status: 'GENERATING' } });
    if (!claimed.count) continue;
    try {
      const generatedToday = await prisma.campaignAsset.count({ where: { campaign: { orgId: queued.campaign.orgId }, provider: 'openrouter', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, status: { in: ['GENERATING', 'READY', 'APPROVED', 'FAILED'] } } });
      if (generatedToday > DAILY_GENERATION_LIMIT) throw campaignError(`The organization image limit of ${DAILY_GENERATION_LIMIT} generations per 24 hours has been reached`, 429, 'campaign_image_daily_limit');
      const generated = await provider({ prompt: queued.prompt, aspectRatio: queued.metadata?.aspect_ratio || '16:9', model: queued.model || DEFAULT_CAMPAIGN_IMAGE_MODEL });
      if (!generated.bytes.length || generated.bytes.length > MAX_UPLOAD_BYTES) throw campaignError('Generated image exceeds the 5 MB campaign limit', 400, 'campaign_asset_too_large');
      const contentHash = crypto.createHash('sha256').update(generated.bytes).digest('hex');
      const storageKey = await storeBytes({ orgId: queued.campaign.orgId, campaignId: queued.campaignId, assetId: queued.id, bytes: generated.bytes, contentType: generated.contentType });
      const size = dimensions(generated.bytes, generated.contentType);
      const asset = await prisma.campaignAsset.update({ where: { id: queued.id }, data: { status: 'READY', storageKey, contentHash, contentType: generated.contentType, sizeBytes: generated.bytes.length, width: size.width, height: size.height, provider: generated.provider, model: generated.model, metadata: { ...(queued.metadata || {}), usage: generated.usage || {} } } });
      const action = await prisma.campaignAction.findUnique({ where: { id: queued.actionId } });
      if (action && !action.payload?.asset_id) await selectReadyAsset(prisma, { campaign: queued.campaign, action, asset });
      await prisma.campaignEvent.create({ data: { campaignId: queued.campaignId, orgId: queued.campaign.orgId, eventType: 'campaign_asset_ready', data: { action_id: queued.actionId, asset_id: queued.id, content_hash: contentHash, provider: asset.provider, model: asset.model } } });
    } catch (error) {
      await prisma.campaignAsset.update({ where: { id: queued.id }, data: { status: 'FAILED', metadata: { ...(queued.metadata || {}), error: String(error?.message || error).slice(0, 1000), error_code: error?.code || null } } });
    }
    await finalizeCampaignAssets(prisma, queued.campaignId);
    processed += 1;
  }
  return { processed };
}

export async function selectCampaignAsset({ prisma, orgId, userId, campaignId, actionId, assetId }) {
  const { campaign, action } = await editableAction(prisma, { orgId, userId, campaignId, actionId });
  const asset = await prisma.campaignAsset.findFirst({ where: { id: assetId, campaignId, actionId, status: 'READY', deletedAt: null } });
  if (!asset) throw campaignError('Campaign image not found or not ready', 404, 'campaign_asset_not_found');
  await selectReadyAsset(prisma, { campaign, action, asset });
  await prisma.campaignEvent.create({ data: { campaignId, orgId, eventType: 'campaign_asset_selected', actorType: 'user', actorId: userId, data: { action_id: actionId, asset_id: assetId, content_hash: asset.contentHash } } });
  await finalizeCampaignAssets(prisma, campaignId);
  return publicAsset({ ...asset, metadata: { ...(asset.metadata || {}), selected: true } });
}

export async function uploadCampaignAsset({ prisma, orgId, userId, campaignId, actionId, bytes, contentType, filename = null, altText = '' }) {
  const { campaign, action } = await editableAction(prisma, { orgId, userId, campaignId, actionId });
  if (!IMAGE_TYPES.has(contentType) || !bytes?.length) throw campaignError('Upload a PNG, JPG, or WEBP image', 400, 'campaign_asset_type_invalid');
  if (bytes.length > MAX_UPLOAD_BYTES) throw campaignError('Campaign images must be 5 MB or smaller', 413, 'campaign_asset_too_large');
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const existing = await prisma.campaignAsset.findFirst({ where: { campaignId, actionId, contentHash, status: 'READY', deletedAt: null } });
  if (existing) {
    await selectReadyAsset(prisma, { campaign, action, asset: existing }); await finalizeCampaignAssets(prisma, campaignId); return publicAsset(existing);
  }
  const asset = await prisma.campaignAsset.create({ data: { campaignId, actionId, kind: 'IMAGE', status: 'GENERATING', provider: 'upload', model: null, prompt: null, contentHash, contentType, sizeBytes: bytes.length, metadata: { alt_text: String(altText || '').slice(0, 1000), original_filename: String(filename || '').slice(0, 255) || null } } });
  try {
    const storageKey = await storeBytes({ orgId, campaignId, assetId: asset.id, bytes, contentType });
    const size = dimensions(bytes, contentType);
    const ready = await prisma.campaignAsset.update({ where: { id: asset.id }, data: { status: 'READY', storageKey, width: size.width, height: size.height } });
    await selectReadyAsset(prisma, { campaign, action, asset: ready });
    await prisma.campaignEvent.create({ data: { campaignId, orgId, eventType: 'campaign_asset_uploaded', actorType: 'user', actorId: userId, data: { action_id: actionId, asset_id: ready.id, content_hash: contentHash } } });
    await finalizeCampaignAssets(prisma, campaignId);
    return publicAsset(ready);
  } catch (error) {
    await prisma.campaignAsset.update({ where: { id: asset.id }, data: { status: 'FAILED', metadata: { ...(asset.metadata || {}), error: String(error?.message || error).slice(0, 1000) } } });
    throw error;
  }
}

export async function deleteCampaignAsset({ prisma, orgId, userId, campaignId, actionId, assetId }) {
  const { campaign, action } = await editableAction(prisma, { orgId, userId, campaignId, actionId });
  const asset = await prisma.campaignAsset.findFirst({ where: { id: assetId, campaignId, actionId, deletedAt: null } });
  if (!asset) throw campaignError('Campaign image not found', 404, 'campaign_asset_not_found');
  const selected = action.payload?.asset_id === assetId;
  await prisma.$transaction([
    prisma.campaignAsset.update({ where: { id: assetId }, data: { deletedAt: new Date(), status: 'DELETED' } }),
    ...(selected ? [prisma.campaignAction.update({ where: { id: actionId }, data: { payload: { ...action.payload, asset_id: null, asset_hash: null, asset_alt_text: null } } })] : []),
    prisma.campaignEvent.create({ data: { campaignId, orgId, eventType: 'campaign_asset_removed', actorType: 'user', actorId: userId, data: { action_id: actionId, asset_id: assetId } } }),
  ]);
  if (asset.storageKey) {
    const filename = path.resolve(STORAGE_ROOT, asset.storageKey);
    if (filename.startsWith(`${STORAGE_ROOT}${path.sep}`)) await fs.rm(filename, { force: true }).catch(() => {});
  }
  if (selected && action.payload?.creative_brief?.required === true) await finalizeCampaignAssets(prisma, campaignId);
  return { asset_id: assetId, deleted: true };
}

export async function getCampaignAssetContent({ prisma, orgId, campaignId, assetId }) {
  const asset = await prisma.campaignAsset.findFirst({ where: { id: assetId, campaignId, campaign: { orgId }, status: { in: ['READY', 'APPROVED'] }, deletedAt: null } });
  if (!asset?.storageKey) throw campaignError('Campaign image not found', 404, 'campaign_asset_not_found');
  const filename = path.resolve(STORAGE_ROOT, asset.storageKey);
  if (!filename.startsWith(`${STORAGE_ROOT}${path.sep}`)) throw campaignError('Invalid campaign asset path', 400, 'campaign_asset_path_invalid');
  return { asset: publicAsset(asset), bytes: await fs.readFile(filename) };
}

export async function readSelectedCampaignAsset({ prisma, action }) {
  const assetId = String(action?.payload?.asset_id || '');
  if (!assetId) return null;
  const result = await getCampaignAssetContent({ prisma, orgId: action.campaign.orgId, campaignId: action.campaignId, assetId });
  if (result.asset.actionId !== action.id || result.asset.contentHash !== action.payload?.asset_hash) throw campaignError('Campaign image no longer matches the approved action', 409, 'campaign_asset_changed');
  return result;
}

export { publicAsset, MAX_UPLOAD_BYTES, DAILY_GENERATION_LIMIT };
