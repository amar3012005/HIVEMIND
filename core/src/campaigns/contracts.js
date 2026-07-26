export const CAMPAIGN_ROOM_TASK_TAG = 'CAMPAIGN';

const CHANNEL_LABELS = { x_organic: 'X', gmail: 'Email', tara: 'TARA' };

export function buildCampaignDisplayMessage(campaign, feedback = '') {
  const channels = (campaign.requestedChannels || []).map((channel) => CHANNEL_LABELS[channel] || channel).join(', ');
  const objective = String(campaign.objective || 'campaign').toLowerCase().replaceAll('_', ' ');
  return [
    `Create a ${objective} campaign for this goal: ${campaign.goal}`,
    channels ? `Prepare the campaign for ${channels}.` : null,
    'Research our company and existing audience, debate the strategy, and produce a polished launch-ready operating plan. Do not publish anything yet.',
    feedback ? `Requested improvement: ${String(feedback).slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n\n');
}

export function buildCampaignExecutionContext(campaign, feedback = '') {
  return [
    `CAMPAIGN_ID: ${campaign.id}`,
    `GOAL: ${campaign.goal}`,
    `OBJECTIVE: ${campaign.objective}`,
    `CHANNELS: ${campaign.requestedChannels.join(', ')}`,
    `BRIEF_JSON: ${JSON.stringify(campaign.brief || {})}`,
    `AUDIENCE_POLICY_JSON: ${JSON.stringify(campaign.audiencePolicy || {})}`,
    feedback ? `USER_FEEDBACK: ${String(feedback).slice(0, 4000)}` : null,
    'Execute the Campaign Room workflow now: gather company and existing-audience evidence first, debate the strategy, create final ready-to-send channel actions, and submit the complete plan with campaign__submit_plan. Do not send any external action.',
  ].filter(Boolean).join('\n');
}

// Backward-compatible name for internal callers/tests. This value is private
// execution context and must never be persisted as the Room's user message.
export const buildCampaignKickoff = buildCampaignExecutionContext;

export function buildCampaignRoomDispatch({ campaign, room, turn, participantIds, briefSnapshot }) {
  return {
    room_id: room.id,
    turn_id: turn.id,
    user_id: campaign.ownerUserId,
    org_id: campaign.orgId,
    user_message: turn.userMessage,
    display_message: turn.userMessage,
    execution_context: buildCampaignExecutionContext(campaign, briefSnapshot?.feedback || ''),
    participant_ids: participantIds,
    room_goal: room.goal,
    task_tag: CAMPAIGN_ROOM_TASK_TAG,
    campaign_id: campaign.id,
    campaign_brief: briefSnapshot,
    write_policy: 'ask',
    callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
  };
}

export function normalizeCampaignRoomEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = String(event.t || '').trim();
  if (!type) return null;
  return { ...event, t: type };
}
