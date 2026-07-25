import crypto from 'node:crypto';

export const X_ADS_STATES = Object.freeze([
  'DRAFT', 'READY', 'PUBLISHING', 'PENDING_REVIEW', 'ACTIVE',
  'PAUSED', 'COMPLETED', 'SETUP_FAILED', 'REJECTED',
]);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function currencyFractionDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

export function amountToMicros(value, currency = 'USD') {
  const raw = String(value ?? '').trim();
  const digits = currencyFractionDigits(currency);
  const match = raw.match(new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${Math.max(1, digits)}}))?$`));
  if (!match || Number(raw) <= 0) throw new Error(`daily_budget must be a positive ${currency} amount`);
  if (digits === 0 && raw.includes('.')) throw new Error(`${currency} does not accept fractional units`);
  const whole = BigInt(match[1]);
  const fraction = digits ? BigInt((match[2] || '').padEnd(digits, '0')) : 0n;
  const minorScale = 10n ** BigInt(digits);
  const minor = whole * minorScale + fraction;
  return minor * (1_000_000n / minorScale);
}

function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

function offsetAt(date, timeZone) {
  const p = datePartsInZone(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

export function accountToday(timeZone, now = new Date()) {
  const p = datePartsInZone(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function inclusiveCampaignDays(endDate, timeZone, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error('end_date must be YYYY-MM-DD');
  const start = accountToday(timeZone, now).split('-').map(Number);
  const end = endDate.split('-').map(Number);
  const normalizedEnd = new Date(Date.UTC(end[0], end[1] - 1, end[2]));
  if (normalizedEnd.getUTCFullYear() !== end[0] || normalizedEnd.getUTCMonth() !== end[1] - 1 || normalizedEnd.getUTCDate() !== end[2]) {
    throw new Error('end_date must be a valid calendar date');
  }
  const startDay = Date.UTC(start[0], start[1] - 1, start[2]);
  const endDay = Date.UTC(end[0], end[1] - 1, end[2]);
  const days = Math.floor((endDay - startDay) / 86_400_000) + 1;
  if (days < 1) throw new Error('end_date must be today or later in the advertiser timezone');
  if (days > 366) throw new Error('end_date must be within 366 days');
  return days;
}

export function inclusiveEndAt(endDate, timeZone) {
  const [year, month, day] = endDate.split('-').map(Number);
  if (!year || !month || !day) throw new Error('invalid end_date');
  const localNextMidnight = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  let utc = new Date(localNextMidnight);
  for (let i = 0; i < 3; i += 1) utc = new Date(localNextMidnight - offsetAt(utc, timeZone));
  return new Date(utc.getTime() - 1000);
}

export function normalizeTargets(value, expectedType) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${expectedType.toLowerCase()} targets are required`);
  const unique = new Map();
  for (const item of value) {
    const targetingValue = String(item?.targeting_value || item?.value || '').trim();
    const name = String(item?.name || '').trim();
    if (!targetingValue || !name) throw new Error(`invalid ${expectedType.toLowerCase()} target`);
    unique.set(targetingValue, { name, targeting_type: expectedType, targeting_value: targetingValue });
  }
  return [...unique.values()];
}

export function validateDestinationUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new Error('destination_url must be a valid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('destination_url must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('destination_url cannot contain credentials');
  return parsed.toString();
}

export function validatePostText(text, destinationUrl) {
  const value = String(text || '').trim();
  if (!value || value.length > 280) throw new Error('post_text must contain 1 to 280 characters');
  const urls = value.match(/https?:\/\/[^\s]+/g) || [];
  if (urls.length !== 1) throw new Error('post_text must contain exactly one website URL');
  const expected = new URL(destinationUrl);
  let actual;
  try { actual = new URL(urls[0].replace(/[),.!?]+$/, '')); } catch { throw new Error('post_text contains an invalid URL'); }
  if (actual.toString() !== expected.toString()) {
    throw new Error('post_text URL must match destination_url');
  }
  return value;
}

export function campaignConfirmationPayload(campaign) {
  return {
    id: campaign.id,
    draft_version: campaign.draftVersion,
    x_user_id: campaign.xUserId,
    ad_account_id: campaign.adAccountId,
    funding_instrument_id: campaign.fundingInstrumentId,
    name: campaign.name,
    destination_url: campaign.destinationUrl,
    post_text: campaign.postText,
    image_sha256: campaign.imageData ? sha256(Buffer.from(campaign.imageData)) : null,
    locations: campaign.locationTargets,
    languages: campaign.languageTargets,
    daily_budget_micros: campaign.dailyBudgetMicros?.toString() || null,
    total_budget_micros: campaign.totalBudgetMicros?.toString() || null,
    currency: campaign.currency,
    timezone: campaign.accountTimezone,
    end_date: campaign.endDate,
  };
}

function confirmationSecret() {
  const secret = process.env.X_ADS_CONFIRMATION_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error('X Ads confirmation secret is not configured');
  return secret;
}

export function createConfirmation(campaign, ttlMs = 10 * 60 * 1000) {
  const hash = sha256(stableJson(campaignConfirmationPayload(campaign)));
  const expiresAt = new Date(Date.now() + ttlMs);
  const material = `${campaign.id}.${campaign.draftVersion}.${hash}.${expiresAt.getTime()}`;
  const signature = crypto.createHmac('sha256', confirmationSecret()).update(material).digest('base64url');
  return { hash, expiresAt, token: `${expiresAt.getTime()}.${signature}` };
}

export function verifyConfirmation(campaign, token) {
  const [rawExpires, supplied] = String(token || '').split('.');
  const expires = Number(rawExpires);
  if (!Number.isFinite(expires) || expires <= Date.now() || !supplied) return false;
  const hash = sha256(stableJson(campaignConfirmationPayload(campaign)));
  if (hash !== campaign.confirmationHash || campaign.confirmationExpiresAt?.getTime() !== expires) return false;
  const material = `${campaign.id}.${campaign.draftVersion}.${hash}.${expires}`;
  const expected = crypto.createHmac('sha256', confirmationSecret()).update(material).digest('base64url');
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function serializeCampaign(campaign, { includeSteps = false } = {}) {
  const metrics = campaign.metrics && typeof campaign.metrics === 'object' ? campaign.metrics : {};
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    draft_version: campaign.draftVersion,
    destination_url: campaign.destinationUrl,
    post_text: campaign.postText,
    has_image: Boolean(campaign.imageData || campaign.xMediaId),
    image_filename: campaign.imageFilename,
    account: campaign.adAccountId ? { id: campaign.adAccountId, name: campaign.adAccountName, timezone: campaign.accountTimezone, currency: campaign.currency } : null,
    funding_instrument_id: campaign.fundingInstrumentId,
    x_identity: campaign.xUserId ? { id: campaign.xUserId, username: campaign.xUsername } : null,
    location_targets: campaign.locationTargets,
    language_targets: campaign.languageTargets,
    daily_budget_micros: campaign.dailyBudgetMicros?.toString() || null,
    total_budget_micros: campaign.totalBudgetMicros?.toString() || null,
    end_date: campaign.endDate,
    x_ids: { campaign: campaign.xCampaignId, line_item: campaign.xLineItemId, media: campaign.xMediaId, post: campaign.xPostId, promoted_tweet: campaign.xPromotedTweetId },
    approval_status: campaign.xApprovalStatus,
    effective_status: campaign.xEffectiveStatus,
    rejection_reasons: campaign.xSnapshot?.promoted_tweet?.reasons_not_servable
      || campaign.xSnapshot?.promoted_tweet?.rejection_reasons || null,
    metrics,
    metrics_synced_at: campaign.metricsSyncedAt?.toISOString() || null,
    last_error: campaign.lastError,
    created_at: campaign.createdAt?.toISOString(),
    updated_at: campaign.updatedAt?.toISOString(),
    published_at: campaign.publishedAt?.toISOString() || null,
    ...(includeSteps ? { steps: (campaign.steps || []).map((step) => ({ step: step.step, status: step.status, external_id: step.externalId, attempts: step.attempts, error: step.error })) } : {}),
  };
}
