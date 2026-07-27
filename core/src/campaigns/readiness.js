const PAID_CHANNELS = new Set([
  'x_ads', 'google_ads', 'meta', 'linkedin', 'youtube_ads', 'tiktok_ads',
  'microsoft_ads', 'apple_ads', 'amazon_ads', 'reddit_ads', 'pinterest_ads', 'snapchat_ads',
]);
const CHANNEL_LABELS = { x_organic: 'X Organic Posts', x_ads: 'Paid X Ads', gmail: 'Email', tara: 'TARA' };

function channelLabel(value) {
  return CHANNEL_LABELS[value] || String(value || '').replaceAll('_', ' ');
}

function text(value) {
  return String(value || '').trim();
}

function check(id, label, status, detail, recovery = null, context = {}) {
  return { id, label, status, detail, recovery, ...context };
}

function ratioNumber(value) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text(value));
  if (!match || Number(match[2]) === 0) return null;
  return Number(match[1]) / Number(match[2]);
}

function expectedRatios(value) {
  return [...new Set([ratioNumber(value), ratioNumber(normalizeImageAspectRatio(value))].filter(Boolean))];
}

function creativeProblems(bundleAction, action, asset) {
  const problems = [];
  if (!action || !asset) return ['selected_asset_missing'];
  if (asset.status !== 'READY' || asset.deletedAt) problems.push('asset_not_ready');
  if (asset.actionId !== action.id) problems.push('wrong_action');
  if (text(asset.contentHash) !== text(action.payload?.asset_hash)) problems.push('hash_mismatch');
  if (asset.kind !== 'IMAGE') problems.push('wrong_asset_kind');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.contentType)) problems.push('unsupported_content_type');
  if (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > 5 * 1024 * 1024) problems.push('invalid_file_size');
  if (!Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0) problems.push('dimensions_unavailable');
  const payloadAlt = text(action.payload?.asset_alt_text);
  const assetAlt = text(asset.metadata?.alt_text);
  if (!payloadAlt || !assetAlt || payloadAlt !== assetAlt) problems.push('alt_text_missing_or_changed');
  const intended = expectedRatios(bundleAction?.creative_brief?.aspect_ratio);
  if (intended.length && Number.isInteger(asset.width) && Number.isInteger(asset.height) && asset.height > 0) {
    const actual = asset.width / asset.height;
    if (!intended.some((ratio) => Math.abs(actual - ratio) / ratio <= 0.08)) problems.push('aspect_ratio_mismatch');
  }
  return [...new Set(problems)];
}

export function assessCampaignReadiness({ campaign, plan, actions = [], assets = [], capabilities = null, planIntegrity = null } = {}) {
  const bundle = plan?.bundle && typeof plan.bundle === 'object' ? plan.bundle : {};
  const requestedChannels = Array.isArray(campaign?.requestedChannels) ? campaign.requestedChannels : [];
  const checks = [];

  checks.push(check(
    'contract', 'Campaign contract', planIntegrity === false || !plan?.id ? 'blocked' : planIntegrity === true ? 'passed' : 'review',
    !plan?.id ? 'No current campaign plan exists.' : planIntegrity === false ? 'The current plan failed canonical hash or deterministic contract validation.' : planIntegrity === true ? 'The current plan hash and deterministic contract are valid.' : 'Plan integrity was not included in this assessment.',
    planIntegrity === false || !plan?.id ? 'Regenerate the campaign plan before approval.' : planIntegrity == null ? 'Refresh campaign readiness before launch.' : null,
  ));

  const capabilityRows = Array.isArray(capabilities?.channels) ? capabilities.channels : [];
  if (capabilityRows.length) {
    const unavailable = requestedChannels.filter((channel) => !capabilityRows.find((item) => item.id === channel)?.execution_ready);
    checks.push(check(
      'channels', 'Publishing channels', unavailable.length ? 'blocked' : 'passed',
      unavailable.length ? `Execution is unavailable for ${unavailable.map(channelLabel).join(', ')}.` : 'Every selected channel has a connected, enabled publishing adapter.',
      unavailable.length ? 'Complete account approval and enable a tested publishing adapter for every blocked channel.' : null,
      { channels: unavailable },
    ));
  } else {
    checks.push(check('channels', 'Publishing channels', 'review', 'Live channel capabilities were not included in this assessment.', 'Refresh campaign readiness before launch.'));
  }

  const bundleActions = Array.isArray(bundle.actions) ? bundle.actions : [];
  const persistedBySource = new Map(actions.map((action) => [text(action?.payload?.source_action_id), action]));
  const missingActions = bundleActions.filter((action) => !persistedBySource.has(text(action?.id))).map((action) => text(action?.id)).filter(Boolean);
  const nonReadyActions = actions.filter((action) => action.planVersionId === plan?.id && action.status !== 'READY').map((action) => action.id);
  checks.push(check(
    'actions', 'Executable actions', !bundleActions.length || missingActions.length || nonReadyActions.length ? 'blocked' : 'passed',
    !bundleActions.length ? 'The current plan contains no actions.' : missingActions.length ? `Persisted actions are missing for ${missingActions.join(', ')}.` : nonReadyActions.length ? 'One or more current actions are not ready.' : `${bundleActions.length} campaign actions are persisted and ready.`,
    !bundleActions.length || missingActions.length || nonReadyActions.length ? 'Regenerate or repair the campaign plan before approval.' : null,
    { action_ids: [...missingActions, ...nonReadyActions] },
  ));

  const evidence = new Map((Array.isArray(bundle.evidence) ? bundle.evidence : []).map((item) => [text(item?.id), item]));
  const unsafeClaims = [];
  for (const action of bundleActions) {
    const status = text(action?.claim_status);
    const refs = Array.isArray(action?.evidence_ids) ? action.evidence_ids.map(text).filter(Boolean) : [];
    if (status === 'assumption') unsafeClaims.push(text(action.id));
    if (status === 'verified' && (!refs.length || refs.some((id) => evidence.get(id)?.status !== 'verified'))) unsafeClaims.push(text(action.id));
  }
  checks.push(check(
    'claims', 'Public claims', unsafeClaims.length ? 'blocked' : 'passed',
    unsafeClaims.length ? `Unverified or assumed claims remain in ${[...new Set(unsafeClaims)].join(', ')}.` : 'Every public claim is either evidence-verified or explicitly contains no factual claim.',
    unsafeClaims.length ? 'Replace the claim, supply verified evidence, or mark the action as containing no factual claim.' : null,
    { action_ids: [...new Set(unsafeClaims)] },
  ));

  const assetById = new Map(assets.map((asset) => [String(asset.id), asset]));
  const missingVisuals = [];
  const creativeIssues = [];
  for (const bundleAction of bundleActions.filter((action) => action?.creative_brief?.required === true)) {
    const action = persistedBySource.get(text(bundleAction.id));
    const assetId = text(action?.payload?.asset_id);
    const asset = assetById.get(assetId);
    const problems = creativeProblems(bundleAction, action, asset);
    if (!assetId || problems.length) {
      missingVisuals.push(text(bundleAction.id));
      creativeIssues.push({ action_id: text(bundleAction.id), problems: !assetId ? ['selected_asset_missing'] : problems });
    }
  }
  checks.push(check(
    'creative', 'Approved creative', missingVisuals.length ? 'blocked' : 'passed',
    missingVisuals.length ? `Creative preflight failed for ${missingVisuals.join(', ')}.` : 'Every required visual is selected, accessible, format-safe, correctly sized, and content-hash bound.',
    missingVisuals.length ? 'Repair the listed image format, dimensions, aspect ratio, alt text, selection, or content binding.' : null,
    { action_ids: missingVisuals, issues: creativeIssues },
  ));

  const paidChannels = requestedChannels.filter((channel) => PAID_CHANNELS.has(channel));
  const mediaRows = new Map((Array.isArray(bundle.media_plan?.channels) ? bundle.media_plan.channels : []).map((row) => [text(row?.channel).toLowerCase(), row]));
  const missingBudgets = paidChannels.filter((channel) => {
    const amount = mediaRows.get(channel)?.budget_amount;
    return typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0;
  });
  const ceilings = Array.isArray(bundle.launch_plan?.ceilings) ? bundle.launch_plan.ceilings : [];
  const budgetBlocked = paidChannels.length > 0 && (!/^[A-Z]{3}$/.test(text(bundle.media_plan?.currency)) || missingBudgets.length > 0 || ceilings.length === 0);
  checks.push(check(
    'budget', 'Budget and ceilings', budgetBlocked ? 'blocked' : 'passed',
    !paidChannels.length ? 'No paid-media budget is required for the selected channels.' : budgetBlocked ? 'Paid channels require a currency, positive channel budgets, and at least one explicit spending ceiling.' : 'Paid-media currency, channel budgets, and spending ceilings are defined.',
    budgetBlocked ? 'Add account currency, positive channel budgets, and explicit owner-approved spending ceilings.' : null,
    { channels: missingBudgets },
  ));

  const timeline = Array.isArray(bundle.timeline) ? bundle.timeline : [];
  const timelineByAction = new Map(timeline.map((row) => [text(row?.action_id), row]));
  const scheduleGaps = bundleActions.filter((action) => {
    const row = timelineByAction.get(text(action?.id));
    return !row || !Number.isInteger(action?.scheduled_offset_minutes) || action.scheduled_offset_minutes < 0 || row.scheduled_offset_minutes !== action.scheduled_offset_minutes;
  }).map((action) => text(action.id));
  checks.push(check(
    'schedule', 'Schedule integrity', scheduleGaps.length ? 'blocked' : 'passed',
    scheduleGaps.length ? `Schedule coverage is invalid for ${scheduleGaps.join(', ')}.` : 'Every action has one matching non-negative campaign offset.',
    scheduleGaps.length ? 'Repair the action timeline before approval.' : null,
    { action_ids: scheduleGaps },
  ));

  const declared = (Array.isArray(bundle.launch_plan?.blocked_by) ? bundle.launch_plan.blocked_by : []).map(text).filter(Boolean);
  if (declared.length) checks.push(check('plan_review', 'Plan-declared concerns', 'review', declared.join(' '), 'Review these concerns and regenerate the plan if they remain unresolved.'));

  const blockers = checks.filter((item) => item.status === 'blocked');
  const advisories = checks.filter((item) => item.status === 'review');
  return {
    version: 1,
    decision: blockers.length ? 'blocked' : 'ready',
    summary: {
      passed_checks: checks.filter((item) => item.status === 'passed').map((item) => item.id),
      blocked_checks: blockers.map((item) => item.id),
      review_checks: advisories.map((item) => item.id),
      next_action: blockers[0]?.recovery || advisories[0]?.recovery || null,
    },
    checks,
    blockers: blockers.map(({ id, label, detail, recovery, channels, action_ids, issues }) => ({ id, label, detail, recovery, channels: channels || [], action_ids: action_ids || [], issues: issues || [] })),
    advisories: advisories.map(({ id, label, detail, recovery }) => ({ id, label, detail, recovery })),
  };
}

export { PAID_CHANNELS };
import { normalizeImageAspectRatio } from './image-provider.js';
