export const CAMPAIGN_ROOM_TASK_TAG = 'CAMPAIGN';

export function buildCampaignKickoff(campaign, feedback = '') {
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

export function buildCampaignRoomDispatch({ campaign, room, turn, participantIds, briefSnapshot }) {
  return {
    room_id: room.id,
    turn_id: turn.id,
    user_id: campaign.ownerUserId,
    org_id: campaign.orgId,
    user_message: turn.userMessage,
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
