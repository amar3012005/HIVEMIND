import { handleCampaignDispatchError } from './pipeline.js';

export async function dispatchCampaignRoom(dispatch) {
  const base = process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
  const key = process.env.HIVEMIND_MASTER_API_KEY;
  if (!key) throw Object.assign(new Error('Campaign room dispatcher is not configured'), { status: 503, code: 'campaign_dispatch_unavailable' });
  const response = await fetch(`${base}/internal/hyper/room-turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(dispatch),
  });
  if (!response.ok) throw Object.assign(new Error(`Campaign room dispatch failed (${response.status})`), {
    status: 502, code: 'campaign_dispatch_failed', definitive: true,
  });
}

export async function dispatchCampaignRoomSafely({ prisma, campaignId, dispatch }) {
  try {
    await dispatchCampaignRoom(dispatch);
    return { dispatched: true };
  } catch (error) {
    await handleCampaignDispatchError({ prisma, campaignId, error }).catch(() => {});
    throw error;
  }
}
