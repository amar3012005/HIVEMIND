import crypto from 'node:crypto';
import { createOpenRouterJevProvider } from '../agent/decision-gateway.js';
import { decisionGatewayProviderConfig } from '../agent/decision-gateway-service.js';
import { sendSystemEmail } from '../email/email-service.js';
import { createWorkspaceNotification } from '../workspace/notifications.js';

export const PROACTIVE_TRIGGER_KEY = 'decision_reflection.v1';
export const PROACTIVE_POLICY_VERSION = 'decision_reflection_policy.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const DELIVERY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVITY_ITEMS = 12;

function clean(value, limit = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function asDate(value, fallback = new Date()) {
  if (!value) return fallback;
  const date = value ? new Date(value) : fallback;
  return !date || Number.isNaN(date.getTime()) ? fallback : date;
}

function uuid(value) { return UUID.test(String(value || '')); }

export function proactiveCognitionEnabled(env = process.env) {
  return String(env.HIVEMIND_PROACTIVE_COGNITION_ENABLED || '').toLowerCase() === 'true';
}

export function isAuthorizedProactiveCognitionRequest(req, env = process.env) {
  const expected = Buffer.from(String(env.HIVEMIND_PROACTIVE_COGNITION_SECRET || ''));
  const header = String(req?.headers?.authorization || '');
  const actual = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function normalizeProactiveSettings(input = {}) {
  const quietStart = Number(input.quiet_start_hour);
  const quietEnd = Number(input.quiet_end_hour);
  return {
    enabled: input.enabled === true,
    timezone: clean(input.timezone, 64) || null,
    quietStartHour: Number.isInteger(quietStart) && quietStart >= 0 && quietStart <= 23 ? quietStart : 21,
    quietEndHour: Number.isInteger(quietEnd) && quietEnd >= 0 && quietEnd <= 23 ? quietEnd : 8,
  };
}

function rowSettings(row) {
  if (!row) return { enabled: false, quiet_start_hour: 21, quiet_end_hour: 8, timezone: 'UTC', trigger_key: PROACTIVE_TRIGGER_KEY };
  return {
    enabled: row.enabled === true,
    quiet_start_hour: Number(row.quiet_start_hour),
    quiet_end_hour: Number(row.quiet_end_hour),
    timezone: clean(row.timezone, 64) || 'UTC',
    trigger_key: row.trigger_key,
    next_evaluate_at: row.next_evaluate_at || null,
  };
}

export async function getProactiveSettings({ prisma, userId, orgId }) {
  if (!uuid(userId) || !uuid(orgId)) throw new Error('proactive_identity_invalid');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT enabled, quiet_start_hour, quiet_end_hour, timezone, trigger_key, next_evaluate_at
       FROM "hivemind"."proactive_user_schedules"
      WHERE user_id=$1::uuid AND org_id=$2::uuid AND trigger_key=$3 LIMIT 1`,
    userId, orgId, PROACTIVE_TRIGGER_KEY,
  );
  return rowSettings(rows?.[0]);
}

export async function listProactiveEvaluations({ prisma, userId, orgId, limit = 20 }) {
  if (!uuid(userId) || !uuid(orgId)) throw new Error('proactive_identity_invalid');
  const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, trigger_key, window_start, window_end, mode, status, decision, policy_version, created_at
       FROM "hivemind"."proactive_evaluations"
      WHERE user_id=$1::uuid AND org_id=$2::uuid
      ORDER BY created_at DESC LIMIT $3`,
    userId, orgId, bounded,
  );
  return (rows || []).map((row) => ({
    id: String(row.id), trigger_key: clean(row.trigger_key, 120),
    window_start: row.window_start, window_end: row.window_end,
    mode: clean(row.mode, 24), status: clean(row.status, 32),
    decision: row.decision && typeof row.decision === 'object' ? row.decision : {},
    policy_version: clean(row.policy_version, 120), created_at: row.created_at,
  }));
}

export async function setProactiveSettings({ prisma, userId, orgId, input, now = new Date() }) {
  if (!uuid(userId) || !uuid(orgId)) throw new Error('proactive_identity_invalid');
  const settings = normalizeProactiveSettings(input);
  const timezone = settings.timezone || 'UTC';
  const next = settings.enabled ? new Date(now.getTime() + WINDOW_MS) : null;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."proactive_user_schedules"
       (user_id, org_id, trigger_key, enabled, timezone, quiet_start_hour, quiet_end_hour, next_evaluate_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id, org_id, trigger_key) DO UPDATE SET
       enabled=EXCLUDED.enabled, timezone=EXCLUDED.timezone,
       quiet_start_hour=EXCLUDED.quiet_start_hour, quiet_end_hour=EXCLUDED.quiet_end_hour,
       next_evaluate_at=EXCLUDED.next_evaluate_at, updated_at=now()
     RETURNING enabled, timezone, quiet_start_hour, quiet_end_hour, next_evaluate_at`,
    userId, orgId, PROACTIVE_TRIGGER_KEY, settings.enabled, timezone,
    settings.quietStartHour, settings.quietEndHour, next,
  );
  return rowSettings(rows?.[0]);
}

export async function listEligibleProactiveSchedules({ prisma, limit = 100, now = new Date() }) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, user_id, org_id, trigger_key, next_evaluate_at
       FROM "hivemind"."proactive_user_schedules"
      WHERE enabled=true AND trigger_key=$1 AND next_evaluate_at <= $2
      ORDER BY next_evaluate_at ASC LIMIT $3`,
    PROACTIVE_TRIGGER_KEY, now, bounded,
  );
  return (rows || []).map((row) => ({
    schedule_id: String(row.id), user_id: String(row.user_id), org_id: String(row.org_id),
    trigger_key: String(row.trigger_key), due_at: row.next_evaluate_at,
  }));
}

function localHour(now, timezone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  } catch { return now.getUTCHours(); }
}

function quietHours(now, settings) {
  const start = Number(settings.quiet_start_hour);
  const end = Number(settings.quiet_end_hour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false;
  const hour = localHour(now, settings.timezone || 'UTC');
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function safeTitle(value) {
  const title = clean(value, 140);
  // Never turn credential-like content into a notification subject or email.
  return /\b(?:otp|verification code|password reset|sign-in|authentication)\b/i.test(title) ? 'a recent company decision' : (title || 'a recent company decision');
}

async function compileActivity({ prisma, userId, orgId, from, to }) {
  const [memories, audits] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, title, tags, source_type, scope, created_at
         FROM "hivemind"."memories"
        WHERE user_id=$1::uuid AND org_id=$2::uuid AND deleted_at IS NULL
          AND created_at >= $3 AND created_at < $4
        ORDER BY created_at DESC LIMIT $5`, userId, orgId, from, to, MAX_ACTIVITY_ITEMS,
    ),
    prisma.$queryRawUnsafe(
      `SELECT event_type, action, resource_type, created_at
         FROM "hivemind"."audit_logs"
        WHERE user_id=$1::uuid AND organization_id=$2::uuid
          AND created_at >= $3 AND created_at < $4
        ORDER BY created_at DESC LIMIT $5`, userId, orgId, from, to, MAX_ACTIVITY_ITEMS,
    ).catch(() => []),
  ]);
  const memoryItems = (memories || []).map((item) => ({
    id: String(item.id), title: safeTitle(item.title), tags: Array.isArray(item.tags) ? item.tags.slice(0, 8).map((tag) => clean(tag, 80)) : [],
    source_type: clean(item.source_type, 80), scope: clean(item.scope, 40), created_at: item.created_at,
  }));
  const auditItems = (audits || []).map((item) => ({
    event_type: clean(item.event_type, 100), action: clean(item.action, 60), resource_type: clean(item.resource_type, 60), created_at: item.created_at,
  }));
  return {
    schema_version: 1,
    window: { from: from.toISOString(), to: to.toISOString() },
    counts: { memories: memoryItems.length, activity: auditItems.length, total: memoryItems.length + auditItems.length },
    recent_memories: memoryItems,
    recent_activity: auditItems,
  };
}

function probabilityFor(answer, choice) {
  const value = Number(answer?.probabilities?.[choice]);
  return Number.isFinite(value) ? value : null;
}

function decisionConfiguration(env) {
  // Background cognition must never silently bypass the observability and
  // provider controls of AI Gateway. Interactive chat keeps its own existing
  // compatibility behavior; this new path is Gateway-only from day one.
  if (String(env.CLOUDFLARE_AI_GATEWAY_ENABLED || '').toLowerCase() !== 'true') return null;
  const config = decisionGatewayProviderConfig(env);
  if (!config.endpoint || (!config.headers?.['cf-aig-byok-alias'] && !config.headers?.['cf-aig-authorization'])) return null;
  return config;
}

async function decideReflection({ activity, userId, orgId, env, provider = null }) {
  const config = decisionConfiguration(env);
  if (!provider && !config) return { outcome: 'wait', source: 'unavailable', reason: 'decision_provider_unconfigured' };
  const decisionProvider = provider || createOpenRouterJevProvider({
    apiKey: config.apiKey, endpoint: config.endpoint, headers: config.headers,
    model: env.JEV_MODEL, timeoutMs: Math.max(500, Math.min(5000, Number(env.HIVEMIND_PROACTIVE_JEV_TIMEOUT_MS || 2500))),
    siteName: 'HIVE-MIND Proactive Cognition',
  });
  try {
    const response = await decisionProvider.decideQuestions({
      state: {
        task: 'decision_reflection_v1', user_id: userId, org_id: orgId,
        policy: 'Choose send only when the bounded activity shows a concrete, non-sensitive decision or unresolved work worth a short user-controlled reflection. Never infer private facts. Never request credentials, security codes, passwords, or authentication details.',
        activity,
      },
      questions: {
        action: {
          type: 'choice',
          instructions: 'Choose exactly one action. This selects only whether a fixed, evidence-grounded reminder may be considered; it does not generate the reminder text.',
          criteria: {
            send_reflection: 'There is a concrete recent decision, commitment, or unresolved work item in the supplied activity and a brief follow-up would plausibly help the user clarify it.',
            wait: 'The evidence is weak, routine, completed, too sparse, or a reminder would be intrusive. Do not send.',
            suppress_sensitive: 'The activity appears sensitive, credential-related, authentication-related, or unsuitable for a proactive reminder. Do not send.',
          },
        },
      },
    });
    const answer = response?.answers?.action;
    const outcome = ['send_reflection', 'wait', 'suppress_sensitive'].includes(answer?.choice) ? answer.choice : 'wait';
    return { outcome, source: 'jev', probability: probabilityFor(answer, outcome), request_id: response.requestId || null, usage: response.usage || null };
  } catch (error) {
    return { outcome: 'wait', source: 'unavailable', reason: clean(error?.message || error, 240) };
  }
}

async function recordEvaluation({ prisma, schedule, from, to, mode, activity, decision, status }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."proactive_evaluations"
       (schedule_id, user_id, org_id, trigger_key, window_start, window_end, mode, status, activity, decision, policy_version)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     RETURNING id`,
    schedule.id, schedule.user_id, schedule.org_id, schedule.trigger_key, from, to,
    mode, status, JSON.stringify(activity), JSON.stringify(decision), PROACTIVE_POLICY_VERSION,
  );
  return String(rows?.[0]?.id || '');
}

async function advanceSchedule({ prisma, scheduleId, nextAt, lastEvaluatedAt }) {
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."proactive_user_schedules"
        SET next_evaluate_at=$2, last_evaluated_at=$3, updated_at=now()
      WHERE id=$1::uuid`, scheduleId, nextAt, lastEvaluatedAt,
  );
}

async function reserveDelivery({ prisma, schedule, evaluationId, windowEnd, focusTitle }) {
  const key = crypto.createHash('sha256').update(`${schedule.id}:${windowEnd.toISOString()}:${PROACTIVE_POLICY_VERSION}`).digest('hex');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."proactive_delivery_ledger"
       (schedule_id, evaluation_id, user_id, org_id, trigger_key, window_end, policy_version, idempotency_key, status, focus_title)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, 'sending', $9)
     ON CONFLICT (schedule_id, window_end, policy_version) DO NOTHING
     RETURNING id`,
    schedule.id, evaluationId, schedule.user_id, schedule.org_id, schedule.trigger_key,
    windowEnd, PROACTIVE_POLICY_VERSION, key, focusTitle,
  );
  return rows?.[0]?.id ? { id: String(rows[0].id), idempotencyKey: key } : null;
}

async function setDelivery({ prisma, id, status, provider = null, messageId = null, error = null }) {
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."proactive_delivery_ledger"
        SET status=$2, provider=$3, provider_message_id=$4, failure_reason=$5, completed_at=now(), updated_at=now()
      WHERE id=$1::uuid`, id, status, provider, messageId, error,
  );
}

async function hasRecentAcceptedDelivery({ prisma, scheduleId, now }) {
  const since = new Date(now.getTime() - DELIVERY_COOLDOWN_MS);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "hivemind"."proactive_delivery_ledger"
      WHERE schedule_id=$1::uuid AND status='accepted'
        AND COALESCE(completed_at, created_at) >= $2
      ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 1`,
    scheduleId, since,
  );
  return Boolean(rows?.[0]?.id);
}

export async function evaluateProactiveSchedule({
  prisma, scheduleId, mode = 'shadow', now = new Date(), env = process.env,
  provider = null, windowEnd = null, advance = true,
}) {
  if (!uuid(scheduleId)) throw new Error('proactive_schedule_invalid');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.user_id, s.org_id, s.trigger_key, s.enabled, s.timezone, s.quiet_start_hour, s.quiet_end_hour, s.next_evaluate_at,
            u.email, u.display_name
       FROM "hivemind"."proactive_user_schedules" s
       JOIN "hivemind".users u ON u.id=s.user_id AND u.deleted_at IS NULL
      WHERE s.id=$1::uuid LIMIT 1`, scheduleId,
  );
  const schedule = rows?.[0];
  if (!schedule || schedule.enabled !== true || schedule.trigger_key !== PROACTIVE_TRIGGER_KEY) return { status: 'stale_or_disabled' };
  const to = asDate(windowEnd || schedule.next_evaluate_at, now);
  const from = new Date(to.getTime() - WINDOW_MS);
  const activity = await compileActivity({ prisma, userId: schedule.user_id, orgId: schedule.org_id, from, to });
  const nextAt = new Date(Math.max(now.getTime(), to.getTime()) + WINDOW_MS);
  if (activity.counts.total < 2) {
    const evaluationId = await recordEvaluation({ prisma, schedule, from, to, mode, activity, decision: { outcome: 'wait', source: 'deterministic', reason: 'insufficient_activity' }, status: 'skipped' });
    if (advance) await advanceSchedule({ prisma, scheduleId, nextAt, lastEvaluatedAt: now });
    return { status: 'skipped', reason: 'insufficient_activity', evaluation_id: evaluationId };
  }
  const decision = await decideReflection({ activity, userId: schedule.user_id, orgId: schedule.org_id, env, provider });
  const quiet = quietHours(now, schedule);
  const dailyCapHit = mode === 'deliver' && decision.outcome === 'send_reflection' && !quiet
    ? await hasRecentAcceptedDelivery({ prisma, scheduleId, now })
    : false;
  const shouldSend = mode === 'deliver' && decision.outcome === 'send_reflection' && !quiet && !dailyCapHit;
  const finalDecision = dailyCapHit
    ? { ...decision, outcome: 'wait', source: 'deterministic_policy', reason: 'one_delivery_per_rolling_24_hours' }
    : decision;
  const evaluationId = await recordEvaluation({
    prisma, schedule, from, to, mode, activity, decision: finalDecision,
    status: shouldSend ? 'ready' : (dailyCapHit ? 'suppressed' : 'completed'),
  });
  if (advance) await advanceSchedule({ prisma, scheduleId, nextAt, lastEvaluatedAt: now });
  if (dailyCapHit) return { status: 'suppressed', reason: 'one_delivery_per_rolling_24_hours', evaluation_id: evaluationId };
  if (!shouldSend) return { status: 'completed', evaluation_id: evaluationId, decision: decision.outcome, mode };

  const focusTitle = safeTitle(activity.recent_memories[0]?.title);
  const ledger = await reserveDelivery({ prisma, schedule, evaluationId, windowEnd: to, focusTitle });
  if (!ledger) return { status: 'already_reserved_or_delivered', evaluation_id: evaluationId };
  const appUrl = `${String(env.HIVEMIND_APP_URL || env.APP_URL || 'https://next.singulancelabs.com').replace(/\/$/, '')}/hivemind/app/overview`;
  try {
    // The provider does not expose a confirmed external idempotency key. A
    // request that cannot return a durable receipt is never replayed blindly.
    const delivery = await sendSystemEmail({
      templateId: 'proactive_decision_reflection', to: schedule.email,
      vars: { name: clean(schedule.display_name, 100) || 'there', focusTitle, appUrl },
      providerAttempts: 1, providerFallback: false,
    });
    if (!delivery?.ok) {
      await setDelivery({ prisma, id: ledger.id, status: 'indeterminate', error: clean(delivery?.error || 'provider_receipt_missing', 240) });
      return { status: 'delivery_indeterminate', evaluation_id: evaluationId };
    }
    await setDelivery({ prisma, id: ledger.id, status: 'accepted', provider: delivery.provider || null, messageId: delivery.messageId || null });
    await createWorkspaceNotification(prisma, {
      orgId: schedule.org_id, userId: schedule.user_id, type: 'proactive.decision_reflection',
      title: 'A thought to carry forward', body: `You recently worked on ${focusTitle}. Want to add what matters most?`,
      resourceType: 'proactive_delivery', resourceId: ledger.id,
      dedupeKey: `proactive:${ledger.idempotencyKey}`,
      data: { trigger_key: schedule.trigger_key, evaluation_id: evaluationId, href: '/hivemind/app/overview' },
    });
    return { status: 'delivered', evaluation_id: evaluationId, delivery_id: ledger.id };
  } catch (error) {
    await setDelivery({ prisma, id: ledger.id, status: 'indeterminate', error: clean(error?.message || error, 240) });
    return { status: 'delivery_indeterminate', evaluation_id: evaluationId };
  }
}

export async function runProactiveHistoricalDryRun({ prisma, scheduleId, windowEnds = [], now = new Date(), env = process.env, provider = null }) {
  const ends = [...new Set((Array.isArray(windowEnds) ? windowEnds : [])
    .map((value) => asDate(value, null))
    .filter((value) => value && value <= now && value >= new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)))
    .map((value) => value.toISOString()))]
    .slice(0, 28);
  if (!ends.length) throw new Error('proactive_dry_run_window_required');
  const evaluations = [];
  for (const end of ends) {
    evaluations.push(await evaluateProactiveSchedule({
      prisma, scheduleId, mode: 'historical_dry_run', now, env, provider,
      windowEnd: new Date(end), advance: false,
    }));
  }
  return { status: 'completed', mode: 'historical_dry_run', evaluations };
}

export async function recordProactiveFeedback({ prisma, userId, orgId, deliveryId, action, note = null }) {
  if (!uuid(userId) || !uuid(orgId) || !uuid(deliveryId)) throw new Error('proactive_feedback_invalid');
  const normalized = ['helpful', 'not_now', 'stop', 'resolved'].includes(String(action)) ? String(action) : null;
  if (!normalized) throw new Error('proactive_feedback_action_invalid');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT d.id, d.schedule_id FROM "hivemind"."proactive_delivery_ledger" d
      WHERE d.id=$1::uuid AND d.user_id=$2::uuid AND d.org_id=$3::uuid LIMIT 1`, deliveryId, userId, orgId,
  );
  const delivery = rows?.[0];
  if (!delivery) throw new Error('proactive_delivery_not_found');
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."proactive_feedback" (delivery_id, user_id, org_id, action, note)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`, deliveryId, userId, orgId, normalized, clean(note, 500) || null,
  );
  if (normalized === 'stop') {
    await prisma.$executeRawUnsafe(`UPDATE "hivemind"."proactive_user_schedules" SET enabled=false, updated_at=now() WHERE id=$1::uuid`, delivery.schedule_id);
  }
  return { ok: true, disabled: normalized === 'stop' };
}
