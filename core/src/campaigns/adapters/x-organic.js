import { createOrganicPost } from '../../x-ads/service.js';
import { requireApproval, requireValue } from './contract.js';

export const xOrganicAdapter = {
  channel: 'x_organic',
  async execute({ prisma, action, approval, providers = {} }) {
    requireApproval(action, approval);
    const payload = action.payload || {};
    const text = requireValue(payload.text || payload.final_copy, 'X Post text is required', 'x_post_text_required');
    const post = await (providers.createOrganicPost || createOrganicPost)({
      prisma,
      userId: action.campaign.ownerUserId,
      orgId: action.campaign.orgId,
      text,
      confirmed: true,
    });
    return { externalId: post.id, response: post };
  },
  async reconcile({ action }) {
    if (action.externalId) return { status: 'SUCCEEDED', externalId: action.externalId };
    return { status: 'NEEDS_RECONCILIATION', reason: 'X returned no durable Post ID; inspect the connected account before retrying.' };
  },
};
